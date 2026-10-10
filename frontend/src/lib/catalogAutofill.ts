import { opencodeApi, type OpenCodeModelView } from './api';
import { EFFORT_LADDER, type ReasoningEffort } from './effort';

/**
 * Catalog auto-fill for the manual model editor: match a user-entered model id
 * against the aggregate catalog (models.dev / OpenRouter / config) and derive
 * a form patch from the hit. Consumers apply fill-blank-only semantics —
 * values the user already typed are never overwritten.
 */

/** Suffix matches shorter than this are noise (e.g. "gpt" matching everything). */
const MIN_SUFFIX_LEN = 3;

/** Reasoning-effort suffixes commonly embedded in gateway model ids
 *  ('ag/gemini-3.8-flash-high' → bare 'gemini-3.8-flash-high' → 'gemini-3.8-flash').
 *  Derived from the shared `EFFORT_LADDER` (the wire vocabulary) minus
 *  `none` (which is never a model-id suffix); the additional entries
 *  (`minimal`, `fast`, `thinking`, `reasoning`) are catalog-vendor noise
 *  that the autofill strips when matching but does not set as the
 *  editor's effort. */
const EFFORT_DETECTABLE_LEVELS: readonly ReasoningEffort[] = EFFORT_LADDER.filter(
  (e) => e !== 'none',
);
const EFFORT_SUFFIXES = [...EFFORT_DETECTABLE_LEVELS, 'minimal', 'fast', 'thinking', 'reasoning'];

/** Subset of `EFFORT_SUFFIXES` that maps 1:1 onto the editor's
 * reasoningEffort dropdown. */
const EFFORT_LEVELS = EFFORT_DETECTABLE_LEVELS;

/**
 * Reasoning-effort level encoded in the user-entered model id, if any
 * ('my-relay/gemini-3.8-flash-high' → 'high'). Only the 5 dropdown levels
 * (everything except `none`) are returned; vendor-noise suffixes
 * (`minimal` / `fast` / `thinking` / `reasoning`) are stripped by
 * `candidateKeys` but never surfaced as the detected level.
 */
export function detectEffortLevel(keys: (string | undefined)[]): ReasoningEffort | undefined {
  for (const raw of keys) {
    const trimmed = (raw || '').trim().toLowerCase();
    if (!trimmed) continue;
    const bare = trimmed.includes('/') ? trimmed.slice(trimmed.lastIndexOf('/') + 1) : trimmed;
    return EFFORT_LEVELS.find((s) => bare.endsWith(`-${s}`));
  }
  return undefined;
}

/**
 * Normalize user-entered model ids into ordered candidate keys, most canonical
 * first: vendor prefix stripped (last '/' segment), then one trailing
 * effort-suffix removed per key. The un-stripped form always outranks the
 * stripped one, so real ids that genuinely end in an effort word are safe.
 */
export function candidateKeys(keys: (string | undefined)[]): string[] {
  const out: string[] = [];
  const push = (k: string) => {
    if (k && !out.includes(k)) out.push(k);
  };
  for (const raw of keys) {
    const trimmed = (raw || '').trim().toLowerCase();
    if (!trimmed) continue;
    const bare = trimmed.includes('/') ? trimmed.slice(trimmed.lastIndexOf('/') + 1) : trimmed;
    push(bare);
    for (const s of EFFORT_SUFFIXES) {
      const stripped = bare.endsWith(`-${s}`) ? bare.slice(0, bare.length - s.length - 1) : null;
      // a too-short remainder ('gpt-low' → 'gpt') is noise, not a catalog id
      if (stripped && stripped.length >= MIN_SUFFIX_LEN) push(stripped);
      if (stripped) break; // strip at most one effort suffix
    }
  }
  return out;
}

/**
 * Score a catalog entry against the candidates. Priority (high → low): exact
 * match on an earlier candidate > later candidate > dash-insensitive exact
 * ('gemini3.8flash' ≡ 'gemini-3.8-flash', some gateways drop separators) >
 * vendor-qualified suffix match as last resort. The caller EXCLUDES the
 * provider's own entries before scoring — self-matches can never fill values.
 */
function scoreCandidate(m: OpenCodeModelView, candidates: string[]): number {
  const id = (m.id || '').toLowerCase();
  const exactIdx = candidates.indexOf(id);
  if (exactIdx >= 0) {
    return [40, 25, 12][Math.min(exactIdx, 2)];
  }
  const normId = id.replace(/-/g, '');
  if (normId.length >= MIN_SUFFIX_LEN) {
    const dashIdx = candidates.findIndex((c) => c.replace(/-/g, '') === normId);
    if (dashIdx >= 0) return 28 - dashIdx;
  }
  const want = candidates[0];
  if (want.length >= MIN_SUFFIX_LEN && id.length >= MIN_SUFFIX_LEN && (id.endsWith(want) || want.endsWith(id))) {
    return 5;
  }
  return 0;
}

