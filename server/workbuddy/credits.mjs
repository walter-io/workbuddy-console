/**
 * 积分（资源余额）统计。
 *
 * 复刻 workbuddy-switch 的 credit_usage.rs + official_usage.rs 的核心逻辑，
 * 但做了一处关键简化与一处关键增强：
 *
 * 简化：不再自己实现"快照推导消耗"作为唯一数据源。官方
 * `get-user-request-usage` 接口直接给出**逐请求**的 credit 明细，
 * 按日/按模型/按账号聚合后就是精确消耗，比本地快照差值法更准。
 * 本地快照降级为**离线兜底**——接口不可用时仍能展示历史趋势。
 *
 * 增强：快照在每次成功查询后自动落盘（供离线兜底与"余额曲线"使用）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { proxyFetch } from '../proxy.mjs';
import { variantOf, getVariant, officialNetHint } from './variant.mjs';
import {
  loadAccounts,
  accountDisplayName,
  secretValue,
  findAccount,
  STORE_DIR,
  CREDIT_SNAPSHOTS_FILE,
  OFFICIAL_USAGE_CACHE_FILE,
  readJsonFile,
} from './accounts.mjs';
import { atomicWriteJson, atomicWriteJsonAsync } from '../store/config.mjs';

/** 单次查询最多返回条数；超过时靠推进起点反复扫描 */
const PAGE_SIZE = 3000;
/** 每个账号落进 requests 明细的条数上限（前端分页展示，防止缓存文件膨胀） */
const DETAIL_LIMIT = 1000;
/** 连续扫描轮数上限，兜住"服务端异常回同一页"的死循环 */
const MAX_ROUNDS = 100;
/** 快照保留天数 */
const SNAPSHOT_RETENTION_DAYS = 90;
const SNAPSHOT_MAX_RECORDS = 5000;

/** 缓存有效期：官方接口较慢，短时间内重复打开统计页直接用缓存 */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** 请求头：与官方前端 Axios 拦截器保持一致，避免网关把请求判为未知客户端 */
export function authHeaders(account, url) {
  const variant = variantOf(account);
  const origin = url.startsWith(variant.apiEndpoint) ? variant.apiEndpoint : getVariant(variant).apiEndpoint;
  const headers = {
    Authorization: `Bearer ${typeof secretValue(account, 'access_token') === 'string' ? secretValue(account, 'access_token') : ''}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Client-Platform': 'web',
    Origin: origin,
    Referer: `${origin}/profile/plans-usage`,
  };
  if (account?.uid) headers['X-User-Id'] = String(account.uid);
  const eid = account?.enterpriseId || account?.enterprise_id;
  if (eid) {
    headers['X-Enterprise-Id'] = String(eid);
    headers['X-Tenant-Id'] = String(eid);
  }
  if (account?.domain) headers['X-Domain'] = String(account.domain);
  return headers;
}

/** 带账号凭据的 POST；网络失败原样抛出，由上层归类为"该账号查询失败" */
async function authenticatedPost(account, url, body) {
  const res = await proxyFetch(url, {
    method: 'POST',
    headers: authHeaders(account, url),
    body: JSON.stringify(body),
    // 计费/用量也是官方接口，提示按档位给（国际版要代理，国内版查网络）
    netHint: officialNetHint(variantOf(account).id),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const err = new Error(`接口返回非 JSON（HTTP ${res.status}）`);
    // 401/403 且响应不是 JSON 时，同样要能识别成"凭据失效"
    if (res.status === 401 || res.status === 403) err.unauthorized = true;
    throw err;
  }
  if (!res.ok && (res.status === 401 || res.status === 403)) {
    const err = new Error(json?.msg || json?.message || json?.Message || `HTTP ${res.status}`);
    err.unauthorized = true;
    throw err;
  }
  return json;
}

/**
 * 校验一个账号的凭据**服务端是否认可**（本机未过期 ≠ 真的有效）。
 *
 * 2026-10-18 用户反馈：面板显示「凭据有效」，切过去 WorkBuddy 却说登录已过期。
 * 原因是面板的判断只看本地 expiresAt——token 可能早已被轮换/吊销，只有真的打一次
 * 官方接口才知道。这里复用余额汇总接口（最轻、所有账号都有权限）。
 *
 * 返回 `{ valid, unauthorized, message }`：
 * - `unauthorized: true` → 服务端明确拒绝（凭据失效，只能重新登录/重新导入）；
 * - `valid: false` 但 `unauthorized: false` → 网络/接口异常，**不能**据此判定凭据失效。
 */
export async function verifyAccountCredential(account) {
  const variant = variantOf(account);
  try {
    await authenticatedPost(account, variant.resourceUrl, {});
    return { valid: true, unauthorized: false, message: '' };
  } catch (err) {
    return {
      valid: false,
      unauthorized: !!err?.unauthorized,
      message: err?.message || '凭据校验失败',
    };
  }
}

/** 官方统一响应包：{ code, data, msg }。code 非 0 视为业务失败 */
function unwrap(json) {
  if (!json || typeof json !== 'object') throw new Error('接口返回为空');
  const code = json.code ?? json.Code ?? 0;
  if (code !== 0) {
    const msg = json.msg || json.message || json.Message || `错误码 ${code}`;
    // 401/未授权要能识别，以便提示"token 已失效，请重新登录"
    const err = new Error(msg);
    err.unauthorized = /401|unauthorized|未授权|登录|token/i.test(String(msg)) || code === 401;
    throw err;
  }
  return json.data ?? json.Data ?? json;
}

/** 时间戳 → 本地日期字符串 YYYY-MM-DD */
export function localDate(ts) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function dateStr(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function dateTimeStr(d) {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${dateStr(d)} ${hh}:${mm}:${ss}`;
}

/**
 * 解析一条请求明细的时间。官方返回 `requestTime` 为 "YYYY-MM-DD HH:mm:ss"
 * 本地时间字符串；也兼容时间戳与 RFC3339。
 */
function parseRequestTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // 秒级时间戳（10 位）转毫秒
    const ms = value < 1e11 ? value * 1000 : value;
    const d = new Date(ms);
    return { ts: d.getTime(), date: dateStr(d), time: dateTimeStr(d) };
  }
  const text = String(value || '').trim();
  if (!text) return null;
  // "2026-10-12 11:37:00" 按本地时间解析（不用 new Date(text)，Safari/Node 对该格式不一致）
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (m) {
    const ts = new Date(
      Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      Number(m[4]), Number(m[5]), Number(m[6])
    ).getTime();
    return { ts, date: m[1] + '-' + m[2] + '-' + m[3], time: text };
  }
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) {
    const d = new Date(parsed);
    return { ts: parsed, date: dateStr(d), time: dateTimeStr(d) };
  }
  return null;
}

