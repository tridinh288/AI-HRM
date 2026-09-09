import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { AppLayout } from './app/AppLayout';
import { ProtectedRoute } from './app/ProtectedRoute';
import { AuthProvider } from './features/auth/AuthContext';
import { LoginPage } from './features/auth/LoginPage';
import { AssistantPage } from './pages/AssistantPage';
import { AttendancePage } from './pages/AttendancePage';
import { DashboardPage } from './pages/DashboardPage';
import { DepartmentsPage } from './pages/DepartmentsPage';
import { EmployeesPage } from './pages/EmployeesPage';
import { LeavePage } from './pages/LeavePage';
import { ProfilePage } from './pages/ProfilePage';
import { AccountsPage } from './pages/AccountsPage';

/**
 * Query defaults, chosen rather than accepted.
 *
 * `retry: failureCount, error` — retrying a 401 or a 403 is pointless (the
 * answer will not change) and retrying a 409 is actively wrong (it is a business
 * conflict, not a blip). Only genuine failures are retried, and only once.
 *
 * `staleTime: 30s` — HR data does not change second to second, so refetching on
 * every window focus is noise. Mutations invalidate explicitly where freshness
 * actually matters.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        const status = (error as { response?: { status?: number } })?.response?.status;
        if (status && status >= 400 && status < 500) return false;
        return failureCount < 1;
      },
    },
    mutations: { retry: false },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        {/* AuthProvider sits inside the router so it can use navigation, and
            inside QueryClientProvider so logout can clear the cache. */}
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />

            <Route
              element={
                <ProtectedRoute>
                  <AppLayout />
                </ProtectedRoute>
              }
            >
              {/* The dashboard is organisation-wide, so an employee landing on
                  "/" is sent to their own attendance page instead of being shown
                  a 403. */}
              <Route
                index
                element={
                  <ProtectedRoute roles={['HR', 'ADMIN']}>
                    <DashboardPage />
                  </ProtectedRoute>
                }
              />
              <Route path="attendance" element={<AttendancePage />} />
              <Route path="leave" element={<LeavePage />} />
              <Route
                path="employees"
                element={
                  <ProtectedRoute roles={['HR', 'ADMIN']}>
                    <EmployeesPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="departments"
                element={
                  <ProtectedRoute roles={['HR', 'ADMIN']}>
                    <DepartmentsPage />
                  </ProtectedRoute>
                }
              />
              <Route path="assistant" element={<AssistantPage />} />
              {/* No role gate: every account owns a profile, and the page only
                  ever reaches its own record. */}
              <Route path="profile" element={<ProfilePage />} />
              <Route
                path="accounts"
                element={
                  <ProtectedRoute roles={['ADMIN']}>
                    <AccountsPage />
                  </ProtectedRoute>
                }
              />
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
