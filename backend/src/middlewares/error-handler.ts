import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';

import { isProduction } from '../config/env.js';
import { AppError, isAppError, translateDatabaseError } from '../shared/errors.js';
import type { ApiError } from '../shared/http.js';
import { logger } from '../shared/logger.js';

/**
 * The single place where an error becomes an HTTP response.
 *
 * Centralising this is what lets every service throw a domain error and stay
 * ignorant of HTTP. It also guarantees one thing that is easy to get wrong when
 * each handler formats its own errors: **internal details never leak**. A
 * PostgreSQL message names tables and columns; a stack trace names file paths
 * and library versions. Both are free reconnaissance for an attacker and mean
 * nothing to a user, so in production the client gets a code and a sentence,
 * while the full error goes to the log with a request id to correlate them.
 */
export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const requestId = String(req.id);

  // Zod errors that escaped the validate() middleware (e.g. from parsing an
  // external AI response) are still validation failures.
  if (error instanceof ZodError) {
    const details = error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    respond(AppError.badRequest('VALIDATION_ERROR', 'Validation failed', details));
    return;
  }

  // A unique or check constraint firing is a business conflict, not a crash:
  // it is how the database reports a race that application checks lost.
  const databaseError = translateDatabaseError(error);
  if (databaseError) {
    respond(databaseError);
    return;
  }

  if (isAppError(error)) {
    respond(error);
    return;
  }

  // Anything reaching here is a bug. Log everything, tell the client nothing.
  logger.error(
    { err: error, requestId, method: req.method, url: req.originalUrl },
    'Unhandled error',
  );
  respond(AppError.internal());

  function respond(appError: AppError): void {
    const body: ApiError = {
      error: {
        code: appError.code,
        message: appError.message,
        requestId,
      },
    };

    if (appError.details !== undefined) {
      body.error.details = appError.details;
    }

    // 5xx from a deliberate AppError still deserves a log line.
    if (appError.statusCode >= 500) {
      logger.error({ err: error, requestId }, appError.message);
    } else if (appError.statusCode === 401 || appError.statusCode === 403) {
      // Authentication and authorization failures are security-relevant events.
      // Logged at warn so they are visible without drowning in 404s.
      logger.warn(
        {
          requestId,
          code: appError.code,
          userId: req.auth?.userId,
          role: req.auth?.role,
          method: req.method,
          url: req.originalUrl,
        },
        'Access denied',
      );
    }

    // In development the stack is genuinely useful and there is no attacker.
    if (!isProduction && !isAppError(error) && error instanceof Error) {
      body.error.details = { stack: error.stack?.split('\n').slice(0, 5) };
    }

    res.status(appError.statusCode).json(body);
  }
};

/** Any request that matched no route. Registered last, before the error handler. */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(AppError.notFound(`Route ${req.method} ${req.originalUrl} does not exist`));
};
