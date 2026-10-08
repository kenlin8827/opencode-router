import { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { getAllClientStatuses, setupClient, teardownClient } from '../cli/clients/index.js';
import { ProviderRegistry } from '../providers/registry.js';
import { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import { Layer2Judge } from '../router/layer2-judge.js';
import { getRawConfig, loadConfig, saveConfig, saveRawConfig } from '../config/index.js';
import { initProxyConfig } from '../utils/proxy.js';
import { RouterConfig } from '../config/types.js';
import {
  listApiKeys,
  createApiKey,
  updateApiKey,
  deleteApiKey,
  validateApiKey,
} from '../auth/api-keys.js';

export { validateApiKey };

/* ------------------------------------------------------------------------ *
 * Process-log tail helpers (for GET /api/ui/logs).
 * Pino writes NDJSON with a numeric `level`; banner text is plain lines.
 * ------------------------------------------------------------------------ */
const PINO_LEVELS: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};
const LEVEL_NAME_TO_NUM: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

function parseLogLevelParam(name?: string): number {
  if (!name) return 0; // 0 = no filtering
  return LEVEL_NAME_TO_NUM[name.toLowerCase()] ?? 0;
}

export interface ParsedLogLine {
  raw: string;
  level?: string;
  levelNum?: number;
  time?: number;
  msg?: string;
}

function parseLogLine(raw: string): ParsedLogLine {
  if (!raw.startsWith('{')) return { raw };
  try {
    const j = JSON.parse(raw);
    const levelNum = typeof j.level === 'number' ? j.level : undefined;
    return {
      raw,
      level: levelNum !== undefined ? PINO_LEVELS[levelNum] : undefined,
      levelNum,
      time: typeof j.time === 'number' ? j.time : undefined,
      msg: typeof j.msg === 'string' ? j.msg : undefined,
    };
  } catch {
    return { raw };
  }
}

/**
 * All frontend SPA page paths served by handleHtml below. Single source of
 * truth — the auth preHandler hook in server.ts whitelists these exact
 * paths so that refreshing a console page never hits API-key auth.
 * Adding a new console page = add it HERE (nothing else to update).
 */
export const SPA_ROUTES = [
  '/',
  '/ui',
  '/dashboard',
  '/tiers',
  '/auto',
  '/rules',
  '/cache',
  '/providers',
  '/keys', // legacy alias for /providers
  '/api-keys',
  '/models',
  '/proxy',
  '/clients',
  '/guardrails',
  '/usage',
  '/traces',
  '/sessions',
  '/logs',
  '/settings',
  '/yaml',
];

/**
 * Catalog-style model payload → opencode v2 model definition shape
 * (https://opencode.ai/v2/docs/models/): capabilities{tools,input,output},
 * limit, settings.reasoningEffort, headers, body, compatibility.reasoningField,
 * variants, modelID, disabled.
 */
function bodyToModelDef(body: any): Record<string, any> {
  if (body?.definition && typeof body.definition === 'object') return { ...body.definition };
  const def: Record<string, any> = {};
  if (body?.name) def.name = String(body.name);
  if (body?.modelID) def.modelID = String(body.modelID);
  if (body?.disabled != null) def.disabled = Boolean(body.disabled);

  // capabilities: tools + input/output modality lists (present in payload = full replace)
  const caps: Record<string, any> = {};
  if (body?.capabilities?.tools != null) caps.tools = Boolean(body.capabilities.tools);
  else if (body?.toolCall != null) caps.tools = Boolean(body.toolCall);
  const inList = body?.capabilities?.input ?? body?.modalities?.input;
  if (Array.isArray(inList)) {
    const vals = inList.map((x: any) => String(x)).filter(Boolean);
    if (vals.length > 0) caps.input = vals;
  }
  const outList = body?.capabilities?.output ?? body?.modalities?.output;
  if (Array.isArray(outList)) {
    const vals = outList.map((x: any) => String(x)).filter(Boolean);
    if (vals.length > 0) caps.output = vals;
  }
  if (body?.capabilities && typeof body.capabilities === 'object') def.capabilities = caps;
  else if (Object.keys(caps).length > 0) def.capabilities = caps;

  const limit: Record<string, number> = {};
  if (body?.contextLimit) limit.context = Number(body.contextLimit);
  if (body?.outputLimit) limit.output = Number(body.outputLimit);
  if (Object.keys(limit).length > 0) def.limit = limit;

  if (body?.cost && typeof body.cost === 'object') {
    const c: Record<string, number> = {};
    for (const k of ['input', 'output', 'cache_read', 'cache_write'] as const) {
      const v = (body.cost as any)[k];
      if (typeof v === 'number' && Number.isFinite(v)) c[k] = v;
    }
    if (Object.keys(c).length > 0) def.cost = c;
  }

  // settings.reasoningEffort (thinking level); presence in payload = full replace
  if (body?.settings && typeof body.settings === 'object') {
    const s: Record<string, any> = {};
    if (body.settings.reasoningEffort) s.reasoningEffort = String(body.settings.reasoningEffort);
    def.settings = s;
  } else if (body?.reasoningEffort) {
    def.settings = { reasoningEffort: String(body.reasoningEffort) };
  }

  // headers: { Name: Value } map or "Name: Value" lines (presence = full replace)
  if (body?.headers && typeof body.headers === 'object' && !Array.isArray(body.headers)) {
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.headers)) {
      if (k && typeof v === 'string' && v) h[k] = v;
    }
    def.headers = h;
  } else if (typeof body?.headersText === 'string') {
    const h: Record<string, string> = {};
    for (const line of body.headersText.split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        const k = line.slice(0, idx).trim();
        const v = line.slice(idx + 1).trim();
        if (k && v) h[k] = v;
      }
    }
    def.headers = h; // may be {} — clears old headers
  }

  // body: provider-specific request body fields (JSON object; presence = full replace)
  if (body?.body && typeof body.body === 'object' && !Array.isArray(body.body)) {
    def.body = body.body;
  } else if (typeof body?.bodyText === 'string') {
    let parsed: any = {};
    if (body.bodyText.trim()) {
      try {
        parsed = JSON.parse(body.bodyText);
      } catch {
        parsed = {}; // UI validates before submit
      }
    }
    def.body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  }

  // compatibility.reasoningField (presence = full replace)
  if (body?.compatibility && typeof body.compatibility === 'object') {
    const c: Record<string, any> = {};
    if (body.compatibility.reasoningField) c.reasoningField = String(body.compatibility.reasoningField);
    def.compatibility = c;
  }

  // variants: [{ id, settings: { reasoningEffort } }]
  if (Array.isArray(body?.variants)) {
    const variants = body.variants
      .filter((v: any) => v && typeof v === 'object' && v.id)
      .map((v: any) => {
        const entry: Record<string, any> = { id: String(v.id) };
        if (v.settings?.reasoningEffort) entry.settings = { reasoningEffort: String(v.settings.reasoningEffort) };
        return entry;
      });
    if (variants.length > 0) def.variants = variants;
  }
  return def;
}

