import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { api, refreshAccessToken, setAccessToken, setUnauthenticatedHandler } from '../../lib/api';
import type { AuthUser, Role } from '../../lib/types';

/**
 * Session state for the whole app.
 *
 * The access token deliberately lives in memory (see lib/api.ts), which means a
 * page refresh starts with no session. `bootstrap` below fixes that: on mount it
 * tries the refresh endpoint once, and the httpOnly cookie the browser sends
 * automatically either produces a new token or does not. That single call is the
 * difference between "refreshing the page logs me out" and a normal app.
 *
 * `status` has three values on purpose. Without a distinct `loading`, the router
 * would see `user === null` during that first call and redirect to the login
 * page before the session had a chance to restore.
 */

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface AuthContextValue {
  user: AuthUser | null;
  status: AuthStatus;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  hasRole: (...roles: Role[]) => boolean;
  isHrOrAdmin: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');
  const queryClient = useQueryClient();
  const bootstrapped = useRef(false);

  const clearSession = useCallback(() => {
    setAccessToken(null);
    setUser(null);
    setStatus('unauthenticated');
    // Cached data belongs to the user who was signed in. Leaving it would show
    // one person's HR records to the next person to log in on this browser.
    queryClient.clear();
  }, [queryClient]);

  useEffect(() => {
    // React 18 StrictMode mounts effects twice in development; without this
    // guard the app fires two refresh calls, and token rotation turns the second
    // into a reuse-detection event that logs the user straight back out.
    if (bootstrapped.current) return;
    bootstrapped.current = true;

    setUnauthenticatedHandler(clearSession);

    void (async () => {
      try {
        await refreshAccessToken();
        const response = await api.get<{ data: AuthUser }>('/auth/me');
        setUser(response.data.data);
        setStatus('authenticated');
      } catch {
        // No valid cookie: a normal first visit, not an error worth showing.
        setAccessToken(null);
        setStatus('unauthenticated');
      }
    })();
  }, [clearSession]);

  const login = useCallback(
    async (email: string, password: string) => {
      const response = await api.post<{ data: { accessToken: string; user: AuthUser } }>(
        '/auth/login',
        { email, password },
      );

      setAccessToken(response.data.data.accessToken);
      setUser(response.data.data.user);
      setStatus('authenticated');
    },
    [],
  );

  const logout = useCallback(async () => {
    try {
      // Tell the server to revoke the refresh token; a client-side-only logout
      // leaves a working session behind.
      await api.post('/auth/logout');
    } catch {
      // Logging out must succeed locally even if the request fails.
    } finally {
      clearSession();
    }
  }, [clearSession]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      status,
      login,
      logout,
      hasRole: (...roles: Role[]) => (user ? roles.includes(user.role) : false),
      isHrOrAdmin: user?.role === 'HR' || user?.role === 'ADMIN',
    }),
    [user, status, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider');
  return context;
}
