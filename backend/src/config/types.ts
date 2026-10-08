import { ModelPricing, TierLevel } from '../types/router.js';

import { CircuitBreakerConfig, RetryConfig } from '../resilience/types.js';

export interface ProviderConfig {
  name: string;
  type: 'openai-compatible' | 'anthropic' | 'google' | 'responses' | 'dispatch';
  baseUrl: string;
  apiKey: string;
  organization?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface ModelRegistration {
  id: string; // e.g., 'gpt-4o-mini', 'claude-3-5-haiku-20241022', 'deepseek-chat'
  provider: string; // matches ProviderConfig.name
  upstreamModel: string; // actual model name sent to upstream
  tier: TierLevel;
  pricing: ModelPricing;
  /** ADR-0011: resolved wire for direct execution (model-level npm beats provider npm). */
  wire?: 'openai' | 'anthropic' | 'google' | 'responses';
  priority?: number; // lower number = higher priority within the tier (e.g. 1 is primary, 2 is backup)
  isDefaultInTier?: boolean;
  supportsReasoningEffort?: boolean;
  supportsPromptCaching?: boolean;
}

/**
 * Combo member entry — bare string (config order = failover chain order,
 * weight 1) or an object carrying an explicit weight for the weighted /
 * round_robin selection strategies.
 */
export interface ComboModelRef {
  id: string;
  weight?: number; // >= 1, default 1
}

/**
 * Custom model combo (user-composed virtual model): the client sends the
 * combo id as `model` and the gateway executes against the member list.
 * Routing/breaker semantics stay per member; `selection` only decides who
 * leads the pool (priority = config order / weighted = weight-random /
 * round_robin = rotating weighted slots) — failover always walks config
 * order. No cross-tier escalation: the user's composition is authoritative.
 */
export interface ComboConfig {
  id: string; // client-visible virtual model name, e.g. 'my-combo'
  selection?: 'priority' | 'weighted' | 'round_robin'; // default 'priority'
  models: (string | ComboModelRef)[]; // ordered: first = preferred leader
  note?: string; // free-form remark, console-display only (never routed)
}

export interface FallbackConfig {
  enabled: boolean;
  maxRetries: number;
  escalateTier: 'flagship' | 'reasoning';
  injectErrorContext: boolean;
}

/**
 * Per-tier composition policy — resolved at runtime whenever a tier's candidate
 * pool is needed (primary pick, failover chain, session self-healing).
 * Matching order: blacklist → whitelist → priceRange; patterns are wildcards
 * (`*` any chars, `?` single char, case-insensitive; no wildcard = substring).
 * Blacklist and whitelist are mutually exclusive in the console UI; if both
 * are set in hand-written YAML, blacklist wins.
 */
export interface TierPriceRange {
  minInputPerM?: number; // $/M input price floor (0 = free/local models)
  maxInputPerM?: number; // $/M input price ceiling
  maxOutputPerM?: number; // $/M output price ceiling
}

export interface TierWeightRule {
  pattern: string; // wildcard pattern over model id
  weight: number; // >= 1, default 1; first matching rule wins
}

export interface TierPolicy {
  priceRange?: TierPriceRange;
  blacklist?: string[]; // matched models are removed from the tier entirely
  whitelist?: string[]; // non-empty: ONLY matching models are kept
  selection?: 'priority' | 'weighted' | 'round_robin'; // primary-pick strategy (see ProviderRegistry.pickPrimary)
  weights?: TierWeightRule[]; // multi-role: selection probability (weighted) / rotation share (round_robin) / same-priority order tie-break (priority)
}

export interface TiersConfig {
  fast?: TierPolicy;
  flagship?: TierPolicy;
  reasoning?: TierPolicy;
}

export type RoutingMode = 'smart' | 'cost' | 'quality';

export interface RoutingConfig {
  mode: RoutingMode; // smart = Layer1/Layer2 cascade (default); cost = always fast; quality = always reasoning
}

export interface OpenCodeConfig {
  url?: string;
  password?: string;
}

/**
 * Outbound proxy for upstream calls (model providers, Layer2 judge, catalog sync).
 * Resolution order: loopback targets are NEVER proxied → blacklist (force direct)
 * → whitelist (non-empty: ONLY matches go through proxy) → proxy.url → direct.
 *
 * Patterns are wildcard globs matched against the composite `provider/modelId`
 * AND the bare model id, so both levels work:
 *   - `anthropic/*`       → provider level (all models of a provider)
 *   - `x/claude-*` (x=* ) → model level within any provider (leading star-slash)
 *   - `claude-*` / `claude` → bare model-id match (wildcard / substring)
 * If both lists are set, blacklist is evaluated first (matched = force direct),
 * then the whitelist gates what remains.
 * With no explicit proxy resolved, Bun still honors HTTP_PROXY/HTTPS_PROXY/NO_PROXY.
 */
export interface ProxyConfig {
  enabled?: boolean; // master switch; default false (opt-in) — proxying only when explicitly true
  url?: string; // global proxy URL, http(s)://[user:pass@]host:port — embedded credentials are sent as Proxy-Authorization (verified on Bun, incl. CONNECT); empty = direct
  whitelist?: string[]; // non-empty: ONLY matching models/providers go through proxy
  blacklist?: string[]; // matching models/providers force direct (evaluated before whitelist)
}

export interface Layer1ClassifierConfig {
  enabled: boolean;
  modelPath?: string;
  confidenceThreshold?: number; // e.g., 0.85
}
export type LocalModelConfig = Layer1ClassifierConfig;

export interface Layer2JudgeConfig {
  enabled: boolean;
  provider: 'typesafe' | 'opencode' | 'openrouter' | 'custom';
  baseUrl?: string;
  apiKey?: string;
  model?: string; // e.g. 'typesafe/jev'
  timeoutMs?: number;
  decisionCache?: { // ADR-0010: reuse prior judge decisions for identical contexts
    enabled?: boolean; // default true
    ttlSeconds?: number; // default 1800
    maxEntries?: number; // default 500
  };
}
export type Layer2DecisionConfig = Layer2JudgeConfig;

export interface ClassifierConfig {
  layer1?: Layer1ClassifierConfig;
  localModel?: Layer1ClassifierConfig;
  layer2?: Layer2JudgeConfig;
}

export interface FlywheelConfig {
  enabled: boolean;
  datasetPath?: string; // default: './data/flywheel.jsonl'
  maxSamples?: number;
  logUserPrompt?: boolean;
}

export interface SessionConfig {
  enabled: boolean;
  strategy?: 'monotonic' | 'sticky' | 'stateless';
  ttlSeconds?: number; // default: 3600 (1 hour)
  maxSessions?: number; // default: 10000
}

export interface ApiKeyConfig {
  id: string; // Unique identifier, e.g. 'key-xxxxxx'
  name: string; // Client / application name, e.g. 'Cursor IDE', 'NextChat'
  key: string; // The token string, e.g. 'sk-ocr-xxxxxx'
  role?: 'admin' | 'user';
  enabled: boolean;
  createdAt: string;
  expiresAt?: string;
  description?: string;
}

/**
 * Catalog source registry — remote sources are fully config-declared.
 * `type` maps to a normalizer registered in opencode/catalog/sources/registry.ts;
 * adding a new source of a KNOWN type is pure configuration (no code).
 * `priority`: lower number = higher precedence when merging (config=10, service=20;
 * remote sources should use >=30).
 */
export interface CatalogSourceConfig {
  id: string;
  type: 'provider-catalog' | 'model-list' | 'openai-compatible';
  url: string;
  enabled?: boolean;
  priority?: number;
}

export interface CatalogConfig {
  syncIntervalMs?: number;
  sources?: CatalogSourceConfig[];
}

export const DEFAULT_CATALOG_SOURCES: CatalogSourceConfig[] = [
  // Baseline: the OpenCode built-in catalog (models.dev) — lowest priority number,
  // processed first, so its non-blank values win and later sources only fill blanks.
  { id: 'builtin', type: 'provider-catalog', url: 'https://models.dev/api.json', enabled: true, priority: 10 },
  // Extension sources fill missing fields only (never overwrite non-blank values).
  { id: 'openrouter', type: 'model-list', url: 'https://openrouter.ai/api/v1/models', enabled: true, priority: 30 },
];

/**
 * Token Saver compression (rtk tool-output compression + headroom context
 * compression + caveman output-style injection). Applied inside
 * PipelineOrchestrator after prompt normalization & session resolution.
 * All stages fail open; every engine has its own `enabled` flag.
 */
export interface CompressionConfig {
  rtk?: {
    enabled?: boolean; // compress tool-result text (git/grep/ls/tree/logs/build output); default false
  };
  headroom?: {
    enabled?: boolean; // whole-context compression via headroom sidecar POST /v1/compress; default false
    url?: string; // headroom proxy base URL, e.g. http://127.0.0.1:8787 (loopback-only by default)
    timeoutMs?: number; // default 3000; on timeout the original messages flow upstream unchanged
    compressUserMessages?: boolean; // also compress user-role text (ignored in session mode)
  };
  caveman?: {
    enabled?: boolean; // terse-style system-prompt injection to cut output tokens; default false
    level?: 'lite' | 'full' | 'ultra' | 'wenyan-lite' | 'wenyan' | 'wenyan-ultra'; // default 'full'
  };
}

/**
 * Request capture (full request/response body audit log). Every orchestrated
 * turn — successes AND failures — is appended as one JSONL line, archived by
 * local-date directory and session id:
 *   <dir>/<YYYY-MM-DD>/<sanitized-sessionId>.jsonl
 *
 * OFF by default (opt-in): captured bodies may contain sensitive data, and the
 * console /api/ui/* endpoints are auth-exempt — enable consciously.
 * Request headers are NEVER recorded.
 */
export interface CaptureConfig {
  enabled?: boolean; // master switch; default false
  dir?: string; // default: ~/.opencode-router/capture
  retentionDays?: number; // default 7; date dirs older than today-N are swept (at boot + hourly)
  maxTotalMB?: number; // default 2048; oldest date dirs are deleted first when exceeded
  maxBodyBytes?: number; // default 524288 (512 KB); truncation budget applied to request and response separately
}

export interface TracePersistConfig {
  enabled?: boolean; // default true
  dir?: string; // default: ~/.opencode-router/traces (traces.db)
  retentionDays?: number; // default 7; rows older than now-N are deleted (at boot + hourly)
  maxTotalMB?: number; // default 100; oldest rows deleted first when the db exceeds the budget
}

/**
 * Daemon-process log rotation (size-based). Only applies when the gateway is
 * started via `ocr start` — a manual `bun backend/src/index.ts` logs to its
 * own console and bypasses rotation entirely.
 * Rotation runs once per daemon start (not per write): if `ocr.log` exceeds
 * `maxSizeMB`, it is renamed to `ocr.log.1` (existing `.N` files shift up to
 * `.N+1`), and archives beyond `keepArchives` are deleted.
 */
export interface LoggingConfig {
  maxSizeMB?: number; // default 10
  keepArchives?: number; // default 7
}

export interface RouterConfig {
  port: number;
  host: string;
  adminApiKey?: string;
  apiKeys?: ApiKeyConfig[];
  opencode?: OpenCodeConfig;
  proxy?: ProxyConfig;
  compression?: CompressionConfig;
  capture?: CaptureConfig;
  tracePersist?: TracePersistConfig;
  logging?: LoggingConfig;
  catalog?: CatalogConfig;
  tiers?: TiersConfig;
  routing?: RoutingConfig;
  fallback: FallbackConfig;
  classifier?: ClassifierConfig;
  flywheel?: FlywheelConfig;
  session?: SessionConfig;
  circuitBreaker?: CircuitBreakerConfig;
  retry?: RetryConfig;
  providers?: ProviderConfig[];
  models?: ModelRegistration[];
  combos?: ComboConfig[];
  baselineModel: string; // Default flagship model id for calculating FinOps cost savings
}

export type { CircuitBreakerConfig, RetryConfig };
