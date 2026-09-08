import { z } from 'zod';

import { paginationQuery } from '../../middlewares/validate.js';

export const createDepartmentSchema = z.object({
  // Uppercase codes are normalised here rather than at every call site, so
  // "eng" and "ENG" cannot become two departments.
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(2)
    .max(16)
    .regex(/^[A-Z0-9_-]+$/, 'Use letters, digits, hyphen or underscore only'),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).optional(),
});

export const updateDepartmentSchema = createDepartmentSchema
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update',
  });

export const listDepartmentsQuery = paginationQuery.extend({
  search: z.string().trim().max(120).optional(),
  isActive: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});

export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>;
export type UpdateDepartmentInput = z.infer<typeof updateDepartmentSchema>;
export type ListDepartmentsQuery = z.infer<typeof listDepartmentsQuery>;
