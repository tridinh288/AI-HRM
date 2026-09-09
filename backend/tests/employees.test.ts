import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { db } from '../src/db/client.js';
import { departments, employees, leaveBalances, users } from '../src/db/schema.js';
import { API, api, tokenFor } from './helpers/api.js';
import {
  TEST_PASSWORD,
  createTestUser,
  resetDatabase,
  seedReferenceData,
  type TestUser,
} from './helpers/fixtures.js';

let hr: TestUser;
let refs: Awaited<ReturnType<typeof seedReferenceData>>;

beforeEach(async () => {
  await resetDatabase();
  refs = await seedReferenceData();
  hr = await createTestUser({
    email: 'hr-emp@test.local',
    role: 'HR',
    departmentId: refs.departmentId,
    annualLeaveTypeId: refs.annualLeaveTypeId,
  });
});

function newEmployeePayload(overrides: Record<string, unknown> = {}) {
  return {
    email: 'new.hire@test.local',
    password: 'ValidPassw0rd!',
    employeeCode: 'EMP1234',
    firstName: 'New',
    lastName: 'Hire',
    hireDate: '2026-02-01',
    departmentId: refs.departmentId,
    positionId: refs.positionId,
    baseSalary: 25_000_000,
    ...overrides,
  };
}

describe('POST /employees', () => {
  it('creates the account, the HR record and this year\'s leave balances together', async () => {
    const response = await api()
      .post(`${API}/employees`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`)
      .send(newEmployeePayload());

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      employeeCode: 'EMP1234',
      fullName: 'New Hire',
      email: 'new.hire@test.local',
    });

    // The third write in the transaction: an employee with no balance rows
    // cannot request leave at all, so it must not be possible to create one.
    const balances = await db
      .select()
      .from(leaveBalances)
      .where(eq(leaveBalances.employeeId, response.body.data.id));

    expect(balances.length).toBe(2); // one per active leave type
    expect(balances.some((balance) => balance.entitledDays === 12)).toBe(true);
  });

  it('lets the new employee log in with the password that was set', async () => {
    await api()
      .post(`${API}/employees`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`)
      .send(newEmployeePayload());

    const login = await api()
      .post(`${API}/auth/login`)
      .send({ email: 'new.hire@test.local', password: 'ValidPassw0rd!' });

    expect(login.status).toBe(200);
    expect(login.body.data.user.role).toBe('EMPLOYEE');
  });

  it('rejects a duplicate email with 409', async () => {
    await api()
      .post(`${API}/employees`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`)
      .send(newEmployeePayload());

    const duplicate = await api()
      .post(`${API}/employees`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`)
      .send(newEmployeePayload({ employeeCode: 'EMP4321' }));

    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('EMAIL_ALREADY_EXISTS');
  });

  it('rejects a duplicate email that differs only in case', async () => {
    await api()
      .post(`${API}/employees`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`)
      .send(newEmployeePayload());

    const duplicate = await api()
      .post(`${API}/employees`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`)
      .send(newEmployeePayload({ email: 'New.Hire@Test.Local', employeeCode: 'EMP4321' }));

    expect(duplicate.status).toBe(409);
  });

  it('rejects a duplicate employee code with 409', async () => {
    await api()
      .post(`${API}/employees`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`)
      .send(newEmployeePayload());

    const duplicate = await api()
      .post(`${API}/employees`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`)
      .send(newEmployeePayload({ email: 'another@test.local' }));

    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('EMPLOYEE_CODE_ALREADY_EXISTS');
  });

  it('rolls the whole transaction back when a later step fails', async () => {
    // The account is inserted first and the employee code collides second. If
    // these were not in one transaction, this would leave an orphaned login that
    // can authenticate but has no HR record — and permanently burn the email.
    await api()
      .post(`${API}/employees`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`)
      .send(newEmployeePayload());

    const failed = await api()
      .post(`${API}/employees`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`)
      .send(newEmployeePayload({ email: 'orphan.check@test.local' }));

    expect(failed.status).toBe(409);

    const orphans = await db
      .select()
      .from(users)
      .where(eq(users.email, 'orphan.check@test.local'));

    expect(orphans).toHaveLength(0);
  });

  it('rejects a weak password', async () => {
    const response = await api()
      .post(`${API}/employees`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`)
      .send(newEmployeePayload({ password: 'short' }));

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an employee code in the wrong format', async () => {
    const response = await api()
      .post(`${API}/employees`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`)
      .send(newEmployeePayload({ employeeCode: 'not a code!' }));

    expect(response.status).toBe(400);
  });
});

