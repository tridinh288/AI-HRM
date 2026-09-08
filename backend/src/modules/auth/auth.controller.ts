import type { Request, Response } from 'express';

import { getAuth } from '../../middlewares/auth.js';
import { AppError } from '../../shared/errors.js';
import { sendData, sendNoContent } from '../../shared/http.js';
import * as authService from './auth.service.js';
import { REFRESH_COOKIE_NAME, refreshCookieOptions } from './auth.tokens.js';
import type { ChangePasswordInput, LoginInput } from './auth.schema.js';

/**
 * HTTP concerns only: read the request, call the service, shape the response.
 *
 * The one piece of real logic here is where each token goes, and it is a
 * security decision rather than a business one:
 *
 *   access token  → response body. The frontend keeps it in memory and attaches
 *                   it as a Bearer header. It is short-lived, so an XSS that
 *                   steals it gets at most 15 minutes.
 *   refresh token → httpOnly cookie. JavaScript cannot read it at all, which is
 *                   what keeps an XSS from walking away with a 7-day credential.
 *
 * The refresh token is deliberately never in the JSON body — putting it there
 * would hand it straight back to the scripts the cookie is protecting it from.
 */

function requestMeta(req: Request): authService.RequestMeta {
  return {
    userAgent: req.headers['user-agent'],
    ipAddress: req.ip,
  };
}

function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE_NAME, token, refreshCookieOptions(authService.refreshTokenMaxAgeMs));
}

export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body as LoginInput;
  const session = await authService.login(email, password, requestMeta(req));

  setRefreshCookie(res, session.refreshToken.token);
  sendData(res, {
    accessToken: session.accessToken,
    user: {
      id: session.auth.userId,
      email: session.auth.email,
      role: session.auth.role,
      employeeId: session.auth.employeeId,
    },
  });
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
  if (!token) {
    throw AppError.unauthorized('UNAUTHENTICATED', 'No refresh token provided');
  }

  const session = await authService.refresh(token, requestMeta(req));

  setRefreshCookie(res, session.refreshToken.token);
  sendData(res, {
    accessToken: session.accessToken,
    user: {
      id: session.auth.userId,
      email: session.auth.email,
      role: session.auth.role,
      employeeId: session.auth.employeeId,
    },
  });
}

export async function logout(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
  await authService.logout(token);

  // Clearing must use the same options the cookie was set with, or the browser
  // keeps the original and "logout" silently does nothing.
  res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions(0));
  sendNoContent(res);
}

export async function me(req: Request, res: Response): Promise<void> {
  const auth = getAuth(req);
  sendData(res, await authService.getCurrentUser(auth.userId));
}

export async function changePassword(req: Request, res: Response): Promise<void> {
  const auth = getAuth(req);
  const { currentPassword, newPassword } = req.body as ChangePasswordInput;

  await authService.changePassword(auth.userId, currentPassword, newPassword);

  // Every session was revoked, including this one — clear the cookie so the
  // client is not left holding a token that will be rejected on next use.
  res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions(0));
  sendNoContent(res);
}
