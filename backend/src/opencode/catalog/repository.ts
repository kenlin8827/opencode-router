import { OpenCodeConnector } from '../sync.js';
import { listOpenCodeProviders, getProviderNodeById } from '../user-config.js';
import type { CatalogConfig } from '../../config/types.js';
import { resolveSources, parseByType, type RemoteSourceDef, type ParsedSource } from './sources/registry.js';
import { modelsDevLogoUrl } from './sources/models-dev.js';
import { readCacheFile, writeCacheFile } from './cache.js';
import { proxiedFetch } from '../../utils/proxy.js';
import { localLogoApiPath } from './logos.js';
import type { CatalogModel, CatalogProviderRecord, CatalogSourceId } from './types.js';

/**
 * Config-driven multi-source catalog aggregator.
 *
 * Remote sources are declared in config.yaml (`catalog.sources`) — id/type/url/
 * enabled/priority — and dispatched through the normalizer registry. Adding a
 * source of a known type requires zero code changes.
 *
 * Merge semantics (fill-missing-only): sources are processed in ascending
 * `priority` — the `builtin` baseline (OpenCode's built-in catalog, models.dev)
 * first, then extension sources. Config definitions are established before all
 * remotes, so they win by order. A later source may only fill fields that are
 * absent / empty / zero; non-blank values are never overwritten. Every
 * provider/model keeps the `source` marker of its creating source.
 */

const SERVICE_TTL_MS = 5 * 60 * 1000;
/** OpenRouter's official brand glyph (verified 200). */
const OPENROUTER_BRAND_LOGO = 'https://openrouter.ai/brand/v2/openrouter-glyph-light.svg';

/**
 * A value a later source may fill: absent, empty, or zero. Anything else is
 * "already known" and never overwritten — first non-blank value wins.
 */
