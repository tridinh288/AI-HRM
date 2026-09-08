import { Router } from 'express';

import { aiRouter } from './modules/ai/ai.routes.js';
import { attendanceRouter } from './modules/attendance/attendance.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { dashboardRouter } from './modules/dashboard/dashboard.routes.js';
import { departmentRouter } from './modules/departments/department.routes.js';
import { employeeRouter } from './modules/employees/employee.routes.js';
import { leaveRouter } from './modules/leave/leave.routes.js';
import { positionRouter } from './modules/positions/position.routes.js';

/**
 * The API surface, versioned at /api/v1.
 *
 * Versioning in the path is chosen over header negotiation because it is
 * visible in a browser address bar and in a log line, which matters far more for
 * a small API than the purity of the alternative.
 */
export const apiRouter: Router = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/employees', employeeRouter);
apiRouter.use('/departments', departmentRouter);
apiRouter.use('/positions', positionRouter);
apiRouter.use('/attendance', attendanceRouter);
apiRouter.use('/leave', leaveRouter);
apiRouter.use('/dashboard', dashboardRouter);
apiRouter.use('/ai', aiRouter);
