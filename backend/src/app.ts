import { existsSync } from 'node:fs';
import path from 'node:path';

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
 * A built frontend, if one was shipped alongside this server.
 *
 * Serving both halves from one process is not a convenience — it is what makes
 * the refresh cookie work. That cookie is SameSite=Strict, so the browser sends
 * it only when the page and the API share a site, and two hostnames under a
 * public suffix like `onrender.com` are two different sites. Split them and
 * login succeeds, then the session vanishes on the first reload; Safari drops
 * the cookie outright.
 *
 * Usually absent: in development Vite serves the frontend, in tests there is no
 * frontend at all, and in the Compose stack nginx serves it. Then none of this
 * is mounted and the process stays a pure JSON API.
 */
const FRONTEND_DIR = path.resolve(process.cwd(), 'public');
const servesFrontend = existsSync(path.join(FRONTEND_DIR, 'index.html'));

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
      // Serving only JSON, a restrictive CSP costs nothing. Serving the SPA as
      // well, `default-src 'none'` would block the page's own bundle — so the
      // policy opens up to exactly this origin. Inline *styles* are allowed
      // because the charting library writes them; inline scripts are not.
      contentSecurityPolicy: servesFrontend
        ? {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              imgSrc: ["'self'", 'data:', 'blob:'],
              fontSrc: ["'self'", 'data:'],
              connectSrc: ["'self'"],
              objectSrc: ["'none'"],
              frameAncestors: ["'none'"],
            },
          }
        : { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
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

  if (servesFrontend) {
    app.use(
      express.static(FRONTEND_DIR, {
        // index.html is served by the fallback below, which sets its own
        // caching. Letting express.static answer "/" first would cache it.
        index: false,
        setHeaders: (res, filePath) => {
          // Asset filenames carry a content hash, so a name never refers to
          // two different files and can be cached indefinitely.
          if (!filePath.endsWith('index.html')) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      }),
    );

    // The router owns the URL. Anything that is not a file and not the API is
    // a page, and gets index.html — otherwise opening /employees directly, or
    // simply pressing F5 on it, is a 404. The home page keeps working either
    // way, which is what makes that bug easy to miss.
    app.get(/^(?!\/api\/)/, (_req, res) => {
      // Never cached: it names the hashed bundles, and a stale copy points at
      // files the last deploy already removed.
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
