import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

import { env } from '../config/env.js';

/**
 * Applies the committed migrations.
 *
 * Separate from `drizzle-kit`, which is a *development* tool: it inspects the
 * schema and generates SQL, and it is a devDependency that the production image
 * deliberately does not install. This script uses the migrator that ships with
 * `drizzle-orm` — already a runtime dependency — so a deployed container can
 * apply exactly the `.sql` files that were reviewed and committed, without
 * pulling build tooling into production.
 *
 * It is run as an explicit deploy step rather than automatically on boot: with
 * more than one instance, boot-time migration means several processes racing to
 * alter the same tables.
 *
 * A single connection, because a migration is one serial sequence of statements.
 */
async function run(): Promise<void> {
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1 });

  try {
    console.log('Applying migrations…');
    await migrate(drizzle(pool), { migrationsFolder: './drizzle' });
    console.log('Migrations applied.');
  } finally {
    await pool.end();
  }
}

run().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
