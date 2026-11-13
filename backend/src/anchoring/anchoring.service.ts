import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import {
  ANCHOR_TARGET,
  AnchorReader,
  anchorEvidence,
} from '../certificates/anchor-reader';
import type { AnchorTarget } from '../certificates/anchor-reader';
import { AnchorJob, AnchorRepository } from './anchor-repository';
import {
  ANCHOR_SIGNER,
  AnchorRejectedError,
  AnchorSignerConfigError,
} from './anchor-signer';
import type { AnchorSending } from './anchor-signer';

/** Signed transactions an anchor may use before it is FAILED. */
export const MAX_ANCHOR_ATTEMPTS = 5;

/** What became of an anchor in one pass. OPEN: nothing final yet. */
export type AnchorOutcome = 'CONFIRMED' | 'FAILED' | 'RETRY' | 'OPEN';

const errorName = (error: unknown): string =>
  error instanceof Error ? error.name : typeof error;

/**
 * Sends the hash of each certificate to the SpaceProofAnchor contract and
 * confirms the result by reading the chain.
 *
 *   PENDING   -> SUBMITTED  a transaction was signed and its hash recorded
 *   PENDING   -> CONFIRMED  the hash was already on chain: nothing is sent
 *   SUBMITTED -> CONFIRMED  receipt, contract, event and stored value agree
 *   SUBMITTED -> PENDING    its transaction reverted or was lost: try again
 *   any open  -> FAILED     after MAX_ANCHOR_ATTEMPTS, or a transaction that
 *                           is not the anchoring it should be
 *   FAILED    -> PENDING    only through retry(), a deliberate action
 *
 * All state lives in PostgreSQL (AnchorRepository): a pass reads the open
 * anchors and continues each from where its row says, so a restart loses
 * nothing. Nothing is kept in memory between passes.
 *
 * Rules it never breaks:
 *   - the hash of a transaction is recorded BEFORE it is broadcast, so an
 *     unknown outcome (timeout, crash) is settled later by that hash instead
 *     of sending again blindly;
 *   - before signing, the chain is asked whether the hash is already there;
 *   - CONFIRMED is only written from what the chain answered; an RPC that
 *     does not answer changes no state;
 *   - one anchor at a time, so nonces follow one another.
 *
 * Without a signing key or a configured contract it does nothing at all.
 */
