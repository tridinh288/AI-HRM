import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import { isTest } from '../../config/env.js';
import { requireAuth } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { asyncHandler } from '../../shared/async-handler.js';
import * as controller from './auth.controller.js';
import { changePasswordSchema, loginSchema } from './auth.schema.js';

/**
 * Login is rate limited far more tightly than the rest of the API, because it is
 * the one endpoint where guessing repeatedly is the attack. Argon2 already makes
 * each attempt expensive for us as well as for the attacker; this caps how many
 * they get.
 *
 * Keyed by IP. That is a real limitation — an attacker with many addresses gets
 * many buckets, and users behind one corporate NAT share a bucket. Per-account
 * lockout would be the complement, and is listed in Known Limitations rather
 * than pretended away.
 */
const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  // See ai.routes.ts: per-IP limiting is meaningless when the whole suite shares
  // one address.
  skip: () => isTest,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many login attempts. Please try again in a few minutes.',
    },
  },
});

export const authRouter = Router();

authRouter.post(
  '/login',
  loginRateLimit,
  validate({ body: loginSchema }),
  asyncHandler(controller.login),
);

authRouter.post('/refresh', asyncHandler(controller.refresh));
authRouter.post('/logout', asyncHandler(controller.logout));

authRouter.get('/me', requireAuth, asyncHandler(controller.me));

authRouter.post(
  '/change-password',
  requireAuth,
  validate({ body: changePasswordSchema }),
  asyncHandler(controller.changePassword),
);
