import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { custom, encodeFunctionData, numberToHex, type Address } from 'viem';
import { UnconfiguredAnchorReader } from './anchor-reader';
import {
  ANCHOR_CHAIN_ID,
  ANCHOR_READ_ABI,
  AvalancheAnchorReader,
  anchorReaderFromEnv,
  anchorTargetFromEnv,
} from './avalanche-anchor-reader';

// The contract deployed on Fuji (contracts/deployments/fuji.json).
const CONTRACT: Address = '0xb5cA7811682676e0B7a8fc568B28dbf6f841c8CF';
// Vector A of docs/manifiesto-v2.md.
const HASH = '268d7919b7a4f9abf52122595b8aecaa2caba5d8f13a3fca91f0d770fdc1f846';

const uint = (value: bigint) => numberToHex(value, { size: 32 });

interface RpcCall {
  method: string;
  params?: unknown[];
}

/** A reader over a fake RPC: no network is ever touched. */
function readerOver(answers: {
  chainId?: () => unknown;
  call?: () => unknown;
}) {
  const calls: RpcCall[] = [];
  const reader = new AvalancheAnchorReader(
    custom(
      {
        request: (call: RpcCall) => {
          calls.push(call);
          try {
            if (call.method === 'eth_chainId') {
              return Promise.resolve(
                (answers.chainId ?? (() => numberToHex(ANCHOR_CHAIN_ID)))(),
              );
            }
            if (call.method === 'eth_call') {
              return Promise.resolve((answers.call ?? (() => uint(0n)))());
            }
          } catch (error) {
            return Promise.reject(error as Error);
          }
          return Promise.reject(new Error(`unexpected ${call.method}`));
        },
      },
      { retryCount: 0 },
    ),
    CONTRACT,
  );
  const methods = () => calls.map((call) => call.method);
  return { reader, calls, methods };
}

describe('AvalancheAnchorReader', () => {
  it('reports a hash the contract has as anchored, with its date', async () => {
    const { reader, calls } = readerOver({ call: () => uint(1794571851n) });

    await expect(reader.lookup(HASH)).resolves.toEqual({
      state: 'ANCHORED',
      anchoredAt: new Date('2026-11-13T12:10:51.000Z'),
    });

    // Asked the right contract for exactly this hash, as bytes32.
    const [request] = calls.find((call) => call.method === 'eth_call')
      ?.params as [{ to: string; data: string }];
    expect(request.to.toLowerCase()).toBe(CONTRACT.toLowerCase());
    expect(request.data).toBe(
      encodeFunctionData({
        abi: ANCHOR_READ_ABI,
        functionName: 'anchoredAt',
        args: [`0x${HASH}`],
      }),
    );
    expect(request.data.endsWith(HASH)).toBe(true);
  });

  it('reports a hash the contract does not have as not anchored', async () => {
    const { reader } = readerOver({ call: () => uint(0n) });
    await expect(reader.lookup(HASH)).resolves.toEqual({
      state: 'NOT_ANCHORED',
    });
  });

  it.each<[string, () => unknown]>([
    [
      'the RPC fails',
      () => {
        throw new Error('fetch failed');
      },
    ],
    // What a node answers for an address that holds no contract.
    ['there is no contract at the address', () => '0x'],
    ['the answer is not a number', () => '0xzz'],
    ['the timestamp is not a representable date', () => uint(2n ** 64n - 1n)],
  ])('rejects, and never answers, when %s', async (_label, call) => {
    const { reader } = readerOver({ call });
    await expect(reader.lookup(HASH)).rejects.toBeInstanceOf(Error);
  });

  it('rejects when the RPC is on another chain, without reading the contract', async () => {
    // 43114 is Avalanche mainnet: an anchor there says nothing about Fuji.
    const { reader, methods } = readerOver({
      chainId: () => numberToHex(43114),
      call: () => uint(1794571851n),
    });
    await expect(reader.lookup(HASH)).rejects.toThrow('chain 43114');
    expect(methods()).toEqual(['eth_chainId']);
  });

  it('rejects when the chain id cannot be read, and asks again next time', async () => {
    let available = false;
    const { reader } = readerOver({
      chainId: () => {
        if (!available) throw new Error('timeout');
        return numberToHex(ANCHOR_CHAIN_ID);
      },
      call: () => uint(1794571851n),
    });
    await expect(reader.lookup(HASH)).rejects.toBeInstanceOf(Error);
    available = true;
    await expect(reader.lookup(HASH)).resolves.toMatchObject({
      state: 'ANCHORED',
    });
  });

  it('confirms the chain once, then only reads the contract', async () => {
    const { reader, methods } = readerOver({});
    await reader.lookup(HASH);
    await reader.lookup(HASH);
    expect(methods()).toEqual(['eth_chainId', 'eth_call', 'eth_call']);
  });

  it.each([
    ['uppercase', HASH.toUpperCase()],
    ['a 0x prefix', `0x${HASH}`],
    ['too short', HASH.slice(2)],
    ['empty', ''],
  ])('rejects a hash that is %s without calling the RPC', async (_l, hash) => {
    const { reader, methods } = readerOver({});
    await expect(reader.lookup(hash)).rejects.toBeInstanceOf(RangeError);
    expect(methods()).toEqual([]);
  });

  it('reads with the same signature as the versioned contract ABI', () => {
    const versioned = JSON.parse(
      readFileSync(
        resolve(__dirname, '../../../contracts/abi/SpaceProofAnchor.json'),
        'utf8',
      ),
    ) as {
      type: string;
      name?: string;
      stateMutability?: string;
      inputs?: { type: string }[];
      outputs?: { type: string }[];
    }[];
    const deployed = versioned.find((item) => item.name === 'anchoredAt');
    const [used] = ANCHOR_READ_ABI;

    expect(deployed).toMatchObject({
      type: used.type,
      stateMutability: used.stateMutability,
    });
    expect(deployed?.inputs?.map((input) => input.type)).toEqual(
      used.inputs.map((input) => input.type),
    );
    expect(deployed?.outputs?.map((output) => output.type)).toEqual(
      used.outputs.map((output) => output.type),
    );
  });
});

