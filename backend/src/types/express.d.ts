import type { AuthContext } from '../shared/auth-context.js';

declare global {
  namespace Express {
    interface Request {
      // `id` (the correlation id) is declared by pino-http as `ReqId`, so it is
      // deliberately not redeclared here — two declarations of the same property
      // with different types is a compile error, and pino-http's is the one the
      // logger actually uses.
      /** Present only after `requireAuth` has run. */
      auth?: AuthContext;
    }
  }
}

export {};
