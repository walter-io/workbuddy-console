import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Hint,
  IconBox,
  IconCheck,
  IconCopy,
  IconExternalLink,
  IconEye,
  IconEyeOff,
  IconKey,
  IconLoader,
  IconRefresh,
  IconSliders,
  IconSwitch,
  IconUser,
  IconWarning,
  IconZap,
  Note,
  PageSection,
  Segmented,
  Skeleton,
  StatCard,
  Switch,
  useConfirm,
  useToast,
} from '../components/ui';
import { get, post } from '../lib/api';
import { loomyApi } from '../lib/loomy';
import type { LoomyProxyStatus, LoomyUpstreamTestResponse } from '../lib/loomy';
import { fmtDateTime, fmtNumber, fmtRelative } from '../lib/format';
import {
  type LoginStatus,
  type NetPlatform,
  type NetState,
  STATUS_LABEL,
  statusTextCls,
} from '../lib/netcheckin';
import NetPlatformDetail from './NetPlatformDetail';

const LOOMY_ID = 'loomy';

/** Loomy 管理页页签：每日积分（签到）+ 反向代理 */
export type LoomyTab = 'checkin' | 'proxy';

const LOOMY_TABS = [
  { value: 'checkin' as const, label: '每日积分' },
  { value: 'proxy' as const, label: '反向代理' },
];

/**
 * Loomy 签到区块：与「豆包管理」同款——客户端启停卡片 + 平台签到详情。
 * Loomy 属于 client-open 类平台：控制台每天替你打开一次客户端，每日赠送积分即自动刷新。
 * 数据与操作全部复用全网签到通用接口（/api/netcheckin/*），与全网签到页读同一份状态。
 */
