import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import { env, isProduction } from '../config/env.js';
import * as schema from './schema.js';

/**
 * A single connection pool for the whole process.
 *
 * Opening a connection per request would spend more time on the TCP + auth
 * handshake than on the query itself, and PostgreSQL charges roughly 5–10 MB of
 * server memory per backend process, so unbounded connections take the database
 * down before they take the app down. The pool caps concurrency at `max` and
 * queues beyond it.
 */
export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: isProduction ? 20 : 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

// An idle client erroring (database restarted, network blip) emits on the pool.
// Without a listener, Node treats it as an unhandled 'error' event and exits.
pool.on('error', (error) => {
  console.error('[db] idle client error', error);
});

export const db = drizzle(pool, { schema, logger: false });

export type Database = typeof db;

/**
 * Either the pool-backed database or a transaction handle.
 *
 * Repository functions accept this so the same function works inside and
 * outside a transaction — which is what lets `leave.service` do the balance
 * check and the status update atomically without duplicating query code.
 */
export type DbExecutor = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
