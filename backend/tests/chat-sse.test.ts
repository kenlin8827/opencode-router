import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildChatStreamChunks } from '../src/utils/chat-sse.js';
import { ChatCompletionResponse } from '../src/types/openai.js';

function resp(overrides: Partial<ChatCompletionResponse['choices'][0]['message']> & { content?: string }): ChatCompletionResponse {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1700000000,
    model: 'up-model',
    choices: [
      { index: 0, message: { role: 'assistant', ...overrides } as any, finish_reason: overrides.tool_calls ? 'tool_calls' : 'stop' },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  } as ChatCompletionResponse;
}

describe('chat SSE synthesizer (streaming exchange)', () => {
  it('text responses: role chunk → content deltas → real finish_reason → [DONE] carries usage', () => {
    const chunks = buildChatStreamChunks(resp({ content: 'abcdefghij' }), 'served-model');
    const parsed = chunks.map((c) => JSON.parse(c.slice('data: '.length)));
    assert.strictEqual(parsed[0].choices[0].delta.role, 'assistant');
    assert.strictEqual(parsed.map((p) => p.choices[0].delta.content || '').join(''), 'abcdefghij');
    const finalChunk = parsed[parsed.length - 1];
    assert.strictEqual(finalChunk.choices[0].finish_reason, 'stop', 'text responses finish with stop');
    assert.deepStrictEqual(finalChunk.usage.total_tokens, 8, 'usage rides the final chunk');
    assert.ok(chunks.every((c) => c.endsWith('\n\n')));
  });

  it('tool-call responses: emit tool_call fragments per OpenAI spec and finish_reason tool_calls', () => {
    const chunks = buildChatStreamChunks(
      resp({
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
      }),
      'served-model'
    );
    const parsed = chunks.map((c) => JSON.parse(c.slice('data: '.length)));
    const fragments = parsed.map((p) => p.choices[0].delta.tool_calls).filter(Boolean).flat();
    assert.strictEqual(fragments[0].id, 'call_1', 'first fragment carries id');
    assert.strictEqual(fragments[0].function.name, 'read_file');
    assert.strictEqual(fragments.slice(1).map((f) => f.function.arguments).join(''), '{"path":"a.ts"}');
    const finalChunk = parsed[parsed.length - 1];
    assert.strictEqual(finalChunk.choices[0].finish_reason, 'tool_calls', 'hardcoded stop would break tool loops');
  });

  it('model id on every chunk is the SERVED model', () => {
    const chunks = buildChatStreamChunks(resp({ content: 'x' }), 'served-model');
    const parsed = chunks.map((c) => JSON.parse(c.slice('data: '.length)));
    assert.ok(parsed.every((p) => p.model === 'served-model'));
  });
});
