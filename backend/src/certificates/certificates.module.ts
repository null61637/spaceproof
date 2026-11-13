import { Module } from '@nestjs/common';
import { AnchorReader, UnconfiguredAnchorReader } from './anchor-reader';
import { CertificatesController } from './certificates.controller';
import { CertificatesService } from './certificates.service';

@Module({
  controllers: [CertificatesController],
  providers: [
    CertificatesService,
    // Replaced by the Avalanche reader when the integration exists (F6).
    { provide: AnchorReader, useClass: UnconfiguredAnchorReader },
  ],
})
export class CertificatesModule {}
