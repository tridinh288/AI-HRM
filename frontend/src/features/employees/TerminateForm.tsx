import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button, Field, Input, Textarea } from '../../components/ui';
import { api, getErrorMessage } from '../../lib/api';
import type { Employee } from '../../lib/types';

/**
 * Ending someone's employment.
 *
 * Not a delete, and the wording says so: the record stays, the status becomes
 * TERMINATED with a date, and the login is disabled — two writes the server
 * does in one transaction, because doing only the first leaves someone who can
 * still sign in and read HR data.
 *
 * Both fields are optional on the server; the date defaults to today. The
 * reason is stored in the audit log rather than on the employee row, which is
 * where a question about "why did this person leave" should be answered from.
 */

const terminateSchema = z.object({
  terminationDate: z.string(),
  reason: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().trim().max(500, 'Tối đa 500 ký tự').optional(),
  ),
});

type TerminateFields = { terminationDate: string; reason: string };
type TerminateValues = z.infer<typeof terminateSchema>;

export function TerminateForm({
  employee,
  onDone,
  onCancel,
}: {
  employee: Employee;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const queryClient = useQueryClient();

  const form = useForm<TerminateFields>({
    resolver: zodResolver(terminateSchema),
    defaultValues: {
      terminationDate: new Date().toISOString().slice(0, 10),
      reason: '',
    },
  });

  const terminate = useMutation({
    mutationFn: async (fields: TerminateFields) => {
      const payload: TerminateValues = terminateSchema.parse(fields);
      const response = await api.post<{ data: Employee }>(
        `/employees/${employee.id}/terminate`,
        payload,
      );
      return response.data.data;
    },
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: ['employees'] });
      // Headcount on the departments page and the dashboard both moved.
      void queryClient.invalidateQueries({ queryKey: ['departments'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      onDone(`${updated.fullName} đã được ghi nhận nghỉ việc và tài khoản bị khoá.`);
    },
  });

  return (
    <form
      onSubmit={form.handleSubmit((fields) => terminate.mutate(fields))}
      className="space-y-4"
      noValidate
    >
      <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
        Hồ sơ và toàn bộ lịch sử chấm công, nghỉ phép được giữ lại. Tài khoản sẽ không đăng nhập
        được nữa.
      </div>

      <Field label="Ngày nghỉ việc" error={form.formState.errors.terminationDate?.message}>
        <Input type="date" {...form.register('terminationDate')} />
      </Field>

      <Field
        label="Lý do"
        error={form.formState.errors.reason?.message}
        hint="Không bắt buộc — được ghi vào nhật ký kiểm toán, không hiện trên hồ sơ"
      >
        <Textarea rows={2} {...form.register('reason')} />
      </Field>

      {terminate.isError && (
        <div role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {getErrorMessage(terminate.error)}
        </div>
      )}

      <div className="flex gap-2">
        <Button type="submit" variant="danger" loading={terminate.isPending}>
          Xác nhận nghỉ việc
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={terminate.isPending}>
          Huỷ
        </Button>
      </div>
    </form>
  );
}
