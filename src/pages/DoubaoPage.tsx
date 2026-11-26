/**
 * 豆包管理（独立菜单）：把「豆包」从全网签到里抽出来做成一个专属入口。
 *
 * 豆包是桌面客户端类平台（engine=client-cdp），签到靠接管已登录的客户端完成，
 * 所以这个页面除了通用的签到详情外，额外提供「启动客户端 / 重启客户端」按钮——
 * 客户端不在运行时 CDP 接管会失败，这是用户最常卡住的一步。
 *
 * 数据与操作全部复用全网签到的通用接口（/api/netcheckin/*），不新增私有数据链路；
 * 全网签到页里的豆包入口照常保留，两个入口读同一份状态、互不影响。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Hint,
  IconExternalLink,
  IconRefresh,
  IconSettings,
  IconSwitch,
  IconUsers,
  IconZap,
  Note,
  PageSection,
  Segmented,
  useToast,
} from '../components/ui';
import { get, post } from '../lib/api';
import { fmtDateTime, fmtRelative } from '../lib/format';
import {
  type LoginStatus,
  type NetPlatform,
  type NetState,
  STATUS_LABEL,
  statusTextCls,
} from '../lib/netcheckin';
import NetPlatformDetail from './NetPlatformDetail';

const DOUBAO_ID = 'doubao';

/** 豆包管理页页签：每日领取（签到）+ 客户端 */
export type DoubaoTab = 'checkin' | 'client';

const DOUBAO_TABS = [
  { value: 'checkin' as const, label: '每日领取' },
  { value: 'client' as const, label: '客户端' },
];

