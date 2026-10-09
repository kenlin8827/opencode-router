import { ChatCompletionChunk, ChatCompletionRequest, ChatCompletionResponse } from '../types/openai.js';
import { ModelRegistration } from '../config/types.js';
import type { UpstreamEventContext } from '../observability/upstream-events.js';

/**
 * Single source of truth lives in observability/upstream-events.ts — the
 * orchestrator fills the context once per inference turn and the adapter
 * uses it to emit the two UPSTREAM events (request before fetch, response
 * after `await res.text()`). The two CLIENT events are the orchestrator /
 * Fastify hook's responsibility, not the provider's.
 */
export type { UpstreamEventContext };

export interface LLMProvider {
  name: string;
  createCompletion(
    request: ChatCompletionRequest,
    model: ModelRegistration,
    /**
     * Event-stream upstream context: provider emits a req event right
     * before fetch and a resp event right after `await res.text()` — each is
     * a separate JSONL line, independent of the inference result. Optional
     * so providers remain usable without a capture pipeline (mock mode,
     * unit tests).
     */
    upstreamEventContext?: UpstreamEventContext
  ): Promise<ChatCompletionResponse>;

  createStream?(
    request: ChatCompletionRequest,
    model: ModelRegistration
  ): Promise<AsyncIterable<ChatCompletionChunk>>;
}