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
