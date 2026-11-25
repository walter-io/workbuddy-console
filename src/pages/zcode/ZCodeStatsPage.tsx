import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
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
  IconChart,
  IconCoins,
  IconGaugeSmall,
  IconHash,
  IconRefresh,
  IconZap,
  PageSection,
  ProgressBar,
  Segmented,
  Skeleton,
  StatCard,
  Toolbar,
  useToast,
} from '../../components/ui';
import { get, TIMEOUT } from '../../lib/api';
import { fmtDateTime, fmtNumber, fmtTokens } from '../../lib/format';
import type { ZCodeStatsRange, ZCodeStatsResponse } from '../../lib/zcode';

const RANGE_OPTS: { value: ZCodeStatsRange; label: string }[] = [
  { value: 'today', label: '今天' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
  { value: 'all', label: '全部' },
];

const tooltipStyle = {
  borderRadius: 12,
  border: '1px solid #e4e4e7',
  fontSize: 12,
  boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
} as const;

function StatsSkeleton() {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i} className="px-4 py-3.5">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-6 w-20 mt-2.5" />
          </Card>
        ))}
      </div>
      <Card className="p-4">
        <Skeleton className="h-4 w-40 mb-3" />
        <Skeleton className="h-64 w-full" />
      </Card>
      <Card className="p-4">
        <Skeleton className="h-40 w-full" />
      </Card>
    </div>
  );
}

function statusColor(status: string, error: string | null): string {
  if (error || /error|fail|abort|cancel/i.test(status)) return 'red';
  if (/success|complete|ok|done/i.test(status)) return 'green';
  return 'gray';
}

