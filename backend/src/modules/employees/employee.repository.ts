import { and, asc, count, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';

import { db, type DbExecutor } from '../../db/client.js';
import { departments, employees, positions, users } from '../../db/schema.js';
import { toOffset } from '../../shared/http.js';
import type { ListEmployeesQuery, UpdateEmployeeInput } from './employee.schema.js';

/**
 * The row shape every employee query returns.
 *
 * `baseSalary` is included here but stripped in the service layer for callers
 * who are not allowed to see it — the repository's job is to fetch, and putting
 * the authorization check in one service function is easier to audit than
 * remembering to select the right columns in five different queries.
 */
export interface EmployeeRow {
  id: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  dateOfBirth: string | null;
  gender: string | null;
  address: string | null;
  hireDate: string;
  employmentStatus: string;
  baseSalary: string;
  terminatedAt: Date | null;
  isActive: boolean;
  departmentId: string | null;
  departmentName: string | null;
  positionId: string | null;
  positionTitle: string | null;
  positionLevel: string | null;
  createdAt: Date;
}

const columns = {
  id: employees.id,
  employeeCode: employees.employeeCode,
  firstName: employees.firstName,
  lastName: employees.lastName,
  email: users.email,
  phone: employees.phone,
  dateOfBirth: employees.dateOfBirth,
  gender: employees.gender,
  address: employees.address,
  hireDate: employees.hireDate,
  employmentStatus: employees.employmentStatus,
  baseSalary: employees.baseSalary,
  terminatedAt: employees.terminatedAt,
  isActive: users.isActive,
  departmentId: employees.departmentId,
  departmentName: departments.name,
  positionId: employees.positionId,
  positionTitle: positions.title,
  positionLevel: positions.level,
  createdAt: employees.createdAt,
};

/**
 * One statement with three joins, rather than fetching employees and then
 * looking up each department and position.
 *
 * Both joins are LEFT because department and position are nullable — an
 * employee can exist before being assigned one, and an INNER JOIN would silently
 * drop exactly those people from every list.
 */
function baseQuery(executor: DbExecutor) {
  return executor
    .select(columns)
    .from(employees)
    .innerJoin(users, eq(users.id, employees.userId))
    .leftJoin(departments, eq(departments.id, employees.departmentId))
    .leftJoin(positions, eq(positions.id, employees.positionId));
}

function buildFilters(query: ListEmployeesQuery): SQL | undefined {
  const filters: SQL[] = [];

  if (query.search) {
    const pattern = `%${query.search}%`;
    // ilike is case-insensitive LIKE. The pattern is a *bound parameter*, so a
    // search for "'; drop table" is matched literally, not executed.
    filters.push(
      or(
        ilike(employees.firstName, pattern),
        ilike(employees.lastName, pattern),
        ilike(employees.employeeCode, pattern),
        ilike(users.email, pattern),
      )!,
    );
  }

  if (query.departmentId) filters.push(eq(employees.departmentId, query.departmentId));
  if (query.positionId) filters.push(eq(employees.positionId, query.positionId));
  if (query.employmentStatus) {
    filters.push(eq(employees.employmentStatus, query.employmentStatus));
  }

  return filters.length > 0 ? and(...filters) : undefined;
}

const sortColumns = {
  employeeCode: employees.employeeCode,
  lastName: employees.lastName,
  hireDate: employees.hireDate,
  createdAt: employees.createdAt,
} as const;

export async function listEmployees(
  query: ListEmployeesQuery,
  executor: DbExecutor = db,
): Promise<{ items: EmployeeRow[]; total: number }> {
  const where = buildFilters(query);
  // Looked up from a fixed map — the request never reaches SQL as a string.
  const sortColumn = sortColumns[query.sortBy];
  const orderBy = query.sortOrder === 'desc' ? desc(sortColumn) : asc(sortColumn);

  const [items, totalRows] = await Promise.all([
    baseQuery(executor)
      .where(where)
      // Tie-break on id so pagination is stable: without a unique tie-breaker,
      // two rows with the same hireDate can swap between page 1 and page 2.
      .orderBy(orderBy, asc(employees.id))
      .limit(query.pageSize)
      .offset(toOffset(query.page, query.pageSize)),
    executor
      .select({ value: count() })
      .from(employees)
      .innerJoin(users, eq(users.id, employees.userId))
      .where(where),
  ]);

  return { items, total: totalRows[0]?.value ?? 0 };
}

export async function findEmployeeById(
  id: string,
  executor: DbExecutor = db,
): Promise<EmployeeRow | null> {
  const rows = await baseQuery(executor).where(eq(employees.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function findEmployeeByUserId(
  userId: string,
  executor: DbExecutor = db,
): Promise<EmployeeRow | null> {
  const rows = await baseQuery(executor).where(eq(employees.userId, userId)).limit(1);
  return rows[0] ?? null;
}

export async function insertUser(
  input: { email: string; passwordHash: string; role: 'ADMIN' | 'HR' | 'EMPLOYEE' },
  executor: DbExecutor,
): Promise<string> {
  const rows = await executor.insert(users).values(input).returning({ id: users.id });
  return rows[0]!.id;
}

export async function insertEmployee(
  input: {
    userId: string;
    employeeCode: string;
    firstName: string;
    lastName: string;
    phone: string | null;
    dateOfBirth: string | null;
    gender: 'MALE' | 'FEMALE' | 'OTHER' | null;
    address: string | null;
    hireDate: string;
    departmentId: string | null;
    positionId: string | null;
    employmentStatus: 'PROBATION' | 'ACTIVE';
    baseSalary: string;
  },
  executor: DbExecutor,
): Promise<string> {
  const rows = await executor.insert(employees).values(input).returning({ id: employees.id });
  return rows[0]!.id;
}

export async function updateEmployee(
  id: string,
  input: UpdateEmployeeInput,
  executor: DbExecutor = db,
): Promise<boolean> {
  // `baseSalary` is separated from the rest because DECIMAL columns round-trip
  // as strings in the driver: keeping the conversion in one place means no
  // caller has to remember it, and a float never gets near a money value.
  const { baseSalary, ...rest } = input;

  const rows = await executor
    .update(employees)
    .set({
      ...rest,
      ...(baseSalary !== undefined ? { baseSalary: String(baseSalary) } : {}),
      updatedAt: new Date(),
    })
    .where(eq(employees.id, id))
    .returning({ id: employees.id });

  return rows.length > 0;
}

export async function terminateEmployee(
  id: string,
  terminatedAt: Date,
  executor: DbExecutor = db,
): Promise<boolean> {
  const rows = await executor
    .update(employees)
    .set({ employmentStatus: 'TERMINATED', terminatedAt, updatedAt: new Date() })
    .where(and(eq(employees.id, id), sql`${employees.employmentStatus} <> 'TERMINATED'`))
    .returning({ id: employees.id });

  return rows.length > 0;
}

/** Disables the login without touching the HR record. */
export async function setUserActive(
  userId: string,
  isActive: boolean,
  executor: DbExecutor = db,
): Promise<void> {
  await executor.update(users).set({ isActive, updatedAt: new Date() }).where(eq(users.id, userId));
}

export async function findUserIdForEmployee(
  employeeId: string,
  executor: DbExecutor = db,
): Promise<string | null> {
  const rows = await executor
    .select({ userId: employees.userId })
    .from(employees)
    .where(eq(employees.id, employeeId))
    .limit(1);
  return rows[0]?.userId ?? null;
}
