import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Certificate } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ANCHOR_TARGET, AnchorReader } from './anchor-reader';
import type { AnchorTarget } from './anchor-reader';
import {
  canonicalizeForVersion,
  computeHashForVersion,
  computeManifestV2Hash,
} from './certificate-hash';
import { IssueCertificateDto } from './dto/issue-certificate.dto';
import type { FileDigest } from './file-upload';

/**
 * A certificate as the API returns it. PostgreSQL BIGINT arrives as a bigint,
 * which JSON cannot represent; a file size always fits a plain number.
 */
export type CertificateRecord = Omit<Certificate, 'fileSizeBytes'> & {
  fileSizeBytes: number | null;
};

function toRecord(certificate: Certificate): CertificateRecord {
  const { fileSizeBytes } = certificate;
  return {
    ...certificate,
    fileSizeBytes: fileSizeBytes === null ? null : Number(fileSizeBytes),
  };
}

type FileCheck = 'MATCH' | 'MISMATCH' | 'NOT_CHECKED';
type RecordCheck = 'MATCH' | 'MISMATCH';
type AnchorCheck =
  | 'ANCHORED'
  | 'NOT_ANCHORED'
  | 'NOT_CONFIGURED'
  | 'UNAVAILABLE'
  | 'NOT_CHECKED';

/** Contract: docs/API_EMISION_VERIFICACION.md. */
export interface CertificateVerification {
  status: 'VALID' | 'INVALID' | 'PENDING' | 'UNVERIFIABLE';
  reason:
    | 'FILE_MISMATCH'
    | 'RECORD_MISMATCH'
    | 'NOT_ANCHORED'
    | 'ANCHOR_NOT_CONFIGURED'
    | 'ANCHOR_UNAVAILABLE'
    | null;
  checks: { file: FileCheck; record: RecordCheck; anchor: AnchorCheck };
  hashVersion: number;
  storedHash: string;
  computedHash: string;
  /** null when no file was presented. */
  file: {
    storedSha256: string;
    receivedSha256: string;
    receivedSizeBytes: number;
  } | null;
  anchoredAt: Date | null;
}

/** A certificate that has a file (hash version 2). */
export type FileCertificate = CertificateRecord & { fileSha256: string };

@Injectable()
export class CertificatesService {
  private readonly logger = new Logger(CertificatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly anchorReader: AnchorReader,
    @Inject(ANCHOR_TARGET) private readonly anchorTarget: AnchorTarget | null,
  ) {}

  /**
   * Issues the certificate of a file that was received completely: `file` is
   * the digest of the whole body. A single write at the end, so an upload
   * that fails or is interrupted leaves nothing behind.
   *
   * When a contract is configured, the certificate is created together with
   * its anchoring record (PENDING: nothing has been sent to the chain), in
   * one database transaction: both rows exist, or neither does.
   */
  async issue(
    dto: IssueCertificateDto,
    file: FileDigest,
  ): Promise<CertificateRecord> {
    // id and createdAt are generated here (not by the database) because they
    // are part of the manifest, whose hash is stored in the same INSERT.
    const record = {
      id: randomUUID(),
      createdAt: new Date(),
      fileSha256: file.sha256,
      fileSizeBytes: file.sizeBytes,
      title: dto.title,
      recipient: dto.recipient,
      satellite: dto.satellite,
      sensor: dto.sensor,
      sceneId: dto.sceneId,
      acquiredAt: dto.acquiredAt,
    };
    return toRecord(
      await this.prisma.certificate.create({
        data: {
          ...record,
          hashVersion: 2,
          fileName: dto.fileName,
          contentHash: computeManifestV2Hash(record),
          // A nested write: Prisma runs both INSERTs in one transaction. The
          // database defaults make the row PENDING and empty.
          ...(this.anchorTarget === null
            ? {}
            : {
                anchor: {
                  create: {
                    chainId: this.anchorTarget.chainId,
                    contractAddress: this.anchorTarget.contractAddress,
                  },
                },
              }),
        },
      }),
    );
  }

