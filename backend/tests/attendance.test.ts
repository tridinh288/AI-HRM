import { beforeEach, describe, expect, it } from 'vitest';

import { API, api, tokenFor } from './helpers/api.js';
import {
  createAttendance,
  createTestUser,
  resetDatabase,
  seedReferenceData,
  type TestUser,
} from './helpers/fixtures.js';

/**
 * Attendance, end to end.
 *
 * The rules themselves (late, overtime, worked minutes) are unit-tested in
 * `src/modules/attendance/attendance.policy.test.ts` where they need no
 * database. What is tested here is everything that only a real database can
 * show: the unique constraint, the conflict responses, and the role scoping.
 */

let employee: TestUser;
let hr: TestUser;
let refs: Awaited<ReturnType<typeof seedReferenceData>>;

beforeEach(async () => {
  await resetDatabase();
  refs = await seedReferenceData();

  employee = await createTestUser({
    email: 'worker@test.local',
    role: 'EMPLOYEE',
    departmentId: refs.departmentId,
    annualLeaveTypeId: refs.annualLeaveTypeId,
  });

  hr = await createTestUser({
    email: 'hrstaff@test.local',
    role: 'HR',
    departmentId: refs.departmentId,
    annualLeaveTypeId: refs.annualLeaveTypeId,
  });
});

describe('POST /attendance/check-in', () => {
  it('creates today\'s attendance record', async () => {
    const response = await api()
      .post(`${API}/attendance/check-in`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`);

    expect(response.status).toBe(201);
    expect(response.body.data.employeeId).toBe(employee.employeeId);
    expect(response.body.data.checkInAt).toBeTruthy();
    expect(response.body.data.checkOutAt).toBeNull();
    expect(['PRESENT', 'LATE']).toContain(response.body.data.status);
  });

  it('rejects a second check-in on the same day with 409', async () => {
    await api()
      .post(`${API}/attendance/check-in`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`);

    const second = await api()
      .post(`${API}/attendance/check-in`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`);

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('ALREADY_CHECKED_IN');
  });

  it('is protected by a database constraint, not only by application code', async () => {
    // The service has no "does a record exist?" read at all — it relies on this
    // index, because two concurrent requests would both pass such a check.
    // Inserting a duplicate directly proves the index is really there.
    const { asPostgresError } = await import('../src/shared/errors.js');
    const today = new Date().toISOString().slice(0, 10);

    await createAttendance({ employeeId: employee.employeeId, workDate: today });

    let caught: unknown;
    try {
      await createAttendance({ employeeId: employee.employeeId, workDate: today });
    } catch (error) {
      caught = error;
    }

    // 23505 is unique_violation. Note the unwrapping: Drizzle wraps the driver
    // error, so the SQLSTATE lives on `.cause` — which is exactly the bug this
    // test caught the first time it ran.
    expect(asPostgresError(caught)?.code).toBe('23505');
    expect(asPostgresError(caught)?.constraint).toBe('attendance_employee_date_unique');
  });

  it('refuses an account with no employee record', async () => {
    const orphan = await createTestUser({
      email: 'orphan@test.local',
      role: 'ADMIN',
      withEmployee: false,
    });

    const response = await api()
      .post(`${API}/attendance/check-in`)
      .set('Authorization', `Bearer ${tokenFor(orphan)}`);

    expect(response.status).toBe(403);
  });
});

describe('POST /attendance/check-out', () => {
  it('rejects a check-out with no check-in', async () => {
    const response = await api()
      .post(`${API}/attendance/check-out`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('NOT_CHECKED_IN');
  });

  it('completes the day and records worked minutes', async () => {
    await api()
      .post(`${API}/attendance/check-in`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`);

    const response = await api()
      .post(`${API}/attendance/check-out`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`);

    expect(response.status).toBe(200);
    expect(response.body.data.checkOutAt).toBeTruthy();
    // Check-in and check-out land milliseconds apart in a test, so the elapsed
    // time is under the break threshold and no time is deducted — the important
    // assertion is that it is never negative.
    expect(response.body.data.workMinutes).toBeGreaterThanOrEqual(0);
  });

  it('rejects a second check-out with 409', async () => {
    const token = tokenFor(employee);
    await api().post(`${API}/attendance/check-in`).set('Authorization', `Bearer ${token}`);
    await api().post(`${API}/attendance/check-out`).set('Authorization', `Bearer ${token}`);

    const second = await api()
      .post(`${API}/attendance/check-out`)
      .set('Authorization', `Bearer ${token}`);

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('ALREADY_CHECKED_OUT');
  });
});

describe('GET /attendance/today', () => {
  it('returns no record before checking in', async () => {
    const response = await api()
      .get(`${API}/attendance/today`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`);

    expect(response.status).toBe(200);
    expect(response.body.data.record).toBeNull();
  });

  it('returns the record after checking in', async () => {
    const token = tokenFor(employee);
    await api().post(`${API}/attendance/check-in`).set('Authorization', `Bearer ${token}`);

    const response = await api()
      .get(`${API}/attendance/today`)
      .set('Authorization', `Bearer ${token}`);

    expect(response.body.data.record).not.toBeNull();
    expect(response.body.data.record.employeeId).toBe(employee.employeeId);
  });
});

