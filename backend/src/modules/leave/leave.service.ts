import { companyPolicy } from '../../config/env.js';
import { db } from '../../db/client.js';
import { assertCanAccessEmployee, requireOwnEmployeeId } from '../../middlewares/auth.js';
import { recordAudit } from '../../shared/audit.js';
import type { AuthContext } from '../../shared/auth-context.js';
import { companyToday } from '../../shared/calendar.js';
import { AppError } from '../../shared/errors.js';
import { calculateLeaveDays, checkBalance, validateLeaveDates } from './leave.policy.js';
import * as repository from './leave.repository.js';
import type {
  ApproveLeaveRequestInput,
  CreateLeaveRequestInput,
  LeaveBalanceQuery,
  ListLeaveRequestsQuery,
  RejectLeaveRequestInput,
} from './leave.schema.js';

export async function listLeaveTypes() {
  return repository.listLeaveTypes(true);
}

export async function getBalances(query: LeaveBalanceQuery, auth: AuthContext) {
  const employeeId =
    auth.role === 'HR' || auth.role === 'ADMIN'
      ? (query.employeeId ?? requireOwnEmployeeId(auth))
      : requireOwnEmployeeId(auth);

  assertCanAccessEmployee(auth, employeeId);

  const year = query.year ?? new Date().getFullYear();
  const balances = await repository.listBalancesForEmployee(employeeId, year);

  return {
    employeeId,
    year,
    balances: balances.map((balance) => ({
      ...balance,
      remainingDays: balance.entitledDays - balance.usedDays,
    })),
  };
}

/**
 * Listing, scoped by role.
 *
 * As with attendance, a non-privileged caller's `employeeId` filter is
 * *overwritten* rather than checked: there is no code path where an EMPLOYEE
 * sees anyone else's requests, so a missing check cannot leak data.
 */
export async function listLeaveRequests(query: ListLeaveRequestsQuery, auth: AuthContext) {
  const isPrivileged = auth.role === 'HR' || auth.role === 'ADMIN';

  return repository.listLeaveRequests({
    ...query,
    employeeId: isPrivileged ? query.employeeId : requireOwnEmployeeId(auth),
    departmentId: isPrivileged ? query.departmentId : undefined,
  });
}

export async function getLeaveRequest(id: string, auth: AuthContext) {
  const request = await repository.findLeaveRequestById(id);
  if (!request) throw AppError.notFound('Leave request not found');

  assertCanAccessEmployee(auth, request.employeeId);
  return request;
}

/**
 * Creating a leave request.
 *
 * Three checks, in increasing order of cost, and the ordering is the point:
 *
 *   1. Calendar rules — pure functions, no I/O (leave.policy).
 *   2. Overlap with an existing request — one query.
 *   3. Balance, including days already committed to pending requests — two more.
 *
 * Steps 2 and 3 run inside a transaction because both read state that a
 * concurrent request could change between the read and the insert. Without it,
 * two requests submitted at the same instant for the same week would both see
 * "no overlap" and both be created.
 */