export function isBlank(v: any): boolean {
  if (v === undefined || v === null || v === '') return true;
  if (typeof v === 'number') return v === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

function isPlainObject(v: any): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Fill-missing-only value merge: blank base → overlay; blank overlay → base;
 * two plain objects → recurse (nested containers like `cost`/`limit` merge per
 * field); otherwise the first non-blank value wins.
 */
export function mergeFillMissing(base: any, overlay: any): any {
  if (isBlank(base)) return overlay;
  if (isBlank(overlay)) return base;
  if (isPlainObject(base) && isPlainObject(overlay)) {
    const out: any = { ...base };
    for (const [k, v] of Object.entries(overlay)) out[k] = mergeFillMissing(base[k], v);
    return out;
  }
  return base;
}

/**
 * Extension sources may only ENRICH existing model entries (fill-missing per
 * field) — never add new ones. The model universe is defined by config + the
 * builtin baseline; anything else is an overlay, not a source of truth.
 */
export function fillOnlyModels(base: CatalogModel[], overlay: CatalogModel[]): CatalogModel[] {
  if (overlay.length === 0 || base.length === 0) return base;
  const byId = new Map(overlay.map((m) => [m.id, m]));
  return base.map((b) => (byId.has(b.id) ? mergeModels([b], [byId.get(b.id)!])[0] : b));
}

/**
 * Union-merge model lists by id with fill-missing-only semantics: the first
 * source to set a field owns it (undefined / '' / 0 / empty container count as
 * unset); later sources only fill blanks, recursing into nested objects
 * (`cost`, `limit`). `source` stays the creating source.
 */
export function mergeModels(base: CatalogModel[], overlay: CatalogModel[]): CatalogModel[] {
  const byId = new Map<string, CatalogModel>();
  for (const m of base) byId.set(m.id, m);
  for (const m of overlay) {
    const existing = byId.get(m.id);
    if (!existing) {
      byId.set(m.id, m);
      continue;
    }
    const merged: any = { ...existing };
    for (const [k, v] of Object.entries(m)) {
      if (k === 'source') continue;
      merged[k] = mergeFillMissing((existing as any)[k], v);
    }
    byId.set(m.id, merged as CatalogModel);
  }
  return Array.from(byId.values());
}

function addSource(sources: CatalogSourceId[], s: CatalogSourceId): CatalogSourceId[] {
  return sources.includes(s) ? sources : [...sources, s];
}

interface ServiceProbe {
  available: boolean;
  baseURLs: Map<string, string>;
}

interface RemoteState {
  def: RemoteSourceDef;
  parsed: ParsedSource;
  origin: 'network' | 'cache' | 'stale' | 'none';
}

export class CatalogRepository {
  private remote = new Map<string, RemoteState>();
  private serviceProbe: ServiceProbe | null = null;
  private serviceProbedAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private connector: OpenCodeConnector | null = null;
  private sources: RemoteSourceDef[] = resolveSources();
  private intervalMs = 24 * 3600 * 1000;
  private started = false;

  /**
   * Apply config before start(). If `catalog.sources` is empty/omitted the
   * built-in defaults (openrouter, models.dev) are used.
   */
  applyConfig(catalog?: CatalogConfig): this {
    if (this.started) return this;
    if (catalog?.syncIntervalMs && catalog.syncIntervalMs > 0) this.intervalMs = catalog.syncIntervalMs;
    this.sources = resolveSources(catalog?.sources);
    return this;
  }

  /** Boot-time sync of every enabled source + periodic refresh. */
  async start(): Promise<void> {
    this.started = true;
    await Promise.all(this.sources.map((def) => this.syncRemote(def)));
    this.timer = setInterval(() => {
      void Promise.all(this.sources.map((def) => this.syncRemote(def)));
    }, this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get lastSyncOrigin(): string {
    return this.sources
      .map((def) => `${def.id}:${this.remote.get(def.id)?.origin ?? 'none'}`)
      .join(', ');
  }

  private async syncRemote(def: RemoteSourceDef): Promise<void> {
    // v2 = OpenCode-schema catalog records (pricing/limit → cost/limit); the
    // rename invalidates pre-schema-migration caches in one go.
    const cacheName = `catalog-v2-${def.id}`;
    const cached = readCacheFile<ParsedSource>(cacheName);
    // Shape validation: legacy caches (pre-repository) stored a bare array and
    // must NOT be treated as a valid ParsedSource.
    const cachedValid = Boolean(
      cached?.data &&
      typeof cached.data === 'object' &&
      !Array.isArray(cached.data) &&
      (Array.isArray(cached.data.providers) || Array.isArray(cached.data.models))
    );
    const fresh = cachedValid && cached && Date.now() - cached.fetchedAt < this.intervalMs;

    if (fresh && cached) {
      this.applyRemote(def, cached.data, 'cache');
      return;
    }

    try {
      const res = await proxiedFetch(def.url, {
        signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': 'OpenCode-Router/1.0' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = parseByType(def.type, await res.json());
      if (!parsed) throw new Error(`no normalizer registered for type '${def.type}'`);
      const nonEmpty = (parsed.providers?.length || parsed.models?.length || 0) > 0;
      if (nonEmpty) writeCacheFile(cacheName, parsed);
      this.applyRemote(def, parsed, nonEmpty ? 'network' : 'none');
    } catch {
      if (cachedValid && cached) this.applyRemote(def, cached.data, 'stale');
      else {
        this.remote.set(def.id, { def, parsed: {}, origin: 'none' });
      }
    }
  }

  private applyRemote(def: RemoteSourceDef, parsed: ParsedSource, origin: RemoteState['origin']): void {
    this.remote.set(def.id, { def, parsed, origin });
  }

  /** Remote entries producing model lists, ascending priority. */
  private modelSources(): RemoteState[] {
    return [...this.remote.values()]
      .filter((r) => Array.isArray(r.parsed.models) && r.parsed.models!.length > 0)
      .sort((a, b) => a.def.priority - b.def.priority);
  }

  /** OpenRouter-style `vendor/model` → vendor → models (first writer wins per id). */
  private demuxByVendor(): Map<string, CatalogModel[]> {
    const map = new Map<string, CatalogModel[]>();
    for (const src of this.modelSources()) {
      for (const m of src.parsed.models!) {
        const slash = m.id.indexOf('/');
        if (slash <= 0) continue;
        const vendor = m.id.slice(0, slash);
        if (!map.has(vendor)) map.set(vendor, []);
        map.get(vendor)!.push({ ...m, id: m.id.slice(slash + 1) });
      }
    }
    return map;
  }

  private configModelsFor(id: string): CatalogModel[] {
    const node = getProviderNodeById(id);
    if (!node?.models || typeof node.models !== 'object') return [];
    // Config defs use the OpenCode v2 schema (`capabilities{tools,input,output}`);
    // CatalogModel is the snake_case models.dev view (`tool_call`, `modalities`).
    // Normalize v2 → snake_case fill-missing-style so view consumers (e.g. the
    // /models capability column) see one shape; explicit snake_case fields and
    // `capabilities` itself are kept untouched.
    return Object.entries<any>(node.models).map(([mid, m]) => {
      const def = m && typeof m === 'object' ? m : {};
      const caps = def.capabilities && typeof def.capabilities === 'object' ? def.capabilities : {};
      const modalities: Record<string, string[]> = {
        ...(Array.isArray(caps.input) && caps.input.length > 0
          ? { input: caps.input.map((x: any) => String(x)) }
          : {}),
        ...(Array.isArray(caps.output) && caps.output.length > 0
          ? { output: caps.output.map((x: any) => String(x)) }
          : {}),
      };
      return {
        ...def,
        tool_call: def.tool_call ?? (typeof caps.tools === 'boolean' ? caps.tools : undefined),
        reasoning: def.reasoning ?? (caps.reasoning === true || undefined),
        modalities:
          Object.keys(modalities).length > 0
            ? { ...modalities, ...(isPlainObject(def.modalities) ? def.modalities : {}) }
            : def.modalities,
        id: mid,
        source: 'config' as const,
      };
    });
  }

  /** Unified, management-safe catalog view (no secrets). */
  async list(): Promise<CatalogProviderRecord[]> {
    const unified = new Map<string, CatalogProviderRecord>();

    // 1. opencode user data (config definitions + credentials) — real-time, top precedence
    for (const v of listOpenCodeProviders()) {
      unified.set(v.id, {
        id: v.id,
        name: v.name,
        npm: v.npm,
        baseURL: v.baseURL,
        custom: v.custom,
        connected: v.auth.connected,
        sources: ['config'],
        models: this.configModelsFor(v.id),
      });
    }

    const orByVendor = this.demuxByVendor();

    // 2. provider-catalog sources (ascending priority; builtin is the baseline):
    //    later sources only fill blanks on existing records (config was first).
    for (const src of [...this.remote.values()]
      .filter((r) => Array.isArray(r.parsed.providers) && r.parsed.providers!.length > 0)
      .sort((a, b) => a.def.priority - b.def.priority)) {
      const isBaseline = src.def.id === 'builtin';
      for (const md of src.parsed.providers!) {
        const existing = unified.get(md.id);
        if (!existing) {
          // Provider records may be created by any provider-catalog source, but
          // model ENTRIES only by the builtin baseline (config came earlier and
          // keeps priority through fill-missing order).
          unified.set(md.id, { ...md, models: isBaseline ? md.models : [] });
          continue;
        }
        existing.name = existing.name || md.name;
        existing.logo = existing.logo || md.logo;
        existing.api = existing.api || md.api;
        existing.doc = existing.doc || md.doc;
        existing.env = existing.env || md.env;
        existing.sources = addSource(existing.sources, src.def.id as CatalogSourceId);
        if (isBaseline) existing.models = mergeModels(existing.models, md.models);
      }
    }

    // 3. model-list sources: enrich EXISTING providers/models only (fill-missing),
    //    never add model entries — builtin + config define the model universe.
    const ownRecordDone = new Set<string>();
    for (const src of this.modelSources()) {
      const sourceId = src.def.id as CatalogSourceId;
      for (const [vendor, models] of orByVendor) {
        const rec = unified.get(vendor);
        if (!rec) continue;
        rec.sources = addSource(rec.sources, sourceId);
        rec.models = fillOnlyModels(rec.models, models);
      }
      // First-party record for the source itself (e.g. 'openrouter')
      if (!ownRecordDone.has(src.def.id)) {
        ownRecordDone.add(src.def.id);
        const rec = unified.get(src.def.id);
        const models = src.parsed.models!;
        if (rec) {
          rec.models = fillOnlyModels(rec.models, models);
          rec.sources = addSource(rec.sources, sourceId);
          if (src.def.id === 'openrouter') rec.logo = OPENROUTER_BRAND_LOGO;
        } else {
          unified.set(src.def.id, {
            id: src.def.id,
            name: src.def.id,
            logo: src.def.id === 'openrouter' ? OPENROUTER_BRAND_LOGO : modelsDevLogoUrl(src.def.id),
            custom: false,
            connected: false,
            sources: [sourceId],
            models: [], // extension source — no model entries of its own
          });
        }
      }
    }

    // 4. live service baseURL hints (effective routing endpoints)
    const service = await this.probeService();
    if (service.available) {
      for (const [id, baseURL] of service.baseURLs) {
        const rec = unified.get(id);
        if (!rec) continue;
        rec.baseURL = rec.baseURL || baseURL;
        rec.sources = addSource(rec.sources, 'service');
      }
    }

    // 5. serve logos through the local disk-cache proxy (offline-safe page loads)
    return Array.from(unified.values())
      .map((rec) => ({ ...rec, logo: localLogoApiPath(rec.logo) }))
      .sort(
        (a, b) =>
          Number(b.custom || b.connected) - Number(a.custom || a.connected) ||
          (a.name || '').localeCompare(b.name || '')
      );
  }

  async getProvider(id: string): Promise<CatalogProviderRecord | undefined> {
    return (await this.list()).find((p) => p.id === id);
  }

  /** Cheapest known input price ($/1M); negative promo prices are ignored. */
  minInputPrice(rec: CatalogProviderRecord): number | undefined {
    const prices = rec.models
      .map((m) => m.cost?.input)
      .filter((v): v is number => typeof v === 'number' && v >= 0);
    return prices.length > 0 ? Math.min(...prices) : undefined;
  }

  private async probeService(): Promise<ServiceProbe> {
    if (this.serviceProbe && Date.now() - this.serviceProbedAt < SERVICE_TTL_MS) {
      return this.serviceProbe;
    }
    const probe: ServiceProbe = { available: false, baseURLs: new Map() };
    try {
      if (!this.connector) this.connector = new OpenCodeConnector();
      if (this.connector.isAvailable()) {
        const providers = await this.connector.getProviders();
        for (const p of providers) {
          const baseURL = p?.settings?.baseURL;
          if (p?.id && typeof baseURL === 'string') probe.baseURLs.set(p.id, baseURL);
        }
        probe.available = true;
      }
    } catch {
      // service offline — keep cached negative result for the TTL window
    }
    this.serviceProbe = probe;
    this.serviceProbedAt = Date.now();
    return probe;
  }
}

/** Process-wide singleton (scheduler runs once per gateway). */
export const catalogRepository = new CatalogRepository();
