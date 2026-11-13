import { INestApplication, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { assignRequestId } from './common/request-id';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// CSRF protection. Another site can make the browser send form posts
// (urlencoded, multipart) and text/plain bodies without a CORS preflight,
// carrying the user's cached credentials (e.g. Caddy's basic auth). A JSON body
// requires a preflight, which this API never answers (CORS is not enabled), so
// writes must be JSON. Registered before Nest's body parsers.
function requireJsonWrites(req: Request, res: Response, next: NextFunction) {
  if (WRITE_METHODS.has(req.method) && !req.is('application/json')) {
    res.status(415).json({
      statusCode: 415,
      message: 'Content-Type must be application/json',
      error: 'Unsupported Media Type',
    });
    return;
  }
  next();
}

// Shared by main.ts and e2e tests so both run with the same HTTP configuration.
export function setupApp(app: INestApplication): void {
  app.use(assignRequestId);
  app.use(requireJsonWrites);
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