/** CatalogModel is already in the OpenCode schema — strip id/source, pass the rest through. */
function catalogModelToDef(m: Record<string, any>): Record<string, any> {
  const def: Record<string, any> = {};
  for (const [k, v] of Object.entries(m)) {
    if (k === 'id' || k === 'source') continue;
    if (v === undefined) continue;
    // Flat catalog npm → opencode's model-level `provider: { npm }` override
    // (models.dev schema), so added models keep their exact wire shape.
    if (k === 'npm') {
      def.provider = { ...(def.provider || {}), npm: v };
      continue;
    }
    def[k] = v;
  }
  return def;
}

/**
 * Live pull: fetch the provider's own /v1/models (OpenAI-compatible) using its
 * configured baseURL + credential, so self-hosted gateways absent from the
 * static catalog can still be populated. Every failure mode surfaces a real
 * error (auth, DNS, HTTP status) — never a silent empty result.
 */
async function livePullModels(id: string, body: { pattern?: string; dryRun?: boolean }, reply: any) {
  const { getProviderNodeById, getProviderModelDefs, upsertProviderModel, matchesGlobPattern, expandEnvTemplate, readAuthEntries } =
    await import('../opencode/user-config.js');
  const def = getProviderNodeById(id);
  if (!def) {
    return reply.status(404).send({ success: false, error: `Provider '${id}' is not defined in opencode.jsonc` });
  }
  const baseURL = def?.options?.baseURL;
  if (!baseURL) {
    return reply.status(400).send({ success: false, error: `Provider '${id}' has no baseURL configured` });
  }
  const inlineKey = expandEnvTemplate(def?.options?.apiKey);
  const key = inlineKey || readAuthEntries()[id]?.key;
  if (!key) {
    return reply.status(400).send({
      success: false,
      authHint: true,
      error: `No API key for '${id}' (auth.json or inline) — cannot authenticate against ${baseURL}`,
    });
  }

  const url = `${String(baseURL).replace(/\/+$/, '')}/models`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
  } catch (err: any) {
    const cause = err?.cause?.code || err?.cause?.message || err?.message;
    return reply.status(502).send({ success: false, error: `无法访问 ${url}: ${cause}` });
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 200);
    const hint =
      res.status === 401 || res.status === 403
        ? ' —— 鉴权失败，请检查 API Key'
        : res.status === 404
          ? ' —— 端点不存在，baseURL 可能缺少 /v1 后缀'
          : '';
    return reply.status(res.status === 401 || res.status === 403 ? 401 : 502).send({
      success: false,
      authHint: res.status === 401 || res.status === 403,
      error: `${url} → HTTP ${res.status}${hint}${text ? ` | ${text}` : ''}`,
    });
  }
  const raw = await res.json().catch(() => null);
  if (!raw) {
    return reply.status(502).send({ success: false, error: `${url} 返回了非 JSON 内容` });
  }
  const { normalizeOpenAICompatible } = await import('../opencode/catalog/sources/registry.js');
  const models = normalizeOpenAICompatible(raw);
  const pattern = body?.pattern?.trim();
  const matched = models.filter((m) => !pattern || matchesGlobPattern(pattern, m.id));
  const existing = getProviderModelDefs(id) || {};
  const pullable = matched.filter((m) => !(m.id in existing));
  if (body?.dryRun) {
    return { status: 'ok', live: true, matched: matched.length, pullable: pullable.length, models: pullable };
  }
  let pulled = 0;
  for (const m of pullable) {
    const result = upsertProviderModel(id, m.id, catalogModelToDef(m));
    if (!result.success) return reply.status(400).send(result);
    pulled++;
  }
  return {
    status: 'ok',
    success: true,
    live: true,
    matched: matched.length,
    pullable: pullable.length,
    pulled,
    skipped: matched.length - pullable.length,
    models: pullable.map((m) => m.id),
  };
}

