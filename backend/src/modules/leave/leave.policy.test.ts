import { describe, expect, it } from 'vitest';

import {
  calculateLeaveDays,
  canTransition,
  checkBalance,
  defaultLeavePolicy,
  validateLeaveDates,
} from './leave.policy.js';

/**
 * Unit tests for the leave rules that need no database.
 *
 * "2026-03-16" is a Monday and "2026-03-20" a Friday, so the weekend arithmetic
 * below is easy to check by hand.
 */

const today = '2026-03-16';

describe('validateLeaveDates', () => {
  it('accepts a normal working-week request', () => {
    expect(validateLeaveDates({ startDate: '2026-03-18', endDate: '2026-03-20' }, today)).toEqual(
      [],
    );
  });

  it('rejects a reversed range and stops checking further', () => {
    const issues = validateLeaveDates(
      { startDate: '2026-03-20', endDate: '2026-03-18' },
      today,
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('END_BEFORE_START');
  });

  it('allows a short backdated request, because sick leave is filed afterwards', () => {
    expect(
      validateLeaveDates({ startDate: '2026-03-13', endDate: '2026-03-13' }, today),
    ).toEqual([]);
  });

  it('rejects a request backdated beyond the policy window', () => {
    const issues = validateLeaveDates(
      { startDate: '2026-02-02', endDate: '2026-02-03' },
      today,
    );

    expect(issues.map((issue) => issue.code)).toContain('TOO_FAR_IN_PAST');
  });

  it('rejects a request longer than the maximum', () => {
    const issues = validateLeaveDates(
      { startDate: '2026-03-16', endDate: '2026-06-16' },
      today,
    );

    expect(issues.map((issue) => issue.code)).toContain('TOO_LONG');
  });

  it('rejects a request that covers only a weekend', () => {
    // 21–22 March 2026 is a Saturday and Sunday: no working days, so nothing to
    // deduct and nothing to approve.
    const issues = validateLeaveDates(
      { startDate: '2026-03-21', endDate: '2026-03-22' },
      today,
    );

    expect(issues.map((issue) => issue.code)).toContain('WEEKEND_ONLY');
  });

  it('reports every problem at once rather than one per submission', () => {
    const issues = validateLeaveDates(
      { startDate: '2025-01-01', endDate: '2025-06-01' },
      today,
    );

    expect(issues.length).toBeGreaterThan(1);
    expect(issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['TOO_FAR_IN_PAST', 'TOO_LONG']),
    );
  });

  it('honours a minimum-notice policy when one is configured', () => {
    const issues = validateLeaveDates(
      { startDate: '2026-03-17', endDate: '2026-03-17' },
      today,
      { ...defaultLeavePolicy, minNoticeDays: 3 },
    );

    expect(issues.map((issue) => issue.code)).toContain('INSUFFICIENT_NOTICE');
  });
});

describe('calculateLeaveDays', () => {
  it('counts a full working week as five days', () => {
    expect(calculateLeaveDays('2026-03-16', '2026-03-20')).toBe(5);
  });

  it('does not charge for the weekend in a Friday-to-Monday request', () => {
    // Four calendar days, two working days. Charging calendar days would
    // overcharge every request that crosses a weekend.
    expect(calculateLeaveDays('2026-03-20', '2026-03-23')).toBe(2);
  });

  it('counts a single day as one', () => {
    expect(calculateLeaveDays('2026-03-16', '2026-03-16')).toBe(1);
  });
});

describe('checkBalance', () => {
  it('permits a request that fits exactly', () => {
    expect(checkBalance({ entitledDays: 12, usedDays: 7, requestedDays: 5 })).toEqual({
      sufficient: true,
      remainingDays: 5,
      shortfallDays: 0,
    });
  });

  it('reports the shortfall when the request is too large', () => {
    expect(checkBalance({ entitledDays: 12, usedDays: 10, requestedDays: 5 })).toEqual({
      sufficient: false,
      remainingDays: 2,
      shortfallDays: 3,
    });
  });

  it('handles an exhausted balance', () => {
    const result = checkBalance({ entitledDays: 12, usedDays: 12, requestedDays: 1 });
    expect(result.sufficient).toBe(false);
    expect(result.remainingDays).toBe(0);
  });
});

describe('leave state machine', () => {
  it('allows the three transitions out of PENDING', () => {
    expect(canTransition('PENDING', 'APPROVED')).toBe(true);
    expect(canTransition('PENDING', 'REJECTED')).toBe(true);
    expect(canTransition('PENDING', 'CANCELLED')).toBe(true);
  });

  it('treats decided states as terminal', () => {
    expect(canTransition('APPROVED', 'REJECTED')).toBe(false);
    expect(canTransition('REJECTED', 'APPROVED')).toBe(false);
    expect(canTransition('CANCELLED', 'PENDING')).toBe(false);
    expect(canTransition('APPROVED', 'CANCELLED')).toBe(false);
  });
});
