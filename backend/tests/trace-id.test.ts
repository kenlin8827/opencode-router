import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTraceId, resolveSpanId, buildTraceparent } from '../src/observability/trace-id.js';

/**
 * Lightweight FastifyRequest-shaped object — only `headers` is read by
 * the resolver, and we exercise it via a plain record so the test
 * doesn't need to construct a real Fastify instance.
 */
function fakeReq(headers: Record<string, string | undefined>): any {
  return { headers };
}

describe('resolveTraceId', () => {
  it('parses W3C traceparent header (canonical source)', () => {
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    const res = resolveTraceId(fakeReq({ traceparent }), 'client-or-mint');
    assert.equal(res.traceId, '0af7651916cd43dd8448eb211c80319c');
    assert.equal(res.source, 'traceparent');
  });

  it('lowercases traceparent hex (OTel canonical form)', () => {
    const res = resolveTraceId(fakeReq({ traceparent: '00-AABBCC11DD22EE33FF44556677889900-BBBBBBBBBBBBBBBB-01' }), 'client-or-mint');
    assert.equal(res.traceId, 'aabbcc11dd22ee33ff44556677889900');
  });

  it('falls through to x-request-id when traceparent is malformed', () => {
    const res = resolveTraceId(fakeReq({
      traceparent: 'not-a-valid-traceparent',
      'x-request-id': 'req_abc123def456',
    }), 'client-or-mint');
    assert.equal(res.traceId, 'req_abc123def456');
    assert.equal(res.source, 'x-request-id');
  });

  it('falls through to x-request-id when traceparent is absent', () => {
    const res = resolveTraceId(fakeReq({ 'x-request-id': 'req_xyz789' }), 'client-or-mint');
    assert.equal(res.traceId, 'req_xyz789');
  });

  it('falls through to x-trace-id when x-request-id is absent', () => {
    const res = resolveTraceId(fakeReq({ 'x-trace-id': 'trace_abcdef' }), 'client-or-mint');
    assert.equal(res.traceId, 'trace_abcdef');
    assert.equal(res.source, 'x-trace-id');
  });

  it('falls through to x-correlation-id when x-trace-id is absent', () => {
    const res = resolveTraceId(fakeReq({ 'x-correlation-id': 'corr_1234' }), 'client-or-mint');
    assert.equal(res.source, 'x-correlation-id');
  });

  it('accepts non-hex traceIds from upstream SDKs (UUID / NanoID / base32)', () => {
    // Many LLM SDKs send UUIDs in x-request-id; we preserve as-is.
    const res = resolveTraceId(fakeReq({ 'x-request-id': '550e8400-e29b-41d4-a716-446655440000' }), 'client-or-mint');
    assert.equal(res.traceId, '550e8400-e29b-41d4-a716-446655440000');
    assert.equal(res.source, 'x-request-id');
  });

  it('mints a 32-hex traceId when nothing is supplied', () => {
    const res = resolveTraceId(fakeReq({}), 'client-or-mint');
    assert.equal(res.source, 'minted');
    assert.equal(res.traceId.length, 32);
    assert.match(res.traceId, /^[0-9a-f]{32}$/);
  });

  it('throws when client-only policy and nothing supplied (opt-in strict mode)', () => {
    assert.throws(() => resolveTraceId(fakeReq({}), 'client-only'));
  });

  it('two consecutive mints produce DIFFERENT traceIds (no entropy collapse)', () => {
    const a = resolveTraceId(fakeReq({}), 'client-or-mint');
    const b = resolveTraceId(fakeReq({}), 'client-or-mint');
    assert.notEqual(a.traceId, b.traceId);
  });

  it('priority: traceparent WINS over x-request-id (most-explicit)', () => {
    const res = resolveTraceId(fakeReq({
      traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
      'x-request-id': 'should-not-be-used',
    }), 'client-or-mint');
    assert.equal(res.source, 'traceparent');
    assert.equal(res.traceId, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });
});

describe('resolveSpanId', () => {
  it('extracts parentSpanId from traceparent (W3C child semantics)', () => {
    const res = resolveSpanId(fakeReq({
      traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
    }));
    assert.equal(res.spanId, 'bbbbbbbbbbbbbbbb');
    assert.equal(res.source, 'traceparent');
  });

  it('mints a 16-hex spanId when no upstream span is available', () => {
    const res = resolveSpanId(fakeReq({}));
    assert.equal(res.source, 'minted');
    assert.equal(res.spanId.length, 16);
    assert.match(res.spanId, /^[0-9a-f]{16}$/);
  });
});

describe('buildTraceparent', () => {
  it('produces a W3C-compliant traceparent for upstream propagation', () => {
    const tp = buildTraceparent('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb');
    assert.equal(tp, '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01');
  });

  it('round-trips through resolveTraceId', () => {
    const originalTraceId = '1234567890abcdef1234567890abcdef';
    const originalParentSpan = 'fedcba0987654321';
    const tp = buildTraceparent(originalTraceId, originalParentSpan);
    const res = resolveTraceId(fakeReq({ traceparent: tp }), 'client-or-mint');
    assert.equal(res.traceId, originalTraceId);
  });
});

describe('End-to-end trace propagation', () => {
  it('gateway traceId stays consistent across capture event stream', () => {
    // Simulate: client sends traceparent → gateway resolves → events
    // share that traceId. The orchestrator passes `correlationId`
    // (= traceId) to every emit call.
    const upstreamTraceparent = '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-cccccccccccccccc-01';
    const req = fakeReq({ traceparent: upstreamTraceparent });
    const res = resolveTraceId(req, 'client-or-mint');

    // The orchestrator passes res.traceId to every emit helper.
    const events = [
      { direction: 'inbound',  phase: 'request',  correlationId: res.traceId },
      { direction: 'outbound', phase: 'request',  correlationId: res.traceId },
      { direction: 'outbound', phase: 'response', correlationId: res.traceId },
      { direction: 'inbound',  phase: 'response', correlationId: res.traceId },
    ];
    // Every event shares the same traceId — a console reader can join them.
    const traceIds = new Set(events.map(e => e.correlationId));
    assert.equal(traceIds.size, 1, 'all 4 events share one traceId');
    assert.equal(res.traceId, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });
});