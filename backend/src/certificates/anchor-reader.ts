import { Injectable } from '@nestjs/common';

/** What the chain says about a certificate hash. */
export type AnchorLookup =
  | { state: 'ANCHORED'; anchoredAt: Date }
  | { state: 'NOT_ANCHORED' }
  // There is no chain integration to ask.
  | { state: 'NOT_CONFIGURED' };

/**
 * Read side of the anchoring: asks the chain, live, whether a certificate
 * hash is registered. Verification depends only on this port.
 *
 * An implementation must throw when it cannot get an answer (RPC down,
 * timeout): the caller reports that as "could not be checked". It must never
 * answer ANCHORED without a positive reply from the chain.
 */
export abstract class AnchorReader {
  abstract lookup(contentHash: string): Promise<AnchorLookup>;
}

/**
 * Where new certificates are to be anchored: recorded in the certificate's
 * Anchor row when it is issued. null when no contract is configured.
 */
export interface AnchorTarget {
  chainId: number;
  contractAddress: string;
}

/** Injection token for the AnchorTarget of this environment, or null. */
export const ANCHOR_TARGET = Symbol('ANCHOR_TARGET');

/**
 * The only implementation until the Avalanche integration exists (phases F5
 * and F6): it talks to no chain and says so. No certificate verifies as
 * anchored with it.
 */
@Injectable()
export class UnconfiguredAnchorReader extends AnchorReader {
  lookup(): Promise<AnchorLookup> {
    return Promise.resolve({ state: 'NOT_CONFIGURED' });
  }
}
