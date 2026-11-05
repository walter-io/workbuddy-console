/**
 * 全网签到页共享的类型与呈现工具：总览页和平台子页面都用这一份，
 * 避免两处各写一套状态颜色/文案导致对不上。
 */

export type CheckStatus =
  | 'success'
  | 'already'
  | 'needs_login'
  | 'not_installed'
  | 'needs_manual'
  | 'offline'
  | 'timeout'
  | 'not_found'
  | 'uncertain'
  | 'failed'
  | 'error'
  | 'busy'
  | 'dry_run'
  | null;

export interface NetPlatform {
  id: string;
  name: string;
  kind: 'web' | 'client';
  engine: string;
  category: 'chat' | 'code' | 'video' | 'art';
  enabled: boolean;
  reward: string;
  notes: string;
  homepage: string;
  loginUrl: string;
  headed: boolean;
  visitClaim: boolean;
  claimViaApp: boolean;
  appOnlyNote: string;
  clientExe: string;
  clientRunning: boolean;
  lastStatus: CheckStatus;
  lastDetail: string;
  lastTs: number | null;
  todayDone: boolean;
  streak: number;
  /** 该平台最近一次登录成功的记账时间（登录窗口保存） */
  lastLoginAt: number | null;
  /** 最近一次查询到的积分余额（平台没报过数就是 null） */
  credits: number | null;
  /** 历史累计到账（只在引擎报过数时才有值） */
  totalGained: number | null;
  /** 累计成功领取次数 */
  successCount: number;
  needsLogin: boolean;
  matrix: Record<string, CheckStatus>;
}

export interface ResultRow {
  id: string;
  name: string;
  status: string;
  detail: string;
  ts: number;
  date: string;
  dryRun: boolean;
  credits: number | null;
  gain: number | null;
}

export interface ManualPlatform {
  id: string;
  name: string;
  category: 'chat' | 'code' | 'video' | 'art';
  reward: string;
  why: string;
  homepage: string;
}

export interface NetState {
  platforms: NetPlatform[];
  schedule: { enabled: boolean; time: string; jitterMinutes: number };
  running: boolean;
  /** 正在执行中的平台 id（含批量与单平台）：行级按钮按它禁用，其它平台不受影响 */
  activeIds: string[];
  runSource: 'manual' | 'auto' | null;
  runId: number | null;
  nextWindowAt: number | null;
  lastRun: { ts: number; date: string; total: number; done: number } | null;
  totals: { claims: number };
  trial: Record<string, { status: string; detail: string }> | null;
  /** 最近 200 条正式运行流水（新→旧），领取记录表的数据源 */
  recentResults: ResultRow[];
  manualPlatforms: ManualPlatform[];
}

export interface LogRow {
  seq: number;
  ts: number;
  level: 'info' | 'ok' | 'warn' | 'err';
  text: string;
}

export interface LoginStatus {
  id: string | null;
  name: string;
  stage: 'idle' | 'waiting' | 'success' | 'failed' | 'timeout' | 'cancelled';
  message: string;
}

export const STATUS_LABEL: Record<string, string> = {
  success: '已到账',
  already: '今日已领',
  needs_login: '登录失效',
  not_installed: '客户端未装',
  needs_manual: '待重启客户端',
  offline: '网络不通',
  timeout: '等待超时',
  not_found: '入口未命中',
  uncertain: '结果存疑',
  failed: '未成功',
  error: '执行异常',
  busy: '浏览器忙',
  dry_run: '检测通过',
};

/** 行内状态文字的颜色：到账用青绿、受阻用琥珀、失败用玫红 */
export function statusTextCls(status: CheckStatus | string): string {
  if (status === 'success' || status === 'already') return 'text-teal-600';
  if (status === 'failed' || status === 'error' || status === 'timeout') return 'text-rose-600';
  if (status === 'needs_login' || status === 'needs_manual' || status === 'not_found' || status === 'uncertain' || status === 'busy')
    return 'text-amber-600';
  return 'text-zinc-400';
}

/** 行内状态前的圆点：先色后字，扫一眼就知道哪几行卡住了 */
export function statusDotCls(status: CheckStatus | string): string {
  if (status === 'success' || status === 'already') return 'bg-teal-500';
  if (status === 'failed' || status === 'error' || status === 'timeout') return 'bg-rose-500';
  if (status === 'needs_login' || status === 'needs_manual' || status === 'not_found' || status === 'uncertain' || status === 'busy')
    return 'bg-amber-500';
  return 'bg-zinc-300';
}

/** 平台类别：标签文字与徽章配色（模型=蓝、编程=紫、视频=红、美术=绿） */
export const CATEGORY_META: Record<string, { label: string; color: string }> = {
  chat: { label: '模型', color: 'blue' },
  code: { label: '编程', color: 'violet' },
  video: { label: '视频', color: 'red' },
  art: { label: '美术', color: 'green' },
};

/** 类别的清单排序权重：模型 → 编程 → 视频 → 美术 */
export const CATEGORY_ORDER: Record<string, number> = { chat: 0, code: 1, video: 2, art: 3 };

/** 平台头像块：首字 + 固定配色，同 id 永远同色 */
const AVATAR_TONES: Record<string, string> = {
  doubao: 'bg-rose-50 text-rose-600',
  'trae-cn': 'bg-indigo-50 text-indigo-600',
  'qoder-cn': 'bg-sky-50 text-sky-600',
  zhipu: 'bg-violet-50 text-violet-600',
  minimax: 'bg-amber-50 text-amber-600',
  wanxiang: 'bg-emerald-50 text-emerald-600',
  coze: 'bg-blue-50 text-blue-600',
  jimeng: 'bg-cyan-50 text-cyan-700',
  liblib: 'bg-orange-50 text-orange-700',
  vidu: 'bg-lime-50 text-lime-700',
  pixverse: 'bg-sky-50 text-sky-700',
  tusiart: 'bg-pink-50 text-pink-700',
  comate: 'bg-cyan-50 text-cyan-700',
};
const FALLBACK_TONES = ['bg-indigo-50 text-indigo-600', 'bg-violet-50 text-violet-600', 'bg-sky-50 text-sky-600', 'bg-emerald-50 text-emerald-600'];

export function avatarCls(id: string): string {
  if (AVATAR_TONES[id]) return AVATAR_TONES[id];
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return FALLBACK_TONES[h % FALLBACK_TONES.length];
}

export const fmtClock = (ts: number) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });

/** 14 天矩阵里一天的小色点 */
export function matrixDotCls(status: CheckStatus | string): string {
  if (status === 'success' || status === 'already') return 'bg-teal-500';
  if (status === 'failed' || status === 'error' || status === 'timeout') return 'bg-rose-400';
  if (status && status !== 'offline') return 'bg-amber-400';
  if (status === 'offline') return 'bg-zinc-300';
  return 'bg-zinc-200';
}