export default function DoubaoPage() {
  const toast = useToast();
  const [state, setState] = useState<NetState | null>(null);
  const [login, setLogin] = useState<LoginStatus | null>(null);
  // 关闭客户端的等待态（温和关闭+等进程树拆干净，最长约 35 秒）
  const [stopping, setStopping] = useState(false);
  /** 页签：每日领取 / 客户端 */
  const [tab, setTab] = useState<DoubaoTab>('checkin');

  // 状态版本号守卫：与全网签到页同一套逻辑，丢弃乱序到达的旧轮询响应
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

  // 后台标签页节流：切回本页立刻补拉一次，别等下一个轮询
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  // 只在豆包执行中 / 登录窗口开着时 2 秒轮询，空闲 30 秒兜底
  const doubao: NetPlatform | null = state?.platforms.find((p) => p.id === DOUBAO_ID) || null;
  const active = Boolean(state?.activeIds?.includes(DOUBAO_ID)) || login?.stage === 'waiting';
  useEffect(() => {
    const t = setInterval(async () => {
      const s = await get<NetState>('/api/netcheckin/state').catch(() => null);
      if (s) applyState(s);
    }, active ? 2_000 : 30_000);
    return () => clearInterval(t);
  }, [active, applyState]);

  // 登录窗口状态轮询：豆包是客户端类，正常不会走网页扫码登录；保留只为兼容将来的登录入口
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
      toast('info', opts?.dryRun ? '豆包检测已开始，结论出来自动标在页面上' : '豆包签到已开始，会先接管客户端，结果出来自动更新');
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

  /** 启动豆包客户端：只拉起进程，不接管、不签到。已在运行时引擎会给出提示，不重复开。 */
  const openClient = async () => {
    try {
      const r = await post<{ status: string; detail: string }>('/api/netcheckin/open-client', { id: DOUBAO_ID });
      if (r.status === 'uncertain') toast('info', r.detail);
      else toast('ok', r.detail || '已发出启动指令');
      refresh();
    } catch (e: any) {
      toast('err', e?.message || '启动客户端失败');
    }
  };

  /** 关闭豆包客户端：先温和关窗口、超时再强杀，并等进程树拆干净（与签到引擎同一套退出逻辑）。
   *  客户端残留是 CDP 接管失败的常见原因，关闭后下次「立即领取」就是干净状态。 */
  const closeClient = async () => {
    setStopping(true);
    try {
      const r = await post<{ ok: boolean; detail: string }>('/api/netcheckin/close-client', { id: DOUBAO_ID });
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
      {/* 页签头：与 ZCode 管理同款（Segmented + 右侧说明） */}
      <Card className="p-3.5 flex flex-wrap items-center gap-x-4 gap-y-3">
        <Segmented<DoubaoTab> value={tab} onChange={setTab} options={DOUBAO_TABS} />
        <div className="flex items-center gap-2 text-xs text-zinc-400 min-w-0">
          {tab === 'checkin' && (
            <>
              <IconZap className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">「免费用豆包」活动额度：领取状态、连续天数与执行记录</span>
            </>
          )}
          {tab === 'client' && (
            <>
              <IconSettings className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">启动 / 关闭豆包桌面客户端，保持登录可用</span>
            </>
          )}
        </div>
      </Card>

      {/* 客户端页签：豆包专属，全网签到页没有这一块 */}
      <div className={tab === 'client' ? '' : 'hidden'}>
      <Card className="p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-rose-50 text-rose-600 flex items-center justify-center text-base font-semibold shrink-0">豆</div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[15px] font-semibold text-zinc-900">豆包客户端</span>
              {doubao?.clientExe ? (
                <Badge color={doubao.clientRunning ? 'green' : 'gray'} dot>
                  {doubao.clientRunning ? '运行中' : '未运行'}
                </Badge>
              ) : (
                <Badge color="amber">未找到主程序</Badge>
              )}
              {active && <Badge color="blue" dot>执行中</Badge>}
            </div>
            <div className="text-xs text-zinc-400 mt-0.5">
              {doubao?.clientExe
                ? `主程序：${doubao.clientExe}`
                : '先在常规目录安装豆包桌面版，或把 exe 路径填进 ~/.free-token/checkin/config.json 的 platforms.doubao.app'}
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
          豆包签到靠接管<strong>已登录</strong>的桌面客户端完成。若客户端未运行或登录失效，「立即领取」会失败——先点「启动客户端」，
          在客户端里登录一次，回到「每日领取」页签点「立即领取」即可。客户端已在运行时启动按钮只会给出提示，不会重复拉起。
        </Hint>
      </Card>
      </div>

      {/* 每日领取页签：复用全网签到的平台详情页（状态、积分、连续天数、14 天矩阵、领取记录） */}
      <div className={tab === 'checkin' ? '' : 'hidden'}>
      <NetPlatformDetail
        id={DOUBAO_ID}
        state={state}
        trial={state?.trial?.[DOUBAO_ID] || undefined}
        login={login}
        showBack={false}
        onBack={() => {}}
        onRefresh={refresh}
        onRun={startRun}
        onToggle={togglePlatform}
        onLogin={startLogin}
        onCancelLogin={cancelLogin}
      />
      </div>

      {/* 最近一次执行详情单独强调，方便一眼判断要不要重跑 */}
      {tab === 'checkin' && doubao?.lastTs && (
        <PageSection icon={<IconExternalLink />} title="最近一次执行" desc={fmtRelative(doubao.lastTs)}>
          <Card className="p-4 space-y-1 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className={statusTextCls(doubao.lastStatus)}>{STATUS_LABEL[doubao.lastStatus || ''] || doubao.lastStatus}</span>
              <span className="text-xs text-zinc-400">{fmtDateTime(doubao.lastTs)}</span>
            </div>
            {doubao.lastDetail && <div className="text-xs text-zinc-600 break-all">{doubao.lastDetail}</div>}
          </Card>
        </PageSection>
      )}

      <Note tone="amber" title="关于两个入口">
        「豆包管理」是独立菜单，「全网签到 → 豆包页签」是原入口，两者读同一份状态、同一份领取记录。在任意一边签到，另一边刷新后都会同步。
      </Note>
    </div>
  );
}