import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CaptureConfig } from '../config/types.js';
import { getOcrHomeDir } from '../cli/paths.js';

/**
 * One captured turn — a single JSONL line in the per-session archive file.
 * `request` is the PRE-compression snapshot (what the client actually sent);
 * `response` is the full upstream payload. Either becomes a plain string with
 * `truncated: true` when it exceeds the per-body byte budget (a truncated
 * JSON document is no longer valid JSON, so it is stored as a string).
 * Request headers are NEVER captured (they carry API keys).
 */
export interface CaptureRecord {
  id: string; // cap_<hex>
  ts: number; // epoch ms
  sessionId: string; // raw (unsanitized) session id
  status: 'ok' | 'error';
  model: string; // client-requested model id
  request?: unknown;
  /** Post-compression snapshot of what the successful upstream call actually received (same shape as request). */
  upstreamRequest?: unknown;
  /** Upstream error payload when a candidate call failed with a provider response (status + parsed body). */
  upstreamError?: unknown;
  response?: unknown;
  error?: string;
  routing?: {
    tierUsed?: string;
    layerUsed?: string;
    modelUsed?: string;
    provider?: string;
    fallbackOccurred?: boolean;
    failoverPath?: string[];
  };
  usage?: unknown;
  latencyMs?: number;
  truncated?: boolean;
}

export interface CaptureDateRow {
  date: string; // YYYY-MM-DD (local time)
  sessions: number;
  bytes: number;
}

export interface CaptureSessionRow {
  file: string; // safe file name (already sanitized at write time)
  sessionId: string; // same as file minus the .jsonl suffix
  bytes: number;
  mtimeMs: number;
  turns: number; // total captured turns
  failed: number; // turns with status === 'error'
  lastStatus?: 'ok' | 'error'; // status of the most recent turn (badge dot)
  /** First user-message text of the session (single line, capped) so the console list is human-identifiable. */
  preview?: string;
}

/** One archive hit for a session id, across all date directories. */
export interface CaptureSessionMatch extends CaptureSessionRow {
  date: string; // YYYY-MM-DD directory the archive lives in
}

export interface CaptureStatus {
  enabled: boolean;
  dir: string;
  retentionDays: number;
  maxTotalMB: number;
  maxBodyBytes: number;
  totalBytes: number;
  dateCount: number;
}

const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;
// Session ids that are already filesystem-safe are kept verbatim for
// browsability; anything else (path traversal, separators, excess length)
// falls back to a stable content hash.
const SAFE_SESSION_RE = /^[\w.@:-]{1,80}$/;
const JSONL_SUFFIX = '.jsonl';
const TRUNCATION_SUFFIX = '...[TRUNCATED]';
// Read cap for a single archive file — a turn is bounded by maxBodyBytes, so
// this only trips on pathologically long sessions; the tail is what matters.
const MAX_READ_BYTES = 8 * 1024 * 1024;

/**
 * Full request/response capture recorder (opt-in audit log).
 *
 * Archives are plain append-only JSONL files, laid out for O(1) retention:
 *   <rootDir>/<YYYY-MM-DD>/<sanitized-sessionId>.jsonl
 * Retention sweeps delete whole date directories — at boot and on an hourly
 * unref'd timer — first by age (retentionDays), then by total size
 * (maxTotalMB, oldest date first).
 *
 * All I/O fails open: a capture problem must never break an inference request.
 * Mirrors the FlywheelCollector pattern, but keeps full bodies instead of a
 * redacted training summary.
 */
