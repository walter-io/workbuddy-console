import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  loadConfig,
  saveConfigAsync,
  newId,
  maskKey,
  CONFIG_FILE,
  cachePath,
  activeKeyFor,
} from './store/config.mjs';
import { providers, getProvider, listPlatforms, PLATFORM_ORDER } from './providers/registry.mjs';
import { clearModelsCache, modelsCacheFile } from './providers/genericOpenAI.mjs';
import {
  detectWorkbuddyDir,
  detectWorkbuddyProcess,
  isPendingRestart,
  modelsJsonMtime,
  listLoaded,
  loadModels,
  removeModels,
  restartWorkbuddy,
  killWorkbuddy,
  waitForWorkbuddyGone,
  findWorkbuddyExe,
} from './targets/workbuddy.mjs';
import { getStats } from './stats/workbuddyStats.mjs';
import { getProxyUrl } from './proxy.mjs';
import { loadAccounts, accountMeta, findAccount, accountDisplayName, hasPlainToken } from './workbuddy/accounts.mjs';
import { oauthStart, oauthPoll } from './workbuddy/oauth.mjs';
import {
  switchAccount,
  detectCurrentAccount,
  importLocalAccount,
  deleteAccount,
  updateAccountDisplay,
} from './workbuddy/auth.mjs';
import {
  getCreditStatistics,
  getOfflineCreditProjection,
  getAccountBalances,
  getCreditDetails,
  // 提速版在 credit-stats 路由尾部调用了它（预热 7/90 天），但漏了 import：
  // 缺这行每次统计请求都会抛 ReferenceError（响应已发出，只在服务端日志里炸）
  prefetchCreditRanges,
} from './workbuddy/credits.mjs';
import { refreshAccessToken } from './proxy/wb.mjs';
import { VARIANT_LIST, authFilePath, dataRoot } from './workbuddy/variant.mjs';
import { checkinAll, checkinAccount, fetchCheckinStatus, loadCheckinLogs, allCheckedInToday, allGrowthDoneToday } from './workbuddy/checkin.mjs';
import { fetchTravelStatus } from './workbuddy/growth.mjs';
import {
  refreshAccounts,
  refreshPlan,
  loadRefreshLogs,
  lastRefreshRun,
  loadCredentialStatus,
  verifyStateOf,
  verifyAccount,
  verifyNewAccount,
  ACCESS_MIN_HOURS,
  REFRESH_MIN_HOURS,
} from './workbuddy/tokenRefresh.mjs';
import { checkForUpdate, LOCAL_VERSION } from './update.mjs';
import { checkPermissions } from './workbuddy/diagnostics.mjs';
import { listBackups, restoreBackup, deleteBackup, cleanBackups, backupVariants } from './workbuddy/backups.mjs';
import { probeAllModelLimits } from './workbuddy/modelLimits.mjs';
import { registerProxyRoutes, refreshModelsCache } from './proxy/index.mjs';
import { stopWorkbuddy, launchWorkbuddy } from './targets/workbuddy.mjs';
import { listSessionsForSwitch, copySessions, moveSessionsToAccount, sessionIdsNeedingSync, syncAllAccounts, dedupeSessions, sessionDataRoot, copyVariantIntoAccount, currentUidOfVariant, warmSessionSignatures } from './workbuddy/sessions.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 57911);

const app = express();
// 反向代理的对话请求体可能很长（大上下文 / 工具调用），单独放宽到 12MB；
// 放在全局 1MB 解析器之前，命中的请求不会被后者拦下。
// /v1 与 /v1beta 是两个独立前缀（前者不含后者），Gemini 原生协议走 /v1beta，需单独挂。
app.use('/v1', express.json({ limit: '12mb' }));
app.use('/v1beta', express.json({ limit: '12mb' }));
app.use(express.json({ limit: '1mb' }));

const wrap = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((err) => {
    const status = Number(err?.status) || 500;
    // 4xx 是调用方参数问题，不打成服务器错误日志，避免日志噪音
    if (status >= 500) console.error(`[api] ${req.method} ${req.path}:`, err?.message || err);
    res.status(status).json({ error: err?.message || '服务器内部错误' });
  });
};

/**
 * 只有"确实是我们把 WorkBuddy 关掉的"才重新打开它，并保证**不把用户的应用留在关闭状态**。
 * 重新打开本身失败只回报，不抛错——登录态已经写好，重启失败不该让整个切换算失败。
 */
async function relaunchIfStopped(appStop) {
  if (!appStop?.wasRunning) return null;
  try {
    return launchWorkbuddy(appStop.exePath);
  } catch (err) {
    return { launched: false, error: err?.message || String(err) };
  }
}

// 服务保命：未捕获的异步异常/Rejection 只记日志，绝不让进程整个消失——
// 用户点「一键同步」跑到一半服务闪退（页面变「本地服务已断开」）就是这类错误杀的。
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.stack || err);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err?.stack || err);
});

/**
 * 全自动执行：自动关闭 WorkBuddy → 执行 fn → 清掉执行期间被系统拉起的实例 →
 * 自动打开（读到操作完成后的最新数据）。用户无需手动开关。
 */
/**
 * 数据写操作门禁：WorkBuddy 在运行就拒绝并提示用户手动退出。
 * 绝不替用户杀进程/关应用（用户明确要求：不冻结、不强杀、不自动开关应用）。
 */
async function assertAppClosed() {
  let running = false;
  try {
    const proc = await detectWorkbuddyProcess();
    running = !!proc?.running;
  } catch {
    running = false;
  }
  if (running) {
    throw Object.assign(
      new Error('WorkBuddy 正在运行：请先在系统托盘右键退出 WorkBuddy（不是最小化），再回来点执行。写完数据后你自己重新打开即可，控制台不会替你关闭或启动应用。'),
      { status: 409 }
    );
  }
}

/**
 * 会话写操作互斥：sync-all / dedupe / move 都是「关应用 → 改库 → 重启」的重操作，
 * 并发跑会重复备份、撞 SQLite 写锁、重复重启 WorkBuddy。执行中再收到写请求直接 409
 * （排队等一小时不如让用户稍后再点）；dryRun 只读、随时可跑，不占锁。
 */
let sessionOpBusy = false;
async function withSessionOpLock(fn) {
  if (sessionOpBusy) {
    throw Object.assign(new Error('已有会话整理操作在执行中（同步 / 去重 / 搬家），请等它完成后再操作'), { status: 409 });
  }
  sessionOpBusy = true;
  try {
    return await fn();
  } finally {
    sessionOpBusy = false;
  }
}

/**
 * 会话搬家结果落一行服务日志。
 *
 * 控制台是隐藏启动的，用户看不到 stdout，排查全靠 /api/diag/tail；
 * 而此前搬家结果根本没打日志——「说成功但会话没动」这类反馈完全无从下手。
 */
function logMove(report, targetAccountId) {
  if (!report) return;
  const moved = report.moved?.length || 0;
  const merged = report.merged?.length || 0;
  const skipped = report.skippedDeleted?.length || 0;
  const failed = report.errors?.length || 0;
  const firstError = failed ? ` / 首个失败：${report.errors[0]?.error}` : '';
  const verify = report.verified === false ? ' / 回读校验未通过（写入未生效）' : '';
  console.log(
    `[move] → ${String(targetAccountId).slice(0, 8)} 过户 ${moved} / 合并 ${merged} / 跳过 ${skipped} / 失败 ${failed}` +
      `${verify}${firstError}（${report.elapsedMs ?? 0}ms）`
  );
}

/**
 * 全自动执行：关掉 WorkBuddy → 干活 → 自动重新打开。
 * 仅在用户明确要求时使用（stopApp=true）。关闭失败直接中止，不会在应用还开着时写库。
 * 任何情况下都会尝试把 WorkBuddy 重新拉起来，避免把用户的应用留在关闭状态。
 */
async function withAppRestart(fn) {
  const t0 = Date.now();
  // 关应用（子进程、要等）和「预热会话指纹」（纯读文件）并行跑，互不干扰
  const stopPromise = stopWorkbuddy();
  let warm = null;
  try {
    warm = warmSessionSignatures();
  } catch {
    /* 预热失败不影响主流程 */
  }
  let stop = null;
  try {
    stop = await stopPromise;
  } catch (e) {
    throw Object.assign(new Error(`无法关闭 WorkBuddy，已中止（没有改动任何数据）：${e?.message || e}`), { status: 500 });
  }
  // 等进程真的消失再动库：taskkill 返回 ≠ 句柄释放，WorkBuddy 还可能被系统
  // 「崩溃自动恢复」在几秒内重新拉起（新实例会重新打开 workbuddy.db）。
  // 写入落在这个窗口里就会撞锁或被回滚——用户看到的是「说成功了，会话没动」。
  if (stop?.wasRunning) {
    const gone = await waitForWorkbuddyGone(4000);
    if (!gone) console.log('[restart] 关闭后 4 秒内仍检测到 WorkBuddy 进程，仍继续写入（可能撞锁，失败会重试）');
  }
  const tStop = Date.now();
  let result = null;
  let failure = null;
  try {
    result = await fn();
  } catch (e) {
    failure = e;
  }
  const tWork = Date.now();
  let relaunch = null;
  if (stop?.wasRunning) {
    // 应用是自己退出的，句柄已释放；只留 200ms 缓冲即可
    await new Promise((r) => setTimeout(r, 200));
    relaunch = launchWorkbuddyInBackground(stop.exePath || null, '-restart');
  }
  const tLaunch = Date.now();
  console.log(
    `[restart] 关闭 ${tStop - t0}ms（含并行预热 ${warm?.files ?? 0} 文件 ${warm?.ms ?? 0}ms）` +
      ` / 处理 ${tWork - tStop}ms / 打开 ${tLaunch - tWork}ms / 总计 ${tLaunch - t0}ms`
  );
  if (failure) {
    failure.relaunch = relaunch;
    failure.appStop = stop;
    throw failure;
  }
  return { result, appStop: stop, relaunch };
}

