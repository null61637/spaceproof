import { config } from 'dotenv';
import { resolve } from 'node:path';
import { Client } from 'pg';

// The E2E suite drops and rebuilds its database on every run, so it only ever
// runs against this database, configured in backend/.env.test (never .env).
export const TEST_DATABASE = 'spaceproof_test';
export const APP_ROLE = 'spaceproof_app';
export const OWNER_ROLE = 'spaceproof_owner';

const LOCAL_HOSTS = ['localhost', '127.0.0.1'];
// node-postgres and Prisma let query parameters override the URL (e.g.
// ?host=, ?user=), so only Prisma's harmless `schema` is accepted.
const ALLOWED_PARAMS = ['schema'];

/**
 * Throws unless `raw` points at the local test database as `role`. Error
 * messages never include the URL: it contains a password.
 */
export function assertTestDatabaseUrl(
  name: string,
  raw: string | undefined,
  role: string,
): void {
  if (!raw) {
    throw new Error(`${name} is not set (see backend/.env.test.example)`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  if (!['postgresql:', 'postgres:'].includes(url.protocol)) {
    throw new Error(`${name} must be a postgresql:// URL`);
  }
  const extra = [...url.searchParams.keys()].filter(
    (key) => !ALLOWED_PARAMS.includes(key),
  );
  if (extra.length > 0) {
    throw new Error(`${name} has unsupported parameters: ${extra.join(', ')}`);
  }
  if (url.pathname.replace(/^\//, '') !== TEST_DATABASE) {
    throw new Error(`${name} must use database ${TEST_DATABASE}`);
  }
  if (!LOCAL_HOSTS.includes(url.hostname)) {
    throw new Error(`${name} must point to localhost`);
  }
  if (decodeURIComponent(url.username) !== role) {
    throw new Error(`${name} must connect as ${role}`);
  }
}

/**
 * Loads backend/.env.test (or E2E_ENV_FILE, e.g. in CI) over any inherited
 * variables, then checks it.
 */
export function loadTestEnv(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('E2E tests never run with NODE_ENV=production');
  }
  const { error } = config({
    path: process.env.E2E_ENV_FILE ?? resolve(__dirname, '../.env.test'),
    override: true,
    quiet: true,
  });
  if (error) {
    throw new Error('E2E env file not found: copy .env.test.example');
  }
  // The E2E suite never talks to a chain: no anchoring configuration reaches
  // the application, neither from the shell nor from the env file.
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('ANCHOR_')) delete process.env[name];
  }
  assertTestDatabaseUrl('DATABASE_URL', process.env.DATABASE_URL, APP_ROLE);
  assertTestDatabaseUrl(
    'MIGRATION_DATABASE_URL',
    process.env.MIGRATION_DATABASE_URL,
    OWNER_ROLE,
  );
}

/** Throws unless the live session is the test database as `role`. */
export async function assertTestSession(
  client: Client,
  role: string,
): Promise<void> {
  const { rows } = await client.query<{ db: string; role: string }>(
    'SELECT current_database() AS db, current_user AS role',
  );
  if (rows[0].db !== TEST_DATABASE || rows[0].role !== role) {
    throw new Error(`refusing to run on ${rows[0].db} as ${rows[0].role}`);
  }
}
