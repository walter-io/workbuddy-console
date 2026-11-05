import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  ConfirmProvider,
  IconDownload,
  IconGrid,
  IconRefresh,
  IconSettings,
  IconShield,
  IconUsers,
  IconWarning,
  IconZap,
  ToastProvider,
} from './components/ui';
import { get } from './lib/api';
import { onUpdateChecked } from './lib/appUpdate';
import PageGuide from './components/PageGuide';
import { GUIDES, type GuideKey } from './lib/guides';
import type { AccountsResponse, AppUpdateInfo, LoadedInfo } from './lib/types';
import SettingsPage from './pages/SettingsPage';
import PlatformPage, { type PlatformTab } from './pages/PlatformPage';
import WorkBuddyPage, { type WorkBuddyTab } from './pages/WorkBuddyPage';
import NetCheckinPage from './pages/NetCheckinPage';

const WB_TABS: WorkBuddyTab[] = ['accounts', 'stats', 'credits', 'proxy'];

const TABS = [
  { id: 'workbuddy', label: 'WorkBuddy 管理', desc: '账号切换 · Token/积分统计 · 反向代理 · WorkBuddy 设置', icon: IconUsers },
  { id: 'platform', label: '免费模型', desc: '免费模型 · 平台额度 · API Keys', icon: IconGrid },
  { id: 'netcheckin', label: '全网签到', desc: '其他 AI 平台的每日福利交给控制台代领', icon: IconZap },
  { id: 'settings', label: '设置', desc: '网络代理 · 全网签到自动领取 · 通知历史 · 界面错误日志 · 关于', icon: IconSettings },
] as const;

type TabId = (typeof TABS)[number]['id'];

/** 旧版地址兼容：曾经是顶级入口的页签，按现在的归属跳到对应子页签 */
const LEGACY_TABS: Record<string, { tab: TabId; platform: PlatformTab; wb: WorkBuddyTab }> = {
  accounts: { tab: 'workbuddy', platform: 'models', wb: 'accounts' },
  models: { tab: 'platform', platform: 'models', wb: 'accounts' },
  quota: { tab: 'platform', platform: 'quota', wb: 'accounts' },
  keys: { tab: 'platform', platform: 'keys', wb: 'accounts' },
  proxy: { tab: 'workbuddy', platform: 'models', wb: 'proxy' },
  stats: { tab: 'workbuddy', platform: 'models', wb: 'stats' },
  credits: { tab: 'workbuddy', platform: 'models', wb: 'credits' },
};

/** 解析当前地址栏 hash → 页签（含子页签，如 #workbuddy/stats）；无法识别时回落到 WorkBuddy 管理 */
function resolveHash(): { tab: TabId; platform: PlatformTab; wb: WorkBuddyTab } {
  const h = location.hash.replace('#', '').replace(/^\/+/, '');
  if (LEGACY_TABS[h]) return LEGACY_TABS[h];
  const [head, sub] = h.split('/');
  if (head === 'workbuddy' && WB_TABS.includes(sub as WorkBuddyTab)) {
    return { tab: 'workbuddy', platform: 'models', wb: sub as WorkBuddyTab };
  }
  return { tab: (TABS.some((t) => t.id === head) ? head : 'workbuddy') as TabId, platform: 'models', wb: 'accounts' };
}

function currentTab(): TabId {
  return resolveHash().tab;
}

/**
 * 左下角：版本号 + 有新版时的升级按钮。
 *
 * 只有远端版本**严格新于**本机时才出现按钮——本机开发版常常领先于已发布的 tag，
 * 按"版本号不相等即有更新"判断会把用户引向一次**降级**安装。版本号本身也取自服务端
 * （package.json），不再在前端硬编码，省掉"发版忘了改这里"的老问题。
 */
