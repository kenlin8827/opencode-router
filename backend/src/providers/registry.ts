import { LLMProvider, type UpstreamEventContext } from './base.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { AnthropicProvider } from './anthropic.js';
import { ResponsesProvider } from './responses.js';
import { GoogleProvider } from './google.js';
import { ModelRegistration, ProviderConfig, RouterConfig, TiersConfig, ComboConfig, ComboModelRef } from '../config/types.js';
import { PoolMembership, TierLevel } from '../types/router.js';
import { ChatCompletionRequest, ChatCompletionResponse } from '../types/openai.js';
import { CircuitBreakerManager, UpstreamError } from '../resilience/index.js';
import { globMatch, globMatchAny } from '../utils/glob.js';
import { loadConfig } from '../config/index.js';
import { resolveTierMatch, classifyTier, type ResolvedTierMatch } from './tier-match.js';
import { readOverridesStore, type OverrideEntry } from '../opencode/catalog/overrides-store.js';

export class ProviderRegistry {
  private providers = new Map<string, LLMProvider>();
  private models = new Map<string, ModelRegistration>();
  private tierDefaults = new Map<TierLevel, ModelRegistration>();
  private circuitBreakerManager: CircuitBreakerManager;
  private tierPolicies: TiersConfig;
  private rrCursor = new Map<TierLevel, number>();
  private combos = new Map<string, ComboConfig>();
  private comboRrCursor = new Map<string, number>();
  private mockMode = false;
  private autoRefreshTierMatch = true;
  private lastMatchRefreshAt = 0;

  constructor(config: RouterConfig, mockMode = false) {
    this.mockMode = mockMode;
    this.tierPolicies = config.tiers || {};
    this.circuitBreakerManager = new CircuitBreakerManager(config.circuitBreaker);

    // Initialize providers
    for (const pConfig of config.providers || []) {
      if (pConfig.type === 'anthropic') {
        this.providers.set(pConfig.name, new AnthropicProvider(pConfig));
      } else if (pConfig.type === 'responses') {
        this.providers.set(pConfig.name, new ResponsesProvider(pConfig));
      } else if (pConfig.type === 'google') {
        this.providers.set(pConfig.name, new GoogleProvider(pConfig));
      } else {
        this.providers.set(pConfig.name, new OpenAICompatibleProvider(pConfig));
      }
    }

    // Initialize models
    for (const mConfig of config.models || []) {
      this.registerModel(mConfig, mConfig.isDefaultInTier);
    }

    // Initialize custom model combos (after models so member resolution at
    // request time can find them; membership itself is resolved lazily)
    this.applyCombos(config.combos);

    // In mock testing mode, if no models provided, populate mock tier models
    if (this.mockMode && this.models.size === 0) {
      const mockT1: ModelRegistration = {
        id: 'mock-fast',
        provider: 'mock',
        upstreamModel: 'mock-fast',
        tier: 'fast',
        isDefaultInTier: true,
        pricing: { input: 0.2, cacheRead: 0.05, output: 0.8 },
      };
      const mockT2: ModelRegistration = {
        id: 'mock-flagship',
        provider: 'mock',
        upstreamModel: 'mock-flagship',
        tier: 'flagship',
        isDefaultInTier: true,
        pricing: { input: 3.0, cacheRead: 0.75, output: 12.0 },
      };
      const mockT3: ModelRegistration = {
        id: 'mock-reasoning',
        provider: 'mock',
        upstreamModel: 'mock-reasoning',
        tier: 'reasoning',
        isDefaultInTier: true,
        pricing: { input: 15.0, cacheRead: 3.75, output: 60.0 },
      };
      this.registerModel(mockT1, true);
      this.registerModel(mockT2, true);
      this.registerModel(mockT3, true);
    }
  }

  public registerProvider(name: string, provider: LLMProvider): void {
    this.providers.set(name, provider);
  }

  public registerModel(model: ModelRegistration, isDefault = false): void {
    if (this.combos.has(model.id)) {
      console.warn(`[Registry] Model id '${model.id}' shadows an existing combo id — the combo became unreachable.`);
    }
    this.models.set(model.id, model);
    this.circuitBreakerManager.registerModel(model);
    // ADR-0012: an UNCLAIMED model must never become a tier's representative —
    // it joins no pool, so promoting it would hand routing a model the pools
    // themselves filter out. Explicit `isDefault` pinning stays authoritative.
    if (model.unclassified && !isDefault) return;
    if (isDefault || !this.tierDefaults.has(model.tier)) {
      this.tierDefaults.set(model.tier, model);
    }
  }

