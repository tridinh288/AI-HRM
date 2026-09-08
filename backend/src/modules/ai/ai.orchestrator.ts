import { env } from '../../config/env.js';
import type { AuthContext } from '../../shared/auth-context.js';
import { AppError } from '../../shared/errors.js';
import { moduleLogger } from '../../shared/logger.js';
import { authorizeTool, getLlmToolsForRole, getTool } from './ai.tools.js';
import { formatToolError, formatToolResult } from './ai.prompt.js';
import { getLlmProvider, LlmError, type LlmMessage } from './llm/index.js';

const log = moduleLogger('ai');

/**
 * The tool-calling loop.
 *
 * Shape of one turn:
 *
 *   send messages + role-filtered tools  →  model
 *   model answers, or asks for tools
 *   for each requested tool:
 *       authorize (role, scope, existence)
 *       validate arguments (Zod)
 *       execute an ordinary application function
 *       append the result as a tool message
 *   repeat, up to a hard iteration cap
 *
 * Three deliberate design points:
 *
 *  - **Authorization happens here, on every call**, not once at the start. The
 *    model's output is untrusted input; a tool name it invents gets the same
 *    scrutiny as one it was offered.
 *  - **A refused tool call is not an error.** The denial is fed back to the model
 *    as a tool result, so it can tell the user it lacks access instead of the
 *    request blowing up. It is also written to the audit table.
 *  - **The loop is bounded.** Without `maxIterations`, a model that keeps calling
 *    tools would keep costing money and holding the request open indefinitely.
 */

export interface ToolInvocationTrace {
  toolName: string;
  arguments: unknown;
  allowed: boolean;
  deniedReason?: string;
  durationMs: number;
  error?: string;
}

export interface OrchestratorResult {
  answer: string;
  invocations: ToolInvocationTrace[];
  iterations: number;
  truncated: boolean;
}

export async function runAssistant(input: {
  auth: AuthContext;
  systemPrompt: string;
  history: { role: 'USER' | 'ASSISTANT'; content: string }[];
  question: string;
}): Promise<OrchestratorResult> {
  const provider = getLlmProvider();
  const tools = getLlmToolsForRole(input.auth.role);
  const invocations: ToolInvocationTrace[] = [];

  const messages: LlmMessage[] = [
    { role: 'system', content: input.systemPrompt },
    ...input.history.map((message) =>
      message.role === 'USER'
        ? ({ role: 'user', content: message.content } as const)
        : ({ role: 'assistant', content: message.content } as const),
    ),
    { role: 'user', content: input.question },
  ];

  for (let iteration = 1; iteration <= env.AI_MAX_TOOL_ITERATIONS; iteration += 1) {
    const response = await callProvider(() =>
      provider.chat({ messages, tools, maxOutputTokens: 1024, temperature: 0.2 }),
    );

    if (response.toolCalls.length === 0) {
      return {
        answer: response.content?.trim() || 'I was not able to produce an answer to that.',
        invocations,
        iterations: iteration,
        truncated: false,
      };
    }

    messages.push({
      role: 'assistant',
      content: response.content,
      toolCalls: response.toolCalls,
    });

    for (const call of response.toolCalls) {
      const startedAt = Date.now();
      const decision = authorizeTool(call.name, input.auth);

      if (!decision.allowed) {
        // Logged at warn: a denied tool call is a security-relevant event, and
        // several in a row from one account is worth noticing.
        log.warn(
          {
            userId: input.auth.userId,
            role: input.auth.role,
            tool: call.name,
            reason: decision.reason,
          },
          'AI tool call denied',
        );

        invocations.push({
          toolName: call.name,
          arguments: call.arguments,
          allowed: false,
          deniedReason: decision.reason ?? 'Not permitted',
          durationMs: Date.now() - startedAt,
        });

        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: formatToolError(
            call.name,
            decision.reason ?? 'You are not permitted to use this tool.',
          ),
        });
        continue;
      }

      const tool = getTool(call.name)!;

      try {
        // Zod validation happens inside execute(); unknown keys are stripped, so
        // an injected `employeeId` never reaches the handler.
        const result = await tool.execute(call.arguments, { auth: input.auth });

        invocations.push({
          toolName: call.name,
          arguments: call.arguments,
          allowed: true,
          durationMs: Date.now() - startedAt,
        });

        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: formatToolResult(call.name, result),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Tool execution failed';

        log.error({ err: error, tool: call.name, userId: input.auth.userId }, 'AI tool failed');

        invocations.push({
          toolName: call.name,
          arguments: call.arguments,
          allowed: true,
          durationMs: Date.now() - startedAt,
          error: message,
        });

        // The failure goes back to the model as data, so it reports honestly
        // rather than the request 500-ing on the user.
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: formatToolError(call.name, message),
        });
      }
    }
  }

  // The cap was reached. Say so rather than returning whatever half-finished
  // reasoning the model had accumulated.
  return {
    answer:
      'I needed more steps than allowed to answer that. Try asking a narrower question, ' +
      'for example about a single month or a single department.',
    invocations,
    iterations: env.AI_MAX_TOOL_ITERATIONS,
    truncated: true,
  };
}

/**
 * Translates provider failures into HTTP-meaningful errors.
 *
 * A dead LLM is a 503 — the request was fine, the dependency is not — and never
 * a fabricated answer. That distinction is the point: when the AI cannot answer,
 * the honest failure is the correct product behaviour.
 */
async function callProvider<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof LlmError) {
      log.error({ kind: error.kind, status: error.status }, 'LLM provider error');

      switch (error.kind) {
        case 'timeout':
          throw AppError.serviceUnavailable(
            'AI_PROVIDER_UNAVAILABLE',
            'The AI service took too long to respond. Please try again.',
          );
        case 'rate_limited':
          throw AppError.serviceUnavailable(
            'AI_PROVIDER_UNAVAILABLE',
            'The AI service is rate limited right now. Please try again shortly.',
          );
        case 'malformed_response':
          throw AppError.serviceUnavailable(
            'AI_RESPONSE_INVALID',
            'The AI service returned a response that could not be understood.',
          );
        default:
          throw AppError.serviceUnavailable(
            'AI_PROVIDER_UNAVAILABLE',
            'The AI service is unavailable. Please try again later.',
          );
      }
    }
    throw error;
  }
}
