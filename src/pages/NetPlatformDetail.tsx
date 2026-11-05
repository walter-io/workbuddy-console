/**
 * 全网签到的平台子页面：每个平台一个独立视图，把能扒到的信息都摊开——
 * 状态、积分、连续天数、登录态、14 天签到矩阵、该平台的全部领取记录。
 * 数据来自 /api/netcheckin/platform/:id（记录）+ 总览页轮询的共享 state（实时状态）。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Hint,
  IconChevronLeft,
  IconClock,
  IconCoins,
  IconExternalLink,
  IconRefresh,
  IconZap,
  Note,
  PageSection,
  StatCard,
  Switch,
  useToast,
} from '../components/ui';
import { get, post } from '../lib/api';
import { fmtDateTime, fmtRelative } from '../lib/format';
import {
  type LoginStatus,
  type NetPlatform,
  type NetState,
  type ResultRow,
  CATEGORY_META,
  STATUS_LABEL,
  avatarCls,
  matrixDotCls,
  statusDotCls,
  statusTextCls,
} from '../lib/netcheckin';

interface DetailData {
  platform: NetPlatform;
  records: ResultRow[];
  active: boolean;
}

export default function NetPlatformDetail({
  id,
  state,
  trial,
  login,
  onBack,
  showBack = true,
  onRefresh,
  onRun,
  onToggle,
  onLogin,
  onCancelLogin,
}: {
  id: string;
  state: NetState | null;
  trial?: { status: string; detail: string };
  login: LoginStatus | null;
  onBack: () => void;
  /** 页签视图下顶栏已有页签条，返回按钮冗余；列表/深链场景显示 */
  showBack?: boolean;
  onRefresh: () => void;
  onRun: (id: string, opts?: { dryRun?: boolean }) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onLogin: (id: string) => void;
  onCancelLogin: () => void;
}) {
  const toast = useToast();
  const [detail, setDetail] = useState<DetailData | null>(null);
  const [loadErr, setLoadErr] = useState('');

  const load = useCallback(async () => {
    try {
      const d = await get<DetailData>(`/api/netcheckin/platform/${encodeURIComponent(id)}`);
      setDetail(d);
      setLoadErr('');
    } catch (e: any) {
      setLoadErr(e?.message || '加载失败');
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // 该平台执行中或登录窗口开着时 3 秒轮询记录，否则 30 秒兜底
  const active = state?.activeIds?.includes(id) || login?.stage === 'waiting';
  useEffect(() => {
    const t = setInterval(load, active ? 3_000 : 30_000);
    return () => clearInterval(t);
  }, [load, active]);

  const p = detail?.platform || state?.platforms.find((x) => x.id === id) || null;

  if (loadErr && !p) {
    return (
      <div className="space-y-4">
        {showBack && (
          <Button size="sm" variant="ghost" onClick={onBack}>
            <IconChevronLeft className="w-4 h-4" />
            返回清单
          </Button>
        )}
        <Card className="p-10">
          <EmptyState icon={<IconZap />} title="加载失败" desc={loadErr} />
        </Card>
      </div>
    );
  }

  if (!p) {
    return (
      <Card className="p-10">
        <EmptyState icon={<IconZap />} title="加载中…" desc="正在读取平台详情" />
      </Card>
    );
  }

  const st = p.lastStatus ? STATUS_LABEL[p.lastStatus] || p.lastStatus : null;
  const rowActive = state?.activeIds?.includes(p.id) || false;
  // 需要登录按钮的情况：登录失效、检测发现失效，或从没登录过
  const needLogin = p.enabled && (p.lastStatus === 'needs_login' || trial?.status === 'needs_login' || (!p.lastLoginAt && !p.lastTs));
  const loginActive = login?.stage === 'waiting' && login.id === p.id;

  // 检测与领取各自记 loading，两个按钮不互相转圈
  const [runBusy, setRunBusy] = useState(false);
  const [trialBusy, setTrialBusy] = useState(false);

  const run = async (opts?: { dryRun?: boolean }) => {
    if (opts?.dryRun) setTrialBusy(true);
    else setRunBusy(true);
    try {
      await onRun(p.id, opts);
    } finally {
      setTrialBusy(false);
      setRunBusy(false);
    }
  };

  // 14 天矩阵（子页面数据可能比共享 state 新，优先用 detail 里的）
  const matrix = detail?.platform.matrix || p.matrix || {};
  const days = Object.keys(matrix);

  return (
    <div className="space-y-8">
      {/* 顶部：返回 + 平台身份 + 操作 */}
      <div className="flex flex-wrap items-center gap-3">
        {showBack && (
          <Button size="sm" variant="ghost" onClick={onBack}>
            <IconChevronLeft className="w-4 h-4" />
            返回清单
          </Button>
        )}
        <div className={`w-11 h-11 rounded-xl flex items-center justify-center text-lg font-semibold shrink-0 ${avatarCls(p.id)}`}>
          {p.name.slice(0, 1)}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-lg font-semibold text-zinc-900">{p.name}</span>
            <Badge color={CATEGORY_META[p.category]?.color || 'gray'}>{CATEGORY_META[p.category]?.label || p.category}</Badge>
            <Badge color="gray">{p.kind === 'client' ? '桌面版' : '网页版'}</Badge>
            <Badge color="gray">{p.visitClaim ? '登录即送' : '签到按钮'}</Badge>
            {rowActive && (
              <Badge color="blue" dot>
                执行中
              </Badge>
            )}
          </div>
          <div className="text-xs text-zinc-400 mt-0.5">{p.reward}</div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {p.homepage && (
            <a
              href={p.homepage}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-xl bg-white px-3 text-xs text-zinc-700 border border-zinc-200 shadow-sm shadow-zinc-900/5 transition-all duration-150 hover:bg-zinc-50 hover:border-zinc-300 active:scale-[0.98]"
            >
              <IconExternalLink className="w-3.5 h-3.5" />
              {p.kind === 'client' ? '下载页' : '官网'}
            </a>
          )}
          <Switch checked={p.enabled} onChange={(v) => onToggle(p.id, v)} title="开启后参与自动领取与一键执行" />
          {/* 登录按钮只在需要时出现：首次登录、登录失效或检测发现失效；登录成功后立即消失 */}
          {p.kind === 'web' && (needLogin || loginActive) && (
            <Button
              size="sm"
              variant={needLogin ? 'outline' : 'ghost'}
              loading={loginActive}
              onClick={() => (loginActive ? onCancelLogin() : onLogin(p.id))}
              title="打开内置浏览器登录该平台，登录态会存进本机档案"
            >
              {loginActive ? '取消登录' : needLogin ? '重新登录' : '登录'}
            </Button>
          )}
          <Button size="sm" variant="subtle" disabled={rowActive || trialBusy} loading={trialBusy} onClick={() => run({ dryRun: true })}>
            检测
          </Button>
          <Button size="sm" variant="primary" disabled={rowActive || runBusy || !p.enabled || p.todayDone} loading={runBusy} onClick={() => run()}>
            {p.todayDone ? '今日已领' : '立即领取'}
          </Button>
        </div>
      </div>

      {/* 需要下载客户端才能领的主动提醒（百度 Comate 等） */}
      {p.claimViaApp && p.appOnlyNote && (
        <Note tone="amber" title="需要下载客户端 / 在 App 内领取">
          {p.appOnlyNote}
        </Note>
      )}

      {/* 登录窗口进行中 */}
      {loginActive && (
        <Card className="px-4 py-3 border-sky-200 bg-sky-50/70 flex flex-wrap items-center gap-3">
          <IconExternalLink className="w-4 h-4 text-sky-500 shrink-0" />
          <div className="text-sm text-sky-800 flex-1 min-w-0">浏览器已打开，正在等待你完成登录；成功后会自动记录登录态并关闭窗口。</div>
          <Button size="sm" variant="ghost" onClick={onCancelLogin}>
            取消
          </Button>
        </Card>
      )}

      {/* 概览数字 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="今日状态"
          value={p.todayDone ? '已领取' : rowActive ? '执行中' : '未领取'}
          sub={st ? `最近：${st}${p.lastTs ? ` · ${fmtRelative(p.lastTs)}` : ''}` : '还没有执行过'}
          tone={p.todayDone ? 'emerald' : 'zinc'}
          icon={<IconZap />}
        />
        <StatCard
          label="已知积分余额"
          value={p.credits != null ? p.credits.toLocaleString('zh-CN') : '—'}
          sub={p.credits != null ? '平台最近一次报回的余额' : '该平台没有提供余额查询，暂无法显示'}
          tone="violet"
          icon={<IconCoins />}
        />
        <StatCard
          label="累计到账"
          value={p.totalGained != null ? p.totalGained.toLocaleString('zh-CN') : '—'}
          sub={p.totalGained != null ? `共 ${p.successCount} 次领取成功` : `共 ${p.successCount} 次领取成功（平台未报具体数额）`}
          tone="amber"
          icon={<IconCoins />}
        />
        <StatCard
          label="连续领取"
          value={`${p.streak} 天`}
          sub={p.lastLoginAt ? `最近登录 ${fmtRelative(p.lastLoginAt)}` : '尚未在本工具登录过'}
          tone="sky"
          icon={<IconClock />}
        />
      </div>

      {/* 平台信息 */}
      <PageSection icon={<IconZap />} title="平台信息">
        <Card className="p-4 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-2.5 text-sm">
            <InfoLine label="领取方式">{p.visitClaim ? '登录即送：打开页面即到账，没有签到按钮' : '签到按钮：由代领引擎在页面里真实点击'}</InfoLine>
            <InfoLine label="执行引擎">
              <span className="font-mono text-xs">{p.engine}</span>
              {p.headed && '（需要可见浏览器窗口，执行时会弹窗）'}
            </InfoLine>
            <InfoLine label="奖励说明">{p.reward}</InfoLine>
            <InfoLine label="客户端状态">
              {p.kind === 'client' ? (
                p.clientExe ? (
                  <>
                    已安装（<span className="font-mono text-xs">{p.clientExe}</span>）· {p.clientRunning ? '运行中' : '未运行'}
                  </>
                ) : (
                  '未安装'
                )
              ) : (
                '—'
              )}
            </InfoLine>
            <InfoLine label="最近登录">{p.lastLoginAt ? fmtDateTime(p.lastLoginAt) : '尚未在本工具登录过'}</InfoLine>
            <InfoLine label="最近执行">{p.lastTs ? `${fmtDateTime(p.lastTs)} · ${st || ''}` : '还没有执行过'}</InfoLine>
          </div>
          {trial && (
            <Hint>
              <b>最近检测：</b>
              <span className={trial.status === 'dry_run' ? 'text-teal-600' : statusTextCls(trial.status)}>
                {STATUS_LABEL[trial.status] || trial.status}
              </span>
              {trial.detail ? ` · ${trial.detail}` : ''}
            </Hint>
          )}
          {p.notes && <Hint>{p.notes}</Hint>}
          {p.lastDetail && (
            <Hint icon={false}>
              <b>最近执行详情：</b>
              {p.lastDetail}
            </Hint>
          )}
        </Card>
      </PageSection>

      {/* 14 天签到矩阵 */}
      <PageSection icon={<IconRefresh />} title="近 14 天领取情况" desc="青绿=已领 · 琥珀=受阻 · 玫红=失败 · 灰=未执行">
        <Card className="p-4">
          <div className="flex flex-wrap gap-2.5">
            {days.map((d) => (
              <div key={d} className="flex flex-col items-center gap-1.5" title={`${d}：${matrix[d] ? STATUS_LABEL[matrix[d]] || matrix[d] : '未执行'}`}>
                <span className={`inline-block h-4 w-4 rounded-md ${matrixDotCls(matrix[d])}`} />
                <span className="text-[10px] text-zinc-400 tabular-nums">{d.slice(5)}</span>
              </div>
            ))}
            {!days.length && <span className="text-sm text-zinc-400">还没有数据</span>}
          </div>
        </Card>
      </PageSection>

      {/* 该平台的领取记录表 */}
      <PageSection
        icon={<IconRefresh />}
        title="领取记录"
        count={detail?.records.length ? String(detail.records.length) : undefined}
        desc="本平台全部执行流水，新→旧"
        actions={
          <Button size="sm" variant="subtle" onClick={load}>
            <IconRefresh className="w-3.5 h-3.5" />
            刷新
          </Button>
        }
      >
        <Card className="p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead>
                <tr className="text-xs text-zinc-400 text-left border-b border-zinc-100">
                  <th className="py-2.5 px-4 font-medium w-24">状态</th>
                  <th className="py-2.5 font-medium w-32">积分变动</th>
                  <th className="py-2.5 font-medium">说明</th>
                  <th className="py-2.5 px-4 font-medium w-44 text-right">时间</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-50">
                {(detail?.records || []).map((r, i) => (
                  <tr key={`${r.ts}-${i}`} className="hover:bg-zinc-50/60 transition-colors">
                    <td className="py-2.5 px-4">
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
                    <td className="py-2.5 text-xs text-zinc-500 max-w-[420px] truncate" title={r.detail}>
                      {r.detail || '—'}
                    </td>
                    <td className="py-2.5 px-4 text-right text-xs text-zinc-400 tabular-nums">{fmtDateTime(r.ts)}</td>
                  </tr>
                ))}
                {!detail?.records.length && (
                  <tr>
                    <td colSpan={4} className="py-8 text-center text-sm text-zinc-400">
                      还没有记录。点右上角「立即领取」试一次。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </PageSection>
    </div>
  );
}

function InfoLine({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 min-w-0">
      <span className="text-xs text-zinc-400 shrink-0 w-20 pt-0.5">{label}</span>
      <span className="text-[13px] text-zinc-700 min-w-0 break-all">{children}</span>
    </div>
  );
}
