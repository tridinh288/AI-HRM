import { zodResolver } from '@hookform/resolvers/zod';
import { Building2 } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';

import { Button, Card, Field, Input } from '../../components/ui';
import { getErrorMessage } from '../../lib/api';
import { useAuth } from './AuthContext';

/**
 * The schema is shared between the runtime check and the form's TypeScript
 * types, so the two cannot drift. The rules here mirror the server's — client
 * validation is for fast feedback, and the server validates again because
 * anything sent from a browser can be sent without one.
 */
const loginSchema = z.object({
  email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

type LoginForm = z.infer<typeof loginSchema>;

const DEMO_ACCOUNTS = [
  { role: 'Admin', email: 'admin@hrm.local' },
  { role: 'HR', email: 'hr@hrm.local' },
  { role: 'Employee', email: 'employee@hrm.local' },
] as const;

const DEMO_PASSWORD = 'DemoPassw0rd!';

export function LoginPage() {
  const { login, status } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  if (status === 'authenticated') {
    return <Navigate to="/" replace />;
  }

  const onSubmit = handleSubmit(async (values) => {
    setServerError(null);
    try {
      await login(values.email, values.password);
      // Return the user to the page they originally asked for, rather than
      // always dumping them on the dashboard.
      const from = (location.state as { from?: string } | null)?.from ?? '/';
      navigate(from, { replace: true });
    } catch (error) {
      setServerError(getErrorMessage(error));
    }
  });

  return (
    <div className="flex min-h-full items-center justify-center bg-slate-100 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-2 text-center">
          <div className="rounded-xl bg-brand-600 p-2.5 text-white">
            <Building2 className="h-6 w-6" />
          </div>
          <h1 className="text-xl font-semibold text-slate-900">HRM People Operations</h1>
          <p className="text-sm text-slate-500">Sign in to continue</p>
        </div>

        <Card>
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <Field label="Email" error={errors.email?.message}>
              <Input
                type="email"
                autoComplete="username"
                autoFocus
                placeholder="you@company.com"
                aria-invalid={Boolean(errors.email)}
                {...register('email')}
              />
            </Field>

            <Field label="Password" error={errors.password?.message}>
              <Input
                type="password"
                autoComplete="current-password"
                placeholder="••••••••"
                aria-invalid={Boolean(errors.password)}
                {...register('password')}
              />
            </Field>

            {serverError && (
              <div role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
                {serverError}
              </div>
            )}

            <Button type="submit" loading={isSubmitting} className="w-full">
              Sign in
            </Button>
          </form>
        </Card>

        <Card className="mt-4 bg-slate-50">
          <p className="text-xs font-medium text-slate-600">Demo accounts</p>
          <p className="mt-0.5 text-xs text-slate-500">
            Seeded by <code className="rounded bg-slate-200 px-1">npm run db:seed</code>. Click one
            to fill the form.
          </p>
          <div className="mt-3 space-y-1.5">
            {DEMO_ACCOUNTS.map((account) => (
              <button
                key={account.email}
                type="button"
                onClick={() => {
                  setValue('email', account.email);
                  setValue('password', DEMO_PASSWORD);
                }}
                className="flex w-full items-center justify-between rounded-lg bg-white px-3 py-2 text-left text-xs ring-1 ring-slate-200 hover:bg-brand-50"
              >
                <span className="font-medium text-slate-700">{account.role}</span>
                <span className="text-slate-500">{account.email}</span>
              </button>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
