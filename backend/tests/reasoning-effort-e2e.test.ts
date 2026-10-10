import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderRegistry } from '../src/providers/registry.js';
import { FinOpsTracker } from '../src/metrics/finops-tracker.js';
import { PipelineOrchestrator } from '../src/pipeline/orchestrator.js';
import { RouterConfig } from '../src/config/types.js';
import { ChatCompletionRequest } from '../src/types/openai.js';
import { injectWarnThrottle } from '../src/observability/warn-throttle.js';

// ---------------------------------------------------------------------------
// End-to-end: orchestrator really rewires the request when the pool can't
// serve the requested effort, and the response carries the truth.
// ---------------------------------------------------------------------------

function configWithEffortTiers(
  models: Array<{
    id: string;
    tier: 'lite' | 'plus' | 'pro' | 'ultra';
    supportedReasoningEfforts?: ('none' | 'low' | 'medium' | 'high' | 'xhigh')[];
  }>
): RouterConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    baselineModel: 'mock-lite',
    fallback: { enabled: false, maxRetries: 0, escalateTier: 'plus', injectErrorContext: false },
    providers: [],
    models: models.map((m) => ({
      id: m.id,
      provider: 'mock',
      upstreamModel: m.id,
      tier: m.tier,
      pricing: { input: 1, output: 2, cacheRead: 0.5 },
      supportedReasoningEfforts: m.supportedReasoningEfforts,
      wire: 'openai',
    })),
  };
}

describe('End-to-End: orchestrator surfaces the resolved thinking effort', () => {
  it('client asked xhigh, served high → header fields + ExecutionResult reflect the downgrade', async () => {
    // pro tier only has [high] → no perfect xhigh match → downgrade to high
    const cfg = configWithEffortTiers([
      { id: 'pro-only-high', tier: 'pro', supportedReasoningEfforts: ['high'] },
    ]);
    const reg = new ProviderRegistry(cfg, true);
    const orch = new PipelineOrchestrator(cfg, reg, new FinOpsTracker());

    const req: ChatCompletionRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'explain something hard' }],
      reasoning_effort: 'xhigh',
    };
    const result = await orch.process(req);
    assert.strictEqual(result.requestedEffort, 'xhigh');
    assert.strictEqual(result.actualEffort, 'high', 'must downgrade to the only supported level');
    assert.strictEqual(result.reasoningDegraded, true);
  });

  it('ExecutionResult.actualEffort mirrors what the upstream payload builder will see', async () => {
    // The contract that provider builders depend on: orchestrator writes the
    // resolved effort back into the request so the upstream sees the truth
    // (not the original client ask). Verify via the registry's mock-mode
    // round-trip: the served model and its supported effort are reported
    // back through `modelUsed` and `actualEffort`.
    const cfg = configWithEffortTiers([
      { id: 'plus-only-medium', tier: 'plus', supportedReasoningEfforts: ['medium'] },
    ]);
    const reg = new ProviderRegistry(cfg, true);
    const orch = new PipelineOrchestrator(cfg, reg, new FinOpsTracker());

    const result = await orch.process({
      model: 'auto',
      messages: [{ role: 'user', content: 'plan a trip' }],
      reasoning_effort: 'high',
    } as ChatCompletionRequest);
    assert.strictEqual(result.actualEffort, 'medium');
    assert.strictEqual(result.reasoningDegraded, true);
    assert.strictEqual(result.modelUsed, 'plus-only-medium');
  });

  it('no reasoning_effort requested → ExecutionResult reflects requestedEffort=none', async () => {
    const cfg = configWithEffortTiers([
      { id: 'pro', tier: 'pro', supportedReasoningEfforts: ['high'] },
    ]);
    const reg = new ProviderRegistry(cfg, true);
    const orch = new PipelineOrchestrator(cfg, reg, new FinOpsTracker());
    const result = await orch.process({
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
    } as ChatCompletionRequest);
    assert.strictEqual(result.requestedEffort, 'none');
    assert.strictEqual(result.actualEffort, 'none');
    assert.strictEqual(result.reasoningDegraded, false);
  });

  it('explicit model choice bypasses the effort picker (preferredModel is honored)', async () => {
    // Client pinned `pro-only-high` and asked for xhigh. The orchestrator
    // must NOT re-route to a different model — explicit pin is the user's
    // contract. The actualEffort reflects the served model's capability
    // (downgrade to high), but the modelUsed is unchanged.
    const cfg = configWithEffortTiers([
      { id: 'pinned-high', tier: 'pro', supportedReasoningEfforts: ['high'] },
      { id: 'alternate-xhigh', tier: 'pro', supportedReasoningEfforts: ['xhigh'] },
    ]);
    const reg = new ProviderRegistry(cfg, true);
    const orch = new PipelineOrchestrator(cfg, reg, new FinOpsTracker());

    const result = await orch.process({
      model: 'pinned-high',
      messages: [{ role: 'user', content: 'test' }],
      reasoning_effort: 'xhigh',
    } as ChatCompletionRequest);
    assert.strictEqual(result.modelUsed, 'pinned-high', 'explicit pin must win over re-routing');
    assert.strictEqual(result.actualEffort, 'high', 'but actual effort reflects what was served');
    assert.strictEqual(result.reasoningDegraded, true);
  });
});

describe('End-to-End: thinking-effort warn is throttled', () => {
  it('100 identical downgrades produce ONE warn line, not 100', async () => {
    // QPS-style stress: with a pool that always downgrades, the hot path
    // would log once per request without throttling. The throttle
    // collapses identical (model, requested, actual) tuples.
    const cfg = configWithEffortTiers([
      { id: 'always-downgrade', tier: 'pro', supportedReasoningEfforts: ['high'] },
    ]);
    const reg = new ProviderRegistry(cfg, true);
    const orch = new PipelineOrchestrator(cfg, reg, new FinOpsTracker());

    // Inject a sink-bound throttle for this test only.
    const captured: string[] = [];
    const restore = injectWarnThrottle({
      windowMs: 60_000,
      maxPerWindow: 1000,
      sink: (line) => captured.push(line),
    });
    try {
      for (let i = 0; i < 100; i++) {
        await orch.process({
          model: 'auto',
          messages: [{ role: 'user', content: `request ${i}` }],
          reasoning_effort: 'xhigh',
        } as ChatCompletionRequest);
      }
      const downgradeLines = captured.filter((l) => l.includes('thinking effort downgraded'));
      assert.strictEqual(
        downgradeLines.length,
        1,
        `expected exactly 1 throttled warn line for 100 identical downgrades, got ${downgradeLines.length}`
      );
    } finally {
      restore();
    }
  });
});