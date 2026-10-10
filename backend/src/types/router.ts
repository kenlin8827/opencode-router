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
 * 5-level thinking-effort vocabulary aligned with Anthropic's native effort
 * levels. `none` is the implicit value when a client omits `reasoning_effort`.
 * Higher rank = more thinking budget. Used both for client-facing requests
 * (ChatCompletionRequest.reasoning_effort) and for declaring what a model
 * can serve (ModelRegistration.supportedReasoningEfforts).
 */
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

export const REASONING_EFFORT_RANK: Record<ReasoningEffort, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
};

/**
 * Returns the highest effort level that `supported` is allowed to be
 * substituted for `requested`. The contract is "degraded or equal": a
 * `medium` request can be served by a model that supports `medium` OR
 * `low` (or anything below), but never above the request (e.g. a `low`
 * request must NOT silently become `high` — that's dishonest and changes
 * the user's contract).
 *
 * When `supported` is empty / undefined, returns `none` (the gateway falls
 * back to model-default thinking behavior).
 */
export function downgradeReasoning(
  requested: ReasoningEffort,
  supported: ReasoningEffort[] | undefined
): ReasoningEffort {
  const allLevels: ReasoningEffort[] = ['none', 'low', 'medium', 'high', 'xhigh'];
  const reqRank = REASONING_EFFORT_RANK[requested];
  // Filter to levels the model can serve, then find the highest whose
  // rank <= requested rank. The intersection is sorted descending so the
  // first match wins.
  const candidates = (supported && supported.length > 0 ? supported : allLevels)
    .filter((lvl) => REASONING_EFFORT_RANK[lvl] <= reqRank)
    .sort((a, b) => REASONING_EFFORT_RANK[b] - REASONING_EFFORT_RANK[a]);
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
   * Subset of `ReasoningEffort` this model can natively serve. Empty / missing
   * means "model-default only" (no explicit effort control). Provider payload
   * builders use this to choose how to construct thinking blocks.
   */
  supportedReasoningEfforts?: ReasoningEffort[];
  /**
   * Legacy boolean kept for back-compat with catalog / config files that
   * pre-date the per-level vocabulary. Treated as "supports all 4 non-default
   * levels" when true and no `supportedReasoningEfforts` is set.
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
   * Reasoning-effort observability. Always set: `requestedEffort` defaults to
   * `'none'` when the client didn't ask for thinking; `actualEffort` is what
   * the gateway actually served (may be lower after registry-level downgrade);
   * `reasoningDegraded` flags the discrepancy.
   */
  requestedEffort?: ReasoningEffort;
  actualEffort?: ReasoningEffort;
  reasoningDegraded?: boolean;
}



