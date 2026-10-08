// Mirrors backend FinOpsStats (backend/src/metrics/finops-tracker.ts getStats)
export interface GatewayMetrics {
  totalRequests: number;
  fallbackCount: number;
  tierDistribution: {
    fast: { count: number; pct: number };
    flagship: { count: number; pct: number };
    reasoning: { count: number; pct: number };
  };
  tokens: {
    totalPromptTokens: number;
    totalCachedPromptTokens: number;
    totalCompletionTokens: number;
    totalReasoningTokens: number;
  };
  economics: {
    actualCostUsd: number;
    baselineCostUsd: number;
    totalSavingsUsd: number;
    savingsPct: number;
  };
  latency: {
    avgMs: number;
    fastAvgMs: number;
    flagshipAvgMs: number;
    reasoningAvgMs: number;
  };
}

export interface ClientStatus {
  name: string;
  displayName: string;
  configPath: string;
  exists: boolean;
  hooked: boolean;
  targetProvider: string;
  backupExists: boolean;
  /** Extra concrete models exposed in the client's model switcher (opencode) */
  extraModels?: string[];
  /** This client's model slots; value undefined = auto (intelligent routing) */
  modelSlots: { key: string; value?: string; default?: string }[];
}

// Mirrors backend CircuitBreakerSnapshot (backend/src/resilience/types.ts)
export interface BreakerInfo {
  modelId: string;
  provider: string;
  tier?: string;
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  reason?: string;
  category?: string;
  consecutiveFailures: number;
  totalRequests: number;
  totalSuccesses: number;
  totalFailures: number;
  lastFailureTime?: number;
  lastSuccessTime?: number;
  trippedAt?: number;
  cooldownUntil?: number;
  remainingCooldownMs: number;
  currentCooldownMs: number;
  halfOpenProbes: number;
}

