import { get, post, put, TIMEOUT } from './api';

export type ZCodeTimestamp = number | string | null;

export interface ZAccount {
  id: string;
  label: string;
  email: string;
  name: string;
  userId: string;
  provider: string;
  addedAt: number;
  lastAt: number;
}

export type ZCodeAccount = ZAccount;

export interface ZCodeCurrentAccount {
  exists: boolean;
  email?: string;
  name?: string;
  userId?: string;
  provider?: string;
  accountId?: string | null;
  label?: string | null;
  error?: string;
}

export interface ZCodeProcessState {
  running: boolean;
  pids: number[];
  error?: string;
}

export interface ZCodeState {
  accounts: ZAccount[];
  current: ZCodeCurrentAccount;
  process: ZCodeProcessState;
  credentialOk: boolean;
  exe: string | null;
  clientVersion: string | null;
  accountsFile: string;
  switchCooldown: {
    ms: number;
    lastAt: number | null;
  };
}

export interface ZCodeLoginUrlResponse {
  ok: boolean;
  url: string;
  note: string;
}

export interface ZCodeImportResponse {
  ok: boolean;
  account: ZAccount;
  updated: boolean;
}

export interface ZCodeStopResponse {
  ok: boolean;
  remaining?: number;
  error?: string;
  [key: string]: unknown;
}

export interface ZCodeSwitchResponse {
  ok: boolean;
  stopped: ZCodeStopResponse | null;
  result: unknown;
  note: string;
}

export interface ZCodeDeleteResponse {
  ok: boolean;
}

export interface ZCodeRenameResponse {
  ok: boolean;
  account: ZAccount;
}

export interface ZCodeLaunchResponse {
  ok: boolean;
  already?: boolean;
  exe?: string;
}

export interface ZCodeBalancePlan {
  planId: string;
  userPlanId?: string;
  name: string;
  status: string;
  startsAt: ZCodeTimestamp;
  endsAt: ZCodeTimestamp;
}

export interface ZCodeBalanceBucket {
  bucketId: string;
  planId?: string;
  entitlementId?: string;
  name: string;
  capabilities?: string[];
  total: number;
  used: number;
  remaining: number;
  available: number;
  expiresAt: ZCodeTimestamp;
}

export interface ZCodeBalanceCacheEntry {
  plans: ZCodeBalancePlan[];
  balances: ZCodeBalanceBucket[];
  at: number;
  serverTime?: ZCodeTimestamp;
}

export interface ZCodeBalanceSuccess extends ZCodeBalanceCacheEntry {
  ok: true;
  userId: string | null;
  cached: boolean;
}

export interface ZCodeBalanceFailure {
  ok: false;
  error: string;
  userId?: string | null;
  cached: ZCodeBalanceCacheEntry | null;
}

export type ZCodeBalanceResponse = ZCodeBalanceSuccess | ZCodeBalanceFailure;

export interface ZCodeBalanceCacheResponse {
  cache: Record<string, ZCodeBalanceCacheEntry>;
}

export type ZCodeStatsRange = 'today' | '7d' | '30d' | 'all';

