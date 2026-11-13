import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

// Stored text is trimmed and in Unicode NFC, the same form the hash uses.
const normalizeText = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().normalize('NFC') : value;

// Only client-provided fields. id, createdAt, contentHash and txHash are set
// by the server; sending any of them is rejected (forbidNonWhitelisted).
export class CreateCertificateDto {
  @Transform(normalizeText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @Transform(normalizeText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  recipient: string;
}
