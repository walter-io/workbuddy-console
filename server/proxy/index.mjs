/**
 * 反向代理：把 WorkBuddy 的官方 chat 能力以 **OpenAI 兼容协议** 暴露给本机其他 agent。
 *
 * 其他 agent（Claude Code / Cherry Studio / 任意 OpenAI SDK）只要把
 *   base_url = http://127.0.0.1:<port>/v1 ，api_key = 本页生成的 Key
 * 就能直接消耗 WorkBuddy 账号的积分与模型额度。
 *
 * 设计取舍：
 * - **不另起端口**：复用控制台自身的 Express（默认 57891 / 桌面版动态端口），
 *   少一个监听端口、少一处防火墙与"端口被占"的故障面。
 * - **默认关闭**：会对外暴露一个本地 HTTP 接口，必须用户显式开启。
 * - **账号出站顺序**：按「积分最早过期优先」排序——先烧快过期的积分，避免浪费；
 *   余额数据后台低频刷新（10 分钟），绝不阻塞请求。
 * - **限额换号**：某账号对某模型撞限额（429 / 积分不足类错误）→ 该「账号×模型」
 *   冷却 10 分钟，本请求与后续请求自动改用其他账号；401/403 先刷新 token 重试，
 *   仍失败换下一个账号。
 * - **只透传必要字段**：OpenAI 入站 body 里的未知字段（如某些客户端的私货）不往上游带。
 */
import { Readable } from 'node:stream';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfigAsync, DEFAULT_PROXY } from '../store/config.mjs';
import { loadAccounts, accountMeta, secretValue, STORE_DIR } from '../workbuddy/accounts.mjs';
import { variantOf, VARIANT_LIST, authFilePath } from '../workbuddy/variant.mjs';
import { getAccountBalances } from '../workbuddy/credits.mjs';
import { chatComplete, refreshAccessToken, fetchUpstreamModels, openUpstreamStream } from './wb.mjs';
import { anthropicToOpenAi, buildAnthropicMessage, pipeAnthropicStream } from './anthropic.mjs';
import { responsesToOpenAi, buildResponsesReply, pipeResponsesStream } from './responses.mjs';
import { geminiToOpenAi, buildGeminiResponse, geminiModelsPayload, pipeGeminiStream } from './gemini.mjs';
import { sanitizeMessages } from './sanitize.mjs';

/** 允许透传给上游的字段白名单（其余一律丢弃，避免把客户端私货喂给官方接口） */
const ALLOWED_FIELDS = [
  'model',
  'messages',
  'stream',
  'temperature',
  'top_p',
  'max_tokens',
  'max_completion_tokens',
  'stop',
  'tools',
  'tool_choice',
  'response_format',
  'frequency_penalty',
  'presence_penalty',
  'seed',
  'user',
];

const LOG_LIMIT = 200;

/** 限额冷却时长：撞限额的「账号×模型」在这段时间内被排到队尾，之后自动恢复 */
const COOLDOWN_MS = 10 * 60 * 1000;

/** 余额（积分过期时间）后台刷新间隔：只影响排序，不用新鲜到分钟级 */
const EXPIRY_REFRESH_MS = 10 * 60 * 1000;

/** 进程内状态：请求日志、累计统计、模型缓存、限额冷却、积分过期时间 */
const state = {
  logs: [],
  stats: { total: 0, ok: 0, failed: 0, lastAt: null },
  models: { ids: [], fetchedAt: null, error: null, account: null },
  /** 限额冷却表：`${accountId}|${model}` → 冷却截止时间戳（毫秒） */
  cooldown: new Map(),
  /** 积分过期时间表：accountId → 最早到期的未过期积分包时间戳（毫秒）；at 为上次刷新时间 */
  expiry: { at: 0, map: new Map() },
};

/**
 * 生成一把新的代理 Key（**不落盘**）。
 * 落盘交给调用方用 saveConfigAsync：这里是请求路径，同步写盘会冻住整个服务。
 */
function newProxyKey() {
  return `sk-wb-${crypto.randomBytes(16).toString('hex')}`;
}

function ensureKey() {
  const cfg = loadConfig();
  if (cfg.proxy?.apiKey) return cfg.proxy.apiKey;
  // 返回新 key 但不在这里写配置：PUT /api/proxy/config 随后会用异步方式统一落盘
  return newProxyKey();
}

/** 出站可用的明文 access_token（空值或加密信封对象都不算） */
function plainAccessToken(account) {
  const t = secretValue(account, 'access_token');
  return typeof t === 'string' && t.trim() ? t : '';
}

/** 出站可用的明文 refresh_token */
function plainRefreshToken(account) {
  const t = secretValue(account, 'refresh_token');
  return typeof t === 'string' && t.trim() ? t : '';
}

/**
 * 账号能否用于出站请求：有明文 access_token，**或**有明文 refresh_token
 * （access_token 过期、甚至只存了加密信封，都能靠 refresh_token 换一份明文的回来）。
 *
 * ⚠️ 别用 `hasPlainToken` 当这个判据：它顺带把"已过期"也算成不可用，于是
 * 「控制台离线几天、access_token 正好过期」的账号会被**静默踢出账号池**——
 * 明明 refresh_token 还有效，界面却只回一句"没有可用账号"，把人往"重新扫码"上引。
 * 那个函数在签到 / 切换账号 / 界面徽章里仍按原语义使用（那里"过期=不可用"是对的）。
 */
export function canEgress(account) {
  return !!plainAccessToken(account) || !!plainRefreshToken(account);
}

/** 参与轮换的账号：能出站的（见 canEgress），再按界面选中的子集过滤 */
export function poolAccounts() {
  const cfg = loadConfig();
  const raw = cfg.proxy?.accountIds;
  // null / 非数组 = 未指定 → 全部可用账号；[] = 明确一个都不选 → 池为空
  const selected = Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : null;
  if (selected && selected.length === 0) return [];
  const loginUids = currentLoginUids();
  return loadAccounts().filter((a) => {
    if (!canEgress(a)) return false;
    // 桌面端当前登录的账号**绝不参与出站**（显式勾选了也不行，见 currentLoginUids 注释）
    if (a?.uid && loginUids.has(String(a.uid))) return false;
    return selected ? selected.includes(a.id) : true;
  });
}

/**
 * 桌面端当前登录的 uid 集合（两个档位的登录态文件都查，读不到的档位当未登录）。
 *
 * 为什么要把当前登录账号剔出账号池：上游 11128 渠道风控除了按单请求内容判，
 * **对账号也有连坐效应** —— 实测「代理带着账号 A 跑竞品系统提示词的流量」之后，
 * 官方客户端用同一个账号 A 发消息也开始被拦。账号池默认收全部能出站的账号，
 * 不加隔离就等于主动把官方客户端正登录的账号往风控枪口上送。
 * 这里从机制上把两边分开：官方客户端用 A，代理只用其余账号。
 */
export function currentLoginUids() {
  const uids = new Set();
  for (const v of VARIANT_LIST) {
    try {
      const uid = JSON.parse(fs.readFileSync(authFilePath(v.id), 'utf8'))?.account?.uid;
      if (typeof uid === 'string' && uid.trim()) uids.add(uid.trim());
    } catch {
      /* 没有登录态文件 / 解析失败 → 该档位当未登录 */
    }
  }
  return uids;
}

function log(entry) {
  state.logs.unshift(entry);
  if (state.logs.length > LOG_LIMIT) state.logs.length = LOG_LIMIT;
}

/**
 * 11128 现场捕获：被风控拒绝时把 system 原文（截断 6KB）追加到
 * `<存储根>/proxy-11128-samples.jsonl`。
 *
 * 上游判据是「连续逐字文本命中竞品系统提示词库」（见 sanitize.mjs 文件头），
 * 没有原文就只能凭猜加规则——这个文件就是下次精准加一条规则的依据。
 * 只记 system 级文本（不含用户消息），失败不影响响应。
 */
function capture11128(kind, body, errors) {
  try {
    const hit = (errors || []).some((e) => /11128|Illegal API invocation/i.test(String(e)));
    if (!hit) return;
    // 优先用净化前的原文（L2）：净化会就地改写 messages，采样改写版排不了障
    const sys = rawSystemOf(body) || (body?.messages || [])
      .filter((m) => m && (m.role === 'system' || m.role === 'developer'))
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n---\n');
    if (!sys) return;
    fs.appendFile(
      path.join(STORE_DIR, 'proxy-11128-samples.jsonl'),
      JSON.stringify({ at: Date.now(), kind, model: body?.model || null, chars: sys.length, head: sys.slice(0, 6000) }) + '\n',
      'utf8',
      () => {}
    );
  } catch {
    /* 捕获失败不影响响应 */
  }
}

/**
 * 上游错误文本是否属于「该账号这个模型用不了」的限额类失败。
 * 典型：HTTP 429（限流/限额）、积分不足、额度用尽。这类失败换号是**确定有效**的
 * （别的账号大概率还有额度），所以除了换号，还给该「账号×模型」记一次冷却，
 * 避免后续每个请求都先来撞一下。
 */