/**
 * 后台重新打开 WorkBuddy：不阻塞当前请求。
 * 用户点确认后要的是「快点结束」，窗口晚几秒出现完全可以接受。
 */
function launchWorkbuddyInBackground(exePath, tag = '') {
  const t = Date.now();
  launchWorkbuddy(exePath)
    .then((r) => console.log(`[launch${tag}] 窗口就绪 ${Date.now() - t}ms verified=${r?.verified}`))
    .catch((e) => console.log(`[launch${tag}] 打开失败：${e?.message || e}`));
  return { launched: true, background: true };
}

async function runWithAppClosed(fn) {
  let wasRunning = false;
  let killed = null;
  try {
    const proc = await detectWorkbuddyProcess();
    wasRunning = proc.running;
    if (wasRunning) killed = await killWorkbuddy();
  } catch {
    wasRunning = false;
  }
  const result = await fn();
  let relaunch = null;
  if (wasRunning) {
    try {
      await killWorkbuddy();
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 6000));
    const p2 = await detectWorkbuddyProcess();
    if (p2.running) {
      relaunch = { launched: true, resurrected: true };
    } else {
      try {
        relaunch = await launchWorkbuddy(killed?.exePath || null);
      } catch (err) {
        relaunch = { launched: false, error: err?.message || String(err) };
      }
    }
  }
  return { result, wasRunning, relaunch };
}

const platformFromReq = (req) => {
  const id = String(req.query.platform || req.body?.platform || 'openrouter');
  return getProvider(id);
};

/* ---------------- 健康检查（前端用于探测本地服务是否在线） ---------------- */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    pid: process.pid,
    uptime: Math.round(process.uptime()),
    now: Date.now(),
    // 本机版本号：界面不再硬编码，统一从这里取
    version: LOCAL_VERSION,
    // 运行在 Electron 桌面壳里时为 true：前端据此调整「服务断开」的恢复指引
    desktop: process.env.WB_DESKTOP === '1',
  });
});

/* ---------------- 平台与模型 ---------------- */

app.get('/api/platforms', (req, res) => {
  const cfg = loadConfig();
  // 置灰只是"默认不建议"，不是"不允许"：设置里勾了「显示全部平台」就照常可选，
  // 但把原始限制原因单独作为 restriction 传下去，让界面能常驻风险提示。
  const unlockAll = !!cfg.settings.unlockAllPlatforms;
  const platforms = listPlatforms().map((p) => ({
    ...p,
    restriction: p.uiDisabled || null,
    uiDisabled: unlockAll ? null : p.uiDisabled || null,
    keyCount: cfg.keys.filter((k) => k.platform === p.id).length,
    modelCount: providers[p.id].peek?.()?.count ?? null,
  }));
  res.json({ platforms, unlockAll });
});

app.get(
  '/api/models',
  wrap(async (req, res) => {
    const provider = platformFromReq(req);
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const key = activeKeyFor(loadConfig(), provider.id);
    const data = await provider.getModels({ refresh, apiKey: key?.key || undefined, baseUrl: key?.baseUrl || undefined });
    res.json({ ...data, platform: provider.id, platformName: provider.name, note: provider.note, tutorialUrl: provider.tutorialUrl || null });
  })
);

/* ---------------- 额度（按平台聚合，只查已配置 key 的平台） ---------------- */

app.get(
  '/api/quota',
  wrap(async (req, res) => {
    const cfg = loadConfig();
    const groups = [];
    for (const pid of PLATFORM_ORDER) {
      const provider = providers[pid];
      const keys = cfg.keys.filter((k) => k.platform === pid);
      if (!keys.length) continue;
      const list = await Promise.all(
        keys.map(async (k) => {
          const base = { keyId: k.id, platform: pid, label: k.label || maskKey(k.key), masked: maskKey(k.key) };
          // 无额度接口的平台不发起任何网络请求，仅展示本地保存的 key 状态
          if (!provider.fetchQuotaForKey) {
            const st = k.lastStatus;
            return { ...base, status: st === 'ok' || st === 'invalid' ? st : 'unknown', note: '该平台未提供额度查询接口' };
          }
          try {
            const q = await provider.fetchQuotaForKey(k.key);
            if (!q.ok) return { ...base, status: 'invalid', error: 'Key 无效或已撤销' };
            if (q.unavailable) return { ...base, status: 'ok', unavailable: q.unavailable };
            if (provider.quotaKind === 'balance') {
              return { ...base, status: 'ok', balance: q.balance || null };
            }
            const { key: info, credits } = q;
            return {
              ...base,
              status: 'ok',
              freeModelDailyRequests: info.free_model_daily_requests || null,
              usage: info.usage ?? null,
              usageDaily: info.usage_daily ?? null,
              usageWeekly: info.usage_weekly ?? null,
              usageMonthly: info.usage_monthly ?? null,
              limit: info.limit ?? null,
              limitRemaining: info.limit_remaining ?? null,
              isFreeTier: !!info.is_free_tier,
              expiresAt: info.expires_at || null,
              credits: credits ? { total: credits.total_credits ?? null, used: credits.total_usage ?? null } : null,
            };
          } catch (err) {
            return { ...base, status: 'error', error: err?.message || '查询失败' };
          }
        })
      );
      groups.push({
        platform: pid,
        platformName: provider.name,
        quotaKind: provider.quotaKind,
        note: provider.note,
        tutorialUrl: provider.tutorialUrl || null,
        keys: list,
      });
    }
    res.json({ fetchedAt: Date.now(), activeKeys: cfg.activeKeys || {}, platforms: groups });
  })
);

/* ---------------- Keys 管理（按平台） ---------------- */

app.get('/api/keys', (req, res) => {
  const cfg = loadConfig();
  res.json({
    activeKeys: cfg.activeKeys || {},
    activeKeyId: cfg.activeKeyId,
    keys: cfg.keys.map((k) => ({
      id: k.id,
      platform: k.platform,
      label: k.label || maskKey(k.key),
      masked: maskKey(k.key),
      addedAt: k.addedAt,
      lastStatus: k.lastStatus || null,
      baseUrl: k.baseUrl || null,
    })),
    configFile: CONFIG_FILE,
  });
});

