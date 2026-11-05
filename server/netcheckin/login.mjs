/**
 * 「去登录」会话：给网页类平台补登录态用的。
 *
 * 流程：页面点「去登录」→ 这里弹一个真实浏览器窗口打开该平台的登录页 →
 * 用户扫码/输手机号 → 后台每 2.5 秒探测一次「登录成功了吗」→ 成功后自动
 * 关窗、把登录态落进共享 profile，全程不需要回终端敲命令。
 *
 * 同一时间只允许一个登录窗口（profile 是独占的）；自动代领撞上登录窗口时
 * 会直接跳过本轮，所以登录不会被打断。
 */

import { lockFor, acquireContext, releaseContext } from './browser.mjs';
import { pageVisibleText } from './dom.mjs';
import { zhipuProbe } from './engines.mjs';
import { loadConfig, saveConfig, resolvePlatforms } from './store.mjs';

/** 登录窗口时限：30 分钟——要给滑块验证、刷新重试、等短信验证码留足时间，
 *  10 分钟的旧时限在 Vidu 这类带人机验证的站上会把用户填到一半的登录掐断 */
const MAX_MINUTES = 30;
const POLL_MS = 2500;

/** 各平台最近一次登录成功的时间戳：调度器靠它判断「登录失效」的平台是否已重新登录 */
const loginOkAt = new Map();
export function markLoginOk(id) {
  const now = Date.now();
  loginOkAt.set(id, now);
  // 落盘：服务重启后记账不能丢，否则登录过的平台会被误判回「需要登录」
  try {
    const cfg = loadConfig();
    cfg.logins = { ...(cfg.logins || {}), [id]: now };
    saveConfig(cfg);
  } catch {
    /* 落盘失败只影响重启后的显示，不影响登录态本身 */
  }
  // 立即推进运行代数：前端 2 秒一轮的状态轮询马上就能把「登录」按钮摘掉，
  // 不用等 60 秒状态缓存自然过期（2026-11-05 用户反馈：登录后按钮不消失）。
  // 动态 import 避免与 runner.mjs 的静态循环依赖。
  import('./runner.mjs')
    .then((m) => {
      m.runEpoch.value++;
    })
    .catch(() => {});
}
export function loginOkSince(id) {
  let disk = 0;
  try {
    disk = loadConfig().logins?.[id] || 0;
  } catch {
    /* 读不到就只看内存 */
  }
  return Math.max(loginOkAt.get(id) || 0, disk);
}

/** 单例登录会话状态（前端轮询这个） */
const state = {
  id: null,
  name: '',
  stage: 'idle', // idle | waiting | success | failed | timeout | cancelled
  message: '',
  startedAt: null,
  finishedAt: null,
};

export function loginState() {
  return { ...state };
}

/* 各平台「登录成功」的判定方式：默认看登录表单文案是否消失 */
const DETECTORS = {
  zhipu: async (page) => zhipuProbe(page),
  // 百度系（Comate）：登录态就是 BDUSS cookie（百度全域会话）——页面上的
  // 「退出登录」藏在账号悬停菜单里，innerText 抓不到，文字判定对它无效
  comate: async (page, ctx) => {
    const cookies = await ctx.cookies('https://comate.baidu.com').catch(() => []);
    if (cookies.some((c) => (c.name === 'BDUSS' || c.name === 'BDUSS_BFESS') && c.value)) {
      return { ok: true, why: '百度登录态（BDUSS）有效' };
    }
    return { ok: false, why: '未检测到百度登录态' };
  },
  minimax: async (page) => {
    const text = await pageVisibleText(page, 6000).catch(() => '');
    const loginForm = /获取验证码|微信扫码登录|请输入您的手机号/.test(text);
    const logged = /每日签到|签到得|MiniMax\d+/.test(text);
    return { ok: !loginForm && logged, why: loginForm ? 'login-form' : logged ? 'user-ui' : 'unknown' };
  },
  // 哩布哩布：登录后页头会出现「算力」余额字样（未登录时不显示），退出入口
  // 藏在头像悬停菜单里 innerText 抓不到——文字兜底之外再认一组登录 cookie。
  liblib: async (page, ctx) => {
    const text = await pageVisibleText(page, 6000).catch(() => '');
    if (/退出登录|退出帐号|注销登录/.test(text)) return { ok: true, why: '发现退出登录入口' };
    if (/算力/.test(text)) return { ok: true, why: '页头出现算力余额（登录态正证）' };
    const cookies = await ctx.cookies('https://www.liblib.art').catch(() => []);
    if (cookies.some((c) => c.value && c.value.length > 10 && /liblib|authorization|_token|session/i.test(c.name))) {
      return { ok: true, why: '哩布哩布登录 cookie 已出现' };
    }
    return { ok: false, why: /扫码登录|请输入手机号|获取验证码/.test(text) ? '登录表单仍在' : '未检测到登录态（页头没有算力字样）' };
  },
};

