import { ModelRegistration, ProviderConfig } from '../config/types.js';
import { TierLevel } from '../types/router.js';
import { loadConfig } from '../config/index.js';
import { resolveTierMatch, classifyTier } from './tier-match.js';
import { catalogRepository } from '../opencode/catalog/repository.js';
import {
  getProviderNodeById,
  getProviderModelDefs,
  expandEnvTemplate,
  readAuthEntries,
} from '../opencode/user-config.js';
import { WireKind, wireFor, unroutableReason, baseForWire } from './wire.js';

/**
 * ADR-0011: build the direct execution pool WITHOUT the opencode daemon.
 * Truth sources are files only:
 *   - opencode.jsonc provider nodes (baseURL/headers/npm/model defs)   [user-config.ts]
 *   - auth.json credentials                                            [user-config.ts]
 *   - models.dev catalog (pricing/capabilities/provider+model npm)     [catalogRepository]
 * Wire per model = wireFor(model npm > config npm > provider npm, base hint).
 * OAuth providers are excluded explicitly (P2 owns their refresh lifecycle).
 */

export interface DirectBootResult {
  /** logical provider name → resolved wire set (one DispatchingProvider per entry) */
  instances: { name: string; config: ProviderConfig; wires: WireKind[]; wireBases: Partial<Record<WireKind, string>> }[];
  models: ModelRegistration[];
  excluded: { provider: string; model?: string; reason: string }[];
}