/** 清洗用户粘贴的 Key：去零宽字符、所有空白字符、首尾包裹引号（网页复制的常见污染） */
function cleanKey(raw) {
  return String(raw || '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '') // 零宽字符与方向控制符
    .replace(/\s+/g, '') // 空格 / 换行 / 制表符等
    .replace(/^["'`]+|["'`]+$/g, ''); // 首尾引号
}

app.post(
  '/api/keys',
  wrap(async (req, res) => {
    const key = cleanKey(req.body?.key);
    const label = String(req.body?.label || '').trim();
    const provider = getProvider(String(req.body?.platform || 'openrouter'));
    if (provider.keyFormat && !provider.keyFormat.test(key)) {
      const head = key.slice(0, 6);
      return res.status(400).json({
        error:
          `Key 格式不符合 ${provider.name} 的要求（应以 ${provider.keyPlaceholder || '正确前缀'} 开头）。` +
          `检测到粘贴内容以 "${head || '空'}" 开头、共 ${key.length} 个字符，` +
          '请确认复制的是 API Key 本身（不是页面上的其他文本），重新复制后重试',
      });
    }
    const cfg = loadConfig();
    if (cfg.keys.some((k) => k.platform === provider.id && k.key === key)) {
      return res.status(400).json({ error: '这个 Key 已经添加过了' });
    }
    // 先验真伪再入库
    const t = await provider.testKey(key);
    if (!t.ok) {
      const why = t.invalid ? t.error || '平台返回未授权（401），Key 已失效或账户未开通该服务' : t.error || '校验失败';
      return res.status(400).json({ error: `Key 无效：${why}` });
    }
    const item = {
      id: newId('key'),
      platform: provider.id,
      key,
      label: label || t.label || `${provider.name} ${maskKey(key)}`,
      addedAt: Date.now(),
      lastStatus: 'ok',
      // 多节点平台（如 Agnes 双站）：记录该 key 实际鉴权通过的节点，
      // 之后拉模型、载入 WorkBuddy 都走这个节点（key 与签发站点绑定，跨站必 401）
      baseUrl: t.baseUrl || null,
    };
    cfg.keys.push(item);
    cfg.activeKeys = { ...(cfg.activeKeys || {}) };
    if (!cfg.activeKeys[provider.id]) cfg.activeKeys[provider.id] = item.id;
    if (provider.id === 'openrouter') cfg.activeKeyId = item.id;
    // 异步落盘：写盘重试最坏 36 秒，同步版会冻住整个服务 → 前端 25 秒默认超时误报失败
    await saveConfigAsync(cfg);
    res.json({ id: item.id, platform: provider.id, label: item.label, masked: maskKey(key), isFreeTier: t.isFreeTier, warn: t.warn || null });
  })
);

app.delete('/api/keys/:id', async (req, res) => {
  const cfg = loadConfig();
  const target = cfg.keys.find((k) => k.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'Key 不存在' });
  cfg.keys = cfg.keys.filter((k) => k.id !== req.params.id);
  if ((cfg.activeKeys || {})[target.platform] === req.params.id) {
    cfg.activeKeys[target.platform] = cfg.keys.find((k) => k.platform === target.platform)?.id || null;
  }
  if (cfg.activeKeyId === req.params.id) cfg.activeKeyId = cfg.keys.find((k) => k.platform === 'openrouter')?.id || null;
  try {
    await saveConfigAsync(cfg);
  } catch (err) {
    return res.status(500).json({ error: `删除失败：${err?.message || err}` });
  }
  res.json({ ok: true });
});

app.post('/api/keys/:id/activate', async (req, res) => {
  const cfg = loadConfig();
  const target = cfg.keys.find((k) => k.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'Key 不存在' });
  cfg.activeKeys = { ...(cfg.activeKeys || {}), [target.platform]: target.id };
  if (target.platform === 'openrouter') cfg.activeKeyId = target.id;
  try {
    await saveConfigAsync(cfg);
  } catch (err) {
    return res.status(500).json({ error: `切换失败：${err?.message || err}` });
  }
  res.json({ ok: true });
});

app.post(
  '/api/keys/:id/test',
  wrap(async (req, res) => {
    const cfg = loadConfig();
    const k = cfg.keys.find((x) => x.id === req.params.id);
    if (!k) return res.status(404).json({ error: 'Key 不存在' });
    try {
      const t = await getProvider(k.platform).testKey(k.key);
      k.lastStatus = t.ok ? 'ok' : 'invalid';
      // 多节点平台：key 可能被删后换站点重建，重测时同步纠正生效节点
      k.baseUrl = t.baseUrl || null;
      // 探测结果只是元数据：落盘失败不该让「测试通过」变成 502，故单独兜住
      await saveConfigAsync(cfg).catch(() => {});
      res.json(
        t.ok
          ? { ok: true, isFreeTier: t.isFreeTier, baseUrl: t.baseUrl || null, warn: t.warn || null }
          : { ok: false, error: t.error || 'Key 无效' },
      );
    } catch (err) {
      res.status(502).json({ ok: false, error: err?.message || '测试失败' });
    }
  })
);

/* ---------------- WorkBuddy ---------------- */

app.get(
  '/api/workbuddy/status',
  wrap(async (req, res) => {
    const loaded = listLoaded();
    const proc = await detectWorkbuddyProcess();
    res.json({
      ...loaded,
      running: proc.running,
      exePath: proc.exePath || null,
      // 进程探测本身失败（而非"确实没运行"）时透出原因，避免界面给出错误结论
      detectError: proc.error || null,
      detectMethod: proc.method || null,
      processCount: proc.processCount ?? null,
      // 降级探测（tasklist）拿不到启动时间，无法自动判断"配置待重启"
      detectWarning: proc.warning || (proc.startTimeUnknown ? '未能获取进程启动时间，无法自动判断模型配置是否需要重启' : null),
      modelsJsonMtime: modelsJsonMtime(),
      pendingRestart: isPendingRestart(proc), // 配置已变更但运行中的 WorkBuddy 尚未读取
    });
  })
);

app.get('/api/workbuddy/loaded', (req, res) => {
  res.json(listLoaded());
});

app.post(
  '/api/workbuddy/load',
  wrap(async (req, res) => {
    const modelIds = Array.isArray(req.body?.modelIds) ? req.body.modelIds.filter(Boolean) : [];
    const provider = platformFromReq(req);
    if (!modelIds.length) return res.status(400).json({ error: '请先选择要载入的模型' });

    const cfg = loadConfig();
    const keyId = req.body?.keyId || null;
    const target =
      cfg.keys.find((k) => k.platform === provider.id && k.id === keyId) || activeKeyFor(cfg, provider.id);
    if (!target) {
      return res.status(400).json({ error: `尚未配置 ${provider.name} API Key，请先到「免费模型广场 → API Keys」添加` });
    }

    const cached = provider.peek?.();
    if (!cached?.models?.length) {
      return res.status(409).json({ error: `${provider.name} 模型列表尚未加载，请先在模型页查看一次该平台` });
    }
    const index = new Map(cached.models.map((m) => [m.id, m]));

    const entries = [];
    const skipped = [];
    for (const id of modelIds) {
      const m = index.get(id);
      if (!m) {
        skipped.push({ id, reason: '模型列表中未找到' });
        continue;
      }
      if (m.outputKind !== 'text') {
        skipped.push({ id, reason: '图像/视频生成模型暂不支持载入 WorkBuddy' });
        continue;
      }
      if (m.loadable === false) {
        skipped.push({ id, reason: '该模型协议不兼容，不支持载入 WorkBuddy' });
        continue;
      }
      entries.push(provider.buildEntry(m, target.key, target.baseUrl));
    }
    if (!entries.length) {
      return res.status(400).json({ error: '没有可载入的模型', skipped });
    }
    const result = await loadModels(entries);
    res.json({ ...result, keyUsed: maskKey(target.key), skipped });
  })
);

/* ---------------- 导出配置（拷给其他 agent 用：不写文件，只读生成条目） ---------------- */

/**
 * 与 /api/workbuddy/load 的区别：这一步**不改任何文件**，只把"如果要配这些模型，
 * 该填什么"算出来给界面展示与复制。
 * API Key 默认只回脱敏尾巴；界面上点「显示」时才带 reveal=1 取明文（本机工具，用户自己的 Key）。
 */
app.post(
  '/api/export/entries',
  wrap(async (req, res) => {
    const modelIds = Array.isArray(req.body?.modelIds) ? req.body.modelIds.filter(Boolean) : [];
    const provider = platformFromReq(req);
    const reveal = req.query.reveal === '1' || req.body?.reveal === true;
    if (!modelIds.length) return res.status(400).json({ error: '请先选择要导出的模型' });

    const cfg = loadConfig();
    const keyId = req.body?.keyId || null;
    const target =
      cfg.keys.find((k) => k.platform === provider.id && k.id === keyId) || activeKeyFor(cfg, provider.id);
    if (!target) {
      return res.status(400).json({ error: `尚未配置 ${provider.name} API Key，请先到「免费模型广场 → API Keys」添加` });
    }

    const cached = provider.peek?.();
    if (!cached?.models?.length) {
      return res.status(409).json({ error: `${provider.name} 模型列表尚未加载，请先在模型广场打开一次该平台` });
    }
    const index = new Map(cached.models.map((m) => [m.id, m]));

    const entries = [];
    const skipped = [];
    for (const id of modelIds) {
      const m = index.get(id);
      if (!m) {
        skipped.push({ id, reason: '模型列表中未找到' });
        continue;
      }
      const entry = provider.buildEntry(m, target.key, target.baseUrl);
      entries.push({
        ...entry,
        // 未点「显示」时不带明文，避免 Key 被无意复制到剪贴板
        apiKey: reveal ? entry.apiKey : null,
        outputKind: m.outputKind || 'text',
      });
    }
    if (!entries.length) return res.status(400).json({ error: '没有可导出的模型', skipped });

    res.json({
      platform: provider.id,
      platformName: provider.name,
      baseUrl: provider.baseUrl || null,
      protocol: 'openai-compatible',
      chatPath: '/chat/completions',
      masked: maskKey(target.key),
      apiKey: reveal ? target.key : null,
      entries,
      skipped,
    });
  })
);

app.post(
  '/api/workbuddy/remove',
  wrap(async (req, res) => {
    const ids = Array.isArray(req.body?.modelIds) ? req.body.modelIds.filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ error: '请选择要移除的模型' });
    res.json(await removeModels(ids));
  })
);

app.post(
  '/api/workbuddy/restart',
  wrap(async (req, res) => {
    res.json(await restartWorkbuddy());
  })
);

/* ---------------- 每日签到（仅国内版账号） ---------------- */

