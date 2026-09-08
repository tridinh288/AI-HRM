/**
 * Runs before every test file.
 *
 * The environment is set here, in code, rather than in a committed .env.test —
 * so the suite is reproducible on any machine and in CI without a file anyone
 * has to remember to create, and so the values used by tests are visible next to
 * the tests themselves.
 *
 * `config/env.ts` reads process.env at import time, so this must run before any
 * application module is imported. Vitest's `setupFiles` guarantees that.
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

process.env.DATABASE_URL ??= 'postgresql://hrm:hrm_local_dev@localhost:5432/hrm_test?schema=public';

process.env.JWT_ACCESS_SECRET = 'test_access_secret_at_least_32_characters_long_xxxx';
process.env.JWT_REFRESH_SECRET = 'test_refresh_secret_at_least_32_characters_long_yyy';
process.env.JWT_ACCESS_TTL = '15m';
process.env.JWT_REFRESH_TTL_DAYS = '7';

// Fixed policy so assertions are about the rules, not about whoever's local .env.
process.env.WORK_START = '08:00';
process.env.WORK_END = '17:30';
process.env.LATE_GRACE_MINUTES = '5';
process.env.BREAK_MINUTES = '60';
process.env.ANNUAL_LEAVE_DAYS = '12';
process.env.COMPANY_TIMEZONE = 'Asia/Ho_Chi_Minh';

// Never call a real LLM from a test: no network, no cost, no flakiness.
process.env.AI_PROVIDER = 'fake';
process.env.AI_API_KEY = '';
// Low enough that the per-user quota can be exercised in a test, high enough
// that no other test brushes against it (each test resets the database first).
process.env.AI_RATE_LIMIT_PER_HOUR = '5';

/**
 * Closes the connection pool when a test file finishes.
 *
 * Vitest isolates each test file in its own module registry, so each one creates
 * its own pool — and each must close it, or the process keeps live handles open
 * and the run never exits. The dynamic import matters: a static one would be
 * hoisted above the environment assignments above, and `config/env.ts` reads
 * process.env at import time.
 */
const { afterAll } = await import('vitest');

afterAll(async () => {
  const { closeDatabase } = await import('../src/db/client.js');
  await closeDatabase();
});
