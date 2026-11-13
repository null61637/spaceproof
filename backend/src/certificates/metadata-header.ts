import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { IssueCertificateDto } from './dto/issue-certificate.dto';

/** Carries the declared metadata while the request body carries the file. */
export const METADATA_HEADER = 'x-spaceproof-metadata';

// The largest valid metadata (every text at its limit, in 4-byte characters)
// encodes to just under this.
const MAX_HEADER_CHARS = 8192;
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

// Same rules as the global pipe in app.setup.ts.
const validation = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const invalid = () =>
  new BadRequestException(
    'X-SpaceProof-Metadata must be base64url-encoded UTF-8 JSON holding an object',
  );

/**
 * Decodes and validates the metadata header. Runs before the request body is
 * read, so invalid metadata is rejected without consuming the file. Error
 * messages never quote the header value.
 */
export async function parseMetadataHeader(
  value: string | string[] | undefined,
): Promise<IssueCertificateDto> {
  if (value === undefined || value === '') {
    throw new BadRequestException('X-SpaceProof-Metadata header is required');
  }
  if (
    typeof value !== 'string' ||
    value.length > MAX_HEADER_CHARS ||
    !BASE64URL.test(value)
  ) {
    throw invalid();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.from(value, 'base64url'),
      ),
    );
  } catch {
    throw invalid();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalid();
  }
  return (await validation.transform(parsed, {
    type: 'body',
    metatype: IssueCertificateDto,
  })) as IssueCertificateDto;
}
