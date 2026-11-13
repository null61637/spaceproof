import { Injectable } from '@nestjs/common';

/** What the chain says about a certificate hash. */
export type AnchorLookup =
  | { state: 'ANCHORED'; anchoredAt: Date }
  | { state: 'NOT_ANCHORED' }
  // There is no chain integration to ask.
  | { state: 'NOT_CONFIGURED' };

/** A transaction that is in a block, as the chain reports it. */
export interface MinedAnchorTransaction {
  state: 'MINED';
  /** false when the transaction reverted. */
  success: boolean;
  /** The address the transaction was sent to. */
  to: string | null;
  blockNumber: bigint;
  /** 1 when it is in the latest block. */
  confirmations: number;
  /** The Anchored events the configured contract emitted in it. */
  anchored: { contentHash: string; anchoredAt: Date }[];
}

/** What the chain says about a transaction hash. */
export type AnchorTransaction =
  // The node does not know the transaction.
  | { state: 'UNKNOWN' }
  // Known to the node, not in a block yet.
  | { state: 'PENDING' }
  | MinedAnchorTransaction;

/**
 * Read side of the anchoring: asks the chain, live, whether a certificate
 * hash is registered, and what became of a transaction. Verification and the
 * anchoring service depend only on this port.
 *
 * An implementation must throw when it cannot get an answer (RPC down,
 * timeout): the caller reports that as "could not be checked". It must never
 * answer ANCHORED or MINED without a positive reply from the chain.
 */
export abstract class AnchorReader {
  abstract lookup(contentHash: string): Promise<AnchorLookup>;
  abstract transaction(txHash: string): Promise<AnchorTransaction>;
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

/** Blocks a transaction must be in before its result counts. */
export const REQUIRED_CONFIRMATIONS = 1;

export type AnchorEvidence =
  // The transaction anchored exactly this hash in this contract.
  | { result: 'MATCH'; anchoredAt: Date; blockNumber: bigint }
  // Matches, but is not deep enough in the chain yet.
  | { result: 'UNCONFIRMED' }
  | { result: 'REVERTED' }
  // Mined, but it is not the anchoring of this hash in this contract.
  | { result: 'MISMATCH' };

/**
 * Whether a mined transaction is the evidence that `contentHash` was anchored
 * in `contractAddress`: it succeeded, it was sent to that contract, and that
 * contract emitted exactly one Anchored event, for that hash.
 */
export function anchorEvidence(
  transaction: MinedAnchorTransaction,
  contractAddress: string,
  contentHash: string,
): AnchorEvidence {
  if (!transaction.success) return { result: 'REVERTED' };
  if (transaction.to?.toLowerCase() !== contractAddress.toLowerCase()) {
    return { result: 'MISMATCH' };
  }
  const [event, ...others] = transaction.anchored;
  if (!event || others.length > 0 || event.contentHash !== contentHash) {
    return { result: 'MISMATCH' };
  }
  if (transaction.confirmations < REQUIRED_CONFIRMATIONS) {
    return { result: 'UNCONFIRMED' };
  }
  return {
    result: 'MATCH',
    anchoredAt: event.anchoredAt,
    blockNumber: transaction.blockNumber,
  };
}

/**
 * The implementation when no contract is configured: it talks to no chain
 * and says so. No certificate verifies as anchored with it.
 */
@Injectable()
export class UnconfiguredAnchorReader extends AnchorReader {
  lookup(): Promise<AnchorLookup> {
    return Promise.resolve({ state: 'NOT_CONFIGURED' });
  }

  transaction(): Promise<AnchorTransaction> {
    return Promise.reject(new Error('No anchor chain is configured'));
  }
}
