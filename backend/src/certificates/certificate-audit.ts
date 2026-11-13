import { PrismaClient } from '../generated/prisma/client';
import { computeHashForVersion } from './certificate-hash';

export interface CertificateAudit {
  total: number;
  valid: number;
  invalid: number;
  errors: number;
  /** Ids only: certificate contents (names) never leave the database. */
  invalidIds: string[];
  errorIds: string[];
}

// Long enough for a full scan; the transaction holds no locks (read only).
const AUDIT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Recomputes the hash of every certificate and compares it with the stored
 * one, like GET /api/certificates/:id/verify. Runs in one READ ONLY,
 * REPEATABLE READ transaction: a consistent snapshot that cannot write.
 */
export function auditCertificates(
  prisma: PrismaClient,
  batchSize = 500,
): Promise<CertificateAudit> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
      );
      const audit: CertificateAudit = {
        total: 0,
        valid: 0,
        invalid: 0,
        errors: 0,
        invalidIds: [],
        errorIds: [],
      };
      let cursor: string | undefined;
      for (;;) {
        const batch = await tx.certificate.findMany({
          select: {
            id: true,
            title: true,
            recipient: true,
            createdAt: true,
            contentHash: true,
            hashVersion: true,
            fileSha256: true,
            fileSizeBytes: true,
            satellite: true,
            sensor: true,
            sceneId: true,
            acquiredAt: true,
          },
          orderBy: { id: 'asc' },
          take: batchSize,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        for (const certificate of batch) {
          audit.total++;
          try {
            if (
              computeHashForVersion(certificate) === certificate.contentHash
            ) {
              audit.valid++;
            } else {
              audit.invalid++;
              audit.invalidIds.push(certificate.id);
            }
          } catch {
            audit.errors++;
            audit.errorIds.push(certificate.id);
          }
        }
        if (batch.length < batchSize) return audit;
        cursor = batch[batch.length - 1].id;
      }
    },
    { timeout: AUDIT_TIMEOUT_MS },
  );
}
