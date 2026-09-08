import axios, { AxiosError, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';

/**
 * The HTTP client, and the one piece of genuinely tricky frontend logic in this
 * project: transparent access-token refresh.
 *
 * The access token lives **in memory only**. Not in localStorage — anything a
 * script can read, an XSS can steal, and a token in localStorage survives the
 * tab closing. Keeping it in a module variable means a page refresh loses it,
 * which is exactly why the refresh token exists: it is in an httpOnly cookie the
 * browser sends automatically, and the app trades it for a new access token on
 * startup.
 *
 * The interceptor below handles the other half. When a request comes back 401
 * with TOKEN_EXPIRED, it refreshes once and replays the original request, so the
 * user never sees a failure at the 15-minute mark. The subtlety is that several
 * requests usually fail together — a dashboard fires four at once — and each
 * must not start its own refresh, or the first rotation invalidates the rest and
 * the reuse detector logs everyone out. One shared in-flight promise fixes that.
 */

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:4000/api/v1';

let accessToken: string | null = null;
let onUnauthenticated: (() => void) | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

/** Called when refreshing fails, so the app can send the user back to login. */
export function setUnauthenticatedHandler(handler: () => void): void {
  onUnauthenticated = handler;
}

export const api: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  // Required for the refresh cookie to be sent on cross-origin requests.
  withCredentials: true,
  timeout: 60_000,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config) => {
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
});

/** The single in-flight refresh, shared by every request that needs one. */
let refreshPromise: Promise<string> | null = null;

async function refreshAccessToken(): Promise<string> {
  refreshPromise ??= axios
    .post<{ data: { accessToken: string } }>(
      `${BASE_URL}/auth/refresh`,
      {},
      { withCredentials: true },
    )
    .then((response) => {
      const token = response.data.data.accessToken;
      setAccessToken(token);
      return token;
    })
    .finally(() => {
      refreshPromise = null;
    });

  return refreshPromise;
}

interface RetriableRequest extends InternalAxiosRequestConfig {
  _retried?: boolean;
}

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<ApiErrorBody>) => {
    const original = error.config as RetriableRequest | undefined;
    const code = error.response?.data?.error?.code;

    const shouldRefresh =
      error.response?.status === 401 &&
      code === 'TOKEN_EXPIRED' &&
      original &&
      !original._retried &&
      // Never try to refresh the refresh call itself — that is an infinite loop.
      !original.url?.includes('/auth/refresh');

    if (shouldRefresh) {
      original._retried = true;
      try {
        const token = await refreshAccessToken();
        original.headers.Authorization = `Bearer ${token}`;
        return api(original);
      } catch {
        setAccessToken(null);
        onUnauthenticated?.();
        return Promise.reject(error);
      }
    }

    // A 401 that is not an expiry (revoked, tampered, no session) is terminal.
    if (error.response?.status === 401 && !original?.url?.includes('/auth/login')) {
      setAccessToken(null);
      onUnauthenticated?.();
    }

    return Promise.reject(error);
  },
);

export { refreshAccessToken };

// ---------------------------------------------------------------------------
// Response envelope
// ---------------------------------------------------------------------------

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ApiResponse<T> {
  data: T;
  meta?: PaginationMeta;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

/**
 * Turns any thrown value into a message worth showing a user.
 *
 * The backend always answers with `{ error: { code, message } }`, so the happy
 * path is simple. The other branches matter: a network failure has no response
 * at all, and showing "undefined" there is the kind of small thing that makes an
 * app feel broken.
 */
export function getErrorMessage(error: unknown): string {
  if (axios.isAxiosError<ApiErrorBody>(error)) {
    if (error.response?.data?.error?.message) {
      return error.response.data.error.message;
    }
    if (error.code === 'ECONNABORTED') {
      return 'The request timed out. Please try again.';
    }
    if (!error.response) {
      return 'Cannot reach the server. Check that the API is running.';
    }
    return `Request failed with status ${error.response.status}`;
  }

  if (error instanceof Error) return error.message;
  return 'Something went wrong';
}

export function getErrorCode(error: unknown): string | undefined {
  if (axios.isAxiosError<ApiErrorBody>(error)) {
    return error.response?.data?.error?.code;
  }
  return undefined;
}

/** Unwraps `{ data }` so callers work with the payload directly. */
export async function fetchData<T>(url: string, params?: Record<string, unknown>): Promise<T> {
  const response = await api.get<ApiResponse<T>>(url, { params });
  return response.data.data;
}

/** Keeps `meta` alongside the payload, for paginated lists. */
export async function fetchPage<T>(
  url: string,
  params?: Record<string, unknown>,
): Promise<{ items: T[]; meta: PaginationMeta }> {
  const response = await api.get<ApiResponse<T[]>>(url, { params });
  return {
    items: response.data.data,
    meta: response.data.meta ?? { page: 1, pageSize: 20, total: 0, totalPages: 1 },
  };
}