function num(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 从单页响应里取出请求明细数组。
 *
 * 实测官方返回 `data.data`，另有 list / requests / records 等历史变体，一并兼容。
 * 注意：明细里带 `input`（用户提问原文）与 `inputTrunc`，属于隐私内容，
 * 这里只定位数组位置，字段级白名单在下方 rows.push 处执行——绝不整条透传。
 */
function extractRows(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  const candidates = [data.data, data.list, data.requests, data.records, data.items, data.requestList];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

/**
 * 扫描单个账号最近 N 天的官方请求用量。
 *
 * 服务端单次最多返回 PAGE_SIZE 条，且超限时**保留最早的一批**，
 * 因此不能靠 total 判断是否取完，而是"取满就把起点推进到本轮最新一条"反复扫，
 * 直到某一轮取不满为止。
 */
/** 官方接口一次最多只认 30 天窗口，超过就返回空数组（实测 90 天全账号都是 0 条） */
const MAX_WINDOW_DAYS = 30;

/** 取一个时间窗口内的全部记录（自动翻页），seen 跨窗口共享用于去重 */
async function fetchWindow(account, url, startTime0, endTime, seen) {
  const rows = [];
  let startTime = startTime0;
  let rounds = 0;

  while (rounds < MAX_ROUNDS) {
    const json = await authenticatedPost(account, url, {
      startTime,
      endTime,
      pageNum: 1,
      pageSize: PAGE_SIZE,
    });
    const data = unwrap(json);
    const page = extractRows(data);
    if (!page.length) break;

    let newestTs = 0;
    page.forEach((raw, idx) => {
      const time = parseRequestTime(raw?.requestTime ?? raw?.createTime ?? raw?.time);
      if (!time) return;
      if (time.ts > newestTs) newestTs = time.ts;
      // requestId 缺失时用「时间+模型+序号」构造去重键，保证多轮扫描不重复计入
      const id = String(raw?.requestId ?? raw?.id ?? `${time.ts}|${raw?.model ?? ''}|${idx}`);
      if (seen.has(id)) return;
      seen.add(id);
      rows.push({
        requestId: id,
        ts: time.ts,
        date: time.date,
        time: time.time,
        model: String(raw?.model || 'unknown'),
        client: String(raw?.client || ''),
        credit: num(raw?.credit ?? raw?.credits),
      });
    });

    // 未取满 = 区间内数据已扫完
    if (page.length < PAGE_SIZE) break;
    if (!newestTs) break;
    // 起点无法推进（服务端返回的时间没有前进）= 停滞，保留已有数据退出
    const next = new Date(newestTs + 1000);
    const nextStart = `${dateTimeStr(next)}`;
    if (nextStart <= startTime) break;
    startTime = nextStart;
    rounds++;
  }

  return rows;
}

async function fetchAccountUsage(account, days) {
  const url = variantOf(account).usageUrl;
  const rows = [];
  const seen = new Set();

  // 按 30 天切段往前扫：接口对超长区间直接返回空，不切段的话 60/90 天永远是空数据
  let cursorEnd = new Date();
  let remaining = Math.max(1, days);
  while (remaining > 0) {
    const span = Math.min(MAX_WINDOW_DAYS, remaining);
    const start = new Date(cursorEnd);
    start.setDate(start.getDate() - (span - 1));
    const endTime = `${dateStr(cursorEnd)} 23:59:59`;
    const chunk = await fetchWindow(account, url, dateTimeStr(start), endTime, seen);
    rows.push(...chunk);
    cursorEnd = new Date(start);
    cursorEnd.setDate(cursorEnd.getDate() - 1);
    remaining -= span;
  }
  return rows;
}

/* ---------------- 本地快照（离线兜底 + 余额曲线） ---------------- */

export function loadSnapshots() {
  const raw = readJsonFile(CREDIT_SNAPSHOTS_FILE, []);
  return Array.isArray(raw) ? raw : [];
}

/** 记录一次余额观察；5 分钟内的重复快照不重复落盘（去重窗口） */
export async function recordSnapshot(account, total, remaining) {
  const snapshots = loadSnapshots();
  const now = Date.now();
  const last = snapshots
    .filter((s) => s?.accountId === account.id)
    .sort((a, b) => b.ts - a.ts)[0];
  if (last && Math.abs(num(last.total) - total) < 0.01 && Math.abs(num(last.remaining) - remaining) < 0.01) {
    return; // 余额没变，不写
  }
  snapshots.push({
    ts: now,
    accountId: account.id,
    accountName: accountDisplayName(account),
    variant: variantOf(account).id,
    total: Math.max(0, total),
    remaining: Math.max(0, remaining),
  });
  // 保留期裁剪
  const cutoff = now - SNAPSHOT_RETENTION_DAYS * 24 * 3600 * 1000;
  const kept = snapshots
    .filter((s) => num(s?.ts) >= cutoff)
    .sort((a, b) => a.ts - b.ts)
    .slice(-SNAPSHOT_MAX_RECORDS);
  // 异步落盘：余额查询跑在请求路径上，同步写撞上 EPERM 锁窗会把整个服务冻住
  await atomicWriteJsonAsync(CREDIT_SNAPSHOTS_FILE, kept);
}

/**
 * 商品码 → 官方中文名。
 *
 * 与官方客户端展示文案对齐（客户端把积分分成三类展示：套餐基础积分 / 平台奖励积分 / 购买积分）：
 * - 套餐内基础额度（原"版本基础用量"系列）→ 套餐基础积分
 * - 活动/裂变/赠送包 → 平台奖励积分
 * - 付费购买的积分包 → 购买积分
 *
 * 来源：官方客户端 asar 内的 package-name-resolver.ts + 实机截图比对（2026-10）。
 * 国际版才用后端下发的 PackageName。未登记的商品码保持回落链，不会漏展示。
 * 官方新增商品码时需手工同步。
 */
const CREDIT_PACKAGE_NAMES = {
  TCACA_code_001_PqouKr6QWV: 'CodeBuddy 个人体验版',
  TCACA_code_002_AkiJS3ZHF5: '套餐基础积分',
  TCACA_code_003_FAnt7lcmRT: 'CodeBuddy 个人标准版',
  TCACA_code_005_maRGyrHhw1: '套餐基础积分',
  TCACA_code_006_DbXS0lrypC: 'CodeBuddy 个人体验版',
  TCACA_code_007_nzdH5h4Nl0: '平台奖励积分',
  TCACA_code_008_cfWoLwvjU4: '套餐基础积分',
  TCACA_code_009_0XmEQc2xOf: '购买积分',
  TCACA_code_023_4xbGhMrE6q: '套餐基础积分',
  TCACA_code_026_BaESVICNoi: '套餐基础积分',
  TCACA_code_027_0FCGVA6vSa: '套餐基础积分',
  TCACA_code_028_NtpWi0jzXs: '平台奖励积分',
  TCACA_code_029_6wCGEWquYy: '平台奖励积分',
  TCACA_code_030_BjSt89qTvr: '平台奖励积分',
  TCACA_code_035_ArVxJcGDsm: '套餐基础积分',
  TCACA_code_036_lupO5WgNdG: '平台奖励积分',
  TCACA_code_037_WxOD3MpI2o: '平台奖励积分',
  TCACA_code_038_OhvqZtiPKr: '购买积分',
  TCACA_code_039_KRcQj7wUat: '套餐基础积分',
  TCACA_code_040_mi9rCYg46x: '套餐基础积分',
};

/** 到期时间早于「扣除结束时间 + 该天数」时改用周期结束时间（视前者为长期占位） */
const EXPIRY_CYCLE_OVERRIDE_DAYS = 30;
/** 距现在超过该天数视为长期有效（官方占位值） */
const FAR_FUTURE_EXPIRY_DAYS = 365;
/** 临近到期窗口 */
const EXPIRING_SOON_DAYS = 7;

/**
 * 付费 / 免费积分包的**明细**接口（与汇总接口分开）。
 *
 * 汇总接口只给当前周期的总额与剩余，**不含任何到期字段**；到期时间只在明细
 * 接口的记录里（`DeductionEndTime` / `CycleEndTime` / `ExpiredTime`）。
 * 两者按 PackageCode 关联：汇总决定权威数额，明细只负责补到期时间。
 * 商品码清单与 workbuddy-switch 一致（∪ 官方客户端 PAID/FREE_PACKAGE_CODES），
 * 请求体多带码对不存在的包无副作用。
 */
const RESOURCE_PAID_PACKAGES_PATH = '/billing/meter/get-user-resource-paid-packages';
const RESOURCE_FREE_PACKAGES_PATH = '/billing/meter/get-user-resource-free-packages';
const PAID_PACKAGE_CODES = [
  'TCACA_code_002_AkiJS3ZHF5',
  'TCACA_code_023_4xbGhMrE6q',
  'TCACA_code_026_BaESVICNoi',
  'TCACA_code_027_0FCGVA6vSa',
  'TCACA_code_009_0XmEQc2xOf',
  'TCACA_code_038_OhvqZtiPKr',
  'TCACA_code_003_FAnt7lcmRT',
  'TCACA_code_036_lupO5WgNdG',
];
const FREE_PACKAGE_CODES = [
  'TCACA_code_008_cfWoLwvjU4',
  'TCACA_code_007_nzdH5h4Nl0',
  'TCACA_code_028_NtpWi0jzXs',
  'TCACA_code_029_6wCGEWquYy',
  'TCACA_code_030_BjSt89qTvr',
  'TCACA_code_001_PqouKr6QWV',
  'TCACA_code_006_DbXS0lrypC',
  'TCACA_code_035_ArVxJcGDsm',
  'TCACA_code_037_WxOD3MpI2o',
  'TCACA_code_039_KRcQj7wUat',
  'TCACA_code_040_mi9rCYg46x',
];

/** 取第一个有值的字段（官方大小写变体都要兼容） */
function firstValue(raw, keys) {
  for (const k of keys) {
    const v = raw?.[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/**
 * 时间字段 → 毫秒时间戳。
 * 兼容三种形态：毫秒/秒级数字、"YYYY-MM-DD HH:mm:ss" 本地时间字符串、可被
 * Date.parse 解析的其他字符串。无法解析返回 null。
 */
function parseTimestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e11 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n < 1e11 ? n * 1000 : n;
    // 明细接口的到期字段是这个格式，且必须是本地时间（不能丢给 Date.parse 赌实现）
    const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (m) {
      return new Date(
        Number(m[1]), Number(m[2]) - 1, Number(m[3]),
        Number(m[4]), Number(m[5]), Number(m[6])
      ).getTime();
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * 解析单个资源包的到期时刻。
 *
 * 优先 DeductionEndTime / ExpiredTime；仅当 CycleEndTime 比其早 **≥30 天** 时
 * 改用周期结束时间（前者是长期占位）。
 *
 * ⚠️ 必须是 ≥ 而不是 >：实测（2026-10，code_007 平台奖励积分 66 条记录）
 * DeductionEndTime 恰好等于 CycleEndTime + 整 30 天（2,592,000,000ms），
 * 用 > 会导致整 30 天的占位值漏判，到期时间普遍多算一个月。
 * 最终值距现在超过 365 天视为长期有效。
 */
function resolveExpireAt(raw, now) {
  const deductionEnd = parseTimestampMs(
    firstValue(raw, ['DeductionEndTime', 'deductionEndTime', 'ExpiredTime', 'expiredTime']),
  );
  const cycleEnd = parseTimestampMs(firstValue(raw, ['CycleEndTime', 'cycleEndTime']));
  const overrideMs = EXPIRY_CYCLE_OVERRIDE_DAYS * 24 * 3600 * 1000;
  let expireAt = null;
  if (deductionEnd != null && cycleEnd != null && deductionEnd - cycleEnd >= overrideMs) {
    expireAt = cycleEnd;
  } else if (deductionEnd != null) {
    expireAt = deductionEnd;
  } else {
    expireAt = cycleEnd;
  }
  if (expireAt == null) return null;
  return expireAt - now <= FAR_FUTURE_EXPIRY_DAYS * 24 * 3600 * 1000 ? expireAt : null;
}

/** 官方资源包名：商品码命中映射用映射名，否则回落 PackageName → packageCode */
function creditPackageName(raw) {
  const code = firstValue(raw, ['PackageCode', 'packageCode']);
  const name = firstValue(raw, ['PackageName', 'packageName']);
  if (code && CREDIT_PACKAGE_NAMES[code]) return CREDIT_PACKAGE_NAMES[code];
  return name || code || '积分包';
}

/**
 * 拉取付费 / 免费两类积分包明细，返回「商品码 → 该码下最早的有效到期时刻」。
 *
 * 明细接口一次返回全部历史成交记录（含已用完、已到期的），同一 PackageCode 会有
 * 很多条。对汇总里的一个包来说，「到期时间」应当是**还有额度的那批里最早会过期的一笔**：
 *
 * - 只取「未过期」是不够的——实测（2026-10-16，code_007 平台奖励积分）63 笔
 *   未过期记录**全部已用完**，真正还有额度的只有 1 笔（2027/4/9，剩余 321）。
 *   旧逻辑取到最早那笔「已用完的 10/17」，卡片于是显示 10/17 到期，而那时用户
 *   手里其实还有 321 积分可用——正是用户反馈的误导点（官方客户端也有同样问题）。
 * - 因此这里分两档：主档只认「未过期 **且 还有剩余**」的记录；若该包所有记录都已
 *   用完（如 0/500 的套餐基础积分），兜底回落到「最早一笔未过期」，
 *   保证卡片仍能显示一个可参考的周期刷新时间，而不是变成"长期有效"。
 *
 * 明细查询失败不影响汇总结果——只是各包到期时间显示为「长期有效」。
 */
async function fetchPackageExpiryMap(account, origin) {
  const paidBody = {
    PageNumber: 1,
    PageSize: 200,
    Status: [0, 3],
    PackageCodes: PAID_PACKAGE_CODES,
    NeedRenewInfo: true,
  };
  // ⚠️ 不带 SlicePeriodStartTime/EndTime：实测（2026-10）带当天切片会漏掉
  // 月度套餐包（如 code_008 套餐基础积分）的记录，导致"套餐基础积分"没有到期时间。
  // 不带切片时返回全部历史记录（含已用完/已过期的），PageSize 200 内由 consider 过滤。
  const freeBody = {
    PageNumber: 1,
    PageSize: 200,
    Status: [0, 3],
    PackageCodes: FREE_PACKAGE_CODES,
    NeedRenewInfo: true,
  };

  const [paidRes, freeRes] = await Promise.allSettled([
    authenticatedPost(account, origin + RESOURCE_PAID_PACKAGES_PATH, paidBody),
    authenticatedPost(account, origin + RESOURCE_FREE_PACKAGES_PATH, freeBody),
  ]);

  const now = Date.now();
  /** 商品码 → 最早一笔「未过期且还有额度」的到期时刻（主口径） */
  const map = new Map();
  /** 商品码 → 最早一笔「未过期」的到期时刻（该包全部用完后兜底） */
  const fallback = new Map();
  const consider = (raw) => {
    const code = firstValue(raw, ['PackageCode', 'packageCode']);
    if (!code) return;
    const expireAt = resolveExpireAt(raw, now);
    if (expireAt == null || expireAt <= now) return; // 已过期/长期有效不参与
    const prevFallback = fallback.get(code);
    if (prevFallback == null || expireAt < prevFallback) fallback.set(code, expireAt);
    // 剩余额度：周期口径优先，单笔口径兜底（两者都缺时 num() 回落为 0）
    const remain = num(
      firstValue(raw, ['CycleCapacityRemain', 'cycleCapacityRemain', 'CapacityRemain', 'capacityRemain'])
    );
    if (remain > 0) {
      const prev = map.get(code);
      if (prev == null || expireAt < prev) map.set(code, expireAt);
    }
  };

  for (const settled of [paidRes, freeRes]) {
    if (settled.status !== 'fulfilled') continue;
    let data;
    try {
      data = unwrap(settled.value);
    } catch {
      continue; // 单侧失败不影响另一侧
    }
    const list = data?.Accounts ?? data?.accounts ?? (Array.isArray(data) ? data : []);
    if (Array.isArray(list)) list.forEach(consider);
  }
  for (const [code, expireAt] of fallback) {
    if (!map.has(code)) map.set(code, expireAt);
  }
  return map;
}

/**
 * 查询单个账号的资源余额（积分，单位 credits）。
 *
 * 三个接口合并，各自职责分明：
 *
 * 1. `get-user-resource-summary`（汇总）——**权威数额**。返回 `data.Packages[]`，
 *    每包给出周期总额/剩余/已用，但不含任何到期字段；
 * 2. `get-user-resource-paid-packages` / `-free-packages`（明细）——只用来补
 *    **到期时间**，按 PackageCode 关联到汇总的包上。
 *
 * 之所以不让明细参与求和：明细是逐笔成交记录，同一商品码会有很多条历史，
 * 直接相加会和汇总的周期口径重复计算。汇总的 remaining 才是当前真实余额。
 *
 * 同时保留旧版标量形状（remaining/total）作为兼容兜底。
 */
async function fetchBalance(account) {
  const variant = variantOf(account);
  const json = await authenticatedPost(account, variant.resourceUrl, {});
  const data = unwrap(json);

  const packages = Array.isArray(data?.Packages)
    ? data.Packages
    : Array.isArray(data?.packages)
      ? data.packages
      : null;

  if (packages?.length) {
    const now = Date.now();
    let total = 0;
    let remaining = 0;
    let used = 0;
    const details = [];
    for (const p of packages) {
      const t = num(p?.CycleTotalCapacity ?? p?.totalCapacity);
      const r = num(p?.CycleRemainCapacity ?? p?.remainCapacity);
      const u = num(p?.CycleUsedCapacity ?? p?.usedCapacity);
      total += t;
      remaining += r;
      used += u;
      const code = firstValue(p, ['PackageCode', 'packageCode']) ?? null;
      details.push({
        packageCode: code,
        name: creditPackageName(p),
        total: round2(t),
        remaining: round2(r),
        used: round2(u),
        expireAt: null, // 下面用明细接口补
        expired: false,
        expiringSoon: false,
      });
    }
    // 剩余 + 已用 与总额对不上时（部分包无 used 字段），以总额减剩余兜底
    if (used <= 0 && total > remaining) used = total - remaining;

    // 明细接口补到期时间；失败则所有包保持"长期有效"，不影响余额展示
    try {
      const expiryMap = await fetchPackageExpiryMap(account, variant.apiEndpoint);
      for (const d of details) {
        const expireAt = (d.packageCode && expiryMap.get(d.packageCode)) ?? null;
        d.expireAt = expireAt;
        d.expired = expireAt != null && expireAt <= now;
        d.expiringSoon = expireAt != null && expireAt > now && expireAt - now <= EXPIRING_SOON_DAYS * 24 * 3600 * 1000;
      }
    } catch {
      /* 明细查询失败：到期时间留空 */
    }

    // 有剩余且未到期的排前面，同序按到期时间升序
    details.sort((a, b) => {
      const ra = a.remaining > 0 && !a.expired ? 0 : 1;
      const rb = b.remaining > 0 && !b.expired ? 0 : 1;
      if (ra !== rb) return ra - rb;
      const ea = a.expireAt ?? Number.POSITIVE_INFINITY;
      const eb = b.expireAt ?? Number.POSITIVE_INFINITY;
      return ea === eb ? 0 : ea < eb ? -1 : 1;
    });
    return {
      total: round2(total),
      remaining: round2(remaining),
      used: round2(used),
      packageCount: packages.length,
      unit: packages[0]?.CapacityUnit || 'credits',
      packages: details,
    };
  }

  // 标量形状兜底
  const pick = (...keys) => {
    for (const k of keys) {
      if (data?.[k] !== undefined && data?.[k] !== null && data[k] !== '') {
        const n = num(data[k]);
        if (Number.isFinite(n)) return n;
      }
    }
    return null;
  };
  const remaining = pick('remaining', 'remain', 'remainCredit', 'available', 'availableCredit');
  const total = pick('total', 'totalCredit', 'quota');
  if (remaining == null && total == null) {
    throw new Error('接口返回中没有可识别的余额字段');
  }
  const rem = remaining ?? 0;
  const tot = total ?? 0;
  return {
    total: round2(tot),
    remaining: round2(rem),
    used: round2(tot > 0 ? Math.max(0, tot - rem) : 0),
    packageCount: 0,
    unit: 'credits',
    packages: [],
  };
}

function round2(n) {
  return Math.round(num(n) * 100) / 100;
}

/**
 * 只查各账号的积分余额（含积分包明细），不走用量明细扫描。
 *
 * 账号页卡片要用「余额 + 近期到期」，那只需要一次资源接口；`getCreditStatistics`
 * 还要额外扫 30 天逐请求用量（上千条），放在账号页会把首屏拖慢。两者缓存策略
 * 相互独立：这里的结果只在进程内保留 BALANCE_CACHE_TTL_MS，落盘仍由
 * `recordSnapshot` 负责（给离线兜底用）。
 */
const BALANCE_CACHE_TTL_MS = 2 * 60 * 1000;
let balanceCache = { at: 0, payload: null };

export async function getAccountBalances({ refresh = false } = {}) {
  const now = Date.now();
  if (!refresh && balanceCache.payload && now - balanceCache.at < BALANCE_CACHE_TTL_MS) {
    return { ...balanceCache.payload, cached: true };
  }

  const accounts = loadAccounts().filter((a) => a?.uid);
  const rows = [];
  const errors = [];

  // 并发处理各账号：原先串行 9 个账号 × 2 个官方请求 ≈ 13 秒，并发后约 2-3 秒
  await Promise.all(accounts.map(async (account) => {
    const variant = variantOf(account);
    const base = {
      accountId: account.id,
      accountName: accountDisplayName(account),
      variant: variant.id,
      variantLabel: variant.label,
    };
    try {
      const b = await fetchBalance(account);
      await recordSnapshot(account, b.total, b.remaining);
      rows.push({ ...base, balance: { ...b, updatedAt: now }, balanceError: null, error: null, authInvalid: false });
    } catch (err) {
      // unauthorized = 官方明确拒绝这个 token（过期/被轮换/吊销）。界面据此把
      // 「凭据有效」改判为「凭据已失效」，不再拿本地有效期糊弄用户（2026-10-18 反馈）。
      rows.push({
        ...base,
        balance: null,
        balanceError: err?.message || '余额查询失败',
        error: err?.message || '查询失败',
        authInvalid: !!err?.unauthorized,
      });
      errors.push({ ...base, error: err?.message || '查询失败' });
    }
  }));

  const payload = {
    collectedAt: now,
    accounts: rows,
    errors,
  };
  balanceCache = { at: now, payload };
  return { ...payload, cached: false };
}

/* ---------------- 积分到期提醒 ----------------
 * Buddy One 积分按套餐周期发放、周期结束清零不结转（2026-11 官方口径）。
 * 用户月底才发现整池积分没用完就作废，损失最大——这里做两层：
 * 1) /api/accounts/credit-expiry：汇总「每个账号最近到期的可用积分包」，前端角标/提醒条用；
 * 2) 每日巡检（scheduleCreditExpiryCheck）：扫全部账号，到期窗口内的记进本地提醒档
 *    （credit-expiry-notifications.json），按「账号+包+到期日」去重，同一天不重复提醒。
 */

/** 提醒窗口：N 天内到期的积分包要提醒（官方套餐周期按自然月，月末是高峰） */
const EXPIRY_NOTIFY_DAYS = 3;
/** 巡检间隔：12 小时（服务长期挂机也能当天发现） */
const EXPIRY_CHECK_INTERVAL_MS = 12 * 3600 * 1000;
/** 提醒档路径：本地 JSON，与快照同目录 */
const EXPIRY_NOTIFY_FILE = path.join(STORE_DIR, 'credit-expiry-notifications.json');

/** 读取已发出的提醒档（损坏按空处理） */
function readExpiryNotified() {
  try {
    const arr = JSON.parse(fs.readFileSync(EXPIRY_NOTIFY_FILE, 'utf8'));
    return Array.isArray(arr) ? arr.filter((x) => typeof x?.key === 'string') : [];
  } catch {
    return [];
  }
}

async function writeExpiryNotified(keys) {
  try {
    await fs.promises.mkdir(STORE_DIR, { recursive: true });
    await fs.promises.writeFile(EXPIRY_NOTIFY_FILE, JSON.stringify(keys.slice(-500), null, 2), 'utf8');
  } catch {
    /* 落盘失败只影响去重，下轮会重复提醒一次，可接受 */
  }
}

/**
 * 汇总各账号「即将到期」的可用积分包。
 * 复用 getAccountBalances 的缓存（不额外打官方接口）；返回按到期时间升序的告警行。
 */
export async function getCreditExpirySummary() {
  const balances = await getAccountBalances();
  const now = Date.now();
  const horizon = now + EXPIRY_NOTIFY_DAYS * 24 * 3600 * 1000;
  const rows = [];
  for (const acc of balances.accounts || []) {
    const b = acc.balance;
    if (!b) continue;
    for (const p of b.packages || []) {
      if ((p.remaining ?? 0) <= 0) continue; // 用完的包不作废也不提醒
      if (p.expireAt == null) continue; // 长期有效不提醒
      if (p.expireAt <= now) continue; // 已过期的由过期态展示，不在这里重复
      if (p.expireAt > horizon) continue;
      rows.push({
        accountId: acc.accountId,
        accountName: acc.accountName,
        variant: acc.variant,
        variantLabel: acc.variantLabel,
        packageCode: p.packageCode,
        name: p.name,
        remaining: p.remaining,
        expireAt: p.expireAt,
        hoursLeft: Math.max(0, Math.round((p.expireAt - now) / 3600000)),
      });
    }
  }
  rows.sort((a, b) => a.expireAt - b.expireAt);
  return { collectedAt: now, windowDays: EXPIRY_NOTIFY_DAYS, rows };
}

/**
 * 每日巡检：到期窗口内的积分包记入提醒档（本地 JSON，通知中心读取展示）。
 * 按 `accountId|packageCode|到期日(本地)` 去重——同一个包同一天只提醒一次。
 * 巡检失败安静跳过（余额接口本身有缓存与错误兜底）。
 */
async function runCreditExpiryCheck() {
  try {
    const summary = await getCreditExpirySummary();
    if (!summary.rows.length) return;
    const seen = new Set(readExpiryNotified().map((x) => x.key));
    const d = new Date();
    const fresh = [];
    for (const r of summary.rows) {
      const dayKey = `${r.accountId}|${r.packageCode || r.name}|${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
      if (seen.has(dayKey)) continue;
      seen.add(dayKey);
      fresh.push({ key: dayKey, at: Date.now(), ...r });
    }
    if (fresh.length) {
      await writeExpiryNotified([...readExpiryNotified().map((x) => ({ key: x.key, at: x.at })), ...fresh]);
      console.log(`[credit-expiry] ${fresh.length} 个积分包将在 ${EXPIRY_NOTIFY_DAYS} 天内到期，已记入提醒`);
    }
  } catch (e) {
    console.log(`[credit-expiry] 巡检失败（下轮重试）：${String(e?.message || e).slice(0, 80)}`);
  }
}

/** 读取提醒档（前端通知中心/积分页提醒条用） */
export function readCreditExpiryNotifications() {
  return readExpiryNotified();
}

/** 启动后注册巡检：先延迟 90 秒（避开启动预热高峰），之后每 12 小时一轮 */
export function scheduleCreditExpiryCheck() {
  setTimeout(() => {
    void runCreditExpiryCheck();
    setInterval(runCreditExpiryCheck, EXPIRY_CHECK_INTERVAL_MS);
  }, 90_000);
}

/* ---------------- 逐笔积分明细（官方客户端的「积分明细」弹窗） ---------------- */

/** 单账号逐笔明细的进程内缓存：accountId → { at, payload } */
const detailsCache = new Map();
const DETAILS_CACHE_TTL_MS = 5 * 60 * 1000;
/** 单账号明细接口返回的记录上限（明细是逐笔成交记录，裂变包账号可能有几十上百条） */
const DETAILS_MAX_RECORDS = 500;

/**
 * 拉取单账号的**逐笔**积分明细（官方客户端「积分明细」弹窗的数据源）。
 *
 * 与 fetchBalance 的区别：汇总接口只给「每类包一个总数」，而明细接口返回每一笔
 * 发放记录（各自的到期时间与用量）——客户端弹窗里每行一条「到期时间 2026/10/15
 * 11:40:29 · 已使用 6/6」就是这里的原始记录。
 *
 * 请求形态与 fetchPackageExpiryMap 相同（带 PackageCodes、不带当天切片），但
 * **不过滤**已用完/已过期的记录：客户端的「已过期」tab 依赖它们。
 */
async function fetchCreditRecords(account) {
  const variant = variantOf(account);
  const origin = variant.apiEndpoint;
  const now = Date.now();

  const paidBody = {
    PageNumber: 1,
    PageSize: 200,
    Status: [0, 3],
    PackageCodes: PAID_PACKAGE_CODES,
    NeedRenewInfo: true,
  };
  const freeBody = {
    PageNumber: 1,
    PageSize: 200,
    Status: [0, 3],
    PackageCodes: FREE_PACKAGE_CODES,
    NeedRenewInfo: true,
  };

  const [paidRes, freeRes] = await Promise.allSettled([
    authenticatedPost(account, origin + RESOURCE_PAID_PACKAGES_PATH, paidBody),
    authenticatedPost(account, origin + RESOURCE_FREE_PACKAGES_PATH, freeBody),
  ]);

  const records = [];
  const collect = (settled) => {
    if (settled.status !== 'fulfilled') return;
    let data;
    try {
      data = unwrap(settled.value);
    } catch {
      return; // 单侧失败不影响另一侧
    }
    const list = data?.Accounts ?? data?.accounts ?? (Array.isArray(data) ? data : []);
    if (!Array.isArray(list)) return;
    for (const raw of list) {
      const expireAt = resolveExpireAt(raw, now);
      const cycleTotal = num(raw?.CycleCapacitySize ?? raw?.cycleCapacitySize);
      const cycleUsed = num(raw?.CycleCapacityUsed ?? raw?.cycleCapacityUsed);
      const flatTotal = num(raw?.CapacitySize ?? raw?.capacitySize);
      const flatUsed = num(raw?.CapacityUsed ?? raw?.capacityUsed);
      // 周期口径优先（裂变包按周期切片），单笔口径兜底；两者都缺失时记 0
      const total = cycleTotal != null && cycleTotal > 0 ? cycleTotal : flatTotal ?? 0;
      const used = cycleUsed != null && cycleUsed > 0 ? cycleUsed : flatUsed ?? 0;
      records.push({
        name: creditPackageName(raw),
        packageCode: firstValue(raw, ['PackageCode', 'packageCode']) ?? null,
        /** 到期时刻（官方客户端展示的就是它）；null = 长期有效 */
        expireAt,
        /** 周期结束时间（与到期时刻同源展示，客户端不区分） */
        cycleEnd: parseTimestampMs(firstValue(raw, ['CycleEndTime', 'cycleEndTime'])),
        total: round2(total),
        used: round2(used),
        remaining: round2(Math.max(0, total - used)),
        createTime: parseTimestampMs(raw?.CreateTime ?? raw?.createTime),
        expired: expireAt != null && expireAt <= now,
      });
    }
  };
  collect(paidRes);
  collect(freeRes);

  if (!records.length && (paidRes.status === 'rejected' || freeRes.status === 'rejected')) {
    // 两侧都失败时把第一个失败原因抛出去，让前端显示明确错误而不是"空明细"
    const reason = (paidRes.reason || freeRes.reason)?.message || '明细接口查询失败';
    throw new Error(reason);
  }

  // 到期时间升序（null 排最后），超出上限截断
  records.sort((a, b) => (a.expireAt ?? Number.MAX_SAFE_INTEGER) - (b.expireAt ?? Number.MAX_SAFE_INTEGER));
  return records.slice(0, DETAILS_MAX_RECORDS);
}

/**
 * 单账号逐笔积分明细（带 5 分钟进程内缓存）。
 *
 * @param {object} opts
 * @param {string} opts.accountId 账号库 id 或 uid
 * @param {boolean} opts.refresh true 时绕过缓存重新打官方接口
 */
export async function getCreditDetails({ accountId, refresh = false } = {}) {
  const account = findAccount(accountId);
  if (!account) throw new Error('账号不存在');
  if (!account.uid) throw new Error('该账号缺少 uid，无法查询积分明细');

  const now = Date.now();
  if (!refresh) {
    const cached = detailsCache.get(account.id);
    if (cached && now - cached.at < DETAILS_CACHE_TTL_MS) {
      return { ...cached.payload, cached: true };
    }
  }

  const records = await fetchCreditRecords(account);
  const payload = {
    accountId: account.id,
    accountName: accountDisplayName(account),
    variant: variantOf(account).id,
    collectedAt: now,
    records,
  };
  detailsCache.set(account.id, { at: now, payload });
  return { ...payload, cached: false };
}

/* ---------------- 主入口 ---------------- */

/** 本工具缓存 payload 的结构标识；读到别的结构一律当缓存不存在 */
const CACHE_SCHEMA = 'wb-console-credit-v1';

/** 各档位统计结果的进程内缓存（切「国内版/国际版」不再重新打官方接口） */
const variantCache = new Map(); // `${variant}|${days}` -> { at, payload }
const rawRowsCache = new Map(); // `all|${days}` -> 全量明细，供档位过滤重算

function readCache() {
  const raw = readJsonFile(OFFICIAL_USAGE_CACHE_FILE, null);
  const payload = raw?.payload;
  if (!payload || typeof payload !== 'object') return null;
  // 结构校验：必须是本工具写的（对方程序/旧版本的 payload 字段完全不同）
  if (payload.schema !== CACHE_SCHEMA) return null;
  if (!Array.isArray(payload.requests) || !Array.isArray(payload.accounts)) return null;
  // 账号行必须带 variant：没有就说明是外来结构，直接丢弃而不是拿残缺数据渲染
  if (payload.accounts.length && !('variant' in payload.accounts[0])) return null;
  return payload;
}

/**
 * 积分统计。
 *
 * @param {object} opts
 * @param {number} opts.days 统计窗口天数（默认 30）
 * @param {boolean} opts.refresh true 时绕过缓存重新打官方接口
 * @param {'all'|'cn'|'ai'} opts.variant 档位筛选：只统计该档位的账号（默认 all）
 */
/**
 * 预热另外两个区间：用户点完 30 天，通常在 7/90 之间来回切。
 * 后台算好放缓存，切换时直接命中（冷算一次 1.5~3.5 秒，切起来太慢）。
 */
const prefetching = new Set();
export function prefetchCreditRanges({ variant = 'all', days = 30 } = {}) {
  for (const d of [7, 30, 90]) {
    if (d === days) continue;
    // 统一预热「全部档位」的明细：cn/ai 之后直接过滤重算，不用各自再打一遍接口
    const key = `all|${d}`;
    if (prefetching.has(key)) continue;
    prefetching.add(key);
    // 90 天要按 30 天切 3 段，请求量是 7 天的 3 倍：错开 2.5 秒再跑，别和界面抢带宽
    const delay = d >= 90 ? 2500 : 80;
    setTimeout(() => {
      getCreditStatistics({ days: d, refresh: false, variant: 'all' })
        .catch(() => {})
        .finally(() => prefetching.delete(key));
    }, delay);
  }
  void variant;
}

export async function getCreditStatistics({ days = 30, refresh = false, variant = 'all' } = {}) {
  const variantFilter = variant === 'cn' || variant === 'ai' ? variant : 'all';
  const accounts = loadAccounts()
    .filter((a) => a?.uid)
    .filter((a) => variantFilter === 'all' || variantOf(a).id === variantFilter);
  const now = Date.now();

  // 缓存命中则直接返回，避免每次打开统计页都打官方接口
  // 注意：缓存键必须带天数——只按档位做键会导致「点近 7 天仍返回近 90 天的数据」
  const memKey = `${variantFilter}|${days}`;
  if (!refresh) {
    const mem = variantCache.get(memKey);
    if (mem && now - mem.at < CACHE_TTL_MS) return { ...mem.payload, cached: true };

    // 国内版/国际版 = 全部档位的子集：只要「全部」的原始明细还在内存里，
    // 直接过滤后重算聚合（几十毫秒），不用再打一遍官方接口（冷算 1.4 秒）。
    if (variantFilter !== 'all') {
      const raw = rawRowsCache.get(`all|${days}`);
      if (raw && now - raw.at < CACHE_TTL_MS) {
        const rows = raw.allRows.filter((r) => r.variant === variantFilter);
        const accts = raw.accountsResult.filter((a) => a.variant === variantFilter);
        const errs = raw.errors.filter((a) => a.variant === variantFilter);
        const payload = buildProjection({
          allRows: rows,
          accountsResult: accts,
          errors: errs,
          rangeStart: raw.rangeStart,
          rangeEnd: raw.rangeEnd,
          collectedAt: raw.collectedAt,
          days,
          variantFilter,
        });
        variantCache.set(memKey, { at: now, payload });
        return { ...payload, cached: true };
      }
    }
    const cached = readCache();
    // 档位与区间必须同时一致才算命中
    if (
      cached &&
      (cached.variantFilter || 'all') === variantFilter &&
      num(cached.days) === days &&
      now - num(cached.collectedAt) < CACHE_TTL_MS
    ) {
      variantCache.set(memKey, { at: now, payload: cached });
      return { ...cached, cached: true };
    }
  }

  const start = new Date();
  start.setDate(start.getDate() - (days - 1));
  const rangeStart = dateStr(start);
  const rangeEnd = dateStr(new Date(now));

  const allRows = [];
  const accountsResult = [];
  const errors = [];
  let collectedAt = 0;

  await Promise.all(accounts.map(async (account) => {
    const variant = variantOf(account);
    const base = {
      accountId: account.id,
      accountName: accountDisplayName(account),
      variant: variant.id,
      variantLabel: variant.label,
    };
    try {
      const rows = await fetchAccountUsage(account, days);
      collectedAt = Math.max(collectedAt, now);
      allRows.push(...rows.map((r) => ({ ...r, ...base })));

      // 余额单独查：失败不影响用量统计（降级为余额未知）
      let balance = null;
      let balanceError = null;
      try {
        const b = await fetchBalance(account);
        balance = { ...b, updatedAt: now };
        await recordSnapshot(account, b.total, b.remaining);
      } catch (err) {
        balanceError = err?.message || '余额查询失败';
      }

      const credit = rows.reduce((s, r) => s + r.credit, 0);
      accountsResult.push({
        ...base,
        requests: rows.length,
        credit,
        balance,
        balanceError,
        error: null,
      });
    } catch (err) {
      accountsResult.push({
        ...base,
        requests: 0,
        credit: 0,
        balance: null,
        balanceError: null,
        error: err?.message || '查询失败',
        unauthorized: !!err?.unauthorized,
      });
      errors.push({ ...base, error: err?.message || '查询失败' });
    }
  }));

  const payload = buildProjection({
    allRows,
    accountsResult,
    errors,
    rangeStart,
    rangeEnd,
    collectedAt: now,
    days,
    variantFilter,
  });

  // 全量明细留在内存里：切「国内版/国际版」时直接过滤重算，不再打官方接口
  if (variantFilter === 'all') {
    rawRowsCache.set(`all|${days}`, {
      at: Date.now(),
      allRows,
      accountsResult,
      errors,
      rangeStart,
      rangeEnd,
      collectedAt: now,
    });
  }

  // 记住本档位结果：再切回来直接命中，不用重算
  variantCache.set(`${variantFilter}|${days}`, { at: Date.now(), payload });

  // 只有真的取到数据才覆盖缓存，避免一次网络抖动把好缓存冲掉
  if (collectedAt) {
    try {
      await atomicWriteJsonAsync(OFFICIAL_USAGE_CACHE_FILE, { payload });
    } catch {
      /* 缓存写失败不影响本次返回 */
    }
  }
  return { ...payload, cached: false };
}

/** 把逐请求明细投影成界面需要的聚合结构（离线缓存与在线结果共用这一份口径） */
function buildProjection({ allRows, accountsResult, errors, rangeStart, rangeEnd, collectedAt, days, variantFilter = 'all' }) {
  const dailyMap = new Map();
  const modelMap = new Map();
  const accountMap = new Map();

  for (const r of allRows) {
    // daily
    let d = dailyMap.get(r.date);
    if (!d) d = { date: r.date, credit: 0, requests: 0, models: new Map() };
    d.credit += r.credit;
    d.requests += 1;
    d.models.set(r.model, (d.models.get(r.model) || 0) + r.credit);
    dailyMap.set(r.date, d);

    // byModel
    let m = modelMap.get(r.model);
    if (!m) m = { model: r.model, credit: 0, requests: 0 };
    m.credit += r.credit;
    m.requests += 1;
    modelMap.set(r.model, m);

    // byAccount
    let a = accountMap.get(r.accountId);
    if (!a) a = { accountId: r.accountId, accountName: r.accountName, credit: 0, requests: 0 };
    a.credit += r.credit;
    a.requests += 1;
    accountMap.set(r.accountId, a);
  }

  const today = dateStr(new Date());
  const totalCredit = allRows.reduce((s, r) => s + r.credit, 0);

  const daily = [...dailyMap.values()]
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((d) => ({
      date: d.date,
      credit: d.credit,
      requests: d.requests,
      byModel: Object.fromEntries([...d.models.entries()].sort((x, y) => y[1] - x[1])),
    }));

  const models = [...modelMap.values()].sort((a, b) => b.credit - a.credit);

  // 按档位分流：全部视图下给出国内版/国际版各自的消耗，方便"归类看"
  const variantMap = new Map();
  for (const r of allRows) {
    const v = r.variant || 'cn';
    let x = variantMap.get(v);
    if (!x) x = { variant: v, credit: 0, requests: 0 };
    x.credit += r.credit;
    x.requests += 1;
    variantMap.set(v, x);
  }
  const variantTotals = [...variantMap.values()].sort((a, b) => b.credit - a.credit);

  // 明细按消耗降序截断，控制缓存体积与前端渲染压力
  const requests = [...allRows].sort((a, b) => b.credit - a.credit).slice(0, DETAIL_LIMIT);

  return {
    schema: CACHE_SCHEMA,
    variantFilter,
    status: errors.length && !allRows.length ? 'error' : errors.length ? 'partial' : 'complete',
    collectedAt,
    rangeStart,
    rangeEnd,
    days,
    detailLimitPerAccount: DETAIL_LIMIT,
    summary: {
      usageToday: daily.find((d) => d.date === today)?.credit ?? 0,
      usage7Days: daily.slice(-7).reduce((s, d) => s + d.credit, 0),
      usageThisMonth: totalCredit,
      totalRequests: allRows.length,
    },
    accounts: accountsResult,
    daily,
    models,
    variantTotals,
    requests,
    errors,
  };
}

/**
 * 离线兜底：官方接口不可用时，用本地快照推导"观察到的消耗"。
 *
 * WorkBuddy 只返回当前余额，没有历史账单，因此这里用**相邻快照的正向下降量**
 * 推导消耗；首次快照和余额上升只建立基线，不产生负数消耗。
 */
export function getOfflineCreditProjection({ days = 30 } = {}) {
  const now = Date.now();
  const cutoff = now - days * 24 * 3600 * 1000;
  const snapshots = loadSnapshots()
    .filter((s) => num(s?.ts) >= cutoff && s?.accountId)
    .sort((a, b) => a.ts - b.ts);

  const perAccount = new Map();
  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1];
    const cur = snapshots[i];
    if (prev.accountId !== cur.accountId) continue;
    const delta = num(prev.remaining) - num(cur.remaining);
    if (delta <= 0) continue; // 余额没降或上升（充值/赠送）→ 不算消耗
    let acc = perAccount.get(cur.accountId);
    if (!acc) {
      acc = {
        accountId: cur.accountId,
        accountName: cur.accountName,
        variant: cur.variant || 'cn',
        consumed: 0,
        events: 0,
        lastRemaining: num(cur.remaining),
        total: num(cur.total),
      };
      perAccount.set(cur.accountId, acc);
    }
    acc.consumed += delta;
    acc.events += 1;
    acc.lastRemaining = num(cur.remaining);
    acc.total = num(cur.total);
  }

  const accounts = [...perAccount.values()];
  return {
    offline: true,
    generatedAt: now,
    days,
    accounts,
    totalConsumed: accounts.reduce((s, a) => s + a.consumed, 0),
    snapshotCount: snapshots.length,
  };
}