  public getCircuitBreakerManager(): CircuitBreakerManager {
    return this.circuitBreakerManager;
  }

  public setDefaultTierModel(tier: TierLevel, model: ModelRegistration): void {
    this.models.set(model.id, model);
    this.tierDefaults.set(tier, model);
    this.circuitBreakerManager.registerModel(model);
  }

  public getModel(modelId: string): ModelRegistration | undefined {
    return this.models.get(modelId);
  }

  /**
   * Why a model is rejected from every pool ('' = allowed). The ONLY pool
   * filter left: the GLOBAL denylist (tiers.exclude) — unconditional, it
   * outranks even an explicit pin (ADR-0012). Per-tier vetoes (match.exclude)
   * and the model-side excludeTiers live inside the classification gate.
   */
  private policyRejectionReason(policies: TiersConfig | undefined, m: ModelRegistration): string {
    const exclude = policies?.exclude;
    if (exclude?.length && globMatchAny(exclude, m.id)) return 'exclude';
    return '';
  }

  /** Hot-path candidate filter — see policyRejectionReason. */
  private applyTierPolicy(policies: TiersConfig | undefined, models: ModelRegistration[]): ModelRegistration[] {
    if (!policies?.exclude?.length) return models;
    return models.filter((m) => !this.policyRejectionReason(policies, m));
  }

  /** Weight of a model inside a tier: first matching weights rule wins, default 1. */
  private weightFor(policies: TiersConfig | undefined, tier: TierLevel, modelId: string): number {
    const rules = policies?.[tier]?.weights;
    for (const rule of rules || []) {
      if (globMatch(rule.pattern, modelId)) return Math.max(1, Number(rule.weight) || 1);
    }
    return 1;
  }

  /** Effective selection strategy: explicit config wins; legacy default keeps weights→weighted. */
  private selectionStrategy(tier: TierLevel): 'priority' | 'weighted' | 'round_robin' {
    const policy = this.tierPolicies?.[tier];
    return policy?.selection ?? (policy?.weights?.length ? 'weighted' : 'priority');
  }

  /** Weighted round-robin: each model occupies `weight` consecutive slots per cycle. */
  private pickRoundRobin(models: ModelRegistration[], tier: TierLevel): ModelRegistration {
    const slots: ModelRegistration[] = [];
    for (const m of models) {
      const w = this.weightFor(this.tierPolicies, tier, m.id);
      for (let i = 0; i < w; i++) slots.push(m);
    }
    if (slots.length === 0) return models[0];
    const prev = this.rrCursor.get(tier) ?? 0;
    this.rrCursor.set(tier, prev + 1);
    return slots[prev % slots.length];
  }

  /**
   * Primary pick inside a tier, driven by the tier's selection strategy:
   * - priority (default): first healthy candidate in chain order; weights break
   *   same-priority ties (see sortForChain)
   * - weighted: weighted random draw over the healthy pool
   * - round_robin: rotating weighted slots for even distribution over time
   * The failover chain order is strategy-independent (sortForChain); when no
   * selection is configured the legacy default (weights → weighted) applies.
   */
  private pickPrimary(models: ModelRegistration[], tier: TierLevel): ModelRegistration {
    if (models.length <= 1) return models[0];
    const strategy = this.selectionStrategy(tier);
    if (strategy === 'round_robin') return this.pickRoundRobin(models, tier);
    if (strategy === 'weighted') {
      const weights = models.map((m) => this.weightFor(this.tierPolicies, tier, m.id));
      const total = weights.reduce((a, b) => a + b, 0);
      let r = Math.random() * total;
      for (let i = 0; i < models.length; i++) {
        r -= weights[i];
        if (r < 0) return models[i];
      }
      return models[models.length - 1];
    }
    return models[0];
  }

