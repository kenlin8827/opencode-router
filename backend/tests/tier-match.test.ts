import { describe, it, expect } from 'bun:test';
import { DEFAULT_TIER_MATCH, bandOrder, classifyTier, resolveTierMatch, type ResolvedTierMatch } from '../src/providers/tier-match.js';

const base = resolveTierMatch(undefined);

/**
 * ADR-0012 — symmetric tiers, no residual. classifyTier now returns
 * PoolMembership: 'fast' | 'flagship' | 'reasoning' | 'unclassified'.
 */
describe('tier smart match (providers/tier-match, ADR-0012)', () => {
  it('classifies name-keyword models as fast (incl. haiku)', () => {
    expect(classifyTier({ modelId: 'gemini-2.5-flash', reasoningFlag: false }, base)).toBe('fast');
    expect(classifyTier({ modelId: 'gpt-4o-mini', reasoningFlag: false }, base)).toBe('fast');
    expect(classifyTier({ modelId: 'claude-haiku-4-5', reasoningFlag: false }, base)).toBe('fast');
  });

  it('includes free/local models (input = 0) in the fast band', () => {
    expect(classifyTier({ modelId: 'qwen3-32b', inputPerM: 0, reasoningFlag: false }, base)).toBe('fast');
  });

  it('NO residual any more: a model nothing claims is unclassified', () => {
    // no pattern, no pricing (bands skip), no reasoning flag
    expect(classifyTier({ modelId: 'some-unknown-model', inputPerM: undefined, reasoningFlag: false }, base)).toBe('unclassified');
    // priced OUTSIDE every band is unclassified too (flagship is a real band now)
    const custom = resolveTierMatch({ flagship: { match: { minInputPerM: 20, maxInputPerM: 40 } } });
    expect(classifyTier({ modelId: 'plain-cheap', inputPerM: 1.5, reasoningFlag: false }, custom)).toBe('unclassified');
  });

  it('flagship has a REAL price band (the dead-config field is gone)', () => {
    expect(classifyTier({ modelId: 'gpt-5.2', inputPerM: 2.5, reasoningFlag: false }, base)).toBe('flagship');
    // a custom flagship ceiling pushes the price up into reasoning's band
    const custom = resolveTierMatch({ flagship: { match: { minInputPerM: 1, maxInputPerM: 2 } } });
    expect(classifyTier({ modelId: 'mid-priced', inputPerM: 3, reasoningFlag: false }, custom)).toBe('unclassified');
    expect(classifyTier({ modelId: 'mid-priced', inputPerM: 3, reasoningFlag: true }, custom)).toBe('reasoning');
  });

  it('price >= 5 is reasoning; the flag is consulted AFTER bands (existing rule)', () => {
    expect(classifyTier({ modelId: 'claude-sonnet-5', inputPerM: 15, reasoningFlag: false }, base)).toBe('reasoning');
    // ADR-0012 behavior delta: a mid-priced flagged model is claimed by flagship's
    // band first — 'bands outrank the reasoning flag' now applies to flagship too.
    expect(classifyTier({ modelId: 'kimi-k2', inputPerM: 1, reasoningFlag: true }, base)).toBe('flagship');
    // unpriced + flag still reaches reasoning (bands skip)
    expect(classifyTier({ modelId: 'local-qwq', reasoningFlag: true }, base)).toBe('reasoning');
  });

  it('user match overrides defaults per field', () => {
    const custom = resolveTierMatch({ fast: { match: { maxInputPerM: 1.2 } }, reasoning: { match: { patterns: ['*qwq*'] } } });
    expect(classifyTier({ modelId: 'glm-4-air', inputPerM: 1.0, reasoningFlag: false }, custom)).toBe('fast');
    expect(classifyTier({ modelId: 'qwq-32b', inputPerM: 0.5, reasoningFlag: false }, custom)).toBe('reasoning');
    // fast patterns default kept because only maxInputPerM was replaced
    expect(custom.fast.patterns).toEqual(DEFAULT_TIER_MATCH.fast.patterns);
  });

  it('every tier is merged symmetrically (flagship band is no longer ignored)', () => {
    const custom = resolveTierMatch({ flagship: { match: { patterns: ['*sonnet*'], minInputPerM: 3.749, maxInputPerM: 125 } } });
    expect(custom.flagship.patterns).toEqual(['*sonnet*']);
    expect(custom.flagship.minInputPerM).toBe(3.749);
    expect(custom.flagship.maxInputPerM).toBe(125);
    // pattern claim is symmetric now: flagship claims sonnet like any other tier
    expect(classifyTier({ modelId: 'claude-sonnet-5', inputPerM: 15, reasoningFlag: true }, custom)).toBe('flagship');
  });

  it('bandOrder(): closed bands first by ascending floor, open-ended bands last', () => {
    expect(bandOrder(base)).toEqual(['fast', 'flagship', 'reasoning']);
    // Hand-built: the per-field merge in resolveTierMatch() cannot CLEAR the
    // baseline flagship ceiling (blank = fall back to baseline), and an open-
    // ended flagship floor is exactly the trap bandOrder() defends against.
    const openFlagship: ResolvedTierMatch = {
      fast: { maxInputPerM: 0.8 },
      flagship: { minInputPerM: 0.8 }, // no ceiling → weak, consulted last
      reasoning: { minInputPerM: 5 },
    };
    expect(bandOrder(openFlagship)).toEqual(['fast', 'reasoning', 'flagship']);
    // ...which is what keeps an open-ended flagship floor from swallowing reasoning
    expect(classifyTier({ modelId: 'expensive', inputPerM: 15, reasoningFlag: false }, openFlagship)).toBe('reasoning');
    expect(classifyTier({ modelId: 'middle', inputPerM: 2.5, reasoningFlag: false }, openFlagship)).toBe('flagship');
  });

  it('overlapping bands resolve to the lower floor', () => {
    const custom = resolveTierMatch({
      fast: { match: { patterns: [], maxInputPerM: 10 } },
      reasoning: { match: { minInputPerM: 2, maxInputPerM: 8 }, patterns: [] },
      flagship: { match: { minInputPerM: 5, maxInputPerM: 100 }, patterns: [] },
    });
    expect(classifyTier({ modelId: 'overlap-model', inputPerM: 6, reasoningFlag: false }, custom)).toBe('fast');
  });

  it('per-tier exclude vetoes the AUTO-claim; the model keeps going down the chain', () => {
    const custom = resolveTierMatch({ fast: { match: { exclude: ['*mini*'] } } });
    // 'mini-r1' @ $0.5: fast pattern AND fast band both vetoed → flagship floor is 0.8 → unclaimed
    expect(classifyTier({ modelId: 'openai/mini-r1', inputPerM: 0.5, reasoningFlag: false }, custom)).toBe('unclassified');
    // a cheap NON-mini model is still fast
    expect(classifyTier({ modelId: 'openai/cheap-nano', inputPerM: 0.5, reasoningFlag: false }, custom)).toBe('fast');
  });

  it('excludeTiers anchor: this tier refuses models the other tier conditions claim', () => {
    // flagship [1, 20] overlaps reasoning [5, ∞) and would win by lower floor…
    const overlap = resolveTierMatch({ flagship: { match: { minInputPerM: 1, maxInputPerM: 20 } } });
    expect(classifyTier({ modelId: 'expensive-plain', inputPerM: 10, reasoningFlag: false }, overlap)).toBe('flagship');
    // …unless flagship anchor-excludes reasoning: the band claim is filtered out
    const anchored = resolveTierMatch({
      flagship: { match: { minInputPerM: 1, maxInputPerM: 20, excludeTiers: ['reasoning'] } },
    });
    expect(classifyTier({ modelId: 'expensive-plain', inputPerM: 10, reasoningFlag: false }, anchored)).toBe('reasoning');
    // below reasoning's floor the anchor does not bite → flagship keeps it
    expect(classifyTier({ modelId: 'mid-plain', inputPerM: 3, reasoningFlag: false }, anchored)).toBe('flagship');
    // a flagged model matches reasoning's CONDITION even without pricing → excluded too
    expect(classifyTier({ modelId: 'other-mid', inputPerM: 3, reasoningFlag: true }, anchored)).toBe('reasoning');
    // self-reference is ignored
    const self = resolveTierMatch({ flagship: { match: { excludeTiers: ['flagship'] } } });
    expect(classifyTier({ modelId: 'gpt-5.2', inputPerM: 2.5, reasoningFlag: false }, self)).toBe('flagship');
  });

  it('an anchor-vetoed model can be rescued by another tier, not hidden', () => {
    const custom = resolveTierMatch({
      fast: { match: { excludeTiers: ['reasoning'] } },
      reasoning: { match: { patterns: ['*r1*'] } },
    });
    // 'deepseek-r1' @ $0.55: fast's band would claim it, but reasoning's PATTERN
    // matches → anchor veto at fast → reasoning claims it via its own pattern
    expect(classifyTier({ modelId: 'deepseek-r1', inputPerM: 0.55, reasoningFlag: true }, custom)).toBe('reasoning');
    // a cheap model reasoning does NOT describe still lands in fast
    expect(classifyTier({ modelId: 'nano-plain', inputPerM: 0.55, reasoningFlag: false }, custom)).toBe('fast');
  });

  // Regression locks for behavior that the live ruleset depends on but is easy
  // to break with an off-by-one or a missing guard.
  describe('regression locks (boundary + NaN + glob)', () => {
    it('price exactly at the flagship/reasoning boundary (5.0) stays in flagship (closed-band wins by lower floor)', () => {
      // bandOrder: closed bands first by ascending floor → flagship [0.8, 5]
      // is consulted before reasoning [5, +∞). Both bands include the boundary,
      // so the first-evaluated (lower floor) tier wins.
      expect(classifyTier({ modelId: 'boundary-5', inputPerM: 5.0, reasoningFlag: false }, base)).toBe('flagship');
      // 5.0 + reasoningFlag: bands are still consulted before the flag
      expect(classifyTier({ modelId: 'boundary-5-flagged', inputPerM: 5.0, reasoningFlag: true }, base)).toBe('flagship');
    });

    it('price exactly at the fast/flagship boundary (0.8) lands in fast (closed-band wins by lower floor)', () => {
      expect(classifyTier({ modelId: 'boundary-08', inputPerM: 0.8, reasoningFlag: false }, base)).toBe('fast');
    });

    it('NaN price is rejected by every band — model joins no pool, not the last-evaluated one', () => {
      // Without the Number.isNaN guard, `NaN < x` and `NaN > x` are both false,
      // so bandHit() would return true for EVERY configured band and the model
      // would silently land in whatever bandOrder() consulted last.
      expect(classifyTier({ modelId: 'corrupt-row', inputPerM: Number.NaN, reasoningFlag: false }, base)).toBe('unclassified');
      expect(classifyTier({ modelId: 'corrupt-row', inputPerM: Number.NaN, reasoningFlag: true }, base)).toBe('reasoning');
    });
  });
});
