import { AppError } from '../../shared/errors.js';
import * as repository from './position.repository.js';
import type {
  CreatePositionInput,
  ListPositionsQuery,
  UpdatePositionInput,
} from './position.schema.js';

export async function listPositions(query: ListPositionsQuery) {
  return repository.listPositions(query);
}

export async function getPosition(id: string) {
  const position = await repository.findPositionById(id);
  if (!position) throw AppError.notFound('Position not found');
  return position;
}

export async function createPosition(input: CreatePositionInput) {
  // Duplicate titles are caught by the unique index, translated into a 409 by
  // the error handler. Checking first would still race; letting the constraint
  // decide is both correct and one query cheaper.
  const id = await repository.insertPosition(input);
  return repository.findPositionById(id);
}

export async function updatePosition(id: string, input: UpdatePositionInput) {
  const updated = await repository.updatePosition(id, input);
  if (!updated) throw AppError.notFound('Position not found');
  return repository.findPositionById(id);
}

/**
 * Deactivation, not deletion.
 *
 * Employees reference positions, and the foreign key is ON DELETE RESTRICT, so a
 * delete would fail anyway once anyone held the position. More importantly, "QA
 * Engineer" appearing in an employee's history is still true after the company
 * stops hiring for it.
 */
export async function deactivatePosition(id: string) {
  const position = await repository.findPositionById(id);
  if (!position) throw AppError.notFound('Position not found');

  if (position.employeeCount > 0) {
    throw AppError.conflict(
      'DEPARTMENT_NOT_EMPTY',
      `Cannot deactivate a position still held by ${position.employeeCount} employee(s)`,
    );
  }

  await repository.updatePosition(id, { isActive: false });
  return repository.findPositionById(id);
}
