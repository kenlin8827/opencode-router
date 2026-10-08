/**
 * caveman injector: appends the selected level's terse-style prompt to the
 * request's system message, compressing the model's output tokens.
 *
 * By the time this runs, the request is already in the canonical OpenAI
 * shape and PromptOptimizer has merged system messages at index 0 — so
 * injection is "append to the first system/developer message, or create one
 * at the head".
 *
 * Idempotency: retries / failover re-enter the pipeline with the same
 * message array, so injection must happen at most once (exact SEP-segment
 * match, not substring — a substring check could false-positive on prose).
 */
import { ChatCompletionRequest, ChatMessage } from '../types/openai.js';
import { CAVEMAN_PROMPTS, isCavemanLevel } from './caveman-prompts.js';

const SEP = '\n\n';

/** Exact match: the prompt exists as its own SEP-delimited segment (or the whole string). */
function containsSegment(haystack: string | undefined, segment: string): boolean {
  if (!haystack) return false;
  if (haystack === segment) return true;
  return haystack.split(SEP).includes(segment);
}

function messageContains(msg: ChatMessage, segment: string): boolean {
  const c = msg.content;
  if (typeof c === 'string') return containsSegment(c, segment);
  if (Array.isArray(c)) {
    return c.some(part => part && part.type === 'text' && containsSegment(part.text, segment));
  }
  return false;
}

function appendSegment(msg: ChatMessage, segment: string): void {
  const c = msg.content;
  if (typeof c === 'string') {
    msg.content = c ? `${c}${SEP}${segment}` : segment;
    return;
  }
  if (Array.isArray(c)) {
    c.push({ type: 'text', text: segment });
    return;
  }
  msg.content = segment;
}

/** Inject the caveman prompt; returns false (request untouched) when already injected / invalid level / bad request. */
export function injectCaveman(request: ChatCompletionRequest, level?: string): boolean {
  if (!request || !Array.isArray(request.messages)) return false;
  if (!isCavemanLevel(level)) return false;
  const prompt = CAVEMAN_PROMPTS[level];

  try {
    const idx = request.messages.findIndex(m => m && (m.role === 'system' || m.role === 'developer'));
    if (idx >= 0) {
      const msg = request.messages[idx];
      if (messageContains(msg, prompt)) return false;
      appendSegment(msg, prompt);
      return true;
    }
    request.messages.unshift({ role: 'system', content: prompt });
    return true;
  } catch {
    return false; // fail-open (frozen/proxied bodies and other odd shapes)
  }
}
