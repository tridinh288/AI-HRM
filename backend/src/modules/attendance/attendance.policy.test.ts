import { describe, expect, it } from 'vitest';

import {
  calendarDaysBetween,
  countWorkingDays,
  evaluateCheckIn,
  evaluateCheckOut,
  formatMinutes,
  isWeekend,
  minutesOfDay,
  parseTimeToMinutes,
  toCompanyDate,
  type AttendancePolicy,
} from './attendance.policy.js';

/**
 * Unit tests for the attendance rules.
 *
 * These need no database and no server, so the whole file runs in milliseconds —
 * which is why the rules were extracted into pure functions in the first place.
 * Every timestamp below is written in UTC with its Ho Chi Minh City (UTC+7)
 * local time in a comment, because that offset is exactly what these rules have
 * to get right.
 */

const policy: AttendancePolicy = {
  workStart: '08:00',
  workEnd: '17:30',
  lateGraceMinutes: 5,
  breakMinutes: 60,
  timezone: 'Asia/Ho_Chi_Minh',
};

/** Helper: build a UTC instant from an ISO string, for readability below. */
const at = (iso: string) => new Date(iso);

describe('parseTimeToMinutes / formatMinutes', () => {
  it('converts a time of day to minutes since midnight', () => {
    expect(parseTimeToMinutes('00:00')).toBe(0);
    expect(parseTimeToMinutes('08:00')).toBe(480);
    expect(parseTimeToMinutes('17:30')).toBe(1050);
    expect(parseTimeToMinutes('23:59')).toBe(1439);
  });

  it('rejects malformed input instead of returning NaN', () => {
    expect(() => parseTimeToMinutes('8:00')).toThrow();
    expect(() => parseTimeToMinutes('24:00')).toThrow();
    expect(() => parseTimeToMinutes('08:60')).toThrow();
    expect(() => parseTimeToMinutes('')).toThrow();
  });

  it('round-trips', () => {
    expect(formatMinutes(parseTimeToMinutes('09:45'))).toBe('09:45');
  });
});

describe('toCompanyDate', () => {
  it('uses company-local time, not UTC, to decide the calendar day', () => {
    // 23:30 UTC on the 15th is 06:30 on the 16th in Ho Chi Minh City.
    expect(toCompanyDate(at('2026-03-15T23:30:00Z'), policy.timezone)).toBe('2026-03-16');
    // 17:30 UTC on the 16th is 00:30 on the 17th locally.
    expect(toCompanyDate(at('2026-03-16T17:30:00Z'), policy.timezone)).toBe('2026-03-17');
  });

  it('reports local minutes since midnight', () => {
    expect(minutesOfDay(at('2026-03-16T01:15:00Z'), policy.timezone)).toBe(8 * 60 + 15);
  });
});

describe('evaluateCheckIn', () => {
  it('is PRESENT when arriving before the start of the day', () => {
    // 01:00Z → 08:00 local, exactly on time.
    const result = evaluateCheckIn(at('2026-03-16T01:00:00Z'), policy);
    expect(result).toEqual({ workDate: '2026-03-16', status: 'PRESENT', lateMinutes: 0 });
  });

  it('is PRESENT inside the grace period', () => {
    // 08:04 local — four minutes late, within the five-minute grace.
    const result = evaluateCheckIn(at('2026-03-16T01:04:00Z'), policy);
    expect(result.status).toBe('PRESENT');
    expect(result.lateMinutes).toBe(0);
  });

  it('is PRESENT at exactly the grace boundary', () => {
    // 08:05 local — the boundary is inclusive.
    expect(evaluateCheckIn(at('2026-03-16T01:05:00Z'), policy).status).toBe('PRESENT');
  });

  it('is LATE one minute past the grace period', () => {
    const result = evaluateCheckIn(at('2026-03-16T01:06:00Z'), policy);
    expect(result.status).toBe('LATE');
    // Measured from 08:00, not from the end of the grace window.
    expect(result.lateMinutes).toBe(6);
  });

  it('measures lateness from the official start time', () => {
    // 08:15 local is 15 minutes late, not 10.
    const result = evaluateCheckIn(at('2026-03-16T01:15:00Z'), policy);
    expect(result).toEqual({ workDate: '2026-03-16', status: 'LATE', lateMinutes: 15 });
  });

  it('files an early-morning check-in under the correct local day', () => {
    // 23:30Z on the 15th → 06:30 local on the 16th: early, and on the 16th.
    const result = evaluateCheckIn(at('2026-03-15T23:30:00Z'), policy);
    expect(result.workDate).toBe('2026-03-16');
    expect(result.status).toBe('PRESENT');
  });
});

