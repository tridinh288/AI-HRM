import { companyPolicy, env } from '../../config/env.js';
import type { AuthContext } from '../../shared/auth-context.js';
import { companyToday } from '../../shared/calendar.js';
import { AppError } from '../../shared/errors.js';
import { runAssistant } from './ai.orchestrator.js';
import { buildSystemPrompt } from './ai.prompt.js';
import * as repository from './ai.repository.js';
import { getToolsForRole } from './ai.tools.js';

const HISTORY_LIMIT = 10;

/**
 * Per-user hourly rate limit for the assistant.
 *
 * Separate from the global IP rate limiter in app.ts, and for a different
 * reason: this one protects a *paid external dependency*. It is counted per
 * account because that is what maps to cost, and in the database because an
 * in-memory counter resets on deploy and is not shared between instances.
 */
async function assertWithinRateLimit(auth: AuthContext): Promise<void> {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const used = await repository.countRecentUserMessages(auth.userId, since);

  if (used >= env.AI_RATE_LIMIT_PER_HOUR) {
    throw AppError.tooManyRequests(
      `You have reached the limit of ${env.AI_RATE_LIMIT_PER_HOUR} assistant messages per hour. Please try again later.`,
    );
  }
}

export interface AssistantAnswer {
  conversationId: string;
  answer: string;
  /**
   * Which tools ran, and which were refused.
   *
   * Returned to the client on purpose, and shown in the UI. An answer with no
   * tool calls behind it is an answer with no data behind it, and making that
   * visible is the most practical defence against a model that sounds confident
   * about a number it invented.
   */
  toolCalls: {
    name: string;
    allowed: boolean;
    deniedReason?: string;
    durationMs: number;
    error?: string;
  }[];
  truncated: boolean;
}

export async function ask(
  input: { question: string; conversationId?: string | undefined },
  auth: AuthContext,
): Promise<AssistantAnswer> {
  await assertWithinRateLimit(auth);

  // Ownership is proven by the query, not by a check afterwards: a conversation
  // id belonging to someone else simply does not resolve.
  let conversationId = input.conversationId;

  if (conversationId) {
    const owned = await repository.findOwnedConversation(conversationId, auth.userId);
    if (!owned) throw AppError.notFound('Conversation not found');
  } else {
    conversationId = await repository.createConversation(auth.userId, input.question);
  }

  const previous = await repository.listMessages(conversationId, HISTORY_LIMIT);

  const result = await runAssistant({
    auth,
    systemPrompt: buildSystemPrompt(auth, companyToday(companyPolicy.timezone)),
    history: previous.map((message) => ({ role: message.role, content: message.content })),
    question: input.question,
  });

  const userMessageId = await repository.appendMessage(conversationId, 'USER', input.question);
  await repository.appendMessage(conversationId, 'ASSISTANT', result.answer);

  // Audit every tool call, allowed or denied, linked to the message that caused
  // it. Written after the answer so a failed audit cannot cost the user their
  // reply — but failures are logged loudly (see shared/audit.ts for the same
  // reasoning applied to the main audit trail).
  for (const invocation of result.invocations) {
    await repository.recordToolInvocation({
      userId: auth.userId,
      messageId: userMessageId,
      toolName: invocation.toolName,
      arguments: invocation.arguments,
      allowed: invocation.allowed,
      deniedReason: invocation.deniedReason ?? null,
      durationMs: invocation.durationMs,
    });
  }

  return {
    conversationId,
    answer: result.answer,
    toolCalls: result.invocations.map((invocation) => ({
      name: invocation.toolName,
      allowed: invocation.allowed,
      ...(invocation.deniedReason ? { deniedReason: invocation.deniedReason } : {}),
      durationMs: invocation.durationMs,
      ...(invocation.error ? { error: invocation.error } : {}),
    })),
    truncated: result.truncated,
  };
}

export async function listConversations(auth: AuthContext) {
  return repository.listConversations(auth.userId);
}

export async function getConversation(conversationId: string, auth: AuthContext) {
  const conversation = await repository.findOwnedConversation(conversationId, auth.userId);
  if (!conversation) throw AppError.notFound('Conversation not found');

  return {
    ...conversation,
    messages: await repository.listMessages(conversationId, 100),
  };
}

/**
 * The tools this user can reach.
 *
 * Exposed so the UI can honestly tell people what the assistant is able to do
 * for *them* — an employee sees three personal tools, HR sees ten. It also makes
 * the role filtering visible and testable from the outside.
 */
export function listCapabilities(auth: AuthContext) {
  return {
    role: auth.role,
    provider: env.AI_PROVIDER,
    tools: getToolsForRole(auth.role).map((tool) => ({
      name: tool.name,
      description: tool.description,
      scope: tool.scope,
    })),
  };
}
