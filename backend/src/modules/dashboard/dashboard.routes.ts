import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requireRole } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { asyncHandler } from '../../shared/async-handler.js';
import { sendData } from '../../shared/http.js';
import * as service from './dashboard.service.js';

const rangeQuery = z.object({
  // Capped at a year: an unbounded window would let one request scan the whole
  // attendance table and generate a series of arbitrary length.
  days: z.coerce.number().int().min(7).max(365).default(30),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const dashboardRouter: Router = Router();

// Organisation-wide figures — HR and ADMIN only, gated at the router level
// because every route below it is equally sensitive.
dashboardRouter.use(requireAuth, requireRole('HR', 'ADMIN'));

dashboardRouter.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    sendData(res, await service.getOverview());
  }),
);

dashboardRouter.get(
  '/charts',
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const { days } = req.query as unknown as z.infer<typeof rangeQuery>;
    sendData(res, await service.getCharts(days));
  }),
);

dashboardRouter.get(
  '/late-employees',
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const { days, limit } = req.query as unknown as z.infer<typeof rangeQuery>;
    sendData(res, await service.getLateEmployees(days, limit));
  }),
);