describe('evaluateCheckOut', () => {
  it('deducts the unpaid break from a full day', () => {
    // 08:00 → 17:30 local: 9h30 elapsed, minus a 60-minute break.
    const result = evaluateCheckOut(
      at('2026-03-16T01:00:00Z'),
      at('2026-03-16T10:30:00Z'),
      policy,
    );
    expect(result.workMinutes).toBe(510);
    expect(result.earlyLeaveMinutes).toBe(0);
    expect(result.overtimeMinutes).toBe(0);
  });

  it('records early leave against the scheduled end of day', () => {
    // 08:00 → 17:00 local: half an hour early.
    const result = evaluateCheckOut(
      at('2026-03-16T01:00:00Z'),
      at('2026-03-16T10:00:00Z'),
      policy,
    );
    expect(result.earlyLeaveMinutes).toBe(30);
    expect(result.overtimeMinutes).toBe(0);
    expect(result.workMinutes).toBe(480);
  });

  it('records overtime past the scheduled end of day', () => {
    // 08:00 → 18:30 local: an hour of overtime.
    const result = evaluateCheckOut(
      at('2026-03-16T01:00:00Z'),
      at('2026-03-16T11:30:00Z'),
      policy,
    );
    expect(result.overtimeMinutes).toBe(60);
    expect(result.earlyLeaveMinutes).toBe(0);
  });

  it('handles a checkout after local midnight as overtime, not early leave', () => {
    // 17:00 local on the 16th → 00:30 local on the 17th.
    const result = evaluateCheckOut(
      at('2026-03-16T10:00:00Z'),
      at('2026-03-16T17:30:00Z'),
      policy,
    );
    expect(result.overtimeMinutes).toBe(7 * 60); // 17:30 → 00:30
    expect(result.earlyLeaveMinutes).toBe(0);
    expect(result.workMinutes).toBe(450 - 60);
  });

  it('never produces negative worked minutes for a very short visit', () => {
    // 20 minutes in the office is shorter than the break itself.
    const result = evaluateCheckOut(
      at('2026-03-16T01:00:00Z'),
      at('2026-03-16T01:20:00Z'),
      policy,
    );
    expect(result.workMinutes).toBe(20);
    expect(result.workMinutes).toBeGreaterThanOrEqual(0);
  });
});

describe('working day arithmetic', () => {
  it('identifies weekends', () => {
    expect(isWeekend('2026-03-14')).toBe(true); // Saturday
    expect(isWeekend('2026-03-15')).toBe(true); // Sunday
    expect(isWeekend('2026-03-16')).toBe(false); // Monday
  });

  it('counts a full working week as five days', () => {
    expect(countWorkingDays('2026-03-16', '2026-03-20')).toBe(5);
  });

  it('excludes the weekend from a span that crosses it', () => {
    // Friday to Monday is four calendar days but two working days.
    expect(calendarDaysBetween('2026-03-20', '2026-03-23')).toBe(4);
    expect(countWorkingDays('2026-03-20', '2026-03-23')).toBe(2);
  });

  it('counts a single weekday as one day', () => {
    expect(countWorkingDays('2026-03-16', '2026-03-16')).toBe(1);
  });

  it('counts a weekend-only request as zero working days', () => {
    expect(countWorkingDays('2026-03-14', '2026-03-15')).toBe(0);
  });

  it('returns zero when the range is reversed', () => {
    expect(countWorkingDays('2026-03-20', '2026-03-16')).toBe(0);
  });
});
