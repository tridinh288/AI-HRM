import type { Request, Response } from 'express';

import { getAuth } from '../../middlewares/auth.js';
import { sendCreated, sendData, sendPaginated } from '../../shared/http.js';
import * as service from './employee.service.js';
import type {
  CreateEmployeeInput,
  ListEmployeesQuery,
  TerminateEmployeeInput,
  UpdateEmployeeInput,
  UpdateOwnProfileInput,
} from './employee.schema.js';

export async function list(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListEmployeesQuery;
  const { items, total } = await service.listEmployees(query, getAuth(req));
  sendPaginated(res, items, { page: query.page, pageSize: query.pageSize, total });
}

export async function me(req: Request, res: Response): Promise<void> {
  sendData(res, await service.getOwnProfile(getAuth(req)));
}

export async function updateMe(req: Request, res: Response): Promise<void> {
  sendData(res, await service.updateOwnProfile(req.body as UpdateOwnProfileInput, getAuth(req)));
}

export async function getById(req: Request, res: Response): Promise<void> {
  sendData(res, await service.getEmployee(req.params.id as string, getAuth(req)));
}

export async function create(req: Request, res: Response): Promise<void> {
  sendCreated(res, await service.createEmployee(req.body as CreateEmployeeInput, getAuth(req)));
}

export async function update(req: Request, res: Response): Promise<void> {
  sendData(
    res,
    await service.updateEmployee(
      req.params.id as string,
      req.body as UpdateEmployeeInput,
      getAuth(req),
    ),
  );
}

export async function terminate(req: Request, res: Response): Promise<void> {
  sendData(
    res,
    await service.terminateEmployee(
      req.params.id as string,
      req.body as TerminateEmployeeInput,
      getAuth(req),
    ),
  );
}
