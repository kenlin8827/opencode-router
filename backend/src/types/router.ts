import { ChatCompletionResponse } from './openai.js';

export type TierLevel = 'fast' | 'flagship' | 'reasoning';

export const TIER_RANK: Record<TierLevel, number> = {
  fast: 1,
  flagship: 2,
  reasoning: 3,
};

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
}



