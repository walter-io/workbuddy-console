/**
 * ZCode 官方上游客户端（反向代理用）——免 key gift 链路。
 *
 * 链路（本机 ZCode 3.18.2 实测）：
 *   端点   POST https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages
 *   鉴权   Authorization: Bearer <zcodejwttoken>（本机登录态，零配置）
 *   body   必须 dress() 成 ZCode 的三段 cached system block，否则 405/3012
 *   头     全套客户端指纹头，app_version 需 >= 3.17.2
 *   并发   免费套餐有槽位上限，超限 3008，需排队（槽位实现在 gift.mjs）
 *
 * 与旧 key 链路（BigModel 官方 anthropic 端点 + x-api-key）的区别：
 *   key 链路扣的是 **付费余额**，gift-only 账号在 key 背后没有 coding plan，
 *   不会扣到任何免费额度。本文件这条链路才吃得到用户的 ZCode 免费套餐额度。
 *
 * 安全红线：
 *   - token 只出现在 Authorization 头，绝不写日志、绝不回显到前端
 *   - 额度接口只返回数字
 *   - 不把任何登录态、账号、绝对路径写进本文件
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { giftFetch, giftBalance, currentAccount, zcodeAppVersion, zcodeCredentialsFile, invalidateLoginCache } from './gift.mjs';

/* ── 凭据监视器（换号 / 重新登录 → 清缓存） ───────────────────────────────── */

/**
 * 监视凭据文件：zcodejwttoken 变化（客户端登录/换号）→ 清登录态缓存 + 通知状态。
 * 凭据路径自动发现（不写死 home 下的固定位置）。
 */
let credJwtFingerprint = null;
let credWatcherStarted = false;
const credentialState = { lastJwtChangeAt: null, accountChanged: false };

function credJwtFingerprintNow(credFile) {
  try {
    const cred = JSON.parse(fs.readFileSync(credFile, 'utf8'));
    const jwt = cred['zcodejwttoken'] || '';
    const linked = cred['oauth:linked_bigmodel'] || '';
    const pkKey = Object.keys(cred).find((k) => k.startsWith('project-key-location'));
    return crypto.createHash('sha256').update(jwt + '|' + linked + '|' + (pkKey || '')).digest('hex').slice(0, 24);
  } catch { return null; }
}

function startCredentialWatcher(onChange) {
  if (credWatcherStarted) return;
  const credFile = zcodeCredentialsFile();
  if (!fs.existsSync(credFile)) return;
  credWatcherStarted = true;
  credJwtFingerprint = credJwtFingerprintNow(credFile);
  fs.watchFile(credFile, { interval: 15_000 }, () => {
    const fp = credJwtFingerprintNow(credFile);
    if (fp && fp !== credJwtFingerprint) {
      credJwtFingerprint = fp;
      credentialState.lastJwtChangeAt = Date.now();
      credentialState.accountChanged = true;
      invalidateLoginCache();   // 登录态换了 → 立刻丢掉缓存的 JWT/额度快照
      if (onChange) try { onChange(credentialState); } catch { /* 通知失败不影响主流程 */ }
    }
  });
}

export function getCredentialState() { return { ...credentialState, watched: credWatcherStarted }; }
export function startZcodeCredentialWatcher(onChange) { startCredentialWatcher(onChange); }

/**
 * 本机 ZCode 客户端版本（客户端指纹头要用）。
 * 探测逻辑与 gift 链路共用（gift.mjs 内部是同步探测 + 缓存 + 最低版本兜底），
 * 这里不再重复实现一遍——重复实现的那份是异步回调式，
 * 回调回来之前函数已经返回了默认值，导致探测结果永远不生效。
 */
export function zcodeClientVersion() {
  return zcodeAppVersion();
}

/* ── 会话 ID 派生 ─────────────────────────────────────────────────────────── */

/**
 * 派生 x-session-id。
 * - 显式给了就用它（客户端可传 x-session-id 头）
 * - 否则用首条 user 消息内容派生：同一会话首条消息相同 → 同 session（能命中 prompt cache）；
 *   不同会话首条不同 → 不同 session（不会串味）。
 * 绝不能所有请求共用一个常量 session id：那会让不同会话共享缓存、互相污染。
 */
