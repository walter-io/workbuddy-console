export type OutputKind = 'text' | 'image' | 'video';

export interface ORModel {
  id: string;
  platform?: string;
  name: string;
  vendor: string;
  created: number | null;
  description: string;
  contextLength: number | null;
  pricing: { prompt: number | null; completion: number | null; request: number | null; image: number | null } | null;
  inputModalities: string[];
  outputModalities: string[];
  supportedParameters: string[];
  isFree: boolean;
  outputKind: OutputKind;
  supportsTools: boolean;
  supportsReasoning: boolean;
  supportsImageInput: boolean;
  /** false = 协议不兼容等原因不可载入 WorkBuddy（缺省视为可载入） */
  loadable?: boolean;
}

export interface ModelsResponse {
  fetchedAt: number;
  count: number;
  models: ORModel[];
  platform?: string;
  platformName?: string;
  note?: string | null;
  /** 备注里「参考教程」四个字指向的外链（无则按纯文本渲染） */
  tutorialUrl?: string | null;
}

export interface PlatformInfo {
  id: string;
  name: string;
  shortName: string;
  site: string;
  /** 该平台创建/管理 API Key 的入口页 */
  keyUrl: string | null;
  keyPlaceholder: string | null;
  modelsPublic: boolean;
  quotaKind: 'openrouter' | 'balance' | 'none';
  note: string | null;
  /** 备注里「参考教程」四个字指向的外链（无则按纯文本渲染） */
  tutorialUrl?: string | null;
  /** 平台默认 base URL（导出配置时展示用） */
  baseUrl?: string | null;
  keyCount?: number;
  modelCount?: number | null;
  /** 置灰原因：region = 地区受限；platform = 平台限制外部使用；null = 正常可用 */
  uiDisabled?: 'region' | 'platform' | null;
  /**
   * 平台本身的限制原因（不受设置影响，恒为真实原因）。
   * 设置里勾了「显示全部平台」时 uiDisabled 会被清空，但 restriction 仍保留——
   * 界面据此常驻「可能被限制」的风险提示。
   */
  restriction?: 'region' | 'platform' | null;
}

/** 导出给其他 agent 的单条模型配置（即 OpenAI 兼容的"自定义模型"条目） */
export interface ExportEntry {
  id: string;
  name: string;
  vendor: string;
  url: string;
  /** 点了「显示」才有值，否则为 null */
  apiKey: string | null;
  supportsToolCall: boolean;
  supportsImages: boolean;
  supportsReasoning: boolean;
  useCustomProtocol: boolean;
  outputKind: OutputKind;
}

export interface ExportResponse {
  platform: string;
  platformName: string;
  baseUrl: string | null;
  protocol: string;
  chatPath: string;
  /** Key 的脱敏尾巴，始终有值 */
  masked: string;
  apiKey: string | null;
  entries: ExportEntry[];
  skipped: { id: string; reason: string }[];
}

export interface FreeDailyRequests {
  used: number;
  limit: number;
  remaining: number;
}

export interface KeyQuota {
  keyId: string;
  platform: string;
  label: string;
  masked: string;
  status: 'ok' | 'invalid' | 'error' | 'unknown';
  error?: string;
  /** 该平台未提供额度查询接口时的提示 */
  note?: string | null;
  unavailable?: string | null;
  freeModelDailyRequests?: FreeDailyRequests | null;
  usage?: number | null;
  usageDaily?: number | null;
  usageWeekly?: number | null;
  usageMonthly?: number | null;
  limit?: number | null;
  limitRemaining?: number | null;
  isFreeTier?: boolean;
  expiresAt?: string | null;
  credits?: { total: number | null; used: number | null } | null;
  /** 余额型平台的余额信息（单位见平台说明） */
  balance?: { total: number | null; charge: number | null; gift: number | null } | null;
}

export interface PlatformQuotaGroup {
  platform: string;
  platformName: string;
  quotaKind: 'openrouter' | 'balance' | 'none';
  note: string | null;
  /** 备注里「参考教程」四个字指向的外链（无则按纯文本渲染） */
  tutorialUrl?: string | null;
  keys: KeyQuota[];
}

