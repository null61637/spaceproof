import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inspect } from 'node:util';
import { Logger } from '@nestjs/common';
import { custom, numberToHex, pad, type Address } from 'viem';
import { ANCHOR_CHAIN_ID } from '../certificates/avalanche-anchor-reader';
import {
  ANCHOR_SIGNER_ABI,
  AnchorSigner,
  AnchorSignerConfigError,
  anchorSignerFromEnv,
} from './anchor-signer';
import { AnchorSignerStartupCheck } from './anchoring.module';

// The contract deployed on Fuji (contracts/deployments/fuji.json).
const CONTRACT: Address = '0xb5cA7811682676e0B7a8fc568B28dbf6f841c8CF';
// Hardhat's well-known development account #0: public, never funded on a
// real network, and not the key of any SpaceProof contract.
const TEST_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_KEY_BODY = TEST_KEY.slice(2);
const TEST_ADDRESS: Address = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const STRANGER: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const RPC = 'https://api.avax-test.network/ext/bc/C/rpc';

/** A signer over a fake RPC: no network is touched, nothing is ever sent. */
function signerOver(answers: {
  chainId?: () => unknown;
  owner?: () => unknown;
}) {
  const methods: string[] = [];
  const signer = new AnchorSigner(
    custom(
      {
        request: ({ method }: { method: string }) => {
          methods.push(method);
          try {
            if (method === 'eth_chainId') {
              return Promise.resolve(
                (answers.chainId ?? (() => numberToHex(ANCHOR_CHAIN_ID)))(),
              );
            }
            if (method === 'eth_call') {
              return Promise.resolve(
                (answers.owner ?? (() => pad(TEST_ADDRESS)))(),
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
    TEST_KEY,
  );
  return { signer, methods };
}

describe('AnchorSigner', () => {
  it('is ready when the RPC is Fuji and the key is the contract owner', async () => {
    const { signer, methods } = signerOver({});
    await expect(signer.assertReady()).resolves.toBeUndefined();
    expect(signer.address).toBe(TEST_ADDRESS);
    // Read-only calls: nothing was signed or sent.
    expect(methods).toEqual(['eth_chainId', 'eth_call']);
  });

  it('checks once, then asks nothing more', async () => {
    const { signer, methods } = signerOver({});
    await signer.assertReady();
    await signer.assertReady();
    expect(methods).toEqual(['eth_chainId', 'eth_call']);
  });

  it('refuses a key that is not the contract owner', async () => {
    const { signer } = signerOver({ owner: () => pad(STRANGER) });
    await expect(signer.assertReady()).rejects.toBeInstanceOf(
      AnchorSignerConfigError,
    );
    await expect(signer.assertReady()).rejects.toThrow('not the owner');
  });

  it('refuses another chain, without reading the contract', async () => {
    // 43114 is Avalanche mainnet.
    const { signer, methods } = signerOver({
      chainId: () => numberToHex(43114),
    });
    await expect(signer.assertReady()).rejects.toBeInstanceOf(
      AnchorSignerConfigError,
    );
    expect(methods).toEqual(['eth_chainId']);
  });

  it.each<[string, { chainId?: () => unknown; owner?: () => unknown }]>([
    [
      'the chain id cannot be read',
      {
        chainId: () => {
          throw new Error('fetch failed');
        },
      },
    ],
    [
      'the owner cannot be read',
      {
        owner: () => {
          throw new Error('timeout');
        },
      },
    ],
    ['there is no contract at the address', { owner: () => '0x' }],
  ])(
    'is not ready, and it is not a configuration error, when %s',
    async (_l, answers) => {
      const { signer } = signerOver(answers);
      const error: unknown = await signer
        .assertReady()
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(AnchorSignerConfigError);
    },
  );

  it('asks again after a failure, and becomes ready when the RPC answers', async () => {
    let available = false;
    const { signer } = signerOver({
      chainId: () => {
        if (!available) throw new Error('timeout');
        return numberToHex(ANCHOR_CHAIN_ID);
      },
    });
    await expect(signer.assertReady()).rejects.toBeInstanceOf(Error);
    available = true;
    await expect(signer.assertReady()).resolves.toBeUndefined();
  });

  it('never shows the key when it is logged, serialized or fails', async () => {
    const { signer } = signerOver({ owner: () => pad(STRANGER) });
    const error = await signer.assertReady().catch((e: Error) => e);
    const shown = [
      JSON.stringify(signer),
      inspect(signer, { depth: 10, showHidden: true }),
      JSON.stringify(Object.entries(signer)),
      String((error as Error).message),
      String((error as Error).stack),
    ].join('\n');
    expect(shown.toLowerCase()).not.toContain(TEST_KEY_BODY);
    expect(JSON.parse(JSON.stringify(signer))).toEqual({
      address: TEST_ADDRESS,
      contractAddress: CONTRACT,
    });
  });

  it('uses the signatures of the versioned contract ABI', () => {
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
    const shape = (item: (typeof versioned)[number]) => ({
      type: item.type,
      name: item.name,
      stateMutability: item.stateMutability,
      inputs: item.inputs?.map((input) => input.type),
      outputs: item.outputs?.map((output) => output.type),
    });
    for (const used of ANCHOR_SIGNER_ABI) {
      const deployed = versioned.find(
        (item) => item.type === used.type && item.name === used.name,
      );
      expect(deployed && shape(deployed)).toEqual(shape(used));
    }
  });
});

describe('anchorSignerFromEnv', () => {
  const complete = {
    ANCHOR_PRIVATE_KEY: TEST_KEY,
    ANCHOR_RPC_URL: RPC,
    ANCHOR_CONTRACT_ADDRESS: CONTRACT,
  };

  it.each<[string, Record<string, string>]>([
    ['nothing is set', {}],
    [
      'only the read variables are set',
      { ANCHOR_RPC_URL: RPC, ANCHOR_CONTRACT_ADDRESS: CONTRACT },
    ],
    ['the key is blank', { ...complete, ANCHOR_PRIVATE_KEY: '  ' }],
  ])('has no signer when %s', (_label, env) => {
    expect(anchorSignerFromEnv(env)).toBeNull();
  });

  it('builds the signer of the configured key, without any request', () => {
    const signer = anchorSignerFromEnv(complete);
    expect(signer).toBeInstanceOf(AnchorSigner);
    expect(signer?.address).toBe(TEST_ADDRESS);
    expect(signer?.contractAddress).toBe(CONTRACT);
  });

  it.each<[string, Record<string, string | undefined>]>([
    ['the RPC is missing', { ...complete, ANCHOR_RPC_URL: undefined }],
    [
      'the contract address is missing',
      { ...complete, ANCHOR_CONTRACT_ADDRESS: undefined },
    ],
    [
      'the contract address is malformed',
      { ...complete, ANCHOR_CONTRACT_ADDRESS: '0x1234' },
    ],
    ['the RPC is not a URL', { ...complete, ANCHOR_RPC_URL: 'fuji' }],
    [
      'the key has no 0x prefix',
      { ...complete, ANCHOR_PRIVATE_KEY: TEST_KEY_BODY },
    ],
    [
      'the key is too short',
      { ...complete, ANCHOR_PRIVATE_KEY: TEST_KEY.slice(0, 60) },
    ],
    [
      'the key is not hexadecimal',
      { ...complete, ANCHOR_PRIVATE_KEY: `0x${'zz'.repeat(32)}` },
    ],
    [
      'the key is not a valid secp256k1 key',
      { ...complete, ANCHOR_PRIVATE_KEY: `0x${'00'.repeat(32)}` },
    ],
  ])('fails at startup when %s, without showing any value', (_label, env) => {
    let message = '';
    try {
      anchorSignerFromEnv(env);
    } catch (error) {
      message = `${(error as Error).message}\n${(error as Error).stack}`;
    }
    expect(message).toMatch(/ANCHOR_/);
    for (const value of Object.values(env)) {
      if (value && value !== CONTRACT) {
        expect(message).not.toContain(value.replace(/^0x/, ''));
      }
    }
  });
});

describe('AnchorSignerStartupCheck', () => {
  let logged: unknown[];

  beforeEach(() => {
    logged = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => void logged.push(args));
    }
  });

  afterEach(() => jest.restoreAllMocks());

  const start = (signer: AnchorSigner | null) =>
    new AnchorSignerStartupCheck(signer).onModuleInit();

  it('starts without a signer: the chain is read only', async () => {
    await expect(start(null)).resolves.toBeUndefined();
  });

  it('starts when the signer is the owner on Fuji', async () => {
    await expect(start(signerOver({}).signer)).resolves.toBeUndefined();
  });

  it.each<[string, { chainId?: () => unknown; owner?: () => unknown }]>([
    ['the key is not the owner', { owner: () => pad(STRANGER) }],
    ['the RPC is on another chain', { chainId: () => numberToHex(43114) }],
  ])('refuses to start when %s', async (_label, answers) => {
    await expect(start(signerOver(answers).signer)).rejects.toBeInstanceOf(
      AnchorSignerConfigError,
    );
  });

  it('starts when the RPC does not answer, logging only the error name', async () => {
    const { signer } = signerOver({
      chainId: () => {
        throw new Error(`fetch failed for ${RPC}?token=secret-token`);
      },
    });
    await expect(start(signer)).resolves.toBeUndefined();
    // Still not ready: nothing may be signed until the check passes.
    await expect(signer.assertReady()).rejects.toBeInstanceOf(Error);
    expect(JSON.stringify(logged)).not.toContain('secret-token');
  });

  it('never logs the key', async () => {
    await start(signerOver({}).signer);
    await start(signerOver({ owner: () => pad(STRANGER) }).signer).catch(
      () => undefined,
    );
    expect(logged.length).toBeGreaterThan(0);
    expect(inspect(logged, { depth: 10 }).toLowerCase()).not.toContain(
      TEST_KEY_BODY,
    );
  });
});
