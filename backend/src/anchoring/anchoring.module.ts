import { Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import {
  AnchorSigner,
  AnchorSignerConfigError,
  anchorSignerFromEnv,
} from './anchor-signer';

/** Injection token: the AnchorSigner, or null when no key is configured. */
export const ANCHOR_SIGNER = Symbol('ANCHOR_SIGNER');

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

@Module({
  providers: [
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
  exports: [ANCHOR_SIGNER],
})
export class AnchoringModule {}
