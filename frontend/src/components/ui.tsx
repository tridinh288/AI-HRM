import clsx from 'clsx';
import { AlertTriangle, ArrowUpRight, Inbox, Loader2 } from 'lucide-react';
import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { Link } from 'react-router-dom';

/**
 * A small, deliberate set of building blocks.
 *
 * Not a component library — just the pieces this application repeats, in one
 * place so that a button looks the same on every page and a change to focus
 * styling happens once. Anything used only once stays in the page that uses it.
 */

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';

/**
 * Filled buttons carry a shadow tinted with their own colour rather than black.
 * A grey shadow under a violet button reads as dirt; a violet one reads as the
 * button sitting slightly above the page.
 */
const buttonStyles: Record<ButtonVariant, string> = {
  primary:
    'bg-brand-600 text-white shadow-sm shadow-brand-900/25 hover:bg-brand-700 ' +
    'hover:shadow-md hover:shadow-brand-900/25 disabled:bg-brand-300 disabled:shadow-none',
  secondary:
    'bg-white text-slate-700 shadow-xs ring-1 ring-inset ring-slate-200 hover:bg-slate-50 ' +
    'hover:ring-slate-300 disabled:text-slate-400 disabled:shadow-none',
  ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 disabled:text-slate-300',
  danger:
    'bg-rose-600 text-white shadow-sm shadow-rose-900/25 hover:bg-rose-700 ' +
    'disabled:bg-rose-300 disabled:shadow-none',
  success:
    'bg-emerald-600 text-white shadow-sm shadow-emerald-900/25 hover:bg-emerald-700 ' +
    'disabled:bg-emerald-300 disabled:shadow-none',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  className,
  children,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      // A loading button must also be disabled, or a double click sends the
      // request twice — which the API will correctly reject as a conflict, but
      // the user just sees an error they did not cause.
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-xl font-medium',
        // The press is worth animating: a button that moves under the finger
        // confirms the click before the network does.
        'transition-all duration-150 active:scale-[0.98]',
        'disabled:cursor-not-allowed disabled:active:scale-100',
        size === 'sm' ? 'px-3 py-1.5 text-sm' : 'px-4 py-2.5 text-sm',
        buttonStyles[variant],
        className,
      )}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export function Card({
  children,
  className,
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <div
      className={clsx(
        'rounded-2xl border border-slate-200/80 bg-white shadow-sm',
        padded && 'p-5 sm:p-6',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-start justify-between gap-4">
      <div>
        <h2 className="text-base font-semibold tracking-tight text-slate-900">{title}</h2>
        {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-[1.75rem] font-bold leading-tight text-slate-900">{title}</h1>
        {description && <p className="mt-1.5 text-sm text-slate-500">{description}</p>}
      </div>
      {action}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const badgeStyles: Record<BadgeTone, string> = {
  neutral: 'bg-slate-100 text-slate-600 ring-slate-200/70',
  success: 'bg-emerald-50 text-emerald-700 ring-emerald-200/70',
  warning: 'bg-amber-50 text-amber-700 ring-amber-200/70',
  danger: 'bg-rose-50 text-rose-700 ring-rose-200/70',
  info: 'bg-brand-50 text-brand-700 ring-brand-200/70',
};

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset',
        badgeStyles[tone],
      )}
    >
      {children}
    </span>
  );
}

/** Maps domain statuses to a tone, so the same status is never two colours. */
export function StatusBadge({ status }: { status: string }) {
  const tone: BadgeTone =
    status === 'APPROVED' || status === 'ACTIVE' || status === 'PRESENT'
      ? 'success'
      : status === 'PENDING' || status === 'LATE' || status === 'PROBATION'
        ? 'warning'
        : status === 'REJECTED' || status === 'TERMINATED'
          ? 'danger'
          : status === 'ON_LEAVE'
            ? 'info'
            : 'neutral';

  return <Badge tone={tone}>{status.replace(/_/g, ' ').toLowerCase()}</Badge>;
}

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

export function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-slate-700">{label}</span>
      {children}
      {/* role="alert" so a screen reader announces the failure rather than
          leaving it as silently-red text. */}
      {error ? (
        <span role="alert" className="mt-1 block text-sm text-rose-600">
          {error}
        </span>
      ) : hint ? (
        <span className="mt-1 block text-sm text-slate-500">{hint}</span>
      ) : null}
    </label>
  );
}

const controlClass =
  'block w-full rounded-xl border-0 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-xs ' +
  'ring-1 ring-inset ring-slate-200 transition-shadow placeholder:text-slate-400 ' +
  'hover:ring-slate-300 focus:ring-2 focus:ring-inset focus:ring-brand-500 ' +
  'disabled:bg-slate-50 disabled:text-slate-500 disabled:shadow-none';

