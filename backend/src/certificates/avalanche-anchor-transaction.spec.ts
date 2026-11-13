import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  custom,
  encodeEventTopics,
  numberToHex,
  pad,
  type Address,
} from 'viem';
import { AnchorTransaction, anchorEvidence } from './anchor-reader';
import {
  ANCHOR_CHAIN_ID,
  ANCHOR_EVENT_ABI,
  AvalancheAnchorReader,
} from './avalanche-anchor-reader';

// Reading what became of a transaction, over a fake RPC: no network.
const CONTRACT: Address = '0xb5cA7811682676e0B7a8fc568B28dbf6f841c8CF';
const OTHER: Address = '0x0000000000000000000000000000000000000001';
const HASH = '268d7919b7a4f9abf52122595b8aecaa2caba5d8f13a3fca91f0d770fdc1f846';
const TX = `0x${'ab'.repeat(32)}`;
const SECONDS = 1794572305n;

const anchoredLog = (address: Address, hash = HASH) => ({
  address,
  topics: encodeEventTopics({
    abi: ANCHOR_EVENT_ABI,
    eventName: 'Anchored',
    args: { hash: `0x${hash}` },
  }),
  data: numberToHex(SECONDS, { size: 32 }),
  blockNumber: '0x64',
  blockHash: pad('0x1'),
  transactionHash: TX,
  transactionIndex: '0x0',
  logIndex: '0x0',
  removed: false,
});

const receipt = (overrides: Record<string, unknown> = {}) => ({
  transactionHash: TX,
  transactionIndex: '0x0',
  blockHash: pad('0x1'),
  blockNumber: '0x64',
  from: OTHER,
  to: CONTRACT,
  status: '0x1',
  cumulativeGasUsed: '0xb296',
  gasUsed: '0xb296',
  effectiveGasPrice: '0x9d',
  contractAddress: null,
  logsBloom: pad('0x0', { size: 256 }),
  type: '0x2',
  logs: [anchoredLog(CONTRACT)],
  ...overrides,
});

function readerOver(answers: {
  chainId?: () => unknown;
  receipt?: () => unknown;
  transaction?: () => unknown;
  blockNumber?: () => unknown;
}) {
  const methods: string[] = [];
  const reader = new AvalancheAnchorReader(
    custom(
      {
        request: ({ method }: { method: string }) => {
          methods.push(method);
          try {
            switch (method) {
              case 'eth_chainId':
                return Promise.resolve(
                  (answers.chainId ?? (() => numberToHex(ANCHOR_CHAIN_ID)))(),
                );
              case 'eth_getTransactionReceipt':
                return Promise.resolve((answers.receipt ?? (() => null))());
              case 'eth_getTransactionByHash':
                return Promise.resolve((answers.transaction ?? (() => null))());
              case 'eth_blockNumber':
                return Promise.resolve(
                  (answers.blockNumber ?? (() => '0x64'))(),
                );
            }
          } catch (error) {
            return Promise.reject(error as Error);
          }
          return Promise.reject(new Error(`unexpected ${method}`));
        },
      },
      { retryCount: 0 },
    ),
    CONTRACT,
  );
  return { reader, methods };
}

const down = () => {
  throw new Error('fetch failed');
};

