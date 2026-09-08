import { and, eq, isNull, lt, sql } from 'drizzle-orm';

import { db, type DbExecutor } from '../../db/client.js';
import { employees, refreshTokens, users } from '../../db/schema.js';

/**
 * Data access for authentication.
 *
 * No business rules here — this layer knows how to fetch and store rows, and
 * nothing about whether a login should succeed. That separation is what lets
 * `auth.service` be tested against a fake repository, and what keeps SQL out of
 * the file where the security logic lives.
 */

export interface AuthUserRow {
  id: string;
  email: string;
  passwordHash: string;
  role: 'ADMIN' | 'HR' | 'EMPLOYEE';
  isActive: boolean;
  employeeId: string | null;
}

/**
 * Looks a user up by email, case-insensitively, together with their employee id.
 *
 * One query rather than two: the employee id is needed on every login to build
 * the auth context, and a LEFT JOIN costs nothing compared to a second round
 * trip. It is LEFT because an ADMIN account need not have an HR record.
 */
export async function findUserByEmail(
  email: string,
  executor: DbExecutor = db,
): Promise<AuthUserRow | null> {
  const rows = await executor
    .select({
      id: users.id,
      email: users.email,
      passwordHash: users.passwordHash,
      role: users.role,
      isActive: users.isActive,
      employeeId: employees.id,
    })
    .from(users)
    .leftJoin(employees, eq(employees.userId, users.id))
    .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
    .limit(1);

  return rows[0] ?? null;
}

export async function findUserById(
  userId: string,
  executor: DbExecutor = db,
): Promise<AuthUserRow | null> {
  const rows = await executor
    .select({
      id: users.id,
      email: users.email,
      passwordHash: users.passwordHash,
      role: users.role,
      isActive: users.isActive,
      employeeId: employees.id,
    })
    .from(users)
    .leftJoin(employees, eq(employees.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1);

  return rows[0] ?? null;
}

export async function touchLastLogin(userId: string, executor: DbExecutor = db): Promise<void> {
  await executor.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
}

export async function updatePasswordHash(
  userId: string,
  passwordHash: string,
  executor: DbExecutor = db,
): Promise<void> {
  await executor
    .update(users)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

export interface StoredRefreshToken {
  id: string;
  userId: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export async function storeRefreshToken(
  input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    userAgent?: string | undefined;
    ipAddress?: string | undefined;
  },
  executor: DbExecutor = db,
): Promise<void> {
  await executor.insert(refreshTokens).values({
    userId: input.userId,
    tokenHash: input.tokenHash,
    expiresAt: input.expiresAt,
    userAgent: input.userAgent?.slice(0, 255) ?? null,
    ipAddress: input.ipAddress?.slice(0, 64) ?? null,
  });
}

export async function findRefreshTokenByHash(
  tokenHash: string,
  executor: DbExecutor = db,
): Promise<StoredRefreshToken | null> {
  const rows = await executor
    .select({
      id: refreshTokens.id,
      userId: refreshTokens.userId,
      expiresAt: refreshTokens.expiresAt,
      revokedAt: refreshTokens.revokedAt,
    })
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, tokenHash))
    .limit(1);

  return rows[0] ?? null;
}

export async function revokeRefreshToken(
  tokenHash: string,
  replacedByHash: string | null,
  executor: DbExecutor = db,
): Promise<void> {
  await executor
    .update(refreshTokens)
    .set({ revokedAt: new Date(), replacedByHash })
    .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt)));
}

/**
 * Revokes every live session for a user.
 *
 * Called on refresh-token reuse (see `auth.service`) and after a password
 * change. Both are moments where the safe assumption is that something has been
 * stolen, and the cost of logging someone out of their other devices is far
 * lower than the cost of leaving an attacker's session alive.
 */
export async function revokeAllUserTokens(
  userId: string,
  executor: DbExecutor = db,
): Promise<void> {
  await executor
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
}

/** Housekeeping: expired rows are dead weight and an unnecessary liability. */
export async function deleteExpiredRefreshTokens(executor: DbExecutor = db): Promise<number> {
  const deleted = await executor
    .delete(refreshTokens)
    .where(lt(refreshTokens.expiresAt, new Date()))
    .returning({ id: refreshTokens.id });
  return deleted.length;
}
