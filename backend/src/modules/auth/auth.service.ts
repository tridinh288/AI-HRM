import { randomBytes } from 'node:crypto';

import argon2 from 'argon2';

import { env } from '../../config/env.js';
import type { DbExecutor } from '../../db/client.js';
import type { AuthContext } from '../../shared/auth-context.js';
import { AppError } from '../../shared/errors.js';
import { moduleLogger } from '../../shared/logger.js';
import * as repository from './auth.repository.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
  type GeneratedRefreshToken,
} from './auth.tokens.js';

const log = moduleLogger('auth');

/**
 * Argon2id, with explicit parameters rather than library defaults, so the cost
 * is a documented decision that can be raised as hardware gets faster.
 *
 * Why Argon2id over bcrypt: bcrypt is CPU-hard but not memory-hard, and a GPU
 * or ASIC can therefore run enormous numbers of bcrypt guesses in parallel.
 * Argon2id forces each guess to allocate 64 MB, which is what makes parallel
 * cracking expensive. bcrypt would not be a *wrong* choice — it is still solid —
 * but Argon2id is the current recommendation and won the Password Hashing
 * Competition.
 *
 * 64 MB × 4 concurrent logins is 256 MB of transient memory. That is the
 * trade-off being accepted here: login is deliberately slow and expensive.
 */
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536, // 64 MB
  timeCost: 3,
  parallelism: 1,
};

/**
 * An Argon2 hash of a random value nobody knows, verified against when the email
 * does not exist.
 *
 * Without it, "no such user" returns in ~1 ms while "wrong password" takes
 * ~150 ms, and anyone can enumerate which emails have accounts here by timing
 * the responses. Verifying against a dummy hash makes both paths cost the same.
 *
 * It is computed once, lazily, from real randomness — a hard-coded literal risks
 * being subtly malformed, in which case `argon2.verify` rejects it immediately
 * and the timing difference is right back.
 */
let dummyHashPromise: Promise<string> | null = null;

function getDummyPasswordHash(): Promise<string> {
  dummyHashPromise ??= argon2.hash(randomBytes(32).toString('hex'), ARGON2_OPTIONS);
  return dummyHashPromise;
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    // A malformed stored hash must fail closed, not throw a 500 that tells the
    // caller something unusual is going on with this account.
    return false;
  }
}

export interface AuthenticatedSession {
  accessToken: string;
  refreshToken: GeneratedRefreshToken;
  auth: AuthContext;
}

export interface RequestMeta {
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
}

/**
 * Login.
 *
 * Every failure returns the same error: `INVALID_CREDENTIALS`. Not "no such
 * user", not "wrong password", not "that account is disabled" — telling an
 * attacker which half they got right turns one guess into two cheaper ones, and
 * confirms whether an email has an account here. The logs record the real
 * reason; the client does not.
 */
export async function login(
  email: string,
  password: string,
  meta: RequestMeta = {},
): Promise<AuthenticatedSession> {
  const user = await repository.findUserByEmail(email);

  if (!user) {
    await verifyPassword(await getDummyPasswordHash(), password);
    log.warn({ email }, 'Login failed: unknown email');
    throw AppError.unauthorized('INVALID_CREDENTIALS', 'Invalid email or password');
  }

  const passwordMatches = await verifyPassword(user.passwordHash, password);
  if (!passwordMatches) {
    log.warn({ userId: user.id }, 'Login failed: wrong password');
    throw AppError.unauthorized('INVALID_CREDENTIALS', 'Invalid email or password');
  }

  if (!user.isActive) {
    log.warn({ userId: user.id }, 'Login failed: account disabled');
    throw AppError.unauthorized('INVALID_CREDENTIALS', 'Invalid email or password');
  }

  const auth: AuthContext = {
    userId: user.id,
    email: user.email,
    role: user.role,
    employeeId: user.employeeId,
  };

  const session = await issueSession(auth, meta);
  await repository.touchLastLogin(user.id);
  log.info({ userId: user.id, role: user.role }, 'Login succeeded');
  return session;
}

async function issueSession(
  auth: AuthContext,
  meta: RequestMeta,
): Promise<AuthenticatedSession> {
  const refreshToken = generateRefreshToken();

  await repository.storeRefreshToken({
    userId: auth.userId,
    tokenHash: refreshToken.tokenHash,
    expiresAt: refreshToken.expiresAt,
    userAgent: meta.userAgent,
    ipAddress: meta.ipAddress,
  });

  const accessToken = signAccessToken({
    sub: auth.userId,
    email: auth.email,
    role: auth.role,
    employeeId: auth.employeeId,
  });

  return { accessToken, refreshToken, auth };
}

