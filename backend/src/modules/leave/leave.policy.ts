import { calendarDaysBetween, countWorkingDays, isWeekend } from '../../shared/calendar.js';

/**
 * Leave business rules that depend only on their inputs.
 *
 * The split between this file and `leave.service.ts` is the one worth being able
 * to explain: a rule belongs here if it can be decided from the request itself
 * (dates, policy, today's date), and in the service if it needs the database
 * (does this overlap an existing request? is there balance left?). Rules that
 * need the database also need a transaction, because between reading and writing
 * the answer can change.
 */

export interface LeavePolicy {
  /** Requests may not start more than this many days in the past. */
  maxBackdateDays: number;
  /** Guards against a typo turning into a five-year leave request. */
  maxRequestDays: number;
  /** Requests must be submitted at least this many days before they start. */
  minNoticeDays: number;
}

export const defaultLeavePolicy: LeavePolicy = {
  // Zero notice and no backdating would be unrealistic in the other direction —
  // people are genuinely off sick and file the request afterwards. Allowing a
  // short backdating window is the honest model of how leave actually works.
  maxBackdateDays: 7,
  maxRequestDays: 30,
  minNoticeDays: 0,
};

export type LeaveValidationCode =
  | 'END_BEFORE_START'
  | 'TOO_FAR_IN_PAST'
  | 'TOO_LONG'
  | 'WEEKEND_ONLY'
  | 'INSUFFICIENT_NOTICE';

export interface LeaveValidationIssue {
  code: LeaveValidationCode;
  message: string;
}

export interface LeaveRequestDates {
  startDate: string;
  endDate: string;
}

/**
 * Validates the shape of a leave request against the calendar and the policy.
 *
 * Returns *all* the problems rather than throwing on the first one, so the form
 * can show everything that is wrong at once instead of making the user fix one
 * issue per submission.
 */
export function validateLeaveDates(
  dates: LeaveRequestDates,
  today: string,
  policy: LeavePolicy = defaultLeavePolicy,
): LeaveValidationIssue[] {
  const issues: LeaveValidationIssue[] = [];
  const { startDate, endDate } = dates;

  // ISO dates compare correctly as strings — "2026-03-09" < "2026-03-10" — which
  // is precisely why the columns are stored in that format.
  if (endDate < startDate) {
    issues.push({
      code: 'END_BEFORE_START',
      message: 'The end date must not be before the start date',
    });
    // Every other check below is meaningless on a reversed range.
    return issues;
  }

  const daysInPast = calendarDaysBetween(startDate, today) - 1;
  if (daysInPast > policy.maxBackdateDays) {
    issues.push({
      code: 'TOO_FAR_IN_PAST',
      message: `Leave cannot start more than ${policy.maxBackdateDays} days in the past`,
    });
  }

  if (calendarDaysBetween(startDate, endDate) > policy.maxRequestDays) {
    issues.push({
      code: 'TOO_LONG',
      message: `A single request cannot exceed ${policy.maxRequestDays} days`,
    });
  }

  if (countWorkingDays(startDate, endDate) === 0) {
    issues.push({
      code: 'WEEKEND_ONLY',
      message: 'This range contains no working days',
    });
  }

  if (policy.minNoticeDays > 0 && startDate > today) {
    const notice = calendarDaysBetween(today, startDate) - 1;
    if (notice < policy.minNoticeDays) {
      issues.push({
        code: 'INSUFFICIENT_NOTICE',
        message: `Requests must be submitted at least ${policy.minNoticeDays} days in advance`,
      });
    }
  }

  return issues;
}

/**
 * How many days a request costs against the balance.
 *
 * Weekends are free: a Friday-to-Monday request spans four calendar days but
 * consumes two days of leave, because nobody was scheduled to work on the other
 * two. Charging calendar days would quietly overcharge every request that
 * crosses a weekend.
 */
export function calculateLeaveDays(startDate: string, endDate: string): number {
  return countWorkingDays(startDate, endDate);
}

export interface BalanceCheck {
  entitledDays: number;
  usedDays: number;
  requestedDays: number;
}

export interface BalanceResult {
  sufficient: boolean;
  remainingDays: number;
  shortfallDays: number;
}

export function checkBalance(input: BalanceCheck): BalanceResult {
  const remainingDays = input.entitledDays - input.usedDays;
  const shortfallDays = Math.max(0, input.requestedDays - remainingDays);
  return {
    sufficient: shortfallDays === 0,
    remainingDays,
    shortfallDays,
  };
}

/**
 * The allowed transitions of a leave request.
 *
 * Encoding the state machine as data rather than as a chain of `if` statements
 * means "can this go from X to Y" has exactly one answer, and adding a state is
 * a change in one place. APPROVED, REJECTED and CANCELLED are terminal: a
 * request that has been decided stays decided.
 */
export const LEAVE_TRANSITIONS = {
  PENDING: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: [],
  REJECTED: [],
  CANCELLED: [],
} as const satisfies Record<string, readonly string[]>;

export function canTransition(from: keyof typeof LEAVE_TRANSITIONS, to: string): boolean {
  return (LEAVE_TRANSITIONS[from] as readonly string[]).includes(to);
}

export { countWorkingDays, isWeekend };
