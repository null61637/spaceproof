import { randomUUID } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { Certificate } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  computeCertificateHash,
  computeHashForVersion,
} from './certificate-hash';
import { CreateCertificateDto } from './dto/create-certificate.dto';

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

export interface CertificateVerification {
  valid: boolean;
  storedHash: string;
  computedHash: string;
}

@Injectable()
export class CertificatesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateCertificateDto): Promise<CertificateRecord> {
    // id and createdAt are generated here (not by the database) because they
    // are part of the hash, which must be stored in the same INSERT.
    const record = {
      id: randomUUID(),
      title: dto.title,
      recipient: dto.recipient,
      createdAt: new Date(),
    };
    return toRecord(
      await this.prisma.certificate.create({
        data: { ...record, contentHash: computeCertificateHash(record) },
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

  async verify(id: string): Promise<CertificateVerification> {
    const certificate = await this.findOne(id);
    // Each certificate is verified with the hash function of its own version.
    const computedHash = computeHashForVersion(certificate);
    return {
      valid: computedHash === certificate.contentHash,
      storedHash: certificate.contentHash,
      computedHash,
    };
  }
}
