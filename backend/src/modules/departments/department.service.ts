import { AppError } from '../../shared/errors.js';
import * as repository from './department.repository.js';
import type {
  CreateDepartmentInput,
  ListDepartmentsQuery,
  UpdateDepartmentInput,
} from './department.schema.js';

export async function listDepartments(query: ListDepartmentsQuery) {
  return repository.listDepartments(query);
}

export async function getDepartment(id: string) {
  const department = await repository.findDepartmentById(id);
  if (!department) throw AppError.notFound('Department not found');
  return department;
}

export async function createDepartment(input: CreateDepartmentInput) {
  const id = await repository.insertDepartment(input);
  return repository.findDepartmentById(id);
}

export async function updateDepartment(id: string, input: UpdateDepartmentInput) {
  const updated = await repository.updateDepartment(id, input);
  if (!updated) throw AppError.notFound('Department not found');
  return repository.findDepartmentById(id);
}

/**
 * A department with employees cannot be deactivated.
 *
 * The rule lives here rather than in the database because it is a *business*
 * rule about a status column, not about referential integrity — the foreign key
 * already stops a hard delete. Blocking it matters because a deactivated
 * department still owning employees leaves the org chart in a state nobody can
 * explain: the people exist, the department they belong to does not.
 */
export async function deactivateDepartment(id: string) {
  const department = await repository.findDepartmentById(id);
  if (!department) throw AppError.notFound('Department not found');

  if (department.employeeCount > 0) {
    throw AppError.conflict(
      'DEPARTMENT_NOT_EMPTY',
      `Move or terminate the ${department.employeeCount} employee(s) in this department first`,
    );
  }

  await repository.updateDepartment(id, { isActive: false });
  return repository.findDepartmentById(id);
}
