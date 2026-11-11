/**
 * Playwright 浏览器的生命周期管理（每平台独立实例）。
 *
 * 2026-11-05 重构：以前是全平台共用一个持久化 profile + 一把全局锁，结果点一次
 * 「检测」就把登录、领取全部堵死（「浏览器正忙」）。现在**每个平台一个浏览器实例、
 * 一个独立 profile、一把独立锁**：
 * - 单平台的检测/领取/登录只占它自己的浏览器，其它平台与其他功能完全不受影响；
 * - 多个平台可以并行开工（一轮批量任务也按并发上限同时开多个实例）；
 * - 登录态按平台隔离落盘（profiles/<id>/），互不干扰。
 *
 * 首次使用某平台的 profile 时做一次**迁移**：老的共享 profile（profile/）里若有
 * 该平台的登录记账（config.logins[id]），整目录拷贝过来，用户不用逐个重新登录。
 *
 * playwright 是惰性加载的：没装依赖/没下载浏览器内核时，其它功能完全不受影响，
 * 只有真正用到网页签到的请求会收到一条「怎么补装」的明确提示。
 */

import path from 'node:path';
import fs from 'node:fs';
import { PROFILE_DIR, CHECKIN_DIR, loadConfig } from './store.mjs';

/** 每平台 profile 的根目录：CHECKIN_DIR/profiles/<platformId>/ */
export const PROFILES_ROOT = path.join(CHECKIN_DIR, 'profiles');

function profileDirFor(key) {
  return path.join(PROFILES_ROOT, String(key).replace(/[^a-zA-Z0-9_-]/g, '_'));
}

/**
 * 确保某平台的 profile 目录就绪；首次使用时尝试从老的共享 profile 迁移登录态。
 * 迁移条件：老 profile 存在 且 该平台有登录记账（说明共享档案里有它的 cookie）。
 */
function ensureProfileDir(key, logger) {
  const dir = profileDirFor(key);
  const readyMark = path.join(dir, '.ready');
  if (fs.existsSync(readyMark)) return dir;
  fs.mkdirSync(dir, { recursive: true });
  try {
    const cfg = loadConfig();
    if (cfg.logins?.[key] && fs.existsSync(PROFILE_DIR)) {
      logger?.info?.(`首次使用 ${key} 的独立档案：从共享档案迁移登录态（老档案保留作回滚）`);
      fs.cpSync(PROFILE_DIR, dir, { recursive: true, force: false, errorOnExist: false });
    }
  } catch (e) {
    logger?.warn?.(`迁移共享档案失败（不影响使用，登录态可能需要重新授权）: ${String(e?.message || e).split('\n')[0]}`);
  }
  try {
    fs.writeFileSync(readyMark, String(Date.now()), 'utf8');
  } catch {
    /* 标记写不下去就每次多试一次迁移，无碍 */
  }
  return dir;
}

/** 简单异步互斥锁：tryAcquire 语义是关键——批量任务撞上占用中的平台时选择跳过而不是干等 */
class AsyncLock {
  constructor() {
    this.held = false;
    this.queue = [];
  }

  tryAcquire() {
    if (this.held) return false;
    this.held = true;
    return true;
  }

  acquire() {
    if (this.tryAcquire()) return Promise.resolve();
    return new Promise((resolve) => this.queue.push(resolve));
  }

  release() {
    const next = this.queue.shift();
    if (next) next();
    else this.held = false;
  }
}

/** 每平台一把锁 */
const locks = new Map();
export function lockFor(key) {
  if (!locks.has(key)) locks.set(key, new AsyncLock());
  return locks.get(key);
}
/** 某平台的浏览器是否被占用（登录窗口 / 另一轮任务正在用它） */
export function lockHeld(key) {
  return locks.get(key)?.held || false;
}
/** 是否存在任意被占用的平台浏览器 */
export function anyLockHeld() {
  for (const l of locks.values()) if (l.held) return true;
  return false;
}

