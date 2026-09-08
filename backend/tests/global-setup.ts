import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/**
 * Runs once before the whole suite: applies the committed migrations to the test
 * database.
 *
 * Tests run against **real PostgreSQL**, not an in-memory fake or a mocked
 * repository. That is the point of them: this project's correctness leans on
 * unique indexes, CHECK constraints, `SELECT ... FOR UPDATE` and transaction
 * rollback, none of which a mock can reproduce. A test suite that mocks the
 * database cannot tell you whether double check-in is actually prevented.
 *
 * Applying the same migration files production will run also verifies the
 * migrations themselves on every test run.
 */
export default async function globalSetup(): Promise<void> {
  const connectionString =
    process.env.DATABASE_URL ??
    'postgresql://hrm:hrm_local_dev@localhost:5432/hrm_test?schema=public';

  const pool = new pg.Pool({ connectionString, max: 1 });

  try {
    await migrate(drizzle(pool), { migrationsFolder: './drizzle' });
  } finally {
    await pool.end();
  }
}
