import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';

// Reuse a caller's id (e.g. from a proxy) only if it is short and plain, so it
// cannot inject anything into the logs.
const VALID_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Gives every request an id, echoed in X-Request-Id and in error logs. */
export function assignRequestId(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const id =
    typeof incoming === 'string' && VALID_ID.test(incoming)
      ? incoming
      : randomUUID();
  req.headers[REQUEST_ID_HEADER] = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
}

export function requestIdOf(req: Request): string | undefined {
  const id = req.headers[REQUEST_ID_HEADER];
  return typeof id === 'string' ? id : undefined;
}
