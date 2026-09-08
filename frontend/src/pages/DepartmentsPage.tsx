import { useQuery } from '@tanstack/react-query';

import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  TableWrapper,
  Td,
  Th,
} from '../components/ui';
import { fetchPage, getErrorMessage } from '../lib/api';
import type { Department, Position } from '../lib/types';

export function DepartmentsPage() {
  const departments = useQuery({
    queryKey: ['departments', 'page'],
    queryFn: () => fetchPage<Department>('/departments', { pageSize: 50 }),
  });

  const positions = useQuery({
    queryKey: ['positions', 'page'],
    queryFn: () => fetchPage<Position>('/positions', { pageSize: 50 }),
  });

  return (
    <>
      <PageHeader
        title="Organisation"
        description="Departments and positions, with live headcount"
      />

      <div className="grid gap-6 xl:grid-cols-2">
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Departments
          </h2>

          {departments.isPending ? (
            <LoadingState />
          ) : departments.isError ? (
            <ErrorState
              message={getErrorMessage(departments.error)}
              onRetry={() => departments.refetch()}
            />
          ) : departments.data.items.length === 0 ? (
            <Card>
              <EmptyState title="No departments yet" />
            </Card>
          ) : (
            <TableWrapper>
              <thead className="bg-slate-50">
                <tr>
                  <Th>Code</Th>
                  <Th>Name</Th>
                  <Th align="right">Employees</Th>
                  <Th align="right">Status</Th>
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
                        {department.isActive ? 'active' : 'inactive'}
                      </Badge>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </TableWrapper>
          )}
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Positions
          </h2>

          {positions.isPending ? (
            <LoadingState />
          ) : positions.isError ? (
            <ErrorState
              message={getErrorMessage(positions.error)}
              onRetry={() => positions.refetch()}
            />
          ) : positions.data.items.length === 0 ? (
            <Card>
              <EmptyState title="No positions yet" />
            </Card>
          ) : (
            <TableWrapper>
              <thead className="bg-slate-50">
                <tr>
                  <Th>Title</Th>
                  <Th>Level</Th>
                  <Th align="right">Employees</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {positions.data.items.map((position) => (
                  <tr key={position.id} className="hover:bg-slate-50">
                    <Td>
                      <span className="font-medium text-slate-900">{position.title}</span>
                    </Td>
                    <Td>
                      <Badge tone="info">{position.level.toLowerCase()}</Badge>
                    </Td>
                    <Td align="right">{position.employeeCount}</Td>
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
