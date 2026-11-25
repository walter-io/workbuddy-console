import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Hint,
  IconCheck,
  IconClock,
  IconCopy,
  IconDatabase,
  IconLayers,
  IconPower,
  IconRefresh,
  IconSettings,
  IconShield,
  IconSliders,
  IconZap,
  Note,
  PageSection,
  Skeleton,
  Spinner,
  Switch,
  useConfirm,
  useToast,
} from '../../components/ui';
import { zcodeApi } from '../../lib/zcode';
import type {
  ZCodeClientSettingKey,
  ZCodeSettingsResponse,
  ZCodeState,
  ZCodeUpstreamTestResponse,
} from '../../lib/zcode';
import { Row } from '../settings-shared';

/**
 * ZCode 设置页：运行状态与启停、客户端行为开关、凭据维护、数据/安装目录、最近工作区。
 *
 * 版式对齐「WorkBuddy 设置」（PageSection 分块 + Row 键值行 + Switch 开关行）；
 * WorkBuddy 的「每日签到与成长中心 / 登录态备份与恢复 / 目录权限」ZCode 没有对应接口，不放。
 * 客户端开关真实写回 ZCode setting.json（ZCode 客户端重启后生效），控制台不做额外缓存。
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

function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const toast = useToast();
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="subtle"
      onClick={async () => {
        if (!text) return toast('err', '没有可复制的内容');
        const ok = await copyText(text);
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

/** 等宽路径 + 复制按钮 */
function PathRow({ value }: { value: string }) {
  return (
    <div className="flex items-center gap-2 rounded-xl bg-zinc-50 px-3 py-2">
      <code className="min-w-0 flex-1 break-all font-mono text-xs text-zinc-700" title={value}>
        {value}
      </code>
      <div className="shrink-0">
        <CopyButton text={value} />
      </div>
    </div>
  );
}

/** 客户端开关定义：key 与服务端 writeZcodeClientSetting 的映射一一对应 */
const CLIENT_SWITCHES: { key: ZCodeClientSettingKey; label: string; desc: string }[] = [
  { key: 'closeToTray', label: '关闭到托盘', desc: '点关闭按钮时最小化到系统托盘，而不是直接退出 ZCode' },
  { key: 'keepAwakeWhileRunning', label: '运行时保持唤醒', desc: 'ZCode 运行期间阻止系统休眠，长任务不会被系统挂起' },
  { key: 'mobilePushEnabled', label: '手机推送', desc: '任务完成等事件推送到手机端，离开电脑也能收到通知' },
  { key: 'messageStreamShowReasoning', label: '显示思考过程', desc: '在对话消息流里展示模型的推理（reasoning）内容' },
  { key: 'autoDownloadUpdates', label: '自动更新', desc: '自动下载并安装 ZCode 客户端的新版本' },
];

/** 最近工作区条目结构未在类型里约束（unknown[]），做容错取值 */
function workspaceText(w: unknown): string {
  if (w == null) return '—';
  if (typeof w === 'string') return w;
  if (typeof w === 'object') {
    const o = w as Record<string, unknown>;
    const candidate = o.path || o.dir || o.name || o.label || o.title || o.workspace;
    if (typeof candidate === 'string' && candidate) return candidate;
    try {
      return JSON.stringify(w);
    } catch {
      return String(w);
    }
  }
  return String(w);
}

