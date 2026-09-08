/**
 * The API response envelope.
 *
 * Every successful response is `{ data, meta? }` and every failure is
 * `{ error: { code, message, details? } }`. One shape means the frontend has one
 * success path and one error path, instead of a guess per endpoint — and it
 * means a machine-readable `code` the UI can branch on without string-matching
 * an English message that translators will eventually change.
 */

import type { Response } from 'express';

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ApiSuccess<T> {
  data: T;
  meta?: PaginationMeta;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

export function sendData<T>(res: Response, data: T, statusCode = 200): void {
  res.status(statusCode).json({ data } satisfies ApiSuccess<T>);
}

export function sendCreated<T>(res: Response, data: T): void {
  sendData(res, data, 201);
}

export function sendNoContent(res: Response): void {
  res.status(204).end();
}

export function sendPaginated<T>(
  res: Response,
  items: T[],
  pagination: { page: number; pageSize: number; total: number },
): void {
  res.status(200).json({
    data: items,
    meta: {
      ...pagination,
      totalPages: Math.max(1, Math.ceil(pagination.total / pagination.pageSize)),
    },
  } satisfies ApiSuccess<T[]>);
}

/**
 * Offset pagination, chosen because this UI has numbered pages and lets you jump
 * to page 7. Cursor pagination is faster on very large tables (it does not make
 * PostgreSQL count and discard `OFFSET` rows) but cannot express "page 7", and
 * with a few hundred employees the offset cost is not measurable. Documented
 * here so the trade-off is a decision rather than an accident.
 */
export function toOffset(page: number, pageSize: number): number {
  return (page - 1) * pageSize;
}
