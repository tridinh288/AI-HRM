import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenAiCompatibleProvider } from './openai.provider.js';
import { LlmError, type LlmChatResponse, type LlmMessage } from './types.js';

/**
 * Wire-format tests for the OpenAI-compatible adapter.
 *
 * This is the adapter that actually carries traffic — OpenAI, Groq, OpenRouter
 * and a local Ollama all speak this shape — yet the AI suite exercises only
 * `FakeLlmProvider`, so nothing here was covered. Its companion
 * `anthropic.provider.test.ts` explains the reasoning at more length.
 *
 * Two behaviours below matter more than the rest. `baseUrl` is used exactly as
 * configured, which is the whole reason a local model needs no code change; and
 * a tool call's `arguments` is a *string* the model generated token by token,
 * so malformed JSON has to be reported rather than thrown from inside a parse.
 */

const TOOLS = [
  { name: 'get_headcount', description: 'Total headcount', parameters: { type: 'object' } },
];

let sent: { url: string; body: Record<string, unknown>; headers: Record<string, string> } | null =
  null;

/** Stubs `fetch`, recording the request and replying with `payload`. */
function respondWith(payload: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string; headers: Record<string, string> }) => {
      sent = {
        url,
        body: JSON.parse(init.body) as Record<string, unknown>,
        headers: init.headers,
      };
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      };
    }),
  );
}

/** The shape the API returns for a plain text answer. */
function textReply(text: string): unknown {
  return { choices: [{ message: { content: text } }] };
}

/** The shape the API returns when the model wants a tool run. */
function toolCallReply(args: string): unknown {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'get_headcount', arguments: args } },
          ],
        },
      },
    ],
  };
}

function makeProvider(baseUrl = 'https://api.openai.com/v1'): OpenAiCompatibleProvider {
  return new OpenAiCompatibleProvider({
    apiKey: 'sk-test',
    baseUrl,
    model: 'gpt-4o-mini',
    timeoutMs: 30_000,
  });
}

function ask(
  provider: OpenAiCompatibleProvider,
  messages: LlmMessage[],
  tools = TOOLS,
): Promise<LlmChatResponse> {
  return provider.chat({ messages, tools, maxOutputTokens: 4096 });
}

beforeEach(() => {
  sent = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('endpoint and credentials', () => {
  it('calls whatever base URL it was configured with', async () => {
    // The reason a local Ollama server needs no code change: unlike the
    // Anthropic adapter, this one never rewrites the host.
    respondWith(textReply('hello'));

    await ask(makeProvider('http://localhost:11434/v1'), [{ role: 'user', content: 'hi' }]);

    expect(sent?.url).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('sends the API key as a bearer token', async () => {
    respondWith(textReply('hello'));

    await ask(makeProvider(), [{ role: 'user', content: 'hi' }]);

    expect(sent?.headers.Authorization).toBe('Bearer sk-test');
  });
});

describe('request body', () => {
  it('sends temperature, which this API still accepts', async () => {
    // Deliberately the opposite of the Anthropic adapter, where the same field
    // is rejected with a 400. The difference is the point of having two.
    respondWith(textReply('hello'));

    await makeProvider().chat({
      messages: [{ role: 'user', content: 'hi' }],
      tools: TOOLS,
      maxOutputTokens: 4096,
      temperature: 0.7,
    });

    expect(sent?.body.temperature).toBe(0.7);
  });

  it('falls back to a low temperature when the caller names none', async () => {
    respondWith(textReply('hello'));

    await ask(makeProvider(), [{ role: 'user', content: 'hi' }]);

    expect(sent?.body.temperature).toBe(0.2);
  });

  it('wraps each tool in the function envelope', async () => {
    respondWith(textReply('hello'));

    await ask(makeProvider(), [{ role: 'user', content: 'hi' }]);

    expect(sent?.body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_headcount',
          description: 'Total headcount',
          parameters: { type: 'object' },
        },
      },
    ]);
    expect(sent?.body.tool_choice).toBe('auto');
  });

  it('omits tool_choice when the role has no tools at all', async () => {
    // Sending "auto" alongside an empty tool list is rejected by some hosts.
    respondWith(textReply('hello'));

    await ask(makeProvider(), [{ role: 'user', content: 'hi' }], []);

    expect(sent?.body).not.toHaveProperty('tool_choice');
  });
});

describe('message mapping', () => {
  it('keeps system and user messages in the array, unlike Anthropic', async () => {
    respondWith(textReply('hello'));

    await ask(makeProvider(), [
      { role: 'system', content: 'You are an HR assistant.' },
      { role: 'user', content: 'hi' },
    ]);

    expect(sent?.body).not.toHaveProperty('system');
    expect(sent?.body.messages).toEqual([
      { role: 'system', content: 'You are an HR assistant.' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('serialises tool call arguments back into a string', async () => {
    // The API takes `arguments` as a JSON string, not an object, in both
    // directions — sending the object silently loses the call.
    respondWith(textReply('done'));

    await ask(makeProvider(), [
      { role: 'user', content: 'how many staff?' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'call_1', name: 'get_headcount', arguments: { department: 'sales' } }],
      },
    ]);

    const messages = sent?.body.messages as Record<string, unknown>[];

    expect(messages[1]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'get_headcount', arguments: '{"department":"sales"}' },
        },
      ],
    });
  });

  it('gives a tool result its own role, unlike Anthropic', async () => {
    respondWith(textReply('done'));

    await ask(makeProvider(), [
      { role: 'user', content: 'how many staff?' },
      { role: 'tool', toolCallId: 'call_1', name: 'get_headcount', content: '{"total":50}' },
    ]);

    const messages = sent?.body.messages as Record<string, unknown>[];

    expect(messages[1]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      name: 'get_headcount',
      content: '{"total":50}',
    });
  });

  it('leaves an assistant turn without tool calls free of the field', async () => {
    respondWith(textReply('done'));

    await ask(makeProvider(), [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello.' },
    ]);

    const messages = sent?.body.messages as Record<string, unknown>[];

    expect(messages[1]).toEqual({ role: 'assistant', content: 'Hello.' });
  });
});

