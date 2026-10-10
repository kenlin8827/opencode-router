import crypto from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  Tool,
} from '../types/openai.js';
import type { ReasoningEffort } from '../types/router.js';
import { ChatMessageLite, RespNode, RespStore, newResponseId } from '../session/resp-store.js';
import {
  appendGatewayResponseChunk,
  getClientExchangeContext,
} from '../observability/http-exchange.js';

/**
 * OpenAI Responses API compatibility layer (POST /v1/responses).
 *
 * Stateful mode (`previous_response_id`) is implemented as GATEWAY-OWNED
 * stateful emulation: the client sends only the delta, the RespStore rebuilds
 * the full message array, and routing runs through the SAME orchestrator as
 * every other wire. Consequences that matter:
 * - state survives model switches / failover / ratchet escalations (an
 *   upstream-owned store would pin the conversation to one provider);
 * - stateful turns bind to their routing session EXACTLY via
 *   router_options.session_id (client-supplied correlation, resolved by the
 *   explicit layer — zero ambiguity);
 * - a previous_response_id that is unknown/expired fails LOUDLY with 400
 *   (never silently opens a new session).
 *
 * `reasoning` input items are intentionally skipped: chat-completions
 * upstreams cannot consume them (note: `reasoning` is the OpenAI Responses API
 * item type name, kept verbatim — not the internal tier name). Unknown item
 * types fail with 400 rather
 * than being silently dropped (fail-visible over silent data loss).
 *
 * Streaming (`stream: true`) synthesizes the Responses SSE event sequence
 * from the fully-buffered gateway response — same architecture as the
 * chat-completions and Anthropic wires.
 */

// ---------------------------------------------------------------------------
// Wire types (subset consumed by the gateway)
// ---------------------------------------------------------------------------

interface ResponsesTextPart {
  type: 'input_text' | 'output_text' | 'summary_text' | 'refusal';
  text: string;
}

interface ResponsesImagePart {
  type: 'input_image';
  image_url: string;
  detail?: 'low' | 'high' | 'auto';
}

type ResponsesContentPart = ResponsesTextPart | ResponsesImagePart;

interface ResponsesMessageItem {
  type?: 'message';
  role: 'user' | 'assistant' | 'system' | 'developer';
  content: string | ResponsesContentPart[];
}

