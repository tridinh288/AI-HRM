import { db } from '../../db/client.js';
import { assertCanAccessEmployee } from '../../middlewares/auth.js';
import { recordAudit } from '../../shared/audit.js';
import type { AuthContext } from '../../shared/auth-context.js';
import { AppError } from '../../shared/errors.js';
import { hashPassword, revokeAllSessions } from '../auth/auth.service.js';
import { createInitialLeaveBalances } from '../leave/leave.repository.js';
import { toEmployeeDto, type EmployeeDto } from './employee.mapper.js';
import * as repository from './employee.repository.js';
import type {
  CreateEmployeeInput,
  ListEmployeesQuery,
  TerminateEmployeeInput,
  UpdateAccountInput,
  UpdateEmployeeInput,
  UpdateOwnProfileInput,
} from './employee.schema.js';

export async function listEmployees(
  query: ListEmployeesQuery,
  viewer: AuthContext,
): Promise<{ items: EmployeeDto[]; total: number }> {
  const { items, total } = await repository.listEmployees(query);
  return { items: items.map((row) => toEmployeeDto(row, viewer)), total };
}

/**
 * Row-level authorization: HR and ADMIN may read anyone, everyone else only
 * themselves.
 *
 * This check is the reason `GET /employees/<someone-else>` returns 403 rather
 * than data. It cannot live in route middleware, because the answer depends on
 * which row was asked for.
 */
export async function getEmployee(id: string, viewer: AuthContext): Promise<EmployeeDto> {
  assertCanAccessEmployee(viewer, id);

  const row = await repository.findEmployeeById(id);
  if (!row) throw AppError.notFound('Employee not found');

  return toEmployeeDto(row, viewer);
}

export async function getOwnProfile(viewer: AuthContext): Promise<EmployeeDto> {
  if (!viewer.employeeId) {
    throw AppError.notFound('This account has no employee record');
  }
  const row = await repository.findEmployeeById(viewer.employeeId);
  if (!row) throw AppError.notFound('Employee not found');
  return toEmployeeDto(row, viewer);
}

/**
 * Creating an employee is three writes that must succeed or fail together:
 *
 *   1. the user account (so the person can log in),
 *   2. the employee record (the HR data),
 *   3. this year's leave balance rows (one per active leave type).
 *
 * Without a transaction, a duplicate employee code failing at step 2 leaves an
 * orphaned login with no HR record — an account that can authenticate but has
 * no identity in the system, and which blocks the email from being reused. And
 * a failure at step 3 leaves an employee who cannot request leave at all,
 * silently, until the first time they try.
 *
 * `db.transaction` wraps all three in one BEGIN/COMMIT: any throw inside rolls
 * back everything, including the audit entry.
 */
export async function createEmployee(
  input: CreateEmployeeInput,
  actor: AuthContext,
): Promise<EmployeeDto> {
  // Privilege escalation guard: HR manages people, ADMIN manages access. An HR
  // account that could mint ADMIN accounts would make the role boundary
  // meaningless — the *first* thing to check when reviewing this endpoint.
  if (input.role !== 'EMPLOYEE' && actor.role !== 'ADMIN') {
    throw AppError.forbidden(
      'INSUFFICIENT_ROLE',
      'Only an administrator can create HR or ADMIN accounts',
    );
  }

  const passwordHash = await hashPassword(input.password);

  const employeeId = await db.transaction(async (tx) => {
    const userId = await repository.insertUser(
      { email: input.email, passwordHash, role: input.role },
      tx,
    );

    const newEmployeeId = await repository.insertEmployee(
      {
        userId,
        employeeCode: input.employeeCode,
        firstName: input.firstName,
        lastName: input.lastName,
        phone: input.phone ?? null,
        dateOfBirth: input.dateOfBirth ?? null,
        gender: input.gender ?? null,
        address: input.address ?? null,
        hireDate: input.hireDate,
        departmentId: input.departmentId ?? null,
        positionId: input.positionId ?? null,
        employmentStatus: input.employmentStatus,
        baseSalary: String(input.baseSalary),
      },
      tx,
    );

    await createInitialLeaveBalances(newEmployeeId, new Date().getFullYear(), tx);

    await recordAudit(
      {
        actorUserId: actor.userId,
        action: 'employee.created',
        entityType: 'employee',
        entityId: newEmployeeId,
        // Deliberately records the role granted and never the password or salary.
        metadata: { employeeCode: input.employeeCode, role: input.role },
      },
      tx,
    );

    return newEmployeeId;
  });

  const row = await repository.findEmployeeById(employeeId);
  return toEmployeeDto(row!, actor);
}

export async function updateEmployee(
  id: string,
  input: UpdateEmployeeInput,
  actor: AuthContext,
): Promise<EmployeeDto> {
  const existing = await repository.findEmployeeById(id);
  if (!existing) throw AppError.notFound('Employee not found');

  const updated = await repository.updateEmployee(id, input);
  if (!updated) throw AppError.notFound('Employee not found');

  await recordAudit({
    actorUserId: actor.userId,
    action: 'employee.updated',
    entityType: 'employee',
    entityId: id,
    // Field names only — values may include personal data that does not belong
    // in a table with broader read access than the employee record itself.
    metadata: { fields: Object.keys(input) },
  });

  const row = await repository.findEmployeeById(id);
  return toEmployeeDto(row!, actor);
}