describe('GET /employees', () => {
  beforeEach(async () => {
    for (let i = 1; i <= 5; i += 1) {
      await createTestUser({
        email: `list${i}@test.local`,
        departmentId: i <= 3 ? refs.departmentId : refs.otherDepartmentId,
        positionId: refs.positionId,
        annualLeaveTypeId: refs.annualLeaveTypeId,
      });
    }
  });

  it('paginates and reports totals', async () => {
    const response = await api()
      .get(`${API}/employees`)
      .query({ page: 1, pageSize: 2 })
      .set('Authorization', `Bearer ${tokenFor(hr)}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(2);
    expect(response.body.meta.total).toBe(6); // five created here plus the HR user
  });

  it('filters by department', async () => {
    const response = await api()
      .get(`${API}/employees`)
      .query({ departmentId: refs.otherDepartmentId })
      .set('Authorization', `Bearer ${tokenFor(hr)}`);

    expect(response.body.meta.total).toBe(2);
    for (const employee of response.body.data) {
      expect(employee.department.id).toBe(refs.otherDepartmentId);
    }
  });

  it('filters by department name or code, case-insensitively', async () => {
    // The register filters by id; the AI assistant only ever knows the name.
    const byName = await api()
      .get(`${API}/employees`)
      .query({ department: 'sales' })
      .set('Authorization', `Bearer ${tokenFor(hr)}`);

    expect(byName.status).toBe(200);
    expect(byName.body.data.length).toBeGreaterThan(0);
    for (const item of byName.body.data) {
      expect(item.department.name).toBe('Sales');
    }
    // The total must come from the same filter as the rows.
    expect(byName.body.meta.total).toBe(byName.body.data.length);

    const byCode = await api()
      .get(`${API}/employees`)
      .query({ department: 'eng' })
      .set('Authorization', `Bearer ${tokenFor(hr)}`);

    expect(byCode.status).toBe(200);
    expect(byCode.body.data.length).toBeGreaterThan(0);
    for (const item of byCode.body.data) {
      expect(item.department.name).toBe('Engineering');
    }
  });

  it('searches by email', async () => {
    const response = await api()
      .get(`${API}/employees`)
      .query({ search: 'list3@' })
      .set('Authorization', `Bearer ${tokenFor(hr)}`);

    expect(response.body.meta.total).toBe(1);
    expect(response.body.data[0].email).toBe('list3@test.local');
  });

  it('treats a search string with SQL metacharacters as literal text', async () => {
    // The pattern is a bound parameter, so this matches nothing rather than
    // executing anything.
    const response = await api()
      .get(`${API}/employees`)
      .query({ search: "'; drop table employees; --" })
      .set('Authorization', `Bearer ${tokenFor(hr)}`);

    expect(response.status).toBe(200);
    expect(response.body.meta.total).toBe(0);

    // The table is still there.
    const stillThere = await db.select({ n: sql<number>`count(*)::int` }).from(employees);
    expect(stillThere[0]!.n).toBe(6);
  });

  it('rejects a sort field that is not on the allow-list', async () => {
    const response = await api()
      .get(`${API}/employees`)
      .query({ sortBy: 'base_salary; drop table employees' })
      .set('Authorization', `Bearer ${tokenFor(hr)}`);

    expect(response.status).toBe(400);
  });

  it('sorts by hire date descending', async () => {
    const response = await api()
      .get(`${API}/employees`)
      .query({ sortBy: 'hireDate', sortOrder: 'desc', pageSize: 10 })
      .set('Authorization', `Bearer ${tokenFor(hr)}`);

    const dates = response.body.data.map((employee: { hireDate: string }) => employee.hireDate);
    expect([...dates].sort().reverse()).toEqual(dates);
  });
});

describe('POST /employees/:id/terminate', () => {
  it('marks the employee terminated and disables the login', async () => {
    const target = await createTestUser({
      email: 'leaver@test.local',
      departmentId: refs.departmentId,
      annualLeaveTypeId: refs.annualLeaveTypeId,
    });

    const response = await api()
      .post(`${API}/employees/${target.employeeId}/terminate`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`)
      .send({ reason: 'Resigned' });

    expect(response.status).toBe(200);
    expect(response.body.data.employmentStatus).toBe('TERMINATED');
    expect(response.body.data.terminatedAt).toBeTruthy();

    // The second half of the transaction: the account can no longer sign in.
    const login = await api()
      .post(`${API}/auth/login`)
      .send({ email: 'leaver@test.local', password: TEST_PASSWORD });

    expect(login.status).toBe(401);
  });

  it('rejects terminating the same employee twice', async () => {
    const target = await createTestUser({
      email: 'leaver2@test.local',
      departmentId: refs.departmentId,
    });

    await api()
      .post(`${API}/employees/${target.employeeId}/terminate`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`)
      .send({});

    const second = await api()
      .post(`${API}/employees/${target.employeeId}/terminate`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`)
      .send({});

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('EMPLOYEE_ALREADY_TERMINATED');
  });
});

describe('departments', () => {
  it('refuses to deactivate a department that still has employees', async () => {
    const response = await api()
      .post(`${API}/departments/${refs.departmentId}/deactivate`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('DEPARTMENT_NOT_EMPTY');
  });

  it('refuses at the database level to delete a department with employees', async () => {
    const { asPostgresError } = await import('../src/shared/errors.js');

    let caught: unknown;
    try {
      await db.delete(departments).where(eq(departments.id, refs.departmentId));
    } catch (error) {
      caught = error;
    }

    // 23503 is foreign_key_violation: ON DELETE RESTRICT holds even if
    // application code forgets to check.
    expect(asPostgresError(caught)?.code).toBe('23503');
  });

  it('reports headcount per department', async () => {
    const response = await api()
      .get(`${API}/departments`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`);

    expect(response.status).toBe(200);
    const engineering = response.body.data.find(
      (department: { code: string }) => department.code === 'ENG',
    );
    expect(engineering.employeeCount).toBe(1);
  });

  it('rejects a duplicate department code', async () => {
    const response = await api()
      .post(`${API}/departments`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`)
      .send({ code: 'ENG', name: 'Engineering Duplicate' });

    expect(response.status).toBe(409);
  });

  it('normalises the code to uppercase', async () => {
    const response = await api()
      .post(`${API}/departments`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`)
      .send({ code: 'ops', name: 'Operations' });

    expect(response.status).toBe(201);
    expect(response.body.data.code).toBe('OPS');
  });
});

describe('unknown routes', () => {
  it('returns a structured 404', async () => {
    const response = await api()
      .get(`${API}/does-not-exist`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body.error.requestId).toBeTruthy();
  });
});
