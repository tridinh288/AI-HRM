import { companyPolicy } from '../../config/env.js';
import { assertCanAccessEmployee, requireOwnEmployeeId } from '../../middlewares/auth.js';
import { recordAudit } from '../../shared/audit.js';
import type { AuthContext } from '../../shared/auth-context.js';
import { AppError, asPostgresError } from '../../shared/errors.js';
import {
  companyToday,
  evaluateCheckIn,
  evaluateCheckOut,
  type AttendancePolicy,
} from './attendance.policy.js';
import * as repository from './attendance.repository.js';
import type {
  AttendanceSummaryQuery,
  CorrectAttendanceInput,
  ListAttendanceQuery,
} from './attendance.schema.js';

const policy: AttendancePolicy = companyPolicy;

/**
 * Check in.
 *
 * The interesting part is what happens when someone clicks the button twice.
 * There is no "have you already checked in?" read here on purpose: two requests
 * arriving milliseconds apart would both read "no record" and both proceed. The
 * INSERT is allowed to fail against the `(employee_id, work_date)` unique index,
 * and PostgreSQL error 23505 is translated into a 409. The database decides,
 * because it is the only participant that can decide correctly.
 */
export async function checkIn(auth: AuthContext, now: Date = new Date()) {
  const employeeId = requireOwnEmployeeId(auth);
  const evaluation = evaluateCheckIn(now, policy);

  try {
    const id = await repository.insertCheckIn({
      employeeId,
      workDate: evaluation.workDate,
      checkInAt: now,
      status: evaluation.status,
      lateMinutes: evaluation.lateMinutes,
    });

    return repository.findById(id);
  } catch (error) {
    if (asPostgresError(error)?.code === '23505') {
      throw AppError.conflict('ALREADY_CHECKED_IN', 'You have already checked in today');
    }
    throw error;
  }
}

/**
 * Check out.
 *
 * Two failures are distinguished, because they mean different things to the
 * person clicking: there is no check-in for today at all (NOT_CHECKED_IN), or
 * there is one that has already been closed (ALREADY_CHECKED_OUT). The second is
 * detected by the UPDATE matching zero rows rather than by a prior read, so a
 * double click cannot slip between the check and the write.
 */
export async function checkOut(auth: AuthContext, now: Date = new Date()) {
  const employeeId = requireOwnEmployeeId(auth);
  const workDate = companyToday(policy.timezone, now);

  const record = await repository.findByEmployeeAndDate(employeeId, workDate);

  if (!record?.checkInAt) {
    throw AppError.conflict('NOT_CHECKED_IN', 'You have not checked in today');
  }

  if (record.checkOutAt) {
    throw AppError.conflict('ALREADY_CHECKED_OUT', 'You have already checked out today');
  }

  const evaluation = evaluateCheckOut(record.checkInAt, now, policy);

  const updated = await repository.updateCheckOut(record.id, {
    checkOutAt: now,
    workMinutes: evaluation.workMinutes,
    earlyLeaveMinutes: evaluation.earlyLeaveMinutes,
    overtimeMinutes: evaluation.overtimeMinutes,
  });

  if (!updated) {
    throw AppError.conflict('ALREADY_CHECKED_OUT', 'You have already checked out today');
  }

  return repository.findById(record.id);
}

export async function getToday(auth: AuthContext, now: Date = new Date()) {
  const employeeId = requireOwnEmployeeId(auth);
  const workDate = companyToday(policy.timezone, now);
  return {
    workDate,
    record: await repository.findByEmployeeAndDate(employeeId, workDate),
  };
}

/**
 * Listing attendance, scoped by role.
 *
 * An EMPLOYEE's query is *rewritten* to their own employee id rather than
 * validated against it. That distinction matters: there is no path through this
 * function where a non-HR caller's `employeeId` filter is honoured, so forgetting
 * a check cannot leak another person's attendance — the filter is simply
 * overwritten.
 */
export async function listAttendance(query: ListAttendanceQuery, auth: AuthContext) {
  const isPrivileged = auth.role === 'HR' || auth.role === 'ADMIN';

  const filters = {
    ...query,
    employeeId: isPrivileged ? query.employeeId : requireOwnEmployeeId(auth),
    departmentId: isPrivileged ? query.departmentId : undefined,
  };

  return repository.listAttendance(filters);
}

export async function getSummary(query: AttendanceSummaryQuery, auth: AuthContext) {
  const employeeId =
    auth.role === 'HR' || auth.role === 'ADMIN'
      ? (query.employeeId ?? requireOwnEmployeeId(auth))
      : requireOwnEmployeeId(auth);

  // Belt and braces: HR passing an explicit id is allowed, anyone else is not.
  assertCanAccessEmployee(auth, employeeId);

  if (query.to < query.from) {
    throw AppError.badRequest('INVALID_DATE_RANGE', 'The end date must not precede the start date');
  }

  const summary = await repository.getAttendanceSummary(employeeId, query.from, query.to);
  return { employeeId, from: query.from, to: query.to, ...summary };
}

/**
 * HR correction of an attendance record.
 *
 * Derived values are recomputed from the corrected timestamps using the same
 * policy functions as a live check-in, so a corrected record is indistinguishable
 * from a correctly-recorded one — and cannot end up with, say, a LATE status and
 * zero late minutes.
 */
export async function correctAttendance(
  id: string,
  input: CorrectAttendanceInput,
  actor: AuthContext,
) {
  const record = await repository.findById(id);
  if (!record) throw AppError.notFound('Attendance record not found');

  const checkInAt =
    input.checkInAt === undefined
      ? record.checkInAt
      : input.checkInAt === null
        ? null
        : new Date(input.checkInAt);

  const checkOutAt =
    input.checkOutAt === undefined
      ? record.checkOutAt
      : input.checkOutAt === null
        ? null
        : new Date(input.checkOutAt);

  if (checkInAt && checkOutAt && checkOutAt <= checkInAt) {
    throw AppError.badRequest(
      'INVALID_DATE_RANGE',
      'Check-out must be later than check-in',
    );
  }

  const checkInEvaluation = checkInAt ? evaluateCheckIn(checkInAt, policy) : null;
  const checkOutEvaluation =
    checkInAt && checkOutAt ? evaluateCheckOut(checkInAt, checkOutAt, policy) : null;

  await repository.correctRecord(id, {
    checkInAt,
    checkOutAt,
    status: checkInEvaluation?.status ?? 'PRESENT',
    lateMinutes: checkInEvaluation?.lateMinutes ?? 0,
    earlyLeaveMinutes: checkOutEvaluation?.earlyLeaveMinutes ?? 0,
    workMinutes: checkOutEvaluation?.workMinutes ?? 0,
    overtimeMinutes: checkOutEvaluation?.overtimeMinutes ?? 0,
    note: input.note ?? record.note,
    correctedById: actor.userId,
  });

  await recordAudit({
    actorUserId: actor.userId,
    action: 'attendance.corrected',
    entityType: 'attendance',
    entityId: id,
    metadata: {
      employeeId: record.employeeId,
      workDate: record.workDate,
      previousCheckIn: record.checkInAt?.toISOString() ?? null,
      previousCheckOut: record.checkOutAt?.toISOString() ?? null,
    },
  });

  return repository.findById(id);
}
