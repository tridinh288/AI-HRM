import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z, type ZodTypeAny } from 'zod';

import { AppError } from '../shared/errors.js';

/**
 * Request validation as middleware.
 *
 * Two things this buys us beyond "reject bad input":
 *
 *  1. The parsed result *replaces* `req.body` / `req.query` / `req.params`, so
 *     handlers receive coerced, typed values ("2" → 2) and — because Zod strips
 *     unknown keys — a client cannot smuggle extra fields into an update. That
 *     is the mass-assignment defence: `role: "ADMIN"` posted to an employee
 *     update is dropped by the schema, not by the handler remembering to.
 *  2. `z.infer<typeof schema>` gives the handler its parameter types, so the
 *     runtime check and the compile-time type cannot drift apart.
 */

export interface RequestSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

export function validate(schemas: RequestSchemas): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const issues: { path: string; message: string }[] = [];

    for (const key of ['body', 'query', 'params'] as const) {
      const schema = schemas[key];
      if (!schema) continue;

      const result = schema.safeParse(req[key]);
      if (result.success) {
        // req.query is a getter on some Express versions; defineProperty works
        // regardless of whether the original property was writable.
        Object.defineProperty(req, key, {
          value: result.data,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      } else {
        for (const issue of result.error.issues) {
          issues.push({
            path: [key, ...issue.path].join('.'),
            message: issue.message,
          });
        }
      }
    }

    if (issues.length > 0) {
      next(AppError.badRequest('VALIDATION_ERROR', 'Request validation failed', issues));
      return;
    }

    next();
  };
}

/** Shared building blocks so every list endpoint paginates the same way. */
export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  // Capped: an unbounded pageSize lets one request ask for the whole table,
  // which is both a performance problem and a data-exfiltration convenience.
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const uuidParam = (name = 'id') =>
  z.object({ [name]: z.string().uuid('must be a valid id') } as Record<string, z.ZodString>);

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date in YYYY-MM-DD format')
  .refine((value) => !Number.isNaN(Date.parse(value)), 'must be a real calendar date');
