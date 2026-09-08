import { Router } from 'express';

import { requireAuth, requireRole } from '../../middlewares/auth.js';
import { uuidParam, validate } from '../../middlewares/validate.js';
import { asyncHandler } from '../../shared/async-handler.js';
import * as controller from './department.controller.js';
import {
  createDepartmentSchema,
  listDepartmentsQuery,
  updateDepartmentSchema,
} from './department.schema.js';

export const departmentRouter: Router = Router();

departmentRouter.use(requireAuth);

departmentRouter.get('/', validate({ query: listDepartmentsQuery }), asyncHandler(controller.list));

departmentRouter.get('/:id', validate({ params: uuidParam() }), asyncHandler(controller.getById));

departmentRouter.post(
  '/',
  requireRole('HR', 'ADMIN'),
  validate({ body: createDepartmentSchema }),
  asyncHandler(controller.create),
);

departmentRouter.patch(
  '/:id',
  requireRole('HR', 'ADMIN'),
  validate({ params: uuidParam(), body: updateDepartmentSchema }),
  asyncHandler(controller.update),
);

departmentRouter.post(
  '/:id/deactivate',
  requireRole('HR', 'ADMIN'),
  validate({ params: uuidParam() }),
  asyncHandler(controller.deactivate),
);
