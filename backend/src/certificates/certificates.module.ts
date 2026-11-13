import { Module } from '@nestjs/common';
import { AnchoringModule } from '../anchoring/anchoring.module';
import { CertificatesController } from './certificates.controller';
import { CertificatesService } from './certificates.service';

// The chain providers (reader, target, anchoring service) come from
// AnchoringModule: verification reads the contract through them, and issuing
// records a PENDING anchor when a contract is configured.
@Module({
  imports: [AnchoringModule],
  controllers: [CertificatesController],
  providers: [CertificatesService],
})
export class CertificatesModule {}
