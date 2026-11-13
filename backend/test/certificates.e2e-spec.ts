import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { connect } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { setupApp } from '../src/app.setup';
import {
  ANCHOR_TARGET,
  AnchorReader,
  AnchorTarget,
} from '../src/certificates/anchor-reader';
import { computeManifestV2Hash } from '../src/certificates/certificate-hash';
import { MAX_FILE_BYTES } from '../src/certificates/file-upload';
import { connectAs, pgError } from './db';
import {
  CertificateBody,
  TIFF_SIGNATURE,
  VerificationBody,
  countCertificates,
  insertV1,
  issue,
  metadata,
  metadataHeader,
  openUpload,
  portOf,
  sha256,
  tiff,
  verifyFile,
  writeChunk,
} from './files';

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

// Runs against spaceproof_test as spaceproof_app, like the real API. Rows are
// never deleted; global-setup.ts rebuilds the database before each run.
// Contract under test: docs/API_EMISION_VERIFICACION.md.
describe('Certificates (e2e)', () => {
  let app: INestApplication<App>;
  let db: Client;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    // A real port: some tests write the request body by hand.
    await app.listen(0, '127.0.0.1');
    db = await connectAs('DATABASE_URL');
  });

  afterAll(async () => {
    await db.end();
    await app.close();
  });

  async function issued(file = tiff(), meta: unknown = metadata) {
    const res = await issue(app, file, meta).expect(201);
    return res.body as CertificateBody;
  }

  async function row(id: string) {
    const { rows } = await db.query<Record<string, unknown>>(
      'SELECT * FROM "Certificate" WHERE id = $1',
      [id],
    );
    return rows[0];
  }

  describe('issuing', () => {
    it('certifies a file: server-side SHA-256, manifest hash and one stored row', async () => {
      const file = tiff(300_000);
      const created = await issued(file);

      expect(created).toEqual({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
        createdAt: expect.stringMatching(/^\d{4}-.*Z$/) as string,
        contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
        txHash: null,
        hashVersion: 2,
        fileSha256: sha256(file),
        fileSizeBytes: 300_000,
        ...metadata,
      });
      // The certificate hash is the hash of the manifest, recomputed here.
      expect(created.contentHash).toBe(
        computeManifestV2Hash({
          ...metadata,
          id: created.id,
          createdAt: new Date(created.createdAt),
          fileSha256: sha256(file),
          fileSizeBytes: 300_000,
          acquiredAt: new Date(metadata.acquiredAt),
        }),
      );

      const fetched = await request(app.getHttpServer())
        .get(`/api/certificates/${created.id}`)
        .expect(200);
      expect(fetched.body).toEqual(created);

      const listed = await request(app.getHttpServer())
        .get('/api/certificates')
        .expect(200);
      expect((listed.body as CertificateBody[]).map((c) => c.id)).toContain(
        created.id,
      );
    });

    it('serves the exact manifest text whose SHA-256 is the certificate hash', async () => {
      const file = tiff();
      const created = await issued(file);
      const res = await request(app.getHttpServer())
        .get(`/api/certificates/${created.id}/manifest`)
        .buffer(true)
        .parse((response, done) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => done(null, Buffer.concat(chunks)));
        })
        .expect(200)
        .expect('Content-Type', 'application/json; charset=utf-8');

      const bytes = res.body as Buffer;
      expect(sha256(bytes)).toBe(created.contentHash);
      expect(bytes.toString('utf8')).toBe(
        `{"v":2,"id":"${created.id}","createdAt":"${created.createdAt}",` +
          `"file":{"sha256":"${sha256(file)}","sizeBytes":1024},` +
          `"metadata":{"title":"Escena E2E","recipient":"Ada Lovelace",` +
          `"satellite":"Sentinel-2A","sensor":"MSI",` +
          `"sceneId":"S2A_MSIL2A_20260101T140051",` +
          `"acquiredAt":"2026-01-01T14:00:51.000Z"}}`,
      );
    });

    it('stores texts trimmed and in NFC, and absent optionals as null', async () => {
      const created = await issued(tiff(), {
        title: '  Río Paraná  ',
        recipient: 'José Pérez'.normalize('NFD'),
        satellite: 'Landsat 9',
        sensor: '',
        acquiredAt: '2026-01-01T11:00:51-03:00',
        fileName: 'ESCENA.TIFF',
      });
      expect(created).toMatchObject({
        title: 'Río Paraná',
        recipient: 'José Pérez'.normalize('NFC'),
        sensor: null,
        sceneId: null,
        acquiredAt: '2026-01-01T14:00:51.000Z',
        fileName: 'ESCENA.TIFF',
      });
      // What was stored is what was hashed.
      const verification = await request(app.getHttpServer())
        .get(`/api/certificates/${created.id}/verify`)
        .expect(200);
      expect((verification.body as VerificationBody).checks.record).toBe(
        'MATCH',
      );
    });

    it.each(['49492a00', '4d4d002a', '49492b00', '4d4d002b'])(
      'accepts the TIFF signature %s',
      async (signature) => {
        const file = Buffer.concat([
          Buffer.from(signature, 'hex'),
          Buffer.alloc(64),
        ]);
        expect((await issued(file)).fileSha256).toBe(sha256(file));
      },
    );

    it('issues two different certificates for the same file', async () => {
      const file = tiff();
      const [first, second] = [await issued(file), await issued(file)];
      expect(second.fileSha256).toBe(first.fileSha256);
      expect(second.id).not.toBe(first.id);
      expect(second.contentHash).not.toBe(first.contentHash);
    });

    it('stores only the digest: no column can hold the file', async () => {
      const file = tiff(2 * 1024 * 1024);
      const created = await issued(file);
      const stored = await row(created.id);

      expect(Object.keys(stored).sort()).toEqual(
        [...Object.keys(created)].sort(),
      );
      for (const value of Object.values(stored)) {
        expect(Buffer.isBuffer(value)).toBe(false);
      }
      const size = await db.query<{ bytes: number }>(
        'SELECT pg_column_size(c.*) AS bytes FROM "Certificate" c WHERE id = $1',
        [created.id],
      );
      expect(size.rows[0].bytes).toBeLessThan(1024);

      // No binary or large-object column anywhere in the schema.
      const binary = await db.query(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND data_type IN ('bytea', 'oid')`,
      );
      expect(binary.rows).toEqual([]);
    });

    it('opens no file for writing while it receives and verifies a file', async () => {
      const file = tiff(5 * 1024 * 1024);
      // Warm up first, so lazy module loading does not show up as writes.
      const created = await issued(file);
      await verifyFile(app, created.id, file).expect(200);

      // Spies that call through: every open and write still happens, and is
      // recorded.
      const opens = [
        jest.spyOn(fs, 'open'),
        jest.spyOn(fs, 'openSync'),
        jest.spyOn(fs.promises, 'open'),
      ];
      const writers = [
        jest.spyOn(fs, 'createWriteStream'),
        jest.spyOn(fs, 'writeFile'),
        jest.spyOn(fs, 'writeFileSync'),
        jest.spyOn(fs.promises, 'writeFile'),
        jest.spyOn(fs, 'appendFile'),
        jest.spyOn(fs, 'appendFileSync'),
        jest.spyOn(fs, 'mkdtemp'),
        jest.spyOn(fs, 'mkdtempSync'),
      ];
      const isWrite = (flags: unknown) =>
        typeof flags === 'string'
          ? /[wa+]/.test(flags)
          : typeof flags === 'number' &&
            (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== 0;
      let written: unknown[];
      try {
        const again = await issued(file);
        await verifyFile(app, again.id, file).expect(200);
        written = [
          ...opens.flatMap((spy) =>
            (spy.mock.calls as unknown[][])
              .filter(([, flags]) => isWrite(flags))
              .map(([path]) => path),
          ),
          ...writers.flatMap((spy) =>
            (spy.mock.calls as unknown[][]).map(([path]) => path),
          ),
        ];
      } finally {
        [...opens, ...writers].forEach((spy) => spy.mockRestore());
      }
      expect(written).toEqual([]);
    });

    it.each<[string, unknown]>([
      ['a missing title', { ...metadata, title: undefined }],
      ['a blank recipient', { ...metadata, recipient: '   ' }],
      ['a missing satellite', { ...metadata, satellite: undefined }],
      ['a too long title', { ...metadata, title: 'x'.repeat(201) }],
      ['a date without a zone', { ...metadata, acquiredAt: '2026-01-01' }],
      ['a control character', { ...metadata, title: 'a\u0007b' }],
      ['a file that is not .tif', { ...metadata, fileName: 'escena.png' }],
      ['a client-supplied id', { ...metadata, id: randomUUID() }],
      [
        'a client-supplied contentHash',
        { ...metadata, contentHash: 'a'.repeat(64) },
      ],
      [
        'a client-supplied fileSha256',
        { ...metadata, fileSha256: 'a'.repeat(64) },
      ],
      ['a client-supplied txHash', { ...metadata, txHash: '0x1' }],
      ['metadata that is not an object', [metadata]],
    ])('rejects %s with 400 and stores nothing', async (_label, meta) => {
      const before = await countCertificates(db);
      await issue(app, tiff(), meta).expect(400);
      expect(await countCertificates(db)).toBe(before);
    });

    it.each<[string, Record<string, string>]>([
      ['no metadata header', {}],
      ['a header that is not base64url', { 'X-SpaceProof-Metadata': '{}' }],
      [
        'a header that is not JSON',
        { 'X-SpaceProof-Metadata': Buffer.from('x').toString('base64url') },
      ],
    ])('rejects %s with 400', async (_label, headers) => {
      const before = await countCertificates(db);
      await request(app.getHttpServer())
        .post('/api/certificates')
        .set('Content-Type', 'image/tiff')
        .set(headers)
        .send(tiff())
        .expect(400);
      expect(await countCertificates(db)).toBe(before);
    });

    it('rejects invalid metadata before any byte of the file arrives', async () => {
      // The body is announced and never sent: an answer can only come from
      // the headers.
      const { req, response } = openUpload(app, {
        'Content-Length': 1_000_000,
        'X-SpaceProof-Metadata': metadataHeader({ ...metadata, title: '' }),
      });
      req.flushHeaders();
      const { status, body } = await response;
      req.destroy();
      expect(status).toBe(400);
      expect(JSON.stringify(body)).toContain('title');
    });

    it('answers a rejected upload even while the client keeps sending', async () => {
      // Without a lingering close the client sees a connection reset instead
      // of the 400, which is what a proxy would then report.
      const before = await countCertificates(db);
      const size = 30 * 1024 * 1024;
      const { req, response } = openUpload(app, {
        'Content-Length': size,
        'X-SpaceProof-Metadata': metadataHeader({ ...metadata, title: '' }),
      });
      req.on('error', () => undefined);
      let answered = false;
      void response.then(() => (answered = true));
      const chunk = Buffer.alloc(1024 * 1024, 1);
      // Keeps writing until the answer arrives (or the whole body is sent).
      for (let sent = 0; sent < size && !answered; sent += chunk.length) {
        await Promise.race([writeChunk(req, chunk), response]);
      }
      const { status } = await response;
      req.destroy();
      expect(status).toBe(400);
      expect(await countCertificates(db)).toBe(before);
    });

    it.each([
      ['a PNG', Buffer.from('89504e470d0a1a0a0000', 'hex')],
      ['a text file', Buffer.from('not a tiff at all')],
      ['three bytes', Buffer.from('49492a', 'hex')],
    ])(
      'rejects %s (no TIFF signature) with 415 and stores nothing',
      async (_label, file) => {
        const before = await countCertificates(db);
        const res = await issue(app, file).expect(415);
        expect((res.body as { message: string }).message).toBe(
          'File does not have a TIFF signature',
        );
        expect(await countCertificates(db)).toBe(before);
      },
    );

    it('rejects an empty file with 400 and stores nothing', async () => {
      const before = await countCertificates(db);
      const res = await issue(app, Buffer.alloc(0)).expect(400);
      expect((res.body as { message: string }).message).toBe('File is empty');
      expect(await countCertificates(db)).toBe(before);
    });

    it('rejects JSON, the retired way of issuing, with 415', async () => {
      const before = await countCertificates(db);
      await request(app.getHttpServer())
        .post('/api/certificates')
        .send({ title: 'T', recipient: 'Ada' })
        .expect(415);
      expect(await countCertificates(db)).toBe(before);
    });
  });

  describe('size limit and Content-Length', () => {
    const headers = { 'X-SpaceProof-Metadata': metadataHeader() };

    it('rejects a Content-Length over 200 MB with 413 before reading the body', async () => {
      const before = await countCertificates(db);
      const { req, response } = openUpload(app, {
        ...headers,
        'Content-Length': MAX_FILE_BYTES + 1,
      });
      req.flushHeaders();
      const { status } = await response;
      req.destroy();
      expect(status).toBe(413);
      expect(await countCertificates(db)).toBe(before);
    });

    it('certifies a file sent without Content-Length (chunked)', async () => {
      const file = tiff(200_000);
      const { req, response } = openUpload(app, headers);
      expect(req.getHeader('content-length')).toBeUndefined();
      await writeChunk(req, file.subarray(0, 70_000));
      await writeChunk(req, file.subarray(70_000));
      req.end();
      const { status, body } = await response;
      expect(status).toBe(201);
      expect(body).toMatchObject({
        fileSha256: sha256(file),
        fileSizeBytes: 200_000,
      });
    });

    it('never certifies bytes beyond a Content-Length that understates the body', async () => {
      // HTTP ends the body where Content-Length says; what follows is not part
      // of it (Node reads it as a malformed second request and closes the
      // connection). Whatever happens, no certificate may cover the whole
      // file. Node's client refuses to send such a request: raw socket.
      const file = Buffer.concat([TIFF_SIGNATURE, randomBytes(996)]);
      await new Promise<void>((resolve, reject) => {
        const socket = connect(portOf(app), '127.0.0.1');
        socket.on('data', () => undefined);
        socket.on('error', reject);
        socket.on('close', () => resolve());
        socket.write(
          'POST /api/certificates HTTP/1.1\r\nHost: localhost\r\n' +
            'Content-Type: image/tiff\r\nContent-Length: 600\r\n' +
            `X-SpaceProof-Metadata: ${metadataHeader()}\r\n` +
            'Connection: close\r\n\r\n',
        );
        socket.write(file);
      });
      await settle();

      const { rows } = await db.query<{ sha: string; size: string }>(
        `SELECT "fileSha256" AS sha, "fileSizeBytes" AS size
           FROM "Certificate" WHERE "fileSha256" = ANY($1)`,
        [[sha256(file), sha256(file.subarray(0, 600))]],
      );
      // At most the 600 delimited bytes, certified as exactly that.
      for (const certificate of rows) {
        expect(certificate).toEqual({
          sha: sha256(file.subarray(0, 600)),
          size: '600',
        });
      }
    });

    it('stores nothing when the body is shorter than its Content-Length', async () => {
      const before = await countCertificates(db);
      const { req } = openUpload(app, { ...headers, 'Content-Length': 5000 });
      await writeChunk(req, tiff(1000));
      await settle();
      req.destroy();
      await settle();
      expect(await countCertificates(db)).toBe(before);
    });

    it('stores nothing when a chunked upload is interrupted', async () => {
      const before = await countCertificates(db);
      const { req } = openUpload(app, headers);
      await writeChunk(req, tiff(100_000));
      await settle();
      req.destroy();
      await settle();
      expect(await countCertificates(db)).toBe(before);

      // The server is still healthy afterwards.
      await issued();
    });

    describe('with 200 MB of real data', () => {
      const chunk = Buffer.alloc(1024 * 1024, 5);

      async function upload(totalBytes: number) {
        const { req, response } = openUpload(app, headers);
        await writeChunk(req, TIFF_SIGNATURE);
        let sent = TIFF_SIGNATURE.length;
        while (sent < totalBytes) {
          const part = chunk.subarray(
            0,
            Math.min(chunk.length, totalBytes - sent),
          );
          await writeChunk(req, part);
          sent += part.length;
        }
        return { req, response };
      }

      it('certifies a file of exactly 200 MB, in constant memory', async () => {
        const before = process.memoryUsage().rss;
        const { req, response } = await upload(MAX_FILE_BYTES);
        req.end();
        const { status, body } = await response;
        expect(status).toBe(201);
        expect(body).toMatchObject({ fileSizeBytes: MAX_FILE_BYTES });
        // Client and server share this process: neither kept the 200 MB.
        expect(process.memoryUsage().rss - before).toBeLessThan(
          100 * 1024 * 1024,
        );
      }, 120_000);

      it('rejects one byte more with 413, counted while streaming, and stores nothing', async () => {
        const before = await countCertificates(db);
        // Not ended: the server must answer from the byte count alone.
        const { req, response } = await upload(MAX_FILE_BYTES + 1);
        const { status } = await response;
        req.destroy();
        expect(status).toBe(413);
        await settle();
        expect(await countCertificates(db)).toBe(before);
      }, 120_000);
    });
  });

  describe('verifying a file', () => {
    const file = tiff(150_000);
    let certificate: CertificateBody;

    beforeAll(async () => {
      certificate = await issued(file);
    });

    async function verified(candidate: Buffer, id = certificate.id) {
      const res = await verifyFile(app, id, candidate).expect(200);
      return res.body as VerificationBody;
    }

    it('matches the original, and says the chain could not be checked', async () => {
      expect(await verified(file)).toEqual({
        status: 'UNVERIFIABLE',
        reason: 'ANCHOR_NOT_CONFIGURED',
        checks: { file: 'MATCH', record: 'MATCH', anchor: 'NOT_CONFIGURED' },
        hashVersion: 2,
        storedHash: certificate.contentHash,
        computedHash: certificate.contentHash,
        file: {
          storedSha256: sha256(file),
          receivedSha256: sha256(file),
          receivedSizeBytes: file.length,
        },
        anchoredAt: null,
      });
    });

    it.each<[string, () => Buffer]>([
      [
        'one changed bit',
        () => {
          const copy = Buffer.from(file);
          copy[copy.length - 1] ^= 1;
          return copy;
        },
      ],
      ['one byte less', () => file.subarray(0, file.length - 1)],
      ['one byte more', () => Buffer.concat([file, Buffer.from([0])])],
      [
        'an altered signature',
        () => {
          const copy = Buffer.from(file);
          copy[0] = 0;
          return copy;
        },
      ],
      ['a different file', () => tiff(150_000, 8)],
      ['a file that is not a TIFF', () => Buffer.from('something else')],
    ])('detects %s as FILE_MISMATCH', async (_label, alter) => {
      const candidate = alter();
      expect(await verified(candidate)).toMatchObject({
        status: 'INVALID',
        reason: 'FILE_MISMATCH',
        checks: { file: 'MISMATCH', record: 'MATCH', anchor: 'NOT_CHECKED' },
        file: {
          storedSha256: sha256(file),
          receivedSha256: sha256(candidate),
          receivedSizeBytes: candidate.length,
        },
      });
    });

    it('does not depend on the file name', async () => {
      const renamed = await issued(file, {
        ...metadata,
        fileName: 'otro-nombre.tiff',
      });
      expect((await verified(file, renamed.id)).checks.file).toBe('MATCH');
    });

    it('detects a record whose metadata do not match its hash', async () => {
      // A row whose hash was computed for another satellite (see T13 / T17 in
      // db-privileges): a role that can INSERT can store it.
      const id = randomUUID();
      const createdAt = new Date();
      const contentHash = computeManifestV2Hash({
        ...metadata,
        id,
        createdAt,
        fileSha256: sha256(file),
        fileSizeBytes: file.length,
        acquiredAt: new Date(metadata.acquiredAt),
      });
      await db.query(
        `INSERT INTO "Certificate" (id, title, recipient, "contentHash",
           "createdAt", "hashVersion", "fileSha256", "fileSizeBytes",
           satellite, sensor, "sceneId", "acquiredAt")
         VALUES ($1, $2, $3, $4, $5, 2, $6, $7, 'Forged satellite', $8, $9, $10)`,
        [
          id,
          metadata.title,
          metadata.recipient,
          contentHash,
          createdAt.toISOString(),
          sha256(file),
          file.length,
          metadata.sensor,
          metadata.sceneId,
          metadata.acquiredAt,
        ],
      );
      expect(await verified(file, id)).toMatchObject({
        status: 'INVALID',
        reason: 'RECORD_MISMATCH',
        checks: { file: 'MATCH', record: 'MISMATCH', anchor: 'NOT_CHECKED' },
        storedHash: contentHash,
      });
    });

    it('creates and changes nothing', async () => {
      const before = await db.query('SELECT * FROM "Certificate" ORDER BY id');
      await verified(file);
      await verified(tiff(10));
      const after = await db.query('SELECT * FROM "Certificate" ORDER BY id');
      expect(after.rows).toEqual(before.rows);
    });

    it.each([
      ['an unknown certificate', UNKNOWN_ID, 404],
      ['an id that is not a UUID', 'not-a-uuid', 400],
    ])('answers %s before reading the file', async (_label, id, expected) => {
      const { req, response } = openUpload(
        app,
        { 'Content-Length': 1_000_000 },
        `/api/certificates/${id}/verify-file`,
      );
      req.flushHeaders();
      const { status } = await response;
      req.destroy();
      expect(status).toBe(expected);
    });

    it('rejects an empty file with 400', () =>
      verifyFile(app, certificate.id, Buffer.alloc(0)).expect(400));

    it('rejects a Content-Length over 200 MB with 413', async () => {
      const { req, response } = openUpload(
        app,
        { 'Content-Length': MAX_FILE_BYTES + 1 },
        `/api/certificates/${certificate.id}/verify-file`,
      );
      req.flushHeaders();
      const { status } = await response;
      req.destroy();
      expect(status).toBe(413);
    });

    it.each(['application/json', 'text/plain', 'application/octet-stream'])(
      'rejects the content type %s with 415',
      (contentType) =>
        request(app.getHttpServer())
          .post(`/api/certificates/${certificate.id}/verify-file`)
          .set('Content-Type', contentType)
          .send('{}')
          .expect(415),
    );
  });

  describe('version-1 certificates (issued before files)', () => {
    let legacy: { id: string; contentHash: string; createdAt: Date };

    beforeAll(async () => {
      legacy = await insertV1(db);
    });

    it('are still listed and returned, with no file fields', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/certificates/${legacy.id}`)
        .expect(200);
      expect(res.body).toEqual({
        id: legacy.id,
        title: 'Legacy certificate',
        recipient: 'Ada',
        contentHash: legacy.contentHash,
        txHash: null,
        createdAt: legacy.createdAt.toISOString(),
        hashVersion: 1,
        fileSha256: null,
        fileSizeBytes: null,
        fileName: null,
        satellite: null,
        sensor: null,
        sceneId: null,
        acquiredAt: null,
      });
      const listed = await request(app.getHttpServer())
        .get('/api/certificates')
        .expect(200);
      expect((listed.body as CertificateBody[]).map((c) => c.id)).toContain(
        legacy.id,
      );
    });

    it('still verify with the version-1 hash, keeping the `valid` field', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/certificates/${legacy.id}/verify`)
        .expect(200);
      expect(res.body).toEqual({
        valid: true,
        storedHash: legacy.contentHash,
        computedHash: legacy.contentHash,
        status: 'UNVERIFIABLE',
        reason: 'ANCHOR_NOT_CONFIGURED',
        checks: {
          file: 'NOT_CHECKED',
          record: 'MATCH',
          anchor: 'NOT_CONFIGURED',
        },
        hashVersion: 1,
        file: null,
        anchoredAt: null,
      });
    });

    it('report a tampered record as invalid', async () => {
      const forged = await insertV1(db, 'Forged title', 'Original title');
      const res = await request(app.getHttpServer())
        .get(`/api/certificates/${forged.id}/verify`)
        .expect(200);
      expect(res.body).toMatchObject({
        valid: false,
        status: 'INVALID',
        reason: 'RECORD_MISMATCH',
        storedHash: forged.contentHash,
      });
    });

    it('serve their version-1 canonical form as manifest', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/certificates/${legacy.id}/manifest`)
        .expect(200);
      expect(sha256(res.text)).toBe(legacy.contentHash);
      expect(res.text).toContain('"v":1');
    });

    it('cannot be verified against a file: 409, without reading it', async () => {
      const { req, response } = openUpload(
        app,
        { 'Content-Length': 1_000_000 },
        `/api/certificates/${legacy.id}/verify-file`,
      );
      req.flushHeaders();
      const { status } = await response;
      req.destroy();
      expect(status).toBe(409);
    });
  });

  it.each([
    ['unknown id', UNKNOWN_ID, 404],
    ['invalid id', 'not-a-uuid', 400],
  ])('returns the right status for %s', async (_label, id, status) => {
    for (const suffix of ['', '/verify', '/manifest']) {
      await request(app.getHttpServer())
        .get(`/api/certificates/${id}${suffix}`)
        .expect(status);
    }
  });
});

