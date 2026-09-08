import { Router } from 'express';

import { requireAuth, requireRole } from '../../middlewares/auth.js';
import { uuidParam, validate } from '../../middlewares/validate.js';
import { asyncHandler } from '../../shared/async-handler.js';
import * as controller from './attendance.controller.js';
import {
  attendanceSummaryQuery,
  correctAttendanceSchema,
  listAttendanceQuery,
} from './attendance.schema.js';

export const attendanceRouter: Router = Router();

attendanceRouter.use(requireAuth);

// POST rather than PATCH: checking in creates a record of an event that
// happened, and the server decides the timestamp. A client-supplied time would
// let anyone record having arrived at 08:00 from their sofa at 10:00.
attendanceRouter.post('/check-in', asyncHandler(controller.checkIn));
attendanceRouter.post('/check-out', asyncHandler(controller.checkOut));

attendanceRouter.get('/today', asyncHandler(controller.today));

attendanceRouter.get(
  '/summary',
  validate({ query: attendanceSummaryQuery }),
  asyncHandler(controller.summary),
);

// Open to every role: the service narrows the query to the caller's own records
// unless they are HR or ADMIN. See attendance.service.listAttendance.
attendanceRouter.get('/', validate({ query: listAttendanceQuery }), asyncHandler(controller.list));

attendanceRouter.patch(
  '/:id',
  requireRole('HR', 'ADMIN'),
  validate({ params: uuidParam(), body: correctAttendanceSchema }),
  asyncHandler(controller.correct),
);