// Masked provider entry from /api/ui/status (ProviderConfig with apiKey masked)
export interface MaskedProviderStatus {
  name: string;
  type: 'openai-compatible' | 'anthropic';
  baseUrl: string;
  apiKey: string; // "xxxx••••xxxx", empty string when unset
  rawKeyConfigured: boolean;
  organization?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

// Mirrors backend /api/ui/status payload exactly (backend/src/routes/console.ts handleStatus)
export interface GatewayStatusResponse {
  status: string;
  timestamp: string;
  metrics: GatewayMetrics;
  circuitBreakers: {
    total: number;
    healthy: number;
    tripped: number;
    halfOpen: number;
    breakers: BreakerInfo[];
  };
  clients: ClientStatus[];
  providers: MaskedProviderStatus[];
  registeredModelsCount: number;
}

// Mirrors backend ExecutionTrace (backend/src/trace/tracker.ts) returned by /v1/traces
export interface TraceRecord {
  traceId: string;
  sessionId: string;
  turnNumber: number;
  timestamp: number;
  request: {
    model: string;
    userPromptSummary: string;
    messageCount: number;
    hasSystemPrompt: boolean;
    hasToolsOrSchema: boolean;
  };
  routing: {
    layerUsed: 'layer0' | 'layer1' | 'layer2';
    targetTier: 'fast' | 'flagship' | 'reasoning';
    confidence: number;
    reason: string;
    sessionRatchetApplied: boolean;
  };
  execution: {
    modelUsed: string;
    provider: string;
    tierUsed: 'fast' | 'flagship' | 'reasoning';
    latencyMs: number;
    fallbackOccurred: boolean;
    fallbackReason?: string;
    failoverOccurred?: boolean;
    failoverAttempts?: number;
    failoverPath?: string[];
    inplaceRetries?: number;
  };
  finops: {
    promptTokens: number;
    completionTokens: number;
    cachedPromptTokens: number;
    costUsd: number;
    savedCostUsd: number;
  };
}

// Mirrors backend capture types (backend/src/capture/recorder.ts)
export interface CaptureStatus {
  enabled: boolean;
  dir: string;
  retentionDays: number;
  maxTotalMB: number;
  maxBodyBytes: number;
  totalBytes: number;
  dateCount: number;
}

export interface CaptureDateRow {
  date: string; // YYYY-MM-DD
  sessions: number;
  bytes: number;
}

export interface CaptureSessionRow {
  file: string;
  sessionId: string;
  bytes: number;
  mtimeMs: number;
  lastStatus?: 'ok' | 'error';
}

export interface CaptureRecord {
  id: string;
  ts: number;
  sessionId: string;
  status: 'ok' | 'error';
  model: string;
  request?: unknown;
  /** Post-compression snapshot of what the successful upstream call received */
  upstreamRequest?: unknown;
  /** Upstream error payload (status + parsed body) when a candidate call failed */
  upstreamError?: unknown;
  response?: unknown;
  error?: string;
  routing?: {
    tierUsed?: string;
    layerUsed?: string;
    modelUsed?: string;
    provider?: string;
    fallbackOccurred?: boolean;
    failoverPath?: string[];
  };
  usage?: unknown;
  latencyMs?: number;
  truncated?: boolean;
}

// Mirrors backend ConversationSession (backend/src/session/session-manager.ts) + traceCount
export interface SessionRecord {
  id: string;
  maxTier: 'fast' | 'flagship' | 'reasoning';
  pinnedModel: string;
  pinnedProvider: string;
  createdAt: number;
  lastActiveAt: number;
  turnCount: number;
  historyTiers: string[];
  traceCount: number;
}

// Mirrors backend CacheStatsSummary (backend/src/trace/tracker.ts getCacheStats)
export interface CacheStatsModelRow {
  model: string;
  provider: string;
  requests: number;
  cachedRequests: number;
  promptTokens: number;
  cachedPromptTokens: number;
  costUsd: number;
  savedCostUsd: number;
}

export interface CacheStatsHourBucket {
  hourTs: number;
  requests: number;
  cachedRequests: number;
  promptTokens: number;
  cachedPromptTokens: number;
}

export interface CacheStatsSummary {
  windowTraces: number;
  totalRequests: number;
  cachedRequests: number;
  requestHitRatio: number;
  promptTokens: number;
  cachedPromptTokens: number;
  tokenHitRatio: number;
  costUsd: number;
  savedCostUsd: number;
  models: CacheStatsModelRow[];
  hourly: CacheStatsHourBucket[];
}

// Mirrors backend RoutingCacheStats (backend/src/router/decision-cache.ts)
export interface RoutingCacheStats {
  enabled: boolean;
  entries: number;
  maxEntries: number;
  ttlSeconds: number;
  hits: number;
  misses: number;
  hitRatio: number;
}

export interface CacheStatsResponse {
  status: string;
  stats: CacheStatsSummary;
  routingCache: RoutingCacheStats;
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

export interface ComboMemberView {
  id: string;
  weight: number;
  registered: boolean;
  provider?: string;
  tier?: string;
  inputPrice?: number;
  outputPrice?: number;
  breakerState?: 'CLOSED' | 'OPEN' | 'HALF_OPEN' | string;
}

export interface ComboView {
  id: string;
  active?: boolean;
  selection: 'priority' | 'weighted' | 'round_robin' | string;
  members: ComboMemberView[];
  note?: string;
}

export interface CombosResponse {
  status: string;
  combos: ComboView[];
}

export interface LogLine {
  raw: string;
  level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  levelNum?: number;
  time?: number;
  msg?: string;
}

export interface LogsResponse {
  status: string;
  file: string;
  exists: boolean;
  size: number;
  mtimeMs: number;
  lines: LogLine[];
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
    const body = await res.json();
    // Unwrap the { status, config } envelope — consumers want the RouterConfig
    // object itself (SettingsPage/AutoPage save it back via saveConfig).
    return body?.config ?? body;
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

