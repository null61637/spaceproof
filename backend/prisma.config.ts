import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // The CLI (migrations) connects as spaceproof_owner, never with the app's
    // DATABASE_URL. Read directly (not via env()) so `prisma generate` works
    // without a .env; commands that need a database fail clearly if it is unset.
    url: process.env.MIGRATION_DATABASE_URL,
    // Needed by `prisma migrate dev`: the owner cannot create databases.
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