  /**
   * Chain order: when the tier has weights configured, weight descending IS the
   * primary order (ties → priority asc → insertion); without weights the order
   * stays priority ascending (isDefault 0 / default 10) — fully backward compatible.
   */
  private sortForChain(models: ModelRegistration[], tier: TierLevel, policies: TiersConfig | undefined): ModelRegistration[] {
    const hasWeights = (policies?.[tier]?.weights?.length || 0) > 0;
    const prio = (m: ModelRegistration) => (m.isDefaultInTier ? 0 : m.priority ?? 10);
    return [...models].sort((a, b) =>
      hasWeights
        ? this.weightFor(policies, tier, b.id) - this.weightFor(policies, tier, a.id) || prio(a) - prio(b)
        : prio(a) - prio(b)
    );
  }

  /**
   * Runtime tier reclassification — tier membership is pure file-derived data
   * (config `tiers[t].match` + catalog overrides.json), so it is replayed
   * against the captured per-model inputs on pool resolution instead of
   * waiting for a gateway restart. Model UNIVERSE (providers/credentials/wire)
   * stays a boot snapshot.
   */

  /** Hot-path guard: replay match + refresh policies at most every 2 seconds. */
  private maybeRefreshTierMatch(): void {
    if (!this.autoRefreshTierMatch) return;
    const now = Date.now();
    if (now - this.lastMatchRefreshAt < 2000) return;
    this.lastMatchRefreshAt = now;
    try {
      const tiers = loadConfig().tiers || {};
      this.tierPolicies = tiers; // exclude/weights live too
      this.reclassifyTiers(resolveTierMatch(tiers));
    } catch {
      // transient config/IO error — keep the current classification
    }
  }

  /** Latest committed `tiers` config (snapshot; updated by applyTierConfigNow / maybeRefreshTierMatch). */
  public getTierPolicies(): TiersConfig {
    return this.tierPolicies;
  }

  /** Test hook: silence the lazy config re-read (explicit reclassifyTiers still works). */
  public setAutoRefreshTierMatch(on: boolean): void {
    this.autoRefreshTierMatch = on;
  }

  /**
   * PURE projection of one model's pool membership (never mutates): live
   * precedence is catalog override (overrides.json, read fresh) > configTier
   * (opencode.jsonc def) > smart match. Returns undefined for hand-configured
   * models (no captured tierMatch) — their explicit tier is permanent.
   * ADR-0012: the chain can now yield `'unclassified'` (no residual tier), and
   * the model-side `excludeTiers` veto feeds the classification gate.
   */
  private projectedTier(m: ModelRegistration, match: ResolvedTierMatch, store: Record<string, OverrideEntry>): PoolMembership | undefined {
    if (!m.tierMatch) return undefined;
    const mid = m.id.startsWith(m.provider + '/') ? m.id.slice(m.provider.length + 1) : m.id;
    const ov = store[`${m.provider}||${mid}`];
    const explicit = ov?.tier === 'fast' || ov?.tier === 'flagship' || ov?.tier === 'reasoning' ? ov.tier : undefined;
    return (
      explicit ??
      m.configTier ??
      classifyTier({ modelId: mid, inputPerM: m.tierMatch.rawInputPerM, reasoningFlag: m.tierMatch.reasoningFlag }, match)
    );
  }

  /**
   * COMMIT path — the only one that rewrites live pool membership. Called on
   * every config-save event (console routes) so edits take effect immediately;
   * the lazy maybeRefreshTierMatch replay remains only as the out-of-band
   * (hand-edited YAML/overrides.json) safety net.
   */
  public applyTierConfigNow(): void {
    if (this.mockMode) return;
    const tiers = loadConfig().tiers || {};
    this.tierPolicies = tiers;
    this.lastMatchRefreshAt = Date.now(); // the file was just read — skip the TTL replay
    this.reclassifyTiers(resolveTierMatch(tiers));
  }

