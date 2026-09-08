import { format, parseISO } from 'date-fns';

/** Formatting helpers, so the same value never renders two different ways. */

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  try {
    return format(parseISO(value), 'dd MMM yyyy');
  } catch {
    return value;
  }
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  try {
    return format(parseISO(value), 'dd MMM yyyy, HH:mm');
  } catch {
    return value;
  }
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  try {
    return format(parseISO(value), 'HH:mm');
  } catch {
    return value;
  }
}

/** 510 → "8h 30m". Minutes are how the API reports durations. */
export function formatMinutes(minutes: number | null | undefined): string {
  if (!minutes || minutes <= 0) return '0m';
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours === 0) return `${remainder}m`;
  if (remainder === 0) return `${hours}h`;
  return `${hours}h ${remainder}m`;
}

/**
 * Money, in Vietnamese đồng.
 *
 * `Intl.NumberFormat` rather than hand-rolled grouping: it gets the separators,
 * the symbol and the placement right for the locale, and costs nothing.
 */
export function formatCurrency(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return '—';
  return new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND',
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('en-US').format(value);
}

/** "2026-03" → "Mar 2026", for chart axes. */
export function formatMonth(value: string): string {
  try {
    return format(parseISO(`${value}-01`), 'MMM yy');
  } catch {
    return value;
  }
}

export function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
}

export function todayIso(): string {
  return format(new Date(), 'yyyy-MM-dd');
}

export function firstDayOfMonthIso(): string {
  return format(new Date(), 'yyyy-MM-01');
}
