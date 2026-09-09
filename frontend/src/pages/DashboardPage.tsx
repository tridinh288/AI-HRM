import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CalendarClock, Clock, TrendingUp, UserCheck, Users } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import {
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  StatCard,
  TableWrapper,
  Td,
  Th,
} from '../components/ui';
import { fetchData, getErrorMessage } from '../lib/api';
import { formatMinutes, formatMonth, formatNumber, todayIso } from '../lib/format';
import type { DashboardCharts, DashboardOverview, LateEmployee } from '../lib/types';

/**
 * Chart colours come from one palette, so a department is the same colour in
 * every chart and no two adjacent series are hard to tell apart.
 */
const PALETTE = ['#4f46e5', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6'];

const axisStyle = { fontSize: 12, fill: '#64748b' };

/**
 * Every figure on this page is a summary of a list that lives on another page.
 * The link in each card header goes to that list — with the filter the figure
 * was computed under where the destination page can take one, so "late today"
 * opens today's late arrivals rather than the attendance register at large.
 */
function DetailLink({ to, children }: { to: string; children: string }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700 hover:underline"
    >
      {children}
      <ArrowRight className="h-3.5 w-3.5" />
    </Link>
  );
}

export function DashboardPage() {
  const navigate = useNavigate();
  const today = todayIso();
  const overview = useQuery({
    queryKey: ['dashboard', 'overview'],
    queryFn: () => fetchData<DashboardOverview>('/dashboard/overview'),
  });

  const charts = useQuery({
    queryKey: ['dashboard', 'charts'],
    queryFn: () => fetchData<DashboardCharts>('/dashboard/charts', { days: 30 }),
  });

  const late = useQuery({
    queryKey: ['dashboard', 'late'],
    queryFn: () =>
      fetchData<{ range: { from: string; to: string }; items: LateEmployee[] }>(
        '/dashboard/late-employees',
        { days: 30, limit: 5 },
      ),
  });

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Company-wide headcount, attendance and leave at a glance"
      />

      {overview.isPending ? (
        <LoadingState />
      ) : overview.isError ? (
        <ErrorState message={getErrorMessage(overview.error)} onRetry={() => overview.refetch()} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Active employees"
            value={formatNumber(overview.data.activeEmployees)}
            hint={`${overview.data.totalEmployees} on record · ${overview.data.departmentCount} departments`}
            icon={<Users className="h-5 w-5" />}
            to="/employees?employmentStatus=ACTIVE"
          />
          <StatCard
            label="Present today"
            value={formatNumber(overview.data.presentToday)}
            hint={`${overview.data.notCheckedInToday} not checked in`}
            tone="success"
            icon={<UserCheck className="h-5 w-5" />}
            to={`/attendance?from=${today}&to=${today}&status=PRESENT`}
          />
          <StatCard
            label="Late today"
            value={formatNumber(overview.data.lateToday)}
            hint={`${overview.data.onLeaveToday} on approved leave`}
            tone={overview.data.lateToday > 0 ? 'warning' : 'neutral'}
            icon={<Clock className="h-5 w-5" />}
            to={`/attendance?from=${today}&to=${today}&status=LATE`}
          />
          <StatCard
            label="Pending leave"
            value={formatNumber(overview.data.pendingLeaveRequests)}
            hint={`${overview.data.newHiresThisMonth} new hires this month`}
            tone={overview.data.pendingLeaveRequests > 0 ? 'info' : 'neutral'}
            icon={<CalendarClock className="h-5 w-5" />}
            to="/leave"
          />
        </div>
      )}

      {charts.isPending ? (
        <LoadingState label="Loading charts…" />
      ) : charts.isError ? (
        <div className="mt-6">
          <ErrorState message={getErrorMessage(charts.error)} onRetry={() => charts.refetch()} />
        </div>
      ) : (
        <div className="mt-6 grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader
              title="Attendance, last 30 days"
              description="Weekdays only — weekends are excluded rather than drawn as zero"
              action={<DetailLink to="/attendance">Xem chấm công</DetailLink>}
            />
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={charts.data.attendanceTrend}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis
                    dataKey="workDate"
                    tick={axisStyle}
                    tickFormatter={(value: string) => value.slice(5)}
                    interval="preserveStartEnd"
                    minTickGap={24}
                  />
                  <YAxis tick={axisStyle} allowDecimals={false} width={32} />
                  <Tooltip
                    contentStyle={{ fontSize: 12, borderRadius: 8, borderColor: '#e2e8f0' }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line
                    type="monotone"
                    dataKey="present"
                    name="On time"
                    stroke={PALETTE[0]}
                    strokeWidth={2}
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="late"
                    name="Late"
                    stroke={PALETTE[3]}
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Headcount by department"
              description="Active employees only — click a bar for the people behind it"
              action={<DetailLink to="/departments">Xem tổ chức</DetailLink>}
            />
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={charts.data.headcountByDepartment} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                  <XAxis type="number" tick={axisStyle} allowDecimals={false} />
                  <YAxis
                    type="category"
                    dataKey="departmentName"
                    tick={axisStyle}
                    width={110}
                  />
                  <Tooltip
                    contentStyle={{ fontSize: 12, borderRadius: 8, borderColor: '#e2e8f0' }}
                    formatter={(value: number) => [value, 'Employees']}
                  />
                  {/* Recharts hands the clicked bar's data row back as `payload`;
                      the id it carries is exactly what the register filters by. */}
                  <Bar
                    dataKey="employeeCount"
                    radius={[0, 4, 4, 0]}
                    className="cursor-pointer"
                    onClick={(bar: { payload?: { departmentId?: string | null } }) => {
                      const departmentId = bar.payload?.departmentId;
                      navigate(departmentId ? `/employees?departmentId=${departmentId}` : '/employees');
                    }}
                  >
                    {charts.data.headcountByDepartment.map((entry, index) => (
                      <Cell key={entry.departmentName} fill={PALETTE[index % PALETTE.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Headcount over time"
              description="Running total: hires minus departures, month by month"
              action={<DetailLink to="/employees?sortBy=hireDate">Người mới nhất</DetailLink>}
            />
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={charts.data.employeeGrowth}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis dataKey="month" tick={axisStyle} tickFormatter={formatMonth} />
                  <YAxis tick={axisStyle} allowDecimals={false} width={32} />
                  <Tooltip
                    contentStyle={{ fontSize: 12, borderRadius: 8, borderColor: '#e2e8f0' }}
                    labelFormatter={formatMonth}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line
                    type="monotone"
                    dataKey="headcount"
                    name="Headcount"
                    stroke={PALETTE[2]}
                    strokeWidth={2}
                    dot={{ r: 2 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="hires"
                    name="Hires"
                    stroke={PALETTE[1]}
                    strokeWidth={1.5}
                    strokeDasharray="4 4"
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Leave this year"
              description="Requests and approved days by type"
              action={<DetailLink to="/leave">Xem đơn nghỉ</DetailLink>}
            />
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={charts.data.leaveStatistics}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis dataKey="leaveTypeName" tick={axisStyle} />
                  <YAxis tick={axisStyle} allowDecimals={false} width={32} />
                  <Tooltip
                    contentStyle={{ fontSize: 12, borderRadius: 8, borderColor: '#e2e8f0' }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="approvedDays" name="Approved days" fill={PALETTE[0]} radius={[4, 4, 0, 0]} />
                  <Bar dataKey="pendingCount" name="Pending" fill={PALETTE[3]} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </div>
      )}

      <div className="mt-6">
        <Card padded={false}>
          <div className="p-5 pb-0">
            <CardHeader
              title="Most late arrivals"
              description="Last 30 days"
              action={
                <span className="inline-flex items-center gap-3">
                  <span className="text-xs text-slate-400">
                    <TrendingUp className="mr-1 inline h-3.5 w-3.5" />
                    top 5
                  </span>
                  <DetailLink to="/attendance?status=LATE">Xem tất cả</DetailLink>
                </span>
              }
            />
          </div>

          {late.isPending ? (
            <LoadingState />
          ) : late.isError ? (
            <div className="p-5">
              <ErrorState message={getErrorMessage(late.error)} onRetry={() => late.refetch()} />
            </div>
          ) : late.data.items.length === 0 ? (
            <EmptyState
              title="Nobody was late"
              description="No late arrivals were recorded in the last 30 days."
            />
          ) : (
            <TableWrapper>
              <thead className="bg-slate-50">
                <tr>
                  <Th>Employee</Th>
                  <Th>Department</Th>
                  <Th align="right">Late days</Th>
                  <Th align="right">Total late</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {late.data.items.map((employee) => (
                  // A row is a person; clicking it opens that person's record.
                  <tr
                    key={employee.employeeId}
                    onClick={() => navigate(`/employees?open=${employee.employeeId}`)}
                    className="cursor-pointer hover:bg-slate-50"
                  >
                    <Td>
                      <span className="font-medium text-slate-900">{employee.fullName}</span>
                      <span className="ml-2 text-xs text-slate-400">{employee.employeeCode}</span>
                    </Td>
                    <Td>{employee.departmentName ?? '—'}</Td>
                    <Td align="right">{employee.lateDays}</Td>
                    <Td align="right">{formatMinutes(employee.totalLateMinutes)}</Td>
                  </tr>
                ))}
              </tbody>
            </TableWrapper>
          )}
        </Card>
      </div>
    </>
  );
}
