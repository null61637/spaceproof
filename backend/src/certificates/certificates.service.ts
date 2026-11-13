import { randomUUID } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { Certificate } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { computeCertificateHash } from './certificate-hash';
import { CreateCertificateDto } from './dto/create-certificate.dto';

export interface CertificateVerification {
  valid: boolean;
  storedHash: string;
  computedHash: string;
}

@Injectable()
export class CertificatesService {
  constructor(private readonly prisma: PrismaService) {}

  create(dto: CreateCertificateDto): Promise<Certificate> {
    // id and createdAt are generated here (not by the database) because they
    // are part of the hash, which must be stored in the same INSERT.
    const record = {
      id: randomUUID(),
      title: dto.title,
      recipient: dto.recipient,
      createdAt: new Date(),
    };
    return this.prisma.certificate.create({
      data: { ...record, contentHash: computeCertificateHash(record) },
    });
  }

  findAll(): Promise<Certificate[]> {
    return this.prisma.certificate.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async findOne(id: string): Promise<Certificate> {
    const certificate = await this.prisma.certificate.findUnique({
      where: { id },
    });
    if (!certificate) {
      throw new NotFoundException(`Certificate ${id} not found`);
    }
    return certificate;
  }

  async verify(id: string): Promise<CertificateVerification> {
    const certificate = await this.findOne(id);
    const computedHash = computeCertificateHash(certificate);
    return {
      valid: computedHash === certificate.contentHash,
      storedHash: certificate.contentHash,
      computedHash,
    };
  }
}
