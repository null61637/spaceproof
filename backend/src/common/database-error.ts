// Safe-to-log summary of a Prisma / PostgreSQL error. Never includes the
// Prisma message (it quotes source code and, for validation errors, the query
// arguments) nor PostgreSQL's DETAIL (it may quote row values).
export interface DatabaseErrorSummary {
  /** Prisma error code (P2xxx) or Node network code (ECONNREFUSED…). */
  code?: string;
  /** PostgreSQL SQLSTATE, e.g. 42501 (insufficient privilege). */
  sqlState?: string;
  /** PostgreSQL's primary message, e.g. "permission denied for table …". */
  dbMessage?: string;
  /** The database could not be reached; retrying later may succeed. */
  unavailable: boolean;
}

// Connection failures: Node network errors and Prisma's P1xxx codes, plus
// PostgreSQL's "server shutting down" and "too many connections".
const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'P1001',
  'P1002',
  'P1017',
]);
const UNAVAILABLE_SQLSTATES = new Set(['57P01', '57P02', '57P03', '53300']);

interface PrismaLikeError {
  name?: unknown;
  code?: unknown;
  meta?: {
    driverAdapterError?: {
      cause?: { kind?: unknown; code?: unknown; message?: unknown };
    };
  };
}

/** Returns undefined when the error does not come from Prisma. */
export function describeDatabaseError(
  error: unknown,
): DatabaseErrorSummary | undefined {
  const e = error as PrismaLikeError | null;
  if (typeof e?.name !== 'string' || !e.name.startsWith('PrismaClient')) {
    return undefined;
  }
  const code = typeof e.code === 'string' ? e.code : undefined;
  const cause = e.meta?.driverAdapterError?.cause;
  const fromPostgres = cause?.kind === 'postgres';
  const sqlState =
    fromPostgres && typeof cause.code === 'string' ? cause.code : undefined;
  const dbMessage =
    fromPostgres && typeof cause.message === 'string'
      ? cause.message
      : undefined;
  return {
    code,
    sqlState,
    dbMessage,
    unavailable:
      (code !== undefined && UNAVAILABLE_CODES.has(code)) ||
      (sqlState !== undefined && UNAVAILABLE_SQLSTATES.has(sqlState)),
  };
}
