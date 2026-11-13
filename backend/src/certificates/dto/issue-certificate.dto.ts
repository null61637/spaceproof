import { Transform } from 'class-transformer';
import {
  IsDate,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxDate,
  MaxLength,
  MinDate,
  isISO8601,
} from 'class-validator';

// Stored text is trimmed and in Unicode NFC, the same form the hash uses.
const normalizeText = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().normalize('NFC') : value;

// Absent optionals are stored as null, never as an empty text: the manifest
// hashes "" and null differently.
const normalizeOptionalText = (params: { value: unknown }): unknown => {
  const value = normalizeText(params);
  return value === undefined || value === '' ? null : value;
};

// Control characters, lone surrogates and bidirectional formatting: a text
// holding them can display differently from what it contains, and a lone
// surrogate would not be stored as it was hashed.
const SAFE_TEXT =
  /^[^\p{Cc}\p{Cs}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]*$/u;
const UNSAFE_TEXT_MESSAGE =
  '$property must not contain control or bidirectional formatting characters';

// An instant, not a local time: seconds and an explicit zone are required.
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const INSTANT_MESSAGE =
  '$property must be an ISO 8601 instant with seconds and time zone, e.g. 2026-01-01T14:00:51Z';

// Anything else stays as it came and fails @IsDate. The strict check rejects
// calendar dates that do not exist, which Date would silently roll over.
const toInstant = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' &&
  ISO_INSTANT.test(value) &&
  isISO8601(value, { strict: true })
    ? new Date(value)
    : value;

/**
 * The metadata declared when issuing a certificate, sent in the
 * X-SpaceProof-Metadata header. Only client-provided fields: id, createdAt,
 * the file hash and size, and contentHash are set by the server, and sending
 * any of them is rejected (forbidNonWhitelisted).
 */
export class IssueCertificateDto {
  @Transform(normalizeText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @Matches(SAFE_TEXT, { message: UNSAFE_TEXT_MESSAGE })
  title: string;

  @Transform(normalizeText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @Matches(SAFE_TEXT, { message: UNSAFE_TEXT_MESSAGE })
  recipient: string;

  @Transform(normalizeText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @Matches(SAFE_TEXT, { message: UNSAFE_TEXT_MESSAGE })
  satellite: string;

  @Transform(normalizeOptionalText)
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(SAFE_TEXT, { message: UNSAFE_TEXT_MESSAGE })
  sensor: string | null = null;

  @Transform(normalizeOptionalText)
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(SAFE_TEXT, { message: UNSAFE_TEXT_MESSAGE })
  sceneId: string | null = null;

  // Years 0001 to 9999: the range the manifest can serialize.
  @Transform(toInstant)
  @IsDate({ message: INSTANT_MESSAGE })
  @MinDate(new Date('0001-01-01T00:00:00.000Z'))
  @MaxDate(new Date('9999-12-31T23:59:59.999Z'))
  acquiredAt: Date;

  // Informational: stored next to the certificate, outside the manifest.
  @Transform(normalizeText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  @Matches(SAFE_TEXT, { message: UNSAFE_TEXT_MESSAGE })
  @Matches(/\.tiff?$/i, { message: '$property must end in .tif or .tiff' })
  fileName: string;
}