export interface ZCodeStatsTotals {
  requests: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface ZCodeStatsDay {
  date: string;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface ZCodeStatsModel {
  model: string;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface ZCodeStatsRecent {
  at: number;
  model: string;
  provider: string;
  status: string;
  input: number;
  output: number;
  cacheRead: number;
  total: number;
  error: string | null;
}

export interface ZCodeStatsResponse {
  available: boolean;
  reason?: string;
  dbFile?: string;
  totals: ZCodeStatsTotals;
  days: ZCodeStatsDay[];
  models: ZCodeStatsModel[];
  recent: ZCodeStatsRecent[];
}

export interface ZCodeProxyStats {
  total: number;
  ok: number;
  failed: number;
  lastAt?: number | null;
  [key: string]: unknown;
}

export interface ZCodeProxyLog {
  at: number;
  model: string;
  ok: boolean;
  ms: number;
  status: number;
  stream?: boolean;
  note?: string;
  error?: string;
  tokens?: unknown;
}

export interface ZCodeModelsResponse {
  models: string[];
  source?: string;
}

export interface ZCodeProxyStatus {
  enabled: boolean;
  apiKeySet: boolean;
  endpoint: string;
  clientVersion: string | null;
  upstream: string;
  credentialChanged: boolean;
  timeoutMs: number;
  minIntervalMs: number;
  stats: ZCodeProxyStats;
  logs: ZCodeProxyLog[];
  models: ZCodeModelsResponse;
}

export interface ZCodeProxyConfigInput {
  enabled?: boolean;
  regenerateKey?: boolean;
  timeoutMs?: number;
  minIntervalMs?: number;
}

export interface ZCodeProxyConfigResponse {
  ok: boolean;
  enabled: boolean;
  apiKeySet: boolean;
  timeoutMs: number;
  minIntervalMs: number;
  apiKey?: string;
}

export interface ZCodeRevealKeyResponse {
  apiKey: string;
}

export interface ZCodeUpstreamTestResponse {
  ok: boolean;
  status: number;
  error: string | null;
  hint: string | null;
  usage: Record<string, unknown> | null;
  reply: string | null;
}

export type ZCodeClientSettingKey =
  | 'closeToTray'
  | 'keepAwakeWhileRunning'
  | 'mobilePushEnabled'
  | 'messageStreamShowReasoning'
  | 'autoDownloadUpdates';

export interface ZCodeClientSettings {
  locale: string | null;
  closeToTray: boolean;
  keepAwakeWhileRunning: boolean;
  mobilePushEnabled: boolean;
  messageStreamShowReasoning: boolean;
  autoDownloadUpdates: boolean;
  receivePreviewUpdates: boolean;
  recentWorkspaces: unknown[];
  lastActiveWorkspace: string | null;
  enabledCliProviders: string[];
}

export interface ZCodeSettingsResponse {
  installDir: string | null;
  installExe: string | null;
  dataDir: string;
  credentialsFile: string;
  credentialSource: string | null;
  userId: string | null;
  occupation?: string | null;
  interfaceMode?: string | null;
  memoryEnabled?: boolean;
  deviceMid: string | null;
  cliPlugins?: Record<string, unknown>;
  settings: ZCodeClientSettings;
  process: ZCodeProcessState;
  clientVersion: string | null;
  credentialState: Record<string, unknown> | null;
}

export interface ZCodeClientSettingResponse {
  key: ZCodeClientSettingKey;
  target: string;
  value: boolean;
}

export const zcodeApi = {
  state: () => get<ZCodeState>('/api/zcode/state'),

  loginUrl: () => post<ZCodeLoginUrlResponse>('/api/zcode/login-url', {}),

  importCurrent: (label?: string) =>
    post<ZCodeImportResponse>('/api/zcode/import', label?.trim() ? { label: label.trim() } : {}, { timeoutMs: TIMEOUT.write }),

  switchTo: (id: string) =>
    post<ZCodeSwitchResponse>('/api/zcode/switch', { id }, { timeoutMs: TIMEOUT.switch }),

  deleteAccount: (id: string) =>
    post<ZCodeDeleteResponse>('/api/zcode/accounts/delete', { id }, { timeoutMs: TIMEOUT.write }),

  renameAccount: (id: string, label: string) =>
    post<ZCodeRenameResponse>('/api/zcode/accounts/rename', { id, label }, { timeoutMs: TIMEOUT.write }),

  stop: () => post<ZCodeStopResponse>('/api/zcode/stop', {}, { timeoutMs: TIMEOUT.write }),

  launch: () => post<ZCodeLaunchResponse>('/api/zcode/launch', {}),

  balance: (refresh = false) =>
    get<ZCodeBalanceResponse>(`/api/zcode/balance${refresh ? '?refresh=1' : ''}`, { timeoutMs: TIMEOUT.quota }),

  balanceCache: () => get<ZCodeBalanceCacheResponse>('/api/zcode/balance/cache'),

  stats: (range: ZCodeStatsRange = '30d', model = '') => {
    const query = new URLSearchParams({ range, model });
    return get<ZCodeStatsResponse>(`/api/zcode/stats?${query.toString()}`, { timeoutMs: TIMEOUT.stats });
  },

  proxyStatus: () => get<ZCodeProxyStatus>('/api/zcode/proxy/status'),

  proxyConfig: (config: ZCodeProxyConfigInput) =>
    put<ZCodeProxyConfigResponse>('/api/zcode/proxy/config', config, { timeoutMs: TIMEOUT.write }),

  revealProxyKey: () => post<ZCodeRevealKeyResponse>('/api/zcode/proxy/reveal-key', {}),

  upstreamTest: () => get<ZCodeUpstreamTestResponse>('/api/zcode/upstream-test', { timeoutMs: TIMEOUT.quota }),

  settings: () => get<ZCodeSettingsResponse>('/api/zcode/settings'),

  clientSetting: (key: ZCodeClientSettingKey, value: boolean) =>
    put<ZCodeClientSettingResponse>('/api/zcode/client-setting', { key, value }, { timeoutMs: TIMEOUT.write }),

  models: () => get<ZCodeModelsResponse>('/api/zcode/models', { timeoutMs: TIMEOUT.models }),
};