export function deriveSessionId(body, explicit) {
  const e = String(explicit ?? '').trim();
  if (e) return e;
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const first = msgs.find((m) => m && m.role === 'user');
  const seed = JSON.stringify(first?.content ?? '');
  if (!seed || seed === '""') return 'proxy-' + crypto.randomUUID();
  return 'proxy-' + crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32);
}

/* ── 上游请求 ─────────────────────────────────────────────────────────────── */

/** 从 Anthropic body 里挑出 gift 链路需要的字段（其余丢弃）。 */
function toGiftReq(body) {
  return {
    model: body.model,
    max_tokens: body.max_tokens,
    messages: body.messages,
    ...(body.system !== undefined ? { system: body.system } : {}),
    ...(body.tools !== undefined ? { tools: body.tools } : {}),
  };
}

/**
 * Anthropic /v1/messages 非流式请求。
 * 返回 { ok, status, data, error }。
 */
export async function anthropicMessages(body, { timeoutMs = 120_000, sessionId } = {}) {
  const { res, body: text } = await giftFetch({
    ...toGiftReq(body),
    sessionId: deriveSessionId(body, sessionId),
    timeoutMs,
  });
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: String(text).slice(0, 400) }; }
  return {
    ok: res.ok,
    status: res.status,
    data,
    error: res.ok ? null : String((data && data.error && data.error.message) || (data && data.error) || text.slice(0, 300)),
  };
}

/**
 * Anthropic /v1/messages 流式请求：返回上游 Response（body 是 SSE web stream）。
 * 槽位释放挂在流的收尾上——调用方读完流后必须调用 giftStreamRelease(res)。
 * 首字节超时只覆盖"等响应头"这一段；拿到头后由调用方决定何时结束。
 */
export async function anthropicMessagesStream(body, { signal, firstByteTimeoutMs = 60_000, sessionId } = {}) {
  const abort = new AbortController();
  const onOuterAbort = () => abort.abort();
  if (signal) {
    if (signal.aborted) abort.abort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  const req = {
    ...toGiftReq(body),
    stream: true,
    raw: true,                                   // 让 giftFetch 把槽位交给我们释放
    sessionId: deriveSessionId(body, sessionId),
  };
  let timer = null;
  try {
    const pending = giftFetch({ ...req, signal: abort.signal });
    timer = setTimeout(() => abort.abort(), firstByteTimeoutMs);
    const { res, release } = await pending;
    clearTimeout(timer);
    timer = null;
    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (signal) signal.removeEventListener('abort', onOuterAbort);
      release();                                  // 幂等：giftFetch 内部已做去重
    };
    if (signal) {
      signal.addEventListener('abort', () => {
        // 注意：body.cancel() 返回 Promise，异步拒绝（ERR_INVALID_STATE: ReadableStream is locked）
        // **不是**同步抛错——try/catch 抓不住，必须对返回的 Promise 挂 catch，否则变成 unhandledRejection。
        try {
          const p = res.body && typeof res.body.cancel === 'function' ? res.body.cancel() : null;
          if (p && typeof p.catch === 'function') p.catch(() => { /* 流已结束或已被读取器锁定 */ });
        } catch { /* 已结束 */ }
        cleanup();
      }, { once: true });
    }
    giftStreamReleases.set(res, cleanup);
    return res;
  } catch (e) {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
    throw e;
  }
}

/** 流式槽位释放表：调用方转发完成后调用 giftStreamRelease(res) 释放 gift 槽位 */
export const giftStreamReleases = new WeakMap();
export function giftStreamRelease(res) {
  const c = giftStreamReleases.get(res);
  if (c) { giftStreamReleases.delete(res); try { c(); } catch { /* 释放失败不应影响响应 */ } }
}

/** 模型清单（start-plan 固定集；后续官方动态下发时再换成接口拉取） */
export function listUpstreamModels() {
  return {
    models: ['GLM-5.3', 'GLM-5.3-Flash', 'GLM-4.7', 'GLM-4.7-Flash', 'GLM-4.6'],
    source: 'static (bigmodel start-plan)',
  };
}

/** 免费套餐额度（给控制台 Token 统计页用；只回数字，不回 token） */
export async function giftPlanBalances(opts = {}) {
  return giftBalance(opts);
}

/** 当前登录账号（不含 token） */
export async function giftAccount() {
  return currentAccount();
}
