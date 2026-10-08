/**
 * Tool-output compression: walks role:"tool" messages of the canonical
 * request and compresses their text content by detected kind. Every inbound
 * protocol is normalized to the OpenAI shape at the route layer, so only
 * two carriers need handling here: string content and content-part arrays.
 *
 * Safety rules:
 *  - blobs below MIN_BLOB_BYTES / above MAX_BLOB_BYTES are skipped;
 *  - empty output or output not smaller than the input → keep the original;
 *  - any error → keep the original (fail-open);
 *  - every compressed blob is prefixed with a [token-saver: …] marker that
 *    tells the model it is looking at a summary and how to recover the full
 *    output (rerun a narrower command / pipe through head|tail) — the
 *    primary loop-breaker against blind tool retries. The marker counts
 *    against the size budget: if it eats the saving, the original passes.
 */
import { ChatCompletionRequest } from '../types/openai.js';
import { MIN_BLOB_BYTES, MAX_BLOB_BYTES } from './constants.js';
import { detectContentKind, ContentKind } from './detect.js';
import {
  compressGitStatus,
  compressGitLog,
  compressGitDiff,
  compressGrepHits,
  compressPathList,
  compressDirListing,
  compressFsTree,
  compressBuildLog,
  compressNumberedFile,
  compressGeneric,
} from './compressors.js';

export interface CompressionStats {
  bytesBefore: number;
  bytesAfter: number;
  hits: { kind: ContentKind; saved: number }[];
}

const COMPRESSORS: Record<ContentKind, (text: string) => string> = {
  'git-log': compressGitLog,
  'git-diff': compressGitDiff,
  'git-status': compressGitStatus,
  'build-log': compressBuildLog,
  'grep-hits': compressGrepHits,
  'path-list': compressPathList,
  'dir-listing': compressDirListing,
  'fs-tree': compressFsTree,
  'numbered-file': compressNumberedFile,
  generic: compressGeneric,
};

function countLines(s: string): number {
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

function compressText(text: string, stats: CompressionStats): string {
  const bytesIn = text.length;
  stats.bytesBefore += bytesIn;

  if (bytesIn < MIN_BLOB_BYTES || bytesIn > MAX_BLOB_BYTES) {
    stats.bytesAfter += bytesIn;
    return text;
  }

  const kind = detectContentKind(text);
  let out: string;
  try {
    out = COMPRESSORS[kind](text);
  } catch (err: any) {
    console.warn(`[compression] ${kind} compressor failed — passthrough: ${err?.message || err}`);
    stats.bytesAfter += bytesIn;
    return text;
  }

  if (!out || out.length === 0) {
    stats.bytesAfter += bytesIn;
    return text;
  }

  // Marker: model-visible notice that this is a summary, plus the escape
  // route to the full output. Counted against the size budget below.
  const marked =
    `[token-saver: ${kind} ${countLines(text)}->${countLines(out)} lines; ` +
    `rerun a narrower command or pipe through head/tail for full output]\n${out}`;

  // Safety net: never grow the input (marker included)
  if (marked.length >= bytesIn) {
    stats.bytesAfter += bytesIn;
    return text;
  }

  stats.bytesAfter += marked.length;
  stats.hits.push({ kind, saved: bytesIn - marked.length });
  return marked;
}

/** Compress tool outputs in place. Returns stats, or null when disabled/empty/failed. */
export function compressToolOutputs(request: ChatCompletionRequest, enabled?: boolean): CompressionStats | null {
  if (!enabled) return null;
  if (!request || !Array.isArray(request.messages)) return null;

  const stats: CompressionStats = { bytesBefore: 0, bytesAfter: 0, hits: [] };
  try {
    for (const msg of request.messages) {
      if (!msg || msg.role !== 'tool') continue;

      if (typeof msg.content === 'string') {
        msg.content = compressText(msg.content, stats);
        continue;
      }

      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part && part.type === 'text' && typeof part.text === 'string') {
            part.text = compressText(part.text, stats);
          }
        }
      }
    }
  } catch (e: any) {
    console.warn('[compression] compressToolOutputs error:', e?.message || e);
    return null;
  }
  return stats;
}

/** One-line log summary; null when nothing was compressed. */
export function formatCompressionLog(stats: CompressionStats | null): string | null {
  if (!stats || stats.hits.length === 0) return null;
  const saved = stats.bytesBefore - stats.bytesAfter;
  const pct = stats.bytesBefore > 0 ? ((saved / stats.bytesBefore) * 100).toFixed(1) : '0';
  const kinds = Array.from(new Set(stats.hits.map(h => h.kind))).join(',');
  return `[compression:rtk] saved ${saved}B / ${stats.bytesBefore}B (${pct}%) via [${kinds}] hits=${stats.hits.length}`;
}
