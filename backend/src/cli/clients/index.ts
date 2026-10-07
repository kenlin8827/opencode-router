import { ClientAdapter } from './base.js';
import { OpenCodeClientAdapter } from './opencode.js';
import { ClaudeClientAdapter } from './claude.js';
import { CodexClientAdapter } from './codex.js';
import { ClientHookStatus, SupportedClient } from '../types.js';

const adapters: Record<SupportedClient, ClientAdapter> = {
  opencode: new OpenCodeClientAdapter(),
  claude: new ClaudeClientAdapter(),
  codex: new CodexClientAdapter(),
};

export function getClientAdapter(name: string): ClientAdapter | null {
  const normalized = name.toLowerCase().trim() as SupportedClient;
  return adapters[normalized] || null;
}

export function getAllClientAdapters(): ClientAdapter[] {
  return Object.values(adapters);
}

export function getAllClientStatuses(): ClientHookStatus[] {
  return getAllClientAdapters().map(adapter => adapter.getStatus());
}

export async function setupClient(
  name: string,
  options?: { port?: number; models?: Record<string, string> }
): Promise<{ success: boolean; message: string }> {
  const adapter = getClientAdapter(name);
  if (!adapter) {
    return {
      success: false,
      message: `Unknown client '${name}'. Supported clients: ${Object.keys(adapters).join(', ')}`,
    };
  }
  return adapter.setup(options);
}

export async function teardownClient(name: string): Promise<{ success: boolean; message: string }> {
  const adapter = getClientAdapter(name);
  if (!adapter) {
    return {
      success: false,
      message: `Unknown client '${name}'. Supported clients: ${Object.keys(adapters).join(', ')}`,
    };
  }
  return adapter.teardown();
}
