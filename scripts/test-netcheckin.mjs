/**
 * 「全网签到」回归测试（离线，不联网、不碰真实平台与真实登录态）。
 *
 * 守几条容易写错、写错了就会**每天重复请求或静默漏领**的判据：
 *
 * 1. 注册表完整性：内置平台 id 唯一；客户端平台必须有 exe 候选与调试端口，
 *    网页平台必须有官网/登录页与关键词；注意事项非空——新增平台漏字段在启动前暴露。
 * 2. 配置合并：用户开关逐字段覆盖默认值；custom 平台可登记；撞内置 id 的
 *    custom 被忽略（改内置平台行为请走 platforms.<id> 覆盖）。
 * 3. 每日随机延迟：同一天内恒定（每分钟 tick 不漂移）、隔天不同、上限不超过
 *    jitterMinutes、jitterMinutes=0 时准点跑。
 * 4. 补跑过滤：今天已领过 / 客户端未安装 / 登录失效（且未重新登录）的平台不进
 *    自动队列；重新登录成功后自动恢复接手；检测记录不算数。
 *
 * 隔离：`FREE_TOKEN_CONFIG_DIR` 在 **import 之前**设到临时目录，全程不联网。
 *
 * 运行：node scripts/test-netcheckin.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-netcheckin-'));
process.env.FREE_TOKEN_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.FREE_TOKEN_CONFIG_DIR, { recursive: true });

const { BUILTIN_PLATFORMS, normalizePlatform } = await import('../server/netcheckin/registry.mjs');
const { resolvePlatforms, loadConfig, saveConfig, appendResult, todayStr } = await import('../server/netcheckin/store.mjs');
const { dailyJitterMs, nextWindowAt } = await import('../server/netcheckin/scheduler.mjs');
const { pendingForAuto } = await import('../server/netcheckin/runner.mjs');
const { markLoginOk } = await import('../server/netcheckin/login.mjs');

let pass = 0;
let fail = 0;
const failures = [];
const check = (name, cond, extra = '') => {
  if (cond) pass++;
  else {
    fail++;
    failures.push(name + (extra ? ` (${extra})` : ''));
  }
};

/* ---------------- 1. 注册表完整性 ---------------- */

const ids = BUILTIN_PLATFORMS.map((p) => p.id);
check('内置平台 ≥ 12 个', BUILTIN_PLATFORMS.length >= 12, String(BUILTIN_PLATFORMS.length));
check('平台 id 唯一', new Set(ids).size === ids.length);

