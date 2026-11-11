/**
 * 账号包：把 WorkBuddy 账号迁移到另一台机器的控制台。
 *
 * 包格式：tar.gz，内含（路径固定，导入按名读取）：
 * - account-pack.json   数据本体：{ version, exportedAt, accounts, config?, logins?, meta }
 * - README.txt          人读的说明（含导入步骤与 refresh_token 轮换警告）
 *
 * 数据来源与去向：
 * - accounts：~/.wb-switch/accounts.json（凭据本体，必含）
 * - config：~/.free-token/config.json（控制台设置，可选导出；导入时只合并 settings/checkin 相关字段）
 * - logins：~/.free-token/checkin/config.json 的 logins 记账（可选，含在 config.checkin 内）
 *
 * ⚠️ refresh_token 是轮换式：新机器刷新一次后旧机器那份立即作废——包里 README 写明。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import * as tar from 'tar';
import { CONFIG_FILE } from '../store/config.mjs';
import { CHECKIN_DIR, CONFIG_FILE as CHECKIN_CONFIG_FILE } from '../netcheckin/store.mjs';
import { STORE_DIR, ACCOUNTS_FILE } from './accounts.mjs';

export const PACK_VERSION = 1;

function packMeta() {
  return {
    version: PACK_VERSION,
    tool: 'workbuddy-console',
    exportedAt: new Date().toISOString(),
    host: os.hostname(),
  };
}

/** 读 JSON（缺失/损坏返回 null，不打断导出） */
function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 导出账号包：返回 { file, accounts, withConfig }。file 是生成的 tar.gz 绝对路径 */
export async function exportAccountPack({ includeConfig = true } = {}) {
  const accounts = readJsonSafe(ACCOUNTS_FILE);
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error('账号库是空的（~/.wb-switch/accounts.json），没有可导出的账号');
  }

  const data = {
    ...packMeta(),
    accounts,
    config: null,
  };

  if (includeConfig) {
    const cfg = readJsonSafe(CONFIG_FILE);
    if (cfg) {
      // 控制台设置整体带走，但剔除本机运行状态类字段（activeKeys 活跃指向、统计缓存等
      // 到新机器上重新生成才有意义；keys 里的 API Key 是用户自己的，随包走）
      const { activeKeys: _ak, activeKeyId: _aki, ...rest } = cfg;
      data.config = rest;
    }
    const checkinCfg = readJsonSafe(CHECKIN_CONFIG_FILE);
    if (checkinCfg) {
      // 签到设置与登录记账：平台开关/定时/logins 记账迁过去，custom 平台也带上
      data.checkin = {
        schedule: checkinCfg.schedule || null,
        platforms: checkinCfg.platforms || {},
        logins: checkinCfg.logins || {},
        custom: checkinCfg.custom || [],
        cookieSigs: checkinCfg.cookieSigs || {},
        balances: checkinCfg.balances || {},
      };
    }
  }

  const outDir = path.join(os.tmpdir(), 'wb-account-pack');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const file = path.join(outDir, `wb-account-pack-${stamp}.tar.gz`);

  const readme = [
    'WorkBuddy 控制台账号包',
    `导出时间：${data.exportedAt}（来自 ${data.host}）`,
    `账号数：${accounts.length}${data.config ? '（含控制台设置与签到配置）' : '（仅账号凭据）'}`,
    '',
    '导入方法：在目标机器的控制台「设置 → 账号迁移」点「导入账号包」选择本文件。',
    '',
    '⚠️ 重要：refresh_token 是轮换式的——目标机器刷新过一次后，源机器上的同账号凭据立即作废。',
    '   导入并验证成功后，请停用源机器控制台的自动任务（自动签到 / 凭据巡检），避免两边抢刷新互相踢掉登录。',
    '',
    '导入后：在目标机器的「WorkBuddy 管理」里切换一次账号，凭据即写入该机器的 WorkBuddy 登录态文件。',
  ].join('\n');

  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-pack-'));
  const tmpJson = path.join(stageDir, 'account-pack.json');
  const tmpReadme = path.join(stageDir, 'README.txt');
  fs.writeFileSync(tmpJson, JSON.stringify(data, null, 2), 'utf8');
  fs.writeFileSync(tmpReadme, readme, 'utf8');
  try {
    // tar v7 用 `gzip`（v6 的 `gz` 简写在 v7 被静默忽略——包会变成裸 tar，扩展名骗人，
    // 2026-11-09 实测踩到）。写全名，v6/v7 都认。
    await tar.c(
      { gzip: true, file, cwd: stageDir, portable: true },
      ['account-pack.json', 'README.txt']
    );
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
  return { file, count: accounts.length, withConfig: !!data.config, bytes: fs.statSync(file).size };
}

