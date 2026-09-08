import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import { isTest } from '../../config/env.js';
import { getAuth, requireAuth } from '../../middlewares/auth.js';
import { uuidParam, validate } from '../../middlewares/validate.js';
import { asyncHandler } from '../../shared/async-handler.js';
import { sendData } from '../../shared/http.js';
import { askAssistantSchema } from './ai.schema.js';
import * as service from './ai.service.js';
import type { AskAssistantInput } from './ai.schema.js';

/**
 * A burst limiter in front of the per-user hourly quota in `ai.service`.
 *
 * The two do different jobs: this one stops a runaway client hammering the
 * endpoint (cheap, in-memory, per IP), while the service-level quota controls
 * total spend per account across the hour. Neither replaces the other.
 */
const aiBurstLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Disabled under test: every request in the suite arrives from 127.0.0.1, so a
  // shared per-IP bucket would make unrelated tests fail each other. The limit
  // that actually protects spend is the per-user hourly quota in ai.service,
  // which is database-backed and is tested directly.
  skip: () => isTest,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many assistant requests. Please wait a moment.',
    },
  },
});

export const aiRouter: Router = Router();

aiRouter.use(requireAuth);

// Every authenticated role may use the assistant. What differs is which tools
// it can reach — see ai.tools.getToolsForRole — so there is no role gate here.
aiRouter.get(
  '/capabilities',
  asyncHandler(async (req, res) => {
    sendData(res, service.listCapabilities(getAuth(req)));
  }),
);

aiRouter.post(
  '/assistant',
  aiBurstLimit,
  validate({ body: askAssistantSchema }),
  asyncHandler(async (req, res) => {
    sendData(res, await service.ask(req.body as AskAssistantInput, getAuth(req)));
  }),
);

aiRouter.get(
  '/conversations',
  asyncHandler(async (req, res) => {
    sendData(res, await service.listConversations(getAuth(req)));
  }),
);

aiRouter.get(
  '/conversations/:id',
  validate({ params: uuidParam() }),
  asyncHandler(async (req, res) => {
    sendData(res, await service.getConversation(req.params.id as string, getAuth(req)));
  }),
);
