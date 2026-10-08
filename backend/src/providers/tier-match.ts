import { TierLevel } from '../types/router.js';
import { globMatchAny } from '../utils/glob.js';
import { TiersConfig } from '../config/types.js';

/**
 * Smart-match configuration per tier — how a model is *classified* into a
 * tier at boot (candidate pools), vs. the composition policy (blacklist /
 * whitelist) which *filters* an already-classified pool.
 *
 * Classification precedence (first hit wins):
 *   1. explicit tier (catalog override / opencode.jsonc model def)
 *   2. tier name patterns (wildcards over the model id)
 *   3. catalog/config reasoning flag → reasoning
 *   4. price band over the RAW catalog $/M input price (missing price = no
 *      band match; free models with input=0 DO fall into a max-only band)
 *   5. flagship (fallback)
 */
export interface TierMatch {
  patterns?: string[]; // wildcard patterns over model id (case-insensitive)
  minInputPerM?: number; // price-band floor; undefined = no floor
  maxInputPerM?: number; // price-band ceiling; undefined = no ceiling
}

export type ResolvedTierMatch = Record<TierLevel, TierMatch>;

/**
 * Built-in baseline. `fast` name hints mirror the historical keyword regex
 * plus `*haiku*`; the 0.8 ceiling includes free/local models (input = 0).
 * `reasoning` is catalog-flag driven or priced at ≥ $5/M input.
 */
export const DEFAULT_TIER_MATCH: ResolvedTierMatch = {
  fast: { patterns: ['*flash*', '*lite*', '*speed*', '*turbo*', '*mini*', '*fast*', '*haiku*'], maxInputPerM: 0.8 },
  flagship: {},
  reasoning: { minInputPerM: 5 },
};

/** Per-field merge of user `tiers[t].match` over the built-in defaults. */
export function resolveTierMatch(policies: TiersConfig | undefined): ResolvedTierMatch {
  const out = {} as ResolvedTierMatch;
  for (const tier of ['fast', 'flagship', 'reasoning'] as TierLevel[]) {
    const d = DEFAULT_TIER_MATCH[tier];
    const m = policies?.[tier]?.match;
    out[tier] = {
      patterns: m?.patterns ?? d.patterns,
      minInputPerM: m?.minInputPerM ?? d.minInputPerM,
      maxInputPerM: m?.maxInputPerM ?? d.maxInputPerM,
    };
  }
  return out;
}

export interface TierClassifyInput {
  modelId: string; // provider-qualified or bare model id (matched lowercased)
  inputPerM?: number; // RAW catalog price; undefined = unknown → bands skip
  reasoningFlag: boolean; // catalog `reasoning` or config capability
}

/** True when the price lies inside the tier's band (band must be configured). */
function bandHit(band: TierMatch, price?: number): boolean {
  if (price == null) return false;
  if (band.minInputPerM == null && band.maxInputPerM == null) return false;
  if (band.minInputPerM != null && price < band.minInputPerM) return false;
  if (band.maxInputPerM != null && price > band.maxInputPerM) return false;
  return true;
}

/** Classify a model by the effective match config (see precedence above). */
export function classifyTier(input: TierClassifyInput, match: ResolvedTierMatch): TierLevel {
  const mid = input.modelId.toLowerCase();
  if (globMatchAny(match.fast.patterns, mid)) return 'fast';
  if (globMatchAny(match.reasoning.patterns, mid)) return 'reasoning';
  if (globMatchAny(match.flagship.patterns, mid)) return 'flagship';
  if (input.reasoningFlag) return 'reasoning';
  if (bandHit(match.reasoning, input.inputPerM)) return 'reasoning';
  if (bandHit(match.fast, input.inputPerM)) return 'fast';
  return 'flagship';
}
