import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Request, Response } from 'express';
import { describeDatabaseError } from './database-error';
import { requestIdOf } from './request-id';

/**
 * HTTP errors (4xx and deliberate 5xx) keep Nest's default handling. Anything
 * else is logged once, with the request id and, for database errors, the
 * Prisma code and SQLSTATE, and answered with a generic 500 (or 503 when the
 * database is unreachable). Request bodies are never logged: they hold
 * personal data.
 */
@Catch()
export class AllExceptionsFilter extends BaseExceptionFilter {
  private readonly logger = new Logger('ExceptionsHandler');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (exception instanceof HttpException || host.getType() !== 'http') {
      return super.catch(exception, host);
    }
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const requestId = requestIdOf(req);
    const database = describeDatabaseError(exception);

    this.logger.error({
      message: database ? 'Database error' : 'Unhandled error',
      requestId,
      method: req.method,
      // The matched route pattern (e.g. /api/certificates/:id), not the URL.
      route: (req.route as { path?: string } | undefined)?.path,
      error: exception instanceof Error ? exception.name : typeof exception,
      ...database,
    });
    if (!database && exception instanceof Error) {
      // Programming errors: the stack is what a developer needs.
      this.logger.error(exception.stack);
    }

    const status = database?.unavailable
      ? HttpStatus.SERVICE_UNAVAILABLE
      : HttpStatus.INTERNAL_SERVER_ERROR;
    res.status(status).json({
      statusCode: status,
      message:
        status === HttpStatus.SERVICE_UNAVAILABLE
          ? 'Service unavailable'
          : 'Internal server error',
      requestId,
    });
  }
}
