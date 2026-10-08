/**
 * Frontend mirror of backend/src/providers/tier-match.ts — the boot-time
 * smart-match that classifies models into tiers. Kept in sync deliberately:
 * live config is fetched from /api/ui/tier-pools (`match`) whenever possible;
 * DEFAULT_TIER_MATCH is only the offline/fallback copy of the built-in
 * baseline. Classification precedence: name patterns (fast → reasoning →
 * flagship) > reasoning flag > raw-price band > flagship.
 */

export type Tier = 'fast' | 'flagship' | 'reasoning';

export interface TierMatchCfg {
  patterns?: string[];
  minInputPerM?: number;
  maxInputPerM?: number;
}

export type ResolvedTierMatch = Record<Tier, TierMatchCfg>;

export const DEFAULT_TIER_MATCH: ResolvedTierMatch = {
  fast: { patterns: ['*flash*', '*lite*', '*speed*', '*turbo*', '*mini*', '*fast*', '*haiku*'], maxInputPerM: 0.8 },
  flagship: {},
  reasoning: { minInputPerM: 5 },
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

export type TierReasonCode = 'name' | 'flag' | 'cost' | 'default';

export function classifyTierDetailed(
  modelId: string,
  inputPerM: number | undefined,
  reasoningFlag: boolean,
  match: ResolvedTierMatch,
): { tier: Tier; reason: TierReasonCode } {
  const mid = modelId.toLowerCase();
  if (globMatchAny(match.fast.patterns, mid)) return { tier: 'fast', reason: 'name' };
  if (globMatchAny(match.reasoning.patterns, mid)) return { tier: 'reasoning', reason: 'name' };
  if (globMatchAny(match.flagship.patterns, mid)) return { tier: 'flagship', reason: 'name' };
  if (reasoningFlag) return { tier: 'reasoning', reason: 'flag' };
  if (bandHit(match.reasoning, inputPerM)) return { tier: 'reasoning', reason: 'cost' };
  if (bandHit(match.fast, inputPerM)) return { tier: 'fast', reason: 'cost' };
  return { tier: 'flagship', reason: 'default' };
}
