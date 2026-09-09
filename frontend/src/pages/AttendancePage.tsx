import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LogIn, LogOut, Pencil } from 'lucide-react';
import { useState } from 'react';

import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  PageHeader,
  Pagination,
  Select,
  StatCard,
  StatusBadge,
  TableWrapper,
  Td,
  Th,
} from '../components/ui';
import { CorrectionForm } from '../features/attendance/CorrectionForm';
import { api, fetchData, fetchPage, getErrorMessage } from '../lib/api';
import { useAuth } from '../features/auth/AuthContext';
import { firstDayOfMonthIso, formatDate, formatMinutes, formatTime, todayIso } from '../lib/format';
import type { AttendanceRecord, AttendanceSummary } from '../lib/types';

export function AttendancePage() {
  const { isHrOrAdmin } = useAuth();
  const queryClient = useQueryClient();

  const [page, setPage] = useState(1);
  const [from, setFrom] = useState(firstDayOfMonthIso());
  const [to, setTo] = useState(todayIso());
  const [status, setStatus] = useState('');
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'error'; message: string } | null>(null);
  // The record HR is correcting, if any. Held whole rather than by id: the
  // drawer needs its timestamps, and the row is already in hand.
  const [correcting, setCorrecting] = useState<AttendanceRecord | null>(null);

  const today = useQuery({
    queryKey: ['attendance', 'today'],
    queryFn: () =>
      fetchData<{ workDate: string; record: AttendanceRecord | null }>('/attendance/today'),
  });

  const summary = useQuery({
    queryKey: ['attendance', 'summary', from, to],
    queryFn: () => fetchData<AttendanceSummary>('/attendance/summary', { from, to }),
  });

  const records = useQuery({
    queryKey: ['attendance', 'list', page, from, to, status],
    queryFn: () =>
      fetchPage<AttendanceRecord>('/attendance', {
        page,
        pageSize: 15,
        from,
        to,
        status: status || undefined,
      }),
  });

  /**
   * Check-in and check-out share this mutation. On success every attendance
   * query is invalidated rather than one being patched by hand: the server
   * derives status, late minutes and worked minutes, so refetching is the only
   * way to display what was actually recorded rather than a guess.
   */
  const punch = useMutation({
    mutationFn: async (action: 'check-in' | 'check-out') => {
      await api.post(`/attendance/${action}`);
      return action;
    },
    onSuccess: (action) => {
      setFeedback({
        tone: 'ok',
        message: action === 'check-in' ? 'Checked in.' : 'Checked out.',
      });
      void queryClient.invalidateQueries({ queryKey: ['attendance'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (error) => {
      // 409 here is expected, not exceptional: "you already checked in today" is
      // information the user needs, phrased by the server.
      setFeedback({ tone: 'error', message: getErrorMessage(error) });
    },
  });

  const record = today.data?.record ?? null;
  const canCheckIn = !record;
  const canCheckOut = Boolean(record?.checkInAt && !record.checkOutAt);

  return (
    <>
      <PageHeader
        title="Attendance"
        description={
          isHrOrAdmin
            ? 'Your own attendance, and the company-wide record'
            : 'Check in, check out, and review your attendance history'
        }
      />

      <Card className="mb-6">
        <CardHeader
          title="Today"
          description={today.data ? formatDate(today.data.workDate) : undefined}
          action={
            <div className="flex gap-2">
              <Button
                icon={<LogIn className="h-4 w-4" />}
                disabled={!canCheckIn}
                loading={punch.isPending && punch.variables === 'check-in'}
                onClick={() => punch.mutate('check-in')}
              >
                Check in
              </Button>
              <Button
                variant="secondary"
                icon={<LogOut className="h-4 w-4" />}
                disabled={!canCheckOut}
                loading={punch.isPending && punch.variables === 'check-out'}
                onClick={() => punch.mutate('check-out')}
              >
                Check out
              </Button>
            </div>
          }
        />

        {feedback && (
          <div
            role="status"
            className={
              feedback.tone === 'ok'
                ? 'mb-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700'
                : 'mb-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700'
            }
          >
            {feedback.message}
          </div>
        )}

        {today.isPending ? (
          <LoadingState />
        ) : today.isError ? (
          <ErrorState message={getErrorMessage(today.error)} onRetry={() => today.refetch()} />
        ) : record ? (
          <div className="grid gap-3 sm:grid-cols-4">
            <div>
              <p className="text-xs text-slate-500">Checked in</p>
              <p className="text-lg font-semibold tabular text-slate-900">
                {formatTime(record.checkInAt)}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Checked out</p>
              <p className="text-lg font-semibold tabular text-slate-900">
                {formatTime(record.checkOutAt)}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Status</p>
              <div className="mt-1.5">
                <StatusBadge status={record.status} />
                {record.lateMinutes > 0 && (
                  <span className="ml-2 text-xs text-amber-600">
                    {formatMinutes(record.lateMinutes)} late
                  </span>
                )}
              </div>
            </div>
            <div>
              <p className="text-xs text-slate-500">Worked</p>
              <p className="text-lg font-semibold tabular text-slate-900">
                {formatMinutes(record.workMinutes)}
              </p>
              {record.overtimeMinutes > 0 && (
                <p className="text-xs text-emerald-600">
                  +{formatMinutes(record.overtimeMinutes)} overtime
                </p>
              )}
            </div>
          </div>
        ) : (
          <p className="text-sm text-slate-500">
            You have not checked in today. Absence is derived from the missing record rather than
            stored, so there is nothing to clean up if you are off.
          </p>
        )}
      </Card>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {summary.data && (
          <>
            <StatCard label="Days recorded" value={summary.data.daysRecorded} hint={`${from} → ${to}`} />
            <StatCard
              label="Late days"
              value={summary.data.lateDays}
              hint={formatMinutes(summary.data.totalLateMinutes) + ' total'}
              tone={summary.data.lateDays > 0 ? 'warning' : 'neutral'}
            />
            <StatCard label="Hours worked" value={formatMinutes(summary.data.totalWorkMinutes)} />
            <StatCard
              label="Overtime"
              value={formatMinutes(summary.data.totalOvertimeMinutes)}
              tone="success"
            />
          </>
        )}
      </div>

      <Card className="mb-4">
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="From">
            <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </Field>
          <Field label="To">
            <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </Field>
          <Field label="Status">
            <Select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setPage(1);
              }}
            >
              <option value="">All</option>
              <option value="PRESENT">On time</option>
              <option value="LATE">Late</option>
              <option value="ON_LEAVE">On leave</option>
            </Select>
          </Field>
        </div>
      </Card>

      {records.isPending ? (
        <LoadingState />
      ) : records.isError ? (
        <ErrorState message={getErrorMessage(records.error)} onRetry={() => records.refetch()} />
      ) : records.data.items.length === 0 ? (
        <Card>
          <EmptyState
            title="No attendance records"
            description="Nothing was recorded in this date range."
          />
        </Card>
      ) : (
        <>
          <TableWrapper>
            <thead className="bg-slate-50">
              <tr>
                <Th>Date</Th>
                {isHrOrAdmin && <Th>Employee</Th>}
                <Th>In</Th>
                <Th>Out</Th>
                <Th>Status</Th>
                <Th align="right">Late</Th>
                <Th align="right">Worked</Th>
                <Th align="right">Overtime</Th>
                {isHrOrAdmin && <Th align="right">Sửa</Th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {records.data.items.map((row) => (
                <tr key={row.id} className="hover:bg-slate-50">
                  <Td>{formatDate(row.workDate)}</Td>
                  {isHrOrAdmin && (
                    <Td>
                      <span className="font-medium text-slate-900">{row.employeeName}</span>
                      <span className="ml-2 text-xs text-slate-400">{row.employeeCode}</span>
                    </Td>
                  )}
                  <Td>{formatTime(row.checkInAt)}</Td>
                  <Td>
                    {row.checkOutAt ? (
                      formatTime(row.checkOutAt)
                    ) : (
                      <Badge tone="warning">open</Badge>
                    )}
                  </Td>
                  <Td>
                    <StatusBadge status={row.status} />
                  </Td>
                  <Td align="right">{row.lateMinutes > 0 ? formatMinutes(row.lateMinutes) : '—'}</Td>
                  <Td align="right">{formatMinutes(row.workMinutes)}</Td>
                  <Td align="right">
                    {row.overtimeMinutes > 0 ? formatMinutes(row.overtimeMinutes) : '—'}
                  </Td>
                  {isHrOrAdmin && (
                    <Td align="right">
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Pencil className="h-3.5 w-3.5" />}
                        onClick={() => {
                          setFeedback(null);
                          setCorrecting(row);
                        }}
                      >
                        Sửa
                      </Button>
                    </Td>
                  )}
                </tr>
              ))}
            </tbody>
          </TableWrapper>

          <Pagination
            page={records.data.meta.page}
            totalPages={records.data.meta.totalPages}
            total={records.data.meta.total}
            onChange={setPage}
          />
        </>
      )}

      {correcting && (
        <div className="fixed inset-0 z-40 flex justify-end">
          <div
            className="absolute inset-0 bg-slate-900/30"
            onClick={() => setCorrecting(null)}
            aria-hidden
          />
          <aside className="relative w-full max-w-md overflow-y-auto bg-white p-6 shadow-xl">
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-slate-900">Sửa bản ghi chấm công</h2>
              <p className="text-sm text-slate-500">
                {correcting.employeeName} · {correcting.employeeCode} ·{' '}
                {formatDate(correcting.workDate)}
              </p>
            </div>

            <CorrectionForm
              record={correcting}
              onDone={(message) => {
                setFeedback({ tone: 'ok', message });
                setCorrecting(null);
              }}
              onCancel={() => setCorrecting(null)}
            />
          </aside>
        </div>
      )}
    </>
  );
}
