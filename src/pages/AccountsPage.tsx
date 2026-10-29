import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  IconArrowDown,
  IconCheck,
  IconClock,
  IconCopy,
  IconEdit,
  IconExternalLink,
  IconInfo,
  IconPower,
  IconQrCode,
  IconRefresh,
  IconSearch,
  IconSparkles,
  IconSwitch,
  IconTrash,
  IconUser,
  IconUsers,
  IconWarning,
  Modal,
  Hint,
  SectionHeader,
  Segmented,
  Skeleton,
  Spinner,
  Toolbar,
  useConfirm,
  useToast,
} from '../components/ui';
import { del, get, patch, post, TIMEOUT } from '../lib/api';
import { BRAND_MARKS } from '../lib/modelBrands';
import { CROSS_ACCOUNT_OPS_REASON, CROSS_ACCOUNT_SESSION_OPS_DISABLED } from '../lib/riskGates';
import { BanRiskGuide } from '../components/BanRiskGuide';
import { fmtDateTime } from '../lib/format';
import type {
  AccountBalancesResponse,
  AccountInfo,
  AccountRefreshRunResponse,
  AccountsResponse,
  AppStopResult,
  CreditBalance,
  CreditDetailsResponse,
  CreditPackage,
  LoadedInfo,
  OAuthPollResult,
  OAuthStartResult,
  SessionCopyReport,
  SessionListResponse,
  RelaunchResult,
  SwitchAccountResult,
  VariantInfo,
} from '../lib/types';

/**
 * 把「重开 WorkBuddy」的结果翻成一句人话，三种状态必须分开：
 * - 成功发起且确认进程在 → 已自动重新打开
 * - 发起成功但没能确认（安全软件拦截/启动慢）→ 明确说"未能确认"，别谎报成功
 * - 压根没发起成功 → 报失败并带上原因（老版本只说"重新打开失败"，用户看不出为什么）
 */
function relaunchTail(relaunch: RelaunchResult | null | undefined, stopped: boolean) {
  if (!relaunch) return stopped ? '请重新打开 WorkBuddy' : '';
  if (relaunch.launched === false) {
    return `WorkBuddy 已退出但重新打开失败，请手动打开${relaunch.error ? `（${relaunch.error}）` : ''}`;
  }
  if (relaunch.warning) return `已发起启动 WorkBuddy，但未能确认：${relaunch.warning}`;
  return 'WorkBuddy 已自动重新打开';
}

/** 按 uid 生成稳定的头像色，同一账号每次渲染颜色一致 */
function avatarTone(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const tones = [
    'from-indigo-500 to-violet-600',
    'from-emerald-500 to-teal-600',
    'from-amber-500 to-orange-600',
    'from-sky-500 to-blue-600',
    'from-rose-500 to-pink-600',
    'from-fuchsia-500 to-purple-600',
  ];
  return tones[h % tones.length];
}

/** 积分数额：最多两位小数，千分位 */
function fmtCredits(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(v);
}

/** 积分包到期时刻：10/13 10:31；长期有效不带时刻 */
function fmtPkgExpiry(ts: number | null | undefined): string {
  if (!ts) return '长期有效';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '长期有效';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${hh}:${mm}`;
}

/** 明细行用的完整时刻：2026/10/15 11:40:29（与官方客户端「积分明细」一致，精确到秒） */
function fmtFullDateTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${hh}:${mm}:${ss}`;
}

