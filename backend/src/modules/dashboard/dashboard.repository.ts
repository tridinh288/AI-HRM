import { sql } from 'drizzle-orm';

import { db } from '../../db/client.js';

/**
 * Dashboard aggregations, written as raw SQL.
 *
 * This is a deliberate departure from the query builder used everywhere else,
 * and the reason is worth being able to defend: these are reporting queries.
 * They use `FILTER (WHERE ...)`, `GENERATE_SERIES`, window functions and
 * `DATE_TRUNC` — features an ORM either cannot express or expresses so
 * awkwardly that the resulting code is harder to read *and* harder to reason
 * about than the SQL it generates.
 *
 * The trade-off accepted here: no compile-time column checking, so every query
 * below is covered by an integration test against a real database. In exchange,
 * each of these is a single round trip that PostgreSQL can plan properly, rather
 * than several queries stitched together in JavaScript.
 *
 * Every value is still passed as a bound parameter through the `sql` template —
 * nothing is string-concatenated, so these are no more injectable than the
 * builder queries.
 */

export interface DashboardOverview {
  totalEmployees: number;
  activeEmployees: number;
  newHiresThisMonth: number;
  departmentCount: number;
  presentToday: number;
  lateToday: number;
  onLeaveToday: number;
  notCheckedInToday: number;
  pendingLeaveRequests: number;
  openAttendanceRecords: number;
}

export async function getOverview(today: string): Promise<DashboardOverview> {
  /**
   * One statement instead of ten.
   *
   * Each CTE answers one question, and the final SELECT stitches them together.
   * Ten separate round trips would each cost a network hop and a query plan;
   * this costs one of each, and the numbers are all read from the same snapshot
   * so they cannot disagree with one another.
   */
  const result = await db.execute(sql`
    with headcount as (
      select
        count(*)::int as total_employees,
        count(*) filter (where employment_status <> 'TERMINATED')::int as active_employees,
        count(*) filter (
          where date_trunc('month', hire_date) = date_trunc('month', ${today}::date)
        )::int as new_hires_this_month
      from employees
    ),
    departments_active as (
      select count(*)::int as department_count from departments where is_active
    ),
    today_attendance as (
      select
        count(*) filter (where status = 'PRESENT')::int as present_today,
        count(*) filter (where status = 'LATE')::int as late_today,
        count(*) filter (where check_out_at is null)::int as open_records
      from attendance_records
      where work_date = ${today}::date
    ),
    today_leave as (
      select count(distinct lr.employee_id)::int as on_leave_today
      from leave_requests lr
      where lr.status = 'APPROVED'
        and ${today}::date between lr.start_date and lr.end_date
    ),
    pending as (
      select count(*)::int as pending_leave_requests
      from leave_requests where status = 'PENDING'
    )
    select
      h.total_employees,
      h.active_employees,
      h.new_hires_this_month,
      d.department_count,
      coalesce(a.present_today, 0) as present_today,
      coalesce(a.late_today, 0) as late_today,
      coalesce(l.on_leave_today, 0) as on_leave_today,
      -- Absence is derived, never stored: everyone active, minus those who have
      -- a record today, minus those on approved leave.
      greatest(
        h.active_employees
          - coalesce(a.present_today, 0)
          - coalesce(a.late_today, 0)
          - coalesce(l.on_leave_today, 0),
        0
      )::int as not_checked_in_today,
      p.pending_leave_requests,
      coalesce(a.open_records, 0) as open_attendance_records
    from headcount h
    cross join departments_active d
    cross join today_attendance a
    cross join today_leave l
    cross join pending p
  `);

  const row = result.rows[0] as Record<string, number> | undefined;

  return {
    totalEmployees: Number(row?.total_employees ?? 0),
    activeEmployees: Number(row?.active_employees ?? 0),
    newHiresThisMonth: Number(row?.new_hires_this_month ?? 0),
    departmentCount: Number(row?.department_count ?? 0),
    presentToday: Number(row?.present_today ?? 0),
    lateToday: Number(row?.late_today ?? 0),
    onLeaveToday: Number(row?.on_leave_today ?? 0),
    notCheckedInToday: Number(row?.not_checked_in_today ?? 0),
    pendingLeaveRequests: Number(row?.pending_leave_requests ?? 0),
    openAttendanceRecords: Number(row?.open_attendance_records ?? 0),
  };
}