export function isQuotaError(text) {
  // 只认明确的配额语义。此前正则还裸匹 rate.?limit / insufficient：上游 5xx 的
  // 文案里常带这些词，会把好账号误记 10 分钟冷却，池小时等于自废（2026-10-26 L1）
  return /(^|[^0-9])429([^0-9]|$)|insufficient\s+(credits?|quota|balance)|积分不足|余额不足|额度(不足|用尽|已用完)|限额|配额/i.test(
    String(text ?? '')
  );
}

/** 给「账号×模型」记限额冷却 */
function markCooldown(accountId, model) {
  if (!accountId || !model) return;
  state.cooldown.set(`${accountId}|${model}`, Date.now() + COOLDOWN_MS);
}

/** 「账号×模型」是否还在冷却期内 */
function isCooling(accountId, model) {
  const until = state.cooldown.get(`${accountId}|${model}`);
  return Number.isFinite(until) && until > Date.now();
}

/**
 * 后台低频刷新「积分过期时间表」：从余额缓存（getAccountBalances 自带 2 分钟进程内缓存）
 * 里取每个账号「剩余>0 且未过期」的最早积分包到期时间。
 *
 * 刻意 **fire-and-forget**：余额接口慢（逐账号打官方接口），绝不能阻塞代理请求；
 * 拉不到（网络不通/接口失败）就沿用上一次的结果，排序退化为「无过期信息、按原顺序」。
 */
async function refreshExpiryMap() {
  try {
    const payload = await getAccountBalances({ refresh: false });
    const map = new Map();
    const now = Date.now();
    for (const row of payload?.accounts || []) {
      const pkgs = row?.balance?.packages;
      if (!Array.isArray(pkgs)) continue;
      let earliest = null;
      for (const p of pkgs) {
        const exp = Number(p?.expireAt);
        const rem = Number(p?.remaining);
        if (!Number.isFinite(exp) || exp <= now) continue; // 已过期/长期有效的不参与
        if (Number.isFinite(rem) && rem <= 0) continue; // 用完的包排序无意义
        if (earliest == null || exp < earliest) earliest = exp;
      }
      if (earliest != null) map.set(row.accountId, earliest);
    }
    state.expiry = { at: Date.now(), map };
  } catch {
    state.expiry.at = Date.now(); // 失败也推进节流时间，避免每个请求都重试
  }
}

/** 到期时间表过期了就后台补一次（不 await） */
function maybeRefreshExpiry() {
  if (Date.now() - state.expiry.at < EXPIRY_REFRESH_MS) return;
  state.expiry.at = Date.now(); // 先推进再拉，防止并发请求重复触发
  void refreshExpiryMap();
}

/**
 * 出站顺序：**积分最早过期优先**（先烧快到期的积分）+ 限额冷却的后账号排最后。
 *
 * - 排序键：账号最早到期的未过期积分包时间升序；查不到过期信息的账号排后面
 *   （可能是长期有效或余额接口没拉到，优先级让位给"再不用就作废"的积分）；
 * - 冷却中的「账号×模型」不剔除、只沉底：万一是误判（比如瞬时 429），
 *   兜底尝试仍然存在，只是不在前面浪费正式请求的时间；
 * - 同分组内保持 loadAccounts 的原始顺序，保证确定性。
 */
export function orderPool(pool, model) {
  maybeRefreshExpiry();
  // 顺手清掉过期冷却项，防止长驻进程里 Map 无限增长
  const now = Date.now();
  for (const [k, until] of state.cooldown) if (until <= now) state.cooldown.delete(k);
  const active = [];
  const cooling = [];
  for (const a of pool) (isCooling(a.id, model) ? cooling : active).push(a);
  const byExpiry = (x, y) => {
    const ex = state.expiry.map.get(x.id) ?? Number.POSITIVE_INFINITY;
    const ey = state.expiry.map.get(y.id) ?? Number.POSITIVE_INFINITY;
    return ex === ey ? 0 : ex < ey ? -1 : 1;
  };
  active.sort(byExpiry);
  cooling.sort(byExpiry);
  return [...active, ...cooling];
}

function summarizeLog() {
  state.stats.total += 1;
  state.stats.lastAt = Date.now();
}

/**
 * 账号是否需要先刷新：到期前 60 秒就刷（避免请求打到一半过期），
 * 另外**当前 token 出站根本用不了**（缺失 / 加密信封 / 已过期）时也必须先换明文。
 *
 * 注意"已过期"这里靠 `expiresAt - now < 0` 自然成立——**前提是账号还在池子里**
 * （见 canEgress 的注释：池子必须收下"过期但可刷新"的账号，否则这行永远轮不到它）。
 */
export function needsRefresh(account) {
  if (!plainAccessToken(account)) return true;
  const exp = Number(account?.expiresAt);
  return Number.isFinite(exp) && exp > 0 && exp - Date.now() < 60_000;
}

/** 单次客户端请求的总时间预算：账号池逐个试、每个最长 60s 响应头 + 30s 刷新，
 * 不设上限时池大的客户端要干等数分钟（M4）。超预算返回已收集的错误 */
const REQUEST_BUDGET_MS = 240_000;

/* ------------------------------------------------------------------ *
 * 风控节流层（2026-10 用户连坐封号后的防御性改造）
 *
 * 官方桌面端的真实行为模式：同一账号同一时刻只有一个对话在跑、请求之间隔着
 * 人类操作的秒级间隙。此前的反代是"agent 形态"：并发请求可以同时砸向同一个
 * 账号、同一账号的请求背靠背零间隔——都是教科书级的机器特征。
 *
 * withAccountSlot 提供两层约束（配置 proxy.minIntervalMs / maxConcurrent）：
 * 1. 账号级串行链 + 最小间隔：同一账号的上游请求排队执行，间隔不足自动补等待；
 * 2. 全局并发上限：在途请求数超过上限时排队等待。
 * ------------------------------------------------------------------ */
const accountChains = new Map(); // accountId -> Promise（串行链尾）
const lastUpstreamAt = new Map(); // accountId -> 上次出站时刻
let inFlight = 0;
const waiters = [];

