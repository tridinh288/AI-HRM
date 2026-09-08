import { companyPolicy } from '../../config/env.js';
import { addDays, companyToday } from '../../shared/calendar.js';
import * as repository from './dashboard.repository.js';

/**
 * The dashboard is HR/ADMIN only, enforced by route middleware — every figure
 * here is organisation-wide, so there is no per-row scoping to apply and no
 * "my own data" variant. An employee's personal figures come from
 * `/attendance/summary` and `/leave/balances` instead.
 */

export async function getOverview() {
  const today = companyToday(companyPolicy.timezone);
  return repository.getOverview(today);
}

export async function getCharts(days = 30) {
  const today = companyToday(companyPolicy.timezone);
  const from = addDays(today, -days);
  const yearStart = `${today.slice(0, 4)}-01-01`;

  // Four independent queries, issued concurrently rather than one after another.
  // They do not depend on each other, so waiting for each in turn would make the
  // endpoint as slow as their sum instead of as slow as the slowest.
  const [headcountByDepartment, attendanceTrend, leaveStatistics, employeeGrowth] =
    await Promise.all([
      repository.getHeadcountByDepartment(),
      repository.getAttendanceTrend(from, today),
      repository.getLeaveStatistics(yearStart, today),
      repository.getEmployeeGrowth(12),
    ]);

  return {
    range: { from, to: today },
    headcountByDepartment,
    attendanceTrend,
    leaveStatistics,
    employeeGrowth,
  };
}

export async function getLateEmployees(days = 30, limit = 10) {
  const today = companyToday(companyPolicy.timezone);
  return {
    range: { from: addDays(today, -days), to: today },
    items: await repository.getLateEmployees(addDays(today, -days), today, limit),
  };
}