/**
 * Refresh with rotation and reuse detection.
 *
 * The old token is revoked and a new one issued on every refresh, so a stolen
 * token is only useful until the legitimate client next refreshes.
 *
 * The important case is the one below: a token that exists but has *already been
 * revoked*. A well-behaved client never sends one — it threw the old token away
 * when it received the replacement. Seeing it means two parties hold the same
 * token, i.e. one of them stole it. We cannot tell which, so we revoke every
 * session for that user and force a fresh login. This is the standard OAuth
 * refresh-token-rotation reuse detection, and it is the reason refresh tokens
 * are database rows rather than self-contained JWTs.
 */
export async function refresh(
  rawToken: string,
  meta: RequestMeta = {},
): Promise<AuthenticatedSession> {
  const tokenHash = hashRefreshToken(rawToken);
  const stored = await repository.findRefreshTokenByHash(tokenHash);

  if (!stored) {
    throw AppError.unauthorized('TOKEN_INVALID', 'Invalid refresh token');
  }

  if (stored.revokedAt) {
    log.error(
      { userId: stored.userId },
      'Refresh token reuse detected — revoking all sessions for this user',
    );
    await repository.revokeAllUserTokens(stored.userId);
    throw AppError.unauthorized('TOKEN_INVALID', 'Invalid refresh token');
  }

  if (stored.expiresAt.getTime() <= Date.now()) {
    throw AppError.unauthorized('TOKEN_EXPIRED', 'Refresh token has expired');
  }

  // Re-read the user rather than trusting claims from the old token: role
  // changes and deactivations must take effect at the next refresh, not at the
  // next login. This is the revocation point that stateless JWTs lack.
  const user = await repository.findUserById(stored.userId);
  if (!user || !user.isActive) {
    await repository.revokeAllUserTokens(stored.userId);
    throw AppError.unauthorized('ACCOUNT_DISABLED', 'This account is no longer active');
  }

  const auth: AuthContext = {
    userId: user.id,
    email: user.email,
    role: user.role,
    employeeId: user.employeeId,
  };

  const session = await issueSession(auth, meta);
  await repository.revokeRefreshToken(tokenHash, session.refreshToken.tokenHash);
  return session;
}

export async function logout(rawToken: string | undefined): Promise<void> {
  if (!rawToken) return;
  // Revoking is idempotent and never reports whether the token existed: logout
  // must not become an oracle for guessing valid tokens.
  await repository.revokeRefreshToken(hashRefreshToken(rawToken), null);
}

/**
 * Password change.
 *
 * Requires the current password even though the caller is already
 * authenticated — otherwise an attacker with a stolen access token (15 minutes)
 * can lock the real owner out permanently (a new password).
 *
 * All sessions are revoked afterwards, on the assumption that a password change
 * may be a response to compromise.
 */
/**
 * Ends every session of one account.
 *
 * The revocation point that stateless access tokens lack: after this, the
 * next refresh fails and the user must sign in again — and at that point the
 * server re-reads their role and active flag. Exposed as a service function so
 * other modules (an account change, a termination) can end sessions without
 * reaching into this module's repository.
 */
export async function revokeAllSessions(userId: string, executor?: DbExecutor): Promise<void> {
  await repository.revokeAllUserTokens(userId, executor);
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await repository.findUserById(userId);
  if (!user) {
    throw AppError.unauthorized('UNAUTHENTICATED', 'Authentication required');
  }

  const matches = await verifyPassword(user.passwordHash, currentPassword);
  if (!matches) {
    log.warn({ userId }, 'Password change failed: wrong current password');
    throw AppError.unauthorized('INVALID_CREDENTIALS', 'Current password is incorrect');
  }

  await repository.updatePasswordHash(userId, await hashPassword(newPassword));
  await repository.revokeAllUserTokens(userId);
  log.info({ userId }, 'Password changed; all sessions revoked');
}

export async function getCurrentUser(userId: string): Promise<{
  id: string;
  email: string;
  role: string;
  employeeId: string | null;
}> {
  const user = await repository.findUserById(userId);
  if (!user || !user.isActive) {
    throw AppError.unauthorized('ACCOUNT_DISABLED', 'This account is no longer active');
  }
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    employeeId: user.employeeId,
  };
}

export const refreshTokenMaxAgeMs = env.JWT_REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000;
