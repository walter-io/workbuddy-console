import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  IconChevronDown,
  IconClock,
  IconDatabase,
  IconLayers,
  IconPower,
  IconRefresh,
  IconShield,
  IconTrash,
  PageSection,
  Switch,
  Spinner,
  useConfirm,
  useToast,
} from '../components/ui';
import { del, get, post, put, TIMEOUT } from '../lib/api';
import { emitSettingsChanged } from '../lib/appSettings';
import type {
  AccountRefreshResponse,
  AccountRefreshRunResponse,
  BackupEntry,
  BackupsResponse,
  CheckinAllResult,
  CheckinState,
  CheckinStatusResponse,
  DetectResult,
  LoadedInfo,
  PermissionCheck,
  PermissionResponse,
  SettingsInfo,
} from '../lib/types';
import { fmtDateTime, fmtRelative } from '../lib/format';
import { MarkerBadge, Row } from './settings-shared';

function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 剩余小时数 → 人话；null（账号里没有该有效期字段）与"已过期"必须区分 */
function fmtHours(h: number | null | undefined): string {
  if (h == null || !Number.isFinite(h)) return '未知';
  if (h <= 0) return '已过期';
  if (h < 48) return `${h.toFixed(1)} 小时`;
  return `${(h / 24).toFixed(1)} 天`;
}

/** 凭据刷新的判定原因 → 中文（与服务端 tokenRefresh.mjs 的 reason 一一对应） */
const REFRESH_REASON_TEXT: Record<string, string> = {
  ok: '有效期充足',
  'access-expiring': 'access 即将过期',
  'refresh-expiring': 'refresh 即将过期',
  dead: 'refresh 已过期，需重新登录',
  'unknown-expiry': '未记录有效期，暂不处理',
  'no-refresh-token': '无 refresh_token，需重新扫码',
  manual: '手动刷新',
  current: '当前登录账号（由 WorkBuddy 自行续期，不自动刷新）',
  'failed-cooldown': '上次刷新失败，已暂停自动重试',
  'verified-valid': '服务端确认有效',
  'verify-failed': '验活请求失败（网络）',
  'invalid-no-refresh': '服务端已拒绝，且无 refresh_token 可续期',
  'current-invalid': '当前登录账号已被服务端拒绝',
};

/**
 * WorkBuddy 专属设置：运行状态与重启、每日签到与成长中心、账号凭据维护、
 * 数据/安装目录、权限自检、登录态备份恢复。
 *
 * 从「设置」页拆出来收进 WorkBuddy 管理——控制台是多平台工具后，这些只和
 * WorkBuddy 有关的项目跟着 WorkBuddy 走；「设置」页只留通用项。
 * 各区块的状态与加载逻辑自成一组，与「设置」页互不耦合（两边各自拉取
 * /api/settings，改的是同一个文件的不同字段，互不干扰）。
 */
