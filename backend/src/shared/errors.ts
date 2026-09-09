/**
 * One error type for the whole application.
 *
 * The point of a single `AppError` is that services can express *what went
 * wrong in business terms* without importing Express or knowing about HTTP, and
 * one middleware turns that into a response. A service throwing
 * `AppError.conflict('LEAVE_OVERLAP', ...)` works identically whether it was
 * reached through a route or through an AI tool call.
 *
 * Anything thrown that is *not* an AppError is treated as a bug: it is logged
 * with its stack and reported to the client as a generic 500, because internal
 * error messages leak implementation details (table names, file paths, library
 * versions) that are useful to an attacker and useless to a user.
 */

export type ErrorCode =
  // 400
  | 'VALIDATION_ERROR'
  | 'INVALID_DATE_RANGE'
  // 401
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_INVALID'
  | 'ACCOUNT_DISABLED'
  // 403
  | 'FORBIDDEN'
  | 'INSUFFICIENT_ROLE'
  | 'NOT_YOUR_RECORD'
  // 404
  | 'NOT_FOUND'
  // 409
  | 'EMAIL_ALREADY_EXISTS'
  | 'EMPLOYEE_CODE_ALREADY_EXISTS'
  | 'DEPARTMENT_ALREADY_EXISTS'
  | 'POSITION_ALREADY_EXISTS'
  | 'ALREADY_CHECKED_IN'
  | 'NOT_CHECKED_IN'
  | 'ALREADY_CHECKED_OUT'
  | 'LEAVE_OVERLAP'
  | 'LEAVE_BALANCE_EXCEEDED'
  | 'LEAVE_ALREADY_DECIDED'
  | 'CANNOT_APPROVE_OWN_REQUEST'
  | 'DEPARTMENT_NOT_EMPTY'
  | 'EMPLOYEE_ALREADY_TERMINATED'
  | 'EMPLOYEE_TERMINATED'
  | 'CANNOT_MODIFY_OWN_ACCOUNT'
  | 'LAST_ADMIN'
  // 429
  | 'RATE_LIMITED'
  // 500 / 503
  | 'INTERNAL_ERROR'
  | 'AI_PROVIDER_UNAVAILABLE'
  | 'AI_RESPONSE_INVALID';

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details?: unknown;
  /** True for errors we raised deliberately; false for unexpected crashes. */
  readonly isOperational = true;

  constructor(statusCode: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace?.(this, AppError);
  }

  static badRequest(code: ErrorCode, message: string, details?: unknown): AppError {
    return new AppError(400, code, message, details);
  }

  /** 401: "I do not know who you are." */
  static unauthorized(code: ErrorCode, message: string): AppError {
    return new AppError(401, code, message);
  }

  /** 403: "I know who you are, and the answer is no." */
  static forbidden(code: ErrorCode, message: string): AppError {
    return new AppError(403, code, message);
  }

  static notFound(message = 'Resource not found'): AppError {
    return new AppError(404, 'NOT_FOUND', message);
  }

  /** 409: the request was well-formed but conflicts with the current state. */
  static conflict(code: ErrorCode, message: string, details?: unknown): AppError {
    return new AppError(409, code, message, details);
  }

  static tooManyRequests(message: string): AppError {
    return new AppError(429, 'RATE_LIMITED', message);
  }

  static serviceUnavailable(code: ErrorCode, message: string): AppError {
    return new AppError(503, code, message);
  }

  static internal(message = 'Something went wrong'): AppError {
    return new AppError(500, 'INTERNAL_ERROR', message);
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * PostgreSQL error codes we translate into meaningful business errors.
 * `23505` is unique_violation, `23514` is check_violation, `23503` is
 * foreign_key_violation.
 *
 * This matters because the database is the authority on uniqueness: two
 * concurrent check-in requests can both pass an application-level "does a record
 * exist?" test, and only one will survive the unique index. Catching 23505 here
 * turns that race into a clean 409 instead of a 500.
 */
export interface PostgresError {
  code?: string;
  constraint?: string;
  detail?: string;
}

/**
 * Finds the underlying PostgreSQL error, unwrapping driver wrappers.
 *
 * Drizzle raises its own `DrizzleQueryError` and puts the original `pg` error on
 * `.cause`, so a naive `error.code === '23505'` check silently never matches —
 * and every unique-violation conflict is reported to the user as a 500 instead
 * of a 409. This walks the cause chain (bounded, in case anything is circular)
 * and returns the first link that carries a PostgreSQL error code.
 *
 * This was found by an integration test asserting a real duplicate insert, which
 * is precisely the kind of bug a mocked database cannot surface.
 */
export function asPostgresError(error: unknown): PostgresError | null {
  let current: unknown = error;

  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current === 'object' && current !== null && 'code' in current) {
      const code = (current as { code?: unknown }).code;
      // PostgreSQL SQLSTATE codes are five characters, e.g. "23505".
      if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
        return current as PostgresError;
      }
    }
    current = (current as { cause?: unknown } | null)?.cause;
  }

  return null;
}

const CONSTRAINT_ERRORS: Record<string, () => AppError> = {
  users_email_lower_unique: () =>
    AppError.conflict('EMAIL_ALREADY_EXISTS', 'An account with this email already exists'),
  employees_employee_code_unique: () =>
    AppError.conflict('EMPLOYEE_CODE_ALREADY_EXISTS', 'This employee code is already in use'),
  departments_code_unique: () =>
    AppError.conflict('DEPARTMENT_ALREADY_EXISTS', 'A department with this code already exists'),
  departments_name_unique: () =>
    AppError.conflict('DEPARTMENT_ALREADY_EXISTS', 'A department with this name already exists'),
  positions_title_unique: () =>
    AppError.conflict('POSITION_ALREADY_EXISTS', 'A position with this title already exists'),
  attendance_employee_date_unique: () =>
    AppError.conflict('ALREADY_CHECKED_IN', 'You have already checked in today'),
  leave_balance_within_entitlement: () =>
    AppError.conflict(
      'LEAVE_BALANCE_EXCEEDED',
      'Approving this request would exceed the leave entitlement',
    ),
};

/** Maps a PostgreSQL constraint violation to a business error, if we know it. */
export function translateDatabaseError(error: unknown): AppError | null {
  const pgError = asPostgresError(error);
  if (!pgError?.constraint) return null;
  if (pgError.code !== '23505' && pgError.code !== '23514') return null;
  const factory = CONSTRAINT_ERRORS[pgError.constraint];
  return factory ? factory() : null;
}