function VersionFooter() {
  const [info, setInfo] = useState<AppUpdateInfo | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      get<AppUpdateInfo>('/api/app/update')
        .then((r) => {
          if (alive) setInfo(r);
        })
        .catch(() => {
          /* 检查失败只影响按钮显示，不该在界面上报错 */
        });
    load();
    // 定时复查：服务端每小时主动刷新一次远端版本（见 server/index.mjs 的版本自检巡检），
    // 这里每 10 分钟取一次缓存结果即可——让升级按钮**不重启也能出现**。
    // 原先只在挂载时查一次，常年不关的控制台永远看不到新版本（2026-10-18 用户反馈）。
    const timer = setInterval(load, 10 * 60_000);
    // 设置页点「检查更新」会强制打一次接口，结果通过事件立刻同步过来——
    // 不然用户刚在设置页看到「发现新版本」，左下角却要等最多 10 分钟才长出按钮。
    const off = onUpdateChecked((r) => {
      if (alive) setInfo(r);
    });
    return () => {
      alive = false;
      clearInterval(timer);
      off();
    };
  }, []);

  const target = info?.downloadUrl || info?.releaseUrl || '';
  return (
    <div className="space-y-1.5 border-t border-zinc-100 pt-2.5">
      {/* 第一行：产品名 + 当前版本。两个字段一行刚好，不会被升级按钮挤到换行 */}
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[10px] font-medium tracking-wide text-zinc-300">workbuddy控制台</span>
        <span className="shrink-0 text-[10px] tabular-nums text-zinc-300">{info ? `v${info.current}` : ''}</span>
      </div>
      {/* 第二行：升级按钮独立成通栏胶囊，宽度再窄也不与版本号打架 */}
      {info?.hasUpdate && target && (
        <button
          onClick={() => window.open(target, '_blank', 'noopener')}
          title={`发现新版本 v${info.latest}${info.assetName ? `（${info.assetName}）` : ''}，点击前往下载`}
          className="flex h-5 w-full items-center justify-center gap-1 rounded-full bg-indigo-600 text-[10px] font-medium text-white transition-colors hover:bg-indigo-500"
        >
          <IconDownload className="h-3 w-3 shrink-0" />
          <span className="whitespace-nowrap">升级</span>
        </button>
      )}
    </div>
  );
}

/** 顶栏：当前登录的 WorkBuddy 账号（60s 轮询），点击进「WorkBuddy 管理 → 账号切换」 */
function CurrentAccountChip({ onClick }: { onClick: () => void }) {
  const [data, setData] = useState<AccountsResponse | null>(null);

  useEffect(() => {
    const load = () => get<AccountsResponse>('/api/accounts').then(setData).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  if (!data) return null;
  const cur = data.current;
  if (!cur?.exists) {
    return (
      <button onClick={onClick} title="未检测到 WorkBuddy 登录态，点击前往「WorkBuddy 管理 → 账号切换」">
        <Badge color="amber" dot>
          未登录
        </Badge>
      </button>
    );
  }
  const name = cur.account?.name || `账号 ${cur.uid?.slice(0, 8) ?? ''}`;
  return (
    <button onClick={onClick} title={`当前登录：${name}\n${cur.authFilePath || ''}`}>
      <Badge color="green" dot>
        {name}
      </Badge>
    </button>
  );
}

/** 本地服务在线探测：进程退出/端口被占/代理假死时，明确告知用户而不是让页面一直转圈 */
function ServiceBanner() {
  const [offline, setOffline] = useState(false);
  const [checking, setChecking] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);
  const wasOffline = useRef(false);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const h = await get<{ ok: boolean; desktop?: boolean }>('/api/health', { timeoutMs: 8000 });
      setIsDesktop(!!h.desktop);
      if (wasOffline.current) {
        // 服务恢复：重新加载以刷新所有页面数据
        wasOffline.current = false;
        location.reload();
        return;
      }
      setOffline(false);
    } catch {
      wasOffline.current = true;
      setOffline(true);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    check();
    const t = setInterval(check, 15_000);
    return () => clearInterval(t);
  }, [check]);

  if (!offline) return null;

  return (
    <Card className="px-4 py-3 mb-4 border-red-200 bg-red-50 flex flex-wrap items-center gap-3 animate-fade-in">
      <IconWarning className="w-4 h-4 text-red-500 shrink-0" />
      <div className="text-sm text-red-700 leading-relaxed">
        <b>本地服务已断开</b>
        <span className="text-red-600/90">
          {' '}
          —— 界面数据无法刷新。{' '}
          {isDesktop ? (
            <>请从系统托盘图标右键「退出」后重新打开 workbuddy控制台；若仍无法恢复，请重启应用。</>
          ) : (
            <>
              请在项目目录执行 <span className="font-mono text-xs bg-white/70 rounded px-1 py-0.5">npm start</span> 启动服务，或直接运行{' '}
              <span className="font-mono text-xs bg-white/70 rounded px-1 py-0.5">npm run app</span> 打开桌面应用。
            </>
          )}
        </span>
      </div>
      <div className="ml-auto">
        <Button size="sm" variant="subtle" loading={checking} onClick={check}>
          <IconRefresh className="w-3.5 h-3.5" />
          重新连接
        </Button>
      </div>
    </Card>
  );
}

