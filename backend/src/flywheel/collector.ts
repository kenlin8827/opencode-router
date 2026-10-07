import fs from 'node:fs';
import path from 'node:path';
import { RoutingDecision, TierLevel } from '../types/router.js';
import { ChatCompletionRequest } from '../types/openai.js';
import { FlywheelConfig } from '../config/types.js';

export interface FlywheelRecord {
  id: string;
  timestamp: string;
  userPrompt: string;
  tokenCount: number;
  features: {
    hasCode: boolean;
    hasMathOrProof: boolean;
    hasMultiTurn: boolean;
    hasToolsOrSchema: boolean;
    complexityScore: number;
  };
  routing: {
    targetTier: TierLevel;
    confidence: number;
    layerUsed: 'layer0' | 'layer1' | 'layer2';
  };
  execution: {
    tierUsed: TierLevel;
    modelUsed: string;
    fallbackOccurred: boolean;
    fallbackReason?: string;
    costUsd: number;
    latencyMs: number;
  };
  label: {
    groundTruthTier: TierLevel;
    labelSource: 'runtime_fallback' | 'layer2_jev' | 'layer1_confident' | 'layer0_fast';
    isNegativeSampleForFast: boolean;
  };
}

export interface FlywheelStats {
  totalSamples: number;
  tierDistribution: Record<TierLevel, number>;
  layerDistribution: Record<'layer0' | 'layer1' | 'layer2', number>;
  fallbackCount: number;
  negativeSampleCount: number;
}

export class FlywheelCollector {
  private config: FlywheelConfig;
  private datasetPath: string;
  private memoryStats: FlywheelStats = {
    totalSamples: 0,
    tierDistribution: { fast: 0, flagship: 0, reasoning: 0 },
    layerDistribution: { layer0: 0, layer1: 0, layer2: 0 },
    fallbackCount: 0,
    negativeSampleCount: 0,
  };

  constructor(config?: FlywheelConfig) {
    this.config = config || { enabled: true, datasetPath: './data/flywheel.jsonl' };
    this.datasetPath = path.resolve(process.cwd(), this.config.datasetPath || './data/flywheel.jsonl');
    this.ensureDirectory();
  }

  private ensureDirectory(): void {
    if (!this.config.enabled) return;
    const dir = path.dirname(this.datasetPath);
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
        // Ignore mkdir errors
      }
    }
  }

  /**
   * Record a full end-to-end execution turn into the data flywheel pool
   */
  public async record(params: {
    requestId: string;
    request: ChatCompletionRequest;
    decision: RoutingDecision;
    tierUsed: TierLevel;
    modelUsed: string;
    fallbackOccurred: boolean;
    fallbackReason?: string;
    costUsd: number;
    latencyMs: number;
  }): Promise<void> {
    if (!this.config.enabled) return;

    // Extract user prompt text
    const messages = params.request.messages || [];
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    let promptText = typeof lastUserMsg?.content === 'string'
      ? lastUserMsg.content
      : Array.isArray(lastUserMsg?.content)
        ? lastUserMsg.content.map(p => p.text || '').join(' ')
        : '';

    if (this.config.logUserPrompt === false) {
      promptText = `[PROMPT_REDACTED_${params.decision.features.tokenCountEstimate}_TOKENS]`;
    } else if (promptText.length > 2000) {
      promptText = promptText.slice(0, 2000) + '...[TRUNCATED]';
    }

    // Determine Ground Truth label from execution outcomes:
    // If fallback occurred, fast small model was NOT sufficient -> groundTruth is escalated tier (flagship/reasoning)
    let groundTruthTier: TierLevel = params.decision.targetTier;
    let labelSource: 'runtime_fallback' | 'layer2_jev' | 'layer1_confident' | 'layer0_fast' = 'layer0_fast';
    const isNegativeSampleForFast = params.fallbackOccurred;

    if (params.fallbackOccurred) {
      groundTruthTier = params.tierUsed;
      labelSource = 'runtime_fallback';
    } else if (params.decision.layerUsed === 'layer2') {
      groundTruthTier = params.decision.targetTier;
      labelSource = 'layer2_jev';
    } else if (params.decision.layerUsed === 'layer1') {
      groundTruthTier = params.decision.targetTier;
      labelSource = 'layer1_confident';
    }

    const record: FlywheelRecord = {
      id: params.requestId,
      timestamp: new Date().toISOString(),
      userPrompt: promptText,
      tokenCount: params.decision.features.tokenCountEstimate,
      features: {
        hasCode: params.decision.features.hasCode,
        hasMathOrProof: params.decision.features.hasMathOrProof,
        hasMultiTurn: params.decision.features.hasMultiTurn,
        hasToolsOrSchema: params.decision.features.hasToolsOrSchema,
        complexityScore: params.decision.features.complexityScore,
      },
      routing: {
        targetTier: params.decision.targetTier,
        confidence: params.decision.confidence,
        layerUsed: params.decision.layerUsed || 'layer0',
      },
      execution: {
        tierUsed: params.tierUsed,
        modelUsed: params.modelUsed,
        fallbackOccurred: params.fallbackOccurred,
        fallbackReason: params.fallbackReason,
        costUsd: params.costUsd,
        latencyMs: params.latencyMs,
      },
      label: {
        groundTruthTier,
        labelSource,
        isNegativeSampleForFast,
      },
    };

    // Update memory stats
    this.memoryStats.totalSamples++;
    this.memoryStats.tierDistribution[groundTruthTier] = (this.memoryStats.tierDistribution[groundTruthTier] || 0) + 1;
    const layer = params.decision.layerUsed || 'layer0';
    this.memoryStats.layerDistribution[layer] = (this.memoryStats.layerDistribution[layer] || 0) + 1;
    if (params.fallbackOccurred) {
      this.memoryStats.fallbackCount++;
      this.memoryStats.negativeSampleCount++;
    }

    // Asynchronously append to JSONL file
    try {
      const line = JSON.stringify(record) + '\n';
      await fs.promises.appendFile(this.datasetPath, line, 'utf8');
    } catch (err: any) {
      console.warn(`[Flywheel] Failed to write sample to ${this.datasetPath}: ${err.message}`);
    }
  }

  /**
   * Get in-memory flywheel statistics
   */
  public getStats(): FlywheelStats {
    return { ...this.memoryStats };
  }

  public getDatasetPath(): string {
    return this.datasetPath;
  }
}
