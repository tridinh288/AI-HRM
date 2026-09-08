import dayjs from 'dayjs';
import timezonePlugin from 'dayjs/plugin/timezone.js';
import utcPlugin from 'dayjs/plugin/utc.js';

dayjs.extend(utcPlugin);
dayjs.extend(timezonePlugin);

/**
 * Calendar and time-of-day helpers shared by attendance and leave.
 *
 * They live here rather than inside one module because both need them and
 * neither owns them: "how many working days are in this range" is the same
 * question whether you are counting a leave request or an attendance report, and
 * two implementations of it would eventually disagree by a day.
 *
 * Everything here is pure — same inputs, same output, no clock, no I/O.
 */

export const MINUTES_PER_DAY = 24 * 60;

/** "08:30" → 510. Throws on malformed input rather than returning NaN. */
export function parseTimeToMinutes(time: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) throw new Error(`Invalid time of day: ${time}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/** 510 → "08:30". */
export function formatMinutes(minutes: number): string {
  const normalised = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hours = Math.floor(normalised / 60);
  const mins = normalised % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

/**
 * Which calendar day an instant belongs to, in company-local time.
 *
 * This is the function that prevents the classic timezone bug: a check-in at
 * 06:30 local in Ho Chi Minh City is 23:30 UTC on the *previous* day. Deriving
 * the work date from the UTC timestamp would file it under the wrong day, and
 * the unique (employee, work_date) index would then accept a second check-in
 * the same morning.
 */
export function toCompanyDate(instant: Date, timezone: string): string {
  return dayjs(instant).tz(timezone).format('YYYY-MM-DD');
}

/** Minutes since local midnight, in company-local time. */
export function minutesOfDay(instant: Date, timezone: string): number {
  const local = dayjs(instant).tz(timezone);
  return local.hour() * 60 + local.minute();
}

/** Today, in company-local time. */
export function companyToday(timezone: string, now: Date = new Date()): string {
  return toCompanyDate(now, timezone);
}

/** Saturday or Sunday. */
export function isWeekend(date: string): boolean {
  const day = dayjs(date).day();
  return day === 0 || day === 6;
}

/**
 * Working days in an inclusive range, excluding weekends.
 *
 * Public holidays are *not* handled — this system has no holiday calendar.
 * That limitation is documented in the README rather than papered over, because
 * silently counting Tết as working days would make every leave balance wrong.
 */
export function countWorkingDays(startDate: string, endDate: string): number {
  const start = dayjs(startDate);
  const end = dayjs(endDate);

  if (!start.isValid() || !end.isValid() || end.isBefore(start)) return 0;

  let count = 0;
  let cursor = start;

  while (!cursor.isAfter(end, 'day')) {
    if (!isWeekend(cursor.format('YYYY-MM-DD'))) count += 1;
    cursor = cursor.add(1, 'day');
  }

  return count;
}

/** Inclusive calendar-day span. */
export function calendarDaysBetween(startDate: string, endDate: string): number {
  return dayjs(endDate).diff(dayjs(startDate), 'day') + 1;
}

/** Do two inclusive date ranges share at least one day? */
export function rangesOverlap(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): boolean {
  return aStart <= bEnd && aEnd >= bStart;
}

/** First and last day of a month, as "YYYY-MM-DD". */
export function monthBounds(year: number, month: number): { from: string; to: string } {
  const start = dayjs(`${year}-${String(month).padStart(2, '0')}-01`);
  return { from: start.format('YYYY-MM-DD'), to: start.endOf('month').format('YYYY-MM-DD') };
}

export function addDays(date: string, days: number): string {
  return dayjs(date).add(days, 'day').format('YYYY-MM-DD');
}

export function isValidDate(date: string): boolean {
  return dayjs(date, 'YYYY-MM-DD').isValid();
}