export default function WorkBuddySettingsPage() {
  const toast = useToast();
  const confirm = useConfirm();

  const [settings, setSettings] = useState<SettingsInfo | null>(null);
  const [wbDir, setWbDir] = useState('');
  const [savingDir, setSavingDir] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [showManual, setShowManual] = useState(false);
  /** 客户端安装目录（跟数据目录是两回事：切换账号后「自动重新打开」要靠它定位 exe） */
  const [exeDir, setExeDir] = useState('');
  const [savingExeDir, setSavingExeDir] = useState(false);

  /* ---------------- WorkBuddy 运行状态 ---------------- */
  const [status, setStatus] = useState<LoadedInfo | null>(null);
  const [restarting, setRestarting] = useState(false);

  /* ---------------- 签到 ---------------- */
  const [checkin, setCheckin] = useState<CheckinStatusResponse | null>(null);
  const [checkinLoading, setCheckinLoading] = useState(false);
  const [checkingIn, setCheckingIn] = useState(false);
  /** 单账号领取的 busy（按账号 id 区分，避免全部行一起转圈） */
  const [checkingInId, setCheckingInId] = useState<string | null>(null);

  /* ---------------- 凭据自动刷新 ---------------- */
  const [refreshInfo, setRefreshInfo] = useState<AccountRefreshResponse | null>(null);
  const [refreshingTokens, setRefreshingTokens] = useState(false);

  /* ---------------- 权限自检 ---------------- */
  const [perm, setPerm] = useState<PermissionResponse | null>(null);
  const [permLoading, setPermLoading] = useState(false);

  /* ---------------- 备份 ---------------- */
  const [backups, setBackups] = useState<BackupsResponse | null>(null);
  const [backupBusy, setBackupBusy] = useState<string | null>(null);

  const loadSettings = useCallback(() => {
    get<SettingsInfo>('/api/settings')
      .then((r) => {
        setSettings(r);
        setWbDir(r.workbuddyDir || '');
        setExeDir(r.workbuddyInstallDir || '');
      })
      .catch((e) => toast('err', e.message));
  }, [toast]);

  const loadStatus = useCallback(() => {
    get<LoadedInfo>('/api/workbuddy/status')
      .then(setStatus)
      .catch(() => {});
  }, []);

  const loadCheckin = useCallback(
    async (silent = false) => {
      if (!silent) setCheckinLoading(true);
      try {
        setCheckin(await get<CheckinStatusResponse>('/api/workbuddy/checkin/status'));
      } catch (e: any) {
        if (!silent) toast('err', e?.message || '签到状态查询失败');
      } finally {
        setCheckinLoading(false);
      }
    },
    [toast]
  );

  const loadRefreshInfo = useCallback(async () => {
    try {
      setRefreshInfo(await get<AccountRefreshResponse>('/api/accounts/refresh'));
    } catch {
      /* 凭据状态查询失败不打扰用户，列表留空即可 */
    }
  }, []);

  const loadPerm = useCallback(
    async (silent = false) => {
      if (!silent) setPermLoading(true);
      try {
        setPerm(await get<PermissionResponse>('/api/workbuddy/permissions'));
      } catch (e: any) {
        if (!silent) toast('err', e?.message || '权限自检失败');
      } finally {
        setPermLoading(false);
      }
    },
    [toast]
  );

  const loadBackups = useCallback(async () => {
    try {
      setBackups(await get<BackupsResponse>('/api/workbuddy/backups'));
    } catch {
      /* 备份目录不存在时接口返回空列表，这里静默 */
    }
  }, []);

  useEffect(() => {
    loadSettings();
    loadStatus();
    loadBackups();
    void loadPerm(true);
    void loadCheckin(true);
    void loadRefreshInfo();
    // 「运行状态」卡不能只在挂载拉一次：页面常驻挂载，切回来显示的是旧快照。
    // 跟 30s 一次（与顶栏 chip 同节奏），页面不可见时暂停
    let timer: number | undefined;
    const tick = () => {
      if (!document.hidden) loadStatus();
      timer = window.setTimeout(tick, 30_000);
    };
    timer = window.setTimeout(tick, 30_000);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [loadSettings, loadStatus, loadBackups, loadPerm, loadCheckin, loadRefreshInfo]);

  /** 重新检测数据目录与运行状态 */
  const redetect = useCallback(
    async (silent = false) => {
      setDetecting(true);
      try {
        const r = await get<DetectResult>('/api/workbuddy/detect');
        setSettings((prev) => (prev ? { ...prev, detected: r.detected } : prev));
        loadStatus();
        if (!silent) {
          if (r.detected.valid) toast('ok', `已检测到 WorkBuddy 数据目录：${r.detected.dir}`);
          else toast('err', '未检测到 WorkBuddy 数据目录，请确认已安装并运行过 WorkBuddy，或手动指定');
          if (!r.running && r.detectError) toast('err', `无法确认 WorkBuddy 运行状态：${r.detectError}`);
        }
      } catch (e: any) {
        if (!silent) toast('err', e?.message || '检测失败');
      } finally {
        setDetecting(false);
      }
    },
    [loadStatus, toast]
  );

  const saveDir = async (dir: string) => {
    setSavingDir(true);
    try {
      const r = await put<{ workbuddyDir: string; detected: SettingsInfo['detected'] }>('/api/settings', { workbuddyDir: dir }, { timeoutMs: TIMEOUT.write });
      setSettings((prev) => (prev ? { ...prev, workbuddyDir: r.workbuddyDir, detected: r.detected } : prev));
      setWbDir(r.workbuddyDir);
      if (r.detected.valid) {
        setShowManual(false);
        toast('ok', `已保存，检测到 WorkBuddy 数据：${r.detected.dir}`);
      } else {
        toast('err', '已保存，但该目录未检测到 WorkBuddy 数据特征（models.json / 会话日志等）');
      }
    } catch (e: any) {
      toast('err', e?.message || '保存失败');
    } finally {
      setSavingDir(false);
    }
  };

  /**
   * 保存客户端安装目录。
   *
   * 保存后服务端会立刻按该目录重新定位 exe 并回传结果——
   * 用户填错目录时当场就知道，而不是等切完账号才看到「未能定位可执行文件」。
   */
  const saveExeDir = async (dir: string) => {
    setSavingExeDir(true);
    try {
      const r = await put<{ workbuddyInstallDir: string; detectedExe: string | null }>(
        '/api/settings',
        { workbuddyInstallDir: dir },
        { timeoutMs: TIMEOUT.write }
      );
      setSettings((prev) => (prev ? { ...prev, workbuddyInstallDir: r.workbuddyInstallDir, detectedExe: r.detectedExe } : prev));
      setExeDir(r.workbuddyInstallDir);
      if (dir.trim() && !r.detectedExe) {
        toast('err', '该目录下没找到 WorkBuddy.exe，请选到 exe 所在的那一层目录');
      } else if (r.detectedExe) {
        toast('ok', `已定位到客户端：${r.detectedExe}`);
      } else {
        toast('ok', '已清空，恢复自动定位');
      }
    } catch (e: any) {
      toast('err', e?.message || '保存失败');
    } finally {
      setSavingExeDir(false);
    }
  };

  const toggleAutoCheckin = async (next: boolean) => {
    const prev = !!settings?.autoCheckin;
    // 乐观更新：勾选立即响应，失败再回滚（否则要等一次本机请求往返，点上去像没反应）
    setSettings((p) => (p ? { ...p, autoCheckin: next } : p));
    try {
      const r = await put<{ autoCheckin: boolean }>('/api/settings', { autoCheckin: next }, { timeoutMs: TIMEOUT.write });
      setSettings((p) => (p ? { ...p, autoCheckin: r.autoCheckin } : p));
      toast('ok', r.autoCheckin ? '已开启自动领取：服务端每小时巡检一次，自动补签并领取成长中心奖励' : '已关闭自动领取');
    } catch (e: any) {
      setSettings((p) => (p ? { ...p, autoCheckin: prev } : p));
      toast('err', e?.message || '保存失败');
    }
  };

  /** 其余布尔设置项的统一开关：与自动签到同一套「乐观更新 + 失败回滚」交互 */
  const toggleBoolSetting = async (key: 'autoRefreshToken', next: boolean, hint: { on: string; off: string }) => {
    if (!settings) return;
    const prev = !!settings[key];
    setSettings((p) => (p ? { ...p, [key]: next } : p));
    try {
      const r = await put<Partial<SettingsInfo>>('/api/settings', { [key]: next }, { timeoutMs: TIMEOUT.write });
      setSettings((p) => (p ? { ...p, [key]: !!r[key] } : p));
      // 常驻挂载的其它页面不会因为"切回来"重新取数：把变更广播出去（如免费模型页的平台列表）
      emitSettingsChanged({ [key]: !!r[key] });
      toast('ok', next ? hint.on : hint.off);
    } catch (e: any) {
      setSettings((p) => (p ? { ...p, [key]: prev } : p));
      toast('err', e?.message || '保存失败');
    }
  };

  const runCheckin = async (accountId?: string) => {
    // 按账号 id 记 busy：此前共用一个 checkingIn，任一行领取时全部行一起转圈
    if (accountId) {
      setCheckingInId(accountId);
    } else {
      setCheckingIn(true);
    }
    try {
      if (accountId) {
        const r = await post<{ ok: boolean; action: string; message: string; growth?: { report: string } }>(
          '/api/workbuddy/checkin',
          { accountId },
          { timeoutMs: TIMEOUT.write }
        );
        toast(r.ok ? 'ok' : 'err', r.growth?.report ? `${r.message}；${r.growth.report}` : r.message);
      } else {
        const r = await post<CheckinAllResult>('/api/workbuddy/checkin', { onlyPending: true }, { timeoutMs: TIMEOUT.quota });
        const { summary } = r;
        const parts = [`新签到 ${summary.checked} 个`];
        if (summary.already) parts.push(`已签到 ${summary.already} 个`);
        if (summary.skipped) parts.push(`跳过 ${summary.skipped} 个`);
        if (summary.failed) parts.push(`失败 ${summary.failed} 个`);
        if (summary.growthCredits) parts.push(`成长中心 +${summary.growthCredits} 积分`);
        toast(summary.failed || summary.growthHardFailures ? 'err' : 'ok', `领取完成：${parts.join('，')}`);
      }
      await loadCheckin(true);
    } catch (e: any) {
      toast('err', e?.message || '领取失败');
    } finally {
      if (accountId) setCheckingInId(null);
      else setCheckingIn(false);
    }
  };

  /**
   * 手动「检查并刷新」：不带 force —— 只刷新已经临期的账号。
   * 不做「点一下全部重刷」，是因为刷新可能轮换 refresh_token，无谓的刷新反而会与
   * WorkBuddy 自己持有的那一份互相踩到（详见 server/workbuddy/tokenRefresh.mjs 的说明）。
   */
  const runTokenRefresh = async () => {
    setRefreshingTokens(true);
    try {
      const r = await post<AccountRefreshRunResponse>('/api/accounts/refresh', {}, { timeoutMs: TIMEOUT.quota });
      const { summary } = r;
      const failed = r.results.find((x) => x.action === 'failed');
      const dead = r.results.filter((x) => x.action === 'dead');
      if (summary.refreshed) {
        toast('ok', `已刷新 ${summary.refreshed} 个临期账号${summary.failed ? `，${summary.failed} 个失败` : ''}`);
      } else if (summary.failed) {
        toast('err', `刷新失败：${failed?.message || '未知原因'}`);
      } else if (dead.length) {
        toast('info', `${dead.length} 个账号需重新登录：${dead.map((d) => d.accountName).join('、')}`);
      } else {
        toast('ok', '所有账号的有效期都还很充足，未做任何刷新');
      }
      await loadRefreshInfo();
    } catch (e: any) {
      toast('err', e?.message || '刷新失败');
    } finally {
      setRefreshingTokens(false);
    }
  };

  const restartWb = async () => {
    const ok = await confirm({
      title: '重启 WorkBuddy',
      message: (
        <>
          将强制结束当前 WorkBuddy 进程并重新启动，使 <span className="font-mono text-xs">models.json</span> 的最新配置生效。
          <br />
          <span className="text-amber-600">正在进行的对话会被中断，请先保存工作。</span>
        </>
      ),
      confirmText: '重启',
      danger: true,
    });
    if (!ok) return;
    setRestarting(true);
    try {
      const r = await post<{ restarted: boolean; exePath?: string }>('/api/workbuddy/restart', undefined, { timeoutMs: TIMEOUT.write });
      toast('ok', `WorkBuddy 已重启${r.exePath ? `（${r.exePath}）` : ''}`);
      setTimeout(loadStatus, 2500);
    } catch (e: any) {
      toast('err', e?.message || '重启失败');
    } finally {
      setRestarting(false);
    }
  };

  const restoreBackup = async (b: BackupEntry) => {
    const ok = await confirm({
      title: '恢复登录态备份',
      message: (
        <>
          将用备份 <b className="text-zinc-800">{new Date(b.createdAt).toLocaleString('zh-CN')}</b>（{b.variantLabel}）
          覆盖当前的 {b.variantLabel}登录态文件。
          <br />
          覆盖前会自动再备份一次当前文件，可再次回退。若 WorkBuddy 正在运行，恢复后需重启它才会读取新登录态。
        </>
      ),
      confirmText: '恢复',
      danger: true,
    });
    if (!ok) return;
    setBackupBusy(b.name);
    try {
      // 服务端写登录态文件带约 3 分钟重试窗口，前端必须比它更能等
      const r = await post<{ authFilePath: string; safetyBackup: string | null }>(
        '/api/workbuddy/backups/restore',
        { name: b.name },
        { timeoutMs: TIMEOUT.switch }
      );
      toast('ok', `已恢复登录态到 ${r.authFilePath}${r.safetyBackup ? '（原文件已另存备份）' : ''}`);
      await loadBackups();
      await loadPerm(true);
    } catch (e: any) {
      toast('err', e?.message || '恢复失败');
    } finally {
      setBackupBusy(null);
    }
  };

  const removeBackup = async (b: BackupEntry) => {
    const ok = await confirm({
      title: '删除备份',
      message: <>确定删除备份 <b className="text-zinc-800">{new Date(b.createdAt).toLocaleString('zh-CN')}</b> 吗？删除后无法恢复。</>,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    setBackupBusy(b.name);
    try {
      await del(`/api/workbuddy/backups/${encodeURIComponent(b.name)}`);
      toast('ok', '备份已删除');
      await loadBackups();
    } catch (e: any) {
      toast('err', e?.message || '删除失败');
    } finally {
      setBackupBusy(null);
    }
  };

  const cleanBackups = async () => {
    const keep = 10;
    const ok = await confirm({
      title: '清理旧备份',
      message: <>将只保留最近 <b className="text-zinc-800">{keep}</b> 份备份，更早的全部删除。删除后无法恢复。</>,
      confirmText: '清理',
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await post<{ removed: number; keep: number }>('/api/workbuddy/backups/clean', { keep });
      toast('ok', r.removed ? `已清理 ${r.removed} 份旧备份，保留最近 ${r.keep} 份` : '没有需要清理的备份');
      await loadBackups();
    } catch (e: any) {
      toast('err', e?.message || '清理失败');
    }
  };

  // 权限项按分组聚合展示
  const permGroups = useMemo(() => {
    const map = new Map<string, PermissionCheck[]>();
    for (const item of perm?.items || []) {
      if (!map.has(item.group)) map.set(item.group, []);
      map.get(item.group)!.push(item);
    }
    return [...map.entries()];
  }, [perm]);

  const cnStates: CheckinState[] = checkin?.states || [];

  return (
    <div className="space-y-6 max-w-4xl">
      {/* WorkBuddy 运行状态 */}
      <PageSection
        icon={<IconPower />}
        title="WorkBuddy 运行状态"
        desc="模型配置是否已生效、进程是否可以重启"
        actions={
          <Button size="sm" variant="subtle" loading={detecting} onClick={() => redetect(false)}>
            <IconRefresh className="w-3.5 h-3.5" />
            重新检测
          </Button>
        }
      >
        <Card className="p-5">
          {!status ? (
            <div className="py-6 flex justify-center">
              <Spinner />
            </div>
          ) : (
            <>
              <div
                className={`rounded-xl border px-3.5 py-3 ${
                  status.pendingRestart ? 'border-amber-200 bg-amber-50/70' : status.running ? 'border-emerald-200 bg-emerald-50/60' : 'border-zinc-200 bg-zinc-50/70'
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge color={status.running ? 'green' : status.detectError ? 'amber' : 'gray'} dot>
                    {status.running ? '运行中' : status.detectError ? '状态未知' : '未运行'}
                  </Badge>
                  {status.pendingRestart && <Badge color="amber">配置待重启生效</Badge>}
                  {status.processCount ? <span className="text-xs text-zinc-400">{status.processCount} 个进程</span> : null}
                  {status.detectMethod && <span className="text-xs text-zinc-300">探测方式：{status.detectMethod}</span>}
                </div>
                <div className="mt-2 space-y-0.5 text-xs text-zinc-500 leading-relaxed">
                  {status.exePath && (
                    <div className="break-all">
                      可执行文件：<span className="font-mono">{status.exePath}</span>
                    </div>
                  )}
                  {status.dir && (
                    <div className="break-all">
                      数据目录：<span className="font-mono">{status.dir}</span>
                    </div>
                  )}
                  {status.modelsJsonMtime ? <div>models.json 最后修改：{fmtDateTime(status.modelsJsonMtime)}</div> : null}
                  {status.detectError && <div className="text-amber-600">无法确认运行状态：{status.detectError}</div>}
                  {status.detectWarning && <div className="text-amber-600">{status.detectWarning}</div>}
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button variant="subtle" loading={restarting} disabled={!status.running} onClick={restartWb} title={status.running ? '结束进程并重新启动' : '当前未检测到运行中的 WorkBuddy'}>
                  <IconPower className="w-4 h-4" />
                  重启 WorkBuddy
                </Button>
                <span className="text-xs text-zinc-400">
                  在 WorkBuddy 运行期间载入的模型需要重启才会生效；工具已自动备份登录态，重启不影响账号。
                </span>
              </div>
            </>
          )}
        </Card>
      </PageSection>

      {/* 每日签到与成长中心 */}
      <PageSection
        icon={<IconClock />}
        title="每日签到与成长中心"
        count={cnStates.length ? `${cnStates.filter((s) => s.todayCheckedIn).length}/${cnStates.length} 今日已签` : undefined}
        desc="签到积分之外，成长中心的旅行礼物、任务、补登、连登兑换、盲盒、Buddy 也一并代领；自动巡检默认开启"
        actions={
          <>
            <Button size="sm" variant="subtle" loading={checkinLoading} onClick={() => loadCheckin(false)}>
              <IconRefresh className="w-3.5 h-3.5" />
              刷新状态
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={checkingIn}
              disabled={!cnStates.length}
              onClick={() => runCheckin()}
              title="签到 + 领取成长中心全部可领奖励（旅行礼物/派 Buddy/任务/断登补签/连登兑换/开盲盒/Buddy 盲盒）"
            >
              一键领取
            </Button>
          </>
        }
      >
        <Card className="p-5">
          <div className="divide-y divide-zinc-100 -mx-4 mb-3">
            <Row
              label={
                <span className="flex flex-wrap items-center gap-2">
                  自动领取（签到 + 成长中心）
                  <Badge color={settings?.autoCheckin ? 'green' : 'gray'}>
                    {settings?.autoCheckin ? '已开启（默认）' : '已关闭'}
                  </Badge>
                </span>
              }
              desc={
                <>
                  <b className="text-zinc-600">默认为开启</b>
                  ，服务端每小时巡检一次（06:00–23:00），发现当日未签到会自动补签，并顺带领取成长中心的
                  <b className="text-zinc-600">旅行礼物、派 Buddy、任务奖励、断登补签（消耗补登卡）、连登兑换、开盲盒、Buddy 盲盒</b>
                  （只对国内版账号生效；各接口幂等或由服务端兜底，重复执行无副作用；补登卡每轮最多用 1 张、盲盒每轮最多开 1 次）。
                  巡检依赖控制台处于运行状态：桌面版关闭窗口后会驻留系统托盘，领取不会中断。
                  <br />
                  不需要自动领取可在此关闭；关闭后仍可随时点右上角「一键领取」或单账号「领取」手动执行。
                </>
              }
            >
              <Switch
                checked={!!settings?.autoCheckin}
                onChange={(v) => toggleAutoCheckin(v)}
                onText="已开启自动巡检"
                offText="已关闭自动巡检"
              />
            </Row>
          </div>

          {!cnStates.length ? (
            <div className="text-sm text-zinc-400 py-3">暂无国内版账号。签到需要账号具备明文凭据（WorkBuddy 登录后导入）。</div>
          ) : (
            <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200/80">
              {cnStates.map((s) => (
                <div key={s.account.id} className="flex flex-wrap items-center gap-2 px-3.5 py-2.5">
                  <div className="min-w-0">
                    <div className="text-sm text-zinc-800 truncate max-w-64">{s.account.name}</div>
                    <div className="text-xs text-zinc-400">
                      {s.ok ? (s.todayCheckedIn ? '今日已签到' : '今日未签到') : s.error || '状态未知'}
                    </div>
                  </div>
                  <div className="ml-auto flex items-center gap-1.5">
                    {s.ok ? (
                      s.todayCheckedIn ? (
                        <Badge color="green">已签到</Badge>
                      ) : (
                        <Badge color="amber">待签到</Badge>
                      )
                    ) : (
                      <Badge color="gray">{s.unsupported ? '不支持' : '查询失败'}</Badge>
                    )}
                    <Button
                      size="sm"
                      variant="subtle"
                      loading={checkingInId === s.account.id}
                      disabled={!s.ok || (!!checkingInId && checkingInId !== s.account.id)}
                      onClick={() => runCheckin(s.account.id)}
                      title="签到（未签时）+ 领取成长中心全部可领奖励"
                    >
                      领取
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {!!checkin?.logs?.length && (
            <div className="mt-4">
              <div className="text-xs text-zinc-400 mb-1.5">最近领取记录（含成长中心）</div>
              <div className="max-h-48 overflow-y-auto rounded-xl border border-zinc-100 divide-y divide-zinc-50">
                {checkin.logs.map((l, i) => (
                  <div key={`${l.ts}-${i}`} className="px-3 py-1.5 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-zinc-400 tabular-nums">{fmtDateTime(l.ts)}</span>
                      <span className="text-zinc-600 truncate max-w-40">{l.accountName}</span>
                      <span className={l.ok ? 'text-emerald-600' : 'text-red-500'}>{l.message}</span>
                      {l.growth && l.growth.creditsGained > 0 && (
                        <Badge color="green">成长中心 +{l.growth.creditsGained}</Badge>
                      )}
                    </div>
                    {l.growth?.report && (
                      <div className={`mt-0.5 pl-0.5 leading-relaxed ${l.growth.ok ? 'text-zinc-500' : 'text-amber-600'}`}>
                        {l.growth.report}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      </PageSection>

      {/* 账号凭据维护 */}
      <PageSection
        icon={<IconRefresh />}
        title="账号凭据维护"
        desc="凭据不会自己续命：既没被切换过、也没走过反向代理的账号，会一路静默失效，直到只能重新扫码"
      >
        <Card className="p-5">
          <div className="divide-y divide-zinc-100 -mx-4 mb-3">
            <Row
              label={
                <span className="flex flex-wrap items-center gap-2">
                  凭据自动刷新
                  <Badge color={settings?.autoRefreshToken ? 'green' : 'gray'}>
                    {settings?.autoRefreshToken ? '已开启（默认）' : '已关闭'}
                  </Badge>
                </span>
              }
              desc={
                <>
                  服务端每 {refreshInfo?.intervalHours ?? 6} 小时看一次，
                  <b className="text-zinc-600">只在临期时才动手</b>：access_token 剩余不足{' '}
                  {refreshInfo?.accessMinHours ?? 24} 小时，或 refresh_token 剩余不足{' '}
                  {refreshInfo?.refreshMinHours ?? 72} 小时。关掉后，长期不切换、也不走反向代理的账号会一直静默过期。
                </>
              }
            >
              <Switch
                checked={!!settings?.autoRefreshToken}
                onChange={(v) =>
                  toggleBoolSetting('autoRefreshToken', v, {
                    on: '已开启凭据自动刷新：只在临期时才刷新，不会频繁打扰官方接口',
                    off: '已关闭凭据自动刷新：长期不用的账号可能失效',
                  })
                }
              />
            </Row>

            <Row label="立即检查" desc="只刷新已经临期的账号；有效期充足的保持不动，避免无谓的凭据轮换">
              <Button size="sm" onClick={runTokenRefresh} loading={refreshingTokens}>
                {!refreshingTokens && <IconRefresh className="w-3.5 h-3.5" />}
                检查并刷新
              </Button>
            </Row>
          </div>

          {!refreshInfo ? (
            <div className="py-3 text-sm text-zinc-400">正在读取账号凭据状态…</div>
          ) : !refreshInfo.accounts.length ? (
            <div className="py-3 text-sm text-zinc-400">账号库为空。先在「WorkBuddy 管理 → 账号切换」里导入账号。</div>
          ) : (
            <ul className="-mx-4 divide-y divide-zinc-100">
              {refreshInfo.accounts.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-xs">
                  <span className="font-medium text-zinc-700">{a.name}</span>
                  <Badge color={a.dead ? 'red' : a.due ? 'amber' : 'gray'}>
                    {REFRESH_REASON_TEXT[a.reason] || a.reason}
                  </Badge>
                  {/* 服务端验活结论：本地有效期不算数，这里才是官方真实态度 */}
                  <span
                    title={
                      a.verify
                        ? a.verify.valid
                          ? `服务端于 ${fmtDateTime(a.verify.at)} 确认凭据有效`
                          : `服务端于 ${fmtDateTime(a.verify.at)} 拒绝该凭据${a.verify.message ? `：${a.verify.message}` : ''}`
                        : '尚未验活：每 6 小时自动巡检一次'
                    }
                  >
                    <Badge
                      color={a.verify ? (a.verify.valid ? 'green' : a.verify.unauthorized ? 'red' : 'amber') : 'gray'}
                    >
                      {a.verify
                        ? a.verify.valid
                          ? '已验活·有效'
                          : a.verify.unauthorized
                            ? '已验活·失效'
                            : '验活失败'
                        : '未验活'}
                    </Badge>
                  </span>
                  <span className="ml-auto tabular-nums text-zinc-400">
                    access {fmtHours(a.accessHours)} · refresh {fmtHours(a.refreshHours)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {refreshInfo?.lastRun && (
            <div className="mt-3 text-[11px] text-zinc-400">
              最近一次自动巡检：{fmtDateTime(refreshInfo.lastRun.at)}，刷新 {refreshInfo.lastRun.refreshed} 个账号。
            </div>
          )}
        </Card>
      </PageSection>

      {/* WorkBuddy 数据目录 */}
      <PageSection
        icon={<IconDatabase />}
        title="WorkBuddy 数据目录"
        desc="模型配置与 Token 统计的数据来源"
        actions={
          <Button size="sm" variant="subtle" loading={detecting} onClick={() => redetect(false)}>
            <IconRefresh className="w-3.5 h-3.5" />
            重新检测
          </Button>
        }
      >
        <Card className="p-5">
          {!settings ? (
            <div className="py-6 flex justify-center">
              <Spinner />
            </div>
          ) : (
            <>
              <div className={`rounded-xl border px-3.5 py-3 ${settings.detected.valid ? 'border-emerald-200 bg-emerald-50/60' : 'border-amber-200 bg-amber-50'}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm text-zinc-800 break-all">{settings.detected.dir}</span>
                  <div className="ml-auto flex items-center gap-1.5">
                    {settings.detected.source === 'override' && <Badge color="blue">{settings.detected.sourceLabel}</Badge>}
                    {settings.detected.valid ? <Badge color="green">已检测到</Badge> : <Badge color="amber">未检测到</Badge>}
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <MarkerBadge ok={settings.detected.markers.modelsJson} label="models.json" />
                  <MarkerBadge ok={settings.detected.markers.projects} label="会话日志" />
                  <MarkerBadge ok={settings.detected.markers.sessions} label="sessions" />
                  <MarkerBadge ok={settings.detected.markers.db} label="workbuddy.db" />
                </div>
                {!settings.detected.valid && (
                  <div className="mt-2 text-xs text-amber-600">
                    未找到 WorkBuddy 数据特征文件。请先安装并运行一次 WorkBuddy，或展开「手动指定」填写数据目录。
                  </div>
                )}
              </div>

              <div className="mt-3">
                <Button size="sm" variant="ghost" onClick={() => setShowManual((v) => !v)}>
                  <IconChevronDown className={`w-3.5 h-3.5 transition-transform ${showManual ? '' : '-rotate-90'}`} />
                  手动指定
                </Button>
              </div>

              {showManual && (
                <div className="mt-3 rounded-xl border border-zinc-200 p-3.5 animate-fade-in">
                  <div className="text-xs text-zinc-500 mb-2">手动指定数据目录（一般无需修改；留空保存即恢复自动检测）：</div>
                  <div className="flex items-center gap-2">
                    <input
                      value={wbDir}
                      onChange={(e) => setWbDir(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && saveDir(wbDir)}
                      placeholder="例如 C:\Users\你\.workbuddy"
                      className="flex-1 h-9 px-3 rounded-xl border border-zinc-200 text-sm font-mono outline-none focus:border-indigo-400"
                    />
                    <Button variant="primary" loading={savingDir} onClick={() => saveDir(wbDir)}>
                      保存
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </Card>
      </PageSection>

      {/* WorkBuddy 安装目录（客户端 exe） */}
      <PageSection
        icon={<IconLayers />}
        title="WorkBuddy 安装目录"
        desc="切换账号后自动重新打开客户端时用来定位 exe"
      >
        <Card className="p-5">
          {!settings ? (
            <div className="py-6 flex justify-center">
              <Spinner />
            </div>
          ) : (
            <>
              <div
                className={`rounded-xl border px-3.5 py-3 ${
                  settings.detectedExe ? 'border-emerald-200 bg-emerald-50/60' : 'border-amber-200 bg-amber-50'
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm text-zinc-800 break-all">
                    {settings.detectedExe || '未定位到客户端 exe'}
                  </span>
                  <div className="ml-auto">
                    {settings.detectedExe ? <Badge color="green">已定位</Badge> : <Badge color="amber">未定位</Badge>}
                  </div>
                </div>
                <div className="mt-2 text-xs leading-relaxed text-zinc-600">
                  {settings.detectedExe
                    ? '切换账号 / 转移会话完成后，控制台会用这个路径把 WorkBuddy 重新打开。'
                    : '定位不到客户端时，切换账号后无法自动重新打开 WorkBuddy（会改成提示你手动打开）。装在盘符根目录（如 E:\workbuddy）最容易遇到，在这里填一次即可。'}
                </div>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <input
                  value={exeDir}
                  onChange={(e) => setExeDir(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && saveExeDir(exeDir)}
                  placeholder="例如 E:\workbuddy（填 WorkBuddy.exe 所在目录）"
                  className="flex-1 h-9 px-3 rounded-xl border border-zinc-200 text-sm font-mono outline-none focus:border-indigo-400"
                />
                <Button variant="primary" loading={savingExeDir} onClick={() => saveExeDir(exeDir)}>
                  保存
                </Button>
              </div>
              <div className="mt-2 text-[11px] text-zinc-400">
                留空保存 = 恢复自动定位（进程路径 → 上次记录 → 各盘 Program Files → 盘符根目录 → 注册表卸载项）。
              </div>
            </>
          )}
        </Card>
      </PageSection>

      {/* 登录态与目录权限 */}
      <PageSection
        icon={<IconShield />}
        title="登录态与目录权限"
        desc="切换账号、载入模型都要写这些位置"
        actions={
          <>
            {perm && <Badge color={perm.ok ? 'green' : 'red'}>{perm.ok ? '全部正常' : '存在异常'}</Badge>}
            <Button size="sm" variant="subtle" loading={permLoading} onClick={() => loadPerm(false)}>
              <IconRefresh className="w-3.5 h-3.5" />
              重新自检
            </Button>
          </>
        }
      >
        <Card className="p-5 space-y-4">
          {!perm ? (
            <div className="py-6 flex justify-center">
              <Spinner />
            </div>
          ) : (
            permGroups.map(([group, items]) => (
              <div key={group}>
                <div className="text-xs font-medium text-zinc-400 mb-1.5">{group}</div>
                <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200/80">
                  {items.map((item) => (
                    <div key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5">
                      <Badge color={item.ok ? 'green' : 'red'}>{item.ok ? '✓' : '✗'}</Badge>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-zinc-700">{item.label}</div>
                        <div className="text-xs text-zinc-400 font-mono break-all">{item.path}</div>
                        <div className="text-xs text-zinc-400 mt-0.5">{item.hint}</div>
                        {!item.exists && <div className="text-xs text-zinc-400 mt-0.5">尚未创建，首次使用时自动生成。</div>}
                        {item.exists && !item.writable && <div className="text-xs text-red-500 mt-0.5">不可写：可能是只读或被其他程序占用。</div>}
                      </div>
                      <div className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                        <span className={item.readable ? 'text-emerald-600' : 'text-red-500'}>读</span>
                        <span className="text-zinc-200">/</span>
                        <span className={item.writable ? 'text-emerald-600' : 'text-red-500'}>写</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </Card>
      </PageSection>

      {/* 登录态备份与恢复 */}
      <PageSection
        icon={<IconDatabase />}
        title="登录态备份与恢复"
        count={backups ? `${backups.backups.length} 份` : undefined}
        desc="每次切换账号前自动备份，可随时回退"
        actions={
          <>
            <Button size="sm" variant="subtle" onClick={loadBackups}>
              <IconRefresh className="w-3.5 h-3.5" />
              刷新
            </Button>
            <Button size="sm" variant="subtle" disabled={!backups?.backups.length} onClick={cleanBackups}>
              <IconTrash className="w-3.5 h-3.5" />
              清理旧备份
            </Button>
          </>
        }
      >
        <Card className="p-5">
          <div className="text-xs text-zinc-400 mb-3 break-all">备份目录：{backups?.dir || '…'}</div>
          {!backups ? (
            <div className="py-6 flex justify-center">
              <Spinner />
            </div>
          ) : backups.backups.length === 0 ? (
            <div className="text-sm text-zinc-400 py-3">还没有备份。切换账号时本工具会自动把切换前的登录态存到这里。</div>
          ) : (
            <div className="max-h-80 overflow-y-auto rounded-xl border border-zinc-200/80 divide-y divide-zinc-100">
              {backups.backups.map((b) => (
                <div key={b.name} className="flex flex-wrap items-center gap-2 px-3.5 py-2.5 hover:bg-zinc-50/70 transition-colors">
                  <div className="min-w-0">
                    <div className="text-sm text-zinc-700 tabular-nums">{new Date(b.createdAt).toLocaleString('zh-CN')}</div>
                    <div className="text-xs text-zinc-400">
                      {b.variantLabel} · {fmtSize(b.size)} · {fmtRelative(b.mtime)}
                    </div>
                  </div>
                  <div className="ml-auto flex items-center gap-1.5">
                    <Button size="sm" variant="subtle" loading={backupBusy === b.name} onClick={() => restoreBackup(b)}>
                      恢复
                    </Button>
                    <Button size="sm" variant="danger" loading={backupBusy === b.name} onClick={() => removeBackup(b)}>
                      <IconTrash className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </PageSection>
    </div>
  );
}
