import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';

import { corsOrigins, isProduction } from './config/env.js';
import { errorHandler, notFoundHandler } from './middlewares/error-handler.js';
import { httpLogger, requestId } from './middlewares/request-context.js';
import { apiRouter } from './routes.js';

/**
 * Builds the Express application without starting a server.
 *
 * Separating this from `server.ts` is what lets integration tests run the whole
 * middleware chain in-process with Supertest — no port, no teardown races, no
 * "did the server finish starting yet" flakiness.
 *
 * Middleware order below is deliberate, and each position matters:
 *   1. requestId   — every later log line and error needs the id.
 *   2. helmet      — security headers, before anything can respond.
 *   3. cors        — must run before routes so preflights never reach them.
 *   4. body/cookie — parsing, before anything reads req.body.
 *   5. rate limit  — cheap rejection ahead of expensive handlers.
 *   6. routes
 *   7. 404 → error handler, always last: Express selects error middleware by
 *      arity and only considers handlers registered after the failing one.
 */
export function createApp(): Express {
  const app = express();

  // Behind a reverse proxy (Render, Fly, nginx), req.ip is the proxy's address
  // unless Express is told to trust X-Forwarded-For. Rate limiting by the
  // proxy's IP would throttle every user as if they were one.
  app.set('trust proxy', isProduction ? 1 : false);
  app.disable('x-powered-by');

  app.use(requestId);
  app.use(httpLogger);

  app.use(
    helmet({
      // This API serves JSON, never HTML, so a restrictive CSP costs nothing.
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  app.use(
    cors({
      origin: corsOrigins,
      // Required for the refresh cookie: without it the browser neither sends
      // nor stores cookies on cross-origin requests.
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
      maxAge: 86_400,
    }),
  );

  // Capped body size. The default is 100 kB, but stating it makes the decision
  // visible: nothing this API accepts is legitimately larger.
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(cookieParser());

  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: 300,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      // Health checks must not consume a user's budget or trip the limiter.
      skip: (req) => req.path === '/health',
    }),
  );

  app.get('/health', (_req, res) => {
    res.json({ data: { status: 'ok', uptime: Math.round(process.uptime()) } });
  });

  app.use('/api/v1', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
