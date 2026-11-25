import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  IconArrowDown,
  IconCheck,
  IconClock,
  IconEdit,
  IconPower,
  IconQrCode,
  IconRefresh,
  IconSparkles,
  IconSwitch,
  IconTrash,
  IconUser,
  IconUsers,
  IconWarning,
  Modal,
  ProgressBar,
  SectionHeader,
  Skeleton,
  Spinner,
  useConfirm,
  useToast,
} from '../../components/ui';
import { zcodeApi } from '../../lib/zcode';
import type {
  ZAccount,
  ZCodeBalanceCacheEntry,
  ZCodeBalanceResponse,
  ZCodeBalanceBucket,
  ZCodeState,
  ZCodeTimestamp,
} from '../../lib/zcode';

function accountName(account: Pick<ZAccount, 'label' | 'name' | 'email' | 'userId'>): string {
  return account.label || account.name || account.email || account.userId || 'ZCode 账号';
}

function avatarTone(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const tones = [
    'from-indigo-500 to-violet-600',
    'from-emerald-500 to-teal-600',
    'from-amber-500 to-orange-600',
    'from-sky-500 to-blue-600',
    'from-rose-500 to-pink-600',
    'from-fuchsia-500 to-purple-600',
  ];
  return tones[h % tones.length];
}

function Avatar({ name, seed }: { name: string; seed: string }) {
  return (
    <div
      className={`w-12 h-12 text-base rounded-full bg-gradient-to-br ${avatarTone(seed)} text-white flex items-center justify-center font-semibold shrink-0 ring-4 ring-white/70 shadow-sm`}
    >
      {(name || 'Z').slice(0, 1).toUpperCase()}
    </div>
  );
}

function fmtCredits(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
}

function toTime(value: ZCodeTimestamp | undefined): number | null {
  if (value == null || value === '') return null;
  const time = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function fmtClock(value: ZCodeTimestamp | undefined): string {
  const time = toTime(value);
  if (time == null) return '—';
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function fmtExpiry(value: ZCodeTimestamp | undefined): string {
  const time = toTime(value);
  if (time == null) return '长期有效';
  const date = new Date(time);
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;
}

function fmtCacheAge(at: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 60_000));
  return `${minutes} 分钟前`;
}

function StatusPackageRow({ text }: { text: string }) {
  return (
    <div className="min-w-0">
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 text-xs">
        <span className="rounded-lg bg-zinc-100 px-2 py-1 tabular-nums text-zinc-300">—</span>
        <span className="truncate text-zinc-400" title={text}>{text}</span>
        <span className="whitespace-nowrap tabular-nums text-zinc-300">—</span>
      </div>
      <div className="mt-1.5 h-1 rounded-full bg-zinc-100" />
    </div>
  );
}

function BalanceBucketRow({ bucket }: { bucket: ZCodeBalanceBucket }) {
  const remaining = Number(bucket.remaining) || 0;
  const total = Number(bucket.total) || 0;
  const ratio = total > 0 ? Math.min(100, Math.max(0, (remaining / total) * 100)) : 0;
  const expiry = toTime(bucket.expiresAt);
  const expired = expiry != null && expiry < Date.now();
  const expiringSoon = expiry != null && !expired && expiry - Date.now() <= 3 * 86_400_000;
  const tone = expired ? 'bg-red-400' : expiringSoon ? 'bg-amber-500' : 'bg-indigo-500';
  const expiryTone = expired ? 'text-red-500' : expiringSoon ? 'text-amber-600' : 'text-zinc-400';

  return (
    <div
      className="min-w-0"
      title={`${bucket.name} · 剩余 ${fmtCredits(remaining)} / ${fmtCredits(total)} · ${expiry == null ? '长期有效' : `${fmtExpiry(bucket.expiresAt)} 到期`}`}
    >
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 text-xs">
        <span className="rounded-lg bg-zinc-100 px-2 py-1 font-medium tabular-nums text-zinc-700">
          {fmtCredits(remaining)} / {fmtCredits(total)}
        </span>
        <span className="truncate text-zinc-500">{bucket.name}</span>
        <span className={`whitespace-nowrap tabular-nums ${expiryTone}`}>{fmtExpiry(bucket.expiresAt)}</span>
      </div>
      <ProgressBar percent={ratio} color={tone} size="sm" className="mt-1.5" />
    </div>
  );
}

