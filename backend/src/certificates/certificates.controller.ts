import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CertificatesService } from './certificates.service';
import { CreateCertificateDto } from './dto/create-certificate.dto';

@Controller('certificates')
export class CertificatesController {
  constructor(private readonly certificatesService: CertificatesService) {}

  @Post()
  create(@Body() dto: CreateCertificateDto) {
    return this.certificatesService.create(dto);
  }

  @Get()
  findAll() {
    return this.certificatesService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.certificatesService.findOne(id);
  }

  @Get(':id/verify')
  verify(@Param('id', ParseUUIDPipe) id: string) {
    return this.certificatesService.verify(id);
  }
}
