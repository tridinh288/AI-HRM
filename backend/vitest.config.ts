import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // Integration tests share one PostgreSQL database. Running files in parallel
    // would let one file's truncate wipe another file's fixtures mid-test, so the
    // suite runs single-threaded. Unit tests are pure and fast enough that this
    // costs nothing meaningful.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    setupFiles: ['tests/setup.ts'],
    // Applies migrations to the test database once, before any test file runs.
    globalSetup: ['tests/global-setup.ts'],
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
