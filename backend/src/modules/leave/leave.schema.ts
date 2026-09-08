import { z } from 'zod';

import { leaveStatusEnum } from '../../db/schema.js';
import { isoDate, paginationQuery } from '../../middlewares/validate.js';

export const createLeaveRequestSchema = z
  .object({
    leaveTypeId: z.string().uuid(),
    startDate: isoDate,
    endDate: isoDate,
    reason: z.string().trim().min(5, 'Give a reason of at least 5 characters').max(500),
  })
  // The cheapest possible rejection of a reversed range: no database, no service,
  // no transaction. The same rule is also a CHECK constraint, because validation
  // at the edge protects against bad requests while the constraint protects
  // against bad code.
  .refine((value) => value.endDate >= value.startDate, {
    path: ['endDate'],
    message: 'The end date must not be before the start date',
  });

export const rejectLeaveRequestSchema = z.object({
  // Required, not optional: "rejected" with no explanation is the kind of thing
  // that generates a conversation with HR anyway, so the system asks for it up
  // front.
  decisionNote: z.string().trim().min(5, 'Give a reason of at least 5 characters').max(500),
});

export const approveLeaveRequestSchema = z.object({
  decisionNote: z.string().trim().max(500).optional(),
});

export const listLeaveRequestsQuery = paginationQuery.extend({
  employeeId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  status: z.enum(leaveStatusEnum.enumValues).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export const leaveBalanceQuery = z.object({
  employeeId: z.string().uuid().optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

export type CreateLeaveRequestInput = z.infer<typeof createLeaveRequestSchema>;
export type RejectLeaveRequestInput = z.infer<typeof rejectLeaveRequestSchema>;
export type ApproveLeaveRequestInput = z.infer<typeof approveLeaveRequestSchema>;
export type ListLeaveRequestsQuery = z.infer<typeof listLeaveRequestsQuery>;
export type LeaveBalanceQuery = z.infer<typeof leaveBalanceQuery>;
