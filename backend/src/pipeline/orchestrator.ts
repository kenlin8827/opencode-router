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
import { SessionManager, SessionResolveResult } from '../session/session-manager.js';
import { TraceTracker } from '../trace/tracker.js';
import { CaptureRecorder } from '../capture/recorder.js';
import type { UpstreamEventContext } from '../providers/base.js';
import { emitClientRequest, setClientExchangeContext } from '../observability/http-exchange.js';
import { resolveTraceId } from '../observability/trace-id.js';
import { ActiveHealthProber, CircuitBreakerManager, ErrorClassifier } from '../resilience/index.js';

export interface ProcessContext {
  clientIp?: string;
  headers?: Record<string, string | string[] | undefined>;
  /** Inbound wire that produced this request — recorded as session birth metadata. */
  wire?: 'chat' | 'anthropic' | 'responses';
  /**
   * Raw Fastify request, used by the capture pipeline to record the inbound
   * request event (method / url / sanitized headers / body) synchronously
   * at process() entry — independent of any response. Optional so legacy
   * callers and unit tests can pass plain headers without a request object.
   */
  fastifyRequest?: import('fastify').FastifyRequest;
}

/** Deep-enough message copy for capture snapshots (content parts cloned). */
function snapshotMessages(messages: any[]): any[] {
  return messages.map((m: any) => ({
    role: m.role,
    content: Array.isArray(m.content) ? m.content.map((p: any) => ({ ...p })) : m.content,
  }));
}

/**
 * Pull a non-sensitive subset of inbound headers for the trace's
 * `clientHeaders` field. Three categories:
 *   - user-agent / accept-language — client fingerprint.
 *   - request id (x-request-id / x-trace-id / x-correlation-id / request-id /
 *     traceparent) — cross-service correlation, NOT a credential.
 * Authorization / x-api-key / cookies / anything else are intentionally
 * omitted (raw headers carry API keys). Fastify surfaces headers as
 * `string | string[] | undefined`; arrays collapse to their first value to
 * keep the field scalar. Returns undefined when nothing matched so the
 * trace stays compact for the common no-headers path.
 */
const REQUEST_ID_KEYS = ['x-request-id', 'x-trace-id', 'x-correlation-id', 'request-id', 'traceparent'];

function extractClientHeaders(
  headers?: Record<string, string | string[] | undefined>
): { userAgent?: string; acceptLanguage?: string; requestId?: string } | undefined {
  if (!headers) return undefined;
  const pick = (key: string): string | undefined => {
    const v = headers[key] ?? headers[key.toLowerCase()];
    if (v === undefined) return undefined;
    if (Array.isArray(v)) return v[0];
    return v;
  };
  const ua = pick('user-agent');
  const al = pick('accept-language');
  let rid: string | undefined;
  for (const k of REQUEST_ID_KEYS) {
    rid = pick(k);
    if (rid) break;
  }
  if (ua === undefined && al === undefined && rid === undefined) return undefined;
  return {
    ...(ua !== undefined ? { userAgent: ua } : {}),
    ...(al !== undefined ? { acceptLanguage: al } : {}),
    ...(rid !== undefined ? { requestId: rid } : {}),
  };
}

export class PipelineOrchestrator {
  private config: RouterConfig;
  private registry: ProviderRegistry;
  private tracker: FinOpsTracker;
  private flywheel: FlywheelCollector;
  private sessionManager: SessionManager;
  private traceTracker: TraceTracker;
  private captureRecorder: CaptureRecorder;
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
    this.traceTracker = new TraceTracker(5000, config.tracePersist);
    this.captureRecorder = new CaptureRecorder(config.capture);

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

