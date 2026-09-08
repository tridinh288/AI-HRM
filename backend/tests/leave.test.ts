import { beforeEach, describe, expect, it } from 'vitest';

import { API, api, tokenFor } from './helpers/api.js';
import {
  createLeaveRequest,
  createTestUser,
  resetDatabase,
  seedReferenceData,
  type TestUser,
} from './helpers/fixtures.js';

/**
 * Leave management, end to end.
 *
 * This is where the transactional behaviour lives, so these tests run against a
 * real database on purpose: the balance deduction, the `WHERE status =
 * 'PENDING'` atomic transition, and the CHECK constraint that backstops both are
 * all database behaviour that no mock reproduces.
 */

let employee: TestUser;
let colleague: TestUser;
let hr: TestUser;
let refs: Awaited<ReturnType<typeof seedReferenceData>>;

/** Dates are derived from today so the tests never drift out of policy window. */
function futureMonday(weeksAhead = 1): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + weeksAhead * 7);
  while (date.getUTCDay() !== 1) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const result = new Date(`${date}T00:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

beforeEach(async () => {
  await resetDatabase();
  refs = await seedReferenceData();

  employee = await createTestUser({
    email: 'requester@test.local',
    role: 'EMPLOYEE',
    departmentId: refs.departmentId,
    annualLeaveTypeId: refs.annualLeaveTypeId,
    entitledDays: 12,
  });

  colleague = await createTestUser({
    email: 'colleague@test.local',
    role: 'EMPLOYEE',
    departmentId: refs.departmentId,
    annualLeaveTypeId: refs.annualLeaveTypeId,
    entitledDays: 12,
  });

  hr = await createTestUser({
    email: 'approver@test.local',
    role: 'HR',
    departmentId: refs.departmentId,
    annualLeaveTypeId: refs.annualLeaveTypeId,
    entitledDays: 12,
  });
});

describe('POST /leave/requests', () => {
  it('creates a pending request and counts working days only', async () => {
    const monday = futureMonday();

    const response = await api()
      .post(`${API}/leave/requests`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`)
      .send({
        leaveTypeId: refs.annualLeaveTypeId,
        startDate: monday,
        endDate: addDays(monday, 4), // Monday to Friday
        reason: 'Family trip booked months ago',
      });

    expect(response.status).toBe(201);
    expect(response.body.data.status).toBe('PENDING');
    expect(response.body.data.totalDays).toBe(5);
  });

  it('excludes the weekend from a Friday-to-Monday request', async () => {
    const friday = addDays(futureMonday(), 4);

    const response = await api()
      .post(`${API}/leave/requests`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`)
      .send({
        leaveTypeId: refs.annualLeaveTypeId,
        startDate: friday,
        endDate: addDays(friday, 3), // Friday → Monday
        reason: 'Long weekend away',
      });

    expect(response.status).toBe(201);
    expect(response.body.data.totalDays).toBe(2);
  });

  it('rejects a reversed date range at the validation layer', async () => {
    const monday = futureMonday();

    const response = await api()
      .post(`${API}/leave/requests`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`)
      .send({
        leaveTypeId: refs.annualLeaveTypeId,
        startDate: addDays(monday, 3),
        endDate: monday,
        reason: 'Reversed range should fail',
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a request covering only a weekend', async () => {
    const saturday = addDays(futureMonday(), 5);

    const response = await api()
      .post(`${API}/leave/requests`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`)
      .send({
        leaveTypeId: refs.annualLeaveTypeId,
        startDate: saturday,
        endDate: addDays(saturday, 1),
        reason: 'Weekend only, nothing to deduct',
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_DATE_RANGE');
  });

  it('rejects a request overlapping an existing one', async () => {
    const monday = futureMonday();

    await api()
      .post(`${API}/leave/requests`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`)
      .send({
        leaveTypeId: refs.annualLeaveTypeId,
        startDate: monday,
        endDate: addDays(monday, 2),
        reason: 'First request for this week',
      });

    const overlapping = await api()
      .post(`${API}/leave/requests`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`)
      .send({
        leaveTypeId: refs.annualLeaveTypeId,
        startDate: addDays(monday, 1), // starts inside the first range
        endDate: addDays(monday, 3),
        reason: 'Overlapping request',
      });

    expect(overlapping.status).toBe(409);
    expect(overlapping.body.error.code).toBe('LEAVE_OVERLAP');
    expect(overlapping.body.error.details).toBeInstanceOf(Array);
  });

  it('allows a colleague to book the same dates', async () => {
    const monday = futureMonday();

    await api()
      .post(`${API}/leave/requests`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`)
      .send({
        leaveTypeId: refs.annualLeaveTypeId,
        startDate: monday,
        endDate: addDays(monday, 2),
        reason: 'Same week as a colleague',
      });

    const response = await api()
      .post(`${API}/leave/requests`)
      .set('Authorization', `Bearer ${tokenFor(colleague)}`)
      .send({
        leaveTypeId: refs.annualLeaveTypeId,
        startDate: monday,
        endDate: addDays(monday, 2),
        reason: 'Overlap is per person, not per company',
      });

    expect(response.status).toBe(201);
  });

  it('rejects a request that exceeds the remaining balance', async () => {
    const poor = await createTestUser({
      email: 'nobalance@test.local',
      role: 'EMPLOYEE',
      departmentId: refs.departmentId,
      annualLeaveTypeId: refs.annualLeaveTypeId,
      entitledDays: 2,
    });

    const monday = futureMonday();

    const response = await api()
      .post(`${API}/leave/requests`)
      .set('Authorization', `Bearer ${tokenFor(poor)}`)
      .send({
        leaveTypeId: refs.annualLeaveTypeId,
        startDate: monday,
        endDate: addDays(monday, 4), // 5 working days against a 2-day balance
        reason: 'More days than remain',
      });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('LEAVE_BALANCE_EXCEEDED');
  });

  it('counts days already committed to pending requests against the balance', async () => {
    const limited = await createTestUser({
      email: 'limited@test.local',
      role: 'EMPLOYEE',
      departmentId: refs.departmentId,
      annualLeaveTypeId: refs.annualLeaveTypeId,
      entitledDays: 5,
    });

    const firstWeek = futureMonday(1);
    const secondWeek = futureMonday(3);

    const first = await api()
      .post(`${API}/leave/requests`)
      .set('Authorization', `Bearer ${tokenFor(limited)}`)
      .send({
        leaveTypeId: refs.annualLeaveTypeId,
        startDate: firstWeek,
        endDate: addDays(firstWeek, 4),
        reason: 'Uses the whole entitlement while pending',
      });
    expect(first.status).toBe(201);

    // The balance has not been deducted yet — deduction happens on approval —
    // but those five days are already spoken for.
    const second = await api()
      .post(`${API}/leave/requests`)
      .set('Authorization', `Bearer ${tokenFor(limited)}`)
      .send({
        leaveTypeId: refs.annualLeaveTypeId,
        startDate: secondWeek,
        endDate: addDays(secondWeek, 1),
        reason: 'Should be blocked by the pending request',
      });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('LEAVE_BALANCE_EXCEEDED');
  });

  it('does not apply a balance check to unpaid leave', async () => {
    const monday = futureMonday();

    const response = await api()
      .post(`${API}/leave/requests`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`)
      .send({
        leaveTypeId: refs.unpaidLeaveTypeId,
        startDate: monday,
        endDate: addDays(monday, 4),
        reason: 'Unpaid leave is not drawn from an entitlement',
      });

    expect(response.status).toBe(201);
  });
});

describe('PATCH /leave/requests/:id/approve', () => {
  it('approves the request and deducts the balance in one transaction', async () => {
    const monday = futureMonday();

    const created = await api()
      .post(`${API}/leave/requests`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`)
      .send({
        leaveTypeId: refs.annualLeaveTypeId,
        startDate: monday,
        endDate: addDays(monday, 2),
        reason: 'Three days off',
      });

    const requestId = created.body.data.id as string;

    const approval = await api()
      .patch(`${API}/leave/requests/${requestId}/approve`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`)
      .send({ decisionNote: 'Approved, enjoy' });

    expect(approval.status).toBe(200);
    expect(approval.body.data.status).toBe('APPROVED');
    expect(approval.body.data.decidedAt).toBeTruthy();

    // The second half of the transaction: used days went up by exactly the
    // number of days the request covered.
    const balances = await api()
      .get(`${API}/leave/balances`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`);

    const annual = balances.body.data.balances.find(
      (balance: { leaveTypeCode: string }) => balance.leaveTypeCode === 'ANNUAL',
    );

    expect(annual.usedDays).toBe(3);
    expect(annual.remainingDays).toBe(9);
  });

  it('rejects a second approval of the same request', async () => {
    const id = await createLeaveRequest({
      employeeId: employee.employeeId,
      leaveTypeId: refs.annualLeaveTypeId,
      startDate: futureMonday(),
      endDate: futureMonday(),
      totalDays: 1,
    });

    const first = await api()
      .patch(`${API}/leave/requests/${id}/approve`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`)
      .send({});
    expect(first.status).toBe(200);

    const second = await api()
      .patch(`${API}/leave/requests/${id}/approve`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`)
      .send({});

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('LEAVE_ALREADY_DECIDED');
  });

  it('does not deduct the balance twice when approval is attempted twice', async () => {
    const id = await createLeaveRequest({
      employeeId: employee.employeeId,
      leaveTypeId: refs.annualLeaveTypeId,
      startDate: futureMonday(),
      endDate: addDays(futureMonday(), 1),
      totalDays: 2,
    });

    await api()
      .patch(`${API}/leave/requests/${id}/approve`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`)
      .send({});

    await api()
      .patch(`${API}/leave/requests/${id}/approve`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`)
      .send({});

    const balances = await api()
      .get(`${API}/leave/balances`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`);

    const annual = balances.body.data.balances.find(
      (balance: { leaveTypeCode: string }) => balance.leaveTypeCode === 'ANNUAL',
    );

    expect(annual.usedDays).toBe(2);
  });

  it('prevents an HR user from approving their own request', async () => {
    // A role check would not catch this: HR staff take leave too, and
    // self-approval removes the second pair of eyes approval exists for.
    const id = await createLeaveRequest({
      employeeId: hr.employeeId,
      leaveTypeId: refs.annualLeaveTypeId,
      startDate: futureMonday(),
      endDate: futureMonday(),
      totalDays: 1,
    });

    const response = await api()
      .patch(`${API}/leave/requests/${id}/approve`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`)
      .send({});

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CANNOT_APPROVE_OWN_REQUEST');
  });

  it('returns 404 for a request that does not exist', async () => {
    const response = await api()
      .patch(`${API}/leave/requests/${crypto.randomUUID()}/approve`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`)
      .send({});

    expect(response.status).toBe(404);
  });
});

describe('PATCH /leave/requests/:id/reject', () => {
  it('requires a reason', async () => {
    const id = await createLeaveRequest({
      employeeId: employee.employeeId,
      leaveTypeId: refs.annualLeaveTypeId,
      startDate: futureMonday(),
      endDate: futureMonday(),
      totalDays: 1,
    });

    const response = await api()
      .patch(`${API}/leave/requests/${id}/reject`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`)
      .send({});

    expect(response.status).toBe(400);
  });

  it('rejects the request and leaves the balance untouched', async () => {
    const id = await createLeaveRequest({
      employeeId: employee.employeeId,
      leaveTypeId: refs.annualLeaveTypeId,
      startDate: futureMonday(),
      endDate: addDays(futureMonday(), 2),
      totalDays: 3,
    });

    const response = await api()
      .patch(`${API}/leave/requests/${id}/reject`)
      .set('Authorization', `Bearer ${tokenFor(hr)}`)
      .send({ decisionNote: 'Team capacity is too low that week' });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('REJECTED');
    expect(response.body.data.decisionNote).toBe('Team capacity is too low that week');

    // Nothing was ever deducted, because deduction happens on approval.
    const balances = await api()
      .get(`${API}/leave/balances`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`);

    const annual = balances.body.data.balances.find(
      (balance: { leaveTypeCode: string }) => balance.leaveTypeCode === 'ANNUAL',
    );

    expect(annual.usedDays).toBe(0);
  });
});

describe('PATCH /leave/requests/:id/cancel', () => {
  it('lets the owner cancel a pending request', async () => {
    const id = await createLeaveRequest({
      employeeId: employee.employeeId,
      leaveTypeId: refs.annualLeaveTypeId,
      startDate: futureMonday(),
      endDate: futureMonday(),
      totalDays: 1,
    });

    const response = await api()
      .patch(`${API}/leave/requests/${id}/cancel`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`);

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('CANCELLED');
  });

  it('cannot cancel an already-approved request', async () => {
    const id = await createLeaveRequest({
      employeeId: employee.employeeId,
      leaveTypeId: refs.annualLeaveTypeId,
      startDate: futureMonday(),
      endDate: futureMonday(),
      totalDays: 1,
      status: 'APPROVED',
    });

    const response = await api()
      .patch(`${API}/leave/requests/${id}/cancel`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('LEAVE_ALREADY_DECIDED');
  });

  it('frees the dates for a new request once cancelled', async () => {
    const monday = futureMonday();

    const created = await api()
      .post(`${API}/leave/requests`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`)
      .send({
        leaveTypeId: refs.annualLeaveTypeId,
        startDate: monday,
        endDate: addDays(monday, 2),
        reason: 'Will be cancelled',
      });

    await api()
      .patch(`${API}/leave/requests/${created.body.data.id}/cancel`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`);

    // A cancelled request holds no claim on those days.
    const replacement = await api()
      .post(`${API}/leave/requests`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`)
      .send({
        leaveTypeId: refs.annualLeaveTypeId,
        startDate: monday,
        endDate: addDays(monday, 2),
        reason: 'Same dates, after cancelling the first',
      });

    expect(replacement.status).toBe(201);
  });
});

describe('GET /leave/balances', () => {
  it('returns entitled, used and remaining days per leave type', async () => {
    const response = await api()
      .get(`${API}/leave/balances`)
      .set('Authorization', `Bearer ${tokenFor(employee)}`);

    expect(response.status).toBe(200);
    expect(response.body.data.employeeId).toBe(employee.employeeId);

    const annual = response.body.data.balances.find(
      (balance: { leaveTypeCode: string }) => balance.leaveTypeCode === 'ANNUAL',
    );

    expect(annual).toMatchObject({ entitledDays: 12, usedDays: 0, remainingDays: 12 });
  });
});
