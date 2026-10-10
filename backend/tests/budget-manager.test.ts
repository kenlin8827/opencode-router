import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BudgetManager } from '../src/budget/budget-manager.js';
import { Usage } from '../src/types/openai.js';
import { ModelPricing } from '../src/types/router.js';

const basePricing: ModelPricing = { input: 1, output: 2, cacheRead: 0.5 };
const reasoningPricing: ModelPricing = { input: 1, output: 2, cacheRead: 0.5, reasoning: 10 };

function usageOf(over: Partial<Usage> = {}): Usage {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    ...over,
  };
}

describe('BudgetManager.calculateCost — reasoning tokens billing', () => {
  it('catalog pricing.reasoning wins: reasoning tokens billed at that rate, output at output rate', () => {
    const cost = BudgetManager.calculateCost(
      usageOf({
        prompt_tokens: 1_000_000,
        completion_tokens: 1_000_000,
        completion_tokens_details: { reasoning_tokens: 1_000_000 },
      }),
      reasoningPricing
    );
    // prompt: 1 * 1 = 1
    // normal output (excl. reasoning): 0 * 2 = 0
    // reasoning: 1 * 10 = 10
    assert.strictEqual(cost, 11);
  });

  it('no catalog reasoning price → roll into output rate (most models bill thinking as output)', () => {
    const cost = BudgetManager.calculateCost(
      usageOf({
        prompt_tokens: 1_000_000,
        completion_tokens: 1_000_000,
        completion_tokens_details: { reasoning_tokens: 1_000_000 },
      }),
      basePricing
    );
    // prompt: 1
    // completion (incl. reasoning): 1 * 2 = 2
    assert.strictEqual(cost, 3);
  });

  it('higher effort → more tokens → naturally higher cost (no multiplier)', () => {
    const noThinking = BudgetManager.calculateCost(
      usageOf({ prompt_tokens: 1_000_000, completion_tokens: 100_000 }),
      basePricing
    );
    const highEffort = BudgetManager.calculateCost(
      usageOf({
        prompt_tokens: 1_000_000,
        completion_tokens: 500_000,
        completion_tokens_details: { reasoning_tokens: 400_000 },
      }),
      basePricing
    );
    // The two requests use the SAME pricing — highEffort simply spent more
    // tokens, so its cost must be strictly higher. No multiplier applied.
    assert.ok(
      highEffort > noThinking,
      `high-effort request (${highEffort}) must cost more than low-effort (${noThinking})`
    );
  });

  it('returns 0 when usage is undefined', () => {
    assert.strictEqual(BudgetManager.calculateCost(undefined, basePricing), 0);
  });

  it('cached prompt tokens billed at cacheRead rate, uncached at input rate', () => {
    const cost = BudgetManager.calculateCost(
      usageOf({
        prompt_tokens: 1_000_000,
        completion_tokens: 0,
        prompt_tokens_details: { cached_tokens: 400_000 },
      }),
      basePricing
    );
    // uncached prompt: 0.6M * 1 = 0.6
    // cached prompt: 0.4M * 0.5 = 0.2
    assert.strictEqual(Number(cost.toFixed(1)), 0.8);
  });
});

describe('BudgetManager.calculateBaselineCost — baseline cost math', () => {
  it('treats reasoning tokens as part of completion (baseline model usually lacks separate reasoning price)', () => {
    const cost = BudgetManager.calculateBaselineCost(
      usageOf({
        prompt_tokens: 1_000_000,
        completion_tokens: 1_000_000,
        completion_tokens_details: { reasoning_tokens: 1_000_000 },
      }),
      basePricing
    );
    // prompt: 1, completion: 2
    assert.strictEqual(cost, 3);
  });

  it('returns 0 when usage is undefined', () => {
    assert.strictEqual(BudgetManager.calculateBaselineCost(undefined, basePricing), 0);
  });
});