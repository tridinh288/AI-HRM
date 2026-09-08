import { and, asc, count, desc, eq, gte, inArray, lte, ne, sql, type SQL } from 'drizzle-orm';

import { db, type DbExecutor } from '../../db/client.js';
import { employees, leaveBalances, leaveRequests, leaveTypes, users } from '../../db/schema.js';
import { toOffset } from '../../shared/http.js';
import type { LeaveStatus } from '../../db/schema.js';

// ---------------------------------------------------------------------------
// Leave types and balances
// ---------------------------------------------------------------------------

export async function listLeaveTypes(activeOnly = true, executor: DbExecutor = db) {
  return executor
    .select({
      id: leaveTypes.id,
      code: leaveTypes.code,
      name: leaveTypes.name,
      description: leaveTypes.description,
      defaultDays: leaveTypes.defaultDays,
      isPaid: leaveTypes.isPaid,
      isActive: leaveTypes.isActive,
    })
    .from(leaveTypes)
    .where(activeOnly ? eq(leaveTypes.isActive, true) : undefined)
    .orderBy(asc(leaveTypes.name));
}

export async function findLeaveTypeById(id: string, executor: DbExecutor = db) {
  const rows = await executor.select().from(leaveTypes).where(eq(leaveTypes.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Creates this year's balance rows for a new employee, one per active leave type.
 *
 * Runs inside the same transaction that creates the employee: an employee
 * without balance rows cannot request leave at all, so "employee created but
 * balances missing" is not a state the system should ever be able to reach.
 *
 * `onConflictDoNothing` makes it idempotent against the
 * (employee, leave_type, year) unique index, so re-running it for an existing
 * year is harmless rather than a crash.
 */
export async function createInitialLeaveBalances(
  employeeId: string,
  year: number,
  executor: DbExecutor,
): Promise<void> {
  const types = await executor
    .select({ id: leaveTypes.id, defaultDays: leaveTypes.defaultDays })
    .from(leaveTypes)
    .where(eq(leaveTypes.isActive, true));

  if (types.length === 0) return;

  await executor
    .insert(leaveBalances)
    .values(
      types.map((type) => ({
        employeeId,
        leaveTypeId: type.id,
        year,
        entitledDays: type.defaultDays,
        usedDays: 0,
      })),
    )
    .onConflictDoNothing();
}

export interface LeaveBalanceRow {
  id: string;
  leaveTypeId: string;
  leaveTypeName: string;
  leaveTypeCode: string;
  isPaid: boolean;
  year: number;
  entitledDays: number;
  usedDays: number;
}

export async function listBalancesForEmployee(
  employeeId: string,
  year: number,
  executor: DbExecutor = db,
): Promise<LeaveBalanceRow[]> {
  return executor
    .select({
      id: leaveBalances.id,
      leaveTypeId: leaveBalances.leaveTypeId,
      leaveTypeName: leaveTypes.name,
      leaveTypeCode: leaveTypes.code,
      isPaid: leaveTypes.isPaid,
      year: leaveBalances.year,
      entitledDays: leaveBalances.entitledDays,
      usedDays: leaveBalances.usedDays,
    })
    .from(leaveBalances)
    .innerJoin(leaveTypes, eq(leaveTypes.id, leaveBalances.leaveTypeId))
    .where(and(eq(leaveBalances.employeeId, employeeId), eq(leaveBalances.year, year)))
    .orderBy(asc(leaveTypes.name));
}

/**
 * Reads a balance row and holds a row-level lock until the transaction ends.
 *
 * `SELECT ... FOR UPDATE` is the whole reason approving leave is safe under
 * concurrency. Two HR users approving two requests for the same person at the
 * same moment would otherwise both read `usedDays = 10`, both decide there is
 * room, and both write 12 — losing one deduction. With the lock, the second
 * transaction blocks until the first commits and then re-reads the real value.
 */
export async function lockBalance(
  employeeId: string,
  leaveTypeId: string,
  year: number,
  executor: DbExecutor,
): Promise<{ id: string; entitledDays: number; usedDays: number } | null> {
  const rows = await executor
    .select({
      id: leaveBalances.id,
      entitledDays: leaveBalances.entitledDays,
      usedDays: leaveBalances.usedDays,
    })
    .from(leaveBalances)
    .where(
      and(
        eq(leaveBalances.employeeId, employeeId),
        eq(leaveBalances.leaveTypeId, leaveTypeId),
        eq(leaveBalances.year, year),
      ),
    )
    .for('update')
    .limit(1);

  return rows[0] ?? null;
}

export async function addUsedDays(
  balanceId: string,
  days: number,
  executor: DbExecutor,
): Promise<void> {
  await executor
    .update(leaveBalances)
    .set({
      usedDays: sql`${leaveBalances.usedDays} + ${days}`,
      updatedAt: new Date(),
    })
    .where(eq(leaveBalances.id, balanceId));
}

// ---------------------------------------------------------------------------
// Leave requests
// ---------------------------------------------------------------------------

export interface LeaveRequestRow {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  departmentName: string | null;
  leaveTypeId: string;
  leaveTypeName: string;
  startDate: string;
  endDate: string;
  totalDays: number;
  reason: string;
  status: LeaveStatus;
  decidedByEmail: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  createdAt: Date;
}

function requestColumns() {
  return {
    id: leaveRequests.id,
    employeeId: leaveRequests.employeeId,
    employeeName: sql<string>`${employees.firstName} || ' ' || ${employees.lastName}`,
    employeeCode: employees.employeeCode,
    // Table-qualified on purpose — see department.repository.ts for why an
    // interpolated column reference binds to the wrong table inside a subquery.
    departmentName: sql<string | null>`(
      select d.name from departments d where d.id = employees.department_id
    )`,
    leaveTypeId: leaveRequests.leaveTypeId,
    leaveTypeName: leaveTypes.name,
    startDate: leaveRequests.startDate,
    endDate: leaveRequests.endDate,
    totalDays: leaveRequests.totalDays,
    reason: leaveRequests.reason,
    status: leaveRequests.status,
    decidedByEmail: users.email,
    decidedAt: leaveRequests.decidedAt,
    decisionNote: leaveRequests.decisionNote,
    createdAt: leaveRequests.createdAt,
  };
}

function requestQuery(executor: DbExecutor) {
  return executor
    .select(requestColumns())
    .from(leaveRequests)
    .innerJoin(employees, eq(employees.id, leaveRequests.employeeId))
    .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
    .leftJoin(users, eq(users.id, leaveRequests.decidedById));
}

export interface ListLeaveFilters {
  employeeId?: string | undefined;
  departmentId?: string | undefined;
  status?: LeaveStatus | undefined;
  from?: string | undefined;
  to?: string | undefined;
  page: number;
  pageSize: number;
}

export async function listLeaveRequests(
  filters: ListLeaveFilters,
  executor: DbExecutor = db,
): Promise<{ items: LeaveRequestRow[]; total: number }> {
  const conditions: SQL[] = [];
  if (filters.employeeId) conditions.push(eq(leaveRequests.employeeId, filters.employeeId));
  if (filters.departmentId) conditions.push(eq(employees.departmentId, filters.departmentId));
  if (filters.status) conditions.push(eq(leaveRequests.status, filters.status));
  // Overlap, not containment: a request that starts before the window and ends
  // inside it is still relevant to that window.
  if (filters.from) conditions.push(gte(leaveRequests.endDate, filters.from));
  if (filters.to) conditions.push(lte(leaveRequests.startDate, filters.to));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [items, totalRows] = await Promise.all([
    requestQuery(executor)
      .where(where)
      .orderBy(desc(leaveRequests.createdAt), asc(leaveRequests.id))
      .limit(filters.pageSize)
      .offset(toOffset(filters.page, filters.pageSize)),
    executor
      .select({ value: count() })
      .from(leaveRequests)
      .innerJoin(employees, eq(employees.id, leaveRequests.employeeId))
      .where(where),
  ]);

  return { items, total: totalRows[0]?.value ?? 0 };
}

export async function findLeaveRequestById(
  id: string,
  executor: DbExecutor = db,
): Promise<LeaveRequestRow | null> {
  const rows = await requestQuery(executor).where(eq(leaveRequests.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Finds requests that overlap a date range and are still "live".
 *
 * Two ranges overlap when `existing.start <= new.end AND existing.end >=
 * new.start` — the standard interval test, and the reason both dates are
 * indexed. CANCELLED and REJECTED requests are excluded because they hold no
 * claim on those days.
 */
export async function findOverlappingRequests(
  employeeId: string,
  startDate: string,
  endDate: string,
  excludeRequestId: string | null,
  executor: DbExecutor,
): Promise<{ id: string; startDate: string; endDate: string; status: LeaveStatus }[]> {
  const conditions: SQL[] = [
    eq(leaveRequests.employeeId, employeeId),
    inArray(leaveRequests.status, ['PENDING', 'APPROVED']),
    lte(leaveRequests.startDate, endDate),
    gte(leaveRequests.endDate, startDate),
  ];

  if (excludeRequestId) conditions.push(ne(leaveRequests.id, excludeRequestId));

  return executor
    .select({
      id: leaveRequests.id,
      startDate: leaveRequests.startDate,
      endDate: leaveRequests.endDate,
      status: leaveRequests.status,
    })
    .from(leaveRequests)
    .where(and(...conditions));
}

export async function insertLeaveRequest(
  input: {
    employeeId: string;
    leaveTypeId: string;
    startDate: string;
    endDate: string;
    totalDays: number;
    reason: string;
  },
  executor: DbExecutor,
): Promise<string> {
  const rows = await executor
    .insert(leaveRequests)
    .values(input)
    .returning({ id: leaveRequests.id });
  return rows[0]!.id;
}

/**
 * Transitions a request, but only from PENDING.
 *
 * The `status = 'PENDING'` predicate in the WHERE clause is doing real work: it
 * makes the transition atomic. Two approvals racing on the same request both
 * pass an application-level "is it still pending?" check, but only one UPDATE
 * matches a row — the loser gets zero rows back and is reported as a conflict.
 */
export async function transitionLeaveRequest(
  id: string,
  next: Extract<LeaveStatus, 'APPROVED' | 'REJECTED' | 'CANCELLED'>,
  decidedById: string | null,
  decisionNote: string | null,
  executor: DbExecutor,
): Promise<boolean> {
  const rows = await executor
    .update(leaveRequests)
    .set({
      status: next,
      // CANCELLED is the employee withdrawing their own request, not a decision
      // by HR — the CHECK constraint requires decidedAt to be null for it.
      decidedById: next === 'CANCELLED' ? null : decidedById,
      decidedAt: next === 'CANCELLED' ? null : new Date(),
      decisionNote,
      updatedAt: new Date(),
    })
    .where(and(eq(leaveRequests.id, id), eq(leaveRequests.status, 'PENDING')))
    .returning({ id: leaveRequests.id });

  return rows.length > 0;
}

/** Approved leave days that cover a given date — used by attendance reporting. */
export async function findApprovedLeaveOnDate(
  employeeId: string,
  date: string,
  executor: DbExecutor = db,
): Promise<boolean> {
  const rows = await executor
    .select({ id: leaveRequests.id })
    .from(leaveRequests)
    .where(
      and(
        eq(leaveRequests.employeeId, employeeId),
        eq(leaveRequests.status, 'APPROVED'),
        lte(leaveRequests.startDate, date),
        gte(leaveRequests.endDate, date),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

/**
 * Days already committed to PENDING requests for one leave type this year.
 *
 * Needed because the balance is only deducted on *approval*: without counting
 * pending requests, an employee with 12 days left could submit four 5-day
 * requests and see all four accepted, only to have the later approvals fail.
 * Rejecting at submission time is a better experience and costs one query.
 */
export async function sumPendingDays(
  employeeId: string,
  leaveTypeId: string,
  year: number,
  executor: DbExecutor,
): Promise<number> {
  const rows = await executor
    .select({ value: sql<number>`coalesce(sum(${leaveRequests.totalDays}), 0)::int` })
    .from(leaveRequests)
    .where(
      and(
        eq(leaveRequests.employeeId, employeeId),
        eq(leaveRequests.leaveTypeId, leaveTypeId),
        eq(leaveRequests.status, 'PENDING'),
        sql`extract(year from ${leaveRequests.startDate}) = ${year}`,
      ),
    );

  return rows[0]?.value ?? 0;
}
