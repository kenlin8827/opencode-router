import { ChatCompletionResponse } from '../types/openai.js';

/**
 * Pure OpenAI `chat.completion.chunk` synthesizer for one buffered completion
 * (the gateway executes non-streaming upstream calls and re-chunks for
 * streaming clients).
 *
 * Emits: role chunk → content deltas → tool_call fragments → final chunk with
 * the REAL finish_reason. Tool fragments follow the OpenAI streaming spec
 * (first fragment carries index/id/type/name, then argument chunks). A
 * hardcoded finish_reason 'stop' would silently break streaming tool-loop
 * clients — the real reason must ride the final chunk.
 */
export function buildChatStreamChunks(response: ChatCompletionResponse, model: string): string[] {
  const choice = response.choices?.[0];
  const message = choice?.message;
  const id = response.id || `chatcmpl-${Date.now()}`;
  const created = response.created || Math.floor(Date.now() / 1000);
  const chunks: string[] = [];
  const push = (delta: Record<string, any>, finishReason: string | null, withUsage = false) => {
    const chunk: any = {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    if (withUsage) chunk.usage = response.usage;
    chunks.push(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  push({ role: 'assistant', content: '' }, null);

  const text = typeof message?.content === 'string' ? message.content : '';
  const chunkSize = 4;
  for (let i = 0; i < text.length; i += chunkSize) {
    push({ content: text.slice(i, i + chunkSize) }, null);
  }

  const toolCalls = message?.tool_calls || [];
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    push(
      { tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: '' } }] },
      null
    );
    const args = tc.function.arguments || '';
    const argChunk = 32;
    for (let j = 0; j < args.length; j += argChunk) {
      push({ tool_calls: [{ index: i, function: { arguments: args.slice(j, j + argChunk) } }] }, null);
    }
  }

  const finishReason = toolCalls.length ? 'tool_calls' : (choice?.finish_reason as string) || 'stop';
  push({}, finishReason, true);
  return chunks;
}
