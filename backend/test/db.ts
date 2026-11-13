import { Client } from 'pg';

/** Direct connection with the role in DATABASE_URL (app) or MIGRATION_DATABASE_URL (owner). */
export async function connectAs(
  env: 'DATABASE_URL' | 'MIGRATION_DATABASE_URL',
): Promise<Client> {
  const client = new Client({ connectionString: process.env[env] });
  await client.connect();
  return client;
}

/** Resolves with the PostgreSQL error the promise rejects with. */
export async function pgError(
  promise: Promise<unknown>,
): Promise<{ code?: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error('expected the query to fail');
}