export async function buildDirectPool(): Promise<DirectBootResult> {
  const catalog = await catalogRepository.list();
  // Boot-time smart match (config `tiers[t].match` over the built-in
  // baseline). Restart required — same semantics as the composition policy.
  const tierMatch = resolveTierMatch(loadConfig().tiers);
  const authEntries = readAuthEntries();
  const instances: DirectBootResult['instances'] = [];
  const models: ModelRegistration[] = [];
  const excluded: DirectBootResult['excluded'] = [];

  for (const rec of catalog) {
    const def = getProviderNodeById(rec.id);
    const auth = authEntries[rec.id];

    const apiKey = expandEnvTemplate(def?.options?.apiKey) || auth?.key || auth?.access;
    if (!apiKey) {
      // catalog-universe providers without credentials are structural noise —
      // only surface when the user actually defined a config node for them.
      if (def) excluded.push({ provider: rec.id, reason: '无凭证（auth.json/内联均缺失）' });
      continue;
    }
    if (auth?.type === 'oauth') {
      excluded.push({ provider: rec.id, reason: 'OAuth 凭证（ADR-0011 P2：网关自持刷新前显式排除）' });
      continue;
    }
    // models.dev `api` (canonical) beats the daemon's runtime hint; per-wire
    // mounts can differ (e.g. Zen exposes chat+responses under /zen/v1 while
    // the daemon's effective base is a newer inference mount), and the hint
    // may be stale project-scoped state.
    const baseURL = expandEnvTemplate(def?.options?.baseURL) || rec.api || rec.baseURL;
    if (!baseURL) {
      excluded.push({ provider: rec.id, reason: '无法确定 baseURL（无 config 定义且目录无默认 api）' });
      continue;
    }

    const defs = getProviderModelDefs(rec.id) || {};
    const catById = new Map(rec.models.map((m) => [m.id, m]));
    const defIds = Object.keys(defs).filter((k) => (defs as any)[k]?.disabled !== true);
    // config definitions win as the model universe when present (opencode semantics);
    // auth-only providers fall back to the full catalog listing.
    const modelIds = defIds.length > 0 ? defIds : rec.models.map((m) => m.id);
    if (modelIds.length === 0) {
      excluded.push({ provider: rec.id, reason: '目录与配置均无可用模型' });
      continue;
    }

    const wires = new Set<WireKind>();
    const wireBases = new Map<string, string>();
    for (const mid of modelIds) {
      const d = (defs as any)[mid];
      const catModel = catById.get(mid);
      // ADR-0011 P1: the routing pool speaks chat/responses/anthropic only —
      // image/audio/video OUTPUT models (qwen-image, TTS, ASR…) belong to tool
      // extension mechanisms and would answer 400 ModelProtocolUnsupported or
      // garbage on any text wire. Config-defined models without modality data
      // pass through (no evidence they are non-text).
      const outMods = catModel?.modalities?.output;
      if (Array.isArray(outMods) && outMods.length > 0 && !outMods.includes('text')) {
        excluded.push({ provider: rec.id, model: `${rec.id}/${mid}`, reason: `非文本输出模型（modalities.output=${outMods.join('/')}），不入文本路由池` });
        continue;
      }
      const npm = d?.provider?.npm || catModel?.npm || def?.npm || rec.npm;
      const wire = wireFor(npm, baseURL || rec.api);
      if (wire === 'unroutable') {
        excluded.push({ provider: rec.id, model: `${rec.id}/${mid}`, reason: unroutableReason(npm) });
        continue;
      }
      wires.add(wire);
      wireBases.set(wire, baseForWire(wire, baseURL));

      const isReasoning = catModel?.reasoning === true || d?.capabilities?.reasoning === true;
      const inputCost = catModel?.cost?.input ?? (isReasoning ? 10.0 : 2.0);
      const outputCost = catModel?.cost?.output ?? inputCost * 4.0;
      const cacheRead = catModel?.cost?.cache_read ?? inputCost * 0.25;

      // Explicit tier (catalog override / jsonc model def) wins; otherwise the
      // configurable smart match classifies (patterns → reasoning flag → price
      // band on the RAW catalog price → flagship). Free models (input = 0) can
      // hit the fast band; models without catalog pricing simply skip bands.
      const explicitTier = (v: unknown): TierLevel | undefined =>
        v === 'fast' || v === 'flagship' || v === 'reasoning' ? (v as TierLevel) : undefined;
      const tier: TierLevel =
        explicitTier(catModel?.tier) ??
        explicitTier(d?.tier) ??
        classifyTier({ modelId: mid, inputPerM: catModel?.cost?.input, reasoningFlag: isReasoning }, tierMatch);

      models.push({
        id: `${rec.id}/${mid}`,
        provider: rec.id,
        upstreamModel: (d && typeof d === 'object' && d.modelID ? String(d.modelID) : mid),
        tier,
        isDefaultInTier: false,
        supportsReasoningEffort: isReasoning || undefined,
        supportsPromptCaching: wire === 'anthropic' || (catModel?.cost?.cache_read != null ? true : undefined),
        wire,
        pricing: {
          input: inputCost,
          output: outputCost,
          cacheRead,
          ...(catModel?.cost?.cache_write != null ? { cacheWrite: catModel.cost.cache_write } : {}),
        },
      });
    }

    if (wires.size === 0) {
      excluded.push({ provider: rec.id, reason: '该 provider 全部模型不可直连路由' });
      continue;
    }
    instances.push({
      name: rec.id,
      config: {
        name: rec.id,
        type: 'dispatch',
        baseUrl: baseURL,
        apiKey,
        headers: def?.options?.headers,
      },
      wires: [...wires],
      wireBases: Object.fromEntries(wireBases) as Partial<Record<WireKind, string>>,
    });
  }

  // ADR-0002 §3 price-pyramid tier defaults (kept; the daemon is gone, the math stays).
  const external = models.filter((m) => m.provider !== 'opencode');
  const pool = external.length > 0 ? external : models;
  const tFast = pool.filter((m) => m.tier === 'fast').sort((a, b) => (a.pricing.input ?? 0) - (b.pricing.input ?? 0));
  if (tFast.length > 0) tFast[0].isDefaultInTier = true;
  let tFlagship = pool.filter((m) => m.tier === 'flagship').sort((a, b) => (a.pricing.input ?? 0) - (b.pricing.input ?? 0));
  if (tFlagship.length === 0) tFlagship = pool.filter((m) => m.tier !== 'reasoning');
  if (tFlagship.length > 0) tFlagship[Math.floor(tFlagship.length / 2)].isDefaultInTier = true;
  const tReasoning = pool.filter((m) => m.tier === 'reasoning');
  if (tReasoning.length > 0) {
    const top = tReasoning.find((m) => m.supportsReasoningEffort) || tReasoning[0];
    top.isDefaultInTier = true;
  }

  return { instances, models, excluded };
}
