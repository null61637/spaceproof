import {
  CertificateHashInput,
  ManifestV2Input,
  VersionedCertificate,
  canonicalizeCertificate,
  canonicalizeManifestV2,
  computeCertificateHash,
  computeHashForVersion,
  computeManifestV2Hash,
} from './certificate-hash';

const base: CertificateHashInput = {
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Certificado de prueba',
  recipient: 'José Pérez',
  createdAt: new Date('2026-01-02T03:04:05.006Z'),
};

describe('certificate hash', () => {
  it('serializes with a fixed key order and version', () => {
    expect(canonicalizeCertificate(base)).toBe(
      '{"v":1,"id":"00000000-0000-4000-8000-000000000001","title":"Certificado de prueba","recipient":"José Pérez","createdAt":"2026-01-02T03:04:05.006Z"}',
    );
  });

  it('matches a known SHA-256 vector (computed independently with sha256sum)', () => {
    expect(computeCertificateHash(base)).toBe(
      'fc9532748cd7fabfaff52848be9584048f3a3ca20e536f6f49d5ffca09170f3b',
    );
  });

  it('is deterministic and returns 64 lowercase hex chars', () => {
    const hash = computeCertificateHash(base);
    expect(computeCertificateHash({ ...base })).toBe(hash);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives the same hash for NFC and NFD forms of the same text', () => {
    const nfd = {
      ...base,
      title: base.title.normalize('NFD'),
      recipient: base.recipient.normalize('NFD'),
    };
    expect(nfd.recipient).not.toBe(base.recipient);
    expect(computeCertificateHash(nfd)).toBe(computeCertificateHash(base));
  });

  it.each<[string, Partial<CertificateHashInput>]>([
    ['id', { id: '00000000-0000-4000-8000-000000000002' }],
    ['title', { title: 'Certificado de prueba.' }],
    ['recipient', { recipient: 'Jose Perez' }],
    ['createdAt', { createdAt: new Date('2026-01-02T03:04:05.007Z') }],
  ])('changes when %s changes', (_field, change) => {
    expect(computeCertificateHash({ ...base, ...change })).not.toBe(
      computeCertificateHash(base),
    );
  });
});

// Vectors A, B and C of docs/manifiesto-v2.md. The expected hashes were
// computed outside this code: printf '%s' '<manifest>' | sha256sum
const v2: ManifestV2Input = {
  id: '00000000-0000-4000-8000-000000000001',
  createdAt: new Date('2026-01-02T03:04:05.006Z'),
  fileSha256:
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  fileSizeBytes: 1048576,
  title: 'Escena de prueba',
  recipient: 'José Pérez',
  satellite: 'Sentinel-2A',
  sensor: 'MSI',
  sceneId: 'S2A_MSIL2A_20260101T140051',
  acquiredAt: new Date('2026-01-01T14:00:51.000Z'),
};