async function detectDefault(page) {
  const text = await pageVisibleText(page, 6000).catch(() => '');
  // 登录表单还在 → 未登录
  if (/扫码登录|短信验证码|验证码登录|请输入手机号|请先登录|微信扫码登录|获取验证码/.test(text)) {
    return { ok: false, why: 'login-form' };
  }
  // 人机验证/滑块挑战页（阿里云 ESA 等）：既不是已登录也不是登录表单——
  // 之前这类页面会被误判成「已登录」导致登录窗秒关（Vidu 实测）。等用户拖完滑块。
  if (/验证您是真人|请按住滑块|拖动到最右|人机验证|安全验证/.test(text)) {
    return { ok: false, why: '人机验证进行中' };
  }
  // 「退出登录」入口 = 已登录的正证
  if (/退出登录|退出帐号|注销登录/.test(text)) return { ok: true, why: '发现退出登录入口' };
  // 页面还挂着「登录 / 注册」入口按钮（Vidu 等落地页）→ 未登录
  if (/(^|\n)\s*(登录 \/ 注册|登录\/注册|登录|注册)\s*(\n|$)/.test(text)) return { ok: false, why: '登录入口仍在' };
  // 其余情况无法判定（Vidu 等站点的登录入口是图标、页面无文字）：
  // 绝不能凭「没看到登录字样」就当登录成功——那会误报「凭据已保存」。
  // 保持等待：用户登录成功后站点会出现退出入口，或由用户手动关窗结束
  // （关窗时凭据同样会落盘保存）。
  return { ok: false, why: '无法确认是否已登录' };
}

function setStage(stage, message = '') {
  state.stage = stage;
  if (message) state.message = message;
}

/** 结束当前会话（成功/超时/取消共用）：关窗 + 释放该平台的 profile 锁 */
async function teardown() {
  if (state.id) await releaseContext(state.id).catch(() => null);
  if (state.id) lockFor(state.id).release();
  state.finishedAt = Date.now();
}

/** 前端点「去登录」：开窗后立刻返回，结果靠轮询 loginState() */
export async function startLogin(platformId) {
  if (state.stage === 'waiting') {
    return { ok: false, error: `正在为「${state.name}」等待登录，请先完成或取消` };
  }

  const platform = resolvePlatforms().find((p) => p.id === platformId);
  if (!platform) return { ok: false, error: `没有这个平台: ${platformId}` };
  if (platform.kind === 'client') {
    return { ok: false, error: `${platform.name} 是客户端类平台，请打开它的桌面客户端登录，这里不需要也不支持网页登录` };
  }
  if (!platform.loginUrl) return { ok: false, error: '这个平台没配登录页地址' };

  // 只锁这个平台自己的浏览器：其它平台的检测/领取/登录完全不受影响
  if (!lockFor(platformId).tryAcquire()) {
    return { ok: false, error: '该平台的浏览器正忙（可能在领取或检测中），稍后再试' };
  }

  state.id = platform.id;
  state.name = platform.name;
  state.startedAt = Date.now();
  state.finishedAt = null;
  setStage('waiting', '浏览器窗口已打开，等待登录');

  // 整个等待过程放后台跑，调用方不等；ended 保证各种结束路径只收尾一次
  let ended = false;
  const end = async (stage, message) => {
    if (ended) return;
    ended = true;
    setStage(stage, message);
    await teardown().catch(() => null);
  };

  void (async () => {
    let page = null;
    try {
      if (state.stage === 'cancelled') return; // 取消来得太快：锁已在 cancelLogin 里释放
      const ctx = await acquireContext(state.id, { headless: false });
      if (state.stage === 'cancelled') {
        await releaseContext(state.id).catch(() => null);
        lockFor(state.id).release();
        return;
      }
      // 用户手动关掉登录窗口 = 放弃本次登录：立即如实结束，
      // 不再挂到超时、更不能给出「凭据已保存」的误导提示（凭据是否已存取决于是否真的登录过）
      ctx.on('close', () => {
        if (!ended && state.stage !== 'cancelled') end('cancelled', '登录窗口已手动关闭，本次未完成登录');
      });
      page = await ctx.newPage();
      await page.goto(platform.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(2500);
      await page.bringToFront().catch(() => null);

      // 页面本身还停在登录墙/未登录首页时才替用户点开登录入口；
      // 已登录状态下乱点「登录」可能把会话带进重登流程
      const preText = await pageVisibleText(page, 4000).catch(() => '');
      if (/扫码登录|短信验证码|验证码登录|请输入手机号|微信扫码登录|登录 \/ 注册/.test(preText)) {
        for (const sel of ['button:has-text("登录")', 'button:has-text("登录 / 注册")', 'text=登录']) {
          try {
            const loc = page.locator(sel).first();
            if (await loc.isVisible({ timeout: 1500 })) {
              await loc.click({ timeout: 4000 });
              setStage('waiting', '已替你点开登录窗，扫码或输手机号即可');
              break;
            }
          } catch {
            /* 换下一个 */
          }
        }
      }

      const detect = DETECTORS[platform.id] || detectDefault;
      const deadline = Date.now() + MAX_MINUTES * 60_000;
      let lastWhy = '';
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (ended || state.stage === 'cancelled') return; // 用户取消/关窗时 teardown 已做过
        const r = await detect(page, ctx).catch(() => ({ ok: false, why: 'err' }));
        if (r.ok) {
          await new Promise((resolve) => setTimeout(resolve, 1500)); // 让 cookie 落地
          markLoginOk(state.id);
          await end('success', `${platform.name} 登录完成，凭据已存进本机`);
          return;
        }
        if (r.why !== lastWhy) {
          lastWhy = r.why;
          setStage('waiting', `等待登录中（${r.why}）`);
        }
      }

      await end('timeout', `${MAX_MINUTES} 分钟内未检测到登录成功，窗口已关闭${'（若你已完成登录，凭据同样已保存）'}`);
    } catch (e) {
      await end('failed', `登录过程出错: ${String(e?.message || e).split('\n')[0]}`);
    }
  })();

  return { ok: true, id: platform.id, name: platform.name };
}

/** 用户主动放弃：关窗 + 释放锁 */
export async function cancelLogin() {
  if (state.stage !== 'waiting') return { ok: true };
  setStage('cancelled', '已取消');
  await teardown().catch(() => null);
  return { ok: true };
}
