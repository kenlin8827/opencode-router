import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { FastifyInstance } from 'fastify';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config/index.js';

/**
 * Auth mirror of server.ts preHandler key resolution: when the local
 * config.yaml defines apiKeys, inference endpoints require a valid key even
 * though the test config passes none (disk keys win over the test config by
 * design). Reuse the first enabled disk key so the e2e cases run both on
 * machines with a populated config.yaml and in clean CI checkouts.
 */
const authHeaders = (): Record<string, string> => {
  const diskKeys = (loadConfig().apiKeys || []).filter(k => k.enabled !== false && k.key);
  return diskKeys.length > 0 ? { authorization: `Bearer ${diskKeys[0].key}` } : {};
};

describe('Session Details & Trajectory Trace Observability Endpoints', () => {
  let app: FastifyInstance;

  before(async () => {
    const config = loadConfig();
    const serverBundle = createServer(config, true);
    app = serverBundle.app;
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it('POST /v1/chat/completions should attach X-OCR-Trace-ID and record execution trajectory', async () => {
    const res = await app.inject({
      headers: { ...authHeaders(), 'x-session-id': 'sess_unit_test_trace_1' },
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: 'Hello, what is 2 + 2?' }],
      },
    });

    assert.strictEqual(res.statusCode, 200);
    const traceId = res.headers['x-ocr-trace-id'] as string;
    const sessionId = res.headers['x-ocr-session-id'] as string;

    assert.ok(traceId, 'Response header must contain X-OCR-Trace-ID');
    assert.ok(traceId.startsWith('trace_'), 'Trace ID should have trace_ prefix');
    assert.strictEqual(sessionId, 'sess_unit_test_trace_1');
  });

  it('GET /v1/sessions should list active sessions with traceCount', async () => {
    const res = await app.inject({
      headers: authHeaders(),
      method: 'GET',
      url: '/v1/sessions',
    });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.object, 'list');
    assert.ok(body.total >= 1);

    const found = body.data.find((s: any) => s.id === 'sess_unit_test_trace_1');
    assert.ok(found, 'Session sess_unit_test_trace_1 should be listed');
    assert.ok(found.traceCount >= 1, 'Session should have traceCount >= 1');
    assert.ok(found.maxTier);
    assert.ok(typeof found.switchCount === 'number', 'switchCount must be reported');
    assert.ok(typeof found.cacheHits === 'number', 'cacheHits must be reported');
    assert.ok(typeof found.savedCostUsd === 'number', 'savedCostUsd must be reported');

    // q filter: substring match over session id, applied before pagination
    const filtered = await app.inject({
      headers: authHeaders(),
      method: 'GET',
      url: '/v1/sessions?q=sess_unit_test',
    });
    assert.strictEqual(filtered.statusCode, 200);
    const fb = JSON.parse(filtered.body);
    assert.ok(fb.total >= 1, 'q filter should match the test session');
    assert.ok(fb.data.every((s: any) => String(s.id).includes('sess_unit_test')));

    const noMatch = await app.inject({
      headers: authHeaders(),
      method: 'GET',
      url: '/v1/sessions?q=zzz_no_such_session_zzz',
    });
    assert.strictEqual(JSON.parse(noMatch.body).total, 0, 'q filter with no hit must return empty');
  });

  it('GET /v1/sessions/:id should return single session details with recent traces', async () => {
    // 1. Success case
    const res = await app.inject({
      headers: authHeaders(),
      method: 'GET',
      url: '/v1/sessions/sess_unit_test_trace_1',
    });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.object, 'session');
    assert.strictEqual(body.id, 'sess_unit_test_trace_1');
    assert.ok(body.traceCount >= 1);
    assert.ok(Array.isArray(body.recentTraces));
    assert.ok(body.recentTraces.length >= 1);

    // 2. 404 Not Found case
    const notFoundRes = await app.inject({
      headers: authHeaders(),
      method: 'GET',
      url: '/v1/sessions/non_existent_session_id',
    });
    assert.strictEqual(notFoundRes.statusCode, 404);
  });

  it('GET /v1/sessions/:id/traces should return chronological trajectory for the session', async () => {
    // Make a 2nd turn on the same session
    await app.inject({
      headers: { ...authHeaders(), 'x-session-id': 'sess_unit_test_trace_1' },
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        messages: [
          { role: 'user', content: 'Hello, what is 2 + 2?' },
          { role: 'assistant', content: '4' },
          { role: 'user', content: 'Now multiply that by 10' },
        ],
      },
    });

    const res = await app.inject({
      headers: authHeaders(),
      method: 'GET',
      url: '/v1/sessions/sess_unit_test_trace_1/traces',
    });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.object, 'list');
    assert.strictEqual(body.sessionId, 'sess_unit_test_trace_1');
    assert.strictEqual(body.total, 2, 'Session should have exactly 2 trajectory steps');
    assert.strictEqual(body.data.length, 2);

    // Check trajectory step structure
    const firstTurn = body.data[0];
    assert.ok(firstTurn.traceId);
    assert.strictEqual(firstTurn.turnNumber, 1);
    assert.ok(firstTurn.request);
    assert.ok(firstTurn.routing);
    assert.ok(firstTurn.execution);
    assert.ok(firstTurn.finops);

    const secondTurn = body.data[1];
    assert.strictEqual(secondTurn.turnNumber, 2);
    assert.ok(secondTurn.timestamp >= firstTurn.timestamp);
  });

  it('GET /v1/traces should list global traces and support filtering by session_id', async () => {
    // 1. Global list
    const res = await app.inject({
      headers: authHeaders(),
      method: 'GET',
      url: '/v1/traces?limit=10',
    });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.object, 'list');
    assert.ok(body.total >= 2);
    assert.ok(body.data.length >= 2);

    // 2. Filtered by session_id
    const filterRes = await app.inject({
      headers: authHeaders(),
      method: 'GET',
      url: '/v1/traces?session_id=sess_unit_test_trace_1',
    });
    assert.strictEqual(filterRes.statusCode, 200);
    const filterBody = JSON.parse(filterRes.body);
    assert.strictEqual(filterBody.total, 2);
    assert.ok(filterBody.data.every((t: any) => t.sessionId === 'sess_unit_test_trace_1'));
  });

  it('GET /v1/traces/:id should return single trace or 404', async () => {
    // Get existing trace ID from session traces
    const listRes = await app.inject({
      headers: authHeaders(),
      method: 'GET',
      url: '/v1/sessions/sess_unit_test_trace_1/traces',
    });
    const listBody = JSON.parse(listRes.body);
    const sampleTraceId = listBody.data[0].traceId;

    // 1. Success query
    const res = await app.inject({
      headers: authHeaders(),
      method: 'GET',
      url: `/v1/traces/${sampleTraceId}`,
    });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.object, 'trace');
    assert.strictEqual(body.traceId, sampleTraceId);
    assert.strictEqual(body.sessionId, 'sess_unit_test_trace_1');

    // 2. 404 query
    const notFoundRes = await app.inject({
      headers: authHeaders(),
      method: 'GET',
      url: '/v1/traces/trace_non_existent_12345',
    });
    assert.strictEqual(notFoundRes.statusCode, 404);
  });

  it('DELETE /v1/sessions/:id should delete the session and its traces', async () => {
    const delRes = await app.inject({
      headers: authHeaders(),
      method: 'DELETE',
      url: '/v1/sessions/sess_unit_test_trace_1',
    });
    assert.strictEqual(delRes.statusCode, 200);
    const delBody = JSON.parse(delRes.body);
    assert.strictEqual(delBody.status, 'ok');

    // Verify session is gone
    const checkRes = await app.inject({
      headers: authHeaders(),
      method: 'GET',
      url: '/v1/sessions/sess_unit_test_trace_1',
    });
    assert.strictEqual(checkRes.statusCode, 404);

    // Verify traces for this session are cleared
    const traceRes = await app.inject({
      headers: authHeaders(),
      method: 'GET',
      url: '/v1/sessions/sess_unit_test_trace_1/traces',
    });
    const traceBody = JSON.parse(traceRes.body);
    assert.strictEqual(traceBody.total, 0);
  });
});
