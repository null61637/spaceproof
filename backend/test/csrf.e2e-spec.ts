import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { setupApp } from '../src/app.setup';
import { connectAs } from './db';

const EVIL_ORIGIN = 'https://evil.example';

// A page on another site can make the browser send "simple" requests (no CORS
// preflight) with the user's cached credentials, e.g. Caddy's basic auth:
// form posts (urlencoded or multipart) and text/plain bodies. None of them may
// reach a handler. JSON needs a preflight, which the API never answers.
describe('CSRF (e2e)', () => {
  let app: INestApplication<App>;
  let db: Client;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();
    db = await connectAs('DATABASE_URL');
  });

  afterAll(async () => {
    await db.end();
    await app.close();
  });

  async function countByTitle(title: string): Promise<number> {
    const { rows } = await db.query<{ n: string }>(
      'SELECT count(*) AS n FROM "Certificate" WHERE title = $1',
      [title],
    );
    return Number(rows[0].n);
  }

  it.each<[string, (title: string) => request.Test]>([
    [
      'an HTML form (urlencoded)',
      (title) =>
        request(app.getHttpServer())
          .post('/api/certificates')
          .set('Origin', EVIL_ORIGIN)
          .type('form')
          .send({ title, recipient: 'Victim' }),
    ],
    [
      'a multipart form',
      (title) =>
        request(app.getHttpServer())
          .post('/api/certificates')
          .set('Origin', EVIL_ORIGIN)
          .field('title', title)
          .field('recipient', 'Victim'),
    ],
    [
      'a text/plain body holding JSON',
      (title) =>
        request(app.getHttpServer())
          .post('/api/certificates')
          .set('Origin', EVIL_ORIGIN)
          .set('Content-Type', 'text/plain')
          .send(JSON.stringify({ title, recipient: 'Victim' })),
    ],
  ])('rejects %s with 415 and creates nothing', async (_label, send) => {
    const title = `csrf-${randomUUID()}`;
    await send(title).expect(415);
    expect(await countByTitle(title)).toBe(0);
  });

  it('never answers a cross-origin preflight', async () => {
    const res = await request(app.getHttpServer())
      .options('/api/certificates')
      .set('Origin', EVIL_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it.each(['application/json', 'application/json; charset=utf-8'])(
    'still accepts %s from the app',
    async (contentType) => {
      const title = `json-${randomUUID()}`;
      await request(app.getHttpServer())
        .post('/api/certificates')
        .set('Content-Type', contentType)
        .send(JSON.stringify({ title, recipient: 'Ada' }))
        .expect(201);
      expect(await countByTitle(title)).toBe(1);
    },
  );
});
