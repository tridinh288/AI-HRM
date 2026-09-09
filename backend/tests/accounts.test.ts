import { and, eq, isNull } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { db } from '../src/db/client.js';
import { auditLogs, employees, refreshTokens, users } from '../src/db/schema.js';
import { API, api, loginAs, tokenFor } from './helpers/api.js';
import {
  createTestUser,
  resetDatabase,
  seedReferenceData,
  TEST_PASSWORD,
  type TestUser,
} from './helpers/fixtures.js';

/**
 * Account administration — the one capability ADMIN has that HR does not.
 *
 * PATCH /employees/:id/account changes the role or the active flag of the
 * account behind an employee. The tests below are mostly about what it
 * refuses: the endpoint exists to change access, and the ways changing
 * access goes wrong are the interesting part.
 */

let admin: TestUser;
let hr: TestUser;
let employee: TestUser;
let refs: Awaited<ReturnType<typeof seedReferenceData>>;

beforeEach(async () => {
  await resetDatabase();
  refs = await seedReferenceData();

  admin = await createTestUser({ email: 'acct-admin@test.local', role: 'ADMIN' });
  hr = await createTestUser({ email: 'acct-hr@test.local', role: 'HR' });
  employee = await createTestUser({
    email: 'acct-employee@test.local',
    role: 'EMPLOYEE',
    departmentId: refs.departmentId,
  });
});

function patchAccount(actor: TestUser, target: TestUser, body: Record<string, unknown>) {
  return api()
    .patch(`${API}/employees/${target.employeeId}/account`)
    .set('Authorization', `Bearer ${tokenFor(actor)}`)
    .send(body);
}

async function roleOf(userId: string): Promise<{ role: string; isActive: boolean }> {
  const [row] = await db
    .select({ role: users.role, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, userId));
  return row!;
}

describe('who may use it', () => {
  it('refuses HR — managing people is not managing access', async () => {
    const response = await patchAccount(hr, employee, { role: 'HR' });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('INSUFFICIENT_ROLE');
    expect((await roleOf(employee.userId)).role).toBe('EMPLOYEE');
  });

  it('refuses an EMPLOYEE, even against their own account', async () => {
    const response = await patchAccount(employee, employee, { role: 'ADMIN' });

    expect(response.status).toBe(403);
    expect((await roleOf(employee.userId)).role).toBe('EMPLOYEE');
  });
});

describe('changing a role', () => {
  it('lets an administrator promote an employee to HR, and records it', async () => {
    const response = await patchAccount(admin, employee, { role: 'HR' });

    expect(response.status).toBe(200);
    expect(response.body.data.role).toBe('HR');
    expect((await roleOf(employee.userId)).role).toBe('HR');

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, 'user'), eq(auditLogs.entityId, employee.userId)));

    expect(audit?.action).toBe('account.updated');
    expect(audit?.actorUserId).toBe(admin.userId);
    expect(audit?.metadata).toMatchObject({
      from: { role: 'EMPLOYEE', isActive: true },
      to: { role: 'HR', isActive: true },
    });
  });

  it('ends the account\'s sessions so the new role is read at the next refresh', async () => {
    // A real login, so there is a refresh token to revoke.
    const session = await loginAs(employee.email);
    expect(session.refreshCookie).not.toBe('');

    await patchAccount(admin, employee, { role: 'HR' });

    const live = await db
      .select({ id: refreshTokens.id })
      .from(refreshTokens)
      .where(and(eq(refreshTokens.userId, employee.userId), isNull(refreshTokens.revokedAt)));
    expect(live).toHaveLength(0);

    const refresh = await api().post(`${API}/auth/refresh`).set('Cookie', session.refreshCookie);
    expect(refresh.status).toBe(401);
  });

  it('refuses to change the caller\'s own account', async () => {
    const response = await patchAccount(admin, admin, { role: 'EMPLOYEE' });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CANNOT_MODIFY_OWN_ACCOUNT');
    expect((await roleOf(admin.userId)).role).toBe('ADMIN');
  });

  it('refuses to demote the last active administrator', async () => {
    // A second administrator, so there is someone to demote — and the first
    // one's own account is then deactivated directly, standing in for an
    // administrator whose access token has not yet expired. The second is now
    // the only active administrator, and must stay one.
    const other = await createTestUser({ email: 'acct-admin2@test.local', role: 'ADMIN' });
    await db.update(users).set({ isActive: false }).where(eq(users.id, admin.userId));

    const demote = await patchAccount(admin, other, { role: 'HR' });
    expect(demote.status).toBe(409);
    expect(demote.body.error.code).toBe('LAST_ADMIN');

    const disable = await patchAccount(admin, other, { isActive: false });
    expect(disable.status).toBe(409);
    expect(disable.body.error.code).toBe('LAST_ADMIN');

    expect(await roleOf(other.userId)).toEqual({ role: 'ADMIN', isActive: true });
  });

  it('allows demoting an administrator while another remains', async () => {
    const other = await createTestUser({ email: 'acct-admin2@test.local', role: 'ADMIN' });

    const response = await patchAccount(admin, other, { role: 'HR' });

    expect(response.status).toBe(200);
    expect((await roleOf(other.userId)).role).toBe('HR');
  });
});

describe('disabling and re-enabling', () => {
  it('locks the account out at the next login', async () => {
    await loginAs(employee.email);

    const response = await patchAccount(admin, employee, { isActive: false });
    expect(response.status).toBe(200);
    expect(response.body.data.isActive).toBe(false);

    const login = await api()
      .post(`${API}/auth/login`)
      .send({ email: employee.email, password: TEST_PASSWORD });
    expect(login.status).toBe(401);
  });

  it('re-enables an account that was disabled', async () => {
    await patchAccount(admin, employee, { isActive: false });

    const response = await patchAccount(admin, employee, { isActive: true });

    expect(response.status).toBe(200);
    expect((await roleOf(employee.userId)).isActive).toBe(true);
  });

  it('refuses to re-enable the login of a terminated employee', async () => {
    // Termination disabled the login on purpose; the account route must not
    // be a way around that decision.
    await db
      .update(employees)
      .set({ employmentStatus: 'TERMINATED', terminatedAt: new Date() })
      .where(eq(employees.id, employee.employeeId));
    await db.update(users).set({ isActive: false }).where(eq(users.id, employee.userId));

    const response = await patchAccount(admin, employee, { isActive: true });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('EMPLOYEE_TERMINATED');
    expect((await roleOf(employee.userId)).isActive).toBe(false);
  });
});

describe('input', () => {
  it('rejects an empty body', async () => {
    const response = await patchAccount(admin, employee, {});
    expect(response.status).toBe(400);
  });

  it('rejects a role that does not exist', async () => {
    const response = await patchAccount(admin, employee, { role: 'SUPERUSER' });
    expect(response.status).toBe(400);
  });

  it('returns 404 for an employee that does not exist', async () => {
    const response = await api()
      .patch(`${API}/employees/00000000-0000-4000-8000-000000000000/account`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ role: 'HR' });
    expect(response.status).toBe(404);
  });
});
