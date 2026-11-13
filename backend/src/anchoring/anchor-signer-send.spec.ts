import { inspect } from 'node:util';
import {
  custom,
  encodeErrorResult,
  encodeFunctionData,
  keccak256,
  numberToHex,
  pad,
  parseTransaction,
  recoverTransactionAddress,
  type Address,
  type Hex,
} from 'viem';
import { ANCHOR_CHAIN_ID } from '../certificates/avalanche-anchor-reader';
import {
  ANCHOR_SIGNER_ABI,
  AnchorRejectedError,
  AnchorSigner,
  AnchorSignerConfigError,
} from './anchor-signer';

// Signing and broadcasting, over a fake RPC: no network is touched and no
// transaction ever leaves the process. The key is Hardhat's public
// development account #0, never the key of a SpaceProof contract.
const CONTRACT: Address = '0xb5cA7811682676e0B7a8fc568B28dbf6f841c8CF';
const TEST_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_ADDRESS: Address = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const STRANGER: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
// Vector A of docs/manifiesto-v2.md.
const HASH = '268d7919b7a4f9abf52122595b8aecaa2caba5d8f13a3fca91f0d770fdc1f846';
const OWNER_SELECTOR = '0x8da5cb5b';

interface Call {
  method: string;
  params?: unknown[];
}

function signerOver(
  answers: {
    chainId?: () => unknown;
    owner?: () => unknown;
    simulate?: () => unknown;
    send?: (raw: Hex) => unknown;
  } = {},
) {
  const calls: Call[] = [];
  const reply = (call: Call): unknown => {
    switch (call.method) {
      case 'eth_chainId':
        return (answers.chainId ?? (() => numberToHex(ANCHOR_CHAIN_ID)))();
      case 'eth_call': {
        const [{ data }] = call.params as [{ data: string }];
        if (data.startsWith(OWNER_SELECTOR)) {
          return (answers.owner ?? (() => pad(TEST_ADDRESS)))();
        }
        return (answers.simulate ?? (() => '0x'))();
      }
      case 'eth_getTransactionCount':
        return numberToHex(7);
      case 'eth_estimateGas':
        return numberToHex(46_000);
      case 'eth_maxPriorityFeePerGas':
        return numberToHex(1_000_000_000);
      case 'eth_gasPrice':
        return numberToHex(26_000_000_000);
      case 'eth_getBlockByNumber':
        return {
          number: '0x10',
          hash: pad('0x1'),
          parentHash: pad('0x2'),
          timestamp: '0x6af70011',
          baseFeePerGas: numberToHex(25_000_000_000),
          gasLimit: numberToHex(15_000_000),
          gasUsed: '0x0',
          transactions: [],
        };
      case 'eth_sendRawTransaction': {
        const [raw] = call.params as [Hex];
        return (answers.send ?? ((bytes: Hex) => keccak256(bytes)))(raw);
      }
      default:
        throw new Error(`unexpected ${call.method}`);
    }
  };
  const signer = new AnchorSigner(
    custom(
      {
        request: (call: Call) => {
          calls.push(call);
          try {
            return Promise.resolve(reply(call));
          } catch (error) {
            return Promise.reject(error as Error);
          }
        },
      },
      { retryCount: 0 },
    ),
    CONTRACT,
    TEST_KEY,
  );
  const methods = () => calls.map((call) => call.method);
  const sent = () =>
    calls
      .filter((call) => call.method === 'eth_sendRawTransaction')
      .map((call) => (call.params as [Hex])[0]);
  return { signer, methods, sent };
}

/** What a node answers when the contract reverts with a custom error. */
const revert =
  (errorName: 'AlreadyAnchored' | 'NotOwner' | 'EmptyHash') => () => {
    throw Object.assign(new Error('execution reverted'), {
      code: 3,
      data:
        errorName === 'AlreadyAnchored'
          ? encodeErrorResult({
              abi: ANCHOR_SIGNER_ABI,
              errorName,
              args: [`0x${HASH}`, 1794572305n],
            })
          : encodeErrorResult({ abi: ANCHOR_SIGNER_ABI, errorName }),
    });
  };