/** 各账号的签到状态（只读查询，不写任何东西） */
app.get(
  '/api/workbuddy/checkin/status',
  wrap(async (req, res) => {
    const accounts = loadAccounts().filter((a) => (a?.variant || 'cn') !== 'ai');
    const states = [];
    for (const account of accounts) {
      try {
        const state = await fetchCheckinStatus(account);
        states.push({ account: accountMeta(account), ...state });
      } catch (e) {
        states.push({ account: accountMeta(account), ok: false, todayCheckedIn: false, error: e?.message || '查询失败' });
      }
    }
    res.json({ states, logs: loadCheckinLogs().slice(-20).reverse() });
  })
);

/** 手动签到：带 accountId 签单个，不带则全部 */
app.post(
  '/api/workbuddy/checkin',
  wrap(async (req, res) => {
    const accountId = String(req.body?.accountId || '');
    if (accountId) {
      res.json(await checkinAccount(accountId));
    } else {
      res.json(await checkinAll({ onlyPending: req.body?.onlyPending !== false }));
    }
  })
);

/* ---------------- 登录态与目录权限自检 ---------------- */

app.get(
  '/api/workbuddy/permissions',
  wrap(async (req, res) => {
    res.json(checkPermissions());
  })
);

/* ---------------- 登录态备份管理 ---------------- */

app.get(
  '/api/workbuddy/backups',
  wrap(async (req, res) => {
    res.json({ ...listBackups(), variants: backupVariants() });
  })
);

app.post(
  '/api/workbuddy/backups/restore',
  wrap(async (req, res) => {
    const name = String(req.body?.name || '');
    if (!name) return res.status(400).json({ error: '缺少备份文件名' });
    res.json(await restoreBackup(name));
  })
);

app.post(
  '/api/workbuddy/backups/clean',
  wrap(async (req, res) => {
    res.json(cleanBackups(Number(req.body?.keep) || 10));
  })
);

app.delete(
  '/api/workbuddy/backups/:name',
  wrap(async (req, res) => {
    res.json(deleteBackup(decodeURIComponent(req.params.name)));
  })
);

/* ---------------- Token 统计 ---------------- */

app.get(
  '/api/stats',
  wrap(async (req, res) => {
    const range = ['today', '7d', '30d', 'all'].includes(req.query.range) ? req.query.range : '30d';
    const variantQ = String(req.query.variant || '');
    // 档位：cn / ai 只看该档位；其他（含缺省 all）两个档位合并统计
    const variants = variantQ === 'cn' || variantQ === 'ai' ? [variantQ] : ['cn', 'ai'];
    res.json(
      await getStats({
        range,
        model: String(req.query.model || ''),
        force: req.query.force === '1', // 手动刷新时绕过结果缓存强制重扫
        variants,
      })
    );
  })
);

/* ---------------- 账号管理 ---------------- */

/**
 * 账号库 + 当前登录态。
 * accountsFile 指向 ~/.wb-switch/accounts.json（与 workbuddy-switch 共享同一份数据，
 * 两个工具互不干扰地读写，不会互相覆盖）。
 */
app.get('/api/accounts', (req, res) => {
  const accounts = loadAccounts();
  const current = detectCurrentAccount();
  // 附上最近一次验活结论：界面据此把「凭据有效」改成「服务端确认有效 / 已失效」，
  // 而不是只看本地有效期（2026-10-18 反馈：显示有效、切过去却登录过期）
  const verified = loadCredentialStatus();
  res.json({
    accounts: accounts.map((a) => ({ ...accountMeta(a), verify: verified[a.id] || null })),
    current: {
      variant: current.variant,
      uid: current.uid,
      exists: current.exists,
      authFilePath: current.authFilePath,
      account: current.account,
      warning: current.warning || null,
    },
    variants: VARIANT_LIST.map((v) => ({ id: v.id, label: v.label, authFilePath: authFilePath(v.id), dataRoot: dataRoot(v.id) })),
  });
});

/**
 * 切换账号：写登录态文件（内部先备份、失败回滚）。
 *
 * 两个可选动作，都由界面显式传入：
 * - `stopApp`：切换前**直接结束 WorkBuddy 的全部相关进程**（用户不必手动退出）。
 *   运行中的实例会把登录态改写回原账号，所以不关掉的话切换本来就无效；
 *   关进程后还会**重新打开** WorkBuddy，让用户拿到一个已登录新账号的客户端。
 * - `copySessionIds`：切换前把**当前登录账号**的这些会话复制给目标账号。
 *   顺序不能反——来源账号是「当前登录账号」，登录态一旦被改写就再也读不出源账号是谁。
 */
app.post(
  '/api/accounts/switch',
  wrap(async (req, res) => {
    const id = String(req.body?.id || '');
    if (!id) return res.status(400).json({ error: '缺少账号 id' });
    const ids = Array.isArray(req.body?.copySessionIds) ? req.body.copySessionIds : [];
    const stopApp = req.body?.stopApp === true;

    const target = findAccount(id);
    if (!target) return res.status(400).json({ error: '账号不存在' });

    /**
     * 0) 凭据验活兜底：本机「未过期」不代表服务端认可。
     *
     * 验活本身已经由**定时巡检**负责（每 6 小时一次，结论落盘），这里只是切换前的
     * 最后一道门：优先复用 10 分钟内的巡检结论，没有新鲜结论时才现验一次。
     * 明确被拒（401/403）就试一次刷新，仍不行就中止切换并给出可操作提示——
     * 而不是把死 token 写进去，让用户切过去才发现 WorkBuddy「登录已过期」。
     * 网络异常（非鉴权失败）不拦截：不能因为断网就不让用户切号。
     */
    const VERIFY_REUSE_MS = 10 * 60 * 1000;
    if (typeof target.access_token === 'string' && target.access_token) {
      let vs = verifyStateOf(target.id);
      if (!vs || Date.now() - Number(vs.at || 0) > VERIFY_REUSE_MS) {
        try {
          vs = await verifyAccount(target);
        } catch {
          vs = null;
        }
      }
      if (vs && !vs.valid && vs.unauthorized && target.refresh_token) {
        // 试着用 refresh_token 换一份新的（换不到就算了，失败不影响最终判定）
        try {
          await refreshAccessToken(target);
        } catch {
          /* 刷新失败按原判定处理 */
        }
        const fresh = findAccount(id);
        if (fresh) {
          try {
            vs = await verifyAccount(fresh);
          } catch {
            /* 保持原判定 */
          }
        }
      }
      if (vs && !vs.valid && vs.unauthorized) {
        return res.status(400).json({
          error:
            `账号「${accountDisplayName(target)}」的凭据已被服务端判定失效（本机显示未过期不代表服务端认可）。` +
            '请在 WorkBuddy 里重新登录该账号，然后重新导入到控制台再切换',
        });
      }
    }

    /**
     * 1)~4) 全程占会话操作互斥锁。切号里含「搬家（改会话库 + 复制账本）」与「杀/重启
     * WorkBuddy」，和 sync-all / dedupe / move 属同一类重操作——此前只有 sessions 系端点
     * 占锁，切号这条最重的写路径反而没占：切号撞上整理、或双击切号，两边会互踩
     * （重复备份、撞 SQLite 写锁、交错重启），2026-10-26 全面体检发现。
     */
    const { appStop, sessionCopy, result, killed, relaunch } = await withSessionOpLock(async () => {
      // 1) 关闭 WorkBuddy（全自动切换的第一步）。
      //    关键机制：WorkBuddy 被关闭后会被 Windows 的崩溃自动恢复拉起来，而**新实例
      //    读取的是磁盘上当前的登录态**——所以只要在「重开」发生前写好新登录态，
      //    重开出来的就是切换后账号的 WorkBuddy。这就是自动关 + 自动开成新账号。
      let appStop = null;
      let wasRunning = false;
      if (stopApp) {
        try {
          const proc = await detectWorkbuddyProcess();
          wasRunning = proc.running;
          // 把杀之前读到的真实路径传下去：进程一死就再也读不到它装在哪，
          // 后面「关掉重开」和「杀完再写库」都依赖这个路径
          if (wasRunning) appStop = await killWorkbuddy(proc.exePath);
        } catch (err) {
          throw Object.assign(new Error(`退出 WorkBuddy 失败，已中止切换：${err?.message || err}`), { status: 400 });
        }
        if (wasRunning) {
          const gone = await waitForWorkbuddyGone(4000);
          if (!gone) {
            // 4 秒没死透或已被崩溃自动恢复拉起：再杀一轮（写盘重试里还有复活守卫兜底）。
            // 之前这里对返回值看都不看，杀失败也径直往下写，登录态文件被启动中的
            // 新实例锁住，写盘重试全灭（2026-10-25 用户切号报 38 秒 EPERM 即此）
            console.log('[switch] 4 秒内 WorkBuddy 仍有进程，再结束一轮后继续');
            try {
              await killWorkbuddy(appStop?.exePath || null);
            } catch {
              /* 复活守卫还会兜底 */
            }
            await waitForWorkbuddyGone(4000);
          }
        }
      }

      /**
       * 1.5) 自动增量同步：把「此前复制过、目标账号里副本仍存在」的会话自动并入本次切换，
       *      与用户手动勾选的会话**合并**（不是二选一——2026-10-21 用户实测：手动勾了 4 个，
       *      其余 38 个已复制会话全被跳过，改名与内容都没跟过去）。只补已有副本，绝不产生新会话。
       */
      if (req.body?.autoSync !== false) {
        try {
          for (const sid of await sessionIdsNeedingSync({ targetAccountId: id })) {
            if (!ids.includes(sid)) ids.push(sid);
          }
        } catch {
          /* 源目标相同、档位不支持等：安静跳过，按「无会话需同步」处理 */
        }
      }

      // 2) 搬家：勾了「同时复制会话」就只搬勾选的（含此前已同步过的），没勾才整包搬
      let sessionCopy = null;
      try {
        sessionCopy = await moveSessionsToAccount({
          targetAccountId: id,
          ids: ids.length ? ids : null,
          sourceVariant: ['cn', 'ai'].includes(String(req.body?.sourceVariant)) ? String(req.body.sourceVariant) : null,
        });
      } catch (err) {
        throw Object.assign(new Error(`会话搬家失败，已中止切换：${err?.message || err}`), { status: 400 });
      }

      // 3) 写登录态；无论成败都不把用户的应用留在"被关掉"的状态
      let result;
      try {
        result = await switchAccount(id); // 异步：~3 分钟重试窗口，期间服务保持响应
      } catch (err) {
        await relaunchIfStopped(appStop);
        throw err;
      }

      // 4) 收尾：把「登录态切换前就已自动重开」的旧账号实例再关一次，让下一次重开
      //    读到已切换的登录态——重开出来的就是新账号的 WorkBuddy。
      //    不再固定等 8 秒再探测（探测本身也要 4~7 秒），改为直接后台拉起：
      //    已有实例时 launchWorkbuddy 会自动激活窗口而不会重复开。
      let killed = null;
      let relaunch = null;
      if (wasRunning) {
        try {
          killed = await killWorkbuddy(appStop?.exePath || null);
        } catch (err) {
          killed = { stopped: false, error: err?.message || String(err) };
        }
        relaunch = launchWorkbuddyInBackground(killed?.exePath || appStop?.exePath || null, '-switch');
      }
      return { appStop, sessionCopy, result, killed, relaunch };
    });

    console.log(
      `[switch] → ${String(target.uid || '').slice(0, 8)} 搬家 ${sessionCopy?.moved?.length || 0} 个 / 合并 ${sessionCopy?.merged?.length || 0} 个 / 失败 ${sessionCopy?.errors?.length || 0} 个` +
        ` / 登录态已写 = ${result?.ok ? 'ok' : 'fail'}` +
        (sessionCopy?.errors?.length ? ` / 首个失败：${sessionCopy.errors[0]?.error}` : '')
    );
    res.json({ ...result, sessionCopy, appStop, killed, relaunch });
  })
);

