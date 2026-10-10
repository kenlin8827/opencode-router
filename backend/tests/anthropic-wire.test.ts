import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { anthropicToOpenAI, openAIToAnthropic, chatToAnthropicStreamEvents } from '../src/routes/anthropic.js';
import { ChatCompletionResponse } from '../src/types/openai.js';

describe('Anthropic inbound wire: request conversion with tools', () => {
  it('maps body.tools to chat tools (input_schema → parameters)', () => {
    const { request, error } = anthropicToOpenAI({
      model: 'claude-x',
      max_tokens: 100,
      tools: [
        {
          name: 'list_files',
          description: 'List files in a directory',
          input_schema: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
      messages: [{ role: 'user', content: 'list the files' }],
    } as any);
    assert.strictEqual(error, undefined);
    assert.deepStrictEqual(request?.tools, [
      {
        type: 'function',
        function: {
          name: 'list_files',
          description: 'List files in a directory',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      },
    ]);
  });

  it('maps assistant tool_use blocks to chat tool_calls and tool_result to tool messages', () => {
    const { request } = anthropicToOpenAI({
      model: 'claude-x',
      max_tokens: 100,
      messages: [
        { role: 'user', content: 'list the files' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'checking' },
            { type: 'tool_use', id: 'call_1', name: 'list_files', input: { path: '.' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'a.ts,b.ts' }],
        },
      ],
    } as any);
    assert.strictEqual(request!.messages.length, 3);
    const assistant = request!.messages[1];
    assert.strictEqual(assistant.role, 'assistant');
    assert.strictEqual(assistant.content, 'checking');
    assert.strictEqual(assistant.tool_calls?.[0].id, 'call_1');
    assert.strictEqual(assistant.tool_calls?.[0].function.name, 'list_files');
    assert.deepStrictEqual(JSON.parse(assistant.tool_calls?.[0].function.arguments || '{}'), { path: '.' });
    const toolMsg = request!.messages[2];
    assert.strictEqual(toolMsg.role, 'tool');
    assert.strictEqual(toolMsg.tool_call_id, 'call_1');
    assert.strictEqual(toolMsg.content, 'a.ts,b.ts');
  });

  it('keeps metadata.user_id → user mapping (embedded session UUID layer input)', () => {
    const { request } = anthropicToOpenAI({
      model: 'claude-x',
      max_tokens: 10,
      metadata: { user_id: 'user_abc_account_xyz_session_6f978fa1-8a13-4a42-9f77-65bef0e6802f' },
      messages: [{ role: 'user', content: 'hi' }],
    } as any);
    assert.strictEqual(request?.user, 'user_abc_account_xyz_session_6f978fa1-8a13-4a42-9f77-65bef0e6802f');
  });

  it('maps thinking.type=enabled + budget_tokens to max_thinking_tokens', () => {
    const { request } = anthropicToOpenAI({
      model: 'claude-x',
      max_tokens: 100,
      thinking: { type: 'enabled', budget_tokens: 5000 },
      messages: [{ role: 'user', content: 'hi' }],
    } as any);
    assert.strictEqual(request?.max_thinking_tokens, 5000);
  });

  it('omits max_thinking_tokens when thinking.type=adaptive (no budget to forward)', () => {
    const { request } = anthropicToOpenAI({
      model: 'claude-x',
      max_tokens: 100,
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: 'hi' }],
    } as any);
    assert.strictEqual(request?.max_thinking_tokens, undefined);
  });

  it('omits max_thinking_tokens when no thinking block is supplied', () => {
    const { request } = anthropicToOpenAI({
      model: 'claude-x',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    } as any);
    assert.strictEqual(request?.max_thinking_tokens, undefined);
  });

  it('thinking.type=disabled maps to reasoning_effort=none', () => {
    const { request } = anthropicToOpenAI({
      model: 'claude-x',
      max_tokens: 100,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: 'hi' }],
    } as any);
    assert.strictEqual(request?.reasoning_effort, 'none');
  });

  it('thinking.type=adaptive leaves both max_thinking_tokens and reasoning_effort unset', () => {
    const { request } = anthropicToOpenAI({
      model: 'claude-x',
      max_tokens: 100,
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: 'hi' }],
    } as any);
    assert.strictEqual(request?.max_thinking_tokens, undefined);
    assert.strictEqual(request?.reasoning_effort, undefined);
  });
});

