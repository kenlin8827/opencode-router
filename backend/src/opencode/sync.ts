import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ModelRegistration } from '../config/types.js';
import { PoolMembership, TierLevel } from '../types/router.js';
import { loadConfig } from '../config/index.js';
import { resolveTierMatch, classifyTier } from '../providers/tier-match.js';
import { readOverridesStore } from './catalog/overrides-store.js';

export interface OpenCodeServiceConfig {
  baseUrl: string;
  authHeader: string;
  password?: string;
}

export class OpenCodeConnector {
  private serviceConfig: OpenCodeServiceConfig | null = null;

  constructor(customUrl?: string, customPassword?: string) {
    this.serviceConfig = this.resolveServiceConfig(customUrl, customPassword);
  }

  /**
   * Auto-discover OpenCode v2 background service from ~/.config/opencode/service.json
   */
  public resolveServiceConfig(customUrl?: string, customPassword?: string): OpenCodeServiceConfig | null {
    const baseUrl = customUrl || process.env.OPENCODE_SERVER_URL || 'http://127.0.0.1:49374';
    let password = customPassword || process.env.OPENCODE_SERVER_PASSWORD;

    if (!password) {
      const configPaths = [
        path.join(os.homedir(), '.config', 'opencode', 'service.json'),
        path.join(os.homedir(), '.opencode', 'service.json'),
      ];

      for (const p of configPaths) {
        if (fs.existsSync(p)) {
          try {
            const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (raw.password) {
              password = raw.password;
              break;
            }
          } catch {
            // Ignore parse errors
          }
        }
      }
    }

    if (!password) {
      return null;
    }

    const authHeader = 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64');
    return {
      baseUrl,
      authHeader,
      password,
    };
  }

  public isAvailable(): boolean {
    return this.serviceConfig !== null;
  }

  public getServiceConfig(): OpenCodeServiceConfig | null {
    return this.serviceConfig;
  }

  /**
   * Fetch active providers from OpenCode v2
   */
  public async getProviders(): Promise<any[]> {
    if (!this.serviceConfig) throw new Error('OpenCode v2 service credentials not found');
    const res = await fetch(`${this.serviceConfig.baseUrl}/api/provider`, {
      headers: { Authorization: this.serviceConfig.authHeader },
    });
    if (!res.ok) throw new Error(`OpenCode provider fetch failed [${res.status}]`);
    const json = (await res.json()) as any;
    return json.data || [];
  }

  /**
   * Fetch active models and pricing from OpenCode v2
   */
  public async getModels(): Promise<any[]> {
    if (!this.serviceConfig) throw new Error('OpenCode v2 service credentials not found');
    const res = await fetch(`${this.serviceConfig.baseUrl}/api/model`, {
      headers: { Authorization: this.serviceConfig.authHeader },
    });
    if (!res.ok) throw new Error(`OpenCode model fetch failed [${res.status}]`);
    const json = (await res.json()) as any;
    return json.data || [];
  }

