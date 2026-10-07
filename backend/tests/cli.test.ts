import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from '../src/server.js';
import { OpenCodeClientAdapter } from '../src/cli/clients/opencode.js';
import { ClaudeClientAdapter } from '../src/cli/clients/claude.js';
import { CodexClientAdapter } from '../src/cli/clients/codex.js';

describe('CLI Client Setup & Teardown Adapters', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('OpenCode adapter should safely setup and teardown with backup restoration', async () => {
    const configPath = path.join(tmpDir, 'opencode.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ $schema: 'https://opencode.ai/config.json', provider: {}, model: 'anthropic/claude-sonnet-4' }, null, 2)
    );

    const adapter = new OpenCodeClientAdapter();
    adapter.getConfigPath = () => configPath;

    // Initial status
    let status = adapter.getStatus();
    expect(status.exists).toBe(true);
    expect(status.hooked).toBe(false);

    // Setup
    const setupRes = await adapter.setup({ port: 4000 });
    expect(setupRes.success).toBe(true);
    expect(fs.existsSync(`${configPath}.bak.ocr`)).toBe(true);

    status = adapter.getStatus();
    expect(status.hooked).toBe(true);

    const updated = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    // Correct OpenCode v2 schema: singular `provider` node + top-level `model`
    expect(updated.provider['opencode-router'].options.baseURL).toBe('http://127.0.0.1:4000/v1');
    expect(updated.model).toBe('opencode-router/auto');

    // Teardown
    const teardownRes = await adapter.teardown();
    expect(teardownRes.success).toBe(true);

    status = adapter.getStatus();
    expect(status.hooked).toBe(false);

    const restored = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(restored.model).toBe('anthropic/claude-sonnet-4');
    expect(restored.provider['opencode-router']).toBeUndefined();
  });

  it('OpenCode adapter must preserve JSONC comments on setup', async () => {
    const configPath = path.join(tmpDir, 'opencode.jsonc');
    fs.writeFileSync(
      configPath,
      [
        '{',
        '  // My personal OpenCode settings — do not reformat!',
        '  "model": "zhipuai-coding-plan/glm-5.3-flash",',
        '  "provider": {',
        '    // self-hosted gateway',
        '    "home-lab": { "npm": "@ai-sdk/openai-compatible", "options": { "baseURL": "http://192.168.1.10/v1" } }',
        '  }',
        '}',
      ].join('\n'),
      'utf8'
    );

    const adapter = new OpenCodeClientAdapter();
    adapter.getConfigPath = () => configPath;

    const setupRes = await adapter.setup({ port: 4000 });
    expect(setupRes.success).toBe(true);

    const raw = fs.readFileSync(configPath, 'utf8');
    expect(raw).toContain('// My personal OpenCode settings');
    expect(raw).toContain('// self-hosted gateway');

    const parsed = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
    expect(parsed.provider['home-lab'].options.baseURL).toBe('http://192.168.1.10/v1');
    expect(parsed.provider['opencode-router'].options.baseURL).toBe('http://127.0.0.1:4000/v1');
  });

  it('Claude adapter should safely inject ANTHROPIC_BASE_URL and restore', async () => {
    const configPath = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(configPath, JSON.stringify({ env: { SOME_KEY: 'test' } }, null, 2));

    const adapter = new ClaudeClientAdapter();
    adapter.getConfigPath = () => configPath;

    let status = adapter.getStatus();
    expect(status.hooked).toBe(false);

    // Setup
    const setupRes = await adapter.setup({ port: 4000 });
    expect(setupRes.success).toBe(true);
    expect(fs.existsSync(`${configPath}.bak.ocr`)).toBe(true);

    status = adapter.getStatus();
    expect(status.hooked).toBe(true);

    const updated = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(updated.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:4000');

    // Teardown
    const teardownRes = await adapter.teardown();
    expect(teardownRes.success).toBe(true);

    status = adapter.getStatus();
    expect(status.hooked).toBe(false);

    const restored = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(restored.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(restored.env.SOME_KEY).toBe('test');
  });

  it('Codex adapter should safely redirect baseUrl and revert', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' }, null, 2));

    const adapter = new CodexClientAdapter();
    adapter.getConfigPath = () => configPath;

    let status = adapter.getStatus();
    expect(status.hooked).toBe(false);

    const setupRes = await adapter.setup({ port: 4000 });
    expect(setupRes.success).toBe(true);

    status = adapter.getStatus();
    expect(status.hooked).toBe(true);

    const updated = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(updated.baseUrl).toBe('http://127.0.0.1:4000/v1');

    const teardownRes = await adapter.teardown();
    expect(teardownRes.success).toBe(true);

    status = adapter.getStatus();
    expect(status.hooked).toBe(false);

    const restored = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(restored.baseUrl).toBe('https://api.openai.com/v1');
  });
});

describe('Embedded UI & Management API Endpoints', () => {
  const dummyConfig: any = {
    port: 4000,
    host: '127.0.0.1',
    models: [],
    classifier: { localModel: false },
    rateLimit: { maxRequestsPerMinute: 1000 },
  };

  it('should serve HTML UI on GET / and /ui', async () => {
    const { app } = createServer(dummyConfig, true);
    const resRoot = await app.inject({ method: 'GET', url: '/' });
    expect(resRoot.statusCode).toBe(200);
    expect(resRoot.headers['content-type']).toContain('text/html');
    expect(resRoot.body).toContain('OpenCode Router');
    expect(resRoot.body).toContain('Gateway Console');

    const resUi = await app.inject({ method: 'GET', url: '/ui' });
    expect(resUi.statusCode).toBe(200);
    expect(resUi.body).toContain('OpenCode Router');

    const resTiers = await app.inject({ method: 'GET', url: '/tiers' });
    expect(resTiers.statusCode).toBe(200);
    expect(resTiers.headers['content-type']).toContain('text/html');

    const resKeys = await app.inject({ method: 'GET', url: '/providers' });
    expect(resKeys.statusCode).toBe(200);
    expect(resKeys.headers['content-type']).toContain('text/html');

    // legacy alias still serves the SPA
    const resKeysAlias = await app.inject({ method: 'GET', url: '/keys' });
    expect(resKeysAlias.statusCode).toBe(200);
  });

  it('should return aggregated status on GET /api/ui/status', async () => {
    const { app } = createServer(dummyConfig, true);
    const res = await app.inject({ method: 'GET', url: '/api/ui/status' });
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.status).toBe('ok');
    expect(json.metrics).toBeDefined();
    expect(json.circuitBreakers).toBeDefined();
    expect(Array.isArray(json.clients)).toBe(true);
    expect(json.clients.length).toBe(3);
  });

  it('should support reading and validating raw YAML config on /api/ui/config/raw', async () => {
    const { app } = createServer(dummyConfig, true);
    const resGet = await app.inject({ method: 'GET', url: '/api/ui/config/raw' });
    expect(resGet.statusCode).toBe(200);
    const json = JSON.parse(resGet.body);
    expect(json.status).toBe('ok');
    expect(json.yaml).toContain('port:');

    // Test saving invalid YAML
    const resInvalid = await app.inject({
      method: 'POST',
      url: '/api/ui/config/raw',
      payload: { yaml: 'invalid: : yaml: [' },
    });
    expect(resInvalid.statusCode).toBe(400);
  });

  it('should probe provider ping connectivity on /api/ui/providers/test', async () => {
    const { app } = createServer(dummyConfig, true);
    const res = await app.inject({
      method: 'POST',
      url: '/api/ui/providers/test',
      payload: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-invalid-test-key' },
    });
    expect(res.statusCode).toBe(404);
  });
});
