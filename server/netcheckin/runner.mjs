/**
 * 全网签到的运行调度。
 *
 * 关键设计（都是防风控和防误报的实战结论）：
 * 1. 2026-11-05 重构：每个平台一个独立浏览器实例 + 独立 profile + 独立锁，
 *    单平台的检测/领取/登录不再阻塞其它平台；批量任务按并发上限（默认 3）
 *    同时开多个实例，任务错峰启动（2~5 秒随机间隔）保留防风控节奏；
 * 2. 断网预检 —— 断网时所有平台都会失败，逐个白等超时毫无意义；
 * 3. 单平台独立超时 —— 一个平台挂住不能拖死整批；
 * 4. 正式运行的结果才入账（results.jsonl），检测只出报告；
 * 5. 执行输出走内存环形缓冲，前端轮询取，不落盘。
 * 6. 单平台手动操作（行上点「领取」「检测」）随时可用：只要那个平台自己的
 *    浏览器空闲就行，跟批量任务、登录窗口互不相干。
 */

import path from 'node:path';
import { lockFor, acquireContext, releaseContext } from './browser.mjs';
import { resolvePlatforms, loadConfig, saveConfigAsync, appendResult, readResults, todayStr, shotDirForToday, pruneShots } from './store.mjs';
import { runGenericWeb, dryRunWeb, runMinimax, runClientCheckin, clientInstalled, comateProbeRun } from './engines.mjs';
import { snapshot, dumpHtml } from './dom.mjs';
import { isClientRunning, clientProbe, MANUAL_PLATFORMS } from './registry.mjs';
import { loginOkSince, markLoginOk } from './login.mjs';

/** 单平台超时上限：客户端冷启动可能很慢（尤其早上刚唤醒的机器） */
const PLATFORM_TIMEOUT_MS = 240_000;

/** 批量任务的浏览器并发上限：同 IP 同时开太多实例也招风控，错峰启动才是主防线 */
const BATCH_CONCURRENCY = 3;

/** 批量任务里相邻两个平台的启动间隔（毫秒）：随机错峰，避免整齐划一的机器特征 */
const STAGGER_MS = () => 2000 + Math.random() * 3000;

/* ---------------- 执行输出（内存环形缓冲） ---------------- */

const LOG_LIMIT = 600;
const logBuffer = [];
let logSeq = 0;

export function pushLog(level, text) {
  logBuffer.push({ seq: ++logSeq, ts: Date.now(), level, text });
  if (logBuffer.length > LOG_LIMIT) logBuffer.splice(0, logBuffer.length - LOG_LIMIT);
}

/** 取 seq 之后的新日志（前端增量拉取）；不传 seq 就取最近 80 条 */
export function tailLogs(sinceSeq = 0) {
  const rows = logBuffer.filter((l) => l.seq > sinceSeq);
  return { logs: rows.slice(-200), lastSeq: logBuffer.length ? logBuffer[logBuffer.length - 1].seq : 0 };
}

/* ---------------- 运行状态 ---------------- */

const runState = {
  running: false, // 批量一轮是否在跑（一键领取 / 一键检测）
  activeIds: new Set(), // 正在执行的平台 id（批量与单平台任务共用；行级按钮按它禁用）
  runId: null, // 本轮运行的 seq 起点，前端只展示这之后的日志
  source: null, // manual | auto
  startedAt: null,
};

/** 最近一轮的结果快照：检测后前端用它做行内回填（正式运行会覆盖） */
const lastTrial = { at: 0, dryRun: false, results: [] };

/** 检测回填的有效期：6 小时后自动消失，避免长期误导 */
const TRIAL_TTL_MS = 6 * 3600_000;

/**
 * 运行代数：每轮开始/结束、每个平台跑完、登录成功都 +1。状态接口用它判断
 * 「缓存是否已过期」——比按时间过期更准确。
 */
export const runEpoch = { value: 0 };

/** 是否有一轮批量任务在跑（给「立即启动」接口做同步忙检测，避免重复启动） */
export function netCheckinBusy() {
  return runState.running;
}