function acquireGlobalSlot() {
  const cfg = loadConfig();
  const max = Math.max(1, Number(cfg.proxy?.maxConcurrent) || 2);
  if (inFlight < max) {
    inFlight += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
}

function releaseGlobalSlot() {
  const next = waiters.shift();
  if (next) next(); // 名额直接移交，inFlight 不变
  else inFlight = Math.max(0, inFlight - 1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 每日每账号请求计数（风控兜底：agent 重试循环失控时保护账号与积分）。
 * 内存态即可：重启清零可接受（上限本身是软保护）。键 = `${yyyy-mm-dd}|${accountId}` */
const dailyCounts = new Map();
function bumpDailyCount(accountId) {
  const day = new Date().toISOString().slice(0, 10);
  const key = `${day}|${accountId}`;
  const n = (dailyCounts.get(key) || 0) + 1;
  dailyCounts.set(key, n);
  // 跨天清理：只剩当天键，防 Map 无限增长
  if (dailyCounts.size > 64) for (const k of dailyCounts.keys()) if (!k.startsWith(day)) dailyCounts.delete(k);
  return n;
}

export class DailyCapError extends Error {
  constructor(accountName, count) {
    super(
      `账号「${accountName}」今日上游请求已达上限，为保护账号暂停使用（明日自动恢复）。` +
        '若非你主动为之，说明某个 agent 在失控重试，请检查其配置'
    );
    this.name = 'DailyCapError';
    this.count = count;
  }
}

/* ------------------------------------------------------------------ *
 * 账号限制捕获（11140「异常活动受限」/ 11128 风控）：记下账号与时间，
 * 由 /api/accounts 带给界面打「已被官方限制」徽章——小白最需要的就是
 * 「这个号还能不能用」一句话答案，而不是去翻日志
 * ------------------------------------------------------------------ */
const accountRestrictions = new Map(); // accountId -> { code, at }
export function noteAccountRestriction(accountId, text) {
  if (!accountId) return;
  const s = String(text || '');
  let code = null;
  if (/11140|unusual activity|has been restricted/i.test(s)) code = 11140;
  else if (/11128|Illegal API invocation/i.test(s)) code = 11128;
  if (!code) return;
  const prev = accountRestrictions.get(accountId);
  // 已知限制不覆盖更早的时间（首次受限时刻更有信息量）
  if (prev?.code === code) return;
  accountRestrictions.set(String(accountId), { code, at: Date.now() });
  console.log(`[proxy] ⚠️ 账号 ${String(accountId).slice(0, 8)} 被官方限制（code=${code}），已在账号页标记`);
}

/** accountId → { code, at }（/api/accounts 用；只读视图） */
export function restrictionMap() {
  return Object.fromEntries(accountRestrictions);
}

/**
 * 在账号槽位内执行 fn（真正打上游的部分）。
 * 排队期间客户端断开也不会"跳号"——名额语义必须严格进出配对。
 * 导出供 /api/proxy/doctor 体检复用（与业务流量共用同一套节流语义）。
 */
export async function withAccountSlot(account, fn) {
  const key = String(account?.id || account?.uid || '');
  const prev = accountChains.get(key) || Promise.resolve();
  let run;
  const chain = prev.then(
    () =>
      new Promise((res) => {
        run = res;
      })
  );
  accountChains.set(key, chain);
  await prev; // 等前面的出站动作完成（含它的最小间隔）
  await acquireGlobalSlot();
  try {
    const cfg = loadConfig();
    // 每日上限：先于真正出站判定，触顶直接拒绝（不烧积分也不加深风控暴露）
    const cap = Number(cfg.proxy?.dailyPerAccountCap) || 500;
    const done = bumpDailyCount(key);
    if (done > cap) {
      throw new DailyCapError(accountMeta(account).name, done);
    }
    const minGap = Math.max(0, Number(cfg.proxy?.minIntervalMs) || 0);
    const last = lastUpstreamAt.get(key) || 0;
    const wait = last + minGap - Date.now();
    if (wait > 0) await sleep(wait);
    lastUpstreamAt.set(key, Date.now());
    return await fn();
  } finally {
    releaseGlobalSlot();
    run(); // 放行该账号链上的下一个
  }
}

/**
 * 流式透传时顺带扫描上游 in-band 错误帧（11128/11102/14003…）：
 * 不改变字节流，只把命中的错误文本记到 scan.error。此前 handleChat 的流式是纯透传，
 * 上游 200+SSE 内夹错误帧时被记成成功、不冷却、不采样，多数 SDK 静默丢弃后
 * 用户只见「空回复」（M1/M3）
 */
function scanUpstreamErrors(webStream, scan) {
  const decoder = new TextDecoder();
  let tail = '';
  return webStream.pipeThrough(
    new TransformStream({
      transform(chunk, c) {
        c.enqueue(chunk);
        tail = (tail + decoder.decode(chunk, { stream: true })).slice(-4096);
        if (scan.error) return;
        const m = tail.match(/"code"\s*:\s*(111\d\d|14003)\b/);
        if (m) {
          const mm = tail.match(/"message"\s*:\s*"([^"]{0,200})"/);
          scan.error = `上游错误 code=${m[1]}${mm ? `：${mm[1]}` : ''}`;
        }
      },
      flush() {
        try {
          const rest = decoder.decode();
          if (rest && !scan.error) {
            const m = (tail + rest).match(/"code"\s*:\s*(111\d\d|14003)\b/);
            if (m) scan.error = `上游错误 code=${m[1]}`;
          }
        } catch {
          /* 解码尾包失败无所谓 */
        }
      },
    })
  );
}

/**
 * 模型名统一兜底（四协议入口共用）：
 * 1. 命中别名表 → 替换（harness 默认名直传会撞上游 11102）；
 * 2. 在清单内 → 原样；
 * 3. 其它（harness 新版本的新默认名，别名表来不及覆盖）→ 记日志并回落到清单推荐模型，
 *    原样转发等于必败（L3/M6：Gemini 端点此前连别名都没有）。
 */
function resolveModel(model) {
  const m = String(model || '').trim();
  const aliased = applyModelAlias(m);
  if (aliased !== m) {
    console.log(`[proxy] 模型别名：${m} → ${aliased}（客户端未使用清单内模型名）`);
    return aliased;
  }
  if (!m || state.models.ids.includes(m)) return m;
  const fallback = pickTestModel(state.models.ids);
  if (fallback) {
    console.log(`[proxy] 未识别模型 ${m}，回落到 ${fallback}（如需指定请用清单内模型名）`);
    return fallback;
  }
  return m;
}

/** 原始 system 文本（净化前）——capture11128 采样要的是「上游看到什么」之外的原文，
 * 此前 messages 被就地净化后采样到的已是改写版，失去排障价值（L2） */
const RAW_SYSTEM = new WeakMap();
export function rawSystemOf(body) {
  return RAW_SYSTEM.get(body) || null;
}

/** OpenAI 入站 body → 上游 body：白名单过滤 + system 文本净化（导出供协议测试直接断言） */
export function buildUpstreamBody(inbound) {
  const out = {};
  for (const k of ALLOWED_FIELDS) {
    if (inbound[k] !== undefined) out[k] = inbound[k];
  }
  if (!Array.isArray(out.messages) || !out.messages.length) throw new Error('缺少 messages');
  if (!out.model) throw new Error('缺少 model');
  // 先留一份净化前的 system 原文给 11128 采样（WeakMap 不进上游请求体）
  const rawSys = out.messages
    .filter((m) => m && (m.role === 'system' || m.role === 'developer'))
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n---\n');
  if (rawSys) RAW_SYSTEM.set(out, rawSys);
  // system 级文本出站前净化（竞品系统提示词逐字命中上游风控会被 11128 拦截）；
  // 用户消息不受影响。理由与实证见 sanitize.mjs。
  sanitizeMessages(out.messages);
  return out;
}

/**
 * 客户端把 Key 放在哪儿了：返回携带方式，认不出来返回 null。
 *
 * 四种携带方式对应不同客户端的默认行为：
 *   - `Authorization: Bearer`（OpenAI SDK / Codex CLI / 多数 IDE）
 *   - `Authorization: <key>`（少数脚本 / 手写客户端直接把 Key 塞进去，不带前缀）
 *   - `x-api-key`（Anthropic 客户端，Claude Code 用 Bearer，但 ZCode 等用这个）
 *   - `x-goog-api-key`（Gemini CLI / Gemini 原生 SDK 的默认机制）
 * 另外 Gemini 客户端在部分版本会把 Key 放在 `?key=` 查询串里，一并接受。
 *
 * 未配置 Key 时返回 `'none'`（本地工具，方便直接试）。
 *
 * 返回值同时进请求日志：排查「401 到底是没带、还是带错」时，一眼能看出客户端把
 * Key 放在了哪个头上 —— 这比让用户抓包快得多。
 */
export function authMode(req) {
  const key = loadConfig().proxy?.apiKey;
  if (!key) return 'none';
  const auth = String(req.headers.authorization || '').trim();
  if (auth.startsWith('Bearer ')) {
    if (auth.slice(7).trim() === key) return 'bearer';
  } else if (auth === key) {
    return 'raw';
  }
  if (String(req.headers['x-api-key'] || '').trim() === key) return 'x-api-key';
  if (String(req.headers['x-goog-api-key'] || '').trim() === key) return 'x-goog-api-key';
  if (String(req.query?.key || '').trim() === key) return 'query';
  return null;
}

/** 鉴权：见 authMode。认不出携带方式即为不通过；未配置 Key（'none'）同样不放行——
 * /v1 的 CORS 是 *，空口令等于任何本地网页都能跨域静默烧积分（2026-10-26 审查 M8）。 */
function authorized(req) {
  const mode = authMode(req);
  return mode !== null && mode !== 'none';
}

/**
 * 日志用的人话鉴权标签 —— 把「没带 Key」和「带了但不对」分开。
 * 这两种在用户侧都表现为 401，但处理方式完全不同（前者去配 Key，后者去对 Key）。
 */
export function authLabel(req) {
  const mode = authMode(req);
  if (mode) return mode;
  const any = req.headers.authorization || req.headers['x-api-key'] || req.headers['x-goog-api-key'] || req.query?.key;
  return any ? 'mismatch' : 'absent';
}

/** 客户端标识（截断，只用于日志，不影响任何逻辑） */
const uaOf = (req) => String(req.headers['user-agent'] || '').slice(0, 120) || null;

/** 请求路径（去掉查询串；Gemini 的模型名在路径里，出问题时这行最有信息量） */
const pathOf = (req) => String(req.originalUrl || req.url || '').split('?')[0];

/**
 * 上游错误码 → 中文人话。
 * 只收实测碰到过的码；没登记的码回落到上游自己的 zh 文案。
 */
const UPSTREAM_CODE_HINT = {
  11102: '模型不可用（上游没有这个模型，请在「反向代理」页面挑清单里的模型）',
  11128: '上游渠道风控拦截：客户端的「系统提示词」被判定为非官方客户端',
};

/**
 * 把上游那一大坨 JSON 压成一行能读的话。
 *
 * 上游错误原文形如
 *   `账号名: HTTP 400: {"code":11128,"msg":"Illegal API invocation…","displayMsg":{"zh":"…"}`
 * 直接塞进界面（截 60 字）只会看到 `{"code":11128,"msg":"Illegal API invocation from an un…`，
 * 完全看不出该干什么。这里抽出 code 与中文提示，压成
 *   `账号名: 上游 11128：上游渠道风控拦截：客户端的「系统提示词」被判定为非官方客户端`
 */
export function briefUpstream(text) {
  const s = String(text ?? '');
  const i = s.indexOf('{');
  const head = (i > 0 ? s.slice(0, i) : '').replace(/\s*HTTP \d+:\s*$/, ' ');
  const body = i > 0 ? s.slice(i) : s;
  const m = body.match(/"code"\s*:\s*(\d+)\s*,\s*"msg"\s*:\s*"([^"]*)"/);
  if (!m) return s.length > 300 ? `${head}${body.slice(0, 300)}…` : s;
  const zh = (body.match(/"zh"\s*:\s*"([^"]*)"/) || [])[1];
  return `${head}上游 ${m[1]}：${UPSTREAM_CODE_HINT[Number(m[1])] || zh || m[2]}`;
}

/** 多账号错误列表 → 一行简报（给客户端响应体与日志共用） */
export function briefErrors(errors, n = 3) {
  return (errors || [])
    .slice(0, n)
    .map(briefUpstream)
    .join(' | ');
}

/** 响应体里挑出一句人话（鉴权/参数类拒绝的日志用） */
function shortReject(body) {
  if (!body) return '未知错误';
  if (typeof body === 'string') return body.slice(0, 200);
  if (typeof body.error === 'string') return body.error.slice(0, 200);
  if (typeof body.error?.message === 'string') return body.error.message.slice(0, 200);
  if (typeof body.message === 'string') return body.message.slice(0, 200);
  return JSON.stringify(body).slice(0, 200);
}

/**
 * 「没进入转发」的请求也要留痕。
 *
 * 此前只有真正打到账号池的请求才写日志：Key 不对、代理没开、body 缺字段这些在
 * handler 开头就被 `return` 掉了，界面「请求日志」一片空白 —— 用户看到的现象恰好
 * 就是「反向代理用不了，日志里什么都没有」。而这类拒绝往往正是问题本身。
 *
 * 做法：包一层 `res.json` 抓住响应体，`finish` 时若状态码 ≥ 400 且 handler 没记过，
 * 就补一条日志（带客户端 UA、Key 携带方式、请求路径）。
 */
function watchRejections(req, res, next) {
  const started = Date.now();
  const sendJson = res.json.bind(res);
  let body = null;
  res.json = (b) => {
    body = b;
    return sendJson(b);
  };
  res.on('finish', () => {
    if (res.statusCode < 400) return;
    if (res.locals?.proxyLogged) return; // 账号池已记过（markFailed / handleChat）
    summarizeLog();
    state.stats.failed += 1;
    log({
      at: Date.now(),
      ok: false,
      status: res.statusCode,
      model: req.body?.model ? String(req.body.model) : null,
      stream: !!req.body?.stream,
      account: null,
      ms: Date.now() - started,
      error: shortReject(body),
      ua: uaOf(req),
      auth: authLabel(req),
      path: pathOf(req),
    });
  });
  next();
}

/**
 * 把上游流接到客户端响应。
 * 客户端提前断开（Ctrl+C、超时取消）时要销毁上游流，
 * 否则这次请求会一直挂在官方服务器上，连接与账号在途名额都释放不掉。
 */
function pipeStream(webStream, res) {
  return new Promise((resolve, reject) => {
    const nodeStream = Readable.fromWeb(webStream);
    let settled = false;
    const settle = (err) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve();
    };
    let clientGone = false;
    res.on('close', () => {
      if (!res.writableFinished) {
        clientGone = true;
        nodeStream.destroy();
        // destroy() 不触发 error 也到不了 end——必须在 close 里直接落定，
        // 否则每次客户端中断都泄漏一个永久挂起的 handler（2026-10-26 审查 H3）
        settle();
      }
    });
    nodeStream.on('error', (err) => settle(clientGone ? undefined : err));
    nodeStream.on('end', () => settle());
    nodeStream.on('close', () => {
      if (clientGone) settle();
    });
    nodeStream.pipe(res);
  });
}