export interface QuotaResponse {
  fetchedAt: number;
  activeKeys: Record<string, string | null>;
  platforms: PlatformQuotaGroup[];
}

export interface KeyInfo {
  id: string;
  platform: string;
  label: string;
  masked: string;
  addedAt: number;
  lastStatus?: string | null;
  /** 多节点平台（如 Agnes 双站）：该 key 鉴权通过的实际 API 节点；null = 平台默认节点 */
  baseUrl?: string | null;
}

export interface KeysResponse {
  activeKeys: Record<string, string | null>;
  activeKeyId?: string | null;
  keys: KeyInfo[];
  configFile: string;
}

export interface LoadedEntry {
  id: string;
  name: string;
  platform: string;
  keyTail: string;
  supportsToolCall: boolean;
  supportsImages: boolean;
  supportsReasoning: boolean;
}

export interface LoadedInfo {
  exists: boolean;
  invalid?: boolean;
  dir: string;
  modelsJsonPath: string;
  loaded: LoadedEntry[];
  running?: boolean;
  exePath?: string | null;
  /** 进程探测本身失败时的原因（非空表示状态不可信，不能断定"未运行"） */
  detectError?: string | null;
  /** 探测方式：powershell / tasklist / pgrep */
  detectMethod?: string | null;
  /** 降级探测导致的能力缺失说明（例如拿不到启动时间） */
  detectWarning?: string | null;
  /** 检测到的同名进程数（Electron 应用会有多个） */
  processCount?: number | null;
  modelsJsonMtime?: number | null;
  pendingRestart?: boolean;
}

export interface LoadResult {
  added: number;
  updated: number;
  backup: string | null;
  total: number;
  keyUsed: string;
  skipped: { id: string; reason: string }[];
}

export interface StatsBucket {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** 思考 token（output 的子集） */
  thinking: number;
  /**
   * 展示总量。口径：input 已包含 cacheRead，所以 total = input + output + cacheWrite，
   * 不再重复累加缓存命中。uncachedInput 才是真正新读入的输入。
   */
  total: number;
  /** input - cacheRead，下溢饱和为 0 */
  uncachedInput: number;
  /** cacheRead / input；input 为 0 时为 null */
  cacheHitRate: number | null;
  /** max(0, output - thinking)，纯回复量 */
  reply: number;
}

export interface SessionStat extends StatsBucket {
  sessionId: string;
  title: string;
  project: string;
  lastActive: number | null;
  topModels: { model: string; tokens: number }[];
  /** 所属档位（多档位合并统计时用于归类） */
  variant?: 'cn' | 'ai';
  variantLabel?: string;
}

export interface StatsResponse {
  range: string;
  modelFilter: string | null;
  /** 本次统计的档位口径：all / cn / ai */
  variantFilter?: 'all' | 'cn' | 'ai';
  generatedAt: number;
  dir: string;
  /** 每个档位的扫描根与分档汇总（全部视图下展示"归类"用） */
  dirs?: { variant: 'cn' | 'ai'; label: string; dir: string }[];
  variants?: (StatsBucket & { variant: 'cn' | 'ai'; label: string; dir: string; filesScanned: number; filesSkipped: number })[];
  filesScanned: number;
  filesSkipped?: number;
  parseErrors: number;
  coverageStartAt: number | null;
  coverageEndAt: number | null;
  summary: StatsBucket;
  models: (StatsBucket & { name: string })[];
  projects: (StatsBucket & { name: string })[];
  sessions: SessionStat[];
  daily: (StatsBucket & { date: string; byModel: Record<string, number> })[];
  hours: Record<string, number>;
}

/* ---------------- 账号管理 ---------------- */

