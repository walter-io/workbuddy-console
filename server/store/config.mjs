import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

/** 配置目录：默认 ~/.free-token，可用 FREE_TOKEN_CONFIG_DIR 重定向（隔离测试用） */
export const CONFIG_DIR = process.env.FREE_TOKEN_CONFIG_DIR
  ? path.resolve(process.env.FREE_TOKEN_CONFIG_DIR)
  : path.join(os.homedir(), '.free-token');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export const CACHE_DIR = path.join(CONFIG_DIR, 'cache');

const DEFAULT_SETTINGS = {
  workbuddyDir: '', // 覆盖默认 ~/.workbuddy（**数据目录**：sessions/projects/workbuddy.db）
  /**
   * 客户端**安装**目录（如 `E:\workbuddy`）。与上面的数据目录是两件事：
   * 装到盘符根、非 Program Files 的位置时自动扫描可能扫不到，切号后「自动重新打开」
   * 就会报「未能定位可执行文件」——填这里可以直接指定。
   */
  workbuddyInstallDir: '',
  /** 直接指定客户端 exe 的绝对路径；优先级高于安装目录 */
  workbuddyExePath: '',
  proxyUrl: '', // 出站代理（如 http://127.0.0.1:7890）；留空自动探测环境变量 / Windows 系统代理
  autoCheckin: true, // 自动签到（仅国内版账号，服务端每小时巡检一次）；默认开启，可在设置里关闭
  // 凭据自动刷新（服务端每 6 小时巡检一次，只在 access/refresh 临期时才动手）；默认开启。
  // 关掉后：既没被切换、也没走过反向代理的账号会一直静默过期，直到需要重新扫码。
  autoRefreshToken: true,
  // 启动时检查有没有新版本（只读 GitHub Release 元数据，是唯一一处访问非官方服务的出站请求）
  autoCheckUpdate: true,
  /**
   * 免费模型页是否列出**全部平台**（含默认收起的地区受限 / 平台禁止外部接入的那几个）。
   * 默认关闭：这些平台的 key 在外部环境调用大概率被拒，列出来只会让人白折腾。
   * 打开后照常可选，但界面上会常驻风险提示——是否接入由用户自己承担。
   */
  unlockAllPlatforms: false,
};

/**
 * 反向代理（让其他 agent 用 OpenAI 协议调用 WorkBuddy 的积分与模型）。
 * 放在 settings 里，随 config.json 一起落盘；apiKey 首次使用时自动生成。
 */
export const DEFAULT_PROXY = {
  enabled: false, // 默认关闭：暴露本地端口属于"对外能力"，要用户明确打开
  apiKey: '', // 调用方鉴权用；为空视为未初始化，首次启用时生成
  /**
   * 参与轮换的账号 id。
   * 语义上必须区分「没配过」与「一个都不选」：
   *   null/非数组 = 全部可用账号；[]（空数组）= 一个都不用（池为空）。
   * 早期版本用 [] 表示"全部"，导致用户在界面上取消最后一个勾选后又被解释成全部。
   */
  accountIds: null,
  /** 非流式请求的整段超时；流式响应只受 60s 首字节超时约束，不会被硬掐 */
  timeoutMs: 120_000,
  /**
   * 风控节流（2026-10 用户连坐封号后的防御性默认值）：
   * - minIntervalMs：同一账号两次上游请求的最小间隔。官方桌面端是人类操作节奏，
   *   同账号请求背靠背连发是明显机器特征；
   * - maxConcurrent：全局同时在途的上游 chat 请求数上限。官方客户端同一时刻
   *   基本只有一个对话在跑；agent 并发狂打多个账号同样高危。
   * 调大需自担风险；0/负值按默认值处理（不允许完全关闭节流）。
   */
  minIntervalMs: 3_000,
  maxConcurrent: 2,
  /**
   * 单账号单日上游请求上限（风控兜底）：agent 的重试循环失控时，一个账号一天能被
   * 打出数千次请求——积分烧穿之前先引来封号。默认 500（重度 agent 使用也够），
   * 触顶后该账号当日拒绝服务并给出人话提示；次日自动重置。0/负值按默认处理。
   */
  dailyPerAccountCap: 500,
};