export async function createLeaveRequest(
  input: CreateLeaveRequestInput,
  auth: AuthContext,
  now: Date = new Date(),
) {
  const employeeId = requireOwnEmployeeId(auth);
  const today = companyToday(companyPolicy.timezone, now);

  const issues = validateLeaveDates(
    { startDate: input.startDate, endDate: input.endDate },
    today,
  );

  if (issues.length > 0) {
    throw AppError.badRequest('INVALID_DATE_RANGE', issues[0]!.message, issues);
  }

  const leaveType = await repository.findLeaveTypeById(input.leaveTypeId);
  if (!leaveType || !leaveType.isActive) {
    throw AppError.notFound('Leave type not found');
  }

  const totalDays = calculateLeaveDays(input.startDate, input.endDate);

  const requestId = await db.transaction(async (tx) => {
    const overlapping = await repository.findOverlappingRequests(
      employeeId,
      input.startDate,
      input.endDate,
      null,
      tx,
    );

    if (overlapping.length > 0) {
      throw AppError.conflict(
        'LEAVE_OVERLAP',
        'You already have a leave request covering some of these dates',
        overlapping.map((row) => ({
          id: row.id,
          startDate: row.startDate,
          endDate: row.endDate,
          status: row.status,
        })),
      );
    }

    // Unpaid leave is not drawn from an entitlement, so there is nothing to
    // check — the balance rules apply to paid types only.
    if (leaveType.isPaid) {
      const year = Number(input.startDate.slice(0, 4));
      const balance = await repository.lockBalance(employeeId, leaveType.id, year, tx);

      if (!balance) {
        throw AppError.conflict(
          'LEAVE_BALANCE_EXCEEDED',
          `You have no ${leaveType.name} entitlement for ${year}`,
        );
      }

      const pendingDays = await repository.sumPendingDays(employeeId, leaveType.id, year, tx);

      const result = checkBalance({
        entitledDays: balance.entitledDays,
        usedDays: balance.usedDays + pendingDays,
        requestedDays: totalDays,
      });

      if (!result.sufficient) {
        throw AppError.conflict(
          'LEAVE_BALANCE_EXCEEDED',
          `This request needs ${totalDays} day(s) but only ${result.remainingDays} remain (pending requests included)`,
          { remainingDays: result.remainingDays, requestedDays: totalDays },
        );
      }
    }

    return repository.insertLeaveRequest(
      {
        employeeId,
        leaveTypeId: leaveType.id,
        startDate: input.startDate,
        endDate: input.endDate,
        totalDays,
        reason: input.reason,
      },
      tx,
    );
  });

  return repository.findLeaveRequestById(requestId);
}

/**
 * Approval — the transaction that matters most in this codebase.
 *
 * Two writes have to happen together: the request becomes APPROVED, and the
 * employee's used days go up. If the second failed on its own, the employee
 * would hold approved leave that was never deducted, their balance would be
 * permanently wrong, and nothing would ever surface it.
 *
 * Concurrency is handled in two layers:
 *   - the status UPDATE carries `WHERE status = 'PENDING'`, so of two
 *     simultaneous approvals exactly one matches a row;
 *   - the balance row is read with SELECT ... FOR UPDATE, so the second
 *     transaction blocks until the first commits and then re-reads the true
 *     value rather than the stale one it would otherwise have cached.
 *
 * And underneath both, the `leave_balance_within_entitlement` CHECK constraint
 * refuses to store a balance where used exceeds entitled — the last line of
 * defence if the logic above is ever wrong.
 */
export async function approveLeaveRequest(
  id: string,
  input: ApproveLeaveRequestInput,
  actor: AuthContext,
) {
  await db.transaction(async (tx) => {
    const request = await repository.findLeaveRequestById(id, tx);
    if (!request) throw AppError.notFound('Leave request not found');

    // A role rule would not catch this: HR users take leave too, and an HR
    // account approving its own request removes the second pair of eyes that
    // approval exists for.
    if (actor.employeeId && actor.employeeId === request.employeeId) {
      throw AppError.conflict(
        'CANNOT_APPROVE_OWN_REQUEST',
        'You cannot approve your own leave request',
      );
    }

    if (request.status !== 'PENDING') {
      throw AppError.conflict(
        'LEAVE_ALREADY_DECIDED',
        `This request has already been ${request.status.toLowerCase()}`,
      );
    }

    const leaveType = await repository.findLeaveTypeById(request.leaveTypeId, tx);

    const transitioned = await repository.transitionLeaveRequest(
      id,
      'APPROVED',
      actor.userId,
      input.decisionNote ?? null,
      tx,
    );

    // Zero rows updated means another approval won the race between the read
    // above and this write.
    if (!transitioned) {
      throw AppError.conflict('LEAVE_ALREADY_DECIDED', 'This request has already been decided');
    }

    if (leaveType?.isPaid) {
      const year = Number(request.startDate.slice(0, 4));
      const balance = await repository.lockBalance(request.employeeId, request.leaveTypeId, year, tx);

      if (!balance) {
        throw AppError.conflict(
          'LEAVE_BALANCE_EXCEEDED',
          `No ${leaveType.name} entitlement exists for ${year}`,
        );
      }

      const result = checkBalance({
        entitledDays: balance.entitledDays,
        usedDays: balance.usedDays,
        requestedDays: request.totalDays,
      });

      if (!result.sufficient) {
        throw AppError.conflict(
          'LEAVE_BALANCE_EXCEEDED',
          `Approving this would exceed the entitlement by ${result.shortfallDays} day(s)`,
        );
      }

      await repository.addUsedDays(balance.id, request.totalDays, tx);
    }

    await recordAudit(
      {
        actorUserId: actor.userId,
        action: 'leave.approved',
        entityType: 'leave_request',
        entityId: id,
        metadata: {
          employeeId: request.employeeId,
          totalDays: request.totalDays,
          startDate: request.startDate,
          endDate: request.endDate,
        },
      },
      tx,
    );
  });

  return repository.findLeaveRequestById(id);
}

