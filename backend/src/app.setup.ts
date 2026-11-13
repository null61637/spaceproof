import { INestApplication, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { assignRequestId } from './common/request-id';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// The two routes that take a file as the raw request body (issue and
// verify-file). Case-insensitive with an optional trailing slash, like
// Express routing.
const FILE_ROUTE = /^\/api\/certificates(\/[^/]+\/verify-file)?\/?$/i;

// CSRF protection. Another site can make the browser send form posts
// (urlencoded, multipart) and text/plain bodies without a CORS preflight,
// carrying the user's cached credentials (e.g. Caddy's basic auth). JSON and
// image/tiff bodies require a preflight, which this API never answers (CORS
// is not enabled), so a write must be image/tiff on the file routes and JSON
// anywhere else. Registered before Nest's body parsers, which leave an
// image/tiff body unread for the controller to stream.
function requireWriteContentType(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const expected = FILE_ROUTE.test(req.path)
    ? 'image/tiff'
    : 'application/json';
  if (WRITE_METHODS.has(req.method) && !req.is(expected)) {
    res.status(415).json({
      statusCode: 415,
      message: `Content-Type must be ${expected}`,
      error: 'Unsupported Media Type',
    });
    return;
  }
  next();
}

// How long a rejected upload keeps being read (and discarded) after its
// response was sent.
const LINGER_MS = 5000;

// A response sent before the request body was fully received (a rejected
// upload). Closing at once would reset the connection while the client is
// still sending, and most clients (the Next.js proxy among them) then report
// a network error instead of the response. Reading on without limit would
// accept a body of any size. So what keeps arriving is discarded, unhashed and
// unstored, for a few seconds, and then the connection is closed.
function lingerAfterEarlyResponse(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  res.on('finish', () => {
    if (req.complete) return;
    req.resume();
    const timer = setTimeout(() => req.destroy(), LINGER_MS);
    timer.unref();
    req.once('close', () => clearTimeout(timer));
  });
  next();
}

// Shared by main.ts and e2e tests so both run with the same HTTP configuration.
export function setupApp(app: INestApplication): void {
  app.use(assignRequestId);
  app.use(lingerAfterEarlyResponse);
  app.use(requireWriteContentType);
  app.useGlobalFilters(
    new AllExceptionsFilter(app.get(HttpAdapterHost).httpAdapter),
  );
  // All API routes live under /api; the Next.js frontend proxies /api/* here.
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
}