/**
 * 退出 WorkBuddy（结束后台全部相关进程）。供界面上的「退出 WorkBuddy」按钮直接调用。
 * 返回 `{ stopped, wasRunning, killed, forced, exePath }`。
 */
app.post(
  '/api/workbuddy/stop',
  wrap(async (req, res) => {
    res.json(await stopWorkbuddy());
  })
);

/** 导入本机当前登录中的账号到账号库 */
app.post(
  '/api/accounts/import',
  wrap(async (req, res) => {
    const variant = String(req.body?.variant || 'cn');
    const added = await importLocalAccount(variant);
    // 入库即验活：否则新账号要等 6 小时巡检才脱离「待验活」（2026-10-20 反馈）
    const verify = await verifyNewAccount(added?.uid || added?.id);
    res.json(verify ? { ...added, verify } : added);
  })
);

/**
 * OAuth 扫码登录：向官方申请 state，返回验证链接（前端渲染二维码）。
 * 轮询 /api/oauth/status 等待用户扫码，成功后自动采集入库。
 */
app.post(
  '/api/oauth/start',
  wrap(async (req, res) => {
    const variant = String(req.body?.variant || 'cn');
    res.json(await oauthStart(variant));
  })
);

/** 轮询扫码登录结果（loginId 由 /api/oauth/start 返回） */
app.post(
  '/api/oauth/status',
  wrap(async (req, res) => {
    const loginId = String(req.body?.loginId || '');
    if (!loginId) return res.status(400).json({ error: '缺少 loginId' });
    res.json(await oauthPoll(loginId));
  })
);

/** 删除账号（当前登录中的账号会被拒绝） */
app.delete(
  '/api/accounts/:id',
  wrap(async (req, res) => {
    res.json(await deleteAccount(String(req.params.id)));
  })
);

/** 修改账号本地备注 / 展示名来源 */
app.patch(
  '/api/accounts/:id',
  wrap(async (req, res) => {
    try {
      res.json(await updateAccountDisplay(String(req.params.id), req.body || {}));
    } catch (err) {
      res.status(400).json({ error: err?.message || '保存失败' });
    }
  })
);

/* ---------------- 会话（对话记录）复制 ---------------- */

/**
 * 列出「当前登录账号 → 目标账号」可复制的会话。
 * 只读：不写任何文件、不改数据库；供账号页的会话选择弹窗渲染。
 */
/**
 * 跨账号会话操作总闸（2026-10-29）。
 *
 * 用户实测：把会话复制/转移到其他账号后，同机的关联账号被上游风控批量封禁——
 * 风控已能识别「跨账号会话重放 + 同机多账号关联」，封的是一组而不是一个。
 * 受影响端点：copy / move / sync-all / dedupe（全部置灰，返回 403 + 原因）。
 *
 * 恢复方式：设环境变量 WB_ALLOW_CROSS_ACCOUNT=1，或把下面的 false 改回 true。
 * 前端对应开关在 src/lib/riskGates.ts，恢复时两端一起改。
 */
const CROSS_ACCOUNT_SESSION_OPS = process.env.WB_ALLOW_CROSS_ACCOUNT === '1';

function gateCrossAccount(res) {
  if (CROSS_ACCOUNT_SESSION_OPS) return false;
  res.status(403).json({
    error:
      '跨账号会话操作已临时停用：上游风控会识别跨账号会话重放并批量封禁关联账号（2026-10-29 用户实测）。' +
      '如确需使用，请阅读相关风险说明后设环境变量 WB_ALLOW_CROSS_ACCOUNT=1 重启服务。',
  });
  return true;
}

app.get(
  '/api/sessions',
  wrap(async (req, res) => {
    const target = String(req.query.accountId || '');
    if (!target) return res.status(400).json({ error: '缺少 accountId' });
    res.json(await listSessionsForSwitch({ targetAccountId: target }));
  })
);

/**
 * 把选中的会话复制给目标账号（副本用新 UUID，源账号数据不受影响）。
 *
 * `stopApp: true` 时由本工具先结束 WorkBuddy 的进程再复制，并在结束后重新打开它。
 * 进程生命周期放在这一层而不是 `copySessions` 里，是因为只有这里能保证
 * "无论复制成功还是失败都把用户的 WorkBuddy 重新打开"。
 * `copySessions` 内部仍会自查 App 是否已退出（写库前的最后一道门）。
 */
app.post(
  '/api/sessions/copy',
  wrap(async (req, res) => {
    if (gateCrossAccount(res)) return;
    const accountId = String(req.body?.accountId || '');
    if (!accountId) return res.status(400).json({ error: '缺少 accountId' });

    let appStop = null;
    if (req.body?.stopApp === true) {
      try {
        appStop = await stopWorkbuddy();
      } catch (err) {
        return res.status(400).json({ error: `退出 WorkBuddy 失败，已中止复制：${err?.message || err}` });
      }
    }
    try {
      const report = await copySessions({ targetAccountId: accountId, ids: req.body?.ids });
      res.json({ ...report, appStop, relaunch: await relaunchIfStopped(appStop) });
    } catch (err) {
      await relaunchIfStopped(appStop);
      throw err;
    }
  })
);

/**
 * 定位「汇总后自动整理」脚本。两套布局都要支持：
 *   1) 源码/开发运行：项目根目录（server/ 的上一级）
 *   2) 桌面安装版：electron-builder 的 extraResources 复制到 resources/cleanup/
 *      （asar 内的文件无法被 spawn 执行，所以必须解到真实磁盘上）
 */
function resolveCleanScript() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, '../汇总后自动整理.mjs')];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'cleanup', '汇总后自动整理.mjs'));
  }
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* 忽略单个候选的探测失败，继续下一个 */
    }
  }
  return null;
}

function kickOffStorageClean(reason = 'after-sync') {
  try {
    const script = resolveCleanScript();
    if (!script) return;
    const child = spawn(process.execPath, [script], { detached: true, stdio: 'ignore', cwd: path.dirname(script) });
    child.unref();
    console.log(`[storage-clean] 已触发（${reason}）→ ${script}`);
  } catch (e) {
    console.log('[storage-clean] 触发失败: ' + (e?.message || e));
  }
}

