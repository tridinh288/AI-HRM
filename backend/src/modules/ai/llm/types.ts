/**
 * The boundary between this application and whichever LLM is behind it.
 *
 * Everything above this interface — the orchestrator, the tool registry, the
 * authorization layer — is written against these types and knows nothing about
 * OpenAI's or Anthropic's wire formats. That is what makes two things possible:
 * swapping providers with a configuration change, and running the entire AI
 * test suite against a `FakeLlmProvider` with no network and no API bill.
 *
 * The types are deliberately the *intersection* of what providers offer, not
 * the union. Anything provider-specific stays inside its adapter.
 */

/** JSON Schema describing a tool's arguments, generated from the Zod schema. */
export type JsonSchemaObject = Record<string, unknown>;

export interface LlmToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
}

export interface LlmToolCall {
  /** Provider-assigned id; the tool result must reference it. */
  id: string;
  name: string;
  /** Raw, unvalidated arguments from the model. Never trusted — always parsed. */
  arguments: unknown;
}

export type LlmMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      toolCalls?: LlmToolCall[];
      /**
       * Opaque reasoning blocks from the provider that produced this turn.
       *
       * The one place a provider's wire format is allowed through this
       * boundary, and it stays `unknown` precisely so nothing above can read
       * it. Models with thinking enabled require their own reasoning blocks
       * echoed back verbatim alongside the tool calls they justify; dropping
       * them breaks a tool loop. Adapters that have no such concept ignore it.
       */
      reasoning?: unknown[];
    }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface LlmChatRequest {
  messages: LlmMessage[];
  tools: LlmToolDefinition[];
  maxOutputTokens: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface LlmChatResponse {
  content: string | null;
  toolCalls: LlmToolCall[];
  /** Provider-native reasoning blocks, to be replayed on the next request. */
  reasoning?: unknown[];
  usage?: { inputTokens: number; outputTokens: number };
}

export interface LlmProvider {
  readonly name: string;
  chat(request: LlmChatRequest): Promise<LlmChatResponse>;
}

/**
 * Errors from a provider are typed so the caller can distinguish "try again" from
 * "this will never work", and so the API returns 503 rather than a 500 that looks
 * like our bug.
 */
export type LlmErrorKind =
  | 'timeout'
  | 'rate_limited'
  | 'unauthorized'
  | 'server_error'
  | 'malformed_response';

export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}
