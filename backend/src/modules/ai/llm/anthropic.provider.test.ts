import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AnthropicProvider } from './anthropic.provider.js';
import { LlmError, type LlmChatResponse, type LlmMessage } from './types.js';

/**
 * Wire-format tests for the Anthropic adapter.
 *
 * These exist because this adapter's failure modes are invisible to every other
 * test in the suite: the AI tests all run against `FakeLlmProvider`, so a
 * request body the real API would reject still leaves 180 tests green. Both
 * bugs guarded against below were exactly that shape — the code read fine and
 * nothing could have caught it.
 *
 * `fetch` is stubbed rather than the module mocked, which keeps every assertion
 * about the actual JSON that would go over the network.
 */

const TOOLS = [
  { name: 'get_headcount', description: 'Total headcount', parameters: { type: 'object' } },
];

/** The shape a thinking model returns: reasoning first, then the tool call. */
const THINKING_THEN_TOOL_CALL = {
  content: [
    {
      type: 'thinking',
      thinking: 'The user wants a headcount. I should call get_headcount.',
      signature: 'SIGNATURE_FROM_THE_MODEL',
    },
    { type: 'tool_use', id: 'toolu_01', name: 'get_headcount', input: {} },
  ],
  usage: { input_tokens: 1200, output_tokens: 88 },
};

let sent: { url: string; body: Record<string, unknown> } | null = null;

/** Stubs `fetch`, recording the request and replying with `payload`. */
function respondWith(payload: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string }) => {
      sent = { url, body: JSON.parse(init.body) as Record<string, unknown> };
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      };
    }),
  );
}

function makeProvider(baseUrl = 'https://api.anthropic.com/v1'): AnthropicProvider {
  return new AnthropicProvider({
    apiKey: 'sk-ant-test',
    baseUrl,
    model: 'claude-opus-5',
    timeoutMs: 30_000,
  });
}

function ask(provider: AnthropicProvider, messages: LlmMessage[]): Promise<LlmChatResponse> {
  return provider.chat({ messages, tools: TOOLS, maxOutputTokens: 4096 });
}

beforeEach(() => {
  sent = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('request body', () => {
  it('never sends temperature, even when the caller supplies one', async () => {
    // Current Claude models removed the sampling parameters and answer a request
    // carrying one with a 400, so it must not be forwarded from the request.
    respondWith({ content: [{ type: 'text', text: 'hello' }] });

    await makeProvider().chat({
      messages: [{ role: 'user', content: 'hi' }],
      tools: TOOLS,
      maxOutputTokens: 4096,
      temperature: 0.2,
    });

    expect(sent?.body).not.toHaveProperty('temperature');
  });

  it('sends no thinking field, leaving each model its own default', async () => {
    // Naming a mode here would 400 on whichever configured AI_MODEL rejects it.
    respondWith({ content: [{ type: 'text', text: 'hello' }] });

    await ask(makeProvider(), [{ role: 'user', content: 'hi' }]);

    expect(sent?.body).not.toHaveProperty('thinking');
  });

  it('forwards max_tokens and the tool list', async () => {
    respondWith({ content: [{ type: 'text', text: 'hello' }] });

    await ask(makeProvider(), [{ role: 'user', content: 'hi' }]);

    expect(sent?.body.max_tokens).toBe(4096);
    expect(sent?.body.tools).toEqual([
      { name: 'get_headcount', description: 'Total headcount', input_schema: { type: 'object' } },
    ]);
  });

  it('hoists system messages into the top-level field', async () => {
    // Anthropic has no system role; a system message left in `messages` is an error.
    respondWith({ content: [{ type: 'text', text: 'hello' }] });

    await ask(makeProvider(), [
      { role: 'system', content: 'You are an HR assistant.' },
      { role: 'user', content: 'hi' },
    ]);

    expect(sent?.body.system).toBe('You are an HR assistant.');
    expect(sent?.body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ]);
  });

  it('ignores a non-Anthropic base URL rather than calling the wrong host', async () => {
    // AI_BASE_URL is shared with the OpenAI-compatible adapter, so it may well
    // hold an OpenAI or Ollama URL while AI_PROVIDER is anthropic.
    respondWith({ content: [{ type: 'text', text: 'hello' }] });

    await ask(makeProvider('http://localhost:11434/v1'), [{ role: 'user', content: 'hi' }]);

    expect(sent?.url).toBe('https://api.anthropic.com/v1/messages');
  });
});

describe('reasoning blocks', () => {
  it('captures thinking blocks out of the response', async () => {
    respondWith(THINKING_THEN_TOOL_CALL);

    const response = await ask(makeProvider(), [{ role: 'user', content: 'how many staff?' }]);

    expect(response.toolCalls).toEqual([
      { id: 'toolu_01', name: 'get_headcount', arguments: {} },
    ]);
    expect(response.reasoning).toEqual([THINKING_THEN_TOOL_CALL.content[0]]);
  });

  it('replays them first and unaltered on the next turn', async () => {
    // A thinking model verifies its own prior reasoning before continuing a tool
    // loop and rejects the turn if a block was reordered, edited or dropped.
    // Losing them broke the second iteration of every conversation.
    respondWith(THINKING_THEN_TOOL_CALL);
    const provider = makeProvider();
    const first = await ask(provider, [{ role: 'user', content: 'how many staff?' }]);

    respondWith({ content: [{ type: 'text', text: 'There are 50 employees.' }] });
    await ask(provider, [
      { role: 'user', content: 'how many staff?' },
      {
        role: 'assistant',
        content: first.content,
        toolCalls: first.toolCalls,
        reasoning: first.reasoning,
      },
      { role: 'tool', toolCallId: 'toolu_01', name: 'get_headcount', content: '{"total":50}' },
    ]);

    const messages = sent?.body.messages as { role: string; content: unknown[] }[];
    const assistantTurn = messages.find((message) => message.role === 'assistant');

    expect(assistantTurn?.content[0]).toEqual(THINKING_THEN_TOOL_CALL.content[0]);
    expect(assistantTurn?.content[1]).toMatchObject({ type: 'tool_use', id: 'toolu_01' });
  });

  it('omits the field entirely when the model returned no reasoning', async () => {
    respondWith({ content: [{ type: 'text', text: 'hello' }] });

    const response = await ask(makeProvider(), [{ role: 'user', content: 'hi' }]);

    expect(response.reasoning).toBeUndefined();
  });

  it('turns a tool result into a user-role tool_result block', async () => {
    // Anthropic has no tool role either — the result rides in a user message.
    respondWith({ content: [{ type: 'text', text: 'done' }] });

    await ask(makeProvider(), [
      { role: 'user', content: 'how many staff?' },
      { role: 'tool', toolCallId: 'toolu_01', name: 'get_headcount', content: '{"total":50}' },
    ]);

    const messages = sent?.body.messages as { role: string; content: unknown[] }[];

    expect(messages[1]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '{"total":50}' }],
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
    // The caller distinguishes "try again" from "this will never work"; one
    // opaque failure would surface as our bug rather than the provider's.
    respondWith({ error: 'nope' }, status as number);

    await expect(ask(makeProvider(), [{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      name: 'LlmError',
      kind,
    });
  });

  it('reports a malformed response instead of throwing a TypeError', async () => {
    respondWith({ not_content: true });

    await expect(ask(makeProvider(), [{ role: 'user', content: 'hi' }])).rejects.toBeInstanceOf(
      LlmError,
    );
  });
});
