import {
  LlmError,
  type LlmChatRequest,
  type LlmChatResponse,
  type LlmMessage,
  type LlmProvider,
  type LlmToolCall,
} from './types.js';

/**
 * Adapter for any OpenAI-compatible Chat Completions endpoint.
 *
 * "Compatible" covers a lot of ground — OpenAI itself, Groq, OpenRouter,
 * Together, and a local Ollama server all speak this shape — so a single
 * adapter plus a configurable `baseUrl` makes the provider a deployment choice
 * rather than a code change.
 *
 * Implemented with `fetch` rather than the official SDK on purpose: the SDK
 * would pull the provider's types back into the application, which is exactly
 * what this interface exists to prevent. What is used here is one HTTP endpoint
 * with a stable, documented shape.
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name = 'openai';

  constructor(
    private readonly config: {
      apiKey: string;
      baseUrl: string;
      model: string;
      timeoutMs: number;
    },
  ) {}

  async chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    // Every call gets a hard deadline. Without one, a provider that stops
    // responding holds an Express request open until the client gives up, and
    // holds a database connection if one is checked out.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    request.signal?.addEventListener('abort', () => controller.abort(), { once: true });

    try {
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: request.messages.map(toOpenAiMessage),
          tools: request.tools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
          tool_choice: request.tools.length > 0 ? 'auto' : undefined,
          max_tokens: request.maxOutputTokens,
          temperature: request.temperature ?? 0.2,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw toLlmError(response.status, await safeText(response));
      }

      return parseOpenAiResponse(await response.json());
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

function toOpenAiMessage(message: LlmMessage): Record<string, unknown> {
  switch (message.role) {
    case 'tool':
      return {
        role: 'tool',
        tool_call_id: message.toolCallId,
        name: message.name,
        content: message.content,
      };
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              })),
            }
          : {}),
      };
    default:
      return { role: message.role, content: message.content };
  }
}

/**
 * Parses the response defensively.
 *
 * The model's `arguments` field is a *string* containing JSON that the model
 * generated token by token, so it can be truncated or malformed. A JSON.parse
 * failure here must not crash the request — it is reported as a malformed
 * response, and the orchestrator turns that into an honest "I could not answer"
 * rather than an invented one.
 */
function parseOpenAiResponse(payload: unknown): LlmChatResponse {
  const body = payload as {
    choices?: { message?: { content?: string | null; tool_calls?: unknown[] } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const message = body.choices?.[0]?.message;
  if (!message) {
    throw new LlmError('malformed_response', 'LLM response contained no message');
  }

  const toolCalls: LlmToolCall[] = [];

  for (const raw of message.tool_calls ?? []) {
    const call = raw as { id?: string; function?: { name?: string; arguments?: string } };
    if (!call.id || !call.function?.name) continue;

    let parsedArguments: unknown = {};
    try {
      parsedArguments = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      throw new LlmError(
        'malformed_response',
        `Tool call "${call.function.name}" had arguments that were not valid JSON`,
      );
    }

    toolCalls.push({ id: call.id, name: call.function.name, arguments: parsedArguments });
  }

  return {
    content: message.content ?? null,
    toolCalls,
    ...(body.usage
      ? {
          usage: {
            inputTokens: body.usage.prompt_tokens ?? 0,
            outputTokens: body.usage.completion_tokens ?? 0,
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
