import { FastifyInstance } from 'fastify';
import { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ChatMessageContentPart,
} from '../types/openai.js';

/**
 * Anthropic Messages API compatibility layer (POST /v1/messages).
 *
 * Lets Anthropic-protocol clients (Claude Code, Anthropic SDKs, any
 * ANTHROPIC_BASE_URL-aware tool) hit the same routing pipeline as
 * OpenAI-protocol clients. Auth is enforced by the shared preHandler
 * hook in server.ts, which already accepts `x-api-key` in addition to
 * `Authorization: Bearer`.
 *
 * Wire types (subset consumed by the gateway):
 */

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

interface AnthropicImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicImageBlock;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicMessagesRequest {
  model?: string;
  system?: string | AnthropicTextBlock[];
  messages?: AnthropicMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  metadata?: { user_id?: string };
}

/** Anthropic requires max_tokens; mirror the SDK default when omitted. */
const DEFAULT_MAX_TOKENS = 4096;

export function anthropicToOpenAI(body: AnthropicMessagesRequest): {
  request?: ChatCompletionRequest;
  error?: string;
} {
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return { error: 'Invalid request: "messages" array is required.' };
  }

  const messages: ChatMessage[] = [];

  // Top-level system prompt (string or text blocks) -> leading system message
  if (body.system !== undefined && body.system !== null) {
    const systemText =
      typeof body.system === 'string'
        ? body.system
        : body.system
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('\n');
    if (systemText) {
      messages.push({ role: 'system', content: systemText });
    }
  }

  const convertBlocks = (blocks: AnthropicContentBlock[]): ChatMessageContentPart[] =>
    blocks.flatMap((block): ChatMessageContentPart[] => {
      if (block.type === 'text') {
        return [{ type: 'text', text: block.text }];
      }
      if (block.type === 'image' && block.source?.type === 'base64') {
        return [
          {
            type: 'image_url',
            image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
          },
        ];
      }
      return [];
    });

  for (const msg of body.messages) {
    const content = typeof msg.content === 'string' ? msg.content : convertBlocks(msg.content);
    messages.push({ role: msg.role, content });
  }

  return {
    request: {
      model: body.model?.trim() || 'auto',
      messages,
      max_tokens: body.max_tokens ?? DEFAULT_MAX_TOKENS,
      temperature: body.temperature,
      top_p: body.top_p,
      stream: body.stream,
      stop: body.stop_sequences,
      user: body.metadata?.user_id,
    },
  };
}

/** finish_reason -> Anthropic stop_reason */
function toStopReason(finish: string | null | undefined): string {
  if (finish === 'length') return 'max_tokens';
  if (finish === 'tool_calls') return 'tool_use';
  if (finish === 'content_filter') return 'refusal';
  return 'end_turn';
}

export function openAIToAnthropic(
  response: ChatCompletionResponse,
  model: string
): Record<string, unknown> {
  const choice = response.choices?.[0];
  const usage = response.usage;

  return {
    id: response.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: model || response.model,
    content: [{ type: 'text', text: choice?.message?.content ?? '' }],
    stop_reason: toStopReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: usage?.prompt_tokens ?? 0,
      output_tokens: usage?.completion_tokens ?? 0,
      ...(usage?.prompt_tokens_details?.cached_tokens
        ? { cache_read_input_tokens: usage.prompt_tokens_details.cached_tokens }
        : {}),
    },
  };
}

function sseEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Register the Anthropic-protocol endpoint on the gateway.
 * Model routing (auto / auto-fast / auto-flagship / auto-reasoning /
 * concrete model ids) is resolved inside orchestrator.process, exactly
 * like the OpenAI /v1/chat/completions path.
 */
export function registerAnthropicRoutes(
  app: FastifyInstance,
  orchestrator: PipelineOrchestrator
): void {
  app.post('/v1/messages', async (req, reply) => {
    const body = req.body as AnthropicMessagesRequest;

    const { request, error } = anthropicToOpenAI(body || {});
    if (!request || error) {
      return reply.status(400).send({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: error || 'Invalid request.',
        },
      });
    }

    try {
      const result = await orchestrator.process(request, {
        clientIp: req.ip,
        headers: req.headers,
      });

      const tierHeader = result.tierUsed + (result.fallbackOccurred ? '-escalated' : '');
      const ocrHeaders: Record<string, string> = {
        'X-OCR-Tier': tierHeader,
        'X-OCR-Layer': result.layerUsed || 'layer0',
        'X-OCR-Model': result.modelUsed,
        'X-OCR-Failover': result.failoverOccurred ? 'true' : 'false',
        'X-OCR-Failover-Attempts': (result.failoverAttempts || 1).toString(),
        'X-OCR-Failover-Path': result.failoverPath?.join(' -> ') || '',
        'X-OCR-InPlace-Retries': (result.inplaceRetries || 0).toString(),
        'X-OCR-Breaker-State': result.breakerState || 'CLOSED',
        'X-OCR-Session-ID': result.sessionId || '',
        'X-OCR-Session-Ratchet': result.sessionRatchetApplied ? 'true' : 'false',
        'X-OCR-Trace-ID': result.traceId || '',
        'X-OCR-Cost-USD': result.costUsd.toFixed(6),
        'X-OCR-Saved-USD': result.savedCostUsd.toFixed(6),
        'X-OCR-Latency-MS': result.latencyMs.toString(),
      };
      for (const [k, v] of Object.entries(ocrHeaders)) {
        reply.header(k, v);
      }

      const fullText = result.response.choices?.[0]?.message?.content || '';
      const id = result.response.id || `msg_${Date.now()}`;
      const model = result.modelUsed;

      // -------------------------------------------------------------
      // Anthropic SSE Streaming (stream: true)
      // -------------------------------------------------------------
      if (request.stream) {
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
          ...ocrHeaders,
        });

        const inputTokens = result.response.usage?.prompt_tokens ?? 0;
        const outputTokens = result.response.usage?.completion_tokens ?? 0;

        reply.raw.write(
          sseEvent('message_start', {
            type: 'message_start',
            message: {
              id,
              type: 'message',
              role: 'assistant',
              model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: inputTokens, output_tokens: 0 },
            },
          })
        );

        reply.raw.write(
          sseEvent('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          })
        );

        // Stream content deltas (same chunking strategy as the OpenAI path)
        const chunkSize = 4;
        for (let i = 0; i < fullText.length; i += chunkSize) {
          reply.raw.write(
            sseEvent('content_block_delta', {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: fullText.slice(i, i + chunkSize) },
            })
          );
        }

        reply.raw.write(sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }));

        reply.raw.write(
          sseEvent('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: toStopReason(result.response.choices?.[0]?.finish_reason), stop_sequence: null },
            usage: { output_tokens: outputTokens },
          })
        );

        reply.raw.write(sseEvent('message_stop', { type: 'message_stop' }));
        reply.raw.end();
        return reply;
      }

      // Non-streaming standard Anthropic message JSON
      return reply.send(openAIToAnthropic(result.response, model));
    } catch (err: any) {
      req.log.error(err, 'Anthropic messages execution failed');
      const status =
        Number.isInteger(err?.statusCode) && err.statusCode >= 400 && err.statusCode < 600
          ? err.statusCode
          : 500;
      return reply.status(status).send({
        type: 'error',
        error: {
          type: status >= 500 ? 'api_error' : 'invalid_request_error',
          message: err.message || 'Internal Router Error',
        },
      });
    }
  });
}
