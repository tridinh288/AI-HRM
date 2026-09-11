import { useQuery } from '@tanstack/react-query';
import { Pencil, Search, UserPlus, UserX } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

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
import { EmployeeForm } from '../features/employees/EmployeeForm';
import { TerminateForm } from '../features/employees/TerminateForm';
import { fetchData, fetchPage, getErrorMessage } from '../lib/api';
import { formatCurrency, formatDate } from '../lib/format';
import type { Department, Employee } from '../lib/types';

/**
 * Debounces a rapidly-changing value.
 *
 * Without it, typing "Nguyen" fires six requests and the answer displayed is
 * whichever one happens to come back last — which is not necessarily the one for
 * the complete search term.
 */
function useDebounced<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

/**
 * "EMP0500" → "EMP0501". A suggestion, not a rule: the field stays editable and
 * the server's unique index is what actually guarantees the code is unused.
 */
function nextEmployeeCode(lastCode: string | undefined): string | undefined {
  const match = lastCode?.match(/^([A-Z-]*?)(\d+)$/);
  if (!match) return undefined;
  const [, prefix, digits] = match;
  return `${prefix}${String(Number(digits) + 1).padStart(digits!.length, '0')}`;
}

const SORT_FIELDS = ['employeeCode', 'lastName', 'hireDate', 'createdAt'];
const STATUSES = ['ACTIVE', 'PROBATION', 'ON_LEAVE', 'TERMINATED'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function EmployeesPage() {
  const { user } = useAuth();
  // The dashboard deep-links here: a department bar filters by department, a
  // late-arrivals row opens one person. Filters start from the query string
  // when it carries a valid value; the controls own them from then on.
  const [params] = useSearchParams();
  const fromParams = (key: string, allowed: (value: string) => boolean) => {
    const value = params.get(key);
    return value && allowed(value) ? value : null;
  };

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [departmentId, setDepartmentId] = useState(
    () => fromParams('departmentId', (v) => UUID.test(v)) ?? '',
  );
  const [employmentStatus, setEmploymentStatus] = useState(
    () => fromParams('employmentStatus', (v) => STATUSES.includes(v)) ?? '',
  );
  const [sortBy, setSortBy] = useState(
    () => fromParams('sortBy', (v) => SORT_FIELDS.includes(v)) ?? 'employeeCode',
  );

  const [showCreate, setShowCreate] = useState(false);
  const [banner, setBanner] = useState<{ tone: 'ok' | 'error'; message: string } | null>(null);

  const debouncedSearch = useDebounced(search);

  const departments = useQuery({
    queryKey: ['departments', 'all'],
    queryFn: () => fetchPage<Department>('/departments', { pageSize: 100 }),
    // Departments change rarely; refetching them on every focus is wasted work.
    staleTime: 5 * 60 * 1000,
  });

  const employees = useQuery({
    queryKey: ['employees', page, debouncedSearch, departmentId, employmentStatus, sortBy],
    queryFn: () =>
      fetchPage<Employee>('/employees', {
        page,
        pageSize: 15,
        search: debouncedSearch || undefined,
        departmentId: departmentId || undefined,
        employmentStatus: employmentStatus || undefined,
        sortBy,
        sortOrder: sortBy === 'hireDate' ? 'desc' : 'asc',
      }),
    // Keeps the previous page visible while the next one loads, instead of
    // flashing a spinner over the table on every keystroke.
    placeholderData: (previous) => previous,
  });

  // Only fetched while the create form is open — it exists to prefill one field.
  const latest = useQuery({
    queryKey: ['employees', 'latest-code'],
    queryFn: () =>
      fetchPage<Employee>('/employees', { pageSize: 1, sortBy: 'employeeCode', sortOrder: 'desc' }),
    enabled: showCreate,
  });

  const [selected, setSelected] = useState<string | null>(
    () => fromParams('open', (v) => UUID.test(v)),
  );
  // The drawer shows one of three things: the record, the edit form, or the
  // termination form. One value rather than two booleans that can disagree.
  const [drawerMode, setDrawerMode] = useState<'view' | 'edit' | 'terminate'>('view');

  const detail = useQuery({
    queryKey: ['employees', 'detail', selected],
    queryFn: () => fetchData<Employee>(`/employees/${selected}`),
    enabled: Boolean(selected),
  });

  const closeDrawer = () => {
    setSelected(null);
    setDrawerMode('view');
  };

  return (
    <>
      <PageHeader
        title="Employees"
        description="Search, filter and review the employee register"
        action={
          <Button
            icon={<UserPlus className="h-4 w-4" />}
            onClick={() => {
              setBanner(null);
              setShowCreate((open) => !open);
            }}
          >
            {showCreate ? 'Close' : 'Add employee'}
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

      {showCreate && (
        <Card className="mb-6">
          <CardHeader
            title="New employee"
            description="Creates the login, the HR record and this year's leave balances together — all or nothing."
          />
          {latest.isPending ? (
            <LoadingState label="Preparing…" />
          ) : (
            <EmployeeForm
              mode={{
                kind: 'create',
                suggestedCode: nextEmployeeCode(latest.data?.items[0]?.employeeCode),
              }}
              onSuccess={(employee, message) => {
                setBanner({ tone: 'ok', message });
                setShowCreate(false);
                setSelected(employee.id);
              }}
              onCancel={() => setShowCreate(false)}
            />
          )}
        </Card>
      )}

      <Card className="mb-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Search">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                className="pl-9"
                placeholder="Name, code or email"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(1);
                }}
              />
            </div>
          </Field>

          <Field label="Department">
            <Select
              value={departmentId}
              onChange={(event) => {
                setDepartmentId(event.target.value);
                setPage(1);
              }}
            >
              <option value="">All departments</option>
              {departments.data?.items.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Status">
            <Select
              value={employmentStatus}
              onChange={(event) => {
                setEmploymentStatus(event.target.value);
                setPage(1);
              }}
            >
              <option value="">All statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="PROBATION">Probation</option>
              <option value="ON_LEAVE">On leave</option>
              <option value="TERMINATED">Terminated</option>
            </Select>
          </Field>

          <Field label="Sort by">
            <Select value={sortBy} onChange={(event) => setSortBy(event.target.value)}>
              <option value="employeeCode">Employee code</option>
              <option value="lastName">Last name</option>
              <option value="hireDate">Hire date (newest)</option>
              <option value="createdAt">Recently added</option>
            </Select>
          </Field>
        </div>
      </Card>

      {employees.isPending ? (
        <LoadingState />
      ) : employees.isError ? (
        <ErrorState message={getErrorMessage(employees.error)} onRetry={() => employees.refetch()} />
      ) : employees.data.items.length === 0 ? (
        <Card>
          <EmptyState
            title="No employees found"
            description="Try clearing the filters or searching for something else."
          />
        </Card>
      ) : (
        <>
          <TableWrapper>
            <thead className="bg-slate-50">
              <tr>
                <Th>Employee</Th>
                <Th>Department</Th>
                <Th>Position</Th>
                <Th>Hired</Th>
                <Th>Status</Th>
                <Th align="right">Base salary</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {employees.data.items.map((employee) => (
                <tr
                  key={employee.id}
                  onClick={() => {
                    setSelected(employee.id);
                    setDrawerMode('view');
                  }}
                  className="cursor-pointer hover:bg-slate-50"
                >
                  <Td>
                    <span className="font-medium text-slate-900">{employee.fullName}</span>
                    <p className="text-xs text-slate-400">
                      <span className="code">{employee.employeeCode}</span> · {employee.email}
                    </p>
                  </Td>
                  <Td>{employee.department?.name ?? '—'}</Td>
                  <Td>{employee.position?.title ?? '—'}</Td>
                  <Td>{formatDate(employee.hireDate)}</Td>
                  <Td>
                    <StatusBadge status={employee.employmentStatus} />
                  </Td>
                  {/* `baseSalary` is absent, not null, when the API decided the
                      viewer may not see it — so this renders a dash rather than a
                      misleading zero. */}
                  <Td align="right">
                    {employee.baseSalary === undefined ? (
                      <span className="text-slate-300">hidden</span>
                    ) : (
                      formatCurrency(employee.baseSalary)
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrapper>

          <Pagination
            page={employees.data.meta.page}
            totalPages={employees.data.meta.totalPages}
            total={employees.data.meta.total}
            onChange={setPage}
          />
        </>
      )}

      {selected && (
        <div className="fixed inset-0 z-40 flex justify-end">
          <div className="absolute inset-0 bg-slate-900/30" onClick={closeDrawer} aria-hidden />
          <aside className="relative w-full max-w-md overflow-y-auto bg-white p-6 shadow-xl">
            {detail.isPending ? (
              <LoadingState />
            ) : detail.isError ? (
              <ErrorState message={getErrorMessage(detail.error)} />
            ) : drawerMode === 'edit' ? (
              <>
                <div className="mb-6">
                  <h2 className="text-lg font-semibold text-slate-900">Edit {detail.data.fullName}</h2>
                  <p className="text-sm text-slate-500">
                    {detail.data.employeeCode} · {detail.data.email}
                  </p>
                </div>
                <EmployeeForm
                  mode={{ kind: 'edit', employee: detail.data }}
                  onSuccess={(_employee, message) => {
                    setBanner({ tone: 'ok', message });
                    setDrawerMode('view');
                  }}
                  onCancel={() => setDrawerMode('view')}
                />
              </>
            ) : drawerMode === 'terminate' ? (
              <>
                <div className="mb-6">
                  <h2 className="text-lg font-semibold text-slate-900">
                    Cho {detail.data.fullName} nghỉ việc
                  </h2>
                  <p className="text-sm text-slate-500">
                    {detail.data.employeeCode} · {detail.data.email}
                  </p>
                </div>
                <TerminateForm
                  employee={detail.data}
                  onDone={(message) => {
                    setBanner({ tone: 'ok', message });
                    setDrawerMode('view');
                  }}
                  onCancel={() => setDrawerMode('view')}
                />
              </>
            ) : (
              <>
                <div className="mb-6 flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-semibold text-slate-900">{detail.data.fullName}</h2>
                    <p className="text-sm text-slate-500">{detail.data.email}</p>
                    <div className="mt-2">
                      <StatusBadge status={detail.data.employmentStatus} />
                    </div>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Pencil className="h-3.5 w-3.5" />}
                    onClick={() => setDrawerMode('edit')}
                  >
                    Edit
                  </Button>
                </div>

                <dl className="space-y-3 text-sm">
                  {[
                    ['Employee code', detail.data.employeeCode],
                    ['Department', detail.data.department?.name ?? '—'],
                    ['Position', detail.data.position?.title ?? '—'],
                    ['Level', detail.data.position?.level ?? '—'],
                    ['Hire date', formatDate(detail.data.hireDate)],
                    ['Phone', detail.data.phone ?? '—'],
                    ['Date of birth', formatDate(detail.data.dateOfBirth)],
                    ['Address', detail.data.address ?? '—'],
                    [
                      'Base salary',
                      detail.data.baseSalary === undefined
                        ? 'Not visible to your role'
                        : formatCurrency(detail.data.baseSalary),
                    ],
                  ].map(([label, value]) => (
                    <div key={label} className="flex justify-between gap-4 border-b border-slate-100 pb-2">
                      <dt className="text-slate-500">{label}</dt>
                      <dd className="text-right font-medium text-slate-900">{value}</dd>
                    </div>
                  ))}
                </dl>

                {/* Offered only while there is something to end, and never on
                    your own record: terminating disables the login behind it,
                    so doing it to yourself is locking yourself out. The server
                    refuses both cases with 409 regardless of what is rendered. */}
                {detail.data.employmentStatus !== 'TERMINATED' &&
                  (detail.data.id === user?.employeeId ? (
                    <p className="mt-6 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-500">
                      Đây là hồ sơ của bạn — việc cho nghỉ phải do người khác thực hiện.
                    </p>
                  ) : (
                    <Button
                      variant="danger"
                      icon={<UserX className="h-4 w-4" />}
                      className="mt-6 w-full"
                      onClick={() => {
                        setBanner(null);
                        setDrawerMode('terminate');
                      }}
                    >
                      Cho nghỉ việc
                    </Button>
                  ))}

                <button
                  type="button"
                  onClick={closeDrawer}
                  className="mt-3 w-full rounded-lg bg-slate-100 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-200"
                >
                  Close
                </button>
              </>
            )}
          </aside>
        </div>
      )}
    </>
  );
}