export default function ZCodeStatsPage() {
  const toast = useToast();
  const [range, setRange] = useState<ZCodeStatsRange>('30d');
  const [model, setModel] = useState('');
  const [data, setData] = useState<ZCodeStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError('');
    const params = new URLSearchParams({ range });
    if (model) params.set('model', model);
    try {
      const res = await get<ZCodeStatsResponse>(`/api/zcode/stats?${params.toString()}`, { timeoutMs: TIMEOUT.stats });
      if (seq === seqRef.current) setData(res);
    } catch (e: any) {
      if (seq === seqRef.current) {
        const message = e?.message || 'ZCode 统计加载失败';
        setError(message);
        toast('err', message);
      }
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [range, model, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const modelOptions = useMemo(() => {
    const names = (data?.models || []).map((m) => m.model);
    return model && !names.includes(model) ? [model, ...names] : names;
  }, [data, model]);

  const chartData = useMemo(
    () =>
      (data?.days || []).map((d) => ({
        date: d.date.slice(5),
        total: d.total,
        requests: d.requests,
      })),
    [data]
  );

  const toolbar = (
    <Toolbar>
      <Segmented<ZCodeStatsRange> value={range} onChange={setRange} options={RANGE_OPTS} />
      <select
        value={model}
        onChange={(e) => setModel(e.target.value)}
        className="h-9 px-2.5 rounded-xl border border-zinc-200 text-sm bg-white outline-none focus:border-indigo-400 max-w-[260px]"
        title="按模型筛选"
      >
        <option value="">全部模型</option>
        {modelOptions.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <div className="ml-auto flex items-center gap-2.5">
        {loading && data && <span className="text-xs text-zinc-400">更新中…</span>}
        <Button variant="subtle" loading={loading} onClick={() => void load()} title="重新读取 ZCode 统计">
          <IconRefresh className="w-4 h-4" />
          刷新
        </Button>
      </div>
    </Toolbar>
  );

  if (!data && loading) {
    return (
      <div className="space-y-5">
        {toolbar}
        <StatsSkeleton />
      </div>
    );
  }

  if (!data) {
    return (
      <EmptyState
        icon={<IconChart />}
        title="统计加载失败"
        desc={error || '无法获取 ZCode 统计数据，请稍后重试。'}
        action={
          <Button variant="primary" loading={loading} onClick={() => void load()}>
            <IconRefresh className="w-4 h-4" />
            刷新
          </Button>
        }
      />
    );
  }

  if (!data.available) {
    return (
      <EmptyState
        icon={<IconChart />}
        title="ZCode 统计不可用"
        desc={data.reason || '未找到 ZCode 数据库'}
        action={
          <Button variant="primary" loading={loading} onClick={() => void load()}>
            <IconRefresh className="w-4 h-4" />
            刷新
          </Button>
        }
      />
    );
  }

  const totals = data.totals;
  const cacheHitRate = totals.input > 0 ? (totals.cacheRead / totals.input) * 100 : 0;

  return (
    <div className="space-y-5">
      {toolbar}

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
        <StatCard label="请求次数" value={fmtNumber(totals.requests)} icon={<IconHash />} tone="sky" />
        <StatCard
          label="总 Token"
          value={fmtTokens(totals.total)}
          accent="text-indigo-600"
          sub="input + output + 缓存写入"
          icon={<IconCoins />}
          tone="indigo"
        />
        <StatCard
          label="输入（含缓存）"
          value={fmtTokens(totals.input)}
          sub={`其中未命中 ${fmtTokens(Math.max(0, totals.input - totals.cacheRead))}`}
          icon={<IconGaugeSmall />}
          tone="zinc"
        />
        <StatCard
          label="输出"
          value={fmtTokens(totals.output)}
          sub={totals.reasoning > 0 ? `思考 ${fmtTokens(totals.reasoning)}` : undefined}
          icon={<IconZap />}
          tone="emerald"
        />
        <StatCard
          label="缓存命中"
          value={fmtTokens(totals.cacheRead)}
          sub={`命中率 ${cacheHitRate.toFixed(1)}%`}
          icon={<IconChart />}
          tone="violet"
        />
      </div>

      <PageSection icon={<IconChart />} title="每日消耗趋势" desc="按日本地 Token 用量，面积 = 总 Token">
        <Card className="p-4">
          <div className="h-72">
            {chartData.length === 0 ? (
              <div className="h-full flex items-center justify-center text-sm text-zinc-400">当前筛选下没有趋势数据</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="zcodeStatsGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#6366f1" stopOpacity={0.28} />
                      <stop offset="100%" stopColor="#6366f1" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f1" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#a1a1aa' }} tickLine={false} axisLine={{ stroke: '#e4e4e7' }} minTickGap={16} />
                  <YAxis tick={{ fontSize: 11, fill: '#a1a1aa' }} tickLine={false} axisLine={false} tickFormatter={(v) => fmtTokens(Number(v))} width={52} />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    formatter={(v: any, _n: any, item: any) => [fmtTokens(Number(v)), `总 Token（${item?.payload?.requests ?? 0} 次请求）`]}
                  />
                  <Area type="monotone" dataKey="total" stroke="#6366f1" strokeWidth={2} fill="url(#zcodeStatsGrad)" isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>
      </PageSection>

      <PageSection icon={<IconZap />} title="模型消耗分布" count={Math.min(20, data.models.length)} desc="按累计 Token 排序">
        <Card className="p-4">
          <div className="space-y-2.5 max-h-96 overflow-y-auto pr-1">
            {data.models.slice(0, 20).map((m) => {
              const share = totals.total > 0 ? (m.total / totals.total) * 100 : 0;
              return (
                <div key={m.model} className="text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-zinc-700 truncate flex-1" title={m.model}>
                      {m.model}
                    </span>
                    <span className="text-zinc-500 font-mono text-xs shrink-0">{fmtTokens(m.total)}</span>
                    <span className="text-zinc-400 text-xs w-12 text-right shrink-0 font-mono">{share.toFixed(1)}%</span>
                  </div>
                  <ProgressBar percent={share} size="sm" className="mt-1" color="bg-indigo-400" />
                  <div className="text-[11px] text-zinc-400 mt-1">
                    {fmtNumber(m.requests)} 次请求 · 入 {fmtTokens(m.input)} / 出 {fmtTokens(m.output)} / 缓存读 {fmtTokens(m.cacheRead)}
                  </div>
                </div>
              );
            })}
            {data.models.length === 0 && <div className="text-sm text-zinc-400 py-6 text-center">当前筛选下没有模型数据</div>}
          </div>
        </Card>
      </PageSection>

      <PageSection icon={<IconHash />} title="最近请求" count={data.recent.length} desc="最近 20 条">
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[1080px]">
              <thead>
                <tr className="text-xs text-zinc-400 text-left border-b border-zinc-100">
                  <th className="py-2.5 px-4 font-medium w-40">时间</th>
                  <th className="py-2.5 font-medium">模型</th>
                  <th className="py-2.5 font-medium w-24">状态</th>
                  <th className="py-2.5 font-medium w-24 text-right">输入</th>
                  <th className="py-2.5 font-medium w-24 text-right">输出</th>
                  <th className="py-2.5 font-medium w-24 text-right">缓存</th>
                  <th className="py-2.5 font-medium w-24 text-right">合计</th>
                  <th className="py-2.5 px-4 font-medium w-64">错误信息</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-50">
                {data.recent.map((r, i) => (
                  <tr key={`${r.at}-${r.model}-${i}`} className="hover:bg-zinc-50/60 transition-colors">
                    <td className="py-2.5 px-4 text-zinc-500 text-xs whitespace-nowrap">{fmtDateTime(r.at)}</td>
                    <td className="py-2.5 max-w-[240px]">
                      <span className="block truncate font-mono text-xs text-zinc-600" title={r.model}>
                        {r.model || '—'}
                      </span>
                    </td>
                    <td className="py-2.5">
                      <Badge color={statusColor(r.status, r.error)}>{r.status || '未知'}</Badge>
                    </td>
                    <td className="py-2.5 text-right font-mono text-xs text-zinc-500 tabular-nums">{fmtTokens(r.input)}</td>
                    <td className="py-2.5 text-right font-mono text-xs text-zinc-500 tabular-nums">{fmtTokens(r.output)}</td>
                    <td className="py-2.5 text-right font-mono text-xs text-zinc-500 tabular-nums">{fmtTokens(r.cacheRead)}</td>
                    <td className="py-2.5 text-right font-mono text-xs text-zinc-700 tabular-nums">{fmtTokens(r.total)}</td>
                    <td className="py-2.5 px-4 max-w-[256px]">
                      <span className={`block truncate text-xs ${r.error ? 'text-red-500' : 'text-zinc-300'}`} title={r.error || ''}>
                        {r.error || '—'}
                      </span>
                    </td>
                  </tr>
                ))}
                {data.recent.length === 0 && (
                  <tr>
                    <td colSpan={8} className="py-8 text-center text-sm text-zinc-400">
                      当前筛选下没有请求记录
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </PageSection>

      <div className="text-xs text-zinc-400 leading-relaxed">
        数据来源：本机 ZCode 本地数据库
        {data.dbFile && (
          <>
            （<span className="font-mono break-all">{data.dbFile}</span>）
          </>
        )}
        ，不联网、不上报。
      </div>
    </div>
  );
}