export interface AccountInfo {
  id: string;
  uid: string;
  name: string;
  email: string | null;
  nickname: string | null;
  note: string | null;
  displayField: 'auto' | 'note' | 'phone';
  domain: string;
  variant: 'cn' | 'ai';
  variantLabel: string;
  enterpriseName: string | null;
  createdAt: number | null;
  refreshedAt: number | null;
  expiresAt: number | null;
  refreshExpiresAt: number | null;
  /** 是否持有未过期的明文 access_token（决定能否切换） */
  hasPlainToken: boolean;
  expired: boolean;
  /** token 为 WorkBuddy 5.6 加密信封：不可作为可切换凭据 */
  hasEnvelope: boolean;
  /** token 尾号，完整值永不返回前端 */
  masked: string;
  /**
   * 最近一次**服务端验活**结论（添加账号时立刻验一次，之后由定时巡检每 6 小时刷新）。
   * 本地 expiresAt 只说明"没到时间"，不代表服务端还认——界面以这个为准。
   */
  verify?: CredentialVerifyState | null;
  /**
   * 官方风控限制记录（11140「异常活动受限」/11128），由代理链路捕获。
   * 有值 = 该账号已被官方标记：停止一切自动化并考虑申诉。
   */
  restriction?: { code: number; at: number } | null;
}

/** 服务端验活结论（不含任何 token） */
export interface CredentialVerifyState {
  at: number;
  valid: boolean;
  /** 官方明确拒绝（401/403）：token 已被轮换/吊销，只能重新登录 */
  unauthorized: boolean;
  message: string;
}

export interface VariantInfo {
  id: string;
  label: string;
  authFilePath: string;
  dataRoot: string;
}

/* ---------------- OAuth 扫码登录 ---------------- */

/** 发起扫码登录：官方验证链接（前端本地渲染二维码，不外传） */
export interface OAuthStartResult {
  loginId: string;
  verificationUri: string;
  /** state 有效期（秒） */
  expiresIn: number;
}

/** 轮询扫码结果：done=false 表示尚未扫码；result 为采集入库的账号摘要 */
export interface OAuthPollResult {
  done: boolean;
  result?: AccountInfo;
  error?: string;
  /** 未完成时的官方状态码 / 文案（如 11217「login ing…」），用于界面解释"卡在哪一步" */
  code?: number | null;
  message?: string;
  /** 服务端已轮询次数 */
  pollCount?: number;
}

export interface AccountsResponse {
  accounts: AccountInfo[];
  current: {
    variant: string;
    uid: string | null;
    exists: boolean;
    authFilePath: string | null;
    account: AccountInfo | null;
    warning: string | null;
  };
  variants: VariantInfo[];
}

/* ---------------- 会话（对话记录）复制 ---------------- */

/** 会话列表里的一条：源是当前登录账号，目标是选中的账号 */
export interface SessionRow {
  id: string;
  /** 展示名：优先用户改名（custom_title），否则自动标题 */
  title: string;
  cwd: string;
  /** 工作区名（cwd 末段），用于分组与搜索 */
  workspace: string;
  status: string;
  updatedAt: number;
  isPlayground: boolean;
  /** 有无正文文件；没有正文的会话不能复制 */
  hasBody: boolean;
  bytes: number;
  /** 目标账号里是否已有这段对话（直接复制或经由其它账号同步过去都算） */
  copied: boolean;
  copiedTo: string | null;
  /** direct=这一对账号直接复制过；family=经其它账号间接同步；null=没有 */
  copiedScope?: 'direct' | 'family' | null;
}

export interface SessionListResponse {
  variant: string;
  sourceUid: string;
  targetUid: string;
  supported: boolean;
  sessions: SessionRow[];
  stats: { total: number; withBody: number; bytes: number };
}

export interface SessionCopyItem {
  id: string;
  newId: string;
  title: string;
  workspace: string;
  bytes: number;
}

/** 退出 WorkBuddy 的结果（`wasRunning=false` 表示本来就没开） */
export interface AppStopResult {
  stopped: boolean;
  wasRunning: boolean;
  killed: number[];
  /** 是否需要强杀（WorkBuddy 关窗会缩到托盘，优雅退出经常不够） */
  forced: boolean;
  exePath: string | null;
}

