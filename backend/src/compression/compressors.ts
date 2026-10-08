/**
 * Per-kind compressors.
 *
 * Design principles:
 *  - Structured summaries over blind truncation: parse out semantics
 *    (branch / files / counts) first, then render within a budget,
 *    rather than just cutting lines;
 *  - Each compressor is best-effort only — "output must be smaller"
 *    is enforced by the caller (tool-output);
 *  - Pure functions, no IO, deterministic per input — byte-stable across
 *    turns, so upstream prefix caching is not disturbed.
 */
import {
  GIT_STATUS_FILES_SHOWN,
  GIT_DIFF_CHANGED_LINES_PER_FILE,
  GIT_LOG_ENTRIES_MAX,
  GREP_MATCHES_PER_FILE,
  PATHS_PER_DIR_SHOWN,
  PATHS_DIRS_MAX,
  BUILD_WARNINGS_SHOWN,
  GENERIC_HEAD_LINES,
  GENERIC_TAIL_LINES,
  GENERIC_MIN_LINES_TO_CUT,
  LISTING_NOISE_NAMES,
} from './constants.js';

// ── git status ──────────────────────────────────────────────────────────────
// Parses both porcelain and long-form output, renders a one-line-per-group
// summary with a bounded file list.

export function compressGitStatus(text: string): string {
  let branch = '';
  const staged: string[] = [];
  const modified: string[] = [];
  const untracked: string[] = [];
  let conflicts = 0;

  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;

    const br = line.match(/^On branch (.+)$/) || (line.startsWith('##') ? [null, line.slice(2).trim()] : null);
    if (br) { branch = br[1]; continue; }

    if (/^[ MADRCU?!][ MADRCU?!] \S/.test(line)) {
      const x = line[0];
      const y = line[1];
      const file = line.slice(3).trim();
      if (x === '?' && y === '?') { untracked.push(file); continue; }
      if (x === 'U' || y === 'U') { conflicts++; continue; }
      if ('MADRC'.includes(x)) staged.push(file);
      if ('MD'.includes(y)) modified.push(file);
      continue;
    }

    const long = line.match(/^\s*(new file|modified|deleted|renamed|both modified):\s+(.+)$/);
    if (long) {
      const [, kind, file] = long;
      if (kind === 'both modified') conflicts++;
      else if (kind === 'new file' || kind === 'renamed') staged.push(file.trim());
      else modified.push(file.trim());
    }
  }

  if (!branch && staged.length + modified.length + untracked.length + conflicts === 0) {
    return text; // not really a status output — let the safety net fall back
  }

  const render = (label: string, files: string[]) => {
    if (files.length === 0) return '';
    const shown = files.slice(0, GIT_STATUS_FILES_SHOWN).join(', ');
    const more = files.length > GIT_STATUS_FILES_SHOWN ? ` +${files.length - GIT_STATUS_FILES_SHOWN}` : '';
    return `${label}(${files.length}): ${shown}${more}\n`;
  };

  let out = branch ? `branch: ${branch}\n` : '';
  out += render('staged', staged);
  out += render('modified', modified);
  out += render('untracked', untracked);
  if (conflicts > 0) out += `conflicts: ${conflicts}\n`;
  if (staged.length + modified.length + untracked.length + conflicts === 0) out += 'clean\n';
  return out.trimEnd();
}

// ── git log ─────────────────────────────────────────────────────────────────
// Keeps only short sha + first subject line per commit; drops author/date/
// body/graph decoration.

export function compressGitLog(text: string): string {
  const out: string[] = [];
  let pendingSha = '';
  let truncated = false;

  for (const raw of text.split('\n')) {
    if (out.length >= GIT_LOG_ENTRIES_MAX) { truncated = true; break; }
    const line = raw.replace(/^[*|/\\ ]+/, '').trimEnd();
    const trimmed = line.trim();
    if (!trimmed) continue;

    const commit = trimmed.match(/^commit ([0-9a-f]{7,40})\b/i);
    if (commit) {
      pendingSha = commit[1].slice(0, 8);
      continue;
    }
    if (/^(Author|Date|Merge):/i.test(trimmed)) continue;

    if (pendingSha) {
      out.push(`${pendingSha} ${trimmed}`);
      pendingSha = '';
      continue;
    }
    // --oneline / --graph single-line form
    const oneline = trimmed.match(/^([0-9a-f]{7,10})\s+(.+)$/i);
    if (oneline) {
      out.push(`${oneline[1]} ${oneline[2]}`);
      continue;
    }
    // everything else (stat lines etc.) is dropped
  }

  if (out.length === 0) return text;
  if (truncated) out.push(`… ( truncated at ${GIT_LOG_ENTRIES_MAX} entries )`);
  return out.join('\n');
}

// ── git diff ────────────────────────────────────────────────────────────────
// Per-file +/- counts, keeps changed lines only (no context), bounded per file.

