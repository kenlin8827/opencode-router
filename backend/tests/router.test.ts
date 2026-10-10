import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RouterEngine } from '../src/router/index.js';
import { ChatCompletionRequest } from '../src/types/openai.js';

describe('Zero-Hardcoding Model-Driven Semantic Router', () => {
  it('should respect client force_tier override', () => {
    const req: ChatCompletionRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'Anything' }],
      router_options: { force_tier: 'pro' },
    };
    const decision = RouterEngine.route(req);
    assert.strictEqual(decision.targetTier, 'pro');
    assert.strictEqual(decision.confidence, 1.0);
  });

  it('should detect structured JSON output protocol and enable schema validation for lite tier with fallback', () => {
    const req: ChatCompletionRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'Extract contact info and return as JSON.' }],
      response_format: { type: 'json_object' },
    };

    const decision = RouterEngine.route(req);
    assert.strictEqual(decision.needsSchemaValidation, true);
    assert.strictEqual(decision.targetTier, 'lite', 'Should deploy Lite Tier first for structured tasks');
  });

  it('should default safely to plus quality when no model is active, never degrading to lite tier', () => {
    // Ultra-short query (P=NP?) without local model loaded
    const req1: ChatCompletionRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'P=NP?' }],
    };
    const dec1 = RouterEngine.route(req1);
    assert.strictEqual(dec1.targetTier, 'plus', 'Must default to Plus quality baseline, never degraded to Lite!');

    // Another short query
    const req2: ChatCompletionRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'Compose a sonnet' }],
    };
    const dec2 = RouterEngine.route(req2);
    assert.strictEqual(dec2.targetTier, 'plus', 'Must default to Plus quality baseline!');
  });
});