  /** Replays the match config over every reclassifiable model. ADR-0012 makes
   * the ordering explicit: 1) settle ALL memberships, 2) only then pick each
   * tier's representative (先定成员，再选代表) — representatives must never be
   * chosen from unclassified models. */
  public reclassifyTiers(match: ResolvedTierMatch, overrides?: Record<string, OverrideEntry>): void {
    if (this.mockMode) return;
    const store = overrides ?? readOverridesStore()?.models ?? {};
    for (const m of this.models.values()) {
      const eff = this.projectedTier(m, match, store);
      if (eff === undefined) continue; // hand-configured: never moved
      if (eff === 'unclassified') m.unclassified = true;
      else {
        m.unclassified = false;
        if (m.tier !== eff) m.tier = eff;
      }
    }
    const live = Array.from(this.models.values());
    for (const tier of ['fast', 'flagship', 'reasoning'] as TierLevel[]) {
      const cur = this.tierDefaults.get(tier);
      if (cur && (cur.tier !== tier || cur.unclassified)) {
        const rep =
          live.find((x) => x.tier === tier && !x.unclassified && x.isDefaultInTier) ??
          live.find((x) => x.tier === tier && !x.unclassified);
        if (rep) this.tierDefaults.set(tier, rep);
        else this.tierDefaults.delete(tier);
      }
    }
  }

  /**
   * Returns all candidate models registered for a given tier, sorted by priority.
   * If healthyOnly is true, only returns models where circuit breaker allows execution.
   * The global denylist (tiers.exclude) is applied first; ADR-0012 models that
   * no condition claimed (`unclassified`) join no pool either. Tier MEMBERSHIP
   * is replayed live from the latest match config (see reclassifyTiers).
   */
  public getCandidateModelsForTier(tier: TierLevel, healthyOnly = true): ModelRegistration[] {
    this.maybeRefreshTierMatch();
    let list = this.applyTierPolicy(
      this.tierPolicies,
      Array.from(this.models.values()).filter((m) => m.tier === tier && !m.unclassified),
    );
    list = this.sortForChain(list, tier, this.tierPolicies);

    if (healthyOnly) {
      return list.filter(m => this.circuitBreakerManager.isAvailable(m.id));
    }
    return list;
  }

  public getModelForTier(tier: TierLevel, healthyOnly = true): ModelRegistration {
    const candidates = this.getCandidateModelsForTier(tier, healthyOnly);
    if (candidates.length > 0) {
      return this.pickPrimary(candidates, tier);
    }
    // If healthyOnly was true and no healthy models found, fallback to any model in tier
    if (healthyOnly) {
      const anyCandidate = this.getCandidateModelsForTier(tier, false);
      if (anyCandidate.length > 0) {
        return this.pickPrimary(anyCandidate, tier);
      }
    }
    // ADR-0012: the requested tier is EMPTY (a real possibility now that there
    // is no residual catch-all). Degradation is still possible — routing must
    // not hard-fail on a config the user can legitimately write — but it is
    // NEVER silent: the cross-tier step is logged with the reason.
    const escalate = (this.tierPolicies ? loadConfig().fallback?.escalateTier : undefined) ?? 'flagship';
    const order: TierLevel[] = [escalate, 'flagship', 'fast', 'reasoning'];
    const chain = order.filter((t, i, all) => t !== tier && all.indexOf(t) === i);
    for (const step of chain) {
      const rep = this.tierDefaults.get(step);
      if (rep && !rep.unclassified) {
        console.warn(`[Registry] Tier '${tier}' has no candidate model — falling back to '${step}' (${rep.id}), reason=empty-pool`);
        return rep;
      }
    }
    const any = Array.from(this.models.values()).find((m) => !m.unclassified);
    if (!any) {
      throw new Error(`No routable models registered (every model is unclassified or excluded).`);
    }
    console.warn(`[Registry] Tier '${tier}' has no candidate model — falling back to the first registered model (${any.id}), reason=empty-pool`);
    return any;
  }

  public getAllModels(): ModelRegistration[] {
    return Array.from(this.models.values());
  }

  // ─── Custom model combos ────────────────────────────────────────────────

  /** Virtual model ids that routing already owns — a combo must never shadow them. */
  private static readonly RESERVED_COMBO_IDS = new Set(['auto', 'default', 'auto-fast', 'auto-flagship', 'auto-reasoning']);

  /** (Re)register combo definitions — used at boot and for hot-apply on console config saves. */
  public applyCombos(combos?: ComboConfig[]): void {
    this.combos.clear();
    this.comboRrCursor.clear();
    for (const combo of combos || []) {
      if (!combo?.id || !Array.isArray(combo.models) || combo.models.length === 0) continue;
      if (ProviderRegistry.RESERVED_COMBO_IDS.has(combo.id)) {
        console.warn(`[Registry] Combo id '${combo.id}' is a reserved virtual model name — combo ignored.`);
        continue;
      }
      if (this.models.has(combo.id)) {
        console.warn(`[Registry] Combo id '${combo.id}' collides with a registered model id — combo ignored.`);
        continue;
      }
      this.combos.set(combo.id, combo);
    }
  }

