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
