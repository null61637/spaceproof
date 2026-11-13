import {
  CertificateHashInput,
  canonicalizeCertificate,
  computeCertificateHash,
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
