import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { setupApp } from '../src/app.setup';
import { computeCertificateHash } from '../src/certificates/certificate-hash';
import { PrismaService } from '../src/prisma/prisma.service';

interface CertificateBody {
  id: string;
  title: string;
  recipient: string;
  contentHash: string;
  txHash: string | null;
  createdAt: string;
}

// Runs against spaceproof_test as spaceproof_app, like the real API. Rows are
// never deleted; global-setup.ts rebuilds the database before each run.
describe('Certificates (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  async function createCertificate(title = 'E2E title') {
    const res = await request(app.getHttpServer())
      .post('/api/certificates')
      .send({ title, recipient: 'Ada' })
      .expect(201);
    return res.body as CertificateBody;
  }

  it('creates a certificate with a server-generated SHA-256 and verifies it', async () => {
    const created = await createCertificate('  E2E title  ');

    expect(created).toMatchObject({
      title: 'E2E title',
      recipient: 'Ada',
      txHash: null,
    });
    expect(created.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const row = await prisma.certificate.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.contentHash).toBe(created.contentHash);
    expect(computeCertificateHash(row)).toBe(row.contentHash);

    const fetched = await request(app.getHttpServer())
      .get(`/api/certificates/${created.id}`)
      .expect(200);
    expect(fetched.body).toEqual(created);

    const listed = await request(app.getHttpServer())
      .get('/api/certificates')
      .expect(200);
    const ids = (listed.body as CertificateBody[]).map((c) => c.id);
    expect(ids).toContain(created.id);

    await request(app.getHttpServer())
      .get(`/api/certificates/${created.id}/verify`)
      .expect(200)
      .expect({
        valid: true,
        storedHash: created.contentHash,
        computedHash: created.contentHash,
      });
  });

  it('stores texts in NFC', async () => {
    const created = await createCertificate('José Pérez');
    expect(created.title).toBe('José Pérez'.normalize('NFC'));
  });

  it.each([
    ['unknown id', '00000000-0000-4000-8000-000000000000', 404],
    ['invalid id', 'not-a-uuid', 400],
  ])('returns the right status for %s', async (_label, id, status) => {
    await request(app.getHttpServer())
      .get(`/api/certificates/${id}`)
      .expect(status);
    await request(app.getHttpServer())
      .get(`/api/certificates/${id}/verify`)
      .expect(status);
  });

  it.each([
    ['missing title', { recipient: 'Ada' }],
    ['blank recipient', { title: 'T', recipient: '   ' }],
    ['too long title', { title: 'x'.repeat(201), recipient: 'Ada' }],
    [
      'client-supplied contentHash',
      { title: 'T', recipient: 'Ada', contentHash: 'a'.repeat(64) },
    ],
    ['client-supplied txHash', { title: 'T', recipient: 'Ada', txHash: '0x1' }],
    [
      'client-supplied id',
      {
        title: 'T',
        recipient: 'Ada',
        id: '00000000-0000-4000-8000-000000000009',
      },
    ],
  ])('rejects %s with 400', (_label, payload) => {
    return request(app.getHttpServer())
      .post('/api/certificates')
      .send(payload)
      .expect(400);
  });
});
