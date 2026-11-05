/**
 * 「全网签到」的数据落盘。
 *
 * 全部数据放在控制台自己的配置目录下（~/.free-token/checkin/）：
 * - config.json   用户设置：各平台开关、自动代领时间、自定义平台
 * - results.jsonl 每次运行的结果流水（一行一条，只追加）
 * - shots/        每次运行的页面截图（按日期分目录，失败排查的唯一一手现场）
 * - profile/      Playwright 持久化浏览器 profile —— 里面是各平台网页的登录态，
 *                  等价于账号凭据，整个目录都不该外传
 *
 * 写盘一律走 store/config.mjs 的原子写（本机存在外部进程间歇锁文件的现象，
 * 裸 writeFileSync 会随机炸掉，这是整个控制台踩过的坑）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, atomicWriteJson, atomicWriteJsonAsync } from '../store/config.mjs';
import { BUILTIN_PLATFORMS, BUILTIN_IDS, normalizePlatform, resolveClientExe } from './registry.mjs';

export const CHECKIN_DIR = path.join(CONFIG_DIR, 'checkin');
export const CONFIG_FILE = path.join(CHECKIN_DIR, 'config.json');
export const RESULTS_FILE = path.join(CHECKIN_DIR, 'results.jsonl');
export const SHOTS_DIR = path.join(CHECKIN_DIR, 'shots');
export const PROFILE_DIR = path.join(CHECKIN_DIR, 'profile');

/** 结果流水与截图的保留上限 */
const RESULT_KEEP = 2000;
const SHOT_KEEP_DAYS = 7;

export function ensureDirs() {
  fs.mkdirSync(CHECKIN_DIR, { recursive: true });
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
}

const DEFAULT_SCHEDULE = {
  enabled: true, // 自动代领默认开启：控制台本来就是常驻的，不开等于白装
  time: '10:00', // 每天主跑时间
  jitterMinutes: 25, // 0~N 分钟随机延迟：每天同一秒打站点是最容易被风控识别的行为
};

const DEFAULT_CONFIG = {
  version: 1,
  schedule: { ...DEFAULT_SCHEDULE },
  /** 平台开关：id -> enabled。没出现的平台按注册表里的 defaultEnabled 处理 */
  platforms: {},
  /** 各网页平台最近一次登录成功的时间戳（id -> ms）：重启后登录状态记账不丢 */
  logins: {},
  /** 自定义网页平台（kind: web），字段见 registry.mjs 的 normalizePlatform */
  custom: [],
};

/** 读用户设置（文件不存在/损坏时返回默认值，不自动落盘——落盘在首次修改时发生） */
export function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return {
      ...structuredClone(DEFAULT_CONFIG),
      ...raw,
      schedule: { ...DEFAULT_SCHEDULE, ...(raw.schedule || {}) },
      platforms: raw.platforms || {},
      logins: raw.logins || {},
      custom: Array.isArray(raw.custom) ? raw.custom : [],
    };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function saveConfig(cfg) {
  ensureDirs();
  atomicWriteJson(CONFIG_FILE, cfg);
}

/** 异步版：HTTP 请求链路上用，EPERM 锁窗期间不冻结整个服务 */
export async function saveConfigAsync(cfg) {
  ensureDirs();
  await atomicWriteJsonAsync(CONFIG_FILE, cfg);
}

/**
 * 合并出「实际生效」的平台清单：注册表默认值 + 用户覆盖 + 自定义平台。
 * 覆盖是逐字段的，用户只写 enabled 也不会丢掉默认的 keywords/入口。
 */
export function resolvePlatforms(cfg = loadConfig(), { only = [], includeDisabled = true } = {}) {
  const userPlatforms = cfg.platforms || {};
  const list = [];

  for (const def of BUILTIN_PLATFORMS) {
    const merged = normalizePlatform({ ...def, ...(userPlatforms[def.id] || {}) });
    merged.enabled = userPlatforms[def.id]?.enabled ?? def.defaultEnabled;
    list.push(merged);
  }

  // 自定义平台：id 撞了内置平台就忽略（改内置平台行为请用 platforms.<id> 覆盖）
  for (const raw of cfg.custom || []) {
    if (!raw || !raw.id || BUILTIN_IDS.has(raw.id)) continue;
    if (!raw.url && !raw.homepage) continue;
    const merged = normalizePlatform({ kind: 'web', ...raw });
    merged.enabled = raw.enabled ?? userPlatforms[raw.id]?.enabled ?? false;
    list.push(merged);
  }

  return list.filter((p) => (includeDisabled ? true : p.enabled)).filter((p) => (only.length ? only.includes(p.id) : true));
}

/** 某平台解析出的客户端可执行文件（kind=client 专用） */
export function clientExeOf(platform) {
  return resolveClientExe(platform);
}

/* ---------------- 结果流水 ---------------- */

/** 本地日期 YYYY-MM-DD（用本机时区，避免 UTC 把深夜算成第二天） */
export function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 读取全部结果（最早在前）。行损坏直接跳过——jsonl 允许半行存在 */
export function readResults() {
  try {
    const text = fs.readFileSync(RESULTS_FILE, 'utf8');
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* 半行/损坏行忽略 */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** 追加一条结果（正式运行才落盘，检测不入账） */
export function appendResult(record) {
  ensureDirs();
  fs.appendFileSync(RESULTS_FILE, JSON.stringify(record) + '\n', 'utf8');
  pruneResults();
}

/** 流水超限时把最老的整行砍掉（jsonl 重写回 jsonl，保持一行一条的格式） */
function pruneResults() {
  try {
    const stat = fs.statSync(RESULTS_FILE);
    if (stat.size < 512 * 1024) return;
    const rows = readResults();
    if (rows.length <= RESULT_KEEP) return;
    const kept = rows.slice(-RESULT_KEEP).map((r) => JSON.stringify(r)).join('\n') + '\n';
    const tmp = RESULTS_FILE + '.tmp-prune';
    fs.writeFileSync(tmp, kept, 'utf8');
    fs.renameSync(tmp, RESULTS_FILE);
  } catch {
    /* 裁剪失败不影响主流程，下次再试 */
  }
}

/** 删除超过保留期的截图目录 */
export function pruneShots() {
  try {
    const cutoff = Date.now() - SHOT_KEEP_DAYS * 86_400_000;
    for (const name of fs.readdirSync(SHOTS_DIR)) {
      const full = path.join(SHOTS_DIR, name);
      try {
        if (fs.statSync(full).isDirectory() && fs.statSync(full).mtimeMs < cutoff) {
          fs.rmSync(full, { recursive: true, force: true });
        }
      } catch {
        /* 单个目录删不掉不影响其它 */
      }
    }
  } catch {
    /* 目录不存在等情况忽略 */
  }
}

/** 今天的截图目录（runOne 会往里放 <platformId>.png） */
export function shotDirForToday(date = todayStr()) {
  const dir = path.join(SHOTS_DIR, date);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
