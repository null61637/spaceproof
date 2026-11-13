import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { setupApp } from '../src/app.setup';
import { connectAs } from './db';
import { issue, metadata, metadataHeader, tiff } from './files';

const EVIL_ORIGIN = 'https://evil.example';

// A page on another site can make the browser send "simple" requests (no CORS
// preflight) with the user's cached credentials, e.g. Caddy's basic auth:
// form posts (urlencoded or multipart) and text/plain bodies. None of them may
// reach a handler. image/tiff (the file routes) and JSON (any other write)
// need a preflight, which the API never answers; so does the metadata header.
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
      'a multipart form carrying a file',
      (title) =>
        request(app.getHttpServer())
          .post('/api/certificates')
          .set('Origin', EVIL_ORIGIN)
          .field('title', title)
          .attach('file', tiff(), 'escena.tif'),
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
    [
      // Even with the metadata header, which a cross-site request cannot set
      // without a preflight, the content type alone is refused.
      'a text/plain body holding a file, with valid metadata',
      (title) =>
        request(app.getHttpServer())
          .post('/api/certificates')
          .set('Origin', EVIL_ORIGIN)
          .set('Content-Type', 'text/plain')
          .set('X-SpaceProof-Metadata', metadataHeader({ ...metadata, title }))
          .send(tiff().toString('latin1')),
    ],
    [
      'JSON, the retired way of issuing',
      (title) =>
        request(app.getHttpServer())
          .post('/api/certificates')
          .set('Content-Type', 'application/json; charset=utf-8')
          .send(JSON.stringify({ title, recipient: 'Ada' })),
    ],
    [
      'JSON on the route written in another case',
      (title) =>
        request(app.getHttpServer())
          .post('/API/Certificates')
          .send({ title, recipient: 'Ada' }),
    ],
    [
      'JSON on the route with a trailing slash',
      (title) =>
        request(app.getHttpServer())
          .post('/api/certificates/')
          .send({ title, recipient: 'Ada' }),
    ],
  ])('rejects %s with 415 and creates nothing', async (_label, send) => {
    const title = `csrf-${randomUUID()}`;
    await send(title).expect(415);
    expect(await countByTitle(title)).toBe(0);
  });

  it.each([
    ['urlencoded', 'application/x-www-form-urlencoded'],
    ['multipart', 'multipart/form-data; boundary=x'],
    ['text/plain', 'text/plain'],
  ])('rejects a %s body on verify-file with 415', (_label, contentType) =>
    request(app.getHttpServer())
      .post(`/api/certificates/${randomUUID()}/verify-file`)
      .set('Origin', EVIL_ORIGIN)
      .set('Content-Type', contentType)
      .send('x')
      .expect(415),
  );

  it('requires JSON for a write on any other route', () =>
    request(app.getHttpServer())
      .post('/api/health/live')
      .set('Content-Type', 'image/tiff')
      .send(tiff())
      .expect(415));

  it.each([
    'content-type',
    'x-spaceproof-metadata',
    'content-type, x-spaceproof-metadata',
  ])(
    'never answers a cross-origin preflight asking for %s',
    async (requested) => {
      const res = await request(app.getHttpServer())
        .options('/api/certificates')
        .set('Origin', EVIL_ORIGIN)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', requested);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['access-control-allow-headers']).toBeUndefined();
    },
  );

  it.each(['image/tiff', 'IMAGE/TIFF'])(
    'still accepts %s from the app',
    async (contentType) => {
      const title = `tiff-${randomUUID()}`;
      await issue(app, tiff(), { ...metadata, title })
        .set('Content-Type', contentType)
        .expect(201);
      expect(await countByTitle(title)).toBe(1);
    },
  );
});