export function compressGitDiff(text: string): string {
  interface FileDiff { name: string; added: number; removed: number; keptLines: string[]; elided: number }
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git')) {
      const m = line.match(/^diff --git a\/.+ b\/(.+)$/);
      cur = { name: m ? m[1] : '(unknown)', added: 0, removed: 0, keptLines: [], elided: 0 };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ') || line.startsWith('@@')) continue;
    if (line.startsWith('+')) {
      cur.added++;
      if (cur.keptLines.length < GIT_DIFF_CHANGED_LINES_PER_FILE) cur.keptLines.push(line);
      else cur.elided++;
    } else if (line.startsWith('-')) {
      cur.removed++;
      if (cur.keptLines.length < GIT_DIFF_CHANGED_LINES_PER_FILE) cur.keptLines.push(line);
      else cur.elided++;
    }
    // context lines are dropped (the +/- counts carry the information)
  }

  if (files.length === 0) return text;

  const out: string[] = [];
  for (const f of files) {
    out.push(`${f.name}: +${f.added} -${f.removed}`);
    for (const l of f.keptLines) out.push(`  ${l}`);
    if (f.elided > 0) out.push(`  … +${f.elided} more changed lines`);
  }
  return out.join('\n');
}

// ── grep hits (file:line:content) ───────────────────────────────────────────
// Aggregates matches per file with a bounded listing.

export function compressGrepHits(text: string): string {
  const byFile = new Map<string, string[]>();
  let total = 0;

  for (const line of text.split('\n')) {
    let first = line.indexOf(':');
    // Windows absolute paths: skip the drive-letter colon
    if (first === 1 && /[A-Za-z]/.test(line.charAt(0))) first = line.indexOf(':', 2);
    if (first <= 0) continue;
    const second = line.indexOf(':', first + 1);
    if (second === -1) continue;
    if (!/^\d+$/.test(line.slice(first + 1, second))) continue;
    const file = line.slice(0, first);
    const entry = `${line.slice(first + 1, second)}: ${line.slice(second + 1).trim()}`;
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file)!.push(entry);
    total++;
  }

  if (total === 0) return text;

  const out: string[] = [`${total} matches / ${byFile.size} files`];
  for (const [file, entries] of [...byFile.entries()].sort()) {
    const shown = entries.slice(0, GREP_MATCHES_PER_FILE);
    out.push(`${file} (${entries.length})`);
    for (const e of shown) out.push(`  ${e}`);
    if (entries.length > GREP_MATCHES_PER_FILE) out.push(`  … +${entries.length - GREP_MATCHES_PER_FILE}`);
  }
  return out.join('\n');
}

// ── path lists (find / glob results) ────────────────────────────────────────
// Groups by directory into "dir (n): a, b +k" rows.

export function compressPathList(text: string): string {
  const paths = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (paths.length === 0) return text;

  const byDir = new Map<string, string[]>();
  for (const p of paths) {
    const sep = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    const dir = sep === -1 ? '.' : p.slice(0, sep) || '/';
    const name = sep === -1 ? p : p.slice(sep + 1);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir)!.push(name);
  }

  const dirs = [...byDir.keys()].sort();
  const out: string[] = [`${paths.length} paths / ${dirs.length} dirs`];
  for (const dir of dirs.slice(0, PATHS_DIRS_MAX)) {
    const names = byDir.get(dir)!;
    const shown = names.slice(0, PATHS_PER_DIR_SHOWN).join(', ');
    const more = names.length > PATHS_PER_DIR_SHOWN ? ` +${names.length - PATHS_PER_DIR_SHOWN}` : '';
    out.push(`${dir} (${names.length}): ${shown}${more}`);
  }
  if (dirs.length > PATHS_DIRS_MAX) out.push(`… +${dirs.length - PATHS_DIRS_MAX} more dirs`);
  return out.join('\n');
}

// ── ls -la directory listings ───────────────────────────────────────────────

const LS_LINE = /^([-dl])[rwx-]{9}\s+\S+\s+\S+\s+\S+\s+(\d+)\s+\w+\s+\d+\s+[\d:]+\s+(.+)$/;

function humanSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)}M`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${bytes}B`;
}

export function compressDirListing(text: string): string {
  const dirs: string[] = [];
  const files: string[] = [];

  for (const line of text.split('\n')) {
    const m = line.match(LS_LINE);
    if (!m) continue;
    const [, type, sizeStr, name] = m;
    if (name === '.' || name === '..' || LISTING_NOISE_NAMES.has(name)) continue;
    if (type === 'd') dirs.push(name);
    else files.push(`${name} ${humanSize(Number(sizeStr))}`);
  }

  if (dirs.length === 0 && files.length === 0) return text;
  const out: string[] = [];
  if (dirs.length > 0) out.push(`dirs(${dirs.length}): ${dirs.join(', ')}`);
  if (files.length > 0) out.push(`files(${files.length}): ${files.join(', ')}`);
  return out.join('\n');
}