/* ---------------- OpenAI 兼容端点 ---------------- */

async function handleChat(req, res) {
  const started = Date.now();
  const cfg = loadConfig();
  if (!cfg.proxy?.enabled) return res.status(403).json({ error: '反向代理未开启，请在「反向代理」页面开启' });
  if (!authorized(req)) return res.status(401).json({ error: 'API Key 无效，请在「反向代理」页面查看或重新生成' });

  let body;
  try {
    body = buildUpstreamBody(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  // 客户端默认模型名（deepseek-chat / gpt-5 / claude-* 等）→ 清单内真实模型，
  // 未识别的新默认名回落到清单推荐模型，避免上游 11102「模型不可用」（harness 不认账）
  body.model = resolveModel(body.model);

  const pool = orderPool(poolAccounts(), String(body.model));
  if (!pool.length) {
    return res.status(503).json({
      error: '没有可用账号：反向代理需要至少 1 个带明文凭据的 WorkBuddy 账号（扫码登录导入的账号才有）',
    });
  }

  const timeoutMs = Number(cfg.proxy?.timeoutMs) || DEFAULT_PROXY.timeoutMs;
  const isStream = !!body.stream;
  const signal = clientAbort(res); // 客户端断开传导到上游（M2），此前本端点根本没建
  const deadline = Date.now() + REQUEST_BUDGET_MS;
  const errors = [];

  // 按出站顺序逐个账号试：每个账号最多两轮（一轮直发，401/403 时刷新后重试一轮），
  // 撞限额的「账号×模型」记 10 分钟冷却，全部失败才放弃
  for (let i = 0; i < pool.length; i++) {
    const account = pool[i];
    if (Date.now() > deadline) {
      errors.push(`单请求总时间预算（${REQUEST_BUDGET_MS / 1000} 秒）耗尽，停止尝试剩余账号`);
      break;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt === 0 && needsRefresh(account)) await refreshAccessToken(account);
        if (isStream) {
          // 流式：上游请求 + 透传整个流都占账号槽（同账号在流期间不许并行第二路）
          const scan = { error: null };
          let pipeFailed = null;
          const out = await withAccountSlot(account, async () => {
            const o = await chatComplete(account, body, { timeoutMs, signal });
            if (!o.ok) return o;
            res.status(o.status);
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            try {
              await pipeStream(scanUpstreamErrors(o.stream, scan), res);
            } catch (pipeErr) {
              // 头已发出：必须写一帧 OpenAI 形状的错误再收尾（H5 后半）——此前异常
              // 冒泡到 wrap，res.status(500).json() 的裸 JSON 被 end 进 SSE 流，
              // 客户端既看不到错误帧也等不到 [DONE]
              pipeFailed = pipeErr;
              if (!res.writableEnded) {
                res.write(
                  `data: ${JSON.stringify({
                    error: { message: `上游流中断：${String(pipeErr?.message || pipeErr)}`, type: 'upstream_error', code: 502 },
                  })}\n\n`
                );
                res.write('data: [DONE]\n\n');
                res.end();
              }
            }
            return o;
          });
          if (!out.ok) {
            // 401/403：先刷新再试一次同一账号；其它错误直接换号（走下方统一失败处理）
            if ((out.status === 401 || out.status === 403) && attempt === 0) {
              await refreshAccessToken(account).catch(() => {});
              continue;
            }
            if (out.status === 429 || isQuotaError(out.error)) markCooldown(account.id, String(body.model));
            noteAccountRestriction(account.id, out.error);
            errors.push(`${accountMeta(account).name}: ${out.error || `HTTP ${out.status}`}`);
            break;
          }
          const streamErr = pipeFailed ? `上游流中断：${pipeFailed?.message || pipeFailed}` : scan.error;
          if (streamErr) {
            // 流中断 / 上游 200 但 SSE 里夹了错误帧：按失败记账（此前被记成功）
            summarizeLog();
            state.stats.failed += 1;
            res.locals.proxyLogged = true;
            if (isQuotaError(streamErr)) markCooldown(account.id, String(body.model));
            capture11128('chat', body, [streamErr]);
            noteAccountRestriction(account.id, streamErr);
            log({ at: Date.now(), ok: false, status: pipeFailed ? 502 : 200, model: String(body.model), stream: true, account: accountMeta(account).name, ms: Date.now() - started, error: streamErr.slice(0, 300), ua: uaOf(req), auth: authLabel(req), path: pathOf(req) });
            return; // 响应已终止，绝不能再换下一个账号
          }
          summarizeLog();
          state.stats.ok += 1;
          log({
            at: Date.now(),
            ok: true,
            status: out.status,
            model: String(body.model),
            stream: true,
            account: accountMeta(account).name,
            ms: Date.now() - started,
            ua: uaOf(req),
            auth: authLabel(req),
            path: pathOf(req),
          });
          return;
        }
        const out = await withAccountSlot(account, () => chatComplete(account, body, { timeoutMs, signal }));
        if (out.ok) {
          summarizeLog();
          state.stats.ok += 1;
          log({
            at: Date.now(),
            ok: true,
            status: out.status,
            model: String(body.model),
            stream: false,
            account: accountMeta(account).name,
            ms: Date.now() - started,
            ua: uaOf(req),
            auth: authLabel(req),
            path: pathOf(req),
          });
          res.status(out.status);
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(out.text);
          return;
        }
        // 401/403：先刷新再试一次同一账号；其它错误直接换号
        if ((out.status === 401 || out.status === 403) && attempt === 0) {
          await refreshAccessToken(account).catch(() => {});
          continue;
        }
        // 限额类失败：给该「账号×模型」记冷却，后续请求直接跳过它
        if (out.status === 429 || isQuotaError(out.error)) markCooldown(account.id, String(body.model));
        noteAccountRestriction(account.id, out.error);
        errors.push(`${accountMeta(account).name}: ${out.error || `HTTP ${out.status}`}`);
        break;
      } catch (err) {
        if (err?.status === 429) markCooldown(account.id, String(body.model));
        noteAccountRestriction(account.id, err?.message);
        errors.push(`${accountMeta(account).name}: ${err?.message || '请求失败'}`);
        break;
      }
    }
  }

  summarizeLog();
  state.stats.failed += 1;
  res.locals.proxyLogged = true;
  capture11128('chat', body, errors);
  log({
    at: Date.now(),
    ok: false,
    status: 502,
    model: String(body.model),
    stream: isStream,
    account: null,
    ms: Date.now() - started,
    error: briefErrors(errors, 1) || '所有账号都请求失败',
    errorRaw: errors.join(' | ').slice(0, 4000),
    ua: uaOf(req),
    auth: authLabel(req),
    path: pathOf(req),
  });
  res.status(502).json({ error: '所有账号都请求失败', details: errors.slice(0, 5).map(briefUpstream) });
}