describe('GET /attendance/summary', () => {
  it('aggregates a month of records', async () => {
    await createAttendance({
      employeeId: employee.employeeId,
      workDate: '2026-03-16',
      status: 'LATE',
      lateMinutes: 15,
      workMinutes: 480,
    });
    await createAttendance({
      employeeId: employee.employeeId,
      workDate: '2026-03-17',
      status: 'PRESENT',
      workMinutes: 510,
    });

    const response = await api()
      .get(`${API}/attendance/summary`)
      .query({ from: '2026-03-01', to: '2026-03-31' })
      .set('Authorization', `Bearer ${tokenFor(employee)}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      daysRecorded: 2,
      presentDays: 1,
      lateDays: 1,
      totalLateMinutes: 15,
      totalWorkMinutes: 990,
    });
  });

  it('rejects a reversed date range', async () => {
    const response = await api()
      .get(`${API}/attendance/summary`)
      .query({ from: '2026-03-31', to: '2026-03-01' })
      .set('Authorization', `Bearer ${tokenFor(employee)}`);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_DATE_RANGE');
  });

  it('lets HR request another employee\'s summary', async () => {
    await createAttendance({
      employeeId: employee.employeeId,
      workDate: '2026-03-16',
      status: 'LATE',
      lateMinutes: 20,
    });

    const response = await api()
      .get(`${API}/attendance/summary`)
      .query({ employeeId: employee.employeeId, from: '2026-03-01', to: '2026-03-31' })
      .set('Authorization', `Bearer ${tokenFor(hr)}`);

    expect(response.status).toBe(200);
    expect(response.body.data.employeeId).toBe(employee.employeeId);
    expect(response.body.data.lateDays).toBe(1);
  });
});

describe('PATCH /attendance/:id (HR correction)', () => {
  it('recomputes derived fields from the corrected timestamps', async () => {
    const id = await createAttendance({
      employeeId: employee.employeeId,
      workDate: '2026-03-16',
      checkInAt: new Date('2026-03-16T01:00:00Z'), // 08:00 local
      status: 'PRESENT',
    });

    const response = await api()
      .patch(`${API}/attendance/${id}`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`)
      .send({
        checkInAt: '2026-03-16T01:20:00.000Z', // 08:20 local — 20 minutes late
        checkOutAt: '2026-03-16T11:30:00.000Z', // 18:30 local — an hour of overtime
        note: 'Corrected from the door log',
      });

    expect(response.status).toBe(200);
    // HR supplies times; the server derives status and minutes with the same
    // policy functions the live check-in uses, so a corrected record cannot end
    // up internally inconsistent.
    expect(response.body.data.status).toBe('LATE');
    expect(response.body.data.lateMinutes).toBe(20);
    expect(response.body.data.overtimeMinutes).toBe(60);
    expect(response.body.data.correctedAt).toBeTruthy();
  });

  it('rejects a correction where check-out precedes check-in', async () => {
    const id = await createAttendance({
      employeeId: employee.employeeId,
      workDate: '2026-03-16',
      checkInAt: new Date('2026-03-16T01:00:00Z'),
    });

    const response = await api()
      .patch(`${API}/attendance/${id}`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`)
      .send({
        checkInAt: '2026-03-16T10:00:00.000Z',
        checkOutAt: '2026-03-16T02:00:00.000Z',
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_DATE_RANGE');
  });

  it('returns 404 for a record that does not exist', async () => {
    const response = await api()
      .patch(`${API}/attendance/${crypto.randomUUID()}`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`)
      .send({ note: 'Nothing here' });

    expect(response.status).toBe(404);
  });
});

describe('GET /attendance (listing)', () => {
  it('lets HR filter by employee and date range', async () => {
    await createAttendance({ employeeId: employee.employeeId, workDate: '2026-03-16' });
    await createAttendance({ employeeId: hr.employeeId, workDate: '2026-03-16' });

    const response = await api()
      .get(`${API}/attendance`)
      .query({ employeeId: employee.employeeId, from: '2026-03-01', to: '2026-03-31' })
      .set('Authorization', `Bearer ${tokenFor(hr)}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.meta.total).toBe(1);
  });

  it('paginates', async () => {
    for (let day = 1; day <= 5; day += 1) {
      await createAttendance({
        employeeId: employee.employeeId,
        workDate: `2026-03-0${day}`,
      });
    }

    const response = await api()
      .get(`${API}/attendance`)
      .query({ page: 1, pageSize: 2 })
      .set('Authorization', `Bearer ${tokenFor(hr)}`);

    expect(response.body.data).toHaveLength(2);
    expect(response.body.meta).toMatchObject({ page: 1, pageSize: 2, total: 5, totalPages: 3 });
  });

  it('rejects a pageSize above the cap', async () => {
    const response = await api()
      .get(`${API}/attendance`)
      .query({ pageSize: 5000 })
      .set('Authorization', `Bearer ${tokenFor(hr)}`);

    expect(response.status).toBe(400);
  });
});