@Injectable()
export class AnchoringService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(AnchoringService.name);
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private again = false;
  private stopped = false;

  /** Public so tests can shorten the waits; production uses the defaults. */
  timing = {
    /** Time between periodic passes. */
    sweepIntervalMs: 15_000,
    /** Waits for the receipt right after a broadcast, before moving on. */
    settleDelaysMs: [1000, 2000, 3000, 4000],
    /**
     * A recorded transaction the node has never heard of is given up after
     * this long. Avalanche finalizes in seconds; this covers a slow RPC.
     */
    lostAfterMs: 120_000,
    /** Anchors handled per pass. */
    batchSize: 25,
  };

  constructor(
    private readonly anchors: AnchorRepository,
    private readonly reader: AnchorReader,
    @Inject(ANCHOR_SIGNER) private readonly signer: AnchorSending | null,
    @Inject(ANCHOR_TARGET) private readonly target: AnchorTarget | null,
  ) {}

  /** Whether this process anchors: it has a key and a contract. */
  get enabled(): boolean {
    return this.signer !== null && this.target !== null;
  }

  onApplicationBootstrap(): void {
    if (!this.enabled || this.target === null) return;
    // Said out loud before anything is sent: with a key, this process sends
    // a transaction for every open anchor of this contract in its database.
    const { contractAddress } = this.target;
    void this.anchors.countOpen(this.target).then(
      (openAnchors) =>
        this.logger.warn({
          message:
            'Anchoring is ON: open anchors of this contract will be sent',
          contractAddress,
          openAnchors,
        }),
      () => undefined,
    );
    // Picks up whatever a previous run left PENDING or SUBMITTED.
    this.wake();
    this.timer = setInterval(() => this.wake(), this.timing.sweepIntervalMs);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.running;
  }

  /**
   * Asks for a pass soon, without waiting for it: called after a certificate
   * is issued. Never throws.
   */
  wake(): void {
    if (!this.enabled || this.stopped) return;
    void this.sweep();
  }

  /**
   * One pass over the open anchors of the configured contract. Passes never
   * overlap in a process: a call during a pass makes it run once more.
   */
  sweep(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.pass();
        } while (this.again && !this.stopped);
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  /**
   * FAILED -> PENDING, with its attempts again. The only way out of FAILED;
   * nothing calls it automatically.
   */
  async retry(anchorId: string): Promise<boolean> {
    const reopened = await this.anchors.reopen(anchorId);
    if (reopened) this.wake();
    return reopened;
  }

  /**
   * Advances one anchor from the state its row is in now. Rejects when the
   * chain could not be asked: the row is then exactly as it was.
   */
  async process(anchorId: string): Promise<AnchorOutcome | null> {
    if (this.signer === null || this.target === null) return null;
    const job = await this.anchors.find(anchorId);
    if (job === null) return null;
    // Only anchors of the contract this process signs for.
    if (job.contractAddress !== this.target.contractAddress) return null;
    switch (job.status) {
      case 'PENDING':
        return this.submit(job, this.signer);
      case 'SUBMITTED':
        return this.settle(job);
      case 'CONFIRMED':
        return 'CONFIRMED';
      default:
        return 'FAILED';
    }
  }

  private async pass(): Promise<void> {
    if (this.target === null) return;
    let jobs: AnchorJob[];
    try {
      jobs = await this.anchors.findOpen(this.target, this.timing.batchSize);
    } catch (error) {
      this.logger.warn({
        message: 'Open anchors could not be read',
        error: errorName(error),
      });
      return;
    }
    for (const job of jobs) {
      if (this.stopped) return;
      try {
        await this.process(job.id);
      } catch (error) {
        if (error instanceof AnchorSignerConfigError) {
          // Wrong chain or not the owner: nothing can be signed at all.
          this.logger.error({
            message: 'Anchoring stopped: the signer is not valid',
            error: error.name,
          });
          return;
        }
        // The chain (or the database) could not be asked. Names only: an
        // error message can contain the RPC URL.
        this.logger.warn({
          message: 'Anchor left as it was',
          anchorId: job.id,
          error: errorName(error),
        });
        await this.anchors
          .noteError(job, errorName(error))
          .catch(() => undefined);
      }
    }
  }

  /** A PENDING anchor: confirm it if already on chain, otherwise send it. */
  private async submit(
    job: AnchorJob,
    signer: AnchorSending,
  ): Promise<AnchorOutcome> {
    if (job.attempts >= MAX_ANCHOR_ATTEMPTS) {
      await this.anchors.markFailed(job, job.lastError ?? 'TooManyAttempts');
      return 'FAILED';
    }
    // Fuji and the contract's owner, or nothing is signed.
    await signer.assertReady();

    // Idempotency: a hash that is already there is never sent again.
    if (await this.confirmIfOnChain(job)) return 'CONFIRMED';

    let signed: Awaited<ReturnType<AnchorSending['sign']>>;
    try {
      signed = await signer.sign(job.contentHash);
    } catch (error) {
      if (!(error instanceof AnchorRejectedError)) throw error;
      // The contract would revert. If that is because the hash got there in
      // the meantime, the anchor is done.
      if (await this.confirmIfOnChain(job)) return 'CONFIRMED';
      const last = job.attempts + 1 >= MAX_ANCHOR_ATTEMPTS;
      await this.anchors.countRefusal(job, error.reason, last);
      return last ? 'FAILED' : 'RETRY';
    }

    // Written before the broadcast. Losing this race means another process
    // owns the anchor: the transaction signed here is dropped, never sent.
    if (!(await this.anchors.markSubmitted(job, signed.txHash))) return 'OPEN';
    let submitted: AnchorJob = {
      ...job,
      status: 'SUBMITTED',
      txHash: signed.txHash,
      attempts: job.attempts + 1,
      lastError: null,
      updatedAt: new Date(),
    };
    this.logger.log({
      message: 'Anchor transaction recorded',
      anchorId: job.id,
      txHash: signed.txHash,
    });

    try {
      await signer.broadcast(signed);
    } catch (error) {
      // Unknown outcome: it may or may not have reached the network. The
      // recorded hash decides, now or in a later pass.
      this.logger.warn({
        message: 'Anchor broadcast did not answer',
        anchorId: job.id,
        error: errorName(error),
      });
    }

    // Wait briefly for the result, so the next anchor signs with the next
    // nonce. Whatever is not settled here is settled by a later pass.
    for (const delay of this.timing.settleDelaysMs) {
      if (this.stopped) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        const outcome = await this.settle(submitted);
        if (outcome !== 'OPEN') return outcome;
      } catch {
        // The chain did not answer: keep waiting.
      }
      submitted = (await this.anchors.find(job.id)) ?? submitted;
      if (submitted.status !== 'SUBMITTED') break;
    }
    return 'OPEN';
  }

  /** A SUBMITTED anchor: what became of its recorded transaction. */
  private async settle(job: AnchorJob): Promise<AnchorOutcome> {
    if (job.txHash === null) return 'OPEN';
    const transaction = await this.reader.transaction(job.txHash);

    if (transaction.state === 'PENDING') return 'OPEN';
    if (transaction.state === 'UNKNOWN') {
      // Just sent, or never arrived. Only time tells them apart.
      if (Date.now() - job.updatedAt.getTime() < this.timing.lostAfterMs) {
        return 'OPEN';
      }
      return this.giveUpTransaction(job, 'TransactionNotFound');
    }

    const evidence = anchorEvidence(
      transaction,
      job.contractAddress,
      job.contentHash,
    );
    switch (evidence.result) {
      case 'UNCONFIRMED':
        return 'OPEN';
      case 'REVERTED':
        return this.giveUpTransaction(job, 'TransactionReverted');
      case 'MISMATCH':
        // A successful transaction that is not this anchoring: the record is
        // wrong in a way a retry cannot fix.
        await this.anchors.markFailed(job, 'TransactionMismatch');
        return 'FAILED';
      case 'MATCH': {
        // Independent of the receipt: the value the contract stores.
        const stored = await this.reader.lookup(job.contentHash);
        if (
          stored.state !== 'ANCHORED' ||
          stored.anchoredAt.getTime() !== evidence.anchoredAt.getTime()
        ) {
          // The two readings disagree: confirm nothing, ask again later.
          return 'OPEN';
        }
        const confirmed = await this.anchors.markConfirmed(job, {
          txHash: job.txHash,
          blockNumber: evidence.blockNumber,
          anchoredAt: evidence.anchoredAt,
        });
        if (confirmed) {
          this.logger.log({
            message: 'Anchor confirmed',
            anchorId: job.id,
            txHash: job.txHash,
          });
        }
        return 'CONFIRMED';
      }
    }
  }

  /**
   * The recorded transaction will not anchor the hash. If the hash is on
   * chain anyway the anchor is done (without that transaction); otherwise it
   * goes back to PENDING, or to FAILED when it has no attempts left.
   */
  private async giveUpTransaction(
    job: AnchorJob,
    reason: string,
  ): Promise<AnchorOutcome> {
    if (await this.confirmIfOnChain(job)) return 'CONFIRMED';
    if (job.attempts >= MAX_ANCHOR_ATTEMPTS) {
      await this.anchors.markFailed(job, reason);
      return 'FAILED';
    }
    await this.anchors.backToPending(job, reason);
    return 'RETRY';
  }

  /** CONFIRMED from the contract's stored value alone, without a transaction. */
  private async confirmIfOnChain(job: AnchorJob): Promise<boolean> {
    const stored = await this.reader.lookup(job.contentHash);
    if (stored.state === 'NOT_ANCHORED') return false;
    if (stored.state !== 'ANCHORED') {
      throw new Error('The anchor chain gave no answer');
    }
    await this.anchors.markConfirmed(job, {
      txHash: null,
      blockNumber: null,
      anchoredAt: stored.anchoredAt,
    });
    return true;
  }
}
