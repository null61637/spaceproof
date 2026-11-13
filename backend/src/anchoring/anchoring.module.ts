import { Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { ANCHOR_TARGET, AnchorReader } from '../certificates/anchor-reader';
import {
  anchorReaderFromEnv,
  anchorTargetFromEnv,
} from '../certificates/avalanche-anchor-reader';
import { AnchorRepository } from './anchor-repository';
import {
  ANCHOR_SIGNER,
  AnchorSigner,
  AnchorSignerConfigError,
  anchorSignerFromEnv,
} from './anchor-signer';
import { AnchoringService } from './anchoring.service';

/**
 * Checks the signer when the application starts. A key that can never sign
 * for the contract (wrong chain, not the owner) stops the startup. An RPC
 * that does not answer does not: issuing and verifying must keep working,
 * and the signer checks again before it is ever used.
 */
@Injectable()
export class AnchorSignerStartupCheck implements OnModuleInit {
  private readonly logger = new Logger(AnchorSignerStartupCheck.name);

  constructor(private readonly signer: AnchorSigner | null) {}

  async onModuleInit(): Promise<void> {
    if (this.signer === null) {
      this.logger.log('No anchoring key configured: the chain is read only');
      return;
    }
    try {
      await this.signer.assertReady();
      this.logger.log({
        message: 'Anchor signer ready',
        address: this.signer.address,
      });
    } catch (error) {
      if (error instanceof AnchorSignerConfigError) throw error;
      // Name only: an RPC error message can contain the RPC URL.
      this.logger.warn({
        message: 'Anchor signer could not be checked at startup',
        error: error instanceof Error ? error.name : typeof error,
      });
    }
  }
}

// Everything about the chain, configured by three variables:
//   ANCHOR_RPC_URL + ANCHOR_CONTRACT_ADDRESS  read the contract (verification)
//                                             and record a PENDING anchor for
//                                             every certificate issued;
//   + ANCHOR_PRIVATE_KEY                      also send those anchors.
// With none of them there is no chain integration at all.
@Module({
  providers: [
    {
      provide: AnchorReader,
      useFactory: () => anchorReaderFromEnv(process.env),
    },
    {
      provide: ANCHOR_TARGET,
      useFactory: () => anchorTargetFromEnv(process.env),
    },
    AnchorRepository,
    AnchoringService,
    {
      provide: ANCHOR_SIGNER,
      useFactory: () => anchorSignerFromEnv(process.env),
    },
    {
      provide: AnchorSignerStartupCheck,
      useFactory: (signer: AnchorSigner | null) =>
        new AnchorSignerStartupCheck(signer),
      inject: [ANCHOR_SIGNER],
    },
  ],
  exports: [AnchorReader, ANCHOR_TARGET, ANCHOR_SIGNER, AnchoringService],
})
export class AnchoringModule {}
