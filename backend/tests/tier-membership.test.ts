import { describe, it, expect } from 'bun:test';
import { ProviderRegistry } from '../src/providers/registry.js';
import { resolveTierMatch } from '../src/providers/tier-match.js';
import type { RouterConfig } from '../src/config/types.js';
import type { ModelRegistration } from '../src/config/types.js';

/**
 * ADR-0012 — registry-level membership: the fourth state ('unclassified')
 * joins no pool, never becomes a tier representative, and an explicit pin
 * outranks the tier-side vetoes. NON-mock mode: reclassifyTiers() is a no-op
 * under mockMode by design.
 */

const model = (id: string, tier: ModelRegistration['tier'], extra: Partial<ModelRegistration> = {}): ModelRegistration => ({
  id,
  provider: 'p',
  upstreamModel: id,
  tier,
  pricing: { input: 1, output: 2, cacheRead: 0.1 },
  ...extra,
});

function makeRegistry(models: ModelRegistration[]): ProviderRegistry {
  const config = {
    port: 3000,
    host: '127.0.0.1',
    fallback: { enabled: false, maxRetries: 1, escalateTier: 'flagship', injectErrorContext: false },
    circuitBreaker: { enabled: false },
    models,
    tiers: {},
  } as unknown as RouterConfig;
  const registry = new ProviderRegistry(config, false);
  registry.setAutoRefreshTierMatch(false); // no disk re-reads in tests
  return registry;
}

describe('tier membership commit (ADR-0012 fourth state)', () => {
  it('an unclaimed model leaves every candidate pool but is NOT deleted', () => {
    const registry = makeRegistry([
      model('p/mid-priced', 'flagship', { tierMatch: { rawInputPerM: 2, reasoningFlag: false } }),
      model('p/no-condition', 'flagship', { tierMatch: { rawInputPerM: undefined, reasoningFlag: false } }),
    ]);
    registry.reclassifyTiers(resolveTierMatch({}), {});

    expect(registry.getCandidateModelsForTier('flagship', false).map((m) => m.id)).toEqual(['p/mid-priced']);
    expect(registry.getCandidateModelsForTier('fast', false)).toHaveLength(0);
    expect(registry.getAllModels()).toHaveLength(2); // still registered → direct calls work

    // and it is projected into the diagnostic 'unclassified' pool
    const { pool } = registry.resolveTierPool('unclassified', {}, { match: resolveTierMatch({}), overrides: {} });
    expect(pool.map((p) => p.model.id)).toEqual(['p/no-condition']);
  });

  it('an unclassified model can never be a tier representative', () => {
    const registry = makeRegistry([
      // registered FIRST so it would naively become the flagship representative
      model('p/no-condition', 'flagship', { tierMatch: { rawInputPerM: undefined, reasoningFlag: false } }),
      model('p/mid-priced', 'flagship', { tierMatch: { rawInputPerM: 2, reasoningFlag: false } }),
    ]);
    registry.reclassifyTiers(resolveTierMatch({}), {});
    expect(registry.getModelForTier('flagship', false).id).toBe('p/mid-priced');
  });

  it('an explicit pin outranks the tier-side vetoes and rescues a model into a pool', () => {
    const registry = makeRegistry([
      model('p/mystery-mid', 'flagship', { tierMatch: { rawInputPerM: undefined, reasoningFlag: false } }),
    ]);
    // nothing claims it → unclassified
    registry.reclassifyTiers(resolveTierMatch({}), {});
    expect(registry.getCandidateModelsForTier('reasoning', false)).toHaveLength(0);
    // catalog override pins it → the pin short-circuits the chain
    registry.reclassifyTiers(resolveTierMatch({}), { 'p||mystery-mid': { tier: 'reasoning' } });
    expect(registry.getCandidateModelsForTier('reasoning', false).map((m) => m.id)).toEqual(['p/mystery-mid']);
  });

  it('a model whose band is emptied by the user config degrades instead of hard-failing', () => {
    const registry = makeRegistry([
      model('p/fast-one', 'fast', { tierMatch: { rawInputPerM: 0.2, reasoningFlag: false }, isDefaultInTier: true }),
      model('p/mid-one', 'flagship', { tierMatch: { rawInputPerM: 2, reasoningFlag: false } }),
    ]);
    // flagship band [20,30] claims nothing → flagship pool is EMPTY (no residual)
    const match = resolveTierMatch({ flagship: { match: { minInputPerM: 20, maxInputPerM: 30 } } });
    registry.reclassifyTiers(match, {});
    expect(registry.getCandidateModelsForTier('flagship', false)).toHaveLength(0);
    // degradation is allowed (logged) but never lands on an unclassified model
    const picked = registry.getModelForTier('flagship', false);
    expect(['p/fast-one', 'p/mid-one']).toContain(picked.id);
    expect(picked.unclassified).not.toBe(true);
  });

  it('reclassify is idempotent and restores membership when the config widens again', () => {
    const registry = makeRegistry([model('p/no-condition', 'flagship', { tierMatch: { rawInputPerM: 4, reasoningFlag: false } })]);
    const narrow = resolveTierMatch({ flagship: { match: { minInputPerM: 100 } } });
    registry.reclassifyTiers(narrow, {});
    expect(registry.getCandidateModelsForTier('flagship', false)).toHaveLength(0);
    registry.reclassifyTiers(resolveTierMatch({}), {});
    expect(registry.getCandidateModelsForTier('flagship', false).map((m) => m.id)).toEqual(['p/no-condition']);
  });
});
