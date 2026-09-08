import { and, asc, desc, eq, gte, sql } from 'drizzle-orm';

import { db, type DbExecutor } from '../../db/client.js';
import { aiConversations, aiMessages, aiToolInvocations } from '../../db/schema.js';

export async function createConversation(
  userId: string,
  title: string,
  executor: DbExecutor = db,
): Promise<string> {
  const rows = await executor
    .insert(aiConversations)
    .values({ userId, title: title.slice(0, 160) })
    .returning({ id: aiConversations.id });
  return rows[0]!.id;
}

/**
 * Loads a conversation, but only if it belongs to the caller.
 *
 * The ownership check is part of the query rather than a separate `if` after
 * fetching. There is no way to read this row without proving ownership, so a
 * forgotten check cannot expose one user's conversation to another.
 */
export async function findOwnedConversation(
  conversationId: string,
  userId: string,
  executor: DbExecutor = db,
): Promise<{ id: string; title: string } | null> {
  const rows = await executor
    .select({ id: aiConversations.id, title: aiConversations.title })
    .from(aiConversations)
    .where(and(eq(aiConversations.id, conversationId), eq(aiConversations.userId, userId)))
    .limit(1);

  return rows[0] ?? null;
}

export async function listConversations(userId: string, limit = 20) {
  return db
    .select({
      id: aiConversations.id,
      title: aiConversations.title,
      updatedAt: aiConversations.updatedAt,
    })
    .from(aiConversations)
    .where(eq(aiConversations.userId, userId))
    .orderBy(desc(aiConversations.updatedAt))
    .limit(limit);
}

export async function listMessages(conversationId: string, limit = 40) {
  return db
    .select({
      id: aiMessages.id,
      role: aiMessages.role,
      content: aiMessages.content,
      createdAt: aiMessages.createdAt,
    })
    .from(aiMessages)
    .where(eq(aiMessages.conversationId, conversationId))
    .orderBy(asc(aiMessages.createdAt))
    .limit(limit);
}

export async function appendMessage(
  conversationId: string,
  role: 'USER' | 'ASSISTANT',
  content: string,
  executor: DbExecutor = db,
): Promise<string> {
  const rows = await executor
    .insert(aiMessages)
    .values({ conversationId, role, content })
    .returning({ id: aiMessages.id });

  await executor
    .update(aiConversations)
    .set({ updatedAt: new Date() })
    .where(eq(aiConversations.id, conversationId));

  return rows[0]!.id;
}

export interface ToolInvocationRecord {
  userId: string;
  messageId?: string | null;
  toolName: string;
  arguments: unknown;
  allowed: boolean;
  deniedReason?: string | null;
  durationMs?: number | null;
}

/**
 * The AI audit trail.
 *
 * Every tool call is recorded, *including the refused ones* — that is the whole
 * point. A denied row is evidence that the authorization layer did its job, and
 * a burst of them from one user is the signal that somebody is probing.
 */
export async function recordToolInvocation(
  record: ToolInvocationRecord,
  executor: DbExecutor = db,
): Promise<void> {
  await executor.insert(aiToolInvocations).values({
    userId: record.userId,
    messageId: record.messageId ?? null,
    toolName: record.toolName.slice(0, 80),
    arguments: (record.arguments ?? {}) as object,
    allowed: record.allowed,
    deniedReason: record.deniedReason?.slice(0, 255) ?? null,
    durationMs: record.durationMs ?? null,
  });
}

/**
 * Requests made by one user in the last hour.
 *
 * Rate limiting for the AI endpoint is counted in the database rather than in
 * memory, and per *user* rather than per IP. In-memory counters reset on every
 * deploy and are not shared between instances; IP-based limits punish everyone
 * behind one office NAT while doing nothing about one account with a script.
 * Since calls to a paid API are the resource being protected, the account is the
 * right unit.
 */
export async function countRecentInvocations(userId: string, since: Date): Promise<number> {
  const rows = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(aiToolInvocations)
    .where(and(eq(aiToolInvocations.userId, userId), gte(aiToolInvocations.createdAt, since)));

  return rows[0]?.value ?? 0;
}

export async function countRecentUserMessages(userId: string, since: Date): Promise<number> {
  const rows = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(aiMessages)
    .innerJoin(aiConversations, eq(aiConversations.id, aiMessages.conversationId))
    .where(
      and(
        eq(aiConversations.userId, userId),
        eq(aiMessages.role, 'USER'),
        gte(aiMessages.createdAt, since),
      ),
    );

  return rows[0]?.value ?? 0;
}