// The chain is replaced by a fake reader (Nest provider override): no test
// talks to a real network. What is proven here is how each answer of the
// chain, or the lack of one, is reported.
describe('Certificates with a chain reader (e2e)', () => {
  const lookup = jest.fn();
  const file = tiff(50_000);
  let app: INestApplication<App>;
  let certificate: CertificateBody;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AnchorReader)
      .useValue({ lookup })
      .compile();
    app = moduleRef.createNestApplication();
    app.useLogger(false);
    setupApp(app);
    await app.init();
    certificate = (await issue(app, file).expect(201)).body as CertificateBody;
  });

  beforeEach(() => {
    lookup.mockReset();
  });

  afterAll(async () => {
    await app.close();
  });

  async function verified(candidate = file) {
    const res = await verifyFile(app, certificate.id, candidate).expect(200);
    return res.body as VerificationBody;
  }

  it('does not ask the chain to issue a certificate', () => {
    expect(lookup).not.toHaveBeenCalled();
  });

  it('is VALID when the chain confirms the certificate hash', async () => {
    lookup.mockResolvedValue({
      state: 'ANCHORED',
      anchoredAt: new Date('2026-11-13T10:00:00.000Z'),
    });
    expect(await verified()).toMatchObject({
      status: 'VALID',
      reason: null,
      checks: { file: 'MATCH', record: 'MATCH', anchor: 'ANCHORED' },
      anchoredAt: '2026-11-13T10:00:00.000Z',
    });
    expect(lookup).toHaveBeenCalledWith(certificate.contentHash);
  });

  it('is PENDING when the chain does not have the hash', async () => {
    lookup.mockResolvedValue({ state: 'NOT_ANCHORED' });
    expect(await verified()).toMatchObject({
      status: 'PENDING',
      reason: 'NOT_ANCHORED',
      anchoredAt: null,
    });
  });

  it('is UNVERIFIABLE, never VALID, when the RPC fails', async () => {
    lookup.mockRejectedValue(new Error('RPC request failed'));
    const result = await verified();
    expect(result).toMatchObject({
      status: 'UNVERIFIABLE',
      reason: 'ANCHOR_UNAVAILABLE',
      checks: { file: 'MATCH', record: 'MATCH', anchor: 'UNAVAILABLE' },
      anchoredAt: null,
    });

    const record = await request(app.getHttpServer())
      .get(`/api/certificates/${certificate.id}/verify`)
      .expect(200);
    expect(record.body).toMatchObject({
      status: 'UNVERIFIABLE',
      reason: 'ANCHOR_UNAVAILABLE',
      valid: true,
    });
  });

  it('reports an altered file as INVALID even if the certificate is anchored', async () => {
    lookup.mockResolvedValue({ state: 'ANCHORED', anchoredAt: new Date() });
    const altered = Buffer.from(file);
    altered[100] ^= 0xff;
    expect(await verified(altered)).toMatchObject({
      status: 'INVALID',
      reason: 'FILE_MISMATCH',
      anchoredAt: null,
    });
    expect(lookup).not.toHaveBeenCalled();
  });
});

