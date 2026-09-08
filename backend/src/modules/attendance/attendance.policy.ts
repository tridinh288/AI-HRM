import {
  MINUTES_PER_DAY,
  minutesOfDay,
  parseTimeToMinutes,
  toCompanyDate,
} from '../../shared/calendar.js';

/**
 * Attendance business rules, as pure functions.
 *
 * Nothing here touches the database, Express, or the clock — every input is a
 * parameter, including "now". That is deliberate: these are the rules an
 * interviewer will ask about ("how do you decide someone is late?"), and rules
 * that depend on hidden state cannot be tested in a dozen cases in a
 * millisecond. All the I/O lives in attendance.service.ts.
 *
 * The policy object comes from configuration (config/env.ts), so changing office
 * hours is an environment variable rather than a code change — and, crucially,
 * the rule exists in exactly one place instead of being re-implemented in the
 * check-in handler, the report query, and the dashboard.
 */

export interface AttendancePolicy {
  /** "08:00" */
  workStart: string;
  /** "17:30" */
  workEnd: string;
  /** Arrivals within this many minutes of workStart are not counted late. */
  lateGraceMinutes: number;
  /** Unpaid break deducted from a full day. */
  breakMinutes: number;
  /** IANA zone, e.g. "Asia/Ho_Chi_Minh". */
  timezone: string;
}

// Re-exported so the attendance rules and the calendar helpers they are built on
// can be imported from one place by callers and tests.
export {
  calendarDaysBetween,
  companyToday,
  countWorkingDays,
  formatMinutes,
  isWeekend,
  MINUTES_PER_DAY,
  minutesOfDay,
  parseTimeToMinutes,
  toCompanyDate,
} from '../../shared/calendar.js';

export interface CheckInEvaluation {
  workDate: string;
  status: 'PRESENT' | 'LATE';
  lateMinutes: number;
}

/**
 * Late is measured from the official start time, not from the end of the grace
 * period.
 *
 * With workStart 08:00 and a 5-minute grace: arriving at 08:04 is PRESENT with 0
 * minutes late; arriving at 08:15 is LATE by 15 minutes, not by 10. The grace
 * period decides *whether* lateness counts, not *how much* — otherwise the first
 * five minutes of every late arrival quietly disappear from the monthly report.
 */
export function evaluateCheckIn(instant: Date, policy: AttendancePolicy): CheckInEvaluation {
  const workDate = toCompanyDate(instant, policy.timezone);
  const arrival = minutesOfDay(instant, policy.timezone);
  const expectedStart = parseTimeToMinutes(policy.workStart);

  const minutesAfterStart = arrival - expectedStart;

  if (minutesAfterStart <= policy.lateGraceMinutes) {
    return { workDate, status: 'PRESENT', lateMinutes: 0 };
  }

  return { workDate, status: 'LATE', lateMinutes: minutesAfterStart };
}

export interface CheckOutEvaluation {
  workMinutes: number;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
}

/**
 * Worked minutes, early departure, and overtime.
 *
 * `workMinutes` is the real elapsed time between the two timestamps, minus the
 * unpaid break — but only when the day was long enough to have contained one.
 * Deducting an hour from a 20-minute visit to the office would produce negative
 * worked time, which the `attendance_minutes_non_negative` CHECK constraint
 * rejects, so this rule has to be right rather than "usually right".
 *
 * Early leave and overtime are measured against the local wall clock, so they
 * come from the time of day rather than from the elapsed span.
 */
export function evaluateCheckOut(
  checkInAt: Date,
  checkOutAt: Date,
  policy: AttendancePolicy,
): CheckOutEvaluation {
  const elapsedMinutes = Math.max(
    0,
    Math.floor((checkOutAt.getTime() - checkInAt.getTime()) / 60_000),
  );

  const workMinutes =
    elapsedMinutes > policy.breakMinutes ? elapsedMinutes - policy.breakMinutes : elapsedMinutes;

  const expectedEnd = parseTimeToMinutes(policy.workEnd);
  let departure = minutesOfDay(checkOutAt, policy.timezone);

  // A checkout after local midnight belongs to the previous working day. Without
  // this, 00:30 reads as 30 minutes past midnight and looks like leaving 17
  // hours early instead of working 7 hours of overtime.
  if (toCompanyDate(checkOutAt, policy.timezone) !== toCompanyDate(checkInAt, policy.timezone)) {
    departure += MINUTES_PER_DAY;
  }

  const difference = departure - expectedEnd;

  return {
    workMinutes,
    earlyLeaveMinutes: difference < 0 ? -difference : 0,
    overtimeMinutes: difference > 0 ? difference : 0,
  };
}
