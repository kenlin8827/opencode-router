import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RouterConfig } from '../src/config/types.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { FinOpsTracker } from '../src/metrics/finops-tracker.js';
import { PipelineOrchestrator } from '../src/pipeline/orchestrator.js';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config/index.js';

/**
 * Auth mirror of server.ts preHandler key resolution: when the local
 * config.yaml defines apiKeys, inference endpoints require a valid key even
 * though the test config passes none (disk keys win over the test config by
 * design). Reuse the first enabled disk key so the e2e cases run both on
 * machines with a populated config.yaml and in clean CI checkouts.
 */
function authHeaders(): Record<string, string> {
  const diskKeys = (loadConfig().apiKeys || []).filter(k => k.enabled !== false && k.key);
  return diskKeys.length > 0 ? { authorization: `Bearer ${diskKeys[0].key}` } : {};
}

const baseConfig: RouterConfig = {
  port: 3000,
  host: '127.0.0.1',
  baselineModel: 'flagship-1',
  fallback: {
    enabled: false,
    maxRetries: 1,
    escalateTier: 'flagship',
    injectErrorContext: false,
  },
  circuitBreaker: {
    enabled: true,
    failureThreshold: 3,
  },
  retry: {
    enabled: true,
    inplace: {
      enabled: true,
      maxAttempts: 1,
      backoffMs: 10,
      jitterMs: 5,
    },
    failover: {
      enabled: true,
      maxAttempts: 3,
      tierCrossPolicy: 'allow_escalate',
    },
  },
  models: [
    {
      id: 'fast-1',
      provider: 'mock',
      upstreamModel: 'fast-1',
      tier: 'fast',
      priority: 1,
      isDefaultInTier: true,
      pricing: { input: 0.15, cacheRead: 0.015, output: 0.6 },
    },
    {
      id: 'fast-2',
      provider: 'mock',
      upstreamModel: 'fast-2',
      tier: 'fast',
      priority: 2,
      pricing: { input: 0.15, cacheRead: 0.015, output: 0.6 },
    },
    {
      id: 'flagship-1',
      provider: 'mock',
      upstreamModel: 'flagship-1',
      tier: 'flagship',
      priority: 1,
      isDefaultInTier: true,
      pricing: { input: 3.0, cacheRead: 0.3, output: 15.0 },
    },
  ],
  combos: [
    { id: 'combo-priority', selection: 'priority', models: ['fast-1', 'fast-2'] },
    { id: 'combo-single', selection: 'priority', models: ['fast-1'] },
    { id: 'combo-cross', selection: 'priority', models: ['fast-1', 'flagship-1'] },
    { id: 'combo-rr', selection: 'round_robin', models: ['fast-1', 'fast-2'] },
    { id: 'combo-weighted', selection: 'weighted', models: [{ id: 'fast-1', weight: 1000000 }, { id: 'fast-2', weight: 1 }] },
    { id: 'combo-unknown-member', selection: 'priority', models: ['ghost-model', 'fast-2'] },
  ],
};

function makeOrchestrator(config: RouterConfig) {
  const registry = new ProviderRegistry(config, true);
  const tracker = new FinOpsTracker();
  const orchestrator = new PipelineOrchestrator(config, registry, tracker);
  return { registry, orchestrator };
}

