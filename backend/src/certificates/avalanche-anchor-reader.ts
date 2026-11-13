import {
  createPublicClient,
  http,
  isAddress,
  parseAbi,
  type Address,
  type PublicClient,
  type Transport,
} from 'viem';
import {
  AnchorLookup,
  AnchorReader,
  UnconfiguredAnchorReader,
} from './anchor-reader';

/** Avalanche Fuji C-Chain: the only chain SpaceProof anchors on. */
export const ANCHOR_CHAIN_ID = 43113;

// The one function verification needs from SpaceProofAnchor. A test checks it
// against the versioned ABI (contracts/abi/SpaceProofAnchor.json).
export const ANCHOR_READ_ABI = parseAbi([
  'function anchoredAt(bytes32 hash) view returns (uint64 timestamp)',
]);

const CONTENT_HASH = /^[0-9a-f]{64}$/;
const RPC_TIMEOUT_MS = 5000;

/**
 * Asks the SpaceProofAnchor contract, live, whether a certificate hash is
 * registered. Read-only: it holds no key and sends no transaction.
 *
 * Every way of not getting an answer is a rejection, which verification
 * reports as "could not be checked": an RPC error or timeout, an RPC on
 * another chain, an address with no contract, a value that is not a date.
 */
export class AvalancheAnchorReader extends AnchorReader {
  private readonly client: PublicClient;
  private chainConfirmed = false;

  constructor(
    transport: Transport,
    private readonly contractAddress: Address,
  ) {
    super();
    this.client = createPublicClient({ transport });
  }

  async lookup(contentHash: string): Promise<AnchorLookup> {
    if (!CONTENT_HASH.test(contentHash)) {
      throw new RangeError('Not a certificate hash');
    }
    await this.confirmChain();
    // The certificate hash (SHA-256, 64 hex) as the same 32 bytes.
    const seconds = await this.client.readContract({
      address: this.contractAddress,
      abi: ANCHOR_READ_ABI,
      functionName: 'anchoredAt',
      args: [`0x${contentHash}`],
    });
    if (seconds === 0n) return { state: 'NOT_ANCHORED' };

    const anchoredAt = new Date(Number(seconds) * 1000);
    if (Number.isNaN(anchoredAt.getTime())) {
      throw new RangeError('The contract returned a timestamp out of range');
    }
    return { state: 'ANCHORED', anchoredAt };
  }

  /** Once per process: the RPC must be Fuji, or nothing it says counts. */
  private async confirmChain(): Promise<void> {
    if (this.chainConfirmed) return;
    const chainId = await this.client.getChainId();
    if (chainId !== ANCHOR_CHAIN_ID) {
      throw new Error(`Anchor RPC is on chain ${chainId}`);
    }
    this.chainConfirmed = true;
  }
}

/**
 * The reader for this environment. With neither variable set there is no
 * chain integration and verification says so. A partial or malformed
 * configuration is an error at startup, never a silent fallback.
 *
 *   ANCHOR_RPC_URL           Fuji C-Chain RPC endpoint
 *   ANCHOR_CONTRACT_ADDRESS  SpaceProofAnchor (contracts/deployments/fuji.json)
 */
export function anchorReaderFromEnv(
  env: Record<string, string | undefined>,
): AnchorReader {
  const rpcUrl = env.ANCHOR_RPC_URL?.trim();
  const address = env.ANCHOR_CONTRACT_ADDRESS?.trim();
  if (!rpcUrl && !address) return new UnconfiguredAnchorReader();
  if (!rpcUrl || !address) {
    throw new Error(
      'ANCHOR_RPC_URL and ANCHOR_CONTRACT_ADDRESS must be set together',
    );
  }
  if (!isAddress(address)) {
    throw new Error('ANCHOR_CONTRACT_ADDRESS is not a valid address');
  }
  if (!/^https?:\/\//.test(rpcUrl)) {
    throw new Error('ANCHOR_RPC_URL must be an http(s) URL');
  }
  return new AvalancheAnchorReader(
    http(rpcUrl, { timeout: RPC_TIMEOUT_MS, retryCount: 1 }),
    address,
  );
}