export async function rejectLeaveRequest(
  id: string,
  input: RejectLeaveRequestInput,
  actor: AuthContext,
) {
  await db.transaction(async (tx) => {
    const request = await repository.findLeaveRequestById(id, tx);
    if (!request) throw AppError.notFound('Leave request not found');

    if (request.status !== 'PENDING') {
      throw AppError.conflict(
        'LEAVE_ALREADY_DECIDED',
        `This request has already been ${request.status.toLowerCase()}`,
      );
    }

    const transitioned = await repository.transitionLeaveRequest(
      id,
      'REJECTED',
      actor.userId,
      input.decisionNote,
      tx,
    );

    if (!transitioned) {
      throw AppError.conflict('LEAVE_ALREADY_DECIDED', 'This request has already been decided');
    }

    // No balance change: rejected leave was never deducted in the first place,
    // because deduction happens on approval.
    await recordAudit(
      {
        actorUserId: actor.userId,
        action: 'leave.rejected',
        entityType: 'leave_request',
        entityId: id,
        metadata: { employeeId: request.employeeId, reason: input.decisionNote },
      },
      tx,
    );
  });

  return repository.findLeaveRequestById(id);
}

/**
 * Cancellation is the employee withdrawing their own pending request.
 *
 * Ownership is checked rather than role: HR must not cancel someone else's
 * request through this endpoint, because "withdrawn by me" and "rejected by HR"
 * are different facts and the audit trail should not confuse them.
 */
export async function cancelLeaveRequest(id: string, auth: AuthContext) {
  const employeeId = requireOwnEmployeeId(auth);

  await db.transaction(async (tx) => {
    const request = await repository.findLeaveRequestById(id, tx);
    if (!request) throw AppError.notFound('Leave request not found');

    if (request.employeeId !== employeeId) {
      throw AppError.forbidden('NOT_YOUR_RECORD', 'You may only cancel your own leave requests');
    }

    if (request.status !== 'PENDING') {
      throw AppError.conflict(
        'LEAVE_ALREADY_DECIDED',
        `Only a pending request can be cancelled; this one is ${request.status.toLowerCase()}`,
      );
    }

    const transitioned = await repository.transitionLeaveRequest(id, 'CANCELLED', null, null, tx);
    if (!transitioned) {
      throw AppError.conflict('LEAVE_ALREADY_DECIDED', 'This request has already been decided');
    }

    await recordAudit(
      {
        actorUserId: auth.userId,
        action: 'leave.cancelled',
        entityType: 'leave_request',
        entityId: id,
        metadata: { employeeId },
      },
      tx,
    );
  });

  return repository.findLeaveRequestById(id);
}
