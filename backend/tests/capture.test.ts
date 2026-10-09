import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CaptureRecorder } from '../src/capture/recorder.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-capture-test-'));
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('CaptureRecorder', () => {
  let tmp: string;
  let recorder: CaptureRecorder;

  before(() => {
    tmp = makeTmpDir();
    recorder = new CaptureRecorder({
      enabled: true,
      dir: tmp,
      retentionDays: 7,
      maxTotalMB: 512,
      maxBodyBytes: 1024,
    });
  });

  after(() => {
    recorder.stop();
    rmrf(tmp);
  });

  it('is disabled by default (opt-in)', () => {
    const off = new CaptureRecorder(undefined);
    assert.equal(off.isEnabled(), false);
    off.stop();
  });

  it('does not write when disabled', async () => {
    const off = new CaptureRecorder({ enabled: false, dir: makeTmpDir() });
    await off.record({ sessionId: 's1', status: 'ok', model: 'auto', request: { a: 1 } });
    assert.equal(fs.readdirSync(off.getDir()).length, 0);
    off.stop();
    rmrf(off.getDir());
  });

  it('archives by local date directory + session id and reads back', async () => {
    await recorder.record({
      sessionId: 'sess_demo_1',
      status: 'ok',
      model: 'auto',
      request: { model: 'auto', messages: [{ role: 'user', content: 'hello' }] },
      response: { id: 'chatcmpl-1', choices: [{ message: { content: 'hi' } }] },
      routing: { tierUsed: 'fast', modelUsed: 'm1', provider: 'p1' },
      usage: { prompt_tokens: 3, completion_tokens: 2 },
      latencyMs: 42,
    });

    const dates = recorder.listDates();
    assert.equal(dates.length, 1);
    assert.match(dates[0].date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(dates[0].sessions, 1);
    assert.ok(dates[0].bytes > 0);

    const sessions = recorder.listSessions(dates[0].date);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].file, 'sess_demo_1.jsonl');
    assert.equal(sessions[0].sessionId, 'sess_demo_1');

    const { records, totalLines } = recorder.readRecords(dates[0].date, sessions[0].file);
    assert.equal(totalLines, 1);
    assert.equal(records[0].status, 'ok');
    assert.equal(records[0].latencyMs, 42);
    assert.match(records[0].id, /^cap_/);
    assert.equal((records[0].response as any).choices[0].message.content, 'hi');
    assert.equal(records[0].truncated, undefined);
  });

  it('appends multiple turns into the same session file', async () => {
    await recorder.record({ sessionId: 'sess_demo_1', status: 'ok', model: 'auto', request: { n: 2 } });
    await recorder.record({ sessionId: 'sess_demo_1', status: 'error', model: 'auto', request: { n: 3 }, error: 'boom' });

    const date = recorder.listDates()[0].date;
    const { records, totalLines } = recorder.readRecords(date, 'sess_demo_1.jsonl');
    assert.equal(totalLines, 3);
    assert.equal(records[2].status, 'error');
    assert.equal(records[2].error, 'boom');
  });

  it('sanitizes client-controlled session ids (path traversal safe)', async () => {
    const evil = '../../etc/passwd';
    const file = CaptureRecorder.sessionFileName(evil);
    assert.ok(file.startsWith('h_'), `expected hashed name, got ${file}`);
    assert.ok(!file.includes('..') && !file.includes('/'));
    // Stable hash for the same input
    assert.equal(file, CaptureRecorder.sessionFileName(evil));

    await recorder.record({ sessionId: evil, status: 'ok', model: 'auto', request: {} });
    const date = recorder.listDates()[0].date;
    const sessions = recorder.listSessions(date);
    assert.ok(sessions.some(s => s.file === file));
    // Nothing escaped the date dir
    assert.equal(fs.existsSync(path.join(tmp, '..', 'etc')), false);
  });

  it('truncates oversized bodies and marks the record', async () => {
    const big = 'x'.repeat(5000); // > maxBodyBytes 1024 once serialized
    await recorder.record({
      sessionId: 'sess_big',
      status: 'ok',
      model: 'auto',
      request: { messages: [{ role: 'user', content: big }] },
      response: { text: big },
    });

    const date = recorder.listDates()[0].date;
    const { records } = recorder.readRecords(date, 'sess_big.jsonl');
    assert.equal(records[0].truncated, true);
    assert.equal(typeof records[0].request, 'string');
    assert.ok(String(records[0].request).endsWith('...[TRUNCATED]'));
    assert.equal(typeof records[0].response, 'string');
  });

  it('rejects path traversal on reads', () => {
    const date = recorder.listDates()[0].date;
    assert.deepEqual(recorder.readRecords(date, '../../secret.jsonl'), { records: [], totalLines: 0, fileTruncated: false });
    assert.deepEqual(recorder.readRecords('2020-01-01; rm -rf', 'sess_demo_1.jsonl'), { records: [], totalLines: 0, fileTruncated: false });
    assert.equal(recorder.readRecords(date, 'sess_demo_1.jsonl').totalLines > 0, true);
  });

  it('sweep deletes date directories older than retentionDays', () => {
    const old = path.join(tmp, '2020-01-01');
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, 'old_sess.jsonl'), '{"old":true}\n');
    assert.ok(fs.existsSync(old));

    recorder.sweep();
    assert.equal(fs.existsSync(old), false);
    // Today's data survives
    assert.ok(recorder.listDates().length >= 1);
  });

  it('deleteDate removes a whole date directory and validates input', () => {
    const dates = recorder.listDates();
    assert.ok(dates.length >= 1);
    const date = dates[0].date;
    assert.equal(recorder.deleteDate('not-a-date'), false);
    assert.equal(recorder.deleteDate(date), true);
    assert.equal(recorder.deleteDate(date), false); // already gone
  });

  it('deleteSession removes one session file and validates input', async () => {
    const dir = makeTmpDir();
    try {
      const rec = new CaptureRecorder({ enabled: true, dir, retentionDays: 7, maxTotalMB: 512, maxBodyBytes: 1024 });
      await rec.record({ sessionId: 'sess_a', status: 'ok', model: 'auto', request: {} });
      await rec.record({ sessionId: 'sess_b', status: 'ok', model: 'auto', request: {} });
      const date = rec.listDates()[0].date;
      assert.equal(rec.listSessions(date).length, 2);

      assert.equal(rec.deleteSession(date, 'sess_a.jsonl'), true);
      assert.equal(rec.deleteSession(date, 'sess_a.jsonl'), false); // already gone
      const left = rec.listSessions(date);
      assert.equal(left.length, 1);
      assert.equal(left[0].file, 'sess_b.jsonl');

      // Validation: bad date / traversal / wrong suffix / unknown file
      assert.equal(rec.deleteSession('not-a-date', 'sess_b.jsonl'), false);
      assert.equal(rec.deleteSession(date, '../../etc/passwd.jsonl'), false);
      assert.equal(rec.deleteSession(date, 'sess_b.txt'), false);
      assert.equal(rec.deleteSession(date, 'sess_missing.jsonl'), false);

      rec.stop();
    } finally {
      rmrf(dir);
    }
  });

  it('readRawArchive filters excluded body fields for export', async () => {
    const dir = makeTmpDir();
    try {
      const rec = new CaptureRecorder({ enabled: true, dir, retentionDays: 7, maxTotalMB: 512, maxBodyBytes: 1024 });
      await rec.record({
        sessionId: 'sess_f',
        status: 'error',
        model: 'auto',
        request: { q: 1 },
        upstreamRequest: { u: 1 },
        upstreamError: { e: 1 },
        error: 'boom',
      });
      await rec.record({
        sessionId: 'sess_f',
        status: 'ok',
        model: 'auto',
        request: { q: 2 },
        upstreamRequest: { u: 2 },
        response: { r: 2 },
      });
      const date = rec.listDates()[0].date;

      // Default: verbatim, bodies intact
      const full = rec.readRawArchive(date, 'sess_f.jsonl');
      assert.ok(full!.includes('"request":{"q":1}'));
      assert.ok(full!.includes('"response":{"r":2}'));

      // Excluding all body fields keeps metadata only
      const filtered = rec.readRawArchive(date, 'sess_f.jsonl', [
        'request',
        'upstreamRequest',
        'response',
        'upstreamError',
      ])!;
      const lines = filtered.trim().split('\n').map(l => JSON.parse(l));
      assert.equal(lines.length, 2);
      assert.equal(lines[0].request, undefined);
      assert.equal(lines[0].upstreamRequest, undefined);
      assert.equal(lines[0].upstreamError, undefined);
      assert.equal(lines[0].status, 'error');
      assert.equal(lines[0].error, 'boom'); // error message is metadata, kept
      assert.equal(lines[1].response, undefined);
      assert.equal(lines[1].status, 'ok');

      rec.stop();
    } finally {
      rmrf(dir);
    }
  });

  it('applyConfig hot-toggles recording without a restart', async () => {
    const dir3 = makeTmpDir();
    try {
      const hot = new CaptureRecorder({ enabled: false, dir: dir3, retentionDays: 7, maxTotalMB: 512, maxBodyBytes: 1024 });
      await hot.record({ sessionId: 's_cold', status: 'ok', model: 'auto', request: {} });
      assert.equal(hot.listDates().length, 0); // still disabled

      hot.applyConfig({ enabled: true });
      assert.equal(hot.isEnabled(), true);
      await hot.record({ sessionId: 's_hot', status: 'ok', model: 'auto', request: {} });
      assert.equal(hot.listDates().length, 1);

      hot.applyConfig({ enabled: false });
      assert.equal(hot.isEnabled(), false);
      await hot.record({ sessionId: 's_after_off', status: 'ok', model: 'auto', request: {} });
      const sessions = hot.listSessions(hot.listDates()[0].date);
      assert.ok(!sessions.some(s => s.file === 's_after_off.jsonl'), 'no writes after hot-disable');
      // Existing archive survives a hot-disable (disable never deletes)
      assert.ok(sessions.some(s => s.file === 's_hot.jsonl'));

      hot.stop();
    } finally {
      rmrf(dir3);
    }
  });

  it('applyConfig picks up a new retention window and sweeps by it', () => {
    const dir4 = makeTmpDir();
    try {
      const old = path.join(dir4, '2026-10-01');
      fs.mkdirSync(old, { recursive: true });
      fs.writeFileSync(path.join(old, 'old.jsonl'), '{"x":1}\n');

      const hot = new CaptureRecorder({ enabled: true, dir: dir4, retentionDays: 365, maxTotalMB: 512, maxBodyBytes: 65536 });
      assert.ok(fs.existsSync(old)); // within the 365d window

      hot.applyConfig({ retentionDays: 1 }); // 2026-10-01 is now out of window
      assert.equal(fs.existsSync(old), false); // applied config swept immediately
      hot.stop();
    } finally {
      rmrf(dir4);
    }
  });

  it('sweep enforces maxTotalBytes by deleting oldest dates first', () => {
    const dir2 = makeTmpDir();
    try {
      fs.mkdirSync(path.join(dir2, '2026-10-06'), { recursive: true });
      fs.writeFileSync(path.join(dir2, '2026-10-06', 'a.jsonl'), '{"x":1}\n');
      fs.mkdirSync(path.join(dir2, '2026-10-07'), { recursive: true });
      fs.writeFileSync(path.join(dir2, '2026-10-07', 'b.jsonl'), '{"x":1}\n');
      // retentionDays 365 keeps both by age; maxTotalMB 0 over-budgets all content.
      const tiny = new CaptureRecorder({ enabled: true, dir: dir2, retentionDays: 365, maxTotalMB: 0 });
      assert.equal(tiny.listDates().length, 0);
      tiny.stop();
    } finally {
      rmrf(dir2);
    }
  });

  it('extractSessionPreview reads the first user message across body shapes', () => {
    const E = CaptureRecorder.extractSessionPreview;
    // OpenAI chat, string content
    assert.equal(E({ messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: '帮我写个爬虫' }] }), '帮我写个爬虫');
    // Text-part array content
    assert.equal(E({ messages: [{ role: 'user', content: [{ type: 'text', text: 'part one' }, { type: 'text', text: 'part two' }] }] }), 'part one part two');
    // Responses API input (string + parts array)
    assert.equal(E({ input: 'plain input' }), 'plain input');
    assert.equal(E({ input: [{ role: 'user', content: [{ type: 'input_text', text: 'responses text' }] }] }), 'responses text');
    // Truncated-string body: strip suffix, repair the cut JSON, recover text
    assert.equal(E('{"messages":[{"role":"user","content":"from truncated"}],"more":...[TRUNCATED]'), 'from truncated');
    assert.equal(
      E('{"messages":[{"role":"system","content":"sys"},{"role":"user","content":"帮我修复登录bug"}],"tools":[{"na...[TRUNCATED]'),
      '帮我修复登录bug'
    );
    // Raw non-JSON string body — falls back to the string head
    assert.equal(E('not json at all'), 'not json at all');
    // Newlines flattened, capped with ellipsis
    assert.equal(E({ messages: [{ role: 'user', content: 'line1\n\nline2' }] }), 'line1 line2');
    const long = 'x'.repeat(300);
    const capped = E({ messages: [{ role: 'user', content: long }] })!;
    assert.equal(capped.length, 120);
    assert.ok(capped.endsWith('…'));
    // No previewable text
    assert.equal(E({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: {} }] }, { role: 'user', content: [{ type: 'image_url', image_url: {} }] }] }), undefined);
    assert.equal(E({}), undefined);
    assert.equal(E(undefined), undefined);
  });

  it('listSessions surfaces the session preview', async () => {
    const dir = makeTmpDir();
    try {
      const rec = new CaptureRecorder({ enabled: true, dir, retentionDays: 7, maxTotalMB: 512, maxBodyBytes: 1024 });
      await rec.record({ sessionId: 'sess_p', status: 'ok', model: 'auto', request: { model: 'auto', messages: [{ role: 'user', content: '第一条用户消息' }] } });
      await rec.record({ sessionId: 'sess_p', status: 'ok', model: 'auto', request: { messages: [{ role: 'user', content: '第二条不覆盖预览' }] } });
      const row = rec.listSessions(rec.listDates()[0].date)[0];
      assert.equal(row.preview, '第一条用户消息');
      rec.stop();
    } finally {
      rmrf(dir);
    }
  });

  it('listSessions tallies event-stream files per TURN (not per event line)', async () => {
    const dir = makeTmpDir();
    try {
      const rec = new CaptureRecorder({ enabled: true, dir, retentionDays: 7, maxTotalMB: 512, maxBodyBytes: 4096 });
      const wire = { requestLine: '', requestHeaders: {}, requestBody: '', responseLine: '', status: 0, responseHeaders: {}, responseBody: '' };
      // Turn 1 (ok): full 4-event cycle.
      for (const [direction, phase, spanId] of [
        ['client', 'request', 's1'], ['upstream', 'request', 's2'],
        ['upstream', 'response', 's2'], ['client', 'response', 's1'],
      ] as const) {
        await rec.recordEvent({
          eventType: 'http-exchange', direction, phase, spanId, traceId: 't1',
          sessionId: 'sess_evt', model: 'auto', status: 'ok',
          wire: direction === 'client' && phase === 'request'
            ? { ...wire, requestBody: JSON.stringify({ messages: [{ role: 'user', content: '事件流预览文本' }] }) }
            : wire,
        });
      }
      // Turn 2 (failed): upstream response is an error → ONE failed turn,
      // even though a gateway-response error event also carries the traceId.
      for (const [direction, phase, spanId, status] of [
        ['client', 'request', 's3', 'ok'], ['upstream', 'request', 's4', 'ok'],
        ['upstream', 'response', 's4', 'error'], ['client', 'response', 's3', 'error'],
      ] as const) {
        await rec.recordEvent({
          eventType: 'http-exchange', direction, phase, spanId, traceId: 't2',
          sessionId: 'sess_evt', model: 'auto', status, wire,
        });
      }
      const row = rec.listSessions(rec.listDates()[0].date)[0];
      assert.equal(row.turns, 2, '8 event lines = 2 turns');
      assert.equal(row.failed, 1, 'failed counts turns, not error events');
      assert.equal(row.lastStatus, 'error');
      assert.equal(row.preview, '事件流预览文本');
      rec.stop();
    } finally {
      rmrf(dir);
    }
  });

  it('findBySession matches safe and hashed ids across dates', async () => {
    const dir = makeTmpDir();
    try {
      const rec = new CaptureRecorder({ enabled: true, dir, retentionDays: 365, maxTotalMB: 512, maxBodyBytes: 1024 });
      await rec.record({ sessionId: 'sess_find', status: 'ok', model: 'auto', request: {} });
      // Same session id on a previous local day (hand-made extra date dir)
      const today = rec.listDates()[0].date;
      const yesterday = new Date(new Date().getTime() - 86_400_000).toISOString().slice(0, 10);
      fs.mkdirSync(path.join(dir, yesterday), { recursive: true });
      fs.writeFileSync(path.join(dir, yesterday, 'sess_find.jsonl'), '{"status":"ok"}\n');
      // Unsafe id → hashed file name must still match the raw id
      const evil = '{"device_id":"x","session_id":"<uuid>"}';
      await rec.record({ sessionId: evil, status: 'ok', model: 'auto', request: {} });

      const safe = rec.findBySession('sess_find');
      assert.equal(safe.length, 2);
      assert.deepEqual(safe.map(m => m.date).sort(), [today, yesterday].sort());
      assert.ok(safe.every(m => m.file === 'sess_find.jsonl'));

      const hashed = rec.findBySession(evil);
      assert.equal(hashed.length, 1);
      assert.ok(hashed[0].file.startsWith('h_'), `expected hashed archive, got ${hashed[0].file}`);

      assert.deepEqual(rec.findBySession('sess_missing'), []);
      assert.deepEqual(rec.findBySession(''), []);
      rec.stop();
    } finally {
      rmrf(dir);
    }
  });
});

