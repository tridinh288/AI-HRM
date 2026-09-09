import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Search, ShieldCheck, ShieldOff } from 'lucide-react';
import { useEffect, useState } from 'react';

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
  StatusBadge,
  TableWrapper,
  Td,
  Th,
} from '../components/ui';
import { useAuth } from '../features/auth/AuthContext';
import { api, fetchPage, getErrorMessage } from '../lib/api';
import type { Employee, Role } from '../lib/types';

/**
 * Account administration — the page that gives ADMIN a reason to exist.
 *
 * Everywhere else HR and ADMIN are the same role. Here, and only here, an
 * administrator changes what an account may do: its role, and whether it may
 * sign in at all. Both go through one endpoint the server gates to ADMIN and
 * guards against the three ways changing access goes wrong — changing your
 * own account, removing the last administrator, and re-enabling someone who
 * was terminated. The page mirrors the first of those (your own row cannot be
 * edited) and lets the server speak for the other two: its refusals name the
 * reason, and they are shown as written.
 */

function useDebounced<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

const ROLES: { value: Role; label: string; hint: string }[] = [
  { value: 'EMPLOYEE', label: 'Employee', hint: 'Chỉ dữ liệu của chính mình' },
  { value: 'HR', label: 'HR', hint: 'Toàn bộ nhân sự, duyệt phép, dashboard' },
  { value: 'ADMIN', label: 'Admin', hint: 'Như HR, thêm quyền quản trị tài khoản' },
];

function AccountForm({
  employee,
  onDone,
  onCancel,
}: {
  employee: Employee;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const queryClient = useQueryClient();
  const [role, setRole] = useState<Role>(employee.role);
  const [isActive, setIsActive] = useState(employee.isActive);

  const changed = role !== employee.role || isActive !== employee.isActive;
  const terminated = employee.employmentStatus === 'TERMINATED';

  const save = useMutation({
    mutationFn: async () => {
      // Only what changed: the server requires at least one field and treats
      // an absent one as "leave it alone".
      const response = await api.patch<{ data: Employee }>(`/employees/${employee.id}/account`, {
        ...(role !== employee.role ? { role } : {}),
        ...(isActive !== employee.isActive ? { isActive } : {}),
      });
      return response.data.data;
    },
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: ['employees'] });
      onDone(
        `${updated.fullName}: role ${updated.role.toLowerCase()}, ${
          updated.isActive ? 'đăng nhập được' : 'đã khoá đăng nhập'
        }. Mọi phiên của tài khoản này đã bị thu hồi.`,
      );
    },
  });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (changed) save.mutate();
      }}
      className="grid gap-4 sm:grid-cols-2"
      noValidate
    >
      <Field label="Role" hint={ROLES.find((option) => option.value === role)?.hint}>
        <Select value={role} onChange={(event) => setRole(event.target.value as Role)}>
          {ROLES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        label="Đăng nhập"
        hint={
          terminated
            ? 'Người này đã nghỉ việc — không mở lại được'
            : 'Khoá là thu hồi mọi phiên ngay; mở lại là cho phép đăng nhập'
        }
      >
        <Select
          value={isActive ? 'active' : 'disabled'}
          onChange={(event) => setIsActive(event.target.value === 'active')}
          disabled={terminated}
        >
          <option value="active">Được phép</option>
          <option value="disabled">Bị khoá</option>
        </Select>
      </Field>

      {save.isError && (
        <div role="alert" className="sm:col-span-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {getErrorMessage(save.error)}
        </div>
      )}

      <div className="sm:col-span-2 flex gap-2">
        <Button type="submit" loading={save.isPending} disabled={!changed}>
          Áp dụng
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={save.isPending}>
          Huỷ
        </Button>
      </div>
    </form>
  );
}

export function AccountsPage() {
  const { user } = useAuth();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Employee | null>(null);
  const [banner, setBanner] = useState<{ tone: 'ok' | 'error'; message: string } | null>(null);
  const debouncedSearch = useDebounced(search);

  const accounts = useQuery({
    queryKey: ['employees', 'accounts', page, debouncedSearch],
    queryFn: () =>
      fetchPage<Employee>('/employees', {
        page,
        pageSize: 20,
        search: debouncedSearch || undefined,
        sortBy: 'employeeCode',
        sortOrder: 'asc',
      }),
    placeholderData: (previous) => previous,
  });

  return (
    <>
      <PageHeader
        title="Tài khoản"
        description="Role và quyền đăng nhập của từng tài khoản — chỉ quản trị viên"
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

      {editing && (
        <Card className="mb-6">
          <CardHeader
            title={`${editing.fullName}`}
            description={`${editing.employeeCode} · ${editing.email}`}
          />
          <AccountForm
            employee={editing}
            onDone={(message) => {
              setBanner({ tone: 'ok', message });
              setEditing(null);
            }}
            onCancel={() => setEditing(null)}
          />
        </Card>
      )}

      <Card className="mb-4">
        <Field label="Tìm kiếm">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              className="pl-9"
              placeholder="Tên, mã hoặc email"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
            />
          </div>
        </Field>
      </Card>

      {accounts.isPending ? (
        <LoadingState />
      ) : accounts.isError ? (
        <ErrorState message={getErrorMessage(accounts.error)} onRetry={() => accounts.refetch()} />
      ) : accounts.data.items.length === 0 ? (
        <Card>
          <EmptyState title="Không tìm thấy tài khoản nào" />
        </Card>
      ) : (
        <>
          <TableWrapper>
            <thead className="bg-slate-50">
              <tr>
                <Th>Tài khoản</Th>
                <Th>Role</Th>
                <Th>Đăng nhập</Th>
                <Th>Trạng thái nhân sự</Th>
                <Th align="right">Thao tác</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {accounts.data.items.map((employee) => {
                const isSelf = employee.id === user?.employeeId;
                return (
                  <tr key={employee.id} className="hover:bg-slate-50">
                    <Td>
                      <span className="font-medium text-slate-900">{employee.fullName}</span>
                      <p className="text-xs text-slate-400">
                        {employee.employeeCode} · {employee.email}
                      </p>
                    </Td>
                    <Td>
                      <Badge tone={employee.role === 'ADMIN' ? 'info' : employee.role === 'HR' ? 'warning' : 'neutral'}>
                        {employee.role.toLowerCase()}
                      </Badge>
                    </Td>
                    <Td>
                      {employee.isActive ? (
                        <span className="inline-flex items-center gap-1 text-sm text-emerald-700">
                          <ShieldCheck className="h-3.5 w-3.5" /> được phép
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-sm text-slate-500">
                          <ShieldOff className="h-3.5 w-3.5" /> bị khoá
                        </span>
                      )}
                    </Td>
                    <Td>
                      <StatusBadge status={employee.employmentStatus} />
                    </Td>
                    <Td align="right">
                      {/* Your own row is not editable here, and the server refuses it
                          regardless: an administrator changes their own access by
                          asking another administrator. */}
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<KeyRound className="h-3.5 w-3.5" />}
                        disabled={isSelf}
                        title={isSelf ? 'Tài khoản của bạn — nhờ quản trị viên khác' : undefined}
                        onClick={() => {
                          setBanner(null);
                          setEditing(employee);
                        }}
                      >
                        {isSelf ? 'Bạn' : 'Sửa quyền'}
                      </Button>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </TableWrapper>

          <Pagination
            page={accounts.data.meta.page}
            totalPages={accounts.data.meta.totalPages}
            total={accounts.data.meta.total}
            onChange={setPage}
          />
        </>
      )}
    </>
  );
}
