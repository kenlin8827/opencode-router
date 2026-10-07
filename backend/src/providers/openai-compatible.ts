import { LLMProvider } from './base.js';
import { ModelRegistration, ProviderConfig } from '../config/types.js';
import { ChatCompletionChunk, ChatCompletionRequest, ChatCompletionResponse } from '../types/openai.js';
import { UpstreamError } from '../resilience/error-classifier.js';
import { proxiedFetch } from '../utils/proxy.js';

export class OpenAICompatibleProvider implements LLMProvider {
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
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`,
      ...this.config.headers,
    };

    if (this.config.organization) {
      headers['OpenAI-Organization'] = this.config.organization;
    }

    // Build payload using upstreamModel name
    const payload: any = {
      ...request,
      model: model.upstreamModel,
      stream: false,
    };
    delete payload.router_options;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs || 60000);

    try {
      const res = await proxiedFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      }, { provider: this.config.name, model: model.id });

      if (!res.ok) {
        const errorText = await res.text();
        const retryAfterHeader = res.headers.get('retry-after');
        const retryAfterSeconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined;
        throw new UpstreamError({
          message: `Upstream ${this.name} returned status ${res.status}: ${errorText}`,
          status: res.status,
          errorBody: errorText,
          provider: this.name,
          modelId: model.id,
          retryAfterSeconds: isNaN(retryAfterSeconds as number) ? undefined : retryAfterSeconds,
        });
      }

      const json = (await res.json()) as ChatCompletionResponse;
      return json;
    } finally {
      clearTimeout(timeout);
    }
  }

  public async createStream(
    request: ChatCompletionRequest,
    model: ModelRegistration
  ): Promise<AsyncIterable<ChatCompletionChunk>> {
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`,
      ...this.config.headers,
    };

    const payload: any = {
      ...request,
      model: model.upstreamModel,
      stream: true,
      stream_options: { include_usage: true },
    };
    delete payload.router_options;

    const res = await proxiedFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    }, { provider: this.config.name, model: model.id });

    if (!res.ok || !res.body) {
      const err = await res.text();
      throw new Error(`Upstream streaming failed [${res.status}]: ${err}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');

    return {
      async *[Symbol.asyncIterator]() {
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(':')) continue;
            if (trimmed === 'data: [DONE]') return;
            if (trimmed.startsWith('data: ')) {
              try {
                const chunk = JSON.parse(trimmed.slice(6)) as ChatCompletionChunk;
                yield chunk;
              } catch {
                // Ignore parse errors on partial lines
              }
            }
          }
        }
      },
    };
  }
}
