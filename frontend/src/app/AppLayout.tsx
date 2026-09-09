import clsx from 'clsx';
import {
  Bot,
  Building2,
  CalendarDays,
  ClipboardCheck,
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
              'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
              isActive
                ? 'bg-brand-50 text-brand-700'
                : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
            )
          }
        >
          <item.icon className="h-4.5 w-4.5" />
          {item.label}
        </NavLink>
      ))}
    </nav>
  );

  const sidebarContent = (
    <div className="flex h-full flex-col gap-6 p-4">
      <div className="flex items-center gap-2.5 px-1">
        <div className="rounded-lg bg-brand-600 p-1.5 text-white">
          <Building2 className="h-5 w-5" />
        </div>
        <span className="font-semibold text-slate-900">HRM</span>
      </div>

      {nav}

      <div className="border-t border-slate-200 pt-4">
        {/* The account block is the link to the profile — the conventional
            place to look for it, and the only page every role shares. */}
        <NavLink
          to="/profile"
          onClick={() => setMobileOpen(false)}
          className={({ isActive }) =>
            clsx(
              'mb-3 flex items-center gap-3 rounded-lg px-1 py-1.5 transition-colors',
              isActive ? 'bg-brand-50' : 'hover:bg-slate-100',
            )
          }
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-600">
            {user ? initials(user.email.split('@')[0] ?? user.email) : '?'}
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-slate-900">{user?.email}</p>
            <Badge tone="info">{user?.role.toLowerCase()}</Badge>
          </div>
        </NavLink>
        <button
          type="button"
          onClick={() => void logout()}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
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
      <aside className="hidden w-60 shrink-0 border-r border-slate-200 bg-white lg:block">
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
          <aside className="absolute inset-y-0 left-0 w-64 bg-white shadow-xl">
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
        <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 lg:hidden">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-100"
            aria-label="Open navigation"
          >
            <Menu className="h-5 w-5" />
          </button>
          <span className="font-semibold text-slate-900">HRM</span>
        </header>

        <main className="flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-7xl">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
