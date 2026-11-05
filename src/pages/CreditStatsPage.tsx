import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  IconChart,
  IconClock,
  IconCoins,
  IconHash,
  IconInfo,
  IconLayers,
  IconRefresh,
  IconTrendUp,
  IconWallet,
  IconWarning,
  IconZap,
  Modal,
  PageSection,
  ProgressBar,
  Segmented,
  Skeleton,
  StatCard,
  Toolbar,
  useToast,
} from '../components/ui';
import { get, TIMEOUT } from '../lib/api';
import { fmtNumber, fmtRelative } from '../lib/format';
import type { CreditRequestRow, CreditResponse } from '../lib/types';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

/** 积分保留两位小数即可，过长数字在卡片里会被截断 */
function fmtCredit(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  if (Math.abs(n) < 0.01) return n.toFixed(4);
  if (Math.abs(n) < 100) return n.toFixed(2);
  return fmtNumber(Math.round(n));
}

/** 图表配色：同一序列在所有图表里保持一致的颜色 */
const PALETTE = ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#0ea5e9', '#8b5cf6', '#14b8a6', '#f43f5e'];

const tooltipStyle = {
  borderRadius: 12,
  border: '1px solid #e4e4e7',
  fontSize: 12,
  boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
} as const;

/** 账号维度卡片：余额 + 本期消耗 */
function AccountBalanceCard({ row, maxConsumed }: { row: CreditResponse['accounts'][number]; maxConsumed: number }) {
  const b = row.balance;
  const usedPct = b && b.total > 0 ? Math.min(100, (b.used / b.total) * 100) : 0;
  const barTone = usedPct > 85 ? 'bg-red-500' : usedPct > 60 ? 'bg-amber-500' : 'bg-indigo-500';
  return (
    <div className="rounded-2xl border border-zinc-200/80 bg-white p-3.5 shadow-[0_1px_2px_rgba(15,23,42,.025),0_10px_28px_rgba(15,23,42,.035)] transition-shadow hover:shadow-[0_2px_4px_rgba(15,23,42,.04),0_14px_34px_rgba(15,23,42,.055)]">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium text-zinc-900 truncate">{row.accountName}</span>
            <Badge color="gray">{row.variantLabel}</Badge>
          </div>
          <div className="mt-0.5 text-[11px] text-zinc-400">
            {fmtNumber(row.requests)} 次请求 · 本期消耗 {fmtCredit(row.credit)}
          </div>
        </div>
        {row.error && <Badge color="red">查询失败</Badge>}
      </div>

      {b ? (
        <div className="mt-3">
          <div className="flex items-baseline justify-between">
            <span className="text-[11px] text-zinc-400">剩余额度</span>
            <span className="text-sm font-semibold font-mono text-indigo-600">
              {fmtCredit(b.remaining)}
              <span className="text-[11px] text-zinc-400 font-normal ml-1">/ {fmtCredit(b.total)}</span>
            </span>
          </div>
          <ProgressBar percent={usedPct} className="mt-1.5" color={barTone} />
          <div className="mt-1.5 flex items-center justify-between text-[11px] text-zinc-400">
            <span>已用 {fmtCredit(b.used)}（{usedPct.toFixed(0)}%）</span>
            <span>{b.packageCount} 个资源包</span>
          </div>
        </div>
      ) : (
        <div className="mt-3 text-[11px] text-amber-600 bg-amber-50 border border-amber-100 rounded-xl px-2 py-1.5 leading-relaxed">
          余额未知{row.balanceError ? `：${row.balanceError}` : ''}
        </div>
      )}

      {maxConsumed > 0 && (
        <div className="mt-2.5">
          <div className="text-[11px] text-zinc-400 mb-1">本期消耗占比</div>
          <ProgressBar percent={(row.credit / maxConsumed) * 100} size="sm" color="bg-violet-500" />
        </div>
      )}
    </div>
  );
}

