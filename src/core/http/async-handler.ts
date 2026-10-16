import type { NextFunction, Request, RequestHandler, Response } from "express";

/** Wraps an async Express handler so rejected promises reach the error middleware (Express 4 does not do this automatically). */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
