import {
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { CertificatesService } from './certificates.service';
import { receiveFile } from './file-upload';
import { METADATA_HEADER, parseMetadataHeader } from './metadata-header';

// Contract: docs/API_EMISION_VERIFICACION.md. The two POST routes take the
// file as the raw request body (Content-Type image/tiff, enforced in
// app.setup.ts) and read it as a stream: it is hashed and never stored.
@Controller('certificates')
export class CertificatesController {
  constructor(private readonly certificatesService: CertificatesService) {}

  @Post()
  async issue(@Req() req: Request) {
    // The metadata is validated before the body is read, and the certificate
    // is stored only once the whole body has been received.
    const metadata = await parseMetadataHeader(req.headers[METADATA_HEADER]);
    const file = await receiveFile(req, { requireTiffSignature: true });
    return this.certificatesService.issue(metadata, file);
  }

  @Get()
  findAll() {
    return this.certificatesService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.certificatesService.findOne(id);
  }

  @Get(':id/manifest')
  @Header('Content-Type', 'application/json; charset=utf-8')
  manifest(@Param('id', ParseUUIDPipe) id: string) {
    return this.certificatesService.manifest(id);
  }

  @Get(':id/verify')
  async verify(@Param('id', ParseUUIDPipe) id: string) {
    const verification = await this.certificatesService.verify(id);
    // `valid` predates `status`: it only says the stored record is consistent.
    return { ...verification, valid: verification.checks.record === 'MATCH' };
  }

  @Post(':id/verify-file')
  @HttpCode(200)
  async verifyFile(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    // Looked up before the body is read: an unknown id costs no upload.
    const certificate = await this.certificatesService.findFileCertificate(id);
    // No signature check: a file altered in its first bytes is a mismatch.
    const file = await receiveFile(req, { requireTiffSignature: false });
    return this.certificatesService.verifyFile(certificate, file);
  }
}
