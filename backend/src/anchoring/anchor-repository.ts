import { Injectable } from '@nestjs/common';
import { AnchorStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AnchorTarget } from '../certificates/anchor-reader';

/** An anchoring record as the service works with it. */
export interface AnchorJob {
  id: string;
  certificateId: string;
  /** The certificate hash to anchor: 64 lowercase hex. */
  contentHash: string;
  contractAddress: string;
  status: AnchorStatus;
  txHash: string | null;
  attempts: number;
  lastError: string | null;
  updatedAt: Date;
}

/**
 * The state of every anchoring, in PostgreSQL: the only memory the anchoring
 * service has, so it survives a restart.
 *
 * Every transition is one conditional UPDATE that names the state it expects
 * (status, transaction, attempts). It returns whether this caller made the
 * transition: when two processes race, exactly one gets true and the other
 * changes nothing. Only the tracking columns are written, the ones the
 * runtime role may UPDATE; CONFIRMED rows are never matched, and the database
 * would refuse to change them anyway.
 */
@Injectable()
export class AnchorRepository {
  constructor(private readonly prisma: PrismaService) {}

  private static readonly SELECT = {
    id: true,
    certificateId: true,
    contractAddress: true,
    status: true,
    txHash: true,
    attempts: true,
    lastError: true,
    updatedAt: true,
    certificate: { select: { contentHash: true } },
  } as const;

  private static toJob(row: {
    id: string;
    certificateId: string;
    contractAddress: string;
    status: AnchorStatus;
    txHash: string | null;
    attempts: number;
    lastError: string | null;
    updatedAt: Date;
    certificate: { contentHash: string };
  }): AnchorJob {
    const { certificate, ...anchor } = row;
    return { ...anchor, contentHash: certificate.contentHash };
  }

  async find(id: string): Promise<AnchorJob | null> {
    const row = await this.prisma.anchor.findUnique({
      where: { id },
      select: AnchorRepository.SELECT,
    });
    return row && AnchorRepository.toJob(row);
  }

  /**
   * Anchors of this contract that are not finished: SUBMITTED first (a sent
   * transaction is settled before anything new is sent), then oldest first.
   */
  async findOpen(target: AnchorTarget, limit: number): Promise<AnchorJob[]> {
    const rows = await this.prisma.anchor.findMany({
      where: {
        chainId: target.chainId,
        contractAddress: target.contractAddress,
        status: { in: [AnchorStatus.SUBMITTED, AnchorStatus.PENDING] },
      },
      orderBy: [{ status: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: AnchorRepository.SELECT,
    });
    return rows.map((row) => AnchorRepository.toJob(row));
  }

  /**
   * PENDING -> SUBMITTED: records the hash of a signed transaction, before it
   * is broadcast. Counts one attempt.
   */
  markSubmitted(job: AnchorJob, txHash: string): Promise<boolean> {
    return this.transition(
      { id: job.id, status: AnchorStatus.PENDING, attempts: job.attempts },
      {
        status: AnchorStatus.SUBMITTED,
        txHash,
        attempts: job.attempts + 1,
        lastError: null,
      },
    );
  }

  /**
   * -> CONFIRMED, with what the chain reported. `txHash` is null when the
   * hash was found on chain without a transaction of this record.
   */
  markConfirmed(
    job: AnchorJob,
    evidence: {
      txHash: string | null;
      blockNumber: bigint | null;
      anchoredAt: Date;
    },
  ): Promise<boolean> {
    return this.transition(this.asSeen(job), {
      status: AnchorStatus.CONFIRMED,
      txHash: evidence.txHash,
      blockNumber: evidence.blockNumber,
      anchoredAt: evidence.anchoredAt,
      lastError: null,
    });
  }

  /** SUBMITTED -> PENDING: its transaction will never anchor the hash. */
  backToPending(job: AnchorJob, lastError: string): Promise<boolean> {
    return this.transition(this.asSeen(job), {
      status: AnchorStatus.PENDING,
      txHash: null,
      lastError,
    });
  }

  /** -> FAILED: no more automatic attempts. */
  markFailed(job: AnchorJob, lastError: string): Promise<boolean> {
    return this.transition(this.asSeen(job), {
      status: AnchorStatus.FAILED,
      lastError,
    });
  }

  /**
   * A PENDING anchor the contract refused before anything was sent: counts
   * the attempt, and fails the anchor when it was the last one.
   */
  countRefusal(
    job: AnchorJob,
    lastError: string,
    last: boolean,
  ): Promise<boolean> {
    return this.transition(
      { id: job.id, status: AnchorStatus.PENDING, attempts: job.attempts },
      {
        status: last ? AnchorStatus.FAILED : AnchorStatus.PENDING,
        attempts: job.attempts + 1,
        lastError,
      },
    );
  }

  /** Notes why nothing could be done this time. The state does not change. */
  noteError(job: AnchorJob, lastError: string): Promise<boolean> {
    return this.transition(this.asSeen(job), { lastError });
  }

  /** FAILED -> PENDING, with its attempts again: a deliberate retry. */
  reopen(id: string): Promise<boolean> {
    return this.transition(
      { id, status: AnchorStatus.FAILED },
      { status: AnchorStatus.PENDING, txHash: null, attempts: 0 },
    );
  }

  /** The row exactly as the caller last read it. */
  private asSeen(job: AnchorJob) {
    return {
      id: job.id,
      status: job.status,
      txHash: job.txHash,
      attempts: job.attempts,
    };
  }

  private async transition(
    expected: {
      id: string;
      status: AnchorStatus;
      txHash?: string | null;
      attempts?: number;
    },
    data: {
      status?: AnchorStatus;
      txHash?: string | null;
      blockNumber?: bigint | null;
      anchoredAt?: Date;
      attempts?: number;
      lastError?: string | null;
    },
  ): Promise<boolean> {
    // CONFIRMED is final: never matched, whatever the caller believes.
    if (expected.status === AnchorStatus.CONFIRMED) return false;
    const { count } = await this.prisma.anchor.updateMany({
      where: expected,
      data,
    });
    return count === 1;
  }
}
