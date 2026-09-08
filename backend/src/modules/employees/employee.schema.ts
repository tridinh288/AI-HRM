import { z } from 'zod';

import { employmentStatusEnum, genderEnum, roleEnum } from '../../db/schema.js';
import { isoDate, paginationQuery } from '../../middlewares/validate.js';
import { passwordSchema } from '../auth/auth.schema.js';

/**
 * Sortable columns are an explicit allow-list, not free text.
 *
 * `ORDER BY` cannot be parameterised — the column name is part of the statement,
 * not a bound value — so a user-supplied sort field interpolated into SQL is a
 * genuine injection point. Restricting it to a union of known keys makes the
 * dangerous case unrepresentable rather than merely escaped.
 */
export const employeeSortFields = [
  'employeeCode',
  'lastName',
  'hireDate',
  'createdAt',
] as const;

export const createEmployeeSchema = z.object({
  // Account
  email: z.string().trim().toLowerCase().email(),
  password: passwordSchema,
  role: z.enum(roleEnum.enumValues).default('EMPLOYEE'),

  // HR record
  employeeCode: z
    .string()
    .trim()
    .toUpperCase()
    .min(3)
    .max(20)
    .regex(/^[A-Z0-9-]+$/, 'Use uppercase letters, digits or hyphens'),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  phone: z
    .string()
    .trim()
    .regex(/^[0-9+\-\s()]{6,20}$/, 'Enter a valid phone number')
    .optional(),
  dateOfBirth: isoDate.optional(),
  gender: z.enum(genderEnum.enumValues).optional(),
  address: z.string().trim().max(255).optional(),
  hireDate: isoDate,
  departmentId: z.string().uuid().optional(),
  positionId: z.string().uuid().optional(),
  employmentStatus: z.enum(['PROBATION', 'ACTIVE']).default('PROBATION'),
  baseSalary: z.coerce.number().nonnegative().max(1_000_000_000).default(0),
});

/**
 * What HR may change about an existing employee.
 *
 * Note what is absent: `email`, `password`, `role`, and `employmentStatus`.
 * Those are account and lifecycle concerns with their own endpoints and their
 * own authorization — folding them into a general-purpose PATCH is how a
 * privilege-escalation bug gets written. Termination in particular has to set a
 * status *and* a date together, which is a transition, not a field edit.
 */
export const updateEmployeeSchema = createEmployeeSchema
  .omit({
    email: true,
    password: true,
    role: true,
    employeeCode: true,
    employmentStatus: true,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update',
  });

/** The subset an employee may change about themselves. */
export const updateOwnProfileSchema = z
  .object({
    phone: z
      .string()
      .trim()
      .regex(/^[0-9+\-\s()]{6,20}$/, 'Enter a valid phone number')
      .optional(),
    address: z.string().trim().max(255).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update',
  });

export const listEmployeesQuery = paginationQuery.extend({
  search: z.string().trim().max(120).optional(),
  departmentId: z.string().uuid().optional(),
  positionId: z.string().uuid().optional(),
  employmentStatus: z.enum(employmentStatusEnum.enumValues).optional(),
  sortBy: z.enum(employeeSortFields).default('employeeCode'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
});

export const terminateEmployeeSchema = z.object({
  terminationDate: isoDate.optional(),
  reason: z.string().trim().max(500).optional(),
});

export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;
export type UpdateOwnProfileInput = z.infer<typeof updateOwnProfileSchema>;
export type ListEmployeesQuery = z.infer<typeof listEmployeesQuery>;
export type TerminateEmployeeInput = z.infer<typeof terminateEmployeeSchema>;