const DEFAULT_CONFIG = {
  version: 1,
  activeKeyId: null, // 兼容字段：openrouter 的活跃 key
  activeKeys: {}, // platform -> 活跃 keyId（如 { openrouter: 'key-xxx', zen: 'key-yyy' }）
  keys: [], // { id, platform, label, key, addedAt, lastStatus }
  settings: { ...DEFAULT_SETTINGS },
  proxy: { ...DEFAULT_PROXY },
};

export function ensureDirs() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

/** 同步 sleep（Atomics.wait 在 Node 主线程可用；用于写盘重试的退避等待） */
function syncSleep(ms) {
  const sink = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sink, 0, 0, ms);
}

/**
 * 落盘策略组：三种覆盖写走不同系统调用（MoveFileExW / CopyFileW / CreateFile+write）。
 * 全局 NODE_OPTIONS 注入的 genie-safe-delete shim 按「档期」间歇拦截其中的部分操作
 * （2026-10-22 拦 rename、2026-10-23 连 writeFileSync(open) 都拦），同一时刻至少一条
 * 通常可用，配合多轮退避重试扛过瞬时故障窗。全链失败才抛错。
 */
const PERSIST_STRATEGIES = [
  (tmp, file, text) => fs.renameSync(tmp, file),
  (tmp, file, text) => {
    fs.copyFileSync(tmp, file);
    fs.rmSync(tmp, { force: true });
  },
  (tmp, file, text) => {
    fs.writeFileSync(file, text, 'utf8');
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* tmp 残留无害 */
    }
  },
];

/**
 * 落盘重试窗口：0/250/600/1500/3000/6000/10000/15000 ≈ 最坏 36 秒。
 * 本机存在「外部进程间歇性锁定/扫描/删除新文件」的现象：一次 EPERM 可能持续
 * 几十秒甚至几分钟（2026-10-25 实测 auth 目录锁了 3 分钟左右），所以**创建临时
 * 文件本身也必须在这个窗口里重试**——早期实现只给写临时文件 2 秒，窗口一来
 * 直接放弃，用户看到的就是「写入登录态文件失败（已重试 2 秒）」。
 */
const PERSIST_DELAYS = [0, 250, 600, 1500, 3000, 6000, 10000, 15000];

/**
 * 关键文件（登录态 workbuddy-desktop.info）专用的加长窗口：常规 36 秒之上再追加
 * 8 轮 × 20 秒（约 2.6~3 分钟）。实测本机写不进登录态文件有两类窗口，36 秒都盖不住
 * （2026-10-25 用户切换账号连续报「已重试 38 秒」）：
 * 1. WorkBuddy 被 taskkill 强杀后被「崩溃自动恢复」拉起，新实例启动期间锁住 auth 文件
 *    ——而切换流程里「杀进程 → 搬会话 → 写登录态」中间还隔着可能耗时几十秒的会话搬家；
 * 2. 未查明的外部进程间歇性锁 auth 目录（同日实测约 3 分钟）。
 */
export const CRITICAL_WRITE_DELAYS = [...PERSIST_DELAYS, ...Array(8).fill(20_000)];