/** 复制报告：copied 成功 / skipped 账本命中 / errors 逐条原因 */
export interface SessionCopyReport {
  ok: boolean;
  variant: string;
  sourceUid: string;
  targetUid: string;
  /** 搬家：直接过户的会话 */
  moved?: { id: string; title: string; bytes?: number }[];
  /** 搬家：内容已并集合并进目标已有副本的会话 */
  merged?: { sourceId: string; targetId: string; title: string; bytes?: number }[];
  /** 目标账号用户手动删过同一对话 → 跳过不搬（尊重删除） */
  skippedDeleted?: { id: string; title: string; bytes?: number; reason?: string }[];
  /**
   * 「复制」形态的结果。搬家（/api/sessions/move、切换账号里的会话转移）**不返回**这两个字段，
   * 调用方必须按 moved/merged/skippedDeleted 兼容——否则 `report.copied.length` 会抛
   * TypeError，整个弹窗直接崩成白屏（2026-10-25 反馈的「转移会话失败」）。
   */
  copied?: SessionCopyItem[];
  skipped?: { id: string; reason: string; newId?: string }[];
  errors: { id: string; error: string }[];
  /** 搬家后的回读校验：false = 写进去了但没生效（被其它进程回滚） */
  verified?: boolean | null;
  verifyError?: string;
  /**
   * 原位同步到目标账号里那一份的改名。
   * 两个方向都会触发：往返（本账号会话是目标账号某会话的副本）与正向（目标账号里已有旧副本）。
   * `sourceId` = 本次选中的会话，`targetId` = 目标账号里被改名的会话。
   */
  titleSynced?: { sourceId: string; targetId: string; title: string }[];
  /** 原位同步到目标账号里那一份的增量内容（只补对方没有的行，天然幂等） */
  contentSynced?: { sourceId: string; targetId: string; appendedLines: number; bytes: number }[];
  totalBytes: number;
  backupPath: string;
  appStop: AppStopResult | null;
  /** 由路由层补上：本次是否重新打开了被关掉的 WorkBuddy */
  relaunch?: RelaunchResult | null;
  elapsedMs: number;
}

/**
 * 重开 WorkBuddy 的结果。
 * `launched` 只表示"是否成功发起启动"；`verified` 才是"进程真的起来了"——
 * 有些环境（安全软件拦截、启动很慢）只能发起、无法确认，此时带 `warning` 说明。
 */
export interface RelaunchResult {
  launched: boolean;
  exePath?: string;
  error?: string;
  verified?: boolean;
  warning?: string;
}

/** 切换账号的返回：登录态切换结果 + 可选的会话复制报告与进程退出/重开结果 */
export interface SwitchAccountResult {
  ok: boolean;
  backupPath: string | null;
  authFilePath: string;
  variant: string;
  account: AccountInfo;
  needRestart: boolean;
  sessionCopy: SessionCopyReport | null;
  appStop: AppStopResult | null;
  relaunch: RelaunchResult | null;
}

/* ---------------- 积分统计 ---------------- */

/** 单个积分资源包（官方 get-user-resource-summary 的 Packages 项） */
export interface CreditPackage {
  packageCode: string | null;
  /** 展示名：商品码命中官方映射时用映射名，否则回落 PackageName */
  name: string;
  total: number;
  remaining: number;
  used: number;
  /** 到期时刻（毫秒时间戳）；null = 长期有效 */
  expireAt: number | null;
  expired: boolean;
  /** 7 天内到期 */
  expiringSoon: boolean;
}

export interface CreditBalance {
  total: number;
  remaining: number;
  used: number;
  packageCount: number;
  unit: string;
  /** 全部资源包明细（含已用完的），按到期时间升序 */
  packages: CreditPackage[];
  /** 余额最近一次成功查询的时刻 */
  updatedAt: number | null;
}