describe('AnchorSigner.sign', () => {
  it('signs anchor(hash) for the configured contract, and sends nothing', async () => {
    const { signer, sent } = signerOver();
    const signed = await signer.sign(HASH);

    // The hash is the one the transaction will have on chain.
    expect(signed.txHash).toBe(keccak256(signed.serializedTransaction));
    const transaction = parseTransaction(signed.serializedTransaction);
    expect(transaction).toMatchObject({
      to: CONTRACT.toLowerCase(),
      chainId: ANCHOR_CHAIN_ID,
      nonce: 7,
      // Only the 32-byte certificate hash travels: no file, no metadata.
      data: encodeFunctionData({
        abi: ANCHOR_SIGNER_ABI,
        functionName: 'anchor',
        args: [`0x${HASH}`],
      }),
    });
    expect(transaction.data).toBe(`0xeecdf927${HASH}`);
    expect(transaction.value ?? 0n).toBe(0n);
    await expect(
      recoverTransactionAddress({
        serializedTransaction: signed.serializedTransaction as `0x02${string}`,
      }),
    ).resolves.toBe(TEST_ADDRESS);
    expect(sent()).toEqual([]);
  });

  it('checks chain and owner before the first signature', async () => {
    const { signer, methods } = signerOver();
    await signer.sign(HASH);
    expect(methods().slice(0, 2)).toEqual(['eth_chainId', 'eth_call']);
  });

  it.each<[string, Parameters<typeof signerOver>[0]]>([
    ['the RPC is on another chain', { chainId: () => numberToHex(43114) }],
    ['the key is not the contract owner', { owner: () => pad(STRANGER) }],
  ])('signs nothing when %s', async (_label, answers) => {
    const { signer, methods, sent } = signerOver(answers);
    await expect(signer.sign(HASH)).rejects.toBeInstanceOf(
      AnchorSignerConfigError,
    );
    await expect(
      signer.broadcast({ txHash: '0x00', serializedTransaction: '0x00' }),
    ).rejects.toBeInstanceOf(AnchorSignerConfigError);
    expect(methods()).not.toContain('eth_estimateGas');
    expect(sent()).toEqual([]);
  });

  it('signs nothing when the RPC does not answer, and it is not a configuration error', async () => {
    const { signer, sent } = signerOver({
      chainId: () => {
        throw new Error('fetch failed');
      },
    });
    const error: unknown = await signer.sign(HASH).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AnchorSignerConfigError);
    expect(error).not.toBeInstanceOf(AnchorRejectedError);
    expect(sent()).toEqual([]);
  });

  it.each(['AlreadyAnchored', 'NotOwner', 'EmptyHash'] as const)(
    'signs nothing when the contract would revert with %s',
    async (errorName) => {
      const { signer, methods, sent } = signerOver({
        simulate: revert(errorName),
      });
      const error = await signer.sign(HASH).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AnchorRejectedError);
      expect((error as AnchorRejectedError).reason).toBe(errorName);
      expect(methods()).not.toContain('eth_estimateGas');
      expect(sent()).toEqual([]);
    },
  );

  it.each([
    ['uppercase', HASH.toUpperCase()],
    ['a 0x prefix', `0x${HASH}`],
    ['empty', ''],
  ])('refuses a hash that is %s without any request', async (_l, hash) => {
    const { signer, methods } = signerOver();
    await expect(signer.sign(hash)).rejects.toBeInstanceOf(RangeError);
    expect(methods()).toEqual([]);
  });
});

describe('AnchorSigner.broadcast', () => {
  it('sends exactly the signed bytes, once', async () => {
    const { signer, sent } = signerOver();
    const signed = await signer.sign(HASH);
    await expect(signer.broadcast(signed)).resolves.toBeUndefined();
    expect(sent()).toEqual([signed.serializedTransaction]);
  });

  it('rejects when the RPC does not answer: the outcome is unknown to the caller', async () => {
    const { signer, sent } = signerOver({
      send: () => {
        throw new Error('timeout');
      },
    });
    const signed = await signer.sign(HASH);
    await expect(signer.broadcast(signed)).rejects.toBeInstanceOf(Error);
    // It was handed to the RPC all the same.
    expect(sent()).toEqual([signed.serializedTransaction]);
  });

  it('never shows the key in what it returns or throws', async () => {
    const { signer } = signerOver({
      send: () => {
        throw new Error('timeout');
      },
    });
    const signed = await signer.sign(HASH);
    const failure = await signer.broadcast(signed).catch((e: Error) => e);
    const refusal = await signerOver({ simulate: revert('NotOwner') })
      .signer.sign(HASH)
      .catch((e: Error) => e);
    const shown = [
      JSON.stringify(signed),
      inspect(signer, { depth: 10, showHidden: true }),
      inspect(failure, { depth: 10 }),
      inspect(refusal, { depth: 10 }),
    ].join('\n');
    expect(shown.toLowerCase()).not.toContain(TEST_KEY.slice(2));
  });
});
