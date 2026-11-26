import { get, post, put, TIMEOUT } from './api';

/** Loomy 反代状态（GET /api/loomy/proxy/status） */
export interface LoomyProxyStatus {
  enabled: boolean;
  apiKeySet: boolean;
  endpoint: string;
  upstream: string;
  credential: {
    ok: boolean;
    error: string | null;
    phoneMasked: string;
    userid: string;
    updatedAt: number | null;
    file: string | null;
    changedRecently: boolean;
  };
  timeoutMs: number;
  minIntervalMs: number;
  stats: { total: number; ok: number; failed: number; lastAt: number | null };
  logs: LoomyProxyLogEntry[];
  models: { id: string; name: string }[];
}

export interface LoomyProxyLogEntry {
  at: number;
  model: string;
  ok: boolean;
  ms: number;
  status: number;
  stream?: boolean;
  error?: string;
  note?: string;
  tokens?: unknown;
}

export interface LoomyProxyConfigInput {
  enabled?: boolean;
  regenerateKey?: boolean;
  timeoutMs?: number;
  minIntervalMs?: number;
}

export interface LoomyProxyConfigResponse {
  ok: boolean;
  enabled: boolean;
  apiKeySet: boolean;
  apiKey?: string;
  timeoutMs: number;
  minIntervalMs: number;
}

export interface LoomyUpstreamTestResponse {
  ok: boolean;
  status?: number;
  error?: string;
  reply?: string;
  usage?: unknown;
  model?: string;
  ms?: number;
}

export const loomyApi = {
  status: () => get<LoomyProxyStatus>('/api/loomy/proxy/status'),

  config: (config: LoomyProxyConfigInput) =>
    put<LoomyProxyConfigResponse>('/api/loomy/proxy/config', config, { timeoutMs: TIMEOUT.write }),

  /** 明文 Key：专用端点，仅在需要时取一次 */
  revealKey: async (): Promise<string> => {
    const r = await get<{ apiKey: string }>('/api/loomy/proxy/reveal-key');
    return r.apiKey;
  },

  test: () => post<LoomyUpstreamTestResponse>('/api/loomy/proxy/test', {}, { timeoutMs: TIMEOUT.quota }),
};