// ── tree output ─────────────────────────────────────────────────────────────
// Strips box-drawing glyphs while keeping indentation hierarchy; drops the
// trailing summary line.

export function compressFsTree(text: string): string {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    if (/\d+ director/.test(raw) && /file/.test(raw)) continue; // summary line
    const cleaned = raw
      .replace(/[│|]\s*/g, '  ')
      .replace(/[├└|][─-]+\s?/g, '')
      .trimEnd();
    if (cleaned.trim()) out.push(cleaned);
    if (out.length >= GENERIC_HEAD_LINES) break;
  }
  if (out.length === 0) return text;
  return out.join('\n');
}

// ── build logs ──────────────────────────────────────────────────────────────
// Extracts errors / warnings / final summary; folds progress chatter into a
// step count.

export function compressBuildLog(text: string): string {
  const errors: string[] = [];
  const warnings: string[] = [];
  const summary: string[] = [];
  let progress = 0;

  const isError = (l: string) =>
    /^(npm (ERR!|error)|pnpm (ERR_\w*|error)|bun error|yarn error|error(\[|:| -->)|ERROR:|\[ERROR\]|BUILD FAILED|FAILURE:|FAILED\s|=+ (FAILURES|ERRORS)|--- FAIL:|FAIL\t|\*\*\* \[.*\] Error|✖ \d+ problem)/i.test(l) ||
    /: error (TS|CS|MSB|FS|BC)\d+\s*:/i.test(l);
  const isWarning = (l: string) =>
    /^(npm warn|pnpm warn|bun warn|yarn warning|warning(\[|:| -->)|WARNING:|\[WARNING\]|\[WARN\])/i.test(l) ||
    /: warning (TS|CS|MSB|FS|BC)\d+\s*:/i.test(l);
  const isSummary = (l: string) =>
    /^(added|removed|changed|audited|installed)\s+\d+|^\s*Finished\s|^BUILD SUCCESS|^\d+\s+(vulnerabilit|packages?|warnings?|errors?)|^Successfully (installed|built)|^Found \d+ error|^\d+ (failed|passed|skipped)|^\S+ tests? passed/i.test(l);
  const isProgress = (l: string) =>
    /^\s*(Compiling|Downloading|Downloaded|Fetching|Building|Installing|Resolving|Linking|Bundling|Step \d+\/)\s?/i.test(l);

  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (isError(t)) { errors.push(t); continue; }
    if (isWarning(t)) { warnings.push(t); continue; }
    if (isSummary(t)) { summary.push(t); continue; }
    if (isProgress(t)) { progress++; continue; }
  }

  if (errors.length + warnings.length + summary.length === 0) return text;

  const out: string[] = [];
  if (progress > 0) out.push(`progress: ${progress} steps`);
  for (const e of errors) out.push(`error: ${e}`);
  for (const w of warnings.slice(0, BUILD_WARNINGS_SHOWN)) out.push(`warn: ${w}`);
  if (warnings.length > BUILD_WARNINGS_SHOWN) out.push(`warn: +${warnings.length - BUILD_WARNINGS_SHOWN} more`);
  for (const s of summary) out.push(s);
  return out.join('\n');
}

// ── line-numbered file dumps (read_file "N|content") ───────────────────────

export function compressNumberedFile(text: string): string {
  const lines = text.split('\n');
  if (lines.length < GENERIC_MIN_LINES_TO_CUT) return text;
  const head = lines.slice(0, GENERIC_HEAD_LINES);
  const tail = lines.slice(lines.length - GENERIC_TAIL_LINES);
  return [
    ...head,
    `…… elided ${lines.length - head.length - tail.length} lines ……`,
    ...tail,
  ].join('\n');
}

// ── generic fallback ────────────────────────────────────────────────────────
// Collapses runs of identical lines (×N marker) and blank runs; if still too
// long, keeps head + tail.

export function compressGeneric(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let runLine = '';
  let runCount = 0;
  let pendingBlank = false;

  const flushRun = () => {
    if (runCount === 1) out.push(runLine);
    else if (runCount > 1) out.push(`${runLine}  (×${runCount})`);
    runLine = '';
    runCount = 0;
  };

  for (const line of lines) {
    const t = line.trimEnd();
    if (t === '') {
      flushRun();
      if (!pendingBlank) out.push('');
      pendingBlank = true;
      continue;
    }
    pendingBlank = false;
    if (t === runLine) {
      runCount++;
      continue;
    }
    flushRun();
    runLine = t;
    runCount = 1;
  }
  flushRun();

  if (out.length > GENERIC_MIN_LINES_TO_CUT) {
    const head = out.slice(0, GENERIC_HEAD_LINES);
    const tail = out.slice(out.length - GENERIC_TAIL_LINES);
    return [...head, `…… elided ${out.length - head.length - tail.length} lines ……`, ...tail].join('\n');
  }
  return out.join('\n');
}
