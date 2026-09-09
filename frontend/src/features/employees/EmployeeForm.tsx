import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button, Field, Input, Select } from '../../components/ui';
import { api, fetchPage, getErrorMessage } from '../../lib/api';
import type { Department, Employee, Position } from '../../lib/types';
import { useAuth } from '../auth/AuthContext';

/**
 * One form for both creating and editing an employee.
 *
 * The two differ in exactly the fields the API refuses to change after
 * creation — email, password, role, employee code and status are account and
 * lifecycle concerns with their own endpoints — so the form renders those only
 * in create mode and the edit payload never contains them. Salary is editable
 * in both: it is a field HR maintains, not a constant the seed decided.
 *
 * Validation mirrors `employee.schema.ts` on the server. The client copy is for
 * fast feedback; the server validates again because a browser is optional.
 */

/** `<select>` and `<input>` yield "" for "nothing chosen"; the API wants the key absent. */
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const employeeCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(3, 'At least 3 characters')
  .max(20, 'At most 20 characters')
  .regex(/^[A-Z0-9-]+$/, 'Use uppercase letters, digits or hyphens');

const recordSchema = z.object({
  firstName: z.string().trim().min(1, 'First name is required').max(80),
  lastName: z.string().trim().min(1, 'Last name is required').max(80),
  phone: optional(
    z.string().trim().regex(/^[0-9+\-\s()]{6,20}$/, 'Enter a valid phone number'),
  ),
  dateOfBirth: optional(z.string()),
  gender: optional(z.enum(['MALE', 'FEMALE', 'OTHER'])),
  address: optional(z.string().trim().max(255, 'At most 255 characters')),
  hireDate: z.string().min(1, 'Hire date is required'),
  departmentId: optional(z.string().uuid()),
  positionId: optional(z.string().uuid()),
  baseSalary: z.coerce
    .number({ invalid_type_error: 'Enter a number' })
    .nonnegative('Salary cannot be negative')
    .max(1_000_000_000, 'That is more than the system allows'),
});

const createSchema = recordSchema.extend({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  password: z
    .string()
    .min(10, 'At least 10 characters')
    .max(128, 'At most 128 characters'),
  role: z.enum(['EMPLOYEE', 'HR', 'ADMIN']),
  employeeCode: employeeCodeSchema,
  employmentStatus: z.enum(['PROBATION', 'ACTIVE']),
});

type CreateValues = z.infer<typeof createSchema>;
type RecordValues = z.infer<typeof recordSchema>;

/** What the inputs hold before validation coerces them. */
type FormValues = {
  [K in keyof CreateValues]: K extends 'baseSalary' ? number | string : string;
};

export type EmployeeFormMode = { kind: 'create'; suggestedCode?: string } | { kind: 'edit'; employee: Employee };

const GENDERS = [
  { value: 'MALE', label: 'Male' },
  { value: 'FEMALE', label: 'Female' },
  { value: 'OTHER', label: 'Other' },
] as const;

function initialValues(mode: EmployeeFormMode): FormValues {
  if (mode.kind === 'edit') {
    const e = mode.employee;
    return {
      email: e.email,
      password: '',
      role: 'EMPLOYEE',
      employeeCode: e.employeeCode,
      employmentStatus: e.employmentStatus === 'ACTIVE' ? 'ACTIVE' : 'PROBATION',
      firstName: e.firstName,
      lastName: e.lastName,
      phone: e.phone ?? '',
      dateOfBirth: e.dateOfBirth ?? '',
      gender: e.gender ?? '',
      address: e.address ?? '',
      hireDate: e.hireDate,
      departmentId: e.department?.id ?? '',
      positionId: e.position?.id ?? '',
      baseSalary: e.baseSalary ?? 0,
    };
  }

  return {
    email: '',
    password: '',
    role: 'EMPLOYEE',
    employeeCode: mode.suggestedCode ?? '',
    employmentStatus: 'PROBATION',
    firstName: '',
    lastName: '',
    phone: '',
    dateOfBirth: '',
    gender: '',
    address: '',
    hireDate: new Date().toISOString().slice(0, 10),
    departmentId: '',
    positionId: '',
    baseSalary: '',
  };
}

