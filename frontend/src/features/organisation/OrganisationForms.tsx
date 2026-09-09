import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button, Field, Input, Select, Textarea } from '../../components/ui';
import { api, getErrorMessage } from '../../lib/api';
import type { Department, Position } from '../../lib/types';

/**
 * Create and edit forms for the two reference tables.
 *
 * Both endpoints have existed since the modules were written; nothing called
 * them, so the only departments and positions a company could ever have were
 * the ones the seed seeded — and the employee form could only offer those.
 *
 * Validation mirrors `department.schema.ts` and `position.schema.ts`. The
 * codes are uppercased on the server for a reason worth repeating here: "eng"
 * and "ENG" must not become two departments.
 */

const POSITION_LEVELS = ['INTERN', 'JUNIOR', 'MID', 'SENIOR', 'LEAD', 'MANAGER'] as const;

/** `<textarea>` yields "" for empty; the API wants the key absent. */
const optionalText = (max: number) =>
  z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().trim().max(max, `Tối đa ${max} ký tự`).optional(),
  );

const departmentSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(2, 'Ít nhất 2 ký tự')
    .max(16, 'Tối đa 16 ký tự')
    .regex(/^[A-Z0-9_-]+$/, 'Chỉ dùng chữ, số, gạch ngang hoặc gạch dưới'),
  name: z.string().trim().min(2, 'Ít nhất 2 ký tự').max(120, 'Tối đa 120 ký tự'),
  description: optionalText(500),
});

const positionSchema = z.object({
  title: z.string().trim().min(2, 'Ít nhất 2 ký tự').max(120, 'Tối đa 120 ký tự'),
  level: z.enum(POSITION_LEVELS),
  description: optionalText(500),
});

type DepartmentValues = z.infer<typeof departmentSchema>;
type PositionValues = z.infer<typeof positionSchema>;

/** Raw input shapes: every control holds a string before the schema coerces it. */
type DepartmentFields = Record<keyof DepartmentValues, string>;
type PositionFields = Record<keyof PositionValues, string>;

interface FormProps<T> {
  /** Absent when creating. */
  existing?: T;
  onDone: (message: string) => void;
  onCancel: () => void;
}

function ServerError({ error }: { error: unknown }) {
  return (
    <div role="alert" className="sm:col-span-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
      {getErrorMessage(error)}
    </div>
  );
}

export function DepartmentForm({ existing, onDone, onCancel }: FormProps<Department>) {
  const queryClient = useQueryClient();
  const isEdit = Boolean(existing);

  const form = useForm<DepartmentFields>({
    resolver: zodResolver(departmentSchema),
    defaultValues: {
      code: existing?.code ?? '',
      name: existing?.name ?? '',
      description: existing?.description ?? '',
    },
  });

  const save = useMutation({
    mutationFn: async (fields: DepartmentFields) => {
      const payload: DepartmentValues = departmentSchema.parse(fields);
      const response = existing
        ? await api.patch<{ data: Department }>(`/departments/${existing.id}`, payload)
        : await api.post<{ data: Department }>('/departments', payload);
      return response.data.data;
    },
    onSuccess: (department) => {
      void queryClient.invalidateQueries({ queryKey: ['departments'] });
      onDone(isEdit ? `Đã cập nhật ${department.name}.` : `Đã thêm phòng ban ${department.name}.`);
    },
  });

  return (
    <form
      onSubmit={form.handleSubmit((fields) => save.mutate(fields))}
      className="grid gap-4 sm:grid-cols-2"
      noValidate
    >
      <Field
        label="Mã phòng ban"
        error={form.formState.errors.code?.message}
        hint={isEdit ? undefined : 'Tự động viết hoa'}
      >
        <Input placeholder="OPS" className="uppercase" {...form.register('code')} />
      </Field>

      <Field label="Tên phòng ban" error={form.formState.errors.name?.message}>
        <Input placeholder="Operations" {...form.register('name')} />
      </Field>

      <div className="sm:col-span-2">
        <Field label="Mô tả" error={form.formState.errors.description?.message}>
          <Textarea rows={2} {...form.register('description')} />
        </Field>
      </div>

      {save.isError && <ServerError error={save.error} />}

      <div className="sm:col-span-2 flex gap-2">
        <Button type="submit" loading={save.isPending}>
          {isEdit ? 'Lưu thay đổi' : 'Thêm phòng ban'}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={save.isPending}>
          Huỷ
        </Button>
      </div>
    </form>
  );
}

export function PositionForm({ existing, onDone, onCancel }: FormProps<Position>) {
  const queryClient = useQueryClient();
  const isEdit = Boolean(existing);

  const form = useForm<PositionFields>({
    resolver: zodResolver(positionSchema),
    defaultValues: {
      title: existing?.title ?? '',
      level: existing?.level ?? 'JUNIOR',
      description: existing?.description ?? '',
    },
  });

  const save = useMutation({
    mutationFn: async (fields: PositionFields) => {
      const payload: PositionValues = positionSchema.parse(fields);
      const response = existing
        ? await api.patch<{ data: Position }>(`/positions/${existing.id}`, payload)
        : await api.post<{ data: Position }>('/positions', payload);
      return response.data.data;
    },
    onSuccess: (position) => {
      void queryClient.invalidateQueries({ queryKey: ['positions'] });
      onDone(isEdit ? `Đã cập nhật ${position.title}.` : `Đã thêm vị trí ${position.title}.`);
    },
  });

  return (
    <form
      onSubmit={form.handleSubmit((fields) => save.mutate(fields))}
      className="grid gap-4 sm:grid-cols-2"
      noValidate
    >
      <Field label="Tên vị trí" error={form.formState.errors.title?.message}>
        <Input placeholder="DevOps Engineer" {...form.register('title')} />
      </Field>

      <Field label="Cấp bậc" error={form.formState.errors.level?.message}>
        <Select {...form.register('level')}>
          {POSITION_LEVELS.map((level) => (
            <option key={level} value={level}>
              {level.toLowerCase()}
            </option>
          ))}
        </Select>
      </Field>

      <div className="sm:col-span-2">
        <Field label="Mô tả" error={form.formState.errors.description?.message}>
          <Textarea rows={2} {...form.register('description')} />
        </Field>
      </div>

      {save.isError && <ServerError error={save.error} />}

      <div className="sm:col-span-2 flex gap-2">
        <Button type="submit" loading={save.isPending}>
          {isEdit ? 'Lưu thay đổi' : 'Thêm vị trí'}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={save.isPending}>
          Huỷ
        </Button>
      </div>
    </form>
  );
}
