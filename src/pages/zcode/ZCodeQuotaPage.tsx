import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  IconCalendar,
  IconChart,
  IconClock,
  IconCoins,
  IconLayers,
  IconRefresh,
  IconTrendUp,
  IconWallet,
  IconWarning,
  PageSection,
  ProgressBar,
  Skeleton,
  StatCard,
  Toolbar,
  useToast,
} from '../../components/ui';
import { fmtDate, fmtNumber, fmtTokens } from '../../lib/format';
import { zcodeApi } from '../../lib/zcode';
import type { ZCodeBalanceResponse, ZCodeStatsResponse, ZCodeTimestamp } from '../../lib/zcode';

const tooltipStyle = {
  borderRadius: 12,
  border: '1px solid #e4e4e7',
  fontSize: 12,
  boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
} as const;

function toMs(value: ZCodeTimestamp): number | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && /^\d+(\.\d+)?$/.test(value.trim())) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function fmtClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function planStatusColor(status: string): string {
  if (/active|valid|normal|生效|有效/i.test(status)) return 'green';
  if (/expire|invalid|cancel|失效|过期/i.test(status)) return 'red';
  return 'gray';
}

function QuotaSkeleton() {
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
      <Skeleton className="h-32" />
      <Skeleton className="h-56" />
    </div>
  );
}