/** How much usable data an entry carries — tie-break between equal matches. */
function infoScore(m: OpenCodeModelView): number {
  let s = 0;
  if (m.name) s += 1;
  if (typeof m.cost?.input === 'number' && m.cost.input >= 0) s += 2;
  if (typeof m.cost?.output === 'number' && m.cost.output >= 0) s += 2;
  if (typeof m.limit?.context === 'number' && m.limit.context > 0) s += 1;
  if (m.modalities?.input?.length || m.modalities?.output?.length) s += 1;
  return s;
}

export interface CatalogMatch {
  model: OpenCodeModelView;
  /** How many entries share the winning score — >1 means the pick was ambiguous. */
  alternatives: number;
}

/** Field-by-field fill-missing merge — a lower-ranked entry may carry exactly
 *  the field the top one lacks (pricing vs context vs modalities). */
function mergeModel(a: OpenCodeModelView, b: OpenCodeModelView): OpenCodeModelView {
  const out: OpenCodeModelView = { ...a };
  out.name = out.name || b.name;
  const cost = { ...(out.cost ?? {}) };
  for (const k of ['input', 'output', 'cache_read', 'cache_write'] as const) {
    if (cost[k] === undefined && b.cost?.[k] !== undefined) cost[k] = b.cost[k];
  }
  if (Object.values(cost).some((v) => v !== undefined)) out.cost = cost;
  const limit = { ...(out.limit ?? {}) };
  for (const k of ['context', 'output'] as const) {
    if (limit[k] === undefined && b.limit?.[k] !== undefined) limit[k] = b.limit[k];
  }
  if (limit.context !== undefined || limit.output !== undefined) out.limit = limit;
  if (!out.modalities?.input?.length && !out.modalities?.output?.length && b.modalities) out.modalities = b.modalities;
  if (out.tool_call === undefined && b.tool_call !== undefined) out.tool_call = b.tool_call;
  if (out.reasoning === undefined && b.reasoning !== undefined) out.reasoning = b.reasoning;
  if (out.attachment === undefined && b.attachment !== undefined) out.attachment = b.attachment;
  return out;
}

/**
 * Find the best catalog match for a model among the given candidate ids
 * (later keys act as fallbacks, e.g. [modelID, modelKey]). Handles vendor
 * prefixes, trailing thinking-effort suffixes and dash-style variants via
 * candidateKeys() + scoreCandidate().
 *
 * The provider's OWN entries are excluded — they are the values being filled
 * (a live-pulled list carries no pricing), so a self-match is useless. All
 * equal-best matches are MERGED field-by-field (info-richest first), so the
 * patch carries the union of what the catalog knows; `alternatives` reports
 * how many entries contributed.
 */
export async function matchCatalogModel(providerId: string, ...keys: (string | undefined)[]): Promise<CatalogMatch | null> {
  const candidates = candidateKeys(keys);
  if (candidates.length === 0) return null;
  const res = await opencodeApi.listModels();
  const provider = (providerId || '').trim().toLowerCase();
  const scored: { m: OpenCodeModelView; s: number; info: number }[] = [];
  for (const m of res.models || []) {
    if (provider && (m.providerId || '').toLowerCase() === provider) continue; // never self-fill
    const s = scoreCandidate(m, candidates);
    if (s > 0) scored.push({ m, s, info: infoScore(m) });
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.s - a.s || b.info - a.info);
  const top = scored[0];
  let merged = top.m;
  let alternatives = 1;
  for (const { m, s, info } of scored.slice(1)) {
    if (s !== top.s || info !== top.info) continue;
    merged = mergeModel(merged, m);
    alternatives++;
  }
  return { model: merged, alternatives };
}

export interface CatalogAutofillPatch {
  name?: string;
  tools?: boolean;
  inputMod?: string[];
  outputMod?: string[];
  contextLimit?: string;
  outputLimit?: string;
  costInput?: string;
  costOutput?: string;
  costCacheRead?: string;
  costCacheWrite?: string;
}

/** Catalog record → editor form patch (string-typed limits, per ModelFormState). */
export function catalogAutofillPatch(m: OpenCodeModelView): CatalogAutofillPatch {
  const patch: CatalogAutofillPatch = {};
  if (m.name) patch.name = m.name;
  if (typeof m.limit?.context === 'number' && m.limit.context > 0) patch.contextLimit = String(m.limit.context);
  if (typeof m.limit?.output === 'number' && m.limit.output > 0) patch.outputLimit = String(m.limit.output);
  const input = (m.modalities?.input || []).filter(Boolean);
  const output = (m.modalities?.output || []).filter(Boolean);
  if (input.length > 0) patch.inputMod = input;
  else if (m.attachment === true) patch.inputMod = ['text', 'image']; // legacy v1 vision flag
  if (output.length > 0) patch.outputMod = output;
  if (m.tool_call != null) patch.tools = m.tool_call === true;
  // pricing ($/1M) — finite, non-negative numbers only (OpenRouter has negative
  // promo prices); blank form fields get the catalog value, 0 (free) is kept
  const num = (v: unknown): string | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? String(v) : undefined;
  patch.costInput = num(m.cost?.input);
  patch.costOutput = num(m.cost?.output);
  patch.costCacheRead = num(m.cost?.cache_read);
  patch.costCacheWrite = num(m.cost?.cache_write);
  return patch;
}