describe('Custom Model Combos: routing & execution', () => {
  it('should route a combo-named request to the first member under priority selection', async () => {
    const { registry, orchestrator } = makeOrchestrator(baseConfig);

    const result = await orchestrator.process({
      model: 'combo-priority',
      messages: [{ role: 'user', content: 'Hello combo' }],
    } as any);

    assert.equal(result.modelUsed, 'fast-1');
    assert.equal(result.tierUsed, 'fast');
    assert.equal(result.failoverOccurred, false);
    assert.equal(registry.isCombo('combo-priority'), true);
  });

  it('should fail over in combo config order when the leader hits a hard 402', async () => {
    const { registry, orchestrator } = makeOrchestrator(baseConfig);

    const result = await orchestrator.process({
      model: 'combo-priority',
      messages: [{ role: 'user', content: 'Hello combo' }],
      __simulate_error_model__: 'fast-1',
      __simulate_status__: 402,
      __simulate_message__: 'insufficient_quota',
    } as any);

    assert.equal(result.modelUsed, 'fast-2');
    assert.equal(result.failoverOccurred, true);
    assert.deepEqual(result.failoverPath, ['fast-1', 'fast-2']);

    // Leader breaker hard-tripped by the 402
    assert.equal(registry.getCircuitBreakerManager().getBreaker('fast-1')?.getState(), 'OPEN');
  });

  it('must NOT escalate outside the combo when all members fail (composition is authoritative)', async () => {
    const { orchestrator } = makeOrchestrator(baseConfig);

    // combo-single has exactly one member (fast-1); flagship-1 is healthy but
    // NOT in the combo — the request must fail instead of silently escalating.
    await assert.rejects(
      async () =>
        orchestrator.process({
          model: 'combo-single',
          messages: [{ role: 'user', content: 'Hello combo' }],
          __simulate_error_model__: 'fast-1',
          __simulate_status__: 503,
          __simulate_message__: 'down hard',
        } as any),
      (err: any) => {
        assert.ok(err.message.includes('503') || err.message.includes('down hard'));
        return true;
      }
    );
  });

  it('should skip a tripped member and lead with the first healthy one (no failover counted)', async () => {
    const { registry, orchestrator } = makeOrchestrator(baseConfig);
    registry.getCircuitBreakerManager().getBreaker('fast-1')?.trip('pre-tripped', 'MANUAL', 3600000);

    const result = await orchestrator.process({
      model: 'combo-priority',
      messages: [{ role: 'user', content: 'Hello combo' }],
    } as any);

    assert.equal(result.modelUsed, 'fast-2');
    assert.equal(result.failoverAttempts, 1);
  });

  it('should support cross-tier combos and report the executed member tier', async () => {
    const { orchestrator } = makeOrchestrator(baseConfig);

    const result = await orchestrator.process({
      model: 'combo-cross',
      messages: [{ role: 'user', content: 'Hello combo' }],
    } as any);

    assert.equal(result.modelUsed, 'fast-1');
    assert.equal(result.tierUsed, 'fast');
  });

  it('round_robin selection should rotate the leader across members', async () => {
    const { orchestrator } = makeOrchestrator(baseConfig);

    const r1 = await orchestrator.process({
      model: 'combo-rr',
      messages: [{ role: 'user', content: 'Turn 1' }],
    } as any);
    const r2 = await orchestrator.process({
      model: 'combo-rr',
      messages: [{ role: 'user', content: 'Turn 2' }],
    } as any);

    assert.deepEqual([r1.modelUsed, r2.modelUsed], ['fast-1', 'fast-2']);
  });

  it('weighted selection should draw the leader by member weight', async () => {
    const { orchestrator } = makeOrchestrator(baseConfig);

    // weight 1,000,000 : 1 — probability of the minority draw is ~1e-6
    const result = await orchestrator.process({
      model: 'combo-weighted',
      messages: [{ role: 'user', content: 'Hello combo' }],
    } as any);

    assert.equal(result.modelUsed, 'fast-1');
  });

  it('should drop unregistered member ids and execute the remaining ones', async () => {
    const { registry, orchestrator } = makeOrchestrator(baseConfig);

    const members = registry.resolveCombo('combo-unknown-member');
    assert.deepEqual(members.map(m => m.id), ['fast-2']);

    const result = await orchestrator.process({
      model: 'combo-unknown-member',
      messages: [{ role: 'user', content: 'Hello combo' }],
    } as any);

    assert.equal(result.modelUsed, 'fast-2');
  });
});

describe('Custom Model Combos: exposure & config plumbing', () => {
  it('should list combos in /v1/models and resolve them in /v1/models/:id', async () => {
    const { app } = createServer(baseConfig, true);

    const list = await app.inject({ method: 'GET', url: '/v1/models' });
    assert.equal(list.statusCode, 200);
    const ids = (list.json().data || []).map((m: any) => m.id);
    assert.ok(ids.includes('combo-priority'));

    const single = await app.inject({
      method: 'GET',
      url: '/v1/models/combo-priority',
      headers: authHeaders(),
    });
    assert.equal(single.statusCode, 200);

    const unknown = await app.inject({
      method: 'GET',
      url: '/v1/models/no-such-combo',
      headers: authHeaders(),
    });
    assert.equal(unknown.statusCode, 404);
  });

  it('should execute a combo end-to-end through POST /v1/chat/completions', async () => {
    const { app } = createServer(baseConfig, true);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(),
      payload: {
        model: 'combo-priority',
        messages: [{ role: 'user', content: 'What is 42?' }],
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-ocr-model'], 'fast-1');
  });

  it('applyCombos should hot-swap the combo registry snapshot', () => {
    const { registry } = makeOrchestrator(baseConfig);
    assert.equal(registry.isCombo('combo-priority'), true);
    assert.equal(registry.isCombo('combo-new'), false);

    registry.applyCombos([{ id: 'combo-new', selection: 'priority', models: ['fast-1'] }]);
    assert.equal(registry.isCombo('combo-priority'), false);
    assert.equal(registry.isCombo('combo-new'), true);
    assert.equal(registry.resolveCombo('combo-new').length, 1);
  });
});