export interface DepartmentHeadcount {
  departmentId: string | null;
  departmentName: string;
  employeeCount: number;
  averageTenureYears: number;
}

export async function getHeadcountByDepartment(): Promise<DepartmentHeadcount[]> {
  // LEFT JOIN from departments, so a department with nobody in it still appears
  // as a zero rather than vanishing from the chart.
  const result = await db.execute(sql`
    select
      d.id as department_id,
      d.name as department_name,
      count(e.id) filter (where e.employment_status <> 'TERMINATED')::int as employee_count,
      coalesce(
        round(
          avg(extract(epoch from (now() - e.hire_date)) / 31557600)
            filter (where e.employment_status <> 'TERMINATED'),
          1
        ),
        0
      )::float as average_tenure_years
    from departments d
    left join employees e on e.department_id = d.id
    where d.is_active
    group by d.id, d.name
    order by employee_count desc, d.name asc
  `);

  return result.rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      departmentId: r.department_id as string,
      departmentName: r.department_name as string,
      employeeCount: Number(r.employee_count),
      averageTenureYears: Number(r.average_tenure_years),
    };
  });
}

export interface AttendanceTrendPoint {
  workDate: string;
  present: number;
  late: number;
  totalRecords: number;
}

export async function getAttendanceTrend(
  from: string,
  to: string,
): Promise<AttendanceTrendPoint[]> {
  /**
   * `generate_series` produces every date in the range, so days with no records
   * come back as zeroes instead of being missing.
   *
   * That matters for a line chart: a gap between two points is drawn as a
   * straight line through the missing days, which reads as "nobody was late"
   * when the truth is "we have no data". Weekends are excluded because a zero on
   * Sunday is noise, not information.
   */
  const result = await db.execute(sql`
    select
      to_char(d.day, 'YYYY-MM-DD') as work_date,
      coalesce(count(a.id) filter (where a.status = 'PRESENT'), 0)::int as present,
      coalesce(count(a.id) filter (where a.status = 'LATE'), 0)::int as late,
      coalesce(count(a.id), 0)::int as total_records
    from generate_series(${from}::date, ${to}::date, interval '1 day') as d(day)
    left join attendance_records a on a.work_date = d.day
    where extract(isodow from d.day) < 6
    group by d.day
    order by d.day asc
  `);

  return result.rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      workDate: r.work_date as string,
      present: Number(r.present),
      late: Number(r.late),
      totalRecords: Number(r.total_records),
    };
  });
}

export interface LeaveStatistic {
  leaveTypeName: string;
  requestCount: number;
  approvedDays: number;
  pendingCount: number;
  rejectedCount: number;
}

export async function getLeaveStatistics(from: string, to: string): Promise<LeaveStatistic[]> {
  const result = await db.execute(sql`
    select
      lt.name as leave_type_name,
      count(lr.id)::int as request_count,
      coalesce(sum(lr.total_days) filter (where lr.status = 'APPROVED'), 0)::int as approved_days,
      count(lr.id) filter (where lr.status = 'PENDING')::int as pending_count,
      count(lr.id) filter (where lr.status = 'REJECTED')::int as rejected_count
    from leave_types lt
    left join leave_requests lr
      on lr.leave_type_id = lt.id
      and lr.start_date <= ${to}::date
      and lr.end_date >= ${from}::date
    where lt.is_active
    group by lt.id, lt.name
    order by request_count desc, lt.name asc
  `);

  return result.rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      leaveTypeName: r.leave_type_name as string,
      requestCount: Number(r.request_count),
      approvedDays: Number(r.approved_days),
      pendingCount: Number(r.pending_count),
      rejectedCount: Number(r.rejected_count),
    };
  });
}

export interface LateEmployee {
  employeeId: string;
  employeeCode: string;
  fullName: string;
  departmentName: string | null;
  lateDays: number;
  totalLateMinutes: number;
}

