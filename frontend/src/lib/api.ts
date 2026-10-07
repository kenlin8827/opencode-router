export interface GatewayMetrics {
  totalRequests: number;
  cacheHits: number;
  cacheHitRatio: number;
  totalTokens: number;
  cachedTokens: number;
  costSavingsUsd: number;
  savingsPercentage: number;
  avgLatencyMs: number;
}

export interface ClientStatus {
  name: string;
  displayName: string;
  configPath: string;
  exists: boolean;
  hooked: boolean;
  targetProvider: string;
  backupExists: boolean;
}

export interface BreakerInfo {
  model: string;
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  failures: number;
  lastFailureTime: number | null;
  cooldownRemainingMs: number;
}

export interface GatewayStatusResponse {
  status: string;
  timestamp: string;
  uptimeSeconds: number;
  memoryUsageMb: {
    heapUsed: number;
    rss: number;
  };
  metrics: GatewayMetrics;
  circuitBreakers: {
    total: number;
    openCount: number;
    breakers: BreakerInfo[];
  };
  clients: ClientStatus[];
  budget: {
    monthlyLimitUsd: number;
    currentSpendUsd: number;
    usageRatio: number;
    hardLimitEnforced: boolean;
  };
}

export interface TraceRecord {
  id: string;
  timestamp: string;
  sessionId?: string;
  model: string;
  provider: string;
  status: 'success' | 'fallback' | 'error';
  latencyMs: number;
  tokens?: {
    prompt: number;
    completion: number;
    total: number;
  };
  costUsd?: {
    actual: number;
    baseline: number;
    savings: number;
  };
  cacheHit?: boolean;
}

export interface SessionRecord {
  sessionId: string;
  pinnedModel: string;
  currentTier: number;
  traceCount: number;
  totalTokens: number;
  createdAt: string;
  lastActiveAt: string;
}

export interface TierPoolModel {
  id: string;
  provider: string;
  upstreamModel?: string;
  priority?: number;
  isDefaultInTier: boolean;
  inputPrice?: number;
  outputPrice?: number;
  healthy: boolean;
  weight: number;
}

export interface TierPoolInfo {
  pool: TierPoolModel[];
  excluded: { id: string; reason: string }[];
}

export interface TierPoolsResponse {
  status: string;
  pools: Record<string, TierPoolInfo>;
}

