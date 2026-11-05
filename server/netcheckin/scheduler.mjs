/**
 * 全网签到的进程内定时器。
 *
 * 控制台本身就是常驻进程（桌面版随系统启动），所以不需要再装系统计划任务：
 * 每分钟看一次表，到了「设定时间 + 当日随机延迟」就自动跑一轮。
 *
 * 随机延迟：以日期为种子做确定性哈希——同一天内每次 tick 算出的延迟一致
 * （不会因为每分钟都看表而漂移），不同天不同。这是真实的防风控措施：
 * 每天同一秒请求平台是最容易被识别的机器特征。
 *
 * 补领逻辑：每小时检查一次「今天还有没有平台没领」——过点没跑成（关机/睡眠、
 * 网络抖动、平台超时）的，下一个整点检查发现后自动补跑；启动后 30 秒也做一次
 * 同样的检查。幂等门禁在 runner 里（已完成的平台自动跳过），补跑不会重复签到。
 *
 * 节流：两次自动运行至少间隔一小时，节拍本身就是「每小时一次」。全领完了就
 * 不再动。深夜 23:00 后不自动跑，避免打扰风控敏感时段。
 */

import { loadConfig } from './store.mjs';
import { runNetCheckin, allDoneToday, netCheckinBusy, pushLog } from './runner.mjs';

const TICK_MS = 60_000;
const RETRY_GAP_MS = 60 * 60_000; // 两次自动运行至少隔一小时：补跑检查的节奏就是每小时一次
const QUIET_AFTER_HOUR = 23; // 23:00 后不再自动跑

const sched = {
  timer: null,
  lastAutoRunAt: 0,
  busy: false,
};

function todayAt(timeStr, day = new Date()) {
  const [h, m] = String(timeStr || '10:00').split(':').map(Number);
  const d = new Date(day);
  d.setHours(h || 0, m || 0, 0, 0);
  return d;
}

/** 当天的随机延迟（毫秒）：以「日期+设定时间」为种子的确定性哈希，同天恒定、隔天不同 */
export function dailyJitterMs(cfg, day = new Date()) {
  const cap = Math.max(0, Math.min(120, Number(cfg.schedule.jitterMinutes) || 0));
  if (!cap) return 0;
  const key = `${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}@${cfg.schedule.time}`;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return Math.round(((h % 10_000) / 10_000) * cap * 60_000);
}

/** 下一个自动窗口（给 UI 显示用）：今天没过就是今天的时间，过了就是明天；含当日随机延迟 */
export function nextWindowAt() {
  const cfg = loadConfig();
  if (!cfg.schedule.enabled) return null;
  let day = new Date();
  let next = todayAt(cfg.schedule.time, day);
  if (next.getTime() <= Date.now()) {
    day = new Date(day.getTime() + 86_400_000);
    next = todayAt(cfg.schedule.time, day);
  }
  return next.getTime() + dailyJitterMs(cfg, next);
}

async function tick({ startupCatchUp = false } = {}) {
  if (sched.busy) return;
  // 手动签到/登录窗口正在占用浏览器时不打扰：只跳过本轮 tick，不改 lastAutoRunAt
  if (netCheckinBusy()) return;
  const cfg = loadConfig();
  if (!cfg.schedule.enabled) return;

  const now = Date.now();
  const plannedAt = todayAt(cfg.schedule.time).getTime() + dailyJitterMs(cfg);
  const hour = new Date().getHours();

  // 主窗口：过了「设定时间 + 当日随机延迟」就到了；之后的整点检查负责补跑
  const due = now >= plannedAt;
  if (!due) return;
  // 夜间安静时段：既不首跑也不重试（启动补领例外一次，用户要求启动即领）
  if (hour >= QUIET_AFTER_HOUR && !startupCatchUp) return;
  // 幂等：全领完了就不动
  if (await allDoneToday()) return;
  // 补跑节流：一小时内的检查里不再重复触发，节奏就是每小时一次
  if (sched.lastAutoRunAt && now - sched.lastAutoRunAt < RETRY_GAP_MS) return;

  sched.busy = true;
  sched.lastAutoRunAt = now;
  try {
    pushLog('info', startupCatchUp ? '启动检查：发现今天还有平台未领取，自动补跑' : '到达设定的领取时间，开始自动领取');
    await runNetCheckin({ source: 'auto', dryRun: false });
  } catch (e) {
    pushLog('err', `自动代领异常: ${String(e?.message || e).split('\n')[0]}`);
  } finally {
    sched.busy = false;
  }
}

/** 服务启动时调用：30 秒后做一次启动补领，然后每分钟巡检。
 *  NO_NETCHECKIN_AUTO=1 可整体关闭自动调度（自动化测试里防止测试机真去打平台）。 */
export function startNetCheckinScheduler() {
  if (process.env.NO_NETCHECKIN_AUTO === '1') return;
  if (sched.timer) clearInterval(sched.timer);
  setTimeout(() => {
    tick({ startupCatchUp: true }).catch(() => {});
  }, 30_000);
  sched.timer = setInterval(() => {
    tick().catch(() => {});
  }, TICK_MS);
}
