import crypto from 'node:crypto';
import { ChatCompletionRequest, ChatCompletionResponse } from '../types/openai.js';
import { ExecutionResult, ModelPricing, RoutingDecision, TierLevel } from '../types/router.js';
import { ModelRegistration, RouterConfig } from '../config/types.js';
import { PromptOptimizer } from './prompt-optimizer.js';
import { applyCompression } from '../compression/index.js';
import { RouterEngine, routingModeForceTier } from '../router/index.js';
import { SchemaAssertion } from '../validator/schema-assertion.js';
import { FallbackContextBuilder } from '../validator/parser.js';
import { BudgetManager } from '../budget/budget-manager.js';
import { ProviderRegistry } from '../providers/registry.js';
import { FinOpsTracker } from '../metrics/finops-tracker.js';
import { FlywheelCollector } from '../flywheel/collector.js';
import { SessionManager } from '../session/session-manager.js';
import { TraceTracker } from '../trace/tracker.js';
import { ActiveHealthProber, CircuitBreakerManager, ErrorClassifier } from '../resilience/index.js';

export interface ProcessContext {
  clientIp?: string;
  headers?: Record<string, string | string[] | undefined>;
}

export class PipelineOrchestrator {
  private config: RouterConfig;
  private registry: ProviderRegistry;
  private tracker: FinOpsTracker;
  private flywheel: FlywheelCollector;
  private sessionManager: SessionManager;
  private traceTracker: TraceTracker;
  private baselinePricing: ModelPricing;
  private healthProber?: ActiveHealthProber;

  constructor(
    config: RouterConfig,
    registry: ProviderRegistry,
    tracker: FinOpsTracker,
    sessionManager?: SessionManager
  ) {
    this.config = config;
    this.registry = registry;
    this.tracker = tracker;
    this.flywheel = new FlywheelCollector(config.flywheel);
    this.sessionManager = sessionManager || new SessionManager(config.session);
    this.traceTracker = new TraceTracker();

    // Lookup baseline pricing for FinOps dollar calculation
    const baselineModel = this.registry.getModel(config.baselineModel) || this.registry.getModelForTier('flagship');
    this.baselinePricing = baselineModel.pricing;

    if (config.circuitBreaker?.activeProbing?.enabled) {
      this.healthProber = new ActiveHealthProber(
        this.registry.getCircuitBreakerManager(),
        this.registry,
        config.circuitBreaker.activeProbing.intervalMs
      );
    }
  }

  public getTracker(): FinOpsTracker {
    return this.tracker;
  }

  public getFlywheel(): FlywheelCollector {
    return this.flywheel;
  }

  public getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  public getTraceTracker(): TraceTracker {
    return this.traceTracker;
  }

  public getRegistry(): ProviderRegistry {
    return this.registry;
  }

  public getCircuitBreakerManager(): CircuitBreakerManager {
    return this.registry.getCircuitBreakerManager();
  }

  public startProber(): void {
    if (this.healthProber) this.healthProber.start();
  }

  public stopProber(): void {
    if (this.healthProber) this.healthProber.stop();
  }

