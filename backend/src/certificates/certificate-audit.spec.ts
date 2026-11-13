import { PrismaClient } from '../generated/prisma/client';
import { auditCertificates } from './certificate-audit';
import { computeCertificateHash } from './certificate-hash';

function certificate(n: number) {
  const record = {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    title: `T${n}`,
    recipient: 'R',
    createdAt: new Date('2026-01-02T03:04:05.006Z'),
  };
  return { ...record, contentHash: computeCertificateHash(record) };
}

describe('auditCertificates', () => {
  const rows = [
    certificate(1),
    { ...certificate(2), title: 'Tampered' },
    certificate(3),
    { ...certificate(4), createdAt: new Date(Number.NaN) },
    certificate(5),
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
      total: 5,
      valid: 3,
      invalid: 1,
      errors: 1,
      invalidIds: [rows[1].id],
      errorIds: [rows[3].id],
    });
    // 5 rows in batches of 2: 3 queries, the last one short.
    expect(tx.certificate.findMany).toHaveBeenCalledTimes(3);
  });

  it('reads in a read-only snapshot transaction', async () => {
    await auditCertificates(prisma, 10);
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
    );
  });
});
