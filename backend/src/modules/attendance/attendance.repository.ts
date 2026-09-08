import { and, asc, count, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';

import { db, type DbExecutor } from '../../db/client.js';
import { attendanceRecords, departments, employees } from '../../db/schema.js';
import { toOffset } from '../../shared/http.js';
import type { AttendanceStatus } from '../../db/schema.js';

export interface AttendanceRow {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  departmentName: string | null;
  workDate: string;
  checkInAt: Date | null;
  checkOutAt: Date | null;
  status: AttendanceStatus;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  workMinutes: number;
  overtimeMinutes: number;
  note: string | null;
  correctedAt: Date | null;
}

const columns = {
  id: attendanceRecords.id,
  employeeId: attendanceRecords.employeeId,
  employeeName: sql<string>`${employees.firstName} || ' ' || ${employees.lastName}`,
  employeeCode: employees.employeeCode,
  departmentName: departments.name,
  workDate: attendanceRecords.workDate,
  checkInAt: attendanceRecords.checkInAt,
  checkOutAt: attendanceRecords.checkOutAt,
  status: attendanceRecords.status,
  lateMinutes: attendanceRecords.lateMinutes,
  earlyLeaveMinutes: attendanceRecords.earlyLeaveMinutes,
  workMinutes: attendanceRecords.workMinutes,
  overtimeMinutes: attendanceRecords.overtimeMinutes,
  note: attendanceRecords.note,
  correctedAt: attendanceRecords.correctedAt,
};

function baseQuery(executor: DbExecutor) {
  return executor
    .select(columns)
    .from(attendanceRecords)
    .innerJoin(employees, eq(employees.id, attendanceRecords.employeeId))
    .leftJoin(departments, eq(departments.id, employees.departmentId));
}

export interface AttendanceFilters {
  employeeId?: string | undefined;
  departmentId?: string | undefined;
  status?: AttendanceStatus | undefined;
  from?: string | undefined;
  to?: string | undefined;
  page: number;
  pageSize: number;
}

function buildFilters(filters: AttendanceFilters): SQL | undefined {
  const conditions: SQL[] = [];
  if (filters.employeeId) conditions.push(eq(attendanceRecords.employeeId, filters.employeeId));
  if (filters.departmentId) conditions.push(eq(employees.departmentId, filters.departmentId));
  if (filters.status) conditions.push(eq(attendanceRecords.status, filters.status));
  if (filters.from) conditions.push(gte(attendanceRecords.workDate, filters.from));
  if (filters.to) conditions.push(lte(attendanceRecords.workDate, filters.to));
  return conditions.length > 0 ? and(...conditions) : undefined;
}

export async function listAttendance(
  filters: AttendanceFilters,
  executor: DbExecutor = db,
): Promise<{ items: AttendanceRow[]; total: number }> {
  const where = buildFilters(filters);

  const [items, totalRows] = await Promise.all([
    baseQuery(executor)
      .where(where)
      .orderBy(desc(attendanceRecords.workDate), asc(employees.employeeCode))
      .limit(filters.pageSize)
      .offset(toOffset(filters.page, filters.pageSize)),
    executor
      .select({ value: count() })
      .from(attendanceRecords)
      .innerJoin(employees, eq(employees.id, attendanceRecords.employeeId))
      .where(where),
  ]);

  return { items, total: totalRows[0]?.value ?? 0 };
}

export async function findByEmployeeAndDate(
  employeeId: string,
  workDate: string,
  executor: DbExecutor = db,
): Promise<AttendanceRow | null> {
  const rows = await baseQuery(executor)
    .where(
      and(
        eq(attendanceRecords.employeeId, employeeId),
        eq(attendanceRecords.workDate, workDate),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

export async function findById(
  id: string,
  executor: DbExecutor = db,
): Promise<AttendanceRow | null> {
  const rows = await baseQuery(executor).where(eq(attendanceRecords.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function insertCheckIn(
  input: {
    employeeId: string;
    workDate: string;
    checkInAt: Date;
    status: 'PRESENT' | 'LATE';
    lateMinutes: number;
  },
  executor: DbExecutor = db,
): Promise<string> {
  const rows = await executor
    .insert(attendanceRecords)
    .values(input)
    .returning({ id: attendanceRecords.id });
  return rows[0]!.id;
}

/**
 * Records a check-out, but only on a record that has not already been checked
 * out.
 *
 * The `check_out_at IS NULL` predicate makes double check-out impossible without
 * a separate read: two concurrent requests both try to update, only one matches
 * a row, and the loser gets `false` back and a 409. Reading first and then
 * updating would let both pass the read.
 */
export async function updateCheckOut(
  id: string,
  input: {
    checkOutAt: Date;
    workMinutes: number;
    earlyLeaveMinutes: number;
    overtimeMinutes: number;
  },
  executor: DbExecutor = db,
): Promise<boolean> {
  const rows = await executor
    .update(attendanceRecords)
    .set({ ...input, updatedAt: new Date() })
    .where(
      and(
        eq(attendanceRecords.id, id),
        sql`${attendanceRecords.checkOutAt} is null`,
      ),
    )
    .returning({ id: attendanceRecords.id });

  return rows.length > 0;
}

export async function correctRecord(
  id: string,
  input: {
    checkInAt: Date | null;
    checkOutAt: Date | null;
    status: AttendanceStatus;
    lateMinutes: number;
    earlyLeaveMinutes: number;
    workMinutes: number;
    overtimeMinutes: number;
    note: string | null;
    correctedById: string;
  },
  executor: DbExecutor = db,
): Promise<boolean> {
  const rows = await executor
    .update(attendanceRecords)
    .set({ ...input, correctedAt: new Date(), updatedAt: new Date() })
    .where(eq(attendanceRecords.id, id))
    .returning({ id: attendanceRecords.id });

  return rows.length > 0;
}

export interface AttendanceSummary {
  daysRecorded: number;
  presentDays: number;
  lateDays: number;
  totalLateMinutes: number;
  totalWorkMinutes: number;
  totalOvertimeMinutes: number;
  earlyLeaveDays: number;
}

/**
 * A month's attendance for one employee, aggregated in the database.
 *
 * Written as a single aggregate query rather than fetching ~22 rows and summing
 * them in JavaScript. The row count is small here, but the habit matters: the
 * same shape over a whole department for a year is thousands of rows, and the
 * difference between "PostgreSQL sums it" and "Node sums it after transferring
 * it" is the difference between a fast endpoint and a slow one.
 */
export async function getAttendanceSummary(
  employeeId: string,
  from: string,
  to: string,
  executor: DbExecutor = db,
): Promise<AttendanceSummary> {
  const rows = await executor
    .select({
      daysRecorded: sql<number>`count(*)::int`,
      presentDays: sql<number>`count(*) filter (where ${attendanceRecords.status} = 'PRESENT')::int`,
      lateDays: sql<number>`count(*) filter (where ${attendanceRecords.status} = 'LATE')::int`,
      totalLateMinutes: sql<number>`coalesce(sum(${attendanceRecords.lateMinutes}), 0)::int`,
      totalWorkMinutes: sql<number>`coalesce(sum(${attendanceRecords.workMinutes}), 0)::int`,
      totalOvertimeMinutes: sql<number>`coalesce(sum(${attendanceRecords.overtimeMinutes}), 0)::int`,
      earlyLeaveDays: sql<number>`count(*) filter (where ${attendanceRecords.earlyLeaveMinutes} > 0)::int`,
    })
    .from(attendanceRecords)
    .where(
      and(
        eq(attendanceRecords.employeeId, employeeId),
        gte(attendanceRecords.workDate, from),
        lte(attendanceRecords.workDate, to),
      ),
    );

  return (
    rows[0] ?? {
      daysRecorded: 0,
      presentDays: 0,
      lateDays: 0,
      totalLateMinutes: 0,
      totalWorkMinutes: 0,
      totalOvertimeMinutes: 0,
      earlyLeaveDays: 0,
    }
  );
}
