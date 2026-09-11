import clsx from 'clsx';
import {
  Bot,
  Building2,
  CalendarDays,
  ClipboardCheck,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  Users,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';

import { Badge } from '../components/ui';
import { useAuth } from '../features/auth/AuthContext';
import { initials } from '../lib/format';
import type { Role } from '../lib/types';

interface NavItem {
  to: string;
  label: string;
  icon: typeof Users;
  roles?: Role[];
}

/**
 * Navigation is filtered by role.
 *
 * This is **user experience, not security** — hiding a link stops someone
 * stumbling into a page that would only refuse them, but the actual refusal
 * happens on the server. Every endpoint behind these links is tested against the
 * wrong role in the backend's authorization suite.
 */
const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, roles: ['HR', 'ADMIN'] },
  { to: '/attendance', label: 'Attendance', icon: ClipboardCheck },
  { to: '/leave', label: 'Leave', icon: CalendarDays },
  { to: '/employees', label: 'Employees', icon: Users, roles: ['HR', 'ADMIN'] },
  { to: '/departments', label: 'Departments', icon: Building2, roles: ['HR', 'ADMIN'] },
  { to: '/assistant', label: 'HR Assistant', icon: Bot },
  // The one entry ADMIN has and HR does not.
  { to: '/accounts', label: 'Accounts', icon: KeyRound, roles: ['ADMIN'] },
];

export function AppLayout() {
  const { user, logout, hasRole } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);

  const visibleItems = NAV_ITEMS.filter((item) => !item.roles || hasRole(...item.roles));

  const nav = (
    <nav className="flex flex-1 flex-col gap-1">
      {visibleItems.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/'}
          onClick={() => setMobileOpen(false)}
          className={({ isActive }) =>
            clsx(
              'group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium',
              'transition-all duration-150',
              isActive
                ? 'bg-brand-600 text-white shadow-sm shadow-brand-900/25'
                : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
            )
          }
        >
          {({ isActive }) => (
            <>
              <item.icon
                className={clsx(
                  'h-4.5 w-4.5 transition-colors',
                  isActive ? 'text-white' : 'text-slate-400 group-hover:text-brand-600',
                )}
              />
              {item.label}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );

  const sidebarContent = (
    <div className="flex h-full flex-col gap-6 p-4">
      <div className="flex items-center gap-3 px-1 pt-1">
        <div className="rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 p-2 text-white shadow-sm shadow-brand-900/25">
          <Building2 className="h-5 w-5" />
        </div>
        <div className="leading-tight">
          <p className="font-bold tracking-tight text-slate-900">HRM</p>
          <p className="text-[11px] font-medium text-slate-400">People Operations</p>
        </div>
      </div>

      {nav}

      <div className="border-t border-slate-200/70 pt-4">
        {/* The account block is the link to the profile — the conventional
            place to look for it, and the only page every role shares. */}
        <NavLink
          to="/profile"
          onClick={() => setMobileOpen(false)}
          className={({ isActive }) =>
            clsx(
              'mb-2 flex items-center gap-3 rounded-xl p-2 transition-colors',
              isActive ? 'bg-brand-50 ring-1 ring-brand-200/70' : 'hover:bg-slate-100',
            )
          }
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-400 to-brand-600 text-xs font-bold text-white">
            {user ? initials(user.email.split('@')[0] ?? user.email) : '?'}
          </div>
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold text-slate-900">{user?.email}</p>
            <Badge tone="info">{user?.role.toLowerCase()}</Badge>
          </div>
        </NavLink>
        <button
          type="button"
          onClick={() => void logout()}
          className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-slate-500 transition-colors hover:bg-rose-50 hover:text-rose-600"
        >
          <LogOut className="h-4.5 w-4.5" />
          Sign out
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex h-full">
      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 border-r border-slate-300/50 bg-white/55 backdrop-blur-xl lg:block">
        {sidebarContent}
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-slate-900/40"
            onClick={() => setMobileOpen(false)}
            aria-hidden
          />
          <aside className="absolute inset-y-0 left-0 w-64 bg-white shadow-lg">
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              className="absolute right-3 top-3 rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"
              aria-label="Close navigation"
            >
              <X className="h-5 w-5" />
            </button>
            {sidebarContent}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-slate-300/50 bg-white/70 px-4 py-3 backdrop-blur-xl lg:hidden">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="rounded-xl p-1.5 text-slate-600 transition-colors hover:bg-slate-100"
            aria-label="Open navigation"
          >
            <Menu className="h-5 w-5" />
          </button>
          <span className="font-bold tracking-tight text-slate-900">HRM</span>
        </header>

        <main className="flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
          <div className="mx-auto max-w-7xl">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
