import { beforeEach, describe, expect, it } from 'vitest';

import { API, api, loginAs, tokenFor } from './helpers/api.js';
import { TEST_PASSWORD, createTestUser, resetDatabase, seedReferenceData } from './helpers/fixtures.js';

/**
 * Authentication and session management, end to end.
 *
 * These run against a real PostgreSQL database and the real middleware stack —
 * real Argon2 verification, real JWTs, real refresh-token rows — because the
 * behaviour under test (rotation, reuse detection, revocation) exists in the
 * interaction between the code and the database, not in either alone.
 */

describe('POST /auth/login', () => {
  beforeEach(async () => {
    await resetDatabase();
    const refs = await seedReferenceData();
    await createTestUser({
      email: 'employee@test.local',
      role: 'EMPLOYEE',
      departmentId: refs.departmentId,
      annualLeaveTypeId: refs.annualLeaveTypeId,
    });
  });

  it('returns an access token and sets an httpOnly refresh cookie', async () => {
    const response = await api()
      .post(`${API}/auth/login`)
      .send({ email: 'employee@test.local', password: TEST_PASSWORD });

    expect(response.status).toBe(200);
    expect(response.body.data.accessToken).toBeTypeOf('string');
    expect(response.body.data.user).toMatchObject({
      email: 'employee@test.local',
      role: 'EMPLOYEE',
    });

    const cookies = response.headers['set-cookie'] as unknown as string[];
    const refreshCookie = cookies.find((c) => c.startsWith('hrm_refresh_token='));

    expect(refreshCookie).toBeDefined();
    // The reason the refresh token is in a cookie at all: script cannot read it,
    // so an XSS cannot walk away with a seven-day credential.
    expect(refreshCookie).toContain('HttpOnly');
    expect(refreshCookie).toContain('SameSite=Strict');
  });

  it('never returns the password hash', async () => {
    const response = await api()
      .post(`${API}/auth/login`)
      .send({ email: 'employee@test.local', password: TEST_PASSWORD });

    expect(JSON.stringify(response.body)).not.toContain('argon2');
    expect(response.body.data.user.passwordHash).toBeUndefined();
  });

  it('rejects a wrong password with 401', async () => {
    const response = await api()
      .post(`${API}/auth/login`)
      .send({ email: 'employee@test.local', password: 'WrongPassword123' });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('gives an unknown email exactly the same error as a wrong password', async () => {
    // User enumeration defence: the response must not reveal which accounts
    // exist. If these two differed, an attacker could harvest valid emails.
    const unknown = await api()
      .post(`${API}/auth/login`)
      .send({ email: 'nobody@test.local', password: TEST_PASSWORD });

    const wrongPassword = await api()
      .post(`${API}/auth/login`)
      .send({ email: 'employee@test.local', password: 'WrongPassword123' });

    expect(unknown.status).toBe(wrongPassword.status);
    expect(unknown.body.error.code).toBe(wrongPassword.body.error.code);
    expect(unknown.body.error.message).toBe(wrongPassword.body.error.message);
  });

  it('rejects a disabled account without saying that it is disabled', async () => {
    await createTestUser({ email: 'disabled@test.local', role: 'EMPLOYEE' });
    const { db } = await import('../src/db/client.js');
    const { users } = await import('../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    await db.update(users).set({ isActive: false }).where(eq(users.email, 'disabled@test.local'));

    const response = await api()
      .post(`${API}/auth/login`)
      .send({ email: 'disabled@test.local', password: TEST_PASSWORD });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('treats email as case-insensitive', async () => {
    const response = await api()
      .post(`${API}/auth/login`)
      .send({ email: 'EMPLOYEE@Test.Local', password: TEST_PASSWORD });

    expect(response.status).toBe(200);
  });

  it('rejects a malformed request body with 400', async () => {
    const response = await api().post(`${API}/auth/login`).send({ email: 'not-an-email' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details).toBeInstanceOf(Array);
  });
});

describe('GET /auth/me', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedReferenceData();
  });

  it('returns the caller identity for a valid token', async () => {
    const user = await createTestUser({ email: 'me@test.local' });
    const response = await api()
      .get(`${API}/auth/me`)
      .set('Authorization', `Bearer ${tokenFor(user)}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      email: 'me@test.local',
      role: 'EMPLOYEE',
      employeeId: user.employeeId,
    });
  });

  it('rejects a request with no token', async () => {
    const response = await api().get(`${API}/auth/me`);
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a tampered token', async () => {
    const user = await createTestUser({ email: 'tamper@test.local' });
    const token = tokenFor(user);
    // Flip the last character of the signature.
    const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');

    const response = await api().get(`${API}/auth/me`).set('Authorization', `Bearer ${tampered}`);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('TOKEN_INVALID');
  });

  it('reports an expired token distinctly, so the client can refresh instead of logging out', async () => {
    const jwt = (await import('jsonwebtoken')).default;
    const { env } = await import('../src/config/env.js');
    const user = await createTestUser({ email: 'expired@test.local' });

    const expired = jwt.sign(
      { sub: user.userId, email: user.email, role: 'EMPLOYEE', employeeId: user.employeeId },
      env.JWT_ACCESS_SECRET,
      { expiresIn: '-10s', issuer: 'ai-hrm', audience: 'ai-hrm-web' },
    );

    const response = await api().get(`${API}/auth/me`).set('Authorization', `Bearer ${expired}`);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('rejects a token signed with the wrong secret', async () => {
    const jwt = (await import('jsonwebtoken')).default;
    const user = await createTestUser({ email: 'forged@test.local' });

    const forged = jwt.sign(
      { sub: user.userId, email: user.email, role: 'ADMIN', employeeId: null },
      'an-attacker-chosen-secret-of-sufficient-length',
      { issuer: 'ai-hrm', audience: 'ai-hrm-web' },
    );

    const response = await api().get(`${API}/auth/me`).set('Authorization', `Bearer ${forged}`);

    expect(response.status).toBe(401);
  });
});

describe('refresh token rotation', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedReferenceData();
    await createTestUser({ email: 'rotate@test.local' });
  });

  it('issues a new access token and a new refresh cookie', async () => {
    const { refreshCookie } = await loginAs('rotate@test.local');

    const response = await api().post(`${API}/auth/refresh`).set('Cookie', refreshCookie);

    expect(response.status).toBe(200);
    expect(response.body.data.accessToken).toBeTypeOf('string');

    const cookies = response.headers['set-cookie'] as unknown as string[];
    const rotated = cookies.find((c) => c.startsWith('hrm_refresh_token='));

    expect(rotated).toBeDefined();
    // Rotation: the new token must not be the old one, or a stolen token would
    // stay valid for its full lifetime.
    expect(rotated).not.toBe(refreshCookie);
  });

  it('detects reuse of an already-rotated token and revokes every session', async () => {
    const { refreshCookie: original } = await loginAs('rotate@test.local');

    // Legitimate refresh: the original token is now spent.
    const first = await api().post(`${API}/auth/refresh`).set('Cookie', original);
    expect(first.status).toBe(200);

    const rotated = (first.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('hrm_refresh_token='),
    )!;

    // Replaying the spent token means two parties hold it — one of them stole it.
    const replay = await api().post(`${API}/auth/refresh`).set('Cookie', original);
    expect(replay.status).toBe(401);

    // We cannot tell which party is the thief, so *both* sessions die: even the
    // freshly-rotated token is now rejected.
    const afterBreach = await api().post(`${API}/auth/refresh`).set('Cookie', rotated);
    expect(afterBreach.status).toBe(401);
  });

  it('rejects a refresh with no cookie', async () => {
    const response = await api().post(`${API}/auth/refresh`);
    expect(response.status).toBe(401);
  });

  it('invalidates the refresh token on logout', async () => {
    const { refreshCookie } = await loginAs('rotate@test.local');

    const logout = await api().post(`${API}/auth/logout`).set('Cookie', refreshCookie);
    expect(logout.status).toBe(204);

    const afterLogout = await api().post(`${API}/auth/refresh`).set('Cookie', refreshCookie);
    expect(afterLogout.status).toBe(401);
  });
});

describe('POST /auth/change-password', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedReferenceData();
    await createTestUser({ email: 'changer@test.local' });
  });

  it('requires the current password even though the caller is authenticated', async () => {
    // Defends against a stolen access token being escalated into permanent
    // account takeover.
    const { accessToken } = await loginAs('changer@test.local');

    const response = await api()
      .post(`${API}/auth/change-password`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: 'NotTheRightOne1', newPassword: 'BrandNewPassw0rd!' });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('changes the password and revokes all existing sessions', async () => {
    const { accessToken, refreshCookie } = await loginAs('changer@test.local');

    const response = await api()
      .post(`${API}/auth/change-password`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'BrandNewPassw0rd!' });

    expect(response.status).toBe(204);

    // Old sessions are gone — a password change is treated as a possible
    // response to compromise.
    const staleRefresh = await api().post(`${API}/auth/refresh`).set('Cookie', refreshCookie);
    expect(staleRefresh.status).toBe(401);

    // The old password no longer works, the new one does.
    const oldPassword = await api()
      .post(`${API}/auth/login`)
      .send({ email: 'changer@test.local', password: TEST_PASSWORD });
    expect(oldPassword.status).toBe(401);

    const newPassword = await api()
      .post(`${API}/auth/login`)
      .send({ email: 'changer@test.local', password: 'BrandNewPassw0rd!' });
    expect(newPassword.status).toBe(200);
  });

  it('rejects a new password that is too short', async () => {
    const { accessToken } = await loginAs('changer@test.local');

    const response = await api()
      .post(`${API}/auth/change-password`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'short' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
});
