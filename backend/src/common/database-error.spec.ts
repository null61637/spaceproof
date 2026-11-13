import { describeDatabaseError } from './database-error';

// Shapes observed from Prisma 7 with @prisma/adapter-pg.
class PrismaClientKnownRequestError extends Error {
  name = 'PrismaClientKnownRequestError';
  constructor(
    readonly code: string,
    readonly meta?: Record<string, unknown>,
  ) {
    super('Invalid `prisma.certificate.create()` invocation: data { … }');
  }
}

describe('describeDatabaseError', () => {
  it('extracts SQLSTATE and message from a PostgreSQL error', () => {
    const error = new PrismaClientKnownRequestError('P2039', {
      modelName: 'Certificate',
      driverAdapterError: {
        cause: {
          kind: 'postgres',
          code: '42501',
          message: 'permission denied for table Certificate',
        },
      },
    });
    expect(describeDatabaseError(error)).toEqual({
      code: 'P2039',
      sqlState: '42501',
      dbMessage: 'permission denied for table Certificate',
      unavailable: false,
    });
  });

  it.each(['ECONNREFUSED', 'P1001'])(
    'marks %s as the database being unavailable',
    (code) => {
      expect(
        describeDatabaseError(new PrismaClientKnownRequestError(code)),
      ).toMatchObject({ code, unavailable: true });
    },
  );

  it('marks "too many connections" as unavailable', () => {
    const error = new PrismaClientKnownRequestError('P2010', {
      driverAdapterError: { cause: { kind: 'postgres', code: '53300' } },
    });
    expect(describeDatabaseError(error)).toMatchObject({
      sqlState: '53300',
      unavailable: true,
    });
  });

  it('never returns the Prisma message, which can quote query arguments', () => {
    const summary = describeDatabaseError(
      new PrismaClientKnownRequestError('P2000'),
    );
    expect(JSON.stringify(summary)).not.toContain('invocation');
  });

  it.each([new Error('boom'), 'text', null, undefined])(
    'ignores non-Prisma errors (%p)',
    (error) => {
      expect(describeDatabaseError(error)).toBeUndefined();
    },
  );
});
