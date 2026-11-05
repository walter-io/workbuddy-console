/**
 * 全网签到页：把 WorkBuddy 以外的 AI 平台每日福利收进控制台统一代领。
 *
 * 分工：WorkBuddy 账号自己的领取在「WorkBuddy 管理 → WorkBuddy 设置」（官方
 * 接口 + 成长中心）；这里管第三方平台——网页类用内置浏览器代操作，桌面类
 * 通过调试端口临时接管客户端。
 *
 * 版式（2026-11-05 二次改版，对齐「WorkBuddy 管理」的交互）：
 * - **页签视图（默认）**：顶部一排平台页签（总览 + 每平台一个），点页签切平台，
 *   每个平台的详情独立成页（积分、14 天矩阵、该平台全部记录）；
 * - **列表视图**：原来的「领取清单」一行一条；
 * - 右上角随时切换两种视图，选择记进 localStorage；
 * - 每个平台一把独立浏览器锁：单平台的「检测 / 领取 / 登录」随时可用，
 *   批量运行期间不影响其它平台，也不影响登录窗口。
 * - 深链保持不变：#netcheckin/<平台id> 直接落到该平台的页签。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Hint,
  IconChevronDown,
  IconChevronUp,
  IconExternalLink,
  IconInfo,
  IconRefresh,
  IconZap,
  Note,
  PageSection,
  Segmented,
  StatCard,
  Switch,
  useToast,
} from '../components/ui';
import { get, post } from '../lib/api';
import { fmtDateTime, fmtRelative } from '../lib/format';
import NetPlatformDetail from './NetPlatformDetail';
import {
  type LoginStatus,
  type LogRow,
  type NetPlatform,
  type NetState,
  CATEGORY_META,
  CATEGORY_ORDER,
  STATUS_LABEL,
  avatarCls,
  statusDotCls,
  statusTextCls,
} from '../lib/netcheckin';

/** 从地址栏 hash 解析平台子页面：#netcheckin/<id> → <id> */
function parseSubId(): string | null {
  const h = location.hash.replace(/^#\/?/, '');
  if (h.startsWith('netcheckin/')) return decodeURIComponent(h.slice('netcheckin/'.length)) || null;
  return null;
}

const VIEW_KEY = 'wbhub.netcheckin.view';
type ViewMode = 'tab' | 'list';

/* ---------------- 平台行（列表视图） ---------------- */

function PlatformRow({
  p,
  active,
  trial,
  loginActive,
  onOpen,
  onRun,
  onTrial,
  onToggle,
  onLogin,
}: {
  p: NetPlatform;
  active: boolean;
  trial?: { status: string; detail: string };
  loginActive: boolean;
  onOpen: (id: string) => void;
  onRun: (id: string) => void;
  onTrial: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onLogin: (id: string) => void;
}) {
  // 需要登录按钮的情况：登录失效、检测发现失效，或从没登录过；
  // 登录成功后（runEpoch 推进）状态刷新，按钮立即消失
  const showLogin = p.kind === 'web' && (p.enabled ? p.lastStatus === 'needs_login' || trial?.status === 'needs_login' || (!p.lastLoginAt && !p.lastTs) : false);
  const st = p.lastStatus ? STATUS_LABEL[p.lastStatus] || p.lastStatus : null;

  return (
    <div>
      <div className="flex items-center gap-3.5 px-4 py-3.5 transition-colors hover:bg-zinc-50/70">
        {/* 头像块：点它进平台页签 */}
        <button onClick={() => onOpen(p.id)} title={`查看 ${p.name} 的详情`} className="shrink-0 outline-none">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-[15px] font-semibold ${avatarCls(p.id)} transition-transform active:scale-95`}>
            {p.name.slice(0, 1)}
          </div>
        </button>

        {/* 名称与实时状态：第一行身份，第二行现状 */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              onClick={() => onOpen(p.id)}
              className="text-sm font-medium text-zinc-900 hover:text-indigo-600 transition-colors"
              title={`查看 ${p.name} 的详情（积分 / 记录 / 矩阵）`}
            >
              {p.name}
            </button>
            <Badge color={CATEGORY_META[p.category]?.color || 'gray'}>{CATEGORY_META[p.category]?.label || p.category}</Badge>
            <Badge color="gray">{p.kind === 'client' ? '桌面版' : '网页版'}</Badge>
            {p.todayDone && <Badge color="teal">今日已领</Badge>}
            {p.streak >= 2 && <Badge color="teal">连续 {p.streak} 天</Badge>}
            {active && (
              <Badge color="blue" dot>
                执行中
              </Badge>
            )}
          </div>
          <div className="text-xs text-zinc-400 mt-1 flex items-center gap-1.5 flex-wrap">
            <span>{p.reward}</span>
            {p.credits != null && (
              <>
                <span className="text-zinc-300">·</span>
                <span className="text-violet-600 tabular-nums font-medium" title="平台最近一次报回的积分余额">
                  余额 {p.credits.toLocaleString('zh-CN')}
                </span>
              </>
            )}
            {st && (
              <>
                <span className="text-zinc-300">·</span>
                <span className={`inline-block h-1.5 w-1.5 rounded-full ${statusDotCls(p.lastStatus)}`} />
                <span className={statusTextCls(p.lastStatus)}>
                  {st}
                  {p.lastTs ? `（${fmtRelative(p.lastTs)}）` : ''}
                </span>
              </>
            )}
            {p.lastDetail && (
              <>
                <span className="text-zinc-300">·</span>
                <span className="truncate max-w-[360px]" title={p.lastDetail}>
                  {p.lastDetail}
                </span>
              </>
            )}
            {p.kind === 'client' && p.clientExe && (
              <>
                <span className="text-zinc-300">·</span>
                <span>{p.clientRunning ? '客户端运行中' : '客户端未运行'}</span>
              </>
            )}
            {trial && (
              <>
                <span className="text-zinc-300">·</span>
                <span
                  className="inline-flex items-center gap-1 rounded-md border border-dashed border-zinc-300 px-1.5 py-px text-zinc-500"
                  title={trial.detail || undefined}
                >
                  <span className="text-zinc-400">检测</span>
                  <span className={trial.status === 'dry_run' ? 'text-teal-600' : statusTextCls(trial.status)}>
                    {STATUS_LABEL[trial.status] || trial.status}
                  </span>
                </span>
              </>
            )}
          </div>
        </div>

        {/* 操作：详情 → 官网 → 登录（需要时） → 检测 → 领取 → 开关 */}
        <div className="flex items-center gap-2 shrink-0">
          <Button size="xs" variant="ghost" onClick={() => onOpen(p.id)} title="切到该平台的页签，查看积分、14 天矩阵与全部领取记录">
            详情
          </Button>
          {p.homepage && (
            <a
              href={p.homepage}
              target="_blank"
              rel="noreferrer"
              title={p.kind === 'client' ? `前往 ${p.name} 的下载页` : `打开 ${p.name} 的官网（含登录入口）`}
              className="inline-flex h-6 items-center gap-1 rounded-xl bg-white px-2 text-[11px] text-zinc-700 border border-zinc-200 shadow-sm shadow-zinc-900/5 transition-all duration-150 hover:bg-zinc-50 hover:border-zinc-300 active:scale-[0.98]"
            >
              <IconExternalLink className="w-3 h-3" />
              {p.kind === 'client' ? '下载' : '官网'}
            </a>
          )}
          {showLogin && (
            <Button
              size="xs"
              variant={p.lastStatus === 'needs_login' || trial?.status === 'needs_login' ? 'outline' : 'ghost'}
              loading={loginActive}
              onClick={() => onLogin(p.id)}
              title="打开内置浏览器登录该平台，登录态会存进本机档案"
            >
              重新登录
            </Button>
          )}
          <Button size="xs" variant="ghost" disabled={active} onClick={() => onTrial(p.id)} title="只核对这一个平台的入口与登录态，不点击、不领取">
            检测
          </Button>
          <Button size="xs" variant="subtle" disabled={active || !p.enabled || p.todayDone} onClick={() => onRun(p.id)}>
            {p.todayDone ? '已领取' : '领取'}
          </Button>
          <Switch checked={p.enabled} onChange={(v) => onToggle(p.id, v)} title="开启后参与自动领取与一键执行" className="ml-1" />
        </div>
      </div>

      {/* 注意事项：常驻展示，不随开关状态切换；需要下载客户端的平台加醒目提醒 */}
      {(p.notes || (p.claimViaApp && p.appOnlyNote)) && (
        <div className="px-4 pb-3 pl-[62px] -mt-0.5 space-y-1.5">
          {p.claimViaApp && p.appOnlyNote && <Note tone="amber">{p.appOnlyNote}</Note>}
          {p.notes && <Hint icon={false}>{p.notes}</Hint>}
        </div>
      )}
    </div>
  );
}

/* ---------------- 共享区块 ---------------- */

/** 领取记录表（平台 / 状态 / 积分 / 说明 / 时间），总览页签与列表视图共用 */
function RecordsSection({ state, onRefresh, onOpen }: { state: NetState; onRefresh: () => void; onOpen: (id: string) => void }) {
  return (
    <PageSection
      icon={<IconRefresh />}
      title="领取记录"
      desc={
        state.running
          ? '执行中，新结果会实时插进来…'
          : state.lastRun
            ? `最近一轮 ${fmtDateTime(state.lastRun.ts)} · ${state.lastRun.done}/${state.lastRun.total} 领取成功`
            : '还没有执行过'
      }
      count={state.recentResults?.length ? String(state.recentResults.length) : undefined}
      actions={
        <Button size="sm" variant="subtle" onClick={onRefresh} title="重新拉取最新记录">
          <IconRefresh className="w-3.5 h-3.5" />
          刷新
        </Button>
      }
    >
      <Card className="p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[720px]">
            <thead>
              <tr className="text-xs text-zinc-400 text-left border-b border-zinc-100">
                <th className="py-2.5 px-4 font-medium w-36">平台</th>
                <th className="py-2.5 font-medium w-28">状态</th>
                <th className="py-2.5 font-medium w-32">积分变动</th>
                <th className="py-2.5 font-medium">说明</th>
                <th className="py-2.5 px-4 font-medium w-40 text-right">时间</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-50">
              {(state.recentResults || []).map((r, i) => (
                <tr
                  key={`${r.id}-${r.ts}-${i}`}
                  className="hover:bg-zinc-50/60 transition-colors cursor-pointer"
                  onClick={() => onOpen(r.id)}
                  title={`查看 ${r.name} 的详情`}
                >
                  <td className="py-2.5 px-4">
                    <span className="inline-flex items-center gap-2 min-w-0">
                      <span className={`w-6 h-6 rounded-lg flex items-center justify-center text-[11px] font-semibold shrink-0 ${avatarCls(r.id)}`}>
                        {r.name.slice(0, 1)}
                      </span>
                      <span className="text-[13px] text-zinc-700 truncate max-w-24">{r.name}</span>
                    </span>
                  </td>
                  <td className="py-2.5">
                    <span className="inline-flex items-center gap-1.5">
                      <span className={`inline-block h-1.5 w-1.5 rounded-full ${statusDotCls(r.status)}`} />
                      <span className={`text-xs font-medium ${statusTextCls(r.status)}`}>{STATUS_LABEL[r.status] || r.status}</span>
                      {r.dryRun && <Badge color="gray">检测</Badge>}
                    </span>
                  </td>
                  <td className="py-2.5 text-xs tabular-nums">
                    {r.gain != null ? (
                      <span className="text-teal-600 font-medium">+{r.gain.toLocaleString('zh-CN')}</span>
                    ) : r.credits != null ? (
                      <span className="text-zinc-500">余额 {r.credits.toLocaleString('zh-CN')}</span>
                    ) : (
                      <span className="text-zinc-300">—</span>
                    )}
                  </td>
                  <td className="py-2.5 text-xs text-zinc-500 max-w-[380px] truncate" title={r.detail}>
                    {r.detail || '—'}
                  </td>
                  <td className="py-2.5 px-4 text-right text-xs text-zinc-400 tabular-nums">{fmtDateTime(r.ts)}</td>
                </tr>
              ))}
              {!state.recentResults?.length && (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-sm text-zinc-400">
                    还没有记录。点「一键领取」，或某一行里的「领取」，每次执行都会记在这里。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </PageSection>
  );
}

/** 运行输出：可折叠面板（内部持有自己的滚底 ref） */
function LogPanel({ logs, running }: { logs: LogRow[]; running: boolean }) {
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [logs]);
  return (
    <div ref={boxRef} className="h-56 overflow-y-auto rounded-2xl border border-zinc-200/80 bg-white divide-y divide-zinc-50">
      {!logs.length && <div className="px-4 py-4 text-sm text-zinc-400">还没有输出。点「一键领取」或某一行里的「领取」，每一步都会列在这里。</div>}
      {logs.map((l) => (
        <div key={l.seq} className="flex items-start gap-2.5 px-4 py-2">
          <span
            className={`mt-1.5 inline-block h-1.5 w-1.5 rounded-full shrink-0 ${
              l.level === 'ok' ? 'bg-teal-500' : l.level === 'warn' ? 'bg-amber-500' : l.level === 'err' ? 'bg-rose-500' : 'bg-zinc-300'
            }`}
          />
          <span className="text-[11px] text-zinc-300 shrink-0 tabular-nums pt-0.5">{new Date(l.ts).toLocaleTimeString('zh-CN', { hour12: false })}</span>
          <span
            className={`text-xs leading-relaxed min-w-0 break-words ${
              l.level === 'ok' ? 'text-zinc-700' : l.level === 'warn' ? 'text-amber-700' : l.level === 'err' ? 'text-rose-600' : 'text-zinc-600'
            }`}
          >
            {l.text}
          </span>
        </div>
      ))}
      {running && <div className="px-4 py-2 text-xs text-zinc-400">实时滚动中…</div>}
    </div>
  );
}

/** 羊毛情报 */
function ManualSection({ platforms }: { platforms: NetState['manualPlatforms'] }) {
  if (!platforms.length) return null;
  return (
    <PageSection
      icon={<IconInfo />}
      title="羊毛情报"
      desc="这些平台也有免费福利，但无法由控制台代领——知道有，需要的话自己动手"
    >
      <Card className="p-0 overflow-hidden">
        <div className="divide-y divide-zinc-100">
          {platforms.map((m) => (
            <div key={m.id} className="flex items-start gap-3 px-4 py-3">
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-[13px] font-semibold shrink-0 ${avatarCls(m.id)}`}>
                {m.name.slice(0, 1)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-sm font-medium text-zinc-700">{m.name}</span>
                  <Badge color={CATEGORY_META[m.category]?.color || 'gray'}>{CATEGORY_META[m.category]?.label || m.category}</Badge>
                </div>
                <div className="text-xs text-zinc-500 mt-0.5">{m.reward}</div>
                <div className="text-[11px] text-zinc-400 mt-0.5 leading-relaxed">{m.why}</div>
              </div>
              <a
                href={m.homepage}
                target="_blank"
                rel="noreferrer"
                title={`打开 ${m.name} 官网`}
                className="inline-flex h-6 items-center gap-1 rounded-xl bg-white px-2 text-[11px] text-zinc-700 border border-zinc-200 shadow-sm shadow-zinc-900/5 transition-all duration-150 hover:bg-zinc-50 hover:border-zinc-300 active:scale-[0.98] shrink-0"
              >
                <IconExternalLink className="w-3 h-3" />
                官网
              </a>
            </div>
          ))}
        </div>
      </Card>
    </PageSection>
  );
}

