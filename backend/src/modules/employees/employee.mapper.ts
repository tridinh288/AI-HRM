import type { Role } from '../../db/schema.js';
import type { AuthContext } from '../../shared/auth-context.js';
import type { EmployeeRow } from './employee.repository.js';

/**
 * Row → response object, with field-level authorization applied here and only
 * here.
 *
 * This is the third layer of authorization (after route middleware and row-level
 * service checks) and it exists because `base_salary` is not an all-or-nothing
 * field: an employee may read their own record but must not see anyone's salary
 * but their own. Doing that by selecting different columns per caller would
 * scatter the rule across every query; doing it in one mapper means there is a
 * single function to audit, and any new endpoint that returns an employee gets
 * the rule for free.
 *
 * Note the shape: `baseSalary` is *absent*, not null, when the viewer may not
 * see it — so a frontend bug cannot render `null` as `0`.
 */

export interface EmployeeDto {
  id: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  /** The account's role. Not sensitive — it is what the sidebar badge shows —
   *  and the accounts page needs it to offer the right change. */
  role: Role;
  phone: string | null;
  dateOfBirth: string | null;
  gender: string | null;
  address: string | null;
  hireDate: string;
  employmentStatus: string;
  terminatedAt: string | null;
  isActive: boolean;
  department: { id: string; name: string } | null;
  position: { id: string; title: string; level: string } | null;
  baseSalary?: number;
  createdAt: string;
}

export function canViewSalary(viewer: AuthContext, employeeId: string): boolean {
  if (viewer.role === 'HR' || viewer.role === 'ADMIN') return true;
  return viewer.employeeId === employeeId;
}

export function toEmployeeDto(row: EmployeeRow, viewer: AuthContext): EmployeeDto {
  const dto: EmployeeDto = {
    id: row.id,
    employeeCode: row.employeeCode,
    firstName: row.firstName,
    lastName: row.lastName,
    fullName: `${row.firstName} ${row.lastName}`,
    email: row.email,
    role: row.role,
    phone: row.phone,
    dateOfBirth: row.dateOfBirth,
    gender: row.gender,
    address: row.address,
    hireDate: row.hireDate,
    employmentStatus: row.employmentStatus,
    terminatedAt: row.terminatedAt ? row.terminatedAt.toISOString() : null,
    isActive: row.isActive,
    department: row.departmentId
      ? { id: row.departmentId, name: row.departmentName ?? '' }
      : null,
    position: row.positionId
      ? {
          id: row.positionId,
          title: row.positionTitle ?? '',
          level: row.positionLevel ?? '',
        }
      : null,
    createdAt: row.createdAt.toISOString(),
  };

  if (canViewSalary(viewer, row.id)) {
    // The column is DECIMAL, which the driver returns as a string to avoid the
    // precision loss of a float. Converted once, at the boundary.
    dto.baseSalary = Number(row.baseSalary);
  }

  return dto;
}

/**
 * The shape used by AI tools.
 *
 * Salary, address, phone and date of birth are not merely hidden — they are not
 * part of this type at all. That is the point: a tool cannot accidentally leak a
 * field its return type does not have, no matter what the model asks for.
 */
export interface EmployeePublicDto {
  id: string;
  employeeCode: string;
  fullName: string;
  department: string | null;
  position: string | null;
  employmentStatus: string;
  hireDate: string;
}

export function toEmployeePublicDto(row: EmployeeRow): EmployeePublicDto {
  return {
    id: row.id,
    employeeCode: row.employeeCode,
    fullName: `${row.firstName} ${row.lastName}`,
    department: row.departmentName,
    position: row.positionTitle,
    employmentStatus: row.employmentStatus,
    hireDate: row.hireDate,
  };
}
