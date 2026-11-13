import {
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  createPublicClient,
  getAddress,
  http,
  isAddress,
  isAddressEqual,
  parseAbi,
  parseEventLogs,
  type Address,
  type PublicClient,
  type Transport,
} from 'viem';
import {
  AnchorLookup,
  AnchorReader,
  AnchorTarget,
  AnchorTransaction,
  UnconfiguredAnchorReader,
} from './anchor-reader';

/** Avalanche Fuji C-Chain: the only chain SpaceProof anchors on. */
export const ANCHOR_CHAIN_ID = 43113;

// The one function verification needs from SpaceProofAnchor. A test checks it
// against the versioned ABI (contracts/abi/SpaceProofAnchor.json).
export const ANCHOR_READ_ABI = parseAbi([
  'function anchoredAt(bytes32 hash) view returns (uint64 timestamp)',
]);

// The event a successful anchor() emits. Checked against the versioned ABI
// by the same test.
export const ANCHOR_EVENT_ABI = parseAbi([
  'event Anchored(bytes32 indexed hash, uint64 timestamp)',
]);

const CONTENT_HASH = /^[0-9a-f]{64}$/;
const TRANSACTION_HASH = /^0x[0-9a-f]{64}$/;
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

  /**
   * What became of a transaction, read from the chain: its receipt (did it
   * succeed, to which address, in which block) and the Anchored events that
   * the configured contract, and only it, emitted in it.
   */
  async transaction(txHash: string): Promise<AnchorTransaction> {
    if (!TRANSACTION_HASH.test(txHash)) {
      throw new RangeError('Not a transaction hash');
    }
    const hash = txHash as `0x${string}`;
    await this.confirmChain();
    let receipt: Awaited<ReturnType<PublicClient['getTransactionReceipt']>>;
    try {
      receipt = await this.client.getTransactionReceipt({ hash });
    } catch (error) {
      if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
      // No receipt: either waiting to be mined, or unknown to the node.
      try {
        await this.client.getTransaction({ hash });
        return { state: 'PENDING' };
      } catch (inner) {
        if (inner instanceof TransactionNotFoundError) {
          return { state: 'UNKNOWN' };
        }
        throw inner;
      }
    }
    const latest = await this.client.getBlockNumber({ cacheTime: 0 });
    const events = parseEventLogs({
      abi: ANCHOR_EVENT_ABI,
      eventName: 'Anchored',
      logs: receipt.logs.filter((log) =>
        isAddressEqual(log.address, this.contractAddress),
      ),
    });
    return {
      state: 'MINED',
      success: receipt.status === 'success',
      to: receipt.to,
      blockNumber: receipt.blockNumber,
      confirmations: Number(latest - receipt.blockNumber) + 1,
      anchored: events.map((event) => ({
        contentHash: event.args.hash.slice(2),
        anchoredAt: new Date(Number(event.args.timestamp) * 1000),
      })),
    };
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
 * The contract this environment is configured for, or null with neither
 * variable set. A partial or malformed configuration is an error at startup,
 * never a silent fallback.
 *
 *   ANCHOR_RPC_URL           Fuji C-Chain RPC endpoint
 *   ANCHOR_CONTRACT_ADDRESS  SpaceProofAnchor (contracts/deployments/fuji.json)
 */
function anchorConfigFromEnv(
  env: Record<string, string | undefined>,
): { rpcUrl: string; contractAddress: Address } | null {
  const rpcUrl = env.ANCHOR_RPC_URL?.trim();
  const address = env.ANCHOR_CONTRACT_ADDRESS?.trim();
  if (!rpcUrl && !address) return null;
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
  return { rpcUrl, contractAddress: address };
}

/**
 * The reader for this environment. Without a configured contract there is no
 * chain integration and verification says so.
 */
export function anchorReaderFromEnv(
  env: Record<string, string | undefined>,
): AnchorReader {
  const config = anchorConfigFromEnv(env);
  if (config === null) return new UnconfiguredAnchorReader();
  return new AvalancheAnchorReader(
    http(config.rpcUrl, { timeout: RPC_TIMEOUT_MS, retryCount: 1 }),
    config.contractAddress,
  );
}

/**
 * Where certificates issued in this environment are to be anchored: the same
 * contract verification reads. null without a configured contract, and then
 * certificates are issued without an anchoring record, as before.
 */
export function anchorTargetFromEnv(
  env: Record<string, string | undefined>,
): AnchorTarget | null {
  const config = anchorConfigFromEnv(env);
  if (config === null) return null;
  return {
    chainId: ANCHOR_CHAIN_ID,
    contractAddress: getAddress(config.contractAddress),
  };
}