/**
 * 服务日志尾部（服务是隐藏启动的，用户看不到控制台输出，排查全靠这个）
 * GET /api/diag/tail?n=80
 */
app.get(
  '/api/diag/tail',
  wrap(async (req, res) => {
    const n = Math.min(500, Math.max(1, Number(req.query?.n) || 80));
    // 候选顺序：本仓库的启动方式（.workbuddy/tmp/service.log）→ 部署包的
    // deploy-windows 布局（server-detached.log 在项目上级目录或项目根）
    const candidates = [
      path.join(ROOT, '.workbuddy', 'tmp', 'service.log'),
      path.join(ROOT, '.workbuddy', 'tmp', 'service.err.log'),
      path.join(process.cwd(), '..', 'server-detached.log'),
      path.join(process.cwd(), 'server-detached.log'),
    ];
    const file = candidates.find((p) => fs.existsSync(p));
    if (!file) return res.json({ ok: false, error: '找不到日志文件', tried: candidates });
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n').filter((l) => l.trim());
    res.json({ ok: true, file, total: lines.length, lines: lines.slice(-n) });
  })
);

/**
 * 一键同步所有本机账号：内容并集取最新 + 改名跟随，已有副本原位合并、绝不重复复制。
 * fillMissing=true 时把「目标账号里从来没有」的会话也补全复制过去（全量对齐，占磁盘）。
 * stopApp=true 时由服务端先结束 WorkBuddy（写库门禁要求），完成后再重新打开。
 */
app.post(
  '/api/sessions/sync-all',
  wrap(async (req, res) => {
    if (gateCrossAccount(res)) return;
    const dryRun = req.body?.dryRun === true;
    const fillMissing = req.body?.fillMissing === true;
    const pruneOthers = req.body?.pruneOthers === true;
    // 在哪个档位的界面点汇总，就保留哪个档位的当前账号（另一个档位的会话清掉）
    const keepVariant = ['cn', 'ai'].includes(String(req.body?.variant)) ? String(req.body.variant) : null;
    // 跨档位/汇总独有会话都由 syncAllAccounts 内部完成（pruneOthers 分支），这里不再重复做
    if (dryRun) {
      res.json(await syncAllAccounts({ stopApp: false, fillMissing, pruneOthers, dryRun: true, keepVariant }));
      return;
    }
    // 默认全自动：关掉 WorkBuddy → 汇总 → 自动重新打开
    if (req.body?.stopApp !== false) {
      const { result, appStop, relaunch } = await withSessionOpLock(() =>
        withAppRestart(() => syncAllAccounts({ stopApp: false, assumeClosed: true, fillMissing, pruneOthers, dryRun: false, keepVariant }))
      );
      if (result?.ok) kickOffStorageClean('sync-all');
      res.json({ ...result, appStop, relaunch });
      return;
    }
    await assertAppClosed();
    const result = await withSessionOpLock(() =>
      syncAllAccounts({ stopApp: false, fillMissing, pruneOthers, dryRun: false, keepVariant })
    );
    if (result?.ok) kickOffStorageClean('sync-all');
    res.json({ ...result, relaunch: null });
  })
);

/**
 * 搬家式转移：把当前账号的会话「过户」给目标账号——不复制、磁盘零增长。
 * 目标账号已有同一对话时先合并内容（取全）再移走源正文；需要 WorkBuddy 已退出。
 */
app.post(
  '/api/sessions/move',
  wrap(async (req, res) => {
    if (gateCrossAccount(res)) return;
    const targetAccountId = String(req.body?.targetAccountId || '').trim();
    if (!targetAccountId) throw Object.assign(new Error('缺少目标账号'), { status: 400 });
    const dryRun = req.body?.dryRun === true;
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : null;
    const sourceVariant = ['cn', 'ai'].includes(String(req.body?.sourceVariant)) ? String(req.body.sourceVariant) : null;
    if (dryRun) {
      res.json(await moveSessionsToAccount({ targetAccountId, ids, dryRun: true, sourceVariant }));
      return;
    }
    if (req.body?.stopApp !== false) {
      const { result, appStop, relaunch } = await withSessionOpLock(() =>
        withAppRestart(() => moveSessionsToAccount({ targetAccountId, ids, sourceVariant }))
      );
      logMove(result, targetAccountId);
      res.json({ ...result, appStop, relaunch });
      return;
    }
    await assertAppClosed();
    const result = await withSessionOpLock(() => moveSessionsToAccount({ targetAccountId, ids, sourceVariant }));
    logMove(result, targetAccountId);
    res.json({ ...result, relaunch: null });
  })
);

/**
 * 一键去重：同账号内同一家族的多余副本，合并进最完整的一份后软删除多余者；
 * 复制账本同步改写，此后同步永远原位合并、不再产生重复。dryRun=预演不写入。
 * 写库需要 WorkBuddy 冻结：stopApp=true 时先冻结、完成后再结束（崩溃恢复自动
 * 拉起新实例，登录态不变，等同于「重启了一次 WorkBuddy」）。
 */
app.post(
  '/api/sessions/dedupe',
  wrap(async (req, res) => {
    if (gateCrossAccount(res)) return;
    const dryRun = req.body?.dryRun === true;
    // 冻结方案已废除（冻结会把宿主进程一起冻住，用户系统卡死）。
    // 现在只做门禁：WorkBuddy 在运行就拒绝并提示用户手动退出（托盘右键退出）。
    const appStop = null;
    if (dryRun) {
      res.json(await dedupeSessions({ dryRun: true }));
      return;
    }
    if (req.body?.stopApp !== false) {
      const { result, appStop, relaunch } = await withSessionOpLock(() =>
        withAppRestart(() => dedupeSessions({ dryRun: false }))
      );
      res.json({ ...result, appStop, relaunch });
      return;
    }
    await assertAppClosed();
    const result = await withSessionOpLock(() => dedupeSessions({ dryRun: false }));
    res.json({ ...result, relaunch: null });
  })
);

/* ---------------- 积分统计 ---------------- */

/**
 * 只查积分余额（含积分包明细），供账号页卡片渲染。
 * 不扫用量明细，比 /api/credits 快得多；进程内缓存 2 分钟。
 */
/**
 * 每个账号「今日是否已签到 / 是否已旅行」——账号卡片上的两个状态小标。
 * 只查询官方状态接口，不执行任何签到/旅行动作；结果缓存 5 分钟。
 */
let dailyStatusCache = { at: 0, data: null };
app.get(
  '/api/accounts/daily-status',
  wrap(async (req, res) => {
    const force = req.query?.refresh === '1';
    // 缓存 10 分钟：这是纯展示用的状态小标，没必要 5 分钟一刷官方接口
    if (!force && dailyStatusCache.data && Date.now() - dailyStatusCache.at < 10 * 60 * 1000) {
      res.json(dailyStatusCache.data);
      return;
    }
    const list = loadAccounts().filter((a) => a?.uid && hasPlainToken(a));
    // 防风控：原来 N 账号 × 2 接口全部 Promise.all 并发（同 IP 一波 6+ 请求，典型批量指纹），
    // 改成逐账号串行、账号间隔 400ms；接口总数少（2/账号），串行代价可接受
    const entries = [];
    for (const a of list) {
      if (entries.length > 0) await new Promise((r) => setTimeout(r, 400));
      const c = await fetchCheckinStatus(a).catch(() => null);
      const tr = await fetchTravelStatus(a).catch(() => null);
      entries.push([
        String(a.id || a.uid),
        {
          checkedIn: !!c?.todayCheckedIn,
          traveled: !!tr?.traveled,
          travelState: tr?.state || null,
          travelDailyLimit: !!tr?.dailyLimit,
          travelReward: Number(tr?.reward || 0),
          checkinError: c && c.ok === false ? String(c.error || '查询失败') : null,
          travelError: tr && tr.ok === false ? String(tr.error || '查询失败') : null,
        },
      ]);
    }
    const data = { accounts: Object.fromEntries(entries), at: Date.now() };
    dailyStatusCache = { at: Date.now(), data };
    res.json(data);
  })
);

/**
 * 每个账号「当前额度超限的模型」+ 恢复时间。
 * 数据源：该账号最近会话日志里的官方 429 报错（含「将在 xxx 重置」）。
 * 只返回「恢复时间还在未来」的记录；结果缓存 3 分钟。
 */
/**
 * 每个账号「当前额度超限的模型」+ 恢复时间。
 * 数据源：**当场探测** —— 用该账号的登录态对「它最近用过的模型」发一次 max_tokens=1 的请求，
 * 上游回 429 且带重置时间才算超限（见 workbuddy/modelLimits.mjs）。结果缓存 10 分钟。
 */
app.get(
  '/api/accounts/model-limits',
  wrap(async (req, res) => {
    // 每个账号当场发一次最小请求探测，结果缓存 10 分钟（见 modelLimits.mjs）
    res.json(await probeAllModelLimits({ refresh: req.query?.refresh === '1' }));
  })
);

app.get(
  '/api/accounts/credits',
  wrap(async (req, res) => {
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    res.json(await getAccountBalances({ refresh }));
  })
);