export default function ZCodeQuotaPage() {
  const toast = useToast();
  const [data, setData] = useState<ZCodeBalanceResponse | null>(null);
  const [stats, setStats] = useState<ZCodeStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [requestError, setRequestError] = useState('');

  const loadBalance = useCallback(
    async (refresh = false) => {
      if (refresh) setRefreshing(true);
      else setLoading(true);
      try {
        const res = await zcodeApi.balance(refresh);
        setData(res);
        setRequestError('');
        if (refresh) {
          if (res.ok) toast('ok', '额度已刷新');
          else toast('err', res.error);
        }
      } catch (e: any) {
        const message = e?.message || '读取 ZCode 额度失败';
        setRequestError(message);
        if (refresh) toast('err', message);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [toast]
  );

  useEffect(() => {
    void loadBalance();
  }, [loadBalance]);

  useEffect(() => {
    let active = true;
    zcodeApi
      .stats('30d')
      .then((res) => {
        if (active) setStats(res);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const entry = data ? (data.ok ? data : data.cached) : null;
  const plans = entry?.plans || [];
  const balances = entry?.balances || [];
  const remaining = balances.reduce((sum, b) => sum + (b.remaining || 0), 0);
  const total = balances.reduce((sum, b) => sum + (b.total || 0), 0);
  const used = balances.reduce((sum, b) => sum + (b.used || 0), 0);
  const usedPercent = total > 0 ? (used / total) * 100 : 0;
  const earliestExpiry = balances.reduce<number | null>((earliest, b) => {
    const ms = toMs(b.expiresAt);
    return ms != null && (earliest == null || ms < earliest) ? ms : earliest;
  }, null);
  const expiryDays = earliestExpiry == null ? null : Math.max(0, Math.ceil((earliestExpiry - Date.now()) / 86_400_000));

  const dailyChart = useMemo(
    () =>
      (stats?.days || []).map((d) => ({
        date: d.date.slice(5),
        total: d.total,
        requests: d.requests,
      })),
    [stats]
  );

  const warning = data && !data.ok ? data.error : requestError;

  return (
    <div className="space-y-5">
      {warning && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs leading-relaxed text-amber-800">
          <IconWarning className="w-4 h-4 text-amber-500 shrink-0 mt-px" />
          <span>{warning}</span>
        </div>
      )}

      <Toolbar>
        <div className="text-xs text-zinc-400 inline-flex items-center gap-1.5">
          <IconClock className="w-3.5 h-3.5" />
          {data && !data.ok && entry ? `上次读取于 ${fmtClock(entry.at)}` : 'ZCode 官方免费套餐'}
        </div>
        <div className="ml-auto">
          <Button size="sm" loading={loading || refreshing} onClick={() => void loadBalance(true)}>
            <IconRefresh className="w-3.5 h-3.5" />
            刷新额度
          </Button>
        </div>
      </Toolbar>

      {loading && !entry ? (
        <QuotaSkeleton />
      ) : !entry ? (
        <EmptyState
          icon={<IconWallet />}
          title="还没读到额度"
          desc="确认 ZCode 客户端已登录后点刷新"
          action={
            <Button variant="primary" loading={refreshing} onClick={() => void loadBalance(true)}>
              <IconRefresh className="w-4 h-4" />
              刷新额度
            </Button>
          }
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="剩余额度" value={fmtNumber(remaining)} accent="text-indigo-600" icon={<IconCoins />} tone="indigo" />
            <StatCard label="总额度" value={fmtNumber(total)} sub={`${balances.length} 个额度桶`} icon={<IconWallet />} tone="violet" />
            <StatCard label="已用" value={fmtNumber(used)} sub={`占总额度 ${usedPercent.toFixed(1)}%`} icon={<IconTrendUp />} tone="emerald" />
            <StatCard
              label="最早到期"
              value={earliestExpiry == null ? '—' : fmtDate(earliestExpiry)}
              sub={earliestExpiry == null ? '暂无到期时间' : earliestExpiry < Date.now() ? '已过期' : `${expiryDays} 天后`}
              icon={<IconCalendar />}
              tone="amber"
            />
          </div>

          <PageSection icon={<IconLayers />} title="当前套餐" count={plans.length}>
            <Card className="divide-y divide-zinc-50">
              {plans.map((plan) => (
                <div key={plan.userPlanId || plan.planId} className="flex flex-wrap items-center gap-3 px-4 py-3.5">
                  <span className="text-sm font-medium text-zinc-800 min-w-0 flex-1 truncate" title={plan.name}>
                    {plan.name}
                  </span>
                  <Badge color={planStatusColor(plan.status)} dot>
                    {plan.status || '未知'}
                  </Badge>
                  <span className="text-xs text-zinc-400 font-mono whitespace-nowrap">
                    {fmtDate(toMs(plan.startsAt))} ~ {fmtDate(toMs(plan.endsAt))}
                  </span>
                </div>
              ))}
              {plans.length === 0 && <div className="px-4 py-8 text-center text-sm text-zinc-400">暂无套餐信息</div>}
            </Card>
          </PageSection>

          <PageSection icon={<IconWallet />} title="额度桶明细" count={balances.length} desc="剩余、已用与可用额度">
            <Card>
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[820px]">
                  <thead>
                    <tr className="text-xs text-zinc-400 text-left border-b border-zinc-100">
                      <th className="py-2.5 px-4 font-medium">额度桶</th>
                      <th className="py-2.5 font-medium w-48 text-right">剩余 / 总额</th>
                      <th className="py-2.5 font-medium w-56">已用</th>
                      <th className="py-2.5 font-medium w-32 text-right">可用</th>
                      <th className="py-2.5 px-4 font-medium w-36 text-right">到期时间</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-50">
                    {balances.map((b) => {
                      const percent = b.total > 0 ? (b.used / b.total) * 100 : 0;
                      return (
                        <tr key={b.bucketId} className="hover:bg-zinc-50/60 transition-colors">
                          <td className="py-3 px-4 text-zinc-700 max-w-[240px]">
                            <span className="block truncate" title={b.name}>
                              {b.name}
                            </span>
                          </td>
                          <td className="py-3 text-right font-mono text-xs whitespace-nowrap">
                            <span className="text-indigo-600 font-medium">{fmtNumber(b.remaining)}</span>
                            <span className="text-zinc-400"> / {fmtNumber(b.total)}</span>
                          </td>
                          <td className="py-3 pr-4">
                            <ProgressBar percent={percent} size="sm" color={percent > 85 ? 'bg-red-500' : percent > 60 ? 'bg-amber-500' : 'bg-indigo-500'} />
                            <div className="mt-1 text-[11px] text-zinc-400 font-mono">
                              {fmtNumber(b.used)}（{percent.toFixed(1)}%）
                            </div>
                          </td>
                          <td className="py-3 text-right font-mono text-xs text-zinc-600">{fmtNumber(b.available)}</td>
                          <td className="py-3 px-4 text-right text-xs text-zinc-500 whitespace-nowrap">{fmtDate(toMs(b.expiresAt))}</td>
                        </tr>
                      );
                    })}
                    {balances.length === 0 && (
                      <tr>
                        <td colSpan={5} className="py-8 text-center text-sm text-zinc-400">
                          暂无额度桶信息
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Card>
          </PageSection>

          <PageSection icon={<IconChart />} title="近 30 天消耗" desc="本机 ZCode 数据库每日总 Token">
            <Card className="p-4">
              <div className="h-56">
                {dailyChart.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-sm text-zinc-400">
                    {stats ? '近 30 天没有消耗记录' : '正在读取消耗趋势…'}
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={dailyChart} margin={{ top: 5, right: 8, left: -18, bottom: 0 }}>
                      <defs>
                        <linearGradient id="zcodeQuotaGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#6366f1" stopOpacity={0.28} />
                          <stop offset="100%" stopColor="#6366f1" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#a1a1aa' }} tickLine={false} axisLine={false} minTickGap={16} />
                      <YAxis tick={{ fontSize: 11, fill: '#a1a1aa' }} tickLine={false} axisLine={false} tickFormatter={(v) => fmtTokens(Number(v))} width={52} />
                      <Tooltip
                        contentStyle={tooltipStyle}
                        formatter={(v: any, _n: any, item: any) => [fmtTokens(Number(v)), `消耗（${item?.payload?.requests ?? 0} 次请求）`]}
                      />
                      <Area type="monotone" dataKey="total" stroke="#6366f1" strokeWidth={2} fill="url(#zcodeQuotaGrad)" isAnimationActive={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </div>
            </Card>
          </PageSection>
        </>
      )}

      <div className="text-xs text-zinc-400">额度来自 ZCode 官方免费套餐接口，只显示数字，不显示任何凭据。</div>
    </div>
  );
}