async function handleModels(req, res) {
  const cfg = loadConfig();
  if (!cfg.proxy?.enabled) return res.status(403).json({ error: '反向代理未开启' });
  if (!authorized(req)) return res.status(401).json({ error: 'API Key 无效' });

  const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
  const emptyRecentlyFailed =
    !state.models.ids.length && Date.now() - Number(state.models.fetchedAt || 0) < 60_000; // 拉取失败会写入空清单，失败结果也要有短 TTL，否则轮询型客户端每次请求都全池撞上游
  if (refresh || (!state.models.ids.length && !emptyRecentlyFailed)) await refreshModelsCache().catch(() => {});

  const now = Math.floor(Date.now() / 1000);
  // Anthropic 客户端（Claude Code / ZCode）按 Anthropic 的模型列表形状解析
  if (req.headers['anthropic-version']) {
    return res.json({
      data: state.models.ids.map((id) => ({
        id,
        type: 'model',
        display_name: id,
        created_at: new Date(now * 1000).toISOString(),
      })),
      has_more: false,
      first_id: state.models.ids[0] || null,
      last_id: state.models.ids[state.models.ids.length - 1] || null,
    });
  }
  res.json({
    object: 'list',
    data: state.models.ids.map((id) => ({ id, object: 'model', created: now, owned_by: 'workbuddy' })),
  });
}

/* ---------------- Anthropic Messages 端点（Claude Code / ZCode） ---------------- */

/** 给非流式路径套上客户端断连信号（流式路径由 openUpstreamStream 直接用 signal） */
function clientAbort(res) {
  const ctrl = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) ctrl.abort();
  });
  return ctrl.signal;
}

const anthropicError = (res, status, message) =>
  res.status(status).json({
    type: 'error',
    error: { type: status === 401 ? 'authentication_error' : status === 429 ? 'rate_limit_error' : 'api_error', message },
  });

const sseHeaders = (res) => {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
};

/** 结算一次成功请求（轮转指针前进 + 日志） */
function markOk({ started, model, stream, account, status = 200, req }) {
  summarizeLog();
  state.stats.ok += 1;
  log({
    at: Date.now(),
    ok: true,
    status,
    model,
    stream,
    account: accountMeta(account).name,
    ms: Date.now() - started,
    ua: req ? uaOf(req) : null,
    auth: req ? authLabel(req) : null,
    path: req ? pathOf(req) : null,
  });
}

/**
 * 结算一次失败请求。
 * 传 `res` 是为了在响应上打标记，避免外层的「拒绝请求监听」把同一次失败记两遍。
 */
function markFailed(res, { started, model, stream, errors }) {
  summarizeLog();
  state.stats.failed += 1;
  if (res?.locals) res.locals.proxyLogged = true;
  const raw = (errors || []).join(' | ');
  log({
    at: Date.now(),
    ok: false,
    status: 502,
    model,
    stream,
    account: null,
    ms: Date.now() - started,
    error: briefErrors(errors, 1) || '所有账号都请求失败',
    errorRaw: raw.slice(0, 4000),
  });
}

/**
 * 账号池遍历执行器（Anthropic / Responses 端点共用）。
 * 传入的 pool 应已按 orderPool 排好序（积分过期优先 + 冷却沉底）。
 *
 * task 的返回约定：
 *   'done'          —— 已成功响应，收工
 *   'retry-auth'    —— 401/403，刷新同一账号后再试一轮
 *   其它对象         —— 该账号失败（取 .error 记日志），换下一个账号；
 *                      错误属限额类时给该「账号×模型」记冷却
 */
async function runAcrossPool(pool, task, model) {
  const errors = [];
  // 端到端预算：池大时逐账号串行最坏 60s×N，客户端干等数分钟（M4）
  const deadline = Date.now() + REQUEST_BUDGET_MS;
  for (let i = 0; i < pool.length; i++) {
    const account = pool[i];
    if (Date.now() > deadline) {
      errors.push(`单请求总时间预算（${REQUEST_BUDGET_MS / 1000} 秒）耗尽，停止尝试剩余账号`);
      break;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt === 0 && needsRefresh(account)) await refreshAccessToken(account).catch(() => {});
        const r = await task(account, attempt);
        if (r === 'done') {
          return { ok: true };
        }
        if (r === 'retry-auth' && attempt === 0) {
          await refreshAccessToken(account).catch(() => {});
          continue;
        }
        if (isQuotaError(r?.error)) markCooldown(account.id, model);
        noteAccountRestriction(account.id, r?.error);
        errors.push(`${accountMeta(account).name}: ${r?.error || '请求失败'}`);
        break;
      } catch (err) {
        if (err?.status === 401 || err?.status === 403) {
          if (attempt === 0) {
            await refreshAccessToken(account).catch(() => {});
            continue;
          }
        }
        if (err?.status === 429) markCooldown(account.id, model);
        noteAccountRestriction(account.id, err?.message);
        errors.push(`${accountMeta(account).name}: ${err?.message || '请求失败'}`);
        break;
      }
    }
  }
  return { ok: false, errors };
}

async function handleMessages(req, res) {
  const started = Date.now();
  const cfg = loadConfig();
  if (!cfg.proxy?.enabled) return anthropicError(res, 403, '反向代理未开启，请在控制台「反向代理」页面开启');
  if (!authorized(req)) return anthropicError(res, 401, 'API Key 无效，请在控制台「反向代理」页面查看或重新生成');
  const pool = poolAccounts();
  if (!pool.length) {
    return anthropicError(res, 503, '没有可用账号：反向代理需要至少 1 个带明文凭据的 WorkBuddy 账号（扫码登录导入的账号才有）');
  }

  let upstream;
  try {
    upstream = anthropicToOpenAi(req.body || {});
  } catch (err) {
    return anthropicError(res, 400, `请求体解析失败：${err?.message || err}`);
  }
  if (!upstream.messages?.length) return anthropicError(res, 400, '缺少 messages');
  if (!upstream.model) return anthropicError(res, 400, '缺少 model');
  // Claude Code / ZCode 默认发 claude-* 模型名 → 映射成清单内真实模型，避免上游 11102；
  // 未识别的新默认名回落清单推荐模型（resolveModel）
  upstream.model = resolveModel(upstream.model);

  // 按 Anthropic 规范：只有显式 stream:true 才流式，否则返回完整 message
  const isStream = req.body?.stream === true;
  const timeoutMs = Number(cfg.proxy?.timeoutMs) || DEFAULT_PROXY.timeoutMs;
  const signal = clientAbort(res);

  const result = await runAcrossPool(orderPool(pool, upstream.model), async (account, attempt) => {
    if (isStream) {
      // open + pipe 整体占一个账号槽：流式在途的整段时间都算"该账号正在对话"，
      // 期间同一账号的新请求必须排队（官方客户端不可能同账号并行两路对话）
      let upErr = null;
      try {
        upErr = await withAccountSlot(account, async () => {
          const up = await openUpstreamStream(account, upstream, { signal });
          sseHeaders(res);
          try {
            return await pipeAnthropicStream(up.frames, res, { model: upstream.model, signal });
          } catch (pipeErr) {
            if (!signal.aborted && !res.writableEnded) {
              res.write(
                `event: error\ndata: ${JSON.stringify({
                  type: 'error',
                  error: { type: 'api_error', message: String(pipeErr?.message || pipeErr) },
                })}\n\n`
              );
              res.end();
            }
            return String(pipeErr?.message || pipeErr); // 传输中断也按失败记账
          }
        });
      } catch (slotErr) {
        upErr = String(slotErr?.message || slotErr);
      }
      if (upErr) {
        // 上游 in-band 错误帧或断流：此前无条件 markOk，失败被记成功、不冷却、不采样（M1）
        markFailed(res, { started, model: upstream.model, stream: true, errors: [upErr] });
        if (isQuotaError(upErr)) markCooldown(account.id, upstream.model);
        capture11128('messages', upstream, [upErr]);
        noteAccountRestriction(account.id, upErr);
      } else {
        markOk({ started, model: upstream.model, stream: true, account, req });
      }
      return 'done';
    }

    const out = await withAccountSlot(account, () => chatComplete(account, upstream, { timeoutMs, signal }));
    if (out.ok) {
      let parsed;
      try {
        parsed = JSON.parse(out.text);
      } catch {
        return { error: '上游响应解析失败' };
      }
      res.json(buildAnthropicMessage(parsed, upstream.model));
      markOk({ started, model: upstream.model, stream: false, account, req });
      return 'done';
    }
    if ((out.status === 401 || out.status === 403) && attempt === 0) return 'retry-auth';
    return { error: out.error || `HTTP ${out.status}` };
  }, upstream.model);

  if (!result.ok && !res.headersSent) {
    markFailed(res, { started, model: upstream.model, stream: isStream, errors: result.errors, req });
    capture11128('anthropic', upstream, result.errors);
    return anthropicError(res, 502, `所有账号都请求失败：${briefErrors(result.errors, 3)}`);
  }
}