/** logger 适配：runner 内部统一走 pushLog */
function makeLogger() {
  return {
    info: (t) => pushLog('info', t),
    ok: (t) => pushLog('ok', t),
    warn: (t) => pushLog('warn', t),
    error: (t) => pushLog('err', t),
    step: (t) => pushLog('info', `· ${t}`),
  };
}

/** 取异常首行：Playwright 的报错栈可能很长，日志里只留第一行 */
const firstLine = (s) => String(s ?? '').split('\n')[0];

class TimeoutError extends Error {}

function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${label} 等了 ${Math.round(ms / 1000)} 秒仍未完成`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/**
 * 离线预检：断网时所有平台都会失败，先探路。多源探测 + 重试——
 * 早上机器刚唤醒时网络往往还没就绪，单源探测容易误判。
 */
async function isOnline({ attempts = 3, gapMs = 8000 } = {}) {
  const probes = ['https://www.baidu.com', 'https://www.aliyun.com', 'https://www.qq.com'];
  for (let i = 0; i < attempts; i++) {
    for (const url of probes) {
      try {
        const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(6000) });
        if (r.status < 500) return true;
      } catch {
        /* 换下一个源 */
      }
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, gapMs));
  }
  return false;
}

/** 今天某个平台是否已有成功/已领记录（正式运行才算） */
export function doneTodayOf(platformId, date = todayStr()) {
  return readResults().some((r) => r.id === platformId && r.date === date && !r.dryRun && (r.status === 'success' || r.status === 'already'));
}

/** 平台是否有过成功领取的记录（任意日期，正式运行） */
function hasSuccessRecord(platformId) {
  return readResults().some((r) => r.id === platformId && !r.dryRun && (r.status === 'success' || r.status === 'already'));
}

/**
 * 自动运行（含每小时补跑）的待领过滤：
 * - 今天已领过的直接跳过（幂等）；
 * - 「登录失效」「客户端未安装」需要用户亲自处理，每小时反复跑没有意义——
 *   等用户重新登录成功（或装好客户端后手动领取一次）就会解除，自动检查随即恢复接手。
 * 手动点「领取」不受此过滤影响。
 */
export function pendingForAuto(list) {
  const today = todayStr();
  const doneIds = new Set();
  const latestById = new Map();
  for (const r of readResults()) {
    if (r.dryRun || r.date !== today) continue;
    if (r.status === 'success' || r.status === 'already') doneIds.add(r.id);
    const cur = latestById.get(r.id);
    if (!cur || (r.ts || 0) > cur.ts) latestById.set(r.id, { status: r.status, ts: r.ts || 0 });
  }
  return list.filter((p) => {
    if (doneIds.has(p.id)) return false;
    const last = latestById.get(p.id);
    // 历史「未安装」不再永久锁死：装好客户端后实时重探，命中即恢复自动补跑
    if (last?.status === 'not_installed') return p.kind === 'client' && Boolean(clientInstalled(p));
    if (last?.status === 'needs_login' && loginOkSince(p.id) <= last.ts) return false;
    return true;
  });
}

/** 今天是否所有启用平台都已完成（自动代领的幂等门禁） */
export function allDoneToday() {
  const list = resolvePlatforms(loadConfig(), { includeDisabled: false });
  return list.length > 0 && list.every((p) => doneTodayOf(p.id));
}

/** 运行记录里状态用中文展示（前端徽章用同一套词，两边对得上） */
export const STATUS_LABEL = {
  success: '已到账',
  already: '今日已领',
  needs_login: '需登录',
  not_installed: '未安装',
  stale_install: '待重跑',
  needs_manual: '需重启客户端',
  offline: '断网跳过',
  timeout: '超时',
  not_found: '没找到入口',
  uncertain: '结果未确认',
  failed: '失败',
  error: '出错',
  dry_run: '检测通过',
  busy: '浏览器忙',
};

/** 从结果里提取积分数值：meta 优先，detail 文案兜底（各引擎返回格式不一） */
function parsePoints(detail, meta) {
  let credits = null;
  let gain = null;
  if (meta && typeof meta === 'object') {
    if (Number.isFinite(meta.credits)) credits = meta.credits;
    if (Number.isFinite(meta.todayPoints)) gain = meta.todayPoints;
    if (Number.isFinite(meta.todayCredit)) gain = meta.todayCredit;
  }
  const mC = /当前积分 ([\d,]+(?:\.\d+)?)/.exec(detail || '');
  if (mC && credits === null) credits = Number(mC[1].replace(/,/g, ''));
  const mG = /\+(\d[\d,]*(?:\.\d+)?)\s*(?:积分|算力|额度|点)/.exec(detail || '');
  if (mG && gain === null) gain = Number(mG[1].replace(/,/g, ''));
  return { credits, gain };
}

/** 记录转成给前端的行（统一形状，records/recentResults 共用） */
function toRow(rec) {
  const { credits, gain } = parsePoints(rec.detail, rec.meta);
  return {
    id: rec.id,
    name: rec.name || rec.id,
    status: rec.status,
    detail: rec.detail || '',
    ts: rec.ts || 0,
    date: rec.date || '',
    dryRun: Boolean(rec.dryRun),
    credits,
    gain,
  };
}

/**
 * 跑单个平台：按引擎分发 + 超时控制 + 截图留现场。
 * 平台持有自己那把浏览器锁：被占用（登录窗口开着 / 另一任务在跑）时立即返回 busy，
 * 绝不排队——排队就是「点一下检测全页面卡死」的老问题。
 */
async function runOne(platform, { dryRun }) {
  const started = Date.now();
  const shotDir = shotDirForToday();
  const logger = makeLogger();

  try {
    if (platform.engine === 'client-cdp') {
      // 桌面类平台走 CDP 接管客户端，不占共享浏览器资源，直接跑
      const result = await withTimeout(runClientCheckin(platform, { logger, shotDir, dryRun }), PLATFORM_TIMEOUT_MS, platform.name);
      return {
        id: platform.id,
        name: platform.name,
        status: result.status,
        detail: result.detail || '',
        url: result.url || '',
        meta: result.meta || undefined,
        candidates: result.candidates ? result.candidates.length : undefined,
        buttons: result.buttons,
        shot: null,
        durationMs: Date.now() - started,
        dryRun: !!dryRun,
      };
    }

    if (!lockFor(platform.id).tryAcquire()) {
      return {
        id: platform.id,
        name: platform.name,
        status: 'busy',
        detail: '该平台的浏览器被占用（可能在等待登录或另一任务在执行）',
        durationMs: Date.now() - started,
        dryRun: !!dryRun,
      };
    }

    let result;
    let shot = null;
    try {
      const ctx = await acquireContext(platform.id, { headless: !platform.headed, logger, proxy: platform.proxy });
      if (platform.headed) pushLog('info', `${platform.name} 需要可见浏览器窗口，已弹出窗口执行（站点风控要求）`);
      const page = await ctx.newPage();
      let work;
      // MiniMax 有自己的三步导航、Comate 检测走专用探测——其余平台用通用页面体检
      if (dryRun) {
        work =
          platform.engine === 'minimax-web'
            ? runMinimax(page, logger, { dryRun: true })
            : platform.id === 'comate'
              ? comateProbeRun(page, ctx, logger)
              : dryRunWeb(platform, page, logger, ctx);
      } else if (platform.engine === 'minimax-web') work = runMinimax(page, logger, { dryRun });
      else work = runGenericWeb(platform, page, logger, ctx);
      result = await withTimeout(work, PLATFORM_TIMEOUT_MS, platform.name);

      // 余额随跑随记：检测/领取只要报回余额就落盘（balances），状态页随时能显示
      // 最近一次的余额，不必等下一次真实领取。失败不影响主流程。
      const bal = result.meta?.credits;
      if (Number.isFinite(bal)) {
        void (async () => {
          try {
            const c = loadConfig();
            c.balances = { ...(c.balances || {}), [platform.id]: { credits: bal, at: Date.now() } };
            await saveConfigAsync(c);
          } catch {
            /* 余额记账失败不影响主流程 */
          }
        })();
      }

      // 不管结果好坏都截图存档；状态拿不准或失败的额外存一份 HTML，方便离线复盘
      if (!page.isClosed()) {
        shot = await snapshot(page, shotDir, platform.id).catch(() => null);
        if (['not_found', 'error', 'timeout', 'uncertain', 'failed'].includes(result.status)) {
          await dumpHtml(page, shotDir, platform.id).catch(() => null);
        }
      }
    } finally {
      await releaseContext(platform.id).catch(() => null);
      lockFor(platform.id).release();
    }

    return {
      id: platform.id,
      name: platform.name,
      status: result.status,
      detail: result.detail || '',
      url: result.url || '',
      meta: result.meta || undefined,
      candidates: result.candidates ? result.candidates.length : undefined,
      buttons: result.buttons,
      shot: shot || null,
      durationMs: Date.now() - started,
      dryRun: !!dryRun,
    };
  } catch (e) {
    const msg = firstLine(e?.message || e);
    pushLog('err', `${platform.name} 抛出异常：${msg}`);
    return {
      id: platform.id,
      name: platform.name,
      status: e instanceof TimeoutError ? 'timeout' : 'error',
      detail: msg,
      shot: null,
      durationMs: Date.now() - started,
      dryRun: !!dryRun,
    };
  }
}

/**
 * 跑一轮全网签到（支持批量与单平台）。
 * 返回 { ok, busy?, results?, summary?, error? }
 */
export async function runNetCheckin({ only = [], dryRun = false, source = 'manual' } = {}) {
  const single = Array.isArray(only) && only.length === 1;
  if (runState.running) return { ok: false, busy: true, error: '已有一轮批量签到在运行，等它结束再试' };
  if (single && runState.activeIds.has(only[0])) return { ok: false, busy: true, error: '该平台正在执行中，等它结束再试' };

  if (!single) {
    runState.running = true;
    runState.source = source;
    runState.startedAt = Date.now();
  }
  runState.runId = (logBuffer.length ? logBuffer[logBuffer.length - 1].seq : 0) + 1;
  runEpoch.value++;
  const cfg = loadConfig();
  const runStart = Date.now();

  const results = [];
  try {
    // 检测覆盖全部登记的网页类平台（含未启用的——登记新平台后不用先开开关就能体检）；
    // 桌面类不参与：它的「检测」要拉起/重启客户端，不是只读操作。
    // 正式运行只跑已启用的（含桌面类）。单平台操作按 id 精确点名。
    let list = resolvePlatforms(cfg, { includeDisabled: Boolean(dryRun) || single, only });
    if (dryRun && !single) list = list.filter((p) => p.kind === 'web');
    pushLog('info', `${single ? '单独执行' : '开始执行'}（${list.map((p) => p.name).join('、') || '无平台'}${dryRun ? '，检测' : ''}）`);
    if (!list.length) {
      pushLog('warn', dryRun ? '清单里没有任何网页类平台' : '没有可执行的平台：在清单上打开开关，或检查配置文件');
      return { ok: true, results, summary: emptySummary() };
    }

    // 幂等 + 「等你处理」过滤：批量正式运行时跳过已领过的与需要用户处理的平台；
    // 单平台手动操作是用户点名要跑的，不过滤
    const pending = dryRun || single ? list : pendingForAuto(list);
    const doneCount = list.filter((p) => doneTodayOf(p.id)).length;
    const waitingUser = list.length - doneCount - pending.length;
    if (doneCount > 0 && !single) pushLog('info', `${doneCount} 个平台今天已领过，跳过`);
    if (waitingUser > 0 && !single) pushLog('info', `${waitingUser} 个平台在等你处理（重新登录 / 安装客户端），本轮先跳过`);
    if (!pending.length) {
      pushLog('ok', '没有需要本轮执行的平台');
      return { ok: true, results, summary: emptySummary() };
    }

    // 断网预检（检测同样要走网络，一样预检）
    if (!(await isOnline())) {
      pushLog('warn', '当前网络不可用，本轮全部跳过（恢复联网后再执行一次即可）');
      for (const p of pending) {
        const rec = makeRecord(p, { status: 'offline', detail: '网络不可用，已跳过', durationMs: 0, dryRun, source });
        results.push(rec);
        if (!dryRun) appendResult(rec);
      }
      return { ok: true, results, summary: summarize(results) };
    }

    // 并行执行：并发上限 BATCH_CONCURRENCY。每个平台拿自己的浏览器锁，busy 的
    // 平台直接记「浏览器忙」跳过，不影响其它平台。
    // 错峰启动：第 i 个任务不早于 runStart + i * 3.5s 开工（随机抖动），保留防风控节奏。
    const queue = pending.map((p, i) => ({
      platform: p,
      notBefore: i === 0 ? 0 : runStart + i * 3500 + Math.round(Math.random() * 1500),
    }));

    async function worker() {
      for (;;) {
        const item = queue.shift();
        if (!item) return;
        const p = item.platform;
        const wait = item.notBefore - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        runState.activeIds.add(p.id);
        try {
          const rec = await runOne(p, { dryRun });
          rec.source = source;
          rec.date = todayStr();
          rec.ts = Date.now();
          results.push(rec);
          logResult(rec, p);
          if (!dryRun) appendResult(rec);
          // 检测证明登录态有效：同步刷新登录记账。否则被「登录失效」暂停的平台
          // 即使检测通过也会一直被自动领取跳过（检测结果不入账，needs_login 记录盖不掉）
          if (rec.status === 'dry_run' && p.kind === 'web' && loginOkSince(p.id) <= rec.ts - 60_000) {
            markLoginOk(p.id);
            pushLog('info', `· ${p.name}：检测证明登录态有效，已刷新登录记账`);
          }
          // 逐平台回填结论并推进运行代数——前端 2 秒一轮的状态轮询会在几秒内把
          // 结论标到行上，不用等整轮结束
          lastTrial.at = Date.now();
          lastTrial.dryRun = dryRun;
          const entry = { id: rec.id, status: rec.status, detail: rec.detail || '' };
          const upsertAt = lastTrial.results.findIndex((r) => r.id === rec.id);
          if (upsertAt >= 0) lastTrial.results[upsertAt] = entry;
          else lastTrial.results.push(entry);
          runEpoch.value++;
        } catch (e) {
          pushLog('err', `${p.name} 任务异常: ${firstLine(e?.message || e)}`);
        } finally {
          runState.activeIds.delete(p.id);
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, queue.length) }, () => worker()));

    pruneShots();
    pushLog('info', `执行完毕：${summarize(results).done}/${results.length} 成功${dryRun ? '（检测，不记入统计）' : ''}`);
    return { ok: true, results, summary: summarize(results) };
  } catch (e) {
    pushLog('err', `本轮异常: ${firstLine(e?.message || e)}`);
    return { ok: false, error: firstLine(e?.message || e), results, summary: summarize(results) };
  } finally {
    if (!single) {
      runState.running = false;
      runState.source = null;
    }
    runEpoch.value++;
    // 记录本轮结果供前端行内回填：检测的结果在行上显示「检测结论」，
    // 正式运行会覆盖掉它（行内转回真实状态）
    lastTrial.at = Date.now();
    lastTrial.dryRun = dryRun;
    if (results.length) {
      for (const r of results) {
        const entry = { id: r.id, status: r.status, detail: r.detail || '' };
        const upsertAt = lastTrial.results.findIndex((x) => x.id === r.id);
        if (upsertAt >= 0) lastTrial.results[upsertAt] = entry;
        else lastTrial.results.push(entry);
      }
    }
  }
}

/** 结果落日志：成功/失败文案 + 需要下载客户端的主动提醒 */
function logResult(rec, platform) {
  // 需要下载客户端/App 才能领的平台：入口未命中时大声提醒，别让用户翻运行记录才发现
  if (rec.status === 'not_found' && platform?.claimViaApp) {
    const note = platform.appOnlyNote || '该平台需要下载客户端或在 App 内领取，网页端代领不了';
    rec.detail = `${note}${rec.detail ? `（原始结果：${rec.detail}）` : ''}`;
    pushLog('warn', `⚠ ${platform.name}：${note}`);
    return;
  }
  const okStatus = ['success', 'already', 'dry_run'].includes(rec.status);
  const label = STATUS_LABEL[rec.status] || rec.status;
  pushLog(okStatus ? 'ok' : 'warn', `${okStatus ? '✓' : '✗'} ${rec.name}：${label}${rec.detail ? ' · ' + rec.detail : ''}`);
}

function makeRecord(platform, patch) {
  return {
    id: platform.id,
    name: platform.name,
    date: todayStr(),
    ts: Date.now(),
    shot: null,
    ...patch,
  };
}

function emptySummary() {
  return { total: 0, done: 0, failed: 0, skipped: 0 };
}

function summarize(results) {
  const done = results.filter((r) => r.status === 'success' || r.status === 'already' || r.status === 'dry_run').length;
  const failed = results.filter((r) => !['success', 'already', 'dry_run'].includes(r.status)).length;
  return { total: results.length, done, failed, skipped: 0 };
}

/** 给前端的状态构建：平台清单 + 最近结果 + 14 天矩阵 + 连续天数 */
export function buildNetCheckinState() {
  const cfg = loadConfig();
  const platforms = resolvePlatforms(cfg);
  const results = readResults();
  const dates = lastDates(14);

  const rows = platforms.map((p) => {
    // 客户端安装状态必须实时探测：历史流水里的一条 not_installed 不能代表现状
    const probe = p.kind === 'client' ? clientProbe(p) : null;
    const installedNow = Boolean(probe?.exe && !probe.launcherOnly);
    const mine = results.filter((r) => r.id === p.id && !r.dryRun);
    mine.sort((a, b) => a.ts - b.ts);
    const last = mine[mine.length - 1] || null;

    const matrix = {};
    for (const d of dates) {
      const day = mine.filter((r) => r.date === d);
      matrix[d] = day.length ? day[day.length - 1].status : null;
    }

    // 连续天数：从今天（没跑就看昨天）往回数连续成功/已领的天数
    let streak = 0;
    const cursor = new Date();
    if (!doneStatus(matrix[todayStr()])) cursor.setDate(cursor.getDate() - 1);
    for (;;) {
      const key = todayStr(cursor);
      if (doneStatus(matrix[key])) {
        streak++;
        cursor.setDate(cursor.getDate() - 1);
      } else break;
    }

    // 积分信息：最近一次已知的余额 + 历史累计到账（只在引擎报过数时才统计）。
    // 流水没有余额时回退到 balances 记账（检测/领取顺带抓到的余额都会落盘）
    let credits = null;
    let balanceAt = null;
    let totalGained = 0;
    let hasGained = false;
    let successCount = 0;
    for (const r of mine) {
      const { credits: c, gain } = parsePoints(r.detail, r.meta);
      if (c !== null) {
        credits = c; // 后写的覆盖先写的（升序遍历，最后赋值即最新）
        balanceAt = r.ts;
      }
      if (Number.isFinite(gain) && ['success', 'already'].includes(r.status)) {
        totalGained += gain;
        hasGained = true;
      }
      if (r.status === 'success' || r.status === 'already') successCount++;
    }
    const bal = cfg.balances?.[p.id];
    if (credits === null && bal && Number.isFinite(bal.credits)) {
      credits = bal.credits;
      balanceAt = bal.at || null;
    }

    return {
      id: p.id,
      name: p.name,
      kind: p.kind,
      engine: p.engine,
      enabled: p.enabled,
      category: p.category,
      reward: p.reward,
      notes: p.notes,
      homepage: p.homepage,
      loginUrl: p.loginUrl,
      headed: Boolean(p.headed),
      visitClaim: Boolean(p.visitClaim),
      claimViaApp: Boolean(p.claimViaApp),
      appOnlyNote: p.appOnlyNote || '',
      // 客户端类：实时探测（进程内缓存 60 秒），不依赖上一次运行留下的历史状态
      clientExe: installedNow ? probe.exe : '',
      clientExeSource: probe?.source || '',
      clientLauncherOnly: Boolean(probe?.launcherOnly),
      clientProbePaths: (probe?.tried || []).map((t) => t.path).filter(Boolean).slice(0, 6),
      clientRunning: false, // 由路由层填充
      // 历史「未安装」但现在已找到客户端：展示成「待重跑」，避免一直误导用户
      lastStatus: last?.status === 'not_installed' && installedNow ? 'stale_install' : last?.status || null,
      lastDetail:
        last?.status === 'not_installed' && installedNow
          ? `已检测到客户端 ${probe.exe}，下次运行会自动重试`
          : last?.detail || '',
      lastTs: last?.ts || null,
      todayDone: doneTodayOf(p.id),
      streak,
      /** 该平台最近一次登录成功的记账时间（登录窗口保存） */
      lastLoginAt: cfg.logins?.[p.id] || null,
      /** 已知积分余额（最近一次查询到的）与累计到账 */
      credits,
      /** 余额的记账时间：流水里带出来的用记录时间，balances 记账用落盘时间 */
      balanceAt: balanceAt || null,
      totalGained: hasGained ? totalGained : null,
      successCount,
      /** 网页平台是否需要用户去登录：登录失效（且没有重新登录过），或从没登录过 */
      needsLogin:
        p.kind === 'web' &&
        Boolean(
          (last?.status === 'needs_login' && loginOkSince(p.id) <= (last.ts || 0)) ||
            (!loginOkSince(p.id) && !last),
        ),
      matrix,
    };
  });

  // 最近一轮（非检测）运行的汇总：流水按轮追加，从末尾回溯同一轮的记录
  // （同一轮的记录时间戳彼此相差不会超过单平台超时上限，10 分钟截断足够）
  const real = results.filter((r) => !r.dryRun);
  let lastRun = null;
  if (real.length) {
    const last = real[real.length - 1];
    const run = [last];
    for (let i = real.length - 2; i >= 0; i--) {
      if (last.ts - real[i].ts > 10 * 60_000) break;
      run.unshift(real[i]);
    }
    lastRun = {
      ts: last.ts,
      date: last.date,
      total: run.length,
      done: run.filter((r) => r.status === 'success' || r.status === 'already').length,
    };
  }

  // 最近一次检测的结果（6 小时内有效）：前端拿它做行内回填；
  // 正式运行后 lastTrial.dryRun 变为 false，回填自动消失
  const trial =
    lastTrial.dryRun && lastTrial.results.length && Date.now() - lastTrial.at < TRIAL_TTL_MS
      ? Object.fromEntries(lastTrial.results.map((r) => [r.id, { status: r.status, detail: r.detail }]))
      : null;

  // 领取记录表：最近 200 条正式运行流水（新→旧），含积分数值
  const recentResults = real.slice(-200).reverse().map(toRow);

  return {
    platforms: rows,
    schedule: cfg.schedule,
    running: runState.running,
    /** 正在执行中的平台 id（含批量与单平台）：行级按钮按它禁用，其它平台不受影响 */
    activeIds: [...runState.activeIds],
    runSource: runState.source,
    runId: runState.running ? runState.runId : null,
    lastRun,
    totals: { claims: real.filter((r) => r.status === 'success' || r.status === 'already').length },
    customPlatforms: (cfg.custom || []).map((c) => c.id),
    manualPlatforms: MANUAL_PLATFORMS,
    trial,
    recentResults,
  };
}

/**
 * 单平台详情（子页面用）：状态行 + 该平台全部领取记录（新→旧）。
 * 没有这个平台时返回 null。
 */
export function platformDetail(platformId) {
  const state = buildNetCheckinState();
  const row = state.platforms.find((p) => p.id === platformId);
  if (!row) return null;
  const records = readResults()
    .filter((r) => r.id === platformId)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 200)
    .map(toRow);
  return { platform: row, records, active: runState.activeIds.has(platformId) };
}

const doneStatus = (s) => s === 'success' || s === 'already';

function lastDates(n) {
  const out = [];
  const d = new Date();
  for (let n2 = n - 1; n2 >= 0; n2--) {
    const t = new Date(d);
    t.setDate(d.getDate() - n2);
    out.push(todayStr(t));
  }
  return out;
}

/** 查询客户端运行状态（state 构建时按需调用；有 60s 路由层缓存就够） */
export async function fillClientRunning(rows) {
  for (const row of rows) {
    if (row.kind !== 'client' || !row.clientExe || !row.enabled) {
      row.clientRunning = false;
      continue;
    }
    row.clientRunning = await isClientRunning(row.clientExe).catch(() => false);
  }
  return rows;
}
