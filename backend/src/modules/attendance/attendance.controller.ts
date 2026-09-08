import type { Request, Response } from 'express';

import { getAuth } from '../../middlewares/auth.js';
import { sendCreated, sendData, sendPaginated } from '../../shared/http.js';
import * as service from './attendance.service.js';
import type {
  AttendanceSummaryQuery,
  CorrectAttendanceInput,
  ListAttendanceQuery,
} from './attendance.schema.js';

export async function checkIn(req: Request, res: Response): Promise<void> {
  sendCreated(res, await service.checkIn(getAuth(req)));
}

export async function checkOut(req: Request, res: Response): Promise<void> {
  sendData(res, await service.checkOut(getAuth(req)));
}

export async function today(req: Request, res: Response): Promise<void> {
  sendData(res, await service.getToday(getAuth(req)));
}

export async function list(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListAttendanceQuery;
  const { items, total } = await service.listAttendance(query, getAuth(req));
  sendPaginated(res, items, { page: query.page, pageSize: query.pageSize, total });
}

export async function summary(req: Request, res: Response): Promise<void> {
  sendData(
    res,
    await service.getSummary(req.query as unknown as AttendanceSummaryQuery, getAuth(req)),
  );
}

export async function correct(req: Request, res: Response): Promise<void> {
  sendData(
    res,
    await service.correctAttendance(
      req.params.id as string,
      req.body as CorrectAttendanceInput,
      getAuth(req),
    ),
  );
}