/** 余额更新时刻：只到分 */
function fmtClock(ts: number | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function Avatar({ name, seed, size = 'md' }: { name: string; seed: string; size?: 'md' | 'lg' }) {
  const cls = size === 'lg' ? 'w-12 h-12 text-base' : 'w-12 h-12 text-base';
  return (
    <div
      className={`${cls} rounded-full bg-gradient-to-br ${avatarTone(seed)} text-white flex items-center justify-center font-semibold shrink-0 ring-4 ring-white/70 shadow-sm`}
    >
      {name.slice(0, 1).toUpperCase()}
    </div>
  );
}

/**
 * 卡片上展示的积分包：**只展示还有剩余（>0）的包**，按类别顺序、同类别按到期时间升序。
 *
 * 用户明确要求：剩余为 0 的包（如「0 套餐基础积分 10/31 23:59」）不显示——
 * 它们既不能用，还会干扰「谁先过期」的判断。
 */
const PACKAGE_CATEGORY_ORDER: Record<string, number> = {
  套餐基础积分: 0,
  平台奖励积分: 1,
  购买积分: 2,
};

function usablePackages(balance: CreditBalance | null | undefined): CreditPackage[] {
  return (balance?.packages || [])
    .filter((p) => (p.remaining ?? 0) > 0)
    .sort((a, b) => {
      const ca = PACKAGE_CATEGORY_ORDER[a.name] ?? 3;
      const cb = PACKAGE_CATEGORY_ORDER[b.name] ?? 3;
      if (ca !== cb) return ca - cb;
      const ea = a.expireAt ?? Number.POSITIVE_INFINITY;
      const eb = b.expireAt ?? Number.POSITIVE_INFINITY;
      return ea === eb ? 0 : ea < eb ? -1 : 1;
    });
}

/** 超限模型的官方品牌图形（Simple Icons 24×24 路径；智谱用官方 favicon） */
function ModelIcon({ model, className, mono = false }: { model: string; className?: string; mono?: boolean }) {
  const m = String(model || "").toLowerCase();
  if (m.includes("glm") || m.includes("zhipu") || m.includes("chatglm")) {
    return <img src="/brands/glm.ico" alt="" className={className + " object-contain"} draggable={false} />;
  }
  const mark =
    m.includes("deepseek")
      ? BRAND_MARKS.deepseek
      : m.includes("kimi") || m.includes("moonshot")
        ? BRAND_MARKS.kimi
        : m.includes("minimax")
          ? BRAND_MARKS.minimax
          : m.includes("mimo") || m.includes("xiaomi")
            ? BRAND_MARKS.xiaomi
            : m.includes("qwen") || m.includes("tongyi")
              ? BRAND_MARKS.qwen
              : null;
  if (mark) {
    return (
      <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
        <path d={mark.path} fill={mono ? "currentColor" : mark.color} />
      </svg>
    );
  }
  // 其它：首字母
  const ch = (String(model || "?").replace(/[^a-zA-Z0-9]/g, "")[0] || "?").toUpperCase();
  return (
    <svg viewBox="0 0 20 20" className={className}>
      <text x="10" y="14" textAnchor="middle" fontSize="11" fontWeight="700" fill="currentColor">
        {ch}
      </text>
    </svg>
  );
}

/**
 * 模型额度超限小标：某个模型的用量超出限额时显示该模型图标（红色），
 * 鼠标悬停显示「何时恢复」。数据来自会话日志里的官方 429 报错。
 */
function ModelLimitBadges({
  limits,
  note,
}: {
  limits?: { model: string; resetAt: number; resetKnown?: boolean; status?: number }[];
  note?: string;
}) {
  // 恢复时间一到就自动消失：每分钟刷新一次当前时间，顺手过滤掉已过期的条目
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const live = (limits || []).filter((x) => !x.resetAt || x.resetAt > now);
  if (!live.length) {
    // 探测有异常（非 429 的拒绝、超时、凭据被拒…）也要留痕，否则用户只看到“什么都没发生”
    if (!note) return null;
    return (
      <span
        className="inline-flex h-6 items-center justify-center rounded-md bg-zinc-100 px-1"
        title={`额度探测异常：${note}`}
      >
        <IconWarning className="h-3.5 w-3.5 text-zinc-400" />
      </span>
    );
  }
  const fmt = (ts: number) => {
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  return (
    <span className="inline-flex items-center gap-1.5">
      {live.slice(0, 4).map((x) => (
        <span
          key={x.model}
          className="inline-flex h-6 items-center justify-center rounded-md bg-rose-50 px-1"
          title={
            x.resetKnown === false
              ? `${x.model} 用量已超限额（HTTP ${x.status || 429}），恢复时间未知，10 分钟后自动复探`
              : `${x.model} 用量已超限额，将于 ${fmt(x.resetAt)} 恢复`
          }
        >
          <ModelIcon model={x.model} mono className="h-3.5 w-3.5 text-rose-500" />
        </span>
      ))}
    </span>
  );
}

/**
 * 今日状态小标：日历勾（签到）+ 小飞机（旅行）。
 * 已完成 → 绿色；未完成 → 灰色；查询失败 → 灰色并给出提示。
 */
function DailyBadges({
  daily,
}: {
  daily?: {
    checkedIn?: boolean;
    traveled?: boolean;
    travelState?: string | null;
    travelDailyLimit?: boolean;
    travelReward?: number;
    checkinError?: string | null;
    travelError?: string | null;
  };
}) {
  if (!daily) return null;
  const done = 'text-emerald-500';
  const idle = 'text-zinc-300';
  const wrap = (active: boolean) =>
    `inline-flex h-6 w-6 items-center justify-center rounded-full ${active ? 'bg-emerald-50' : 'bg-zinc-100'}`;

  // 旅行三种状态：旅行中（含已到达）/ 今日名额已用完 / 未旅行
  const state = daily.travelState || (daily.traveled ? 'traveling' : 'idle');
  const traveling = state === 'traveling' || state === 'arrived' || !!daily.traveled;
  const limitReached = !traveling && !!daily.travelDailyLimit;
  const reward = Number(daily.travelReward || 0);

  // 三色：绿=正在旅行，黄=今日名额用完，灰=未旅行
  const travelTone = traveling
    ? { chipBg: '#E7F6EE', iconColor: '#2FBF8F' }
    : limitReached
      ? { chipBg: '#FEF9C3', iconColor: '#EAB308' }
      : { chipBg: '#F1F2F4', iconColor: '#A1A6AE' };

  const travelTitle = daily.travelError
    ? `旅行状态查询失败：${daily.travelError}`
    : traveling
      ? state === 'arrived'
        ? `旅行已到达，待领取${reward > 0 ? ` +${reward}` : ''} 积分`
        : `旅行中${reward > 0 ? `：已获得 ${reward} 积分` : '（Buddy 已出发）'}`
      : limitReached
        ? '今日旅行名额已用完'
        : '今日未旅行';

  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={wrap(!!daily.checkedIn)}
        title={daily.checkinError ? `签到状态查询失败：${daily.checkinError}` : daily.checkedIn ? '今日已签到' : '今日未签到'}
      >
        <svg viewBox="0 0 20 20" className={`h-3.5 w-3.5 ${daily.checkedIn ? done : idle}`} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4.5" width="14" height="12.5" rx="2" />
          <path d="M6.5 2.6v3.4M13.5 2.6v3.4M3 8.6h14" />
          <path d="M11.6 13.2l1.5 1.5 2.6-2.8" />
        </svg>
      </span>

      {/* 旅行标：直接复刻 WorkBuddy Switch 的做法 —— lucide PlaneTakeoff（自带底线）放进浅色圆角徽标 */}
      <span
        className="inline-flex h-6 items-center justify-center rounded-md px-1"
        style={{ background: travelTone.chipBg }}
        title={travelTitle}
      >
        <svg
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke={travelTone.iconColor}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2 22h20" />
          <path d="M6.36 17.4 4 17l-2-4 1.1-.55a2 2 0 0 1 1.8 0l.17.1a2 2 0 0 0 1.8 0L8 12 5 6l.9-.45a2 2 0 0 1 2.09.2l4.02 3a2 2 0 0 0 2.1.2l4.19-2.06a2.41 2.41 0 0 1 1.73-.17L21 7a1.4 1.4 0 0 1 .87 1.99l-.38.76c-.23.46-.6.84-1.07 1.08L7.58 17.2a2 2 0 0 1-1.22.18Z" />
        </svg>
      </span>
    </span>
  );
}

/**
 * 单条积分包：数额徽标 + 名称 + 到期时刻 + 细进度条。
 *
 * `pkg` 缺省时渲染**占位行**——与真实行完全同构（同一套 grid 与间距），
 * 因此两者等高，卡片不会因为积分包数量不同而参差不齐。
 */
function CreditPackageRow({ pkg }: { pkg?: CreditPackage }) {
  if (!pkg) {
    return (
      <div className="min-w-0" aria-hidden="true">
        <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 text-xs">
          <span className="invisible rounded-lg bg-zinc-100 px-2 py-1">0</span>
          <span className="invisible truncate">占位</span>
          <span className="invisible whitespace-nowrap">占位</span>
        </div>
        <div className="mt-1.5 h-1 rounded-full" />
      </div>
    );
  }

  const ratio = pkg.total > 0 ? Math.min(100, Math.max(0, (pkg.remaining / pkg.total) * 100)) : 0;
  const tone = pkg.expired ? 'bg-red-400' : pkg.expiringSoon ? 'bg-amber-500' : 'bg-indigo-500';
  const expiryTone = pkg.expired ? 'text-red-500' : pkg.expiringSoon ? 'text-amber-600' : 'text-zinc-400';
  const title = `${pkg.name} · 剩余 ${fmtCredits(pkg.remaining)} / ${fmtCredits(pkg.total)}${
    pkg.expireAt ? ` · ${fmtPkgExpiry(pkg.expireAt)} 到期` : ' · 长期有效'
  }`;

  return (
    <div className="min-w-0" title={title}>
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 text-xs">
        <span className="rounded-lg bg-zinc-100 px-2 py-1 font-medium tabular-nums text-zinc-700">
          {fmtCredits(pkg.remaining)}
        </span>
        <span className="truncate text-zinc-500">{pkg.name}</span>
        <span className={`whitespace-nowrap tabular-nums ${expiryTone}`}>{fmtPkgExpiry(pkg.expireAt)}</span>
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-zinc-100">
        <div className={`h-full rounded-full transition-all duration-500 ${tone}`} style={{ width: `${ratio}%` }} />
      </div>
    </div>
  );
}

/**
 * 状态占位行：与真实积分包行完全同构（同一套 grid、间距、进度条高度），
 * 中间显示状态文案（查询中 / 余额不可用 / 暂无可用积分），
 * 用来替代原来「一行小字」的状态展示——卡片在网格里等高、行与行左右对称对齐。
 */
function StatusPackageRow({ text }: { text: string }) {
  return (
    <div className="min-w-0">
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 text-xs">
        <span className="rounded-lg bg-zinc-100 px-2 py-1 tabular-nums text-zinc-300">—</span>
        <span className="truncate text-zinc-400">{text}</span>
        <span className="whitespace-nowrap tabular-nums text-zinc-300">—</span>
      </div>
      <div className="mt-1.5 h-1 rounded-full bg-zinc-100" />
    </div>
  );
}

/** 账号卡片：身份 + 积分余额 + 近期到期 + 操作条 */
function AccountCard({
  account,
  isCurrent,
  busy,
  balance,
  daily,
  modelLimits,
  limitNote,
  balanceLoading,
  authInvalid,
  onSwitch,
  onSyncSessions,
  onRefreshToken,
  onRename,
  onDelete,
  onShowPackages,
  onOpenRiskGuide,
}: {
  account: AccountInfo;
  isCurrent: boolean;
  busy: boolean;
  balance: CreditBalance | null;
  daily?: { checkedIn?: boolean; traveled?: boolean; checkinError?: string | null; travelError?: string | null };
  modelLimits?: { model: string; resetAt: number; resetKnown?: boolean; status?: number }[];
  limitNote?: string;
  balanceLoading: boolean;
  /** 官方接口已明确拒绝该账号的凭据（401/403）——本地未过期也不算数 */
  authInvalid: boolean;
  onSwitch: () => void;
  onSyncSessions: () => void;
  onRefreshToken: () => void;
  onRename: () => void;
  onDelete: () => void;
  onShowPackages: () => void;
  /** 打开「申诉与风险指引」弹层（限制徽章点击） */
  onOpenRiskGuide: () => void;
}) {
  /**
   * 凭据状态：以**服务端验活结论**为准（定时巡检每 6 小时刷新一次，结果落盘）。
   * 本地 expiresAt 只说明"没到时间"，不代表官方还认这个 token——早先只看本地时间，
   * 于是出现「面板显示凭据有效、切过去 WorkBuddy 却说登录过期」（2026-10-18 反馈）。
   */
  const vs = account.verify || null;
  const credState = !account.hasPlainToken
    ? account.hasEnvelope
      ? { color: 'amber', text: '加密凭据' }
      : { color: 'red', text: '无可用凭据' }
    : vs?.unauthorized || authInvalid
      ? { color: 'red', text: '凭据已失效' }
      : account.expired
        ? { color: 'red', text: '凭据已过期' }
        : vs?.valid
          ? { color: 'green', text: '凭据有效' }
          : { color: 'gray', text: '待验活' };

  const credTitle = vs?.unauthorized
    ? `服务端于 ${fmtClock(vs.at)} 明确拒绝该凭据（token 已被轮换或吊销）。请重新登录该账号后重新导入`
    : vs?.valid
      ? `服务端于 ${fmtClock(vs.at)} 确认凭据有效`
      : authInvalid
        ? '官方接口已拒绝这个账号的凭据，本地「未过期」不算数。请重新登录该账号后重新导入'
        : !account.hasPlainToken
          ? undefined
          : '尚未验活：添加账号时会自动验一次，之后每 6 小时巡检一次，也可以点「刷新凭据」立即验证';

  const pkgs = usablePackages(balance).slice(0, 2);
  const pkgTotal = usablePackages(balance).length;

  return (
    <article
      className={`flex min-w-0 flex-col overflow-hidden rounded-2xl border bg-white shadow-[0_1px_2px_rgba(15,23,42,.025),0_10px_28px_rgba(15,23,42,.035)] transition-shadow hover:shadow-[0_2px_4px_rgba(15,23,42,.04),0_14px_34px_rgba(15,23,42,.055)] ${
        isCurrent ? 'border-emerald-200' : 'border-zinc-200'
      }`}
    >
      {/* 卡头：染色随「是否当前登录态」变化，右下角一枚柔光斑 */}
      <header className={`relative border-b px-5 py-4 ${isCurrent ? 'bg-emerald-50/50' : 'bg-zinc-50/60'}`}>
        <div
          className={`pointer-events-none absolute -right-10 -top-16 size-24 rounded-full blur-2xl ${
            isCurrent ? 'bg-emerald-300/35' : 'bg-zinc-300/40'
          }`}
        />
        <div className="relative flex items-center gap-3">
          <Avatar name={account.name} seed={account.uid || account.id} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <h3 className="truncate text-sm font-semibold leading-5 text-zinc-900" title={account.name}>
                {account.name}
              </h3>
              {isCurrent && (
                <Badge color="green" dot>
                  使用中
                </Badge>
              )}
              {account.restriction && (
                <button
                  type="button"
                  onClick={() => onOpenRiskGuide()}
                  title="该账号已被官方限制。点击查看申诉教程与官方入口"
                  className="cursor-pointer"
                >
                  <Badge color="red" dot>官方已限制（{account.restriction.code}）· 点此申诉</Badge>
                </button>
              )}
            </div>
            <p className="mt-0.5 truncate font-mono text-xs leading-5 text-zinc-400" title={account.uid}>
              UID {account.uid}
            </p>
            {/* 备注行：直接点击即可修改（原「备注」按钮已并入这里），无备注时显示浅色提示 */}
            <button
              type="button"
              onClick={onRename}
              title={account.note ? `备注：${account.note}（点击修改）` : '点击添加备注'}
              className="group mt-1 flex max-w-full items-center gap-1 truncate text-left text-xs leading-5 text-zinc-500 transition-colors hover:text-indigo-600"
            >
              <IconEdit className="h-3 w-3 shrink-0 text-zinc-300 transition-colors group-hover:text-indigo-400" />
              {account.note ? (
                <span className="truncate">备注：{account.note}</span>
              ) : (
                <span className="truncate text-zinc-400 group-hover:text-indigo-500">添加备注</span>
              )}
            </button>
            <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
              <Badge color="gray">{account.variantLabel}</Badge>
              <span title={credTitle}>
                <Badge color={credState.color}>{credState.text}</Badge>
              </span>
              <DailyBadges daily={daily} />
              <ModelLimitBadges limits={modelLimits} note={limitNote} />
            </div>
          </div>
        </div>
      </header>

      <section className="flex min-w-0 flex-1 flex-col px-5 pb-5 pt-4">
        {/* 三个状态（查询中 / 不可用 / 正常）共用同一套结构：余额行 + 「近期到期」标签 + 两行积分包行。
            没有数据的位置用同构占位行补齐，保证网格里每张卡片等高、信息行对称 */}
        <div className="flex items-baseline gap-x-3 gap-y-1">
          <span className="flex items-center gap-1.5">
            <IconSparkles className="w-4 h-4 shrink-0 text-zinc-400" />
            <strong className="text-[22px] font-semibold leading-none tracking-[-0.025em] tabular-nums text-zinc-900">
              {balance ? fmtCredits(balance.remaining) : <span className="text-zinc-300">—</span>}
            </strong>
          </span>
          <span
            className="text-xs text-zinc-400"
            title="按周期汇总后的积分类别（套餐 / 平台奖励 / 购买）；点「查看全部」看逐笔发放记录"
          >
            {balance ? `${pkgTotal} 个积分池` : '—'}
          </span>
          <div
            className="ml-auto flex items-center gap-1.5 text-xs text-zinc-400"
            title={
              balanceLoading
                ? '余额查询中'
                : balance
                  ? `共 ${fmtCredits(balance.total)}，已用 ${fmtCredits(balance.used)}`
                  : account.hasPlainToken
                    ? '余额查询失败'
                    : account.hasEnvelope
                      ? '客户端加密信封凭据，无法查询余额'
                      : '该账号无可用凭据，无法查询余额'
            }
          >
            {balanceLoading ? <Spinner className="w-3.5 h-3.5" /> : <IconClock className="w-3.5 h-3.5 shrink-0" />}
            <span className="whitespace-nowrap tabular-nums">
              {balanceLoading ? '查询中…' : balance?.updatedAt ? `${fmtClock(balance.updatedAt)} 更新` : '—'}
            </span>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium text-zinc-400">积分明细</span>
          {balance && pkgTotal > 0 && (
            <button
              type="button"
              onClick={onShowPackages}
              className="inline-flex shrink-0 cursor-pointer items-center gap-1 text-[11px] font-medium text-indigo-600 transition-colors hover:text-indigo-500"
            >
              查看全部
              <IconArrowDown className="w-3 h-3 -rotate-90" />
            </button>
          )}
        </div>

        <div className="mt-4 space-y-2.5">
          {balanceLoading ? (
            <>
              <StatusPackageRow text="积分查询中…" />
              <CreditPackageRow />
            </>
          ) : !balance ? (
            <>
              <StatusPackageRow
              text={
                account.hasPlainToken
                  ? '余额暂不可用'
                  : account.hasEnvelope
                    ? '加密信封凭据，无法查询余额'
                    : '无可用凭据，无法查询余额'
              }
            />
              <CreditPackageRow />
            </>
          ) : pkgTotal === 0 ? (
            <>
              <StatusPackageRow text="暂无可用积分" />
              <CreditPackageRow />
            </>
          ) : (
            [0, 1].map((i) => <CreditPackageRow key={i} pkg={pkgs[i]} />)
          )}
        </div>
      </section>

      <footer className="flex flex-wrap items-center gap-2 border-t border-zinc-100 px-5 py-2.5">
        <Button
          variant={isCurrent ? 'subtle' : 'primary'}
          size="sm"
          className="h-7 rounded-full px-2.5 pr-3.5 text-xs"
          disabled={isCurrent || busy || (!account.hasPlainToken && !account.hasEnvelope)}
          onClick={onSwitch}
          title={
            account.hasPlainToken
              ? '把 WorkBuddy 的登录态切换到这个账号'
              : account.hasEnvelope
                ? '该账号只有客户端加密信封凭据：切换会把信封原样写回登录态，需由 WorkBuddy 客户端解密使用'
                : '该账号没有可用的明文凭据，无法切换'
          }
        >
          {isCurrent ? <IconCheck className="w-3.5 h-3.5" /> : <IconSwitch className="w-3.5 h-3.5" />}
          {isCurrent ? '使用中' : '切换账号'}
        </Button>
        <Button
          size="sm"
          className="h-7 rounded-full px-2.5 pr-3.5 text-xs"
          disabled={isCurrent || busy || CROSS_ACCOUNT_SESSION_OPS_DISABLED}
          onClick={onSyncSessions}
          title={
            CROSS_ACCOUNT_SESSION_OPS_DISABLED
              ? CROSS_ACCOUNT_OPS_REASON
              : isCurrent
                ? '这就是当前正在使用的账号，源与目标相同，无需转移会话'
                : '把当前登录账号的会话转到这个账号：源账号不再保留，磁盘只存一份'
          }
        >
          <IconCopy className="w-3.5 h-3.5" />
          转到此账号
        </Button>
        <Button
          size="sm"
          className="h-7 rounded-full px-2.5 pr-3.5 text-xs"
          disabled={busy || !account.hasPlainToken}
          onClick={onRefreshToken}
          title={
            account.hasPlainToken
              ? '用 refresh_token 换一份新的 access_token，有效期顺延（账号长期不用时可防止静默失效）'
              : '该账号没有可用的凭据，需重新扫码登录'
          }
        >
          <IconRefresh className="w-3.5 h-3.5" />
          刷新凭据
        </Button>
        <Button
          size="sm"
          variant="danger"
          className="ml-auto h-7 rounded-full px-2.5 text-xs"
          onClick={onDelete}
          disabled={isCurrent || busy}
          title="从账号库删除"
        >
          <IconTrash className="w-3.5 h-3.5" />
        </Button>
      </footer>
    </article>
  );
}

/** 备注编辑弹窗 */
function RenameDialog({
  account,
  onClose,
  onSaved,
}: {
  account: AccountInfo | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [displayField, setDisplayField] = useState<'auto' | 'note' | 'phone'>('auto');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (account) {
      setNote(account.note || '');
      setDisplayField((account.displayField as 'auto' | 'note' | 'phone') || 'auto');
    }
  }, [account]);

  if (!account) return null;

  const save = async () => {
    setSaving(true);
    try {
      await patch(`/api/accounts/${account.id}`, { note, displayField }, { timeoutMs: TIMEOUT.write });
      toast('ok', '已保存');
      onSaved();
      onClose();
    } catch (e: any) {
      toast('err', e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={!!account}
      onClose={onClose}
      title={`编辑「${account.name}」`}
      subtitle="仅修改本地备注，不触碰任何凭据"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" loading={saving} onClick={save}>
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-zinc-600 mb-1.5">备注</label>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="例如：主号 / 备用号 / 公司账号"
            maxLength={40}
            className="w-full h-9 px-3 rounded-xl border border-zinc-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-zinc-600 mb-1.5">列表展示名来源</label>
          <div className="space-y-1.5">
            {(
              [
                { v: 'auto', label: '自动（备注 → 邮箱 → 昵称 → UID）' },
                { v: 'note', label: '优先显示备注' },
                { v: 'phone', label: '优先显示官方手机号' },
              ] as const
            ).map((o) => (
              <label key={o.v} className="flex items-center gap-2 text-sm text-zinc-600 cursor-pointer">
                <input type="radio" checked={displayField === o.v} onChange={() => setDisplayField(o.v)} className="accent-indigo-600" />
                {o.label}
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-zinc-400 leading-relaxed">
            手机号从登录态中的 profile_raw 实时读取，不额外存储一份副本。
          </p>
        </div>
      </div>
    </Modal>
  );
}

/* ---------------- 未完成的扫码请求（跨弹窗/刷新续采） ---------------- */

const PENDING_OAUTH_KEY = 'wbhub.pendingOAuth';
/** 超过该时长视为失效（官方 state 有效期 10 分钟，留一点余量） */
const PENDING_OAUTH_TTL = 12 * 60_000;

interface PendingOAuth {
  loginId: string;
  variant: 'cn' | 'ai';
  at: number;
}

export function readPendingOAuth(): PendingOAuth | null {
  try {
    const raw = localStorage.getItem(PENDING_OAUTH_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p?.loginId || Date.now() - Number(p.at || 0) > PENDING_OAUTH_TTL) {
      localStorage.removeItem(PENDING_OAUTH_KEY);
      return null;
    }
    return p as PendingOAuth;
  } catch {
    return null;
  }
}

function savePendingOAuth(p: PendingOAuth) {
  try {
    localStorage.setItem(PENDING_OAUTH_KEY, JSON.stringify(p));
  } catch {
    /* 隐私模式：仅影响"关弹窗后续采"，不影响本次采集 */
  }
}

function clearPendingOAuth() {
  try {
    localStorage.removeItem(PENDING_OAUTH_KEY);
  } catch {
    /* 忽略 */
  }
}

/** 把官方状态码翻译成一句人话，用于提示"卡在哪一步" */
function describeOfficialState(r: OAuthPollResult): string {
  const msg = String(r.message || '');
  if (r.code === 11217 || /login\s*ing/i.test(msg)) return '官方状态：等待手机端确认授权';
  if (r.code == null && !msg) return '官方状态：尚未收到授权结果';
  return `官方状态：${msg || `code ${r.code}`}`;
}

/**
 * 扫码添加账号：OAuth 设备码流程。
 *
 * 打开即向官方申请 state，二维码在**本地渲染**（qrcode 库，验证链接不外传），
 * 随后每 1.5 秒读一次授权结果；成功后自动采集入库并回调父组件刷新。
 * 档位决定链接域名与 platform 参数，服务端按发起档位校验，绝不混档。
 *
 * 重要：真正的轮询在**服务端**跑（手机授权是异步的，用户常关掉弹窗或刷新页面），
 * 前端只负责读状态；未完成的请求会记到 localStorage，重开页面后仍能续上结果。
 */
function ScanAddDialog({
  open,
  variant,
  variantLabel,
  onClose,
  onAdded,
}: {
  open: boolean;
  variant: 'cn' | 'ai';
  variantLabel: string;
  onClose: () => void;
  onAdded: (acc: AccountInfo) => void;
}) {
  const toast = useToast();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState<'starting' | 'waiting' | 'done' | 'failed'>('starting');
  const [uri, setUri] = useState('');
  const [loginId, setLoginId] = useState('');
  const [deadline, setDeadline] = useState(0);
  const [remain, setRemain] = useState(0);
  const [result, setResult] = useState<AccountInfo | null>(null);
  const [error, setError] = useState('');
  const [qrFailed, setQrFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  /** 官方接口的原始状态文案，用于解释"卡在哪一步" */
  const [official, setOfficial] = useState('');
  /** 成功回调进 ref：父组件传的是内联函数，直接进 deps 会让轮询效应反复重启 */
  const onAddedRef = useRef(onAdded);
  onAddedRef.current = onAdded;
  /** 本次弹窗是否已发起过授权申请（防止 deps 变化重复换 state，详见下方 effect） */
  const openedRef = useRef(false);

  const start = useCallback(async () => {
    setPhase('starting');
    setUri('');
    setLoginId('');
    setResult(null);
    setError('');
    setQrFailed(false);
    setOfficial('');
    try {
      const r = await post<OAuthStartResult>('/api/oauth/start', { variant }, { timeoutMs: TIMEOUT.oauth });
      setUri(r.verificationUri);
      setLoginId(r.loginId);
      setDeadline(Date.now() + r.expiresIn * 1000);
      setPhase('waiting');
      // 记录本次请求：弹窗关掉/页面刷新后仍能续上采集结果
      savePendingOAuth({ loginId: r.loginId, variant, at: Date.now() });
    } catch (e: any) {
      setError(e?.message || '发起登录失败');
      setPhase('failed');
    }
  }, [variant]);

  /** 在系统浏览器打开授权页：官方页在浏览器里完成绑定，本页只负责等结果 */
  const openAuthPage = useCallback(() => {
    if (!uri) return;
    const w = window.open(uri, '_blank', 'noopener,noreferrer');
    if (!w) toast('info', '浏览器拦截了新窗口，请点下方链接手动打开，或复制链接到浏览器');
  }, [uri, toast]);

  /**
   * 打开弹窗即自动发起，省一次点击。
   *
   * ⚠️ 只在「弹窗从关到开」时发起一次：`start` 依赖 variant，而 variant 会跟随
   * 当前登录态变化（见下方 useEffect）。若把它放进普通 deps，档位一变就会**静默
   * 换掉二维码/链接**——用户扫的或打开的是旧 state，官方那边登录成功但不绑定，
   * 服务端只能一直看到 code 11217「login ing」，最后表现为「跳官网登录了却没添加
   * 成功」（2026-10-25 反馈）。档位在服务端按 loginId 固定，不需要重发。
   */
  useEffect(() => {
    if (!open) {
      openedRef.current = false;
      return;
    }
    if (openedRef.current) return;
    openedRef.current = true;
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, start]);

  // 有效期倒计时（官方 state 有效期 10 分钟）
  useEffect(() => {
    if (phase !== 'waiting') return;
    const tick = () => setRemain(Math.max(0, Math.round((deadline - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [phase, deadline]);

  // 二维码本地渲染：失败时降级为展示链接（不依赖任何第三方二维码服务）
  // deps 带 phase：canvas 在 waiting 态才挂载，仅依赖 uri 会在 canvas 就绪前空跑
  useEffect(() => {
    if (!uri || !canvasRef.current) return;
    let alive = true;
    QRCode.toCanvas(canvasRef.current, uri, {
      width: 208,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#18181b', light: '#ffffff' },
    })
      .then(() => {
        if (alive) setQrFailed(false);
      })
      .catch(() => {
        if (alive) setQrFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [uri, phase]);

  // 轮询授权结果：done=false 继续等，done+result 已入库，done+error 失败/超时
  // 服务端有常驻采集循环，这里只是"读状态"，关掉弹窗也不影响账号入库。
  //
  // 单次请求失败**不是**登录失败：本机写盘可能被外部进程拦几十秒（服务端退避重试），
  // 或浏览器并发连接排队，任何一种都会让这一枪超时。以前一次失败就置 failed，
  // 用户看到的就是「扫码后提示 25 秒超时、没添加成功」——而账号其实可能在后台入库。
  // 现在：超时放宽到 60 秒，且连续 3 次失败才判定失败（弹窗失败不清理 pending，
  // 刷新页面会由 resumePendingOAuth 继续续采）。
  useEffect(() => {
    if (!loginId) return;
    let timer: number | undefined;
    let cancelled = false;
    let fails = 0;
    const poll = async () => {
      try {
        const r = await post<OAuthPollResult>('/api/oauth/status', { loginId }, { timeoutMs: TIMEOUT.oauth });
        if (cancelled) return;
        fails = 0;
        if (r.done) {
          clearPendingOAuth();
          if (r.result) {
            setResult(r.result);
            setPhase('done');
            onAddedRef.current(r.result);
          } else {
            setError(r.error || '登录失败');
            setPhase('failed');
          }
          return;
        }
        // 未完成：把官方原始状态显示出来，用户能判断是"没扫"还是"官方还在处理"
        setOfficial(describeOfficialState(r));
        timer = window.setTimeout(poll, 1500);
      } catch (e: any) {
        if (cancelled) return;
        fails += 1;
        if (fails < 3) {
          setOfficial(`本地服务响应慢或正在落盘，正在重试（第 ${fails} 次）`);
          timer = window.setTimeout(poll, 2500);
          return;
        }
        setError(`${e?.message || '轮询失败'}；服务端采集仍在继续，刷新页面会自动续采`);
        setPhase('failed');
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [loginId]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(uri);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast('err', '复制失败，请手动选中链接复制');
    }
  };

  // 过期判定只看 deadline：remain 初始为 0，若用它判断会在 waiting 首帧误判过期，
  // 导致 canvas 来不及挂载、二维码效果空跑（表现为二维码区域永远空白）
  const expired = phase === 'waiting' && deadline > 0 && Date.now() >= deadline;
  const mmss = `${String(Math.floor(remain / 60)).padStart(2, '0')}:${String(remain % 60).padStart(2, '0')}`;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="扫码添加账号"
      subtitle={`${variantLabel} · 授权成功后自动采集入库`}
      footer={
        phase === 'done' ? (
          <Button variant="primary" onClick={onClose}>
            完成
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>取消</Button>
            <Button variant="subtle" onClick={() => void start()} loading={phase === 'starting'}>
              <IconRefresh className="w-3.5 h-3.5" />
              刷新二维码
            </Button>
          </>
        )
      }
    >
      <div className="space-y-3.5 text-sm">
        {phase === 'starting' && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-zinc-400">
            <Spinner className="w-4 h-4" />
            正在向官方申请登录凭证…
          </div>
        )}

        {phase === 'waiting' && uri && !expired && (
          <>
            {/* 常驻提示（非国际版也显示）：这是「跳官网登录成功却没添加成功」最常见的原因——
                浏览器已有官网登录态，授权页直接显示已登录，**不会绑定本次 state**。 */}
            <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-800 leading-relaxed">
              <IconWarning className="w-3.5 h-3.5 shrink-0 mt-px text-amber-500" />
              <span>
                {variant === 'ai' && (
                  <span className="block">
                    国际版登录要访问 <b>workbuddy.ai</b>，境内直连通常不通——请先开启代理，并到「设置 → 网络代理」填写代理地址；
                    没有可用的境外网络请改用「国内版」。
                  </span>
                )}
                <span className={variant === 'ai' ? 'mt-1 block' : 'block'}>
                  若浏览器<strong>已登录</strong>官网（{variant === 'ai' ? 'workbuddy.ai' : 'codebuddy.cn'}），授权页会直接跳到
                  「登录成功」而<strong>不会绑定本次登录</strong>，控制台就一直等不到账号。请复制链接到
                  <strong>无痕（隐私）窗口</strong>打开，或用未登录的浏览器完成授权。
                </span>
              </span>
            </div>
            {/* 首选：浏览器里完成授权。官方页在浏览器里点「同意」才会绑定 state，
                手机扫码偶发不绑定的情况，走浏览器最稳；二维码保留给手机扫码用户。 */}
            <div className="rounded-xl border border-indigo-100 bg-indigo-50/60 px-3.5 py-3 space-y-2">
              <div className="text-xs text-indigo-800 leading-relaxed">
                推荐在<strong>浏览器</strong>中完成授权：点下面的按钮打开官方登录页，登录并同意后本页会自动采集账号。
              </div>
              <Button variant="primary" className="w-full" onClick={openAuthPage}>
                <IconExternalLink className="w-4 h-4" />
                在浏览器中打开授权页
              </Button>
            </div>

            <div className="flex items-center gap-3">
              <span className="h-px flex-1 bg-zinc-100" />
              <span className="text-[11px] text-zinc-400">或用手机扫码</span>
              <span className="h-px flex-1 bg-zinc-100" />
            </div>

            <div className="flex flex-col items-center gap-3">
              {qrFailed ? (
                <div className="text-xs text-zinc-400">二维码渲染失败，请直接打开上方按钮或下方链接完成授权</div>
              ) : (
                <canvas ref={canvasRef} className="rounded-xl border border-zinc-200" width={208} height={208} />
              )}
              <div className="flex items-center gap-1.5 text-xs text-zinc-400 tabular-nums">
                <IconClock className="w-3.5 h-3.5" />
                有效期剩余 {mmss}
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-xl bg-zinc-50 px-3 py-2">
              <a
                href={uri}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 flex-1 truncate font-mono text-[11px] text-indigo-600 hover:underline"
                title="在浏览器中打开验证链接"
              >
                {uri}
              </a>
              <Button size="sm" variant="ghost" onClick={copyLink} title="复制验证链接">
                {copied ? <IconCheck className="w-3.5 h-3.5" /> : <IconCopy className="w-3.5 h-3.5" />}
                {copied ? '已复制' : '复制'}
              </Button>
            </div>
            <p className="text-center text-xs text-zinc-400">
              {variant === 'ai' ? '正在等待 Web 登录授权…' : '正在等待授权，浏览器完成或手机扫码后会自动采集…'}
            </p>
            <p className="text-center text-[11px] text-zinc-300">
              {official || '已提交，正在等待官方返回授权结果'}
            </p>
            <Hint className="justify-center">
              授权由本机服务在后台等待并自动采集：中途关闭这个弹窗不会中断，重新打开「扫码添加账号」会继续等待上一次授权（约 12 分钟内有效）。
            </Hint>
          </>
        )}

        {phase === 'waiting' && expired && (
          <div className="space-y-3 py-4 text-center">
            <div className="text-sm text-zinc-500">二维码已过期（有效期 10 分钟）</div>
            <Button variant="primary" onClick={() => void start()}>
              <IconRefresh className="w-3.5 h-3.5" />
              重新获取
            </Button>
          </div>
        )}

        {phase === 'done' && result && (
          <div className="flex flex-col items-center gap-2.5 py-6">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
              <IconCheck className="w-5 h-5" />
            </div>
            <div className="text-sm text-zinc-700">
              已添加账号「<b className="text-zinc-900">{result.name}</b>」
            </div>
            <div className="text-xs text-zinc-400">已写入账号库，可在下方一键切换</div>
          </div>
        )}

        {phase === 'failed' && (
          <div className="space-y-3 py-2">
            <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-700 leading-relaxed">
              <IconWarning className="w-3.5 h-3.5 shrink-0 mt-px text-red-500" />
              <span>{error || '登录失败'}</span>
            </div>
            <div className="text-center">
              <Button variant="subtle" onClick={() => void start()}>
                <IconRefresh className="w-3.5 h-3.5" />
                重试
              </Button>
            </div>
          </div>
        )}

        <p className="text-[11px] leading-relaxed text-zinc-400">
          扫码链接由官方接口实时生成，仅在本机渲染二维码；授权凭据直接写入本机账号库
          <span className="font-mono"> ~/.wb-switch/accounts.json</span>，不经过任何第三方服务器。
        </p>
      </div>
    </Modal>
  );
}

/**
 * 积分明细弹窗：逐笔列出官方明细接口的发放记录（与官方客户端「积分明细」同形）。
 *
 * 打开时请求 `/api/accounts/credit-details`（服务端缓存 5 分钟）；按
 * 「有效期内 / 已过期」两个 tab 分组，行内展示包名、到期时刻（精确到秒）
 * 与「已使用 x/y」进度条。明细查询失败时回落到汇总包视图并提示原因。
 */
function PackagesDialog({ account, balance, onClose }: { account: AccountInfo | null; balance: CreditBalance | null; onClose: () => void }) {
  const [details, setDetails] = useState<CreditDetailsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** tab：'active' = 有效期内（含长期有效），'expired' = 已过期 */
  const [tab, setTab] = useState<'active' | 'expired'>('active');

  useEffect(() => {
    if (!account) {
      setDetails(null);
      setError(null);
      setTab('active');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDetails(null);
    setTab('active');
    get<CreditDetailsResponse>(`/api/accounts/credit-details?id=${encodeURIComponent(account.id)}`, { timeoutMs: TIMEOUT.quota })
      .then((r) => {
        if (!cancelled) setDetails(r);
      })
      .catch((e: any) => {
        if (!cancelled) setError(e?.message || '明细查询失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [account]);

  if (!account) return null;

  const records = details?.records || [];
  const active = records.filter((r) => !r.expired);
  const expired = records.filter((r) => r.expired);
  const shown = tab === 'active' ? active : expired;

  return (
    <Modal
      open={!!account}
      onClose={onClose}
      title="积分明细"
      subtitle={
        balance
          ? `${account.name} · 剩余 ${fmtCredits(balance.remaining)} / 总额 ${fmtCredits(balance.total)} · 已用 ${fmtCredits(balance.used)}`
          : account.name
      }
      footer={<Button onClick={onClose}>关闭</Button>}
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-zinc-400">
          <Spinner className="w-4 h-4" />
          正在获取逐笔明细…
        </div>
      ) : error ? (
        <div className="space-y-3">
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-800">
            逐笔明细获取失败：{error}。以下为按包汇总的视图。
          </div>
          <PackagesFallback account={account} balance={balance} />
        </div>
      ) : records.length === 0 ? (
        <div className="py-6 text-center text-sm text-zinc-400">当前没有积分明细记录。</div>
      ) : (
        <div className="min-w-0">
          {/* 分组 tab：与官方客户端一致（有效期内 / 已过期） */}
          <div className="mb-4 grid grid-cols-2 gap-1 rounded-xl bg-zinc-100 p-1">
            {(
              [
                { key: 'active' as const, label: `有效期内 ${active.length} 笔` },
                { key: 'expired' as const, label: `已过期 ${expired.length} 笔` },
              ]
            ).map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`h-8 cursor-pointer rounded-lg text-xs font-medium transition-all ${
                  tab === t.key ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-700'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="max-h-[55vh] min-w-0 space-y-3 overflow-y-auto pr-1">
            {shown.map((r, i) => {
              const ratio = r.total > 0 ? Math.min(100, Math.max(0, (r.used / r.total) * 100)) : 0;
              // 已用完的记录仍列在「有效期内」（客户端同口径），但加标记说明它不再提供额度
              const usedUp = !r.expired && r.remaining <= 0;
              return (
                <div key={`${r.packageCode || 'rec'}-${i}`} className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium text-zinc-800">{r.name}</span>
                    {usedUp && (
                      <span className="shrink-0 rounded-md bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
                        已用完
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex min-w-0 items-baseline justify-between gap-3 text-xs">
                    <span className="shrink-0 text-zinc-500">
                      {r.expireAt ? `到期时间 ${fmtFullDateTime(r.expireAt)}` : '长期有效'}
                    </span>
                    <span className={`shrink-0 tabular-nums ${r.expired || usedUp ? 'text-zinc-400' : 'text-zinc-700'}`}>
                      已使用 {fmtCredits(r.used)}/{fmtCredits(r.total)}
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-zinc-100">
                    <div
                      className={`h-full rounded-full ${r.expired || usedUp ? 'bg-zinc-300' : 'bg-emerald-500'}`}
                      style={{ width: `${ratio}%` }}
                    />
                  </div>
                </div>
              );
            })}
            {shown.length === 0 && (
              <div className="py-6 text-center text-sm text-zinc-400">
                {tab === 'expired' ? '没有已过期的记录。' : '有效期内没有记录。'}
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

/** 明细接口失败时的回落视图：按包汇总展示（旧「全部积分包」的内容） */
function PackagesFallback({ account, balance }: { account: AccountInfo; balance: CreditBalance | null }) {
  const all = (balance?.packages || [])
    .slice()
    .sort((a, b) => {
      const ca = PACKAGE_CATEGORY_ORDER[a.name] ?? 3;
      const cb = PACKAGE_CATEGORY_ORDER[b.name] ?? 3;
      if (ca !== cb) return ca - cb;
      const ea = a.expireAt ?? Number.POSITIVE_INFINITY;
      const eb = b.expireAt ?? Number.POSITIVE_INFINITY;
      return ea === eb ? 0 : ea < eb ? -1 : 1;
    });

  if (all.length === 0) {
    return <div className="py-6 text-center text-sm text-zinc-400">当前没有可展示的积分包。</div>;
  }
  return (
    <div className="min-w-0 divide-y divide-zinc-100">
      {all.map((p, i) => {
        const ratio = p.total > 0 ? Math.min(100, Math.max(0, (p.remaining / p.total) * 100)) : 0;
        return (
          <div key={`${p.packageCode || 'pkg'}-${i}`} className="min-w-0 py-3 first:pt-0 last:pb-0">
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-zinc-800">{p.name}</div>
                <div className="mt-1 text-[11px] text-zinc-400">
                  {p.expired ? '已到期' : p.expireAt ? `到期 ${fmtDateTime(p.expireAt)}` : '长期有效'}
                </div>
              </div>
              <div className="shrink-0 text-right text-xs">
                <div className="font-medium tabular-nums text-zinc-700">
                  {fmtCredits(p.remaining)} / {fmtCredits(p.total)}
                </div>
                <div className="mt-1 text-[11px] text-zinc-400">已用 {fmtCredits(p.used)}</div>
              </div>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-100">
              <div
                className={`h-full rounded-full ${p.expired ? 'bg-red-400/70' : p.expiringSoon ? 'bg-amber-500/80' : 'bg-indigo-500/75'}`}
                style={{ width: `${ratio}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 体积：B → 人类可读；复制会话的体积提示用（单会话可达几十 MB） */
function fmtBytes(n: number): string {
  if (!n || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

/** 会话列表一次最多渲染多少行：本机有 3300+ 条，全渲染会明显卡顿，靠搜索收敛 */
const SESSION_RENDER_LIMIT = 200;

/**
 * 「自动退出 WorkBuddy」勾选行（受控纯展示，两处复用）。
 *
 * 勾上后：切换/复制前由服务端结束 WorkBuddy 的全部相关进程，确认退出后才动数据；
 * 切换完成后再把它重新打开（只重开"确实是我们关掉的"那种情况）。
 */
function StopAppRow({
  checked,
  onChange,
  disabled,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <label
      className={`mt-3 flex items-start gap-2 rounded-xl border px-3 py-2.5 ${
        disabled ? 'cursor-not-allowed border-zinc-200 bg-zinc-50' : 'cursor-pointer border-indigo-200 bg-indigo-50/60'
      }`}
    >
      <input
        type="checkbox"
        className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-indigo-600"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="text-xs leading-relaxed text-indigo-900">
        <b>自动退出 WorkBuddy</b>：由本工具结束后台的全部 WorkBuddy 进程，确认退出后才执行，不再需要你手动关闭。
        {children}
      </span>
    </label>
  );
}

/**
 * 确认弹窗里用的版本：自己持有勾选状态并把值写进外部 ref。
 *
 * 必须这样做：确认弹窗保存的是**调用那一刻的消息节点快照**，
 * 由父组件受控的 checkbox 不会跟着父组件重渲染，勾了也读不到。
 */
function StopAppToggleRef({ flagRef }: { flagRef: { current: boolean } }) {
  const [on, setOn] = useState(true);
  return (
    <StopAppRow
      checked={on}
      onChange={(v) => {
        setOn(v);
        flagRef.current = v;
      }}
    />
  );
}

/**
 * 切换确认框里的「同时复制会话」勾选（同样只能自己持有状态 + 写外部 ref，原因见上）。
 */
function CopyOnSwitchToggle({ flagRef }: { flagRef: { current: boolean } }) {
  const [on, setOn] = useState(false);
  // 跨账号会话操作总闸：置灰「同时复制会话」，勾选状态强制为关
  if (CROSS_ACCOUNT_SESSION_OPS_DISABLED) {
    flagRef.current = false;
    return (
      <label className="mt-2 flex cursor-not-allowed items-start gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 opacity-70">
        <input type="checkbox" className="mt-0.5 h-3.5 w-3.5 shrink-0" checked={false} disabled />
        <span className="text-xs leading-relaxed text-zinc-500">
          <b>同时复制会话（已停用）</b>：上游风控会识别跨账号会话重放并批量封禁关联账号
          （2026-10-29 实测），该功能已临时关闭。
        </span>
      </label>
    );
  }
  return (
    <label className="mt-2 flex cursor-pointer items-start gap-2 rounded-xl border border-indigo-200 bg-indigo-50/60 px-3 py-2.5">
      <input
        type="checkbox"
        className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-indigo-600"
        checked={on}
        onChange={(e) => {
          setOn(e.target.checked);
          flagRef.current = e.target.checked;
        }}
      />
      <span className="text-xs leading-relaxed text-indigo-900">
        <b>同时复制会话</b>：把当前账号的会话也带给这个账号。勾选后会先打开会话选择列表，
        由你挑要复制哪些（复制用的是新会话 id，源账号的数据不受影响）。
      </span>
    </label>
  );
}

/**
 * 结果明细块。
 *
 * 必须同时兼容两种形态：`/api/sessions/copy` 返回 copied/skipped，
 * `/api/sessions/move`（以及切换里的会话转移）返回 moved/merged/skippedDeleted。
 * 早期只读 copied/skipped，搬家结果一进来 `report.copied.length` 就是 TypeError，
 * 弹窗直接崩掉——用户看到的就是「转移会话失败」，而且连失败原因都看不到。
 */
function SessionReportBlock({ report }: { report: SessionCopyReport }) {
  const movedOk = (report.moved?.length || 0) + (report.copied?.length || 0);
  const merged = report.merged?.length || 0;
  const okCount = movedOk + merged;
  const skippedList = [...(report.skippedDeleted || []), ...(report.skipped || [])];
  const errCount = report.errors?.length || 0;
  const isMove = !report.copied || !!report.moved;
  return (
    <div className="space-y-2 rounded-xl border border-zinc-200 bg-zinc-50/70 px-3.5 py-3 text-xs">
      <div className="font-medium text-zinc-700">
        {isMove ? '转移结果' : '复制结果'}：成功 <b className="tabular-nums text-emerald-600">{okCount}</b> 个
        {merged > 0 && <span className="text-zinc-500">（其中 {merged} 个与已有副本合并取全）</span>} ·
        跳过 <b className="tabular-nums text-zinc-500">{skippedList.length}</b> 个 ·
        失败 <b className={`tabular-nums ${errCount ? 'text-red-600' : 'text-zinc-500'}`}>{errCount}</b> 个 ·
        共 {fmtBytes(report.totalBytes)} · 用时 {(report.elapsedMs / 1000).toFixed(1)}s
      </div>
      {report.backupPath && (
        <div className="truncate font-mono text-[11px] text-zinc-400" title={report.backupPath}>
          执行前已备份会话库：{report.backupPath}
        </div>
      )}
      {report.verified === false && (
        <div className="flex items-start gap-1.5 rounded-lg border border-red-200 bg-red-50 px-2.5 py-2 text-[11px] text-red-700">
          <IconWarning className="mt-px w-3.5 h-3.5 shrink-0 text-red-500" />
          <span>
            <b>写入没有生效</b>：数据库被其它进程回滚了，通常是有 WorkBuddy 实例还在运行。
            完全退出 WorkBuddy 后重试即可，源账号的会话没有被破坏。
          </span>
        </div>
      )}
      {!!report.titleSynced?.length && (
        <div className="text-[11px] text-emerald-700">
          改名同步：<b className="tabular-nums">{report.titleSynced.length}</b>{' '}
          个会话的新名字已写到目标账号里同一份会话上（客户端会给导入的副本重新生成自动标题，会话带上固定名后不再被覆盖）。
        </div>
      )}
      {!!report.contentSynced?.length && (
        <div className="text-[11px] text-emerald-700">
          内容同步：<b className="tabular-nums">{report.contentSynced.length}</b> 个会话新聊的内容（共{' '}
          <b className="tabular-nums">{report.contentSynced.reduce((s, c) => s + c.appendedLines, 0)}</b> 行）已
          合并进目标账号里同一份会话，不会再重复复制出新会话。
        </div>
      )}
      {errCount > 0 && (
        <ul className="max-h-32 space-y-0.5 overflow-y-auto text-[11px] text-red-600">
          {report.errors.slice(0, 50).map((e) => (
            <li key={e.id} className="truncate" title={`${e.id}：${e.error}`}>
              {e.id.slice(0, 8)}… — {e.error}
            </li>
          ))}
        </ul>
      )}
      {skippedList.length > 0 && okCount === 0 && errCount === 0 && (
        <div className="text-[11px] text-zinc-500">
          选中的会话在目标账号里你已删过同一对话，按「尊重删除」不回填，本次没有需要搬的内容。
        </div>
      )}
    </div>
  );
}

/**
 * 会话复制弹窗：列出「当前登录账号 → 目标账号」可复制的会话并执行复制。
 *
 * `mode='switch'` 时按钮变成「复制并切换」——先复制会话、再写登录态文件。
 * 顺序不能反：来源账号是「当前登录账号」，登录态一旦被改写就再也读不出源账号是谁。
 */
function SessionCopyDialog({
  open,
  target,
  mode,
  wbRunning,
  onClose,
  onDone,
}: {
  open: boolean;
  target: AccountInfo | null;
  mode: 'copy' | 'switch';
  wbRunning: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  // 之前漏了这行：confirm 落到全局 window.confirm，弹窗显示 [object Object]
  const confirm = useConfirm();
  const toast = useToast();
  const [data, setData] = useState<SessionListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [hideCopied, setHideCopied] = useState(false);
  /** 默认勾选：由服务端直接结束 WorkBuddy 进程，用户不必自己动手 */
  const [stopApp, setStopApp] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<SessionCopyReport | null>(null);

  const targetId = target?.id || '';

  /** 拉取列表；复制成功后也复用它刷新「已复制」标记 */
  const load = useCallback(async () => {
    if (!targetId) return;
    setLoading(true);
    setLoadError('');
    try {
      setData(await get<SessionListResponse>(`/api/sessions?accountId=${encodeURIComponent(targetId)}`, { timeoutMs: TIMEOUT.stats }));
    } catch (e: any) {
      setLoadError(e?.message || '读取会话列表失败');
    } finally {
      setLoading(false);
    }
  }, [targetId]);

  // 每次打开（或换目标账号）重新拉取：避免看到过期的「已复制」状态
  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setReport(null);
    setQuery('');
    setHideCopied(false);
    setStopApp(true);
    void load();
  }, [open, targetId, load]);

  // 列表就绪后自动预勾选「之前同步过」的会话：用户点开弹窗直接点「开始复制」，
  // 就能把所有已同步会话的内容与改名对齐到最新（不会产生新副本、不会重复）。
  useEffect(() => {
    if (!open || loading || !data) return;
    const pre = new Set(
      data.sessions.filter((s) => s.copied && s.hasBody).map((s) => s.id)
    );
    setSelected(pre);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, loading, data]);

  const sessions = data?.sessions || [];
  const copiedCount = useMemo(() => sessions.filter((s) => s.copied).length, [sessions]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions.filter((s) => {
      if (hideCopied && s.copied) return false;
      if (!q) return true;
      return (
        s.title.toLowerCase().includes(q) ||
        s.workspace.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q)
      );
    });
  }, [sessions, query, hideCopied]);

  const visible = filtered.slice(0, SESSION_RENDER_LIMIT);
  const selectableIds = useMemo(() => filtered.filter((s) => s.hasBody).map((s) => s.id), [filtered]);
  const selectedBytes = useMemo(
    () => sessions.reduce((sum, s) => (selected.has(s.id) ? sum + s.bytes : sum), 0),
    [sessions, selected]
  );
  /** 预勾选说明：打开弹窗时自动勾上了多少个「之前同步过」的会话 */
  const preCheckedNote = useMemo(() => {
    if (loading || !data) return '';
    const n = data.sessions.filter((s) => s.copied && s.hasBody).length;
    return n ? `（已自动勾选之前同步过的 ${n} 个，点「开始复制」即全部对齐到最新）` : '';
  }, [loading, data]);

  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const run = async () => {
    const ids = [...selected];
    if (!ids.length || !target) return;
    setBusy(true);
    setReport(null);
    try {
      if (mode === 'switch') {
        const r = await post<SwitchAccountResult>(
          '/api/accounts/switch',
          {
            id: target.id,
            copySessionIds: ids,
            stopApp,
            sourceVariant: (window as any).__wbVariant || undefined,
          },
          { timeoutMs: TIMEOUT.switch }
        );
        const rep = r?.sessionCopy || null;
        const failed = rep?.errors?.length || 0;
        const movedCount = (rep?.moved?.length || 0) + (rep?.merged?.length || 0);
        const mergedCount = rep?.merged?.length || 0;
        const reopenFailed = r?.relaunch ? r.relaunch.launched === false : false;
        const firstErr = rep?.errors?.[0]?.error || '';
        const tail = relaunchTail(r?.relaunch, !!r?.appStop?.wasRunning);
        // 三件事分开说：账号切没切成 / 会话转没转过去 / 有没有自动重新打开。
        // 之前把「重新打开失败」也算成切换失败（红框），用户会以为账号没切——其实已经切了。
        const level = failed && !movedCount ? 'err' : failed || reopenFailed ? 'info' : 'ok';
        toast(
          level,
          `已切换到「${target.name}」` +
            (movedCount ? `，${movedCount} 个会话已转移到该账号` : '') +
            (mergedCount ? `（其中 ${mergedCount} 个与原有副本合并为全量内容）` : '') +
            (failed ? `，${failed} 个会话转移失败${firstErr ? `（首个原因：${firstErr}）` : ''}` : '') +
            `；${tail}`
        );
        onDone();
        // 失败明细留在弹窗里给用户看；全部成功就直接关掉——登录态已切换，
        // 此时再拉会话列表会因为「源账号 = 目标账号」而报错，所以不做刷新。
        if (failed) setReport(rep);
        else onClose();
        return;
      }
      // 先预演（只读），让用户看清要转移多少个再确认——绝不一点就动数据
      const preview = await post<any>(
        '/api/sessions/move',
        { targetAccountId: target.id, ids, dryRun: true, sourceVariant: (window as any).__wbVariant || undefined },
        { timeoutMs: TIMEOUT.switch }
      );
      const pTotal = (preview?.moved?.length || 0) + (preview?.merged?.length || 0);
      if (!pTotal) {
        toast('ok', '没有需要转移的会话');
        setBusy(false);
        return;
      }
      const sure = await confirm({
        title: '确认转移会话',
        message: (
          <>
            <div>
              将把 <b>{pTotal}</b> 个会话从当前账号<b>转移</b>到「<b>{target.name}</b>」
              {preview?.merged?.length ? <>（其中 {preview.merged.length} 个与目标已有的同一会话合并为全量内容）</> : null}。
            </div>
            <ul className="mt-2 list-disc pl-5 text-sm leading-relaxed">
              <li>转移后这些会话从当前账号消失，目标账号拥有全部（磁盘只保留一份）</li>
              <li>执行前自动备份会话库；合并时源正文移入备份目录，可随时找回</li>
              <li>确认后<b>自动关闭 WorkBuddy</b>，完成后<b>自动重新打开</b>（无需手动操作）</li>
            </ul>
          </>
        ),
      });
      if (!sure) {
        setBusy(false);
        return;
      }
      const rep = await post<any>(
        '/api/sessions/move',
        {
          targetAccountId: target.id,
          ids,
          sourceVariant: (window as any).__wbVariant || undefined,
        },
        { timeoutMs: TIMEOUT.switch }
      );
      const movedCount = (rep?.moved?.length || 0) + (rep?.merged?.length || 0);
      const mergedCount = rep?.merged?.length || 0;
      const failed = rep?.errors?.length || 0;
      const skippedDeleted = rep?.skippedDeleted?.length || 0;
      const firstErr = rep?.errors?.[0]?.error || '';
      if (failed) {
        // 失败必须把明细留在弹窗里（此前只在 toast 里说一句「失败 N 个」，原因完全看不到）
        setReport(rep);
        toast(
          'err',
          `会话转移失败：${failed} 个没有搬过去${firstErr ? `（首个原因：${firstErr}）` : ''}` +
            (movedCount ? `，成功 ${movedCount} 个` : '') +
            '；明细见下方'
        );
      } else if (!movedCount && skippedDeleted) {
        setReport(rep);
        toast('info', `这 ${skippedDeleted} 个会话你在目标账号里删过同一对话，按「尊重删除」没有搬`);
      } else {
        // 搬家会先关掉 WorkBuddy、写完再打开；「没自动打开」要说清楚，别让用户以为卡住了
        const tail = relaunchTail(rep?.relaunch, !!rep?.appStop?.wasRunning);
        toast(
          rep?.relaunch && rep.relaunch.launched === false ? 'info' : 'ok',
          `已把 ${movedCount} 个会话转移到「${target.name}」` +
            (mergedCount ? `（其中 ${mergedCount} 个与原有副本合并为全量内容）` : '') +
            '，磁盘上只保留一份' +
            (tail ? `；${tail}` : '')
        );
        onClose();
      }
      setSelected(new Set());
      if (!failed) await load();
      onDone();
    } catch (e: any) {
      toast('err', e?.message || '复制失败');
    } finally {
      setBusy(false);
    }
  };

  /** 只有在「运行中且没有授权自动退出」时才真的挡住操作 */
  const blocked = wbRunning && !stopApp;

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      width="max-w-3xl"
      title={mode === 'switch' ? `转移会话并切换到「${target?.name}」` : `把会话转到「${target?.name}」`}
      subtitle={
        data
          ? `来源：当前登录账号 ${data.sourceUid.slice(0, 8)}… → 目标：${target?.name}（${target?.variantLabel}）`
          : '转移后源账号不再保留这些会话，磁盘上只存一份'
      }
      footer={
        <>
          <span className="mr-auto text-xs text-zinc-500">
            已选 <b className="tabular-nums text-zinc-800">{selected.size}</b> 个 · 约{' '}
            <b className="tabular-nums text-zinc-800">{fmtBytes(selectedBytes)}</b>
            {preCheckedNote}
          </span>
          <Button onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!selected.size || blocked || loading || !data?.supported}
            onClick={run}
            title={
              blocked
                ? 'WorkBuddy 正在运行：请勾选「自动退出 WorkBuddy」或自己先退出'
                : `${selected.size} 个会话${wbRunning && stopApp ? '（会先自动退出 WorkBuddy）' : ''}`
            }
          >
            <IconCopy className="w-3.5 h-3.5" />
            {mode === 'switch' ? '转移并切换' : '开始转移'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {/* 前置条件与副作用：这两条是用户最容易踩的坑，必须写在最上面 */}
        <div
          className={`flex items-start gap-2 rounded-xl border px-3.5 py-2.5 text-xs leading-relaxed ${
            blocked ? 'border-red-200 bg-red-50 text-red-800' : 'border-amber-200 bg-amber-50 text-amber-800'
          }`}
        >
          <IconWarning className={`mt-px w-3.5 h-3.5 shrink-0 ${blocked ? 'text-red-500' : 'text-amber-500'}`} />
          <span>
            {blocked ? (
              <>
                <b>WorkBuddy 正在运行，无法复制。</b>运行中的实例看不到写入，继续对话会让副本与源会话分叉。
                勾选下面的「自动退出 WorkBuddy」，或自己先完全退出后重试。
              </>
            ) : (
              <>
                复制前的写入要求 WorkBuddy 不在运行
                {wbRunning && stopApp ? '——下面已勾选自动退出，由本工具结束后台进程并确认退出' : ''}。
                复制出的会话是独立副本，WorkBuddy 下次启动时会把它们<b>上传到云端</b>，会占用云端空间与流量。
              </>
            )}
          </span>
        </div>

        {wbRunning && <StopAppRow checked={stopApp} onChange={setStopApp} />}

        {loading && (
          <div className="flex items-center gap-2 py-10 text-sm text-zinc-400">
            <Spinner className="w-4 h-4" />
            正在读取会话列表（本机数千个会话，需要索引一次正文目录）…
          </div>
        )}

        {!loading && loadError && (
          <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-700">
            <IconWarning className="mt-px w-3.5 h-3.5 shrink-0 text-red-500" />
            <span>{loadError}</span>
          </div>
        )}

        {!loading && !loadError && data && !data.supported && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-800">
            该档位暂不支持会话复制：数据根下缺少 <span className="font-mono">projects/</span> 目录或
            <span className="font-mono"> sessions</span> 表。
          </div>
        )}

        {!loading && !loadError && data?.supported && (
          <>
            <Toolbar>
              <div className="relative min-w-[180px] flex-1">
                <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索标题 / 工作区 / 会话 id"
                  className="h-8 w-full rounded-xl border border-zinc-200 bg-white pl-8 pr-3 text-xs text-zinc-700 outline-none transition-colors focus:border-indigo-400"
                />
              </div>
              <Button size="sm" onClick={() => setSelected(new Set(selectableIds))} disabled={!selectableIds.length}>
                全选当前
              </Button>
              <Button size="sm" onClick={() => setSelected(new Set())} disabled={!selected.size}>
                清空
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setHideCopied((v) => !v)}>
                {hideCopied ? `显示已复制的（${copiedCount}）` : '隐藏已复制的'}
              </Button>
            </Toolbar>

            <div className="text-[11px] text-zinc-400 leading-relaxed">
              共 {data.stats.total} 个会话（有正文 {data.stats.withBody} 个，合计 {fmtBytes(data.stats.bytes)}），
              当前筛选出 <b className="tabular-nums text-zinc-600">{filtered.length}</b> 个
              {filtered.length > visible.length ? `，只渲染前 ${SESSION_RENDER_LIMIT} 条，请用搜索缩小范围` : ''}
            </div>

            <div className="max-h-[38vh] space-y-1.5 overflow-y-auto pr-0.5">
              {visible.length === 0 && (
                <div className="py-10 text-center text-xs text-zinc-400">
                  {sessions.length === 0 ? '当前账号没有可复制的会话' : '没有匹配的会话'}
                </div>
              )}
              {visible.map((s) => {
                // 「已复制过」的会话依然可以勾选：目标账号里那份可能已经落后了（本账号又聊了新内容），
                // 再选一次不是重复复制，而是把新增内容与改名同步过去（后端按血缘原位合并）。
                const disabled = !s.hasBody;
                const checked = selected.has(s.id);
                return (
                  <label
                    key={s.id}
                    title={s.cwd || '(无工作区)'}
                    className={`flex items-center gap-3 rounded-xl border px-3 py-2 transition-colors ${
                      disabled
                        ? 'border-zinc-100 bg-zinc-50/60'
                        : checked
                          ? 'cursor-pointer border-indigo-300 bg-indigo-50/50'
                          : 'cursor-pointer border-zinc-200 hover:border-indigo-200 hover:bg-indigo-50/30'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 shrink-0 accent-indigo-600"
                      checked={checked}
                      disabled={disabled}
                      onChange={(e) => toggle(s.id, e.target.checked)}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className={`truncate text-sm ${disabled ? 'text-zinc-400' : 'font-medium text-zinc-800'}`}>
                          {s.title}
                        </span>
                        {s.isPlayground && <Badge color="violet">任务</Badge>}
                        {s.copied && (
                          <span
                            title={
                              s.copiedScope === 'family'
                                ? '这段对话已经通过其它账号同步到目标账号了（不是这一对账号直接复制的）；勾选也不会产生重复会话，只会把新增内容与改名同步过去'
                                : '目标账号里已经有同一份会话；再勾选复制不会产生重复会话，只会把新增内容与改名同步过去'
                            }
                          >
                            <Badge color="green">已复制</Badge>
                          </span>
                        )}
                        {!s.hasBody && <Badge color="amber">无正文</Badge>}
                      </div>
                      <div className="mt-0.5 flex min-w-0 items-center gap-x-2.5 text-[11px] text-zinc-400">
                        <span className="truncate">{s.workspace}</span>
                        <span className="shrink-0 tabular-nums">{fmtBytes(s.bytes)}</span>
                        <span className="shrink-0 tabular-nums">{s.updatedAt ? fmtDateTime(s.updatedAt) : '—'}</span>
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          </>
        )}

        {/* 结果：成功 / 跳过 / 失败逐条列出，避免"点了没反应" */}
        {report && <SessionReportBlock report={report} />}
      </div>
    </Modal>
  );
}

export default function AccountsPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [data, setData] = useState<AccountsResponse | null>(null);
  const [balances, setBalances] = useState<AccountBalancesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [balanceLoading, setBalanceLoading] = useState(true);
  /** 「刷新」进行中：刷新登录态的同时会把成长中心奖励领一遍 */
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [editing, setEditing] = useState<AccountInfo | null>(null);
  const [pkgTarget, setPkgTarget] = useState<AccountInfo | null>(null);
  /** 扫码添加账号弹窗（OAuth 设备码流程） */
  const [scanOpen, setScanOpen] = useState(false);
  /** 申诉与风险指引弹层（限制徽章点击 / 页头按钮共用） */
  const [riskGuideOpen, setRiskGuideOpen] = useState(false);
  /** 档位筛选：与 workbuddy-switch 一致，两套登录态分开管理 */
  const [variant, setVariant] = useState<'cn' | 'ai'>('cn');
  // 记录当前档位，供同步会话/切换账号弹窗在请求里带上（跨档位搬运靠它判断源）
  useEffect(() => {
    (window as any).__wbVariant = variant;
  }, [variant]);
  /** WorkBuddy 进程是否在运行：运行时切换会被它改写回去，需要提前提醒 */
  const [wbRunning, setWbRunning] = useState(false);
  /** 「退出 WorkBuddy」按钮的进行态 */
  const [stopping, setStopping] = useState(false);
  /** 会话复制弹窗的目标账号；`sessionMode` 决定按钮是「开始复制」还是「复制并切换」 */
  const [sessionTarget, setSessionTarget] = useState<AccountInfo | null>(null);
  const [sessionMode, setSessionMode] = useState<'copy' | 'switch'>('copy');
  /** 一键同步所有账号的进行态 */
  const [syncAllBusy, setSyncAllBusy] = useState(false);
  const [summaryBusy, setSummaryBusy] = useState(false);
  /** 一键去重的进行态 */
  const [dedupeBusy, setDedupeBusy] = useState(false);

  /** 一键去重：同账号内重复会话合并成一份（先预演再确认执行） */
  const dedupeNow = async () => {
    if (CROSS_ACCOUNT_SESSION_OPS_DISABLED) {
      toast('info', CROSS_ACCOUNT_OPS_REASON);
      return;
    }
    setDedupeBusy(true);
    let plan: any = null;
    try {
      plan = await post<any>('/api/sessions/dedupe', { dryRun: true }, { timeoutMs: 600000 });
    } catch (e: any) {
      setDedupeBusy(false);
      toast('err', `预演失败：${e?.message || e}`);
      return;
    }
    setDedupeBusy(false);
    const nGroups = plan?.groups?.length || 0;
    const nRemoved = plan?.removed?.length || 0;
    const nRenamed = plan?.renamed?.length || 0;
    const lines = plan?.appendedLines || 0;
    if (!nGroups) {
      toast('ok', '没有发现重复会话，无需清理');
      return;
    }
    const ok = await confirm({
      title: '确认执行一键去重',
      message: (
        <>
          <div>预演结果（<b>还没有改动任何数据</b>）：</div>
          <ul className="mt-2 list-disc pl-5 text-sm leading-relaxed">
            <li>{nGroups} 组同一对话的重复副本：<b>内容少的会合并进内容多的那一份</b>（缺的消息补进来，按时间排序），再删除 {nRemoved} 个多余副本</li>
            <li>{nRenamed} 个会话名将统一为最新的手改名字</li>
            <li className="text-zinc-500">删除的只是「重复副本」：执行前自动备份会话库，正文文件也仍保留在磁盘上，可恢复</li>
          </ul>
          <div className="mt-2 text-xs text-zinc-500">确认后自动关闭 WorkBuddy（先退出再写数据，不会丢内容），完成后自动重新打开，全程无需你手动操作。</div>
        </>
      ),
    });
    if (!ok) return;
    setDedupeBusy(true);
    try {
      const r = await post<any>('/api/sessions/dedupe', { stopApp: true }, { timeoutMs: 900000 });
      const parts = [`清理 ${r?.groups?.length || 0} 组`, `删除重复副本 ${r?.removed?.length || 0} 个`, `补入 ${r?.appendedLines || 0} 行`];
      if (r?.errors?.length) parts.push(`失败 ${r.errors.length} 个`);
      if (r?.appStop?.wasRunning) parts.push(r?.relaunch?.launched ? 'WorkBuddy 已重新打开' : 'WorkBuddy 未自动打开，请手动启动');
      toast(r?.ok ? 'ok' : 'err', `去重完成：${parts.join('，')}`);
    } catch (e: any) {
      toast('err', e?.message || '去重失败');
    } finally {
      setDedupeBusy(false);
    }
  };

  /** 一键同步：全部本机账号两两对齐（内容并集取最新 + 改名跟随），可选补全缺失会话 */
  const syncAllNow = async (fillMissing: boolean, pruneOthers = false) => {
    if (CROSS_ACCOUNT_SESSION_OPS_DISABLED) {
      toast('info', CROSS_ACCOUNT_OPS_REASON);
      return;
    }
    setSyncAllBusy(true);
    if (pruneOthers) setSummaryBusy(true);
    // 全量汇总：连国际版的会话也一起并进来
    const crossVariant = fillMissing && pruneOthers;
    const variant = (window as any).__wbVariant === 'ai' ? 'ai' : 'cn';
    const payload = { fillMissing, pruneOthers, crossVariant, variant };
    let plan: any = null;
    try {
      // 先预演：只读，不动任何数据，WorkBuddy 开着也能跑
      plan = await post<any>('/api/sessions/sync-all', { dryRun: true, ...payload }, { timeoutMs: 600000 });
    } catch (e: any) {
      setSyncAllBusy(false);
      setSummaryBusy(false);
      toast('err', `预演失败：${e?.message || e}`);
      return;
    }
    setSyncAllBusy(false);
    if (pruneOthers) setSummaryBusy(false); // 预演结束就复位，避免取消后按钮一直转圈
    const nContent = plan?.contentSynced?.length || 0;
    const nTitle = plan?.titleSynced?.length || 0;
    const lines = plan?.contentSynced?.reduce((s: number, c: any) => s + (c.appendedLines || 0), 0) || 0;
    const cross = Array.isArray(plan?.crossVariant) ? plan.crossVariant : [];
    const nCross = cross.reduce((s: number, c: any) => s + (c.copied || 0), 0);
    const crossMb = Math.round(cross.reduce((s: number, c: any) => s + (c.bytes || 0), 0) / 1048576);
    // 全量汇总：其他国内账号独有的会话（单向汇总进当前账号）
    const collected = plan?.collected?.copied || 0;
    const collectedMb = Math.round((plan?.collected?.bytes || 0) / 1048576);
    // 跨档位（国际版）独有会话
    const crossCnt = plan?.crossVariantCopy?.copied || 0;
    const crossOnlyMb = Math.round((plan?.crossVariantCopy?.freedBytes || 0) / 1048576);
    const ok = await confirm({
      title: pruneOthers ? '确认执行全账号会话同步汇总' : '确认执行一键同步',
      message: (
        <>
          <div>预演结果（<b>还没有改动任何数据</b>）：</div>
          <ul className="mt-2 list-disc pl-5 text-sm leading-relaxed">
            <li>{nContent} 个会话将补入新内容（共 {lines} 行，<b>只追加、不删除、不覆盖</b>）</li>
            <li>{nTitle} 个会话将更新名称（只写 title 两个字段）</li>
            {collected > 0 ? (
              <li>
                <b>{collected} 个其他账号独有的会话</b>将汇总进当前账号（约 {collectedMb} MB）
              </li>
            ) : null}
            {crossCnt > 0 ? (
              <li>
                <b>{crossCnt} 个国际版独有的会话</b>将并入当前账号（约 {crossOnlyMb} MB）
              </li>
            ) : null}
            {(plan?.skippedDeleted || []).length ? <li className="text-zinc-500">{(plan.skippedDeleted || []).length} 个会话你已在目标账号删过，<b>不会回填</b>（尊重删除）</li> : null}
            {pruneOthers && plan?.mergedWithin && plan.mergedWithin.groups ? <li><b>同账号内合并：</b>{plan.mergedWithin.groups} 组同一对话的多份副本将合并成最完整的一份（内容按时间取全，删掉 {plan.mergedWithin.removed} 份）</li> : null}
            {pruneOthers && plan?.prune ? <li><b>汇总后清理：</b>删除 {(plan.prune.pruned || 0)} 个其他账号的冗余副本（释放约 {Math.round(((plan.prune.freedBytes) || 0) / 1048576)} MB），只保留当前账号一份；你已删除的对话也会从其他账号一并清掉</li> : null}
            <li className="text-zinc-500">执行前自动备份整个会话库到 ~/.wb-switch/backups/，改坏可回滚</li>
          </ul>
          <div className="mt-2 text-xs text-zinc-500">确认后自动关闭 WorkBuddy（先退出再写数据，不会丢内容），完成后自动重新打开，全程无需你手动操作。</div>
        </>
      ),
    });
    if (!ok) return;
    setSyncAllBusy(true);
    if (pruneOthers) setSummaryBusy(true);
    try {
      const r = await post<any>('/api/sessions/sync-all', { stopApp: true, ...payload }, { timeoutMs: 3600000 });
      const parts = [
        `复制 ${r?.copied?.length || 0} 个`,
        `内容更新 ${r?.contentSynced?.length || 0} 个`,
        `改名 ${r?.titleSynced?.length || 0} 个`,
      ];
      const crossDone = Array.isArray(r?.crossVariant) ? r.crossVariant.reduce((s: number, c: any) => s + (c.copied || 0), 0) : 0;
      if (crossDone) parts.push(`其他档位并入 ${crossDone} 个`);
      const collectedDone = r?.collected?.copied || 0;
      if (collectedDone) parts.push(`其他账号独有并入 ${collectedDone} 个`);
      const crossOnly = r?.crossVariantCopy?.copied || 0;
      if (crossOnly) parts.push(`国际版并入 ${crossOnly} 个`);
      if (r?.errors?.length) parts.push(`失败 ${r.errors.length} 个`);
      if (r?.appStop?.wasRunning) parts.push(r?.relaunch?.launched ? 'WorkBuddy 已重新打开' : 'WorkBuddy 未自动打开，请手动启动');
      toast(r?.ok ? 'ok' : 'err', `全账号同步完成：${parts.join('，')}`);
    } catch (e: any) {
      toast('err', e?.message || '同步失败');
    } finally {
      setSyncAllBusy(false);
      setSummaryBusy(false);
    }
  };
  /** 切换确认框里两个勾选的值（弹窗消息是快照，只能靠 ref 传出来） */
  const copyOnSwitchRef = useRef(false);
  const stopAppRef = useRef(true);

  const load = useCallback(async () => {
    try {
      setData(await get<AccountsResponse>('/api/accounts'));
    } catch (e: any) {
      toast('err', e?.message || '读取账号失败');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const loadBalances = useCallback(async (refresh = false) => {
    setBalanceLoading(true);
    try {
      const res = await get<AccountBalancesResponse>(`/api/accounts/credits${refresh ? '?refresh=1' : ''}`, { timeoutMs: TIMEOUT.quota });
      setBalances(res);
      // 存一份本地快照：下次打开先用旧数据渲染，避免盯着「查询中」空等
      try {
        localStorage.setItem('wb-console:balances', JSON.stringify({ at: Date.now(), res }));
      } catch {
        /* 存不下就算了 */
      }
    } catch {
      /* 余额查询失败不阻塞账号列表，卡片上会显示"余额暂不可用" */
    } finally {
      setBalanceLoading(false);
    }
  }, []);

  /**
   * 「刷新」= 刷新登录态 + 余额，并且顺带把成长中心奖励领一遍。
   * 切完账号最容易忘的就是再去设置页点「一键领取」，这里合成一步。
   */
  const refreshAll = useCallback(async () => {
    setRefreshingAll(true);
    try {
      // 限流徽标/签到状态已有各自的 90s 轮询，这里不再手动逐个刷新
      const r = await post<{
        summary: { checked: number; already: number; skipped: number; failed: number; growthCredits?: number };
      }>('/api/workbuddy/checkin', { onlyPending: true }, { timeoutMs: TIMEOUT.quota });
      const s = r.summary;
      const parts: string[] = [];
      if (s.checked) parts.push(`新签到 ${s.checked} 个`);
      if (s.growthCredits) parts.push(`成长中心 +${s.growthCredits} 积分`);
      if (s.failed) parts.push(`失败 ${s.failed} 个`);
      toast(s.failed ? 'err' : 'ok', parts.length ? `刷新完成，顺带领取：${parts.join('，')}` : '刷新完成，今日奖励已领完');
    } catch (e: any) {
      toast('err', `刷新完成，但领取失败：${e?.message || '未知错误'}`);
    } finally {
      setRefreshingAll(false);
      // 开头不再预拉：load/loadBalances 都在收尾拉一次即可，开头那次纯属双倍开销
      // （loadBalances(true) 是 90 秒超时的官方额度全量扫描，每次刷新双倍打上游）
      load();
      void loadBalances(true);
    }
  }, [load, loadBalances, toast]);

  // 首屏：30 分钟内的上次余额快照先垫上
  useEffect(() => {
    try {
      const raw = localStorage.getItem('wb-console:balances');
      if (!raw) return;
      const saved = JSON.parse(raw) as { at: number; res: AccountBalancesResponse };
      if (saved?.res && Date.now() - Number(saved.at || 0) < 30 * 60 * 1000) setBalances(saved.res);
    } catch {
      /* 脏数据忽略 */
    }
  }, []);

  useEffect(() => {
    load();
    void loadBalances();
    const loadWb = () => get<LoadedInfo>('/api/workbuddy/status').then((i) => setWbRunning(!!i?.running)).catch(() => {});
    loadWb();
    const t = setInterval(loadWb, 30_000);
    return () => clearInterval(t);
  }, [load, loadBalances]);

  // 首次拿到数据后，档位默认跟着当前登录态走
  useEffect(() => {
    const v = data?.current?.variant;
    if (v === 'cn' || v === 'ai') setVariant(v);
  }, [data?.current?.variant]);

  /**
   * 续采：上次扫码没在弹窗里等到结果（关了弹窗 / 刷新了页面 / 去手机上操作太慢），
   * 这里继续读服务端状态，成功了就提示并刷新列表——否则会出现"手机上明明成功了，
   * 页面里却没有账号"这种最让人困惑的情况。
   */
  useEffect(() => {
    const pending = readPendingOAuth();
    if (!pending) return;
    let stopped = false;
    let timer: number | undefined;

    /**
     * 串行轮询而不是 setInterval：单次请求慢（服务端落盘卡顿）时，setInterval 会
     * 让请求不断叠加，抢光浏览器对同一主机的并发连接，反而把「读状态」这一枪排队
     * 到超时。这里等上一次有结果再排下一次。
     */
    const tick = async () => {
      if (stopped) return;
      try {
        const r = await post<OAuthPollResult>('/api/oauth/status', { loginId: pending.loginId }, { timeoutMs: TIMEOUT.oauth });
        if (stopped) return;
        if (r.done) {
          clearPendingOAuth();
          if (r.result) {
            toast('ok', `已扫码添加「${r.result.name}」`);
            load();
            void loadBalances(true);
          } else if (r.error) {
            toast('err', `扫码登录未完成：${r.error}`);
          }
          return;
        }
      } catch {
        /* 瞬时错误忽略，下个周期再试（服务端采集不受影响） */
      }
      if (!stopped) timer = window.setTimeout(tick, 3000);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 切换账号的收尾：写登录态文件（可先自动退出 WorkBuddy、再复制会话） */
  const switchNow = async (account: AccountInfo, copySessionIds: string[] = [], stopApp = true) => {
    setBusyId(account.id);
    try {
      const r = await post<SwitchAccountResult>(
        '/api/accounts/switch',
        {
          id: account.id,
          copySessionIds: copySessionIds.length ? copySessionIds : undefined,
          stopApp,
        },
        { timeoutMs: TIMEOUT.switch }
      );
      // 切换时服务端可能返回「搬家」结果（moved/merged），也可能返回「复制」结果（copied/skipped），
      // 两种都要兼容——之前只读 copied，字段不存在时抛 TypeError，界面就弹红框。
      const copied = r?.sessionCopy?.copied?.length || 0;
      const moved = r?.sessionCopy?.moved?.length || 0;
      const merged = r?.sessionCopy?.merged?.length || 0;
      const synced = r?.sessionCopy?.skipped?.length || 0;
      const transferFailed = r?.sessionCopy?.errors?.length || 0;
      const firstErr = r?.sessionCopy?.errors?.[0]?.error || '';
      const transferCount = copied + moved + merged;
      const wasStopped = !!r?.appStop?.wasRunning;
      const reopenFailed = r?.relaunch ? r.relaunch.launched === false : false;
      const tail = relaunchTail(r?.relaunch, wasStopped || !!r?.appStop?.wasRunning);
      // 账号已经切了、只是会话没搬完 / 只是没自动打开——不能都算「切换失败」
      const level = transferFailed && !transferCount ? 'err' : transferFailed || reopenFailed ? 'info' : 'ok';
      toast(
        level,
        `已切换到「${account.name}」` +
          (transferCount ? `，${transferCount} 个会话已转到该账号` : '') +
          (merged ? `（其中 ${merged} 个与原副本合并取全）` : '') +
          (synced ? `；${synced} 个已同步会话的最新内容与改名已带过去` : '') +
          (transferFailed ? `；${transferFailed} 个会话转移失败${firstErr ? `（${firstErr}）` : ''}` : '') +
          `，${tail}`
      );
      if (r?.backupPath) console.info('登录态备份：', r.backupPath);
      setSessionTarget(null);
      load();
    } catch (e: any) {
      toast('err', e?.message || '切换失败');
    } finally {
      setBusyId(null);
    }
  };

  const doSwitch = async (account: AccountInfo) => {
    copyOnSwitchRef.current = false;
    stopAppRef.current = true;
    const ok = await confirm({
      title: '切换账号',
      message: (
        <>
          将把账号「<b>{account.name}</b>」写入 WorkBuddy 登录态文件。
          <div className="mt-2.5 text-xs text-zinc-500 leading-relaxed">
            切换前会自动备份当前登录态（~/.wb-switch/backups/）。
          </div>
          <StopAppToggleRef flagRef={stopAppRef} />
          <CopyOnSwitchToggle flagRef={copyOnSwitchRef} />
          <div className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-zinc-400">
            <IconWarning className="w-3.5 h-3.5 shrink-0 mt-px text-amber-400" />
            <span>
              取消勾选「自动退出」就必须自己先完全退出 WorkBuddy；否则它会把登录态改写回去，切换不生效。
            </span>
          </div>
        </>
      ),
      confirmText: '开始切换',
    });
    if (!ok) return;
    // 勾了「同时复制会话」就先打开选择列表，由那次操作一并完成退出、复制与切换
    if (copyOnSwitchRef.current) {
      setSessionMode('switch');
      setSessionTarget(account);
      return;
    }
    await switchNow(account, [], stopAppRef.current);
  };

  /**
   * 手动刷新单个账号的凭据。
   *
   * 走 `force=1`：用户是**明确点在这个账号上**的，不必再拿"临期"替他判断。
   * 这与设置页那个批量「检查并刷新」刻意不同——批量动作要保持保守，避免无谓的凭据轮换。
   */
  const doRefreshToken = async (account: AccountInfo) => {
    setBusyId(account.id);
    try {
      const r = await post<AccountRefreshRunResponse>(
        '/api/accounts/refresh',
        {
          accountId: account.id,
          force: true,
        },
        { timeoutMs: TIMEOUT.oauth }
      );
      const row = r.results[0];
      if (row?.ok && row.action === 'refreshed') {
        toast('ok', `「${account.name}」凭据已刷新，有效期已顺延`);
      } else if (row?.ok) {
        // 跳过类结果优先用服务端给出的人话（如当前登录账号不参与自动刷新、失败冷却），
        // 没有 message 时才退回原因码，避免界面上出现 current / failed-cooldown 这种裸标识
        toast('info', row?.message || `「${account.name}」未做刷新（${row.reason}）`);
      } else {
        toast('err', row?.message || '刷新失败');
      }
      await load();
    } catch (e: any) {
      toast('err', e?.message || '刷新失败');
    } finally {
      setBusyId(null);
    }
  };

/** 一键结束后台全部 WorkBuddy 进程（与切换/复制里的自动退出同一条服务端逻辑） */
  const stopNow = async () => {
    const ok = await confirm({
      title: '退出 WorkBuddy',
      message: (
        <>
          将结束后台<b>全部</b> WorkBuddy 相关进程，并确认它们真的退出。
          <div className="mt-2.5 text-xs leading-relaxed text-zinc-500">
            正在进行的对话会<b className="text-red-600">立即中断</b>；关闭前未落盘的内容可能丢失。
            切换账号时勾选「自动退出 WorkBuddy」会自动完成这一步，并在切换后重新打开它。
          </div>
        </>
      ),
      confirmText: '退出',
      danger: true,
    });
    if (!ok) return;
    setStopping(true);
    try {
      const r = await post<AppStopResult>('/api/workbuddy/stop');
      if (r?.wasRunning) {
        // 提速版 stopWorkbuddy 用一条 taskkill 结束整棵树、不再逐个枚举（killed 恒空），
        // 文案只说结论，不编造进程数
        toast('ok', `已退出 WorkBuddy${r.forced ? '（强制结束）' : ''}`);
      } else {
        toast('ok', 'WorkBuddy 本来就没有在运行');
      }
      setWbRunning(false);
    } catch (e: any) {
      toast('err', e?.message || '退出 WorkBuddy 失败');
    } finally {
      setStopping(false);
    }
  };

  const doDelete = async (account: AccountInfo) => {
    const ok = await confirm({
      title: '删除账号',
      message: (
        <>
          确定从账号库删除「<b>{account.name}</b>」？该操作只删除本工具保存的记录，
          <b>不会影响 WorkBuddy 当前的登录态</b>，也无法撤销。
        </>
      ),
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    setBusyId(account.id);
    try {
      await del(`/api/accounts/${account.id}`, { timeoutMs: TIMEOUT.write });
      toast('ok', '已删除');
      load();
    } catch (e: any) {
      toast('err', e?.message || '删除失败');
    } finally {
      setBusyId(null);
    }
  };

  const doImport = async (v: VariantInfo) => {
    setImporting(v.id);
    try {
      const acc = await post<AccountInfo>('/api/accounts/import', { variant: v.id }, { timeoutMs: TIMEOUT.oauth });
      toast('ok', `已导入「${acc.name}」`);
      load();
      void loadBalances(true);
    } catch (e: any) {
      toast('err', e?.message || '导入失败');
    } finally {
      setImporting(null);
    }
  };

  /** 各账号「模型额度超限」状态（后端缓存 10 分钟，前端 90 秒轮询 + 窗口聚焦刷新） */
  const [modelLimits, setModelLimits] = useState<
    Record<string, { model: string; resetAt: number; resetKnown?: boolean; status?: number }[]>
  >({});
  /** 探测异常说明（非 429 的拒绝 / 超时 / 无可用凭据），按账号 id 或 uid 存 */
  const [limitNotes, setLimitNotes] = useState<Record<string, string>>({});

  const loadLimitStates = useCallback(async (refresh = false) => {
    try {
      const r = await get<{ accounts: Record<string, any>; accountNotes?: Record<string, string> }>(
        `/api/accounts/model-limits${refresh ? '?refresh=1' : ''}`
      );
      if (r?.accounts) setModelLimits(r.accounts);
      if (r?.accountNotes) setLimitNotes(r.accountNotes);
    } catch {
      /* 查询失败保留上一次结果，不清空 */
    }
  }, []);

  useEffect(() => {
    void loadLimitStates();
    // 限流是随时发生的事，只在挂载时拉一次会一直显示旧状态
    const timer = window.setInterval(() => void loadLimitStates(), 90_000);
    const onFocus = () => void loadLimitStates();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [loadLimitStates]);

  /** 今日签到/旅行状态（每 5 分钟由后端缓存刷新） */
  const [dailyStatus, setDailyStatus] = useState<
    Record<
      string,
      {
        checkedIn?: boolean;
        traveled?: boolean;
        travelState?: string | null;
        travelDailyLimit?: boolean;
        travelReward?: number;
        checkinError?: string | null;
        travelError?: string | null;
      }
    >
  >({});
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await get<{ accounts: Record<string, any> }>('/api/accounts/daily-status');
        if (!cancelled && r?.accounts) setDailyStatus(r.accounts);
      } catch {
        /* 查询失败不影响主界面 */
      }
    };
    load();
    // 签到/旅行状态会被服务端巡检和「一键领取」随时改变，只在挂载拉一次
    // 会永远显示旧的「今日未签到」——与限流徽标同款轮询模式（90s + focus 刷新）
    const timer = window.setInterval(() => void load(), 90_000);
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  const balanceOf = useCallback(
    (id: string): CreditBalance | null => balances?.accounts?.find((r) => r.accountId === id)?.balance ?? null,
    [balances]
  );

  /** 官方已拒绝凭据的账号 id 集合（余额查询结果是目前最可靠的验活信号） */
  const authInvalidIds = useMemo(
    () => new Set((balances?.accounts || []).filter((r) => r.authInvalid).map((r) => r.accountId)),
    [balances]
  );

  /**
   * 账号排序：按「还有剩余（>0）的积分包里最早的过期时间」升序——谁先过期谁排前面。
   * 剩余为 0 的包不参与排序（它们的到期时间没有意义）；没有有效积分的账号排最后。
   */
  const visibleAccounts = useMemo(() => {
    const list = (data?.accounts || []).filter((a) => a.variant === variant);
    const earliestExpiry = (accountId: string): number => {
      const balance = balances?.accounts?.find((r) => r.accountId === accountId)?.balance;
      const times = (balance?.packages || [])
        .filter((p) => (p.remaining ?? 0) > 0 && p.expireAt)
        .map((p) => Number(p.expireAt))
        .filter((n) => Number.isFinite(n) && n > 0);
      return times.length ? Math.min(...times) : Number.POSITIVE_INFINITY;
    };
    return list.slice().sort((x, y) => earliestExpiry(x.id) - earliestExpiry(y.id));
  }, [data, variant, balances]);
  const activeVariant = (data?.variants || []).find((v) => v.id === variant);

  const stats = useMemo(() => {
    const list = data?.accounts || [];
    return {
      total: list.length,
      // 可用 = 有明文凭据、本地未过期、且服务端**没有**拒绝它
      usable: list.filter((a) => a.hasPlainToken && !a.expired && !authInvalidIds.has(a.id)).length,
      needsAuth: list.filter((a) => !a.hasPlainToken || a.expired || authInvalidIds.has(a.id)).length,
    };
  }, [data, authInvalidIds]);

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-16 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    );
  }

  const current = data?.current;
  const accounts = data?.accounts || [];

  return (
    <div className="space-y-5">
      {/* 页头：档位切换 + 运行状态（大标题由顶栏负责，这里不重复） */}
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          value={variant}
          onChange={setVariant}
          options={[
            { value: 'cn', label: '国内版' },
            { value: 'ai', label: '国际版' },
          ]}
        />
        <span className="text-xs text-zinc-400 leading-relaxed">
          两套登录态互相独立，账号库与 workbuddy-switch 共用同一份文件
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {wbRunning ? (
            <Badge color="green" dot>
              <IconPower className="w-3 h-3" />
              WorkBuddy 运行中
            </Badge>
          ) : (
            <Badge color="gray" dot>
              <IconPower className="w-3 h-3" />
              WorkBuddy 未运行
            </Badge>
          )}
        </div>
      </div>

      {/* 添加与迁移账号 */}
      <div className="relative overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-50/80 px-5 py-5 shadow-[0_6px_20px_rgba(15,23,42,.025)]">
        <div className="pointer-events-none absolute -right-12 -top-20 size-44 rounded-full border-[28px] border-zinc-400/[0.06]" />
        <div className="relative flex flex-wrap items-center gap-x-5 gap-y-4">
          <div className="min-w-[200px] flex-1">
            <h2 className="text-sm font-semibold text-zinc-900">添加与迁移账号</h2>
            <p className="mt-1 text-xs leading-5 text-zinc-500">
              扫码授权后自动采集账号入库；也可读取本机 WorkBuddy 登录态文件迁移已有账号，已存在的只更新凭据、保留本地备注
            </p>
            {activeVariant && (
              <p className="mt-1.5 truncate font-mono text-[11px] text-zinc-400" title={activeVariant.authFilePath}>
                {activeVariant.authFilePath}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="subtle"
              className="h-9 px-3.5"
              onClick={() => setRiskGuideOpen(true)}
              title="账号被封了？申诉教程与官方入口；各功能的风控风险点与已内置的防御"
            >
              申诉与风险指引
            </Button>
            <Button
              variant="primary"
              className="h-9 px-3.5"
              onClick={() => setScanOpen(true)}
              title={`打开官方${variant === 'ai' ? '国际版' : '国内版'}授权页，扫码/登录后自动采集账号入库`}
            >
              <IconQrCode className="w-3.5 h-3.5" />
              扫码添加账号
            </Button>
            <span className="hidden h-6 w-px bg-zinc-200 sm:block" />
            {(data?.variants || []).map((v) => (
              <Button
                key={v.id}
                variant="subtle"
                className="h-9 px-3.5"
                loading={importing === v.id}
                onClick={() => doImport(v)}
                title={`从 ${v.authFilePath} 导入当前登录的账号`}
              >
                <IconArrowDown className="w-3.5 h-3.5" />
                导入{v.label}
              </Button>
            ))}
          </div>
        </div>
      </div>

      {/* 运行中提醒：WorkBuddy 会把登录态改写回去，这是切换不生效的主因 */}
      {wbRunning && (
        <div className="flex flex-wrap items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-800 leading-relaxed">
          <IconWarning className="w-3.5 h-3.5 shrink-0 mt-px text-amber-500" />
          <span className="min-w-[220px] flex-1">
            <b>WorkBuddy 正在运行。</b>此时切换账号会被它改写回原账号。切换 / 复制时勾选
            「自动退出 WorkBuddy」即可由本工具直接结束后台进程，不需要你手动关闭。
          </span>
          <Button size="sm" variant="danger" className="shrink-0" loading={stopping} onClick={stopNow}>
            <IconPower className="w-3.5 h-3.5" />
            退出 WorkBuddy
          </Button>
        </div>
      )}

      {/* 当前登录态 */}
      <Card className="p-4">
        <SectionHeader
          icon={<IconUsers />}
          title="当前登录态"
          desc="切换账号会重写 WorkBuddy 的登录态文件，操作前自动备份，失败自动回滚"
          actions={
            <Button size="sm" loading={refreshingAll} onClick={refreshAll} title="刷新登录态与余额，并顺手领取今日签到与成长中心奖励">
              <IconRefresh className="w-3.5 h-3.5" />
              刷新
            </Button>
          }
        />
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {current?.exists && current.account ? (
            <>
              <Avatar name={current.account.name} seed={current.account.uid || current.account.id} />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-zinc-900">{current.account.name}</span>
                  <Badge color="green" dot>
                    已登录
                  </Badge>
                  <Badge color="gray">{current.account.variantLabel}</Badge>
                </div>
                <div className="mt-1 text-xs text-zinc-400 font-mono truncate max-w-[520px]">{current.authFilePath}</div>
              </div>
            </>
          ) : (
            <>
              <div className="w-12 h-12 rounded-full bg-amber-50 border border-amber-200 text-amber-500 flex items-center justify-center shrink-0">
                <IconWarning className="w-5 h-5" />
              </div>
              <div>
                <div className="font-medium text-zinc-900">未检测到登录态</div>
                <div className="text-xs text-zinc-400 mt-0.5">
                  {current?.uid ? `登录态中的账号（${current.uid.slice(0, 8)}…）尚未导入到账号库` : 'WorkBuddy 登录态文件不存在或已损坏'}
                </div>
              </div>
            </>
          )}
        </div>
        {current?.warning && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2 text-xs text-amber-800">
            <IconWarning className="w-3.5 h-3.5 shrink-0 mt-px text-amber-500" />
            {current.warning}
          </div>
        )}
      </Card>

      {/* 账号列表 */}
      <section className="min-w-0">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold tracking-tight text-zinc-900">
              {variant === 'ai' ? '国际版' : '国内版'}账号
            </h2>
            <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full border border-zinc-200 bg-zinc-100 px-1.5 text-[11px] font-medium tabular-nums text-zinc-500">
              {visibleAccounts.length}
            </span>
            {stats.needsAuth > 0 && (
              <span className="text-xs text-zinc-400">
                全部 {stats.total} 个中 {stats.needsAuth} 个需要重新登录
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              loading={summaryBusy}
              disabled={syncAllBusy || CROSS_ACCOUNT_SESSION_OPS_DISABLED}
              onClick={() => syncAllNow(false, true)}
              title={
                CROSS_ACCOUNT_SESSION_OPS_DISABLED
                  ? CROSS_ACCOUNT_OPS_REASON
                  : '把各账号（含国际版）独有的会话都并进当前账号，同一对话合并成一份；铺满后自动清理其他账号的冗余副本'
              }
            >
              全账号会话同步汇总
            </Button>
            <Button
              variant="outline"
              size="sm"
              loading={dedupeBusy}
              disabled={dedupeBusy || CROSS_ACCOUNT_SESSION_OPS_DISABLED}
              onClick={dedupeNow}
              title={
                CROSS_ACCOUNT_SESSION_OPS_DISABLED
                  ? CROSS_ACCOUNT_OPS_REASON
                  : '同名的同一对话只保留内容最完整的一份，其余副本删除（先预演确认，执行前自动备份）'
              }
            >
              一键去重
            </Button>
          </div>
        </div>

        {visibleAccounts.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-300 px-4 py-16 text-center">
            <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-zinc-100 text-zinc-400">
              <IconUser className="w-5 h-5" />
            </div>
            <p className="text-sm text-zinc-500">暂无{variant === 'ai' ? '国际版' : '国内版'}账号。</p>
            <p className="mt-2 text-xs leading-5 text-zinc-400">
              先用 WorkBuddy 登录一个账号，再点上方「导入{variant === 'ai' ? '国际版' : '国内版'}」加入账号库，之后就能在这里一键切换。
            </p>
          </div>
        ) : (
          <div className="grid min-w-0 gap-5 grid-cols-[repeat(auto-fit,minmax(min(100%,320px),1fr))]">
            {visibleAccounts.map((a) => (
              <AccountCard
                key={a.id}
                account={a}
                isCurrent={current?.account?.id === a.id}
                busy={busyId === a.id}
                daily={dailyStatus[a.id] || dailyStatus[a.uid] || undefined}
                modelLimits={modelLimits[a.id] || modelLimits[a.uid] || undefined}
                limitNote={limitNotes[a.id] || limitNotes[a.uid] || undefined}
                balance={balanceOf(a.id)}
                balanceLoading={balanceLoading && !balanceOf(a.id)}
                authInvalid={authInvalidIds.has(a.id)}
                onSwitch={() => doSwitch(a)}
                onSyncSessions={() => {
                  setSessionMode('copy');
                  setSessionTarget(a);
                }}
                onRename={() => setEditing(a)}
                onRefreshToken={() => doRefreshToken(a)}
                onDelete={() => doDelete(a)}
                onShowPackages={() => setPkgTarget(a)}
                onOpenRiskGuide={() => setRiskGuideOpen(true)}
              />
            ))}
          </div>
        )}
      </section>

      {/* 数据位置脚注：与顶栏副标题呼应，只补充具体路径，不重复导入入口 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-1 text-[11px] text-zinc-400">
        <span className="inline-flex items-center gap-1.5">
          <IconInfo className="w-3.5 h-3.5 shrink-0" />
          账号库 <span className="font-mono">~/.wb-switch/accounts.json</span> 与 workbuddy-switch 共用，两个工具可同时安装、随时切换
        </span>
        {(data?.variants || []).map((v) => (
          <span key={v.id} className="font-mono truncate" title={v.authFilePath}>
            {v.label}：{v.authFilePath}
          </span>
        ))}
      </div>

      <RenameDialog account={editing} onClose={() => setEditing(null)} onSaved={load} />
      <SessionCopyDialog
        open={!!sessionTarget}
        target={sessionTarget}
        mode={sessionMode}
        wbRunning={wbRunning}
        onClose={() => setSessionTarget(null)}
        onDone={load}
      />
      <PackagesDialog account={pkgTarget} balance={pkgTarget ? balanceOf(pkgTarget.id) : null} onClose={() => setPkgTarget(null)} />
      <ScanAddDialog
        open={scanOpen}
        variant={variant}
        variantLabel={variant === 'ai' ? '国际版' : '国内版'}
        onClose={() => setScanOpen(false)}
        onAdded={(acc) => {
          toast('ok', `已扫码添加「${acc.name}」`);
          load();
          void loadBalances(true);
        }}
      />
      <BanRiskGuide open={riskGuideOpen} onClose={() => setRiskGuideOpen(false)} />
    </div>
  );
}
