import type { Request, Response } from 'express';

import { sendCreated, sendData, sendPaginated } from '../../shared/http.js';
import * as service from './department.service.js';
import type {
  CreateDepartmentInput,
  ListDepartmentsQuery,
  UpdateDepartmentInput,
} from './department.schema.js';

export async function list(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListDepartmentsQuery;
  const { items, total } = await service.listDepartments(query);
  sendPaginated(res, items, { page: query.page, pageSize: query.pageSize, total });
}

export async function getById(req: Request, res: Response): Promise<void> {
  sendData(res, await service.getDepartment(req.params.id as string));
}

export async function create(req: Request, res: Response): Promise<void> {
  sendCreated(res, await service.createDepartment(req.body as CreateDepartmentInput));
}

export async function update(req: Request, res: Response): Promise<void> {
  sendData(
    res,
    await service.updateDepartment(req.params.id as string, req.body as UpdateDepartmentInput),
  );
}

export async function deactivate(req: Request, res: Response): Promise<void> {
  sendData(res, await service.deactivateDepartment(req.params.id as string));
}
