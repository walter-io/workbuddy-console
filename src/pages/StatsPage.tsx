import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
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
  IconBox,
  IconCalendar,
  IconChart,
  IconCoins,
  IconDownload,
  IconGaugeSmall,
  IconHash,
  IconRefresh,
  IconSearch,
  IconX,
  IconZap,
  PageSection,
  Segmented,
  Skeleton,
  Spinner,
  StatCard,
  Toolbar,
  useToast,
} from '../components/ui';
import { get, TIMEOUT } from '../lib/api';
import type { StatsResponse } from '../lib/types';
import { fmtDate, fmtDateTime, fmtNumber, fmtRelative, fmtTokens } from '../lib/format';

const RANGE_OPTS = [
  { value: 'today', label: '今天' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
  { value: 'all', label: '全部' },
] as const;

type Range = (typeof RANGE_OPTS)[number]['value'];

const PALETTE = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16'];

function isFreeName(m: string) {
  return m.endsWith(':free') || /(^|\/)free$/i.test(m);
}

/** 首次加载骨架屏：页面立即渲染，数据到了再填充 */
function StatsSkeleton({ elapsed }: { elapsed: number }) {
  return (
    <div className="space-y-4">
      <div className="text-xs text-zinc-400 text-center">
        正在解析本机 {elapsed > 0 ? `${elapsed} 秒` : ''}…
        <span className="text-zinc-300"> 首次扫描需遍历全部会话日志（约 1 分钟），之后会走缓存秒开。</span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i} className="px-4 py-3.5">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-6 w-20 mt-2.5" />
          </Card>
        ))}
      </div>
      <Card className="p-4">
        <Skeleton className="h-4 w-72 mb-3" />
        <Skeleton className="h-72 w-full" />
      </Card>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card className="p-4">
          <Skeleton className="h-4 w-24 mb-3" />
          <Skeleton className="h-80 w-full" />
        </Card>
        <Card className="p-4">
          <Skeleton className="h-4 w-24 mb-3" />
          <Skeleton className="h-80 w-full" />
        </Card>
      </div>
      <Card className="p-4">
        <Skeleton className="h-4 w-56 mb-3" />
        <Skeleton className="h-40 w-full" />
      </Card>
    </div>
  );
}

/** 活跃时段热力图：列宽固定 16px + 间距 4px，刻度与列严格对齐 */
const CELL = 'w-4 h-4 rounded-[5px] shrink-0';

