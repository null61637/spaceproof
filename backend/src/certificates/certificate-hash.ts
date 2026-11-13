import { createHash } from 'node:crypto';

export interface CertificateHashInput {
  id: string;
  title: string;
  recipient: string;
  createdAt: Date;
}

/**
 * Canonical serialization, version 1. Changing anything here changes every
 * hash: introduce a new version instead of editing this one.
 *
 * JSON with a fixed key order, texts in Unicode NFC, date as ISO-8601 UTC
 * with millisecond precision (matches PostgreSQL TIMESTAMP(3)).
 */
export function canonicalizeCertificate(input: CertificateHashInput): string {
  return JSON.stringify({
    v: 1,
    id: input.id,
    title: input.title.normalize('NFC'),
    recipient: input.recipient.normalize('NFC'),
    createdAt: input.createdAt.toISOString(),
  });
}

/** SHA-256 (lowercase hex, 64 chars) of the canonical certificate record. */
export function computeCertificateHash(input: CertificateHashInput): string {
  return createHash('sha256')
    .update(canonicalizeCertificate(input), 'utf8')
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Version 2: manifest binding a file to its metadata.
// Normative specification and test vectors: docs/manifiesto-v2.md.
// Frozen once certificates are anchored: introduce a version 3 instead of
// editing this one.
// ---------------------------------------------------------------------------

export interface ManifestV2Input {
  id: string;
  createdAt: Date;
  /** SHA-256 of the file bytes, computed by the server: 64 lowercase hex. */
  fileSha256: string;
  /** PostgreSQL BIGINT arrives as bigint; plain numbers are accepted too. */
  fileSizeBytes: number | bigint;
  title: string;
  recipient: string;
  satellite: string;
  /** Optional: null when absent (the key is always serialized). */
  sensor: string | null;
  /** Optional: null when absent (the key is always serialized). */
  sceneId: string | null;
  acquiredAt: Date;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

const nfcOrNull = (value: string | null): string | null =>
  value === null ? null : value.normalize('NFC');

/**
 * Canonical manifest, version 2: JSON without whitespace, fixed key order,
 * texts in Unicode NFC, dates as ISO-8601 UTC with millisecond precision,
 * file size as a plain integer, absent optionals as null.
 *
 * Throws on values that have no canonical form (malformed file hash, size
 * that is not a positive integer, invalid date) instead of hashing them.
 */
export function canonicalizeManifestV2(input: ManifestV2Input): string {
  if (!SHA256_HEX.test(input.fileSha256)) {
    throw new RangeError('fileSha256 must be 64 lowercase hex characters');
  }
  const sizeBytes = Number(input.fileSizeBytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
    throw new RangeError('fileSizeBytes must be a positive integer');
  }
  return JSON.stringify({
    v: 2,
    id: input.id,
    createdAt: input.createdAt.toISOString(),
    file: { sha256: input.fileSha256, sizeBytes },
    metadata: {
      title: input.title.normalize('NFC'),
      recipient: input.recipient.normalize('NFC'),
      satellite: input.satellite.normalize('NFC'),
      sensor: nfcOrNull(input.sensor),
      sceneId: nfcOrNull(input.sceneId),
      acquiredAt: input.acquiredAt.toISOString(),
    },
  });
}

/** SHA-256 (lowercase hex, 64 chars) of the canonical v2 manifest. */
export function computeManifestV2Hash(input: ManifestV2Input): string {
  return createHash('sha256')
    .update(canonicalizeManifestV2(input), 'utf8')
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Version dispatch, for verifying stored certificates of any version.
// ---------------------------------------------------------------------------

/** A stored certificate: file and satellite columns are null in version 1. */
export interface VersionedCertificate extends CertificateHashInput {
  hashVersion: number;
  fileSha256: string | null;
  fileSizeBytes: number | bigint | null;
  satellite: string | null;
  sensor: string | null;
  sceneId: string | null;
  acquiredAt: Date | null;
}

/**
 * The canonical text behind a stored certificate's hash, built with the
 * function of its own version. Throws for an unknown version or a v2 record
 * missing required fields: such a record cannot be verified, which is
 * different from invalid.
 */
export function canonicalizeForVersion(record: VersionedCertificate): string {
  switch (record.hashVersion) {
    case 1:
      return canonicalizeCertificate(record);
    case 2: {
      const { fileSha256, fileSizeBytes, satellite, acquiredAt } = record;
      if (
        fileSha256 === null ||
        fileSizeBytes === null ||
        satellite === null ||
        acquiredAt === null
      ) {
        throw new RangeError('Version 2 certificate with missing fields');
      }
      return canonicalizeManifestV2({
        ...record,
        fileSha256,
        fileSizeBytes,
        satellite,
        acquiredAt,
      });
    }
    default:
      throw new RangeError(`Unsupported hash version ${record.hashVersion}`);
  }
}

/** Recomputes the hash of a stored certificate of any version. */
export function computeHashForVersion(record: VersionedCertificate): string {
  return createHash('sha256')
    .update(canonicalizeForVersion(record), 'utf8')
    .digest('hex');
}
