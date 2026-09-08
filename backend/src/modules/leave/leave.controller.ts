import type { Request, Response } from 'express';

import { getAuth } from '../../middlewares/auth.js';
import { sendCreated, sendData, sendPaginated } from '../../shared/http.js';
import * as service from './leave.service.js';
import type {
  ApproveLeaveRequestInput,
  CreateLeaveRequestInput,
  LeaveBalanceQuery,
  ListLeaveRequestsQuery,
  RejectLeaveRequestInput,
} from './leave.schema.js';

export async function listTypes(_req: Request, res: Response): Promise<void> {
  sendData(res, await service.listLeaveTypes());
}

export async function balances(req: Request, res: Response): Promise<void> {
  sendData(res, await service.getBalances(req.query as unknown as LeaveBalanceQuery, getAuth(req)));
}

export async function list(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListLeaveRequestsQuery;
  const { items, total } = await service.listLeaveRequests(query, getAuth(req));
  sendPaginated(res, items, { page: query.page, pageSize: query.pageSize, total });
}

export async function getById(req: Request, res: Response): Promise<void> {
  sendData(res, await service.getLeaveRequest(req.params.id as string, getAuth(req)));
}

export async function create(req: Request, res: Response): Promise<void> {
  sendCreated(
    res,
    await service.createLeaveRequest(req.body as CreateLeaveRequestInput, getAuth(req)),
  );
}

export async function approve(req: Request, res: Response): Promise<void> {
  sendData(
    res,
    await service.approveLeaveRequest(
      req.params.id as string,
      req.body as ApproveLeaveRequestInput,
      getAuth(req),
    ),
  );
}

export async function reject(req: Request, res: Response): Promise<void> {
  sendData(
    res,
    await service.rejectLeaveRequest(
      req.params.id as string,
      req.body as RejectLeaveRequestInput,
      getAuth(req),
    ),
  );
}

export async function cancel(req: Request, res: Response): Promise<void> {
  sendData(res, await service.cancelLeaveRequest(req.params.id as string, getAuth(req)));
}