/**
 * 单账号的逐笔积分明细（官方客户端「积分明细」弹窗的数据源）。
 * 进程内缓存 5 分钟；?refresh=1 强制重打官方接口。
 */
app.get(
  '/api/accounts/credit-details',
  wrap(async (req, res) => {
    const id = String(req.query.id || '').trim();
    if (!id) throw Object.assign(new Error('缺少账号 id'), { status: 400 });
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    res.json(await getCreditDetails({ accountId: id, refresh }));
  })
);

/** 官方逐请求用量投影（按日 / 按模型 / 按账号聚合） */
app.get(
  '/api/credits',
  wrap(async (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const variant = ['cn', 'ai'].includes(String(req.query.variant)) ? String(req.query.variant) : 'all';
    res.json(await getCreditStatistics({ days, refresh, variant }));
    // 后台把另外两个区间也算好，用户切 7/30/90 时直接命中缓存
    prefetchCreditRanges({ variant, days });
  })
);

/** 本地快照离线投影（官方接口不可用时的兜底） */
app.get('/api/credits/offline', (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
  res.json(getOfflineCreditProjection({ days }));
});

/* ---------------- 设置 ---------------- */

function readCacheInfos() {
  return listPlatforms()
    .map((p) => {
      try {
        const raw = JSON.parse(fs.readFileSync(modelsCacheFile(p.id), 'utf8'));
        if (Array.isArray(raw?.models) && raw.models.length) {
          return { platform: p.id, platformName: p.name, fetchedAt: raw.fetchedAt, count: raw.count };
        }
      } catch {
        /* 无缓存 */
      }
      return null;
    })
    .filter(Boolean);
}

app.get(
  '/api/settings',
  wrap(async (req, res) => {
    const cfg = loadConfig();
    res.json({
      workbuddyDir: cfg.settings.workbuddyDir || '',
      workbuddyInstallDir: cfg.settings.workbuddyInstallDir || '',
      workbuddyExePath: cfg.settings.workbuddyExePath || '',
      // 自动定位到的客户端 exe（只读展示：找不到时用户才知道该去填安装目录）
      detectedExe: findWorkbuddyExe(null, { registry: false }) || null,
      proxyUrl: cfg.settings.proxyUrl || '',
      autoCheckin: !!cfg.settings.autoCheckin,
      autoRefreshToken: !!cfg.settings.autoRefreshToken,
      autoCheckUpdate: !!cfg.settings.autoCheckUpdate,
      unlockAllPlatforms: !!cfg.settings.unlockAllPlatforms,
      effectiveProxy: await getProxyUrl(),
      detected: detectWorkbuddyDir(),
      cacheDir: cachePath(''),
      modelsCaches: readCacheInfos(),
    });
  })
);

app.put(
  '/api/settings',
  wrap(async (req, res) => {
    const cfg = loadConfig();
    if (typeof req.body?.workbuddyDir === 'string') {
      cfg.settings.workbuddyDir = req.body.workbuddyDir.trim();
    }
    if (typeof req.body?.workbuddyInstallDir === 'string') {
      cfg.settings.workbuddyInstallDir = req.body.workbuddyInstallDir.trim();
    }
    if (typeof req.body?.workbuddyExePath === 'string') {
      cfg.settings.workbuddyExePath = req.body.workbuddyExePath.trim();
    }
    if (typeof req.body?.proxyUrl === 'string') {
      cfg.settings.proxyUrl = req.body.proxyUrl.trim();
    }
    if (typeof req.body?.autoCheckin === 'boolean') {
      cfg.settings.autoCheckin = req.body.autoCheckin;
    }
    if (typeof req.body?.autoRefreshToken === 'boolean') {
      cfg.settings.autoRefreshToken = req.body.autoRefreshToken;
    }
    if (typeof req.body?.autoCheckUpdate === 'boolean') {
      cfg.settings.autoCheckUpdate = req.body.autoCheckUpdate;
    }
    if (typeof req.body?.unlockAllPlatforms === 'boolean') {
      cfg.settings.unlockAllPlatforms = req.body.unlockAllPlatforms;
    }
    // 设置页每次切换开关都会走这里：必须异步落盘，否则写盘卡顿期间整个界面都超时
    const saveMs = await saveConfigAsync(cfg);
    if (saveMs > 2000) console.log(`[settings] 保存设置耗时 ${saveMs}ms`);
    res.json({
      ok: true,
      workbuddyDir: cfg.settings.workbuddyDir,
      workbuddyInstallDir: cfg.settings.workbuddyInstallDir || '',
      workbuddyExePath: cfg.settings.workbuddyExePath || '',
      detectedExe: findWorkbuddyExe(null, { registry: false }) || null,
      proxyUrl: cfg.settings.proxyUrl,
      autoCheckin: !!cfg.settings.autoCheckin,
      autoRefreshToken: !!cfg.settings.autoRefreshToken,
      autoCheckUpdate: !!cfg.settings.autoCheckUpdate,
      unlockAllPlatforms: !!cfg.settings.unlockAllPlatforms,
      effectiveProxy: await getProxyUrl(),
      detected: detectWorkbuddyDir(),
    });
  })
);

// 重新自动检测 WorkBuddy 数据目录（并附带运行状态）
app.get(
  '/api/workbuddy/detect',
  wrap(async (req, res) => {
    const detected = detectWorkbuddyDir();
    const proc = await detectWorkbuddyProcess();
    res.json({
      detected,
      running: proc.running,
      exePath: proc.exePath || null,
      detectError: proc.error || null,
      detectMethod: proc.method || null,
    });
  })
);

app.post('/api/cache/clear', (req, res) => {
  clearModelsCache(String(req.body?.platform || '')); // 空字符串 = 清全部平台
  res.json({ ok: true });
});

/* ---------------- 版本自检 ---------------- */

app.get(
  '/api/app/update',
  wrap(async (req, res) => {
    const cfg = loadConfig();
    // 关掉自动检查时不发起任何出站请求，前端据此只显示版本号、不显示升级按钮
    if (!cfg.settings.autoCheckUpdate) {
      res.json({
        ok: true,
        disabled: true,
        current: LOCAL_VERSION,
        latest: null,
        hasUpdate: false,
        releaseUrl: null,
        downloadUrl: null,
        assetName: null,
        publishedAt: null,
        notes: '',
        checkedAt: null,
        cached: false,
        error: null,
      });
      return;
    }
    res.json(await checkForUpdate({ force: false }));
  })
);

// 手动「检查更新」是一次明确的授权动作，即使关掉了自动检查也照做
app.post(
  '/api/app/update/check',
  wrap(async (req, res) => {
    res.json(await checkForUpdate({ force: true }));
  })
);

/* ---------------- 凭据自动刷新（巡检 + 接口） ---------------- */

/** 巡检间隔：6 小时。判据本身是"临期才动手"，这里只负责定期来看一眼 */
const TOKEN_REFRESH_PATROL_MS = 6 * 60 * 60 * 1000;
let tokenRefreshBusy = false;
let tokenRefreshTimer = null;

app.get(
  '/api/accounts/refresh',
  wrap(async (req, res) => {
    const cfg = loadConfig();
    res.json({
      autoRefreshToken: !!cfg.settings.autoRefreshToken,
      intervalHours: TOKEN_REFRESH_PATROL_MS / 3_600_000,
      accessMinHours: ACCESS_MIN_HOURS,
      refreshMinHours: REFRESH_MIN_HOURS,
      accounts: refreshPlan(),
      lastRun: lastRefreshRun(),
      logs: loadRefreshLogs().slice(0, 30),
    });
  })
);

// 手动刷新：不传 accountId 就处理全部账号；force 跳过临期判定（用户明确要求刷）
app.post(
  '/api/accounts/refresh',
  wrap(async (req, res) => {
    const accountId = req.body?.accountId ? String(req.body.accountId) : '';
    const force = req.body?.force === true || req.body?.force === '1';
    const { results, summary } = await refreshAccounts({
      accountIds: accountId ? [accountId] : null,
      force,
    });
    res.json({ ok: true, results, summary });
  })
);

/**
 * 巡检防风控：账号间隔。官方对「短窗口内多账号同 IP 操作」会判定批量营销号踢下线
 * （2026-10-23 用户实测凭据被批量失效），巡检类自动化一律顺序执行、账号间隔分钟级；
 * 手动单账号操作不受影响。跳过类账号（无调用）不占间隔。
 */
const PATROL_ACCOUNT_STAGGER_MS = 3 * 60_000;