  public isCombo(modelId: string): boolean {
    return this.combos.has(modelId);
  }

  public getCombos(): ComboConfig[] {
    // A model registered AFTER a combo (setDefaultTierModel / console flows)
    // shadows the combo id — exclude those from exposure so /v1/models never
    // lists a duplicate id that cannot route.
    return Array.from(this.combos.values()).filter(c => !this.models.has(c.id));
  }

  /** Normalize a member entry (bare string | {id, weight}) to {id, weight>=1}. */
  private comboMemberRef(entry: string | ComboModelRef): { id: string; weight: number } {
    if (typeof entry === 'string') return { id: entry, weight: 1 };
    return { id: entry.id, weight: Math.max(1, Number(entry.weight) || 1) };
  }

  /**
   * Resolve a combo to its registered member models in config order.
   * Unregistered ids are dropped and duplicates collapse to the first
   * occurrence — resolved per call so late registrations join naturally.
   */
  public resolveCombo(comboId: string): ModelRegistration[] {
    const combo = this.combos.get(comboId);
    if (!combo) return [];
    const seen = new Set<string>();
    const members: ModelRegistration[] = [];
    for (const entry of combo.models) {
      const ref = this.comboMemberRef(entry);
      if (seen.has(ref.id)) continue;
      const model = this.models.get(ref.id);
      if (model) {
        members.push(model);
        seen.add(ref.id);
      }
    }
    return members;
  }

  /**
   * Combo primary pick, mirroring the tier selection strategies:
   * - priority (default): first healthy member in config order
   * - weighted: weight-random draw over the healthy pool
   * - round_robin: rotating weighted slots (combo-scoped cursor)
   * Falls back to the full member list when every member is tripped.
   */
  public pickComboLeader(comboId: string, members: ModelRegistration[]): ModelRegistration {
    if (members.length <= 1) return members[0];
    const strategy = this.combos.get(comboId)?.selection ?? 'priority';
    const healthy = members.filter(m => this.circuitBreakerManager.isAvailable(m.id));
    const pool = healthy.length > 0 ? healthy : members;
    const weights = new Map<string, number>();
    for (const entry of this.combos.get(comboId)?.models || []) {
      const ref = this.comboMemberRef(entry);
      if (!weights.has(ref.id)) weights.set(ref.id, ref.weight);
    }

    if (strategy === 'round_robin') {
      const slots: ModelRegistration[] = [];
      for (const m of pool) {
        const w = weights.get(m.id) ?? 1;
        for (let i = 0; i < w; i++) slots.push(m);
      }
      if (slots.length === 0) return pool[0];
      const prev = this.comboRrCursor.get(comboId) ?? 0;
      this.comboRrCursor.set(comboId, prev + 1);
      return slots[prev % slots.length];
    }

    if (strategy === 'weighted') {
      const ws = pool.map(m => weights.get(m.id) ?? 1);
      const total = ws.reduce((a, b) => a + b, 0);
      let r = Math.random() * total;
      for (let i = 0; i < pool.length; i++) {
        r -= ws[i];
        if (r < 0) return pool[i];
      }
      return pool[pool.length - 1];
    }

    return pool[0];
  }