function HoursHeatmap({ hours }: { hours: Record<string, number> }) {
  const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const max = Math.max(1, ...Object.values(hours));
  return (
    <div>
      <div className="overflow-x-auto pb-1">
        <div className="inline-block">
          {/* 小时刻度：每 6 小时一个标签，与下方列一一对应 */}
          <div className="flex items-center gap-1 mb-1">
            <span className="w-8 shrink-0" />
            {Array.from({ length: 24 }, (_, h) => (
              <span key={h} className="w-4 shrink-0 text-[10px] text-zinc-400 text-center font-mono">
                {h % 6 === 0 ? h : ''}
              </span>
            ))}
          </div>
          {weekdays.map((wd) => (
            <div key={wd} className="flex items-center gap-1 mb-1">
              <span className="w-8 text-[10px] text-zinc-400 shrink-0">{wd}</span>
              {Array.from({ length: 24 }, (_, h) => {
                const v = hours[`${wd}-${h}`] || 0;
                const intensity = v / max;
                return (
                  <div
                    key={h}
                    title={`${wd} ${String(h).padStart(2, '0')}:00 — ${v} 次请求`}
                    className={CELL}
                    style={{ background: v > 0 ? `rgba(99, 102, 241, ${0.15 + intensity * 0.85})` : '#f4f4f5' }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 text-[10px] text-zinc-400">
        <span>少</span>
        {[0.15, 0.35, 0.55, 0.75, 1].map((a) => (
          <span key={a} className="w-3.5 h-3.5 rounded-[5px]" style={{ background: `rgba(99, 102, 241, ${a})` }} />
        ))}
        <span>多</span>
        <span className="ml-2">单格最深 {max} 次请求</span>
      </div>
    </div>
  );
}

export default function StatsPage() {
  const toast = useToast();
  const [range, setRange] = useState<Range>('30d');
  const [model, setModel] = useState('');
  const [data, setData] = useState<StatsResponse | null>(null);
  const [initialLoading, setInitialLoading] = useState(true); // 首次加载：骨架屏
  const [updating, setUpdating] = useState(false); // 后台/手动更新中（不挡界面）
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [elapsed, setElapsed] = useState(0); // 首次扫描耗时：让 1 分钟的冷扫描不像"卡死"
  /** 档位：国内版/国际版的数据根不同，分开看才不会把两个档位的用量混在一起 */
  const [variant, setVariant] = useState<'all' | 'cn' | 'ai'>('all');
  const seqRef = useRef(0); // 防乱序：只采纳最后一次请求的结果

  /* ---------------- 会话排行：Top 20 / 全部明细 ---------------- */
  const [sessionTab, setSessionTab] = useState<'top' | 'all'>('top');
  const [sessionPage, setSessionPage] = useState(1);
  const [sessionPageSize, setSessionPageSize] = useState(20);
  const [sessionSearch, setSessionSearch] = useState('');

  /**
   * 全部明细：按会话名/项目/模型过滤。
   *
   * 「全部明细」页签按**最近活跃倒序**（最新的排最前）；「排行 Top 20」保持服务端的
   * Token 降序（它是个"Token 用在哪儿"的排行，按时间排会失去意义）。
   * 排序前先复制数组，避免改动 data.sessions 的原始顺序（CSV 导出按原顺序输出）。
   */
  const filteredSessions = useMemo(() => {
    const list = data?.sessions || [];
    const kw = sessionSearch.trim().toLowerCase();
    const matched = kw
      ? list.filter((s) => {
          if (s.title.toLowerCase().includes(kw)) return true;
          if (s.sessionId.toLowerCase().includes(kw)) return true;
          if (s.project.toLowerCase().includes(kw)) return true;
          return s.topModels.some((tm) => tm.model.toLowerCase().includes(kw));
        })
      : list;
    if (sessionTab !== 'all') return matched;
    return [...matched].sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
  }, [data, sessionSearch, sessionTab]);

  const sessionPageCount = Math.max(1, Math.ceil(filteredSessions.length / sessionPageSize));
  const safeSessionPage = Math.min(sessionPage, sessionPageCount);
  const sessionPageItems = useMemo(
    () => filteredSessions.slice((safeSessionPage - 1) * sessionPageSize, safeSessionPage * sessionPageSize),
    [filteredSessions, safeSessionPage, sessionPageSize]
  );

  useEffect(() => {
    if (!initialLoading) {
      setElapsed(0);
      return;
    }
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [initialLoading]);

  /**
   * initial = 首次进入（骨架屏）；silent = 筛选变化/定时刷新（旧数据保持可见）；
   * manual = 手动刷新（force=1 强制重扫，失败弹提示）
   */
  const load = useCallback(
    async (mode: 'initial' | 'silent' | 'manual' = 'silent') => {
      const seq = ++seqRef.current;
      if (mode === 'initial') setInitialLoading(true);
      else setUpdating(true);
      try {
        const params = new URLSearchParams({ range, variant });
        if (model) params.set('model', model);
        if (mode === 'manual') params.set('force', '1');
        const res = await get<StatsResponse>(`/api/stats?${params}`, { timeoutMs: TIMEOUT.stats });
        if (seq === seqRef.current) setData(res);
      } catch (e: any) {
        if (mode === 'manual') toast('err', e?.message || '统计加载失败');
        // 静默刷新失败保留旧数据，等下个周期再试
      } finally {
        if (seq === seqRef.current) {
          setInitialLoading(false);
          setUpdating(false);
        }
      }
    },
    [range, model, variant, toast]
  );

  useEffect(() => {
    load('initial');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 筛选变化：静默刷新，不清空当前数据
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    load('silent');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, model, variant]);

  // 定时刷新：每 60 秒静默更新当前筛选下的统计。
  // 串行自重排 + 页面不可见暂停：stats 冷扫描可能超过 60s 间隔，setInterval 会叠加
  // 并发请求（seqRef 只防乱序不防堆叠）
  useEffect(() => {
    if (!autoRefresh) return;
    let stopped = false;
    let timer: number | undefined;
    const tick = () => {
      if (document.hidden) {
        timer = window.setTimeout(tick, 60_000);
        return;
      }
      void load('silent').finally(() => {
        if (!stopped) timer = window.setTimeout(tick, 60_000);
      });
    };
    timer = window.setTimeout(tick, 60_000);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [autoRefresh, load]);

  const topModelsForChart = useMemo(() => (data?.models || []).slice(0, 8).map((m) => m.name), [data]);

  const chartData = useMemo(() => {
    if (!data) return [];
    return data.daily.map((d) => {
      const row: Record<string, string | number> = { date: d.date.slice(5), requests: d.requests };
      let other = 0;
      for (const [m, tokens] of Object.entries(d.byModel)) {
        if (topModelsForChart.includes(m)) row[m] = tokens;
        else other += tokens;
      }
      if (other > 0) row['其他'] = other;
      return row;
    });
  }, [data, topModelsForChart]);

  /** 导出当前筛选下的统计结果为 CSV（含 BOM，Excel 直接打开不乱码） */
  const exportCsv = useCallback(() => {
    if (!data) return;
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines: string[] = [];
    const row = (arr: unknown[]) => lines.push(arr.map(esc).join(','));
    const rangeLabel = RANGE_OPTS.find((r) => r.value === range)?.label || range;
    const modelLabel = model || '全部模型';

    row(['workbuddy控制台 Token 用量统计']);
    row(['生成时间', new Date(data.generatedAt).toLocaleString('zh-CN')]);
    row(['统计区间', rangeLabel]);
    row(['模型筛选', modelLabel]);
    row(['扫描会话文件数', data.filesScanned]);
    if (data.coverageStartAt) row(['数据覆盖起始', fmtDate(data.coverageStartAt)]);
    row([]);
    row(['一、总览']);
    row(['指标', '数值']);
    row(['请求次数', data.summary.requests]);
    row(['总 Token', data.summary.total]);
    row(['输入 Token', data.summary.input]);
    row(['输出 Token', data.summary.output]);
    row(['缓存读取', data.summary.cacheRead]);
    row(['缓存写入', data.summary.cacheWrite]);
    row([]);
    row(['二、模型排行']);
    row(['模型', '请求次数', '输入', '输出', '缓存读取', '缓存写入', '总 Token']);
    for (const m of data.models) row([m.name, m.requests, m.input, m.output, m.cacheRead, m.cacheWrite, m.total]);
    row([]);
    row(['三、每日趋势']);
    row(['日期', '请求次数', '总 Token']);
    for (const d of data.daily) row([d.date, d.requests, d.total]);
    row([]);
    row(['四、项目排行']);
    row(['项目', '请求次数', '总 Token']);
    for (const p of data.projects) row([p.name, p.requests, p.total]);
    row([]);
    row(['五、会话排行']);
    row(['会话', '项目', '请求次数', '总 Token', '最近活跃']);
    for (const s of data.sessions) row([s.title || s.sessionId, s.project, s.requests, s.total, s.lastActive ? fmtDateTime(s.lastActive) : '']);

    const csv = '\uFEFF' + lines.join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `workbuddy-统计-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast('ok', '已导出 CSV 到下载目录');
  }, [data, range, model, toast]);

  if (!initialLoading && !data) {
    return (
      <EmptyState
        icon={<IconChart />}
        title="统计加载失败"
        desc="无法获取统计数据，请确认本地服务正在运行后重试。"
        action={
          <Button variant="primary" onClick={() => load('manual')}>
            重试
          </Button>
        }
      />
    );
  }

  if (data && data.filesScanned === 0) {
    const scanned = (data.dirs && data.dirs.length ? data.dirs.map((d) => d.dir) : [data.dir]).join('、');
    return (
      <EmptyState
        icon={<IconChart />}
        title={variant === 'ai' ? '国际版没有会话数据' : '未找到 WorkBuddy 会话数据'}
        desc={`已尝试扫描 ${scanned || '~/.workbuddy'}/projects 下的会话日志。${
          variant === 'all' ? '如果 WorkBuddy 安装在其他位置，请到「设置」修改数据目录。' : '可切到「全部档位」查看其它档位，或到「设置」确认该档位的数据目录。'
        }`}
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button variant="primary" onClick={() => (location.hash = 'settings')}>
              前往设置
            </Button>
            {variant !== 'all' && (
              <Button variant="subtle" onClick={() => setVariant('all')}>
                查看全部档位
              </Button>
            )}
          </div>
        }
      />
    );
  }

  return (
    <div className="space-y-5">
      {/* 控制条（首次加载时也渲染，页面立刻可用） */}
      <Toolbar>
        <Segmented<Range> value={range} onChange={setRange} options={[...RANGE_OPTS]} />
        <Segmented<'all' | 'cn' | 'ai'>
          value={variant}
          onChange={setVariant}
          options={[
            { value: 'all', label: '全部档位' },
            { value: 'cn', label: '国内版' },
            { value: 'ai', label: '国际版' },
          ]}
        />
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="h-9 px-2.5 rounded-xl border border-zinc-200 text-sm bg-white outline-none focus:border-indigo-400 max-w-[260px]"
        >
          <option value="">全部模型</option>
          {(data?.models || []).slice(0, 50).map((m) => (
            <option key={m.name} value={m.name}>
              {m.name}
            </option>
          ))}
        </select>
        <div className="ml-auto flex flex-wrap items-center gap-2.5">
          {initialLoading ? (
            <span className="text-xs text-zinc-400 flex items-center gap-1.5">
              <Spinner className="w-3.5 h-3.5" />
              正在扫描会话日志…{elapsed > 0 && <span className="font-mono">{elapsed}s</span>}
              {elapsed >= 10 && <span className="text-zinc-300">首次扫描较慢，请稍候</span>}
            </span>
          ) : (
            data && (
              <span className="text-xs text-zinc-400">
                扫描 {data.filesScanned} 个会话文件{data.parseErrors > 0 ? ` · ${data.parseErrors} 个解析失败` : ''}
                {data.coverageStartAt ? ` · 覆盖 ${fmtDate(data.coverageStartAt)} 起` : ''}
                {data.dirs && data.dirs.length > 1 ? ` · ${data.dirs.length} 个档位数据根` : ''}
                {updating && <span className="text-indigo-400"> · 更新中…</span>}
              </span>
            )
          )}
          <label className="flex items-center gap-1.5 text-xs text-zinc-500 cursor-pointer select-none">
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} className="accent-indigo-600 rounded" />
            每 60 秒自动刷新
          </label>
          <Button variant="subtle" onClick={exportCsv} disabled={!data} title="导出当前筛选下的统计数据为 CSV">
            <IconDownload className="w-4 h-4" />
            导出 CSV
          </Button>
          <Button variant="subtle" loading={updating} onClick={() => load('manual')} title="强制重新扫描会话日志">
            <IconRefresh className="w-4 h-4" />
            刷新
          </Button>
        </div>
      </Toolbar>

      {!data ? (
        <StatsSkeleton elapsed={elapsed} />
      ) : (
        <>
          {/* 总览卡 */}
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            <StatCard label="请求次数" value={fmtNumber(data.summary.requests)} icon={<IconHash />} tone="sky" />
            <StatCard
              label="总 Token"
              value={fmtTokens(data.summary.total)}
              accent="text-indigo-600"
              sub="input + output + 缓存写入"
              icon={<IconCoins />}
              tone="indigo"
            />
            <StatCard
              label="输入"
              value={fmtTokens(data.summary.input)}
              sub={`其中未命中 ${fmtTokens(data.summary.uncachedInput)}`}
              icon={<IconGaugeSmall />}
              tone="zinc"
            />
            <StatCard label="输出" value={fmtTokens(data.summary.output)} icon={<IconZap />} tone="emerald" />
            <StatCard
              label="缓存读取"
              value={fmtTokens(data.summary.cacheRead)}
              sub={data.summary.cacheHitRate != null ? `命中率 ${(data.summary.cacheHitRate * 100).toFixed(1)}%` : undefined}
              icon={<IconChart />}
              tone="violet"
            />
            <StatCard
              label="缓存写入"
              value={fmtTokens(data.summary.cacheWrite)}
              sub={data.summary.thinking > 0 ? `思考 ${fmtTokens(data.summary.thinking)}` : undefined}
              icon={<IconCalendar />}
              tone="amber"
            />
          </div>

          {/* 档位归类：全部视图下给出两个档位各自的数据根与口径 */}
          {variant === 'all' && (data.variants?.length ?? 0) > 0 && (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-zinc-200/80 bg-white px-4 py-3 text-xs">
              <span className="text-zinc-400">按档位归类：</span>
              {(data.variants || []).map((v) => (
                <span key={v.variant} className="inline-flex flex-wrap items-center gap-2" title={v.dir}>
                  <Badge color={v.variant === 'ai' ? 'violet' : 'blue'}>{v.label}</Badge>
                  <span className="text-zinc-600 tabular-nums">
                    {fmtNumber(v.requests)} 次 · {fmtTokens(v.total)}
                  </span>
                  <span className="font-mono text-[11px] text-zinc-400 truncate max-w-[280px]">{v.dir}</span>
                  {v.filesScanned === 0 && <span className="text-zinc-400">（该档位暂无会话数据）</span>}
                </span>
              ))}
            </div>
          )}

          {/* 每日趋势 */}
          <PageSection icon={<IconChart />} title="每日 Token 趋势" desc="堆叠柱 = 各模型 Token 构成，灰线 = 请求次数（右轴）">
            <Card className="p-4">
              <div className="h-72">
                {chartData.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-sm text-zinc-400">当前筛选下没有趋势数据</div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={chartData} margin={{ top: 5, right: 10, bottom: 0, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f1" vertical={false} />
                      <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#a1a1aa' }} tickLine={false} axisLine={{ stroke: '#e4e4e7' }} />
                      <YAxis yAxisId="t" tick={{ fontSize: 11, fill: '#a1a1aa' }} tickLine={false} axisLine={false} tickFormatter={(v) => fmtTokens(v)} width={52} />
                      <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 11, fill: '#a1a1aa' }} tickLine={false} axisLine={false} width={36} />
                      <Tooltip
                        formatter={(value: any, name: any) => [name === 'requests' ? `${value} 次` : fmtTokens(Number(value)), name]}
                        labelStyle={{ color: '#52525b' }}
                        contentStyle={{ borderRadius: 12, borderColor: '#e4e4e7', fontSize: 12 }}
                      />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      {topModelsForChart.map((m, i) => (
                        <Bar key={m} yAxisId="t" dataKey={m} stackId="tokens" fill={PALETTE[i % PALETTE.length]} maxBarSize={26} name={m} radius={i === 0 ? [3, 3, 0, 0] : undefined} />
                      ))}
                      <Bar yAxisId="t" dataKey="其他" stackId="tokens" fill="#d4d4d8" maxBarSize={26} name="其他" />
                      <Line yAxisId="r" type="monotone" dataKey="requests" stroke="#52525b" strokeWidth={1.5} dot={false} name="requests" />
                    </ComposedChart>
                  </ResponsiveContainer>
                )}
              </div>
            </Card>
          </PageSection>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            {/* 模型排行 */}
            <PageSection icon={<IconZap />} title="模型排行" count={Math.min(20, (data.models || []).length)} desc="Top 20">
              <Card className="p-4">
                <div className="space-y-2.5 max-h-96 overflow-y-auto pr-1">
                  {(data.models || []).slice(0, 20).map((m) => {
                    const share = data.summary.total > 0 ? (m.total / data.summary.total) * 100 : 0;
                    return (
                      <div key={m.name} className="text-sm">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs text-zinc-700 truncate flex-1" title={m.name}>
                            {m.name}
                          </span>
                          {isFreeName(m.name) && <Badge color="green">free</Badge>}
                          {m.cacheHitRate != null && m.cacheHitRate > 0 && (
                            <span
                              className="text-[10px] font-mono text-zinc-400 shrink-0"
                              title="缓存命中率 = 缓存读取 / 输入总量"
                            >
                              ⚡{(m.cacheHitRate * 100).toFixed(0)}%
                            </span>
                          )}
                          <span className="text-zinc-500 font-mono text-xs shrink-0">{fmtTokens(m.total)}</span>
                          <span className="text-zinc-400 text-xs w-12 text-right shrink-0 font-mono">{share.toFixed(1)}%</span>
                        </div>
                        <div className="h-1.5 bg-zinc-100 rounded-full mt-1 overflow-hidden">
                          <div className="h-full bg-indigo-400/70 rounded-full transition-all duration-500" style={{ width: `${share}%` }} />
                        </div>
                        <div className="text-[11px] text-zinc-400 mt-0.5">
                          {fmtNumber(m.requests)} 次请求 · 入 {fmtTokens(m.input)} / 出 {fmtTokens(m.output)} / 缓存读 {fmtTokens(m.cacheRead)}
                        </div>
                      </div>
                    );
                  })}
                  {(data.models || []).length === 0 && <div className="text-sm text-zinc-400 py-6 text-center">当前筛选下没有数据</div>}
                </div>
              </Card>
            </PageSection>

            <div className="space-y-5">
              {/* 项目排行 */}
              <PageSection icon={<IconBox />} title="项目排行" count={Math.min(10, (data.projects || []).length)} desc="Top 10">
                <Card className="p-4">
                  <table className="w-full text-sm">
                    <tbody className="divide-y divide-zinc-50">
                      {(data.projects || []).slice(0, 10).map((p) => (
                        <tr key={p.name} className="hover:bg-zinc-50/60 transition-colors">
                          <td className="py-1.5 text-zinc-700 truncate max-w-[220px]" title={p.name}>
                            {p.name}
                          </td>
                          <td className="py-1.5 text-right text-zinc-500 text-xs whitespace-nowrap font-mono">{fmtNumber(p.requests)} 次</td>
                          <td className="py-1.5 text-right font-mono text-xs text-zinc-600 w-20">{fmtTokens(p.total)}</td>
                        </tr>
                      ))}
                      {(data.projects || []).length === 0 && (
                        <tr>
                          <td colSpan={3} className="py-6 text-center text-sm text-zinc-400">
                            当前筛选下没有项目数据
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </Card>
              </PageSection>

              {/* 活跃时段 */}
              <PageSection icon={<IconCalendar />} title="活跃时段热力图" desc="请求次数">
                <Card className="p-4">
                  <HoursHeatmap hours={data.hours || {}} />
                </Card>
              </PageSection>
            </div>
          </div>

          {/* 会话排行 */}
          <PageSection
            icon={<IconHash />}
            title="会话排行"
            count={sessionTab === 'top' ? Math.min(20, (data.sessions || []).length) : filteredSessions.length}
            desc={sessionTab === 'top' ? 'Token 用在哪些会话' : '全部会话明细（按最近活跃倒序）'}
            actions={
              <Segmented<'top' | 'all'>
                value={sessionTab}
                onChange={(v) => {
                  setSessionTab(v);
                  setSessionPage(1);
                }}
                options={[
                  { value: 'top', label: '排行 Top 20' },
                  { value: 'all', label: '全部明细' },
                ]}
              />
            }
          >
            {sessionTab === 'top' ? (
              <Card className="p-4">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm min-w-[720px]">
                    <thead>
                      <tr className="text-xs text-zinc-400 text-left border-b border-zinc-100">
                        <th className="py-2 font-medium">会话</th>
                        <th className="py-2 font-medium w-32">项目</th>
                        <th className="py-2 font-medium w-56">主要模型</th>
                        <th className="py-2 font-medium w-16 text-right">请求</th>
                        <th className="py-2 font-medium w-24 text-right">Token</th>
                        <th className="py-2 font-medium w-28 text-right">最近活跃</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-50">
                      {(data.sessions || []).slice(0, 20).map((sess) => (
                        <tr key={`${sess.variant || ''}-${sess.sessionId}`} className="hover:bg-zinc-50/60 transition-colors">
                          <td className="py-2 max-w-[280px]">
                            <div className="truncate text-zinc-700" title={sess.title || sess.sessionId}>
                              {sess.title || <span className="font-mono text-xs">{sess.sessionId.slice(0, 18)}…</span>}
                            </div>
                          </td>
                          <td className="py-2 text-zinc-500 text-xs truncate max-w-32" title={sess.project}>
                            {sess.project}
                          </td>
                          <td className="py-2 text-xs">
                            {sess.topModels.slice(0, 2).map((tm, i) => (
                              <span key={tm.model} className="mr-2 inline-flex items-center gap-1">
                                <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: PALETTE[i % PALETTE.length] }} />
                                <span className="font-mono text-zinc-500">{tm.model.length > 28 ? tm.model.slice(0, 28) + '…' : tm.model}</span>
                              </span>
                            ))}
                          </td>
                          <td className="py-2 text-right text-zinc-500 text-xs font-mono">{fmtNumber(sess.requests)}</td>
                          <td className="py-2 text-right font-mono text-xs text-zinc-700">{fmtTokens(sess.total)}</td>
                          <td className="py-2 text-right text-zinc-400 text-xs" title={sess.lastActive ? fmtDateTime(sess.lastActive) : ''}>
                            {fmtRelative(sess.lastActive)}
                          </td>
                        </tr>
                      ))}
                      {(data.sessions || []).length === 0 && (
                        <tr>
                          <td colSpan={6} className="py-8 text-center text-sm text-zinc-400">
                            当前筛选下没有会话数据
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </Card>
            ) : (
              <Card>
                {/* 明细搜索：按会话名 / 项目 / 模型过滤 */}
                <div className="flex flex-wrap items-center gap-3 p-4 border-b border-zinc-100">
                  <div className="relative">
                    <IconSearch className="w-4 h-4 text-zinc-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                    <input
                      value={sessionSearch}
                      onChange={(e) => {
                        setSessionSearch(e.target.value);
                        setSessionPage(1);
                      }}
                      placeholder="搜索会话名、项目或模型…"
                      className="h-9 w-72 pl-8 pr-3 rounded-xl border border-zinc-200 text-sm bg-white outline-none focus:border-indigo-400"
                    />
                  </div>
                  {sessionSearch && (
                    <Button size="sm" variant="ghost" onClick={() => setSessionSearch('')}>
                      <IconX className="w-3.5 h-3.5" />
                      清空
                    </Button>
                  )}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm min-w-[1080px]">
                    <thead>
                      <tr className="text-xs text-zinc-400 text-left border-b border-zinc-100">
                        <th className="py-2 px-4 font-medium">会话</th>
                        {variant === 'all' && <th className="py-2 font-medium w-20">档位</th>}
                        <th className="py-2 font-medium w-32">项目</th>
                        <th className="py-2 font-medium w-56">主要模型</th>
                        <th className="py-2 font-medium w-16 text-right">请求</th>
                        <th className="py-2 font-medium w-20 text-right">输入</th>
                        <th className="py-2 font-medium w-20 text-right">输出</th>
                        <th className="py-2 font-medium w-24 text-right">缓存读</th>
                        <th className="py-2 font-medium w-24 text-right">缓存写</th>
                        <th className="py-2 font-medium w-24 text-right">总 Token</th>
                        <th className="py-2 font-medium w-28 text-right">最近活跃</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-50">
                      {sessionPageItems.map((sess) => (
                        <tr key={`${sess.variant || ''}-${sess.sessionId}`} className="hover:bg-zinc-50/60 transition-colors">
                          <td className="py-2 px-4 max-w-[280px]">
                            <div className="truncate text-zinc-700" title={sess.title || sess.sessionId}>
                              {sess.title || <span className="font-mono text-xs">{sess.sessionId.slice(0, 18)}…</span>}
                            </div>
                          </td>
                          {variant === 'all' && (
                            <td className="py-2">
                              <Badge color={sess.variant === 'ai' ? 'violet' : 'blue'}>{sess.variantLabel || '国内版'}</Badge>
                            </td>
                          )}
                          <td className="py-2 text-zinc-500 text-xs truncate max-w-32" title={sess.project}>
                            {sess.project}
                          </td>
                          <td className="py-2 text-xs">
                            {sess.topModels.slice(0, 3).map((tm, i) => (
                              <span key={tm.model} className="mr-2 inline-flex items-center gap-1">
                                <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: PALETTE[i % PALETTE.length] }} />
                                <span className="font-mono text-zinc-500">{tm.model.length > 28 ? tm.model.slice(0, 28) + '…' : tm.model}</span>
                              </span>
                            ))}
                          </td>
                          <td className="py-2 text-right text-zinc-500 text-xs font-mono">{fmtNumber(sess.requests)}</td>
                          <td className="py-2 text-right font-mono text-xs text-zinc-500 tabular-nums">{fmtTokens(sess.input)}</td>
                          <td className="py-2 text-right font-mono text-xs text-zinc-500 tabular-nums">{fmtTokens(sess.output)}</td>
                          <td className="py-2 text-right font-mono text-xs text-zinc-500 tabular-nums">{fmtTokens(sess.cacheRead)}</td>
                          <td className="py-2 text-right font-mono text-xs text-zinc-500 tabular-nums">{fmtTokens(sess.cacheWrite)}</td>
                          <td className="py-2 text-right font-mono text-xs text-zinc-700 tabular-nums">{fmtTokens(sess.total)}</td>
                          <td className="py-2 text-right text-zinc-400 text-xs" title={sess.lastActive ? fmtDateTime(sess.lastActive) : ''}>
                            {fmtRelative(sess.lastActive)}
                          </td>
                        </tr>
                      ))}
                      {sessionPageItems.length === 0 && (
                        <tr>
                          <td colSpan={variant === 'all' ? 11 : 10} className="py-8 text-center text-sm text-zinc-400">
                            没有符合搜索条件的会话
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                {filteredSessions.length > 0 && (
                  <div className="flex flex-wrap items-center gap-3 px-4 py-2.5 border-t border-zinc-100 text-xs text-zinc-500">
                    <span className="tabular-nums">
                      第 <b className="font-mono text-zinc-700">{safeSessionPage}</b> / {sessionPageCount} 页 · 共 {filteredSessions.length} 个会话 · 本页 {sessionPageItems.length} 个
                    </span>
                    <label className="flex items-center gap-1.5">
                      每页
                      <select
                        value={sessionPageSize}
                        onChange={(e) => {
                          setSessionPageSize(Number(e.target.value));
                          setSessionPage(1);
                        }}
                        className="h-7 px-1.5 rounded-lg border border-zinc-200 bg-white outline-none focus:border-indigo-400"
                      >
                        {[20, 50, 100].map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                      条
                    </label>
                    <div className="ml-auto flex items-center gap-1.5">
                      <Button size="sm" variant="subtle" disabled={safeSessionPage <= 1} onClick={() => setSessionPage(1)}>
                        首页
                      </Button>
                      <Button size="sm" variant="subtle" disabled={safeSessionPage <= 1} onClick={() => setSessionPage(safeSessionPage - 1)}>
                        上一页
                      </Button>
                      <Button size="sm" variant="subtle" disabled={safeSessionPage >= sessionPageCount} onClick={() => setSessionPage(safeSessionPage + 1)}>
                        下一页
                      </Button>
                      <Button size="sm" variant="subtle" disabled={safeSessionPage >= sessionPageCount} onClick={() => setSessionPage(sessionPageCount)}>
                        末页
                      </Button>
                    </div>
                  </div>
                )}
              </Card>
            )}
          </PageSection>

          <div className="text-xs text-zinc-400">
            数据来源：本机{' '}
            <span className="font-mono">
              {(data.dirs && data.dirs.length ? data.dirs.map((d) => d.dir) : [data.dir]).join(' / ')}/projects
            </span>{' '}
            下的会话日志，按档位分别归档（国内版 <span className="font-mono">~/.workbuddy</span>、国际版{' '}
            <span className="font-mono">~/.workbuddy-ai</span>）；仅本地解析，不会上传。统计生成于{' '}
            {fmtDateTime(data.generatedAt)}。
          </div>
        </>
      )}
    </div>
  );
}
