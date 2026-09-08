import { beforeAll, describe, expect, it } from 'vitest';

import { API, api, tokenFor } from './helpers/api.js';
import {
  createLeaveRequest,
  createTestUser,
  resetDatabase,
  seedReferenceData,
  type TestUser,
} from './helpers/fixtures.js';

/**
 * The authorization suite.
 *
 * Deliberately separate from the functional tests, because these are the ones
 * that catch the highest-severity bugs — a broken feature annoys a user, a
 * broken authorization check exposes everyone's data. Grouping them means a
 * reviewer can read the whole security surface in one file, and a failure here
 * is unambiguous about what it means.
 *
 * The pattern throughout: call a protected endpoint as the *wrong* caller and
 * assert the refusal. Anonymous → 401 (who are you?). Authenticated but not
 * permitted → 403 (I know who you are, and no).
 */

let employee: TestUser;
let otherEmployee: TestUser;
let hr: TestUser;
let admin: TestUser;
let pendingRequestId: string;
let refs: Awaited<ReturnType<typeof seedReferenceData>>;

beforeAll(async () => {
  await resetDatabase();
  refs = await seedReferenceData();

  employee = await createTestUser({
    email: 'emp@test.local',
    role: 'EMPLOYEE',
    departmentId: refs.departmentId,
    annualLeaveTypeId: refs.annualLeaveTypeId,
    baseSalary: 30_000_000,
  });

  otherEmployee = await createTestUser({
    email: 'other@test.local',
    role: 'EMPLOYEE',
    departmentId: refs.departmentId,
    annualLeaveTypeId: refs.annualLeaveTypeId,
    baseSalary: 99_000_000,
  });

  hr = await createTestUser({
    email: 'hr@test.local',
    role: 'HR',
    departmentId: refs.departmentId,
    annualLeaveTypeId: refs.annualLeaveTypeId,
  });

  admin = await createTestUser({
    email: 'admin@test.local',
    role: 'ADMIN',
    departmentId: refs.departmentId,
    annualLeaveTypeId: refs.annualLeaveTypeId,
  });

  pendingRequestId = await createLeaveRequest({
    employeeId: otherEmployee.employeeId,
    leaveTypeId: refs.annualLeaveTypeId,
    startDate: '2026-12-07',
    endDate: '2026-12-08',
    totalDays: 2,
    status: 'PENDING',
  });
});

describe('unauthenticated access', () => {
  const protectedRoutes: [string, string][] = [
    ['get', `${API}/employees`],
    ['get', `${API}/employees/me`],
    ['get', `${API}/departments`],
    ['get', `${API}/attendance`],
    ['post', `${API}/attendance/check-in`],
    ['get', `${API}/leave/requests`],
    ['get', `${API}/dashboard/overview`],
    ['post', `${API}/ai/assistant`],
  ];

  it.each(protectedRoutes)('%s %s requires authentication', async (method, path) => {
    const response = await (method === 'get' ? api().get(path) : api().post(path).send({}));

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });
});