export class CaptureRecorder {
  private enabled: boolean;
  private retentionDays: number;
  private maxTotalBytes: number;
  private maxBodyBytes: number;
  private rootDir: string;
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(config?: CaptureConfig) {
    this.enabled = config?.enabled ?? false;
    this.retentionDays = config?.retentionDays ?? 7;
    this.maxTotalBytes = (config?.maxTotalMB ?? 2048) * 1024 * 1024;
    this.maxBodyBytes = config?.maxBodyBytes ?? 524288;
    this.rootDir = path.resolve(config?.dir || path.join(getOcrHomeDir(), 'capture'));

    if (this.enabled) {
      this.ensureDir(this.rootDir);
      this.sweep();
      this.startSweepTimer();
    }
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public getDir(): string {
    return this.rootDir;
  }

  public stop(): void {
    this.stopSweepTimer();
  }

  /**
   * Hot-apply a new capture config at runtime (console toggle / settings save).
   * Persisted separately via saveConfig(); call applyConfig AFTER a successful
   * save so memory matches disk. Enabling creates the archive dir and runs an
   * immediate retention sweep; disabling stops accepting new records and the
   * sweep timer. Existing archive files are never deleted by disabling.
   */
  public applyConfig(cfg?: CaptureConfig): void {
    this.enabled = cfg?.enabled ?? this.enabled;
    this.retentionDays = cfg?.retentionDays ?? this.retentionDays;
    this.maxTotalBytes = (cfg?.maxTotalMB ?? this.maxTotalBytes / (1024 * 1024)) * 1024 * 1024;
    this.maxBodyBytes = cfg?.maxBodyBytes ?? this.maxBodyBytes;
    const newDir = path.resolve(cfg?.dir || this.rootDir);
    if (newDir !== this.rootDir) {
      this.rootDir = newDir;
    }

    if (this.enabled) {
      this.ensureDir(this.rootDir);
      this.startSweepTimer();
      this.sweep();
    } else {
      this.stopSweepTimer();
    }
  }

  /** Idempotent hourly retention sweep timer (unref'd, never blocks exit). */
  private startSweepTimer(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), 3_600_000);
    this.sweepTimer.unref?.();
  }

  private stopSweepTimer(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  /**
   * Append one captured turn. Fire-and-forget for callers on the inference
   * hot path (`void recorder.record(...)`); tests may await the promise.
   */
  public async record(entry: Omit<CaptureRecord, 'id' | 'ts'>): Promise<void> {
    if (!this.enabled) return;

    const request = this.truncateField(entry.request);
    const upstreamRequest = this.truncateField(entry.upstreamRequest);
    const upstreamError = this.truncateField(entry.upstreamError);
    const response = this.truncateField(entry.response);
    const record: CaptureRecord = {
      ...entry,
      id: `cap_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
      ts: Date.now(),
      request: request.value,
      upstreamRequest: upstreamRequest.value,
      upstreamError: upstreamError.value,
      response: response.value,
      truncated:
        request.truncated || upstreamRequest.truncated || upstreamError.truncated || response.truncated || undefined,
    };

    const file = path.join(
      this.rootDir,
      CaptureRecorder.localDateDir(new Date(record.ts)),
      CaptureRecorder.sessionFileName(record.sessionId)
    );

    try {
      this.ensureDir(path.dirname(file));
      await fs.promises.appendFile(file, JSON.stringify(record) + '\n', 'utf8');
    } catch (err: any) {
      console.warn(`[Capture] Failed to append to ${file}: ${err.message}`);
    }
  }

  /* -------------------------------------------------------------- queries */

  public getStatus(): CaptureStatus {
    const dates = this.listDates();
    return {
      enabled: this.enabled,
      dir: this.rootDir,
      retentionDays: this.retentionDays,
      maxTotalMB: Math.round(this.maxTotalBytes / (1024 * 1024)),
      maxBodyBytes: this.maxBodyBytes,
      totalBytes: dates.reduce((sum, d) => sum + d.bytes, 0),
      dateCount: dates.length,
    };
  }

  /** Date directories, newest first. */
  public listDates(): CaptureDateRow[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.rootDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const rows: CaptureDateRow[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || !DATE_DIR_RE.test(e.name)) continue;
      let sessions = 0;
      let bytes = 0;
      try {
        for (const f of fs.readdirSync(path.join(this.rootDir, e.name), { withFileTypes: true })) {
          if (!f.isFile() || !f.name.endsWith(JSONL_SUFFIX)) continue;
          sessions++;
          try {
            bytes += fs.statSync(path.join(this.rootDir, e.name, f.name)).size;
          } catch {
            // File vanished mid-sweep — skip.
          }
        }
      } catch {
        continue;
      }
      rows.push({ date: e.name, sessions, bytes });
    }
    return rows.sort((a, b) => b.date.localeCompare(a.date));
  }

  /** Session archive files inside one date directory, most recently written first. */
  public listSessions(date: string): CaptureSessionRow[] {
    if (!DATE_DIR_RE.test(date)) return [];
    const dir = path.join(this.rootDir, date);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const rows: CaptureSessionRow[] = [];
    for (const f of entries) {
      if (!f.isFile() || !f.name.endsWith(JSONL_SUFFIX)) continue;
      try {
        const filePath = path.join(dir, f.name);
        const st = fs.statSync(filePath);
        // Per-session outcome tally for the console badges: parse each turn's
        // status (files are bounded by maxBodyBytes per line, so this stays
        // cheap even for long sessions).
        let turns = 0;
        let failed = 0;
        let lastStatus: 'ok' | 'error' | undefined;
        let preview: string | undefined;
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          for (const line of content.split(/\r?\n/)) {
            if (!line.trim()) continue;
            turns++;
            try {
              const rec = JSON.parse(line);
              const status = rec.status;
              if (status === 'error') failed++;
              if (status === 'ok' || status === 'error') lastStatus = status;
              // Files are append-only, so the first line with a request body
              // is the session's opening turn — capture its user text once.
              if (preview === undefined && rec.request !== undefined) {
                preview = CaptureRecorder.extractSessionPreview(rec.request);
              }
            } catch {
              // Corrupt line — counts as a turn but not a failure.
            }
          }
        } catch {
          // Read failed — return metadata without the tally.
        }
        rows.push({
          file: f.name,
          sessionId: f.name.slice(0, -JSONL_SUFFIX.length),
          bytes: st.size,
          mtimeMs: st.mtimeMs,
          turns,
          failed,
          lastStatus,
          preview,
        });
      } catch {
        // Vanished mid-listing — skip.
      }
    }
    return rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  /**
   * Read records from one archive file, newest `limit` records in
   * chronological order. Reads at most the last MAX_READ_BYTES of the file.
   */
  public readRecords(
    date: string,
    file: string,
    limit = 200
  ): { records: CaptureRecord[]; totalLines: number; fileTruncated: boolean } {
    const filePath = this.resolveArchiveFile(date, file);
    if (!filePath) return { records: [], totalLines: 0, fileTruncated: false };

    try {
      const st = fs.statSync(filePath);
      const readSize = Math.min(st.size, MAX_READ_BYTES);
      const fd = fs.openSync(filePath, 'r');
      let text: string;
      try {
        const buf = Buffer.alloc(readSize);
        fs.readSync(fd, buf, 0, readSize, st.size - readSize);
        text = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }

      const lines = text.split(/\r?\n/);
      const fileTruncated = readSize < st.size;
      // Drop the first (likely partial) line when sliced mid-line.
      if (fileTruncated && lines.length > 0) lines.shift();

      const records: CaptureRecord[] = [];
      for (const raw of lines) {
        if (!raw.trim()) continue;
        try {
          records.push(JSON.parse(raw));
        } catch {
          // Corrupt/partial line — skip, never fail the whole read.
        }
      }
      return { records: records.slice(-Math.max(1, limit)), totalLines: records.length, fileTruncated };
    } catch {
      return { records: [], totalLines: 0, fileTruncated: false };
    }
  }

  /**
   * Read the raw JSONL archive verbatim (for export/download). Unlike
   * readRecords this is NOT capped at MAX_READ_BYTES — exports should be
   * complete; per-line size is already bounded by maxBodyBytes at write time.
   *
   * When `exclude` is non-empty, those body fields (request / upstreamRequest
   * / response / upstreamError) are stripped from each turn and the rest is
   * re-serialized — metadata (ts/status/model/routing/usage) always survives.
   * Corrupt lines are kept verbatim, same fail-open policy as every read.
   */
  public readRawArchive(date: string, file: string, exclude?: string[]): string | null {
    const filePath = this.resolveArchiveFile(date, file);
    if (!filePath) return null;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      if (!exclude || exclude.length === 0) return raw;
      const drop = new Set(exclude);
      const out: string[] = [];
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as Record<string, unknown>;
          for (const f of drop) delete rec[f];
          out.push(JSON.stringify(rec));
        } catch {
          out.push(line);
        }
      }
      return out.length > 0 ? out.join('\n') + '\n' : '';
    } catch {
      return null;
    }
  }

  /**
   * Find archive files for one session id across ALL date directories.
   * The raw client-supplied id is re-sanitized with sessionFileName() so
   * hashed archives (h_<hash>.jsonl) match their original id. Name-only
   * readdir scan — no body reads. Newest archive first.
   */
  public findBySession(sessionId: string): CaptureSessionMatch[] {
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!id || id.length > 512) return [];
    const fileName = CaptureRecorder.sessionFileName(id);
    const matches: CaptureSessionMatch[] = [];
    for (const d of this.listDates()) {
      const row = this.listSessions(d.date).find(s => s.file === fileName);
      if (row) matches.push({ ...row, date: d.date });
    }
    return matches;
  }

  /** Delete one whole date directory. Returns true when it existed. */
  public deleteDate(date: string): boolean {
    if (!DATE_DIR_RE.test(date)) return false;
    const dir = path.join(this.rootDir, date);
    if (!path.resolve(dir).startsWith(path.resolve(this.rootDir) + path.sep)) return false;
    if (!fs.existsSync(dir)) return false;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete one session archive file inside a date directory. Returns true
   * when it existed. resolveArchiveFile validates date/file (suffix,
   * traversal) and existence, so this cannot escape the date dir.
   */
  public deleteSession(date: string, file: string): boolean {
    const filePath = this.resolveArchiveFile(date, file);
    if (!filePath) return false;
    try {
      fs.rmSync(filePath, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  /* ------------------------------------------------------------ retention */

  /**
   * Sweep retention: delete date directories older than the retention window,
   * then — if the archive still exceeds maxTotalBytes — delete oldest dates
   * first until it fits. Whole-directory deletes keep this O(dirs), not
   * O(records).
   */
  public sweep(): void {
    let dates: CaptureDateRow[];
    try {
      dates = this.listDates();
    } catch {
      return;
    }
    if (dates.length === 0) return;

    // 1. Age-based: cutoff date string compares correctly in YYYY-MM-DD form.
    const cutoff = new Date(Date.now() - this.retentionDays * 86_400_000);
    const cutoffStr = CaptureRecorder.localDateDir(cutoff);
    const kept: CaptureDateRow[] = [];
    for (const d of dates) {
      if (d.date < cutoffStr) {
        this.deleteDate(d.date);
      } else {
        kept.push(d);
      }
    }

    // 2. Size-based: listDates is newest-first, so trim from the tail (oldest).
    let totalBytes = kept.reduce((sum, d) => sum + d.bytes, 0);
    for (let i = kept.length - 1; i >= 0 && totalBytes > this.maxTotalBytes; i--) {
      if (this.deleteDate(kept[i].date)) {
        totalBytes -= kept[i].bytes;
      }
    }
  }

  /* ------------------------------------------------------------- helpers */

  private truncateField(value: unknown): { value: unknown; truncated: boolean } {
    if (value === undefined || value === null) return { value: undefined, truncated: false };
    let json: string;
    try {
      json = JSON.stringify(value);
    } catch {
      return { value: '[unserializable]', truncated: false };
    }
    if (Buffer.byteLength(json, 'utf8') <= this.maxBodyBytes) {
      return { value, truncated: false };
    }
    // Approximate byte-budget slicing on the JSON string; stored as a plain
    // string because truncated JSON is not parseable anyway.
    return { value: json.slice(0, this.maxBodyBytes) + '...[TRUNCATED]', truncated: true };
  }

  private resolveArchiveFile(date: string, file: string): string | null {
    if (!DATE_DIR_RE.test(date)) return null;
    if (!file || !file.endsWith(JSONL_SUFFIX)) return null;
    if (file.includes('/') || file.includes('\\') || file.includes('..') || file.includes('\0')) return null;
    const dir = path.join(this.rootDir, date);
    const filePath = path.join(dir, file);
    // Defense in depth: the resolved path must stay inside the date dir.
    if (!path.resolve(filePath).startsWith(path.resolve(dir) + path.sep)) return null;
    return fs.existsSync(filePath) ? filePath : null;
  }

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
        // Ignore mkdir errors — appendFile will fail open with a warn.
      }
    }
  }

  /** Filesystem-safe archive file name for a (client-controlled) session id. */
  public static sessionFileName(sessionId: string): string {
    if (SAFE_SESSION_RE.test(sessionId)) return sessionId + JSONL_SUFFIX;
    const hash = crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
    return `h_${hash}${JSONL_SUFFIX}`;
  }

  /**
   * First user-message text from a captured request body — what makes a
   * session recognizable in the console list. Handles the shapes that reach
   * the archive: OpenAI/Anthropic chat (`messages`, content as string or
   * text-part array), Responses API (`input`), and the truncated-string
   * form stored when a body exceeded maxBodyBytes. Fails open to undefined.
   */
  public static extractSessionPreview(request: unknown, cap = 120): string | undefined {
    const text = CaptureRecorder.firstUserText(request);
    if (!text) return undefined;
    const flat = text.replace(/\s+/g, ' ').trim();
    if (!flat) return undefined;
    return flat.length <= cap ? flat : flat.slice(0, cap - 1) + '…';
  }

  private static firstUserText(request: unknown, depth = 0): string | undefined {
    if (request === null || request === undefined || depth > 2) return undefined;
    if (typeof request === 'string') {
      // Truncated bodies are stored as `JSON.slice(0, cap) + '...[TRUNCATED]'`
      // — strip the suffix, then try verbatim parse, then a bracket-repair
      // pass (long sessions exceed maxBodyBytes often, and their opening
      // user message is usually inside the intact prefix).
      const trimmed = request.endsWith(TRUNCATION_SUFFIX)
        ? request.slice(0, -TRUNCATION_SUFFIX.length)
        : request;
      try {
        return CaptureRecorder.firstUserText(JSON.parse(trimmed), depth + 1);
      } catch {
        const repaired = CaptureRecorder.repairTruncatedJson(trimmed);
        if (repaired !== null) return CaptureRecorder.firstUserText(repaired, depth + 1);
        return trimmed.slice(0, 300);
      }
    }
    if (typeof request !== 'object') return undefined;
    const body = request as Record<string, unknown>;
    if (Array.isArray(body.messages)) return CaptureRecorder.userTextFromMessages(body.messages);
    if (Array.isArray(body.input)) return CaptureRecorder.userTextFromMessages(body.input);
    if (typeof body.input === 'string') return body.input;
    return undefined;
  }

  /**
   * Best-effort recovery of the largest well-formed prefix of a truncated
   * JSON document: walk once tracking string state and the brace stack,
   * recording every position where the structure was balanced, then try
   * candidates newest-first — cut there and close the remaining open
   * containers. Newest-first matters: the newest balanced prefix may end on
   * a value-less key (e.g. `{"a":1,"more"`), which is unparseable, while an
   * older candidate closes cleanly. Returns null when nothing parseable can
   * be salvaged.
   */
  private static repairTruncatedJson(s: string): string | null {
    const stack: string[] = [];
    const cuts: { end: number; stack: string[] }[] = [];
    let inStr = false;
    let esc = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') {
          inStr = false;
          cuts.push({ end: i, stack: [...stack] });
        }
      } else if (c === '"') {
        inStr = true;
      } else if (c === '{' || c === '[') {
        stack.push(c === '{' ? '}' : ']');
      } else if (c === '}' || c === ']') {
        stack.pop();
        cuts.push({ end: i, stack: [...stack] });
      }
    }
    for (let k = cuts.length - 1; k >= 0 && k >= cuts.length - 16; k--) {
      const { end, stack: open } = cuts[k];
      const repaired = s.slice(0, end + 1) + open.slice().reverse().join('');
      try {
        JSON.parse(repaired);
        return repaired;
      } catch {
        // Try the next-older balanced prefix.
      }
    }
    return null;
  }

  /** First role === 'user' entry; content as string or text-part array. */
  private static userTextFromMessages(messages: unknown[]): string | undefined {
    for (const m of messages) {
      if (!m || typeof m !== 'object') continue;
      const msg = m as Record<string, unknown>;
      if (msg.role !== 'user') continue;
      const content = msg.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        const parts = content
          .map(p => (p && typeof p === 'object' && typeof (p as any).text === 'string' ? (p as any).text : ''))
          .filter(Boolean);
        if (parts.length > 0) return parts.join(' ');
        continue; // non-text parts only (images etc.) — try the next user message
      }
      continue; // missing/non-text content (tool calls etc.) — try the next user message
    }
    return undefined;
  }

  /** Local-timezone YYYY-MM-DD — retention is by calendar day as users see it. */
  public static localDateDir(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
}
