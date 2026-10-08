import fs from 'node:fs';
import path from 'node:path';
import type { ExecutionTrace } from './tracker.js';

/**
 * Durable store for execution traces: a single SQLite database written
 * through on every record() and replayed into the in-memory ring at boot.
 *
 * bun:sqlite is imported dynamically so a node fallback runtime (no bun
 * builtins) degrades gracefully to memory-only instead of crashing at import
 * time. Every method fails open — an observability write must never break
 * the inference hot path.
 */
export interface TraceStore {
  insert(trace: ExecutionTrace): void;
  /** Most recent `limit` traces, oldest first (ready for ring replay). */
  loadRecent(limit: number): ExecutionTrace[];
  deleteBySession(sessionId: string): void;
  /** Age-based deletion, then oldest-first deletion to a total-size budget. */
  sweep(retentionMs: number, maxTotalBytes: number): void;
  close(): void;
}

export async function openTraceStore(dir: string): Promise<TraceStore | null> {
  let Database: typeof import('bun:sqlite').Database;
  try {
    ({ Database } = await import('bun:sqlite'));
  } catch {
    return null; // non-bun runtime — memory-only mode
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
    const db = new Database(path.join(dir, 'traces.db'), { create: true });
    db.run('PRAGMA journal_mode = WAL;');
    db.run(`CREATE TABLE IF NOT EXISTS traces (
      trace_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      data TEXT NOT NULL
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_traces_session ON traces(session_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_traces_ts ON traces(ts)');

    return {
      insert(trace) {
        try {
          db.query('INSERT OR REPLACE INTO traces (trace_id, session_id, ts, data) VALUES (?, ?, ?, ?)').run([
            trace.traceId,
            trace.sessionId,
            trace.timestamp,
            JSON.stringify(trace),
          ]);
        } catch {
          // storage hiccup must not break the hot path
        }
      },

      loadRecent(limit) {
        try {
          const rows = db.query('SELECT data FROM traces ORDER BY ts DESC LIMIT ?').all([limit]) as {
            data: string;
          }[];
          return rows
            .map(r => {
              try {
                return JSON.parse(r.data) as ExecutionTrace;
              } catch {
                return null; // skip corrupted lines
              }
            })
            .filter((t): t is ExecutionTrace => t !== null)
            .reverse();
        } catch {
          return [];
        }
      },

      deleteBySession(sessionId) {
        try {
          db.query('DELETE FROM traces WHERE session_id = ?').run([sessionId]);
        } catch {
          // ignore
        }
      },

      sweep(retentionMs, maxTotalBytes) {
        try {
          db.query('DELETE FROM traces WHERE ts < ?').run([Date.now() - retentionMs]);
          // Size budget: drop the oldest rows in batches until the payload fits.
          for (let i = 0; i < 200; i++) {
            const row = db.query('SELECT SUM(LENGTH(data)) AS bytes FROM traces').get() as { bytes: number | null };
            if (!row?.bytes || row.bytes <= maxTotalBytes) break;
            db.run('DELETE FROM traces WHERE trace_id IN (SELECT trace_id FROM traces ORDER BY ts ASC LIMIT 500)');
          }
        } catch {
          // ignore
        }
      },

      close() {
        try {
          db.close();
        } catch {
          // ignore
        }
      },
    };
  } catch {
    return null; // db open/init failed — memory-only mode
  }
}
