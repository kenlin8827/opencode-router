import crypto from 'node:crypto';
import type http from 'node:http';
import type { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import type { ChatCompletionRequest } from '../types/openai.js';
import {
  anthropicToOpenAI,
  chatToAnthropicStreamEvents,
  openAIToAnthropic,
} from '../routes/anthropic.js';
import {
  chatToResponseObject,
  chatToStreamEvents,
  inputItemsToMessages,
} from '../routes/responses.js';
import { buildChatStreamChunks } from '../utils/chat-sse.js';

/**
 * Content-level LLM interception for the forward proxy.
 *
 * Runs on DECRYPTED requests (MITM'd HTTPS or plain HTTP). Only canonical LLM
 * endpoints are intercepted — the wire is identified by path first
 * (…/v1/chat/completions, …/v1/messages, …/v1/responses) and the body is
 * validated by shape; anything else returns false → transparent forward.
 *
 * Intercepted requests are normalized into the gateway's internal
 * ChatCompletionRequest and executed through the SAME orchestrator as the
 * native /v1 endpoints, then the result is re-encoded back to the caller's
 * wire. X-OCR-* observability headers are attached for parity.
 */

const MAX_BODY_BYTES = 32 * 1024 * 1024;

type Wire = 'chat' | 'anthropic' | 'responses';

function detectWire(pathAndQuery: string): Wire | null {
  const p = (pathAndQuery || '').split('?')[0].toLowerCase();
  if (p.endsWith('/v1/chat/completions')) return 'chat';
  if (p.endsWith('/v1/messages')) return 'anthropic';
  if (p.endsWith('/v1/responses')) return 'responses';
  return null;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (d: Buffer) => {
      total += d.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendError(res: http.ServerResponse, wire: Wire, status: number, message: string): true {
  const type = status >= 500 ? 'api_error' : 'invalid_request_error';
  const payload =
    wire === 'anthropic'
      ? { type: 'error', error: { type, message } }
      : { error: { message, type } };
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  } catch {}
  return true;
}

export function createProxyInterceptor(
  orchestrator: PipelineOrchestrator
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean> {
  return async function intercept(req, res): Promise<boolean> {
    if (req.method !== 'POST') return false;
    const wire = detectWire(req.url || '');
    if (!wire) return false;

    let raw: Buffer;
    try {
      raw = await readBody(req);
    } catch (err: any) {
      return sendError(res, wire, 413, err?.message || 'Request body too large');
    }

    let body: any;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return sendError(res, wire, 400, 'Invalid JSON body');
    }
    if (!body || typeof body !== 'object') return sendError(res, wire, 400, 'Invalid JSON body');

    let request: ChatCompletionRequest | undefined;
    let conversionError: string | undefined;
    if (wire === 'chat') {
      if (!Array.isArray(body.messages)) {
        conversionError = 'Invalid request: "messages" array is required.';
      } else {
        request = body as ChatCompletionRequest;
      }
    } else if (wire === 'anthropic') {
      const converted = anthropicToOpenAI(body);
      request = converted.request;
      conversionError = converted.error;
    } else {
      try {
        if (body.input === undefined && !Array.isArray(body.messages)) {
          conversionError = 'Invalid request: "input" is required.';
        } else {
          request = {
            model: typeof body.model === 'string' ? body.model.trim() || 'auto' : 'auto',
            messages: [
              ...(typeof body.instructions === 'string' && body.instructions
                ? [{ role: 'system' as const, content: body.instructions }]
                : []),
              ...inputItemsToMessages(body.input ?? []),
            ],
            stream: body.stream === true,
            temperature: body.temperature,
            top_p: body.top_p,
            max_tokens: body.max_output_tokens,
            reasoning_effort: body.reasoning?.effort,
            user: body.user,
            ...(body.tools ? { tools: body.tools } : {}),
          } as ChatCompletionRequest;
        }
      } catch (err: any) {
        conversionError = err?.message || 'Invalid request body';
      }
    }
    if (!request) return sendError(res, wire, 400, conversionError || 'Invalid request');

    const wantsStream = request.stream === true;
    try {
      const result = await orchestrator.process(request, {
        clientIp: req.socket.remoteAddress || undefined,
        headers: req.headers as Record<string, string | string[] | undefined>,
        wire,
      });
      const model = result.modelUsed || request.model || 'auto';
      const ocrHeaders: Record<string, string> = {
        'X-OCR-Tier': String(result.tierUsed) + (result.fallbackOccurred ? '-escalated' : ''),
        'X-OCR-Model': model,
        'X-OCR-Session-ID': result.sessionId || '',
        'X-OCR-Trace-ID': result.traceId || '',
        'X-OCR-Cost-USD': (result.costUsd ?? 0).toFixed(6),
      };

      if (wantsStream) {
        let out = '';
        if (wire === 'anthropic') {
          for (const ev of chatToAnthropicStreamEvents(result.response, model)) out += ev;
        } else if (wire === 'responses') {
          const respId = 'resp_' + crypto.randomBytes(12).toString('hex');
          for (const ev of chatToStreamEvents(result.response, respId, model)) out += ev;
        } else {
          for (const chunk of buildChatStreamChunks(result.response, model)) out += chunk;
          out += 'data: [DONE]\n\n';
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          ...ocrHeaders,
        });
        res.end(out);
      } else {
        let payload: unknown;
        if (wire === 'anthropic') {
          payload = openAIToAnthropic(result.response, model);
        } else if (wire === 'responses') {
          payload = chatToResponseObject(result.response, 'resp_' + crypto.randomBytes(12).toString('hex'), model);
        } else {
          payload = result.response;
        }
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          ...ocrHeaders,
        });
        res.end(JSON.stringify(payload));
      }
      return true;
    } catch (err: any) {
      return sendError(res, wire, 500, err?.message || 'Internal Router Error');
    }
  };
}