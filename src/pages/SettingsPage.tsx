import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  IconClock,
  IconCopy,
  IconDownload,
  IconLayers,
  IconRefresh,
  IconShield,
  IconSliders,
  IconTrash,
  IconWarning,
  IconZap,
  PageSection,
  Switch,
  useConfirm,
  useToast,
} from '../components/ui';
import { get, post, put, TIMEOUT } from '../lib/api';
import { emitUpdateChecked } from '../lib/appUpdate';
import { emitSettingsChanged } from '../lib/appSettings';
import type { AppUpdateInfo, PlatformInfo, SettingsInfo } from '../lib/types';
import { fmtDateTime } from '../lib/format';
import { NOTIFICATION_MAX, clearNotifications, readNotifications, type NotificationItem } from '../lib/notify';
import { ERROR_MAX, clearErrors, readErrors, type ErrorItem } from '../lib/errlog';
import { Row } from './settings-shared';

/**
 * 全网签到（其他平台福利代领）的自动领取设置。
 * 自包含组件：只依赖 /api/netcheckin/* 三个接口，不与页面主状态耦合——
 * 配置放在独立的 checkin/config.json 里，与主 config.json 互不干扰。
 */
function NetCheckinSettings() {
  const toast = useToast();
  const [form, setForm] = useState<{ enabled: boolean; time: string; jitterMinutes: number } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    get<{ schedule: { enabled: boolean; time: string; jitterMinutes: number } }>('/api/netcheckin/state')
      .then((s) => setForm({ ...s.schedule }))
      .catch(() => {
        /* 服务异常时保持 null，控件显示默认值 */
      });
  }, []);

  /**
   * 保存（可带局部覆盖）。开关类控件拨动即存——若像以前那样只改本地状态、
   * 等用户点「保存」，拨完开关就走的人改动会静默丢失。
   */
  const save = async (override?: { enabled?: boolean; time?: string; jitterMinutes?: number }) => {
    if (!form) return;
    const next = { ...form, ...override };
    setForm(next);
    setSaving(true);
    try {
      await post('/api/netcheckin/schedule', next, { timeoutMs: TIMEOUT.write });
      toast('ok', override?.enabled !== undefined ? (next.enabled ? '已开启自动领取' : '已关闭自动领取') : `已保存：每天 ${next.time} 自动领取全网签到福利`);
    } catch (e: any) {
      toast('err', e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageSection
      icon={<IconZap />}
      title="全网签到"
      desc="其他平台（智谱清言、MiniMax、豆包等）的每日福利代领；平台状态与手动领取在「全网签到」页"
    >
      <Card className="p-5 pt-1 pb-1">
        <div className="divide-y divide-zinc-100 -mx-4">
          <Row
            label={
              <span className="flex flex-wrap items-center gap-2">
                自动领取
                <Badge color={form?.enabled ? 'green' : 'gray'}>{form?.enabled ? '已开启' : '已关闭'}</Badge>
              </span>
            }
            desc={
              <>
                <b className="text-zinc-600">到点自动执行一轮</b>
                ，已领过的平台自动跳过，不会重复请求；之后每小时检查一次，发现还有平台没领就自动补跑（启动时也检查）。
                执行过程与各平台结果在「全网签到」页查看。
              </>
            }
          >
            <Switch checked={form?.enabled ?? true} onChange={(v) => void save({ enabled: v })} />
          </Row>
          <Row
            label="领取时间"
            desc="每天到点执行；随机延迟用于打散每天的请求节奏，降低被平台识别为自动化的概率"
          >
            <input
              type="time"
              className="h-8 rounded-xl border border-zinc-200 bg-white px-2.5 text-sm text-zinc-700 outline-none transition-colors focus:border-indigo-400"
              value={form?.time ?? '10:00'}
              onChange={(e) => setForm((f) => (f ? { ...f, time: e.target.value } : f))}
            />
            <span className="text-xs text-zinc-400">随机延迟</span>
            <input
              type="number"
              min={0}
              max={120}
              className="h-8 w-16 rounded-xl border border-zinc-200 bg-white px-2.5 text-sm text-zinc-700 outline-none transition-colors focus:border-indigo-400"
              value={form?.jitterMinutes ?? 25}
              onChange={(e) => setForm((f) => (f ? { ...f, jitterMinutes: Number(e.target.value) } : f))}
            />
            <span className="text-xs text-zinc-400">分钟</span>
            <Button size="sm" variant="subtle" loading={saving} onClick={() => save()}>
              保存
            </Button>
          </Row>
        </div>
      </Card>
    </PageSection>
  );
}

export default function SettingsPage() {
  const toast = useToast();
  const confirm = useConfirm();

  /* ---------------- 通用设置 ---------------- */
  const [settings, setSettings] = useState<SettingsInfo | null>(null);
  const [proxyInput, setProxyInput] = useState('');
  const [savingProxy, setSavingProxy] = useState(false);

  /* ---------------- 免费模型平台可见性 ---------------- */
  /** 受平台自身限制、默认收起的平台（仅用于在设置里说明"开了会放出哪几个"） */
  const [restrictedPlatforms, setRestrictedPlatforms] = useState<PlatformInfo[]>([]);

  /* ---------------- 版本自检 ---------------- */
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  /* ---------------- 本地日志（前端） ---------------- */
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [errors, setErrors] = useState<ErrorItem[]>([]);

  const loadSettings = useCallback(() => {
    get<SettingsInfo>('/api/settings')
      .then((r) => {
        setSettings(r);
        setProxyInput(r.proxyUrl || '');
      })
      .catch((e) => toast('err', e.message));
    // 平台限制清单：与开关无关，始终取真实原因（restriction），用来告诉用户「打开后会放出哪几个」
    get<{ platforms: PlatformInfo[] }>('/api/platforms')
      .then((r) => setRestrictedPlatforms((r.platforms || []).filter((p) => !!p.restriction)))
      .catch(() => {
        /* 读不到就只是少一句说明，不影响开关本身 */
      });
  }, [toast]);

  const loadUpdateInfo = useCallback(
    async (force = false) => {
      setCheckingUpdate(true);
      try {
        const info = force
          ? await post<AppUpdateInfo>('/api/app/update/check')
          : await get<AppUpdateInfo>('/api/app/update');
        setUpdateInfo(info);
        // 常驻的左下角版本区是另一个组件：把结果广播过去，否则「这里已显示发现新版本、
        // 左下角却没按钮」（用户 2026-10-18 反馈）
        emitUpdateChecked(info);
      } catch (e: any) {
        if (force) toast('err', e?.message || '检查更新失败');
      } finally {
        setCheckingUpdate(false);
      }
    },
    [toast]
  );

  const loadLocalLogs = useCallback(() => {
    setNotifications(readNotifications());
    setErrors(readErrors());
  }, []);

  useEffect(() => {
    loadSettings();
    loadLocalLogs();
    void loadUpdateInfo(false);
  }, [loadSettings, loadLocalLogs, loadUpdateInfo]);

  const saveProxy = async (url: string) => {
    setSavingProxy(true);
    try {
      const r = await put<{ ok: boolean; proxyUrl: string; effectiveProxy: string | null }>('/api/settings', { proxyUrl: url }, { timeoutMs: TIMEOUT.write });
      setSettings((prev) => (prev ? { ...prev, proxyUrl: r.proxyUrl, effectiveProxy: r.effectiveProxy } : prev));
      setProxyInput(r.proxyUrl);
      toast('ok', r.proxyUrl ? `代理已保存，出站请求将走 ${r.effectiveProxy || r.proxyUrl}` : '代理已清空，恢复自动探测（环境变量 / 系统代理）');
    } catch (e: any) {
      toast('err', e?.message || '保存失败');
    } finally {
      setSavingProxy(false);
    }
  };

  /** 其余布尔设置项的统一开关：与自动签到同一套「乐观更新 + 失败回滚」交互 */
  const toggleBoolSetting = async (
    key: 'autoCheckUpdate' | 'unlockAllPlatforms',
    next: boolean,
    hint: { on: string; off: string }
  ) => {
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

  const copyErrors = async () => {
    const text = errors
      .map((e) => `[${new Date(e.at).toLocaleString('zh-CN')}] ${e.kind === 'rejection' ? 'Promise拒绝' : '异常'} ${e.message}${e.source ? ` @ ${e.source}` : ''}${e.detail ? `\n${e.detail}` : ''}`)
      .join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      toast('ok', `已复制 ${errors.length} 条错误记录`);
    } catch {
      toast('err', '复制失败，请手动选中复制');
    }
  };

  return (
    <div className="space-y-6 max-w-4xl">
      {/* 全网签到（其他平台福利代领） */}
      <NetCheckinSettings />

      <PageSection
        icon={<IconLayers />}
        title="免费模型平台"
        desc="默认只列出能正常接入的平台"
        count={restrictedPlatforms.length ? `默认收起 ${restrictedPlatforms.length} 个` : undefined}
      >
        <Card className="p-5">
          <Row
            label="显示全部平台"
            desc="开启后，免费模型页会把因地区限制、或平台自身禁止外部接入而默认收起的平台一并列出，可自行尝试接入"
          >
            <Switch
              checked={!!settings?.unlockAllPlatforms}
              onChange={(v) =>
                toggleBoolSetting('unlockAllPlatforms', v, {
                  on: '已开放全部平台：这些平台大概率仍会被限制，接不上属于预期结果',
                  off: '已恢复默认：只显示可正常接入的平台',
                })
              }
              title="开启后，免费模型页会把因地区限制、或平台自身禁止外部接入而默认收起的平台一并列出"
            />
          </Row>

          {restrictedPlatforms.length > 0 && (
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-zinc-100 px-4 pt-3 text-xs text-zinc-400">
              <span>受限制的平台：</span>
              {restrictedPlatforms.map((p) => (
                <span key={p.id} className="inline-flex items-center gap-1">
                  <Badge color="gray">{p.name}</Badge>
                  <span className="text-[11px] text-zinc-300">
                    {p.restriction === 'region' ? '地区受限' : '平台禁止外部接入'}
                  </span>
                </span>
              ))}
            </div>
          )}

          <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-relaxed text-amber-700">
            <span className="font-medium">风险提示：</span>
            上面这些平台按地区或自身策略限制了外部调用。即使 key 能创建成功，从这里接入后也可能出现
            <b>请求被拒、频繁限流，甚至账号被风控或封禁</b>
            。默认收起正是因为「接进去大概率也用不了」；是否接入请自行判断并承担风险，也请先确认你了解该平台的服务条款。
          </div>
        </Card>
      </PageSection>

      {/* 网络代理 */}
      <PageSection icon={<IconSliders />} title="网络代理" desc="访问 OpenRouter 等海外平台时使用">
        <Card className="p-5">
          <div className="text-xs text-zinc-400 mb-3 leading-relaxed">
            OpenRouter 等海外平台在国内网络下可能无法直连。工具的出站请求默认不走系统代理，此处的代理地址用于访问这些平台；留空时自动探测环境变量（
            <span className="font-mono">HTTPS_PROXY</span>）与 Windows 系统代理，均未命中则直连。
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={proxyInput}
              onChange={(e) => setProxyInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && saveProxy(proxyInput)}
              placeholder="例如 http://127.0.0.1:7890"
              className="flex-1 min-w-56 h-9 px-3 rounded-xl border border-zinc-200 text-sm font-mono outline-none focus:border-indigo-400"
            />
            <Button variant="primary" loading={savingProxy} onClick={() => saveProxy(proxyInput)}>
              保存
            </Button>
          </div>
          <div className="text-xs text-zinc-400 mt-2.5">
            当前出站状态：
            {settings ? (
              settings.effectiveProxy ? (
                <span className="text-emerald-600 font-mono">走代理 {settings.effectiveProxy}</span>
              ) : (
                <span className="text-amber-600">直连（未配置代理，需 VPN 的平台将无法访问）</span>
              )
            ) : (
              '…'
            )}
          </div>
        </Card>
      </PageSection>

      {/* 通知历史 */}
      <PageSection
        icon={<IconClock />}
        title="通知历史"
        count={notifications.length ? `${notifications.length} 条` : undefined}
        desc={`保留最近 ${NOTIFICATION_MAX} 条应用内提示`}
        actions={
          <>
            <Button size="sm" variant="subtle" onClick={loadLocalLogs}>
              <IconRefresh className="w-3.5 h-3.5" />
              刷新
            </Button>
            <Button
              size="sm"
              variant="subtle"
              disabled={!notifications.length}
              onClick={() => {
                clearNotifications();
                setNotifications([]);
                toast('ok', '通知历史已清空');
              }}
            >
              <IconTrash className="w-3.5 h-3.5" />
              清空
            </Button>
          </>
        }
      >
        <Card className="p-5">
          {notifications.length === 0 ? (
            <div className="text-sm text-zinc-400 py-3">还没有记录到任何提示。</div>
          ) : (
            <ul className="max-h-72 overflow-y-auto divide-y divide-zinc-50 rounded-xl border border-zinc-100">
              {notifications.map((n, i) => (
                <li key={`${n.at}-${i}`} className="px-3 py-2">
                  <div className="flex items-center gap-2 text-[11px] text-zinc-400">
                    <span
                      className={`inline-block h-1.5 w-1.5 rounded-full ${
                        n.type === 'ok' ? 'bg-emerald-500' : n.type === 'err' ? 'bg-red-500' : 'bg-zinc-400'
                      }`}
                    />
                    <span>{n.type === 'ok' ? '成功' : n.type === 'err' ? '错误' : '提示'}</span>
                    <span>·</span>
                    <span className="tabular-nums">{fmtDateTime(n.at)}</span>
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-600 leading-5 break-words">{n.text}</div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </PageSection>

      {/* 界面错误日志 */}
      <PageSection
        icon={<IconWarning />}
        title="界面错误日志"
        count={errors.length ? `${errors.length} 条` : undefined}
        desc={`捕获界面异常与 Promise 拒绝，保留最近 ${ERROR_MAX} 条`}
        actions={
          <>
            <Button size="sm" variant="subtle" onClick={loadLocalLogs}>
              <IconRefresh className="w-3.5 h-3.5" />
              刷新
            </Button>
            <Button size="sm" variant="subtle" disabled={!errors.length} onClick={copyErrors}>
              <IconCopy className="w-3.5 h-3.5" />
              复制
            </Button>
            <Button
              size="sm"
              variant="subtle"
              disabled={!errors.length}
              onClick={() => {
                clearErrors();
                setErrors([]);
                toast('ok', '错误日志已清空');
              }}
            >
              <IconTrash className="w-3.5 h-3.5" />
              清空
            </Button>
          </>
        }
      >
        <Card className="p-5">
          <div className="text-xs text-zinc-400 mb-3 leading-relaxed">
            界面崩溃与未捕获的错误会记录在这里，反馈问题时可直接复制贴出；只存本机，不含任何 Key 或账号凭据。
          </div>
          {errors.length === 0 ? (
            <div className="text-sm text-emerald-600 py-3">运行正常，未捕获到界面错误。</div>
          ) : (
            <ul className="max-h-72 overflow-y-auto divide-y divide-zinc-50 rounded-xl border border-zinc-100">
              {errors.map((e, i) => (
                <li key={`${e.at}-${i}`} className="px-3 py-2">
                  <div className="flex items-center gap-2 text-[11px] text-zinc-400">
                    <Badge color="red">{e.kind === 'rejection' ? 'Promise' : '异常'}</Badge>
                    <span className="tabular-nums">{fmtDateTime(e.at)}</span>
                    {e.source && <span className="font-mono break-all">{e.source}</span>}
                  </div>
                  <div className="mt-1 text-xs text-zinc-700 leading-5 break-words">{e.message}</div>
                  {e.detail && (
                    <pre className="mt-1 max-h-32 overflow-auto rounded-lg bg-zinc-50 p-2 text-[10px] leading-4 text-zinc-500 whitespace-pre-wrap break-all">
                      {e.detail}
                    </pre>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </PageSection>

      {/* 关于 */}
      <PageSection icon={<IconShield />} title="关于 workbuddy控制台">
        <Card className="p-5 text-xs text-zinc-400 leading-relaxed space-y-1.5">
          <div className="flex items-center gap-2">
            <div className="font-medium text-zinc-600 text-sm">WorkBuddy 一体化管理工具</div>
            {/* 版本号取自服务端 package.json，前端不再硬编码（发版忘了改这里就再也对不上了） */}
            <Badge color="gray">{updateInfo ? `v${updateInfo.current}` : '版本读取中'}</Badge>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-2.5">
            {updateInfo?.hasUpdate ? (
              <>
                <Badge color="green">发现新版本 v{updateInfo.latest}</Badge>
                <a
                  href={updateInfo.downloadUrl || updateInfo.releaseUrl || '#'}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-7 items-center gap-1 rounded-xl border border-indigo-300 px-2.5 text-[11px] font-medium text-indigo-600 transition-colors hover:bg-indigo-50"
                >
                  <IconDownload className="w-3.5 h-3.5" />
                  下载安装包
                </a>
              </>
            ) : (
              <Badge color="gray">{updateInfo?.error ? '版本状态未知' : '已是最新版本'}</Badge>
            )}
            <Button size="sm" onClick={() => loadUpdateInfo(true)} loading={checkingUpdate}>
              {!checkingUpdate && <IconRefresh className="w-3.5 h-3.5" />}
              检查更新
            </Button>
            <Switch
              checked={!!settings?.autoCheckUpdate}
              onChange={(v) =>
                toggleBoolSetting('autoCheckUpdate', v, {
                  on: '已开启自动检查更新',
                  off: '已关闭自动检查更新（仍可手动点「检查更新」）',
                })
              }
              onText="启动时自动检查"
              offText="已关闭自动检查"
            />
          </div>

          {updateInfo?.error && <div className="text-amber-600">{updateInfo.error}</div>}
          {!!updateInfo?.checkedAt && !updateInfo.error && (
            <div className="text-zinc-300">
              上次检查：{fmtDateTime(updateInfo.checkedAt)}
              {updateInfo.cached ? '（本地缓存，6 小时内不重复请求）' : ''}
            </div>
          )}
          <div>
            主要能力：账号切换（扫码登录 / 切换 / 备份恢复）· Token 统计 · 积分统计 ·
            免费模型广场（免费模型 / 平台额度 / API Keys）·
            反向代理（让其他 agent 按 OpenAI / Anthropic / Responses / Gemini 四种协议调用 WorkBuddy 的积分与模型）。
          </div>
          <div>
            目标应用：<span className="text-zinc-500">WorkBuddy</span>（数据目录 {settings?.detected?.dir || '~/.workbuddy'}）。
          </div>
          <div>
            当前可用平台：OpenRouter、Agnes AI、硅基流动、魔搭；地区受限平台（Groq、Google AI Studio、NVIDIA、GitHub Models、OpenCode Zen）仅在免费模型展示，不可浏览与载入。
          </div>
          <div className="flex items-start gap-1.5">
            <IconShield className="w-3.5 h-3.5 mt-px shrink-0 text-emerald-500" />
            <span>隐私：API Key、账号凭据与统计数据均只保存在本机，不经过任何第三方服务器；界面访问仅限 127.0.0.1。</span>
          </div>
          <div className="text-zinc-300">备份与账号库与 workbuddy-switch 共用 ~/.wb-switch，可同时安装、随时切换。</div>
        </Card>
      </PageSection>
    </div>
  );
}
