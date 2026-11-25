/**
 * ZCode 多账号库与切换。
 *
 * 账号库：CONFIG_DIR（默认 ~/.free-token）/zcode-accounts.json（控制台自维护，与 ZCode 不共享）。
 * 每条账号 = 一份完整的 credentials.json 明文快照（加密存储，key 与账号绑定）：
 *   { id, label, email, userId, provider, addedAt, lastAt, encrypted }
 * encrypted 内含 credentials.json 全部条目（敏感值已用账号独立 key 加密）。
 *
 * 切换 = 把目标账号的快照解密 → 走 credentialStore 写回 ~/.zcode/v2/credentials.json
 * （自动备份原文件），然后提示用户重启 ZCode 客户端生效。
 * ZCode 运行中会把内存里的登录态写回磁盘，切换前必须结束 ZCode 进程（对齐
 * WorkBuddy 账号切换的 stopApp 行为）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readCredentialsDecrypted, writeCredentialsFromMap, sealValue, openValue } from './credentialStore.mjs';
import { CONFIG_DIR } from '../store/config.mjs';

const ACCOUNTS_FILE = path.join(CONFIG_DIR, 'zcode-accounts.json');

/** 账号文件独立加密 key（首用时生成，落盘在账号文件旁边） */
function localKey() {
  const keyFile = ACCOUNTS_FILE + '.key';
  let k;
  if (fs.existsSync(keyFile)) {
    k = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64url');
  } else {
    k = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(ACCOUNTS_FILE), { recursive: true });
    fs.writeFileSync(keyFile, k.toString('base64url'), 'utf8');
  }
  return k;
}

export function loadAccounts() {
  try {
    const j = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    return Array.isArray(j.accounts) ? j.accounts : [];
  } catch {
    return [];
  }
}

function saveAccountsSync(accounts) {
  fs.mkdirSync(path.dirname(ACCOUNTS_FILE), { recursive: true });
  const tmp = ACCOUNTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ accounts }, null, 2), 'utf8');
  fs.renameSync(tmp, ACCOUNTS_FILE);
}

/** 账号文件读-改-写互斥（审查 Z-6）：并发导入/切换会丢更新，API 直调没有 UI busy 挡着 */
let accountsChain = Promise.resolve();
function withAccountsLock(fn) {
  const run = accountsChain.catch(() => {}).then(fn);
  accountsChain = run;
  return run;
}

/** 从一份 credentials.json 提取账号摘要（不落敏感值） */
function summarize(values) {
  let email = '';
  let userId = '';
  let name = '';
  try {
    const ui = JSON.parse(values['oauth:zai_cn:user_info'] || '{}');
    email = ui.email || '';
    name = ui.name || '';
    userId = ui.user_id || '';
  } catch {
    /* user_info 缺失时按空处理 */
  }
  const provider = values['oauth:active_provider'] || 'unknown';
  return { email, name, userId, provider };
}

/** 导入当前登录态为新账号（控制台「导入本机登录态」） */
export async function importCurrentAccount(label) {
  return withAccountsLock(() => importCurrentAccountLocked(label));
}

async function importCurrentAccountLocked(label) {
  const { values } = await readCredentialsDecrypted();
  const sum = summarize(values);
  if (!sum.email && !sum.userId) {
    throw new Error('未读到有效 ZCode 登录态（oauth:zai_cn:user_info 缺失），请先在 ZCode 里登录');
  }
  const accounts = loadAccounts();
  // 同 userId 幂等：重复导入=更新快照
  const found = accounts.find((a) => a.userId === sum.userId);
  const enc = {};
  const key = localKey();
  for (const [k, v] of Object.entries(values)) {
    enc[k] = typeof v === 'string' && v.length ? sealValue(v, key) : v;
  }
  if (found) {
    found.encrypted = enc;
    found.label = label || found.label || sum.email;
    found.lastAt = Date.now();
    saveAccountsSync(accounts);
    return { account: publicAccount(found), updated: true };
  }
  const acc = {
    id: 'zacc-' + crypto.randomBytes(8).toString('hex'),
    label: label || sum.email || sum.name || sum.userId,
    ...sum,
    addedAt: Date.now(),
    lastAt: Date.now(),
    encrypted: enc,
  };
  accounts.push(acc);
  saveAccountsSync(accounts);
  return { account: publicAccount(acc), updated: false };
}

/** 账号公开展示形态（剥掉加密快照） */
export function publicAccount(a) {
  const { encrypted, ...rest } = a;
  return rest;
}

/** 读当前 ~/.zcode 里的登录态摘要（detectCurrentAccount 对齐 WorkBuddy 语义） */
export async function detectCurrentAccount() {
  try {
    const { values } = await readCredentialsDecrypted();
    const sum = summarize(values);
    const accounts = loadAccounts();
    const match = accounts.find((a) => a.userId === sum.userId && sum.userId);
    return {
      exists: !!(sum.email || sum.userId),
      email: sum.email,
      name: sum.name,
      userId: sum.userId,
      provider: sum.provider,
      accountId: match ? match.id : null,
      label: match ? match.label : null,
    };
  } catch (e) {
    return { exists: false, error: String(e?.message || e) };
  }
}

/** 切换：写回目标账号快照（内部备份），返回写回结果 */
export async function switchToAccount(id) {
  return withAccountsLock(() => switchToAccountLocked(id));
}

async function switchToAccountLocked(id) {
  const accounts = loadAccounts();
  const target = accounts.find((a) => a.id === id);
  if (!target) throw new Error('账号不存在');
  const key = localKey();
  const plain = {};
  for (const [k, v] of Object.entries(target.encrypted)) {
    plain[k] = typeof v === 'string' && v.length ? openValue(v, key) : v;
  }
  const res = await writeCredentialsFromMap(plain);
  target.lastAt = Date.now();
  saveAccountsSync(accounts);
  return res;
}

/** 删除账号 */
export async function deleteAccount(id) {
  return withAccountsLock(() => deleteAccountLocked(id));
}

async function deleteAccountLocked(id) {
  const accounts = loadAccounts();
  const idx = accounts.findIndex((a) => a.id === id);
  if (idx < 0) throw new Error('账号不存在');
  accounts.splice(idx, 1);
  saveAccountsSync(accounts);
  return { ok: true };
}

/** 重命名账号 */
export async function updateAccountLabel(id, label) {
  return withAccountsLock(() => updateAccountLabelLocked(id, label));
}

async function updateAccountLabelLocked(id, label) {
  const accounts = loadAccounts();
  const target = accounts.find((a) => a.id === id);
  if (!target) throw new Error('账号不存在');
  target.label = String(label || '').trim() || target.label;
  saveAccountsSync(accounts);
  return publicAccount(target);
}

export { ACCOUNTS_FILE };
