import type { Request, Response } from 'express';

import { sendCreated, sendData, sendPaginated } from '../../shared/http.js';
import * as service from './position.service.js';
import type {
  CreatePositionInput,
  ListPositionsQuery,
  UpdatePositionInput,
} from './position.schema.js';

export async function list(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListPositionsQuery;
  const { items, total } = await service.listPositions(query);
  sendPaginated(res, items, { page: query.page, pageSize: query.pageSize, total });
}

export async function getById(req: Request, res: Response): Promise<void> {
  sendData(res, await service.getPosition(req.params.id as string));
}

export async function create(req: Request, res: Response): Promise<void> {
  sendCreated(res, await service.createPosition(req.body as CreatePositionInput));
}

export async function update(req: Request, res: Response): Promise<void> {
  sendData(
    res,
    await service.updatePosition(req.params.id as string, req.body as UpdatePositionInput),
  );
}

export async function deactivate(req: Request, res: Response): Promise<void> {
  sendData(res, await service.deactivatePosition(req.params.id as string));
}
