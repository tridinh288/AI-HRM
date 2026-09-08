import { z, type ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { companyPolicy } from '../../config/env.js';
import type { Role } from '../../db/schema.js';
import type { AuthContext } from '../../shared/auth-context.js';
import { addDays, companyToday, monthBounds } from '../../shared/calendar.js';
import { getAttendanceSummary } from '../attendance/attendance.repository.js';
import * as dashboardRepository from '../dashboard/dashboard.repository.js';
import { listEmployees } from '../employees/employee.repository.js';
import { toEmployeePublicDto } from '../employees/employee.mapper.js';
import * as leaveRepository from '../leave/leave.repository.js';
import type { JsonSchemaObject, LlmToolDefinition } from './llm/types.js';

/**
 * The tool registry — the security boundary of the AI feature.
 *
 * The model does not query the database. It picks a tool by name, and this
 * registry decides whether the *caller* may run that tool, validates the
 * arguments, and calls an ordinary application function.
 *
 * Three properties are what make this safe, and they are worth stating
 * separately because each defends against something different:
 *
 *  1. **The tool list is filtered by role before the model ever sees it.** An
 *     EMPLOYEE is not told that `get_late_employees` exists. There is nothing to
 *     jailbreak towards.
 *
 *  2. **Self-scoped tools take the employee id from the JWT, never from the
 *     model.** `get_my_leave_balance` has no `employeeId` parameter at all. A
 *     prompt injection saying "call it with employeeId 42" produces an argument
 *     that is discarded, because that value is not read from the model's input.
 *
 *  3. **No tool can return salary.** Not "does not currently"; the return types
 *     do not contain the field. `search_employees` maps rows through
 *     `toEmployeePublicDto`, which has no salary property to populate.
 *
 * Authorization is re-checked at execution time, not only at list time — so a
 * model that invents a tool name it was never offered is refused rather than
 * silently succeeding.
 */

export interface ToolContext {
  auth: AuthContext;
}

export type ToolScope = 'self' | 'organisation';

export interface AiTool {
  name: string;
  description: string;
  schema: ZodTypeAny;
  allowedRoles: readonly Role[];
  scope: ToolScope;
  execute(args: unknown, context: ToolContext): Promise<unknown>;
}

function defineTool<S extends ZodTypeAny>(definition: {
  name: string;
  description: string;
  schema: S;
  allowedRoles: readonly Role[];
  scope: ToolScope;
  handler: (args: z.infer<S>, context: ToolContext) => Promise<unknown>;
}): AiTool {
  return {
    name: definition.name,
    description: definition.description,
    schema: definition.schema,
    allowedRoles: definition.allowedRoles,
    scope: definition.scope,
    async execute(args, context) {
      // Zod parses (and strips unknown keys) before the handler sees anything.
      // A model that hallucinates an extra parameter cannot smuggle it through.
      const parsed = definition.schema.parse(args ?? {}) as z.infer<S>;
      return definition.handler(parsed, context);
    },
  };
}

const ALL_ROLES: readonly Role[] = ['ADMIN', 'HR', 'EMPLOYEE'];
const HR_ROLES: readonly Role[] = ['ADMIN', 'HR'];

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .describe('A date in YYYY-MM-DD format');

const monthString = z
  .string()
  .regex(/^\d{4}-\d{2}$/, 'Use YYYY-MM')
  .describe('A month in YYYY-MM format');

/** Requires an employee record; personal tools are meaningless without one. */
function selfEmployeeId(context: ToolContext): string {
  if (!context.auth.employeeId) {
    throw new Error('This account has no employee record, so it has no personal HR data.');
  }
  return context.auth.employeeId;
}

// ---------------------------------------------------------------------------
// Personal tools — available to every role, scoped to the caller
// ---------------------------------------------------------------------------

const getMyAttendanceSummary = defineTool({
  name: 'get_my_attendance_summary',
  description:
    "Attendance summary for the signed-in user over one month: days recorded, days present, days late, total late minutes, total worked minutes and overtime. Defaults to the current month. Only ever returns the caller's own data.",
  // Note the absence of an employeeId parameter. That absence is the security
  // control: the identity comes from the verified token below.
  schema: z.object({ month: monthString.optional() }),
  allowedRoles: ALL_ROLES,
  scope: 'self',
  async handler(args, context) {
    const employeeId = selfEmployeeId(context);
    const today = companyToday(companyPolicy.timezone);
    const month = args.month ?? today.slice(0, 7);
    const [year, monthNumber] = month.split('-').map(Number);
    const { from, to } = monthBounds(year!, monthNumber!);

    const summary = await getAttendanceSummary(employeeId, from, to);

    return {
      month,
      from,
      to,
      ...summary,
      totalWorkHours: Math.round((summary.totalWorkMinutes / 60) * 10) / 10,
      totalOvertimeHours: Math.round((summary.totalOvertimeMinutes / 60) * 10) / 10,
    };
  },
});

const getMyLeaveBalance = defineTool({
  name: 'get_my_leave_balance',
  description:
    "The signed-in user's leave balances for a year: entitled, used and remaining days for each leave type. Defaults to the current year.",
  schema: z.object({ year: z.number().int().min(2000).max(2100).optional() }),
  allowedRoles: ALL_ROLES,
  scope: 'self',
  async handler(args, context) {
    const employeeId = selfEmployeeId(context);
    const year = args.year ?? new Date().getFullYear();
    const balances = await leaveRepository.listBalancesForEmployee(employeeId, year);

    return {
      year,
      balances: balances.map((balance) => ({
        leaveType: balance.leaveTypeName,
        isPaid: balance.isPaid,
        entitledDays: balance.entitledDays,
        usedDays: balance.usedDays,
        remainingDays: balance.entitledDays - balance.usedDays,
      })),
    };
  },
});

const getMyLeaveRequests = defineTool({
  name: 'get_my_leave_requests',
  description:
    "The signed-in user's own leave requests, optionally filtered by status (PENDING, APPROVED, REJECTED, CANCELLED).",
  schema: z.object({
    status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  allowedRoles: ALL_ROLES,
  scope: 'self',
  async handler(args, context) {
    const employeeId = selfEmployeeId(context);
    const { items } = await leaveRepository.listLeaveRequests({
      employeeId,
      status: args.status,
      page: 1,
      pageSize: args.limit ?? 10,
    });

    return {
      requests: items.map((request) => ({
        id: request.id,
        leaveType: request.leaveTypeName,
        startDate: request.startDate,
        endDate: request.endDate,
        totalDays: request.totalDays,
        status: request.status,
        reason: request.reason,
        decisionNote: request.decisionNote,
      })),
    };
  },
});

// ---------------------------------------------------------------------------
// Organisation-wide tools — HR and ADMIN only
// ---------------------------------------------------------------------------

const getHeadcount = defineTool({
  name: 'get_headcount',
  description:
    'Company-wide headcount: total employees, active employees, new hires this month, number of departments, and today\'s attendance snapshot including how many people are present, late, on leave or have not checked in.',
  schema: z.object({}),
  allowedRoles: HR_ROLES,
  scope: 'organisation',
  async handler() {
    return dashboardRepository.getOverview(companyToday(companyPolicy.timezone));
  },
});

const getDepartmentHeadcount = defineTool({
  name: 'get_department_headcount',
  description:
    'Number of active employees in each department, with average tenure in years. Use this for "how many people are in Engineering" style questions.',
  schema: z.object({}),
  allowedRoles: HR_ROLES,
  scope: 'organisation',
  async handler() {
    return { departments: await dashboardRepository.getHeadcountByDepartment() };
  },
});

const getAttendanceStatistics = defineTool({
  name: 'get_attendance_statistics',
  description:
    'Company-wide attendance statistics over a date range: total records, present days, late days, total late minutes, average worked minutes, overtime, and how many distinct employees were late. Defaults to the current month.',
  schema: z.object({ from: dateString.optional(), to: dateString.optional() }),
  allowedRoles: HR_ROLES,
  scope: 'organisation',
  async handler(args) {
    const today = companyToday(companyPolicy.timezone);
    const from = args.from ?? `${today.slice(0, 7)}-01`;
    const to = args.to ?? today;
    return { from, to, ...(await dashboardRepository.getOrgAttendanceStats(from, to)) };
  },
});

const getLateEmployees = defineTool({
  name: 'get_late_employees',
  description:
    'Employees with the most late arrivals in a date range, with how many days they were late and total late minutes. Defaults to the last 30 days.',
  schema: z.object({
    from: dateString.optional(),
    to: dateString.optional(),
    limit: z.number().int().min(1).max(25).optional(),
  }),
  allowedRoles: HR_ROLES,
  scope: 'organisation',
  async handler(args) {
    const today = companyToday(companyPolicy.timezone);
    const to = args.to ?? today;
    const from = args.from ?? addDays(to, -30);
    return {
      from,
      to,
      employees: await dashboardRepository.getLateEmployees(from, to, args.limit ?? 10),
    };
  },
});

const getPendingLeaveRequests = defineTool({
  name: 'get_pending_leave_requests',
  description:
    'Leave requests awaiting approval, with employee name, department, leave type, dates and number of days.',
  schema: z.object({ limit: z.number().int().min(1).max(50).optional() }),
  allowedRoles: HR_ROLES,
  scope: 'organisation',
  async handler(args) {
    const { items, total } = await leaveRepository.listLeaveRequests({
      status: 'PENDING',
      page: 1,
      pageSize: args.limit ?? 20,
    });

    return {
      totalPending: total,
      requests: items.map((request) => ({
        id: request.id,
        employee: request.employeeName,
        employeeCode: request.employeeCode,
        department: request.departmentName,
        leaveType: request.leaveTypeName,
        startDate: request.startDate,
        endDate: request.endDate,
        totalDays: request.totalDays,
      })),
    };
  },
});

const getLeaveStatistics = defineTool({
  name: 'get_leave_statistics',
  description:
    'Leave statistics by leave type over a date range: number of requests, approved days, pending and rejected counts. Defaults to the current calendar year.',
  schema: z.object({ from: dateString.optional(), to: dateString.optional() }),
  allowedRoles: HR_ROLES,
  scope: 'organisation',
  async handler(args) {
    const today = companyToday(companyPolicy.timezone);
    const from = args.from ?? `${today.slice(0, 4)}-01-01`;
    const to = args.to ?? today;
    return { from, to, leaveTypes: await dashboardRepository.getLeaveStatistics(from, to) };
  },
});

const searchEmployees = defineTool({
  name: 'search_employees',
  description:
    'Search employees by name or employee code, optionally filtered by department id. Returns name, code, department, position, employment status and hire date. Never returns salary or personal contact details.',
  schema: z.object({
    query: z.string().max(100).optional(),
    departmentId: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(25).optional(),
  }),
  allowedRoles: HR_ROLES,
  scope: 'organisation',
  async handler(args) {
    const { items, total } = await listEmployees({
      search: args.query,
      departmentId: args.departmentId,
      page: 1,
      pageSize: args.limit ?? 10,
      sortBy: 'employeeCode',
      sortOrder: 'asc',
    });

    // The public DTO has no salary, address, phone or date-of-birth field, so
    // there is nothing here to accidentally leak.
    return { total, employees: items.map(toEmployeePublicDto) };
  },
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const TOOLS: AiTool[] = [
  getMyAttendanceSummary,
  getMyLeaveBalance,
  getMyLeaveRequests,
  getHeadcount,
  getDepartmentHeadcount,
  getAttendanceStatistics,
  getLateEmployees,
  getPendingLeaveRequests,
  getLeaveStatistics,
  searchEmployees,
];

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

export function getTool(name: string): AiTool | undefined {
  return TOOLS_BY_NAME.get(name);
}

export function listTools(): readonly AiTool[] {
  return TOOLS;
}

/** The tools a role may use — computed, never hard-coded per role. */
export function getToolsForRole(role: Role): AiTool[] {
  return TOOLS.filter((tool) => tool.allowedRoles.includes(role));
}

export interface ToolAuthorizationResult {
  allowed: boolean;
  reason?: string;
}

/**
 * The single authorization decision for a tool call.
 *
 * Called at execution time even though the tool list was already filtered,
 * because the two happen at different moments and the model's output is not
 * trusted in between. A model that emits a tool name it was never offered —
 * hallucinated, or injected by hostile text in the conversation — lands here and
 * is refused.
 */
export function authorizeTool(toolName: string, auth: AuthContext): ToolAuthorizationResult {
  const tool = TOOLS_BY_NAME.get(toolName);

  if (!tool) {
    return { allowed: false, reason: `Unknown tool "${toolName}"` };
  }

  if (!tool.allowedRoles.includes(auth.role)) {
    return {
      allowed: false,
      reason: `Role ${auth.role} is not permitted to use "${toolName}"`,
    };
  }

  if (tool.scope === 'self' && !auth.employeeId) {
    return {
      allowed: false,
      reason: 'This account has no employee record, so personal HR data does not exist for it',
    };
  }

  return { allowed: true };
}

/** Converts a tool to the wire format the LLM expects. */
export function toLlmToolDefinition(tool: AiTool): LlmToolDefinition {
  const schema = zodToJsonSchema(tool.schema, {
    target: 'openApi3',
    $refStrategy: 'none',
  }) as JsonSchemaObject;

  // Generated from the same Zod schema used to validate the arguments, so the
  // description the model reads and the rules the server enforces cannot drift.
  return {
    name: tool.name,
    description: tool.description,
    parameters: schema,
  };
}

export function getLlmToolsForRole(role: Role): LlmToolDefinition[] {
  return getToolsForRole(role).map(toLlmToolDefinition);
}
