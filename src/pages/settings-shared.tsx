import { Badge } from '../components/ui';

/**
 * 设置类页面共用的展示小组件。
 * 「设置」与「WorkBuddy 设置」拆成两页后，两边都要用同一套行布局与状态标记，
 * 放在这里避免互相引用页面文件。
 */

/** 设置行：左标签 + 说明，右操作；与参考项目一致的信息层级 */
export function Row({
  label,
  desc,
  children,
  className = '',
}: {
  label: React.ReactNode;
  desc?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 ${className}`}>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-zinc-700">{label}</div>
        {desc && <div className="mt-0.5 text-xs text-zinc-400 leading-relaxed">{desc}</div>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export function MarkerBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <Badge color={ok ? 'green' : 'gray'}>
      {ok ? '✓' : '—'} {label}
    </Badge>
  );
}
