import { Router } from 'express';

import { requireAuth, requireRole } from '../../middlewares/auth.js';
import { uuidParam, validate } from '../../middlewares/validate.js';
import { asyncHandler } from '../../shared/async-handler.js';
import * as controller from './leave.controller.js';
import {
  approveLeaveRequestSchema,
  createLeaveRequestSchema,
  leaveBalanceQuery,
  listLeaveRequestsQuery,
  rejectLeaveRequestSchema,
} from './leave.schema.js';

export const leaveRouter: Router = Router();

leaveRouter.use(requireAuth);

leaveRouter.get('/types', asyncHandler(controller.listTypes));

leaveRouter.get(
  '/balances',
  validate({ query: leaveBalanceQuery }),
  asyncHandler(controller.balances),
);

leaveRouter.get(
  '/requests',
  validate({ query: listLeaveRequestsQuery }),
  asyncHandler(controller.list),
);

leaveRouter.get(
  '/requests/:id',
  validate({ params: uuidParam() }),
  asyncHandler(controller.getById),
);

leaveRouter.post(
  '/requests',
  validate({ body: createLeaveRequestSchema }),
  asyncHandler(controller.create),
);

// Approve and reject are separate endpoints rather than a PATCH of a `status`
// field. A state transition has its own authorization (HR only), its own
// required inputs (a rejection needs a reason), and its own side effects (a
// balance deduction) — folding that into a generic field update hides all three.
leaveRouter.patch(
  '/requests/:id/approve',
  requireRole('HR', 'ADMIN'),
  validate({ params: uuidParam(), body: approveLeaveRequestSchema }),
  asyncHandler(controller.approve),
);

leaveRouter.patch(
  '/requests/:id/reject',
  requireRole('HR', 'ADMIN'),
  validate({ params: uuidParam(), body: rejectLeaveRequestSchema }),
  asyncHandler(controller.reject),
);

// Deliberately not role-gated: cancelling is an ownership decision, and the
// service enforces that the caller owns the request.
leaveRouter.patch(
  '/requests/:id/cancel',
  validate({ params: uuidParam() }),
  asyncHandler(controller.cancel),
);