function AccountCard({
  account,
  isCurrent,
  credentialOk,
  busy,
  balance,
  balanceError,
  balanceLoading,
  fromCache,
  onSwitch,
  onRename,
  onDelete,
}: {
  account: ZAccount;
  isCurrent: boolean;
  credentialOk: boolean;
  busy: boolean;
  balance: ZCodeBalanceCacheEntry | null;
  balanceError?: string;
  balanceLoading: boolean;
  fromCache: boolean;
  onSwitch: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const name = accountName(account);
  const buckets = balance?.balances || [];
  const remaining = buckets.reduce((sum, bucket) => sum + (Number(bucket.remaining) || 0), 0);
  const soonest = buckets
    .map((bucket) => ({ bucket, expiry: toTime(bucket.expiresAt) }))
    .filter((item): item is { bucket: ZCodeBalanceBucket; expiry: number } => item.expiry != null && (Number(item.bucket.remaining) || 0) > 0)
    .sort((a, b) => a.expiry - b.expiry)[0];
  const soonDays = soonest ? Math.ceil((soonest.expiry - Date.now()) / 86_400_000) : null;
  const soonWarn = soonDays != null && soonDays >= 0 && soonDays <= 3;

  return (
    <article
      className={`flex min-w-0 flex-col overflow-hidden rounded-2xl border bg-white shadow-[0_1px_2px_rgba(15,23,42,.025),0_10px_28px_rgba(15,23,42,.035)] transition-shadow hover:shadow-[0_2px_4px_rgba(15,23,42,.04),0_14px_34px_rgba(15,23,42,.055)] ${
        isCurrent ? 'border-emerald-200' : 'border-zinc-200'
      }`}
    >
      <header className={`relative border-b px-5 py-4 ${isCurrent ? 'bg-emerald-50/50' : 'bg-zinc-50/60'}`}>
        <div
          className={`pointer-events-none absolute -right-10 -top-16 size-24 rounded-full blur-2xl ${
            isCurrent ? 'bg-emerald-300/35' : 'bg-zinc-300/40'
          }`}
        />
        <div className="relative flex items-center gap-3">
          <Avatar name={name} seed={account.userId || account.id} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <h3 className="truncate text-sm font-semibold leading-5 text-zinc-900" title={name}>{name}</h3>
              {isCurrent && <Badge color="green" dot>使用中</Badge>}
            </div>
            <p className="mt-0.5 truncate font-mono text-xs leading-5 text-zinc-400" title={account.userId}>
              UID {account.userId || '—'}
            </p>
            <button
              type="button"
              onClick={onRename}
              title={account.label ? `备注：${account.label}（点击修改）` : '点击添加备注'}
              className="group mt-1 flex max-w-full items-center gap-1 truncate text-left text-xs leading-5 text-zinc-500 transition-colors hover:text-indigo-600"
            >
              <IconEdit className="h-3 w-3 shrink-0 text-zinc-300 transition-colors group-hover:text-indigo-400" />
              {account.label ? (
                <span className="truncate">备注：{account.label}</span>
              ) : (
                <span className="truncate text-zinc-400 group-hover:text-indigo-500">添加备注</span>
              )}
            </button>
            <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
              {account.provider && <Badge color="gray">{account.provider}</Badge>}
              {isCurrent && credentialOk && <Badge color="green">登录有效</Badge>}
            </div>
          </div>
        </div>
      </header>

      <section className="flex min-w-0 flex-1 flex-col px-5 pb-5 pt-4">
        <div className="flex items-baseline gap-x-3 gap-y-1">
          <span className="flex items-center gap-1.5">
            <IconSparkles className="w-4 h-4 shrink-0 text-zinc-400" />
            <strong className="text-[22px] font-semibold leading-none tracking-[-0.025em] tabular-nums text-zinc-900">
              {balance ? fmtCredits(remaining) : <span className="text-zinc-300">—</span>}
            </strong>
          </span>
          <span className="text-xs text-zinc-400" title={fromCache ? '上次读到并缓存在本机的免费额度' : '当前账号的免费额度'}>
            {balance ? `${buckets.length} 个额度桶` : '—'}
          </span>
          {soonest && (
            <span
              className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium tabular-nums ${
                soonWarn ? 'bg-amber-100 text-amber-700' : 'bg-zinc-100 text-zinc-500'
              }`}
              title={`最先到期的额度桶：${soonest.bucket.name} ${fmtExpiry(soonest.bucket.expiresAt)} 到期`}
            >
              {soonWarn && <IconWarning className="w-3 h-3 shrink-0" />}
              {soonDays != null && soonDays >= 0 ? `${soonDays === 0 ? '今天' : `${soonDays} 天`}后到期` : '已到期'}
            </span>
          )}
          <div
            className="ml-auto flex items-center gap-1.5 text-xs text-zinc-400"
            title={fromCache && balance ? `上次读到的额度，${fmtCacheAge(balance.at)}` : '额度更新时间'}
          >
            {balanceLoading ? <Spinner className="w-3.5 h-3.5" /> : <IconClock className="w-3.5 h-3.5 shrink-0" />}
            <span className="whitespace-nowrap tabular-nums">
              {balanceLoading
                ? '查询中…'
                : balance
                  ? `${fromCache ? `${fmtCacheAge(balance.at)} · ` : ''}${fmtClock(balance.at)} 更新`
                  : '—'}
            </span>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium text-zinc-400">额度明细</span>
          {fromCache && balance && <span className="text-[11px] text-zinc-400">上次读到的额度</span>}
        </div>

        {balanceError && (
          <div className="mt-2 rounded-lg border border-red-100 bg-red-50 px-2.5 py-1.5 text-[11px] leading-relaxed text-red-600">
            {balanceError}
          </div>
        )}

        <div className="mt-4 space-y-2.5">
          {balanceLoading ? (
            <StatusPackageRow text="额度查询中…" />
          ) : buckets.length > 0 ? (
            buckets.map((bucket, index) => <BalanceBucketRow key={bucket.bucketId || `${bucket.name}-${index}`} bucket={bucket} />)
          ) : (
            <StatusPackageRow text={balanceError || '切到该账号并刷新后显示额度'} />
          )}
        </div>
      </section>

      <footer className="flex flex-wrap items-center gap-2 border-t border-zinc-100 px-5 py-2.5">
        <Button
          variant={isCurrent ? 'subtle' : 'primary'}
          size="sm"
          className="h-7 rounded-full px-2.5 pr-3.5 text-xs"
          disabled={isCurrent || busy}
          onClick={onSwitch}
          title={isCurrent ? '当前正在使用的账号' : '把 ZCode 登录态切换到这个账号'}
        >
          {isCurrent ? <IconCheck className="w-3.5 h-3.5" /> : <IconSwitch className="w-3.5 h-3.5" />}
          {isCurrent ? '使用中' : '切换账号'}
        </Button>
        <Button
          size="sm"
          variant="subtle"
          className="ml-auto h-7 rounded-full px-2.5 text-xs"
          onClick={onDelete}
          disabled={busy}
          title="从控制台账号库删除快照"
        >
          <IconTrash className="w-3.5 h-3.5" />
        </Button>
      </footer>
    </article>
  );
}

function RenameDialog({
  account,
  onClose,
  onSaved,
}: {
  account: ZAccount | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (account) setLabel(account.label || '');
  }, [account]);

  if (!account) return null;

  const save = async () => {
    setSaving(true);
    try {
      await zcodeApi.renameAccount(account.id, label.trim());
      toast('ok', '已保存');
      onSaved();
      onClose();
    } catch (e: any) {
      toast('err', e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={!!account}
      onClose={onClose}
      title={`编辑「${accountName(account)}」`}
      subtitle="仅修改本地备注，不触碰任何凭据"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" loading={saving} disabled={!label.trim()} onClick={save}>保存</Button>
        </>
      }
    >
      <div>
        <label className="block text-xs font-medium text-zinc-600 mb-1.5">备注</label>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="例如：主号 / 备用号 / 公司账号"
          maxLength={40}
          className="w-full h-9 px-3 rounded-xl border border-zinc-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all"
        />
      </div>
    </Modal>
  );
}

export default function ZCodeAccountsPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [state, setState] = useState<ZCodeState | null>(null);
  const [balance, setBalance] = useState<ZCodeBalanceResponse | null>(null);
  const [balanceCache, setBalanceCache] = useState<Record<string, ZCodeBalanceCacheEntry>>({});
  const [loading, setLoading] = useState(true);
  const [balanceLoading, setBalanceLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [loginOpening, setLoginOpening] = useState(false);
  const [importing, setImporting] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<ZAccount | null>(null);

  const loadState = useCallback(async (): Promise<ZCodeState | null> => {
    try {
      const result = await zcodeApi.state();
      setState(result);
      setLoadError('');
      return result;
    } catch (e: any) {
      setLoadError(e?.message || '读取 ZCode 账号状态失败');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const loadBalance = useCallback(async (refresh = false): Promise<ZCodeBalanceResponse> => {
    setBalanceLoading(true);
    try {
      const result = await zcodeApi.balance(refresh);
      setBalance(result);
      return result;
    } catch (e: any) {
      const result: ZCodeBalanceResponse = {
        ok: false,
        error: e?.message || '读取 ZCode 额度失败',
        cached: null,
      };
      setBalance(result);
      return result;
    } finally {
      setBalanceLoading(false);
    }
  }, []);

  const loadBalanceCache = useCallback(async () => {
    try {
      const result = await zcodeApi.balanceCache();
      setBalanceCache(result.cache || {});
    } catch {
      /* 缓存读取失败时保留上次结果，不影响当前账号的实时额度。 */
    }
  }, []);

  useEffect(() => {
    void Promise.all([loadState(), loadBalance(), loadBalanceCache()]);
  }, [loadState, loadBalance, loadBalanceCache]);

  const openLogin = async () => {
    setLoginOpening(true);
    try {
      const result = await zcodeApi.loginUrl();
      toast('ok', result.note || '已在浏览器打开 ZCode 官方登录页');
    } catch (e: any) {
      toast('err', e?.message || '打开 ZCode 登录页失败');
    } finally {
      setLoginOpening(false);
    }
  };

  const importCurrent = async () => {
    setImporting(true);
    try {
      const result = await zcodeApi.importCurrent();
      const label = accountName(result.account);
      toast('ok', result.updated ? `已更新账号快照：${label}` : `导入成功：${label}`);
      await loadState();
    } catch (e: any) {
      toast('err', e?.message || '导入失败');
    } finally {
      setImporting(false);
    }
  };

  const stopNow = async () => {
    setStopping(true);
    try {
      const result = await zcodeApi.stop();
      if (!result.ok || (Number(result.remaining) || 0) > 0) {
        toast('err', result.error || `ZCode 仍有 ${Number(result.remaining) || 0} 个进程未退出`);
      } else {
        toast('ok', '已退出 ZCode');
      }
      await loadState();
    } catch (e: any) {
      toast('err', e?.message || '退出 ZCode 失败');
    } finally {
      setStopping(false);
    }
  };

  const launchNow = async () => {
    setLaunching(true);
    try {
      const result = await zcodeApi.launch();
      toast('ok', result.already ? 'ZCode 已经在运行' : '已启动 ZCode');
      await loadState();
    } catch (e: any) {
      toast('err', e?.message || '启动 ZCode 失败');
    } finally {
      setLaunching(false);
    }
  };

  const refreshAll = async () => {
    setRefreshing(true);
    try {
      const [nextState, nextBalance] = await Promise.all([loadState(), loadBalance(true), loadBalanceCache()]);
      if (!nextState) {
        toast('err', '登录态刷新失败，请查看页面错误提示');
      } else if (!nextBalance.ok) {
        toast('err', nextBalance.error);
      } else {
        toast('ok', '登录态与免费额度已刷新');
      }
    } finally {
      setRefreshing(false);
    }
  };

  const switchNow = async (account: ZAccount) => {
    const name = accountName(account);
    const ok = await confirm({
      title: '切换 ZCode 账号',
      message: (
        <>
          将把账号「<b>{name}</b>」写入 ZCode 登录态。
          <div className="mt-2.5 text-xs leading-relaxed text-zinc-500">
            切换时会<b>自动结束 ZCode 进程</b>，请先保存手头工作；为避免高频切号风险，<b>3 分钟只能切换一次</b>。
          </div>
        </>
      ),
      confirmText: '切换账号',
    });
    if (!ok) return;
    setBusyId(account.id);
    try {
      await zcodeApi.switchTo(account.id);
      toast('ok', `已切换到「${name}」：重新打开 ZCode 生效`);
      await Promise.all([loadState(), loadBalance(true), loadBalanceCache()]);
    } catch (e: any) {
      toast('err', e?.message || '切换失败');
    } finally {
      setBusyId(null);
    }
  };

  const deleteNow = async (account: ZAccount) => {
    const name = accountName(account);
    const ok = await confirm({
      title: '删除账号',
      message: `删除账号「${name}」？只删控制台账号库里的快照，不影响 ZCode 客户端`,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    setBusyId(account.id);
    try {
      await zcodeApi.deleteAccount(account.id);
      toast('ok', `已删除账号「${name}」`);
      await loadState();
    } catch (e: any) {
      toast('err', e?.message || '删除失败');
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-16 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    );
  }

  const current = state?.current;
  const accounts = state?.accounts || [];
  const currentName = current?.label || current?.name || current?.email || current?.userId || 'ZCode 账号';

  return (
    <div className="space-y-5">
      {loadError && (
        <div className="flex flex-wrap items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-700 leading-relaxed">
          <IconWarning className="w-3.5 h-3.5 shrink-0 mt-px text-red-500" />
          <span className="min-w-[220px] flex-1">{loadError}</span>
          <Button size="sm" variant="subtle" loading={refreshing} onClick={refreshAll}>
            <IconRefresh className="w-3.5 h-3.5" />
            重试
          </Button>
        </div>
      )}

      <div className="relative overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-50/80 px-5 py-5 shadow-[0_6px_20px_rgba(15,23,42,.025)]">
        <div className="pointer-events-none absolute -right-12 -top-20 size-44 rounded-full border-[28px] border-zinc-400/[0.06]" />
        <div className="relative flex flex-wrap items-center gap-x-5 gap-y-4">
          <div className="min-w-[200px] flex-1">
            <h2 className="text-sm font-semibold text-zinc-900">添加与迁移账号</h2>
            <p className="mt-1 text-xs leading-5 text-zinc-500">
              在 ZCode 客户端登录后，读取本机登录态导入账号库（凭据快照加密保存在本机，不上传）；已存在的账号按 userId 只更新快照、保留备注。
            </p>
            <p className="mt-1.5 truncate font-mono text-[11px] text-zinc-400" title={state?.accountsFile}>
              {state?.accountsFile || '—'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" className="h-9 px-3.5" loading={loginOpening} onClick={openLogin}>
              <IconQrCode className="w-3.5 h-3.5" />
              扫码登录
            </Button>
            <Button variant="subtle" className="h-9 px-3.5" loading={importing} onClick={importCurrent}>
              <IconArrowDown className="w-3.5 h-3.5" />
              导入当前登录态
            </Button>
          </div>
        </div>
      </div>

      {state?.process.running && (
        <div className="flex flex-wrap items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-800 leading-relaxed">
          <IconWarning className="w-3.5 h-3.5 shrink-0 mt-px text-amber-500" />
          <span className="min-w-[220px] flex-1">
            ZCode 正在运行（{state.process.pids.length} 个进程）。切换账号时会自动结束 ZCode 进程，请先保存手头工作。
          </span>
          <Button size="sm" variant="danger" className="shrink-0" loading={stopping} onClick={stopNow}>
            <IconPower className="w-3.5 h-3.5" />
            退出 ZCode
          </Button>
        </div>
      )}

      <Card className="p-4">
        <SectionHeader
          icon={<IconUsers />}
          title="当前登录态"
          desc="切换账号会重写 ZCode 登录态文件（~/.zcode/v2/credentials.json），原文件自动备份"
          actions={
            <>
              <Button size="sm" variant="subtle" loading={launching} onClick={launchNow}>
                <IconPower className="w-3.5 h-3.5" />
                启动 ZCode
              </Button>
              <Button size="sm" loading={refreshing} onClick={refreshAll}>
                <IconRefresh className="w-3.5 h-3.5" />
                刷新
              </Button>
            </>
          }
        />
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {current?.exists ? (
            <>
              <Avatar name={currentName} seed={current.userId || current.accountId || currentName} />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-zinc-900">{currentName}</span>
                  {state?.credentialOk ? (
                    <Badge color="green" dot>已登录</Badge>
                  ) : (
                    <Badge color="gray">未读取到登录态</Badge>
                  )}
                  {current.provider && <Badge color="gray">{current.provider}</Badge>}
                </div>
                <div className="mt-1 text-xs text-zinc-400 font-mono truncate max-w-[520px]">
                  {current.email || '—'} · UID {current.userId || '—'}
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="w-12 h-12 rounded-full bg-amber-50 border border-amber-200 text-amber-500 flex items-center justify-center shrink-0">
                <IconWarning className="w-5 h-5" />
              </div>
              <div>
                <div className="font-medium text-zinc-900">未检测到登录态</div>
                <div className="text-xs text-zinc-400 mt-0.5">在 ZCode 客户端登录，或点上方「扫码登录」</div>
              </div>
            </>
          )}
        </div>
        {current?.error && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2 text-xs text-amber-800">
            <IconWarning className="w-3.5 h-3.5 shrink-0 mt-px text-amber-500" />
            {current.error}
          </div>
        )}
      </Card>

      <section className="min-w-0">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold tracking-tight text-zinc-900">ZCode 账号</h2>
            <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full border border-zinc-200 bg-zinc-100 px-1.5 text-[11px] font-medium tabular-nums text-zinc-500">
              {accounts.length}
            </span>
          </div>
        </div>

        {accounts.length === 0 ? (
          <EmptyState
            icon={<IconUser />}
            title="账号库为空"
            desc="在 ZCode 客户端登录后点「导入当前登录态」"
            action={
              <Button variant="primary" loading={importing} onClick={importCurrent}>
                <IconArrowDown className="w-3.5 h-3.5" />
                导入当前登录态
              </Button>
            }
          />
        ) : (
          <div className="grid min-w-0 gap-5 grid-cols-[repeat(auto-fit,minmax(min(100%,320px),1fr))]">
            {accounts.map((account) => {
              const isCurrent = current?.accountId
                ? current.accountId === account.id
                : !!current?.exists && !!current.userId && current.userId === account.userId;
              let cardBalance: ZCodeBalanceCacheEntry | null = null;
              let cardError: string | undefined;
              let fromCache = false;
              if (isCurrent) {
                if (balance?.ok) {
                  cardBalance = balance;
                } else if (balance?.ok === false) {
                  cardBalance = balance.cached;
                  cardError = balance.error;
                }
              } else {
                cardBalance = account.userId ? balanceCache[account.userId] || null : null;
                fromCache = !!cardBalance;
              }
              return (
                <AccountCard
                  key={account.id}
                  account={account}
                  isCurrent={isCurrent}
                  credentialOk={!!state?.credentialOk}
                  busy={busyId === account.id}
                  balance={cardBalance}
                  balanceError={cardError}
                  balanceLoading={isCurrent && balanceLoading}
                  fromCache={fromCache}
                  onSwitch={() => void switchNow(account)}
                  onRename={() => setEditing(account)}
                  onDelete={() => void deleteNow(account)}
                />
              );
            })}
          </div>
        )}
      </section>

      <RenameDialog account={editing} onClose={() => setEditing(null)} onSaved={() => void loadState()} />
    </div>
  );
}
