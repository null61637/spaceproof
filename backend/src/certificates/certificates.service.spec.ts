import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { computeCertificateHash } from './certificate-hash';
import { CertificatesService } from './certificates.service';

describe('CertificatesService', () => {
  let service: CertificatesService;
  const certificate = {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
  };

  const stored = {
    id: '00000000-0000-4000-8000-000000000001',
    title: 'T',
    recipient: 'R',
    createdAt: new Date('2026-01-02T03:04:05.006Z'),
    txHash: null,
    contentHash: '',
    // A version-1 row, as the database returns it.
    hashVersion: 1,
    fileSha256: null,
    fileSizeBytes: null,
    fileName: null,
    satellite: null,
    sensor: null,
    sceneId: null,
    acquiredAt: null,
  };
  stored.contentHash = computeCertificateHash(stored);

  beforeEach(async () => {
    jest.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        CertificatesService,
        { provide: PrismaService, useValue: { certificate } },
      ],
    }).compile();
    service = moduleRef.get(CertificatesService);
  });

  it('creates a certificate with server-generated id, date and hash in one insert', async () => {
    certificate.create.mockImplementation(({ data }: { data: unknown }) =>
      Promise.resolve(data),
    );

    await service.create({ title: 'T', recipient: 'R' });

    expect(certificate.create).toHaveBeenCalledTimes(1);
    const [[{ data }]] = certificate.create.mock.calls as [
      [{ data: typeof stored }],
    ];
    expect(data.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(data.createdAt).toBeInstanceOf(Date);
    expect(data).toMatchObject({ title: 'T', recipient: 'R' });
    expect(data.contentHash).toBe(computeCertificateHash(data));
  });

  it('lists certificates newest first', async () => {
    certificate.findMany.mockResolvedValue([]);
    await expect(service.findAll()).resolves.toEqual([]);
    expect(certificate.findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: 'desc' },
    });
  });

  it('returns a certificate by id', async () => {
    certificate.findUnique.mockResolvedValue(stored);
    await expect(service.findOne(stored.id)).resolves.toEqual(stored);
    expect(certificate.findUnique).toHaveBeenCalledWith({
      where: { id: stored.id },
    });
  });

  it('returns the file size as a plain number (JSON has no bigint)', async () => {
    certificate.findUnique.mockResolvedValue({
      ...stored,
      fileSizeBytes: 209715200n,
    });
    const found = await service.findOne(stored.id);
    expect(found.fileSizeBytes).toBe(209715200);
    expect(() => JSON.stringify(found)).not.toThrow();
  });

  it('throws NotFoundException when the certificate does not exist', async () => {
    certificate.findUnique.mockResolvedValue(null);
    await expect(service.findOne('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('verifies an intact certificate as valid', async () => {
    certificate.findUnique.mockResolvedValue(stored);
    await expect(service.verify(stored.id)).resolves.toEqual({
      valid: true,
      storedHash: stored.contentHash,
      computedHash: stored.contentHash,
    });
  });

  it('reports a tampered certificate as invalid', async () => {
    certificate.findUnique.mockResolvedValue({ ...stored, recipient: 'X' });
    const result = await service.verify(stored.id);
    expect(result.valid).toBe(false);
    expect(result.storedHash).toBe(stored.contentHash);
    expect(result.computedHash).not.toBe(stored.contentHash);
  });

  it('throws NotFoundException when verifying a missing certificate', async () => {
    certificate.findUnique.mockResolvedValue(null);
    await expect(service.verify('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