let pwPromise = null;

/** 惰性加载 playwright；失败时给出可执行的补救提示 */
export async function loadPlaywright() {
  if (!pwPromise) {
    pwPromise = import('playwright').catch((e) => {
      pwPromise = null;
      const err = new Error(
        '网页签到的浏览器内核不可用（' + String(e?.message || e).split('\n')[0] + '）。' +
          '修复方式：源码运行时在项目目录执行 npm install && npx playwright install chromium；' +
          '打包版在任意有 Node 的目录执行 npx playwright install chromium（内核装在系统缓存，装一次全局可用）。',
      );
      err.status = 503;
      throw err;
    });
  }
  return pwPromise;
}

let pw = null;
/** key -> { ctx, headless }：每平台一个持久化上下文 */
const contexts = new Map();

/**
 * 打开（或复用）key 平台的持久化上下文。调用方必须持有 lockFor(key)。
 * headless 参数只在首开时生效；复用时以已开实例为准（调用方按返回值感知）。
 */
export async function acquireContext(key, { headless = true, logger, proxy } = {}) {
  if (!pw) pw = await loadPlaywright();

  const cur = contexts.get(key);
  if (cur && cur.headless === headless) return cur.ctx;

  // 模式变了（比如无头运行中来了一个去登录请求）：先关掉旧的再重开
  if (cur) {
    logger?.info?.('切换浏览器模式，先关闭当前实例');
    await cur.ctx.close().catch(() => null);
    contexts.delete(key);
  }

  const profileDir = ensureProfileDir(key, logger);
  logger?.info?.(`启动 ${key} 的浏览器（headless=${headless}）profile=${profileDir}`);

  const opts = {
    headless,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1440, height: 900 },
    // 把显眼的自动化特征抹掉，降低被风控盯上的概率（不保证百分百）
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  };

  // 无头时优先用「新 headless」通道：旧 headless shell 的 UA/指纹特征更明显
  if (headless) opts.channel = 'chromium';

  // proxy='direct'：强制直连。Chromium 默认跟 Windows 系统代理，本机开着 Clash 时
  // 境外节点不通的站点（pixverse 实测）会全部超时，直连反而能过（实测 2s 打开）。
  // 注意不能用 opts.proxy={server:'direct://'}——playwright 下不生效（实测仍报代理错误），
  // 得用 --no-proxy-server 启动参数
  if (proxy === 'direct') opts.args.push('--no-proxy-server');

  let ctx;
  try {
    ctx = await pw.chromium.launchPersistentContext(profileDir, opts);
  } catch (e) {
    if (opts.channel) {
      logger?.warn?.(`新 headless 启动失败，回退默认模式: ${String(e?.message || e).split('\n')[0]}`);
      delete opts.channel;
      ctx = await pw.chromium.launchPersistentContext(profileDir, opts);
    } else {
      throw e;
    }
  }

  // 抹掉 navigator.webdriver（很多站点拿它做第一层自动化判定）
  await ctx.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    } catch {
      /* ignore */
    }
  });
  ctx.setDefaultTimeout(15_000);
  ctx.setDefaultNavigationTimeout(45_000);

  contexts.set(key, { ctx, headless });
  ctx.on('close', () => {
    if (contexts.get(key)?.ctx === ctx) contexts.delete(key);
  });
  return ctx;
}

/** 关闭 key 平台的浏览器并落盘登录态。调用方必须持有 lockFor(key)。 */
export async function releaseContext(key) {
  const cur = contexts.get(key);
  if (!cur) return;
  contexts.delete(key);
  const c = cur.ctx;
  // 关闭时 playwright 才把 cookie/localStorage 刷进 profile，这步不能省
  await c.close().catch(() => null);
}

/** 供外部探活：某平台是否已有浏览器实例在跑 */
export function hasActiveContext(key) {
  return contexts.has(key);
}