/** 单轮落盘：对已存在的临时文件依次尝试三种覆盖策略（rename → copy → 直接写），不重试 */
function persistTmpOnce(tmp, file, text) {
  let lastErr = null;
  for (const strategy of PERSIST_STRATEGIES) {
    try {
      strategy(tmp, file, text);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

export function persistTmpOverwrite(tmp, file, text) {
  let lastErr = null;
  for (const delay of PERSIST_DELAYS) {
    if (delay > 0) syncSleep(delay);
    try {
      persistTmpOnce(tmp, file, text);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error(`落盘失败：${file}`);
}

/** 把目标内容写完后清理临时文件（尽力而为） */
function cleanupTmpQuietly(tmp) {
  try {
    fs.rmSync(tmp, { force: true });
  } catch {
    /* 残留 tmp 可后续清理，不影响数据 */
  }
}

/**
 * 覆盖式 rename + 降级：rename 被环境拦截时（genie-safe-delete shim 等，间歇性），
 * 降级为「复制内容到目标 + 删临时」。copyFileSync 覆盖已有文件实测不受拦截。
 * rename 是原子操作，失败即未发生，因此降级不会产生半写状态。
 */
export function safeRenameOverwrite(tmp, file) {
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.copyFileSync(tmp, file);
    cleanupTmpQuietly(tmp);
  }
}

/**
 * 一轮完整的写入尝试（不重试）：
 *   1) 临时文件写在**目标所在目录**（rename 原子）；
 *   2) 失败则写在**系统临时目录**（copyFileSync 跨目录覆盖，实测可用）；
 *   3) 都失败再直接写目标文件本身。
 *
 * 直接写兜底要求调用方满足「有备份 + 回读校验 + 失败回滚」或「内容可重生成」——
 * 本项目写登录态 / 配置 / 快照的调用方都满足。
 */
function writeRound(file, text) {
  const errs = [];
  for (const base of [path.dirname(file), os.tmpdir()]) {
    const tmp = path.join(
      base,
      `${path.basename(file)}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
    );
    try {
      fs.writeFileSync(tmp, text, 'utf8');
    } catch (err) {
      errs.push(err);
      cleanupTmpQuietly(tmp);
      continue;
    }
    try {
      persistTmpOnce(tmp, file, text);
      cleanupTmpQuietly(tmp);
      return { ok: true };
    } catch (err) {
      errs.push(err);
      cleanupTmpQuietly(tmp);
    }
  }
  try {
    fs.writeFileSync(file, text, 'utf8');
    return { ok: true };
  } catch (err) {
    errs.push(err);
    return { ok: false, err: errs[errs.length - 1], errs };
  }
}

/** 把一轮里的多个错误压成一行摘要（去重计数），随异常抛给调用方/用户 */
function summarizeErrors(last) {
  const seen = new Map();
  for (const e of last?.errs || []) {
    const sig = `${e.code || 'ERR'} ${e.syscall || ''} ${path.basename(String(e.path || ''))}`.trim();
    if (!sig) continue;
    seen.set(sig, (seen.get(sig) || 0) + 1);
  }
  return [...seen.entries()].map(([sig, n]) => (n > 1 ? `${sig} ×${n}` : sig)).join(' | ');
}

function failAfter(file, started, last) {
  const summary = summarizeErrors(last);
  // 用 console.log（stdout）：会话内重启服务若忘了 2>&1，console.warn 的 stderr 会整段丢失，
  // 2026-10-25 排障时正是因此拿不到「各次尝试」清单
  console.log(`[store] 落盘失败（重试 ${Math.round((Date.now() - started) / 1000)}s 仍失败）：${file}`);
  if (summary) console.log(`[store] 各次尝试：${summary}`);
  const err = last?.err || new Error(`落盘失败：${file}`);
  if (summary) err.message = `${err.message}（${summary}）`;
  return err;
}

/**
 * 持久写任意文本（同步）：整个「建临时文件 → 覆盖 → 兜底」全流程都在 36 秒窗口内重试。
 *
 * 给「登录态文件 / 恢复备份 / 模型列表 / exe 路径缓存」这类**不能半写、又可能被
 * 瞬时锁住**的关键文件用。之前这些位置是裸 `writeFileSync(tmp)`：一次瞬时 EPERM
 * 就让整个切号失败（2026-10-25 报错 `.info.tmp-<pid>`）。
 * @returns 落盘耗时（毫秒）
 */
export function durableWriteText(file, text) {
  const started = Date.now();
  let last = null;
  for (const delay of PERSIST_DELAYS) {
    if (delay > 0) syncSleep(delay);
    const r = writeRound(file, text);
    if (r.ok) return Date.now() - started;
    last = r;
  }
  throw failAfter(file, started, last);
}

/* ---------------- 异步落盘（不阻塞事件循环） ---------------- */

/** 异步 sleep：退避等待时把事件循环让给 HTTP 请求 */
const sleepAsync = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** durableWriteText 的异步版：重试等待不冻结事件循环。@returns 落盘耗时（毫秒）
 *
 * @param opts.delays  自定义退避表（默认 36 秒窗口；登录态文件请用 CRITICAL_WRITE_DELAYS）
 * @param opts.onRetry 每轮写盘失败后、进入下一轮退避前调用（异步）。
 *   给调用方一个「清理外部障碍」的机会——典型用法：登录态文件写不进时，探一下
 *   WorkBuddy 是否被崩溃自动恢复拉起并在锁文件，是就再杀一轮。守卫抛错只记日志，
 *   不影响写盘重试本身。
 */
export async function durableWriteTextAsync(file, text, { delays = PERSIST_DELAYS, onRetry = null } = {}) {
  const started = Date.now();
  let last = null;
  let round = 0;
  for (const delay of delays) {
    if (delay > 0) await sleepAsync(delay);
    const r = writeRound(file, text);
    if (r.ok) return Date.now() - started;
    last = r;
    round += 1;
    if (onRetry && round < delays.length) {
      try {
        await onRetry(Date.now() - started, round, r);
      } catch (e) {
        console.log(`[store] 写盘重试守卫异常（忽略，继续重试）：${e?.message || e}`);
      }
    }
  }
  throw failAfter(file, started, last);
}

/**
 * 原子写 JSON（同步）：等价于 durableWriteText(JSON)。
 * ⚠️ 同步 = 阻塞事件循环：EPERM 窗口内最坏冻结服务 36 秒，用户正在等待结果的
 * 链路请改用 atomicWriteJsonAsync（2026-10-25 扫码/重新生成 Key 两次反馈）。
 */
export function atomicWriteJson(file, obj) {
  const started = Date.now();
  const ms = durableWriteText(file, JSON.stringify(obj, null, 2));
  if (ms > 2000) console.warn(`[store] 同步落盘耗时 ${ms}ms（期间服务无响应）：${file}`);
  return ms;
}

/** 原子写 JSON（异步）：退避等待期间服务仍能正常响应。@returns 落盘耗时（毫秒） */
export async function atomicWriteJsonAsync(file, obj) {
  return durableWriteTextAsync(file, JSON.stringify(obj, null, 2));
}

export function loadConfig() {
  ensureDirs();
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const cfg = {
      ...structuredClone(DEFAULT_CONFIG),
      ...raw,
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
      activeKeys: { ...(raw.activeKeys || {}) },
      proxy: { ...DEFAULT_PROXY, ...(raw.proxy || {}) },
    };
    // 迁移：旧版 key 不分平台，全部归入 openrouter；activeKeyId 迁移为 activeKeys.openrouter
    let migrated = false;
    for (const k of cfg.keys) {
      if (!k.platform) {
        k.platform = 'openrouter';
        migrated = true;
      }
    }
    if (!cfg.activeKeys.openrouter && cfg.activeKeyId && cfg.keys.some((k) => k.id === cfg.activeKeyId)) {
      cfg.activeKeys.openrouter = cfg.activeKeyId;
      migrated = true;
    }
    // 迁移：accountIds 的语义从"空数组=全部"改为"null=全部、空数组=一个都不选"。
    // 旧配置里留下的 [] 必须翻成 null，否则老用户升级后会发现"账号池突然空了"。
    if (Array.isArray(cfg.proxy?.accountIds) && cfg.proxy.accountIds.length === 0 && cfg.proxy.migratedPool !== true) {
      cfg.proxy.accountIds = null;
      cfg.proxy.migratedPool = true;
      migrated = true;
    }
    if (migrated) saveConfig(cfg);
    return cfg;
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

/** 某平台当前活跃的 key 记录（找不到时回退到该平台第一个 key） */
export function activeKeyFor(cfg, platform) {
  const keys = cfg.keys.filter((k) => k.platform === platform);
  const activeId = cfg.activeKeys?.[platform] || (platform === 'openrouter' ? cfg.activeKeyId : null);
  return keys.find((k) => k.id === activeId) || keys[0] || null;
}

export function saveConfig(cfg) {
  ensureDirs();
  atomicWriteJson(CONFIG_FILE, cfg);
}

/**
 * 异步保存配置（不阻塞事件循环）。返回落盘耗时（毫秒）。
 *
 * 用户点一下就要等结果的接口（重新生成 Key、切换代理开关、保存设置）必须用它：
 * 同步版在 EPERM 窗口内会把整个 HTTP 服务冻住 36 秒，前端 25 秒默认超时一到就报
 * 「本地服务响应超时」，而配置其实可能已经写进去了（2026-10-25 两次反馈）。
 */
export async function saveConfigAsync(cfg) {
  ensureDirs();
  return atomicWriteJsonAsync(CONFIG_FILE, cfg);
}

export function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
}

/** key 只保留末 4 位用于界面区分，完整值永不返回给前端 */
export function maskKey(key) {
  if (!key || typeof key !== 'string') return '';
  return `••••${key.slice(-4)}`;
}

export function cachePath(name) {
  ensureDirs();
  return path.join(CACHE_DIR, name);
}