describe('manifest v2', () => {
  it('serializes vector A with a fixed key order and version', () => {
    expect(canonicalizeManifestV2(v2)).toBe(
      '{"v":2,"id":"00000000-0000-4000-8000-000000000001","createdAt":"2026-01-02T03:04:05.006Z","file":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","sizeBytes":1048576},"metadata":{"title":"Escena de prueba","recipient":"José Pérez","satellite":"Sentinel-2A","sensor":"MSI","sceneId":"S2A_MSIL2A_20260101T140051","acquiredAt":"2026-01-01T14:00:51.000Z"}}',
    );
    expect(computeManifestV2Hash(v2)).toBe(
      '268d7919b7a4f9abf52122595b8aecaa2caba5d8f13a3fca91f0d770fdc1f846',
    );
  });

  it('serializes absent optional fields as null (vector B)', () => {
    const input = { ...v2, sensor: null, sceneId: null };
    expect(canonicalizeManifestV2(input)).toContain(
      '"sensor":null,"sceneId":null,',
    );
    expect(computeManifestV2Hash(input)).toBe(
      '26b0b93f0283e50bc31efb639bfc96fdc233134a62b568c95b0d7b39247bc86b',
    );
  });

  it('escapes quotes and backslashes and keeps non-ASCII literal (vector C)', () => {
    const input: ManifestV2Input = {
      id: '00000000-0000-4000-8000-000000000003',
      createdAt: new Date('2026-12-31T23:59:59.999Z'),
      fileSha256:
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      fileSizeBytes: 209715200n,
      title: 'Río "Paraná" \\ banda 4',
      recipient: 'Ñandú S.A. 衛星',
      satellite: 'Landsat 9',
      sensor: 'OLI-2',
      sceneId: null,
      acquiredAt: new Date('2026-06-15T13:45:00.000Z'),
    };
    expect(canonicalizeManifestV2(input)).toBe(
      '{"v":2,"id":"00000000-0000-4000-8000-000000000003","createdAt":"2026-12-31T23:59:59.999Z","file":{"sha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","sizeBytes":209715200},"metadata":{"title":"Río \\"Paraná\\" \\\\ banda 4","recipient":"Ñandú S.A. 衛星","satellite":"Landsat 9","sensor":"OLI-2","sceneId":null,"acquiredAt":"2026-06-15T13:45:00.000Z"}}',
    );
    expect(computeManifestV2Hash(input)).toBe(
      '2317f60e2bde3bb7af2df6a8b6f71733a082405ae39f13f595831157165f96a2',
    );
  });

  it('is deterministic: same data, same hash, whatever the input form', () => {
    const hash = computeManifestV2Hash(v2);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // Property order of the input object is irrelevant.
    const reordered = Object.fromEntries(
      Object.entries(v2).reverse(),
    ) as unknown as ManifestV2Input;
    expect(computeManifestV2Hash(reordered)).toBe(hash);
    // NFD text, bigint size and the same instant written with an offset.
    expect(
      computeManifestV2Hash({
        ...v2,
        recipient: v2.recipient.normalize('NFD'),
        fileSizeBytes: 1048576n,
        acquiredAt: new Date('2026-01-01T11:00:51-03:00'),
      }),
    ).toBe(hash);
  });

  it.each<[string, Partial<ManifestV2Input>]>([
    ['id', { id: '00000000-0000-4000-8000-000000000002' }],
    ['createdAt', { createdAt: new Date('2026-01-02T03:04:05.007Z') }],
    ['fileSha256', { fileSha256: 'f'.repeat(64) }],
    ['fileSizeBytes', { fileSizeBytes: 1048577 }],
    ['title', { title: 'Escena de prueba.' }],
    ['recipient', { recipient: 'Jose Perez' }],
    ['satellite', { satellite: 'Sentinel-2B' }],
    ['sensor', { sensor: null }],
    ['sensor (empty is not null)', { sensor: '' }],
    ['sceneId', { sceneId: 'S2A_MSIL2A_20260101T140052' }],
    ['acquiredAt', { acquiredAt: new Date('2026-01-01T14:00:51.001Z') }],
  ])('changes when %s changes', (_field, change) => {
    expect(computeManifestV2Hash({ ...v2, ...change })).not.toBe(
      computeManifestV2Hash(v2),
    );
  });

  it.each<[string, Partial<ManifestV2Input>]>([
    ['uppercase file hash', { fileSha256: 'F'.repeat(64) }],
    ['short file hash', { fileSha256: 'abc' }],
    ['zero size', { fileSizeBytes: 0 }],
    ['negative size', { fileSizeBytes: -1 }],
    ['fractional size', { fileSizeBytes: 1.5 }],
    ['size beyond exact integers', { fileSizeBytes: 2n ** 53n }],
    ['invalid date', { acquiredAt: new Date(NaN) }],
  ])('refuses to hash a %s', (_case, change) => {
    expect(() => computeManifestV2Hash({ ...v2, ...change })).toThrow(
      RangeError,
    );
  });
});

describe('hash version dispatch', () => {
  const stored = (
    overrides: Partial<VersionedCertificate>,
  ): VersionedCertificate => ({ ...v2, hashVersion: 2, ...overrides });

  it('uses v1 for hashVersion 1, ignoring every v2 column', () => {
    const v1Record = stored({
      ...base,
      hashVersion: 1,
      fileSha256: null,
      fileSizeBytes: null,
      satellite: null,
      sensor: null,
      sceneId: null,
      acquiredAt: null,
    });
    // Same known vector as the v1 suite: v1 hashes did not change.
    expect(computeHashForVersion(v1Record)).toBe(
      'fc9532748cd7fabfaff52848be9584048f3a3ca20e536f6f49d5ffca09170f3b',
    );
    expect(computeHashForVersion({ ...v1Record, satellite: 'x' })).toBe(
      computeCertificateHash(base),
    );
  });

  it('uses v2 for hashVersion 2', () => {
    expect(computeHashForVersion(stored({}))).toBe(computeManifestV2Hash(v2));
  });

  it('v1 and v2 never share a hash for the same record', () => {
    expect(computeHashForVersion(stored({ hashVersion: 1 }))).not.toBe(
      computeHashForVersion(stored({})),
    );
  });

  it.each<[string, Partial<VersionedCertificate>]>([
    ['file hash', { fileSha256: null }],
    ['file size', { fileSizeBytes: null }],
    ['satellite', { satellite: null }],
    ['acquisition date', { acquiredAt: null }],
  ])('throws for a v2 record without %s', (_field, change) => {
    expect(() => computeHashForVersion(stored(change))).toThrow(RangeError);
  });

  it.each([0, 3])('throws for unknown version %d', (hashVersion) => {
    expect(() => computeHashForVersion(stored({ hashVersion }))).toThrow(
      'Unsupported hash version',
    );
  });
});