describe('CaptureRecorder HTTP exchange event stream', () => {
  let tmp: string;
  let recorder: CaptureRecorder;

  before(() => {
    tmp = makeTmpDir();
    recorder = new CaptureRecorder({
      enabled: true,
      dir: tmp,
      retentionDays: 7,
      maxTotalMB: 512,
      maxBodyBytes: 1024,
    });
  });

  after(() => {
    recorder.stop();
    rmrf(tmp);
  });

  // Helper: emit one full inference turn (4 events) into the recorder
  // with the given correlationId. Wire bodies use minimal valid shapes so
  // the recorder's truncate pass is exercised.
  async function emitOneTurn(
    correlationId: string,
    sessionId: string,
    model: string,
    opts: { inboundStatus?: number; outboundStatus?: number; outboundError?: string } = {}
  ): Promise<{ wireId: string }> {
    const wireId = `wire_${correlationId}`;
    // 1. Client request — fires synchronously the moment the handler
    //    enters the orchestrator.
    await recorder.recordEvent({
      eventType: 'http-exchange',
      direction: 'client',
      phase: 'request',
      spanId: wireId,
      traceId: correlationId,
      sessionId,
      model,
      status: 'ok',
      wire: {
        requestLine: 'POST /v1/chat/completions HTTP/1.1',
        requestHeaders: { 'user-agent': 'opencode-router/test', authorization: '[REDACTED]' },
        requestBody: '{"messages":[]}',
        responseLine: '',
        status: 0,
        responseHeaders: {},
        responseBody: '',
      },
    });
    // 2. Upstream request — fires before the provider fetch.
    await recorder.recordEvent({
      eventType: 'http-exchange',
      direction: 'upstream',
      phase: 'request',
      spanId: `${wireId}_out`,
      traceId: correlationId,
      sessionId,
      model,
      status: 'ok',
      wire: {
        requestLine: 'POST https://api.example/v1/chat/completions HTTP/1.1',
        requestHeaders: { authorization: '[REDACTED]', 'content-type': 'application/json' },
        requestBody: '{"model":"upstream-model","messages":[]}',
        responseLine: '',
        status: 0,
        responseHeaders: {},
        responseBody: '',
      },
    });
    // 3. Upstream response — fires after `await res.text()`.
    await recorder.recordEvent({
      eventType: 'http-exchange',
      direction: 'upstream',
      phase: 'response',
      spanId: `${wireId}_out`,
      traceId: correlationId,
      sessionId,
      model,
      status: opts.outboundError ? 'error' : 'ok',
      wire: {
        requestLine: 'POST https://api.example/v1/chat/completions HTTP/1.1',
        requestHeaders: {},
        requestBody: '',
        responseLine: `HTTP/1.1 ${opts.outboundStatus ?? 200} OK`,
        status: opts.outboundStatus ?? 200,
        responseHeaders: { 'content-type': 'application/json' },
        responseBody: '{"choices":[]}',
      },
      ...(opts.outboundError ? { error: opts.outboundError } : {}),
    });
    // 4. Gateway response — fires in the Fastify onResponse hook.
    await recorder.recordEvent({
      eventType: 'http-exchange',
      direction: 'client',
      phase: 'response',
      spanId: wireId,
      traceId: correlationId,
      sessionId,
      model,
      status: opts.inboundStatus && opts.inboundStatus >= 400 ? 'error' : 'ok',
      wire: {
        requestLine: 'POST /v1/chat/completions HTTP/1.1',
        requestHeaders: {},
        requestBody: '',
        responseLine: `HTTP/1.1 ${opts.inboundStatus ?? 200} OK`,
        status: opts.inboundStatus ?? 200,
        responseHeaders: {},
        responseBody: '',
      },
    });
    return { wireId };
  }

  it('writes exactly 4 events per inference turn (inbound-req/res + outbound-req/res)', async () => {
    const sessionIdA = 'sess_events_aaa';
    const sessionIdB = 'sess_events_bbb';
    await emitOneTurn('corr_aaa', sessionIdA, 'auto-fast');
    await emitOneTurn('corr_bbb', sessionIdB, 'auto-flagship');
    const dateDir = CaptureRecorder.localDateDir(new Date());
    const contentA = fs.readFileSync(path.join(tmp, dateDir, `${sessionIdA}.jsonl`), 'utf8');
    const linesA = contentA.split('\n').filter(l => l.trim());
    assert.equal(linesA.length, 4, 'turn A writes 4 events into its own session file');
    const contentB = fs.readFileSync(path.join(tmp, dateDir, `${sessionIdB}.jsonl`), 'utf8');
    const linesB = contentB.split('\n').filter(l => l.trim());
    assert.equal(linesB.length, 4, 'turn B writes 4 events into its own session file');
  });

  it('groups events into logical turns by traceId (groupEventsIntoTurns)', () => {
    const traceId = 'trace_grp_1';
    const events = [
      // client req (ts 1000)
      { eventType: 'http-exchange', direction: 'client', phase: 'request', traceId, sessionId: 's', model: 'auto', status: 'ok', spanId: 'w1', id: 'a', ts: 1000, wire: emptyWire() } as any,
      // upstream req (ts 1005)
      { eventType: 'http-exchange', direction: 'upstream', phase: 'request', traceId, sessionId: 's', model: 'auto', status: 'ok', spanId: 'w2', id: 'b', ts: 1005, wire: emptyWire() } as any,
      // upstream resp (ts 1500)
      { eventType: 'http-exchange', direction: 'upstream', phase: 'response', traceId, sessionId: 's', model: 'auto', status: 'ok', spanId: 'w2', id: 'c', ts: 1500, wire: emptyWire() } as any,
      // client resp (ts 1520)
      { eventType: 'http-exchange', direction: 'client', phase: 'response', traceId, sessionId: 's', model: 'auto', status: 'ok', spanId: 'w1', id: 'd', ts: 1520, wire: emptyWire() } as any,
    ];
    const turns = CaptureRecorder.groupEventsIntoTurns(events);
    assert.equal(turns.length, 1);
    const t = turns[0];
    assert.equal(t.clientRequest?.id, 'a');
    assert.equal(t.upstreamRequest?.id, 'b');
    assert.equal(t.upstreamResponse?.id, 'c');
    assert.equal(t.gatewayResponse?.id, 'd');
    assert.equal(t.upstreamLatencyMs, 1500 - 1005);
    assert.equal(t.gatewayLatencyMs, 1520 - 1000);
  });

  it('records request event BEFORE response event (request-event independence)', async () => {
    // The core invariant the user asked for: "if you sent a request,
    // record it; you don't have to wait for the response." We test by
    // checking that the client-request line in the JSONL appears BEFORE
    // the client-response line for the same spanId.
    const sessionId = 'sess_indep';
    const wireId = 'wire_indep';
    await recorder.recordEvent({
      eventType: 'http-exchange', direction: 'client', phase: 'request',
      spanId: wireId, traceId: 'c1', sessionId, model: 'auto',
      status: 'ok',
      wire: { requestLine: 'POST /x HTTP/1.1', requestHeaders: {}, requestBody: '{}', responseLine: '', status: 0, responseHeaders: {}, responseBody: '' },
    });
    // Provider throws — emit a failure response. The REQUEST must already
    // be on disk even though the response is a failure.
    await recorder.recordEvent({
      eventType: 'http-exchange', direction: 'upstream', phase: 'request',
      spanId: 'w_out', traceId: 'c1', sessionId, model: 'auto',
      status: 'ok',
      wire: { requestLine: 'POST https://x HTTP/1.1', requestHeaders: {}, requestBody: '{}', responseLine: '', status: 0, responseHeaders: {}, responseBody: '' },
    });
    await recorder.recordEvent({
      eventType: 'http-exchange', direction: 'upstream', phase: 'response',
      spanId: 'w_out', traceId: 'c1', sessionId, model: 'auto',
      status: 'error',
      wire: { requestLine: '', requestHeaders: {}, requestBody: '', responseLine: 'HTTP/1.1 503 Service Unavailable', status: 503, responseHeaders: {}, responseBody: '' },
      error: 'upstream 503',
    });
    await recorder.recordEvent({
      eventType: 'http-exchange', direction: 'client', phase: 'response',
      spanId: wireId, traceId: 'c1', sessionId, model: 'auto',
      status: 'error',
      wire: { requestLine: '', requestHeaders: {}, requestBody: '', responseLine: 'HTTP/1.1 502 Bad Gateway', status: 502, responseHeaders: {}, responseBody: '' },
    });
    const dateDir = CaptureRecorder.localDateDir(new Date());
    const content = fs.readFileSync(path.join(tmp, dateDir, `${sessionId}.jsonl`), 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    assert.equal(lines.length, 4);
    const req = JSON.parse(lines[0]);
    const res = JSON.parse(lines[3]);
    assert.equal(req.phase, 'request');
    assert.equal(req.direction, 'client');
    assert.equal(res.phase, 'response');
    assert.equal(res.direction, 'client');
    assert.equal(req.spanId, res.spanId);
    assert.equal(req.traceId, res.traceId);
    // Failure is durable on both sides.
    const outRes = JSON.parse(lines[2]);
    assert.equal(outRes.status, 'error');
    assert.equal(outRes.error, 'upstream 503');
    assert.equal(outRes.direction, 'upstream');
  });

  it('readEvents groups by correlationId and computes per-direction latency', async () => {
    const sessionId = 'sess_read_events';
    // Two turns, sequential — same sessionId so both land in one JSONL.
    await emitOneTurn('corr_read_1', sessionId, 'auto-fast');
    await emitOneTurn('corr_read_2', sessionId, 'auto-flagship');
    const dateDir = CaptureRecorder.localDateDir(new Date());
    const file = `${sessionId}.jsonl`;
    const result = recorder.readEvents(dateDir, file, 100);
    assert.equal(result.turns.length, 2);
    assert.equal(result.events.length, 8);
    // Each turn has all four events paired.
    for (const t of result.turns) {
      assert.ok(t.clientRequest && t.gatewayResponse && t.upstreamRequest && t.upstreamResponse,
        `turn ${t.traceId} missing event pair`);
      assert.equal(t.clientRequest!.spanId, t.gatewayResponse!.spanId);
      assert.equal(t.upstreamRequest!.spanId, t.upstreamResponse!.spanId);
    }
  });

  it('truncates oversized wire bodies (UTF-8 path)', async () => {
    const sessionId = 'sess_truncate';
    const bigBody = 'x'.repeat(2048); // > maxBodyBytes (1024)
    await recorder.recordEvent({
      eventType: 'http-exchange', direction: 'upstream', phase: 'request',
      spanId: 'w_out', traceId: 'corr_t', sessionId, model: 'auto',
      status: 'ok',
      wire: { requestLine: 'POST x HTTP/1.1', requestHeaders: {}, requestBody: bigBody, responseLine: '', status: 0, responseHeaders: {}, responseBody: '' },
    });
    const dateDir = CaptureRecorder.localDateDir(new Date());
    const content = fs.readFileSync(path.join(tmp, dateDir, `${sessionId}.jsonl`), 'utf8');
    const line = content.split('\n').filter(l => l.trim())[0];
    const obj = JSON.parse(line);
    assert.ok(obj.truncated === true, 'truncated flag must be set');
    const stored = obj.wire.requestBody;
    assert.ok(typeof stored === 'string' && stored.length <= 1024 + '...[TRUNCATED]'.length);
    assert.ok(stored.endsWith('...[TRUNCATED]'));
  });

  it('truncates on a BYTE boundary (CJK body never exceeds the byte budget)', async () => {
    const sessionId = 'sess_truncate_cjk';
    // 600 CJK chars = 1800 UTF-8 bytes > 1024 budget. A code-unit slice
    // would store 1024 chars ≈ 3072 bytes (3× over budget).
    const bigBody = '汉'.repeat(600);
    await recorder.recordEvent({
      eventType: 'http-exchange', direction: 'upstream', phase: 'request',
      spanId: 'w_cjk', traceId: 'corr_cjk', sessionId, model: 'auto',
      status: 'ok',
      wire: { requestLine: 'POST x HTTP/1.1', requestHeaders: {}, requestBody: bigBody, responseLine: '', status: 0, responseHeaders: {}, responseBody: '' },
    });
    const dateDir = CaptureRecorder.localDateDir(new Date());
    const content = fs.readFileSync(path.join(tmp, dateDir, `${sessionId}.jsonl`), 'utf8');
    const line = content.split('\n').filter(l => l.trim())[0];
    const obj = JSON.parse(line);
    assert.ok(obj.truncated === true);
    const stored = obj.wire.requestBody as string;
    assert.ok(stored.endsWith('...[TRUNCATED]'));
    const bodyPart = stored.slice(0, -'...[TRUNCATED]'.length);
    assert.ok(Buffer.byteLength(bodyPart, 'utf8') <= 1024, `byte budget respected, got ${Buffer.byteLength(bodyPart, 'utf8')}`);
  });
});

describe('CaptureRecorder hardening (code-review findings)', () => {
  let tmp: string;
  let recorder: CaptureRecorder;

  before(() => {
    tmp = makeTmpDir();
    recorder = new CaptureRecorder({ enabled: true, dir: tmp, retentionDays: 7, maxTotalMB: 512, maxBodyBytes: 1024 });
  });
  after(() => {
    recorder.stop();
    rmrf(tmp);
  });

  it('redacts credential header VALUES (incl. vendor -key headers) and query auth, keeps names', async () => {
    const { emitUpstreamRequest } = await import('../src/observability/http-exchange.js');
    const sessionId = 'sess_redact';
    emitUpstreamRequest({
      recorder,
      url: 'https://api.example/v1/chat?key=AIzaSySecretKey&foo=bar',
      method: 'POST',
      requestHeaders: {
        Authorization: 'Bearer sk-real-secret',
        'x-api-key': 'real-api-key',
        'x-goog-api-key': 'real-google-key',
        'Ocp-Apim-Subscription-Key': 'real-azure-key',
        'X-Functions-Key': 'real-func-key',
        'content-type': 'application/json',
      },
      requestBody: '{}',
      sessionId,
      traceId: 'trace_redact',
      model: 'auto',
    });
    await new Promise(r => setTimeout(r, 100));
    const dateDir = CaptureRecorder.localDateDir(new Date());
    const content = fs.readFileSync(path.join(tmp, dateDir, `${sessionId}.jsonl`), 'utf8');
    const ev = JSON.parse(content.split('\n').filter(l => l.trim())[0]);
    const h = ev.wire.requestHeaders;
    // Header NAMES kept, VALUES redacted — "you sent an x-api-key" must
    // remain visible for debugging auth failures.
    assert.deepEqual(h, {
      authorization: '[REDACTED]',
      'x-api-key': '[REDACTED]',
      'x-goog-api-key': '[REDACTED]',
      'ocp-apim-subscription-key': '[REDACTED]',
      'x-functions-key': '[REDACTED]',
      'content-type': 'application/json',
    });
    // Query-string auth redacted; non-auth params preserved.
    assert.ok(!ev.wire.requestLine.includes('AIzaSySecretKey'), 'raw query key must never persist');
    assert.ok(ev.wire.requestLine.includes('foo=bar'));
    // No raw credential anywhere in the whole line.
    assert.ok(!content.includes('sk-real-secret') && !content.includes('real-api-key') && !content.includes('real-azure-key'));
  });

  it('groupEventsIntoTurns keeps turns separate when a client reuses one traceId', () => {
    const events = [
      { eventType: 'http-exchange', direction: 'client', phase: 'request', traceId: 'CONST', sessionId: 's', model: 'auto', status: 'ok', spanId: 'a1', id: '1', ts: 1000, wire: emptyWire() } as any,
      { eventType: 'http-exchange', direction: 'client', phase: 'response', traceId: 'CONST', sessionId: 's', model: 'auto', status: 'ok', spanId: 'a1', id: '2', ts: 1100, wire: emptyWire() } as any,
      // Same constant traceId, NEW turn (client sends fixed x-request-id).
      { eventType: 'http-exchange', direction: 'client', phase: 'request', traceId: 'CONST', sessionId: 's', model: 'auto', status: 'ok', spanId: 'b1', id: '3', ts: 2000, wire: emptyWire() } as any,
      { eventType: 'http-exchange', direction: 'client', phase: 'response', traceId: 'CONST', sessionId: 's', model: 'auto', status: 'ok', spanId: 'b1', id: '4', ts: 2100, wire: emptyWire() } as any,
    ];
    const turns = CaptureRecorder.groupEventsIntoTurns(events);
    assert.equal(turns.length, 2, 'constant traceId must not collapse turns');
    assert.equal(turns[0].clientRequest?.id, '1');
    assert.equal(turns[0].gatewayResponse?.id, '2');
    assert.equal(turns[1].clientRequest?.id, '3');
    assert.equal(turns[1].gatewayResponse?.id, '4');
    assert.equal(turns[0].gatewayLatencyMs, 100);
    assert.equal(turns[1].gatewayLatencyMs, 100);
  });
});

function emptyWire(): any {
  return {
    requestLine: '',
    requestHeaders: {},
    requestBody: '',
    responseLine: '',
    status: 0,
    responseHeaders: {},
    responseBody: '',
  };
}
