import type { Express } from 'express';
import supertest from 'supertest';

import { createApp } from '../../src/app.js';
import { signAccessToken } from '../../src/modules/auth/auth.tokens.js';
import type { Role } from '../../src/db/schema.js';
import type { TestUser } from './fixtures.js';
import { TEST_PASSWORD } from './fixtures.js';

/**
 * One Express app for the whole suite, driven in-process by Supertest.
 *
 * No port is opened and no server is started: Supertest binds an ephemeral
 * listener per request. That removes the usual sources of integration-test
 * flakiness (port collisions, "is it up yet?" waits) while still exercising the
 * entire middleware chain — helmet, CORS, body parsing, auth, validation,
 * routing, the real database, and the error handler.
 */
let app: Express | null = null;

export function getApp(): Express {
  app ??= createApp();
  return app;
}

export function api() {
  return supertest(getApp());
}

export const API = '/api/v1';

/**
 * Mints an access token directly, rather than logging in over HTTP.
 *
 * A test about leave approval should not spend an Argon2 verification on
 * authentication it is not testing. The token is produced by the *real* signing
 * function, so it is verified by the real middleware — nothing about the auth
 * path is faked, only the login round trip is skipped. The login flow itself has
 * its own tests.
 */
export function tokenFor(user: TestUser): string {
  return signAccessToken({
    sub: user.userId,
    email: user.email,
    role: user.role,
    employeeId: user.employeeId || null,
  });
}

export function tokenForClaims(claims: {
  userId: string;
  email: string;
  role: Role;
  employeeId: string | null;
}): string {
  return signAccessToken({
    sub: claims.userId,
    email: claims.email,
    role: claims.role,
    employeeId: claims.employeeId,
  });
}

/** Performs a real login over HTTP and returns the token plus the refresh cookie. */
export async function loginAs(
  email: string,
  password: string = TEST_PASSWORD,
): Promise<{ accessToken: string; refreshCookie: string }> {
  const response = await api().post(`${API}/auth/login`).send({ email, password });

  if (response.status !== 200) {
    throw new Error(`Login failed with ${response.status}: ${JSON.stringify(response.body)}`);
  }

  const setCookie = response.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const refreshCookie = cookies.find((cookie) => cookie.startsWith('hrm_refresh_token=')) ?? '';

  return { accessToken: response.body.data.accessToken as string, refreshCookie };
}
