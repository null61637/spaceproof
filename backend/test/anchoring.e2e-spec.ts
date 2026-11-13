import { randomBytes, randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  AnchorJob,
  AnchorRepository,
} from '../src/anchoring/anchor-repository';
import {
  ANCHOR_SIGNER,
  AnchorRejectedError,
  AnchorSending,
  AnchorSignerConfigError,
  SignedAnchor,
} from '../src/anchoring/anchor-signer';
import {
  AnchoringService,
  MAX_ANCHOR_ATTEMPTS,
} from '../src/anchoring/anchoring.service';
import { AppModule } from '../src/app.module';
import { setupApp } from '../src/app.setup';
import {
  ANCHOR_TARGET,
  AnchorLookup,
  AnchorReader,
  AnchorTarget,
  AnchorTransaction,
} from '../src/certificates/anchor-reader';
import { computeCertificateHash } from '../src/certificates/certificate-hash';
import { PrismaService } from '../src/prisma/prisma.service';
import { connectAs, pgError } from './db';
import {
  CertificateBody,
  VerificationBody,
  insertV1,
  issue,
  tiff,
} from './files';

// Sending, confirming and recovering anchors (F6.4, F6.5) and verifying
// against them (F6.6), with the real PostgreSQL of the test database and a
// SIMULATED chain: FakeChain below stands in for the contract, the RPC and
// the signer. No network is touched and no transaction exists outside this
// process. What the tests assert is the state persisted in the Anchor rows.

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const OTHER_CONTRACT = `0x${'11'.repeat(20)}`;

type Mined = Extract<AnchorTransaction, { state: 'MINED' }>;

/** A contract, its chain and the RPC in front of them, in memory. */
class FakeChain {
  /** A contract address of this test file only: sweeps touch no other row. */
  readonly target: AnchorTarget = {
    chainId: 43113,
    contractAddress: `0x${hex(20)}`,
  };
  /** The contract's storage: anchoredAt(hash). */
  readonly stored = new Map<string, Date>();
  /** What the RPC answers for a transaction hash. Absent: unknown. */
  readonly transactions = new Map<string, AnchorTransaction>();
  /** Every transaction handed to the RPC, in order. */
  readonly broadcasts: { txHash: string; contentHash: string }[] = [];
  private block = 100n;

  /** What happens to a transaction once it is broadcast. */
  onBroadcast: 'mine' | 'revert' | 'pending' | 'lost' = 'mine';
  /** The RPC accepts the transaction but the answer never arrives. */
  broadcastTimesOut = false;
  readerDown: Error | null = null;
  signerProblem: Error | null = null;
  /** The contract would revert the call with this error. */
  refuses: string | null = null;

  reader(): AnchorReader {
    return {
      lookup: (contentHash: string): Promise<AnchorLookup> => {
        if (this.readerDown) return Promise.reject(this.readerDown);
        const anchoredAt = this.stored.get(contentHash);
        return Promise.resolve(
          anchoredAt
            ? { state: 'ANCHORED', anchoredAt }
            : { state: 'NOT_ANCHORED' },
        );
      },
      transaction: (txHash: string): Promise<AnchorTransaction> => {
        if (this.readerDown) return Promise.reject(this.readerDown);
        return Promise.resolve(
          this.transactions.get(txHash) ?? { state: 'UNKNOWN' },
        );
      },
    };
  }

  /** A signer of this chain. `beforeSigning` lets a test line up a race. */
  signer(beforeSigning: () => Promise<void> = () => Promise.resolve()) {
    const signed: SignedAnchor[] = [];
    const contentOf = new Map<string, string>();
    const sending: AnchorSending = {
      contractAddress: this.target.contractAddress,
      assertReady: () =>
        this.signerProblem
          ? Promise.reject(this.signerProblem)
          : Promise.resolve(),
      sign: async (contentHash: string) => {
        if (this.signerProblem) throw this.signerProblem;
        if (this.refuses) throw new AnchorRejectedError(this.refuses);
        await beforeSigning();
        const transaction: SignedAnchor = {
          txHash: `0x${hex(32)}`,
          serializedTransaction: `0x${hex(8)}`,
        };
        signed.push(transaction);
        contentOf.set(transaction.txHash, contentHash);
        return transaction;
      },
      broadcast: (transaction: SignedAnchor) => {
        const contentHash = contentOf.get(transaction.txHash) as string;
        this.broadcasts.push({ txHash: transaction.txHash, contentHash });
        if (this.onBroadcast === 'mine')
          this.mine(transaction.txHash, contentHash);
        if (this.onBroadcast === 'revert') this.revert(transaction.txHash);
        if (this.onBroadcast === 'pending') {
          this.transactions.set(transaction.txHash, { state: 'PENDING' });
        }
        return this.broadcastTimesOut
          ? Promise.reject(new Error('timeout'))
          : Promise.resolve();
      },
    };
    return { sending, signed };
  }

