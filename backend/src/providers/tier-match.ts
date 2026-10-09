import { PoolMembership, TierLevel } from '../types/router.js';
import { globMatchAny } from '../utils/glob.js';
import { TiersConfig } from '../config/types.js';

/**
 * Smart-match configuration per tier — the SINGLE basis of candidate-pool
 * membership: patterns claim, price bands bound, exclude vetoes.
 *
 * ADR-0012 removed the flagship RESIDUAL: all three tiers are configured
 * identically and a model that matches no positive condition becomes
 * `'unclassified'` (joins no pool) instead of silently landing in flagship.
 * There is no dead configuration — every field below is honored for every tier.
 *
 * Classification chain for ONE model (first hit wins, highest authority first):
 *   1. explicit tier (catalog override / opencode.jsonc model def) — resolved by
 *      the registry BEFORE calling classifyTier; human pins outrank rules
 *   2. tier name patterns (wildcards over the model id) — fast → reasoning →
 *      flagship
 *   3. price bands over the RAW catalog $/M input price — closed bands by
 *      ascending floor first, then open-ended bands by DESCENDING floor (a band
 *      with no ceiling is a weak condition and must not eat the tier above it).
 *      Missing price = no band hit; free models (input = 0) DO fall into a
 *      max-only band
 *   4. catalog/config reasoning flag → reasoning
 *   5. nothing matched → 'unclassified'
 *
 * `exclude` and `excludeTiers` are NOT an earlier stage: they GATE each claim
 * (a claim returns, so a separate stage placed after the claims could never
 * run). The global `tiers.exclude` denylist is unconditional and is enforced at
 * the pool layer (see ProviderRegistry.policyRejectionReason) — it outranks even
 * a pin.
 */
export interface TierMatch {
  patterns?: string[]; // wildcard patterns over model id (case-insensitive)
  minInputPerM?: number; // price-band floor; undefined = no floor
  maxInputPerM?: number; // price-band ceiling; undefined = open-ended (weak)
  /**
   * Per-tier veto on AUTOMATIC claiming (explicit catalog/jsonc pins bypass it).
   * A vetoed model falls to the next claimant in the chain — since ADR-0012 it
   * may end up `'unclassified'` rather than defaulting to flagship.
   */
  exclude?: string[];
  /**
   * ADR-0012 anchor-exclude: a model matching ANY positive condition of one of
   * these tiers may not be AUTO-claimed by THIS tier. It is a convenience veto
   * derived from the other tiers' own patterns / band / flag, so overlapping
   * ranges can be resolved without reordering the chain.
   * Example: flagship.excludeTiers: [reasoning] keeps every reasoning-priced (or
   * reasoning-patterned, or flagged) model out of the flagship pool.
   */
  excludeTiers?: TierLevel[];
}

export type ResolvedTierMatch = Record<TierLevel, TierMatch>;

/** Order in which name patterns are consulted (first hit wins). */
const PATTERN_ORDER: TierLevel[] = ['fast', 'reasoning', 'flagship'];

/**
 * Built-in baseline. `fast` name hints mirror the historical keyword regex
 * plus `*haiku*`; the 0.8 ceiling includes free/local models (input = 0).
 * `reasoning` is catalog-flag driven or priced at ≥ $5/M input.
 * `flagship` is the former residual expressed as its EXPLICIT complement: the
 * closed band [0.8, 5] — anything above 5 is caught by reasoning's floor.
 */
export const DEFAULT_TIER_MATCH: ResolvedTierMatch = {
  fast: { patterns: ['*flash*', '*lite*', '*speed*', '*turbo*', '*mini*', '*fast*', '*haiku*'], maxInputPerM: 0.8 },
  flagship: { minInputPerM: 0.8, maxInputPerM: 5 },
  reasoning: { minInputPerM: 5 },
};