// Issuing when a contract is configured (F6.3): the certificate and its
// PENDING anchoring record are created together or not at all. The target and
// the reader are fakes: nothing here talks to a chain or sends a transaction.
describe('Issuing with anchoring configured (e2e)', () => {
  const target: AnchorTarget = {
    chainId: 43113,
    contractAddress: '0xb5cA7811682676e0B7a8fc568B28dbf6f841c8CF',
  };
  const lookup = jest.fn();
  let app: INestApplication<App>;
  let db: Client;
  let owner: Client;

  async function appWith(anchorTarget: AnchorTarget | null) {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AnchorReader)
      .useValue({ lookup })
      .overrideProvider(ANCHOR_TARGET)
      .useValue(anchorTarget)
      .compile();
    const instance: INestApplication<App> = moduleRef.createNestApplication();
    instance.useLogger(false);
    setupApp(instance);
    await instance.init();
    return instance;
  }

  beforeAll(async () => {
    app = await appWith(target);
    db = await connectAs('DATABASE_URL');
    owner = await connectAs('MIGRATION_DATABASE_URL');
  });

  beforeEach(() => {
    lookup.mockReset();
  });

  afterAll(async () => {
    await db.end();
    await owner.end();
    await app.close();
  });

  async function anchorsOf(certificateId: string) {
    const { rows } = await db.query<Record<string, unknown>>(
      'SELECT * FROM "Anchor" WHERE "certificateId" = $1',
      [certificateId],
    );
    return rows;
  }

  async function counts() {
    const { rows } = await db.query<{ certificates: string; anchors: string }>(
      `SELECT (SELECT count(*) FROM "Certificate") AS certificates,
              (SELECT count(*) FROM "Anchor") AS anchors`,
    );
    return {
      certificates: Number(rows[0].certificates),
      anchors: Number(rows[0].anchors),
    };
  }

  it('creates the certificate and exactly one PENDING anchor for it', async () => {
    const before = await counts();
    const file = tiff(50_000);
    const created = (await issue(app, file).expect(201))
      .body as CertificateBody;

    expect(await counts()).toEqual({
      certificates: before.certificates + 1,
      anchors: before.anchors + 1,
    });
    const anchors = await anchorsOf(created.id);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toMatchObject({
      certificateId: created.id,
      chainId: 43113,
      contractAddress: target.contractAddress,
      // Nothing was sent: no transaction, block or date is recorded.
      status: 'PENDING',
      txHash: null,
      blockNumber: null,
      anchoredAt: null,
      attempts: 0,
      lastError: null,
    });
    expect(anchors[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('issues the same certificate as without anchoring: same response, same hash', async () => {
    const file = tiff(2048, 9);
    const created = (await issue(app, file).expect(201))
      .body as CertificateBody;
    expect(Object.keys(created).sort()).toEqual(
      [
        'acquiredAt',
        'contentHash',
        'createdAt',
        'fileName',
        'fileSha256',
        'fileSizeBytes',
        'hashVersion',
        'id',
        'recipient',
        'satellite',
        'sceneId',
        'sensor',
        'title',
        'txHash',
      ].sort(),
    );
    expect(created).toMatchObject({ hashVersion: 2, txHash: null });
    expect(created.fileSha256).toBe(sha256(file));
    const manifest = await request(app.getHttpServer())
      .get(`/api/certificates/${created.id}/manifest`)
      .expect(200);
    expect(sha256(manifest.text)).toBe(created.contentHash);
    // The anchoring record is not part of what is certified.
    expect(manifest.text).not.toContain('43113');
    expect(manifest.text).not.toContain(target.contractAddress);
  });

  it('gives every certificate its own anchor, also when issued at the same time', async () => {
    const responses = await Promise.all(
      [1, 2, 3, 4, 5].map((fill) => issue(app, tiff(1024, fill)).expect(201)),
    );
    const ids = responses.map((res) => (res.body as CertificateBody).id);
    expect(new Set(ids).size).toBe(5);
    for (const id of ids) {
      const anchors = await anchorsOf(id);
      expect(anchors).toHaveLength(1);
      expect(anchors[0]).toMatchObject({
        certificateId: id,
        status: 'PENDING',
      });
    }
  });

  it('cannot give a certificate a second anchor', async () => {
    const created = (await issue(app).expect(201)).body as CertificateBody;
    const error = await pgError(
      db.query(
        `INSERT INTO "Anchor" (id, "certificateId", "chainId", "contractAddress", "updatedAt")
         VALUES ($1, $2, 43113, $3, now())`,
        [randomUUID(), created.id, target.contractAddress],
      ),
    );
    expect(error.code).toBe('23505');
    expect(await anchorsOf(created.id)).toHaveLength(1);
  });

  it('stores neither row when the anchor cannot be created', async () => {
    // A target the database refuses (CHECK: Fuji only): the anchor INSERT
    // fails after the certificate INSERT, inside the same transaction.
    const broken = await appWith({ ...target, chainId: 43114 });
    try {
      const before = await counts();
      await issue(broken, tiff(4096, 3)).expect(500);
      expect(await counts()).toEqual(before);
      const { rowCount } = await db.query(
        'SELECT 1 FROM "Certificate" WHERE "fileSha256" = $1',
        [sha256(tiff(4096, 3))],
      );
      expect(rowCount).toBe(0);
    } finally {
      await broken.close();
    }
  });

  it('stores neither row when the certificate cannot be created', async () => {
    // A temporary trigger, as the owner, that refuses one specific title.
    const title = `rollback-${randomUUID()}`;
    await owner.query(
      `CREATE FUNCTION e2e_refuse_certificate() RETURNS trigger
       LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused by the test'; END; $$`,
    );
    try {
      await owner.query(
        `CREATE TRIGGER "e2e_refuse_certificate" BEFORE INSERT ON "Certificate"
         FOR EACH ROW WHEN (NEW.title = '${title}')
         EXECUTE FUNCTION e2e_refuse_certificate()`,
      );
      const before = await counts();
      await issue(app, tiff(), { ...metadata, title }).expect(500);
      expect(await counts()).toEqual(before);
      // The same file under another title still goes through, with its anchor.
      const created = (await issue(app).expect(201)).body as CertificateBody;
      expect(await anchorsOf(created.id)).toHaveLength(1);
    } finally {
      await owner.query(
        'DROP TRIGGER IF EXISTS "e2e_refuse_certificate" ON "Certificate"',
      );
      await owner.query('DROP FUNCTION e2e_refuse_certificate()');
    }
  });

  it('stores neither row for an upload that is rejected', async () => {
    const before = await counts();
    await issue(app, tiff(), { ...metadata, satellite: undefined }).expect(400);
    await issue(app, Buffer.from('not a tiff at all')).expect(415);
    expect(await counts()).toEqual(before);
  });

  it('creates no anchor when anchoring is not configured, as before', async () => {
    const disabled = await appWith(null);
    try {
      const before = await counts();
      const created = (await issue(disabled).expect(201))
        .body as CertificateBody;
      expect(await anchorsOf(created.id)).toEqual([]);
      expect(await counts()).toEqual({
        certificates: before.certificates + 1,
        anchors: before.anchors,
      });
    } finally {
      await disabled.close();
    }
  });

  it('keeps verification on the live chain: a PENDING record confirms nothing', async () => {
    const file = tiff(8192, 5);
    const created = (await issue(app, file).expect(201))
      .body as CertificateBody;
    const verified = async () =>
      (await verifyFile(app, created.id, file).expect(200))
        .body as VerificationBody;

    lookup.mockResolvedValue({ state: 'NOT_ANCHORED' });
    expect(await verified()).toMatchObject({
      status: 'PENDING',
      reason: 'NOT_ANCHORED',
      anchoredAt: null,
    });

    lookup.mockRejectedValue(new Error('RPC request failed'));
    expect(await verified()).toMatchObject({
      status: 'UNVERIFIABLE',
      reason: 'ANCHOR_UNAVAILABLE',
    });

    // Only the chain makes it VALID, and reading it does not touch the record.
    lookup.mockResolvedValue({
      state: 'ANCHORED',
      anchoredAt: new Date('2026-11-13T10:00:00.000Z'),
    });
    expect(await verified()).toMatchObject({
      status: 'VALID',
      anchoredAt: '2026-11-13T10:00:00.000Z',
    });
    expect(lookup).toHaveBeenCalledWith(created.contentHash);
    expect((await anchorsOf(created.id))[0]).toMatchObject({
      status: 'PENDING',
      txHash: null,
      anchoredAt: null,
    });
  });
});