  /**
   * Complete orchestration workflow:
   * 1. Prompt normalization (canonical order)
   * 2. Zero-header session identification & prefix fingerprinting
   * 3. Multi-Layer hierarchical routing (Layer 0 -> Layer 1 -> Layer 2)
   * 4. Monotonic Ratchet session state enforcement + Session Self-Healing
   * 5. Execution with Circuit Breaker, Transparent Failover & Schema Assertion
   * 6. FinOps accounting
   * 7. Active learning data flywheel logging
   * 8. Post-turn prefix fingerprint registration
   */
  public async process(
    request: ChatCompletionRequest,
    context?: ProcessContext
  ): Promise<ExecutionResult> {
    const startTime = Date.now();

    // 1. Optimize message prefix order & resolve virtual routing models
    const normalizedMessages = PromptOptimizer.normalizeMessages(request);
    const normalizedRequest: ChatCompletionRequest = {
      ...request,
      messages: normalizedMessages,
    };

    let explicitModel: ModelRegistration | undefined;
    if (request.model === 'auto-fast') {
      normalizedRequest.router_options = { ...normalizedRequest.router_options, force_tier: 'fast' };
    } else if (request.model === 'auto-flagship') {
      normalizedRequest.router_options = { ...normalizedRequest.router_options, force_tier: 'flagship' };
    } else if (request.model === 'auto-reasoning') {
      normalizedRequest.router_options = { ...normalizedRequest.router_options, force_tier: 'reasoning' };
    } else if (request.model && request.model !== 'auto') {
      const specific = this.registry.getModel(request.model);
      if (specific) {
        // Exact-model pass-through: the client named a REGISTERED model id
        // (e.g. pinned via the Client Hub model slots). Route to exactly
        // this model — not merely its tier. Resilience is preserved: if its
        // breaker is tripped, executeCandidatePool drops it and fails over
        // within the tier.
        explicitModel = specific;
        normalizedRequest.router_options = { ...normalizedRequest.router_options, force_tier: specific.tier };
      }
      // Unregistered names (e.g. native `claude-opus-*` after a /model switch
      // inside Claude Code) are left untouched — the classifier decides,
      // which IS the intelligent-routing product behavior.
    }

    // 1B. Global routing mode (config.routing.mode) — cost/quality force the tier
    // for auto/default requests; explicit client choices always win.
    const modeTier = routingModeForceTier(
      normalizedRequest.model,
      normalizedRequest.router_options,
      this.config.routing?.mode
    );
    if (modeTier) {
      normalizedRequest.router_options = { ...normalizedRequest.router_options, force_tier: modeTier };
    }

    // 2. Identify / track conversation session (zero-header prefix chain + root anchor)
    const sessionResolve = this.sessionManager.resolveSessionId(
      normalizedRequest,
      context?.clientIp,
      context?.headers
    );
    const sessionId = sessionResolve.sessionId;

    // 2B. Token-saver compression (toolOutput 工具输出压缩 → headroom sidecar →
    // outputStyle 输出风格注入). All stages fail open. Snapshot the PRE-compression
    // messages for the post-turn prefix fingerprint: the client always sends
    // uncompressed bytes, so the session chain must be indexed on the original
    // content — matching registerCompletedTurn below against compressed bytes
    // would break zero-header session resolution from the next turn onward.
    // (The upstream-facing compressed prefix stays byte-stable across turns
    // because the tool-output compressors are deterministic and headroom
    // runs in session mode.)
    const fingerprintMessages = normalizedRequest.messages.map(m => ({
      role: m.role,
      content: Array.isArray(m.content) ? m.content.map(p => ({ ...p })) : m.content,
    }));
    await applyCompression(normalizedRequest, this.config.compression, sessionId);

    // 3. Multi-Layer Hierarchical Router (Layer 1 Local CPU -> Layer 2 Jev)
    const initialDecision = await RouterEngine.routeAsync(normalizedRequest, this.config.classifier);

    // 4. Apply Monotonic Session Ratchet
    const ratchetResult = this.sessionManager.applyRatchet(
      sessionId,
      initialDecision,
      (tier) => this.registry.getModelForTier(tier)
    );
    const decision = ratchetResult.finalDecision;
    decision.sessionId = sessionId;
    decision.sessionRatchetApplied = ratchetResult.ratchetApplied;

    let actualTier = decision.targetTier;

    // 4B. Session Self-Healing:
    // If the pinned model for this session is currently tripped in OPEN state,
    // dynamically unpin/repin to the healthiest candidate model in actualTier!
    let preferredModel = ratchetResult.session.pinnedModel
      ? this.registry.getModel(ratchetResult.session.pinnedModel)
      : null;

    const cbManager = this.registry.getCircuitBreakerManager();
    if (preferredModel && !cbManager.isAvailable(preferredModel.id)) {
      const healthyReplacement = this.registry.getModelForTier(actualTier, true);
      if (healthyReplacement && healthyReplacement.id !== preferredModel.id) {
        this.sessionManager.repinModel(sessionId, healthyReplacement);
        preferredModel = healthyReplacement;
      }
    }

    let finalResponse: ChatCompletionResponse;
    let actualModel: ModelRegistration = preferredModel || this.registry.getModelForTier(actualTier, true);
    let fallbackOccurred = false;
    let fallbackReason: string | undefined = undefined;
    let failoverOccurred = false;
    let failoverAttempts = 1;
    let failoverPath: string[] = [];
    let inplaceRetries = 0;

    // 5. Execution with Cascading Fallback & Schema Assertion
    // (fast-lead cascade is skipped for explicit model choices — the client
    // named a specific model and must not be silently rerouted to fast tier)
    if (decision.needsSchemaValidation && this.config.fallback.enabled && !request.router_options?.disable_fallback && !explicitModel) {
      // 5A: Fast Tier lead - Deploy Fast Tier first with resilience
      const fastResult = await this.executeCandidatePool(
        normalizedRequest,
        'fast',
        decision
      );

      let fastRes: ChatCompletionResponse | null = null;
      let assertionPassed = false;
      let assertionError = '';

      if (fastResult.success && fastResult.response) {
        fastRes = fastResult.response;
        const content = fastRes.choices[0]?.message?.content || '';

        // Local static AST / Schema assertion (Zero extra LLM cost!)
        const validation = SchemaAssertion.validate(content, normalizedRequest.response_format);
        if (validation.valid) {
          assertionPassed = true;
          finalResponse = fastRes;
          actualTier = 'fast';
          actualModel = fastResult.modelUsed!;
          failoverOccurred = fastResult.failoverOccurred;
          failoverAttempts = fastResult.failoverAttempts;
          failoverPath = fastResult.failoverPath;
          inplaceRetries += fastResult.inplaceRetries;
        } else {
          assertionError = validation.error || 'Schema validation assertion failed';
        }
      } else {
        assertionError = `Fast Tier Execution Error: ${fastResult.lastError?.message}`;
      }

      // 5B: Flagship fallback - If Fast Tier failed assertion or execution, silent escalation
      if (!assertionPassed) {
        fallbackOccurred = true;
        fallbackReason = assertionError;
        const escalateTier = this.config.fallback.escalateTier || 'flagship';

        const failedContent = fastRes?.choices[0]?.message?.content || '';
        const fallbackReq = FallbackContextBuilder.buildEscalationRequest(
          normalizedRequest,
          failedContent,
          assertionError,
          escalateTier
        );

        const flagshipResult = await this.executeCandidatePool(
          fallbackReq,
          escalateTier,
          decision
        );

        if (!flagshipResult.success || !flagshipResult.response) {
          throw flagshipResult.lastError || new Error(`Flagship escalation failed for tier '${escalateTier}'`);
        }

        finalResponse = flagshipResult.response;
        actualTier = escalateTier;
        actualModel = flagshipResult.modelUsed!;
        failoverOccurred = flagshipResult.failoverOccurred;
        failoverAttempts = flagshipResult.failoverAttempts;
        failoverPath = flagshipResult.failoverPath;
        inplaceRetries += flagshipResult.inplaceRetries;
      }
    } else {
      // Standard Direct Model Execution with Multi-Model Failover & Circuit Breaker
      const execResult = await this.executeCandidatePool(
        normalizedRequest,
        actualTier,
        decision,
        explicitModel ?? preferredModel
      );

      if (!execResult.success || !execResult.response) {
        throw execResult.lastError || new Error(`Execution failed for tier '${actualTier}'`);
      }

      finalResponse = execResult.response;
      actualModel = execResult.modelUsed!;
      actualTier = execResult.tierUsed!;
      failoverOccurred = execResult.failoverOccurred;
      failoverAttempts = execResult.failoverAttempts;
      failoverPath = execResult.failoverPath;
      inplaceRetries = execResult.inplaceRetries;
    }

    // 6. Post-Turn Registration: Register completed turn prefix fingerprint for zero-header tracking
    // Uses the PRE-compression snapshot (see 2B): clients always resend
    // uncompressed bytes, so the chain must be indexed on original content.
    const assistantContent = finalResponse!.choices[0]?.message?.content || '';
    this.sessionManager.registerCompletedTurn(
      sessionId,
      fingerprintMessages,
      assistantContent
    );

    // 7. FinOps Tracking & Economics Calculation
    const latencyMs = Date.now() - startTime;
    const actualCost = BudgetManager.calculateCost(finalResponse!.usage, actualModel.pricing);
    const baselineCost = BudgetManager.calculateBaselineCost(
      finalResponse!.usage,
      this.baselinePricing
    );
    const savedCostUsd = Math.max(0, baselineCost - actualCost);

    const cachedTokens = PromptOptimizer.extractCachedTokens(finalResponse!.usage);
    this.tracker.record({
      tier: actualTier,
      fallbackOccurred,
      promptTokens: finalResponse!.usage?.prompt_tokens || 0,
      cachedPromptTokens: cachedTokens,
      completionTokens: finalResponse!.usage?.completion_tokens || 0,
      reasoningTokens: finalResponse!.usage?.completion_tokens_details?.reasoning_tokens || 0,
      actualCost,
      baselineCost,
      latencyMs,
    });

    // 8. Active Learning Data Flywheel Collection
    await this.flywheel.record({
      requestId: finalResponse!.id || `req_${Date.now()}`,
      request: normalizedRequest,
      decision,
      tierUsed: actualTier,
      modelUsed: actualModel.id,
      fallbackOccurred,
      fallbackReason,
      costUsd: actualCost,
      latencyMs,
    });

    // 9. Session Trajectory Recording
    const traceId = `trace_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const lastUserMsg = normalizedRequest.messages.filter(m => m.role === 'user').pop();
    const userPromptSummary = typeof lastUserMsg?.content === 'string'
      ? lastUserMsg.content.slice(0, 200)
      : Array.isArray(lastUserMsg?.content)
        ? (lastUserMsg.content.map(p => (p as any).text || '').join(' ')).slice(0, 200)
        : '';

    this.traceTracker.record({
      traceId,
      sessionId,
      turnNumber: ratchetResult.session.turnCount,
      timestamp: startTime,
      request: {
        model: request.model || 'auto',
        userPromptSummary,
        messageCount: normalizedRequest.messages.length,
        hasSystemPrompt: normalizedRequest.messages.some(m => m.role === 'system'),
        hasToolsOrSchema: Boolean(decision.needsSchemaValidation),
      },
      routing: {
        layerUsed: (decision.layerUsed || 'layer0') as any,
        targetTier: actualTier,
        confidence: decision.confidence,
        reason: decision.reason,
        sessionRatchetApplied: ratchetResult.ratchetApplied,
      },
      execution: {
        modelUsed: actualModel.id,
        provider: actualModel.provider,
        tierUsed: actualTier,
        latencyMs,
        fallbackOccurred,
        fallbackReason,
        failoverOccurred,
        failoverAttempts,
        failoverPath,
        inplaceRetries,
      },
      finops: {
        promptTokens: finalResponse!.usage?.prompt_tokens || 0,
        completionTokens: finalResponse!.usage?.completion_tokens || 0,
        cachedPromptTokens: cachedTokens,
        costUsd: actualCost,
        savedCostUsd,
      },
    });

    const breakerState = cbManager.getBreaker(actualModel.id)?.getState() || 'CLOSED';

    return {
      response: finalResponse!,
      tierUsed: actualTier,
      modelUsed: actualModel.id,
      layerUsed: decision.layerUsed || 'layer0',
      fallbackOccurred,
      fallbackReason,
      failoverOccurred,
      failoverAttempts,
      failoverPath,
      inplaceRetries,
      breakerState,
      sessionId,
      sessionRatchetApplied: ratchetResult.ratchetApplied,
      traceId,
      costUsd: actualCost,
      baselineCostUsd: baselineCost,
      savedCostUsd,
      latencyMs,
    };
  }

  /**
   * Resilient candidate execution pool dispatcher (ADR-0008, ADR-0009).
   *
   * Two-Tier Cost-Aware Resilience Architecture:
   * 1. In-Place Retry (Preserve Upstream KV Prompt Cache, Prevent 10x Cost Invalidation):
   *    Transient 5xx / timeouts trigger a fast in-place retry on the SAME candidate model
   *    with backoff + jitter. If the transient blip recovers, 100% of KV cache is retained!
   *    Hard errors (402 Quota Exhausted, 401 Auth) skip in-place retry instantly (0 wasted retries).
   *
   * 2. Hierarchical Failover (Multi-Model Pool & Tier Crossing Policy):
   *    If in-place retry fails or error is non-transient (402/429):
   *    Failover proceeds across candidates in the tier.
   *    - 'allow_escalate': If all fast-tier models are exhausted, escalate to flagship models.
   *      Strict Anti-Downgrade: Flagship requests NEVER downgrade to fast tier.
   *    - 'same_tier_only': Strictly confine failover to the requested tier.
   */
  private async executeCandidatePool(
    request: ChatCompletionRequest,
    tier: TierLevel,
    decision: RoutingDecision,
    preferredModel?: ModelRegistration | null
  ): Promise<{
    success: boolean;
    response?: ChatCompletionResponse;
    modelUsed?: ModelRegistration;
    tierUsed?: TierLevel;
    failoverOccurred: boolean;
    failoverAttempts: number;
    failoverPath: string[];
    inplaceRetries: number;
    lastError?: any;
  }> {
    const cbManager = this.registry.getCircuitBreakerManager();
    const retryConfig = this.config.retry;
    const inplaceConfig = retryConfig?.inplace;
    const failoverConfig = retryConfig?.failover;

    const inplaceEnabled = retryConfig?.enabled !== false && inplaceConfig?.enabled !== false;
    const maxInplaceAttempts = inplaceEnabled ? (inplaceConfig?.maxAttempts ?? 1) : 0;
    const backoffMs = inplaceConfig?.backoffMs ?? 200;
    const jitterMs = inplaceConfig?.jitterMs ?? 100;

    const failoverEnabled = retryConfig?.enabled !== false && failoverConfig?.enabled !== false;
    const maxFailoverCandidates = failoverEnabled ? (failoverConfig?.maxAttempts ?? 2) : 1;
    const tierCrossPolicy = failoverConfig?.tierCrossPolicy ?? 'allow_escalate';

    // 1. Build Candidate Pool
    const primaryMap = new Map<string, ModelRegistration>();

    // A. Add preferred model first if healthy and in tier
    if (preferredModel && preferredModel.tier === tier && cbManager.isAvailable(preferredModel.id)) {
      primaryMap.set(preferredModel.id, preferredModel);
    }

    // B. Add all healthy candidate models for this tier (sorted by priority / default)
    for (const m of this.registry.getCandidateModelsForTier(tier, true)) {
      if (!primaryMap.has(m.id)) primaryMap.set(m.id, m);
    }

    // C. Escalation Candidates (Cross-tier policy)
    const escalationCandidates: ModelRegistration[] = [];
    if (tierCrossPolicy === 'allow_escalate' && tier === 'fast') {
      // Allow fast -> flagship escalation when fast tier fails
      for (const m of this.registry.getCandidateModelsForTier('flagship', true)) {
        if (!primaryMap.has(m.id)) escalationCandidates.push(m);
      }
    }
    // Strict Anti-Downgrade: if tier === 'flagship', NEVER add 'fast' models!

    // D. If primaryMap is empty (all healthy models unavailable in tier):
    if (primaryMap.size === 0) {
      if (escalationCandidates.length > 0) {
        // Escalate immediately if no healthy fast models exist
        for (const m of escalationCandidates) {
          primaryMap.set(m.id, m);
        }
      } else {
        // Last-resort fallback: include any registered models in tier even if OPEN
        for (const m of this.registry.getCandidateModelsForTier(tier, false)) {
          if (!primaryMap.has(m.id)) primaryMap.set(m.id, m);
        }
      }
    }

    // Form final ordered candidate list
    const candidateList = Array.from(primaryMap.values());
    // Append escalation candidates if not already present
    for (const m of escalationCandidates) {
      if (!candidateList.some(c => c.id === m.id)) {
        candidateList.push(m);
      }
    }

    let lastError: any = null;
    let failoverAttempts = 0;
    let totalInplaceRetries = 0;
    const failoverPath: string[] = [];

    for (const candidate of candidateList) {
      if (failoverAttempts >= maxFailoverCandidates) {
        break;
      }

      // Check circuit breaker
      const check = cbManager.canExecute(candidate.id);
      if (!check.allowed && candidateList.length > 1 && failoverAttempts < candidateList.length - 1) {
        // Skip tripped models if alternative untripped candidates exist in pool
        continue;
      }

      failoverAttempts++;
      failoverPath.push(candidate.id);

      // In-place retry loop on the SAME candidate model
      let candidateSucceeded = false;
      let candidateResponse: ChatCompletionResponse | undefined = undefined;

      for (let attempt = 0; attempt <= maxInplaceAttempts; attempt++) {
        try {
          candidateResponse = await this.registry.execute(request, candidate);
          cbManager.recordSuccess(candidate.id);
          candidateSucceeded = true;
          break; // successfully executed on this candidate!
        } catch (err: any) {
          lastError = err;
          const diagnosis = ErrorClassifier.classify(
            err,
            candidate.id,
            candidate.provider,
            this.config.circuitBreaker,
            this.config.retry
          );
          cbManager.recordFailure(candidate.id, diagnosis, candidate.provider);

          // 1. Client error (400 Bad Request, context length exceeded) -> NEVER retriable, fail immediately
          if (!diagnosis.isRetriable) {
            return {
              success: false,
              failoverOccurred: false,
              failoverAttempts,
              failoverPath,
              inplaceRetries: totalInplaceRetries,
              lastError: err,
            };
          }

          // 2. Can we in-place retry on the SAME candidate model to preserve KV Cache?
          if (diagnosis.isInPlaceRetriable && attempt < maxInplaceAttempts) {
            let sleepMs = backoffMs + Math.random() * jitterMs;
            if (diagnosis.networkCause === 'RATE_LIMIT_BURST' && diagnosis.retryAfterSeconds) {
              sleepMs = Math.max(sleepMs, diagnosis.retryAfterSeconds * 1000);
            }
            await new Promise(resolve => setTimeout(resolve, sleepMs));
            totalInplaceRetries++;
            continue; // retry in-place on this model!
          }

          // 3. In-place retry not applicable (402, long 429, excluded cause, or maxAttempts reached)
          // Break out of in-place loop to failover to next candidate model!
          break;
        }
      }

      if (candidateSucceeded && candidateResponse) {
        return {
          success: true,
          response: candidateResponse,
          modelUsed: candidate,
          tierUsed: candidate.tier,
          failoverOccurred: failoverAttempts > 1,
          failoverAttempts,
          failoverPath,
          inplaceRetries: totalInplaceRetries,
        };
      }
    }

    return {
      success: false,
      failoverOccurred: failoverAttempts > 1,
      failoverAttempts,
      failoverPath,
      inplaceRetries: totalInplaceRetries,
      lastError: lastError || new Error(`No available models for tier '${tier}'`),
    };
  }
}

