import { randomUUID } from 'node:crypto';

import type { RequestHandler } from 'express';
import { pinoHttp } from 'pino-http';

import { isTest } from '../config/env.js';
import { logger } from '../shared/logger.js';

/**
 * Gives every request an id, echoed in the `X-Request-Id` response header, in
 * every log line for that request, and in error responses.
 *
 * This is what makes production debugging possible: a user reports "it failed",
 * you ask for the id shown in the error, and you get exactly the log lines for
 * that request instead of grepping a timestamp range.
 *
 * An inbound `X-Request-Id` is honoured so a trace survives across services —
 * but it is length-capped, because it is client-controlled input that ends up in
 * log files.
 */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.headers['x-request-id'];
  const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
  req.id = candidate && candidate.length <= 64 ? candidate : randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
};

export const httpLogger: RequestHandler = isTest
  ? (_req, _res, next) => next()
  : (pinoHttp({
      logger,
      genReqId: (req) => (req as { id?: string }).id ?? randomUUID(),
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      // Trim the default serializers: full headers on every line is noise, and
      // the sensitive ones are redacted in the logger config anyway.
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }) as unknown as RequestHandler);