  /**
   * Introspection for the console: resolve a tier's effective candidate pool
   * (after the composition policy) plus every excluded model with the reason.
   * Pool order follows the runtime chain order; each entry carries its
   * effective selection weight (default 1). `policiesOverride` lets the
   * console preview freshly-saved policies without a gateway restart — runtime
   * callers omit it and get the construction-time snapshot.
   */
  public resolveTierPool(
    tier: PoolMembership,
    policiesOverride?: TiersConfig,
    preview?: { match: ResolvedTierMatch; overrides?: Record<string, OverrideEntry> }
  ): {
    pool: { model: ModelRegistration; weight: number }[];
    excluded: { id: string; reason: string }[];
  } {
    const policies = policiesOverride ?? this.tierPolicies;
    // Ephemeral snapshot: membership PROJECTED from the given match config —
    // a pure function over the captured registration inputs. Never rewrites
    // live pool state (commit only happens via applyTierConfigNow on save).
    const store = preview ? preview.overrides ?? readOverridesStore()?.models ?? {} : undefined;
    const membershipOf = (m: ModelRegistration): PoolMembership =>
      !store ? (m.unclassified ? 'unclassified' : m.tier) : this.projectedTier(m, preview!.match, store) ?? (m.unclassified ? 'unclassified' : m.tier);
    const pool: { model: ModelRegistration; weight: number }[] = [];
    const excluded: { id: string; reason: string }[] = [];
    for (const m of Array.from(this.models.values()).filter((x) => membershipOf(x) === tier)) {
      if (tier === 'unclassified') {
        // ADR-0012 fourth state: nothing claimed it. It is NOT hidden by the
        // denylist — the console must show it so the user can pin it in bulk.
        pool.push({ model: m, weight: 1 });
        continue;
      }
      const reason = this.policyRejectionReason(policies, m);
      if (reason) excluded.push({ id: m.id, reason });
      else pool.push({ model: m, weight: this.weightFor(policies, tier, m.id) });
    }
    const sortedModels =
      tier === 'unclassified'
        ? pool.map((p) => p.model).sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity))
        : this.sortForChain(
            pool.map((p) => p.model),
            tier,
            policies,
          );
    return {
      pool: sortedModels.map((m) => ({ model: m, weight: tier === 'unclassified' ? 1 : this.weightFor(policies, tier, m.id) })),
      excluded,
    };
  }

  public async execute(
    request: ChatCompletionRequest,
    model: ModelRegistration,
    upstreamEventContext?: UpstreamEventContext
  ): Promise<ChatCompletionResponse> {
    if (this.mockMode) {
      return this.mockExecute(request, model);
    }

    const provider = this.providers.get(model.provider);
    if (!provider) {
      throw new Error(`Provider '${model.provider}' not found for model '${model.id}'`);
    }

    return provider.createCompletion(request, model, upstreamEventContext);
  }

  /**
   * High-fidelity mock executor for automated testing & offline demos
   */
  private async mockExecute(
    request: ChatCompletionRequest,
    model: ModelRegistration
  ): Promise<ChatCompletionResponse> {
    const reqAny = request as any;
    if (reqAny.__simulate_error_model__ === model.id || reqAny.__simulate_error_all__) {
      let shouldThrow = true;
      if (typeof reqAny.__simulate_fail_times__ === 'number') {
        if (reqAny.__simulate_fail_times__ > 0) {
          reqAny.__simulate_fail_times__--;
          shouldThrow = true;
        } else {
          shouldThrow = false;
        }
      }

      if (shouldThrow) {
        const status = reqAny.__simulate_status__ || 503;
        const errorMsg = reqAny.__simulate_message__ || `Simulated error for model ${model.id} (Status ${status})`;
        throw new UpstreamError({
          message: errorMsg,
          status,
          errorBody: JSON.stringify({ error: { message: errorMsg, code: reqAny.__simulate_code__ } }),
          provider: model.provider,
          modelId: model.id,
          retryAfterSeconds: reqAny.__simulate_retry_after__,
        });
      }
    }

    const isJsonRequested =
      request.response_format?.type === 'json_object' ||
      request.response_format?.type === 'json_schema' ||
      /json/i.test(JSON.stringify(request.messages));

    let content = 'This is a standard mock response from ' + model.id;

    if (isJsonRequested) {
      // Simulate fast tier occasionally returning slightly malformed JSON or valid JSON
      if (model.tier === 'fast' && (request as any).__simulate_malformed__) {
        content = '{ "name": "sample", "invalid_json_trailing": ';
      } else {
        content = JSON.stringify({
          status: 'success',
          tier: model.tier,
          model: model.id,
          data: {
            title: 'Mock Structured Output',
            category: 'test',
          },
        });
      }
    }

    return {
      id: `mock-chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model.id,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content,
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 150,
        completion_tokens: 80,
        total_tokens: 230,
        prompt_tokens_details: {
          cached_tokens: 50,
        },
      },
    };
  }
}
