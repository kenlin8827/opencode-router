import { ChatCompletionResponse } from './openai.js';

export type TierLevel = 'lite' | 'plus' | 'pro' | 'ultra';

/**
 * ADR-0012: what a model's smart-match classification yields. `TierLevel`
 * is the REQUEST-side four-state vocabulary (targetTier, TIER_RANK,
 * escalateTier, flywheel labels, session ratchet); `'unclassified'` is a
 * MODEL-side pool-membership outcome only. Kept as a separate type so the
 * two axes can't be conflated.
 *
 * Tier naming: strength-gradient labels that work across model vendors
 * (Claude, GPT-*, Gemini, etc.) instead of vendor-specific brand names.
 * Four-tier vocabulary, ordered lite → plus → pro → ultra, with `ultra`
 * at the price/quality ceiling. See docs/adr for the tier-migration history.
 */
export type PoolMembership = TierLevel | 'unclassified';

export const TIER_RANK: Record<TierLevel, number> = {
  lite: 1,
  plus: 2,
  pro: 3,
  ultra: 4,
};

/**
 * Thinking-effort vocabulary, aligned with OpenCode's 6-level ladder
 * (lowest → highest). `EFFORT_LADDER.indexOf(effort)` IS the rank —
 * weaker levels have smaller index.
 *   none     — no reasoning (the lowest tier; client sends this
 *             explicitly to mean "do not think", not as a default)
 *   low / medium / high   — shared by every wire (OpenAI, Anthropic,
 *                           Google, OpenAI Responses)
 *   xhigh    — OpenAI / OpenAI-compatible top tier (GPT-5+)
 *   max      — Anthropic top tier (Opus 5.5+)
 *
 * `none` IS a real effort value, not a default or a missing-field
 * marker. An omitted `reasoning_effort` field is `undefined`; an
 * explicit `'none'` is the lowest tier of the ladder. The two must be
 * distinguished on the response side (X-OCR-Thinking-Actual header,
 * `actualEffort` field) so the client sees what the gateway actually
 * served.
 *
 * Default `supportedReasoningEfforts` for a thinking-capable model is
 * the full 6-level ladder — there is no 5-level "thinking subset".
 * Operators can narrow the supported set via the catalog overrides-store
 * `reasoningEfforts` field (see opencode/sync.ts).
 */
export const EFFORT_LADDER = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof EFFORT_LADDER)[number];

/**
 * Returns the highest effort level `supported` is allowed to substitute
 * for `requested`. "Degraded or equal": a `medium` request can be served
 * by anything `≤ medium`, never above. `undefined` `supported` → the full
 * `EFFORT_LADDER` (assume the model supports everything); an explicit
 * EMPTY array → `'none'` (the model serves no explicit level).
 */
export function downgradeReasoning(
  requested: ReasoningEffort,
  supported: readonly ReasoningEffort[] | undefined
): ReasoningEffort {
  const reqRank = EFFORT_LADDER.indexOf(requested);
  const candidates = (supported ?? EFFORT_LADDER)
    .filter((lvl) => EFFORT_LADDER.indexOf(lvl) <= reqRank)
    .sort((a, b) => EFFORT_LADDER.indexOf(b) - EFFORT_LADDER.indexOf(a));
  return candidates[0] ?? 'none';
}

export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite?: number;
  reasoning?: number;
}

export interface TierModelConfig {
  id: string;
  provider: string;
  upstreamModel?: string;
  realModel?: string;
  tier?: TierLevel;
  pricing: ModelPricing;
  supportsStreaming?: boolean;
  supportsTools?: boolean;
  supportsJsonSchema?: boolean;
  /**
   * Subset of `ReasoningEffort` this model can natively serve. Empty /
   * missing means "no explicit effort control — the model handles effort
   * internally". Default for thinking-capable models is the full
   * `EFFORT_LADDER` (all 6 levels). Operators narrow via the catalog
   * overrides-store `reasoningEfforts` field.
   */
  supportedReasoningEfforts?: readonly ReasoningEffort[];
  /**
   * Legacy boolean kept for back-compat with catalog / config files that
   * pre-date the per-level vocabulary. Treated as "supports the 5
   * non-`none` levels" (low / medium / high / xhigh / max) when true
   * and no `supportedReasoningEfforts` is set.
   */
  supportsReasoningEffort?: boolean;
  supportsPromptCaching?: boolean;
  isDefaultInTier?: boolean;
}

export type SessionLookupType =
  | 'explicit_header'   // client-supplied header / router_options
  | 'embedded_user_id'  // session UUID embedded in metadata.user_id (Claude Code)
  | 'request_user'      // raw OpenAI request.user field
  | 'prefix_chain'      // exact head-prefix anchor of a completed chain
  | 'tail_anchor'       // trailing-window anchor (survives history truncation)
  | 'root_anchor'       // deterministic first-user-message key
  | 'cold_start';       // fresh mint (random, collision-free by construction)

export interface RoutingDecision {
  targetTier: TierLevel;
  confidence: number;
  reason: string;
  layerUsed?: 'layer0' | 'layer1' | 'layer2';
  needsSchemaValidation: boolean;
  sessionId?: string;
  sessionRatchetApplied?: boolean;
  sessionLookupType?: SessionLookupType;
  pinnedModel?: string;
  features: {
    tokenCountEstimate: number;
    hasCode: boolean;
    hasMathOrProof: boolean;
    hasMultiTurn: boolean;
    hasToolsOrSchema: boolean;
    complexityScore: number;
  };
}

export interface ExecutionResult {
  response: ChatCompletionResponse;
  tierUsed: TierLevel;
  modelUsed: string;
  layerUsed?: 'layer0' | 'layer1' | 'layer2';
  fallbackOccurred: boolean;
  fallbackReason?: string;
  sessionId?: string;
  sessionRatchetApplied?: boolean;
  sessionLookupType?: SessionLookupType;
  traceId?: string;
  costUsd: number;
  baselineCostUsd: number;
  savedCostUsd: number;
  latencyMs: number;
  failoverOccurred?: boolean;
  failoverAttempts?: number;
  failoverPath?: string[];
  inplaceRetries?: number;
  breakerState?: string;
  /**
   * Reasoning-effort observability. `requestedEffort` is the value the
   * client sent (or undefined if the client omitted the field).
   * `actualEffort` is what the gateway actually served (may be lower
   * after registry-level downgrade); `reasoningDegraded` flags the
   * discrepancy. Both are full 6-level `ReasoningEffort` values.
   */
  requestedEffort?: ReasoningEffort;
  actualEffort?: ReasoningEffort;
  reasoningDegraded?: boolean;
}



