import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { setupApp } from '../src/app.setup';
import { computeCertificateHash } from '../src/certificates/certificate-hash';
import { connectAs, pgError } from './db';
import { APP_ROLE, OWNER_ROLE } from './test-env';

const INSUFFICIENT_PRIVILEGE = '42501';
const RAISE_EXCEPTION = 'P0001';

// Proves the database itself enforces the integrity rules: the runtime role
// (spaceproof_app) can only read and insert, and the triggers stop even the
// owner (spaceproof_owner) from changing or deleting certificates.
describe('Database privileges (e2e)', () => {
  let app: INestApplication<App>;
  let asApp: Client;
  let asOwner: Client;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();
    asApp = await connectAs('DATABASE_URL');
    asOwner = await connectAs('MIGRATION_DATABASE_URL');
  });

  afterAll(async () => {
    await asApp.end();
    await asOwner.end();
    await app.close();
  });

  async function createCertificate(): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/certificates')
      .send({ title: 'Privileges', recipient: 'Ada' })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  async function verify(id: string) {
    const res = await request(app.getHttpServer())
      .get(`/api/certificates/${id}/verify`)
      .expect(200);
    return res.body as {
      valid: boolean;
      storedHash: string;
      computedHash: string;
    };
  }

  describe('runtime role', () => {
    it('T1: is not a superuser and has no administrative attributes', async () => {
      const { rows } = await asApp.query(
        `SELECT current_user AS role, rolsuper, rolcreatedb, rolcreaterole,
                rolreplication, rolbypassrls
           FROM pg_roles WHERE rolname = current_user`,
      );
      expect(rows).toEqual([
        {
          role: APP_ROLE,
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolreplication: false,
          rolbypassrls: false,
        },
      ]);
    });

    it('T2: does not own the table and is not a member of the owner role', async () => {
      const { rows } = await asApp.query(
        `SELECT pg_has_role(current_user, $1, 'MEMBER') AS member,
                (SELECT tableowner FROM pg_tables WHERE tablename = 'Certificate') AS owner`,
        [OWNER_ROLE],
      );
      expect(rows).toEqual([{ member: false, owner: OWNER_ROLE }]);
    });

    it.each([
      'ALTER TABLE "Certificate" DISABLE TRIGGER ALL',
      'ALTER TABLE "Certificate" DISABLE TRIGGER "Certificate_immutable"',
      'DROP TRIGGER "Certificate_immutable" ON "Certificate"',
      'DROP TRIGGER "Certificate_no_delete" ON "Certificate"',
    ])('T3: cannot disable or drop triggers: %s', async (sql) => {
      expect((await pgError(asApp.query(sql))).code).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    });

    it('T4: cannot bypass triggers with session_replication_role', async () => {
      const error = await pgError(
        asApp.query('SET session_replication_role = replica'),
      );
      expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it.each([
      'ALTER TABLE "Certificate" ADD COLUMN extra integer',
      'ALTER TABLE "Certificate" ALTER COLUMN title DROP NOT NULL',
      'CREATE TABLE public.extra (id integer)',
      'DROP TABLE "Certificate"',
    ])('T5: cannot alter the schema: %s', async (sql) => {
      expect((await pgError(asApp.query(sql))).code).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    });

    it.each([
      ['id', `'00000000-0000-4000-8000-0000000000aa'`],
      ['title', `'Tampered'`],
      ['recipient', `'Mallory'`],
      ['createdAt', `'2000-01-01'`],
      ['contentHash', `repeat('b', 64)`],
      ['txHash', `'0xabc'`],
    ])('T6: cannot UPDATE %s', async (column, value) => {
      const id = await createCertificate();
      const error = await pgError(
        asApp.query(
          `UPDATE "Certificate" SET "${column}" = ${value} WHERE id = $1`,
          [id],
        ),
      );
      expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
      expect((await verify(id)).valid).toBe(true);
    });

    it('T7: cannot DELETE or TRUNCATE certificates', async () => {
      const id = await createCertificate();
      const deleteError = await pgError(
        asApp.query('DELETE FROM "Certificate" WHERE id = $1', [id]),
      );
      expect(deleteError.code).toBe(INSUFFICIENT_PRIVILEGE);
      const truncateError = await pgError(
        asApp.query('TRUNCATE "Certificate"'),
      );
      expect(truncateError.code).toBe(INSUFFICIENT_PRIVILEGE);

      const { rowCount } = await asApp.query(
        'SELECT 1 FROM "Certificate" WHERE id = $1',
        [id],
      );
      expect(rowCount).toBe(1);
    });

    it('T11: holds exactly the expected privileges', async () => {
      const tables = await asOwner.query(
        `SELECT c.relname AS object, a.privilege_type AS privilege
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          CROSS JOIN aclexplode(c.relacl) a
          WHERE n.nspname = 'public' AND a.grantee = $1::regrole
          ORDER BY 1, 2`,
        [APP_ROLE],
      );
      expect(tables.rows).toEqual([
        { object: 'Certificate', privilege: 'INSERT' },
        { object: 'Certificate', privilege: 'SELECT' },
      ]);

      const columns = await asOwner.query(
        `SELECT a.attrelid::regclass::text AS object, a.attname
           FROM pg_attribute a CROSS JOIN aclexplode(a.attacl) p
          WHERE p.grantee = $1::regrole`,
        [APP_ROLE],
      );
      expect(columns.rows).toEqual([]);

      // grantee 0 is PUBLIC.
      const schema = await asOwner.query(
        `SELECT a.grantee = 0 AS public, a.privilege_type AS privilege
           FROM pg_namespace n CROSS JOIN aclexplode(n.nspacl) a
          WHERE n.nspname = 'public'
            AND (a.grantee = $1::regrole OR a.grantee = 0)`,
        [APP_ROLE],
      );
      expect(schema.rows).toEqual([{ public: false, privilege: 'USAGE' }]);

      const database = await asOwner.query(
        `SELECT a.grantee = 0 AS public, a.privilege_type AS privilege
           FROM pg_database d CROSS JOIN aclexplode(d.datacl) a
          WHERE d.datname = current_database()
            AND (a.grantee = $1::regrole OR a.grantee = 0)`,
        [APP_ROLE],
      );
      expect(database.rows).toEqual([{ public: false, privilege: 'CONNECT' }]);
    });

    it('T14: may connect only to the API and E2E databases; PUBLIC to none', async () => {
      const { rows } = await asOwner.query(
        `SELECT datname,
                has_database_privilege($1, datname, 'CONNECT') AS app_connect,
                has_database_privilege($1, datname, 'TEMP') AS app_temp,
                EXISTS (SELECT FROM aclexplode(coalesce(datacl, acldefault('d', datdba))) a
                         WHERE a.grantee = 0) AS public_access
           FROM pg_database WHERE datallowconn ORDER BY 1`,
        [APP_ROLE],
      );
      // Other databases may exist (e.g. a restore target, which the API role
      // may connect to); none of them may be open to PUBLIC or allow TEMP.
      for (const row of rows) {
        expect(row).toMatchObject({ app_temp: false, public_access: false });
      }
      const appConnect = Object.fromEntries(
        rows.map((row: { datname: string; app_connect: boolean }) => [
          row.datname,
          row.app_connect,
        ]),
      );
      expect(appConnect).toMatchObject({
        postgres: false,
        template1: false,
        spaceproof_shadow: false,
        spaceproof: true,
        spaceproof_test: true,
      });
    });

    it.each(['postgres', 'template1', 'spaceproof_shadow'])(
      'T14: connecting to %s is refused',
      async (datname) => {
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = `/${datname}`;
        const client = new Client({ connectionString: url.toString() });
        const error = await pgError(client.connect());
        await client.end().catch(() => undefined);
        expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
      },
    );

    it('T15: functions are not executable by PUBLIC, now or when created later', async () => {
      const { rows } = await asOwner.query(
        `SELECT p.proname,
                has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute,
                has_function_privilege($1, p.oid, 'EXECUTE') AS app_execute
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' ORDER BY 1`,
        [APP_ROLE],
      );
      expect(rows).toEqual([
        {
          proname: 'certificate_prevent_delete',
          public_execute: false,
          app_execute: false,
        },
        {
          proname: 'certificate_prevent_tampering',
          public_execute: false,
          app_execute: false,
        },
      ]);

      // Default privileges: a function the owner creates later is not public.
      await asOwner.query('BEGIN');
      try {
        await asOwner.query(
          'CREATE FUNCTION later_function() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$',
        );
        const later = await asOwner.query(
          `SELECT has_function_privilege('public', 'later_function()', 'EXECUTE') AS public_execute`,
        );
        expect(later.rows).toEqual([{ public_execute: false }]);
      } finally {
        await asOwner.query('ROLLBACK');
      }
    });
  });

  describe('triggers, even for the owner', () => {
    it.each([
      ['title', `'Tampered'`],
      ['recipient', `'Mallory'`],
      ['createdAt', `'2000-01-01'`],
      ['contentHash', `repeat('b', 64)`],
      ['id', `'00000000-0000-4000-8000-0000000000aa'`],
    ])('T8: rejects an UPDATE of %s', async (column, value) => {
      const id = await createCertificate();
      const error = await pgError(
        asOwner.query(
          `UPDATE "Certificate" SET "${column}" = ${value} WHERE id = $1`,
          [id],
        ),
      );
      expect(error.code).toBe(RAISE_EXCEPTION);
      expect(error.message).toMatch(/is immutable/);
      expect((await verify(id)).valid).toBe(true);
    });

    it('T9: allows filling txHash once, only while it is NULL', async () => {
      const id = await createCertificate();
      const setTx = (value: string | null) =>
        asOwner.query('UPDATE "Certificate" SET "txHash" = $1 WHERE id = $2', [
          value,
          id,
        ]);

      await setTx('0xabc');
      for (const value of ['0xdef', null]) {
        const error = await pgError(setTx(value));
        expect(error.code).toBe(RAISE_EXCEPTION);
        expect(error.message).toMatch(/already has a txHash/);
      }
      const { rows } = await asOwner.query<{ txHash: string }>(
        'SELECT "txHash" FROM "Certificate" WHERE id = $1',
        [id],
      );
      expect(rows[0].txHash).toBe('0xabc');
      expect((await verify(id)).valid).toBe(true);
    });

    it('T10: rejects DELETE and TRUNCATE', async () => {
      const id = await createCertificate();
      for (const query of [
        asOwner.query('DELETE FROM "Certificate" WHERE id = $1', [id]),
        asOwner.query('TRUNCATE "Certificate"'),
      ]) {
        const error = await pgError(query);
        expect(error.code).toBe(RAISE_EXCEPTION);
        expect(error.message).toMatch(/cannot be deleted/);
      }
      const { rowCount } = await asOwner.query(
        'SELECT 1 FROM "Certificate" WHERE id = $1',
        [id],
      );
      expect(rowCount).toBe(1);
    });
  });

  // Known, accepted limitation: INSERT is not checked against the hash, so a
  // role that can INSERT can store a record whose hash does not match. The
  // verification endpoint must report it.
  it('T13: verify reports valid:false when data and hash do not match', async () => {
    const id = randomUUID();
    const createdAt = new Date();
    const contentHash = computeCertificateHash({
      id,
      title: 'Original title',
      recipient: 'Ada',
      createdAt,
    });
    // createdAt as an ISO string: node-postgres would send a Date in local
    // time, and TIMESTAMP (without time zone) stores UTC, as Prisma writes it.
    await asApp.query(
      `INSERT INTO "Certificate" (id, title, recipient, "contentHash", "createdAt")
       VALUES ($1, $2, $3, $4, $5)`,
      [id, 'Forged title', 'Ada', contentHash, createdAt.toISOString()],
    );

    const result = await verify(id);
    expect(result).toEqual({
      valid: false,
      storedHash: contentHash,
      computedHash: computeCertificateHash({
        id,
        title: 'Forged title',
        recipient: 'Ada',
        createdAt,
      }),
    });
    expect(result.computedHash).not.toBe(result.storedHash);
  });
});