export const api = {
  async getStatus(): Promise<GatewayStatusResponse> {
    const res = await fetch('/api/ui/status');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async getConfig(): Promise<any> {
    const res = await fetch('/api/ui/config');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async saveConfig(config: any): Promise<{ status: string; message: string }> {
    const res = await fetch('/api/ui/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${res.status}`);
    }
    return res.json();
  },

  async getTierPools(): Promise<TierPoolsResponse> {
    const res = await fetch('/api/ui/tier-pools');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async getRawYaml(): Promise<{ status: string; yaml: string }> {
    const res = await fetch('/api/ui/config/raw');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async saveRawYaml(yaml: string): Promise<{ status: string; message: string }> {
    const res = await fetch('/api/ui/config/raw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ yaml }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${res.status}`);
    }
    return res.json();
  },

  async toggleClient(client: string, action: 'setup' | 'teardown'): Promise<{ status: string; message: string }> {
    const res = await fetch(`/api/ui/client/${client}/${action}`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async resetBreakers(): Promise<{ status: string; message?: string }> {
    const res = await fetch('/v1/health/circuit-breakers/reset', { method: 'POST' });
    return res.json();
  },

  async restartGateway(): Promise<{ status: string; message?: string }> {
    const res = await fetch('/api/ui/restart', { method: 'POST' });
    return res.json();
  },

  async getTraces(limit = 50, offset = 0): Promise<{ traces: TraceRecord[]; total: number }> {
    const res = await fetch(`/v1/traces?limit=${limit}&offset=${offset}`);
    if (!res.ok) return { traces: [], total: 0 };
    const json = await res.json();
    // /v1/traces responds { object, total, limit, offset, data }
    return { traces: json.data || [], total: json.total || 0 };
  },

  async getSessions(limit?: number, offset = 0): Promise<{ sessions: SessionRecord[]; total: number }> {
    const qs = new URLSearchParams();
    if (limit !== undefined) qs.set('limit', String(limit));
    qs.set('offset', String(offset));
    const res = await fetch(`/v1/sessions?${qs.toString()}`);
    if (!res.ok) return { sessions: [], total: 0 };
    const json = await res.json();
    // /v1/sessions responds { object, total, limit?, offset, data }
    return { sessions: json.data || [], total: json.total || 0 };
  },

  async getApiKeys(): Promise<{ status: string; keys: ApiKeyItem[] }> {
    const res = await fetch('/api/ui/api-keys');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async createApiKey(payload: {
    name: string;
    key?: string;
    role?: 'admin' | 'user';
    expiresAt?: string;
    description?: string;
  }): Promise<{ success: boolean; data?: ApiKeyItem; error?: string }> {
    const res = await fetch('/api/ui/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.json();
  },

  async updateApiKey(
    id: string,
    updates: Partial<ApiKeyItem>
  ): Promise<{ success: boolean; data?: ApiKeyItem; error?: string }> {
    const res = await fetch(`/api/ui/api-keys/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    return res.json();
  },

  async deleteApiKey(id: string): Promise<{ success: boolean; error?: string }> {
    const res = await fetch(`/api/ui/api-keys/${id}`, { method: 'DELETE' });
    return res.json();
  },
};

export interface ApiKeyItem {
  id: string;
  name: string;
  key: string;
  role?: 'admin' | 'user';
  enabled: boolean;
  createdAt: string;
  expiresAt?: string;
  description?: string;
}

// ---------------------------------------------------------------------------
// OpenCode-native provider management (opencode.jsonc `provider` + auth.json)
// ---------------------------------------------------------------------------

export interface OpenCodeProviderView {
  id: string;
  name?: string;
  npm?: string;
  baseURL?: string;
  models: string[];
  custom: boolean;
  logo?: string;
  priceFrom?: number;
  modelsCount?: number;
  auth: {
    connected: boolean;
    type?: 'api' | 'oauth' | 'wellknown';
    keyMasked?: string;
    expires?: number;
    inline?: boolean;
  };
}

export interface OpenCodeCatalogProvider {
  id: string;
  name: string;
  logo?: string;
  npm?: string;
  api?: string;
  baseURL?: string;
  doc?: string;
  env?: string[];
  custom: boolean;
  connected: boolean;
  sources: string[];
  modelCount: number;
  priceFrom?: number;
}

export interface CustomProviderPayload {
  id: string;
  name?: string;
  npm?: string;
  baseURL?: string;
  apiKey?: string;
  apiKeyInline?: boolean;
  headers?: Record<string, string>;
  models?: Record<string, any>;
  options?: Record<string, any>;
}

/** Result of the one-shot provider/model connectivity probe (POST .../test). */
export interface TestProviderResult {
  status: string;
  ok: boolean;
  kind?: 'openai' | 'anthropic' | 'google';
  model?: string;
  latencyMs?: number;
  error?: string;
  authHint?: boolean;
}

export interface OpenCodeModelView {
  providerId: string;
  providerName?: string;
  logo?: string;
  custom: boolean;
  connected: boolean;
  id: string;
  name?: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  temperature?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  limit?: { context?: number; output?: number };
  source: string;
}

function ocJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    return res
      .json()
      .catch(() => ({}))
      .then((e: any) => {
        throw new Error(e?.error || e?.message || `HTTP ${res.status}`);
      }) as Promise<T>;
  }
  return res.json();
}

export const opencodeApi = {
  async listProviders(): Promise<{
    status: string;
    configPath: string;
    authPath: string;
    providers: OpenCodeProviderView[];
  }> {
    return ocJson(await fetch('/api/ui/opencode/providers'));
  },

  async catalog(refresh = false): Promise<{ status: string; source: string; providers: OpenCodeCatalogProvider[] }> {
    return ocJson(await fetch(`/api/ui/opencode/catalog${refresh ? '?refresh=1' : ''}`));
  },

  async listModels(params?: { provider?: string; connected?: boolean }): Promise<{
    status: string;
    source: string;
    total: number;
    models: OpenCodeModelView[];
  }> {
    const qs = new URLSearchParams();
    if (params?.provider) qs.set('provider', params.provider);
    if (params?.connected) qs.set('connected', '1');
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return ocJson(await fetch(`/api/ui/opencode/models${suffix}`));
  },

  async createProvider(payload: CustomProviderPayload): Promise<{ status: string; success: boolean }> {
    return ocJson(
      await fetch('/api/ui/opencode/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    );
  },

  async updateProvider(id: string, payload: Partial<CustomProviderPayload>): Promise<{ status: string; success: boolean }> {
    return ocJson(
      await fetch(`/api/ui/opencode/providers/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    );
  },

  async connectProvider(id: string, apiKey: string, baseURL?: string): Promise<{ status: string; success: boolean; message?: string }> {
    return ocJson(
      await fetch(`/api/ui/opencode/providers/${encodeURIComponent(id)}/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, baseURL }),
      })
    );
  },

  /** One-shot upstream connectivity probe — optional overrides enable test-before-save. */
  async testProvider(
    id: string,
    payload?: { modelId?: string; apiKey?: string; baseURL?: string }
  ): Promise<TestProviderResult> {
    return ocJson(
      await fetch(`/api/ui/opencode/providers/${encodeURIComponent(id)}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      })
    );
  },

  async deleteProvider(id: string, purgeAuth = false): Promise<{ status: string; success: boolean; message?: string }> {
    return ocJson(
      await fetch(`/api/ui/opencode/providers/${encodeURIComponent(id)}${purgeAuth ? '?purgeAuth=1' : ''}`, {
        method: 'DELETE',
      })
    );
  },

  // -- Per-provider model maintenance (config-defined providers only) ----

  async listProviderModels(id: string): Promise<{ status: string; id: string; models: Record<string, any> }> {
    return ocJson(await fetch(`/api/ui/opencode/providers/${encodeURIComponent(id)}/models`));
  },

  async addProviderModel(
    id: string,
    model: {
      id: string;
      name?: string;
      modelID?: string;
      disabled?: boolean;
      capabilities?: { tools?: boolean; input?: string[]; output?: string[] };
      settings?: Record<string, any>;
      headersText?: string;
      bodyText?: string;
      compatibility?: { reasoningField?: string };
      variants?: { id: string; settings?: Record<string, any> }[];
      reasoning?: boolean;
      toolCall?: boolean;
      attachment?: boolean;
      temperature?: boolean;
      modalities?: { input?: string[]; output?: string[] };
      contextLimit?: number;
      outputLimit?: number;
      cost?: Record<string, number>;
      definition?: Record<string, any>;
    }
  ): Promise<{ status: string; success: boolean; model: string }> {
    return ocJson(
      await fetch(`/api/ui/opencode/providers/${encodeURIComponent(id)}/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(model),
      })
    );
  },

  async updateProviderModel(
    id: string,
    modelId: string,
    patch: {
      name?: string;
      modelID?: string;
      disabled?: boolean;
      capabilities?: { tools?: boolean; input?: string[]; output?: string[] };
      settings?: Record<string, any>;
      headersText?: string;
      bodyText?: string;
      compatibility?: { reasoningField?: string };
      variants?: { id: string; settings?: Record<string, any> }[];
      reasoning?: boolean;
      toolCall?: boolean;
      attachment?: boolean;
      temperature?: boolean;
      modalities?: { input?: string[]; output?: string[] };
      contextLimit?: number;
      outputLimit?: number;
      newId?: string;
      cost?: Record<string, number>;
      definition?: Record<string, any>;
    }
  ): Promise<{ status: string; success: boolean; model: string }> {
    return ocJson(
      await fetch(`/api/ui/opencode/providers/${encodeURIComponent(id)}/models/${encodeURIComponent(modelId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
    );
  },

  async deleteProviderModel(id: string, modelId: string): Promise<{ status: string; success: boolean }> {
    return ocJson(
      await fetch(`/api/ui/opencode/providers/${encodeURIComponent(id)}/models/${encodeURIComponent(modelId)}`, {
        method: 'DELETE',
      })
    );
  },

  async pullProviderModels(
    id: string,
    opts: { pattern?: string; dryRun?: boolean; live?: boolean } = {}
  ): Promise<{
    status: string;
    live?: boolean;
    matched?: number;
    pullable?: number;
    pulled?: number;
    skipped?: number;
    success?: boolean;
    hint?: string;
    models: OpenCodeModelView[] | string[];
  }> {
    return ocJson(
      await fetch(`/api/ui/opencode/providers/${encodeURIComponent(id)}/models/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      })
    );
  },

  async clearProviderModels(id: string, pattern?: string): Promise<{ status: string; success: boolean; removed?: number }> {
    return ocJson(
      await fetch(`/api/ui/opencode/providers/${encodeURIComponent(id)}/models/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pattern }),
      })
    );
  },
};
