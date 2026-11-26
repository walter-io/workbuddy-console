import { Card, IconChart, IconSettings, IconSwitch, IconUsers, IconWallet, Note, Segmented } from '../components/ui';
import ZCodeAccountsPage from './zcode/ZCodeAccountsPage';
import ZCodeStatsPage from './zcode/ZCodeStatsPage';
import ZCodeQuotaPage from './zcode/ZCodeQuotaPage';
import ZCodeProxyPage from './zcode/ZCodeProxyPage';
import ZCodeSettingsPage from './zcode/ZCodeSettingsPage';

/** ZCode 专属功能统一入口；子页保持挂载，切换页签时不丢状态。 */
export type ZCodeTab = 'accounts' | 'stats' | 'quota' | 'proxy' | 'zsettings';

const ZCODE_TABS = [
  { value: 'accounts' as const, label: '账号切换' },
  { value: 'stats' as const, label: 'Token 统计' },
  { value: 'quota' as const, label: '额度统计' },
  { value: 'proxy' as const, label: '反向代理' },
  { value: 'zsettings' as const, label: 'ZCode 设置' },
];

export default function ZCodePage({
  tab,
  onTabChange,
}: {
  tab: ZCodeTab;
  onTabChange: (t: ZCodeTab) => void;
}) {
  return (
    <div className="space-y-5">
      <Card className="p-3.5 flex flex-wrap items-center gap-x-4 gap-y-3">
        <Segmented<ZCodeTab> value={tab} onChange={onTabChange} options={ZCODE_TABS} />
        <div className="flex items-center gap-2 text-xs text-zinc-400 min-w-0">
          {tab === 'accounts' && (
            <>
              <IconUsers className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">管理 ZCode 账号，一键切换登录态</span>
            </>
          )}
          {tab === 'stats' && (
            <>
              <IconChart className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">读取 ZCode 本地数据库，统计 Token 消耗与缓存命中</span>
            </>
          )}
          {tab === 'quota' && (
            <>
              <IconWallet className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">官方免费套餐额度：余额、到期时间与各额度桶</span>
            </>
          )}
          {tab === 'proxy' && (
            <>
              <IconSwitch className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">让其他 agent 按 OpenAI 协议调用 ZCode（免 key，用本机登录账号的免费额度）</span>
            </>
          )}
          {tab === 'zsettings' && (
            <>
              <IconSettings className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">运行状态 · 客户端开关 · 凭据维护 · 目录</span>
            </>
          )}
        </div>
      </Card>

      <Note tone="amber" title="官方免费活动已结束">
        ZCode 官方的免费赠送活动已下线，不再发放新的活动额度；此前已到账的额度仍可正常使用，剩余量与到期时间以「额度统计」页签显示为准。
        页面里如出现领取入口失效或赠送额度不再更新，属正常现象，不是本工具故障。
      </Note>

      <div className={tab === 'accounts' ? '' : 'hidden'}>
        <ZCodeAccountsPage />
      </div>
      <div className={tab === 'stats' ? '' : 'hidden'}>
        <ZCodeStatsPage />
      </div>
      <div className={tab === 'quota' ? '' : 'hidden'}>
        <ZCodeQuotaPage />
      </div>
      <div className={tab === 'proxy' ? '' : 'hidden'}>
        <ZCodeProxyPage />
      </div>
      <div className={tab === 'zsettings' ? '' : 'hidden'}>
        <ZCodeSettingsPage />
      </div>
    </div>
  );
}
