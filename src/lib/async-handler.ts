import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Express 4 does not await handler promises, so a rejected promise would
 * otherwise become an unhandled rejection and the request would hang. Every
 * async route is wrapped so rejections reach the error handler.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