  /** The transaction succeeds: the contract stores the hash and emits it. */
  mine(txHash: string, contentHash: string, overrides: Partial<Mined> = {}) {
    const anchoredAt = new Date(1_794_572_305_000 + Number(this.block) * 1000);
    this.block += 1n;
    if (!overrides.anchored) this.stored.set(contentHash, anchoredAt);
    this.transactions.set(txHash, {
      state: 'MINED',
      success: true,
      to: this.target.contractAddress,
      blockNumber: this.block,
      confirmations: 1,
      anchored: [{ contentHash, anchoredAt }],
      ...overrides,
    });
    return anchoredAt;
  }

  revert(txHash: string) {
    this.block += 1n;
    this.transactions.set(txHash, {
      state: 'MINED',
      success: false,
      to: this.target.contractAddress,
      blockNumber: this.block,
      confirmations: 1,
      anchored: [],
    });
  }
}

describe('Anchoring (e2e, simulated chain)', () => {
  let prisma: PrismaService;
  let repository: AnchorRepository;
  let chain: FakeChain;
  let logged: unknown[];

  beforeAll(() => {
    prisma = new PrismaService();
    repository = new AnchorRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(() => {
    chain = new FakeChain();
    logged = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => void logged.push(args));
    }
  });

  afterEach(() => jest.restoreAllMocks());

  /** A process: its own service and signer over the shared chain and database. */
  function processOf(
    beforeSigning?: () => Promise<void>,
    target: AnchorTarget | null = chain.target,
  ) {
    const { sending, signed } = chain.signer(beforeSigning);
    const service = new AnchoringService(
      repository,
      chain.reader(),
      sending,
      target,
    );
    // No waiting in tests; a "lost" transaction is given up at once only
    // where a test says so.
    service.timing = { ...service.timing, settleDelaysMs: [0] };
    return { service, signed };
  }

  /** A certificate with its PENDING anchor, created like issuing does. */
  async function pendingAnchor(target: AnchorTarget = chain.target) {
    // A consistent version-1 record: its hash is the real one.
    const record = {
      id: randomUUID(),
      title: 'Anchoring e2e',
      recipient: 'Ada',
      createdAt: new Date(),
    };
    const contentHash = computeCertificateHash(record);
    const certificate = await prisma.certificate.create({
      data: {
        ...record,
        contentHash,
        anchor: { create: target },
      },
      include: { anchor: true },
    });
    return { id: certificate.anchor!.id, contentHash };
  }

  const row = (id: string) =>
    prisma.anchor.findUniqueOrThrow({ where: { id } });

  /** An anchor already SUBMITTED, with a transaction this test controls. */
  async function submittedAnchor() {
    const anchor = await pendingAnchor();
    const txHash = `0x${hex(32)}`;
    const job = (await repository.find(anchor.id)) as AnchorJob;
    expect(await repository.markSubmitted(job, txHash)).toBe(true);
    return { ...anchor, txHash };
  }

  describe('sending and confirming', () => {
    it('sends a PENDING anchor once and confirms it from the chain', async () => {
      const { service } = processOf();
      const anchor = await pendingAnchor();

      await expect(service.process(anchor.id)).resolves.toBe('CONFIRMED');

      // Only the certificate hash was sent, in one transaction.
      expect(chain.broadcasts).toEqual([
        {
          txHash: expect.any(String) as string,
          contentHash: anchor.contentHash,
        },
      ]);
      const [{ txHash }] = chain.broadcasts;
      expect(await row(anchor.id)).toMatchObject({
        status: 'CONFIRMED',
        txHash,
        blockNumber: (chain.transactions.get(txHash) as Mined).blockNumber,
        anchoredAt: chain.stored.get(anchor.contentHash),
        attempts: 1,
        lastError: null,
        chainId: 43113,
        contractAddress: chain.target.contractAddress,
      });
    });

    it('records the transaction hash before broadcasting it', async () => {
      const anchor = await pendingAnchor();
      const { sending } = chain.signer();
      let seenAtBroadcast: unknown;
      const service = new AnchoringService(
        repository,
        chain.reader(),
        {
          ...sending,
          broadcast: async (signed) => {
            seenAtBroadcast = await row(anchor.id);
            return sending.broadcast(signed);
          },
        },
        chain.target,
      );
      service.timing = { ...service.timing, settleDelaysMs: [0] };
      await service.process(anchor.id);
      expect(seenAtBroadcast).toMatchObject({
        status: 'SUBMITTED',
        txHash: chain.broadcasts[0].txHash,
        attempts: 1,
        anchoredAt: null,
      });
    });

    it('does not treat SUBMITTED as confirmed: a pending transaction stays SUBMITTED', async () => {
      chain.onBroadcast = 'pending';
      const { service, signed } = processOf();
      const anchor = await pendingAnchor();
      await expect(service.process(anchor.id)).resolves.toBe('OPEN');
      await service.sweep();
      await service.sweep();
      expect(await row(anchor.id)).toMatchObject({
        status: 'SUBMITTED',
        txHash: signed[0].txHash,
        anchoredAt: null,
        blockNumber: null,
      });
      // Waiting sends nothing again.
      expect(chain.broadcasts).toHaveLength(1);
    });

    it('confirms without sending when the hash is already on chain', async () => {
      const { service, signed } = processOf();
      const anchor = await pendingAnchor();
      const anchoredAt = new Date('2026-11-13T12:18:25Z');
      chain.stored.set(anchor.contentHash, anchoredAt);
      await expect(service.process(anchor.id)).resolves.toBe('CONFIRMED');
      expect(signed).toEqual([]);
      expect(chain.broadcasts).toEqual([]);
      expect(await row(anchor.id)).toMatchObject({
        status: 'CONFIRMED',
        txHash: null,
        blockNumber: null,
        anchoredAt,
        attempts: 0,
      });
    });

    it.each(['SUBMITTED', 'CONFIRMED'])(
      'never sends an anchor that is already %s',
      async (status) => {
        const { service, signed } = processOf();
        const anchor = await submittedAnchor();
        chain.transactions.set(anchor.txHash, { state: 'PENDING' });
        if (status === 'CONFIRMED') {
          chain.mine(anchor.txHash, anchor.contentHash);
          await service.process(anchor.id);
        }
        const before = await row(anchor.id);
        expect(before.status).toBe(status);

        await service.process(anchor.id);
        await service.sweep();
        expect(signed).toEqual([]);
        expect(chain.broadcasts).toEqual([]);
        expect(await row(anchor.id)).toEqual(before);
      },
    );

    it('does nothing at all without a signer or without a contract', async () => {
      const anchor = await pendingAnchor();
      const lookup = jest.fn();
      const disabled = [
        new AnchoringService(
          repository,
          { lookup } as never,
          null,
          chain.target,
        ),
        new AnchoringService(
          repository,
          { lookup } as never,
          chain.signer().sending,
          null,
        ),
      ];
      for (const service of disabled) {
        expect(service.enabled).toBe(false);
        service.wake();
        await service.sweep();
        await expect(service.process(anchor.id)).resolves.toBeNull();
      }
      expect(lookup).not.toHaveBeenCalled();
      expect(await row(anchor.id)).toMatchObject({
        status: 'PENDING',
        attempts: 0,
      });
    });

    it('only handles anchors of the contract it signs for', async () => {
      const { service } = processOf();
      const foreign = await pendingAnchor({
        chainId: 43113,
        contractAddress: `0x${hex(20)}`,
      });
      await service.sweep();
      await expect(service.process(foreign.id)).resolves.toBeNull();
      expect(chain.broadcasts).toEqual([]);
      expect(await row(foreign.id)).toMatchObject({
        status: 'PENDING',
        attempts: 0,
      });
    });
  });

  describe('before anything is sent', () => {
    it.each<[string, () => Error]>([
      [
        'the RPC is on another chain',
        () => new AnchorSignerConfigError('chain 43114'),
      ],
      [
        'the key is not the contract owner',
        () => new AnchorSignerConfigError('not the owner'),
      ],
    ])('signs and changes nothing when %s', async (_label, problem) => {
      chain.signerProblem = problem();
      const { service, signed } = processOf();
      const anchors = [await pendingAnchor(), await pendingAnchor()];
      await service.sweep();
      await expect(service.process(anchors[0].id)).rejects.toBeInstanceOf(
        AnchorSignerConfigError,
      );
      expect(signed).toEqual([]);
      expect(chain.broadcasts).toEqual([]);
      for (const anchor of anchors) {
        expect(await row(anchor.id)).toMatchObject({
          status: 'PENDING',
          attempts: 0,
          txHash: null,
          lastError: null,
        });
      }
    });

    it('leaves the anchor PENDING, without using an attempt, while the RPC is down', async () => {
      chain.readerDown = new Error('fetch failed');
      const { service, signed } = processOf();
      const anchor = await pendingAnchor();
      await expect(service.process(anchor.id)).rejects.toThrow('fetch failed');
      for (let i = 0; i < MAX_ANCHOR_ATTEMPTS + 2; i++) await service.sweep();
      expect(signed).toEqual([]);
      expect(await row(anchor.id)).toMatchObject({
        status: 'PENDING',
        attempts: 0,
        txHash: null,
        lastError: 'Error',
      });

      // The RPC comes back: the same anchor goes through.
      chain.readerDown = null;
      await service.sweep();
      expect(await row(anchor.id)).toMatchObject({
        status: 'CONFIRMED',
        attempts: 1,
        lastError: null,
      });
      expect(chain.broadcasts).toHaveLength(1);
    });

    it('counts a refusal by the contract, and fails after the last attempt', async () => {
      chain.refuses = 'EmptyHash';
      const { service, signed } = processOf();
      const anchor = await pendingAnchor();
      for (let attempt = 1; attempt < MAX_ANCHOR_ATTEMPTS; attempt++) {
        await expect(service.process(anchor.id)).resolves.toBe('RETRY');
        expect(await row(anchor.id)).toMatchObject({
          status: 'PENDING',
          attempts: attempt,
          lastError: 'EmptyHash',
        });
      }
      await expect(service.process(anchor.id)).resolves.toBe('FAILED');
      expect(await row(anchor.id)).toMatchObject({
        status: 'FAILED',
        attempts: MAX_ANCHOR_ATTEMPTS,
        lastError: 'EmptyHash',
        txHash: null,
      });
      expect(signed).toEqual([]);
      expect(chain.broadcasts).toEqual([]);
    });

    it('confirms, instead of counting a refusal, when the contract refuses because the hash got there first', async () => {
      const { service } = processOf();
      const anchor = await pendingAnchor();
      chain.refuses = 'AlreadyAnchored';
      // Not there at the first look; there when asked again after the refusal.
      const reader = chain.reader();
      let looks = 0;
      const racing = new AnchoringService(
        repository,
        {
          transaction: (txHash: string) => reader.transaction(txHash),
          lookup: (hash: string) => {
            if (looks++ === 1)
              chain.stored.set(hash, new Date(1_794_572_305_000));
            return reader.lookup(hash);
          },
        },
        chain.signer().sending,
        chain.target,
      );
      await expect(racing.process(anchor.id)).resolves.toBe('CONFIRMED');
      expect(await row(anchor.id)).toMatchObject({
        status: 'CONFIRMED',
        txHash: null,
        attempts: 0,
      });
      expect(service.enabled).toBe(true);
    });
  });

  describe('unknown and failed outcomes', () => {
    it('settles a broadcast that timed out but was mined, by its recorded hash', async () => {
      chain.broadcastTimesOut = true;
      const { service } = processOf();
      const anchor = await pendingAnchor();
      await expect(service.process(anchor.id)).resolves.toBe('CONFIRMED');
      expect(chain.broadcasts).toHaveLength(1);
      expect(await row(anchor.id)).toMatchObject({
        status: 'CONFIRMED',
        txHash: chain.broadcasts[0].txHash,
        attempts: 1,
      });
    });

    it('does not send again while the outcome of a timed-out broadcast is unknown', async () => {
      chain.broadcastTimesOut = true;
      chain.onBroadcast = 'lost';
      const { service, signed } = processOf();
      const anchor = await pendingAnchor();
      await expect(service.process(anchor.id)).resolves.toBe('OPEN');
      for (let i = 0; i < 3; i++) await service.sweep();
      // Still waiting on the one recorded transaction.
      expect(signed).toHaveLength(1);
      expect(chain.broadcasts).toHaveLength(1);
      expect(await row(anchor.id)).toMatchObject({
        status: 'SUBMITTED',
        txHash: signed[0].txHash,
        attempts: 1,
      });

      // It shows up after all: confirmed with that same transaction.
      chain.mine(signed[0].txHash, anchor.contentHash);
      await service.sweep();
      expect(await row(anchor.id)).toMatchObject({
        status: 'CONFIRMED',
        txHash: signed[0].txHash,
        attempts: 1,
      });
      expect(chain.broadcasts).toHaveLength(1);
    });

    it('gives a lost transaction up after the waiting time, and only then sends another', async () => {
      chain.onBroadcast = 'lost';
      const { service, signed } = processOf();
      const anchor = await pendingAnchor();
      await service.process(anchor.id);
      expect((await row(anchor.id)).status).toBe('SUBMITTED');

      service.timing = { ...service.timing, lostAfterMs: 0 };
      await expect(service.process(anchor.id)).resolves.toBe('RETRY');
      expect(await row(anchor.id)).toMatchObject({
        status: 'PENDING',
        txHash: null,
        attempts: 1,
        lastError: 'TransactionNotFound',
      });

      chain.onBroadcast = 'mine';
      await service.sweep();
      expect(signed).toHaveLength(2);
      expect(await row(anchor.id)).toMatchObject({
        status: 'CONFIRMED',
        txHash: signed[1].txHash,
        attempts: 2,
        lastError: null,
      });
    });

    it('never confirms a reverted transaction: back to PENDING, to try again', async () => {
      chain.onBroadcast = 'revert';
      const { service, signed } = processOf();
      const anchor = await pendingAnchor();
      await expect(service.process(anchor.id)).resolves.toBe('RETRY');
      expect(await row(anchor.id)).toMatchObject({
        status: 'PENDING',
        txHash: null,
        anchoredAt: null,
        attempts: 1,
        lastError: 'TransactionReverted',
      });
      expect(signed).toHaveLength(1);
    });

    it('confirms without a transaction when its own reverted because the hash was already there', async () => {
      const { service } = processOf();
      const anchor = await submittedAnchor();
      chain.revert(anchor.txHash);
      const anchoredAt = new Date('2026-11-13T12:18:25Z');
      chain.stored.set(anchor.contentHash, anchoredAt);
      await expect(service.process(anchor.id)).resolves.toBe('CONFIRMED');
      expect(await row(anchor.id)).toMatchObject({
        status: 'CONFIRMED',
        // The reverted transaction is not kept as evidence.
        txHash: null,
        anchoredAt,
      });
    });

    it('fails after the last attempt, and then stays FAILED', async () => {
      chain.onBroadcast = 'revert';
      const { service, signed } = processOf();
      const anchor = await pendingAnchor();
      for (let i = 0; i < MAX_ANCHOR_ATTEMPTS + 3; i++) await service.sweep();
      expect(signed).toHaveLength(MAX_ANCHOR_ATTEMPTS);
      expect(await row(anchor.id)).toMatchObject({
        status: 'FAILED',
        attempts: MAX_ANCHOR_ATTEMPTS,
        lastError: 'TransactionReverted',
        anchoredAt: null,
      });
      await expect(service.process(anchor.id)).resolves.toBe('FAILED');
      expect(signed).toHaveLength(MAX_ANCHOR_ATTEMPTS);
    });

    it('retries a FAILED anchor only when asked to, with its attempts again', async () => {
      chain.onBroadcast = 'revert';
      const { service, signed } = processOf();
      const anchor = await pendingAnchor();
      for (let i = 0; i < MAX_ANCHOR_ATTEMPTS; i++) await service.sweep();
      expect((await row(anchor.id)).status).toBe('FAILED');

      chain.onBroadcast = 'mine';
      await expect(service.retry(anchor.id)).resolves.toBe(true);
      await service.sweep();
      expect(await row(anchor.id)).toMatchObject({
        status: 'CONFIRMED',
        attempts: 1,
        txHash: signed[MAX_ANCHOR_ATTEMPTS].txHash,
        lastError: null,
      });
      // Only FAILED anchors can be reopened.
      await expect(service.retry(anchor.id)).resolves.toBe(false);
      await expect(service.retry(randomUUID())).resolves.toBe(false);
    });

    it.each<
      [string, (anchor: { txHash: string; contentHash: string }) => void]
    >([
      ['anchored another hash', ({ txHash }) => chain.mine(txHash, hex(32))],
      [
        'went to another contract',
        ({ txHash, contentHash }) =>
          chain.mine(txHash, contentHash, { to: OTHER_CONTRACT, anchored: [] }),
      ],
      [
        'emitted no Anchored event',
        ({ txHash, contentHash }) =>
          chain.mine(txHash, contentHash, { anchored: [] }),
      ],
    ])(
      'fails, and does not confirm or resend, when the recorded transaction %s',
      async (_label, arrange) => {
        const { service, signed } = processOf();
        const anchor = await submittedAnchor();
        arrange(anchor);
        await expect(service.process(anchor.id)).resolves.toBe('FAILED');
        await service.sweep();
        expect(await row(anchor.id)).toMatchObject({
          status: 'FAILED',
          txHash: anchor.txHash,
          anchoredAt: null,
          lastError: 'TransactionMismatch',
        });
        expect(signed).toEqual([]);
      },
    );

    it('confirms nothing while the receipt and the stored value disagree', async () => {
      const { service } = processOf();
      const anchor = await submittedAnchor();
      chain.mine(anchor.txHash, anchor.contentHash);
      chain.stored.delete(anchor.contentHash);
      await expect(service.process(anchor.id)).resolves.toBe('OPEN');
      chain.stored.set(anchor.contentHash, new Date(0));
      await expect(service.process(anchor.id)).resolves.toBe('OPEN');
      expect(await row(anchor.id)).toMatchObject({
        status: 'SUBMITTED',
        anchoredAt: null,
      });
    });

    it('waits for the required confirmations', async () => {
      const { service } = processOf();
      const anchor = await submittedAnchor();
      chain.mine(anchor.txHash, anchor.contentHash, { confirmations: 0 });
      await expect(service.process(anchor.id)).resolves.toBe('OPEN');
      expect((await row(anchor.id)).status).toBe('SUBMITTED');
      chain.mine(anchor.txHash, anchor.contentHash);
      await expect(service.process(anchor.id)).resolves.toBe('CONFIRMED');
    });

    it('invents no result while the RPC is down during confirmation', async () => {
      const { service, signed } = processOf();
      const anchor = await submittedAnchor();
      chain.mine(anchor.txHash, anchor.contentHash);
      chain.readerDown = new Error(
        'request to https://rpc.example/?key=secret-token failed',
      );
      await expect(service.process(anchor.id)).rejects.toThrow();
      await service.sweep();
      expect(await row(anchor.id)).toMatchObject({
        status: 'SUBMITTED',
        txHash: anchor.txHash,
        anchoredAt: null,
        // The error's name: never its message, which holds the RPC URL.
        lastError: 'Error',
      });
      expect(inspect(logged, { depth: 10 })).not.toContain('secret-token');

      chain.readerDown = null;
      await service.sweep();
      expect(await row(anchor.id)).toMatchObject({
        status: 'CONFIRMED',
        txHash: anchor.txHash,
        lastError: null,
      });
      expect(signed).toEqual([]);
    });
  });

  describe('recovery and concurrency', () => {
    it('continues after a restart from what the database says, without sending again', async () => {
      chain.onBroadcast = 'pending';
      const first = processOf();
      const sent = await pendingAnchor();
      const untouched = await pendingAnchor();
      await first.service.process(sent.id);
      await first.service.onModuleDestroy();

      // The transaction is mined while no backend is running.
      const [{ txHash }] = chain.broadcasts;
      chain.mine(txHash, sent.contentHash);
      chain.onBroadcast = 'mine';

      // A new process: nothing in memory, only the rows.
      const second = processOf();
      await second.service.sweep();
      expect(await row(sent.id)).toMatchObject({
        status: 'CONFIRMED',
        txHash,
        attempts: 1,
      });
      // The one that was never sent is sent now, once.
      expect(await row(untouched.id)).toMatchObject({
        status: 'CONFIRMED',
        attempts: 1,
      });
      expect(second.signed).toHaveLength(1);
      expect(chain.broadcasts.map((b) => b.contentHash)).toEqual([
        sent.contentHash,
        untouched.contentHash,
      ]);
    });

    it('is safe to run again and again', async () => {
      const { service, signed } = processOf();
      const anchors = [await pendingAnchor(), await pendingAnchor()];
      for (let i = 0; i < 4; i++) await service.sweep();
      await Promise.all([service.sweep(), service.sweep(), service.sweep()]);
      expect(signed).toHaveLength(2);
      expect(chain.broadcasts).toHaveLength(2);
      for (const anchor of anchors) {
        expect(await row(anchor.id)).toMatchObject({
          status: 'CONFIRMED',
          attempts: 1,
        });
      }
    });

    it('sends one transaction when two processes take the same anchor at once', async () => {
      // Both sign before either records its transaction: a real race for
      // the row, decided by the database.
      let arrived = 0;
      let release: () => void = () => undefined;
      const both = new Promise<void>((resolve) => (release = resolve));
      const barrier = () => {
        if (++arrived === 2) release();
        return both;
      };
      const a = processOf(barrier);
      const b = processOf(barrier);
      const anchor = await pendingAnchor();

      await Promise.all([
        a.service.process(anchor.id),
        b.service.process(anchor.id),
      ]);

      expect(a.signed.length + b.signed.length).toBe(2);
      // Only the winner's transaction left its process.
      expect(chain.broadcasts).toHaveLength(1);
      const stored = await row(anchor.id);
      expect(stored).toMatchObject({
        status: 'CONFIRMED',
        txHash: chain.broadcasts[0].txHash,
        attempts: 1,
      });
    });

    it('confirms once when two processes confirm the same anchor at once', async () => {
      const a = processOf();
      const b = processOf();
      const anchor = await submittedAnchor();
      chain.mine(anchor.txHash, anchor.contentHash);
      const job = (await repository.find(anchor.id)) as AnchorJob;
      const evidence = {
        txHash: anchor.txHash,
        blockNumber: 7n,
        anchoredAt: new Date(0),
      };

      const outcomes = await Promise.all([
        a.service.process(anchor.id),
        b.service.process(anchor.id),
      ]);
      expect(outcomes).toEqual(['CONFIRMED', 'CONFIRMED']);
      const confirmed = await row(anchor.id);
      expect(confirmed).toMatchObject({
        status: 'CONFIRMED',
        txHash: anchor.txHash,
        anchoredAt: chain.stored.get(anchor.contentHash),
      });

      // A late writer that still believes it is SUBMITTED changes nothing.
      await expect(repository.markConfirmed(job, evidence)).resolves.toBe(
        false,
      );
      await expect(repository.markFailed(job, 'Late')).resolves.toBe(false);
      await expect(repository.backToPending(job, 'Late')).resolves.toBe(false);
      expect(await row(anchor.id)).toEqual(confirmed);
    });

    it('cannot overwrite a confirmation, even bypassing the service', async () => {
      const { service } = processOf();
      const anchor = await pendingAnchor();
      await service.process(anchor.id);
      const confirmed = await row(anchor.id);
      const job = { ...((await repository.find(anchor.id)) as AnchorJob) };

      for (const attempt of [
        repository.markFailed(job, 'x'),
        repository.backToPending(job, 'x'),
        repository.noteError(job, 'x'),
        repository.reopen(anchor.id),
        repository.markConfirmed(job, {
          txHash: null,
          blockNumber: null,
          anchoredAt: new Date(0),
        }),
      ]) {
        await expect(attempt).resolves.toBe(false);
      }
      // And the database refuses a direct UPDATE by the runtime role.
      const asApp = await connectAs('DATABASE_URL');
      try {
        const error = await pgError(
          asApp.query(
            `UPDATE "Anchor" SET "status" = 'PENDING' WHERE id = $1`,
            [anchor.id],
          ),
        );
        expect(error.message).toMatch(/is confirmed/);
      } finally {
        await asApp.end();
      }
      expect(await row(anchor.id)).toEqual(confirmed);
    });

    it('never writes anything but names into lastError or the logs', async () => {
      chain.readerDown = Object.assign(
        new Error('POST https://rpc.example/v1/secret-token: ECONNRESET'),
        { name: 'HttpRequestError' },
      );
      const { service } = processOf();
      const anchor = await pendingAnchor();
      await service.sweep();
      expect((await row(anchor.id)).lastError).toBe('HttpRequestError');
      expect(inspect(logged, { depth: 10 })).not.toContain('secret-token');
    });
  });
});

