/**
 * WorkBuddy 官方上游客户端（反向代理用）。
 *
 * 形态参考 workbuddy2api（Go 实现）逆向出的官方桌面端出站协议：
 * 同一套 chat / models / refresh 端点，靠一组「客户端指纹头」通过网关风控校验。
 * 本模块只做三件事：造头、发请求、刷新 token；不含任何账号调度逻辑。
 *
 * 安全红线：
 * - refresh_token 只出现在 refresh 请求头（X-Refresh-Token），绝不进 chat 请求；
 * - 绝不跨档位请求：国内版只打 copilot.tencent.com，国际版只打 www.workbuddy.ai。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { loadAccounts, saveAccountsAsync, secretValue, STORE_DIR } from '../workbuddy/accounts.mjs';
import { variantOf } from '../workbuddy/variant.mjs';
import { syncTokensToAuthFile } from '../workbuddy/auth.mjs';
import { findWorkbuddyExe } from '../targets/workbuddy.mjs';

/**
 * 出站客户端版本：**运行时探测本机安装的 WorkBuddy 实际版本**（exe FileVersion），
 * 探测不到才回落默认值。此前写死 5.5.4，而本机实际安装 5.3.11——同一台设备的
 * 官方客户端与控制台出站版本不一致，是可关联的差异信号（每台机器版本还各不相同）。
 * 与真机 MachineGuid 同一哲学：出站身份与真实环境一致。
 */