/** 校验包结构：返回解析后的数据或抛出带人话的错误 */
async function readPack(file) {
  const names = [];
  try {
    await tar.list({ f: file, onentry: (e) => names.push(e.path) });
  } catch (e) {
    throw new Error(`不是有效的账号包（tar.gz 解析失败：${String(e?.message || e).split('\n')[0]}）`);
  }
  if (!names.some((n) => n.endsWith('account-pack.json'))) {
    throw new Error('包里没有 account-pack.json——这不是本工具导出的账号包');
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-import-'));
  try {
    await tar.x({ f: file, cwd: tmpDir });
    const dataPath = path.join(tmpDir, 'account-pack.json');
    const data = readJsonSafe(dataPath);
    if (!data || !Array.isArray(data.accounts)) throw new Error('包内数据损坏（account-pack.json 解析失败）');
    if (data.tool !== 'workbuddy-console') throw new Error('包不是由 workbuddy 控制台导出的');
    return data;
  } finally {
    fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => null);
  }
}

/**
 * 导入账号包：按 id 合并进账号库（同 id 以包里的为准——迁移语义是「以导出时的最新凭据为准」），
 * 返回 { added, updated, skipped }。
 * mode: 'merge'（默认，保留本机已有且包里没有的账号）| 'replace'（整库替换，慎用）
 */
export async function importAccountPack(file, { mode = 'merge', applyConfig = true } = {}) {
  const data = await readPack(file);
  const incoming = data.accounts.filter((a) => a && a.id);
  if (!incoming.length) throw new Error('包里没有任何账号');

  // 账号库合并
  const { loadAccounts, saveAccounts } = await import('./accounts.mjs');
  const local = loadAccounts();
  const byId = new Map(local.map((a) => [a.id, a]));
  let added = 0;
  let updated = 0;
  for (const a of incoming) {
    if (byId.has(a.id)) {
      byId.set(a.id, { ...byId.get(a.id), ...a });
      updated++;
    } else {
      byId.set(a.id, a);
      added++;
    }
  }
  const merged = mode === 'replace' ? incoming : [...byId.values()];
  const { saveAccountsAsync } = await import('./accounts.mjs');
  await saveAccountsAsync(merged);

  // 控制台设置：只填本机缺失的键（merge 语义），不覆盖用户在本机已经调过的值；
  // replace 模式也不动 settings——那里面是本机路径相关配置，覆盖了反而坏事
  let configApplied = false;
  if (applyConfig && data.config && mode === 'merge') {
    const cfg = readJsonSafe(CONFIG_FILE) || {};
    for (const key of ['keys', 'proxy', 'checkin', 'stats', 'guidesShown']) {
      const v = data.config[key];
      if (v !== undefined && cfg[key] === undefined) cfg[key] = v;
    }
    await fsp.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
    configApplied = true;
  }

  // 签到配置（合并语义）：平台开关/定时/logins 记账/cookie 签名/余额
  let checkinApplied = false;
  if (applyConfig && data.checkin && (mode === 'merge' || mode === 'replace')) {
    const c = readJsonSafe(CHECKIN_CONFIG_FILE) || { version: 1 };
    c.schedule = data.checkin.schedule || c.schedule;
    c.platforms = { ...(c.platforms || {}), ...(data.checkin.platforms || {}) };
    c.logins = { ...(c.logins || {}), ...(data.checkin.logins || {}) };
    if (Array.isArray(data.checkin.custom) && data.checkin.custom.length) {
      const have = new Set((c.custom || []).map((x) => x.id));
      c.custom = [...(c.custom || []), ...data.checkin.custom.filter((x) => x && x.id && !have.has(x.id))];
    }
    c.cookieSigs = { ...(c.cookieSigs || {}), ...(data.checkin.cookieSigs || {}) };
    c.balances = { ...(c.balances || {}), ...(data.checkin.balances || {}) };
    await fsp.mkdir(CHECKIN_DIR, { recursive: true });
    await fsp.writeFile(CHECKIN_CONFIG_FILE, JSON.stringify(c, null, 2), 'utf8');
    checkinApplied = true;
  }

  return { added, updated, total: merged.length, exportedAt: data.exportedAt, configApplied, checkinApplied };
}
