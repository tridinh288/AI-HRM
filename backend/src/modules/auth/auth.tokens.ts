import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import jwt from 'jsonwebtoken';

import { env } from '../../config/env.js';
import type { AuthContext } from '../../shared/auth-context.js';
import { AppError } from '../../shared/errors.js';
import type { Role } from '../../db/schema.js';

/**
 * Two tokens, two jobs.
 *
 * ACCESS TOKEN — a signed JWT, short-lived (15 minutes), sent on every request.
 * It is stateless: the server verifies the signature and reads the claims, with
 * no database round trip. That is the whole benefit, and also the whole
 * drawback — a stateless token cannot be revoked, so it must expire quickly.
 *
 * REFRESH TOKEN — an opaque random string, long-lived (7 days), stored *hashed*
 * in the database and sent only to `/auth/refresh` in an httpOnly cookie. It is
 * deliberately NOT a JWT: the only thing it must do is be looked up and
 * invalidated, and that requires the database anyway. Being a database row is
 * what makes logout, revocation, and theft detection possible.
 *
 * Together they give the property people actually want: cheap stateless auth on
 * the hot path, with a revocation point that is hit once every 15 minutes.
 */

export interface AccessTokenClaims {
  sub: string;
  email: string;
  role: Role;
  employeeId: string | null;
}

export function signAccessToken(claims: AccessTokenClaims): string {
  return jwt.sign(claims, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL as jwt.SignOptions['expiresIn'],
    issuer: 'ai-hrm',
    audience: 'ai-hrm-web',
  });
}

/**
 * Verifies the signature and returns the caller's identity.
 *
 * Distinguishes expiry from tampering, because the frontend must react
 * differently: an expired token means "silently refresh and retry", an invalid
 * one means "log out, something is wrong".
 */
export function verifyAccessToken(token: string): AuthContext {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      issuer: 'ai-hrm',
      audience: 'ai-hrm-web',
    });

    if (typeof decoded === 'string' || !decoded.sub) {
      throw AppError.unauthorized('TOKEN_INVALID', 'Malformed authentication token');
    }

    const claims = decoded as jwt.JwtPayload & AccessTokenClaims;
    return {
      userId: claims.sub as string,
      email: claims.email,
      role: claims.role,
      employeeId: claims.employeeId ?? null,
    };
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw AppError.unauthorized('TOKEN_EXPIRED', 'Access token has expired');
    }
    if (error instanceof jwt.JsonWebTokenError) {
      throw AppError.unauthorized('TOKEN_INVALID', 'Invalid authentication token');
    }
    throw error;
  }
}

/**
 * The refresh token itself is 48 random bytes — no structure, nothing to forge.
 * What lands in the database is an HMAC of it, keyed with a server-side secret.
 *
 * Why HMAC rather than a plain SHA-256: a plain hash of a high-entropy random
 * string is already safe against dictionary attacks, but keying it means that
 * stealing a database dump is not enough to verify a guessed token offline —
 * you need the application secret too.
 */
export interface GeneratedRefreshToken {
  token: string;
  tokenHash: string;
  expiresAt: Date;
}

export function generateRefreshToken(): GeneratedRefreshToken {
  const token = randomBytes(48).toString('base64url');
  const expiresAt = new Date(Date.now() + env.JWT_REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
  return { token, tokenHash: hashRefreshToken(token), expiresAt };
}

export function hashRefreshToken(token: string): string {
  return createHmac('sha256', env.JWT_REFRESH_SECRET).update(token).digest('hex');
}

/**
 * Constant-time comparison, used where a secret is compared against a value the
 * caller controls. A naive `===` on strings returns as soon as two characters
 * differ, and that timing difference is measurable across many requests.
 */
export function safeCompare(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

export const REFRESH_COOKIE_NAME = 'hrm_refresh_token';

/**
 * Cookie settings, and why each one is here:
 *
 *  httpOnly  JavaScript cannot read it. This is the reason the refresh token
 *            lives in a cookie at all: in localStorage, a single XSS hands an
 *            attacker a 7-day credential.
 *  sameSite  'strict' — the browser will not attach this cookie to requests
 *            originating from another site, which is the CSRF defence for the
 *            one endpoint that authenticates by cookie.
 *  secure    HTTPS only in production (off locally, where there is no TLS).
 *  path      Sent only to the refresh/logout endpoints, not on every API call —
 *            the smaller the blast radius, the better.
 */
export function refreshCookieOptions(maxAgeMs: number) {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    path: '/api/v1/auth',
    maxAge: maxAgeMs,
  };
}