interface ResponsesFunctionCallItem {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

interface ResponsesFunctionCallOutputItem {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

interface ResponsesReasoningItem {
  type: 'reasoning';
  [k: string]: unknown;
}

type ResponsesInputItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem
  | ResponsesReasoningItem;

export interface ResponsesRequest {
  model?: string;
  input?: string | ResponsesInputItem[];
  instructions?: string;
  previous_response_id?: string;
  stream?: boolean;
  /** Accepted for compatibility; the gateway always keeps state (local, bounded). */
  store?: boolean;
  user?: string;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  tools?: Tool[];
  // 5-level effort vocabulary (the OpenAI Responses wire mirrors the
  // OpenAI Chat Completions ladder — `max` is Anthropic-only and never
  // crosses this wire). OpenAI Responses rejects unsupported values
  // per-model (e.g. a never-thinking model rejects `none` with 400).
// OpenAI Responses wire: 5 levels (no `max` — that's Anthropic-only).
// The internal ReasoningEffort type also includes `max` so the orchestrator
// can carry it through the downgrade pipeline; the openai-compatible
// provider builder collapses it before this wire is touched.
reasoning?: { effort?: Exclude<ReasoningEffort, 'max'>; max_tokens?: number };
}

// ---------------------------------------------------------------------------
// Errors (OpenAI error envelope)
// ---------------------------------------------------------------------------

function errorReply(message: string, code?: string): { error: { message: string; type: string; code?: string } } {
  return { error: { message, type: 'invalid_request_error', code } };
}

// ---------------------------------------------------------------------------
// Converter: Responses input items -> chat messages (delta only, no system)
// ---------------------------------------------------------------------------

function contentToChatContent(content: string | ResponsesContentPart[]): ChatMessage['content'] {
  if (typeof content === 'string') return content;
  return content.map((p) => {
    if (p.type === 'input_image') {
      return { type: 'image_url' as const, image_url: { url: p.image_url, detail: p.detail } };
    }
    // input_text / output_text / summary_text / refusal all carry text.
    return { type: 'text' as const, text: (p as ResponsesTextPart).text };
  });
}

export function inputItemsToMessages(input: string | ResponsesInputItem[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const items: ResponsesInputItem[] =
    typeof input === 'string' ? [{ role: 'user', content: input }] : input || [];

  for (const item of items) {
    const t = (item as { type?: string })?.type as string | undefined;
    if (t === undefined || t === 'message') {
      const m = item as ResponsesMessageItem;
      messages.push({
        role: (m.role || 'user') as ChatMessage['role'],
        content: contentToChatContent(m.content),
      });
    } else if (t === 'function_call') {
      const fc = item as ResponsesFunctionCallItem;
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [{ id: fc.call_id, type: 'function', function: { name: fc.name, arguments: fc.arguments } }],
      });
    } else if (t === 'function_call_output') {
      const fo = item as ResponsesFunctionCallOutputItem;
      messages.push({ role: 'tool', content: String(fo.output ?? ''), tool_call_id: fo.call_id });
    } else if (t === 'reasoning') {
      // Known-ignored: chat-completions upstreams cannot consume reasoning items.
      continue;
    } else {
      throw new Error(`Unsupported input item type: "${t}"`);
    }
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Converter: chat response -> Responses response object
// ---------------------------------------------------------------------------

function shortId(prefix: string): string {
  return prefix + crypto.randomBytes(12).toString('hex');
}

export function chatToResponseObject(
  chatResp: ChatCompletionResponse,
  respId: string,
  model: string
): Record<string, unknown> {
  const msg = chatResp.choices[0]?.message;
  const output: Record<string, unknown>[] = [];

  if (Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) {
    for (const tc of msg.tool_calls) {
      output.push({
        type: 'function_call',
        id: shortId('fc_'),
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
        status: 'completed',
      });
    }
  } else {
    const text = typeof msg?.content === 'string' ? msg.content : '';
    output.push({
      type: 'message',
      id: shortId('msg_'),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  }

  const u = chatResp.usage;
  return {
    id: respId,
    object: 'response',
    created_at: Math.floor(chatResp.created || Date.now() / 1000),
    status: 'completed',
    model,
    output,
    usage: {
      input_tokens: u?.prompt_tokens || 0,
      output_tokens: u?.completion_tokens || 0,
      total_tokens: u?.total_tokens || (u ? u.prompt_tokens + u.completion_tokens : 0),
    },
  };
}

/** Synthesized Responses SSE event sequence for one buffered completion. */
export function chatToStreamEvents(
  chatResp: ChatCompletionResponse,
  respId: string,
  model: string
): string[] {
  const response = chatToResponseObject(chatResp, respId, model) as Record<string, any>;
  const events: string[] = [];
  const emit = (payload: Record<string, unknown>) =>
    events.push(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`);

  emit({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } });
  emit({ type: 'response.in_progress', response: { ...response, status: 'in_progress', output: [] } });

  const output = response.output as Record<string, any>[];
  for (let i = 0; i < output.length; i++) {
    const item = output[i];
    emit({ type: 'response.output_item.added', output_index: i, item: { ...item, status: 'in_progress' } });
    if (item.type === 'message') {
      const fullText: string = item.content?.[0]?.text || '';
      emit({
        type: 'response.content_part.added',
        item_id: item.id,
        output_index: i,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
      const chunkSize = 16;
      for (let j = 0; j < fullText.length; j += chunkSize) {
        emit({
          type: 'response.output_text.delta',
          item_id: item.id,
          output_index: i,
          content_index: 0,
          delta: fullText.slice(j, j + chunkSize),
        });
      }
      emit({ type: 'response.output_text.done', item_id: item.id, output_index: i, content_index: 0, text: fullText });
      emit({ type: 'response.content_part.done', item_id: item.id, output_index: i, content_index: 0, part: item.content[0] });
    } else if (item.type === 'function_call') {
      const args: string = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {});
      const chunkSize = 32;
      for (let j = 0; j < args.length; j += chunkSize) {
        emit({
          type: 'response.function_call_arguments.delta',
          item_id: item.id,
          output_index: i,
          delta: args.slice(j, j + chunkSize),
        });
      }
      emit({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: i, arguments: args });
    }
    emit({ type: 'response.output_item.done', output_index: i, item });
  }

  emit({ type: 'response.completed', response });
  return events;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerResponsesRoutes(app: FastifyInstance, orchestrator: PipelineOrchestrator): void {
  const store = new RespStore();

  app.post('/v1/responses', async (req, reply) => {
    const body = req.body as ResponsesRequest;

    if (!body || body.input === undefined || body.input === null) {
      return reply.status(400).send(errorReply('Invalid request: "input" is required.'));
    }

    // This turn's NEW messages only (never includes rebuilt history — the
    // parent chain in the store already holds it).
    let delta: ChatMessage[];
    try {
      delta = inputItemsToMessages(body.input);
    } catch (e: any) {
      return reply.status(400).send(errorReply(e?.message || 'Invalid input items.'));
    }
    if (delta.length === 0) {
      return reply.status(400).send(errorReply('Invalid request: "input" resolved to an empty message list.'));
    }

    // Full request messages = [instructions?] + [rebuilt history?] + delta.
    // `instructions` is request-scoped (like a system prompt for THIS turn),
    // so it is prepended at send time and never baked into stored deltas.
    let messages: ChatMessage[];
    let sessionIdBind: string | undefined;
    if (body.previous_response_id) {
      const built = store.buildMessages(body.previous_response_id);
      if (!built) {
        return reply.status(400).send(
          errorReply(
            `Unknown previous_response_id "${body.previous_response_id}" (expired, evicted, or from before a gateway restart). Resend the full conversation input.`,
            'previous_response_not_found'
          )
        );
      }
      messages = [...built.messages, ...delta];
      if (body.instructions?.trim()) {
        messages = [{ role: 'system', content: body.instructions }, ...messages];
      }
      sessionIdBind = built.sessionId;
    } else {
      messages = [...delta];
      if (body.instructions?.trim()) {
        messages = [{ role: 'system', content: body.instructions }, ...messages];
      }
    }

    const request: ChatCompletionRequest = {
      model: body.model?.trim() || 'auto',
      messages,
    };
    if (body.temperature !== undefined) request.temperature = body.temperature;
    if (body.top_p !== undefined) request.top_p = body.top_p;
    if (body.max_output_tokens !== undefined) request.max_tokens = body.max_output_tokens;
    if (body.tools?.length) request.tools = body.tools;
    if (body.reasoning?.effort) request.reasoning_effort = body.reasoning.effort;
    // Responses-native reasoning.max_tokens maps to router's max_thinking_tokens,
    // which provider payload builders translate per-upstream (see anthropic.ts,
    // google.ts, responses.ts buildResponsesPayload).
    if (body.reasoning?.max_tokens != null) request.max_thinking_tokens = body.reasoning.max_tokens;
    if (body.user) request.user = body.user;
    // Exact session binding for stateful turns: the parent node remembers the
    // routing session; router_options.session_id resolves via the explicit
    // layer — zero ambiguity, no content heuristics involved.
    if (sessionIdBind) request.router_options = { ...request.router_options, session_id: sessionIdBind };

    try {
      const result = await orchestrator.process(request, {
        clientIp: req.ip,
        headers: req.headers,
        wire: 'responses',
        fastifyRequest: req,
      });

      const tierHeader = result.tierUsed + (result.fallbackOccurred ? '-escalated' : '');
      reply.header('X-OCR-Tier', tierHeader);
      reply.header('X-OCR-Model', result.modelUsed);
      reply.header('X-OCR-Session-ID', result.sessionId || '');
      reply.header('X-OCR-Session-Lookup', result.sessionLookupType || '');
      reply.header('X-OCR-Session-Ratchet', result.sessionRatchetApplied ? 'true' : 'false');
      reply.header('X-OCR-Trace-ID', result.traceId || '');
      // Reasoning-effort observability — see server.ts for full description.
      if (result.requestedEffort && result.requestedEffort !== 'none') {
        reply.header('X-OCR-Thinking-Requested', result.requestedEffort);
        reply.header('X-OCR-Thinking-Actual', result.actualEffort ?? result.requestedEffort);
        reply.header('X-OCR-Thinking-Degraded', result.reasoningDegraded ? 'true' : 'false');
      }
      // Variant observability — sibling / `#variant` id resolved for this request.
      if (result.variantUsed) reply.header('X-OCR-Variant', result.variantUsed);

      const respId = newResponseId();
      const assistant = result.response.choices[0]?.message;
      const node: RespNode = {
        id: respId,
        parent: body.previous_response_id || null,
        sessionId: result.sessionId || sessionIdBind || '',
        model: result.modelUsed,
        input: delta as ChatMessageLite[],
        assistant: {
          role: 'assistant',
          content: typeof assistant?.content === 'string' ? assistant.content : '',
          tool_calls: assistant?.tool_calls,
        },
        createdAt: Date.now(),
      };

      if (body.stream) {
        // Register BEFORE streaming so the id is resolvable the moment the
        // client sees response.created.
        store.append(node);
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
          'X-OCR-Session-ID': result.sessionId || '',
        });
        const sseCtx = getClientExchangeContext(req);
        for (const evt of chatToStreamEvents(result.response, respId, result.modelUsed)) {
          if (sseCtx) appendGatewayResponseChunk(sseCtx, evt);
          reply.raw.write(evt);
        }
        reply.raw.end();
        return reply;
      }

      store.append(node);
      return reply.status(200).send(chatToResponseObject(result.response, respId, result.modelUsed));
    } catch (err: any) {
      req.log?.error?.(err);
      // Explicitly tagged 4xx errors (e.g. variant resolution) keep their
      // status; everything else stays the route's upstream_error 502.
      if (Number.isInteger(err?.statusCode) && err.statusCode >= 400 && err.statusCode < 500) {
        return reply.status(err.statusCode).send(errorReply(err.message, 'invalid_request_error'));
      }
      return reply.status(502).send(errorReply(err?.message || 'Upstream execution failed.', 'upstream_error'));
    }
  });
}
