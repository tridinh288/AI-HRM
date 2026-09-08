/**
 * Environment configuration, validated once at startup.
 *
 * Why validate: `process.env.PORT` is `string | undefined` everywhere in Node,
 * and a typo in a variable name normally surfaces as `undefined` deep inside a
 * request three hours after deploy. Parsing the whole environment through a Zod
 * schema at boot turns that into a startup crash with a readable message, and
 * gives the rest of the codebase a fully typed `env` object.
 */

import 'dotenv/config';
import { z } from 'zod';

const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'must be HH:mm, e.g. 08:00');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    DATABASE_URL: z.string().min(1),
    /** Comma-separated list of allowed browser origins. */
    CORS_ORIGIN: z.string().default('http://localhost:5173'),

    // Two different secrets on purpose: if the access-token secret ever leaks,
    // an attacker still cannot mint refresh tokens.
    JWT_ACCESS_SECRET: z.string().min(32, 'use at least 32 characters'),
    JWT_REFRESH_SECRET: z.string().min(32, 'use at least 32 characters'),
    JWT_ACCESS_TTL: z.string().default('15m'),
    JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(7),

    // Company policy. These are configuration, not literals scattered through
    // attendance code — see src/modules/attendance/attendance.policy.ts.
    WORK_START: timeOfDay.default('08:00'),
    WORK_END: timeOfDay.default('17:30'),
    LATE_GRACE_MINUTES: z.coerce.number().int().min(0).max(120).default(5),
    /** Unpaid break deducted from a full day's worked minutes. */
    BREAK_MINUTES: z.coerce.number().int().min(0).max(240).default(60),
    ANNUAL_LEAVE_DAYS: z.coerce.number().int().min(0).max(60).default(12),
    /**
     * The company's local timezone. Attendance timestamps are stored as UTC
     * instants; "was this person late" is a question about *local* wall-clock
     * time, so the conversion has to happen somewhere explicit rather than
     * defaulting to whatever timezone the server happens to run in.
     */
    COMPANY_TIMEZONE: z.string().min(1).default('Asia/Ho_Chi_Minh'),

    AI_PROVIDER: z.enum(['openai', 'anthropic', 'fake']).default('fake'),
    AI_MODEL: z.string().default('gpt-4o-mini'),
    AI_API_KEY: z.string().optional(),
    AI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
    AI_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    /** Hard cap on tool-call rounds per request, so a model that keeps calling
     *  tools cannot run up an unbounded bill or hang the request. */
    AI_MAX_TOOL_ITERATIONS: z.coerce.number().int().min(1).max(10).default(5),
    AI_RATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(30),

    // 'silent' is a real pino level, used by the test suite to keep output clean.
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
  })
  .superRefine((value, ctx) => {
    if (value.AI_PROVIDER !== 'fake' && !value.AI_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AI_API_KEY'],
        message: `AI_API_KEY is required when AI_PROVIDER is "${value.AI_PROVIDER}"`,
      });
    }
    if (value.WORK_END <= value.WORK_START) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['WORK_END'],
        message: 'WORK_END must be after WORK_START',
      });
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  // Fail fast and loudly. A server that boots with a broken configuration is
  // worse than one that refuses to boot.
  throw new Error(`Invalid environment configuration:\n${details}`);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

export const corsOrigins = env.CORS_ORIGIN.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

/** Company attendance / leave policy, in one place. */
export const companyPolicy = {
  workStart: env.WORK_START,
  workEnd: env.WORK_END,
  lateGraceMinutes: env.LATE_GRACE_MINUTES,
  breakMinutes: env.BREAK_MINUTES,
  annualLeaveDays: env.ANNUAL_LEAVE_DAYS,
  timezone: env.COMPANY_TIMEZONE,
} as const;

export type CompanyPolicy = typeof companyPolicy;
