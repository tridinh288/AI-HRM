import { z } from 'zod';

import { positionLevelEnum } from '../../db/schema.js';
import { paginationQuery } from '../../middlewares/validate.js';

export const positionLevels = positionLevelEnum.enumValues;

export const createPositionSchema = z.object({
  title: z.string().trim().min(2).max(120),
  level: z.enum(positionLevels).default('JUNIOR'),
  description: z.string().trim().max(500).optional(),
});

// Partial, and required to be non-empty: `PATCH` with `{}` is almost always a
// frontend bug, and silently returning 200 hides it.
export const updatePositionSchema = createPositionSchema
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update',
  });

export const listPositionsQuery = paginationQuery.extend({
  search: z.string().trim().max(120).optional(),
  level: z.enum(positionLevels).optional(),
  isActive: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});

export type CreatePositionInput = z.infer<typeof createPositionSchema>;
export type UpdatePositionInput = z.infer<typeof updatePositionSchema>;
export type ListPositionsQuery = z.infer<typeof listPositionsQuery>;
