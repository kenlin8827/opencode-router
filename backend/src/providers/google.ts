import { LLMProvider } from './base.js';
import { ModelRegistration, ProviderConfig } from '../config/types.js';
import { ChatCompletionRequest, ChatCompletionResponse } from '../types/openai.js';
import { UpstreamError } from '../resilience/error-classifier.js';
import { proxiedFetch } from '../utils/proxy.js';

/**
 * ADR-0011: Google Generative Language wire (`@ai-sdk/google`) —
 * POST {base}/models/{model}:generateContent with x-goog-api-key.
 */
export class GoogleProvider implements LLMProvider {
  public name: string;
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.name = config.name;
    this.config = config;
  }

  public async createCompletion(
    request: ChatCompletionRequest,
    model: ModelRegistration
  ): Promise<ChatCompletionResponse> {
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/models/${encodeURIComponent(model.upstreamModel)}:generateContent`;

    const systemText = request.messages
      .filter((m) => m.role === 'system' || m.role === 'developer')
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n\n');

    const contents = request.messages
      .filter((m) => m.role !== 'system' && m.role !== 'developer')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts:
          typeof m.content === 'string'
            ? [{ text: m.content }]
            : m.content
                .map((p) =>
                  p.type === 'text'
                    ? { text: p.text || '' }
                    : { inlineData: { mimeType: 'image/*', data: String((p as any).image_url?.url || '').split(',').pop() } }
                )
                .filter(Boolean),
      }));

    const generationConfig: Record<string, any> = {};
    if (request.max_tokens != null) generationConfig.maxOutputTokens = request.max_tokens;
    else if (request.max_completion_tokens != null) generationConfig.maxOutputTokens = request.max_completion_tokens;
    if (request.temperature != null) generationConfig.temperature = request.temperature;
    if (request.top_p != null) generationConfig.topP = request.top_p;
    if (request.stop?.length) generationConfig.stopSequences = request.stop;

    const payload: Record<string, any> = { contents, ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}) };
    if (Object.keys(generationConfig).length) payload.generationConfig = generationConfig;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs || 60000);

    try {
      const res = await proxiedFetch(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': this.config.apiKey,
            ...this.config.headers,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        },
        { provider: this.config.name, model: model.id }
      );

      if (!res.ok) {
        const errorText = await res.text();
        throw new UpstreamError({
          message: `Upstream ${this.name} [google] returned status ${res.status}: ${errorText}`,
          status: res.status,
          errorBody: errorText,
          provider: this.name,
          modelId: model.id,
        });
      }

      const data = (await res.json()) as any;
      const text = (data.candidates?.[0]?.content?.parts || [])
        .map((p: any) => p.text || '')
        .join('');
      const finishRaw = data.candidates?.[0]?.finishReason;

      return {
        id: `google-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model.id,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: text },
            finish_reason: finishRaw === 'MAX_TOKENS' ? 'length' : finishRaw === 'SAFETY' ? 'content_filter' : 'stop',
          },
        ],
        usage: {
          prompt_tokens: data.usageMetadata?.promptTokenCount ?? 0,
          completion_tokens: data.usageMetadata?.candidatesTokenCount ?? 0,
          total_tokens: data.usageMetadata?.totalTokenCount ?? 0,
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