describe('AvalancheAnchorReader.transaction', () => {
  it('reports a successful anchoring with its contract, block, depth and event', async () => {
    const { reader } = readerOver({
      receipt: () => receipt(),
      blockNumber: () => '0x66',
    });
    await expect(reader.transaction(TX)).resolves.toEqual({
      state: 'MINED',
      success: true,
      to: CONTRACT,
      blockNumber: 100n,
      confirmations: 3,
      anchored: [
        { contentHash: HASH, anchoredAt: new Date('2026-11-13T12:18:25Z') },
      ],
    });
  });

  it('reports a reverted transaction as mined and not successful', async () => {
    const { reader } = readerOver({
      receipt: () => receipt({ status: '0x0', logs: [] }),
    });
    await expect(reader.transaction(TX)).resolves.toMatchObject({
      state: 'MINED',
      success: false,
      anchored: [],
    });
  });

  it('ignores Anchored events emitted by any other contract', async () => {
    const { reader } = readerOver({
      receipt: () => receipt({ to: OTHER, logs: [anchoredLog(OTHER)] }),
    });
    await expect(reader.transaction(TX)).resolves.toMatchObject({
      state: 'MINED',
      success: true,
      to: OTHER,
      anchored: [],
    });
  });

  it('reports a transaction the node knows but has not mined as pending', async () => {
    const { reader } = readerOver({
      transaction: () => ({
        hash: TX,
        blockNumber: null,
        blockHash: null,
        transactionIndex: null,
        from: OTHER,
        to: CONTRACT,
        nonce: '0x3',
        value: '0x0',
        gas: '0xb413',
        input: '0x',
        type: '0x2',
        chainId: numberToHex(ANCHOR_CHAIN_ID),
        maxFeePerGas: '0x9f',
        maxPriorityFeePerGas: '0x93',
        v: '0x1',
        r: pad('0x1'),
        s: pad('0x2'),
      }),
    });
    await expect(reader.transaction(TX)).resolves.toEqual({
      state: 'PENDING',
    });
  });

  it('reports a transaction the node has never seen as unknown', async () => {
    const { reader } = readerOver({});
    await expect(reader.transaction(TX)).resolves.toEqual({
      state: 'UNKNOWN',
    });
  });

  it.each<[string, Parameters<typeof readerOver>[0]]>([
    ['the receipt cannot be read', { receipt: down }],
    ['the transaction cannot be read', { transaction: down }],
    [
      'the latest block cannot be read',
      { receipt: () => receipt(), blockNumber: down },
    ],
    ['the chain id cannot be read', { chainId: down }],
  ])('rejects, and never answers, when %s', async (_label, answers) => {
    const { reader } = readerOver(answers);
    await expect(reader.transaction(TX)).rejects.toBeInstanceOf(Error);
  });

  it('rejects when the RPC is on another chain, without reading anything', async () => {
    const { reader, methods } = readerOver({
      chainId: () => numberToHex(43114),
      receipt: () => receipt(),
    });
    await expect(reader.transaction(TX)).rejects.toThrow('chain 43114');
    expect(methods).toEqual(['eth_chainId']);
  });

  it.each(['0xabc', TX.toUpperCase(), TX.slice(2), ''])(
    'rejects %p as a transaction hash without calling the RPC',
    async (txHash) => {
      const { reader, methods } = readerOver({});
      await expect(reader.transaction(txHash)).rejects.toBeInstanceOf(
        RangeError,
      );
      expect(methods).toEqual([]);
    },
  );

  it('reads the event with the signature of the versioned contract ABI', () => {
    const versioned = JSON.parse(
      readFileSync(
        resolve(__dirname, '../../../contracts/abi/SpaceProofAnchor.json'),
        'utf8',
      ),
    ) as {
      type: string;
      name?: string;
      inputs?: { type: string; indexed?: boolean; name: string }[];
    }[];
    const deployed = versioned.find((item) => item.name === 'Anchored');
    const [used] = ANCHOR_EVENT_ABI;
    expect(deployed?.type).toBe('event');
    expect(
      deployed?.inputs?.map(({ type, indexed, name }) => ({
        type,
        indexed: indexed ?? false,
        name,
      })),
    ).toEqual(
      used.inputs.map((input) => ({
        type: input.type,
        indexed: 'indexed' in input ? input.indexed : false,
        name: input.name,
      })),
    );
  });
});

describe('anchorEvidence', () => {
  const at = new Date('2026-11-13T12:18:25Z');
  const mined = (
    overrides: Partial<Extract<AnchorTransaction, { state: 'MINED' }>> = {},
  ): Extract<AnchorTransaction, { state: 'MINED' }> => ({
    state: 'MINED',
    success: true,
    to: CONTRACT,
    blockNumber: 100n,
    confirmations: 1,
    anchored: [{ contentHash: HASH, anchoredAt: at }],
    ...overrides,
  });

  it('matches a successful transaction to the contract with exactly this hash', () => {
    expect(anchorEvidence(mined(), CONTRACT, HASH)).toEqual({
      result: 'MATCH',
      anchoredAt: at,
      blockNumber: 100n,
    });
    // Addresses compare regardless of checksum case.
    expect(
      anchorEvidence(mined({ to: CONTRACT.toLowerCase() }), CONTRACT, HASH)
        .result,
    ).toBe('MATCH');
  });

  it.each<[string, Parameters<typeof mined>[0], string]>([
    ['reverted', { success: false, anchored: [] }, 'REVERTED'],
    ['sent to another contract', { to: OTHER }, 'MISMATCH'],
    ['a contract creation', { to: null }, 'MISMATCH'],
    ['without an event', { anchored: [] }, 'MISMATCH'],
    [
      'for another hash',
      { anchored: [{ contentHash: 'f'.repeat(64), anchoredAt: at }] },
      'MISMATCH',
    ],
    [
      'with two events',
      {
        anchored: [
          { contentHash: HASH, anchoredAt: at },
          { contentHash: 'f'.repeat(64), anchoredAt: at },
        ],
      },
      'MISMATCH',
    ],
    ['not deep enough', { confirmations: 0 }, 'UNCONFIRMED'],
  ])('does not match a transaction %s', (_label, overrides, result) => {
    expect(anchorEvidence(mined(overrides), CONTRACT, HASH).result).toBe(
      result,
    );
  });
});