/*
 * The three controls forward their ref. This is not optional: react-hook-form
 * attaches to a field through the ref that `register()` returns, and React
 * drops `ref` from the props of a plain function component. Without the
 * forward, the form never reaches the DOM element and only learns a value
 * from onChange — so anything that sets a field without an event, browser
 * autofill above all, submits as undefined and fails validation with a bare
 * "Required" while the field visibly holds text.
 */

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} {...props} className={clsx(controlClass, className)} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...props }, ref) {
    return (
      <select ref={ref} {...props} className={clsx(controlClass, 'pr-8', className)}>
        {children}
      </select>
    );
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} {...props} className={clsx(controlClass, 'min-h-24', className)} />;
});

// ---------------------------------------------------------------------------
// State views
// ---------------------------------------------------------------------------

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('h-5 w-5 animate-spin text-brand-600', className)} />;
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-12 text-sm text-slate-500">
      <Spinner />
      {label}
    </div>
  );
}

/**
 * Loading, error and empty are three distinct states, and each gets its own
 * view. Collapsing them — showing an empty table while a request is in flight,
 * or "no results" when the request actually failed — is the most common way a UI
 * lies to the person using it.
 */
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-rose-200/70 bg-rose-50/70 px-6 py-10 text-center">
      <AlertTriangle className="h-6 w-6 text-rose-600" />
      <p className="text-sm text-rose-800">{message}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <div className="mb-1 rounded-2xl bg-slate-100 p-3">
        <Inbox className="h-6 w-6 text-slate-400" />
      </div>
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {description && <p className="max-w-sm text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export function TableWrapper({ children }: { children: ReactNode }) {
  // overflow-x-auto so a wide table scrolls inside its own box rather than
  // pushing the whole page sideways on a narrow screen.
  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-200/80 bg-white shadow-sm">
      <table className="min-w-full divide-y divide-slate-200 text-sm">{children}</table>
    </div>
  );
}

export function Th({ children, align = 'left' }: { children: ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      scope="col"
      className={clsx(
        'whitespace-nowrap px-4 py-3.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500',
        align === 'right' ? 'text-right' : 'text-left',
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = 'left',
  className,
}: {
  children: ReactNode;
  align?: 'left' | 'right';
  className?: string;
}) {
  return (
    <td
      className={clsx(
        'whitespace-nowrap px-4 py-3.5 text-slate-700',
        align === 'right' ? 'text-right tabular' : 'text-left',
        className,
      )}
    >
      {children}
    </td>
  );
}

// ---------------------------------------------------------------------------
// Stat tile
// ---------------------------------------------------------------------------

export function StatCard({
  label,
  value,
  hint,
  tone = 'neutral',
  icon,
  to,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: BadgeTone;
  icon?: ReactNode;
  /** Where the number leads. A figure worth showing is usually worth opening. */
  to?: string;
}) {
  // The number and its icon carry the same tone, so a tile reads as one object
  // rather than a figure that happens to sit beside a grey square.
  const accent = {
    neutral: { value: 'text-slate-900', chip: 'bg-slate-100 text-slate-500' },
    success: { value: 'text-emerald-600', chip: 'bg-emerald-50 text-emerald-600' },
    warning: { value: 'text-amber-600', chip: 'bg-amber-50 text-amber-600' },
    danger: { value: 'text-rose-600', chip: 'bg-rose-50 text-rose-600' },
    info: { value: 'text-brand-600', chip: 'bg-brand-50 text-brand-600' },
  }[tone];

  const body = (
    <>
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-slate-500">{label}</p>
        <p
          className={clsx(
            'mt-2 text-[1.75rem] font-bold leading-none tracking-tight tabular',
            accent.value,
          )}
        >
          {value}
        </p>
        {hint && <p className="mt-2 text-xs text-slate-400">{hint}</p>}
      </div>
      {icon && (
        <div className={clsx('relative shrink-0 rounded-xl p-2.5', accent.chip)}>
          {icon}
          {to && (
            <ArrowUpRight className="absolute -right-1.5 -top-1.5 h-4 w-4 rounded-full bg-white text-brand-500 opacity-0 transition-opacity group-hover:opacity-100" />
          )}
        </div>
      )}
    </>
  );

  if (!to) {
    return <Card className="flex items-start justify-between gap-4">{body}</Card>;
  }

  // A link that looks like the card, not a card with a link inside it: the whole
  // surface is the target, and the hover state says so before the click.
  return (
    <Link
      to={to}
      className={clsx(
        'group flex items-start justify-between gap-4 rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm sm:p-6',
        'transition-all duration-200 hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-md',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
      )}
    >
      {body}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export function Pagination({
  page,
  totalPages,
  total,
  onChange,
}: {
  page: number;
  totalPages: number;
  total: number;
  onChange: (page: number) => void;
}) {
  if (total === 0) return null;

  return (
    <div className="mt-4 flex items-center justify-between gap-4 px-1 text-sm text-slate-500">
      <span>
        Page <span className="font-semibold text-slate-700 tabular">{page}</span> of{' '}
        <span className="font-semibold text-slate-700 tabular">{totalPages}</span>
        <span className="mx-1.5 text-slate-300">·</span>
        <span className="tabular">{total}</span> record{total === 1 ? '' : 's'}
      </span>
      <div className="flex gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
        >
          Previous
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => onChange(page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