/** The narrow set of fields an employee may change about themselves. */
export async function updateOwnProfile(
  input: UpdateOwnProfileInput,
  actor: AuthContext,
): Promise<EmployeeDto> {
  if (!actor.employeeId) throw AppError.notFound('This account has no employee record');

  await repository.updateEmployee(actor.employeeId, input);

  const row = await repository.findEmployeeById(actor.employeeId);
  return toEmployeeDto(row!, actor);
}

/**
 * Termination: a status transition, not a delete.
 *
 * Two writes that belong together — the employee is marked TERMINATED and the
 * login is disabled. Doing only the first leaves someone who can still sign in
 * and read HR data; doing only the second leaves the org chart wrong. The
 * database's `employees_termination_consistent` CHECK additionally guarantees
 * the status and the date can never disagree.
 */
export async function terminateEmployee(
  id: string,
  input: TerminateEmployeeInput,
  actor: AuthContext,
): Promise<EmployeeDto> {
  const existing = await repository.findEmployeeById(id);
  if (!existing) throw AppError.notFound('Employee not found');

  if (existing.employmentStatus === 'TERMINATED') {
    throw AppError.conflict('EMPLOYEE_ALREADY_TERMINATED', 'This employee is already terminated');
  }

  const terminatedAt = input.terminationDate ? new Date(input.terminationDate) : new Date();

  await db.transaction(async (tx) => {
    const done = await repository.terminateEmployee(id, terminatedAt, tx);
    if (!done) {
      throw AppError.conflict('EMPLOYEE_ALREADY_TERMINATED', 'This employee is already terminated');
    }

    const userId = await repository.findUserIdForEmployee(id, tx);
    if (userId) await repository.setUserActive(userId, false, tx);

    await recordAudit(
      {
        actorUserId: actor.userId,
        action: 'employee.terminated',
        entityType: 'employee',
        entityId: id,
        metadata: { terminatedAt: terminatedAt.toISOString(), reason: input.reason ?? null },
      },
      tx,
    );
  });

  const row = await repository.findEmployeeById(id);
  return toEmployeeDto(row!, actor);
}

/** Used by the AI tool layer and the dashboard; no salary, no personal contact data. */
export async function findEmployeeRowById(id: string) {
  return repository.findEmployeeById(id);
}

/**
 * The account behind an employee: its role, and whether it may sign in.
 *
 * ADMIN only, and the one operation that separates ADMIN from HR. It is kept
 * apart from the HR record's PATCH so that no ordinary edit can become a
 * privilege change, and it refuses three things a live system must refuse:
 *
 *   - changing your own account, so an administrator cannot lock themselves
 *     out or quietly promote themselves through a second route;
 *   - demoting or disabling the last active administrator, so the system
 *     cannot end up with nobody able to administer it;
 *   - re-enabling the login of a terminated employee, which termination
 *     disabled on purpose.
 *
 * Every session of the account is revoked in the same transaction, so the
 * change lands at the user's next refresh, where the server re-reads role and
 * active flag. An access token already issued stays valid for the rest of its
 * fifteen minutes — the revocation window the README documents for JWTs.
 */
export async function updateAccount(
  id: string,
  input: UpdateAccountInput,
  actor: AuthContext,
): Promise<EmployeeDto> {
  const existing = await repository.findEmployeeById(id);
  if (!existing) throw AppError.notFound('Employee not found');

  const userId = await repository.findUserIdForEmployee(id);
  if (!userId) throw AppError.notFound('Employee not found');

  if (userId === actor.userId) {
    throw AppError.conflict(
      'CANNOT_MODIFY_OWN_ACCOUNT',
      'Ask another administrator to change your own role or access',
    );
  }

  const stopsBeingAdmin =
    existing.role === 'ADMIN' &&
    ((input.role !== undefined && input.role !== 'ADMIN') || input.isActive === false);

  if (stopsBeingAdmin && (await repository.countActiveAdminsOtherThan(userId)) === 0) {
    throw AppError.conflict(
      'LAST_ADMIN',
      'This is the only active administrator; promote someone else first',
    );
  }

  if (input.isActive === true && existing.employmentStatus === 'TERMINATED') {
    throw AppError.conflict(
      'EMPLOYEE_TERMINATED',
      'A terminated employee cannot be given access again',
    );
  }

  await db.transaction(async (tx) => {
    await repository.updateUserAccount(userId, input, tx);
    await revokeAllSessions(userId, tx);

    await recordAudit(
      {
        actorUserId: actor.userId,
        action: 'account.updated',
        entityType: 'user',
        entityId: userId,
        metadata: {
          employeeId: id,
          from: { role: existing.role, isActive: existing.isActive },
          to: { role: input.role ?? existing.role, isActive: input.isActive ?? existing.isActive },
        },
      },
      tx,
    );
  });

  const row = await repository.findEmployeeById(id);
  return toEmployeeDto(row!, actor);
}
