import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';

/**
 * Trace identifier model: every HTTP exchange event and every trace record
 * carries two correlated ids:
 *
 *   - `traceId` — stable across the whole inference turn (4 capture events
 *     and the trace record all share one). When the client supplied an
 *     upstream trace id (W3C `traceparent` or `x-request-id`), we adopt it
 *     so the gateway becomes a transparent span in the caller's
 *     distributed trace; otherwise we mint a fresh 32-hex id.
 *
 *   - `spanId` — one per HTTP exchange (req + resp share it). Same value
 *     across the inbound pair and another value across the outbound pair
 *     (two exchanges per turn).
 *
 * Source-of-truth: W3C Trace Context (https://www.w3.org/TR/trace-context/)
 * `traceparent: 00-{traceId}-{parentSpanId}-{flags}` is the standard. We
 * also accept the de-facto `x-request-id` / `x-trace-id` /
 * `x-correlation-id` headers common to LLM SDKs. When multiple are present,
 * W3C wins (most explicit format), then `x-request-id` (most common),
 * then the others as fallbacks.
 */

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
const TRACE_ID_RE = /^[0-9a-f]{32}$/i;
const SPAN_ID_RE = /^[0-9a-f]{16}$/i;

/** Priority chain for inbound traceId extraction. */
const TRACE_ID_HEADERS = [
  'traceparent',     // W3C Trace Context (level 1 priority, see below)
  'x-request-id',    // de-facto LLM-SDK standard
  'x-trace-id',      // OpenAI / Anthropic convention
  'x-correlation-id',
  'request-id',
] as const;

const SPAN_ID_HEADERS = [
  'x-span-id',
  'tracestate',      // secondary in traceparent
] as const;

/**
 * Extract / mint the traceId for an inbound request. Priority:
 *   1. W3C `traceparent` (canonical; most explicit)
 *   2. `x-request-id` (de-facto LLM SDK standard)
 *   3. `x-trace-id` / `x-correlation-id` / `request-id`
 *   4. freshly minted 32-hex id (via crypto.randomBytes, no Math.random fallback)
 *
 * `provider` lets the caller decide what to do when the inbound request has
 * no trace id. Pass `'client-or-mint'` to mint one (always-on tracing);
 * pass `'client-only'` to surface an error when nothing was supplied
 * (off by default — most clients don't send a trace id).
 */
export function resolveTraceId(
  req: Pick<FastifyRequest, 'headers'>,
  provider: 'client-or-mint' | 'client-only' = 'client-or-mint'
): { traceId: string; source: 'traceparent' | 'x-request-id' | 'x-trace-id' | 'x-correlation-id' | 'request-id' | 'minted' } {
  const headers = req.headers as Record<string, string | string[] | undefined>;

  // 1. W3C traceparent — canonical. Parse the four fields; if malformed,
  //    ignore (don't reject the request, just fall through to the next source).
  const traceparent = pickHeader(headers, 'traceparent');
  if (traceparent) {
    const m = TRACEPARENT_RE.exec(traceparent.trim());
    if (m && TRACE_ID_RE.test(m[2])) {
      return { traceId: m[2].toLowerCase(), source: 'traceparent' };
    }
  }

  // 2-4. De-facto headers.
  for (const name of TRACE_ID_HEADERS.slice(1)) {
    const v = pickHeader(headers, name);
    if (v && TRACE_ID_RE.test(v.trim())) {
      return { traceId: v.trim().toLowerCase(), source: name as any };
    }
    // Some clients send non-hex ids (UUIDs, NanoIDs, base32). Accept as-is
    // so we don't lose the link — only mint when truly absent.
    if (v && v.trim().length > 0 && v.trim().length <= 128) {
      return { traceId: v.trim(), source: name as any };
    }
  }

  if (provider === 'client-only') {
    throw new Error('No upstream traceId provided and policy is client-only');
  }
  return { traceId: mintTraceId(), source: 'minted' };
}

/**
 * Extract / mint a per-exchange spanId. Priority:
 *   1. W3C `traceparent` parentSpanId (canonical child-span semantics)
 *   2. `x-span-id` (some OpenTelemetry-aware proxies)
 *   3. freshly minted 16-hex id
 *
 * The spanId is set by the gateway when minting the traceId (parent span
 * becomes a new child). For inbound/exchange spans, we always mint — the
 * span scope is local to one HTTP exchange.
 */
export function resolveSpanId(
  req: Pick<FastifyRequest, 'headers'>,
  hint?: { traceparent?: string }
): { spanId: string; source: 'traceparent' | 'x-span-id' | 'minted' } {
  const headers = req.headers as Record<string, string | string[] | undefined>;

  // 1. W3C traceparent — if a fresh traceparent was supplied, the parentSpanId
  //    inside is the natural caller-supplied span for our inbound span.
  const tp = hint?.traceparent ?? pickHeader(headers, 'traceparent');
  if (tp) {
    const m = TRACEPARENT_RE.exec(tp.trim());
    if (m && SPAN_ID_RE.test(m[3])) {
      return { spanId: m[3].toLowerCase(), source: 'traceparent' };
    }
  }

  // 2. Explicit span header.
  for (const name of SPAN_ID_HEADERS) {
    const v = pickHeader(headers, name);
    if (v && SPAN_ID_RE.test(v.trim())) {
      return { spanId: v.trim().toLowerCase(), source: name as any };
    }
  }

  return { spanId: mintSpanId(), source: 'minted' };
}

/**
 * Build a W3C-compatible traceparent for an OUTGOING request — used by
 * provider adapters when they propagate the traceId to upstream calls.
 * The provider's child span (16-hex) is generated locally so the upstream
 * sees the gateway as its parent.
 */
export function buildTraceparent(traceId: string, parentSpanId: string): string {
  return `00-${traceId}-${parentSpanId}-01`;
}

function pickHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v[0];
  return v;
}

function mintTraceId(): string {
  // 32 hex chars = 16 bytes of entropy = 128 bits — OTel-compliant. node:crypto
  // is available on every supported runtime; Math.random is NOT used (collision
  // risk across bursty gateway traffic).
  return crypto.randomBytes(16).toString('hex');
}

function mintSpanId(): string {
  // 16 hex chars = 8 bytes = 64 bits — OTel-compliant.
  return crypto.randomBytes(8).toString('hex');
}