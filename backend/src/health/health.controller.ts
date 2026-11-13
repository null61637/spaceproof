import {
  Controller,
  Get,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { describeDatabaseError } from '../common/database-error';
import { PrismaService } from '../prisma/prisma.service';

// Fail readiness instead of hanging when the database does not answer.
const READY_TIMEOUT_MS = 2000;

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Liveness: the process answers HTTP. Never touches the database. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: the API can serve requests, i.e. PostgreSQL answers SELECT 1. */
  @Get('ready')
  async ready() {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.prisma.$queryRaw`SELECT 1`,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('database timeout')),
            READY_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (error) {
      this.logger.warn({
        message: 'Readiness check failed',
        ...(describeDatabaseError(error) ?? {
          error: error instanceof Error ? error.message : String(error),
        }),
      });
      throw new ServiceUnavailableException({
        status: 'error',
        database: 'unavailable',
      });
    } finally {
      clearTimeout(timer);
    }
    return { status: 'ok', database: 'ok' };
  }
}
