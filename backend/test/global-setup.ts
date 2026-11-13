import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { connectAs } from './db';
import {
  APP_ROLE,
  OWNER_ROLE,
  assertTestSession,
  loadTestEnv,
} from './test-env';

// Rebuilds spaceproof_test from the migrations before every E2E run. Rows
// cannot be deleted (by design), so the reset drops schema public as its owner.
export default async function globalSetup(): Promise<void> {
  loadTestEnv();

  // Check both live sessions too, not only the URLs, before dropping anything.
  const app = await connectAs('DATABASE_URL');
  try {
    await assertTestSession(app, APP_ROLE);
  } finally {
    await app.end();
  }

  const owner = await connectAs('MIGRATION_DATABASE_URL');
  try {
    await assertTestSession(owner, OWNER_ROLE);
    await owner.query('DROP SCHEMA IF EXISTS public CASCADE');
    await owner.query('CREATE SCHEMA public');
  } finally {
    await owner.end();
  }

  // prisma.config.ts reads MIGRATION_DATABASE_URL, already set from .env.test.
  const prismaCli = resolve(
    dirname(require.resolve('prisma/package.json')),
    'build/index.js',
  );
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: resolve(__dirname, '..'),
    env: { ...process.env, CHECKPOINT_DISABLE: '1' },
    stdio: 'inherit',
  });
}
