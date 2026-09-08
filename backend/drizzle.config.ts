import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  // Migrations are generated as plain .sql files and committed. They are
  // reviewable in a pull request, and production runs exactly the SQL that was
  // reviewed — no "the tool will figure it out at deploy time".
  verbose: true,
  strict: true,
});
