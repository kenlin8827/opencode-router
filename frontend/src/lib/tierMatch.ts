/**
 * Frontend mirror of backend/src/providers/tier-match.ts — the smart-match that
 * decides which candidate pool a model belongs to. Kept in sync deliberately:
 * live config is fetched from /api/ui/tier-pools (`match`) whenever possible;
 * DEFAULT_TIER_MATCH is only the offline/fallback copy of the built-in baseline.
 *
 * ADR-0012: there is NO residual tier any more. All four tiers are configured
 * identically (patterns / price band / exclude), and a model that matches no
 * positive condition is `'unclassified'` — it joins no candidate pool instead of
 * silently landing in a default tier.
 *
 * Chain for one model (first hit wins):
 *   name patterns (lite → pro → plus → ultra)
 *   > price bands (closed bands by ascending floor, then open-ended ones)
 *   > thinking-effort flag (claims Pro)
 *   > unclassified
 * `excludeTiers` (model-side) and each tier's `exclude` gate the automatic
 * claims; explicit pins short-circuit this function in the registry.
 */

export type Tier = 'lite' | 'plus' | 'pro' | 'ultra';

/** Pool membership: the four tiers, or nothing claimed the model at all. */
export type Membership = Tier | 'unclassified';

export interface TierMatchCfg {
  patterns?: string[];
  minInputPerM?: number;
  maxInputPerM?: number;
  exclude?: string[]; // vetoes this tier's auto-claim (explicit pins bypass)
  excludeTiers?: Tier[]; // ADR-0012 anchor-exclude: models matching these tiers' conditions are not claimed here
}

export type ResolvedTierMatch = Record<Tier, TierMatchCfg>;

export const PATTERN_ORDER: Tier[] = ['lite', 'pro', 'plus', 'ultra'];

// Built-in baseline — mirrored from backend providers/tier-match.ts. Fully
// PRICE-DRIVEN: NO tier presets name patterns (vendor tier words mean very
// different prices across vendors). Classification is the price band over the
// raw catalog $/M input price; the catalog thinking-effort flag → pro; nothing
// matches → 'unclassified'. Name patterns stay user-configurable per tier.
export const DEFAULT_TIER_MATCH: ResolvedTierMatch = {
  lite: { maxInputPerM: 0.8 },
  plus: { minInputPerM: 0.8, maxInputPerM: 3 },
  pro: { minInputPerM: 3, maxInputPerM: 8 },
  ultra: { minInputPerM: 8 },
};

/** Mirror of backend utils/glob.ts: `*` any run, `?` single char, no-wildcard = substring. */
function globMatch(pattern: string, value: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  const v = value.toLowerCase();
  if (!/[*?]/.test(p)) return v.includes(p);
  const regex = new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return regex.test(v);
}

const globMatchAny = (patterns: string[] | undefined, value: string): boolean =>
  Boolean(patterns?.length) && patterns!.some((p) => globMatch(p, value));

function bandHit(band: TierMatchCfg, price?: number): boolean {
  if (price == null) return false;
  if (band.minInputPerM == null && band.maxInputPerM == null) return false;
  if (band.minInputPerM != null && price < band.minInputPerM) return false;
  if (band.maxInputPerM != null && price > band.maxInputPerM) return false;
  return true;
}

/** Mirror of backend bandOrder(): a band without a ceiling is a WEAK condition
 * — consulted after every closed band (ascending floor), then open-ended bands
 * by DESCENDING floor so an unbounded band cannot eat the tier above it. */
export function bandOrder(match: ResolvedTierMatch): Tier[] {
  const configured = PATTERN_ORDER.filter((t) => match[t].minInputPerM != null || match[t].maxInputPerM != null);
  const floor = (t: Tier) => match[t].minInputPerM ?? 0;
  const closed = configured.filter((t) => match[t].maxInputPerM != null).sort((a, b) => floor(a) - floor(b));
  const open = configured.filter((t) => match[t].maxInputPerM == null).sort((a, b) => floor(b) - floor(a));
  return [...closed, ...open];
}

/** Mirror of backend matchesTierConditions(): does the model match ANY positive
 * condition of `tier`? Used to evaluate another tier's excludeTiers anchor. */
export function matchesTierConditions(
  tier: Tier,
  modelId: string,
  inputPerM: number | undefined,
  reasoningFlag: boolean,
  match: ResolvedTierMatch,
): boolean {
  const mid = modelId.toLowerCase();
  if (globMatchAny(match[tier].patterns, mid)) return true;
  if (bandHit(match[tier], inputPerM)) return true;
  if (tier === 'pro' && reasoningFlag) return true;
  return false;
}

export type TierReasonCode = 'name' | 'flag' | 'cost' | 'unclassified';

export function classifyTierDetailed(
  modelId: string,
  inputPerM: number | undefined,
  reasoningFlag: boolean,
  match: ResolvedTierMatch,
): { tier: Membership; reason: TierReasonCode } {
  const mid = modelId.toLowerCase();
  const anchorVetoed = (tier: Tier) =>
    (match[tier].excludeTiers ?? []).some((other) => other !== tier && matchesTierConditions(other, modelId, inputPerM, reasoningFlag, match));
  const claim = (tier: Tier, hits: boolean) =>
    hits &&
    !(match[tier].exclude?.length && globMatchAny(match[tier].exclude, mid)) &&
    !anchorVetoed(tier);
  for (const tier of PATTERN_ORDER) if (claim(tier, globMatchAny(match[tier].patterns, mid))) return { tier, reason: 'name' };
  for (const tier of bandOrder(match)) if (claim(tier, bandHit(match[tier], inputPerM))) return { tier, reason: 'cost' };
  if (claim('pro', reasoningFlag)) return { tier: 'pro', reason: 'flag' };
  return { tier: 'unclassified', reason: 'unclassified' };
}