/** Per-field merge of user `tiers[t].match` over the built-in defaults. */
export function resolveTierMatch(policies: TiersConfig | undefined): ResolvedTierMatch {
  const out = {} as ResolvedTierMatch;
  for (const tier of PATTERN_ORDER) {
    const d = DEFAULT_TIER_MATCH[tier];
    const m = policies?.[tier]?.match;
    out[tier] = {
      patterns: m?.patterns ?? d.patterns,
      minInputPerM: m?.minInputPerM ?? d.minInputPerM,
      maxInputPerM: m?.maxInputPerM ?? d.maxInputPerM,
      exclude: m?.exclude ?? d.exclude,
      excludeTiers: m?.excludeTiers ?? d.excludeTiers,
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
  // Reject NaN: `NaN < x` and `NaN > x` are both false, so without this guard
  // a corrupted catalog row with price=NaN would silently fall THROUGH every
  // band check and get claimed as the last-evaluated one — wrong membership.
  if (price == null || Number.isNaN(price)) return false;
  if (band.minInputPerM == null && band.maxInputPerM == null) return false;
  if (band.minInputPerM != null && price < band.minInputPerM) return false;
  if (band.maxInputPerM != null && price > band.maxInputPerM) return false;
  return true;
}

/**
 * Bands are consulted by ascending floor, but an OPEN-ENDED band (no ceiling)
 * is a weak condition: it is consulted only after every closed band had a
 * chance. Without this rule a flagship band like `{min: 0.8}` would swallow
 * every priced model before reasoning's `{min: 5}` is ever asked.
 * Among two open-ended bands the HIGHER floor is the more specific claim, so
 * they are consulted by descending floor (an unbounded band must not eat the
 * tier above it).
 */
export function bandOrder(match: ResolvedTierMatch): TierLevel[] {
  const configured = PATTERN_ORDER.filter((t) => match[t].minInputPerM != null || match[t].maxInputPerM != null);
  const floor = (t: TierLevel) => match[t].minInputPerM ?? 0;
  const closed = configured.filter((t) => match[t].maxInputPerM != null).sort((a, b) => floor(a) - floor(b));
  const open = configured.filter((t) => match[t].maxInputPerM == null).sort((a, b) => floor(b) - floor(a));
  return [...closed, ...open];
}

/**
 * Does the model match ANY positive condition of `t` (patterns / price band /
 * reasoning flag)? Used to evaluate another tier's `excludeTiers` anchor. The
 * referenced tier's own exclude list is NOT consulted — the anchor is the set of
 * models its CONDITIONS describe, which is what "these tiers' models" means.
 */
export function matchesTierConditions(tier: TierLevel, input: TierClassifyInput, match: ResolvedTierMatch): boolean {
  const mid = input.modelId.toLowerCase();
  if (globMatchAny(match[tier].patterns, mid)) return true;
  if (bandHit(match[tier], input.inputPerM)) return true;
  if (tier === 'reasoning' && input.reasoningFlag) return true;
  return false;
}

/** Classify a model by the effective match config (see the chain above).
 * Returns `'unclassified'` when nothing claims it — there is no residual tier
 * any more (ADR-0012). Hand-configured models (no captured tierMatch) never
 * reach this function; explicit pins short-circuit it in the registry. */
export function classifyTier(input: TierClassifyInput, match: ResolvedTierMatch): PoolMembership {
  const mid = input.modelId.toLowerCase();
  const price = input.inputPerM;
  const anchorVetoed = (tier: TierLevel) =>
    (match[tier].excludeTiers ?? []).some((other) => other !== tier && matchesTierConditions(other, input, match));
  // Gate = this tier's own exclude list + its excludeTiers anchors.
  const claim = (tier: TierLevel, hits: boolean) =>
    hits &&
    !(match[tier].exclude?.length && globMatchAny(match[tier].exclude, mid)) &&
    !anchorVetoed(tier);
  // 2. Name patterns — explicit naming beats another tier's band.
  for (const tier of PATTERN_ORDER) if (claim(tier, globMatchAny(match[tier].patterns, mid))) return tier;
  // 3. Price bands — closed by ascending floor, then open-ended by descending floor.
  for (const tier of bandOrder(match)) if (claim(tier, bandHit(match[tier], price))) return tier;
  // 4. The mere reasoning flag.
  if (claim('reasoning', input.reasoningFlag)) return 'reasoning';
  // 5. No residual: an unclaimed model joins no pool.
  return 'unclassified';
}
