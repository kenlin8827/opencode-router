import { Usage } from '../types/openai.js';
import { ModelPricing } from '../types/router.js';

/**
 * FinOps cost accounting only — the budget/limit enforcement mechanism
 * (reasoning-effort clamping + max_completion_tokens cap) was removed;
 * cost math is kept because savings/trace stats still depend on it.
 */
export class BudgetManager {
  /**
   * Calculate exact cost in USD for a given usage and model pricing.
   *
   * Reasoning tokens are billed at `pricing.reasoning` when the catalog
   * declares it (preferred for models with separate thinking surcharge
   * like OpenAI o-series / Anthropic extended-thinking). Otherwise they
   * roll into `pricing.output` at the same rate — most models bill
   * thinking tokens as plain output, so this is the natural baseline and
   * a higher effort level simply produces more tokens, which costs more
   * without any per-token multiplier gymnastics.
   */
  public static calculateCost(usage: Usage | undefined, pricing: ModelPricing): number {
    if (!usage) return 0;

    const cachedPromptTokens = usage.prompt_tokens_details?.cached_tokens || 0;
    const uncachedPromptTokens = Math.max(0, usage.prompt_tokens - cachedPromptTokens);
    const completionTokens = usage.completion_tokens || 0;
    const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens || 0;

    const promptCost = (uncachedPromptTokens / 1_000_000) * pricing.input;
    const cachedPromptCost = (cachedPromptTokens / 1_000_000) * pricing.cacheRead;

    let completionCost: number;
    if (pricing.reasoning && reasoningTokens > 0) {
      // Catalog declares a dedicated reasoning price — charge reasoning
      // tokens at that rate and the visible output at the normal rate.
      const normalCompletionTokens = Math.max(0, completionTokens - reasoningTokens);
      completionCost =
        (normalCompletionTokens / 1_000_000) * pricing.output +
        (reasoningTokens / 1_000_000) * pricing.reasoning;
    } else {
      // No dedicated reasoning price → reasoning tokens are billed as
      // plain output (the model-default behavior of every upstream we
      // route to today). Higher effort simply spends more tokens.
      completionCost = (completionTokens / 1_000_000) * pricing.output;
    }

    return promptCost + cachedPromptCost + completionCost;
  }

  /**
   * Calculate baseline cost if this request was sent to a standard plus-tier model (e.g. Claude 3.5 Sonnet).
   */
  public static calculateBaselineCost(usage: Usage | undefined, baselinePricing: ModelPricing): number {
    if (!usage) return 0;
    const promptCost = (usage.prompt_tokens / 1_000_000) * baselinePricing.input;
    const completionCost = (usage.completion_tokens / 1_000_000) * baselinePricing.output;
    return promptCost + completionCost;
  }
}