export function registerConsoleRoutes(
  app: FastifyInstance,
  registry: ProviderRegistry,
  orchestrator: PipelineOrchestrator
): void {
  const candidateDistDirs = [
    path.resolve(process.cwd(), 'frontend/dist'),
    path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../../frontend/dist'),
  ];
  const FRONTEND_DIST = candidateDistDirs.find((p) => fs.existsSync(p)) || path.resolve(process.cwd(), 'frontend/dist');

  // 1. Static Asset Serving from frontend/dist/assets
  app.get('/assets/:file', async (req: any, reply: any) => {
    const file = req.params.file;
    // Path traversal guard: the router percent-decodes :file, so "..%2f" arrives
    // as "../". Reject separators/dot-segments outright (asset names are flat
    // hashed filenames like "index-CeY-Ig7t.js").
    if (!file || file.includes('/') || file.includes('\\') || file.includes('..') || file.includes('\0')) {
      return reply.status(400).send('Bad Request');
    }
    const filePath = path.join(FRONTEND_DIST, 'assets', file);
    // Defense in depth: the resolved path must stay inside the assets dir.
    if (!path.resolve(filePath).startsWith(path.join(FRONTEND_DIST, 'assets') + path.sep)) {
      return reply.status(400).send('Bad Request');
    }
    if (fs.existsSync(filePath)) {
      if (file.endsWith('.js')) reply.type('application/javascript');
      else if (file.endsWith('.css')) reply.type('text/css');
      else if (file.endsWith('.svg')) reply.type('image/svg+xml');
      else if (file.endsWith('.json')) reply.type('application/json');
      else if (file.endsWith('.woff2')) reply.type('font/woff2');
      else if (file.endsWith('.woff')) reply.type('font/woff');
      else if (file.endsWith('.ttf')) reply.type('font/ttf');
      return reply.send(fs.readFileSync(filePath));
    }
    return reply.status(404).send('Not Found');
  });

  // 2. React SPA HTML Handler
  const handleHtml = async (_req: any, reply: any) => {
    const indexHtmlPath = path.join(FRONTEND_DIST, 'index.html');
    if (fs.existsSync(indexHtmlPath)) {
      return reply.type('text/html').send(fs.readFileSync(indexHtmlPath, 'utf8'));
    }
    return reply.type('text/html').send(`
      <!DOCTYPE html>
      <html>
        <head><title>OpenCode Router Gateway Console</title></head>
        <body style="background:#09090b;color:#f4f4f5;font-family:sans-serif;padding:40px;text-align:center;">
          <h2>⚡ OpenCode Router Gateway Console</h2>
          <p style="color:#a1a1aa;">The web console assets have not been built yet.</p>
          <p>Please run <code style="color:#06b6d4;background:rgba(255,255,255,0.1);padding:4px 8px;border-radius:4px;">npm run build:frontend</code> to build the React application.</p>
        </body>
      </html>
    `);
  };

  for (const route of SPA_ROUTES) {
    app.get(route, handleHtml);
  }

  // 3. Status Aggregation API for Console
  const handleStatus = async () => {
    const cbSummary = registry.getCircuitBreakerManager().getSummary();
    const metrics = orchestrator.getTracker().getStats();
    const clients = getAllClientStatuses();
    const config = loadConfig();

    const maskedProviders = (config.providers || []).map((p) => ({
      ...p,
      apiKey: p.apiKey ? `${p.apiKey.slice(0, 4)}••••${p.apiKey.slice(-4)}` : '',
      rawKeyConfigured: Boolean(p.apiKey),
    }));

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      metrics,
      circuitBreakers: cbSummary,
      clients,
      providers: maskedProviders,
      registeredModelsCount: registry.getAllModels().length,
    };
  };

  app.get('/api/ui/status', handleStatus);
  app.get('/api/console/status', handleStatus);

  // 3B. Prompt-cache observability (provider-native caching, aggregated from traces)
  app.get('/api/ui/cache-stats', async () => ({
    status: 'ok',
    stats: orchestrator.getTraceTracker().getCacheStats(),
    routingCache: Layer2Judge.getDecisionCacheStats(),
  }));

  // 4. Client Interception Setup / Teardown
  const handleSetup = async (req: any, reply: any) => {
    const { client } = req.params as { client: string };
    const { models, apiKey, contextWindow, extraModels } = (req.body || {}) as {
      models?: Record<string, string>;
      apiKey?: string;
      contextWindow?: number;
      extraModels?: string[];
    };
    const cleaned = models && typeof models === 'object'
      ? Object.fromEntries(Object.entries(models).map(([k, v]) => [k, String(v ?? 'auto').trim() || 'auto']))
      : undefined;
    const cleanedExtra = Array.isArray(extraModels)
      ? extraModels.map(s => String(s || '').trim()).filter(Boolean)
      : undefined;
    const cw = Number(contextWindow);
    const result = await setupClient(client, {
      ...(cleaned ? { models: cleaned } : {}),
      ...(apiKey?.trim() ? { apiKey: apiKey.trim() } : {}),
      ...(Number.isFinite(cw) && cw > 0 ? { contextWindow: Math.floor(cw) } : {}),
      ...(cleanedExtra ? { extraModels: cleanedExtra } : {}),
    });
    if (!result.success) return reply.status(400).send(result);
    return result;
  };

  const handleTeardown = async (req: any, reply: any) => {
    const { client } = req.params as { client: string };
    const result = await teardownClient(client);
    if (!result.success) return reply.status(400).send(result);
    return result;
  };

  app.post('/api/ui/client/:client/setup', handleSetup);
  app.post('/api/console/client/:client/setup', handleSetup);
  app.post('/api/ui/client/:client/teardown', handleTeardown);
  app.post('/api/console/client/:client/teardown', handleTeardown);

  // 5. Configuration Read & Write API
  app.get('/api/ui/config', async () => ({ status: 'ok', config: loadConfig() }));
  app.get('/api/console/config', async () => ({ status: 'ok', config: loadConfig() }));

  const handleSaveConfig = async (req: any, reply: any) => {
    const body = req.body as Partial<RouterConfig>;
    if (!body || typeof body !== 'object') {
      return reply.status(400).send({ success: false, message: 'Invalid config payload' });
    }
    const result = saveConfig(body);
    if (!result.success) return reply.status(400).send(result);
    // Proxy policy is the ONE hot-applied config section: the resolver reads a
    // module singleton per call, so re-snapshot it right after a successful save
    // (everything else still requires a gateway restart — no hot reload).
    initProxyConfig(loadConfig().proxy);
    return result;
  };
  app.post('/api/ui/config', handleSaveConfig);
  app.post('/api/console/config', handleSaveConfig);

  // 6. Raw YAML Configuration
  app.get('/api/ui/config/raw', async () => ({ status: 'ok', yaml: getRawConfig() }));
  app.get('/api/console/config/raw', async () => ({ status: 'ok', yaml: getRawConfig() }));

  const handleSaveRawYaml = async (req: any, reply: any) => {
    const body = req.body as { yaml?: string };
    if (!body?.yaml || typeof body.yaml !== 'string') {
      return reply.status(400).send({ success: false, message: 'YAML content is required' });
    }
    const result = saveRawConfig(body.yaml);
    if (!result.success) return reply.status(400).send(result);
    initProxyConfig(loadConfig().proxy); // hot-apply proxy policy (see handleSaveConfig)
    return result;
  };
  app.post('/api/ui/config/raw', handleSaveRawYaml);
  app.post('/api/console/config/raw', handleSaveRawYaml);

  // 6b. Tier composition policies — effective candidate pools (for console preview)
  const handleTierPools = async () => {
    const tiers = ['fast', 'flagship', 'reasoning'] as const;
    // Preview freshly-saved policies (loadConfig reads config.yaml live) so the
    // console reflects the last save without a gateway restart; runtime routing
    // still uses the registry's construction-time snapshot until restart.
    const freshTiers = loadConfig().tiers;
    const pools: Record<string, unknown> = {};
    for (const tier of tiers) {
      const { pool, excluded } = registry.resolveTierPool(tier, freshTiers);
      const cb = registry.getCircuitBreakerManager();
      pools[tier] = {
        pool: pool.map(({ model, weight }) => ({
          id: model.id,
          provider: model.provider,
          upstreamModel: model.upstreamModel,
          priority: model.priority,
          isDefaultInTier: Boolean(model.isDefaultInTier),
          inputPrice: model.pricing?.input,
          outputPrice: model.pricing?.output,
          healthy: cb.isAvailable(model.id),
          weight,
        })),
        excluded,
      };
    }
    return { status: 'ok', pools };
  };
  app.get('/api/ui/tier-pools', handleTierPools);
  app.get('/api/console/tier-pools', handleTierPools);

  // 7. OpenCode-native Provider Management (opencode.jsonc `provider` node + auth.json)
  //     - Definitions live in ~/.config/opencode/opencode.jsonc (JSONC, comment-preserving edits)
  //     - Credentials live in ~/.local/share/opencode/auth.json
  //     - Connectable catalog comes from models.dev (same source as `opencode auth login`)
  const ocHandlers = {
    list: async () => {
      const { listOpenCodeProviders, getOpenCodeConfigPath, getOpenCodeAuthPath } = await import(
        '../opencode/user-config.js'
      );
      const { catalogRepository } = await import('../opencode/catalog/repository.js');
      const unified = await catalogRepository.list();
      const byId = new Map(unified.map((p) => [p.id, p]));
      return {
        status: 'ok',
        configPath: getOpenCodeConfigPath(),
        authPath: getOpenCodeAuthPath(),
        catalogSync: catalogRepository.lastSyncOrigin,
        providers: listOpenCodeProviders().map((v) => {
          const u = byId.get(v.id);
          return {
            ...v,
            logo: u?.logo,
            // auth-only providers have no config baseURL — fall back to the
            // catalog's effective base (config override → live service hint)
            baseURL: v.baseURL || u?.baseURL,
            priceFrom: u ? catalogRepository.minInputPrice(u) : undefined,
            modelsCount: u?.models.length ?? v.models.length,
          };
        }),
      };
    },

    catalog: async () => {
      const { catalogRepository } = await import('../opencode/catalog/repository.js');
      const unified = await catalogRepository.list();
      // Trim model arrays from the list payload (detail endpoint can serve them later)
      const providers = unified.map((p) => ({
        id: p.id,
        name: p.name,
        logo: p.logo,
        npm: p.npm,
        api: p.api,
        baseURL: p.baseURL,
        doc: p.doc,
        env: p.env,
        custom: p.custom,
        connected: p.connected,
        sources: p.sources,
        modelCount: p.models.length,
        priceFrom: catalogRepository.minInputPrice(p),
      }));
      return { status: 'ok', source: catalogRepository.lastSyncOrigin, providers };
    },

    /** Flat model catalog across providers (supports ?provider= & ?connected=1). */
    models: async (req: any) => {
      const { catalogRepository } = await import('../opencode/catalog/repository.js');
      const query = req.query as { provider?: string; connected?: string };
      const providerFilter = query.provider?.trim().toLowerCase();
      const connectedOnly = query.connected === '1' || query.connected === 'true';
      const unified = await catalogRepository.list();
      const models = unified
        .filter(
          (p) =>
            (!providerFilter || p.id.toLowerCase() === providerFilter) &&
            (!connectedOnly || p.connected)
        )
        .flatMap((p) =>
          p.models.map((m) => ({
            ...m,
            providerId: p.id,
            providerName: p.name,
            logo: p.logo,
            custom: p.custom,
            connected: p.connected,
          }))
        );
      return { status: 'ok', source: catalogRepository.lastSyncOrigin, total: models.length, models };
    },

    create: async (req: any, reply: any) => {
      const body = req.body as any;
      if (!body?.id) {
        return reply.status(400).send({ success: false, error: 'Provider id is required' });
      }
      const { upsertCustomProvider } = await import('../opencode/user-config.js');
      const result = upsertCustomProvider({
        id: String(body.id),
        name: body.name,
        npm: body.npm,
        baseURL: body.baseURL,
        apiKey: body.apiKey,
        apiKeyInline: Boolean(body.apiKeyInline),
        headers: body.headers,
        models: body.models,
        options: body.options,
      });
      if (!result.success) return reply.status(400).send(result);
      return { status: 'ok', ...result };
    },

    update: async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const body = req.body as any;
      const { upsertCustomProvider, getProviderNodeById } = await import('../opencode/user-config.js');
      const existing = getProviderNodeById(id);
      if (!existing) {
        return reply.status(404).send({ success: false, error: `Provider '${id}' not found in opencode.jsonc` });
      }
      const result = upsertCustomProvider({
        id,
        name: body.name ?? existing.name,
        npm: body.npm ?? existing.npm,
        baseURL: body.baseURL ?? existing.options?.baseURL,
        apiKey: body.apiKey,
        apiKeyInline: body.apiKeyInline ?? Boolean(existing.options?.apiKey),
        headers: body.headers ?? existing.options?.headers,
        models: body.models ?? existing.models,
        options: existing.options,
      });
      if (!result.success) return reply.status(400).send(result);
      return { status: 'ok', ...result };
    },

    connect: async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const body = req.body as { apiKey?: string; baseURL?: string };
      const { setAuthApiKey, upsertCustomProvider, getProviderNodeById } = await import('../opencode/user-config.js');
      try {
        if (!body?.apiKey) {
          return reply.status(400).send({
            success: false,
            oauthHint: true,
            error: `API key required. For OAuth-based providers run: opencode auth login ${id}`,
          });
        }
        setAuthApiKey(id, body.apiKey);
        // Optional baseURL override — merge with the existing definition so we
        // never wipe name/npm/models of a config-defined custom provider.
        if (body.baseURL) {
          const existing = getProviderNodeById(id);
          upsertCustomProvider({
            id,
            baseURL: body.baseURL,
            name: existing?.name,
            npm: existing?.npm,
            headers: existing?.options?.headers,
            models: existing?.models,
            options: existing?.options,
          });
        }
        return { status: 'ok', success: true, message: `Provider '${id}' connected via auth.json` };
      } catch (err: any) {
        return reply.status(400).send({ success: false, error: err.message });
      }
    },

    /**
     * One-shot upstream connectivity probe behind the console "Test" buttons.
     * Resolves baseURL/key/model from body overrides (test-before-save) or
     * config/auth.json. Config problems (no key/baseURL/model) are 4xx; probe
     * outcomes (auth failure, network error, upstream error) come back as data
     * on HTTP 200 with ok:false.
     */
    test: async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const body = (req.body || {}) as { modelId?: string; apiKey?: string; baseURL?: string };
      const { getProviderNodeById, getProviderModelDefs, expandEnvTemplate, readAuthEntries } = await import(
        '../opencode/user-config.js'
      );
      const def = getProviderNodeById(id);
      const authEntry = readAuthEntries()[id];
      const { catalogRepository } = await import('../opencode/catalog/repository.js');
      const cat = (await catalogRepository.list()).find((p) => p.id === id);
      // model: explicit override (config key or upstream id) → first enabled
      // config def → first catalog model (auth-only providers)
      const defs = getProviderModelDefs(id);
      const upstreamId = (mid: string): string => {
        const d = defs?.[mid];
        return d && typeof d === 'object' && d.modelID ? String(d.modelID) : mid;
      };
      const enabledDefIds = Object.keys(defs || {}).filter((k) => (defs as any)[k]?.disabled !== true);
      const modelId = body.modelId
        ? upstreamId(body.modelId)
        : enabledDefIds.length > 0
          ? upstreamId(enabledDefIds[0])
          : cat?.models[0]?.id;
      if (!modelId) {
        return reply.status(400).send({ success: false, error: `'${id}' 没有可用于测试的模型 —— 请先添加模型` });
      }

      // ADR-0011: probes run DIRECT against the provider on the same wire the
      // executor resolved for this model (shared wireFor()). The opencode
      // daemon is not in any request path — no test-vs-inference divergence.
      const apiKey = body.apiKey || expandEnvTemplate(def?.options?.apiKey) || authEntry?.key || authEntry?.access;
      if (!apiKey) {
        return reply.status(400).send({
          success: false,
          oauthHint: true,
          error: `No API key for '${id}' (auth.json or inline). For OAuth-based providers run: opencode auth login ${id}`,
        });
      }
      // Same precedence as boot-direct pool construction (models.dev `api`
      // before the daemon runtime hint) — test must hit what inference hits.
      const baseURL = body.baseURL || def?.options?.baseURL || cat?.api || cat?.baseURL;
      if (!baseURL) {
        return reply
          .status(400)
          .send({ success: false, error: `无法确定 '${id}' 的 baseURL —— 请先配置带 baseURL 的自定义 provider` });
      }
      const { probeProvider, probeKindFor } = await import('../opencode/probe.js');
      const { baseForWire } = await import('../providers/wire.js');
      // Model-level npm override (e.g. Zen gpt-6-luna → @ai-sdk/openai =
      // Responses API) beats provider-level npm when picking the wire shape.
      const modelNpm = cat?.models.find((mm) => mm.id === modelId)?.npm;
      const kind = probeKindFor(cat?.api, modelNpm || def?.npm || cat?.npm);
      const result = await probeProvider({
        baseURL: baseForWire(kind, baseURL),
        apiKey,
        model: modelId,
        provider: id,
        kind,
        headers: def?.options?.headers,
        // explicit body.apiKey override is a plain API key, never OAuth
        oauth: !body.apiKey && authEntry?.type === 'oauth',
      });
      return { status: 'ok', provider: id, model: modelId, ...result };
    },

    setKey: async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const body = req.body as { apiKey?: string };
      const { setAuthApiKey } = await import('../opencode/user-config.js');
      if (!body?.apiKey) {
        return reply.status(400).send({ success: false, error: 'apiKey is required' });
      }
      try {
        setAuthApiKey(id, body.apiKey);
        return { status: 'ok', success: true, message: `Credential updated for '${id}'` };
      } catch (err: any) {
        return reply.status(400).send({ success: false, error: err.message });
      }
    },

    remove: async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const query = req.query as { purgeAuth?: string };
      const { deleteCustomProvider, removeAuthEntry, getProviderNodeById } = await import(
        '../opencode/user-config.js'
      );
      const purgeAuth = query.purgeAuth === '1' || query.purgeAuth === 'true';
      if (getProviderNodeById(id)) {
        const result = deleteCustomProvider(id, { purgeAuth });
        if (!result.success) return reply.status(400).send(result);
        return { status: 'ok', ...result };
      }
      // Credential-only entry (catalog provider connected via auth.json)
      try {
        removeAuthEntry(id);
        return { status: 'ok', success: true, message: `Credential entry '${id}' removed` };
      } catch (err: any) {
        return reply.status(400).send({ success: false, error: err.message });
      }
    },

    // -- Per-provider model maintenance (config-defined providers only) ----

    /** Full model definitions of a config-defined provider (management view). */
    modelsGet: async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const { getProviderModelDefs } = await import('../opencode/user-config.js');
      const defs = getProviderModelDefs(id);
      if (defs === undefined) {
        return reply.status(404).send({ success: false, error: `Provider '${id}' is not defined in opencode.jsonc` });
      }
      return { status: 'ok', id, models: defs };
    },

    /** Add one model. Body: catalog-style fields or a raw `definition` object. */
    modelAdd: async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const body = req.body as any;
      const { getProviderModelDefs, upsertProviderModel } = await import('../opencode/user-config.js');
      if (!body?.id) {
        return reply.status(400).send({ success: false, error: 'Model id is required' });
      }
      const defs = getProviderModelDefs(id);
      if (defs === undefined) {
        return reply.status(404).send({ success: false, error: `Provider '${id}' is not defined in opencode.jsonc` });
      }
      if (body.id in defs) {
        return reply.status(409).send({ success: false, error: `Model '${body.id}' already exists — use PATCH to modify it` });
      }
      const result = upsertProviderModel(id, String(body.id), bodyToModelDef(body));
      if (!result.success) return reply.status(400).send(result);
      return { status: 'ok', success: true, model: body.id };
    },

    /** Modify one model (partial merge over the existing definition). */
    modelUpdate: async (req: any, reply: any) => {
      const { id, modelId } = req.params as { id: string; modelId: string };
      const body = req.body as any;
      const { getProviderModelDefs, upsertProviderModel, removeProviderModel } = await import('../opencode/user-config.js');
      const defs = getProviderModelDefs(id);
      if (defs === undefined) {
        return reply.status(404).send({ success: false, error: `Provider '${id}' is not defined in opencode.jsonc` });
      }
      if (!(modelId in defs)) {
        return reply.status(404).send({ success: false, error: `Model '${modelId}' is not defined for provider '${id}'` });
      }
      // rename support: newId moves the definition to a new key (write new → remove old)
      const targetId = body?.newId ? String(body.newId) : modelId;
      const existing = defs[modelId] && typeof defs[modelId] === 'object' ? defs[modelId] : {};
      const patch = bodyToModelDef(body);
      const merged: Record<string, any> = { ...existing, ...patch };
      // limit/cost: partial merge (the form sends them only when edited)
      if (patch.limit || existing.limit) merged.limit = { ...(existing.limit || {}), ...(patch.limit || {}) };
      // cost: a payload carrying a `cost` key replaces it wholesale (the editor
      // form always sends the full object, so blank fields clear stored prices);
      // a payload without `cost` keeps the old values. Empty `{}` clears.
      if (body?.cost && typeof body.cost === 'object') {
        const c: Record<string, number> = {};
        for (const k of ['input', 'output', 'cache_read', 'cache_write'] as const) {
          const v = (body.cost as any)[k];
          if (typeof v === 'number' && Number.isFinite(v)) c[k] = v;
        }
        if (Object.keys(c).length > 0) merged.cost = c;
        else delete merged.cost; // blank form → drop the key instead of writing `cost: {}`
      }
      // v2 composite fields (capabilities/settings/headers/body/compatibility/
      // variants): the form is a full-definition editor — values present in the
      // payload (even {}) replace wholesale; absent keys keep their old values.
      const result = upsertProviderModel(id, targetId, merged);
      if (!result.success) return reply.status(400).send(result);
      if (targetId !== modelId) {
        const rm = removeProviderModel(id, modelId);
        if (!rm.success) {
          return reply.status(400).send({
            success: false,
            error: `Renamed to '${targetId}' but failed to remove the old entry '${modelId}': ${rm.error}`,
          });
        }
      }
      return { status: 'ok', success: true, model: targetId, renamed: targetId !== modelId };
    },

    modelRemove: async (req: any, reply: any) => {
      const { id, modelId } = req.params as { id: string; modelId: string };
      const { removeProviderModel } = await import('../opencode/user-config.js');
      const result = removeProviderModel(id, modelId);
      if (!result.success) return reply.status(404).send(result);
      return { status: 'ok', success: true, model: modelId };
    },

    /**
     * Pull models into the provider's config definition. Data source is chosen
     * automatically: providers with baseURL + credential are pulled LIVE from
     * their own /v1/models (failures surface real errors); providers without a
     * usable baseURL/key fall back to the static catalog (builtin → extensions).
     */
    modelsPull: async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const body = req.body as { pattern?: string; dryRun?: boolean } | undefined;
      const { getProviderNodeById, expandEnvTemplate, readAuthEntries } = await import('../opencode/user-config.js');
      if (!getProviderNodeById(id)) {
        return reply.status(404).send({
          success: false,
          error: `Provider '${id}' is not defined in opencode.jsonc — create it as a custom provider first`,
        });
      }
      const def = getProviderNodeById(id);
      const inlineKey = expandEnvTemplate(def?.options?.apiKey);
      const liveCapable = Boolean(def?.options?.baseURL && (inlineKey || readAuthEntries()[id]?.key));
      if (liveCapable) {
        return livePullModels(id, body || {}, reply);
      }
      const { getProviderModelDefs, upsertProviderModel, matchesGlobPattern } = await import(
        '../opencode/user-config.js'
      );
      const { catalogRepository } = await import('../opencode/catalog/repository.js');
      const provider = await catalogRepository.getProvider(id);
      if (!provider) {
        return reply.status(404).send({ success: false, error: `Provider '${id}' not found in the model catalog` });
      }
      const existing = getProviderModelDefs(id) || {};
      const pattern = body?.pattern?.trim();
      const matched = provider.models.filter((m) => !pattern || matchesGlobPattern(pattern, m.id));
      const pullable = matched.filter((m) => !(m.id in existing)); // never overwrite maintained defs
      // self-hosted gateways are absent from the static catalog — say so instead of a silent 0
      const notInCatalog = provider.sources.every((s) => s === 'config');
      const hint = notInCatalog && matched.length === 0 ? 'not-in-catalog' : undefined;
      if (body?.dryRun) {
        return { status: 'ok', matched: matched.length, pullable: pullable.length, models: pullable, hint };
      }
      let pulled = 0;
      for (const m of pullable) {
        const result = upsertProviderModel(id, m.id, catalogModelToDef(m));
        if (!result.success) return reply.status(400).send(result);
        pulled++;
      }
      return {
        status: 'ok',
        success: true,
        matched: matched.length,
        pullable: pullable.length,
        pulled,
        skipped: matched.length - pullable.length,
        models: pullable.map((m) => m.id),
        hint,
      };
    },

    /** Clear models — whole node without a pattern, matching ids only with one. */
    modelsClear: async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const body = req.body as { pattern?: string } | undefined;
      const { clearProviderModels } = await import('../opencode/user-config.js');
      const result = clearProviderModels(id, body?.pattern);
      if (!result.success) return reply.status(404).send(result);
      return { status: 'ok', ...result };
    },
  };

  for (const prefix of ['/api/ui', '/api/console']) {
    app.get(`${prefix}/opencode/providers`, ocHandlers.list);
    app.get(`${prefix}/opencode/catalog`, ocHandlers.catalog);
    app.get(`${prefix}/opencode/models`, ocHandlers.models);
    app.post(`${prefix}/opencode/providers`, ocHandlers.create);
    app.patch(`${prefix}/opencode/providers/:id`, ocHandlers.update);
    app.post(`${prefix}/opencode/providers/:id/connect`, ocHandlers.connect);
    app.post(`${prefix}/opencode/providers/:id/key`, ocHandlers.setKey);
    app.post(`${prefix}/opencode/providers/:id/test`, ocHandlers.test);
    app.delete(`${prefix}/opencode/providers/:id`, ocHandlers.remove);

    // Per-provider model maintenance (config-defined providers only)
    app.get(`${prefix}/opencode/providers/:id/models`, ocHandlers.modelsGet);
    app.post(`${prefix}/opencode/providers/:id/models`, ocHandlers.modelAdd);
    app.patch(`${prefix}/opencode/providers/:id/models/:modelId`, ocHandlers.modelUpdate);
    app.delete(`${prefix}/opencode/providers/:id/models/:modelId`, ocHandlers.modelRemove);
    app.post(`${prefix}/opencode/providers/:id/models/pull`, ocHandlers.modelsPull);
    app.post(`${prefix}/opencode/providers/:id/models/clear`, ocHandlers.modelsClear);
  }

  // 8b. Catalog logo proxy — remote provider logos served from the local disk
  //     cache (backend/src/opencode/catalog/logos.ts) so page loads don't break
  //     icons when models.dev / openrouter.ai are unreachable.
  const handleCatalogLogo = async (req: any, reply: any) => {
    const { getLogoCached } = await import('../opencode/catalog/logos.js');
    const url = (req.query as { url?: string }).url;
    const logo = await getLogoCached(url);
    if (!logo) return reply.status(404).send();
    return reply.header('Cache-Control', 'public, max-age=604800').type(logo.contentType).send(logo.body);
  };
  app.get('/api/ui/catalog/logo', handleCatalogLogo);
  app.get('/api/console/catalog/logo', handleCatalogLogo);

  // 9. Client API Keys Management (for external client access)
  const handleListApiKeys = async () => {
    return { status: 'ok', keys: listApiKeys(false) };
  };
  app.get('/api/ui/api-keys', handleListApiKeys);
  app.get('/api/console/api-keys', handleListApiKeys);

  const handleCreateApiKey = async (req: any, reply: any) => {
    const body = req.body as { name: string; key?: string; role?: 'admin' | 'user'; expiresAt?: string; description?: string };
    if (!body?.name) {
      return reply.status(400).send({ success: false, message: 'API Key name is required' });
    }
    const result = createApiKey(body);
    if (!result.success) return reply.status(400).send(result);
    return result;
  };
  app.post('/api/ui/api-keys', handleCreateApiKey);
  app.post('/api/console/api-keys', handleCreateApiKey);

  const handleUpdateApiKey = async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const body = req.body as { name?: string; enabled?: boolean; expiresAt?: string; description?: string; role?: 'admin' | 'user' };
    const result = updateApiKey(id, body);
    if (!result.success) return reply.status(400).send(result);
    return result;
  };
  app.put('/api/ui/api-keys/:id', handleUpdateApiKey);
  app.put('/api/console/api-keys/:id', handleUpdateApiKey);

  const handleDeleteApiKey = async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const result = deleteApiKey(id);
    if (!result.success) return reply.status(400).send(result);
    return result;
  };
  app.delete('/api/ui/api-keys/:id', handleDeleteApiKey);
  app.delete('/api/console/api-keys/:id', handleDeleteApiKey);

  // 10. Remote restart trigger from UI
  const handleRestart = async () => {
    setTimeout(() => process.exit(0), 500);
    return { status: 'restarting', message: 'Gateway restart signal acknowledged' };
  };
  app.post('/api/ui/restart', handleRestart);
  app.post('/api/console/restart', handleRestart);

  // 11. Process-log tail viewer — reads ~/.opencode-router/ocr.log (only
  //     written when the gateway runs under `ocr start`; a manual `bun
  //     backend/src/index.ts` writes to its own console instead).
  //     Reads at most 1 MiB from the tail so huge files never blow up memory.
  const handleGetLogs = async (req: any) => {
    const { getLogFilePath } = await import('../cli/paths.js');
    const query = req.query as { tail?: string; level?: string; q?: string };
    const tail = Math.min(Math.max(parseInt(query.tail || '500', 10) || 500, 1), 5000);
    const minLevel = parseLogLevelParam(query.level);
    const needle = (query.q || '').toLowerCase();

    const file = getLogFilePath();
    if (!fs.existsSync(file)) {
      return { status: 'ok', file, exists: false, size: 0, mtimeMs: 0, lines: [] };
    }

    const stat = fs.statSync(file);
    const readSize = Math.min(stat.size, 1024 * 1024);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
      const text = buf.toString('utf8');
      const allLines = text.split(/\r?\n/);
      // Drop the first (likely partial) line when we sliced mid-line.
      if (readSize < stat.size && allLines.length > 0) allLines.shift();

      const parsed: ParsedLogLine[] = [];
      for (const raw of allLines) {
        if (!raw.trim()) continue;
        const entry = parseLogLine(raw);
        // Level filter only applies to parsed pino lines; banner text is
        // always kept so startup output never silently disappears.
        if (minLevel > 0 && entry.levelNum !== undefined && entry.levelNum < minLevel) continue;
        if (needle && !raw.toLowerCase().includes(needle)) continue;
        parsed.push(entry);
      }
      const lines = parsed.slice(-tail);
      return { status: 'ok', file, exists: true, size: stat.size, mtimeMs: stat.mtimeMs, lines };
    } finally {
      fs.closeSync(fd);
    }
  };
  app.get('/api/ui/logs', handleGetLogs);
  app.get('/api/console/logs', handleGetLogs);
}

// Backwards compatibility export
export const registerUiRoutes = registerConsoleRoutes;
