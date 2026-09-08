import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { Role } from '../db/schema.js';
import type { AuthContext } from '../shared/auth-context.js';
import { AppError } from '../shared/errors.js';
import { verifyAccessToken } from '../modules/auth/auth.tokens.js';

/**
 * Authentication: establishes *who* the caller is.
 *
 * Nothing here decides what they may do — that is authorization, and it happens
 * in `requireRole` (endpoint level) and in services (row level). Keeping the two
 * separate is what makes "401 vs 403" unambiguous: this middleware only ever
 * produces 401.
 */
export const requireAuth: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  const header = req.headers.authorization;

  if (!header?.startsWith('Bearer ')) {
    next(AppError.unauthorized('UNAUTHENTICATED', 'Authentication required'));
    return;
  }

  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    next(AppError.unauthorized('UNAUTHENTICATED', 'Authentication required'));
    return;
  }

  try {
    req.auth = verifyAccessToken(token);
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Authorization at the endpoint level: is this role allowed here at all?
 *
 * This is a coarse gate. It answers "may an EMPLOYEE call the approve endpoint"
 * (no), but it cannot answer "may THIS employee read THAT record" — that needs
 * the record, so it belongs in the service. Both layers exist on purpose: if a
 * route is ever wired up without this middleware, the service check still holds.
 */
export function requireRole(...allowed: Role[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) {
      next(AppError.unauthorized('UNAUTHENTICATED', 'Authentication required'));
      return;
    }

    if (!allowed.includes(req.auth.role)) {
      next(
        AppError.forbidden(
          'INSUFFICIENT_ROLE',
          `This action requires one of: ${allowed.join(', ')}`,
        ),
      );
      return;
    }

    next();
  };
}

/**
 * Reads the auth context inside a handler.
 *
 * Throwing rather than returning `undefined` keeps handlers free of
 * `if (!req.auth)` noise: any route that calls this is behind `requireAuth`, and
 * if it is ever not, the failure is loud instead of a silent `undefined.userId`.
 */
export function getAuth(req: Request): AuthContext {
  if (!req.auth) {
    throw AppError.unauthorized('UNAUTHENTICATED', 'Authentication required');
  }
  return req.auth;
}

/**
 * Row-level authorization for "my own record" endpoints.
 *
 * HR and ADMIN may read anyone. Everyone else may read only the employee record
 * attached to their own account. This is the check that stops
 * `GET /employees/<someone-else-id>` from working, and it lives in application
 * code because the answer depends on the row being requested.
 */
export function assertCanAccessEmployee(auth: AuthContext, employeeId: string): void {
  if (auth.role === 'HR' || auth.role === 'ADMIN') return;
  if (auth.employeeId && auth.employeeId === employeeId) return;
  throw AppError.forbidden('NOT_YOUR_RECORD', 'You may only access your own records');
}

/** Same rule, expressed as a predicate for places that need to branch. */
export function canAccessEmployee(auth: AuthContext, employeeId: string): boolean {
  if (auth.role === 'HR' || auth.role === 'ADMIN') return true;
  return auth.employeeId === employeeId;
}

/**
 * The caller's own employee record, or a clear error.
 *
 * An ADMIN account may legitimately have no employee record, so endpoints like
 * "check me in" have to fail helpfully rather than crash on a null id.
 */
export function requireOwnEmployeeId(auth: AuthContext): string {
  if (!auth.employeeId) {
    throw AppError.forbidden(
      'FORBIDDEN',
      'This account has no employee record, so it cannot perform employee actions',
    );
  }
  return auth.employeeId;
}
