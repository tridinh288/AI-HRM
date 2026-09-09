import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, UserPen } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { z } from 'zod';

import {
  Button,
  Card,
  CardHeader,
  ErrorState,
  Field,
  Input,
  LoadingState,
  PageHeader,
  StatusBadge,
} from '../components/ui';
import { useAuth } from '../features/auth/AuthContext';
import { api, fetchData, getErrorMessage } from '../lib/api';
import { formatCurrency, formatDate } from '../lib/format';
import type { Employee } from '../lib/types';

/**
 * The page every role has and only the account owner can use.
 *
 * Both endpoints behind it existed from the start — `PATCH /employees/me` and
 * `POST /auth/change-password`, both covered by the backend suite — with
 * nothing in the UI calling either. Without this page an employee could not
 * change the password HR set for them, which for 500 seeded accounts is not a
 * theoretical gap.
 *
 * The two forms are deliberately separate. Contact details are an ordinary
 * edit; a password change revokes every session for the account, so it ends
 * the visit.
 */

/** Mirrors `updateOwnProfileSchema` on the server — the only fields anyone may change about themselves. */
const contactSchema = z.object({
  phone: z
    .string()
    .trim()
    .regex(/^[0-9+\-\s()]{6,20}$/, 'Nhập số điện thoại hợp lệ')
    .or(z.literal(''))
    .optional(),
  address: z.string().trim().max(255, 'Tối đa 255 ký tự').or(z.literal('')).optional(),
});

type ContactValues = z.infer<typeof contactSchema>;

/** Mirrors `changePasswordSchema`, including the "must differ" rule. */
const passwordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Nhập mật khẩu hiện tại'),
    newPassword: z.string().min(10, 'Ít nhất 10 ký tự').max(128, 'Tối đa 128 ký tự'),
    confirmPassword: z.string().min(1, 'Nhập lại mật khẩu mới'),
  })
  .refine((value) => value.newPassword !== value.currentPassword, {
    path: ['newPassword'],
    message: 'Mật khẩu mới phải khác mật khẩu hiện tại',
  })
  // Confirmation exists only on the client: the server has no use for it, and a
  // typo in a password nobody can read back is otherwise unrecoverable.
  .refine((value) => value.confirmPassword === value.newPassword, {
    path: ['confirmPassword'],
    message: 'Hai mật khẩu không khớp',
  });

type PasswordValues = z.infer<typeof passwordSchema>;

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-slate-100 pb-2">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right font-medium text-slate-900">{value}</dd>
    </div>
  );
}

