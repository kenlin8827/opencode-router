import { TierLevel } from '../types/router.js';

export interface ExecutionTrace {
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
    targetTier: TierLevel;
    confidence: number;
    reason: string;
    sessionRatchetApplied: boolean;
    sessionLookupType?: string;
  };
  execution: {
    modelUsed: string;
    provider: string;
    tierUsed: TierLevel;
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
  hourTs: number; // epoch ms, hour-aligned
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

export class TraceTracker {
  private traces = new Map<string, ExecutionTrace>(); // traceId -> trace
  private sessionTraceIndex = new Map<string, string[]>(); // sessionId -> traceId[]
  private traceOrder: string[] = []; // Ring buffer order for LRU eviction
  private readonly maxTraces: number;

  constructor(maxTraces = 5000) {
    this.maxTraces = maxTraces;
  }

  /**
   * Record a new request trajectory entry
   */
  public record(trace: ExecutionTrace): void {
    // 1. If buffer reached max capacity, evict oldest
    while (this.traceOrder.length >= this.maxTraces) {
      const oldestId = this.traceOrder.shift();
      if (!oldestId) break;
      const oldestTrace = this.traces.get(oldestId);
      if (oldestTrace) {
        const list = this.sessionTraceIndex.get(oldestTrace.sessionId);
        if (list) {
          const idx = list.indexOf(oldestId);
          if (idx !== -1) list.splice(idx, 1);
          if (list.length === 0) this.sessionTraceIndex.delete(oldestTrace.sessionId);
        }
        this.traces.delete(oldestId);
      }
    }

    // 2. Insert new trace
    this.traces.set(trace.traceId, trace);
    this.traceOrder.push(trace.traceId);

    // 3. Index by sessionId
    const sessionList = this.sessionTraceIndex.get(trace.sessionId) || [];
    sessionList.push(trace.traceId);
    this.sessionTraceIndex.set(trace.sessionId, sessionList);
  }

  /**
   * Get all traces belonging to a specific session in chronological order
   */
  public getTracesBySession(sessionId: string): ExecutionTrace[] {
    const traceIds = this.sessionTraceIndex.get(sessionId) || [];
    return traceIds
      .map(id => this.traces.get(id))
      .filter((t): t is ExecutionTrace => Boolean(t));
  }

  /**
   * Get a single trace by its trace ID
   */
  public getTrace(traceId: string): ExecutionTrace | undefined {
    return this.traces.get(traceId);
  }

  /**
   * Query recent traces with optional session filtering and pagination
   */
  public getRecentTraces(options?: {
    sessionId?: string;
    limit?: number;
    offset?: number;
  }): { total: number; data: ExecutionTrace[] } {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    let traceIds: string[];
    if (options?.sessionId) {
      traceIds = [...(this.sessionTraceIndex.get(options.sessionId) || [])].reverse();
    } else {
      // Reverse order (most recent first)
      traceIds = [...this.traceOrder].reverse();
    }

    const total = traceIds.length;
    const pagedIds = traceIds.slice(offset, offset + limit);
    const data = pagedIds
      .map(id => this.traces.get(id))
      .filter((t): t is ExecutionTrace => Boolean(t));

    return { total, data };
  }

  /**
   * Aggregate provider-native prompt-cache observability over the in-memory
   * trace ring buffer: totals, per-model rows and a 24h hourly series.
   * A request counts as "cached" when finops.cachedPromptTokens > 0.
   */
  public getCacheStats(): CacheStatsSummary {
    const HOUR = 3_600_000;
    const currentHour = Math.floor(Date.now() / HOUR);
    const buckets = new Map<number, CacheStatsHourBucket>();
    for (let h = currentHour - 23; h <= currentHour; h++) {
      buckets.set(h, { hourTs: h * HOUR, requests: 0, cachedRequests: 0, promptTokens: 0, cachedPromptTokens: 0 });
    }

    const models = new Map<string, CacheStatsModelRow>();
    let totalRequests = 0;
    let cachedRequests = 0;
    let promptTokens = 0;
    let cachedPromptTokens = 0;
    let costUsd = 0;
    let savedCostUsd = 0;

    for (const t of this.traces.values()) {
      const f = t.finops;
      const cached = f.cachedPromptTokens > 0;
      totalRequests++;
      promptTokens += f.promptTokens;
      cachedPromptTokens += f.cachedPromptTokens;
      costUsd += f.costUsd;
      savedCostUsd += f.savedCostUsd;
      if (cached) cachedRequests++;

      const b = buckets.get(Math.floor(t.timestamp / HOUR));
      if (b) {
        b.requests++;
        b.promptTokens += f.promptTokens;
        b.cachedPromptTokens += f.cachedPromptTokens;
        if (cached) b.cachedRequests++;
      }

      const key = `${t.execution.provider}::${t.execution.modelUsed}`;
      let row = models.get(key);
      if (!row) {
        row = {
          model: t.execution.modelUsed,
          provider: t.execution.provider,
          requests: 0,
          cachedRequests: 0,
          promptTokens: 0,
          cachedPromptTokens: 0,
          costUsd: 0,
          savedCostUsd: 0,
        };
        models.set(key, row);
      }
      row.requests++;
      row.promptTokens += f.promptTokens;
      row.cachedPromptTokens += f.cachedPromptTokens;
      row.costUsd += f.costUsd;
      row.savedCostUsd += f.savedCostUsd;
      if (cached) row.cachedRequests++;
    }

    return {
      windowTraces: this.traces.size,
      totalRequests,
      cachedRequests,
      requestHitRatio: totalRequests > 0 ? cachedRequests / totalRequests : 0,
      promptTokens,
      cachedPromptTokens,
      tokenHitRatio: promptTokens > 0 ? cachedPromptTokens / promptTokens : 0,
      costUsd,
      savedCostUsd,
      models: [...models.values()].sort((a, b) => b.cachedPromptTokens - a.cachedPromptTokens),
      hourly: [...buckets.values()].sort((a, b) => a.hourTs - b.hourTs),
    };
  }

  /**
   * Count total recorded traces for a session
   */
  public getTraceCountForSession(sessionId: string): number {
    return (this.sessionTraceIndex.get(sessionId) || []).length;
  }

  /**
   * Remove traces for a specific session
   */
  public deleteBySession(sessionId: string): void {
    const traceIds = this.sessionTraceIndex.get(sessionId) || [];
    for (const id of traceIds) {
      this.traces.delete(id);
      const idx = this.traceOrder.indexOf(id);
      if (idx !== -1) this.traceOrder.splice(idx, 1);
    }
    this.sessionTraceIndex.delete(sessionId);
  }

  /**
   * Clear all traces in memory
   */
  public clear(): void {
    this.traces.clear();
    this.sessionTraceIndex.clear();
    this.traceOrder = [];
  }
}