// The whole path through the application: issue over HTTP, the anchor is sent
// and confirmed against the simulated chain, and verification checks the
// certificate, the record and the chain against each other.
describe('Issuing, anchoring and verifying (e2e, simulated chain)', () => {
  const chain = new FakeChain();
  let app: INestApplication<App>;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AnchorReader)
      .useValue(chain.reader())
      .overrideProvider(ANCHOR_TARGET)
      .useValue(chain.target)
      .overrideProvider(ANCHOR_SIGNER)
      .useValue(chain.signer().sending)
      .compile();
    app = moduleRef.createNestApplication();
    app.useLogger(false);
    setupApp(app);
    const service = app.get(AnchoringService);
    service.timing = { ...service.timing, settleDelaysMs: [0] };
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  const anchorOf = (certificateId: string) =>
    prisma.anchor.findUniqueOrThrow({ where: { certificateId } });

  async function until(certificateId: string, status: string) {
    for (let i = 0; i < 100; i++) {
      const anchor = await anchorOf(certificateId);
      if (anchor.status === status) return anchor;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`anchor never became ${status}`);
  }

  async function verify(id: string) {
    const res = await request(app.getHttpServer())
      .get(`/api/certificates/${id}/verify`)
      .expect(200);
    return res.body as VerificationBody & {
      anchor: { status: string; txHash: string | null } | null;
    };
  }

  /** Issues a certificate and waits for its anchor to be confirmed. */
  async function anchored(fill: number) {
    chain.onBroadcast = 'mine';
    const file = tiff(2048, fill);
    const certificate = (await issue(app, file).expect(201))
      .body as CertificateBody;
    const anchor = await until(certificate.id, 'CONFIRMED');
    return { certificate, anchor, file };
  }

  it('issues, anchors on its own and verifies as VALID with the transaction', async () => {
    const { certificate, anchor, file } = await anchored(21);

    // Issuing answered with the certificate alone, as always.
    expect(certificate).not.toHaveProperty('anchor');
    expect(chain.broadcasts.at(-1)).toEqual({
      txHash: anchor.txHash,
      contentHash: certificate.contentHash,
    });

    const result = await verify(certificate.id);
    expect(result).toMatchObject({
      status: 'VALID',
      reason: null,
      checks: { record: 'MATCH', anchor: 'ANCHORED' },
      anchoredAt: chain.stored.get(certificate.contentHash)?.toISOString(),
      anchor: {
        status: 'CONFIRMED',
        txHash: anchor.txHash,
        chainId: 43113,
        contractAddress: chain.target.contractAddress,
      },
    });

    // With the file: the original is valid, a changed bit is not.
    const withFile = await request(app.getHttpServer())
      .post(`/api/certificates/${certificate.id}/verify-file`)
      .set('Content-Type', 'image/tiff')
      .send(file)
      .expect(200);
    expect(withFile.body).toMatchObject({
      status: 'VALID',
      checks: { file: 'MATCH', record: 'MATCH', anchor: 'ANCHORED' },
    });
    const altered = Buffer.from(file);
    altered[500] ^= 1;
    const tampered = await request(app.getHttpServer())
      .post(`/api/certificates/${certificate.id}/verify-file`)
      .set('Content-Type', 'image/tiff')
      .send(altered)
      .expect(200);
    expect(tampered.body).toMatchObject({
      status: 'INVALID',
      reason: 'FILE_MISMATCH',
    });
  });

  it('is PENDING, with the record visible, while the transaction is not mined', async () => {
    chain.onBroadcast = 'pending';
    const certificate = (await issue(app, tiff(2048, 22)).expect(201))
      .body as CertificateBody;
    const anchor = await until(certificate.id, 'SUBMITTED');
    expect(await verify(certificate.id)).toMatchObject({
      status: 'PENDING',
      reason: 'NOT_ANCHORED',
      anchoredAt: null,
      anchor: { status: 'SUBMITTED', txHash: anchor.txHash },
    });
  });

  it('is INVALID when the record says CONFIRMED and the chain no longer has the hash', async () => {
    const { certificate } = await anchored(23);
    chain.stored.delete(certificate.contentHash);
    expect(await verify(certificate.id)).toMatchObject({
      status: 'INVALID',
      reason: 'NOT_ANCHORED',
      anchoredAt: null,
      anchor: { status: 'CONFIRMED' },
    });
  });

  it.each<[string, (txHash: string, contentHash: string) => void]>([
    ['reverted', (txHash) => chain.revert(txHash)],
    ['is unknown to the chain', (txHash) => chain.transactions.delete(txHash)],
    [
      'anchored another hash',
      (txHash, contentHash) => {
        const kept = chain.stored.get(contentHash) as Date;
        chain.mine(txHash, hex(32));
        chain.stored.set(contentHash, kept);
      },
    ],
    [
      'went to another contract',
      (txHash) =>
        chain.transactions.set(txHash, {
          ...(chain.transactions.get(txHash) as Mined),
          to: OTHER_CONTRACT,
          anchored: [],
        }),
    ],
  ])(
    'is INVALID when the recorded transaction %s, even with the hash on chain',
    async (_label, arrange) => {
      const { certificate, anchor } = await anchored(24);
      arrange(anchor.txHash as string, certificate.contentHash);
      expect(await verify(certificate.id)).toMatchObject({
        status: 'INVALID',
        reason: 'ANCHOR_RECORD_MISMATCH',
        anchoredAt: null,
      });
      // Verifying reads; it never repairs the record.
      expect(await anchorOf(certificate.id)).toEqual(anchor);
    },
  );

  it('is UNVERIFIABLE, never VALID or INVALID, while the chain cannot be asked', async () => {
    const { certificate, anchor } = await anchored(25);
    chain.readerDown = new Error('fetch failed');
    try {
      expect(await verify(certificate.id)).toMatchObject({
        status: 'UNVERIFIABLE',
        reason: 'ANCHOR_UNAVAILABLE',
        checks: { record: 'MATCH', anchor: 'UNAVAILABLE' },
        anchoredAt: null,
        anchor: { status: 'CONFIRMED', txHash: anchor.txHash },
      });
    } finally {
      chain.readerDown = null;
    }
    expect((await verify(certificate.id)).status).toBe('VALID');
  });

  it('verifies a certificate without an anchoring record as before: by the chain alone', async () => {
    const db = await connectAs('DATABASE_URL');
    try {
      const legacy = await insertV1(db, 'No anchor record');
      expect(await verify(legacy.id)).toMatchObject({
        status: 'PENDING',
        reason: 'NOT_ANCHORED',
        anchor: null,
      });
      chain.stored.set(legacy.contentHash, new Date('2026-11-13T12:18:25Z'));
      expect(await verify(legacy.id)).toMatchObject({
        status: 'VALID',
        anchoredAt: '2026-11-13T12:18:25.000Z',
        anchor: null,
      });
    } finally {
      await db.end();
    }
  });
});