/** 顶栏：WorkBuddy 进程状态（30s 轮询），有未生效配置时高亮提示 */
function WorkBuddyStatus({ onClick }: { onClick: () => void }) {
  const [info, setInfo] = useState<LoadedInfo | null>(null);

  useEffect(() => {
    const load = () => get<LoadedInfo>('/api/workbuddy/status').then(setInfo).catch(() => {});
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  if (!info) return null;

  if (info.running && info.pendingRestart) {
    return (
      <button onClick={onClick} title="models.json 在 WorkBuddy 运行期间被修改，需重启才会加载最新模型配置">
        <Badge color="amber" dot>
          配置待重启
        </Badge>
      </button>
    );
  }
  // 探测失败时不能断言"未运行"，否则会出现 WorkBuddy 开着却显示未运行
  if (!info.running && info.detectError) {
    return (
      <span title={`无法确认 WorkBuddy 运行状态：${info.detectError}`}>
        <Badge color="amber" dot>
          WorkBuddy 状态未知
        </Badge>
      </span>
    );
  }
  return (
    <span
      title={
        (info.running
          ? `WorkBuddy 正在运行（${info.exePath || '路径未知'}）${info.processCount ? ` · ${info.processCount} 个进程` : ''}`
          : 'WorkBuddy 未运行，载入的模型将在下次启动时生效') + (info.detectWarning ? `\n注意：${info.detectWarning}` : '')
      }
    >
      <Badge color={info.running ? 'green' : 'gray'} dot>
        WorkBuddy {info.running ? '运行中' : '未运行'}
      </Badge>
    </span>
  );
}

export default function App() {
  const initial = resolveHash();
  const [tab, setTab] = useState<TabId>(initial.tab);
  // 平台页子页签：由 App 持有，顶栏入口（如 OpenRouter 额度徽标）才能直接跳到指定子页签
  const [platformTab, setPlatformTab] = useState<PlatformTab>(initial.platform);
  // WorkBuddy 管理页子页签：同理，顶栏账号徽标要能直接跳到「账号切换」
  const [wbTab, setWbTab] = useState<WorkBuddyTab>(initial.wb);
  // 访问过的页签保持挂载（仅隐藏），切换不重新加载数据、不丢筛选状态
  const [visited, setVisited] = useState<Set<TabId>>(() => new Set([initial.tab]));

  useEffect(() => {
    const onHash = () => {
      const r = resolveHash();
      setTab(r.tab);
      if (r.tab === 'platform') setPlatformTab(r.platform);
      if (r.tab === 'workbuddy') setWbTab(r.wb);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    setVisited((v) => (v.has(tab) ? v : new Set(v).add(tab)));
  }, [tab]);

  const go = (id: TabId, sub?: string) => {
    location.hash = sub ? `${id}/${sub}` : id;
    setTab(id);
  };

  /** 跳到平台页的指定子页签（免费模型 / 平台额度 / API Keys） */
  const goPlatform = (sub: PlatformTab) => {
    setPlatformTab(sub);
    go('platform');
  };

  /** 跳到 WorkBuddy 管理页的指定子页签（账号切换 / Token 统计 / 积分统计 / 反向代理） */
  const goWorkBuddy = (sub: WorkBuddyTab) => {
    setWbTab(sub);
    go('workbuddy', sub);
  };

  const meta = TABS.find((t) => t.id === tab)!;

  /**
   * 当前该显示哪份使用指南。
   * 「免费模型」与「WorkBuddy 管理」都是一个入口多个子页签，按各自的子页签细分，
   * 其余页面按 tab 一一对应；WorkBuddy 设置沿用设置页的指南。
   */
  const currentGuide: GuideKey = tab === 'platform' ? platformTab : tab === 'workbuddy' ? (wbTab === 'wbsettings' ? 'settings' : wbTab) : tab;

  return (
    <ToastProvider>
      <ConfirmProvider>
        <div className="h-full flex">
          {/* 侧栏 */}
          <aside className="w-56 shrink-0 bg-white border-r border-zinc-200/80 flex flex-col max-md:hidden">
            <div className="px-4 py-5 flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white flex items-center justify-center shadow-sm shadow-indigo-600/30">
                <IconShield className="w-4.5 h-4.5" />
              </div>
              <div className="min-w-0">
                <div className="font-semibold text-zinc-900 leading-tight">workbuddy控制台</div>
                <div className="text-[11px] text-zinc-400 leading-tight">账号 · 模型 · 用量 · 签到</div>
              </div>
            </div>

            <nav className="px-2.5 mt-1 flex flex-col gap-0.5">
              {TABS.map((t) => {
                const Icon = t.icon;
                const on = tab === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => go(t.id, t.id === 'workbuddy' ? wbTab : undefined)}
                    className={`relative flex items-center gap-2.5 px-3 h-9.5 rounded-xl text-sm transition-all duration-150 ${
                      on ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
                    }`}
                  >
                    {on && <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[3px] rounded-r-full bg-indigo-600" />}
                    <Icon className={`w-4 h-4 transition-colors ${on ? 'text-indigo-600' : 'text-zinc-400'}`} />
                    {t.label}
                  </button>
                );
              })}
            </nav>

            <div className="mt-auto px-3.5 py-4 space-y-2.5">
              <WorkBuddyStatus onClick={() => goPlatform('models')} />
              <div className="text-[11px] text-zinc-400 leading-relaxed">
                数据仅存本机：平台 Key 保存在 <span className="font-mono">~/.free-token</span>，账号保存在{' '}
                <span className="font-mono">~/.wb-switch</span>，模型写入{' '}
                <span className="font-mono">~/.workbuddy/models.json</span>
              </div>
              <VersionFooter />
            </div>
          </aside>

          {/* 主区域 */}
          <div className="flex-1 min-w-0 flex flex-col">
            <header className="h-16 shrink-0 bg-white/85 backdrop-blur border-b border-zinc-200/80 flex items-center px-5 gap-3">
              {/* 小屏导航 */}
              <div className="hidden max-md:flex items-center gap-1 overflow-x-auto">
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => go(t.id, t.id === 'workbuddy' ? wbTab : undefined)}
                    className={`px-3 h-8 rounded-xl text-xs whitespace-nowrap transition-colors ${
                      tab === t.id ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-zinc-500 hover:bg-zinc-100'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              <div className="max-md:hidden min-w-0">
                <div className="text-[15px] font-semibold text-zinc-900 leading-tight">{meta.label}</div>
                <div className="text-xs text-zinc-400 leading-tight mt-0.5 truncate">{meta.desc}</div>
              </div>

              <div className="ml-auto flex items-center gap-2.5 shrink-0">
                {/* 每个功能右上角都有使用指南：内容按当前页（含免费模型的三个子页签）切换 */}
                <PageGuide guide={GUIDES[currentGuide]} />
                <div className="max-md:hidden">
                  <CurrentAccountChip onClick={() => goWorkBuddy('accounts')} />
                </div>
                <div className="max-md:hidden">
                  <WorkBuddyStatus onClick={() => goPlatform('models')} />
                </div>
              </div>
            </header>

            <main className="flex-1 overflow-y-auto">
              <div className="max-w-[1400px] mx-auto p-5">
                <ServiceBanner />
                {[...visited].map((id) => (
                  <div key={id} className={tab === id ? '' : 'hidden'}>
                    {id === 'workbuddy' && <WorkBuddyPage tab={wbTab} onTabChange={setWbTab} />}
                    {id === 'platform' && <PlatformPage tab={platformTab} onTabChange={setPlatformTab} />}
                    {id === 'netcheckin' && <NetCheckinPage />}
                    {id === 'settings' && <SettingsPage />}
                  </div>
                ))}
              </div>
            </main>
          </div>
        </div>
      </ConfirmProvider>
    </ToastProvider>
  );
}