const CLIENT_VERSION_FALLBACK = '5.5.4';
const CLI_VERSION = '2.137.1';
let _clientVersion = null;
async function clientVersionOnce() {
  if (_clientVersion) return _clientVersion;
  try {
    const exe = findWorkbuddyExe();
    if (exe) {
      const v = await new Promise((resolve) => {
        execFile(
          'powershell.exe',
          ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${String(exe).replace(/'/g, "''")}').VersionInfo.FileVersion`],
          { timeout: 8000, windowsHide: true },
          (err, stdout) => resolve(err ? null : String(stdout || '').trim())
        );
      });
      if (/^\d+(\.\d+)+$/.test(v || '')) {
        _clientVersion = v;
        console.log(`[wb] 出站客户端版本对齐本机安装版本：${v}`);
        return v;
      }
    }
  } catch {
    /* 探测失败回落默认 */
  }
  _clientVersion = CLIENT_VERSION_FALLBACK;
  return _clientVersion;
}

/**
 * chat 域按档位分流：国内版走 copilot.tencent.com（官网域 www.codebuddy.cn 不放行 /v2/chat），
 * 国际版走 www.workbuddy.ai。
 */
const CHAT_BASE = {
  cn: 'https://copilot.tencent.com',
  ai: 'https://www.workbuddy.ai',
};

const CHAT_PATH = '/v2/chat/completions';
const MODELS_PATH = '/console/enterprises/personal/models';
const REFRESH_PATH = '/v2/plugin/auth/token/refresh';

/** 官网域（Origin / Referer / X-Domain 用） */
const ORIGIN = {
  cn: 'https://www.codebuddy.cn',
  ai: 'https://www.workbuddy.ai',
};

function chatBase(variant) {
  return CHAT_BASE[variant === 'ai' ? 'ai' : 'cn'];
}

function originFor(variant) {
  return ORIGIN[variant === 'ai' ? 'ai' : 'cn'];
}

/** 32 位随机 hex，对齐官方客户端的请求/消息 ID 形状 */
function newId() {
  return crypto.randomBytes(16).toString('hex');
}

/** 按 uid 稳定派生标识（仅剩非设备语义的用途；设备/会话标识已改用真机身份，见下） */
function stableId(uid, purpose) {
  return crypto.createHash('sha256').update(`wb2a:${purpose}:${uid || ''}`).digest('hex').slice(0, 36);
}

/**
 * 真机设备身份（与官方客户端同源同值）：
 * 官方 CLI 的 machineId = Windows 注册表 HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid
 * （反编译 codebuddy.js 实证：winUuid = reg query ... MachineGuid），**所有账号共用**。
 * 此前这里按账号 uid 伪造每账号一个"设备 ID"——服务端视角变成「同 IP 下 N 台设备各挂
 * 一个账号」的批量养号特征，与 2026-10 反馈的连坐封号高度吻合。改为真机 GUID 后，
 * 出站身份与事实一致：一台设备（官方多账号功能本就支持）、每个账号自己的 uid。
 * 读取失败时退回 ~/.wb-switch/device.json 里的稳定 UUID（同为"本机一个身份"语义）。
 */
const MACHINE_ID_FILE = path.join(STORE_DIR, 'device.json');

function readWindowsMachineGuid() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    execFile(
      'reg.exe',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const m = String(stdout || '').match(/MachineGuid\s+REG_SZ\s+(\S+)/);
        resolve(m ? m[1] : null);
      }
    );
  });
}

let _machineId = null;
async function machineIdOnce() {
  if (_machineId) return _machineId;
  const guid = await readWindowsMachineGuid();
  if (guid) {
    _machineId = guid;
    return guid;
  }
  // 兜底：本机一个稳定 UUID（落盘，跨重启恒定）
  try {
    fs.mkdirSync(path.dirname(MACHINE_ID_FILE), { recursive: true });
    const raw = JSON.parse(fs.readFileSync(MACHINE_ID_FILE, 'utf8'));
    if (raw?.id) {
      _machineId = String(raw.id);
      return _machineId;
    }
  } catch {
    /* 不存在则新建 */
  }
  _machineId = crypto.randomUUID();
  try {
    fs.writeFileSync(MACHINE_ID_FILE, JSON.stringify({ id: _machineId, at: Date.now() }, null, 2));
  } catch {
    /* 写不进就进程内使用 */
  }
  return _machineId;
}

/** 会话标识：官方语义为「客户端本次会话」，每进程一个（重启更换），与账号无关 */
const SESSION_ID = crypto.randomUUID();

function userAgent(variant, clientVersion) {
  const platform = variant === 'ai' ? 'WorkBuddy AI' : 'WorkBuddy';
  return `WorkBuddy/${clientVersion} ${platform}/${clientVersion} CLI/${CLI_VERSION}`;
}

/**
 * 组装 chat 出站头。uid/enterpriseId/domain 全部来自账号库，不额外存储副本。
 * isStream 时 Accept 要声明 event-stream，否则上游可能直接返回非流式。
 */
export async function chatHeaders(account, { isStream = false } = {}) {
  const clientVersion = await clientVersionOnce();
  const variant = variantOf(account).id;
  const token = typeof secretValue(account, 'access_token') === 'string' ? secretValue(account, 'access_token') : '';
  const uid = String(account?.uid || '');
  const origin = originFor(variant);
  const h = {
    'Content-Type': 'application/json',
    Accept: isStream ? 'application/json, text/event-stream' : 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: origin,
    Referer: `${origin}/`,
    'User-Agent': userAgent(variant, clientVersion),
    'X-CodeBuddy-Request': '1',
    'Accept-Language': variant === 'ai' ? 'en-US' : 'zh-CN',
  };
  if (token) h.Authorization = `Bearer ${token}`;
  else h['X-No-Authorization'] = '1';
  if (uid) {
    h['X-User-Id'] = uid;
    // 设备/会话标识用真机身份（见 machineIdOnce 注释）：官方客户端一台机器上所有
    // 账号发同一个 MachineGuid；按账号伪造不同设备 ID 是批量养号特征（封号连坐）
    h['X-Machine-ID'] = await machineIdOnce();
    h['X-Session-ID'] = SESSION_ID;
  } else {
    h['X-No-User-Id'] = '1';
  }
  const enterpriseId = String(account?.enterpriseId || '');
  if (variant === 'ai') {
    // 国际版：无企业 ID，显式声明国际域（与 Origin 同域）
    h['X-No-Enterprise-Id'] = '1';
    h['X-Domain'] = 'www.workbuddy.ai';
  } else {
    if (enterpriseId) h['X-Enterprise-Id'] = enterpriseId;
    else h['X-No-Enterprise-Id'] = '1';
    if (account?.domain) h['X-Domain'] = String(account.domain);
    else h['X-No-Department-Info'] = '1';
  }
  // 用量归属：伪装官方桌面端指纹（缺这些头时上游用量归因会显示"网关特征"）
  h['X-Agent-Purpose'] = 'conversation';
  h['X-IDE-Name'] = 'WorkBuddy';
  h['X-IDE-Type'] = 'WorkBuddy';
  h['X-IDE-Version'] = clientVersion;
  h['X-Product'] = 'WorkBuddy';
  // 会话头族：一次请求内所有重试复用同一 conversationRequestId
  const reqId = newId();
  h['X-Conversation-Request-ID'] = reqId;
  h['X-Root-Request-ID'] = reqId;
  h['X-Trace-ID'] = reqId;
  h['X-Request-ID'] = newId();
  h['X-Conversation-Message-ID'] = newId();
  h['X-B3-TraceId'] = reqId;
  h['X-B3-SpanId'] = newId().slice(0, 16);
  h['X-B3-Sampled'] = '1';
  return h;
}

/** 刷新 access token（X-Refresh-Token 只允许出现在 refresh 端点） */
function refreshHeaders(account, clientVersion) {
  const variant = variantOf(account).id;
  const origin = originFor(variant);
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: origin,
    Referer: `${origin}/`,
    'User-Agent': userAgent(variant, clientVersion),
    'X-CodeBuddy-Request': '1',
    'X-Refresh-Token': String(secretValue(account, 'refresh_token') || ''),
    'X-Auth-Refresh-Source': 'plugin',
    ...(account?.uid ? { 'X-User-Id': String(account.uid) } : {}),
  };
}

/**
 * 用 refresh_token 换新的 access_token，成功后原子写回账号库。
 * 返回新的 access_token；失败抛错（调用方决定是否换下一个账号）。
 */
async function doRefreshAccessToken(account, { timeoutMs = 30_000 } = {}) {
  const refreshToken = secretValue(account, 'refresh_token');
  if (typeof refreshToken !== 'string' || !refreshToken.trim()) {
    throw new Error('该账号没有可用的 refresh_token，需重新扫码登录');
  }
  const variant = variantOf(account).id;
  const res = await fetch(chatBase(variant) + REFRESH_PATH, {
    method: 'POST',
    headers: refreshHeaders(account, await clientVersionOnce()),
    body: '{}',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    /* 非 JSON：按状态码处理 */
  }
  if (!res.ok) {
    /**
     * 「refresh token is invalid」是官方最常见的凭据失效态：官方刷新是**轮换式**的，
     * 一次刷新成功后旧 refresh_token 立即作废。账号无论被官方客户端还是本工具刷新过，
     * 另一份副本里的旧值再拿来刷就是这个错。直接把原文抛给用户没有可操作性，这里翻成
     * 「怎么回事 + 怎么办」（2026-10-18 用户反馈：登录莫名失效后点刷新凭据只见这句英文）。
     */
    if (/invalid[_\s-]*(refresh|token)|refresh[_\s-]*token[_\s-]*is[_\s-]*invalid|invalid_grant/i.test(text)) {
      throw new Error(
        'refresh_token 已失效：官方刷新会轮换 token，账号被刷新过一次后旧值就作废了。' +
          '请在 WorkBuddy 里重新登录该账号（或先切到别的账号再切回，让客户端自行续期），然后重新导入到控制台'
      );
    }
    throw new Error(`刷新失败：HTTP ${res.status} ${text.slice(0, 120)}`);
  }
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const access = data?.accessToken || data?.access_token;
  if (!access) throw new Error('刷新失败：响应里没有 accessToken，需重新扫码登录');

  // H2：把新凭据同步写回调用方传入的 account 对象。loadAccounts() 每次返回全新对象，
  // 调用方（代理请求路径）之后仍用传入的 account 出站——不回写的话「先刷新再发」发的
  // 还是旧 access_token，401 重试还会拿已被轮换作废的旧 refresh_token 再刷（必败）
  const now = Date.now();
  const newRefresh = data?.refreshToken || data?.refresh_token || null;
  account.access_token = access;
  if (newRefresh) account.refresh_token = newRefresh;
  account.refreshedAt = now;
  const expiresIn2 = Number(data?.expiresIn ?? data?.expires_in);
  if (Number.isFinite(expiresIn2) && expiresIn2 > 0) account.expiresAt = now + expiresIn2 * 1000;
  const refreshExpiresIn2 = Number(data?.refreshExpiresIn ?? data?.refresh_expires_in);
  if (Number.isFinite(refreshExpiresIn2) && refreshExpiresIn2 > 0) account.refreshExpiresAt = now + refreshExpiresIn2 * 1000;

  // H4：落库必须「重读→按 id 合并→写」，且不同账号的保存互相串行。
  // 官方刷新是轮换式的（旧 refresh_token 立即作废），并发刷新两个账号时如果各自
  // 拿旧快照整表覆盖，后写者会把先写者刚轮换出的新 token 抹回已作废的旧值——账号报废
  const applyAndSave = async () => {
    const accounts = loadAccounts();
    const idx = accounts.findIndex((a) => a?.id === account.id || (account.uid && a?.uid === account.uid));
    if (idx < 0) return null; // 账号已被删除：放弃落库，不凭内存对象凭空造库
    const target = accounts[idx];
    target.access_token = access;
    if (newRefresh) target.refresh_token = newRefresh;
    target.refreshedAt = now;
    if (Number.isFinite(expiresIn2) && expiresIn2 > 0) target.expiresAt = now + expiresIn2 * 1000;
    if (Number.isFinite(refreshExpiresIn2) && refreshExpiresIn2 > 0) target.refreshExpiresAt = now + refreshExpiresIn2 * 1000;
    // 异步落盘：刷新常发生在代理请求路径上，同步写撞上 EPERM 锁窗会把整个服务
    // （含正在流式输出的请求）冻住 36 秒（2026-10-26 全面体检）
    await saveAccountsAsync(accounts);
    return target;
  };
  refreshSaveChain = refreshSaveChain.then(applyAndSave, applyAndSave);
  const target = await refreshSaveChain;
  if (target) {
    // 官方刷新是轮换式的：旧 refresh_token 已在服务端作废。如果刷新的正是**当前登录账号**，
    // 必须把新凭据写回登录态文件，否则 WorkBuddy 还攥着作废的旧 token，
    // 它下一次自己刷新就会失败 → 用户看到「登录状态莫名失效」（2026-10-18 用户反馈）。
    // 不是当前账号时该函数自己返回 synced:false，什么也不做；同步失败不影响刷新结果。
    try {
      await syncTokensToAuthFile(target);
    } catch {
      /* 同步是尽力而为：账号库已更新，登录态文件下次切号时会重写 */
    }
  }
  return access;
}

/** 同一账号的并发刷新去重：轮换式刷新下，同一账号同时刷两次必有一胜一败（败者报废） */
const refreshInFlight = new Map();

/** 账号库保存串行链：保证「重读→合并→写」不与其它刷新交错 */
let refreshSaveChain = Promise.resolve();

/**
 * 凭据刷新熔断器：refresh_token 已死（invalid_grant）的账号留在池里时，此前**每个**
 * 代理请求都会先拿死 token 去撞一次官方鉴权接口——短时间高频的失效 token 重放
 * 在鉴权侧是典型的攻击特征，很可能加速连坐判定。连续失败 2 次即熔断 15 分钟，
 * 期间直接快速失败（错误信息说明原因），不再发网络请求；成功后计数清零。
 */
const REFRESH_BREAKER_THRESHOLD = 2;
const REFRESH_BREAKER_MS = 15 * 60_000;
const refreshFailures = new Map(); // accountId -> { count, blockedUntil }

function refreshBlocked(accountId) {
  const st = refreshFailures.get(accountId);
  return st && st.blockedUntil > Date.now() ? st : null;
}

function noteRefreshResult(accountId, ok) {
  if (!accountId) return;
  if (ok) {
    refreshFailures.delete(accountId);
    return;
  }
  const st = refreshFailures.get(accountId) || { count: 0, blockedUntil: 0 };
  st.count += 1;
  if (st.count >= REFRESH_BREAKER_THRESHOLD) {
    st.blockedUntil = Date.now() + REFRESH_BREAKER_MS;
    console.log(
      `[wb] 账号 ${String(accountId).slice(0, 8)} 凭据连续刷新失败 ${st.count} 次，熔断 ${REFRESH_BREAKER_MS / 60000} 分钟（避免反复用失效 token 撞官方鉴权接口）`
    );
  }
  refreshFailures.set(accountId, st);
}

/**
 * 刷新 access_token（带并发去重 + 熔断）。
 * 同一账号并发调用复用同一次网络请求；不同账号的落库按序执行（见 refreshSaveChain）。
 */
export function refreshAccessToken(account, opts = {}) {
  const key = String(account?.id || account?.uid || '');
  const blocked = refreshBlocked(key);
  if (blocked) {
    const mins = Math.ceil((blocked.blockedUntil - Date.now()) / 60000);
    return Promise.reject(
      new Error(
        `该账号凭据此前连续刷新失败，已熔断（还需 ${mins} 分钟）。` +
          'refresh_token 大概率已失效：请在 WorkBuddy 里重新登录该账号后重新导入'
      )
    );
  }
  const prev = refreshInFlight.get(key);
  if (prev) return prev;
  const p = doRefreshAccessToken(account, opts)
    .then((v) => {
      noteRefreshResult(key, true);
      return v;
    })
    .catch((e) => {
      noteRefreshResult(key, false);
      throw e;
    })
    .finally(() => refreshInFlight.delete(key));
  refreshInFlight.set(key, p);
  return p;
}

/**
 * 拉取某账号可用的模型清单。
 * 官方端点：{chatBase}/console/enterprises/personal/models
 * 返回 `[{ id, name?, ... }]`，失败返回 null（界面按"未知"处理，不阻塞代理）。
 */
export async function fetchUpstreamModels(account, { timeoutMs = 20_000 } = {}) {
  const variant = variantOf(account).id;
  const res = await fetch(chatBase(variant) + MODELS_PATH, {
    method: 'GET',
    headers: await chatHeaders(account),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`模型列表获取失败：HTTP ${res.status}`);
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const models = data?.models;
  if (!Array.isArray(models)) return null;
  return models
    .map((m) => (typeof m === 'string' ? { id: m } : { id: String(m?.id || m?.name || '') }))
    .filter((m) => m.id);
}

/**
 * 把一段 SSE 文本聚合成 OpenAI 非流式响应。
 *
 * 官方 chat 端点**只接受流式**（非流式直接 400 `Non-stream chat request is currently
 * not supported`），所以代理对上游恒用 stream=true：调用方要流式就原样透传，
 * 要非流式就在这里把 SSE 流拼回一条完整的 chat.completion。
 */
function aggregateSse(raw, model) {
  let content = '';
  let reasoning = '';
  let finishReason = null;
  let usage = null;
  let id = null;
  let respModel = model;
  /** 上游可能把业务错误塞在 SSE 的某一帧里（code != 0），这类帧必须识别成失败而不是"空回复" */
  let upstreamError = null;
  /** index -> { id, type, function: { name, arguments } } */
  const toolCalls = new Map();

  for (const line of String(raw || '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      continue;
    }
    if (json.code && Number(json.code) !== 0) {
      upstreamError = `上游 code ${json.code}: ${json.msg || json.message || '未知错误'}`;
    }
    if (json.id) id = json.id;
    if (json.model) respModel = json.model;
    if (json.usage) usage = json.usage;
    for (const c of json.choices || []) {
      const d = c?.delta || {};
      if (typeof d.content === 'string') content += d.content;
      if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content;
      if (c?.finish_reason) finishReason = c.finish_reason;
      for (const tc of d.tool_calls || []) {
        const idx = tc?.index ?? 0;
        const cur = toolCalls.get(idx) || { id: tc?.id || '', type: tc?.type || 'function', function: { name: '', arguments: '' } };
        if (tc?.id) cur.id = tc.id;
        if (tc?.function?.name) cur.function.name += tc.function.name;
        if (typeof tc?.function?.arguments === 'string') cur.function.arguments += tc.function.arguments;
        toolCalls.set(idx, cur);
      }
    }
  }

  const calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  const message = { role: 'assistant', content };
  if (reasoning) message.reasoning_content = reasoning;
  if (calls.length) message.tool_calls = calls;

  return {
    error: upstreamError,
    text: JSON.stringify({
      id: id || `chatcmpl-${crypto.randomBytes(12).toString('hex')}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: respModel,
      choices: [{ index: 0, message, logprobs: null, finish_reason: finishReason || 'stop' }],
      ...(usage ? { usage } : {}),
    }),
  };
}

/** 上游调用失败（带 HTTP 状态，调用方据此决定刷新 token 还是换号） */
export class UpstreamError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
  }
}

/** 把一行 SSE 文本解析成语义事件；非数据行返回 null */
function parseSseDataLine(line) {
  if (!line.startsWith('data:')) return null;
  const payload = line.slice(5).trim();
  if (!payload) return null;
  if (payload === '[DONE]') return { type: 'done' };
  let json;
  try {
    json = JSON.parse(payload);
  } catch {
    return null;
  }
  // 上游会把业务错误塞进某一帧（code != 0），必须抬成错误事件让调用方换号
  if (json.code && Number(json.code) !== 0) {
    return { type: 'error', message: `上游 code ${json.code}: ${json.msg || json.message || '未知错误'}` };
  }
  const choice = json.choices?.[0];
  const delta = choice?.delta || {};
  return {
    type: 'delta',
    id: json.id || null,
    model: json.model || null,
    content: typeof delta.content === 'string' ? delta.content : '',
    reasoning: typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '',
    toolCalls: Array.isArray(delta.tool_calls) ? delta.tool_calls : [],
    finishReason: choice?.finish_reason || null,
    usage: json.usage || null,
  };
}

/** 逐行消费上游 SSE 字节流，产出语义事件 */
async function* parseSseStream(webStream) {
  const reader = webStream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        const ev = parseSseDataLine(line);
        if (ev) yield ev;
      }
    }
    const tail = parseSseDataLine(buf.trim());
    if (tail) yield tail;
  } finally {
    reader.cancel().catch(() => {});
  }
}