export default function ZCodeSettingsPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [info, setInfo] = useState<ZCodeSettingsResponse | null>(null);
  const [state, setState] = useState<ZCodeState | null>(null);
  const [loading, setLoading] = useState(true);
  const [launching, setLaunching] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ZCodeUpstreamTestResponse | null>(null);

  const load = useCallback(
    async (silent = false) => {
      try {
        const [s, st] = await Promise.all([zcodeApi.settings(), zcodeApi.state()]);
        setInfo(s);
        setState(st);
      } catch (e: any) {
        if (!silent) toast('err', e?.message || '读取 ZCode 设置失败');
      } finally {
        setLoading(false);
      }
    },
    [toast]
  );

  useEffect(() => {
    void load();
  }, [load]);

  const launchNow = async () => {
    setLaunching(true);
    try {
      const r = await zcodeApi.launch();
      toast('ok', r.already ? '已经在运行' : '已启动 ZCode');
      await load(true);
    } catch (e: any) {
      // 404：没找到 ZCode 安装位置（可先设置环境变量 ZCODE_INSTALL_DIR）
      toast('err', e?.message || '启动 ZCode 失败');
    } finally {
      setLaunching(false);
    }
  };

  const stopNow = async () => {
    const ok = await confirm({
      title: '退出 ZCode',
      message: (
        <>
          将结束全部 ZCode 进程，<span className="text-amber-600">正在进行的会话会被中断，请先保存工作。</span>
        </>
      ),
      confirmText: '退出',
      danger: true,
    });
    if (!ok) return;
    setStopping(true);
    try {
      const r = await zcodeApi.stop();
      if (!r.ok || (Number(r.remaining) || 0) > 0) {
        toast('err', r.error || `ZCode 仍有 ${Number(r.remaining) || 0} 个进程未退出`);
      } else {
        toast('ok', '已退出 ZCode');
      }
      await load(true);
    } catch (e: any) {
      toast('err', e?.message || '退出 ZCode 失败');
    } finally {
      setStopping(false);
    }
  };

  /** 客户端开关：乐观更新 + 失败回滚；成功提示重启 ZCode 后生效并重新拉取 */
  const toggleClientSetting = async (key: ZCodeClientSettingKey, next: boolean) => {
    if (!info) return;
    const prev = !!info.settings[key];
    setInfo((p) => (p ? { ...p, settings: { ...p.settings, [key]: next } } : p));
    try {
      await zcodeApi.clientSetting(key, next);
      toast('ok', '已保存，重启 ZCode 后生效');
      await load(true);
    } catch (e: any) {
      setInfo((p) => (p ? { ...p, settings: { ...p.settings, [key]: prev } } : p));
      toast('err', e?.message || '保存失败');
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await zcodeApi.upstreamTest();
      setTestResult(r);
      toast(r.ok ? 'ok' : 'err', r.ok ? '登录态有效，上游连通正常' : `验证失败：${r.error || '未知错误'}`);
    } catch (e: any) {
      toast('err', e?.message || '验证失败');
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4 max-w-4xl">
        <Skeleton className="h-32 w-full rounded-2xl" />
        <Skeleton className="h-56 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    );
  }
  if (!info) return <EmptyState icon={<IconSettings />} title="读取 ZCode 设置失败" desc="请确认本地服务正在运行" />;

  const proc = info.process ?? state?.process;
  const running = !!proc?.running;
  const processCount = proc?.pids?.length || 0;
  const clientVersion = info.clientVersion ?? state?.clientVersion ?? null;
  const workspaces = info.settings.recentWorkspaces || [];

  return (
    <div className="space-y-6 max-w-4xl">
      {/* ZCode 运行状态 */}
      <PageSection icon={<IconPower />} title="ZCode 运行状态" desc="客户端进程、版本与可执行文件位置">
        <Card className="p-5">
          <div
            className={`rounded-xl border px-3.5 py-3 ${
              running ? 'border-emerald-200 bg-emerald-50/60' : 'border-zinc-200 bg-zinc-50/70'
            }`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge color={running ? 'green' : 'gray'} dot>
                {running ? '运行中' : '未运行'}
              </Badge>
              {running && <span className="text-xs text-zinc-400">{processCount} 个进程</span>}
              {clientVersion && <Badge color="gray">客户端版本 {clientVersion}</Badge>}
            </div>
            <div className="mt-2 space-y-0.5 text-xs text-zinc-500 leading-relaxed">
              <div className="break-all">
                可执行文件：<span className="font-mono">{state?.exe || '未找到安装位置'}</span>
              </div>
              {proc?.error && <div className="text-amber-600">无法确认运行状态：{proc.error}</div>}
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="primary" loading={launching} onClick={() => void launchNow()}>
              <IconPower className="w-4 h-4" />
              启动 ZCode
            </Button>
            <Button
              variant="danger"
              loading={stopping}
              disabled={!running}
              onClick={() => void stopNow()}
              title={running ? '结束全部 ZCode 进程' : '当前未检测到运行中的 ZCode'}
            >
              <IconPower className="w-4 h-4" />
              退出 ZCode
            </Button>
            <Button variant="subtle" onClick={() => void load()}>
              <IconRefresh className="w-4 h-4" />
              刷新
            </Button>
            <span className="text-xs text-zinc-400">启动要求已定位到 ZCode 安装位置；退出前请先保存客户端里的工作。</span>
          </div>
        </Card>
      </PageSection>

      {/* 客户端开关 */}
      <PageSection icon={<IconSliders />} title="客户端开关" desc="直接写回 ZCode setting.json；ZCode 客户端重启后生效">
        <Card className="p-5">
          <div className="divide-y divide-zinc-100 -mx-4 mb-3">
            <Row label="语言（locale）" desc="ZCode 界面语言，只读展示；如需修改请在 ZCode 客户端里设置">
              <Badge color="gray">{info.settings.locale || '未设置'}</Badge>
            </Row>
            {CLIENT_SWITCHES.map((sw) => (
              <Row key={sw.key} label={sw.label} desc={sw.desc}>
                <Switch checked={!!info.settings[sw.key]} onChange={(v) => void toggleClientSetting(sw.key, v)} />
              </Row>
            ))}
          </div>
          <Hint>切换即保存到 ZCode 的 setting.json；正在运行的 ZCode 需要重启后才会读取新值。</Hint>
        </Card>
      </PageSection>

      {/* 凭据维护 */}
      <PageSection
        icon={<IconShield />}
        title="凭据维护"
        desc="ZCode 登录态的来源、可读性与监视状态"
        actions={
          <Button size="sm" variant="subtle" loading={testing} onClick={() => void runTest()}>
            <IconZap className="w-3.5 h-3.5" />
            验证登录态
          </Button>
        }
      >
        <Card className="p-5">
          {!state ? (
            <div className="py-6 flex justify-center">
              <Spinner />
            </div>
          ) : (
            <>
              <div className="divide-y divide-zinc-100 -mx-4 mb-3">
                <Row label="凭据来源" desc="ZCode 记录的登录凭据来源标识">
                  <span className="font-mono text-xs text-zinc-600">{info.credentialSource || '未知'}</span>
                </Row>
                <Row label="登录态文件" desc="ZCode 客户端写入的登录凭据文件">
                  <code className="break-all font-mono text-xs text-zinc-600">{info.credentialsFile}</code>
                </Row>
                <Row label="凭据可读" desc="控制台能否正常读取并解密本机 ZCode 登录态">
                  <Badge color={state.credentialOk ? 'green' : 'red'} dot>
                    {state.credentialOk ? '可正常读取' : '读取失败'}
                  </Badge>
                </Row>
              </div>

              <div>
                <div className="mb-1.5 text-xs font-medium text-zinc-600">凭据监视</div>
                {info.credentialState ? (
                  <pre className="overflow-x-auto rounded-xl bg-zinc-50 px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-600">
                    {JSON.stringify(info.credentialState, null, 2)}
                  </pre>
                ) : (
                  <div className="text-xs text-zinc-400">监视器尚未上报状态</div>
                )}
                <Hint className="mt-1.5">凭据监视器发现 ZCode 登录态变化（换号 / 重新登录）时，反向代理会自动跟随新账号。</Hint>
              </div>

              {testResult && (
                <div className="mt-3">
                  {testResult.ok ? (
                    <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 px-3.5 py-3 text-xs leading-relaxed text-emerald-800">
                      <div className="font-medium">上游连通正常，回复：{testResult.reply || '（空回复）'}</div>
                      {testResult.usage && (
                        <div className="mt-1.5 font-mono text-[11px] text-emerald-700">usage：{JSON.stringify(testResult.usage)}</div>
                      )}
                    </div>
                  ) : (
                    <div className="rounded-xl border border-red-200 bg-red-50/70 px-3.5 py-3 text-xs leading-relaxed text-red-700">
                      <div className="font-medium">登录态验证失败（HTTP {testResult.status || '—'}）</div>
                      <div className="mt-1 break-all">{testResult.error || '未知错误'}</div>
                      {testResult.hint && <div className="mt-1.5 text-amber-700">{testResult.hint}</div>}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </Card>
      </PageSection>

      {/* ZCode 数据目录 */}
      <PageSection icon={<IconDatabase />} title="ZCode 数据目录" desc="登录态与 setting.json 等数据所在目录">
        <Card className="p-5">
          <PathRow value={info.dataDir} />
        </Card>
      </PageSection>

      {/* ZCode 安装目录 */}
      <PageSection icon={<IconLayers />} title="ZCode 安装目录" desc="启动 / 退出 ZCode 客户端时用来定位 ZCode.exe">
        <Card className="p-5">
          {info.installDir ? (
            <PathRow value={info.installDir} />
          ) : (
            <Note tone="amber" title="未找到安装位置">
              可设置环境变量 <span className="font-mono">ZCODE_INSTALL_DIR</span> 指向 ZCode 安装目录，然后重启控制台再试。
            </Note>
          )}
        </Card>
      </PageSection>

      {/* 最近工作区（空则不显示该块） */}
      {workspaces.length > 0 && (
        <PageSection icon={<IconClock />} title="最近工作区" count={workspaces.length} desc="ZCode 最近打开的项目（只读）">
          <Card className="divide-y divide-zinc-100">
            {workspaces.map((w, i) => (
              <div key={i} className="px-4 py-2.5 font-mono text-xs text-zinc-600 break-all">
                {workspaceText(w)}
              </div>
            ))}
          </Card>
        </PageSection>
      )}
    </div>
  );
}
