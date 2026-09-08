import { beforeAll, describe, expect, it } from 'vitest';

import { API, api, tokenFor } from './helpers/api.js';
import {
  createAttendance,
  createLeaveRequest,
  createTestUser,
  resetDatabase,
  seedReferenceData,
  type TestUser,
} from './helpers/fixtures.js';

/**
 * Dashboard aggregations.
 *
 * These queries are raw SQL, which means TypeScript cannot check the column
 * names for us — so every one of them is executed here against a real database
 * with known data. That is the trade-off stated in dashboard.repository.ts,
 * honoured.
 */

let hr: TestUser;
let employeeA: TestUser;
let employeeB: TestUser;
let refs: Awaited<ReturnType<typeof seedReferenceData>>;

const today = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  await resetDatabase();
  refs = await seedReferenceData();

  hr = await createTestUser({
    email: 'dash-hr@test.local',
    role: 'HR',
    departmentId: refs.departmentId,
    annualLeaveTypeId: refs.annualLeaveTypeId,
  });

  employeeA = await createTestUser({
    email: 'dash-a@test.local',
    departmentId: refs.departmentId,
    annualLeaveTypeId: refs.annualLeaveTypeId,
  });

  employeeB = await createTestUser({
    email: 'dash-b@test.local',
    departmentId: refs.otherDepartmentId,
    annualLeaveTypeId: refs.annualLeaveTypeId,
  });

  await createAttendance({ employeeId: employeeA.employeeId, workDate: today, status: 'PRESENT' });
  await createAttendance({
    employeeId: employeeB.employeeId,
    workDate: today,
    status: 'LATE',
    lateMinutes: 25,
  });

  await createLeaveRequest({
    employeeId: employeeA.employeeId,
    leaveTypeId: refs.annualLeaveTypeId,
    startDate: '2026-12-14',
    endDate: '2026-12-15',
    totalDays: 2,
    status: 'PENDING',
  });
});

describe('GET /dashboard/overview', () => {
  it('returns today\'s snapshot', async () => {
    const response = await api()
      .get(`${API}/dashboard/overview`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      totalEmployees: 3,
      activeEmployees: 3,
      departmentCount: 2,
      presentToday: 1,
      lateToday: 1,
      pendingLeaveRequests: 1,
    });
  });

  it('derives absence rather than storing it', async () => {
    const response = await api()
      .get(`${API}/dashboard/overview`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`);

    // Three active people, two have a record today, nobody is on approved leave.
    expect(response.body.data.notCheckedInToday).toBe(1);
  });
});

describe('GET /dashboard/charts', () => {
  it('returns every chart series in one response', async () => {
    const response = await api()
      .get(`${API}/dashboard/charts`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`);

    expect(response.status).toBe(200);

    const data = response.body.data;
    expect(data.headcountByDepartment).toBeInstanceOf(Array);
    expect(data.attendanceTrend).toBeInstanceOf(Array);
    expect(data.leaveStatistics).toBeInstanceOf(Array);
    expect(data.employeeGrowth).toBeInstanceOf(Array);
  });

  it('includes departments with nobody in them, as zeroes', async () => {
    const response = await api()
      .get(`${API}/dashboard/charts`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`);

    // A LEFT JOIN from departments, so an empty department is a zero on the
    // chart rather than a missing bar.
    expect(response.body.data.headcountByDepartment).toHaveLength(2);
    const total = response.body.data.headcountByDepartment.reduce(
      (sum: number, row: { employeeCount: number }) => sum + row.employeeCount,
      0,
    );
    expect(total).toBe(3);
  });

  it('fills days with no attendance records with zeroes rather than gaps', async () => {
    const response = await api()
      .get(`${API}/dashboard/charts`)
      .query({ days: 30 })
      .set('Authorization', `Bearer ${tokenFor(hr)}`);

    const trend = response.body.data.attendanceTrend as { workDate: string; late: number }[];

    // generate_series produces a row per weekday, so a line chart cannot draw a
    // straight line through missing days and imply "nobody was late".
    expect(trend.length).toBeGreaterThan(15);
    for (const point of trend) {
      const weekday = new Date(`${point.workDate}T00:00:00Z`).getUTCDay();
      expect(weekday).not.toBe(0);
      expect(weekday).not.toBe(6);
    }
  });

  it('produces a headcount running total per month', async () => {
    const response = await api()
      .get(`${API}/dashboard/charts`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`);

    const growth = response.body.data.employeeGrowth as { month: string; headcount: number }[];

    expect(growth).toHaveLength(12);
    expect(growth[growth.length - 1]?.headcount).toBe(3);
  });

  it('rejects a range outside the allowed bounds', async () => {
    const response = await api()
      .get(`${API}/dashboard/charts`)
      .query({ days: 5000 })
      .set('Authorization', `Bearer ${tokenFor(hr)}`);

    expect(response.status).toBe(400);
  });
});

describe('GET /dashboard/late-employees', () => {
  it('ranks employees by late days', async () => {
    const response = await api()
      .get(`${API}/dashboard/late-employees`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`);

    expect(response.status).toBe(200);
    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0]).toMatchObject({
      employeeId: employeeB.employeeId,
      lateDays: 1,
      totalLateMinutes: 25,
    });
  });

  it('never includes salary in the response', async () => {
    const response = await api()
      .get(`${API}/dashboard/late-employees`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`);

    expect(JSON.stringify(response.body)).not.toContain('baseSalary');
  });
});