/** 明细弹窗：按时间倒序分页展示（最新在最前），不含任何提问正文 */
function DetailModal({
  open,
  onClose,
  requests,
  accountName,
}: {
  open: boolean;
  onClose: () => void;
  requests: CreditRequestRow[];
  accountName: string;
}) {
  const [page, setPage] = useState(0);
  const PAGE = 50;
  // 上游明细是按消耗降序返回的，这里重排成时间倒序（最新的记录排前面）；复制后再排，不改调用方数组
  const sorted = useMemo(() => [...requests].sort((a, b) => (b.ts || 0) - (a.ts || 0)), [requests]);
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE));
  const view = sorted.slice(page * PAGE, page * PAGE + PAGE);

  useEffect(() => {
    if (open) setPage(0);
  }, [open]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="消耗明细"
      subtitle={`${accountName} · 共 ${fmtNumber(requests.length)} 条，按时间倒序（最新在前）`}
      width="max-w-3xl"
      footer={
        <>
          <span className="mr-auto text-xs text-zinc-400 self-center">
            第 {page + 1} / {pages} 页
          </span>
          <Button size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            上一页
          </Button>
          <Button size="sm" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>
            下一页
          </Button>
        </>
      }
    >
      <div className="overflow-x-auto -mx-1">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-zinc-400 border-b border-zinc-100">
              <th className="text-left font-medium py-2 px-1">时间</th>
              <th className="text-left font-medium py-2 px-1">模型</th>
              <th className="text-left font-medium py-2 px-1">客户端</th>
              <th className="text-left font-medium py-2 px-1">账号</th>
              <th className="text-right font-medium py-2 px-1">消耗</th>
            </tr>
          </thead>
          <tbody>
            {view.map((r) => (
              <tr key={r.requestId} className="border-b border-zinc-50 last:border-0 hover:bg-zinc-50/60 transition-colors">
                <td className="py-1.5 px-1 font-mono text-zinc-500 whitespace-nowrap">{r.time}</td>
                <td className="py-1.5 px-1 text-zinc-800 truncate max-w-[180px]">{r.model}</td>
                <td className="py-1.5 px-1 text-zinc-400">{r.client || '—'}</td>
                <td className="py-1.5 px-1 text-zinc-400 truncate max-w-[120px]">{r.accountName}</td>
                <td className="py-1.5 px-1 text-right font-mono text-zinc-700">{fmtCredit(r.credit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex items-start gap-2 rounded-xl bg-zinc-50 px-3 py-2 text-[11px] text-zinc-400 leading-relaxed">
        <IconInfo className="w-3.5 h-3.5 shrink-0 mt-px" />
        明细只包含计数与脱敏标识，不含任何提问正文或工具参数。
      </div>
    </Modal>
  );
}

export default function CreditStatsPage() {
  const toast = useToast();
  const [days, setDays] = useState<'7' | '30' | '90'>('30');
  /** 档位筛选：国内版/国际版分开看，避免两个档位的用量混在一起 */
  const [variant, setVariant] = useState<'all' | 'cn' | 'ai'>('all');
  const [data, setData] = useState<CreditResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [detail, setDetail] = useState<{ open: boolean; rows: CreditRequestRow[]; name: string }>({
    open: false,
    rows: [],
    name: '',
  });

  const load = useCallback(
    async (force = false) => {
      force ? setRefreshing(true) : setLoading(true);
      try {
        setData(
          await get<CreditResponse>(`/api/credits?days=${days}&variant=${variant}${force ? '&refresh=1' : ''}`, {
            timeoutMs: TIMEOUT.credits,
          })
        );
      } catch (e: any) {
        toast('err', e?.message || '积分统计查询失败');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [days, variant, toast]
  );

  useEffect(() => {
    load();
  }, [load]);

  const maxConsumed = useMemo(
    () => Math.max(0, ...(data?.accounts || []).map((a) => a.credit)),
    [data]
  );

  /** 可用剩余积分合计（余额查询失败的账号不计入，避免显示成 0 误导） */
  const remainingTotal = useMemo(
    () => (data?.accounts || []).filter((a) => a.balance).reduce((s, a) => s + (a.balance?.remaining || 0), 0),
    [data]
  );
  const balanceAccounts = useMemo(() => (data?.accounts || []).filter((a) => a.balance).length, [data]);

  const topModels = useMemo(() => (data?.models || []).slice(0, 8), [data]);
  const dailyChart = useMemo(
    () => (data?.daily || []).map((d) => ({ date: d.date.slice(5), credit: Number(d.credit.toFixed(2)), requests: d.requests })),
    [data]
  );

  // 只有「首次进入、还没有任何数据」才整页骨架；切档位/切天数时保留旧内容，避免白屏
  if (loading && !data) {
    return (
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (data && !loading && data.accounts.length === 0 && data.models.length === 0) {
    const variantLabel = variant === 'ai' ? '国际版' : variant === 'cn' ? '国内版' : '';
    return (
      <Card className="p-4">
        <EmptyState
          icon={<IconWallet />}
          title={variant === 'all' ? '暂无积分数据' : `${variantLabel}暂无积分数据`}
          desc={
            variant === 'all'
              ? '账号库为空，或官方接口未返回数据。请先到「WorkBuddy 管理 → 账号切换」导入账号并确认凭据有效'
              : `账号库里还没有${variantLabel}账号。可切回「全部档位」查看其它档位，或到「WorkBuddy 管理 → 账号切换」用${variantLabel}扫码添加。`
          }
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button variant="primary" onClick={() => load(true)}>
                <IconRefresh className="w-3.5 h-3.5" />
                重新查询
              </Button>
              {variant !== 'all' && (
                <Button variant="subtle" onClick={() => setVariant('all')}>
                  查看全部档位
                </Button>
              )}
            </div>
          }
        />
      </Card>
    );
  }

  // 首次加载失败（data 为空且不在加载中）：之前直接 return null 整页空白，
  // 只剩一个转瞬即逝的 toast，用户没有任何重试入口
  if (!data && !loading) {
    return (
      <Card className="p-4">
        <EmptyState
          icon={<IconWallet />}
          title="积分统计加载失败"
          desc="本地服务可能繁忙或官方接口暂时不可用，请稍后重试。"
          action={
            <Button variant="primary" onClick={() => load(true)}>
              <IconRefresh className="w-3.5 h-3.5" />
              重新加载
            </Button>
          }
        />
      </Card>
    );
  }

  // 走到这里 data 一定存在：上面只有「有数据但为空」才提前 return
  if (!data) return null;

  const s = data.summary;

  return (
    <div className="relative space-y-5">
      {/* 工具栏 */}
      <Toolbar>
        <Segmented
          value={days}
          onChange={setDays}
          options={[
            { value: '7', label: '近 7 天' },
            { value: '30', label: '近 30 天' },
            { value: '90', label: '近 90 天' },
          ]}
        />
        <Segmented<'all' | 'cn' | 'ai'>
          value={variant}
          onChange={setVariant}
          options={[
            { value: 'all', label: '全部档位' },
            { value: 'cn', label: '国内版' },
            { value: 'ai', label: '国际版' },
          ]}
        />
        <div className="text-xs text-zinc-400">
          {data.cached ? (
            <span className="inline-flex items-center gap-1">
              <IconClock className="w-3.5 h-3.5" />
              缓存数据，更新于 {fmtRelative(data.collectedAt)}
            </span>
          ) : (
            <span>数据区间 {data.rangeStart} ~ {data.rangeEnd}</span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {loading && <span className="text-xs text-zinc-400">更新中…</span>}
          {data.status !== 'complete' && (
            <Badge color={data.status === 'error' ? 'red' : 'amber'} dot>
              {data.status === 'error' ? '查询失败' : '部分成功'}
            </Badge>
          )}
          <Button size="sm" loading={refreshing} onClick={() => load(true)}>
            <IconRefresh className="w-3.5 h-3.5" />
            刷新数据
          </Button>
        </div>
      </Toolbar>

      {/* 概览 */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard
          label="可用剩余积分"
          value={fmtCredit(remainingTotal)}
          accent="text-indigo-600"
          sub={balanceAccounts ? `${balanceAccounts} 个账号有余额` : '暂无可查余额的账号'}
          icon={<IconCoins />}
          tone="indigo"
        />
        <StatCard
          label="今日消耗"
          value={fmtCredit(s.usageToday)}
          sub={`${fmtNumber(data.daily.at(-1)?.requests ?? 0)} 次请求`}
          icon={<IconTrendUp />}
          tone="sky"
        />
        <StatCard label="近 7 天" value={fmtCredit(s.usage7Days)} sub="单位 credits" icon={<IconChart />} tone="emerald" />
        <StatCard label={`${days} 天总计`} value={fmtCredit(s.usageThisMonth)} accent="text-violet-600" icon={<IconWallet />} tone="violet" />
        <StatCard label="总请求数" value={fmtNumber(s.totalRequests)} sub="逐请求口径" icon={<IconHash />} tone="amber" />
      </div>

      {/* 档位归类：全部视图下给出两个档位各自的口径 */}
      {variant === 'all' && (data.variantTotals?.length ?? 0) > 0 && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-xl border border-zinc-200/80 bg-white px-4 py-2.5 text-xs">
          <span className="text-zinc-400">按档位归类：</span>
          {(data.variantTotals || []).map((v) => (
            <span key={v.variant} className="inline-flex items-center gap-2">
              <Badge color={v.variant === 'ai' ? 'violet' : 'blue'}>{v.variant === 'ai' ? '国际版' : '国内版'}</Badge>
              <span className="text-zinc-600 tabular-nums">消耗 {fmtCredit(v.credit)}</span>
              <span className="text-zinc-400 tabular-nums">{fmtNumber(v.requests)} 次</span>
            </span>
          ))}
          {(data.accounts || []).length === 0 && <span className="text-zinc-400">该区间内没有账号产生消耗</span>}
        </div>
      )}

      {/* 错误提示 */}
      {data.errors.length > 0 && (
        <Card className="p-3.5 border-amber-200 bg-amber-50/60">
          <div className="flex items-start gap-2.5">
            <IconWarning className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-amber-800">
                {data.errors.length} 个账号查询失败
              </div>
              <ul className="mt-1.5 space-y-1">
                {data.errors.map((e) => (
                  <li key={e.accountId} className="text-xs text-amber-700 leading-relaxed">
                    <span className="font-medium">{e.accountName}</span>：{e.error}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Card>
      )}

      {/* 每日趋势 */}
      <PageSection icon={<IconChart />} title="每日消耗趋势" desc="按官方逐请求明细聚合，单位 credits">
        <Card className="p-4">
          <div className="h-64">
            {dailyChart.length === 0 ? (
              <div className="h-full flex items-center justify-center text-sm text-zinc-400">所选区间内没有消耗记录</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={dailyChart} margin={{ top: 5, right: 8, left: -18, bottom: 0 }}>
                  <defs>
                    <linearGradient id="creditGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#6366f1" stopOpacity={0.28} />
                      <stop offset="100%" stopColor="#6366f1" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#a1a1aa' }} tickLine={false} axisLine={false} minTickGap={16} />
                  <YAxis tick={{ fontSize: 11, fill: '#a1a1aa' }} tickLine={false} axisLine={false} width={52} />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    formatter={(v: any, _n: any, item: any) => [fmtCredit(v), `消耗（${item?.payload?.requests ?? 0} 次请求）`]}
                  />
                  <Area type="monotone" dataKey="credit" stroke="#6366f1" strokeWidth={2} fill="url(#creditGrad)" isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>
      </PageSection>

      {/* 账号余额 */}
      <PageSection
        icon={<IconWallet />}
        title="账号余额与消耗"
        count={data.accounts.length}
        desc="余额来自官方资源包接口（多包求和），消耗来自逐请求明细"
      >
        <div className="grid gap-3 lg:grid-cols-2">
          {data.accounts.map((a) => (
            <AccountBalanceCard key={a.accountId} row={a} maxConsumed={maxConsumed} />
          ))}
        </div>
      </PageSection>

      {/* 模型分布 */}
      <PageSection icon={<IconZap />} title="模型消耗分布" desc="按本期累计消耗排序">
        <Card className="p-4">
          <div className="grid gap-5 lg:grid-cols-2">
            <div className="h-64">
              {topModels.length === 0 ? (
                <div className="h-full flex items-center justify-center text-sm text-zinc-400">暂无数据</div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={topModels} dataKey="credit" nameKey="model" innerRadius={48} outerRadius={78} paddingAngle={2} isAnimationActive={false}>
                      {topModels.map((_, i) => (
                        <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
                      ))}
                    </Pie>
                    <Tooltip contentStyle={tooltipStyle} formatter={(v: any, n: any) => [fmtCredit(v), n]} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
            <div className="space-y-2">
              {topModels.map((m, i) => {
                const share = s.usageThisMonth > 0 ? (m.credit / s.usageThisMonth) * 100 : 0;
                return (
                  <div key={m.model}>
                    <div className="flex items-center gap-2 text-xs">
                      <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: PALETTE[i % PALETTE.length] }} />
                      <span className="text-zinc-700 truncate flex-1" title={m.model}>
                        {m.model}
                      </span>
                      <span className="font-mono text-zinc-500 shrink-0">{fmtCredit(m.credit)}</span>
                      <span className="font-mono text-zinc-400 w-11 text-right shrink-0">{share.toFixed(1)}%</span>
                    </div>
                    <ProgressBar percent={share} size="sm" className="mt-1" color="bg-zinc-300" />
                  </div>
                );
              })}
            </div>
          </div>
        </Card>
      </PageSection>

      {/* 明细入口 */}
      <PageSection
        icon={<IconLayers />}
        title="消耗明细"
        desc={`共 ${fmtNumber(data.requests.length)} 条（上限 ${fmtNumber(data.detailLimitPerAccount)} 条，按时间倒序）`}
        actions={
          <Button
            size="sm"
            variant="primary"
            disabled={data.requests.length === 0}
            onClick={() => setDetail({ open: true, rows: data.requests, name: '全部账号' })}
          >
            查看明细
          </Button>
        }
      >
        <Card className="p-3.5">
          <div className="flex flex-wrap gap-1.5">
            {data.accounts.map((a) => (
              <button
                key={a.accountId}
                onClick={() =>
                  setDetail({
                    open: true,
                    rows: data.requests.filter((r) => r.accountId === a.accountId),
                    name: a.accountName,
                  })
                }
                disabled={data.requests.every((r) => r.accountId !== a.accountId)}
                className="px-2.5 h-7 rounded-xl text-xs border border-zinc-200 text-zinc-600 hover:bg-zinc-50 hover:border-zinc-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {a.accountName}（{fmtNumber(data.requests.filter((r) => r.accountId === a.accountId).length)}）
              </button>
            ))}
          </div>
        </Card>
      </PageSection>

      <DetailModal
        open={detail.open}
        onClose={() => setDetail((d) => ({ ...d, open: false }))}
        requests={detail.rows}
        accountName={detail.name}
      />
    </div>
  );
}