export function ProfilePage() {
  const { user, logout } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [banner, setBanner] = useState<string | null>(null);

  const profile = useQuery({
    queryKey: ['employees', 'me'],
    queryFn: () => fetchData<Employee>('/employees/me'),
  });

  const contactForm = useForm<ContactValues>({
    resolver: zodResolver(contactSchema),
    values: {
      phone: profile.data?.phone ?? '',
      address: profile.data?.address ?? '',
    },
  });

  const passwordForm = useForm<PasswordValues>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });

  const saveContact = useMutation({
    mutationFn: async (values: ContactValues) => {
      // An emptied field is sent as null to clear it; the server's schema takes
      // absent-or-value, so "" would be rejected as a malformed phone number.
      const response = await api.patch<{ data: Employee }>('/employees/me', {
        phone: values.phone?.trim() ? values.phone.trim() : null,
        address: values.address?.trim() ? values.address.trim() : null,
      });
      return response.data.data;
    },
    onSuccess: () => {
      setBanner('Đã cập nhật thông tin liên hệ.');
      void queryClient.invalidateQueries({ queryKey: ['employees'] });
    },
    onError: () => setBanner(null),
  });

  const changePassword = useMutation({
    mutationFn: async (values: PasswordValues) => {
      await api.post('/auth/change-password', {
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });
    },
    onSuccess: async () => {
      // The server revoked every session for this account, this one included,
      // and cleared the refresh cookie. Staying on the page would leave the
      // user holding a token that fails on its next use, so the visit ends
      // here — with the reason carried to the login page rather than a bare
      // redirect.
      await logout();
      navigate('/login', {
        replace: true,
        state: { notice: 'Đã đổi mật khẩu. Hãy đăng nhập lại bằng mật khẩu mới.' },
      });
    },
  });

  return (
    <>
      <PageHeader title="Hồ sơ của tôi" description="Thông tin cá nhân và mật khẩu đăng nhập" />

      {banner && (
        <div role="status" className="mb-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {banner}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Thông tin nhân sự"
            description="Do HR quản lý — liên hệ HR nếu có gì chưa đúng"
          />

          {profile.isPending ? (
            <LoadingState />
          ) : profile.isError ? (
            <ErrorState
              message={getErrorMessage(profile.error)}
              onRetry={() => void profile.refetch()}
            />
          ) : (
            <>
              <div className="mb-4">
                <p className="text-lg font-semibold text-slate-900">{profile.data.fullName}</p>
                <p className="text-sm text-slate-500">{profile.data.email}</p>
                <div className="mt-2">
                  <StatusBadge status={profile.data.employmentStatus} />
                </div>
              </div>

              <dl className="space-y-3 text-sm">
                <DetailRow label="Mã nhân viên" value={profile.data.employeeCode} />
                <DetailRow label="Phòng ban" value={profile.data.department?.name ?? '—'} />
                <DetailRow label="Vị trí" value={profile.data.position?.title ?? '—'} />
                <DetailRow label="Ngày vào làm" value={formatDate(profile.data.hireDate)} />
                <DetailRow label="Ngày sinh" value={formatDate(profile.data.dateOfBirth)} />
                {/* Present on your own record for every role — the mapper strips
                    it only when someone else is looking. */}
                <DetailRow
                  label="Lương cơ bản"
                  value={
                    profile.data.baseSalary === undefined
                      ? '—'
                      : formatCurrency(profile.data.baseSalary)
                  }
                />
              </dl>
            </>
          )}
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Thông tin liên hệ" description="Hai trường bạn tự sửa được" />

            <form
              onSubmit={contactForm.handleSubmit((values) => saveContact.mutate(values))}
              className="space-y-4"
              noValidate
            >
              <Field label="Số điện thoại" error={contactForm.formState.errors.phone?.message}>
                <Input
                  type="tel"
                  placeholder="09xx xxx xxx"
                  disabled={profile.isPending}
                  {...contactForm.register('phone')}
                />
              </Field>

              <Field label="Địa chỉ" error={contactForm.formState.errors.address?.message}>
                <Input
                  placeholder="Số nhà, đường, quận, thành phố"
                  disabled={profile.isPending}
                  {...contactForm.register('address')}
                />
              </Field>

              {saveContact.isError && (
                <div role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
                  {getErrorMessage(saveContact.error)}
                </div>
              )}

              <Button
                type="submit"
                icon={<UserPen className="h-4 w-4" />}
                loading={saveContact.isPending}
                disabled={profile.isPending || !contactForm.formState.isDirty}
              >
                Lưu thay đổi
              </Button>
            </form>
          </Card>

          <Card>
            <CardHeader
              title="Đổi mật khẩu"
              description="Mọi phiên đăng nhập sẽ bị thu hồi — bạn cần đăng nhập lại ngay sau đó"
            />

            <form
              onSubmit={passwordForm.handleSubmit((values) => changePassword.mutate(values))}
              className="space-y-4"
              noValidate
            >
              <Field
                label="Mật khẩu hiện tại"
                error={passwordForm.formState.errors.currentPassword?.message}
              >
                <Input
                  type="password"
                  autoComplete="current-password"
                  {...passwordForm.register('currentPassword')}
                />
              </Field>

              <Field
                label="Mật khẩu mới"
                error={passwordForm.formState.errors.newPassword?.message}
                hint="Ít nhất 10 ký tự"
              >
                <Input
                  type="password"
                  autoComplete="new-password"
                  {...passwordForm.register('newPassword')}
                />
              </Field>

              <Field
                label="Nhập lại mật khẩu mới"
                error={passwordForm.formState.errors.confirmPassword?.message}
              >
                <Input
                  type="password"
                  autoComplete="new-password"
                  {...passwordForm.register('confirmPassword')}
                />
              </Field>

              {changePassword.isError && (
                <div role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
                  {getErrorMessage(changePassword.error)}
                </div>
              )}

              <Button
                type="submit"
                variant="secondary"
                icon={<KeyRound className="h-4 w-4" />}
                loading={changePassword.isPending}
              >
                Đổi mật khẩu
              </Button>
            </form>
          </Card>

          {user?.employeeId === null && (
            <Card className="bg-slate-50">
              <p className="text-sm text-slate-600">
                Tài khoản này không gắn với hồ sơ nhân sự nào, nên không có thông tin nhân sự để
                hiển thị. Bạn vẫn đổi được mật khẩu.
              </p>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
