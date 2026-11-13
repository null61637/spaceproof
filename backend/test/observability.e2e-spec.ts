import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { setupApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

async function createApp(prisma?: unknown): Promise<INestApplication<App>> {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (prisma) {
    builder = builder.overrideProvider(PrismaService).useValue(prisma);
  }
  const app = (await builder.compile()).createNestApplication<
    INestApplication<App>
  >();
  setupApp(app);
  await app.init();
  return app;
}

describe('Health and observability (e2e)', () => {
  describe('with the real database', () => {
    let app: INestApplication<App>;

    beforeAll(async () => {
      app = await createApp();
    });

    afterAll(async () => {
      await app.close();
    });

    it('GET /api/health/live answers without the database', () =>
      request(app.getHttpServer())
        .get('/api/health/live')
        .expect(200)
        .expect({ status: 'ok' }));

    it('GET /api/health/ready checks PostgreSQL', () =>
      request(app.getHttpServer())
        .get('/api/health/ready')
        .expect(200)
        .expect({ status: 'ok', database: 'ok' }));

    it('gives every response an X-Request-Id', async () => {
      const res = await request(app.getHttpServer()).get('/api').expect(200);
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('keeps a plain incoming request id and replaces an unsafe one', async () => {
      const kept = await request(app.getHttpServer())
        .get('/api')
        .set('X-Request-Id', 'proxy-123');
      expect(kept.headers['x-request-id']).toBe('proxy-123');

      const replaced = await request(app.getHttpServer())
        .get('/api')
        .set('X-Request-Id', 'bad id\twith "quotes"');
      expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe('when the database fails', () => {
    // Same shapes as Prisma 7 with @prisma/adapter-pg (see database-error.spec.ts).
    class PrismaClientKnownRequestError extends Error {
      name = 'PrismaClientKnownRequestError';
      constructor(
        readonly code: string,
        readonly meta?: Record<string, unknown>,
      ) {
        super('Invalid `prisma.certificate.create()` invocation');
      }
    }
    const permissionDenied = new PrismaClientKnownRequestError('P2039', {
      driverAdapterError: {
        cause: {
          kind: 'postgres',
          code: '42501',
          message: 'permission denied for table Certificate',
        },
      },
    });
    const refused = new PrismaClientKnownRequestError('ECONNREFUSED');

    const prisma = {
      certificate: { create: jest.fn(), findMany: jest.fn() },
      $queryRaw: jest.fn(),
      $connect: jest.fn(),
      $disconnect: jest.fn(),
    };
    let app: INestApplication<App>;
    let logged: unknown[];

    beforeAll(async () => {
      app = await createApp(prisma);
    });

    beforeEach(() => {
      logged = [];
      jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation((...args: unknown[]) => {
          logged.push(...args);
        });
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    afterAll(async () => {
      await app.close();
    });

    it('logs a permission error with SQLSTATE and request id, never the body', async () => {
      prisma.certificate.create.mockRejectedValue(permissionDenied);
      const res = await request(app.getHttpServer())
        .post('/api/certificates')
        .set('X-Request-Id', 'req-42')
        .send({ title: 'Secret title', recipient: 'Jane Personal' })
        .expect(500);

      expect(res.body).toEqual({
        statusCode: 500,
        message: 'Internal server error',
        requestId: 'req-42',
      });
      expect(logged).toContainEqual(
        expect.objectContaining({
          message: 'Database error',
          requestId: 'req-42',
          method: 'POST',
          route: '/api/certificates',
          code: 'P2039',
          sqlState: '42501',
          dbMessage: 'permission denied for table Certificate',
        }),
      );
      const text = JSON.stringify(logged);
      expect(text).not.toContain('Secret title');
      expect(text).not.toContain('Jane Personal');
      expect(text).not.toContain('invocation');
    });

    it('answers 503 when PostgreSQL is unreachable', async () => {
      prisma.certificate.findMany.mockRejectedValue(refused);
      const res = await request(app.getHttpServer())
        .get('/api/certificates')
        .expect(503);
      expect(res.body).toMatchObject({
        statusCode: 503,
        message: 'Service unavailable',
      });
      expect(logged).toContainEqual(
        expect.objectContaining({ code: 'ECONNREFUSED', unavailable: true }),
      );
    });

    it('readiness fails while liveness still answers', async () => {
      prisma.$queryRaw.mockRejectedValue(refused);
      await request(app.getHttpServer()).get('/api/health/ready').expect(503);
      await request(app.getHttpServer()).get('/api/health/live').expect(200);
    });

    it('keeps 4xx responses as they were', () =>
      request(app.getHttpServer())
        .get('/api/certificates/not-a-uuid')
        .expect(400));
  });
});
