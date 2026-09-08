import pino from 'pino';

import { env, isProduction, isTest } from '../config/env.js';

/**
 * Structured logging.
 *
 * Logs are JSON in production because production logs get shipped to a system
 * that queries them — `level:"error" AND module:"auth"` is a query; a formatted
 * sentence is not. Locally they are pretty-printed, because there the reader is
 * a human.
 *
 * The redaction list below is the important part: tokens, passwords, cookies and
 * API keys must never reach a log file. Logs are copied to places with weaker
 * access control than the database, and a refresh token in a log is a valid
 * credential sitting in plain text.
 */
export const logger = pino({
  level: isTest ? 'silent' : env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      'password',
      '*.password',
      'passwordHash',
      '*.passwordHash',
      'currentPassword',
      'newPassword',
      'accessToken',
      '*.accessToken',
      'refreshToken',
      '*.refreshToken',
      'token',
      'apiKey',
      '*.apiKey',
    ],
    censor: '[REDACTED]',
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }),
});

/** A child logger tagged with the module name, so logs can be filtered by area. */
export function moduleLogger(moduleName: string) {
  return logger.child({ module: moduleName });
}
