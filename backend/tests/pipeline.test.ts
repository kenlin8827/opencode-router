import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/index.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { FinOpsTracker } from '../src/metrics/finops-tracker.js';
import { PipelineOrchestrator } from '../src/pipeline/orchestrator.js';
import { ChatCompletionRequest } from '../src/types/openai.js';

describe('End-to-End Pipeline & FinOps Orchestration', () => {
  const config = loadConfig();
  const registry = new ProviderRegistry(config, true); // mockMode = true
  const tracker = new FinOpsTracker();
  const orchestrator = new PipelineOrchestrator(config, registry, tracker);

  it('1. Simple chitchat should execute on Lite tier and record FinOps savings', async () => {
    const req: ChatCompletionRequest = {
      model: 'auto-lite',
      messages: [{ role: 'user', content: 'hello there' }],
    };

    const result = await orchestrator.process(req);
    assert.strictEqual(result.tierUsed, 'lite');
    assert.ok(result.costUsd < result.baselineCostUsd, 'Lite tier cost must be lower than plus-tier baseline');
    assert.ok(result.savedCostUsd > 0, 'Saved cost must be positive');
  });

  it('2. Structured schema task with passing lite tier output completes with ~90% cost savings', async () => {
    const req: ChatCompletionRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'Extract entities in JSON format.' }],
      response_format: { type: 'json_object' },
    };

    const result = await orchestrator.process(req);
    assert.strictEqual(result.tierUsed, 'lite');
    assert.strictEqual(result.fallbackOccurred, false);
    assert.ok(result.savedCostUsd > 0);
  });

  it('3. Structured task with lite tier syntax error silently escalates to plus', async () => {
    const req: ChatCompletionRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'Strict schema extraction.' }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'StrictTest',
          schema: {
            type: 'object',
            required: ['mandatory_key_that_fails_on_fast_tier'],
            properties: {
              mandatory_key_that_fails_on_fast_tier: { type: 'string' },
            },
          },
        },
      },
    };

    const result = await orchestrator.process(req);
    assert.strictEqual(result.fallbackOccurred, true);
    assert.strictEqual(result.tierUsed, 'plus');
    assert.ok(result.fallbackReason?.includes('Missing required key'));
  });

  it('4. FinOpsTracker correctly aggregates savings and metrics', () => {
    const stats = tracker.getStats();
    assert.ok(stats.totalRequests >= 3);
    assert.ok(stats.fallbackCount >= 1);
    assert.ok(stats.economics.totalSavingsUsd > 0);
    assert.ok(stats.economics.savingsPct > 0);
  });
});
