import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { pushNotification } from '../lib/notify';

/* ---------------- Icons（内联 SVG，避免额外依赖） ---------------- */

type IconProps = { className?: string };
const icon = (path: React.ReactNode, viewBox = '0 0 24 24') =>
  function Icon({ className = 'w-4 h-4' }: IconProps) {
    return (
      <svg className={className} viewBox={viewBox} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {path}
      </svg>
    );
  };

export const IconRefresh = icon(<><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></>);
export const IconSearch = icon(<><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>);
export const IconPlus = icon(<><path d="M12 5v14" /><path d="M5 12h14" /></>);
export const IconTrash = icon(<><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></>);
export const IconCheck = icon(<path d="M20 6 9 17l-5-5" />);
export const IconX = icon(<><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>);
export const IconLoader = icon(<path d="M21 12a9 9 0 1 1-6.22-8.56" />);
export const IconDownload = icon(<><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></>);
export const IconKey = icon(<><circle cx="8" cy="15" r="4" /><path d="m10.8 12.2 8.7-8.7" /><path d="m16.5 6.5 3 3" /></>);
export const IconChart = icon(<><path d="M3 3v18h18" /><path d="M7 15v3" /><path d="M12 10v8" /><path d="M17 6v12" /></>);
export const IconGrid = icon(<><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>);
export const IconGauge = icon(<><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" /><path d="m14 10 3-3" /><path d="M3.3 17a9 9 0 1 1 17.4 0" /></>);
export const IconSettings = icon(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h0a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h0a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v0a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z" /></>);
export const IconCopy = icon(<><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>);
export const IconChevronLeft = icon(<path d="m15 18-6-6 6-6" />);
export const IconChevronRight = icon(<path d="m9 18 6-6-6-6" />);
export const IconChevronDown = icon(<path d="m6 9 6 6 6-6" />);
export const IconChevronUp = icon(<path d="m18 15-6-6-6 6" />);
export const IconInfo = icon(<><circle cx="12" cy="12" r="9" /><path d="M12 8h.01" /><path d="M12 12v4" /></>);
export const IconExternalLink = icon(<><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></>);
export const IconSliders = icon(<><path d="M4 6h10" /><path d="M18 6h2" /><path d="M4 12h4" /><path d="M12 12h8" /><path d="M4 18h10" /><path d="M18 18h2" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="16" cy="18" r="2" /></>);
export const IconWarning = icon(<><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4" /><path d="M12 17h.01" /></>);
export const IconSparkles = icon(<><path d="M12 3v4" /><path d="M12 17v4" /><path d="M3 12h4" /><path d="M17 12h4" /><path d="m6.3 6.3 2.4 2.4" /><path d="m15.3 15.3 2.4 2.4" /><path d="m17.7 6.3-2.4 2.4" /><path d="m8.7 15.3-2.4 2.4" /></>);
export const IconInbox = icon(<><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1Z" /></>);
export const IconClock = icon(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>);
export const IconEye = icon(<><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></>);
export const IconEyeOff = icon(<><path d="M10.6 6.2A9.6 9.6 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3 3.6" /><path d="M6.2 6.2A17 17 0 0 0 2 12s3.6 6 10 6a9.6 9.6 0 0 0 3.8-.8" /><path d="m2 2 20 20" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>);
export const IconShield = icon(<><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-4" /></>);
export const IconUsers = icon(<><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>);
export const IconUser = icon(<><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></>);
export const IconWallet = icon(<><path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h15a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5" /><path d="M16 12h.01" /></>);
export const IconSwitch = icon(<><path d="M16 3h5v5" /><path d="M8 3H3v5" /><path d="M21 8l-7 7-3-3" /><path d="M3 16l7-7 3 3" /></>);
export const IconEdit = icon(<><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z" /></>);
export const IconZap = icon(<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z" />);
export const IconDatabase = icon(<><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" /></>);
export const IconArrowDown = icon(<><path d="M12 5v14" /><path d="m19 12-7 7-7-7" /></>);
export const IconPower = icon(<><path d="M12 2v10" /><path d="M18.4 6.6a9 9 0 1 1-12.7.1" /></>);
export const IconCoins = icon(<><circle cx="8" cy="8" r="6" /><path d="M18.09 10.37A6 6 0 1 1 10.34 18" /><path d="M7 6h1v4" /><path d="m16.71 13.88.7.71-2.82 2.82" /></>);
export const IconLayers = icon(<><path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" /><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" /><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" /></>);
export const IconTrendUp = icon(<><path d="M16 7h6v6" /><path d="m22 7-8.5 8.5-5-5L2 17" /></>);
export const IconBox = icon(<><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><path d="m3.3 7 8.7 5 8.7-5" /><path d="M12 22V12" /></>);
export const IconCalendar = icon(<><path d="M8 2v4" /><path d="M16 2v4" /><rect width="18" height="18" x="3" y="4" rx="2" /><path d="M3 10h18" /></>);
export const IconHash = icon(<><line x1="4" x2="20" y1="9" y2="9" /><line x1="4" x2="20" y1="15" y2="15" /><line x1="10" x2="8" y1="3" y2="21" /><line x1="16" x2="14" y1="3" y2="21" /></>);
export const IconGaugeSmall = icon(<><path d="m12 14 4-4" /><path d="M3.34 19a10 10 0 1 1 17.32 0" /></>);
export const IconQrCode = icon(
  <>
    <rect width="5" height="5" x="3" y="3" rx="1" />
    <rect width="5" height="5" x="16" y="3" rx="1" />
    <rect width="5" height="5" x="3" y="16" rx="1" />
    <path d="M21 16h-3a2 2 0 0 0-2 2v3" />
    <path d="M21 21v.01" />
    <path d="M12 7v3a2 2 0 0 1-2 2H7" />
    <path d="M3 12h.01" />
    <path d="M12 3h.01" />
    <path d="M12 12v.01" />
    <path d="M16 12h1" />
    <path d="M21 12v.01" />
    <path d="M12 21v-1" />
  </>
);

/* ---------------- 共享设计令牌 ---------------- */

/**
 * 卡片阴影：两层叠加——近处 1px 勾边、远处 28px 铺开。
 * 比单层 shadow-sm 更柔和，也不会像 shadow-md 那样发灰。
 */
export const CARD_SHADOW = 'shadow-[0_1px_2px_rgba(15,23,42,.025),0_10px_28px_rgba(15,23,42,.035)]';
export const CARD_SHADOW_HOVER = 'hover:shadow-[0_2px_4px_rgba(15,23,42,.04),0_14px_34px_rgba(15,23,42,.055)]';

/** 圆角体系：卡片/面板用 2xl，内部小元素（徽标、输入框）用 xl，胶囊用 full */
export const RADIUS_CARD = 'rounded-2xl';

/* ---------------- Button ---------------- */

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger' | 'subtle' | 'outline';
  size?: 'xs' | 'sm' | 'md';
  loading?: boolean;
};

export function Button({ variant = 'subtle', size = 'md', loading, className = '', children, disabled, ...rest }: ButtonProps) {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-xl font-medium transition-all duration-150 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 whitespace-nowrap';
  const sizes = { xs: 'h-6 px-2 text-[11px]', sm: 'h-7 px-2.5 text-xs', md: 'h-9 px-3.5 text-sm' };
  const variants = {
    primary: 'bg-indigo-600 text-white hover:bg-indigo-700 active:bg-indigo-800 shadow-sm shadow-indigo-600/25',
    ghost: 'text-zinc-600 hover:bg-zinc-200/70 hover:text-zinc-900',
    danger: 'bg-red-50 text-red-600 hover:bg-red-100 border border-red-200',
    subtle: 'bg-white text-zinc-700 border border-zinc-200 hover:bg-zinc-50 hover:border-zinc-300 shadow-sm shadow-zinc-900/5',
    outline: 'bg-transparent text-indigo-600 border border-indigo-300 hover:bg-indigo-50',
  };
  return (
    <button className={`${base} ${sizes[size]} ${variants[variant]} ${className}`} disabled={disabled || loading} {...rest}>
      {loading && <IconLoader className="w-3.5 h-3.5 animate-spin" />}
      {children}
    </button>
  );
}

/* ---------------- Badge ---------------- */

const badgeColors: Record<string, string> = {
  green: 'bg-emerald-50 text-emerald-700 border-emerald-200/80',
  teal: 'bg-teal-50 text-teal-700 border-teal-200/80',
  blue: 'bg-sky-50 text-sky-700 border-sky-200/80',
  gray: 'bg-zinc-100 text-zinc-500 border-zinc-200/80',
  amber: 'bg-amber-50 text-amber-700 border-amber-200/80',
  red: 'bg-red-50 text-red-600 border-red-200/80',
  violet: 'bg-violet-50 text-violet-700 border-violet-200/80',
};

const dotColors: Record<string, string> = {
  green: 'bg-emerald-500',
  teal: 'bg-teal-500',
  blue: 'bg-sky-500',
  gray: 'bg-zinc-400',
  amber: 'bg-amber-500',
  red: 'bg-red-500',
  violet: 'bg-violet-500',
};

export function Badge({
  color = 'gray',
  className = '',
  dot,
  children,
}: {
  color?: keyof typeof badgeColors | string;
  className?: string;
  /** 前置状态圆点，用于「运行中 / 已连接」等状态语义 */
  dot?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-lg border px-1.5 py-0.5 text-[11px] leading-none font-medium ${badgeColors[color] || badgeColors.gray} ${className}`}
    >
      {dot && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColors[color] || dotColors.gray}`} />}
      {children}
    </span>
  );
}

/* ---------------- Card ---------------- */

export function Card({ className = '', children }: { className?: string; children: React.ReactNode }) {
  return <div className={`${RADIUS_CARD} border border-zinc-200/80 bg-white ${CARD_SHADOW} ${className}`}>{children}</div>;
}

/**
 * 卡片内的统一小节标题：图标 + 标题 + 右侧操作。
 * 适合放在 Card 内部；页面级分区标题请用 PageSection。
 */
export function SectionHeader({
  icon,
  title,
  desc,
  actions,
  className = '',
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  desc?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap items-start gap-3 ${className}`}>
      {icon && (
        <div className="w-8 h-8 rounded-xl bg-indigo-50 text-indigo-500 flex items-center justify-center shrink-0 [&>svg]:w-4 [&>svg]:h-4">
          {icon}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="font-medium text-zinc-900 leading-tight">{title}</div>
        {desc && <div className="text-xs text-zinc-400 mt-1 leading-relaxed">{desc}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-1.5">{actions}</div>}
    </div>
  );
}

/**
 * 页面级分区：标题**浮在卡片外面**，下面直接放内容。
 *
 * 比「一张大 Card 套 SectionHeader」更透气：分区之间靠留白分隔，
 * 标题和它管辖的内容视觉上是一组，也不会出现三层嵌套的白盒子。
 */
export function PageSection({
  icon,
  title,
  count,
  desc,
  actions,
  children,
  className = '',
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  /** 标题右侧的数量徽标，如「2」个账号 */
  count?: React.ReactNode;
  desc?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`min-w-0 ${className}`}>
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        {icon && (
          <div className="w-8 h-8 rounded-xl bg-indigo-50 text-indigo-500 flex items-center justify-center shrink-0 [&>svg]:w-4 [&>svg]:h-4">
            {icon}
          </div>
        )}
        <h2 className="text-base font-semibold tracking-tight text-zinc-900">{title}</h2>
        {count != null && count !== '' && (
          <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full border border-zinc-200 bg-zinc-100 px-1.5 text-[11px] font-medium tabular-nums text-zinc-500">
            {count}
          </span>
        )}
        {desc && <span className="text-xs text-zinc-400">{desc}</span>}
        {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** 筛选工具栏：各页的控制条统一容器，圆角与阴影和 Card 一致 */
export function Toolbar({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex flex-wrap items-center gap-2.5 ${RADIUS_CARD} border border-zinc-200/80 bg-white px-3.5 py-3 ${CARD_SHADOW} ${className}`}>
      {children}
    </div>
  );
}

/**
 * 概览数字卡：图标 + 标签 + 大数字 + 副标题。
 * 统计页 / 积分页 / 额度页的总览区共用，保证三处的字号、字重、间距一致。
 */
export function StatCard({
  label,
  value,
  sub,
  accent,
  icon,
  tone = 'indigo',
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  /** 数字文字色，缺省 zinc-900 */
  accent?: string;
  icon?: React.ReactNode;
  tone?: 'indigo' | 'emerald' | 'amber' | 'violet' | 'rose' | 'sky' | 'zinc';
}) {
  const tones: Record<string, string> = {
    indigo: 'bg-indigo-50 text-indigo-500',
    emerald: 'bg-emerald-50 text-emerald-500',
    amber: 'bg-amber-50 text-amber-500',
    violet: 'bg-violet-50 text-violet-500',
    rose: 'bg-rose-50 text-rose-500',
    sky: 'bg-sky-50 text-sky-500',
    zinc: 'bg-zinc-100 text-zinc-400',
  };
  return (
    <div className={`${RADIUS_CARD} border border-zinc-200/80 bg-white px-4 py-3.5 ${CARD_SHADOW} ${CARD_SHADOW_HOVER} transition-shadow`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] font-medium text-zinc-400">{label}</div>
          <div className={`mt-1.5 text-[22px] font-semibold leading-none tracking-[-0.025em] tabular-nums ${accent || 'text-zinc-900'}`}>
            {value}
          </div>
          {sub && <div className="mt-1.5 text-[11px] text-zinc-400 truncate">{sub}</div>}
        </div>
        {icon && (
          <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${tones[tone]} [&>svg]:w-4 [&>svg]:h-4`}>
            {icon}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- ProgressBar ---------------- */

export function ProgressBar({
  percent,
  color = 'bg-indigo-500',
  size = 'md',
  className = '',
}: {
  percent: number;
  color?: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const p = Math.max(0, Math.min(100, percent));
  return (
    <div className={`${size === 'sm' ? 'h-1.5' : 'h-2'} w-full bg-zinc-100 rounded-full overflow-hidden ${className}`}>
      <div className={`h-full rounded-full transition-all duration-500 ${color}`} style={{ width: `${p}%` }} />
    </div>
  );
}

/* ---------------- Segmented ---------------- */

export function Segmented<T extends string>({ value, onChange, options, size = 'md', className = '' }: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: React.ReactNode; title?: string }[];
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <div className={`inline-flex rounded-xl bg-zinc-100/90 p-0.5 ring-1 ring-inset ring-zinc-200/60 ${className}`} role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={`rounded-[10px] transition-all duration-150 ${size === 'sm' ? 'px-2.5 h-6 text-xs' : 'px-3 h-7 text-xs'} ${
            value === o.value
              ? 'bg-white text-zinc-900 font-medium shadow-sm shadow-zinc-900/5 ring-1 ring-inset ring-zinc-200/60'
              : 'text-zinc-500 hover:text-zinc-800'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------------- Skeleton ---------------- */

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse bg-zinc-100 rounded ${className}`} />;
}

/* ---------------- Switch（胶囊滑动开关） ---------------- */

/**
 * 左右滑动的胶囊开关：圆形旋钮在胶囊轨道上滑，开启时轨道变靛蓝、旋钮滑到右侧。
 * 状态文字（可选）显示在开关旁边而不是胶囊里——胶囊太小放不下字；
 * 不传 onText/offText 时只渲染开关本身。
 */
export function Switch({
  checked,
  onChange,
  disabled,
  onText = '开启',
  offText = '关闭',
  title,
  className = '',
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  onText?: React.ReactNode;
  offText?: React.ReactNode;
  title?: string;
  className?: string;
}) {
  const label = checked ? onText : offText;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!checked)}
      className={`inline-flex shrink-0 items-center gap-2 ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer select-none'} ${className}`}
    >
      {label ? <span className="text-xs text-zinc-500">{label}</span> : null}
      <span
        className={`relative inline-block h-5 w-9 shrink-0 rounded-full transition-colors duration-200 ${
          checked ? 'bg-indigo-600' : 'bg-zinc-300'
        }`}
      >
        <span
          className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${
            checked ? 'translate-x-4' : 'translate-x-0'
          }`}
        />
      </span>
    </button>
  );
}


/* ---------------- Modal ---------------- */

export function Modal({ open, onClose, title, subtitle, children, footer, width = 'max-w-lg' }: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: string;
}) {
  // ESC 关闭 + 打开期间锁定背景滚动（长列表下避免"滚动穿透"）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;
  // 一律走 portal 挂到 body：
  // - 祖先若有 backdrop-filter / transform（页头就是），fixed 会被困在那个层叠上下文里，
  //   弹窗既裁切又压不到正文之上（2026-10-19 实测：指南弹窗只剩一条白带）
  // - items-start + 整层 overflow-y-auto：内容比视口高时整层滚动，而不是把弹窗顶出屏幕
  return createPortal(
    (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4">
      <div className="absolute inset-0 bg-zinc-900/45 backdrop-blur-[2px] animate-fade-in" onClick={onClose} />
      <div className={`relative my-auto bg-white rounded-2xl shadow-2xl ring-1 ring-zinc-900/5 w-full ${width} max-h-[min(85vh,680px)] flex flex-col animate-pop-in`}>
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-zinc-100 shrink-0">
          <div className="min-w-0">
            <div className="font-semibold text-zinc-900">{title}</div>
            {subtitle && <div className="text-xs text-zinc-400 mt-0.5">{subtitle}</div>}
          </div>
          <button
            onClick={onClose}
            aria-label="关闭"
            className="-mr-1 -mt-0.5 p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 transition-colors"
          >
            <IconX />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="px-5 py-3.5 border-t border-zinc-100 bg-zinc-50/70 rounded-b-2xl flex flex-wrap justify-end gap-2 shrink-0">{footer}</div>}
      </div>
    </div>
    ),
    document.body
  );
}

/* ---------------- Confirm（替代原生 window.confirm，样式统一且支持长文案） ---------------- */

export type ConfirmOptions = {
  title: string;
  message?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
};

type ConfirmFn = (o: ConfirmOptions) => Promise<boolean>;
const ConfirmCtx = createContext<ConfirmFn>(async () => false);
export const useConfirm = () => useContext(ConfirmCtx);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<{ o: ConfirmOptions; resolve: (v: boolean) => void } | null>(null);
  const confirm = useCallback<ConfirmFn>((o) => new Promise<boolean>((resolve) => setState({ o, resolve })), []);
  const done = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Modal open={!!state} onClose={() => done(false)} title={state?.o.title || ''} width="max-w-md">
        <div className="flex items-start gap-3">
          <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 [&>svg]:w-4.5 [&>svg]:h-4.5 ${state?.o.danger ? 'bg-red-50 text-red-500' : 'bg-amber-50 text-amber-500'}`}>
            <IconWarning />
          </div>
          <div className="text-sm text-zinc-600 leading-relaxed min-w-0 flex-1">{state?.o.message}</div>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <Button onClick={() => done(false)}>{state?.o.cancelText || '取消'}</Button>
          <Button variant={state?.o.danger ? 'danger' : 'primary'} onClick={() => done(true)} autoFocus>
            {state?.o.confirmText || '确定'}
          </Button>
        </div>
      </Modal>
    </ConfirmCtx.Provider>
  );
}

/* ---------------- Hint / Note（页面内小字说明） ---------------- */

/**
 * 行内小字说明：就地解释当前块「是什么 / 为什么」，不打断排版。
 * 用于重要或复杂功能的轻量说明，用户不必离开页面去找答案。
 */
export function Hint({
  children,
  icon = true,
  className = '',
}: {
  children: React.ReactNode;
  icon?: boolean;
  className?: string;
}) {
  return (
    <p className={`flex items-start gap-1.5 text-[11px] leading-relaxed text-zinc-400 ${className}`}>
      {icon && <IconInfo className="mt-0.5 h-3 w-3 shrink-0 text-zinc-300" />}
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/**
 * 提示块：比 Hint 更醒目一级的解释 / 注意事项，放在卡片内或分区顶部。
 * tone：zinc 常规说明 · amber 需要注意 · red 需要警惕
 */
export function Note({
  children,
  tone = 'zinc',
  title,
  className = '',
}: {
  children: React.ReactNode;
  tone?: 'zinc' | 'amber' | 'red';
  title?: React.ReactNode;
  className?: string;
}) {
  const tones = {
    zinc: 'bg-zinc-50 border-zinc-200/70 text-zinc-500',
    amber: 'bg-amber-50/70 border-amber-200/70 text-amber-800',
    red: 'bg-red-50/70 border-red-200/70 text-red-700',
  };
  const iconTones = { zinc: 'text-zinc-400', amber: 'text-amber-500', red: 'text-red-500' };
  return (
    <div className={`flex items-start gap-2 rounded-xl border px-3 py-2.5 text-xs leading-relaxed ${tones[tone]} ${className}`}>
      <IconInfo className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${iconTones[tone]}`} />
      <div className="min-w-0">
        {title && <div className="font-medium">{title}</div>}
        <div className={title ? 'mt-0.5' : ''}>{children}</div>
      </div>
    </div>
  );
}

/**
 * 平台备注文案：把结尾的「参考教程」渲染成外链。
 *
 * 备注是平台侧的纯字符串，要在多处复用（免费模型页 / API Keys / 平台额度），
 * 所以链接地址不放文案里、而是走平台元数据的 `tutorialUrl`；
 * 这里只负责把固定的「参考教程」四个字换成 <a>，避免各页面各写一遍。
 * 没有 tutorialUrl 时按纯文本渲染，行为与之前一致。
 */
export function PlatformNote({
  note,
  tutorialUrl,
  className = '',
}: {
  note: string;
  tutorialUrl?: string | null;
  className?: string;
}) {
  const marker = '参考教程';
  const idx = tutorialUrl ? note.lastIndexOf(marker) : -1;
  if (idx < 0) return <span className={className}>{note}</span>;
  return (
    <span className={className}>
      {note.slice(0, idx)}
      <a
        href={String(tutorialUrl)}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-0.5 underline decoration-dotted underline-offset-2 transition-opacity hover:opacity-75"
        title="打开教程"
      >
        {marker}
        <IconExternalLink className="h-3 w-3 shrink-0" />
      </a>
    </span>
  );
}

/* ---------------- Spinner / EmptyState ---------------- */

export function Spinner({ className = 'w-5 h-5' }: IconProps) {
  return <IconLoader className={`${className} animate-spin text-zinc-400`} />;
}

export function EmptyState({ icon, title, desc, action }: { icon?: React.ReactNode; title: string; desc?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-zinc-300 py-16 px-6 text-center animate-fade-in">
      {icon && (
        <div className="w-14 h-14 rounded-2xl bg-white border border-zinc-200 text-zinc-300 flex items-center justify-center mb-4 shadow-sm [&>svg]:w-6 [&>svg]:h-6">
          {icon}
        </div>
      )}
      <div className="text-zinc-800 font-medium">{title}</div>
      {desc && <div className="text-sm text-zinc-400 mt-1.5 max-w-md leading-relaxed">{desc}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/* ---------------- Toast ---------------- */

type ToastItem = { id: number; type: 'ok' | 'err' | 'info' | 'warn'; text: string };
const ToastCtx = createContext<(type: ToastItem['type'], text: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const push = useCallback((type: ToastItem['type'], text: string) => {
    const id = ++seq.current;
    setItems((arr) => [...arr.slice(-3), { id, type, text }]);
    // 存一份本地存档，设置页可回看（转瞬即逝的提示事后无法核对）
    pushNotification(type, text);
    setTimeout(() => setItems((arr) => arr.filter((t) => t.id !== id)), type === 'err' ? 6000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[60] flex flex-col gap-2 items-center w-full px-4 pointer-events-none">
        {items.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto max-w-2xl flex items-start gap-2.5 rounded-xl px-4 py-2.5 shadow-lg shadow-zinc-900/10 text-sm animate-slide-up ${
              t.type === 'ok' ? 'bg-emerald-600 text-white' : t.type === 'err' ? 'bg-red-600 text-white' : t.type === 'warn' ? 'bg-amber-500 text-white' : 'bg-zinc-800 text-white'
            }`}
          >
            <span className="shrink-0 mt-0.5 [&>svg]:w-4 [&>svg]:h-4">
              {t.type === 'ok' ? <IconCheck /> : t.type === 'err' || t.type === 'warn' ? <IconWarning /> : <IconInfo />}
            </span>
            <span className="leading-relaxed break-words">{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
