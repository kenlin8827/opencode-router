import { registerConsoleRoutes, validateApiKey, SPA_ROUTES } from './routes/console.js';
import { registerAnthropicRoutes } from './routes/anthropic.js';
import { registerResponsesRoutes } from './routes/responses.js';
import { buildChatStreamChunks } from './utils/chat-sse.js';
import fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { RouterConfig } from './config/types.js';
import { loadConfig } from './config/index.js';
import { PipelineOrchestrator } from './pipeline/orchestrator.js';
import { ProviderRegistry } from './providers/registry.js';
import { FinOpsTracker } from './metrics/finops-tracker.js';
import { ChatCompletionRequest } from './types/openai.js';
import { APP_VERSION } from './version.js';

export function createServer(
  config: RouterConfig,
  mockMode = false,
  customRegistry?: ProviderRegistry,
  customOrchestrator?: PipelineOrchestrator
): {
  app: FastifyInstance;
  orchestrator: PipelineOrchestrator;
  registry: ProviderRegistry;
  tracker: FinOpsTracker;
} {
  const app = fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
  });

  const registry = customRegistry || new ProviderRegistry(config, mockMode);
  const tracker = customOrchestrator?.getTracker() || new FinOpsTracker();
  const orchestrator =
    customOrchestrator || new PipelineOrchestrator(config, registry, tracker);

  // Register CORS to allow any web frontend (Chatbox, NextChat, OpenWebUI)
  app.register(cors, { origin: true });

  // Register console dashboard and management routes
  registerConsoleRoutes(app, registry, orchestrator);

  // Register Anthropic-protocol compatibility endpoint (POST /v1/messages)
  registerAnthropicRoutes(app, orchestrator);
  registerResponsesRoutes(app, orchestrator);

  // Authentication hook: validates adminApiKey (master) or client API keys (apiKeys)
  app.addHook('preHandler', async (req, reply) => {
    const diskConfig = loadConfig();
    const activeKeys =
      config.apiKeys !== undefined && config.apiKeys.length > 0
        ? config.apiKeys
        : diskConfig.apiKeys || config.apiKeys || [];
    const adminKey = config.adminApiKey !== undefined ? config.adminApiKey : diskConfig.adminApiKey;

    const isAuthEnabled = Boolean(adminKey || (activeKeys && activeKeys.length > 0));
    if (!isAuthEnabled) return;

    const activeConfig: RouterConfig = {
      ...config,
      adminApiKey: adminKey,
      apiKeys: activeKeys,
    };
    const rawUrl = req.url.split('?')[0];

    // Whitelist routes: health probes, frontend assets, UI pages and the
    // read-only observability endpoints the console pages fetch from the
    // browser (/v1/sessions, /v1/traces). Inference endpoints
    // (/v1/chat/completions, /v1/messages) stay auth-protected.
    // SPA page paths come from SPA_ROUTES (console.ts) — single source of truth,
    // so a new console page can never 401 on browser refresh again.
    if (
      SPA_ROUTES.includes(rawUrl) ||
      rawUrl.startsWith('/assets/') ||
      rawUrl.startsWith('/api/ui/') ||
      rawUrl.startsWith('/api/console/') ||
      rawUrl === '/health' ||
      rawUrl.startsWith('/v1/health') ||
      rawUrl === '/v1/models' ||
      rawUrl === '/v1/sessions' ||
      rawUrl.startsWith('/v1/sessions/') ||
      rawUrl === '/v1/traces' ||
      rawUrl.startsWith('/v1/traces/')
    ) {
      return;
    }

    // Extract token from Authorization header or x-api-key header
    const authHeader = req.headers.authorization;
    const xApiKeyHeader = req.headers['x-api-key'] as string | undefined;
    const token = (authHeader ? authHeader.replace(/^Bearer\s+/i, '').trim() : '') || xApiKeyHeader?.trim() || '';

    if (!token) {
      return reply.status(401).send({
        error: {
          message: 'Missing API Key. Please provide Authorization: Bearer <key> or x-api-key header.',
          type: 'invalid_request_error',
          code: 'missing_api_key',
        },
      });
    }

    const validation = validateApiKey(token, activeConfig);

    if (!validation.valid) {
      return reply.status(401).send({
        error: {
          message: validation.error || 'Invalid or disabled API Key',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      });
    }

    // Attach client identity onto request for tracing and logging
    (req as any).authInfo = validation;
  });

  // 1. Health check (Enriched with Circuit Breaker status)
  app.get('/health', async () => {
    const cbSummary = registry.getCircuitBreakerManager().getSummary();
    const isDegraded = cbSummary.tripped > 0;
    return {
      status: isDegraded ? (cbSummary.healthy === 0 ? 'outage' : 'degraded') : 'ok',
      version: APP_VERSION,
      timestamp: new Date().toISOString(),
      modelsRegistered: registry.getAllModels().length,
      circuitBreakers: {
        total: cbSummary.total,
        healthy: cbSummary.healthy,
        tripped: cbSummary.tripped,
        halfOpen: cbSummary.halfOpen,
      },
    };
  });

  // 1B. Circuit Breakers Inspection Endpoint
  app.get('/v1/health/circuit-breakers', async () => {
    return registry.getCircuitBreakerManager().getSummary();
  });

  // 1C. Reset Tripped Circuit Breakers (Admin recovery after quota top-up)
  app.post('/v1/health/circuit-breakers/reset', async (req) => {
    const query = req.query as { model?: string };
    const body = req.body as { model?: string } | undefined;
    const targetModel = query?.model || body?.model;
    const result = registry.getCircuitBreakerManager().reset(targetModel);
    return {
      status: 'ok',
      ...result,
    };
  });

  // 1D. Manually trip a model's circuit breaker (admin takes a model out of rotation from the console)
  app.post('/v1/health/circuit-breakers/trip', async (req, reply) => {
    const query = req.query as { model?: string };
    const body = (req.body || {}) as { model?: string; reason?: string; cooldownMs?: number };
    const targetModel = query?.model || body?.model;
    if (!targetModel) {
      return reply.status(400).send({ status: 'error', message: 'Model id is required (?model= or body.model)' });
    }
    const result = registry.getCircuitBreakerManager().trip(targetModel, {
      reason: body.reason,
      cooldownMs: typeof body.cooldownMs === 'number' ? body.cooldownMs : undefined,
    });
    return { status: 'ok', model: targetModel, ...result };
  });

  // 2. OpenAI-compatible Models list
  app.get('/v1/models', async () => {
    const virtualModels = [
      { id: 'auto', object: 'model', created: 1700000000, owned_by: 'opencode-router', description: 'Intelligent multi-tier cascading auto-router (Recommended Default)' },
      { id: 'auto-fast', object: 'model', created: 1700000000, owned_by: 'opencode-router', description: 'Force Fast & low-cost layer (~$0.2/M)' },
      { id: 'auto-flagship', object: 'model', created: 1700000000, owned_by: 'opencode-router', description: 'Force Flagship workhorse layer (~$3-$15/M)' },
      { id: 'auto-reasoning', object: 'model', created: 1700000000, owned_by: 'opencode-router', description: 'Force Deep Reasoning specialist layer (~$15-$60/M)' },
    ];

    const registered = registry.getAllModels().map(m => ({
      id: m.id,
      object: 'model',
      created: 1700000000,
      owned_by: m.provider,
      metadata: {
        tier: m.tier,
        pricing: m.pricing,
      },
    }));

    // Custom model combos: user-composed virtual models (config.combos),
    // routable exactly like the auto-* virtual models above.
    const comboModels = registry.getCombos().map(c => ({
      id: c.id,
      object: 'model',
      created: 1700000000,
      owned_by: 'opencode-router',
      description: `Custom model combo (${c.models.length} members, ${c.selection || 'priority'} selection)`,
    }));

    return {
      object: 'list',
      data: [...virtualModels, ...comboModels, ...registered],
    };
  });

  // 2B. Single model lookup (OpenAI standard)
  app.get('/v1/models/:model', async (req, reply) => {
    const { model } = req.params as { model: string };
    const all = registry.getAllModels();
    const found = all.find(m => m.id === model) ||
      ['auto', 'auto-fast', 'auto-flagship', 'auto-reasoning'].includes(model) ||
      registry.isCombo(model);

    if (!found) {
      return reply.status(404).send({
        error: { message: `Model '${model}' not found`, type: 'invalid_request_error' },
      });
    }

    return {
      id: model,
      object: 'model',
      created: 1700000000,
      owned_by: typeof found === 'object' ? found.provider : 'opencode-router',
    };
  });

  // 3. FinOps Economics & Analytics Dashboard
  app.get('/v1/metrics', async () => {
    return orchestrator.getTracker().getStats();
  });

  // Reset metrics
  app.post('/v1/metrics/reset', async () => {
    orchestrator.getTracker().reset();
    return { status: 'ok', message: 'Metrics reset successfully' };
  });

  // 3B. Active Learning Data Flywheel Statistics
  app.get('/v1/flywheel/stats', async () => {
    return orchestrator.getFlywheel()?.getStats() || { status: 'disabled' };
  });

  // 3C. Active Conversation Sessions Inspection (optional limit/offset pagination)
  app.get('/v1/sessions', async (req) => {
    const query = req.query as { limit?: string; offset?: string };
    const limit = query.limit !== undefined ? parseInt(query.limit, 10) : undefined;
    const offset = query.offset ? parseInt(query.offset, 10) : 0;

    const traceTracker = orchestrator.getTraceTracker();
    // Most recently active first — stable ordering for pagination
    const all = (orchestrator.getSessionManager()?.getAllSessions() || [])
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .map(s => ({
        ...s,
        traceCount: traceTracker.getTraceCountForSession(s.id),
      }));
    const data = limit === undefined ? all.slice(offset) : all.slice(offset, offset + limit);

    return {
      object: 'list',
      total: all.length,
      ...(limit !== undefined ? { limit } : {}),
      offset,
      data,
    };
  });

  // 3D. Single Session Details Query
  app.get('/v1/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = orchestrator.getSessionManager()?.getSession(id);
    if (!session) {
      return reply.status(404).send({
        error: {
          message: `Session '${id}' not found`,
          type: 'invalid_request_error',
        },
      });
    }

    const traces = orchestrator.getTraceTracker().getTracesBySession(id);
    return {
      object: 'session',
      ...session,
      traceCount: traces.length,
      recentTraces: traces.slice(-5),
    };
  });

  // 3E. Delete / Reset Single Session
  app.delete('/v1/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const sessionMgr = orchestrator.getSessionManager();
    const existed = sessionMgr?.deleteSession(id);
    orchestrator.getTraceTracker().deleteBySession(id);

    if (!existed) {
      return reply.status(404).send({
        error: {
          message: `Session '${id}' not found`,
          type: 'invalid_request_error',
        },
      });
    }

    return {
      status: 'ok',
      message: `Session '${id}' and its traces have been successfully cleared`,
    };
  });

  // 3F. Query Trajectory / Traces by Session ID
  app.get('/v1/sessions/:id/traces', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = orchestrator.getSessionManager()?.getSession(id);
    const traces = orchestrator.getTraceTracker().getTracesBySession(id);
    
    // Return empty list or session trajectory
    return {
      object: 'list',
      sessionId: id,
      sessionExists: Boolean(session),
      total: traces.length,
      data: traces,
    };
  });

  // 3G. Global Request Trajectory Queries (with optional session_id filter & pagination)
  app.get('/v1/traces', async (req) => {
    const query = req.query as { session_id?: string; limit?: string; offset?: string };
    const limit = query.limit ? parseInt(query.limit, 10) : 50;
    const offset = query.offset ? parseInt(query.offset, 10) : 0;

    const result = orchestrator.getTraceTracker().getRecentTraces({
      sessionId: query.session_id,
      limit,
      offset,
    });

    return {
      object: 'list',
      total: result.total,
      limit,
      offset,
      data: result.data,
    };
  });

  // 3H. Query Single Execution Trace by traceId
  app.get('/v1/traces/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const trace = orchestrator.getTraceTracker().getTrace(id);
    if (!trace) {
      return reply.status(404).send({
        error: {
          message: `Trace '${id}' not found`,
          type: 'invalid_request_error',
        },
      });
    }
    return {
      object: 'trace',
      ...trace,
    };
  });

  // 4. OpenAI-compatible Chat Completions
  app.post('/v1/chat/completions', async (req, reply) => {
    const body = req.body as ChatCompletionRequest;

    if (!body || !body.messages || !Array.isArray(body.messages)) {
      return reply.status(400).send({
        error: {
          message: 'Invalid request: "messages" array is required.',
          type: 'invalid_request_error',
        },
      });
    }

    const requestedModel = body.model?.trim() || 'auto';

    // Model name routing resolution:
    // 'auto', 'default' or unconfigured third-party defaults -> full 4-step cascading auto router!
    if (requestedModel === 'auto-fast') {
      body.router_options = { ...body.router_options, force_tier: 'fast' };
    } else if (requestedModel === 'auto-flagship') {
      body.router_options = { ...body.router_options, force_tier: 'flagship' };
    } else if (requestedModel === 'auto-reasoning') {
      body.router_options = { ...body.router_options, force_tier: 'reasoning' };
    } else if (requestedModel === 'auto' || requestedModel === 'default') {
      // Intentionally standard: let RouterEngine 4-step pipeline handle intelligent tier selection
    } else {
      // Check if user specified a concrete physical model registered in the system
      const specificModel = registry.getModel(requestedModel);
      if (specificModel) {
        body.router_options = { ...body.router_options, force_tier: specificModel.tier };
      }
      // If client sent common client default like 'gpt-3.5-turbo' or 'gpt-4', default to 'auto'
    }

    try {
      const result = await orchestrator.process(body, {
        clientIp: req.ip,
        headers: req.headers,
        wire: 'chat',
      });

      const tierHeader = result.tierUsed + (result.fallbackOccurred ? '-escalated' : '');

      // Primary OCR Headers
      reply.header('X-OCR-Tier', tierHeader);
      reply.header('X-OCR-Layer', result.layerUsed || 'layer0');
      reply.header('X-OCR-Model', result.modelUsed);
      reply.header('X-OCR-Failover', result.failoverOccurred ? 'true' : 'false');
      reply.header('X-OCR-Failover-Attempts', (result.failoverAttempts || 1).toString());
      reply.header('X-OCR-Failover-Path', result.failoverPath?.join(' -> ') || '');
      reply.header('X-OCR-InPlace-Retries', (result.inplaceRetries || 0).toString());
      reply.header('X-OCR-Breaker-State', result.breakerState || 'CLOSED');
      reply.header('X-OCR-Session-ID', result.sessionId || '');
      reply.header('X-OCR-Session-Ratchet', result.sessionRatchetApplied ? 'true' : 'false');
      reply.header('X-OCR-Session-Lookup', result.sessionLookupType || '');
      reply.header('X-OCR-Trace-ID', result.traceId || '');
      reply.header('X-OCR-Cost-USD', result.costUsd.toFixed(6));
      reply.header('X-OCR-Saved-USD', result.savedCostUsd.toFixed(6));
      reply.header('X-OCR-Latency-MS', result.latencyMs.toString());

      // -------------------------------------------------------------
      // SSE Streaming Mode (stream: true)
      // -------------------------------------------------------------
      if (body.stream) {
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
          'X-OCR-Tier': tierHeader,
          'X-OCR-Layer': result.layerUsed || 'layer0',
          'X-OCR-Model': result.modelUsed,
          'X-OCR-Failover': result.failoverOccurred ? 'true' : 'false',
          'X-OCR-Failover-Attempts': (result.failoverAttempts || 1).toString(),
          'X-OCR-Failover-Path': result.failoverPath?.join(' -> ') || '',
          'X-OCR-InPlace-Retries': (result.inplaceRetries || 0).toString(),
          'X-OCR-Breaker-State': result.breakerState || 'CLOSED',
          'X-OCR-Session-ID': result.sessionId || '',
          'X-OCR-Session-Ratchet': result.sessionRatchetApplied ? 'true' : 'false',
          'X-OCR-Session-Lookup': result.sessionLookupType || '',
          'X-OCR-Trace-ID': result.traceId || '',
          'X-OCR-Cost-USD': result.costUsd.toFixed(6),
          'X-OCR-Saved-USD': result.savedCostUsd.toFixed(6),
          'X-OCR-Latency-MS': result.latencyMs.toString(),
        });

        for (const chunk of buildChatStreamChunks(result.response, result.modelUsed)) {
          reply.raw.write(chunk);
        }
        reply.raw.write('data: [DONE]\n\n');
        reply.raw.end();
        return reply;
      }

      // Non-streaming standard JSON response
      return reply.send(result.response);
    } catch (err: any) {
      req.log.error(err, 'Chat completion execution failed');
      const status = Number.isInteger(err?.statusCode) && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
      return reply.status(status).send({
        error: {
          message: err.message || 'Internal Router Error',
          type: status >= 500 ? 'api_error' : 'invalid_request_error',
        },
      });
    }
  });

  return { app, orchestrator, registry, tracker };
}
