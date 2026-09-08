import { z } from 'zod';

import { attendanceStatusEnum } from '../../db/schema.js';
import { isoDate, paginationQuery } from '../../middlewares/validate.js';

export const listAttendanceQuery = paginationQuery.extend({
  employeeId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  status: z.enum(attendanceStatusEnum.enumValues).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export const attendanceSummaryQuery = z.object({
  employeeId: z.string().uuid().optional(),
  from: isoDate,
  to: isoDate,
});

/**
 * An HR correction supplies wall-clock times; everything derived (late minutes,
 * overtime, status) is recomputed from them by the same policy functions the
 * live check-in uses.
 *
 * Letting HR set `lateMinutes` directly would create a second, hand-maintained
 * source of truth that can disagree with the timestamps sitting next to it.
 */
export const correctAttendanceSchema = z
  .object({
    checkInAt: z.string().datetime({ offset: true }).nullable().optional(),
    checkOutAt: z.string().datetime({ offset: true }).nullable().optional(),
    note: z.string().trim().max(255).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to correct',
  });

export type ListAttendanceQuery = z.infer<typeof listAttendanceQuery>;
export type AttendanceSummaryQuery = z.infer<typeof attendanceSummaryQuery>;
export type CorrectAttendanceInput = z.infer<typeof correctAttendanceSchema>;
