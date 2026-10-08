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
    this.maxTotalBytes = (config?.maxTotalMB ?? 512) * 1024 * 1024;
    this.maxBodyBytes = config?.maxBodyBytes ?? 65536;
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
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          for (const line of content.split(/\r?\n/)) {
            if (!line.trim()) continue;
            turns++;
            try {
              const status = JSON.parse(line).status;
              if (status === 'error') failed++;
              if (status === 'ok' || status === 'error') lastStatus = status;
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
   */
  public readRawArchive(date: string, file: string): string | null {
    const filePath = this.resolveArchiveFile(date, file);
    if (!filePath) return null;
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }
  }

  /** Delete one whole date directory. Returns true when it existed. */
  public deleteDate(date: string): boolean {    if (!DATE_DIR_RE.test(date)) return false;
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

  /** Local-timezone YYYY-MM-DD — retention is by calendar day as users see it. */
  public static localDateDir(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
}