  /**
   * Automatically categorize OpenCode models into FinOps lite, plus, pro, and ultra tiers
   * completely dynamically based on pricing and capabilities (Zero Hardcoding!)
   */
  public async syncToTierModels(): Promise<ModelRegistration[]> {
    const rawModels = await this.getModels();
    const registered: ModelRegistration[] = [];
    // Shared smart match — same config & precedence as the direct boot pool
    // (providers/tier-match.ts); this path must not drift its own heuristic.
    const tierMatch = resolveTierMatch(loadConfig().tiers);

    for (const m of rawModels) {
      if (m.status !== 'active') continue;

      const modelId = `${m.providerID}/${m.id}`;

      // 1. Detect thinking-effort capability dynamically from variants and metadata
      const isReasoning =
        m.capabilities?.reasoning === true ||
        m.variants?.some((v: any) => v.settings?.thinking || v.settings?.effort);
      // 1b. Per-level effort override: if an operator has stored a finer
      // truth in the overrides store, use that. Absent = catalog default
      // (all 4 non-default levels, when the model is thinking-capable).
      // Narrow the untyped JSON values to the typed vocabulary; silently drop
      // anything that doesn't match a known level (catastrophic input
      // hygiene, but the catalog store is operator-controlled).
      const rawOverride = readOverridesStore()?.models[`${m.providerID}||${m.id}`]?.reasoningEfforts;
      const allowedEfforts = new Set(['none', 'low', 'medium', 'high', 'xhigh']);
      const effortOverride = Array.isArray(rawOverride)
        ? (rawOverride.filter((v) => typeof v === 'string' && allowedEfforts.has(v)) as
          | Array<'none' | 'low' | 'medium' | 'high' | 'xhigh'>
          | undefined)
        : undefined;

      // 2. Extract pricing (OpenCode cost array is per 1M tokens)
      const inputCost = m.cost?.[0]?.input ?? (isReasoning ? 10.0 : 2.0);
      const outputCost = m.cost?.[0]?.output ?? inputCost * 4.0;
      const cachedCost = m.cost?.[0]?.cache?.read ?? inputCost * 0.25;

      // 3. Tiering via the shared classifyTier (patterns > price band >
      // thinking-effort flag) — missing price skips bands, and since ADR-0012 nothing
      // claims the model → it stays UNCLASSIFIED (no residual tier).
      const membership: PoolMembership = classifyTier(
        { modelId: m.id, inputPerM: m.cost?.[0]?.input, reasoningFlag: isReasoning },
        tierMatch,
      );
      const unclassified = membership === 'unclassified';
      const tier: TierLevel = unclassified ? 'plus' : membership;

      registered.push({
        id: modelId,
        provider: m.providerID,
        upstreamModel: m.modelID || m.id,
        tier,
        isDefaultInTier: false, // will be dynamically assigned below
        // Per-level effort support: catalog sources today only declare a
        // boolean "thinking-effort" capability, so we treat any thinking-capable
        // model as supporting all 4 non-default levels by default. Operators
        // who need finer truth (e.g. "gpt-5.1 has no xhigh") override via
        // the catalog overrides-store `reasoningEfforts` field, read in
        // step 1b above and applied here.
        supportedReasoningEfforts: isReasoning
          ? effortOverride ?? (['low', 'medium', 'high', 'xhigh'] as const)
          : undefined,
        supportsReasoningEffort: isReasoning || undefined,
        supportsPromptCaching: true,
        tierMatch: { rawInputPerM: m.cost?.[0]?.input, reasoningFlag: isReasoning },
        ...(unclassified ? { unclassified: true } : {}),
        pricing: {
          input: inputCost,
          output: outputCost,
          cacheRead: cachedCost,
          ...(m.cost?.[0]?.cache?.write !== undefined ? { cacheWrite: m.cost[0].cache.write } : {}),
        },
      });
    }

    // -----------------------------------------------------------------
    // 4. Dynamic Default Selection (Zero hardcoded model or provider names)
    // -----------------------------------------------------------------
    // Separate external configured plans from local synthetic fallback if
    // available. ADR-0012: UNCLASSIFIED models join no pool, so they can never
    // be picked as a tier representative either (their `tier` is a placeholder).
    const claimable = (m: ModelRegistration) => !m.unclassified;
    const externalPlans = registered.filter(m => m.provider !== 'opencode' && claimable(m));
    const pool = externalPlans.length > 0 ? externalPlans : registered.filter(claimable);

    // Lite Tier Default: lowest input cost model in lite tier
    const tLite = pool.filter(m => m.tier === 'lite').sort((a, b) => a.pricing.input - b.pricing.input);
    if (tLite.length > 0) {
      tLite[0].isDefaultInTier = true;
    }

    // Plus Tier Default: plus model from pool (fallback: any non-pro/non-ultra)
    let tPlus = pool.filter(m => m.tier === 'plus').sort((a, b) => a.pricing.input - b.pricing.input);
    if (tPlus.length === 0) {
      tPlus = pool.filter(m => m.tier !== 'pro' && m.tier !== 'ultra');
    }
    if (tPlus.length > 0) {
      tPlus[Math.floor(tPlus.length / 2)].isDefaultInTier = true;
    }

    // Pro Tier Default: top thinking-effort capability model
    const tPro = pool.filter(m => m.tier === 'pro');
    if (tPro.length > 0) {
      const topPro = tPro.find(m => m.supportsReasoningEffort) || tPro[0];
      topPro.isDefaultInTier = true;
    }

    // Ultra Tier Default: top-priced model in ultra tier (frontier)
    const tUltra = pool.filter(m => m.tier === 'ultra').sort((a, b) => b.pricing.input - a.pricing.input);
    if (tUltra.length > 0) {
      tUltra[0].isDefaultInTier = true;
    }

    return registered;
  }
}
