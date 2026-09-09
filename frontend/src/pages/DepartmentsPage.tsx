import { useQuery } from '@tanstack/react-query';
import { Pencil, Plus, Power, RotateCcw } from 'lucide-react';
import { useState } from 'react';

import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  TableWrapper,
  Td,
  Th,
} from '../components/ui';
import { DepartmentForm, PositionForm } from '../features/organisation/OrganisationForms';
import { useActiveToggle } from '../features/organisation/useActiveToggle';
import { fetchPage, getErrorMessage } from '../lib/api';
import type { Department, Position } from '../lib/types';

/** Which form, if any, is open in a section. */
type Editing<T> = { mode: 'create' } | { mode: 'edit'; row: T } | null;

export function DepartmentsPage() {
  const [banner, setBanner] = useState<{ tone: 'ok' | 'error'; message: string } | null>(null);
  const [editingDepartment, setEditingDepartment] = useState<Editing<Department>>(null);
  const [editingPosition, setEditingPosition] = useState<Editing<Position>>(null);

  const departments = useQuery({
    queryKey: ['departments', 'page'],
    queryFn: () => fetchPage<Department>('/departments', { pageSize: 50 }),
  });

  const positions = useQuery({
    queryKey: ['positions', 'page'],
    queryFn: () => fetchPage<Position>('/positions', { pageSize: 50 }),
  });

  const toggleDepartment = useActiveToggle('departments');
  const togglePosition = useActiveToggle('positions');

  /**
   * Deactivating is refused while the row still has people in it, and the
   * server's message names the count — worth showing verbatim, because
   * "move or terminate the 14 employee(s) first" tells HR what to do next and
   * a generic failure does not.
   */
  function toggleActive(
    toggle: ReturnType<typeof useActiveToggle>,
    input: { id: string; activate: boolean; label: string },
  ) {
    setBanner(null);
    toggle.mutate(
      { id: input.id, activate: input.activate },
      {
        onSuccess: () =>
          setBanner({
            tone: 'ok',
            message: input.activate
              ? `Đã kích hoạt lại ${input.label}.`
              : `Đã ngừng sử dụng ${input.label}.`,
          }),
        onError: (error) => setBanner({ tone: 'error', message: getErrorMessage(error) }),
      },
    );
  }

  return (
    <>
      <PageHeader
        title="Tổ chức"
        description="Phòng ban và vị trí, kèm sĩ số cập nhật trực tiếp"
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

      <div className="grid gap-6 xl:grid-cols-2">
        <section className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Phòng ban
            </h2>
            <Button
              size="sm"
              variant="secondary"
              icon={<Plus className="h-4 w-4" />}
              onClick={() => {
                setBanner(null);
                setEditingDepartment(editingDepartment?.mode === 'create' ? null : { mode: 'create' });
              }}
            >
              Thêm
            </Button>
          </div>

          {editingDepartment && (
            <Card>
              <CardHeader
                title={
                  editingDepartment.mode === 'create'
                    ? 'Phòng ban mới'
                    : `Sửa ${editingDepartment.row.name}`
                }
              />
              <DepartmentForm
                {...(editingDepartment.mode === 'edit' ? { existing: editingDepartment.row } : {})}
                onDone={(message) => {
                  setBanner({ tone: 'ok', message });
                  setEditingDepartment(null);
                }}
                onCancel={() => setEditingDepartment(null)}
              />
            </Card>
          )}

          {departments.isPending ? (
            <LoadingState />
          ) : departments.isError ? (
            <ErrorState
              message={getErrorMessage(departments.error)}
              onRetry={() => departments.refetch()}
            />
          ) : departments.data.items.length === 0 ? (
            <Card>
              <EmptyState
                title="Chưa có phòng ban nào"
                description="Thêm phòng ban đầu tiên để gán nhân viên vào."
              />
            </Card>
          ) : (
            <TableWrapper>
              <thead className="bg-slate-50">
                <tr>
                  <Th>Mã</Th>
                  <Th>Tên</Th>
                  <Th align="right">Nhân viên</Th>
                  <Th align="right">Trạng thái</Th>
                  <Th align="right">Thao tác</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {departments.data.items.map((department) => (
                  <tr key={department.id} className="hover:bg-slate-50">
                    <Td>
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs">
                        {department.code}
                      </span>
                    </Td>
                    <Td>
                      <span className="font-medium text-slate-900">{department.name}</span>
                      {department.description && (
                        <p className="text-xs text-slate-400">{department.description}</p>
                      )}
                    </Td>
                    <Td align="right">{department.employeeCount}</Td>
                    <Td align="right">
                      <Badge tone={department.isActive ? 'success' : 'neutral'}>
                        {department.isActive ? 'đang dùng' : 'ngừng dùng'}
                      </Badge>
                    </Td>
                    <Td align="right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<Pencil className="h-3.5 w-3.5" />}
                          onClick={() => {
                            setBanner(null);
                            setEditingDepartment({ mode: 'edit', row: department });
                          }}
                        >
                          Sửa
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={
                            toggleDepartment.isPending &&
                            toggleDepartment.variables?.id === department.id
                          }
                          icon={
                            department.isActive ? (
                              <Power className="h-3.5 w-3.5" />
                            ) : (
                              <RotateCcw className="h-3.5 w-3.5" />
                            )
                          }
                          onClick={() =>
                            toggleActive(toggleDepartment, {
                              id: department.id,
                              activate: !department.isActive,
                              label: department.name,
                            })
                          }
                        >
                          {department.isActive ? 'Ngừng' : 'Bật lại'}
                        </Button>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </TableWrapper>
          )}
        </section>

        <section className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Vị trí
            </h2>
            <Button
              size="sm"
              variant="secondary"
              icon={<Plus className="h-4 w-4" />}
              onClick={() => {
                setBanner(null);
                setEditingPosition(editingPosition?.mode === 'create' ? null : { mode: 'create' });
              }}
            >
              Thêm
            </Button>
          </div>

          {editingPosition && (
            <Card>
              <CardHeader
                title={
                  editingPosition.mode === 'create'
                    ? 'Vị trí mới'
                    : `Sửa ${editingPosition.row.title}`
                }
              />
              <PositionForm
                {...(editingPosition.mode === 'edit' ? { existing: editingPosition.row } : {})}
                onDone={(message) => {
                  setBanner({ tone: 'ok', message });
                  setEditingPosition(null);
                }}
                onCancel={() => setEditingPosition(null)}
              />
            </Card>
          )}

          {positions.isPending ? (
            <LoadingState />
          ) : positions.isError ? (
            <ErrorState
              message={getErrorMessage(positions.error)}
              onRetry={() => positions.refetch()}
            />
          ) : positions.data.items.length === 0 ? (
            <Card>
              <EmptyState title="Chưa có vị trí nào" />
            </Card>
          ) : (
            <TableWrapper>
              <thead className="bg-slate-50">
                <tr>
                  <Th>Tên vị trí</Th>
                  <Th>Cấp bậc</Th>
                  <Th align="right">Nhân viên</Th>
                  <Th align="right">Thao tác</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {positions.data.items.map((position) => (
                  <tr key={position.id} className="hover:bg-slate-50">
                    <Td>
                      <span className="font-medium text-slate-900">{position.title}</span>
                      {!position.isActive && (
                        <Badge tone="neutral">ngừng dùng</Badge>
                      )}
                      {position.description && (
                        <p className="text-xs text-slate-400">{position.description}</p>
                      )}
                    </Td>
                    <Td>
                      <Badge tone="info">{position.level.toLowerCase()}</Badge>
                    </Td>
                    <Td align="right">{position.employeeCount}</Td>
                    <Td align="right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<Pencil className="h-3.5 w-3.5" />}
                          onClick={() => {
                            setBanner(null);
                            setEditingPosition({ mode: 'edit', row: position });
                          }}
                        >
                          Sửa
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={
                            togglePosition.isPending &&
                            togglePosition.variables?.id === position.id
                          }
                          icon={
                            position.isActive ? (
                              <Power className="h-3.5 w-3.5" />
                            ) : (
                              <RotateCcw className="h-3.5 w-3.5" />
                            )
                          }
                          onClick={() =>
                            toggleActive(togglePosition, {
                              id: position.id,
                              activate: !position.isActive,
                              label: position.title,
                            })
                          }
                        >
                          {position.isActive ? 'Ngừng' : 'Bật lại'}
                        </Button>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </TableWrapper>
          )}
        </section>
      </div>
    </>
  );
}
