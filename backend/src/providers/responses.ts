import { LLMProvider } from './base.js';
import { ModelRegistration, ProviderConfig } from '../config/types.js';
import { ChatCompletionRequest, ChatCompletionResponse, ChatMessageContentPart } from '../types/openai.js';
import { UpstreamError } from '../resilience/error-classifier.js';
import { proxiedFetch } from '../utils/proxy.js';

/**
 * ADR-0011: OpenAI Responses API wire (`@ai-sdk/openai`) — POST {base}/responses.
 * Serves providers (or single models, via model-level npm override) that reject
 * chat/completions with `ModelProtocolUnsupported` — e.g. Zen's gpt-6-luna.
 */
export class ResponsesProvider implements LLMProvider {
  public name: string;
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.name = config.name;
    this.config = config;
  }

  /** OpenAI messages → Responses input items; system/developer → instructions. */
  private buildPayload(request: ChatCompletionRequest, model: ModelRegistration): Record<string, any> {
    const instructions: string[] = [];
    const input: any[] = [];
    for (const msg of request.messages) {
      if (msg.role === 'system' || msg.role === 'developer') {
        instructions.push(typeof msg.content === 'string' ? msg.content : textOf(msg.content));
        continue;
      }
      const role = msg.role === 'assistant' ? 'assistant' : 'user';
      if (typeof msg.content === 'string') {
        input.push({ role, content: msg.content });
      } else {
        input.push({
          role,
          content: msg.content.map((p) =>
            p.type === 'text'
              ? { type: 'input_text', text: p.text || '' }
              : { type: 'input_image', image_url: (p as any).image_url?.url }
          ),
        });
      }
    }
    const payload: Record<string, any> = {
      model: model.upstreamModel,
      input,
      stream: false,
    };
    const joined = instructions.filter(Boolean).join('\n\n');
    if (joined) payload.instructions = joined;
    if (request.max_tokens != null) payload.max_output_tokens = request.max_tokens;
    else if (request.max_completion_tokens != null) payload.max_output_tokens = request.max_completion_tokens;
    if (request.temperature != null) payload.temperature = request.temperature;
    if (request.top_p != null) payload.top_p = request.top_p;
    if (request.stop?.length) payload.text = { format: { type: 'text' } };
    return payload;
  }

  public async createCompletion(
    request: ChatCompletionRequest,
    model: ModelRegistration
  ): Promise<ChatCompletionResponse> {
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/responses`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`,
      ...this.config.headers,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs || 60000);

    try {
      const res = await proxiedFetch(
        url,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(this.buildPayload(request, model)),
          signal: controller.signal,
        },
        { provider: this.config.name, model: model.id }
      );

      if (!res.ok) {
        const errorText = await res.text();
        const retryAfterHeader = res.headers.get('retry-after');
        const retryAfterSeconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined;
        throw new UpstreamError({
          message: `Upstream ${this.name} [responses] returned status ${res.status}: ${errorText}`,
          status: res.status,
          errorBody: errorText,
          provider: this.name,
          modelId: model.id,
          retryAfterSeconds: isNaN(retryAfterSeconds as number) ? undefined : retryAfterSeconds,
        });
      }

      const data = (await res.json()) as any;
      const text = (data.output || [])
        .filter((o: any) => o.type === 'message')
        .flatMap((o: any) => o.content || [])
        .filter((c: any) => c.type === 'output_text')
        .map((c: any) => c.text)
        .join('');
      const cached = data.usage?.input_tokens_details?.cached_tokens || 0;

      return {
        id: data.id || `resp-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model.id,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: text },
            finish_reason: data.status === 'incomplete' ? 'length' : 'stop',
          },
        ],
        usage: {
          prompt_tokens: data.usage?.input_tokens ?? 0,
          completion_tokens: data.usage?.output_tokens ?? 0,
          total_tokens: data.usage?.total_tokens ?? (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
          prompt_tokens_details: { cached_tokens: cached },
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function textOf(parts: ChatMessageContentPart[]): string {
  return parts.map((p) => p.text || '').join(' ');
}