/* ---------------- OpenAI Responses 端点（Codex CLI） ---------------- */

const responsesError = (res, status, message) =>
  res.status(status).json({
    error: { message, type: status === 401 ? 'invalid_request_error' : 'api_error', code: status === 401 ? 'invalid_api_key' : null },
  });

async function handleResponses(req, res) {
  const started = Date.now();
  const cfg = loadConfig();
  if (!cfg.proxy?.enabled) return responsesError(res, 403, '反向代理未开启，请在控制台「反向代理」页面开启');
  if (!authorized(req)) return responsesError(res, 401, 'API Key 无效，请在控制台「反向代理」页面查看或重新生成');
  const pool = poolAccounts();
  if (!pool.length) {
    return responsesError(res, 503, '没有可用账号：反向代理需要至少 1 个带明文凭据的 WorkBuddy 账号（扫码登录导入的账号才有）');
  }

  const upstream = responsesToOpenAi(req.body || {});
  if (!upstream.messages?.length) return responsesError(res, 400, '缺少 input');
  if (!upstream.model) return responsesError(res, 400, '缺少 model');
  // 客户端默认模型名（gpt-5.x 等）→ 清单内真实模型；未识别的新默认名回落清单推荐模型
  upstream.model = resolveModel(upstream.model);

  // 按 Responses 规范：只有显式 stream:true 才流式
  const isStream = req.body?.stream === true;
  const timeoutMs = Number(cfg.proxy?.timeoutMs) || DEFAULT_PROXY.timeoutMs;
  const signal = clientAbort(res);

  const result = await runAcrossPool(orderPool(pool, upstream.model), async (account, attempt) => {
    if (isStream) {
      // 同 handleMessages：open + pipe 整体占账号槽
      let upErr = null;
      try {
        upErr = await withAccountSlot(account, async () => {
          const up = await openUpstreamStream(account, upstream, { signal });
          sseHeaders(res);
          try {
            return await pipeResponsesStream(up.frames, res, { model: upstream.model, signal });
          } catch (pipeErr) {
            if (!signal.aborted && !res.writableEnded) {
              res.write(
                `event: response.failed\ndata: ${JSON.stringify({
                  type: 'response.failed',
                  response: { id: 'resp_error', object: 'response', status: 'failed', error: { code: 'upstream_error', message: String(pipeErr?.message || pipeErr) } },
                })}\n\n`
              );
              res.end();
            }
            return String(pipeErr?.message || pipeErr); // 传输中断也按失败记账
          }
        });
      } catch (slotErr) {
        upErr = String(slotErr?.message || slotErr);
      }
      if (upErr) {
        markFailed(res, { started, model: upstream.model, stream: true, errors: [upErr] });
        if (isQuotaError(upErr)) markCooldown(account.id, upstream.model);
        capture11128('responses', upstream, [upErr]);
        noteAccountRestriction(account.id, upErr);
      } else {
        markOk({ started, model: upstream.model, stream: true, account, req });
      }
      return 'done';
    }

    const out = await withAccountSlot(account, () => chatComplete(account, upstream, { timeoutMs, signal }));
    if (out.ok) {
      let parsed;
      try {
        parsed = JSON.parse(out.text);
      } catch {
        return { error: '上游响应解析失败' };
      }
      res.json(buildResponsesReply(parsed, upstream.model));
      markOk({ started, model: upstream.model, stream: false, account, req });
      return 'done';
    }
    if ((out.status === 401 || out.status === 403) && attempt === 0) return 'retry-auth';
    return { error: out.error || `HTTP ${out.status}` };
  }, upstream.model);

  if (!result.ok && !res.headersSent) {
    markFailed(res, { started, model: upstream.model, stream: isStream, errors: result.errors, req });
    capture11128('responses', upstream, result.errors);
    return responsesError(res, 502, `所有账号都请求失败：${briefErrors(result.errors, 3)}`);
  }
}

/* ---------------- Google Gemini 原生端点（Gemini CLI / Gemini SDK） ---------------- */

/** Gemini 错误体：{ error: { code, message, status } } */
const GEMINI_STATUS_NAME = {
  400: 'INVALID_ARGUMENT',
  401: 'UNAUTHENTICATED',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  429: 'RESOURCE_EXHAUSTED',
  500: 'INTERNAL',
  502: 'INTERNAL',
  503: 'UNAVAILABLE',
  504: 'DEADLINE_EXCEEDED',
};

const geminiError = (res, status, message) =>
  res.status(status).json({ error: { code: status, message, status: GEMINI_STATUS_NAME[status] || 'UNKNOWN' } });

/**
 * generateContent / streamGenerateContent 共用入口。
 * 路径形如 /v1beta/models/{model}:generateContent，模型在 **URL 路径**里
 * （Gemini 请求体不含 model 字段），因此从 req.params 取。
 */