function LoomyCheckinSection() {
  const toast = useToast();
  const [state, setState] = useState<NetState | null>(null);
  const [login, setLogin] = useState<LoginStatus | null>(null);
  const [stopping, setStopping] = useState(false);

  const stateRev = useRef(0);
  const applyState = useCallback((s: NetState) => {
    const rev = typeof s.rev === 'number' ? s.rev : 0;
    if (rev && rev < stateRev.current) return;
    if (rev) stateRev.current = rev;
    setState(s);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const s = await get<NetState>('/api/netcheckin/state');
      applyState(s);
    } catch {
      /* ServiceBanner 兜底提示 */
    }
  }, [applyState]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  const loomy: NetPlatform | null = state?.platforms.find((p) => p.id === LOOMY_ID) || null;
  const active = Boolean(state?.activeIds?.includes(LOOMY_ID)) || login?.stage === 'waiting';
  useEffect(() => {
    const t = setInterval(async () => {
      const s = await get<NetState>('/api/netcheckin/state').catch(() => null);
      if (s) applyState(s);
    }, active ? 2_000 : 30_000);
    return () => clearInterval(t);
  }, [active, applyState]);

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
  }, [login, toast, refresh]);

  const startRun = async (id: string, opts?: { dryRun?: boolean }): Promise<{ started: boolean }> => {
    try {
      const r = await post<{ started?: boolean; ok?: boolean; error?: string }>('/api/netcheckin/run', {
        only: [id],
        dryRun: Boolean(opts?.dryRun),
      });
      if (r && r.ok === false) {
        toast('warn', r.error || '没有开始执行');
        return { started: false };
      }
      toast('info', opts?.dryRun ? 'Loomy 检测已开始，结论出来自动标在页面上' : 'Loomy 任务已开始，结果出来自动更新');
      return { started: true };
    } catch (e: any) {
      toast('err', e?.message || '启动失败');
      return { started: false };
    }
  };

  const togglePlatform = async (id: string, enabled: boolean) => {
    try {
      await post('/api/netcheckin/toggle', { id, enabled });
      await refresh();
    } catch (e: any) {
      toast('err', `保存开关失败：${e?.message || '未知错误'}`);
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

  /** 启动 Loomy 客户端：每天打开一次客户端，赠送积分即自动到账 */
  const openClient = async () => {
    try {
      const r = await post<{ status: string; detail: string }>('/api/netcheckin/open-client', { id: LOOMY_ID });
      if (r.status === 'uncertain') toast('info', r.detail);
      else toast('ok', r.detail || '已发出启动指令');
      refresh();
    } catch (e: any) {
      toast('err', e?.message || '启动客户端失败');
    }
  };

  const closeClient = async () => {
    setStopping(true);
    try {
      const r = await post<{ ok: boolean; detail: string }>('/api/netcheckin/close-client', { id: LOOMY_ID });
      if (r.ok) toast('ok', r.detail || '客户端已关闭');
      else toast('warn', r.detail || '关闭未完成');
      refresh();
    } catch (e: any) {
      toast('err', e?.message || '关闭客户端失败');
    } finally {
      setStopping(false);
    }
  };

  return (
    <div className="space-y-5">
      <Card className="p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-sky-50 text-sky-600 flex items-center justify-center text-base font-semibold shrink-0">L</div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[15px] font-semibold text-zinc-900">Loomy 客户端</span>
              {loomy?.clientExe ? (
                <Badge color={loomy.clientRunning ? 'green' : 'gray'} dot>
                  {loomy.clientRunning ? '运行中' : '未运行'}
                </Badge>
              ) : (
                <Badge color="amber">未找到主程序</Badge>
              )}
              {active && <Badge color="blue" dot>执行中</Badge>}
            </div>
            <div className="text-xs text-zinc-400 mt-0.5">
              {loomy?.clientExe
                ? `主程序：${loomy.clientExe}`
                : '先在常规目录安装 Loomy 桌面版，或把 exe 路径填进 ~/.free-token/checkin/config.json 的 platforms.loomy.app'}
            </div>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button size="sm" variant="subtle" onClick={refresh}>
              <IconRefresh className="w-3.5 h-3.5" />
              刷新状态
            </Button>
            <Button size="sm" variant="subtle" onClick={closeClient} loading={stopping}>
              关闭客户端
            </Button>
            <Button size="sm" variant="primary" onClick={openClient}>
              <IconZap className="w-3.5 h-3.5" />
              启动客户端
            </Button>
          </div>
        </div>
        <Hint>
          Loomy 的「每日赠送积分」在客户端<strong>登录后自动刷新</strong>，没有签到按钮——控制台每天替你打开一次客户端（已开着就不动）即算完成。
          客户端已在运行时启动按钮只会给出提示，不会重复拉起。
        </Hint>
      </Card>

      <NetPlatformDetail
        id={LOOMY_ID}
        state={state}
        trial={state?.trial?.[LOOMY_ID] || undefined}
        login={login}
        showBack={false}
        onBack={() => {}}
        onRefresh={refresh}
        onRun={startRun}
        onToggle={togglePlatform}
        onLogin={startLogin}
        onCancelLogin={cancelLogin}
      />

      {loomy?.lastTs && (
        <PageSection icon={<IconExternalLink />} title="最近一次执行" desc={fmtRelative(loomy.lastTs)}>
          <Card className="p-4 space-y-1 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className={statusTextCls(loomy.lastStatus)}>{STATUS_LABEL[loomy.lastStatus || ''] || loomy.lastStatus}</span>
              <span className="text-xs text-zinc-400">{fmtDateTime(loomy.lastTs)}</span>
            </div>
            {loomy.lastDetail && <div className="text-xs text-zinc-600 break-all">{loomy.lastDetail}</div>}
          </Card>
        </PageSection>
      )}

      <Note tone="amber" title="关于两个入口">
        「Loomy 管理」是独立菜单，「全网签到 → 讯飞 Loomy 页签」是原入口，两者读同一份状态、同一份执行记录。
      </Note>
    </div>
  );
}

/**
 * Loomy 管理页：两块内容。
 * 1) 签到区（LoomyCheckinSection）：与「豆包管理」同款——客户端启停 + 每日赠送积分的执行状态、
 *    连续天数、14 天矩阵、执行记录（数据复用全网签到接口）。
 * 2) 反代区：把本机 Loomy 登录态的每日赠送积分以 OpenAI 兼容协议暴露给其他 agent。
 *    版式对齐 ZCode 管理的「反向代理」页：登录态 + 总开关 + 密钥 + 上游连通 + 接入方法 +
 *    高级设置 + 请求日志。界面不接触任何凭据明文（session 只在服务端读取），
 *    调用 Key 只在点「显示 / 复制」时取一次。
 */

/** 复制：优先 Clipboard API，file:// 等不安全上下文回落到 execCommand */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 回落到下面的 textarea 方案 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function CopyButton({
  text,
  label = '复制',
  beforeCopy,
}: {
  text: string;
  label?: string;
  beforeCopy?: () => Promise<string> | string;
}) {
  const toast = useToast();
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="subtle"
      onClick={async () => {
        let finalText = text;
        if (beforeCopy) {
          try {
            finalText = await beforeCopy();
          } catch {
            return;
          }
        }
        if (!finalText) return toast('err', '没有可复制的内容');
        const ok = await copyText(finalText);
        if (!ok) return toast('err', '复制失败，请手动选中复制');
        toast('ok', '已复制');
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      title="复制到剪贴板"
    >
      {done ? <IconCheck className="w-3.5 h-3.5" /> : <IconCopy className="w-3.5 h-3.5" />}
      {done ? '已复制' : label}
    </Button>
  );
}

/** 一行可复制的等宽文本 */
function CodeRow({ value, copyText: override, beforeCopy }: { value: string; copyText?: string; beforeCopy?: () => Promise<string> }) {
  return (
    <div className="flex items-center gap-2 rounded-xl bg-zinc-50 px-3 py-2">
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-700" title={value}>
        {value}
      </code>
      <div className="shrink-0">
        <CopyButton text={override ?? value} beforeCopy={beforeCopy} />
      </div>
    </div>
  );
}

export default function LoomyPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [data, setData] = useState<LoomyProxyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<LoomyUpstreamTestResponse | null>(null);
  /** 明文 Key：默认不下发，点「显示 / 复制」时单独取一次 */
  const [plainKey, setPlainKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  /** 高级设置草稿 */
  const [timeoutSec, setTimeoutSec] = useState('600');
  const [minIntervalMs, setMinIntervalMs] = useState('3000');
  const [savingAdvanced, setSavingAdvanced] = useState(false);
  /** 页签：每日积分 / 反向代理 */
  const [tab, setTab] = useState<LoomyTab>('checkin');

  const load = useCallback(async () => {
    try {
      const s = await loomyApi.status();
      setData(s);
      setTimeoutSec(String(Math.round((s.timeoutMs || 600_000) / 1000)));
      setMinIntervalMs(String(s.minIntervalMs ?? 3000));
    } catch (e: any) {
      toast('err', e?.message || '读取 Loomy 反向代理状态失败');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleEnabled = async (on: boolean) => {
    if (!data) return;
    setData((p) => (p ? { ...p, enabled: on } : p));
    try {
      await loomyApi.config({ enabled: on });
      toast('ok', on ? 'Loomy 反向代理已开启' : 'Loomy 反向代理已关闭');
      await load();
    } catch (e: any) {
      setData((p) => (p ? { ...p, enabled: !on } : p));
      toast('err', e?.message || '保存失败');
    }
  };

  const revealKey = async (): Promise<string> => {
    if (plainKey) return plainKey;
    const k = await loomyApi.revealKey();
    setPlainKey(k);
    return k;
  };

  const toggleShowKey = async () => {
    if (!showKey) {
      try {
        await revealKey();
      } catch (e: any) {
        toast('err', e?.message || '读取 Key 失败');
        return;
      }
    }
    setShowKey((v) => !v);
  };

  const regenerateKey = async () => {
    const ok = await confirm({
      title: '重新生成 Key',
      message: (
        <>
          重新生成后<span className="text-red-600 font-medium">旧 Key 立即失效</span>
          ，已接入的客户端需要同步更新 Key 才能继续调用。确定继续吗？
        </>
      ),
      confirmText: '重新生成',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await loomyApi.config({ regenerateKey: true });
      setPlainKey('');
      setShowKey(false);
      toast('ok', '已生成新的 Key，请同步更新各客户端的配置');
      await load();
    } catch (e: any) {
      toast('err', e?.message || '生成失败');
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await loomyApi.test();
      setTestResult(r);
      toast(r.ok ? 'ok' : 'err', r.ok ? '上游连通正常' : `上游连通失败：${r.error || '未知错误'}`);
    } catch (e: any) {
      toast('err', e?.message || '测试失败');
    } finally {
      setTesting(false);
    }
  };

  const saveAdvanced = async () => {
    const sec = Number(timeoutSec);
    const interval = Number(minIntervalMs);
    if (!Number.isFinite(sec) || sec < 10) return toast('err', '超时至少 10 秒');
    if (!Number.isFinite(interval) || interval < 0) return toast('err', '最小请求间隔不能小于 0 毫秒');
    setSavingAdvanced(true);
    try {
      await loomyApi.config({ timeoutMs: Math.round(sec * 1000), minIntervalMs: Math.round(interval) });
      toast('ok', '高级设置已保存');
      await load();
    } catch (e: any) {
      toast('err', e?.message || '保存失败');
    } finally {
      setSavingAdvanced(false);
    }
  };

  const models = data?.models || [];
  const modelHint = models[0]?.id || 'GLM-5.3-Flash';
  // 示例里绝不放真 Key：统一用 <你的Key> 占位
  const curlSample = `curl ${data?.endpoint || ''}/chat/completions \\\n  -H "Authorization: Bearer <你的Key>" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${modelHint}","messages":[{"role":"user","content":"hi"}]}'`;

  return (
    <div className="space-y-5">
      {/* 页签头：与 ZCode 管理同款（Segmented + 右侧说明） */}
      <Card className="p-3.5 flex flex-wrap items-center gap-x-4 gap-y-3">
        <Segmented<LoomyTab> value={tab} onChange={setTab} options={LOOMY_TABS} />
        <div className="flex items-center gap-2 text-xs text-zinc-400 min-w-0">
          {tab === 'checkin' && (
            <>
              <IconZap className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">每日赠送积分：客户端自动领取状态、连续天数与执行记录</span>
            </>
          )}
          {tab === 'proxy' && (
            <>
              <IconSwitch className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">OpenAI 兼容反代：让其他 agent 用 Loomy 免费积分</span>
            </>
          )}
        </div>
      </Card>

      {/* 每日积分（签到区）：与豆包管理同款（客户端启停 + 平台详情 + 执行记录） */}
      <div className={tab === 'checkin' ? '' : 'hidden'}>
        <LoomyCheckinSection />
      </div>

      {/* 反向代理区 */}
      <div className={tab === 'proxy' ? '' : 'hidden'}>
        {loading ? (
          <div className="space-y-4">
            <Skeleton className="h-24 w-full rounded-2xl" />
            <Skeleton className="h-40 w-full rounded-2xl" />
            <Skeleton className="h-40 w-full rounded-2xl" />
          </div>
        ) : !data ? (
          <EmptyState icon={<IconBox />} title="读取 Loomy 反向代理状态失败" desc="请确认本地服务正在运行" />
        ) : (
          <>
      {/* 请求统计 */}
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="累计请求" value={fmtNumber(data.stats.total)} icon={<IconSwitch />} tone="indigo" />
        <StatCard label="成功" value={fmtNumber(data.stats.ok)} accent="text-emerald-600" icon={<IconCheck />} tone="emerald" />
        <StatCard
          label="失败"
          value={fmtNumber(data.stats.failed)}
          accent={data.stats.failed ? 'text-red-600' : undefined}
          icon={<IconWarning />}
          tone="rose"
        />
      </div>

      {/* 总开关 + 端点 + 登录态 */}
      <Card className="p-5">
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-[280px] flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-zinc-900">Loomy 反向代理</h2>
              <Badge color={data.enabled ? 'green' : 'gray'} dot>
                {data.enabled ? '已开启' : '未开启'}
              </Badge>
              {data.credential.ok ? (
                <Badge color="blue">
                  正在使用 {data.credential.phoneMasked || data.credential.userid || '本机账号'} 的免费积分
                </Badge>
              ) : (
                <Badge color="amber">未读到 Loomy 登录态</Badge>
              )}
            </div>
            <p className="mt-1.5 text-xs leading-5 text-zinc-500">
              开启后，本机其他 agent（Cherry Studio、Cline、Roo Code 等 OpenAI 兼容客户端）把 base_url 指向下面的端点地址，
              就能用 Loomy 账号的每日赠送积分发请求；请求由控制台进程转发，需保持控制台运行。
            </p>
            <p className="mt-1.5 text-xs leading-5 text-zinc-400">上游说明：{data.upstream}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Switch checked={data.enabled} onChange={(v) => void toggleEnabled(v)} onText="已开启反向代理" offText="开启反向代理" />
            <Button size="sm" variant="subtle" onClick={() => void load()}>
              <IconRefresh className="w-3.5 h-3.5" />
              刷新
            </Button>
          </div>
        </div>

        {data.credential.changedRecently && (
          <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50/70 px-3 py-2 text-xs leading-relaxed text-emerald-700">
            检测到 Loomy 登录态变化：反代已自动跟随新账号
          </div>
        )}

        {!data.credential.ok && (
          <Note tone="amber" title="未读到 Loomy 登录态">
            {data.credential.error || '请先安装并登录 Loomy 桌面客户端，登录后本页会自动读取到登录态。'}
          </Note>
        )}

        <div className="mt-4">
          <div className="mb-1.5 text-xs font-medium text-zinc-600">端点地址（OpenAI 兼容 base_url）</div>
          <CodeRow value={data.endpoint} />
        </div>
        <Hint className="mt-3">
          代理只监听 <span className="font-mono">127.0.0.1</span>，局域网内其他机器访问不到；上游请求走本机 Loomy 登录态，界面与日志都不保存任何凭据明文。
        </Hint>
      </Card>

      {/* 登录态信息 */}
      <PageSection icon={<IconUser />} title="Loomy 登录态" desc="反代使用的凭据来源；换号或重新登录后自动跟随">
        <Card className="p-5">
          {data.credential.ok ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <div className="text-xs text-zinc-400">账号（手机号）</div>
                <div className="mt-1 font-mono text-sm text-zinc-700">{data.credential.phoneMasked || '—'}</div>
              </div>
              <div>
                <div className="text-xs text-zinc-400">用户 ID</div>
                <div className="mt-1 font-mono text-sm text-zinc-700">{data.credential.userid || '—'}</div>
              </div>
              <div>
                <div className="text-xs text-zinc-400">登录态更新时间</div>
                <div className="mt-1 text-sm text-zinc-700">{data.credential.updatedAt ? fmtDateTime(data.credential.updatedAt) : '—'}</div>
              </div>
              <div>
                <div className="text-xs text-zinc-400">凭据文件</div>
                <div className="mt-1 truncate font-mono text-xs text-zinc-500" title={data.credential.file || ''}>
                  {data.credential.file || '—'}
                </div>
              </div>
            </div>
          ) : (
            <div className="text-sm text-zinc-400">{data.credential.error || '未读到登录态'}</div>
          )}
        </Card>
      </PageSection>

      {/* 调用密钥 */}
      <PageSection icon={<IconKey />} title="调用密钥" desc="客户端用这个 Key 访问本机反代；明文只在点「显示 / 复制」时从本机服务取一次">
        <Card className="p-5">
          {data.apiKeySet ? (
            <>
              <div className="flex items-center gap-2 rounded-xl bg-zinc-50 px-3 py-2">
                <code className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-700" title={showKey && plainKey ? plainKey : undefined}>
                  {showKey && plainKey ? plainKey : 'sk-…••••••••••••'}
                </code>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button size="sm" variant="subtle" onClick={() => void toggleShowKey()}>
                  {showKey ? <IconEyeOff className="w-3.5 h-3.5" /> : <IconEye className="w-3.5 h-3.5" />}
                  {showKey ? '隐藏' : '显示'}
                </Button>
                <CopyButton text={plainKey} label="复制 Key" beforeCopy={revealKey} />
                <Button size="sm" variant="subtle" loading={busy} onClick={() => void regenerateKey()}>
                  <IconRefresh className="w-3.5 h-3.5" />
                  重新生成 Key
                </Button>
                <Hint className="flex-1">重新生成后旧 Key 立即失效，已配置过的客户端需要同步更新。</Hint>
              </div>
            </>
          ) : (
            <Note tone="amber" title="还没有调用 Key">
              先在上方开启反向代理，系统会自动生成调用 Key；生成后再回到这里查看或复制。
            </Note>
          )}
        </Card>
      </PageSection>

      {/* 上游连通 */}
      <PageSection
        icon={<IconZap />}
        title="上游连通"
        desc="用当前 Loomy 登录态向上游发一条真实请求，验证凭据与网络"
        actions={
          <Button size="sm" variant="subtle" loading={testing} onClick={() => void runTest()}>
            <IconZap className="w-3.5 h-3.5" />
            测试上游连通
          </Button>
        }
      >
        <Card className="p-5">
          {!testResult ? (
            <div className="text-sm text-zinc-400">{testing ? '正在测试，最长可能需要 90 秒…' : '还没测试过；一次测试最长可能需要 90 秒。'}</div>
          ) : testResult.ok ? (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 px-3.5 py-3 text-xs leading-relaxed text-emerald-800">
              <div className="font-medium">上游连通正常，回复：{testResult.reply || '（空回复）'}</div>
              <div className="mt-1 font-mono text-[11px] text-emerald-700">
                model：{testResult.model} · 耗时 {testResult.ms} ms
                {testResult.usage ? ` · usage：${JSON.stringify(testResult.usage)}` : ''}
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-red-200 bg-red-50/70 px-3.5 py-3 text-xs leading-relaxed text-red-700">
              <div className="font-medium">上游连通失败（HTTP {testResult.status || '—'}）</div>
              <div className="mt-1 break-all">{testResult.error || '未知错误'}</div>
            </div>
          )}
        </Card>
      </PageSection>

      {/* 接入方法 */}
      <PageSection icon={<IconSwitch />} title="接入方法" desc="OpenAI 兼容协议：把客户端的 base_url 与 api_key 指到本机反代即可">
        <Card className="p-5 space-y-4">
          <div className="grid gap-3 lg:grid-cols-2">
            <div>
              <div className="mb-1.5 text-xs font-medium text-zinc-600">base_url</div>
              <CodeRow value={data.endpoint} />
            </div>
            <div>
              <div className="mb-1.5 text-xs font-medium text-zinc-600">api_key（上面「调用密钥」里的 Key）</div>
              <CodeRow value={plainKey || '<你的Key>'} beforeCopy={revealKey} />
            </div>
          </div>

          <div>
            <div className="mb-1.5 text-xs font-medium text-zinc-600">model（可用模型，名称含倍率=积分消耗倍数；点旁边按钮复制模型名）</div>
            {models.length ? (
              <div className="flex flex-wrap gap-1.5">
                {models.map((m) => (
                  <span key={m.id} className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 bg-white px-2 py-1">
                    <code className="font-mono text-[11px] text-zinc-600">{m.id}</code>
                    <span className="text-[11px] text-zinc-400">{m.name !== m.id ? m.name : ''}</span>
                    <button
                      type="button"
                      onClick={async () => {
                        const ok = await copyText(m.id);
                        toast(ok ? 'ok' : 'err', ok ? '已复制' : '复制失败，请手动选中复制');
                      }}
                      className="p-0.5 text-zinc-400 hover:text-indigo-600 transition-colors"
                      title={`复制模型名 ${m.id}`}
                    >
                      <IconCopy className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <div className="text-sm text-zinc-400">暂未获取到模型列表</div>
            )}
          </div>

          <div>
            <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-zinc-600">
              curl 示例
              <div className="ml-auto">
                <CopyButton text={curlSample} label="复制示例" />
              </div>
            </div>
            <pre className="overflow-x-auto rounded-xl bg-zinc-900 px-4 py-3 font-mono text-[11px] leading-relaxed text-zinc-100">{curlSample}</pre>
            <Hint className="mt-2">
              示例中的 <span className="font-mono">&lt;你的Key&gt;</span> 请替换为上面「调用密钥」里的真实 Key；
              流式与非流式都可以直接用——反代内部统一走上游流式接口，非流式请求会在本机自动聚合成完整响应。
              注意：免费通道首字节延迟波动很大（实测 40–120 秒），请把客户端超时设够长，不要因超时频繁重试。
            </Hint>
          </div>
        </Card>
      </PageSection>

      {/* 高级设置 */}
      <PageSection icon={<IconSliders />} title="高级设置" desc="超时与节流参数，保存后立即生效">
        <Card className="p-5">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-zinc-600">响应超时（秒，≥10）</label>
              <input
                type="number"
                min={10}
                value={timeoutSec}
                onChange={(e) => setTimeoutSec(e.target.value)}
                className="h-9 w-32 px-3 rounded-xl border border-zinc-200 text-sm tabular-nums outline-none focus:border-indigo-400"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-zinc-600">最小请求间隔（毫秒，≥0）</label>
              <input
                type="number"
                min={0}
                value={minIntervalMs}
                onChange={(e) => setMinIntervalMs(e.target.value)}
                className="h-9 w-40 px-3 rounded-xl border border-zinc-200 text-sm tabular-nums outline-none focus:border-indigo-400"
              />
            </div>
            <Button variant="primary" loading={savingAdvanced} onClick={() => void saveAdvanced()}>
              保存
            </Button>
          </div>
          <Hint className="mt-3">
            超时用于非流式聚合的最长等待（流式请求由客户端自己控制）；最小请求间隔用于串行节流、降低上游风控压力，设为 0 表示不限制。
          </Hint>
        </Card>
      </PageSection>

      {/* 请求日志 */}
      <PageSection
        icon={<IconLoader />}
        title="请求日志"
        count={data.logs.length}
        desc="仅存于内存，不含任何消息正文"
        actions={
          <Button size="sm" variant="subtle" onClick={() => void load()}>
            <IconRefresh className="w-3.5 h-3.5" />
            刷新
          </Button>
        }
      >
        <Card className="overflow-hidden">
          {data.logs.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-zinc-400">还没有请求</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-100 text-left text-xs text-zinc-400">
                    <th className="px-4 py-2 font-medium">时间</th>
                    <th className="px-4 py-2 font-medium">模型</th>
                    <th className="px-4 py-2 font-medium">类型</th>
                    <th className="px-4 py-2 font-medium">耗时</th>
                    <th className="px-4 py-2 font-medium">结果</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-50">
                  {data.logs.map((l, i) => (
                    <tr key={`${l.at}-${i}`} className="hover:bg-zinc-50/60 transition-colors">
                      <td className="px-4 py-2 whitespace-nowrap text-xs text-zinc-500 tabular-nums">{fmtDateTime(l.at)}</td>
                      <td className="px-4 py-2 font-mono text-xs text-zinc-600">{l.model || '—'}</td>
                      <td className="px-4 py-2 text-xs text-zinc-500">{l.stream ? '流式' : '非流式'}</td>
                      <td className="px-4 py-2 text-xs text-zinc-500 tabular-nums">{l.ms} ms</td>
                      <td className="px-4 py-2">
                        {l.ok ? (
                          <Badge color="green">{l.status}</Badge>
                        ) : (
                          <span className="text-xs text-red-600" title={l.error || l.note}>
                            {l.error || l.note ? String(l.error || l.note).slice(0, 60) : `HTTP ${l.status}`}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          </Card>
        </PageSection>
          </>
        )}
      </div>
    </div>
  );
}