/* ---------------- 页面主体 ---------------- */

export default function NetCheckinPage() {
  const toast = useToast();
  const [view, setView] = useState<ViewMode>(() => (localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'tab'));
  const [activeTab, setActiveTab] = useState<string>(() => parseSubId() || 'overview');
  /** 访问过的平台页签保持挂载（仅隐藏），切换不重新拉数据 */
  const [visitedTabs, setVisitedTabs] = useState<Set<string>>(() => new Set([parseSubId() || 'overview'].filter(Boolean) as string[]));
  const [state, setState] = useState<NetState | null>(null);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [busy, setBusy] = useState(false);
  /** 运行输出面板是否展开：批量运行时强制展开 */
  const [showLog, setShowLog] = useState(false);
  const [login, setLogin] = useState<LoginStatus | null>(null);

  // 日志增量拉取的游标：只取新增部分，避免整段重绘
  const logSeq = useRef(0);
  /** 已主动提醒过「需要下载客户端」的平台（每次会话只提醒一次） */
  const appWarned = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const s = await get<NetState>('/api/netcheckin/state');
      setState(s);
    } catch {
      /* 服务断开时 ServiceBanner 会兜底提示 */
    }
  }, []);

  const pullLogs = useCallback(async () => {
    try {
      const r = await get<{ logs: LogRow[]; lastSeq: number }>(`/api/netcheckin/logs?since=${logSeq.current}`);
      if (r.logs.length) {
        logSeq.current = r.lastSeq;
        setLogs((prev) => [...prev, ...r.logs].slice(-300));
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    refresh();
    pullLogs();
  }, [refresh, pullLogs]);

  // 深链路由：#netcheckin/<id> 落到对应平台页签（页签视图）
  useEffect(() => {
    const onHash = () => {
      const sub = parseSubId();
      if (sub) {
        setView('tab');
        setActiveTab(sub);
        setVisitedTabs((v) => (v.has(sub) ? v : new Set(v).add(sub)));
      } else {
        setActiveTab('overview');
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // 浏览器会把后台标签页的定时器节流到分钟级——切回本页时立刻补拉一次状态，
  // 否则补跑领完了豆包，切回来还要等下一个轮询甚至手动刷新才能看到「今日已领」
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        refresh();
        pullLogs();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh, pullLogs]);

  // 轮询节奏：有平台在执行（批量或单平台）2 秒（输出要跟手），空闲 30 秒兜底刷新；
  // 检测到「运行中 → 结束」的瞬间补一条汇总提示 + 下载类平台的主动提醒
  const prevRunning = useRef(false);
  useEffect(() => {
    const anyActive = state?.running || (state?.activeIds?.length || 0) > 0;
    const t = setInterval(async () => {
      const s = await get<NetState>('/api/netcheckin/state').catch(() => null);
      if (s) {
        setState(s);
        if (prevRunning.current && !s.running && s.lastRun) {
          const ok = s.lastRun.done === s.lastRun.total && s.lastRun.total > 0;
          if (ok) toast('ok', `本轮全部领取完成（${s.lastRun.done}/${s.lastRun.total}）`);
          else toast('info', `本轮结束：${s.lastRun.done}/${s.lastRun.total} 领取成功，详情见领取记录`);
          // 需要下载客户端才能领的平台：入口未命中时大声提醒，别让用户翻记录才发现
          for (const p of s.platforms) {
            if (p.claimViaApp && p.lastStatus === 'not_found' && !appWarned.current.has(p.id)) {
              appWarned.current.add(p.id);
              toast('warn', `${p.name}：${p.appOnlyNote || '该平台需要下载客户端或在 App 内领取'}`);
            }
          }
        }
        prevRunning.current = s.running;
      }
      await pullLogs();
    }, anyActive ? 2_000 : 30_000);
    return () => clearInterval(t);
  }, [state?.running, state?.activeIds?.length, pullLogs, toast]);

  // 登录窗口状态轮询：只在有登录会话时进行
  useEffect(() => {
    if (!login || login.stage !== 'waiting') return;
    const t = setInterval(async () => {
      const s = await get<LoginStatus>('/api/netcheckin/login/status').catch(() => null);
      if (!s) return;
      setLogin(s);
      if (s.stage === 'success') {
        toast('ok', s.message || '登录成功');
        refresh();
      } else if (s.stage === 'failed' || s.stage === 'timeout' || s.stage === 'cancelled') {
        toast('err', s.message || '登录未完成');
      }
    }, 2_000);
    return () => clearInterval(t);
  }, [login?.stage, login, toast, refresh]);

  const startRun = async (opts: { only?: string[]; dryRun?: boolean }, quiet = false) => {
    setBusy(true);
    try {
      await post('/api/netcheckin/run', opts);
      // 运行状态由轮询带回来；先把日志游标推进到当前末尾，只展示本轮的输出
      logSeq.current = 0;
      setLogs([]);
      await pullLogs();
      if (!quiet) toast('info', opts.dryRun ? '已开始检测，结论会标注在每一行上' : '已开始执行，过程见运行输出');
      if (opts.dryRun) setShowLog(true);
    } catch (e: any) {
      toast('err', e?.message || '启动失败');
    } finally {
      setBusy(false);
    }
  };

  const togglePlatform = async (id: string, enabled: boolean) => {
    try {
      await post('/api/netcheckin/toggle', { id, enabled });
      refresh();
    } catch (e: any) {
      toast('err', e?.message || '切换失败');
    }
  };

  const startLogin = async (id: string) => {
    try {
      await post('/api/netcheckin/login/start', { id });
      setLogin({ id, name: '', stage: 'waiting', message: '等待扫码或输入手机号' });
      toast('info', '浏览器窗口已打开：完成登录后会自动记录并关闭窗口');
    } catch (e: any) {
      toast('err', e?.message || '无法打开登录窗口');
    }
  };

  const cancelLogin = async () => {
    try {
      await post('/api/netcheckin/login/cancel');
      setLogin(null);
    } catch {
      /* ignore */
    }
  };

  /** 切到某平台的页签（页签视图）：写 hash 保持深链可复制 */
  const openPlatform = useCallback((id: string) => {
    setView('tab');
    setActiveTab(id);
    setVisitedTabs((v) => (v.has(id) ? v : new Set(v).add(id)));
    if (parseSubId() !== id) location.hash = `netcheckin/${id}`;
  }, []);

  const switchView = (v: ViewMode) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* ignore */
    }
    if (v === 'list' && location.hash !== '#netcheckin') location.hash = 'netcheckin';
    if (v === 'tab' && activeTab !== 'overview' && parseSubId() !== activeTab) location.hash = `netcheckin/${activeTab}`;
  };

  if (!state) {
    return (
      <Card className="p-10">
        <EmptyState icon={<IconZap />} title="加载中…" desc="正在读取平台状态" />
      </Card>
    );
  }

  const enabled = state.platforms.filter((p) => p.enabled);
  const doneToday = enabled.filter((p) => p.todayDone).length;
  // 页签与列表都按类别统一排序（模型 → 编程 → 视频 → 美术），同类别内保持注册表顺序
  const sorted = [...state.platforms].sort(
    (a, b) => (CATEGORY_ORDER[a.category] ?? 9) - (CATEGORY_ORDER[b.category] ?? 9),
  );

  return (
    <div className="space-y-6">
      {/* 顶部工具卡：视图切换 + 页签条 + 全局操作（对齐 WorkBuddy 管理的顶栏） */}
      <Card className="p-3.5 flex flex-wrap items-center gap-x-4 gap-y-3">
        <Segmented<ViewMode>
          value={view}
          onChange={switchView}
          options={[
            { value: 'tab', label: '平台页签', title: '每个平台一个页签，点开看积分、记录与矩阵' },
            { value: 'list', label: '列表', title: '领取清单一行一条（旧版式）' },
          ]}
        />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {state.running && (
            <Badge color="blue" dot>
              {state.runSource === 'auto' ? '自动领取中' : '执行中'}
            </Badge>
          )}
          <span
            className="hidden lg:inline text-xs text-zinc-400 tabular-nums"
            title={`每天 ${state.schedule.time} 自动执行，随机延迟 0~${state.schedule.jitterMinutes} 分钟；时间在「设置」页调整`}
          >
            下次执行 {state.schedule.enabled && state.nextWindowAt ? new Date(state.nextWindowAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '已关闭'}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={state.running || busy}
            loading={busy}
            onClick={() => startRun({ dryRun: true })}
            title="并行核对网页类平台的入口与登录态（含未启用的），不点击、不动客户端；结论会标注在每一行/每个页签上"
          >
            检测
          </Button>
          <Button variant="primary" size="sm" disabled={state.running || busy} loading={busy} onClick={() => startRun({})}>
            一键领取
          </Button>
        </div>
        {/* 平台页签条：总览 + 每平台一枚，页签视图下显示 */}
        {view === 'tab' && (
          <div className="w-full flex flex-wrap items-center gap-1.5 pt-0.5 border-t border-zinc-100 mt-1">
            <button
              onClick={() => {
                setActiveTab('overview');
                if (parseSubId()) location.hash = 'netcheckin';
              }}
              className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-xs transition-all duration-150 ${
                activeTab === 'overview' ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800'
              }`}
              title="全部平台的领取记录、运行输出与羊毛情报"
            >
              总览
            </button>
            {sorted.map((p) => (
              <button
                key={p.id}
                onClick={() => openPlatform(p.id)}
                className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-xs transition-all duration-150 ${
                  activeTab === p.id ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800'
                }`}
                title={`${p.name}：${STATUS_LABEL[p.lastStatus || ''] || '未执行'}${p.credits != null ? ` · 余额 ${p.credits}` : ''}`}
              >
                <span className={`w-4 h-4 rounded flex items-center justify-center text-[10px] font-semibold ${avatarCls(p.id)}`}>{p.name.slice(0, 1)}</span>
                <span className="max-w-28 truncate">{p.name}</span>
                <span className={`inline-block h-1.5 w-1.5 rounded-full ${p.lastStatus ? statusDotCls(p.lastStatus) : 'bg-zinc-200'}`} />
              </button>
            ))}
          </div>
        )}
      </Card>

      {/* 登录窗口进行中：两种视图都常驻提示 */}
      {login?.stage === 'waiting' && (
        <Card className="px-4 py-3 border-sky-200 bg-sky-50/70 flex flex-wrap items-center gap-3">
          <IconExternalLink className="w-4 h-4 text-sky-500 shrink-0" />
          <div className="text-sm text-sky-800 flex-1 min-w-0">
            浏览器已打开（{state.platforms.find((p) => p.id === login.id)?.name || login.id}），正在等待你完成登录；成功后会自动记录并关闭窗口。登录期间其它平台照常可用。
          </div>
          <Button size="sm" variant="ghost" onClick={cancelLogin}>
            取消
          </Button>
        </Card>
      )}

      {/* ============ 页签视图 ============ */}
      {view === 'tab' && (
        <>
          {/* 总览页签：概览数字 + 领取记录 + 运行输出 + 羊毛情报 */}
          <div className={activeTab === 'overview' ? 'space-y-6' : 'hidden'}>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <StatCard
                label="今日进度"
                value={`${doneToday}/${enabled.length}`}
                sub={state.schedule.enabled && state.nextWindowAt ? `下次自动执行 ${fmtRelative(state.nextWindowAt)}` : '自动领取已关闭'}
                tone={doneToday >= enabled.length && enabled.length > 0 ? 'emerald' : 'indigo'}
                icon={<IconZap />}
              />
              <StatCard label="累计领取" value={state.totals.claims.toLocaleString('zh-CN')} sub="全部平台的成功领取次数" tone="violet" icon={<IconInfo />} />
              <StatCard
                label="需要关注"
                value={String(
                  state.platforms.filter((p) => p.lastStatus === 'needs_login' || (p.claimViaApp && p.lastStatus === 'not_found')).length,
                )}
                sub="登录失效 / 需要下载客户端领取"
                tone="amber"
                icon={<IconRefresh />}
              />
              <StatCard
                label="自动领取"
                value={state.schedule.enabled ? state.schedule.time : '已关闭'}
                sub={`随机延迟 0~${state.schedule.jitterMinutes} 分钟，时间在「设置」页调`}
                tone="sky"
                icon={<IconZap />}
              />
            </div>
            <RecordsSection state={state} onRefresh={refresh} onOpen={openPlatform} />
            <PageSection
              icon={<IconInfo />}
              title="运行输出"
              desc={state.running ? '实时滚动中…' : '本轮或最近执行的逐行过程'}
              actions={
                showLog || state.running ? (
                  <Button size="sm" variant="ghost" onClick={() => setShowLog(false)}>
                    <IconChevronUp className="w-3.5 h-3.5" />
                    收起
                  </Button>
                ) : undefined
              }
            >
              {(showLog || state.running) && <LogPanel logs={logs} running={state.running} />}
              {!showLog && !state.running && (
                <div className="flex justify-center">
                  <Button size="sm" variant="ghost" onClick={() => setShowLog(true)}>
                    <IconChevronDown className="w-3.5 h-3.5" />
                    展开运行输出
                  </Button>
                </div>
              )}
            </PageSection>
            <ManualSection platforms={state.manualPlatforms} />
          </div>

          {/* 平台页签：访问过的保持挂载，切换不丢状态 */}
          {sorted.map((p) =>
            visitedTabs.has(p.id) ? (
              <div key={p.id} className={activeTab === p.id ? '' : 'hidden'}>
                <NetPlatformDetail
                  id={p.id}
                  state={state}
                  trial={state.trial?.[p.id]}
                  login={login}
                  onBack={() => setActiveTab('overview')}
                  showBack={false}
                  onRefresh={refresh}
                  onRun={(id, opts) => startRun({ only: [id], ...(opts || {}) }, true)}
                  onToggle={togglePlatform}
                  onLogin={startLogin}
                  onCancelLogin={cancelLogin}
                />
              </div>
            ) : null,
          )}
        </>
      )}

      {/* ============ 列表视图（旧版式：领取清单一行一条） ============ */}
      {view === 'list' && (
        <div className="space-y-8">
          <PageSection
            icon={<IconZap />}
            title="领取清单"
            count={enabled.length ? `今日 ${doneToday}/${enabled.length}` : undefined}
            desc="管的是 WorkBuddy 以外的平台：到点自动代领、按平台单独开关；点平台名切到该平台的页签"
          >
            <div className="space-y-4">
              {state.platforms.length === 0 ? (
                <Card className="p-10">
                  <EmptyState icon={<IconZap />} title="清单是空的" desc="注册表里没有任何平台，检查 server/netcheckin/registry.mjs" />
                </Card>
              ) : (
                <Card className="p-0 overflow-hidden">
                  <div className="divide-y divide-zinc-100">
                    {sorted.map((p) => (
                      <PlatformRow
                        key={p.id}
                        p={p}
                        active={state.activeIds?.includes(p.id) || false}
                        trial={state.trial?.[p.id]}
                        loginActive={login?.stage === 'waiting' && login.id === p.id}
                        onOpen={openPlatform}
                        onRun={(id) => startRun({ only: [id] }, true)}
                        onTrial={(id) => startRun({ only: [id], dryRun: true }, true)}
                        onToggle={togglePlatform}
                        onLogin={startLogin}
                      />
                    ))}
                  </div>
                </Card>
              )}

              <Hint>
                想让控制台代领新平台？在{' '}
                <span className="font-mono">~/.free-token/checkin/config.json</span> 的 custom 数组里登记一条（名称、入口网址、按钮文字），保存后刷新本页就会出现在清单里；
                平台改版导致按钮对不上时，对应行会标出「入口未命中」。每个平台都有独立页签：点平台名或「详情」切换。
              </Hint>
            </div>
          </PageSection>

          <RecordsSection state={state} onRefresh={refresh} onOpen={openPlatform} />

          {/* 运行输出：可折叠，批量运行时自动展开 */}
          {(showLog || state.running) && (
            <PageSection
              icon={<IconInfo />}
              title="运行输出"
              desc={state.running ? '实时滚动中…' : '本轮或最近执行的逐行过程'}
              actions={
                <Button size="sm" variant="ghost" onClick={() => setShowLog(false)}>
                  <IconChevronUp className="w-3.5 h-3.5" />
                  收起
                </Button>
              }
            >
              <LogPanel logs={logs} running={state.running} />
            </PageSection>
          )}
          {!showLog && !state.running && (
            <div className="flex justify-center">
              <Button size="sm" variant="ghost" onClick={() => setShowLog(true)}>
                <IconChevronDown className="w-3.5 h-3.5" />
                展开运行输出
              </Button>
            </div>
          )}

          <ManualSection platforms={state.manualPlatforms} />
        </div>
      )}
    </div>
  );
}