/** 单笔积分发放记录（官方 paid/free-packages 明细接口，「积分明细」弹窗逐行展示） */
export interface CreditRecord {
  packageCode: string | null;
  name: string;
  /** 到期时刻（毫秒时间戳）；null = 长期有效 */
  expireAt: number | null;
  cycleEnd: number | null;
  /** 该笔的总额度（周期口径优先，单笔口径兜底） */
  total: number;
  used: number;
  remaining: number;
  createTime: number | null;
  expired: boolean;
}

export interface CreditDetailsResponse {
  accountId: string;
  accountName: string;
  variant: string;
  collectedAt: number;
  records: CreditRecord[];
  cached?: boolean;
}

export interface CreditAccountRow {
  accountId: string;
  accountName: string;
  variant: string;
  variantLabel: string;
  requests: number;
  credit: number;
  balance: CreditBalance | null;
  balanceError: string | null;
  error: string | null;
  unauthorized?: boolean;
}

export interface CreditRequestRow {
  requestId: string;
  ts: number;
  date: string;
  time: string;
  model: string;
  client: string;
  credit: number;
  accountId: string;
  accountName: string;
  variant: string;
  variantLabel: string;
}

export interface CreditResponse {
  /** 缓存结构标识（本工具专用缓存文件） */
  schema?: string;
  /** 本次统计的档位口径：all / cn / ai */
  variantFilter?: 'all' | 'cn' | 'ai';
  status: 'complete' | 'partial' | 'error';
  collectedAt: number;
  rangeStart: string;
  rangeEnd: string;
  days: number;
  detailLimitPerAccount: number;
  summary: {
    usageToday: number;
    usage7Days: number;
    usageThisMonth: number;
    totalRequests: number;
  };
  accounts: CreditAccountRow[];
  daily: { date: string; credit: number; requests: number; byModel: Record<string, number> }[];
  models: { model: string; credit: number; requests: number }[];
  /** 按档位分流的消耗合计（全部视图下展示"归类"用） */
  variantTotals?: { variant: 'cn' | 'ai'; credit: number; requests: number }[];
  requests: CreditRequestRow[];
  errors: { accountId: string; accountName: string; variant: string; error: string }[];
  cached?: boolean;
}

/** 单个账号的积分余额行（/api/accounts/credits） */
export interface AccountBalanceRow {
  accountId: string;
  accountName: string;
  variant: string;
  variantLabel: string;
  balance: CreditBalance | null;
  balanceError: string | null;
  error: string | null;
  /** 官方接口明确拒绝了这个 token（401/403）：凭据已失效，需重新登录，本地有效期不算数 */
  authInvalid?: boolean;
}

export interface AccountBalancesResponse {
  collectedAt: number;
  accounts: AccountBalanceRow[];
  errors: { accountId: string; accountName: string; variant: string; error: string }[];
  cached?: boolean;
}

export interface WorkbuddyDetection {
  dir: string;
  source: 'override' | 'default' | 'scan';
  sourceLabel: string;
  valid: boolean;
  markers: {
    modelsJson: boolean;
    projects: boolean;
    sessions: boolean;
    db: boolean;
    score: number;
    exists: boolean;
  };
}

export interface DetectResult {
  detected: WorkbuddyDetection;
  running: boolean;
  exePath: string | null;
  detectError?: string | null;
  detectMethod?: string | null;
}

export interface PlatformCacheInfo {
  platform: string;
  platformName: string;
  fetchedAt: number;
  count: number;
}

export interface SettingsInfo {
  workbuddyDir: string;
  /** 客户端**安装**目录（与上面的数据目录不是一回事），用于「切换后自动重新打开」 */
  workbuddyInstallDir: string;
  /** 直接指定的客户端 exe 绝对路径（优先级最高） */
  workbuddyExePath: string;
  /** 自动定位到的客户端 exe；null = 没找到（此时切换后无法自动重新打开） */
  detectedExe: string | null;
  proxyUrl: string;
  /** 自动签到（仅国内版账号，服务端每小时巡检一次） */
  autoCheckin: boolean;
  /** 凭据自动刷新（服务端每 6 小时巡检一次，只在临期时才刷新） */
  autoRefreshToken: boolean;
  /** 启动时检查新版本（唯一一处访问非官方服务的出站请求） */
  autoCheckUpdate: boolean;
  /** 免费模型页是否列出全部平台（含地区受限 / 平台禁止外部接入的）；默认只列可用的 */
  unlockAllPlatforms: boolean;
  effectiveProxy: string | null;
  detected: WorkbuddyDetection;
  cacheDir: string;
  modelsCaches: PlatformCacheInfo[];
}