describe('EMPLOYEE role restrictions', () => {
  it('cannot list all employees', async () => {
    const response = await api()
      .get(`${API}/employees`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('INSUFFICIENT_ROLE');
  });

  it('cannot read another employee record', async () => {
    const response = await api()
      .get(`${API}/employees/${otherEmployee.employeeId}`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('NOT_YOUR_RECORD');
  });

  it('can read their own employee record', async () => {
    const response = await api()
      .get(`${API}/employees/${employee.employeeId}`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`);

    expect(response.status).toBe(200);
    expect(response.body.data.id).toBe(employee.employeeId);
  });

  it('sees their own salary but never anyone else in a list they can reach', async () => {
    // Field-level authorization: `baseSalary` is present for the caller's own
    // record and absent — not null — for anyone else's.
    const own = await api()
      .get(`${API}/employees/me`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`);

    expect(own.status).toBe(200);
    expect(own.body.data.baseSalary).toBe(30_000_000);
  });

  it('cannot create an employee', async () => {
    const response = await api()
      .post(`${API}/employees`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`)
      .send({
        email: 'new@test.local',
        password: 'ValidPassw0rd!',
        employeeCode: 'EMP9999',
        firstName: 'New',
        lastName: 'Person',
        hireDate: '2026-01-01',
      });

    expect(response.status).toBe(403);
  });

  it('cannot approve a leave request', async () => {
    const response = await api()
      .patch(`${API}/leave/requests/${pendingRequestId}/approve`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`)
      .send({});

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('INSUFFICIENT_ROLE');
  });

  it('cannot reject a leave request', async () => {
    const response = await api()
      .patch(`${API}/leave/requests/${pendingRequestId}/reject`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`)
      .send({ decisionNote: 'Denied by an unauthorised caller' });

    expect(response.status).toBe(403);
  });

  it('cannot cancel someone else\'s leave request', async () => {
    const response = await api()
      .patch(`${API}/leave/requests/${pendingRequestId}/cancel`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('NOT_YOUR_RECORD');
  });

  it('cannot read another employee\'s leave request', async () => {
    const response = await api()
      .get(`${API}/leave/requests/${pendingRequestId}`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`);

    expect(response.status).toBe(403);
  });

  it('cannot see the organisation dashboard', async () => {
    const response = await api()
      .get(`${API}/dashboard/overview`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`);

    expect(response.status).toBe(403);
  });

  it('cannot correct an attendance record', async () => {
    const response = await api()
      .patch(`${API}/attendance/${crypto.randomUUID()}`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`)
      .send({ note: 'Adjusted' });

    expect(response.status).toBe(403);
  });

  it('cannot create a department', async () => {
    const response = await api()
      .post(`${API}/departments`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`)
      .send({ code: 'HACK', name: 'Injected Department' });

    expect(response.status).toBe(403);
  });

  it('has its employeeId filter silently overridden when listing attendance', async () => {
    // Not a 403: the query is *rewritten* to the caller's own id, so there is no
    // code path in which another employee's records could be returned.
    const response = await api()
      .get(`${API}/attendance`)
      .query({ employeeId: otherEmployee.employeeId })
      .set('Authorization', `Bearer ${tokenFor(employee)}`);

    expect(response.status).toBe(200);
    for (const record of response.body.data) {
      expect(record.employeeId).toBe(employee.employeeId);
    }
  });

  it('has its employeeId filter silently overridden when listing leave requests', async () => {
    const response = await api()
      .get(`${API}/leave/requests`)
      .query({ employeeId: otherEmployee.employeeId })
      .set('Authorization', `Bearer ${tokenFor(employee)}`);

    expect(response.status).toBe(200);
    for (const request of response.body.data) {
      expect(request.employeeId).toBe(employee.employeeId);
    }
  });

  it('cannot read another employee\'s leave balance', async () => {
    const response = await api()
      .get(`${API}/leave/balances`)
      .query({ employeeId: otherEmployee.employeeId })
      .set('Authorization', `Bearer ${tokenFor(employee)}`);

    // The employeeId is ignored and the caller's own balance is returned.
    expect(response.status).toBe(200);
    expect(response.body.data.employeeId).toBe(employee.employeeId);
  });
});

describe('HR role boundaries', () => {
  it('can list employees', async () => {
    const response = await api()
      .get(`${API}/employees`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`);

    expect(response.status).toBe(200);
  });

  it('can read any employee, including salary', async () => {
    const response = await api()
      .get(`${API}/employees/${otherEmployee.employeeId}`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`);

    expect(response.status).toBe(200);
    expect(response.body.data.baseSalary).toBe(99_000_000);
  });

  it('cannot create an ADMIN account — privilege escalation guard', async () => {
    // The check that matters most on the employee-creation endpoint: HR manages
    // people, ADMIN manages access. If HR could mint admins, the boundary between
    // the two roles would mean nothing.
    const response = await api()
      .post(`${API}/employees`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`)
      .send({
        email: 'escalated@test.local',
        password: 'ValidPassw0rd!',
        role: 'ADMIN',
        employeeCode: 'EMP8888',
        firstName: 'Escalated',
        lastName: 'Admin',
        hireDate: '2026-01-01',
      });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('INSUFFICIENT_ROLE');
  });

  it('cannot create an HR account either', async () => {
    const response = await api()
      .post(`${API}/employees`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`)
      .send({
        email: 'newhr@test.local',
        password: 'ValidPassw0rd!',
        role: 'HR',
        employeeCode: 'EMP8887',
        firstName: 'New',
        lastName: 'Hr',
        hireDate: '2026-01-01',
      });

    expect(response.status).toBe(403);
  });

  it('can create an ordinary EMPLOYEE account', async () => {
    const response = await api()
      .post(`${API}/employees`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`)
      .send({
        email: 'normal@test.local',
        password: 'ValidPassw0rd!',
        employeeCode: 'EMP8886',
        firstName: 'Normal',
        lastName: 'Employee',
        hireDate: '2026-01-01',
        departmentId: refs.departmentId,
      });

    expect(response.status).toBe(201);
    expect(response.body.data.employeeCode).toBe('EMP8886');
  });
});

describe('ADMIN role', () => {
  it('may create an ADMIN account', async () => {
    const response = await api()
      .post(`${API}/employees`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({
        email: 'second-admin@test.local',
        password: 'ValidPassw0rd!',
        role: 'ADMIN',
        employeeCode: 'EMP7777',
        firstName: 'Second',
        lastName: 'Admin',
        hireDate: '2026-01-01',
      });

    expect(response.status).toBe(201);
  });
});

describe('mass assignment', () => {
  it('ignores fields that are not part of the update schema', async () => {
    // Zod strips unknown keys, so a client cannot promote itself by adding
    // `role` to an employee update — the field never reaches the service.
    const response = await api()
      .patch(`${API}/employees/me`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`)
      .send({ phone: '0900000000', role: 'ADMIN', baseSalary: 999_999_999 });

    expect(response.status).toBe(200);
    expect(response.body.data.phone).toBe('0900000000');
    // Salary unchanged, despite being present in the request body.
    expect(response.body.data.baseSalary).toBe(30_000_000);

    const identity = await api()
      .get(`${API}/auth/me`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`);
    expect(identity.body.data.role).toBe('EMPLOYEE');
  });
});