describe('response parsing', () => {
  it('reads a plain text answer', async () => {
    respondWith({ ...(textReply('There are 50 employees.') as object), usage: { prompt_tokens: 120, completion_tokens: 8 } });

    const response = await ask(makeProvider(), [{ role: 'user', content: 'how many staff?' }]);

    expect(response.content).toBe('There are 50 employees.');
    expect(response.toolCalls).toEqual([]);
    expect(response.usage).toEqual({ inputTokens: 120, outputTokens: 8 });
  });

  it('parses tool call arguments out of their JSON string', async () => {
    respondWith(toolCallReply('{"department":"sales"}'));

    const response = await ask(makeProvider(), [{ role: 'user', content: 'how many in sales?' }]);

    expect(response.toolCalls).toEqual([
      { id: 'call_1', name: 'get_headcount', arguments: { department: 'sales' } },
    ]);
    expect(response.content).toBeNull();
  });

  it('treats empty arguments as an empty object rather than failing', async () => {
    // A tool that takes no parameters is commonly answered with "" or "{}".
    respondWith(toolCallReply(''));

    const response = await ask(makeProvider(), [{ role: 'user', content: 'how many staff?' }]);

    expect(response.toolCalls[0]?.arguments).toEqual({});
  });

  it('reports truncated tool arguments instead of throwing a SyntaxError', async () => {
    // `arguments` is generated token by token, so a model that runs out of
    // output budget mid-call sends invalid JSON. A raw SyntaxError here would
    // surface as a 500 — our bug — rather than as the provider's failure, and
    // the orchestrator could not turn it into an honest "I could not answer".
    // Small local models make this a routine event, not a theoretical one.
    respondWith(toolCallReply('{"department":"sal'));

    await expect(
      ask(makeProvider(), [{ role: 'user', content: 'how many in sales?' }]),
    ).rejects.toMatchObject({ name: 'LlmError', kind: 'malformed_response' });
  });

  it('skips a tool call missing the fields needed to run it', async () => {
    respondWith({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { type: 'function', function: { name: 'get_headcount', arguments: '{}' } }, // no id
              { id: 'call_2', type: 'function', function: { arguments: '{}' } }, // no name
              { id: 'call_3', type: 'function', function: { name: 'get_headcount', arguments: '{}' } },
            ],
          },
        },
      ],
    });

    const response = await ask(makeProvider(), [{ role: 'user', content: 'how many staff?' }]);

    expect(response.toolCalls).toEqual([{ id: 'call_3', name: 'get_headcount', arguments: {} }]);
  });

  it('rejects a response carrying no message at all', async () => {
    respondWith({ choices: [] });

    await expect(ask(makeProvider(), [{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      name: 'LlmError',
      kind: 'malformed_response',
    });
  });
});

describe('error mapping', () => {
  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [429, 'rate_limited'],
    [500, 'server_error'],
  ])('maps HTTP %i to %s so the API answers 503 rather than 500', async (status, kind) => {
    respondWith({ error: 'nope' }, status as number);

    await expect(ask(makeProvider(), [{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      name: 'LlmError',
      kind,
    });
  });

  it('reports a network failure as a provider error, not a crash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    // The everyday case for a local model: Ollama is not running.
    await expect(ask(makeProvider(), [{ role: 'user', content: 'hi' }])).rejects.toBeInstanceOf(
      LlmError,
    );
  });

  it('reports an aborted request as a timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }),
    );

    await expect(ask(makeProvider(), [{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      name: 'LlmError',
      kind: 'timeout',
    });
  });
});