  async getCombos(): Promise<CombosResponse> {
    const res = await fetch('/api/ui/combos');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async getCacheStats(): Promise<CacheStatsResponse> {
    const res = await fetch('/api/ui/cache-stats');
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

  async toggleClient(
    client: string,
    action: 'setup' | 'teardown',
    payload?: {
      models?: Record<string, string>;
      apiKey?: string;
      contextWindow?: number;
      extraModels?: string[];
    }
  ): Promise<{ status: string; message: string }> {
    const res = await fetch(`/api/ui/client/${client}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${res.status}`);
    }
    return res.json();
  },

  /** All models the gateway can route to: virtual (auto/auto-fast/…) + registered. */
  async listGatewayModels(): Promise<{ id: string; owned_by: string; tier?: string }[]> {
    const res = await fetch('/v1/models');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return (json?.data || []).map((m: any) => ({
      id: m.id,
      owned_by: m.owned_by || '',
      tier: m.metadata?.tier,
    }));
  },

  async resetBreakers(model?: string): Promise<{ status: string; message?: string }> {
    const res = await fetch('/v1/health/circuit-breakers/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(model ? { model } : {}),
    });
    return res.json();
  },

  async tripBreaker(
    model: string,
    options?: { reason?: string; cooldownMs?: number }
  ): Promise<{ status: string; message?: string }> {
    const res = await fetch('/v1/health/circuit-breakers/trip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, ...options }),
    });
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

  async getLogs(tail = 500, level?: string, q?: string): Promise<LogsResponse> {
    const qs = new URLSearchParams();
    qs.set('tail', String(tail));
    if (level) qs.set('level', level);
    if (q) qs.set('q', q);
    const res = await fetch(`/api/ui/logs?${qs.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
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

  /* ------------------------------------------------------------------ *
   * Request-capture archive (full bodies, opt-in; /api/ui/capture/*)
   * ------------------------------------------------------------------ */

  async getCaptureStatus(): Promise<CaptureStatus> {
    const res = await fetch('/api/ui/capture/status');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async getCaptureDates(): Promise<CaptureDateRow[]> {
    const res = await fetch('/api/ui/capture/dates');
    if (!res.ok) return [];
    const json = await res.json();
    return json.dates || [];
  },

  async getCaptureSessions(date: string): Promise<CaptureSessionRow[]> {
    const res = await fetch(`/api/ui/capture/${encodeURIComponent(date)}/sessions`);
    if (!res.ok) return [];
    const json = await res.json();
    return json.sessions || [];
  },

  async getCaptureRecords(
    date: string,
    file: string,
    limit = 200
  ): Promise<{ records: CaptureRecord[]; totalLines: number; fileTruncated: boolean }> {
    const res = await fetch(
      `/api/ui/capture/${encodeURIComponent(date)}/${encodeURIComponent(file)}?limit=${limit}`
    );
    if (!res.ok) return { records: [], totalLines: 0, fileTruncated: false };
    return res.json();
  },

  /** JSONL download of one session archive; `exclude` strips body fields, metadata always kept. */
  async exportCaptureArchive(date: string, file: string, exclude?: string[]): Promise<Blob> {
    const params = new URLSearchParams({ format: 'raw' });
    if (exclude && exclude.length > 0) params.set('exclude', exclude.join(','));
    const res = await fetch(
      `/api/ui/capture/${encodeURIComponent(date)}/${encodeURIComponent(file)}?${params.toString()}`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.blob();
  },

  async deleteCaptureDate(date: string): Promise<{ status: string; message?: string }> {
    const res = await fetch(`/api/ui/capture/${encodeURIComponent(date)}`, { method: 'DELETE' });
    return res.json();
  },

  async deleteCaptureSession(date: string, file: string): Promise<{ status: string; message?: string }> {
    const res = await fetch(
      `/api/ui/capture/${encodeURIComponent(date)}/${encodeURIComponent(file)}`,
      { method: 'DELETE' }
    );
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
  kind?: 'openai' | 'anthropic' | 'google' | 'responses' | 'unroutable';
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