async function runTokenRefreshPatrol({ silent = false } = {}) {
  if (tokenRefreshBusy) return null;
  if (!loadConfig().settings.autoRefreshToken) return null;
  tokenRefreshBusy = true;
  try {
    const { results, summary } = await refreshAccounts({ delayMs: PATROL_ACCOUNT_STAGGER_MS });
    // 平时（没有临期账号）完全静默：这类巡检不该在日志里刷存在感
    if (summary.refreshed || summary.failed || (!silent && summary.dead)) {
      console.log(
        `[refresh] 凭据巡检：验活有效 ${summary.verified ?? 0}、刷新 ${summary.refreshed}、跳过 ${summary.skipped}、失败 ${summary.failed}、需重新登录 ${summary.dead}` +
          ((summary.invalid ?? 0) > 0 ? `（其中 ${summary.invalid} 个被服务端判定失效）` : '')
      );
      for (const r of results.filter((x) => x.action === 'failed')) {
        console.error(`[refresh] 「${r.accountName}」刷新失败：${r.message}`);
      }
    }
    return summary;
  } catch (e) {
    console.error('[refresh] 凭据巡检出错:', e?.message || e);
    return null;
  } finally {
    tokenRefreshBusy = false;
  }
}

/** 启动巡检：先延迟 60 秒（不与启动时的其它初始化抢网络），之后每 6 小时一次 */
function startTokenRefreshPatrol() {
  if (tokenRefreshTimer) clearInterval(tokenRefreshTimer);
  setTimeout(() => runTokenRefreshPatrol({ silent: true }), 60_000);
  tokenRefreshTimer = setInterval(runTokenRefreshPatrol, TOKEN_REFRESH_PATROL_MS);
}

startTokenRefreshPatrol();

/* ---------------- 版本定时自检 ---------------- */

/**
 * 版本定时自检：每小时**主动**刷新一次远端版本信息（force，不吃 6 小时缓存）。
 *
 * 早先只有界面挂载时才查一次，控制台常年驻留后台的用户永远等不到升级按钮——
 * 只有下次重启才看得见新版本（2026-10-18 用户反馈）。现在由服务端定时刷新缓存，
 * 界面侧再定时取一次缓存结果，升级按钮不重启也能出现。
 *
 * 限流：GitHub 未认证接口每小时 60 次，这里每小时 1 次，余量充足；
 * 关掉「自动检查更新」后整体不工作，也不发起任何出站请求。
 */
const UPDATE_PATROL_MS = 60 * 60 * 1000;
let updatePatrolBusy = false;
let updatePatrolTimer = null;

async function runUpdatePatrol() {
  if (updatePatrolBusy) return;
  if (!loadConfig().settings.autoCheckUpdate) return;
  updatePatrolBusy = true;
  try {
    const r = await checkForUpdate({ force: true });
    if (r?.ok && r.hasUpdate) {
      console.log(`[update] 发现新版本 v${r.latest}（当前 v${r.current}），升级按钮已就绪`);
    }
  } catch (e) {
    // 网络抖动/限流都算常态，不打扰用户
    console.error('[update] 定时检查出错:', e?.message || e);
  } finally {
    updatePatrolBusy = false;
  }
}

function startUpdatePatrol() {
  if (updatePatrolTimer) clearInterval(updatePatrolTimer);
  // 启动 1 分钟后先查一次（首屏自己也会查，这里让缓存尽快就位），之后每小时一次
  setTimeout(runUpdatePatrol, 60_000);
  updatePatrolTimer = setInterval(runUpdatePatrol, UPDATE_PATROL_MS);
}

startUpdatePatrol();

/* ---------------- 自动签到巡检 ---------------- */

/** 巡检间隔：每小时检查一次，跨天自然覆盖（签到本身幂等，重复调用无副作用） */
const CHECKIN_PATROL_MS = 60 * 60 * 1000;
let checkinPatrolBusy = false;
let checkinPatrolTimer = null;

async function runCheckinPatrol({ ignoreQuietHours = false } = {}) {
  if (checkinPatrolBusy) return;
  const cfg = loadConfig();
  if (!cfg.settings.autoCheckin) return;
  // 小时级巡检只在 06:00–23:00 之间进行，避免深夜反复打扰官方接口；
  // 启动触发的那一次（ignoreQuietHours）不受此限——用户要求启动即领，而不是等到固定时间
  const hour = new Date().getHours();
  if (!ignoreQuietHours && (hour < 6 || hour >= 23)) return;
  checkinPatrolBusy = true;
  try {
    // 两道门禁：签到 + 成长中心（签到早满了也不影响成长中心的旅行/任务/补登/兑换/盲盒）
    if ((await allCheckedInToday()) && allGrowthDoneToday()) return;
    // 签到同样防风控：单并发顺序执行，账号间间隔 3 分钟（手动批量签到不传，保持原并发）
    const { summary, results } = await checkinAll({
      onlyPending: true,
      skipGrowthIfDoneToday: true,
      staggerMs: PATROL_ACCOUNT_STAGGER_MS,
    });
    const failed = results.filter((r) => r.action === 'failed');
    console.log(
      `[checkin] 自动巡检完成：签到 ${summary.checked}、已签到 ${summary.already}、失败 ${summary.failed}` +
        (summary.growthCredits ? `、成长中心 +${summary.growthCredits} 积分` : '') +
        (failed.length ? `（${failed.map((f) => f.account?.name || f.account?.uid).join(', ')}）` : '')
    );
  } catch (e) {
    console.error('[checkin] 自动巡检出错:', e?.message || e);
  } finally {
    checkinPatrolBusy = false;
  }
}

/**
 * 启动巡检：先延迟 30 秒（等界面加载完），之后每小时一次。
 *
 * **每次启动必领一次**且不受夜间窗口限制（用户要求 2026-10-17）：
 * 早先那次启动巡检走 06:00–23:00 时间窗，深夜/凌晨启动会被直接跳过，
 * 积分要等到早上 6 点后的某次整点巡检才领到——变成"固定等时间"而不是"启动即领"。
 * 幂等门禁（今天已签到且成长任务已完成就直接返回）保证重复启动不会重复请求。
 */
function startCheckinPatrol() {
  if (checkinPatrolTimer) clearInterval(checkinPatrolTimer);
  setTimeout(() => runCheckinPatrol({ ignoreQuietHours: true }), 30_000);
  checkinPatrolTimer = setInterval(runCheckinPatrol, CHECKIN_PATROL_MS);
}

startCheckinPatrol();

// 反向代理已开启时，启动时预热一次模型缓存（失败不阻塞启动，页面可手动刷新）
if (loadConfig().proxy?.enabled) refreshModelsCache().catch(() => {});

/* ---------------- 反向代理（OpenAI 兼容，供其他 agent 调用） ---------------- */

// 必须挂在静态资源与 SPA 兜底之前，否则 /v1/* 会被 index.html 吃掉
registerProxyRoutes(app, { port: PORT });

/* ---------------- 静态资源 + SPA ---------------- */

app.use(express.static(DIST));
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(DIST, 'index.html'));
});

const onListening = () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`workbuddy控制台已启动: ${url}`);
  // 后台预热统计缓存：冷扫描要遍历全部会话日志（几十秒），
  // 启动后先算一遍，用户点「统计」时直接命中缓存，不再等。
  setTimeout(() => {
    getStats({ range: '30d', model: '', variants: ['cn', 'ai'] }).catch(() => {});
  }, 2000);
  // 预热超限探测（每个账号要发 1-2 个探测请求，3 秒左右），打开页面时直接有结果
  setTimeout(() => {
    probeAllModelLimits({ refresh: true }).catch(() => {});
  }, 4000);
  if (process.env.NO_OPEN !== '1') {
    const cmd =
      process.platform === 'win32'
        ? spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' })
        : process.platform === 'darwin'
          ? spawn('open', [url], { detached: true, stdio: 'ignore' })
          : spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    cmd.unref();
  }
};

/**
 * 端口被占（已经有一个控制台在跑）时**干净退出**。
 *
 * 不处理的话 `listen` 的 error 事件会走 uncaughtException 保命处理器（见文件开头），
 * 进程既不监听也不退出——变成一个僵尸：定时巡检、签到、模型探测照跑，
 * 于是官方接口被两个实例各调一遍（实测 2026-10-25 手动重启时踩到）。
 */
const httpServer = app.listen(PORT, '127.0.0.1', onListening);
httpServer.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.log(`端口 ${PORT} 已被占用：已有一个控制台在运行，本进程退出（不会再重复跑定时任务）`);
    process.exit(0);
  }
  console.error('[listen] 监听失败：', err?.message || err);
  process.exit(1);
});

/*
 * 同时监听 IPv6 环回。
 *
 * 只绑 127.0.0.1 时，把 `localhost` 解析成 `::1` 的客户端（本机 ping localhost 就是
 * ::1）会连不上：实测 `http://[::1]:57891/...` 返回 HTTP 000。现象是「反向代理用不了」，
 * 而且**连一条请求日志都不会有** —— 请求根本没到进程里，最容易被误判成代理坏了。
 *
 * 两个地址都只在环回范围内，不增加对外暴露面。绑不上（机器禁用 IPv6）只提示、不影响 IPv4。
 */
if (process.env.NO_IPV6 !== '1') {
  const server6 = http.createServer(app);
  server6.on('error', (err) => {
    console.warn(`IPv6 环回监听失败（不影响 IPv4 访问）: ${err?.code || err?.message}`);
  });
  server6.listen(PORT, '::1');
}
