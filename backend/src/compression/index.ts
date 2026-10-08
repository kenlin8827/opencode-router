/**
 * Token Saver pipeline: three independent, individually toggleable stages
 * applied to the canonical request inside PipelineOrchestrator.process(),
 * after prompt normalization and session resolution, before routing and
 * execution:
 *
 *   1. rtk      — compresses tool-result text (git/grep/ls/logs/build
 *                 output) with local deterministic compressors. Deterministic
 *                 per content ⇒ the compressed prefix stays byte-stable
 *                 across turns, leaving upstream KV/prefix caches intact.
 *   2. headroom — whole-context compression via the headroom sidecar's
 *                 POST /v1/compress (fail-open). Session mode
 *                 (config.session_id = this gateway's own session id)
 *                 replays a byte-identical prefix across turns.
 *   3. caveman  — terse-style system-prompt injection to cut output tokens.
 *
 * Every stage fails open: any error lets the original request pass through.
 */
import { ChatCompletionRequest } from '../types/openai.js';
import { CompressionConfig } from '../config/types.js';
import { compressToolOutputs, formatCompressionLog, CompressionStats } from './tool-output.js';
import { compressWithHeadroom, formatHeadroomLog, HeadroomResult } from './headroom.js';
import { injectCaveman } from './caveman.js';

export interface CompressionOutcome {
  rtk: CompressionStats | null;
  headroom: HeadroomResult | null;
  cavemanInjected: boolean;
}

/**
 * Apply enabled compression stages to `request` (mutates messages in place).
 * `sessionId` is the gateway's own zero-header session id; when present it
 * is forwarded to headroom's session mode.
 */
export async function applyCompression(
  request: ChatCompletionRequest,
  config: CompressionConfig | undefined,
  sessionId?: string
): Promise<CompressionOutcome> {
  const outcome: CompressionOutcome = { rtk: null, headroom: null, cavemanInjected: false };
  if (!config || config.enabled === false) return outcome;

  // 1. rtk tool-output compression (sync, deterministic, in-process)
  outcome.rtk = compressToolOutputs(request, config.rtk?.enabled);
  const rtkLog = formatCompressionLog(outcome.rtk);
  if (rtkLog) console.log(rtkLog);

  // 2. headroom sidecar whole-context compression (async, fail-open)
  if (config.headroom?.enabled && config.headroom.url) {
    const result = await compressWithHeadroom(
      request.messages,
      request.model,
      config.headroom,
      sessionId
    );
    if (result) {
      request.messages = result.messages;
      outcome.headroom = result;
      const hrLog = formatHeadroomLog(result);
      if (hrLog) console.log(hrLog);
    }
  }

  // 3. caveman output-style injection (sync, idempotent)
  if (config.caveman?.enabled) {
    const level = config.caveman.level ?? 'full';
    outcome.cavemanInjected = injectCaveman(request, level);
    if (outcome.cavemanInjected) {
      console.log(`[compression:caveman] injected level=${level}`);
    }
  }

  return outcome;
}

export type { CompressionStats } from './tool-output.js';
export type { HeadroomResult } from './headroom.js';
export { CAVEMAN_LEVELS } from './caveman-prompts.js';
export type { CavemanLevel } from './caveman-prompts.js';
