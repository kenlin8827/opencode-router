/**
 * Content classification: multi-signal scoring classifier.
 *
 * Instead of an ordered chain of regex probes ("first match wins"), every
 * candidate kind is scored in parallel over the sample window (line-pattern
 * hit rate × weight), and the highest score above the threshold wins; if
 * nothing qualifies we fall back to the generic compressor. Scoring is more
 * robust on mixed content (e.g. `git show` = log + diff): the strongest
 * signal wins rather than whichever probe happens to run first.
 */
import { SAMPLE_BYTES, SAMPLE_LINES, DETECT_MIN_SCORE } from './constants.js';

export type ContentKind =
  | 'git-log'
  | 'git-diff'
  | 'git-status'
  | 'build-log'
  | 'grep-hits'
  | 'path-list'
  | 'dir-listing'
  | 'fs-tree'
  | 'numbered-file'
  | 'generic';

const RE_COMMIT_HDR = /^[*|/\\ ]*commit [0-9a-f]{7,40}\b/i;
const RE_ONELINE_ENTRY = /^[0-9a-f]{7,10} \S/i;
const RE_DIFF_HDR = /^diff --git /;
const RE_DIFF_HUNK = /^@@ -\d/;
const RE_BRANCH = /^On branch \S/;
const RE_STATUS_KW = /^(Changes (not |to be )|Untracked files:|nothing to commit|working tree clean)/;
const RE_PORCELAIN = /^[ MADRCU?!][ MADRCU?!] \S/;
// Build-log markers: deliberately high-precision line prefixes only (a bare
// "Error" would misclassify ordinary error logs). Covers npm/pnpm/yarn/bun,
// cargo, maven/gradle, pip, tsc, MSBuild/dotnet, pytest, go test, make,
// eslint, docker build.
const RE_BUILD_MARK = new RegExp(
  '^(' +
  'npm (ERR!|warn|error)|ERR_PNPM_\\w*|pnpm (warn|error)|yarn (error|warning)|bun (error|warn)|' + // js package managers
  '\\s*(Compiling|Downloaded|Downloading|Building|Installing)\\s|' + // cargo / generic progress
  '\\[ERROR\\]|\\[WARNING\\]|BUILD (SUCCESS|FAILED)|FAILURE:|' + // maven / gradle
  'error\\[|warning\\[|' + // rustc
  'FAILED\\s|=+ (FAILURES|ERRORS)|--- FAIL:|FAIL\\t|' + // pytest / go test
  '\\*\\*\\* \\[.*\\] Error|✖ \\d+ problem|' + // make / eslint
  'ERROR:|Found \\d+ error' + // generic / tsc summary
  ')',
  'i'
);
// File-prefixed compiler diagnostics (tsc / MSBuild / F# / etc.) carry the
// source path before the diagnostic, so they match unanchored: "path: error TS2304:"
const RE_BUILD_DIAG = /: (error|warning) (TS|CS|MSB|FS|BC)\d+\s*:/i;
const RE_PERMS = /^[-dl][rwx-]{9}/;
const RE_LS_TOTAL = /^total \d+\s*$/;
const RE_TREE_GLYPH = /[├└│]──?/;
const RE_NUMBERED = /^\s*\d{1,6}\s?[|»›:]\s?\S/;
const RE_PATH_LIKE = /^(\.{0,2}[\\/]|[A-Za-z]:[\\/]|\/)[\w.\-\\/]+$|^\.\.?\/[\w.\-\/]+$/;

export function detectContentKind(text: string): ContentKind {
  const head = text.length > SAMPLE_BYTES ? text.slice(0, SAMPLE_BYTES) : text;
  const lines = head.split('\n').slice(0, SAMPLE_LINES);
  const nonEmpty = lines.filter(l => l.trim().length > 0);
  const n = Math.max(nonEmpty.length, 1);

  const count = (re: RegExp) => nonEmpty.reduce((acc, l) => acc + (re.test(l) ? 1 : 0), 0);

  const scores: [ContentKind, number][] = [
    ['git-diff', count(RE_DIFF_HDR) * 5 + count(RE_DIFF_HUNK) * 3],
    ['git-log', count(RE_COMMIT_HDR) * 4 + count(RE_ONELINE_ENTRY) * 1.5],
    ['git-status', count(RE_BRANCH) * 4 + count(RE_STATUS_KW) * 2 + (count(RE_PORCELAIN) / n >= 0.5 ? 5 : count(RE_PORCELAIN) * 0.5)],
    ['build-log', count(RE_BUILD_MARK) * 2.5 + count(RE_BUILD_DIAG) * 2.5],
    // grep hits: two colons with a pure number between them (file:line:content)
    ['grep-hits', (nonEmpty.filter(isGrepHitLine).length / n) * 8],
    // path list: nearly every non-empty line looks like a path
    ['path-list', (nonEmpty.filter(isPathLine).length / n) * 6],
    ['dir-listing', count(RE_LS_TOTAL) * 2 + count(RE_PERMS) * 2.5],
    ['fs-tree', (nonEmpty.filter(l => RE_TREE_GLYPH.test(l)).length / n) * 7],
    ['numbered-file', (nonEmpty.filter(l => RE_NUMBERED.test(l)).length / n) * 7],
  ];

  let best: ContentKind = 'generic';
  let bestScore = 0;
  for (const [kind, score] of scores) {
    if (score > bestScore) {
      bestScore = score;
      best = kind;
    }
  }
  return bestScore >= DETECT_MIN_SCORE ? best : 'generic';
}

function isGrepHitLine(line: string): boolean {
  let first = line.indexOf(':');
  // Windows absolute paths (C:\...:12:content): skip the drive-letter colon
  if (first === 1 && /[A-Za-z]/.test(line.charAt(0))) first = line.indexOf(':', 2);
  if (first <= 0) return false;
  const second = line.indexOf(':', first + 1);
  if (second === -1) return false;
  const lineno = line.slice(first + 1, second);
  return /^\d+$/.test(lineno) && line.length > second + 1;
}

function isPathLine(line: string): boolean {
  const t = line.trim();
  if (t.length < 2 || t.includes(' ')) return false;
  if (t.includes(':') && !/^[A-Za-z]:[\\/]/.test(t)) return false;
  return RE_PATH_LIKE.test(t);
}
