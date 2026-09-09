import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { Button, Field, Input } from '../../components/ui';
import { api, getErrorMessage } from '../../lib/api';
import type { AttendanceRecord } from '../../lib/types';

/**
 * HR correcting an attendance record.
 *
 * The endpoint has existed since the module was written and nothing called it,
 * so a forgotten check-out — which the seed generates on purpose, because it is
 * what really happens — could be seen and never fixed.
 *
 * What the server does with the corrected timestamps is the interesting part:
 * it re-runs the same policy functions a live check-in runs, so late minutes,
 * worked minutes and overtime are recomputed rather than trusted from the
 * client. A corrected record cannot end up claiming LATE with zero late
 * minutes, and this form deliberately sends no derived value.
 *
 * Times are edited in the browser's timezone, which is the one the table
 * already displays them in. The attendance *policy* evaluates in the company
 * timezone, so an HR user in another timezone sees shifted times here exactly
 * as they do everywhere else on the page — a display question the whole app
 * shares, not one this form introduces.
 */

/** An instant as `<input type="datetime-local">` wants it: local wall clock. */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** Back to an absolute instant. A value with no offset is read as local time. */
function toInstant(local: string): string {
  return new Date(local).toISOString();
}

export function CorrectionForm({
  record,
  onDone,
  onCancel,
}: {
  record: AttendanceRecord;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const queryClient = useQueryClient();

  const [checkIn, setCheckIn] = useState(toLocalInput(record.checkInAt));
  const [checkOut, setCheckOut] = useState(toLocalInput(record.checkOutAt));
  const [note, setNote] = useState(record.note ?? '');

  // Mirrors the server's own check, purely for faster feedback; the server
  // rejects the same case with INVALID_DATE_RANGE either way.
  const rangeReversed =
    checkIn !== '' && checkOut !== '' && new Date(checkOut) <= new Date(checkIn);

  const correct = useMutation({
    mutationFn: async () => {
      const response = await api.patch<{ data: AttendanceRecord }>(`/attendance/${record.id}`, {
        checkInAt: checkIn === '' ? null : toInstant(checkIn),
        checkOutAt: checkOut === '' ? null : toInstant(checkOut),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      return response.data.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['attendance'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      onDone(`Đã sửa bản ghi ngày ${record.workDate} của ${record.employeeName}.`);
    },
  });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!rangeReversed) correct.mutate();
      }}
      className="space-y-4"
      noValidate
    >
      <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
        Số phút đi muộn, giờ làm và tăng ca được <strong>tính lại</strong> trên máy chủ từ hai mốc
        thời gian bên dưới — form này không gửi lên bất kỳ con số suy dẫn nào.
      </div>

      <Field label="Giờ vào" hint="Để trống nếu không có bản ghi vào">
        <Input type="datetime-local" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} />
      </Field>

      <Field
        label="Giờ ra"
        error={rangeReversed ? 'Giờ ra phải sau giờ vào' : undefined}
        hint={rangeReversed ? undefined : 'Để trống nếu chưa check-out'}
      >
        <Input
          type="datetime-local"
          value={checkOut}
          onChange={(e) => setCheckOut(e.target.value)}
        />
      </Field>

      <Field label="Ghi chú" hint="Không bắt buộc — vì sao phải sửa">
        <Input
          placeholder="Quên check-out, xác nhận qua quản lý"
          maxLength={255}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>

      {correct.isError && (
        <div role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {getErrorMessage(correct.error)}
        </div>
      )}

      <div className="flex gap-2">
        <Button type="submit" loading={correct.isPending} disabled={rangeReversed}>
          Lưu bản ghi
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={correct.isPending}>
          Huỷ
        </Button>
      </div>
    </form>
  );
}