/* ---------------- 版本自检 ---------------- */

/** 版本自检结果；`hasUpdate` 只在远端版本**严格新于**本机时才为 true */
export interface AppUpdateInfo {
  ok: boolean;
  /** 设置里关掉了自动检查（手动检查不受影响） */
  disabled?: boolean;
  /** 本机版本（取自 package.json） */
  current: string;
  latest: string | null;
  tagName?: string | null;
  hasUpdate: boolean;
  releaseUrl: string | null;
  downloadUrl: string | null;
  assetName: string | null;
  publishedAt: number | null;
  notes: string;
  checkedAt: number | null;
  /** 结果来自磁盘缓存（未重新请求） */
  cached: boolean;
  /** 用了上一次的成功缓存（本次请求失败） */
  stale?: boolean;
  error: string | null;
}

/* ---------------- 凭据刷新 ---------------- */

/** 单个账号的刷新判定 */
export interface AccountRefreshPlan {
  id: string;
  uid: string;
  name: string;
  variant: 'cn' | 'ai';
  /** 剩余小时数；null = 账号里没有这个有效期字段 */
  accessHours: number | null;
  refreshHours: number | null;
  hasRefreshToken: boolean;
  hasPlainAccess: boolean;
  /** refresh_token 已过期或无机密凭据：只能重新扫码 */
  dead: boolean;
  due: boolean;
  /** 是否就是 WorkBuddy 当前登录账号（由官方客户端自行维护，不自动刷新） */
  current?: boolean;
  reason:
    | 'ok'
    | 'access-expiring'
    | 'refresh-expiring'
    | 'dead'
    | 'unknown-expiry'
    | 'no-refresh-token'
    | 'manual'
    | 'current';
  /** 最近一次服务端验活结论（定时巡检写入） */
  verify?: CredentialVerifyState | null;
}

export interface AccountRefreshRunResult {
  ok: boolean;
  action: 'refreshed' | 'skipped' | 'failed' | 'dead';
  reason: string;
  message: string;
  accountId: string;
  accountName: string;
  variant: 'cn' | 'ai';
  accessHours: number | null;
  refreshHours: number | null;
  before?: { accessHours: number | null; refreshHours: number | null };
}

export interface AccountRefreshResponse {
  autoRefreshToken: boolean;
  intervalHours: number;
  accessMinHours: number;
  refreshMinHours: number;
  accounts: AccountRefreshPlan[];
  lastRun: { at: number; refreshed: number } | null;
  logs: {
    ts: number;
    accountId: string;
    accountName: string;
    variant: 'cn' | 'ai';
    ok: boolean;
    action: string;
    reason: string;
    message?: string;
  }[];
}

export interface AccountRefreshRunResponse {
  ok: boolean;
  results: AccountRefreshRunResult[];
  summary: { total: number; refreshed: number; skipped: number; failed: number; dead: number };
}

/* ---------------- 每日签到与成长中心 ---------------- */

export interface CheckinState {
  account: AccountInfo;
  /** 状态查询是否成功；false 时看 error */
  ok: boolean;
  todayCheckedIn: boolean;
  error?: string | null;
  /** 该档位没有签到能力（国际版） */
  unsupported?: boolean;
  unauthorized?: boolean;
}

/** 成长中心一轮领取的摘要（旅行/任务/补登/兑换/盲盒/Buddy） */
export interface GrowthRunInfo {
  ok: boolean;
  /** 一行式汇报，如「领旅行礼物 +50 积分；开盲盒获得：冰箱贴（能量 12，连签 7 天）」 */
  report: string;
  creditsGained: number;
  hardFailures: number;
}