  async findAll(): Promise<CertificateRecord[]> {
    const certificates = await this.prisma.certificate.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return certificates.map(toRecord);
  }

  async findOne(id: string): Promise<CertificateRecord> {
    const certificate = await this.prisma.certificate.findUnique({
      where: { id },
    });
    if (!certificate) {
      throw new NotFoundException(`Certificate ${id} not found`);
    }
    return toRecord(certificate);
  }

  /** The certificate a file can be verified against; 409 for version 1. */
  async findFileCertificate(id: string): Promise<FileCertificate> {
    const certificate = await this.findOne(id);
    if (certificate.fileSha256 === null) {
      throw new ConflictException(`Certificate ${id} has no file`);
    }
    return { ...certificate, fileSha256: certificate.fileSha256 };
  }

  /** The exact text whose SHA-256 is the certificate's contentHash. */
  async manifest(id: string): Promise<string> {
    return canonicalizeForVersion(await this.findOne(id));
  }

  /** Verifies the stored record and its anchoring, without a file. */
  async verify(id: string): Promise<CertificateVerification> {
    return this.check(await this.findOne(id));
  }

  /** Verifies a presented file against a certificate, plus the above. */
  verifyFile(
    certificate: FileCertificate,
    file: FileDigest,
  ): Promise<CertificateVerification> {
    return this.check(certificate, {
      storedSha256: certificate.fileSha256,
      receivedSha256: file.sha256,
      receivedSizeBytes: file.sizeBytes,
    });
  }

  private async check(
    certificate: CertificateRecord,
    file: CertificateVerification['file'] = null,
  ): Promise<CertificateVerification> {
    // Each certificate is verified with the hash function of its own version.
    const computedHash = computeHashForVersion(certificate);
    const checks: CertificateVerification['checks'] = {
      file:
        file === null
          ? 'NOT_CHECKED'
          : file.receivedSha256 === file.storedSha256
            ? 'MATCH'
            : 'MISMATCH',
      record: computedHash === certificate.contentHash ? 'MATCH' : 'MISMATCH',
      anchor: 'NOT_CHECKED',
    };
    const result = (
      status: CertificateVerification['status'],
      reason: CertificateVerification['reason'],
      anchoredAt: Date | null = null,
    ): CertificateVerification => ({
      status,
      reason,
      checks,
      hashVersion: certificate.hashVersion,
      storedHash: certificate.contentHash,
      computedHash,
      file,
      anchoredAt,
    });

    if (checks.file === 'MISMATCH') return result('INVALID', 'FILE_MISMATCH');
    if (checks.record === 'MISMATCH') {
      return result('INVALID', 'RECORD_MISMATCH');
    }

    // VALID needs a positive answer from the chain. Not being able to ask
    // (no integration, RPC failure) is never reported as valid.
    let lookup: Awaited<ReturnType<AnchorReader['lookup']>>;
    try {
      lookup = await this.anchorReader.lookup(certificate.contentHash);
    } catch (error) {
      this.logger.warn({
        message: 'Anchor lookup failed',
        error: error instanceof Error ? error.name : typeof error,
      });
      checks.anchor = 'UNAVAILABLE';
      return result('UNVERIFIABLE', 'ANCHOR_UNAVAILABLE');
    }
    // `?.`: a reader that returns nothing is treated like any unexpected
    // answer, which is never a confirmation.
    switch (lookup?.state) {
      case 'ANCHORED':
        checks.anchor = 'ANCHORED';
        return result('VALID', null, lookup.anchoredAt);
      case 'NOT_ANCHORED':
        checks.anchor = 'NOT_ANCHORED';
        return result('PENDING', 'NOT_ANCHORED');
      default:
        checks.anchor = 'NOT_CONFIGURED';
        return result('UNVERIFIABLE', 'ANCHOR_NOT_CONFIGURED');
    }
  }
}
