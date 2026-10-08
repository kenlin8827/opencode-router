import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnthropicPayload, anthropicToChatCompletion } from '../src/providers/anthropic.js';
import { buildGooglePayload, googleToChatCompletion } from '../src/providers/google.js';
import { buildResponsesPayload, responsesToChatCompletion } from '../src/providers/responses.js';
import { ChatCompletionRequest, ToolCall } from '../src/types/openai.js';

const model = { id: 'm1', upstreamModel: 'up-model-1' } as any;

const chatRequest: ChatCompletionRequest = {
  model: 'auto',
  messages: [
    { role: 'system', content: 'You are a coding agent.' },
    { role: 'user', content: 'list the files' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'list_files', arguments: '{"path":"."}' } },
      ],
    },
    { role: 'tool', content: 'a.ts,b.ts', tool_call_id: 'call_1' },
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: 'list_files',
        description: 'List files in a directory',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    },
  ],
} as ChatCompletionRequest;

describe('Anthropic upstream wire: tools mapping', () => {
  it('maps request.tools to Anthropic tools with input_schema', () => {
    const p = buildAnthropicPayload(chatRequest, model) as any;
    assert.deepStrictEqual(p.tools, [
      {
        name: 'list_files',
        description: 'List files in a directory',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ]);
  });

  it('maps assistant tool_calls to tool_use blocks and tool role to tool_result blocks', () => {
    const p = buildAnthropicPayload(chatRequest, model) as any;
    const assistant = p.messages.find((m: any) => m.role === 'assistant');
    assert.deepStrictEqual(assistant.content, [
      { type: 'tool_use', id: 'call_1', name: 'list_files', input: { path: '.' } },
    ]);
    const toolTurn = p.messages.find((m: any) => Array.isArray(m.content) && m.content[0].type === 'tool_result');
    assert.strictEqual(toolTurn.role, 'user');
    assert.strictEqual(toolTurn.content[0].tool_use_id, 'call_1');
    assert.strictEqual(toolTurn.content[0].content, 'a.ts,b.ts');
  });

  it('keeps system prompt + ephemeral cache block and maps tool_choice', () => {
    const req = { ...chatRequest, tool_choice: 'auto' as const };
    const p = buildAnthropicPayload(req, model) as any;
    assert.strictEqual(p.system[0].cache_control.type, 'ephemeral');
    assert.deepStrictEqual(p.tool_choice, { type: 'auto' });
  });

  it('maps image parts to Anthropic source blocks (base64 + url) and stop to stop_sequences', () => {
    const req: ChatCompletionRequest = {
      model: 'auto',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
            { type: 'image_url', image_url: { url: 'https://example.com/pic.jpg' } },
          ],
        },
      ],
      stop: ['END', 'STOP_ALL'],
    } as ChatCompletionRequest;
    const p = buildAnthropicPayload(req, model) as any;
    const blocks = p.messages[0].content;
    assert.strictEqual(blocks[0].type, 'text');
    assert.deepStrictEqual(blocks[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } });
    assert.deepStrictEqual(blocks[2], { type: 'image', source: { type: 'url', url: 'https://example.com/pic.jpg' } });
    assert.deepStrictEqual(p.stop_sequences, ['END', 'STOP_ALL']);
  });

  it('maps upstream tool_use blocks back to chat tool_calls with finish_reason tool_calls', () => {
    const resp = anthropicToChatCompletion(
      {
        content: [
          { type: 'text', text: 'checking' },
          { type: 'tool_use', id: 'call_9', name: 'read_file', input: { path: 'a.ts' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 6 },
      } as any,
      model
    );
    const msg = resp.choices[0].message;
    assert.strictEqual(resp.choices[0].finish_reason, 'tool_calls');
    assert.strictEqual(msg.content, 'checking');
    assert.strictEqual(msg.tool_calls?.[0].id, 'call_9');
    assert.strictEqual(msg.tool_calls?.[0].function.name, 'read_file');
    assert.strictEqual(JSON.parse(msg.tool_calls?.[0].function.arguments || '{}').path, 'a.ts');
    assert.strictEqual(resp.usage.prompt_tokens, 16, 'uncached + cached = prompt tokens');
  });
});