export interface CheckinLogEntry {
  ts: number;
  accountId: string;
  accountName: string;
  variant: 'cn' | 'ai';
  ok: boolean;
  alreadyCheckedIn: boolean;
  message: string;
  growth?: GrowthRunInfo;
}

export interface CheckinStatusResponse {
  states: CheckinState[];
  logs: CheckinLogEntry[];
}

export interface CheckinRunResult {
  ok: boolean;
  action: 'checked' | 'already' | 'skipped' | 'failed';
  message: string;
  account: AccountInfo;
  growth?: GrowthRunInfo;
}

export interface CheckinAllResult {
  results: CheckinRunResult[];
  summary: {
    total: number;
    checked: number;
    already: number;
    failed: number;
    skipped: number;
    /** 本轮成长中心合计进账积分 */
    growthCredits: number;
    growthHardFailures: number;
  };
}

/* ---------------- 权限自检 ---------------- */

export interface PermissionCheck {
  id: string;
  group: string;
  label: string;
  path: string;
  exists: boolean;
  readable: boolean;
  writable: boolean;
  required: 'read-write';
  hint: string;
  ok: boolean;
}

export interface PermissionResponse {
  ok: boolean;
  platform: string;
  home: string;
  items: PermissionCheck[];
}

/* ---------------- 登录态备份 ---------------- */

export interface BackupEntry {
  name: string;
  path: string;
  size: number;
  mtime: number;
  variant: 'cn' | 'ai' | null;
  variantLabel: string;
  createdAt: number;
}

export interface BackupsResponse {
  dir: string;
  backups: BackupEntry[];
  variants: { id: 'cn' | 'ai'; label: string; authFilePath: string }[];
}

export interface RestoreBackupResult {
  ok: boolean;
  restored: string;
  authFilePath: string;
  safetyBackup: string | null;
  variant: { id: 'cn' | 'ai'; label: string };
}

/* ---------------- 反向代理（OpenAI 兼容） ---------------- */

export interface ProxyAccount {
  id: string;
  name: string;
  uid: string;
  variant: 'cn' | 'ai';
  variantLabel: string;
  /** 是否可用于出站请求（有明文凭据，或凭 refresh_token 可自行换新） */
  usable: boolean;
  expired: boolean;
  expiresAt: number | null;
  selected: boolean;
  /** 是否为桌面端当前登录账号（该账号不参与代理出站，避免上游风控连坐官方客户端） */
  isCurrentLogin: boolean;
  /** 官方风控限制记录（11140/11128），与账号页徽章同源 */
  restriction?: { code: number; at: number } | null;
}

export interface ProxyLog {
  at: number;
  ok: boolean;
  status: number;
  model: string;
  stream: boolean;
  account: string | null;
  ms: number;
  /** 人话版失败原因（上游错误码已翻成中文） */
  error?: string;
  /** 上游错误原文，鼠标悬停看全（已截断到 4000 字） */
  errorRaw?: string;
  /** 调用方 UA —— 用来判断「到底是哪个客户端在用」 */
  ua?: string | null;
  /** Key 的携带方式：bearer / raw / x-api-key / x-goog-api-key / query / none */
  auth?: string | null;
  /** 请求路径（Gemini 的模型名在路径里） */
  path?: string | null;
}

export interface ProxyStatus {
  enabled: boolean;
  baseUrl: string;
  chatUrl: string;
  hasKey: boolean;
  keyPreview: string;
  /** 明文 Key：仅在带 reveal=1 请求时返回，其余为空串 */
  apiKey: string;
  accountIds: string[];
  poolCount: number;
  accounts: ProxyAccount[];
  models: { ids: string[]; fetchedAt: number | null; error: string | null; account: string | null };
  stats: { total: number; ok: number; failed: number; lastAt: number | null };
  logs: ProxyLog[];
}

export interface ProxyTestResult {
  ok: boolean;
  account?: string;
  variant?: string;
  model?: string;
  preview?: string;
  error?: string;
}
