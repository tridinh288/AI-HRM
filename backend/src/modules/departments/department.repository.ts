import { and, asc, count, eq, ilike, or, sql, type SQL } from 'drizzle-orm';

import { db, type DbExecutor } from '../../db/client.js';
import { departments } from '../../db/schema.js';
import { toOffset } from '../../shared/http.js';
import type {
  CreateDepartmentInput,
  ListDepartmentsQuery,
  UpdateDepartmentInput,
} from './department.schema.js';

export interface DepartmentWithHeadcount {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isActive: boolean;
  employeeCount: number;
}

/**
 * Headcount as a correlated subquery, so listing departments stays one query
 * instead of one per row (the classic N+1).
 *
 * The table names are written out rather than interpolated with `${employees}`
 * and `${departments.id}`. That matters: Drizzle renders a column reference as a
 * bare `"id"`, with no table qualifier. Inside this subquery a bare `"id"` binds
 * to the *inner* table, so `${employees.departmentId} = ${departments.id}`
 * compiles to `"department_id" = "id"` — that is, `employees.department_id =
 * employees.id`, which is never true, and every department silently reports zero
 * employees. It is valid SQL, so nothing errors; an integration test asserting a
 * real headcount is what caught it.
 */
const headcount = sql<number>`(
  select count(*)::int from employees e
  where e.department_id = departments.id
    and e.employment_status <> 'TERMINATED'
)`;

const columns = {
  id: departments.id,
  code: departments.code,
  name: departments.name,
  description: departments.description,
  isActive: departments.isActive,
  employeeCount: headcount,
};

function buildFilters(query: ListDepartmentsQuery): SQL | undefined {
  const filters: SQL[] = [];
  if (query.search) {
    const pattern = `%${query.search}%`;
    filters.push(or(ilike(departments.name, pattern), ilike(departments.code, pattern))!);
  }
  if (query.isActive !== undefined) filters.push(eq(departments.isActive, query.isActive));
  return filters.length > 0 ? and(...filters) : undefined;
}

export async function listDepartments(
  query: ListDepartmentsQuery,
  executor: DbExecutor = db,
): Promise<{ items: DepartmentWithHeadcount[]; total: number }> {
  const where = buildFilters(query);

  const [items, totalRows] = await Promise.all([
    executor
      .select(columns)
      .from(departments)
      .where(where)
      .orderBy(asc(departments.name))
      .limit(query.pageSize)
      .offset(toOffset(query.page, query.pageSize)),
    executor.select({ value: count() }).from(departments).where(where),
  ]);

  return { items, total: totalRows[0]?.value ?? 0 };
}

export async function findDepartmentById(
  id: string,
  executor: DbExecutor = db,
): Promise<DepartmentWithHeadcount | null> {
  const rows = await executor.select(columns).from(departments).where(eq(departments.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function insertDepartment(
  input: CreateDepartmentInput,
  executor: DbExecutor = db,
): Promise<string> {
  const rows = await executor
    .insert(departments)
    .values({
      code: input.code,
      name: input.name,
      description: input.description ?? null,
    })
    .returning({ id: departments.id });

  return rows[0]!.id;
}

export async function updateDepartment(
  id: string,
  input: UpdateDepartmentInput,
  executor: DbExecutor = db,
): Promise<boolean> {
  const rows = await executor
    .update(departments)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(departments.id, id))
    .returning({ id: departments.id });

  return rows.length > 0;
}
