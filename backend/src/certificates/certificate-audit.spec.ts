import { PrismaClient } from '../generated/prisma/client';
import { auditCertificates } from './certificate-audit';
import {
  computeCertificateHash,
  computeManifestV2Hash,
} from './certificate-hash';

function certificate(n: number) {
  const record = {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    title: `T${n}`,
    recipient: 'R',
    createdAt: new Date('2026-01-02T03:04:05.006Z'),
  };
  return {
    ...record,
    contentHash: computeCertificateHash(record),
    // A version-1 row, as the database returns it.
    hashVersion: 1,
    fileSha256: null,
    fileSizeBytes: null,
    satellite: null,
    sensor: null,
    sceneId: null,
    acquiredAt: null,
  };
}

// A version-2 row whose stored hash matches its manifest.
function fileCertificate(n: number) {
  const record = {
    ...certificate(n),
    hashVersion: 2,
    fileSha256: 'a'.repeat(64),
    fileSizeBytes: 1024n,
    satellite: 'Sentinel-2A',
    acquiredAt: new Date('2026-01-01T14:00:51.000Z'),
  };
  return { ...record, contentHash: computeManifestV2Hash(record) };
}

describe('auditCertificates', () => {
  const rows = [
    certificate(1),
    { ...certificate(2), title: 'Tampered' },
    certificate(3),
    { ...certificate(4), createdAt: new Date(Number.NaN) },
    certificate(5),
    fileCertificate(6),
    { ...fileCertificate(7), satellite: 'Tampered' },
    { ...certificate(8), hashVersion: 3 },
  ];
  const tx = {
    $executeRawUnsafe: jest.fn(),
    certificate: {
      findMany: jest.fn(
        ({ take, cursor }: { take: number; cursor?: { id: string } }) => {
          const start = cursor
            ? rows.findIndex((r) => r.id === cursor.id) + 1
            : 0;
          return Promise.resolve(rows.slice(start, start + take));
        },
      ),
    },
  };
  const prisma = {
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  } as unknown as PrismaClient;

  it('counts valid, invalid and unreadable certificates across batches', async () => {
    await expect(auditCertificates(prisma, 2)).resolves.toEqual({
      total: 8,
      valid: 4,
      invalid: 2,
      errors: 2,
      invalidIds: [rows[1].id, rows[6].id],
      // Unreadable date, and a hash version this code does not know.
      errorIds: [rows[3].id, rows[7].id],
    });
    // 8 rows in batches of 2: 4 full queries and an empty one.
    expect(tx.certificate.findMany).toHaveBeenCalledTimes(5);
  });

  it('reads in a read-only snapshot transaction', async () => {
    await auditCertificates(prisma, 10);
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
    );
  });
});
