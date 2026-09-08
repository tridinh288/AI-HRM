import { and, asc, count, eq, ilike, sql, type SQL } from 'drizzle-orm';

import { db, type DbExecutor } from '../../db/client.js';
import { positions } from '../../db/schema.js';
import { toOffset } from '../../shared/http.js';
import type { CreatePositionInput, ListPositionsQuery, UpdatePositionInput } from './position.schema.js';

export interface PositionWithHeadcount {
  id: string;
  title: string;
  level: string;
  description: string | null;
  isActive: boolean;
  employeeCount: number;
}

/**
 * Headcount comes from a correlated subquery rather than a second round trip.
 *
 * The alternative — fetch positions, then loop and count employees for each — is
 * the classic N+1: one query becomes twenty-one. Here it stays one statement,
 * and `employees_position_idx` makes each subquery an index scan.
 *
 * Table names are spelled out rather than interpolated: Drizzle emits bare,
 * unqualified column names, which inside a correlated subquery bind to the wrong
 * table. See the same note in department.repository.ts.
 */
const headcount = sql<number>`(
  select count(*)::int from employees e
  where e.position_id = positions.id
    and e.employment_status <> 'TERMINATED'
)`;

function buildFilters(query: ListPositionsQuery): SQL | undefined {
  const filters: SQL[] = [];
  if (query.search) filters.push(ilike(positions.title, `%${query.search}%`));
  if (query.level) filters.push(eq(positions.level, query.level));
  if (query.isActive !== undefined) filters.push(eq(positions.isActive, query.isActive));
  return filters.length > 0 ? and(...filters) : undefined;
}

export async function listPositions(
  query: ListPositionsQuery,
  executor: DbExecutor = db,
): Promise<{ items: PositionWithHeadcount[]; total: number }> {
  const where = buildFilters(query);

  const [items, totalRows] = await Promise.all([
    executor
      .select({
        id: positions.id,
        title: positions.title,
        level: positions.level,
        description: positions.description,
        isActive: positions.isActive,
        employeeCount: headcount,
      })
      .from(positions)
      .where(where)
      .orderBy(asc(positions.title))
      .limit(query.pageSize)
      .offset(toOffset(query.page, query.pageSize)),
    executor.select({ value: count() }).from(positions).where(where),
  ]);

  return { items, total: totalRows[0]?.value ?? 0 };
}

export async function findPositionById(
  id: string,
  executor: DbExecutor = db,
): Promise<PositionWithHeadcount | null> {
  const rows = await executor
    .select({
      id: positions.id,
      title: positions.title,
      level: positions.level,
      description: positions.description,
      isActive: positions.isActive,
      employeeCount: headcount,
    })
    .from(positions)
    .where(eq(positions.id, id))
    .limit(1);

  return rows[0] ?? null;
}

export async function insertPosition(
  input: CreatePositionInput,
  executor: DbExecutor = db,
): Promise<string> {
  const rows = await executor
    .insert(positions)
    .values({
      title: input.title,
      level: input.level,
      description: input.description ?? null,
    })
    .returning({ id: positions.id });

  return rows[0]!.id;
}

export async function updatePosition(
  id: string,
  input: UpdatePositionInput,
  executor: DbExecutor = db,
): Promise<boolean> {
  const rows = await executor
    .update(positions)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(positions.id, id))
    .returning({ id: positions.id });

  return rows.length > 0;
}
