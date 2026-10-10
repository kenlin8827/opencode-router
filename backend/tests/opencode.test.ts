import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeConnector } from '../src/opencode/sync.js';

describe('OpenCode v2 Connect & Dynamic Model Sync', () => {
  const connector = new OpenCodeConnector();

  it('should auto-discover local OpenCode background service credentials', () => {
    assert.strictEqual(connector.isAvailable(), true, 'Expected OpenCode service config to be found');
    const cfg = connector.getServiceConfig();
    assert.ok(cfg?.baseUrl.includes('49374'));
    assert.ok(cfg?.authHeader.startsWith('Basic '));
  });

  it('should fetch active providers from OpenCode v2 REST API', async () => {
    const providers = await connector.getProviders();
    assert.ok(Array.isArray(providers));
    assert.ok(providers.length >= 5);
    const names = providers.map(p => p.name);
    assert.ok(names.some(n => n.includes('Alibaba') || n.includes('DeepSeek') || n.includes('Kimi')));
  });

  it('should dynamically sync models and automatically categorize into lite, plus, pro, and ultra tiers', async () => {
    const tierModels = await connector.syncToTierModels();
    assert.ok(tierModels.length > 10, 'Expected dozens of active models synced');

    const lite = tierModels.filter(m => m.tier === 'lite');
    const plus = tierModels.filter(m => m.tier === 'plus');
    const pro = tierModels.filter(m => m.tier === 'pro');
    const ultra = tierModels.filter(m => m.tier === 'ultra');

    assert.ok(lite.length > 0, 'Lite tier models should be present');
    assert.ok(plus.length > 0, 'Plus tier models should be present');
    assert.ok(pro.length > 0, 'Pro tier models should be present');

    // Check pricing presence
    assert.ok(lite[0].pricing.input !== undefined);
    assert.ok(lite[0].pricing.output !== undefined);
    assert.ok(lite[0].pricing.cacheRead !== undefined);
  });
});
