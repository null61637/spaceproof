import { createHash, randomUUID } from 'node:crypto';
import { ClientRequest, Server, request as httpRequest } from 'node:http';
import { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import { App } from 'supertest/types';
import { computeCertificateHash } from '../src/certificates/certificate-hash';

// Helpers for the file routes (docs/API_EMISION_VERIFICACION.md).

export const TIFF_SIGNATURE = Buffer.from('49492a00', 'hex');

/** Bytes with a TIFF signature. Not a real image: only the signature is checked. */
export function tiff(sizeBytes = 1024, fill = 7): Buffer {
  const file = Buffer.alloc(sizeBytes, fill);
  TIFF_SIGNATURE.copy(file);
  return file;
}

export const sha256 = (data: Buffer | string): string =>
  createHash('sha256').update(data).digest('hex');

export const metadata = {
  title: 'Escena E2E',
  recipient: 'Ada Lovelace',
  satellite: 'Sentinel-2A',
  sensor: 'MSI',
  sceneId: 'S2A_MSIL2A_20260101T140051',
  acquiredAt: '2026-01-01T14:00:51.000Z',
  fileName: 'escena.tif',
};

export const metadataHeader = (value: unknown = metadata): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

export interface CertificateBody {
  id: string;
  title: string;
  recipient: string;
  contentHash: string;
  txHash: string | null;
  createdAt: string;
  hashVersion: number;
  fileSha256: string | null;
  fileSizeBytes: number | null;
  fileName: string | null;
  satellite: string | null;
  sensor: string | null;
  sceneId: string | null;
  acquiredAt: string | null;
}

export interface VerificationBody {
  status: string;
  reason: string | null;
  checks: { file: string; record: string; anchor: string };
  hashVersion: number;
  storedHash: string;
  computedHash: string;
  file: {
    storedSha256: string;
    receivedSha256: string;
    receivedSizeBytes: number;
  } | null;
  anchoredAt: string | null;
  valid?: boolean;
}

/** POST /api/certificates with a file body and the metadata header. */
export function issue(
  app: INestApplication<App>,
  file: Buffer = tiff(),
  meta: unknown = metadata,
): request.Test {
  return request(app.getHttpServer())
    .post('/api/certificates')
    .set('Content-Type', 'image/tiff')
    .set('X-SpaceProof-Metadata', metadataHeader(meta))
    .send(file);
}

export function verifyFile(
  app: INestApplication<App>,
  id: string,
  file: Buffer,
): request.Test {
  return request(app.getHttpServer())
    .post(`/api/certificates/${id}/verify-file`)
    .set('Content-Type', 'image/tiff')
    .send(file);
}

/**
 * A version-1 certificate, as issued before file certificates existed. The
 * API no longer issues them, so the row is inserted as the runtime role.
 */
export async function insertV1(
  db: Client,
  title = 'Legacy certificate',
  hashedTitle = title,
): Promise<{ id: string; contentHash: string; createdAt: Date }> {
  const id = randomUUID();
  const createdAt = new Date();
  const contentHash = computeCertificateHash({
    id,
    title: hashedTitle,
    recipient: 'Ada',
    createdAt,
  });
  // createdAt as an ISO string: node-postgres would send a Date in local
  // time, and TIMESTAMP (without time zone) stores UTC, as Prisma writes it.
  await db.query(
    `INSERT INTO "Certificate" (id, title, recipient, "contentHash", "createdAt")
     VALUES ($1, $2, 'Ada', $3, $4)`,
    [id, title, contentHash, createdAt.toISOString()],
  );
  return { id, contentHash, createdAt };
}

export async function countCertificates(db: Client): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    'SELECT count(*) AS n FROM "Certificate"',
  );
  return Number(rows[0].n);
}

/** The port of an app started with app.listen(0). */
export function portOf(app: INestApplication<App>): number {
  const server = app.getHttpServer() as unknown as Server;
  return (server.address() as AddressInfo).port;
}

export interface RawResponse {
  status: number;
  body: unknown;
}

/**
 * A request whose body the test writes by hand (or never writes), to control
 * what supertest hides: Content-Length, chunking and the socket itself. The
 * app must be listening on a port.
 */
export function openUpload(
  app: INestApplication<App>,
  headers: Record<string, string | number>,
  path = '/api/certificates',
): { req: ClientRequest; response: Promise<RawResponse> } {
  const req = httpRequest({
    host: '127.0.0.1',
    port: portOf(app),
    path,
    method: 'POST',
    headers: { 'Content-Type': 'image/tiff', ...headers },
  });
  const response = new Promise<RawResponse>((resolve, reject) => {
    req.on('error', reject);
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
        }),
      );
    });
  });
  // The caller decides whether a socket error matters.
  response.catch(() => undefined);
  return { req, response };
}

/** Writes with backpressure, so a large body is never queued in memory. */
export function writeChunk(req: ClientRequest, chunk: Buffer): Promise<void> {
  return new Promise((resolve) => {
    if (req.write(chunk)) resolve();
    else req.once('drain', resolve);
  });
}
