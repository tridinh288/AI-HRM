import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Wraps an async route handler so a rejected promise reaches Express's error
 * middleware.
 *
 * Express 4 only forwards errors thrown *synchronously*. An `async` handler that
 * rejects produces an unhandled rejection: the client's request hangs until it
 * times out, and the error handler never runs. This wrapper is three lines and
 * removes an entire class of "the request just hangs" bugs.
 *
 * (Express 5 forwards rejections natively. Kept explicit here so the behaviour
 * does not depend on which major version is installed.)
 */
export function asyncHandler<T extends (req: Request, res: Response, next: NextFunction) => unknown>(
  handler: T,
): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(handler(req, res, next)).catch(next);
  };
}
