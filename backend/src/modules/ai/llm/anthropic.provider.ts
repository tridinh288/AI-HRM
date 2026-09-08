import {
  LlmError,
  type LlmChatRequest,
  type LlmChatResponse,
  type LlmMessage,
  type LlmToolCall,
  type LlmProvider,
} from './types.js';

/**
 * Adapter for the Anthropic Messages API.
 *
 * A second real provider exists to prove the abstraction actually abstracts. The
 * two APIs differ in ways that would leak everywhere if the application spoke to
 * them directly:
 *
 *   - the system prompt is a top-level field, not a message with role "system";
 *   - content is an array of typed blocks rather than a string;
 *   - a tool result is a `user` message containing a `tool_result` block, not a
 *     message with role "tool";
 *   - `max_tokens` is required rather than optional.
 *
 * All of that is translated here, and nothing above this file knows about any of
 * it. Adding a third provider means writing one more of these.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';

  constructor(
    private readonly config: {
      apiKey: string;
      baseUrl: string;
      model: string;
      timeoutMs: number;
    },
  ) {}

  async chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    request.signal?.addEventListener('abort', () => controller.abort(), { once: true });

    const systemPrompt = request.messages
      .filter((message): message is Extract<LlmMessage, { role: 'system' }> => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');

    const baseUrl = this.config.baseUrl.includes('anthropic.com')
      ? this.config.baseUrl
      : 'https://api.anthropic.com/v1';

    try {
      const response = await fetch(`${baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.config.model,
          system: systemPrompt || undefined,
          messages: toAnthropicMessages(request.messages),
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
          })),
          max_tokens: request.maxOutputTokens,
          temperature: request.temperature ?? 0.2,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw toLlmError(response.status, await safeText(response));
      }

      return parseAnthropicResponse(await response.json());
    } catch (error) {
      if (error instanceof LlmError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new LlmError('timeout', `LLM request timed out after ${this.config.timeoutMs}ms`);
      }
      throw new LlmError('server_error', `LLM request failed: ${String(error)}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function toAnthropicMessages(messages: LlmMessage[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];

  for (const message of messages) {
    if (message.role === 'system') continue; // hoisted to the top-level field

    if (message.role === 'user') {
      result.push({ role: 'user', content: [{ type: 'text', text: message.content }] });
      continue;
    }

    if (message.role === 'assistant') {
      const content: Record<string, unknown>[] = [];
      if (message.content) content.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
      }
      result.push({ role: 'assistant', content });
      continue;
    }

    // A tool result is a user-role message here, not its own role.
    result.push({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: message.toolCallId, content: message.content },
      ],
    });
  }

  return result;
}

function parseAnthropicResponse(payload: unknown): LlmChatResponse {
  const body = payload as {
    content?: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  if (!Array.isArray(body.content)) {
    throw new LlmError('malformed_response', 'LLM response contained no content blocks');
  }

  const textParts: string[] = [];
  const toolCalls: LlmToolCall[] = [];

  for (const block of body.content) {
    if (block.type === 'text' && block.text) {
      textParts.push(block.text);
    } else if (block.type === 'tool_use' && block.id && block.name) {
      toolCalls.push({ id: block.id, name: block.name, arguments: block.input ?? {} });
    }
  }

  return {
    content: textParts.length > 0 ? textParts.join('\n') : null,
    toolCalls,
    ...(body.usage
      ? {
          usage: {
            inputTokens: body.usage.input_tokens ?? 0,
            outputTokens: body.usage.output_tokens ?? 0,
          },
        }
      : {}),
  };
}

function toLlmError(status: number, body: string): LlmError {
  if (status === 401 || status === 403) {
    return new LlmError('unauthorized', 'LLM provider rejected the API key', status);
  }
  if (status === 429) {
    return new LlmError('rate_limited', 'LLM provider rate limit reached', status);
  }
  return new LlmError('server_error', `LLM provider returned ${status}: ${body.slice(0, 200)}`, status);
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