export function EmployeeForm({
  mode,
  onSuccess,
  onCancel,
}: {
  mode: EmployeeFormMode;
  onSuccess: (employee: Employee, message: string) => void;
  onCancel: () => void;
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const isCreate = mode.kind === 'create';

  const schema = isCreate ? createSchema : recordSchema;

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: initialValues(mode),
  });

  // Same keys the register page uses, so React Query serves both from one fetch.
  const departments = useQuery({
    queryKey: ['departments', 'all'],
    queryFn: () => fetchPage<Department>('/departments', { pageSize: 100 }),
    staleTime: 5 * 60 * 1000,
  });

  const positions = useQuery({
    queryKey: ['positions', 'all'],
    queryFn: () => fetchPage<Position>('/positions', { pageSize: 100 }),
    staleTime: 5 * 60 * 1000,
  });

  const save = useMutation({
    mutationFn: async (values: FormValues) => {
      // The resolver has already validated, but its result is typed as the raw
      // inputs. Parsing once more yields the transformed payload — empty
      // selections dropped, salary as a number — which is what the API expects.
      const payload: CreateValues | RecordValues = schema.parse(values);
      const response = isCreate
        ? await api.post<{ data: Employee }>('/employees', payload)
        : await api.patch<{ data: Employee }>(`/employees/${mode.employee.id}`, payload);
      return response.data.data;
    },
    onSuccess: (employee) => {
      void queryClient.invalidateQueries({ queryKey: ['employees'] });
      // Headcounts on the departments page and the dashboard both moved.
      void queryClient.invalidateQueries({ queryKey: ['departments'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      onSuccess(
        employee,
        isCreate
          ? `${employee.fullName} added as ${employee.employeeCode}.`
          : `${employee.fullName} updated.`,
      );
    },
  });

  const errors = form.formState.errors;
  // HR manages people, ADMIN manages access: only an administrator may create
  // an HR or ADMIN account. The server enforces this; the form just does not
  // offer what would be refused.
  const canGrantElevatedRoles = user?.role === 'ADMIN';

  return (
    <form
      onSubmit={form.handleSubmit((values) => save.mutate(values))}
      className="grid gap-4 sm:grid-cols-2"
      noValidate
    >
      {isCreate && (
        <>
          <div className="sm:col-span-2 border-b border-slate-100 pb-1 text-xs font-medium uppercase tracking-wide text-slate-400">
            Account
          </div>

          <Field label="Email" error={errors.email?.message}>
            <Input type="email" autoComplete="off" placeholder="name@company.com" {...form.register('email')} />
          </Field>

          <Field
            label="Initial password"
            error={errors.password?.message}
            hint="At least 10 characters. The employee can change it after signing in."
          >
            <Input type="password" autoComplete="new-password" {...form.register('password')} />
          </Field>

          <Field
            label="Role"
            error={errors.role?.message}
            hint={canGrantElevatedRoles ? undefined : 'Only an administrator can create HR or admin accounts.'}
          >
            <Select disabled={!canGrantElevatedRoles} {...form.register('role')}>
              <option value="EMPLOYEE">Employee</option>
              {canGrantElevatedRoles && <option value="HR">HR</option>}
              {canGrantElevatedRoles && <option value="ADMIN">Admin</option>}
            </Select>
          </Field>

          <Field label="Employee code" error={errors.employeeCode?.message}>
            <Input placeholder="EMP0501" className="uppercase" {...form.register('employeeCode')} />
          </Field>

          <div className="sm:col-span-2 border-b border-slate-100 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-slate-400">
            HR record
          </div>
        </>
      )}

      <Field label="First name" error={errors.firstName?.message}>
        <Input {...form.register('firstName')} />
      </Field>

      <Field label="Last name" error={errors.lastName?.message}>
        <Input {...form.register('lastName')} />
      </Field>

      <Field label="Department" error={errors.departmentId?.message}>
        <Select {...form.register('departmentId')}>
          <option value="">Unassigned</option>
          {departments.data?.items
            .filter((d) => d.isActive)
            .map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
        </Select>
      </Field>

      <Field label="Position" error={errors.positionId?.message}>
        <Select {...form.register('positionId')}>
          <option value="">Unassigned</option>
          {positions.data?.items
            .filter((p) => p.isActive)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.title} · {p.level.toLowerCase()}
              </option>
            ))}
        </Select>
      </Field>

      <Field label="Hire date" error={errors.hireDate?.message}>
        <Input type="date" {...form.register('hireDate')} />
      </Field>

      {isCreate && (
        <Field label="Status" error={errors.employmentStatus?.message}>
          <Select {...form.register('employmentStatus')}>
            <option value="PROBATION">Probation</option>
            <option value="ACTIVE">Active</option>
          </Select>
        </Field>
      )}

      <Field label="Base salary (VND / month)" error={errors.baseSalary?.message}>
        <Input type="number" min={0} step={500_000} inputMode="numeric" {...form.register('baseSalary')} />
      </Field>

      <Field label="Phone" error={errors.phone?.message}>
        <Input type="tel" placeholder="09xx xxx xxx" {...form.register('phone')} />
      </Field>

      <Field label="Date of birth" error={errors.dateOfBirth?.message}>
        <Input type="date" {...form.register('dateOfBirth')} />
      </Field>

      <Field label="Gender" error={errors.gender?.message}>
        <Select {...form.register('gender')}>
          <option value="">Not specified</option>
          {GENDERS.map((g) => (
            <option key={g.value} value={g.value}>
              {g.label}
            </option>
          ))}
        </Select>
      </Field>

      <div className="sm:col-span-2">
        <Field label="Address" error={errors.address?.message}>
          <Input {...form.register('address')} />
        </Field>
      </div>

      {save.isError && (
        <div role="alert" className="sm:col-span-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {getErrorMessage(save.error)}
        </div>
      )}

      <div className="sm:col-span-2 flex gap-2">
        <Button type="submit" loading={save.isPending}>
          {isCreate ? 'Create employee' : 'Save changes'}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={save.isPending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
