import { Module } from '@nestjs/common';
import { ANCHOR_TARGET, AnchorReader } from './anchor-reader';
import {
  anchorReaderFromEnv,
  anchorTargetFromEnv,
} from './avalanche-anchor-reader';
import { CertificatesController } from './certificates.controller';
import { CertificatesService } from './certificates.service';

@Module({
  controllers: [CertificatesController],
  providers: [
    CertificatesService,
    // Reads the SpaceProofAnchor contract on Avalanche Fuji when
    // ANCHOR_RPC_URL and ANCHOR_CONTRACT_ADDRESS are set; otherwise there is
    // no chain integration and verification reports it as not verifiable.
    {
      provide: AnchorReader,
      useFactory: () => anchorReaderFromEnv(process.env),
    },
    // With the same two variables, every certificate is issued together with
    // its PENDING anchoring record for that contract.
    {
      provide: ANCHOR_TARGET,
      useFactory: () => anchorTargetFromEnv(process.env),
    },
  ],
})
export class CertificatesModule {}
