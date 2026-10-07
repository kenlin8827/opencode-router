import { Usage } from '../types/openai.js';
import { ModelPricing } from '../types/router.js';

/**
 * FinOps cost accounting only — the budget/limit enforcement mechanism
 * (reasoning-effort clamping + max_completion_tokens cap) was removed;
 * cost math is kept because savings/trace stats still depend on it.
 */
export class BudgetManager {
  /**
   * Calculate exact cost in USD for a given usage and model pricing
   */
  public static calculateCost(usage: Usage | undefined, pricing: ModelPricing): number {
    if (!usage) return 0;

    const cachedPromptTokens = usage.prompt_tokens_details?.cached_tokens || 0;
    const uncachedPromptTokens = Math.max(0, usage.prompt_tokens - cachedPromptTokens);
    const completionTokens = usage.completion_tokens || 0;
    const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens || 0;

    const promptCost = (uncachedPromptTokens / 1_000_000) * pricing.input;
    const cachedPromptCost = (cachedPromptTokens / 1_000_000) * pricing.cacheRead;
    
    // Reasoning tokens might have separate pricing or be included in completion/output
    let completionCost = 0;
    if (pricing.reasoning && reasoningTokens > 0) {
      const normalCompletionTokens = Math.max(0, completionTokens - reasoningTokens);
      completionCost = (normalCompletionTokens / 1_000_000) * pricing.output +
                       (reasoningTokens / 1_000_000) * pricing.reasoning;
    } else {
      completionCost = (completionTokens / 1_000_000) * pricing.output;
    }

    return promptCost + cachedPromptCost + completionCost;
  }

  /**
   * Calculate baseline cost if this request was sent to a standard flagship model (e.g. Claude 3.5 Sonnet)
   */
  public static calculateBaselineCost(usage: Usage | undefined, baselinePricing: ModelPricing): number {
    if (!usage) return 0;
    const promptCost = (usage.prompt_tokens / 1_000_000) * baselinePricing.input;
    const completionCost = (usage.completion_tokens / 1_000_000) * baselinePricing.output;
    return promptCost + completionCost;
  }
}
