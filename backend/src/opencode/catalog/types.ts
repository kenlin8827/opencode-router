/**
 * Unified provider/model catalog — normalized across sources.
 *
 * Data shapes are aligned 1:1 with the OpenCode / models.dev standard metadata
 * schema (snake_case): models carry `tool_call`, `limit{context,output}`,
 * `cost{input,output,cache_read,cache_write}`, `attachment`, `temperature`,
 * `modalities` — so normalizer output is near-identity and writing definitions
 * into opencode.jsonc needs no reshaping. Pricing/cost unit: USD per 1M tokens
 * (models.dev `cost` is already $/1M; OpenRouter is converted at the source).
 */

export type CatalogSourceId =
  | 'opencode'
  | 'models-dev'
  | 'openrouter'
  | 'openai-compatible'
  | 'config'
  | 'custom'
  | 'mapped'
  | 'service';

/** OCR-level tier classification (mirrors backend TierLevel). */
export type CatalogTier = 'lite' | 'plus' | 'pro' | 'ultra';

export interface CatalogCost {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
}

export interface CatalogLimit {
  context?: number;
  output?: number;
}

export interface CatalogModalities {
  input?: string[];
  output?: string[];
}

export interface CatalogModel {
  id: string;
  name?: string;
  /**
   * Model-level AI-SDK package override (models.dev `model.provider.npm`).
   * Beats the provider-level npm when present — e.g. opencode(Zen) is
   * `@ai-sdk/openai-compatible` overall, but `gpt-6-luna` carries
   * `@ai-sdk/openai`, i.e. Responses-API-only, and Zen rejects it on the
   * chat/completions wire with `ModelProtocolUnsupported`.
   */
  npm?: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  temperature?: boolean;
  modalities?: CatalogModalities;
  cost?: CatalogCost;
  limit?: CatalogLimit;
  /**
   * Explicit tier assignment (OCR extension — not part of the models.dev
   * schema). Sourced values never carry it; only aggregate overrides
   * (overrides.json) set it. When present, boot-direct uses it verbatim
   * instead of the price/name heuristic.
   */
  tier?: CatalogTier;
  source: CatalogSourceId;
}

export interface CatalogProviderRecord {
  id: string;
  name?: string;
  /** models.dev logo asset (svg); frontend falls back to an initial-letter avatar on error */
  logo?: string;
  npm?: string;
  /** default API base from the catalog */
  api?: string;
  /** effective base URL override (opencode.jsonc definition wins, then live service) */
  baseURL?: string;
  doc?: string;
  env?: string[];
  /** defined in opencode.jsonc provider node */
  custom: boolean;
  /** has a usable credential (auth.json entry or inline key) */
  connected: boolean;
  sources: CatalogSourceId[];
  models: CatalogModel[];
}

export interface CatalogSourceState<T> {
  fetchedAt: number;
  data: T;
}
