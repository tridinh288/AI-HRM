import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, Check, X } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import {
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
  StatusBadge,
  TableWrapper,
  Td,
  Th,
} from '../components/ui';
import { useAuth } from '../features/auth/AuthContext';
import { api, fetchData, fetchPage, getErrorMessage } from '../lib/api';
import { formatDateRange } from '../lib/format';
import type { LeaveBalance, LeaveRequest, LeaveType } from '../lib/types';

const requestSchema = z
  .object({
    leaveTypeId: z.string().uuid('Choose a leave type'),
    startDate: z.string().min(1, 'Start date is required'),
    endDate: z.string().min(1, 'End date is required'),
    reason: z.string().min(5, 'Give a reason of at least 5 characters').max(500),
  })
  .refine((value) => value.endDate >= value.startDate, {
    path: ['endDate'],
    message: 'The end date must not be before the start date',
  });

type RequestForm = z.infer<typeof requestSchema>;

export function LeavePage() {
  const { isHrOrAdmin, user } = useAuth();
  const queryClient = useQueryClient();

  const [page, setPage] = useState(1);
  const [status, setStatus] = useState(isHrOrAdmin ? 'PENDING' : '');
  const [showForm, setShowForm] = useState(false);
  const [banner, setBanner] = useState<{ tone: 'ok' | 'error'; message: string } | null>(null);

  const balances = useQuery({
    queryKey: ['leave', 'balances'],
    queryFn: () =>
      fetchData<{ employeeId: string; year: number; balances: LeaveBalance[] }>('/leave/balances'),
  });

  const types = useQuery({
    queryKey: ['leave', 'types'],
    queryFn: () => fetchData<LeaveType[]>('/leave/types'),
  });

  const requests = useQuery({
    queryKey: ['leave', 'requests', page, status],
    queryFn: () =>
      fetchPage<LeaveRequest>('/leave/requests', {
        page,
        pageSize: 15,
        status: status || undefined,
      }),
  });

  const form = useForm<RequestForm>({
    resolver: zodResolver(requestSchema),
    defaultValues: { leaveTypeId: '', startDate: '', endDate: '', reason: '' },
  });

  const createRequest = useMutation({
    mutationFn: (values: RequestForm) => api.post('/leave/requests', values),
    onSuccess: () => {
      setBanner({ tone: 'ok', message: 'Leave request submitted for approval.' });
      setShowForm(false);
      form.reset();
      void queryClient.invalidateQueries({ queryKey: ['leave'] });
    },
    onError: (error) => {
      // Overlap and insufficient balance both come back as 409 with a message
      // written by the server, which knows the actual numbers.
      setBanner({ tone: 'error', message: getErrorMessage(error) });
    },
  });

  const decide = useMutation({
    mutationFn: async (input: { id: string; action: 'approve' | 'reject' | 'cancel'; note?: string }) => {
      const body =
        input.action === 'reject'
          ? { decisionNote: input.note ?? 'Not approved' }
          : input.action === 'approve'
            ? { decisionNote: input.note }
            : {};
      await api.patch(`/leave/requests/${input.id}/${input.action}`, body);
    },
    onSuccess: () => {
      setBanner({ tone: 'ok', message: 'Request updated.' });
      void queryClient.invalidateQueries({ queryKey: ['leave'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (error) => setBanner({ tone: 'error', message: getErrorMessage(error) }),
  });

  return (
    <>
      <PageHeader
        title="Leave"
        description={
          isHrOrAdmin ? 'Review and decide leave requests' : 'Request time off and track your balance'
        }
        action={
          <Button icon={<CalendarPlus className="h-4 w-4" />} onClick={() => setShowForm((v) => !v)}>
            {showForm ? 'Close' : 'Request leave'}
          </Button>
        }
      />

      {banner && (
        <div
          role="status"
          className={
            banner.tone === 'ok'
              ? 'mb-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700'
              : 'mb-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700'
          }
        >
          {banner.message}
        </div>
      )}

      {showForm && (
        <Card className="mb-6">
          <CardHeader
            title="New leave request"
            description="Weekends are excluded automatically — a Friday-to-Monday request costs two days."
          />
          <form
            onSubmit={form.handleSubmit((values) => createRequest.mutate(values))}
            className="grid gap-4 sm:grid-cols-2"
            noValidate
          >
            <Field label="Leave type" error={form.formState.errors.leaveTypeId?.message}>
              <Select {...form.register('leaveTypeId')}>
                <option value="">Select…</option>
                {types.data?.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                    {type.isPaid ? '' : ' (unpaid)'}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Reason" error={form.formState.errors.reason?.message}>
              <Input placeholder="Family trip, medical appointment…" {...form.register('reason')} />
            </Field>

            <Field label="Start date" error={form.formState.errors.startDate?.message}>
              <Input type="date" {...form.register('startDate')} />
            </Field>

            <Field label="End date" error={form.formState.errors.endDate?.message}>
              <Input type="date" {...form.register('endDate')} />
            </Field>

            <div className="sm:col-span-2">
              <Button type="submit" loading={createRequest.isPending}>
                Submit request
              </Button>
            </div>
          </form>
        </Card>
      )}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {balances.isPending ? (
          <LoadingState />
        ) : balances.isError ? (
          <div className="sm:col-span-2 xl:col-span-4">
            <ErrorState message={getErrorMessage(balances.error)} />
          </div>
        ) : (
          balances.data.balances.map((balance) => (
            <Card key={balance.id}>
              <p className="text-sm font-medium text-slate-500">{balance.leaveTypeName}</p>
              <p className="mt-1 text-2xl font-semibold tabular text-slate-900">
                {balance.remainingDays}
                <span className="ml-1 text-sm font-normal text-slate-400">
                  / {balance.entitledDays} days
                </span>
              </p>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-brand-500"
                  style={{
                    width: `${
                      balance.entitledDays > 0
                        ? Math.min(100, (balance.usedDays / balance.entitledDays) * 100)
                        : 0
                    }%`,
                  }}
                />
              </div>
              <p className="mt-1 text-xs text-slate-400">{balance.usedDays} used</p>
            </Card>
          ))
        )}
      </div>

      <Card className="mb-4">
        <Field label="Status">
          <Select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
            className="sm:max-w-xs"
          >
            <option value="">All statuses</option>
            <option value="PENDING">Pending</option>
            <option value="APPROVED">Approved</option>
            <option value="REJECTED">Rejected</option>
            <option value="CANCELLED">Cancelled</option>
          </Select>
        </Field>
      </Card>

      {requests.isPending ? (
        <LoadingState />
      ) : requests.isError ? (
        <ErrorState message={getErrorMessage(requests.error)} onRetry={() => requests.refetch()} />
      ) : requests.data.items.length === 0 ? (
        <Card>
          <EmptyState
            title="No leave requests"
            description={
              status ? 'Nothing matches this filter.' : 'Requests will appear here once submitted.'
            }
          />
        </Card>
      ) : (
        <>
          <TableWrapper>
            <thead className="bg-slate-50">
              <tr>
                {isHrOrAdmin && <Th>Employee</Th>}
                <Th>Type</Th>
                <Th>Dates</Th>
                <Th align="right">Days</Th>
                <Th>Reason</Th>
                <Th>Status</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {requests.data.items.map((request) => {
                const isOwn = request.employeeId === user?.employeeId;
                const isPending = request.status === 'PENDING';

                return (
                  <tr key={request.id} className="hover:bg-slate-50">
                    {isHrOrAdmin && (
                      <Td>
                        <span className="font-medium text-slate-900">{request.employeeName}</span>
                        <span className="ml-2 text-xs text-slate-400">
                          {request.departmentName ?? '—'}
                        </span>
                      </Td>
                    )}
                    <Td>{request.leaveTypeName}</Td>
                    <Td>{formatDateRange(request.startDate, request.endDate)}</Td>
                    <Td align="right">{request.totalDays}</Td>
                    <Td className="max-w-44 truncate whitespace-normal">{request.reason}</Td>
                    <Td>
                      <StatusBadge status={request.status} />
                      {request.decisionNote && (
                        <p className="mt-0.5 max-w-48 truncate text-xs text-slate-400">
                          {request.decisionNote}
                        </p>
                      )}
                    </Td>
                    <Td align="right">
                      <div className="flex justify-end gap-1.5">
                        {/* HR may decide anyone's request except their own — the
                            server enforces that, and the button is hidden to match. */}
                        {isHrOrAdmin && isPending && !isOwn && (
                          <>
                            <Button
                              size="sm"
                              variant="success"
                              icon={<Check className="h-3.5 w-3.5" />}
                              loading={decide.isPending && decide.variables?.id === request.id}
                              onClick={() =>
                                decide.mutate({ id: request.id, action: 'approve' })
                              }
                            >
                              Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              icon={<X className="h-3.5 w-3.5" />}
                              onClick={() => {
                                const note = window.prompt('Reason for rejection?');
                                if (note && note.trim().length >= 5) {
                                  decide.mutate({ id: request.id, action: 'reject', note });
                                }
                              }}
                            >
                              Reject
                            </Button>
                          </>
                        )}
                        {isOwn && isPending && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => decide.mutate({ id: request.id, action: 'cancel' })}
                          >
                            Cancel
                          </Button>
                        )}
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </TableWrapper>

          <Pagination
            page={requests.data.meta.page}
            totalPages={requests.data.meta.totalPages}
            total={requests.data.meta.total}
            onChange={setPage}
          />
        </>
      )}
    </>
  );
}
