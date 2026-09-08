import { db, type DbExecutor } from '../db/client.js';
import { auditLogs } from '../db/schema.js';
import { logger } from './logger.js';

/**
 * Append-only record of who changed what.
 *
 * Written for actions that change someone's employment, pay, or leave — the ones
 * where "who did this and when" is a question HR will eventually have to answer.
 * Reads are not audited: logging every list request would bury the events that
 * matter in noise.
 *
 * When the write happens inside a transaction, pass the transaction handle so
 * the audit entry commits or rolls back with the change it describes. An audit
 * log recording a change that was rolled back is worse than no audit log.
 */
export interface AuditEntry {
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function recordAudit(entry: AuditEntry, executor: DbExecutor = db): Promise<void> {
  try {
    await executor.insert(auditLogs).values({
      actorUserId: entry.actorUserId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      metadata: entry.metadata ?? null,
    });
  } catch (error) {
    // Outside a transaction, a failed audit write must not fail the user's
    // action — but it must be loud, because a silently broken audit trail is
    // indistinguishable from a clean one.
    logger.error({ err: error, entry }, 'Failed to write audit log');
  }
}
