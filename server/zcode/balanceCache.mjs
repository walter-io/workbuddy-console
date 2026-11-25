/**
 * ZCode 免费套餐额度缓存：读官方余额接口 + 落盘缓存。
 * 只存数字与套餐名；token / 邮箱 / 设备号一律不写盘、不回显。
 */
import fs from 'node:fs';
import path from 'node:path';
import { giftBalance, currentAccount } from './gift.mjs';
import { CONFIG_DIR, durableWriteText } from '../store/config.mjs';

const CACHE_FILE = path.join(CONFIG_DIR, 'zcode-balance-cache.json');
const MEMORY_TTL_MS = 30_000;

/** 401/403 的统一提示：凭据要客户端自己跑一次对话才会刷新。 */
const CREDENTIAL_HINT = 'ZCode 登录凭据需要刷新：打开 ZCode 客户端跑一次任意对话后再点刷新';

/** 内存里最近一次成功结果：{ userId, result, at }，force 时跳过它。 */
let memory = null;

/** 读整份额度缓存；文件不存在或内容损坏都当空缓存。 */
export function readBalanceCache() {
  try {
    const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return cache && typeof cache === 'object' && !Array.isArray(cache) ? cache : {};
  } catch {
    return {};
  }
}

/** 取该 userId 上一次落盘的结果（没有就 null）。 */
function cachedEntryFor(userId) {
  if (!userId) return null;
  const hit = readBalanceCache()[userId];
  return hit && typeof hit === 'object' && !Array.isArray(hit) ? hit : null;
}

/** 把底层错误压成中文原因；401/403 用统一提示。 */
function friendlyError(e) {
  const status = e?.status ?? e?.response?.status;
  const msg = String(e?.message || e || '').trim();
  if (status === 401 || status === 403 || /(^|\D)40[13](\D|$)/.test(msg)) return CREDENTIAL_HINT;
  if (/未登录|没有登录|请先.*登录/.test(msg)) return 'ZCode 未登录：请先打开 ZCode 客户端登录后再刷新';
  if (/过期|expired/i.test(msg)) return CREDENTIAL_HINT;
  if (/凭据|主密钥|keyring/i.test(msg)) return '读不到 ZCode 登录凭据：请确认 ZCode 客户端已登录且本机凭据可读取';
  if (/fetch failed|network|ENOTFOUND|ECONNRESET|ETIMEDOUT|timeout/i.test(msg)) return '读取 ZCode 额度失败：网络连接异常，请稍后重试';
  return msg ? '读取 ZCode 额度失败：' + msg : '读取 ZCode 额度失败：未知原因';
}

/**
 * 读 ZCode 免费套餐额度。
 * 成功：写缓存并返回 { ok: true, userId, plans, balances, serverTime, at, cached: false }；
 * 失败：不抛异常，返回 { ok: false, error, userId, cached: <上次落盘结果或 null> }。
 */
export async function getZcodeBalance({ force = false } = {}) {
  // 账号信息只是本地读取（不碰官方接口）；读不到也算取额度，只是没有 userId。
  let userId = null;
  try {
    const account = await currentAccount();
    userId = account?.userId || null;
  } catch {
    /* 没登录时下面会给出中文原因 */
  }

  // 30 秒内复用上次成功结果，避免狂点刷新把官方接口打爆。
  if (!force && memory && Date.now() - memory.at < MEMORY_TTL_MS && (!userId || memory.userId === userId)) {
    return { ...memory.result, cached: true };
  }

  try {
    const { plans, balances, serverTime } = await giftBalance({ force });
    const at = Date.now();
    const result = { ok: true, userId, plans, balances, serverTime, at, cached: false };

    // 缓存只放数字和套餐名，绝不放 token / 邮箱 / 设备号；写盘失败不影响本次结果。
    try {
      const cache = readBalanceCache();
      cache[userId || 'unknown'] = { plans, balances, serverTime, at };
      durableWriteText(CACHE_FILE, JSON.stringify(cache, null, 2));
    } catch {
      /* 缓存写不进去时，本次结果仍然可用 */
    }

    memory = { userId, result, at };
    return result;
  } catch (e) {
    const cacheOwner = userId || memory?.userId || null;
    return { ok: false, error: friendlyError(e), userId, cached: cachedEntryFor(cacheOwner) };
  }
}