/**
 * 打开上游流，返回**逐帧语义事件**的异步迭代器。
 *
 * 与 chatComplete 的分工：chatComplete 面向"整体要一份结果"（OpenAI 端点用，
 * 非流式在本地聚合）；本函数面向"要边收边转"——Anthropic / Responses 两个
 * 协议必须把上游 delta 实时翻译成各自的事件序列，不能等收完再拼。
 *
 * 上游恒以 stream:true 出站（官方 chat 端点不接受非流式）。
 * `signal` 传入客户端请求的中断信号：客户端断开时立刻掐掉上游连接。
 */
export async function openUpstreamStream(account, body, { headerTimeoutMs = 60_000, signal } = {}) {
  const variant = variantOf(account).id;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(new UpstreamError('客户端已断开', 499));
  if (signal) {
    if (signal.aborted) throw new UpstreamError('客户端已断开', 499);
    signal.addEventListener('abort', onAbort, { once: true });
  }
  const headerTimer = setTimeout(
    () => ctrl.abort(new UpstreamError('上游 60 秒未返回响应头', 504)),
    headerTimeoutMs
  );
  let res;
  try {
    res = await fetch(chatBase(variant) + CHAT_PATH, {
      method: 'POST',
      headers: await chatHeaders(account, { isStream: true }),
      body: JSON.stringify({ ...body, stream: true }),
      signal: ctrl.signal,
    });
  } catch (err) {
    if (signal) signal.removeEventListener('abort', onAbort);
    throw err instanceof UpstreamError ? err : new UpstreamError(err?.message || '上游请求失败', 502);
  } finally {
    clearTimeout(headerTimer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (signal) signal.removeEventListener('abort', onAbort);
    throw new UpstreamError(`HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
  }
  const frames = (async function* run() {
    // 帧间空闲看门狗（H5）：拿到响应头之后流主体此前不受任何超时管，上游僵死时
    // 消费方（各协议适配器）会永久挂起。每产出一帧重置一次计时
    let idle = null;
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(
        () => ctrl.abort(new UpstreamError(`上游 ${STREAM_IDLE_TIMEOUT_MS / 1000} 秒无新数据`, 504)),
        STREAM_IDLE_TIMEOUT_MS
      );
    };
    try {
      armIdle();
      for await (const ev of parseSseStream(res.body)) {
        armIdle();
        yield ev;
      }
    } finally {
      clearTimeout(idle);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  })();
  return { status: res.status, frames };
}

/**
 * 发一次 chat 请求（上游恒流式；非流式由 aggregateSse 在本地拼回）。
 *
 * 超时分两段，避免"长对话被硬掐"：
 * - `headerTimeoutMs`：只覆盖到**拿到响应头**（默认 60s），上游迟迟不给首字节才算失败；
 * - `totalTimeoutMs`：覆盖整段读取。流式会跑很久（长思考 / 长回答），所以流式默认放宽到
 *   10 分钟；非流式用调用方给的值（默认 120s）。
 * 之前只用一个总超时，流式长响应会在中途被 AbortSignal 掐断，客户端拿到半截 SSE。
 */
/**
 * 流式帧间空闲上限：响应头到达之后、流结束之前，上游连接活着但不吐任何字节的
 * 「僵死」状态此前不受任何超时管——客户端会永久挂起（2026-10-26 审查 H5）。
 */
const STREAM_IDLE_TIMEOUT_MS = 120_000;

export async function chatComplete(account, body, { timeoutMs = 120_000, headerTimeoutMs = 60_000, signal } = {}) {
  const variant = variantOf(account).id;
  const wantStream = !!body?.stream;
  const upstreamBody = { ...body, stream: true };

  const ctrl = new AbortController();
  // 客户端断开传导到上游：此前非流式没有 signal，客户端取消后上游照跑、积分照烧
  const onClientAbort = () => ctrl.abort(new Error('客户端已断开'));
  if (signal) {
    if (signal.aborted) throw new Error('客户端已断开');
    signal.addEventListener('abort', onClientAbort, { once: true });
  }
  const headerTimer = setTimeout(() => ctrl.abort(new Error('上游 60 秒未返回响应头')), headerTimeoutMs);
  let res;
  try {
    res = await fetch(chatBase(variant) + CHAT_PATH, {
      method: 'POST',
      headers: await chatHeaders(account, { isStream: true }),
      body: JSON.stringify(upstreamBody),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(headerTimer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (signal) signal.removeEventListener('abort', onClientAbort);
    return { ok: false, status: res.status, text, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }

  if (wantStream) {
    // 帧间空闲看门狗（见 STREAM_IDLE_TIMEOUT_MS 注释）：透传字节流不变，只加超时
    let idle = setTimeout(() => ctrl.abort(new Error(`上游 ${STREAM_IDLE_TIMEOUT_MS / 1000} 秒无新数据`)), STREAM_IDLE_TIMEOUT_MS);
    const rearm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => ctrl.abort(new Error(`上游 ${STREAM_IDLE_TIMEOUT_MS / 1000} 秒无新数据`)), STREAM_IDLE_TIMEOUT_MS);
    };
    const watched = res.body.pipeThrough(
      new TransformStream({
        transform(chunk, c) {
          rearm();
          c.enqueue(chunk);
        },
        flush() {
          clearTimeout(idle);
          if (signal) signal.removeEventListener('abort', onClientAbort);
        },
      })
    );
    return { ok: true, status: res.status, stream: watched, headers: res.headers };
  }

  // 非流式：读完整个流再聚合；整段受 timeoutMs 约束（超时就取消上游流）
  const bodyTimer = setTimeout(() => res.body?.cancel?.().catch(() => {}), timeoutMs);
  let raw;
  try {
    raw = await res.text();
  } finally {
    clearTimeout(bodyTimer);
    if (signal) signal.removeEventListener('abort', onClientAbort);
  }

  // 上游在流式模式下也可能直接回一段错误 JSON（非 SSE），这时把错误抬出去
  if (!/^\s*data:|[\r\n]data:/.test(raw)) {
    try {
      const j = JSON.parse(raw);
      if (j?.code && Number(j.code) !== 0) {
        return { ok: false, status: res.status, text: raw, error: `上游 code ${j.code}: ${j.msg || j.message || ''}` };
      }
    } catch {
      /* 非 JSON：按 SSE 聚合处理 */
    }
  }

  const agg = aggregateSse(raw, body.model);
  // SSE 某一帧里带业务错误（code != 0）→ 判为失败，让调用方换号重试而不是返回空回复
  if (agg.error) return { ok: false, status: res.status, text: agg.text, error: agg.error };
  return { ok: true, status: res.status, text: agg.text };
}
