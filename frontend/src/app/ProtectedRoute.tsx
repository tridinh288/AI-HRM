import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';

import { LoadingState } from '../components/ui';
import { useAuth } from '../features/auth/AuthContext';
import type { Role } from '../lib/types';

/**
 * Route guard.
 *
 * Two cases that are easy to get wrong:
 *
 *  - While the session is still being restored (`status === 'loading'`) this must
 *    render nothing decisive. Treating "not yet known" as "not authenticated"
 *    bounces the user to the login page on every page refresh.
 *  - The attempted path is remembered in navigation state, so signing in returns
 *    the user where they were going instead of to the dashboard.
 *
 * This guard is convenience and clarity, not protection: the data it guards is
 * protected by the API, which checks the token and the role on every request.
 */
export function ProtectedRoute({
  children,
  roles,
}: {
  children: ReactNode;
  roles?: Role[];
}) {
  const { status, user } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return <LoadingState label="Restoring your session…" />;
  }

  if (status === 'unauthenticated' || !user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (roles && !roles.includes(user.role)) {
    return <Navigate to="/attendance" replace />;
  }

  return <>{children}</>;
}
