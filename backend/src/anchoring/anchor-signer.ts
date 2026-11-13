import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
  type Transport,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { prepareTransactionRequest } from 'viem/actions';
import { avalancheFuji } from 'viem/chains';
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

/** Injection token: the AnchorSigner, or null when no key is configured. */
export const ANCHOR_SIGNER = Symbol('ANCHOR_SIGNER');

/** A signed anchor() transaction that has not been sent. */
export interface SignedAnchor {
  /** Hash the transaction will have on chain, known before sending it. */
  txHash: Hex;
  serializedTransaction: Hex;
}

/** What the anchoring service needs from the signer. */
export interface AnchorSending {
  readonly contractAddress: string;
  assertReady(): Promise<void>;
  sign(contentHash: string): Promise<SignedAnchor>;
  broadcast(signed: SignedAnchor): Promise<void>;
}

/**
 * The contract would revert this anchor() call: nothing was signed or sent.
 * `reason` is the contract's error name (AlreadyAnchored, NotOwner,
 * EmptyHash) or "Reverted".
 */
export class AnchorRejectedError extends Error {
  constructor(readonly reason: string) {
    super(`The anchor contract refuses the call: ${reason}`);
    this.name = 'AnchorRejectedError';
  }
}

const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const CONTENT_HASH = /^[0-9a-f]{64}$/;
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
 * Signing and sending are two steps (sign, broadcast) so the caller can
 * record the transaction hash before anything leaves this process.
 */
export class AnchorSigner implements AnchorSending {
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

  /**
   * Signs an anchor(contentHash) transaction for the configured contract and
   * returns it with its hash. Nothing is sent. The only data in the
   * transaction is the 32-byte certificate hash.
   *
   * Rejects with AnchorRejectedError when the contract would revert the call
   * (checked by simulating it), and with the RPC error when the chain could
   * not be asked.
   */
  async sign(contentHash: string): Promise<SignedAnchor> {
    if (!CONTENT_HASH.test(contentHash)) {
      throw new RangeError('Not a certificate hash');
    }
    await this.assertReady();
    const call = {
      abi: ANCHOR_SIGNER_ABI,
      functionName: 'anchor',
      args: [`0x${contentHash}`],
    } as const;
    try {
      await this.#client.simulateContract({
        ...call,
        address: this.contractAddress,
        account: this.#account,
      });
    } catch (error) {
      const revert =
        error instanceof BaseError
          ? error.walk(
              (cause) => cause instanceof ContractFunctionRevertedError,
            )
          : null;
      if (revert instanceof ContractFunctionRevertedError) {
        throw new AnchorRejectedError(revert.data?.errorName ?? 'Reverted');
      }
      throw error;
    }
    // Nonce (counting transactions still pending), gas and fees from the RPC.
    const request = await prepareTransactionRequest(this.#client, {
      account: this.#account,
      chain: avalancheFuji,
      to: this.contractAddress,
      data: encodeFunctionData(call),
    });
    const serializedTransaction = await this.#account.signTransaction({
      ...request,
      chainId: ANCHOR_CHAIN_ID,
    } as Parameters<PrivateKeyAccount['signTransaction']>[0]);
    return {
      txHash: keccak256(serializedTransaction),
      serializedTransaction,
    };
  }

  /**
   * Sends a transaction signed by sign(). A rejection does not mean it was
   * not sent: the caller settles the outcome by the transaction hash.
   */
  async broadcast(signed: SignedAnchor): Promise<void> {
    await this.assertReady();
    await this.#client.sendRawTransaction({
      serializedTransaction: signed.serializedTransaction,
    });
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