for (const p of BUILTIN_PLATFORMS) {
  const n = normalizePlatform(p);
  check(`[${p.id}] kind 合法`, n.kind === 'web' || n.kind === 'client');
  check(`[${p.id}] 名称非空`, !!n.name);
  check(`[${p.id}] 注意事项非空`, !!n.notes);
  check(`[${p.id}] 有关键词与完成词`, Array.isArray(n.keywords) && n.keywords.length > 0 && Array.isArray(n.doneKeywords));
  check(`[${p.id}] 有类别标签`, ['chat', 'code', 'video', 'art'].includes(n.category));
  if (n.kind === 'client') {
    check(`[${p.id}] 客户端有 exe 候选`, Array.isArray(n.appCandidates) && n.appCandidates.length > 0);
    check(`[${p.id}] 客户端有调试端口`, Number(n.port) > 0);
  } else {
    check(`[${p.id}] 网页平台有官网地址`, /^https:\/\//.test(n.homepage || ''));
  }
}

/* ---------------- 2. 配置合并与自定义平台 ---------------- */

// 默认状态：与注册表的 defaultEnabled 一致（智谱清言默认开，其余默认关）
const defaults = resolvePlatforms(loadConfig());
check(
  '默认状态与注册表 defaultEnabled 一致',
  defaults.every((p) => p.enabled === BUILTIN_PLATFORMS.find((b) => b.id === p.id)?.defaultEnabled),
);

// 用户开关覆盖：只写 enabled 不丢其他字段；只写关键词不碰开关
saveConfig({ platforms: { doubao: { enabled: true }, zhipu: { keywords: ['我的关键词'] } } });
const merged = resolvePlatforms(loadConfig());
check('用户可启用内置平台', merged.find((p) => p.id === 'doubao')?.enabled === true);
check('字段覆盖不影响开关', merged.find((p) => p.id === 'zhipu')?.enabled === true);
check('关键词逐字段覆盖生效', merged.find((p) => p.id === 'zhipu')?.keywords?.includes('我的关键词') === true);

// custom 平台：可登记；撞内置 id 的被忽略
saveConfig({
  platforms: {},
  custom: [
    { id: 'mysite', name: '我的站', url: 'https://example.com', keywords: ['签到'] },
    { id: 'zhipu', name: '假冒智谱', url: 'https://fake.example' },
  ],
});
const withCustom = resolvePlatforms(loadConfig());
check('custom 平台可登记', withCustom.some((p) => p.id === 'mysite'));
check('撞内置 id 的 custom 被忽略', withCustom.filter((p) => p.id === 'zhipu').length === 1);

/* ---------------- 3. 每日随机延迟 ---------------- */

const cfg = { schedule: { time: '10:00', jitterMinutes: 25 } };
const day1 = new Date('2026-11-03T02:00:00');
const day1Late = new Date('2026-11-03T23:00:00');
const day2 = new Date('2026-11-04T02:00:00');

check('同一天两次计算一致（tick 不漂移）', dailyJitterMs(cfg, day1) === dailyJitterMs(cfg, day1));
check('同一天早晚时刻一致', dailyJitterMs(cfg, day1) === dailyJitterMs(cfg, day1Late));
check('隔天延迟不同', dailyJitterMs(cfg, day1) !== dailyJitterMs(cfg, day2));
check('延迟不超过上限 25 分钟', dailyJitterMs(cfg, day1) <= 25 * 60_000 && dailyJitterMs(cfg, day2) <= 25 * 60_000);
check('jitterMinutes=0 时准点', dailyJitterMs({ schedule: { time: '10:00', jitterMinutes: 0 } }, day1) === 0);

// nextWindowAt 含延迟：窗口必须落在设定时间与设定时间+上限之间（以窗口所在日为准）
const w = nextWindowAt();
if (w) {
  const wd = new Date(w);
  const base = new Date(wd);
  base.setHours(10, 0, 0, 0);
  check('下次窗口含随机延迟且不越界', w - base.getTime() >= 0 && w - base.getTime() <= 25 * 60_000, `${Math.round((w - base.getTime()) / 60000)} 分钟`);
} else {
  check('nextWindowAt 返回了窗口', false, 'schedule 默认应为启用');
}

/* ---------------- 4. 补跑过滤（自动队列） ---------------- */

// 准备四个平台今天的记录：已领 / 登录失效 / 未安装 / 失败
const list = [
  { id: 'pa', kind: 'web' },
  { id: 'pb', kind: 'web' },
  { id: 'pc', kind: 'web' },
  { id: 'pd', kind: 'web' },
];
const rec = (id, status, hoursAgo) =>
  appendResult({ id, name: id, date: todayStr(), ts: Date.now() - hoursAgo * 3600_000, status, dryRun: false, shot: null });
rec('pa', 'success', 1);
rec('pb', 'needs_login', 2);
rec('pc', 'not_installed', 3);
rec('pd', 'failed', 4);

const pending = pendingForAuto(list);
check('今天已领过的平台跳过', !pending.some((p) => p.id === 'pa'));
check('登录失效且未重新登录的平台跳过', !pending.some((p) => p.id === 'pb'));
check('客户端未安装的平台跳过', !pending.some((p) => p.id === 'pc'));
check('失败的平台保留重试', pending.some((p) => p.id === 'pd'));

// 检测记录不算数：pd 加一条 dryRun 的 success，仍应重试
appendResult({ id: 'pd', name: 'pd', date: todayStr(), ts: Date.now(), status: 'success', dryRun: true, shot: null });
check('检测记录不影响幂等判定', pendingForAuto(list).some((p) => p.id === 'pd'));

// 重新登录成功后，登录失效的平台自动恢复接手
markLoginOk('pb');
check('重新登录后恢复接手', pendingForAuto(list).some((p) => p.id === 'pb'));

/* ---------------- 汇总 ---------------- */

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