  public getCaptureRecorder(): CaptureRecorder {
    return this.captureRecorder;
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
   * Public entry point — thin capture wrapper around processInternal.
   *
   * Records the full request/response into the opt-in CaptureRecorder audit
   * log on BOTH the success and the failure path (debugging failed requests
   * is the primary use case). Implemented as a wrapper instead of an inline
   * hook so processInternal stays untouched: the session-id resolution and
   * the PRE-compression message snapshot are rebuilt here with the same pure
   * functions (PromptOptimizer.normalizeMessages / resolveSessionId) — both
   * are deterministic and run in the same synchronous segment, so the wrapper
   * snapshot is byte-identical to what processInternal sees before
   * applyCompression mutates the request. Request headers are never captured.
   */
  public async process(
    request: ChatCompletionRequest,
    context?: ProcessContext
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    const captureEnabled = this.captureRecorder.isEnabled();

    // Capture pipeline state — see observability/http-exchange.ts and
    // observability/upstream-events.ts for the wire emit contract. The
    // `traceId` shared across all four events is sourced from the inbound
    // request when the client supplied one (W3C `traceparent`,
    // `x-request-id`) so the gateway stays transparent in distributed
    // traces; when nothing is supplied, we mint a fresh 32-hex id
    // (OpenTelemetry compliant).
    const traceResolution = context?.fastifyRequest
      ? resolveTraceId(context.fastifyRequest, 'client-or-mint')
      : { traceId: crypto.randomUUID().replace(/-/g, '').slice(0, 32), source: 'minted' as const };
    const captureOutTraceId = traceResolution.traceId;

    let captureSessionId = '';
    let preResolvedSession: SessionResolveResult | undefined;
    let upstreamEventContext: UpstreamEventContext | undefined;
    if (captureEnabled) {
      const normalizedMessages = PromptOptimizer.normalizeMessages(request);
      const snapshotRequest: ChatCompletionRequest = { ...request, messages: normalizedMessages };
      // Resolve ONCE here and hand the result to processInternal: cold-start
      // IDs carry fresh random entropy, so a second resolve of the same
      // request would mint a different ID and split capture from routing.
      preResolvedSession = this.sessionManager.resolveSessionId(
        snapshotRequest,
        context?.clientIp,
        context?.headers
      );
      captureSessionId = preResolvedSession.sessionId;
      // CLIENT REQUEST event fires synchronously here — independent of any
      // response. Even if the upstream call hangs / times out / the handler
      // throws, the client request event is already on disk.
      // (GATEWAY RESPONSE event is emitted by the Fastify onResponse hook
      // after the handler returns, using the ctx attached back onto req.)
      const clientExchangeCtx = emitClientRequest({
        recorder: this.captureRecorder,
        req: context?.fastifyRequest,
        body: snapshotRequest,
        sessionId: captureSessionId,
        traceId: captureOutTraceId,
        model: request.model || 'auto',
      });
      if (context?.fastifyRequest) {
        setClientExchangeContext(context.fastifyRequest, clientExchangeCtx);
      }
      upstreamEventContext = {
        recorder: this.captureRecorder,
        sessionId: captureSessionId,
        traceId: captureOutTraceId,
        model: request.model || 'auto',
      };
    }

    return await this.processInternal(request, context, preResolvedSession, upstreamEventContext, captureOutTraceId);
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
  private async processInternal(
    request: ChatCompletionRequest,
    context?: ProcessContext,
    preResolvedSession?: SessionResolveResult,
    upstreamEventContext?: UpstreamEventContext,
    traceId?: string
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

    // 1A. Custom model combo: the client named a configured combo id — the
    // combo's member list IS the candidate pool. Classifier tier routing,
    // session ratchet and schema-assertion escalation are all bypassed
    // (explicit user composition wins, mirroring the exact-model
    // pass-through above).
    const comboByName =
      !explicitModel && request.model && this.registry.isCombo(request.model)
        ? request.model
        : undefined;
    if (comboByName && this.registry.resolveCombo(comboByName).length === 0) {
      // Fail fast instead of silently degrading to classifier routing: the
      // combo is still advertised via /v1/models, so routing it as `auto`
      // would be invisible billing/model drift.
      throw new Error(
        `Combo '${comboByName}' has no registered member models — check that every id in config.combos exists in config.models.`
      );
    }
    const comboId = comboByName ?? undefined;

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

    // 2. Identify / track conversation session (zero-header layered resolution).
    // Reuse the capture-time resolve when present: both call sites normalize
    // identically, and one request must yield exactly one session ID.
    const sessionResolve = preResolvedSession ??
      this.sessionManager.resolveSessionId(
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
    // Combo requests bypass the classifier entirely: the combo id IS the
    // explicit routing decision; targetTier here is a placeholder — the
    // executed member's real tier overwrites it after the pool run.
    const initialDecision: RoutingDecision = comboId
      ? {
          targetTier: 'flagship',
          confidence: 1.0,
          reason: `Custom combo '${comboId}' — explicit candidate list, classifier bypassed`,
          layerUsed: 'layer0',
          needsSchemaValidation: false,
          features: {
            tokenCountEstimate: 0,
            hasCode: false,
            hasMathOrProof: false,
            hasMultiTurn: false,
            hasToolsOrSchema: false,
            complexityScore: 0,
          },
        }
      : await RouterEngine.routeAsync(normalizedRequest, this.config.classifier);

    // 4. Apply Monotonic Session Ratchet — three session-interaction modes,
    // resolved once here (the unified policy seam for all entry modes):
    // - 'ratchet'  : auto routing — full monotonic ratchet (upgrade allowed,
    //                downgrade intercepted, pin honored)
    // - 'explicit' : client named a registered model — turn recorded and a
    //                higher tier still escalates the ceiling, but the session
    //                NEVER rewrites the proposed tier (explicit user choice
    //                always wins)
    // - 'bypass'   : combo — no pin read/write, no ceiling raise, the combo
    //                composition IS the decision
    const sessionMode: 'ratchet' | 'explicit' | 'bypass' = comboId
      ? 'bypass'
      : explicitModel
        ? 'explicit'
        : 'ratchet';
    let decision: RoutingDecision;
    let ratchetApplied = false;
    let sessionTurnCount: number;
    if (sessionMode === 'bypass') {
      decision = { ...initialDecision, sessionId, sessionRatchetApplied: false, sessionLookupType: sessionResolve.lookupType };
      sessionTurnCount = (this.sessionManager.getSession(sessionId)?.turnCount ?? 0) + 1;
    } else {
      const ratchetResult = this.sessionManager.applyRatchet(
        sessionId,
        initialDecision,
        (tier) => this.registry.getModelForTier(tier),
        { allowIntercept: sessionMode === 'ratchet' }
      );
      decision = ratchetResult.finalDecision;
      decision.sessionId = sessionId;
      decision.sessionRatchetApplied = ratchetResult.ratchetApplied;
      decision.sessionLookupType = sessionResolve.lookupType;
      ratchetApplied = ratchetResult.ratchetApplied;
      sessionTurnCount = ratchetResult.session.turnCount;
    }

    // Birth metadata: attach once per session (first-write-wins inside the
    // manager), recording the inbound wire, the layer that resolved the id,
    // the client ip and a first-message snippet for UI identification.
    const bornSession = this.sessionManager.getSession(sessionId);
    if (bornSession && bornSession.turnCount === 1) {
      const firstUser = normalizedRequest.messages.find((m) => m.role === 'user');
      this.sessionManager.attachOrigin(
        sessionId,
        { wire: context?.wire, lookupType: sessionResolve.lookupType },
        context?.clientIp,
        typeof firstUser?.content === 'string' ? firstUser.content : undefined
      );
    }

    let actualTier = decision.targetTier;

    // 4B. Session Self-Healing (ratchet mode only — explicit/combo requests
    // have no session pin):
    // If the pinned model for this session is currently tripped in OPEN state,
    // dynamically unpin/repin to the healthiest candidate model in actualTier!
    const cbManager = this.registry.getCircuitBreakerManager();
    let preferredModel: ModelRegistration | null = null;
    if (sessionMode === 'ratchet') {
      const pinnedModel = this.sessionManager.getSession(sessionId)?.pinnedModel;
      preferredModel = pinnedModel ? this.registry.getModel(pinnedModel) ?? null : null;
      if (preferredModel && !cbManager.isAvailable(preferredModel.id)) {
        const healthyReplacement = this.registry.getModelForTier(actualTier, true);
        // Guard: getModelForTier falls back to unhealthy candidates when the
        // whole tier is down — never repin onto a known-tripped model.
        if (healthyReplacement && healthyReplacement.id !== preferredModel.id && cbManager.isAvailable(healthyReplacement.id)) {
          this.sessionManager.repinModel(sessionId, healthyReplacement);
          preferredModel = healthyReplacement;
        }
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
    // (fast-lead cascade is skipped for explicit model choices and combos —
    // the client named exactly what to run and must not be silently rerouted)
    const retryConfig = this.config.retry;
    const failoverEnabled = retryConfig?.enabled !== false && retryConfig?.failover?.enabled !== false;
    const maxFailoverCandidates = failoverEnabled ? (retryConfig?.failover?.maxAttempts ?? 2) : 1;
    const tierCrossPolicy = retryConfig?.failover?.tierCrossPolicy ?? 'allow_escalate';

    if (decision.needsSchemaValidation && this.config.fallback.enabled && !request.router_options?.disable_fallback && !explicitModel && !comboId) {
      // 5A: Fast Tier lead - Deploy Fast Tier first with resilience
      const fastPool = this.registry.getCandidateModelsForTier('fast', true);
      const fastResult = await this.executeCandidatePool(
        normalizedRequest,
        {
          chain: fastPool.length > 0 ? fastPool : this.registry.getCandidateModelsForTier('fast', false),
          tier: 'fast',
          allowEscalate: tierCrossPolicy === 'allow_escalate',
          attemptCap: maxFailoverCandidates,
        },
        upstreamEventContext
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
          {
            chain: this.registry.getCandidateModelsForTier(escalateTier, true),
            tier: escalateTier,
            allowEscalate: false,
            attemptCap: maxFailoverCandidates,
          },
          upstreamEventContext
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
      // Unified candidate-chain resolution for the direct path. One shape for
      // all entry modes: chain[0] = leader, rest = failover order; escalation
      // and attempt-cap are explicit policy fields (see executeCandidatePool).
      let chain: ModelRegistration[];
      let attemptCap: number;
      let allowEscalate: boolean;
      let poolLabel: string | undefined;

      if (comboId) {
        // Combo: the configured member list IS the chain — leader chosen by
        // the combo's selection strategy (registry.pickComboLeader, breaker-
        // aware), the rest follow config order. No cross-tier escalation: the
        // user's composition is authoritative. Cap = full chain length so
        // long combos are never truncated by retry.failover.maxAttempts.
        const members = this.registry.resolveCombo(comboId);
        const leader = members.length > 0 ? this.registry.pickComboLeader(comboId, members) : undefined;
        chain = leader ? [leader, ...members.filter(m => m.id !== leader.id)] : members;
        attemptCap = Math.max(1, chain.length);
        allowEscalate = false;
        poolLabel = `combo '${comboId}'`;
      } else {
        // Auto & explicit: tier pool (peek-filtered; fall back to the full
        // pool when everything is tripped — the loop force-tries the last
        // candidate). Head = pinned model (auto, post-self-healing) or the
        // explicit model, so KV-cache affinity is preserved.
        let pool = this.registry.getCandidateModelsForTier(actualTier, true);
        if (pool.length === 0) pool = this.registry.getCandidateModelsForTier(actualTier, false);
        const head = explicitModel ?? preferredModel;
        chain = head ? [head, ...pool.filter(m => m.id !== head.id)] : pool;
        // Auto keeps the configured failover budget; explicit/combo are
        // bounded by their own chain length (failover.maxAttempts governs
        // auto routing only). Cross-tier escalation is an auto-routing
        // policy — an explicit model fails over within its tier by contract.
        attemptCap = explicitModel ? Math.max(1, chain.length) : maxFailoverCandidates;
        allowEscalate = !explicitModel && tierCrossPolicy === 'allow_escalate' && actualTier === 'fast';
      }

      // Standard Direct Model Execution with Multi-Model Failover & Circuit Breaker
      const execResult = await this.executeCandidatePool(
        normalizedRequest,
        { chain, tier: actualTier, allowEscalate, attemptCap, label: poolLabel },
        upstreamEventContext
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

      // Explicit-mode pin write-back: when the explicitly named model itself
      // served the request at the session's current ceiling tier, migrate the
      // session pin onto it — keeps the pin coherent with actually-used
      // models (KV-cache locality) without ever rewriting the client's choice.
      if (
        explicitModel &&
        execResult.modelUsed?.id === explicitModel.id &&
        sessionMode === 'explicit'
      ) {
        const sess = this.sessionManager.getSession(sessionId);
        if (sess && sess.maxTier === explicitModel.tier && sess.pinnedModel !== explicitModel.id) {
          this.sessionManager.repinModel(sessionId, explicitModel);
        }
      }
    }

    // 6. Post-Turn Registration: Register completed turn prefix fingerprint for zero-header tracking
    // Uses the PRE-compression snapshot (see 2B): clients always resend
    // uncompressed bytes, so the chain must be indexed on original content.
    const assistantContent = finalResponse!.choices[0]?.message?.content || '';
    this.sessionManager.registerCompletedTurn(
      sessionId,
      fingerprintMessages,
      assistantContent,
      context?.clientIp
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

    // 9. Session Trajectory Recording — the traceId is shared with the
    // capture event stream (the OTel traceId sourced from the client request
    // — see resolveTraceId). One id now joins capture events and the trace
    // record, so a console reader can pull both streams by traceId.
    const sharedTraceId = traceId ?? 'unknown';
    const lastUserMsg = normalizedRequest.messages.filter(m => m.role === 'user').pop();
    const userPromptSummary = typeof lastUserMsg?.content === 'string'
      ? lastUserMsg.content.slice(0, 200)
      : Array.isArray(lastUserMsg?.content)
        ? (lastUserMsg.content.map(p => (p as any).text || '').join(' ')).slice(0, 200)
        : '';

    this.traceTracker.record({
      traceId: sharedTraceId,
      sessionId,
      turnNumber: sessionTurnCount,
      timestamp: startTime,
      request: {
        model: request.model || 'auto',
        userPromptSummary,
        messageCount: normalizedRequest.messages.length,
        hasSystemPrompt: normalizedRequest.messages.some(m => m.role === 'system'),
        hasToolsOrSchema: Boolean(decision.needsSchemaValidation),
        clientHeaders: extractClientHeaders(context?.headers),
      },
      routing: {
        layerUsed: (decision.layerUsed || 'layer0') as any,
        targetTier: actualTier,
        confidence: decision.confidence,
        reason: decision.reason,
        sessionRatchetApplied: ratchetApplied,
        sessionLookupType: sessionResolve.lookupType,
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
      sessionRatchetApplied: ratchetApplied,
      sessionLookupType: sessionResolve.lookupType,
      traceId: sharedTraceId,
      costUsd: actualCost,
      baselineCostUsd: baselineCost,
      savedCostUsd,
      latencyMs,
    };
  }

  /**
   * Resilient candidate-chain executor (ADR-0008, ADR-0009) — the single
   * execution path shared by ALL entry modes (auto / explicit model / combo /
   * schema-assertion cascade). Callers resolve a candidate chain + policy
   * fields; this function only runs the loop.
   *
   * Chain contract: chain[0] is the leader (pinned model / explicit model /
   * combo leader), the rest follow failover order. When `allowEscalate` is
   * set (auto fast-tier only), healthy flagship models are appended as a
   * cross-tier escalation tail — Strict Anti-Downgrade: flagship chains never
   * get fast models appended.
   *
   * Two-Tier Cost-Aware Resilience Architecture:
   * 1. In-Place Retry (Preserve Upstream KV Prompt Cache, Prevent 10x Cost Invalidation):
   *    Transient 5xx / timeouts trigger a fast in-place retry on the SAME candidate model
   *    with backoff + jitter. If the transient blip recovers, 100% of KV cache is retained!
   *    Hard errors (402 Quota Exhausted, 401 Auth) skip in-place retry instantly (0 wasted retries).
   *
   * 2. Hierarchical Failover: proceed across the chain while an untried
   *    candidate remains; the LAST candidate is always force-tried (a breaker
   *    rejection costs nothing upstream — when the whole chain is down this is
   *    the last-resort attempt). `attemptCap` bounds real attempts: the
   *    configured retry.failover.maxAttempts for auto routing, the full chain
   *    length for explicit/combo chains.
   *
   * Breaker gate: canExecute() here is the ONLY probe-consuming check in the
   * request path — every selection/filtering site uses the non-consuming
   * peek, so HALF_OPEN canary quota is never starved by lookups.
   */
  private async executeCandidatePool(
    request: ChatCompletionRequest,
    opts: {
      chain: ModelRegistration[];
      tier: TierLevel;
      allowEscalate: boolean;
      attemptCap: number;
      label?: string;
    },
    upstreamEventContext?: UpstreamEventContext
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
    const { tier, allowEscalate, attemptCap, label } = opts;
    const cbManager = this.registry.getCircuitBreakerManager();
    const retryConfig = this.config.retry;
    const inplaceConfig = retryConfig?.inplace;

    const inplaceEnabled = retryConfig?.enabled !== false && inplaceConfig?.enabled !== false;
    const maxInplaceAttempts = inplaceEnabled ? (inplaceConfig?.maxAttempts ?? 1) : 0;
    const backoffMs = inplaceConfig?.backoffMs ?? 200;
    const jitterMs = inplaceConfig?.jitterMs ?? 100;

    // 1. Candidate list = resolved chain (+ cross-tier escalation tail when allowed)
    const candidateList = [...opts.chain];
    if (allowEscalate) {
      for (const m of this.registry.getCandidateModelsForTier('flagship', true)) {
        if (!candidateList.some(c => c.id === m.id)) candidateList.push(m);
      }
    }

    let lastError: any = null;
    let failoverAttempts = 0;
    let totalInplaceRetries = 0;
    const failoverPath: string[] = [];

    for (let ci = 0; ci < candidateList.length; ci++) {
      const candidate = candidateList[ci];

      if (failoverAttempts >= attemptCap) {
        break;
      }

      // Execution gate — position-based skip: drop an unavailable candidate
      // while an untried one remains AFTER it; the last candidate is always
      // attempted (the pool builder already exhausted healthy-only options,
      // and a rejected upstream call is free).
      const check = cbManager.canExecute(candidate.id);
      if (!check.allowed && ci < candidateList.length - 1) {
        continue;
      }

      failoverAttempts++;
      failoverPath.push(candidate.id);

      // In-place retry loop on the SAME candidate model
      let candidateSucceeded = false;
      let candidateResponse: ChatCompletionResponse | undefined = undefined;

      for (let attempt = 0; attempt <= maxInplaceAttempts; attempt++) {
        try {
          candidateResponse = await this.registry.execute(
            request,
            candidate,
            upstreamEventContext
          );
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
        // The provider published its real wire body through the capture sink
        // before returning — captureOut.upstreamRequest holds the SUCCESSFUL
        // attempt's payload (last write wins across retries).
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

    // Pool exhausted — record the request that was actually sent to the last
    // attempted candidate (all candidates receive the same request), so failed
    // turns still carry the outbound view for debugging. Zero-attempt failures
    // (empty pool / every candidate skipped by breaker) never wrote anything
    // upstream, so no snapshot is recorded for them.
    return {
      success: false,
      failoverOccurred: failoverAttempts > 1,
      failoverAttempts,
      failoverPath,
      inplaceRetries: totalInplaceRetries,
      lastError: lastError || new Error(`No available models for ${label ?? `tier '${tier}'`}`),
    };
  }
}

