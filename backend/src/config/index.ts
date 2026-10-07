import fs from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import dotenv from 'dotenv';
import { RouterConfig } from './types.js';
import { DEFAULT_RETRIABLE_CAUSES } from '../resilience/types.js';

dotenv.config();

const DEFAULT_CONFIG: RouterConfig = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  adminApiKey: process.env.ROUTER_API_KEY || undefined,
  baselineModel: 'auto',
  tiers: {},
  routing: { mode: 'smart' },
  fallback: {
    enabled: true,
    maxRetries: 1,
    escalateTier: 'flagship',
    injectErrorContext: true,
  },
  budget: {
    defaultReasoningEffort: 'low',
    enforceReasoningEffortOnMediumTasks: true,
    maxCompletionTokensLimit: 16384,
  },
  classifier: {
    localModel: {
      enabled: false,
      confidenceThreshold: 0.85,
    },
    layer2: {
      enabled: false,
      provider: 'typesafe',
      model: 'typesafe/jev',
      timeoutMs: 1500,
    },
  },
  flywheel: {
    enabled: true,
    datasetPath: './data/flywheel.jsonl',
    maxSamples: 100000,
    logUserPrompt: true,
  },
  circuitBreaker: {
    enabled: true,
    failureThreshold: 3,
    slidingWindowSize: 20,
    failureRateThreshold: 0.5,
    initialCooldownMs: 30000,
    maxCooldownMs: 5 * 3600 * 1000, // 5 hours max cooldown
    cooldownMultiplier: 2.0,
    quotaCooldownMs: 12 * 3600 * 1000, // 12 hours for quota/balance exhaustion
    halfOpenMaxProbes: 1,
    activeProbing: {
      enabled: false,
      intervalMs: 60000,
    },
  },
  retry: {
    enabled: true,
    inplace: {
      enabled: true,
      maxAttempts: 1,
      backoffMs: 200,
      jitterMs: 100,
      retryOnCauses: [...DEFAULT_RETRIABLE_CAUSES],
      maxRateLimitWaitMs: 2000,
    },
    failover: {
      enabled: true,
      maxAttempts: 2,
      tierCrossPolicy: 'allow_escalate',
    },
  },
  apiKeys: [],
  providers: [],
  models: [],
};

export function getConfigPath(customPath?: string): string {
  if (customPath) return path.resolve(customPath);

  const cwdPath = path.resolve(process.cwd(), 'config.yaml');
  if (fs.existsSync(cwdPath)) return cwdPath;

  // Fallback: search upward to repository root
  try {
    const currentDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    const repoRootPath = path.resolve(currentDir, '..', '..', 'config.yaml'); // backend/src/config -> backend/src -> backend -> root
    const altRootPath = path.resolve(currentDir, '..', '..', '..', 'config.yaml');
    if (fs.existsSync(repoRootPath)) return repoRootPath;
    if (fs.existsSync(altRootPath)) return altRootPath;
  } catch {}

  return cwdPath;
}

export function loadConfig(configPath?: string): RouterConfig {
  const resolvedPath = getConfigPath(configPath);
  if (fs.existsSync(resolvedPath)) {
    try {
      const raw = fs.readFileSync(resolvedPath, 'utf8');
      const parsed = parse(raw);
      // Legacy `rules:` (removed prompt-override system) is stripped so stale
      // keys don't get re-persisted on the next config save.
      const { rules: _legacyRules, ...parsedRest } = parsed || {};
      return {
        ...DEFAULT_CONFIG,
        ...parsedRest,
        apiKeys: parsed?.apiKeys || DEFAULT_CONFIG.apiKeys,
        tiers: parsed?.tiers || {},
        routing: { ...DEFAULT_CONFIG.routing, ...parsed?.routing },
        fallback: { ...DEFAULT_CONFIG.fallback, ...parsed?.fallback },
        budget: { ...DEFAULT_CONFIG.budget, ...parsed?.budget },
        classifier: {
          localModel: { ...DEFAULT_CONFIG.classifier?.localModel, ...parsed?.classifier?.localModel },
          layer2: { ...DEFAULT_CONFIG.classifier?.layer2, ...parsed?.classifier?.layer2 },
        },
        flywheel: { ...DEFAULT_CONFIG.flywheel, ...parsed?.flywheel },
        circuitBreaker: { ...DEFAULT_CONFIG.circuitBreaker, ...parsed?.circuitBreaker },
        retry: {
          enabled: parsed?.retry?.enabled ?? DEFAULT_CONFIG.retry?.enabled,
          inplace: { ...DEFAULT_CONFIG.retry?.inplace, ...parsed?.retry?.inplace },
          failover: { ...DEFAULT_CONFIG.retry?.failover, ...parsed?.retry?.failover },
        },
        providers: parsed?.providers || DEFAULT_CONFIG.providers,
        models: parsed?.models || DEFAULT_CONFIG.models,
        catalog: parsed?.catalog,
      };
    } catch (err) {
      console.warn(`[Config] Failed to parse ${resolvedPath}, falling back to defaults:`, err);
    }
  }
  return DEFAULT_CONFIG;
}

export function getRawConfig(): string {
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    return fs.readFileSync(configPath, 'utf8');
  }
  return '';
}

export function saveRawConfig(yamlContent: string): { success: boolean; error?: string } {
  const configPath = getConfigPath();
  try {
    const parsed = parse(yamlContent);
    if (!parsed || typeof parsed !== 'object') {
      return { success: false, error: 'YAML must define an object configuration' };
    }
    fs.writeFileSync(configPath, yamlContent, 'utf8');
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export function saveConfig(newConfig: Partial<RouterConfig>): { success: boolean; error?: string } {
  const configPath = getConfigPath();
  try {
    const current = loadConfig();
    const merged = { ...current, ...newConfig };
    const yamlContent = stringify(merged);
    fs.writeFileSync(configPath, yamlContent, 'utf8');
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