describe('anchorReaderFromEnv', () => {
  const rpc = 'https://api.avax-test.network/ext/bc/C/rpc';

  it.each([
    ['neither variable is set', {}],
    ['both are blank', { ANCHOR_RPC_URL: ' ', ANCHOR_CONTRACT_ADDRESS: '' }],
  ])('has no chain integration when %s', (_label, env) => {
    expect(anchorReaderFromEnv(env)).toBeInstanceOf(UnconfiguredAnchorReader);
  });

  it('reads Avalanche when both variables are set', () => {
    expect(
      anchorReaderFromEnv({
        ANCHOR_RPC_URL: rpc,
        ANCHOR_CONTRACT_ADDRESS: CONTRACT,
      }),
    ).toBeInstanceOf(AvalancheAnchorReader);
  });

  it.each<[string, Record<string, string>]>([
    ['only the RPC is set', { ANCHOR_RPC_URL: rpc }],
    ['only the address is set', { ANCHOR_CONTRACT_ADDRESS: CONTRACT }],
    [
      'the address is malformed',
      { ANCHOR_RPC_URL: rpc, ANCHOR_CONTRACT_ADDRESS: '0x1234' },
    ],
    [
      'the address has a wrong checksum',
      {
        ANCHOR_RPC_URL: rpc,
        ANCHOR_CONTRACT_ADDRESS: CONTRACT.replace('cA', 'Ca'),
      },
    ],
    [
      'the RPC is not a URL',
      { ANCHOR_RPC_URL: 'fuji', ANCHOR_CONTRACT_ADDRESS: CONTRACT },
    ],
  ])('fails at startup, instead of falling back, when %s', (_label, env) => {
    expect(() => anchorReaderFromEnv(env)).toThrow(/ANCHOR_/);
  });

  it('has an anchoring target exactly when it has a chain to read', () => {
    expect(anchorTargetFromEnv({})).toBeNull();
    expect(
      anchorTargetFromEnv({ ANCHOR_RPC_URL: ' ', ANCHOR_CONTRACT_ADDRESS: '' }),
    ).toBeNull();
    expect(
      anchorTargetFromEnv({
        ANCHOR_RPC_URL: rpc,
        ANCHOR_CONTRACT_ADDRESS: CONTRACT,
      }),
    ).toEqual({ chainId: 43113, contractAddress: CONTRACT });
    // The same errors as the reader: never a target from half a configuration.
    expect(() => anchorTargetFromEnv({ ANCHOR_RPC_URL: rpc })).toThrow(
      /ANCHOR_/,
    );
    expect(() =>
      anchorTargetFromEnv({ ANCHOR_CONTRACT_ADDRESS: CONTRACT }),
    ).toThrow(/ANCHOR_/);
  });

  it('never puts a configured value in its error', () => {
    const secretUrl = 'ftp://user:secret-token@rpc.example/path';
    try {
      anchorReaderFromEnv({
        ANCHOR_RPC_URL: secretUrl,
        ANCHOR_CONTRACT_ADDRESS: CONTRACT,
      });
      throw new Error('expected a configuration error');
    } catch (error) {
      expect((error as Error).message).not.toContain('secret-token');
    }
  });
});
