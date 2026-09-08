import { Router } from 'express';

import { requireAuth, requireRole } from '../../middlewares/auth.js';
import { uuidParam, validate } from '../../middlewares/validate.js';
import { asyncHandler } from '../../shared/async-handler.js';
import * as controller from './position.controller.js';
import {
  createPositionSchema,
  listPositionsQuery,
  updatePositionSchema,
} from './position.schema.js';

export const positionRouter: Router = Router();

// Everything here needs a logged-in user. Reads are open to all roles — an
// employee's own profile shows their position, and the leave form shows
// colleagues' departments — while writes are HR/ADMIN only.
positionRouter.use(requireAuth);

positionRouter.get('/', validate({ query: listPositionsQuery }), asyncHandler(controller.list));

positionRouter.get(
  '/:id',
  validate({ params: uuidParam() }),
  asyncHandler(controller.getById),
);

positionRouter.post(
  '/',
  requireRole('HR', 'ADMIN'),
  validate({ body: createPositionSchema }),
  asyncHandler(controller.create),
);

positionRouter.patch(
  '/:id',
  requireRole('HR', 'ADMIN'),
  validate({ params: uuidParam(), body: updatePositionSchema }),
  asyncHandler(controller.update),
);

positionRouter.post(
  '/:id/deactivate',
  requireRole('HR', 'ADMIN'),
  validate({ params: uuidParam() }),
  asyncHandler(controller.deactivate),
);