async function handleGemini(req, res) {
  const started = Date.now();
  const endpoint = String(req.params?.[1] || 'generateContent');
  const rawModel = decodeURIComponent(String(req.params?.[0] || ''));
  const model = resolveModel(rawModel.replace(/^models\//, '')); // Gemini CLI 默认名（gemini-*）此前无别名兜底，直传必撞 11102（M6）

  const cfg = loadConfig();
  if (!cfg.proxy?.enabled) return geminiError(res, 403, '反向代理未开启，请在控制台「反向代理」页面开启');
  if (!authorized(req)) return geminiError(res, 401, 'API Key 无效，请在控制台「反向代理」页面查看或重新生成');
  const pool = poolAccounts();
  if (!pool.length) {
    return geminiError(res, 503, '没有可用账号：反向代理需要至少 1 个带明文凭据的 WorkBuddy 账号（扫码登录导入的账号才有）');
  }

  let upstream;
  try {
    upstream = geminiToOpenAi(req.body || {}, model);
  } catch (err) {
    return geminiError(res, 400, `请求体解析失败：${err?.message || err}`);
  }
  if (!upstream.messages?.length) return geminiError(res, 400, '缺少 contents');
  if (!upstream.model) return geminiError(res, 400, '缺少模型名（应出现在 URL 路径 /v1beta/models/{model} 中）');

  // Gemini 协议按端点区分：:|generateContent 非流式，:streamGenerateContent 流式
  const isStream = endpoint === 'streamGenerateContent';
  const timeoutMs = Number(cfg.proxy?.timeoutMs) || DEFAULT_PROXY.timeoutMs;
  const signal = clientAbort(res);

  const result = await runAcrossPool(orderPool(pool, upstream.model), async (account, attempt) => {
    if (isStream) {
      // 同 handleMessages：open + pipe 整体占账号槽
      let upErr = null;
      try {
        upErr = await withAccountSlot(account, async () => {
          const up = await openUpstreamStream(account, upstream, { signal });
          sseHeaders(res);
          try {
            return await pipeGeminiStream(up.frames, res, { model: upstream.model, signal });
          } catch (pipeErr) {
            if (!signal.aborted && !res.writableEnded) {
              res.write(
                `data: ${JSON.stringify({
                  error: { code: 502, message: String(pipeErr?.message || pipeErr), status: 'INTERNAL' },
                })}\n\n`
              );
              res.end();
            }
            return String(pipeErr?.message || pipeErr); // 传输中断也按失败记账
          }
        });
      } catch (slotErr) {
        upErr = String(slotErr?.message || slotErr);
      }
      if (upErr) {
        markFailed(res, { started, model: upstream.model, stream: true, errors: [upErr] });
        if (isQuotaError(upErr)) markCooldown(account.id, upstream.model);
        capture11128('gemini', upstream, [upErr]);
        noteAccountRestriction(account.id, upErr);
      } else {
        markOk({ started, model: upstream.model, stream: true, account, req });
      }
      return 'done';
    }

    const out = await withAccountSlot(account, () => chatComplete(account, upstream, { timeoutMs, signal }));
    if (out.ok) {
      let parsed;
      try {
        parsed = JSON.parse(out.text);
      } catch {
        return { error: '上游响应解析失败' };
      }
      res.json(buildGeminiResponse(parsed, upstream.model));
      markOk({ started, model: upstream.model, stream: false, account, req });
      return 'done';
    }
    if ((out.status === 401 || out.status === 403) && attempt === 0) return 'retry-auth';
    return { error: out.error || `HTTP ${out.status}` };
  }, upstream.model);

  if (!result.ok && !res.headersSent) {
    markFailed(res, { started, model: upstream.model, stream: isStream, errors: result.errors, req });
    capture11128('gemini', upstream, result.errors);
    return geminiError(res, 502, `所有账号都请求失败：${briefErrors(result.errors, 3)}`);
  }
}

/** GET /v1beta/models：Gemini 形状的模型清单 */
async function handleGeminiModels(req, res) {
  const cfg = loadConfig();
  if (!cfg.proxy?.enabled) return geminiError(res, 403, '反向代理未开启');
  if (!authorized(req)) return geminiError(res, 401, 'API Key 无效');

  const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
  const emptyRecentlyFailed =
    !state.models.ids.length && Date.now() - Number(state.models.fetchedAt || 0) < 60_000; // 拉取失败会写入空清单，失败结果也要有短 TTL，否则轮询型客户端每次请求都全池撞上游
  if (refresh || (!state.models.ids.length && !emptyRecentlyFailed)) await refreshModelsCache().catch(() => {});
  res.json(geminiModelsPayload(state.models.ids));
}

/**
 * POST /v1beta/models/{model}:countTokens
 * Gemini CLI 用它做上下文预算；本地按字符数粗估即可（官方也只承诺近似）。
 * 估算口径：约 4 字符 / token，与官方"字符数估算"同量级。
 */
function handleGeminiCountTokens(req, res) {
  const cfg = loadConfig();
  if (!cfg.proxy?.enabled) return geminiError(res, 403, '反向代理未开启');
  if (!authorized(req)) return geminiError(res, 401, 'API Key 无效');

  const body = req.body || {};
  let chars = 0;
  for (const c of Array.isArray(body.contents) ? body.contents : []) {
    for (const p of Array.isArray(c?.parts) ? c.parts : []) {
      if (typeof p?.text === 'string') chars += p.text.length;
    }
  }
  const sys = body.systemInstruction;
  if (typeof sys === 'string') chars += sys.length;
  else for (const p of Array.isArray(sys?.parts) ? sys.parts : []) if (typeof p?.text === 'string') chars += p.text.length;

  res.json({ totalTokens: Math.max(1, Math.ceil(chars / 4)) });
}

/** 从账号池第一个可用账号拉模型清单，写入进程内缓存 */
export async function refreshModelsCache() {
  const pool = poolAccounts();
  if (!pool.length) {
    state.models = { ids: [], fetchedAt: null, error: '没有可用账号', account: null };
    return state.models;
  }
  let lastErr = null;
  for (const account of pool) {
    try {
      if (needsRefresh(account)) await refreshAccessToken(account).catch(() => {});
      const models = await fetchUpstreamModels(account);
      if (models?.length) {
        state.models = {
          ids: models.map((m) => m.id),
          fetchedAt: Date.now(),
          error: null,
          account: accountMeta(account).name,
        };
        return state.models;
      }
      lastErr = '上游返回空模型列表';
    } catch (err) {
      lastErr = err?.message || String(err);
    }
  }
  state.models = { ids: [], fetchedAt: Date.now(), error: lastErr, account: null };
  return state.models;
}

/* ---------------- 管理接口（前端页面用） ---------------- */

function publicStatus(port, { reveal = false } = {}) {
  const cfg = loadConfig();
  // 界面统一按"显式列表"理解：未指定（null）时展开成全部可用账号的 id
  const stored = cfg.proxy?.accountIds;
  const selected = Array.isArray(stored) ? stored : loadAccounts().map((a) => a?.id).filter(Boolean);
  const loginUids = currentLoginUids();
  const accounts = loadAccounts().map((a) => {
    const meta = accountMeta(a);
    const usable = canEgress(a);
    return {
      id: meta.id,
      name: meta.name,
      uid: meta.uid,
      variant: meta.variant,
      variantLabel: meta.variantLabel,
      usable,
      expired: meta.expired,
      expiresAt: meta.expiresAt,
      selected: selected.length ? selected.includes(meta.id) : true,
      // 桌面端当前登录的账号：即使勾选了也不在池里（poolAccounts 强制排除），界面据此禁勾并打标
      isCurrentLogin: !!(meta.uid && loginUids.has(String(meta.uid))),
    };
  });
  return {
    enabled: !!cfg.proxy?.enabled,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    chatUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
    hasKey: !!cfg.proxy?.apiKey,
    keyPreview: cfg.proxy?.apiKey ? `sk-wb-••••${cfg.proxy.apiKey.slice(-6)}` : '',
    // 明文只在用户点「显示」时带出（本机工具、用户自己的 Key，与模型页 Key 显示口径一致）
    apiKey: reveal ? cfg.proxy?.apiKey || '' : '',
    accountIds: selected,
    poolCount: poolAccounts().length,
    accounts,
    models: state.models,
    stats: state.stats,
    logs: state.logs.slice(0, 50),
  };
}

/** 伪模型：不是真实模型 id，发给上游等于把选择权丢回去（忙时挂起/429），自检不能用它 */
const PSEUDO_MODELS = new Set(['auto', 'default']);

export function isPseudoModel(model) {
  return PSEUDO_MODELS.has(String(model || '').trim());
}

/** 模型清单只读视图（/api/proxy/doctor 体检用） */
export function modelsState() {
  return { ids: [...state.models.ids], fetchedAt: state.models.fetchedAt, error: state.models.error };
}

/**
 * harness 常见模型名 → 本清单内真实模型。
 *
 * 「反代经常被拒绝」最主要的来源：客户端带着自己的默认模型名（DeepSeek harness 的
 * deepseek-chat / deepseek-reasoner、Claude Code 的 claude-sonnet-*、Codex/SDK 的
 * gpt-5.x）发请求，反代原样转发 → 上游 11102「模型不可用」直接拒绝。
 * 这里做别名兼容：命中就静默替换成清单内等价模型，用户不用改 harness 配置。
 */
const MODEL_ALIASES = new Map([
  // DeepSeek harness / OpenAI 兼容客户端
  ['deepseek-chat', 'deepseek-v4.1-flash'],
  ['deepseek-reasoner', 'deepseek-v4-pro'],
  ['deepseek-coder', 'deepseek-v4-pro'],
  ['deepseek-v3', 'deepseek-v3-2-volc'],
  ['deepseek-v3.2', 'deepseek-v3-2-volc'],
  ['deepseek-v2.5', 'deepseek-v4.1-flash'],
  // OpenAI 风格客户端（Codex CLI / 通用 SDK）
  ['gpt-4o', 'hy3'],
  ['gpt-4o-mini', 'hy3'],
  ['gpt-4.1', 'hy3'],
  ['gpt-4', 'hy3'],
  ['gpt-5', 'hy4-preview'],
  ['gpt-5.1', 'hy4-preview'],
  ['o3', 'hy4-preview'],
  ['o4-mini', 'hy3'],
  // Anthropic 风格客户端（Claude Code / ZCode 等）
  ['claude-sonnet-4-5', 'glm-5.3'],
  ['claude-sonnet-4-20250514', 'glm-5.3'],
  ['claude-3-5-sonnet', 'glm-5.3'],
  ['claude-3-7-sonnet', 'glm-5.3'],
  ['claude-opus-4-1', 'glm-5.3'],
  ['claude-haiku-3-5', 'glm-5.3-flash'],
]);

/**
 * 把客户端请求的模型名换成上游能认的 id（纯函数，供测试）。
 * 命中别名返回真实模型；否则原样返回（含清单内真实模型与伪模型）——是否拒绝未知
 * 模型仍交给上游判断，避免本地模型清单未加载时误拒合法模型。
 */
export function applyModelAlias(model) {
  const raw = String(model || '').trim();
  if (!raw) return raw;
  const hit = MODEL_ALIASES.get(raw.toLowerCase());
  return hit || raw;
}

/**
 * 自检模型挑选（纯函数，供测试）：跳过伪模型，**优先免费模型 hy3**（实测 0 积分/次，
 * 全天响应稳定）；hy3 不在列表里时取第一个真实模型。
 * 用免费模型做自检还有一层意义：自检消耗是真实的——用 auto 实测被路由到 hy4-preview
 * （≈41.8 积分/次），点一次自检烧一次积分。
 */
export function pickTestModel(ids) {
  const real = (Array.isArray(ids) ? ids : []).map((m) => String(m || '').trim()).filter((m) => m && !isPseudoModel(m));
  return real.includes('hy3') ? 'hy3' : real[0] || '';
}

/** 自检预览：chatComplete 聚合出的是 OpenAI 形状的 JSON，抽出正文给人看 */
function testPreview(text) {
  let preview = String(text || '');
  try {
    const msg = JSON.parse(preview)?.choices?.[0]?.message;
    const content = typeof msg?.content === 'string' ? msg.content : '';
    const reasoning = typeof msg?.reasoning_content === 'string' ? msg.reasoning_content : '';
    preview = content || (reasoning ? `（思考）${reasoning}` : '') || preview;
  } catch {
    /* 非 JSON 原样截断 */
  }
  return preview.slice(0, 200);
}

/**
 * 挂载反向代理路由。
 * 必须在 Express 的静态资源 / SPA 兜底之前调用，否则 /v1/* 会被 index.html 吃掉。
 */
export function registerProxyRoutes(app, { port }) {
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
    res.status(500).json({ error: err?.message || '服务器内部错误' });
  });

  /**
   * 本机访问防护（DNS rebinding / 管理端点裸奔）：本服务的 /api/proxy/* 管理端点
   * （含 status?reveal=1 返回**明文 apiKey**、PUT config、key/rotate）此前完全无鉴权，
   * 任何能解析到 127.0.0.1 的域名都能直接调用（2026-10-26 审查 H1）。
   * 浏览器/HTTP 客户端直连本机时 Host 头必是本机地址；被恶意域名 rebinding 过来时
   * Host 是该域名 → 一刀切拒绝。必须在所有路由之前挂。
   */
  const LOCAL_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
  app.use((req, res, next) => {
    if (!LOCAL_HOST_RE.test(String(req.headers.host || ''))) {
      return res.status(403).json({ error: '仅允许本机访问' });
    }
    next();
  });

  /**
   * CORS：有些调用方是浏览器页面（自建 Web UI / 在线前端），同源策略会拦预检。
   * 这里只监听 127.0.0.1，放行成本极低；不放行的话这类客户端根本连不上。
   *
   * 注意 `/v1` 与 `/v1beta` 是两个独立前缀（Express 的 use 按路径段边界匹配，
   * `/v1` 不会命中 `/v1beta`），所以两个都要挂。
   */
  const corsV1 = (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, X-API-Key, X-Goog-Api-Key, Anthropic-Version, Anthropic-Beta, Anthropic-Dangerous-Direct-Browser-Access'
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  };
  app.use('/v1', corsV1);
  app.use('/v1beta', corsV1);

  // 拒绝也要留痕（必须在各端点之前挂）
  app.use('/v1', watchRejections);
  app.use('/v1beta', watchRejections);

  app.get('/api/proxy/status', (req, res) => res.json(publicStatus(port, { reveal: req.query.reveal === '1' })));

  app.put(
    '/api/proxy/config',
    wrap(async (req, res) => {
      const cfg = loadConfig();
      cfg.proxy = { ...DEFAULT_PROXY, ...cfg.proxy };
      if (typeof req.body?.enabled === 'boolean') cfg.proxy.enabled = req.body.enabled;
      if (Array.isArray(req.body?.accountIds)) cfg.proxy.accountIds = req.body.accountIds.filter((x) => typeof x === 'string');
      if (cfg.proxy.enabled && !cfg.proxy.apiKey) cfg.proxy.apiKey = ensureKey();
      // 异步落盘：本机写盘可能被外部进程拦几十秒，同步版会把整个事件循环冻住，
      // 前端 25 秒默认超时就把「其实已经保存成功」误报成失败
      const ms = await saveConfigAsync(cfg);
      if (ms > 2000) console.log(`[proxy] 保存代理开关耗时 ${ms}ms`);
      res.json(publicStatus(port));
    })
  );

  app.post(
    '/api/proxy/key/rotate',
    wrap(async (req, res) => {
      const cfg = loadConfig();
      cfg.proxy = { ...DEFAULT_PROXY, ...cfg.proxy, apiKey: newProxyKey() };
      // 同上：用户点「重新生成 Key」正在等结果，不能同步写盘（2026-10-25 25 秒超时反馈）
      const ms = await saveConfigAsync(cfg);
      console.log(`[proxy] 已重新生成 API Key，落盘 ${ms}ms`);
      // reveal：刚生成的 Key 必须随响应带回明文。否则前端只拿到掩码预览，
      // 而界面里残留的旧明文（用户点过「显示」）会继续显示 → 看起来"没刷新"。
      res.json(publicStatus(port, { reveal: true }));
    })
  );

  app.post('/api/proxy/models/refresh', wrap(async (req, res) => res.json(await refreshModelsCache())));

  app.get('/api/proxy/logs', (req, res) => res.json({ logs: state.logs.slice(0, 200) }));

  /**
   * 连通性自检：发一条极短的非流式请求，验证「Key → 账号 → 官方接口」整条链路。
   *
   * 模型挑选见 pickTestModel——**不能用 models.ids[0]**：列表首位常是伪模型 "auto"，
   * 上游会把它路由到不可控的模型（实测 2026-10-22 auto→hy4-preview，≈41.8 积分/次），
   * 忙时要么挂满 60 秒超时、要么 429 "Model busy"，自检按钮看起来就是坏的。
   */
  app.post(
    '/api/proxy/test',
    wrap(async (req, res) => {
      const pool = poolAccounts();
      if (!pool.length) return res.status(400).json({ ok: false, error: '没有可用账号' });
      // 前端可能显式传来伪模型（旧版 ids[0]）；这里统一净化
      const requested = String(req.body?.model || '').trim();
      const model = requested && !isPseudoModel(requested) ? requested : pickTestModel(state.models.ids);
      if (!model) return res.status(400).json({ ok: false, error: '没有可用模型，请先刷新模型列表' });
      const account = pool[0];
      try {
        if (needsRefresh(account)) await refreshAccessToken(account);
        let out = await chatComplete(
          account,
          { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16 },
          { timeoutMs: 60_000 }
        );
        // 忙时 429 是常态：官方给了 retry_after 就等一次再试，别让用户手动点第二下
        if (!out.ok && out.status === 429) {
          let waitMs = 5_000;
          try {
            const ra = Number(JSON.parse(out.text)?.retry_policy?.retry_after);
            if (Number.isFinite(ra) && ra > 0) waitMs = Math.min(ra, 15) * 1000;
          } catch {
            /* 响应体不是 JSON，用默认等待 */
          }
          await new Promise((r) => setTimeout(r, waitMs));
          out = await chatComplete(
            account,
            { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16 },
            { timeoutMs: 60_000 }
          );
        }
        if (out.ok) {
          return res.json({
            ok: true,
            account: accountMeta(account).name,
            variant: variantOf(account).label,
            model,
            preview: testPreview(out.text),
          });
        }
        return res.json({ ok: false, account: accountMeta(account).name, error: out.error });
      } catch (err) {
        res.json({ ok: false, account: accountMeta(account).name, error: err?.message || String(err) });
      }
    })
  );

  // 四种协议端点：不同 agent 说不同的"方言"，共用同一个账号池
  app.post('/v1/chat/completions', wrap(handleChat)); // OpenAI SDK / Cherry Studio / ZCode(OpenAI 模式)
  app.post('/v1/messages', wrap(handleMessages)); // Claude Code / ZCode(Anthropic 模式)
  app.post('/v1/responses', wrap(handleResponses)); // Codex CLI
  app.get('/v1/models', wrap(handleModels));

  // Gemini 原生协议：模型在路径里，且带冒号方法后缀，Express 的字符串路由表达不了，
  // 用正则匹配（贪婪 .+ 保证 model 自身含 `/` 也能取到，如 google/gemini-3-pro）
  const GEMINI_PATH = /^\/v1beta\/models\/(.+):(generateContent|streamGenerateContent)$/;
  app.post(GEMINI_PATH, wrap(handleGemini)); // Gemini CLI / Gemini 原生 SDK
  app.post(/^\/v1beta\/models\/(.+):countTokens$/, wrap(handleGeminiCountTokens));
  app.get('/v1beta/models', wrap(handleGeminiModels)); // Gemini CLI 的模型清单
}