describe('Anthropic inbound wire: response conversion with tools', () => {
  it('maps chat tool_calls to tool_use blocks with stop_reason tool_use', () => {
    const resp = {
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 1700000000,
      model: 'm1',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'checking',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'list_files', arguments: '{"path":"."}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    } as unknown as ChatCompletionResponse;

    const out = openAIToAnthropic(resp, 'claude-x') as any;
    assert.strictEqual(out.stop_reason, 'tool_use');
    assert.strictEqual(out.content[0].type, 'text');
    assert.strictEqual(out.content[0].text, 'checking');
    assert.strictEqual(out.content[1].type, 'tool_use');
    assert.strictEqual(out.content[1].id, 'call_1');
    assert.strictEqual(out.content[1].name, 'list_files');
    assert.deepStrictEqual(out.content[1].input, { path: '.' });
  });

  it('text-only responses keep the classic single text block', () => {
    const resp = {
      id: 'chatcmpl-2',
      object: 'chat.completion',
      created: 1700000000,
      model: 'm1',
      choices: [{ index: 0, message: { role: 'assistant', content: 'plain' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    } as unknown as ChatCompletionResponse;
    const out = openAIToAnthropic(resp, 'claude-x') as any;
    assert.deepStrictEqual(out.content, [{ type: 'text', text: 'plain' }]);
    assert.strictEqual(out.stop_reason, 'end_turn');
  });

  it('SSE synthesis emits tool_use blocks with input_json_delta on the streaming path', () => {
    const resp = {
      id: 'chatcmpl-3',
      object: 'chat.completion',
      created: 1700000000,
      model: 'm1',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'checking',
            tool_calls: [
              { id: 'call_7', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    } as unknown as ChatCompletionResponse;

    const events = chatToAnthropicStreamEvents(resp, 'claude-x');
    const types = events.map((e) => /^event: (.+)$/m.exec(e)?.[1]);
    assert.deepStrictEqual(types, [
      'message_start',
      'content_block_start', // text
      'content_block_delta', // text
      'content_block_delta',
      'content_block_stop',
      'content_block_start', // tool_use
      'content_block_delta', // input_json_delta
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    const toolStart = JSON.parse(events[5].split('data: ')[1]);
    assert.deepStrictEqual(toolStart.content_block, { type: 'tool_use', id: 'call_7', name: 'read_file', input: {} });
    const jsonDeltas = events
      .filter((e) => e.includes('input_json_delta'))
      .map((e) => JSON.parse(e.split('data: ')[1]).delta.partial_json);
    assert.strictEqual(jsonDeltas.join(''), '{"path":"a.ts"}', 'partial_json chunks must reassemble the arguments');
    const messageDelta = JSON.parse(events[8].split('data: ')[1]);
    assert.strictEqual(messageDelta.delta.stop_reason, 'tool_use');
  });

  it('SSE synthesis keeps pure-text responses on the classic single-block shape', () => {
    const resp = {
      id: 'chatcmpl-4',
      object: 'chat.completion',
      created: 1700000000,
      model: 'm1',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    } as unknown as ChatCompletionResponse;
    const events = chatToAnthropicStreamEvents(resp, 'claude-x');
    const types = events.map((e) => /^event: (.+)$/m.exec(e)?.[1]);
    assert.ok(!types!.some((t) => t === 'response.function_call_arguments.delta'));
    assert.strictEqual(types!.filter((t) => t === 'content_block_start').length, 1);
    const last = JSON.parse(events[events.length - 1].split('data: ')[1]);
    assert.strictEqual(last.type, 'message_stop');
  });
});