export async function getLateEmployees(
  from: string,
  to: string,
  limit = 10,
): Promise<LateEmployee[]> {
  const result = await db.execute(sql`
    select
      e.id as employee_id,
      e.employee_code,
      e.first_name || ' ' || e.last_name as full_name,
      d.name as department_name,
      count(*)::int as late_days,
      sum(a.late_minutes)::int as total_late_minutes
    from attendance_records a
    join employees e on e.id = a.employee_id
    left join departments d on d.id = e.department_id
    where a.status = 'LATE'
      and a.work_date between ${from}::date and ${to}::date
    group by e.id, e.employee_code, full_name, d.name
    order by late_days desc, total_late_minutes desc
    limit ${limit}
  `);

  return result.rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      employeeId: r.employee_id as string,
      employeeCode: r.employee_code as string,
      fullName: r.full_name as string,
      departmentName: (r.department_name as string) ?? null,
      lateDays: Number(r.late_days),
      totalLateMinutes: Number(r.total_late_minutes),
    };
  });
}

export interface GrowthPoint {
  month: string;
  hires: number;
  leavers: number;
  headcount: number;
}

export async function getEmployeeGrowth(months = 12): Promise<GrowthPoint[]> {
  /**
   * Headcount over time.
   *
   * The running total is a window function — `SUM(...) OVER (ORDER BY month)` —
   * because headcount at the end of March is every hire ever, minus every
   * departure ever, up to that point. Computing that in JavaScript would mean
   * fetching all hires and all departures and folding them; the database does it
   * in the same pass that groups them.
   */
  const result = await db.execute(sql`
    with month_series as (
      select generate_series(
        date_trunc('month', now()) - make_interval(months => ${months - 1}),
        date_trunc('month', now()),
        interval '1 month'
      ) as month
    ),
    hires as (
      select date_trunc('month', hire_date) as month, count(*)::int as hires
      from employees group by 1
    ),
    leavers as (
      select date_trunc('month', terminated_at) as month, count(*)::int as leavers
      from employees where terminated_at is not null group by 1
    ),
    -- Everyone already employed before the window starts; the running total has
    -- to begin from a real number rather than from zero.
    opening as (
      select
        count(*) filter (
          where hire_date < (select min(month) from month_series)
        )::int
        - count(*) filter (
          where terminated_at is not null
            and terminated_at < (select min(month) from month_series)
        )::int as headcount
      from employees
    )
    select
      to_char(m.month, 'YYYY-MM') as month,
      coalesce(h.hires, 0) as hires,
      coalesce(l.leavers, 0) as leavers,
      (
        (select headcount from opening)
        + sum(coalesce(h.hires, 0) - coalesce(l.leavers, 0)) over (order by m.month)
      )::int as headcount
    from month_series m
    left join hires h on h.month = m.month
    left join leavers l on l.month = m.month
    order by m.month asc
  `);

  return result.rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      month: r.month as string,
      hires: Number(r.hires),
      leavers: Number(r.leavers),
      headcount: Number(r.headcount),
    };
  });
}

export interface OrgAttendanceStats {
  totalRecords: number;
  presentDays: number;
  lateDays: number;
  totalLateMinutes: number;
  averageWorkMinutes: number;
  employeesWithLateDays: number;
  totalOvertimeMinutes: number;
}

/** Organisation-wide attendance figures for a date range. Used by the AI tools. */
export async function getOrgAttendanceStats(
  from: string,
  to: string,
): Promise<OrgAttendanceStats> {
  const result = await db.execute(sql`
    select
      count(*)::int as total_records,
      count(*) filter (where status = 'PRESENT')::int as present_days,
      count(*) filter (where status = 'LATE')::int as late_days,
      coalesce(sum(late_minutes), 0)::int as total_late_minutes,
      coalesce(round(avg(work_minutes) filter (where work_minutes > 0)), 0)::int as average_work_minutes,
      count(distinct employee_id) filter (where status = 'LATE')::int as employees_with_late_days,
      coalesce(sum(overtime_minutes), 0)::int as total_overtime_minutes
    from attendance_records
    where work_date between ${from}::date and ${to}::date
  `);

  const r = (result.rows[0] ?? {}) as Record<string, unknown>;

  return {
    totalRecords: Number(r.total_records ?? 0),
    presentDays: Number(r.present_days ?? 0),
    lateDays: Number(r.late_days ?? 0),
    totalLateMinutes: Number(r.total_late_minutes ?? 0),
    averageWorkMinutes: Number(r.average_work_minutes ?? 0),
    employeesWithLateDays: Number(r.employees_with_late_days ?? 0),
    totalOvertimeMinutes: Number(r.total_overtime_minutes ?? 0),
  };
}
