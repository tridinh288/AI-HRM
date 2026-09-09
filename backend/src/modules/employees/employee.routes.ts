import { Router } from 'express';

import { requireAuth, requireRole } from '../../middlewares/auth.js';
import { uuidParam, validate } from '../../middlewares/validate.js';
import { asyncHandler } from '../../shared/async-handler.js';
import * as controller from './employee.controller.js';
import {
  createEmployeeSchema,
  listEmployeesQuery,
  terminateEmployeeSchema,
  updateAccountSchema,
  updateEmployeeSchema,
  updateOwnProfileSchema,
} from './employee.schema.js';

export const employeeRouter: Router = Router();

employeeRouter.use(requireAuth);

// `/me` is declared before `/:id`. Express matches routes in registration order,
// and `/:id` would otherwise capture the literal string "me" and then fail UUID
// validation — a genuinely confusing 400 for a route that looks correct.
employeeRouter.get('/me', asyncHandler(controller.me));

employeeRouter.patch(
  '/me',
  validate({ body: updateOwnProfileSchema }),
  asyncHandler(controller.updateMe),
);

employeeRouter.get(
  '/',
  requireRole('HR', 'ADMIN'),
  validate({ query: listEmployeesQuery }),
  asyncHandler(controller.list),
);

// Not restricted by role at the route level on purpose: an employee may read
// their *own* record through this endpoint, and the service decides whose record
// that is. See employee.service.getEmployee.
employeeRouter.get('/:id', validate({ params: uuidParam() }), asyncHandler(controller.getById));

employeeRouter.post(
  '/',
  requireRole('HR', 'ADMIN'),
  validate({ body: createEmployeeSchema }),
  asyncHandler(controller.create),
);

employeeRouter.patch(
  '/:id',
  requireRole('HR', 'ADMIN'),
  validate({ params: uuidParam(), body: updateEmployeeSchema }),
  asyncHandler(controller.update),
);

employeeRouter.post(
  '/:id/terminate',
  requireRole('HR', 'ADMIN'),
  validate({ params: uuidParam(), body: terminateEmployeeSchema }),
  asyncHandler(controller.terminate),
);

// ADMIN alone: HR manages people, ADMIN manages access. This is the one route
// where the two roles differ, and the reason the ADMIN role exists.
employeeRouter.patch(
  '/:id/account',
  requireRole('ADMIN'),
  validate({ params: uuidParam(), body: updateAccountSchema }),
  asyncHandler(controller.updateAccount),
);
