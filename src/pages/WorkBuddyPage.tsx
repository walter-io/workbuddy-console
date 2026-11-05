import { Card, IconChart, IconSettings, IconSwitch, IconUsers, IconWallet, Segmented } from '../components/ui';
import AccountsPage from './AccountsPage';
import StatsPage from './StatsPage';
import CreditStatsPage from './CreditStatsPage';
import ProxyPage from './ProxyPage';
import WorkBuddySettingsPage from './WorkBuddySettingsPage';

/**
 * WorkBuddy 管理页：把五件 WorkBuddy 专属的事合并到一个入口。
 *
 * 控制台正在变成多平台工具（免费模型、全网签到都是跨平台的），WorkBuddy
 * 专属的功能收拢到一起，顶层导航才分得清「管 WorkBuddy」还是「管其他平台」。
 *
 * 各个子视图**保持挂载**（非当前 tab 只隐藏）：切回来不重新拉数据、不丢筛选
 * 与滚动位置，和平台页 / App 顶级页签的挂载策略一致。
 */
export type WorkBuddyTab = 'accounts' | 'stats' | 'credits' | 'proxy' | 'wbsettings';

const WB_TABS = [
  { value: 'accounts' as const, label: '账号切换' },
  { value: 'stats' as const, label: 'Token 统计' },
  { value: 'credits' as const, label: '积分统计' },
  { value: 'proxy' as const, label: '反向代理' },
  { value: 'wbsettings' as const, label: 'WorkBuddy 设置' },
];

export default function WorkBuddyPage({
  tab,
  onTabChange,
}: {
  tab: WorkBuddyTab;
  onTabChange: (t: WorkBuddyTab) => void;
}) {
  return (
    <div className="space-y-5">
      <Card className="p-3.5 flex flex-wrap items-center gap-x-4 gap-y-3">
        <Segmented<WorkBuddyTab> value={tab} onChange={onTabChange} options={WB_TABS} />
        <div className="flex items-center gap-2 text-xs text-zinc-400 min-w-0">
          {tab === 'accounts' && (
            <>
              <IconUsers className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">管理 WorkBuddy 账号，一键切换登录态</span>
            </>
          )}
          {tab === 'stats' && (
            <>
              <IconChart className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">本地解析会话日志，统计 Token 消耗与缓存命中</span>
            </>
          )}
          {tab === 'credits' && (
            <>
              <IconWallet className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">官方逐请求用量：余额、每日趋势与模型分布</span>
            </>
          )}
          {tab === 'proxy' && (
            <>
              <IconSwitch className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">让其他 agent 按 OpenAI / Anthropic / Responses / Gemini 协议调用 WorkBuddy</span>
            </>
          )}
          {tab === 'wbsettings' && (
            <>
              <IconSettings className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">运行状态重启 · 每日签到与成长中心 · 凭据维护 · 目录与备份</span>
            </>
          )}
        </div>
      </Card>

      <div className={tab === 'accounts' ? '' : 'hidden'}>
        <AccountsPage />
      </div>
      <div className={tab === 'stats' ? '' : 'hidden'}>
        <StatsPage />
      </div>
      <div className={tab === 'credits' ? '' : 'hidden'}>
        <CreditStatsPage />
      </div>
      <div className={tab === 'proxy' ? '' : 'hidden'}>
        <ProxyPage />
      </div>
      <div className={tab === 'wbsettings' ? '' : 'hidden'}>
        <WorkBuddySettingsPage />
      </div>
    </div>
  );
}
