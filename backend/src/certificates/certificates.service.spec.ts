import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import {
  ANCHOR_TARGET,
  AnchorLookup,
  AnchorReader,
  AnchorTarget,
} from './anchor-reader';
import {
  canonicalizeManifestV2,
  computeCertificateHash,
  computeManifestV2Hash,
} from './certificate-hash';
import { CertificatesModule } from './certificates.module';
import { CertificatesService } from './certificates.service';
import { IssueCertificateDto } from './dto/issue-certificate.dto';

describe('CertificatesService', () => {
  let service: CertificatesService;
  const certificate = {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
  };
  const lookup = jest.fn<Promise<AnchorLookup>, [string]>();

  // A version-1 row, as the database returns it.
  const v1 = {
    id: '00000000-0000-4000-8000-000000000001',
    title: 'T',
    recipient: 'R',
    createdAt: new Date('2026-01-02T03:04:05.006Z'),
    txHash: null,
    contentHash: '',
    hashVersion: 1,
    fileSha256: null,
    fileSizeBytes: null,
    fileName: null,
    satellite: null,
    sensor: null,
    sceneId: null,
    acquiredAt: null,
  };
  v1.contentHash = computeCertificateHash(v1);

  // Vector A of docs/manifiesto-v2.md, as a stored version-2 row.
  const v2 = {
    id: '00000000-0000-4000-8000-000000000001',
    title: 'Escena de prueba',
    recipient: 'José Pérez',
    createdAt: new Date('2026-01-02T03:04:05.006Z'),
    txHash: null,
    contentHash:
      '268d7919b7a4f9abf52122595b8aecaa2caba5d8f13a3fca91f0d770fdc1f846',
    hashVersion: 2,
    fileSha256:
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    fileSizeBytes: 1048576n,
    fileName: 'escena.tif',
    satellite: 'Sentinel-2A',
    sensor: 'MSI',
    sceneId: 'S2A_MSIL2A_20260101T140051',
    acquiredAt: new Date('2026-01-01T14:00:51.000Z'),
  };
  const original = { sha256: v2.fileSha256, sizeBytes: 1048576 };
  const altered = { sha256: 'f'.repeat(64), sizeBytes: 1048576 };

  const metadata: IssueCertificateDto = {
    title: 'Escena',
    recipient: 'Ada',
    satellite: 'Landsat 9',
    sensor: null,
    sceneId: null,
    acquiredAt: new Date('2026-06-15T13:45:00.000Z'),
    fileName: 'escena.tif',
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    lookup.mockResolvedValue({ state: 'NOT_CONFIGURED' });
    service = await serviceWith(null);
  });

  /** The service as wired for an environment with or without a contract. */
  async function serviceWith(
    target: AnchorTarget | null,
  ): Promise<CertificatesService> {
    const moduleRef = await Test.createTestingModule({
      providers: [
        CertificatesService,
        { provide: PrismaService, useValue: { certificate } },
        { provide: AnchorReader, useValue: { lookup } },
        { provide: ANCHOR_TARGET, useValue: target },
      ],
    }).compile();
    return moduleRef.get(CertificatesService);
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('issue', () => {
    type Data = typeof v2 & { fileSizeBytes: number };

    async function issued(dto = metadata, file = original): Promise<Data> {
      certificate.create.mockImplementation(({ data }: { data: Data }) =>
        Promise.resolve({ ...data, fileSizeBytes: BigInt(data.fileSizeBytes) }),
      );
      await service.issue(dto, file);
      expect(certificate.create).toHaveBeenCalledTimes(1);
      const [[{ data }]] = certificate.create.mock.calls as [[{ data: Data }]];
      return data;
    }

    it('stores a version-2 certificate with a server-generated id, date and manifest hash, in one insert', async () => {
      const data = await issued();

      expect(data.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(data.createdAt).toBeInstanceOf(Date);
      expect(data).toMatchObject({
        ...metadata,
        hashVersion: 2,
        fileSha256: original.sha256,
        fileSizeBytes: original.sizeBytes,
      });
      expect(data.contentHash).toBe(computeManifestV2Hash(data));
    });

    it('hashes the canonical manifest of the specification', async () => {
      const data = await issued();
      // Built here by hand, key by key, in the order of docs/manifiesto-v2.md.
      const manifest =
        `{"v":2,"id":"${data.id}","createdAt":"${data.createdAt.toISOString()}",` +
        `"file":{"sha256":"${original.sha256}","sizeBytes":1048576},` +
        `"metadata":{"title":"Escena","recipient":"Ada","satellite":"Landsat 9",` +
        `"sensor":null,"sceneId":null,"acquiredAt":"2026-06-15T13:45:00.000Z"}}`;
      expect(canonicalizeManifestV2(data)).toBe(manifest);
    });

    it('keeps the file name out of the manifest', async () => {
      const data = await issued({ ...metadata, fileName: 'renamed.tiff' });
      expect(data.fileName).toBe('renamed.tiff');
      expect(canonicalizeManifestV2(data)).not.toContain('renamed');
    });

    it('stores nothing but the digest of the file', async () => {
      const data = await issued();
      for (const value of Object.values(data)) {
        expect(Buffer.isBuffer(value)).toBe(false);
        expect(ArrayBuffer.isView(value)).toBe(false);
      }
    });

    it('returns the file size as a plain number', async () => {
      certificate.create.mockResolvedValue(v2);
      const created = await service.issue(metadata, original);
      expect(created.fileSizeBytes).toBe(1048576);
    });

    it('gives two certificates of the same file different hashes', async () => {
      const first = await issued();
      certificate.create.mockClear();
      const second = await issued();
      expect(second.id).not.toBe(first.id);
      expect(second.contentHash).not.toBe(first.contentHash);
    });

    it('propagates a database error and reports no certificate', async () => {
      certificate.create.mockRejectedValue(new Error('connection lost'));
      await expect(service.issue(metadata, original)).rejects.toThrow(
        'connection lost',
      );
      expect(certificate.create).toHaveBeenCalledTimes(1);
    });

    it('creates no anchoring record when no contract is configured', async () => {
      expect(await issued()).not.toHaveProperty('anchor');
    });

    describe('with a contract configured', () => {
      const target: AnchorTarget = {
        chainId: 43113,
        contractAddress: '0xb5cA7811682676e0B7a8fc568B28dbf6f841c8CF',
      };

      beforeEach(async () => {
        service = await serviceWith(target);
      });

      it('creates the certificate and its anchoring record in one nested write', async () => {
        const data = await issued();
        // One call to the database: the two rows cannot be split.
        expect(certificate.create).toHaveBeenCalledTimes(1);
        expect(data).toMatchObject({
          hashVersion: 2,
          anchor: { create: target },
        });
      });

      it('leaves status, transaction and dates to the database: nothing is confirmed', async () => {
        const data = (await issued()) as unknown as {
          anchor: { create: Record<string, unknown> };
        };
        expect(Object.keys(data.anchor.create).sort()).toEqual([
          'chainId',
          'contractAddress',
        ]);
      });

      it('issues the same certificate as without a contract', async () => {
        const data = (await issued()) as Data & { anchor?: unknown };
        const { anchor, ...withoutAnchor } = data;
        expect(anchor).toBeDefined();
        expect(withoutAnchor.contentHash).toBe(
          computeManifestV2Hash(withoutAnchor),
        );
        expect(canonicalizeManifestV2(withoutAnchor)).not.toContain('43113');
      });

      it('does not ask the chain, and returns the certificate without the record', async () => {
        certificate.create.mockResolvedValue(v2);
        const created = await service.issue(metadata, original);
        expect(created).not.toHaveProperty('anchor');
        expect(lookup).not.toHaveBeenCalled();
      });

      it('reports no certificate when the write fails, whichever row failed', async () => {
        certificate.create.mockRejectedValue(new Error('check violation'));
        await expect(service.issue(metadata, original)).rejects.toThrow(
          'check violation',
        );
        expect(certificate.create).toHaveBeenCalledTimes(1);
      });
    });
  });

  it('lists certificates newest first', async () => {
    certificate.findMany.mockResolvedValue([]);
    await expect(service.findAll()).resolves.toEqual([]);
    expect(certificate.findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: 'desc' },
    });
  });

  it('returns a certificate by id', async () => {
    certificate.findUnique.mockResolvedValue(v1);
    await expect(service.findOne(v1.id)).resolves.toEqual(v1);
    expect(certificate.findUnique).toHaveBeenCalledWith({
      where: { id: v1.id },
    });
  });

  it('returns the file size as a plain number (JSON has no bigint)', async () => {
    certificate.findUnique.mockResolvedValue(v2);
    const found = await service.findOne(v2.id);
    expect(found.fileSizeBytes).toBe(1048576);
    expect(() => JSON.stringify(found)).not.toThrow();
  });

  it('throws NotFoundException when the certificate does not exist', async () => {
    certificate.findUnique.mockResolvedValue(null);
    await expect(service.findOne('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.verify('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.manifest('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.findFileCertificate('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  describe('manifest', () => {
    it('returns the exact text of vector A, whose hash is the stored one', async () => {
      certificate.findUnique.mockResolvedValue(v2);
      await expect(service.manifest(v2.id)).resolves.toBe(
        '{"v":2,"id":"00000000-0000-4000-8000-000000000001","createdAt":"2026-01-02T03:04:05.006Z","file":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","sizeBytes":1048576},"metadata":{"title":"Escena de prueba","recipient":"José Pérez","satellite":"Sentinel-2A","sensor":"MSI","sceneId":"S2A_MSIL2A_20260101T140051","acquiredAt":"2026-01-01T14:00:51.000Z"}}',
      );
    });

    it('returns the version-1 canonical form for a version-1 certificate', async () => {
      certificate.findUnique.mockResolvedValue(v1);
      await expect(service.manifest(v1.id)).resolves.toBe(
        '{"v":1,"id":"00000000-0000-4000-8000-000000000001","title":"T","recipient":"R","createdAt":"2026-01-02T03:04:05.006Z"}',
      );
    });
  });

  describe('verification', () => {
    const anchoredAt = new Date('2026-11-13T10:00:00.000Z');

    async function verifyFile(
      file = original,
      row: typeof v2 = v2,
    ): ReturnType<CertificatesService['verifyFile']> {
      certificate.findUnique.mockResolvedValue(row);
      return service.verifyFile(
        await service.findFileCertificate(row.id),
        file,
      );
    }

    it('is unverifiable, never valid, while there is no chain integration', async () => {
      await expect(verifyFile()).resolves.toEqual({
        status: 'UNVERIFIABLE',
        reason: 'ANCHOR_NOT_CONFIGURED',
        checks: { file: 'MATCH', record: 'MATCH', anchor: 'NOT_CONFIGURED' },
        hashVersion: 2,
        storedHash: v2.contentHash,
        computedHash: v2.contentHash,
        file: {
          storedSha256: v2.fileSha256,
          receivedSha256: v2.fileSha256,
          receivedSizeBytes: 1048576,
        },
        anchoredAt: null,
      });
      expect(lookup).toHaveBeenCalledWith(v2.contentHash);
    });

    it('uses the unconfigured reader by default', async () => {
      // "By default" means no ANCHOR_* variables, whatever the shell has.
      const inherited = { ...process.env };
      for (const name of Object.keys(process.env)) {
        if (name.startsWith('ANCHOR_')) delete process.env[name];
      }
      const moduleRef = await Test.createTestingModule({
        imports: [CertificatesModule],
      })
        .useMocker((token) =>
          token === PrismaService ? { certificate } : undefined,
        )
        .compile()
        .finally(() => Object.assign(process.env, inherited));
      certificate.findUnique.mockResolvedValue(v2);
      const result = await moduleRef.get(CertificatesService).verify(v2.id);
      expect(result).toMatchObject({
        status: 'UNVERIFIABLE',
        reason: 'ANCHOR_NOT_CONFIGURED',
      });
    });

    it('is valid only when the chain confirms the hash', async () => {
      lookup.mockResolvedValue({ state: 'ANCHORED', anchoredAt });
      await expect(verifyFile()).resolves.toMatchObject({
        status: 'VALID',
        reason: null,
        checks: { file: 'MATCH', record: 'MATCH', anchor: 'ANCHORED' },
        anchoredAt,
      });
    });

    it('is pending when the chain answers that the hash is not there', async () => {
      lookup.mockResolvedValue({ state: 'NOT_ANCHORED' });
      await expect(verifyFile()).resolves.toMatchObject({
        status: 'PENDING',
        reason: 'NOT_ANCHORED',
        checks: { anchor: 'NOT_ANCHORED' },
        anchoredAt: null,
      });
    });

    it.each([
      ['an RPC error', new Error('fetch failed')],
      ['a timeout', new Error('The request timed out')],
      ['a non-error rejection', 'ECONNREFUSED'],
    ])('is unverifiable, never valid, on %s', async (_label, failure) => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      lookup.mockRejectedValue(failure);

      await expect(verifyFile()).resolves.toMatchObject({
        status: 'UNVERIFIABLE',
        reason: 'ANCHOR_UNAVAILABLE',
        checks: { file: 'MATCH', record: 'MATCH', anchor: 'UNAVAILABLE' },
        anchoredAt: null,
      });
      // Logged without the error message, which may quote a URL or a key.
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/fetch|timed out/);
    });

    it('is not valid when a reader returns something unexpected', async () => {
      lookup.mockResolvedValue({ state: 'CONFIRMED' } as never);
      await expect(verifyFile()).resolves.toMatchObject({
        status: 'UNVERIFIABLE',
        checks: { anchor: 'NOT_CONFIGURED' },
      });
      lookup.mockResolvedValue(undefined as never);
      await expect(verifyFile()).resolves.toMatchObject({
        status: 'UNVERIFIABLE',
        checks: { anchor: 'NOT_CONFIGURED' },
      });
    });

    it('reports an altered file, even when the chain confirms the certificate', async () => {
      lookup.mockResolvedValue({ state: 'ANCHORED', anchoredAt });
      await expect(verifyFile(altered)).resolves.toMatchObject({
        status: 'INVALID',
        reason: 'FILE_MISMATCH',
        checks: { file: 'MISMATCH', record: 'MATCH', anchor: 'NOT_CHECKED' },
        file: { storedSha256: v2.fileSha256, receivedSha256: altered.sha256 },
        anchoredAt: null,
      });
      expect(lookup).not.toHaveBeenCalled();
    });

    it.each<[string, Partial<typeof v2>]>([
      ['title', { title: 'Otra escena' }],
      ['recipient', { recipient: 'Otra persona' }],
      ['satellite', { satellite: 'Landsat 9' }],
      ['sensor', { sensor: null as never }],
      ['sceneId', { sceneId: 'X' }],
      ['acquiredAt', { acquiredAt: new Date('2026-01-01T14:00:51.001Z') }],
      ['createdAt', { createdAt: new Date('2026-01-02T03:04:05.007Z') }],
      ['fileSizeBytes', { fileSizeBytes: 1048577n }],
      ['contentHash', { contentHash: 'a'.repeat(64) }],
    ])('reports a record whose %s was altered', async (_label, change) => {
      lookup.mockResolvedValue({ state: 'ANCHORED', anchoredAt });
      const result = await verifyFile(original, { ...v2, ...change });
      expect(result).toMatchObject({
        status: 'INVALID',
        reason: 'RECORD_MISMATCH',
        checks: { file: 'MATCH', record: 'MISMATCH', anchor: 'NOT_CHECKED' },
      });
      expect(result.computedHash).not.toBe(result.storedHash);
      expect(lookup).not.toHaveBeenCalled();
    });

    it('reports the file first when both the file and the record changed', async () => {
      const result = await verifyFile(altered, { ...v2, title: 'Otra' });
      expect(result).toMatchObject({
        status: 'INVALID',
        reason: 'FILE_MISMATCH',
        checks: { file: 'MISMATCH', record: 'MISMATCH' },
      });
    });

    it('reports a stored file hash that was replaced as a record mismatch', async () => {
      // The attacker swaps the certified hash for the hash of another file:
      // that file now "matches", but the manifest no longer does.
      const result = await verifyFile(altered, {
        ...v2,
        fileSha256: altered.sha256,
      });
      expect(result).toMatchObject({
        status: 'INVALID',
        reason: 'RECORD_MISMATCH',
        checks: { file: 'MATCH', record: 'MISMATCH' },
      });
    });

    it('does not accept a file for a version-1 certificate', async () => {
      certificate.findUnique.mockResolvedValue(v1);
      await expect(service.findFileCertificate(v1.id)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    describe('without a file', () => {
      it('verifies an intact version-1 certificate with its own function', async () => {
        certificate.findUnique.mockResolvedValue(v1);
        await expect(service.verify(v1.id)).resolves.toEqual({
          status: 'UNVERIFIABLE',
          reason: 'ANCHOR_NOT_CONFIGURED',
          checks: {
            file: 'NOT_CHECKED',
            record: 'MATCH',
            anchor: 'NOT_CONFIGURED',
          },
          hashVersion: 1,
          storedHash: v1.contentHash,
          computedHash: v1.contentHash,
          file: null,
          anchoredAt: null,
        });
      });

      it('reports a tampered version-1 certificate', async () => {
        certificate.findUnique.mockResolvedValue({ ...v1, recipient: 'X' });
        const result = await service.verify(v1.id);
        expect(result).toMatchObject({
          status: 'INVALID',
          reason: 'RECORD_MISMATCH',
          storedHash: v1.contentHash,
        });
        expect(result.computedHash).not.toBe(v1.contentHash);
      });

      it('verifies a version-2 record without claiming anything about the file', async () => {
        lookup.mockResolvedValue({ state: 'ANCHORED', anchoredAt });
        certificate.findUnique.mockResolvedValue(v2);
        await expect(service.verify(v2.id)).resolves.toMatchObject({
          status: 'VALID',
          checks: { file: 'NOT_CHECKED', record: 'MATCH', anchor: 'ANCHORED' },
          file: null,
        });
      });
    });

    it('fails, rather than answering invalid, for an unknown hash version', async () => {
      certificate.findUnique.mockResolvedValue({ ...v1, hashVersion: 3 });
      await expect(service.verify(v1.id)).rejects.toBeInstanceOf(RangeError);
    });
  });
});
