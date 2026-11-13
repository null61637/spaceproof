import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  parseAbi,
  type Address,
  type PublicClient,
  type Transport,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { ANCHOR_CHAIN_ID } from '../certificates/avalanche-anchor-reader';

// What the signer needs from SpaceProofAnchor. A test checks these against
// the versioned ABI (contracts/abi/SpaceProofAnchor.json).
export const ANCHOR_SIGNER_ABI = parseAbi([
  'function owner() view returns (address)',
  'function anchor(bytes32 hash)',
  'error NotOwner()',
  'error EmptyHash()',
  'error AlreadyAnchored(bytes32 hash, uint64 anchoredAt)',
]);

const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const RPC_TIMEOUT_MS = 5000;

/**
 * The configuration can never sign for this contract: wrong chain, or a key
 * that is not the contract's owner. Different from not being able to ask
 * (an RPC failure), which may pass.
 */
export class AnchorSignerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnchorSignerConfigError';
  }
}

/**
 * The account allowed to anchor: the contract's owner. Holds the private key
 * (inside the viem account, never as a readable property) and proves, before
 * anything is signed, that it is on Avalanche Fuji and that the contract
 * accepts it.
 *
 * It does not send anything yet: the anchoring service uses it.
 */
export class AnchorSigner {
  readonly #account: PrivateKeyAccount;
  readonly #client: PublicClient;
  #ready = false;

  constructor(
    transport: Transport,
    readonly contractAddress: Address,
    privateKey: `0x${string}`,
  ) {
    this.#account = privateKeyToAccount(privateKey);
    this.#client = createPublicClient({ transport });
  }

  /** Public address of the signing account. */
  get address(): Address {
    return this.#account.address;
  }

  /**
   * Resolves once the RPC is Avalanche Fuji and this account is the
   * contract's owner() (checked once per process). Rejects with
   * AnchorSignerConfigError when that is false, and with the RPC error when
   * it could not be asked: the caller must not sign in either case.
   */
  async assertReady(): Promise<void> {
    if (this.#ready) return;
    const chainId = await this.#client.getChainId();
    if (chainId !== ANCHOR_CHAIN_ID) {
      throw new AnchorSignerConfigError(
        `Anchor RPC is on chain ${chainId}, expected ${ANCHOR_CHAIN_ID}`,
      );
    }
    const owner = await this.#client.readContract({
      address: this.contractAddress,
      abi: ANCHOR_SIGNER_ABI,
      functionName: 'owner',
    });
    if (getAddress(owner) !== getAddress(this.address)) {
      // Both are public addresses.
      throw new AnchorSignerConfigError(
        `ANCHOR_PRIVATE_KEY is account ${this.address}, not the owner of the anchor contract`,
      );
    }
    this.#ready = true;
  }

  /** Never the key: what logging or serializing this object shows. */
  toJSON(): { address: Address; contractAddress: Address } {
    return { address: this.address, contractAddress: this.contractAddress };
  }
}

/**
 * The signer for this environment, or null without ANCHOR_PRIVATE_KEY: the
 * backend then only reads the chain. The key needs the two read variables.
 * A malformed configuration is an error at startup, and no message ever
 * contains a configured value.
 *
 *   ANCHOR_PRIVATE_KEY       0x + 64 hex: the contract owner's key
 *   ANCHOR_RPC_URL           Fuji C-Chain RPC endpoint
 *   ANCHOR_CONTRACT_ADDRESS  SpaceProofAnchor (contracts/deployments/fuji.json)
 */
export function anchorSignerFromEnv(
  env: Record<string, string | undefined>,
): AnchorSigner | null {
  const privateKey = env.ANCHOR_PRIVATE_KEY?.trim();
  if (!privateKey) return null;

  const rpcUrl = env.ANCHOR_RPC_URL?.trim();
  const address = env.ANCHOR_CONTRACT_ADDRESS?.trim();
  if (!rpcUrl || !address) {
    throw new Error(
      'ANCHOR_PRIVATE_KEY needs ANCHOR_RPC_URL and ANCHOR_CONTRACT_ADDRESS',
    );
  }
  if (!isAddress(address)) {
    throw new Error('ANCHOR_CONTRACT_ADDRESS is not a valid address');
  }
  if (!/^https?:\/\//.test(rpcUrl)) {
    throw new Error('ANCHOR_RPC_URL must be an http(s) URL');
  }
  if (!PRIVATE_KEY.test(privateKey)) {
    throw new Error('ANCHOR_PRIVATE_KEY must be 0x followed by 64 hex digits');
  }
  try {
    return new AnchorSigner(
      http(rpcUrl, { timeout: RPC_TIMEOUT_MS, retryCount: 1 }),
      address,
      privateKey as `0x${string}`,
    );
  } catch {
    // Not rethrown: the library's error could describe the key.
    throw new Error('ANCHOR_PRIVATE_KEY is not a valid private key');
  }
}