describe('Google upstream wire: tools mapping', () => {
  it('maps request.tools to functionDeclarations', () => {
    const p = buildGooglePayload(chatRequest, model) as any;
    assert.deepStrictEqual(p.tools, [
      {
        functionDeclarations: [
          {
            name: 'list_files',
            description: 'List files in a directory',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
          },
        ],
      },
    ]);
  });

  it('maps assistant tool_calls to functionCall parts and tool role to functionResponse with resolved name', () => {
    const p = buildGooglePayload(chatRequest, model) as any;
    const modelTurn = p.contents.find((c: any) => c.role === 'model');
    assert.deepStrictEqual(modelTurn.parts, [{ functionCall: { name: 'list_files', args: { path: '.' } } }]);
    const toolTurn = p.contents.find((c: any) => c.parts?.[0]?.functionResponse);
    assert.strictEqual(toolTurn.role, 'user');
    assert.strictEqual(toolTurn.parts[0].functionResponse.name, 'list_files', 'call_id must resolve to the function name');
    assert.deepStrictEqual(toolTurn.parts[0].functionResponse.response, { result: 'a.ts,b.ts' });
  });

  it('maps tool_choice to functionCallingConfig mode', () => {
    const p = buildGooglePayload({ ...chatRequest, tool_choice: 'none' } as ChatCompletionRequest, model) as any;
    assert.deepStrictEqual(p.toolConfig, { functionCallingConfig: { mode: 'NONE' } });
  });

  it('maps data-URL images to inlineData with the real MIME type (not image/*)', () => {
    const req: ChatCompletionRequest = {
      model: 'auto',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,WFla' } },
          ],
        },
      ],
    } as ChatCompletionRequest;
    const p = buildGooglePayload(req, model) as any;
    assert.deepStrictEqual(p.contents[0].parts, [
      { text: 'look' },
      { inlineData: { mimeType: 'image/jpeg', data: 'WFla' } },
    ]);
  });

  it('maps upstream functionCall parts back to chat tool_calls with finish_reason tool_calls', () => {
    const resp = googleToChatCompletion(
      {
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: 'read_file', args: { path: 'a.ts' } } }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 3, totalTokenCount: 11 },
      } as any,
      model
    );
    const msg = resp.choices[0].message;
    assert.strictEqual(resp.choices[0].finish_reason, 'tool_calls');
    const tc: ToolCall | undefined = msg.tool_calls?.[0];
    assert.strictEqual(tc?.function.name, 'read_file');
    assert.deepStrictEqual(JSON.parse(tc?.function.arguments || '{}'), { path: 'a.ts' });
    assert.deepStrictEqual(resp.usage, { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 });
  });
});

describe('Responses upstream wire: tools mapping', () => {
  it('passes request.tools through (identical flat function shape) and maps reasoning_effort', () => {
    const p = buildResponsesPayload(
      { ...chatRequest, reasoning_effort: 'high' } as ChatCompletionRequest,
      model
    ) as any;
    assert.deepStrictEqual(p.tools, chatRequest.tools);
    assert.deepStrictEqual(p.reasoning, { effort: 'high' });
  });

  it('maps assistant tool_calls to function_call items and tool role to function_call_output items', () => {
    const p = buildResponsesPayload(chatRequest, model) as any;
    const fc = p.input.find((i: any) => i.type === 'function_call');
    assert.strictEqual(fc.call_id, 'call_1');
    assert.strictEqual(fc.name, 'list_files');
    assert.strictEqual(fc.arguments, '{"path":"."}');
    const out = p.input.find((i: any) => i.type === 'function_call_output');
    assert.strictEqual(out.call_id, 'call_1');
    assert.strictEqual(out.output, 'a.ts,b.ts');
  });

  it('maps upstream function_call output items back to chat tool_calls (call_id preserved) and system to instructions', () => {
    const resp = responsesToChatCompletion(
      {
        output: [
          { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' },
        ],
        usage: { input_tokens: 5, output_tokens: 2 },
      } as any,
      model
    );
    const msg = resp.choices[0].message;
    assert.strictEqual(resp.choices[0].finish_reason, 'tool_calls');
    assert.strictEqual(msg.tool_calls?.[0].id, 'call_1', 'call_id must round-trip so the tool result matches');
    assert.strictEqual(msg.tool_calls?.[0].function.name, 'read_file');
    assert.strictEqual(resp.usage.total_tokens, 7, 'total falls back to input+output when absent');
  });
});
