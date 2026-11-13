import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { setupApp } from '../src/app.setup';
import {
  computeCertificateHash,
  computeManifestV2Hash,
} from '../src/certificates/certificate-hash';
import { connectAs, pgError } from './db';
import { insertV1 } from './files';
import { APP_ROLE, OWNER_ROLE } from './test-env';

const INSUFFICIENT_PRIVILEGE = '42501';
const RAISE_EXCEPTION = 'P0001';
const CHECK_VIOLATION = '23514';
const FEATURE_NOT_SUPPORTED = '0A000';

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

  // A version-1 certificate, inserted as the runtime role: since hash version
  // 2 the API only issues certificates of a file.
  async function createCertificate(): Promise<string> {
    return (await insertV1(asApp, 'Privileges')).id;
  }

  async function verify(id: string) {
    const res = await request(app.getHttpServer())
      .get(`/api/certificates/${id}/verify`)
      .expect(200);
    return res.body as {
      valid: boolean;
      status: string;
      reason: string | null;
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
        { object: 'Anchor', privilege: 'INSERT' },
        { object: 'Anchor', privilege: 'SELECT' },
        { object: 'Certificate', privilege: 'INSERT' },
        { object: 'Certificate', privilege: 'SELECT' },
      ]);

      const columns = await asOwner.query(
        `SELECT a.attrelid::regclass::text AS object, a.attname AS "column",
                p.privilege_type AS privilege
           FROM pg_attribute a CROSS JOIN aclexplode(a.attacl) p
          WHERE p.grantee = $1::regrole
          ORDER BY 1, 2, 3`,
        [APP_ROLE],
      );
      // Only what tracks the sending of an anchor; nothing on "Certificate".
      expect(columns.rows).toEqual(
        [
          'anchoredAt',
          'attempts',
          'blockNumber',
          'lastError',
          'status',
          'txHash',
          'updatedAt',
        ].map((column) => ({
          object: '"Anchor"',
          column,
          privilege: 'UPDATE',
        })),
      );

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
          proname: 'anchor_guard',
          public_execute: false,
          app_execute: false,
        },
        {
          proname: 'anchor_prevent_delete',
          public_execute: false,
          app_execute: false,
        },
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
        // CASCADE: since "Anchor" references this table, PostgreSQL refuses
        // a plain TRUNCATE before any trigger runs (checked below).
        asOwner.query('TRUNCATE "Certificate" CASCADE'),
      ]) {
        const error = await pgError(query);
        expect(error.code).toBe(RAISE_EXCEPTION);
        expect(error.message).toMatch(/cannot be deleted/);
      }
      const plain = await pgError(asOwner.query('TRUNCATE "Certificate"'));
      expect(plain.code).toBe(FEATURE_NOT_SUPPORTED);
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
    expect(result).toMatchObject({
      valid: false,
      status: 'INVALID',
      reason: 'RECORD_MISMATCH',
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

  // Certificates of a file (hash version 2). Rows are inserted as the runtime
  // role, like T13, to store shapes the API would never issue.
  describe('file certificates (hash version 2)', () => {
    const fileSha256 = 'a'.repeat(64);

    function v2Row(overrides: Record<string, unknown> = {}) {
      return {
        id: randomUUID(),
        title: 'Scene',
        recipient: 'Ada',
        createdAt: new Date().toISOString(),
        hashVersion: 2,
        fileSha256,
        fileSizeBytes: 1024,
        fileName: 'scene.tif',
        satellite: 'Sentinel-2A',
        sensor: null,
        sceneId: null,
        acquiredAt: '2026-01-01T14:00:51.000Z',
        ...overrides,
      } as Record<string, unknown> & { id: string };
    }

    function insert(row: Record<string, unknown>, contentHash: string) {
      const columns = [...Object.keys(row), 'contentHash'];
      return asApp.query(
        `INSERT INTO "Certificate" (${columns.map((c) => `"${c}"`).join(', ')})
         VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
        [...Object.values(row), contentHash],
      );
    }

    async function insertValid(): Promise<string> {
      const row = v2Row();
      await insert(
        row,
        computeManifestV2Hash({
          id: row.id,
          createdAt: new Date(row.createdAt as string),
          fileSha256,
          fileSizeBytes: 1024,
          title: 'Scene',
          recipient: 'Ada',
          satellite: 'Sentinel-2A',
          sensor: null,
          sceneId: null,
          acquiredAt: new Date('2026-01-01T14:00:51.000Z'),
        }),
      );
      return row.id;
    }

    it('T16: existing-style inserts are version 1 with no file columns', async () => {
      const id = await createCertificate();
      const { rows } = await asApp.query(
        `SELECT "hashVersion", "fileSha256", "fileSizeBytes", "fileName",
                "satellite", "sensor", "sceneId", "acquiredAt"
           FROM "Certificate" WHERE id = $1`,
        [id],
      );
      expect(rows).toEqual([
        {
          hashVersion: 1,
          fileSha256: null,
          fileSizeBytes: null,
          fileName: null,
          satellite: null,
          sensor: null,
          sceneId: null,
          acquiredAt: null,
        },
      ]);
      expect((await verify(id)).valid).toBe(true);
    });

    it('T17: a version-2 certificate verifies against its manifest hash', async () => {
      const id = await insertValid();
      const result = await verify(id);
      expect(result.valid).toBe(true);
      expect(result.computedHash).toBe(result.storedHash);
    });

    it('T17: a version-2 certificate with altered metadata is invalid', async () => {
      const row = v2Row({ satellite: 'Forged' });
      const contentHash = computeManifestV2Hash({
        id: row.id,
        createdAt: new Date(row.createdAt as string),
        fileSha256,
        fileSizeBytes: 1024,
        title: 'Scene',
        recipient: 'Ada',
        satellite: 'Sentinel-2A',
        sensor: null,
        sceneId: null,
        acquiredAt: new Date('2026-01-01T14:00:51.000Z'),
      });
      await insert(row, contentHash);
      expect(await verify(row.id)).toMatchObject({
        valid: false,
        storedHash: contentHash,
      });
    });

    it.each<[string, Record<string, unknown>]>([
      ['version 2 without a file hash', { fileSha256: null }],
      ['version 2 without a file size', { fileSizeBytes: null }],
      ['version 2 without a satellite', { satellite: null }],
      ['version 2 without an acquisition date', { acquiredAt: null }],
      ['version 1 carrying a file hash', { hashVersion: 1 }],
      [
        'version 1 carrying only a satellite',
        {
          hashVersion: 1,
          fileSha256: null,
          fileSizeBytes: null,
          fileName: null,
          acquiredAt: null,
        },
      ],
      ['an unknown version', { hashVersion: 3 }],
      ['an uppercase file hash', { fileSha256: 'A'.repeat(64) }],
      ['a short file hash', { fileSha256: 'abc' }],
      ['a zero file size', { fileSizeBytes: 0 }],
    ])('T18: rejects %s', async (_case, overrides) => {
      const error = await pgError(insert(v2Row(overrides), randomHash()));
      expect(error.code).toBe(CHECK_VIOLATION);
    });

    it.each([
      ['hashVersion', `1`],
      ['fileSha256', `repeat('b', 64)`],
      ['fileSizeBytes', `2048`],
      ['fileName', `'other.tif'`],
      ['satellite', `'Landsat 9'`],
      ['sensor', `'MSI'`],
      ['sceneId', `'X'`],
      ['acquiredAt', `'2000-01-01'`],
    ])(
      'T19: rejects an UPDATE of %s, even by the owner',
      async (column, value) => {
        const id = await insertValid();
        const error = await pgError(
          asOwner.query(
            `UPDATE "Certificate" SET "${column}" = ${value} WHERE id = $1`,
            [id],
          ),
        );
        expect(error.code).toBe(RAISE_EXCEPTION);
        expect(error.message).toMatch(/is immutable/);
        expect((await verify(id)).valid).toBe(true);
      },
    );

    it('T20: no column can hold file bytes', async () => {
      const { rows } = await asOwner.query(
        `SELECT table_name, column_name, data_type
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND data_type IN ('bytea', 'oid')`,
      );
      expect(rows).toEqual([]);
      const tables = await asOwner.query(
        `SELECT tablename FROM pg_tables
          WHERE schemaname = 'public' ORDER BY 1`,
      );
      expect(tables.rows).toEqual([
        { tablename: 'Anchor' },
        { tablename: 'Certificate' },
        { tablename: '_prisma_migrations' },
      ]);
    });
  });

  // The anchoring record of a certificate. The runtime role may create it and
  // track the sending; what it anchors, and a confirmed result, are fixed.
  describe('anchors', () => {
    // Not a real contract: rows left by this suite must never be sendable.
    const CONTRACT = '0x000000000000000000000000000000000000e2e1';
    const TX = `0x${'ab'.repeat(32)}`;
    const UNIQUE_VIOLATION = '23505';
    const FOREIGN_KEY_VIOLATION = '23503';

    /** A PENDING anchor of a new certificate, inserted as `client`. */
    async function createAnchor(
      client: Client = asApp,
      overrides: Record<string, unknown> = {},
    ): Promise<{ id: string; certificateId: string }> {
      const row: Record<string, unknown> = {
        id: randomUUID(),
        certificateId: await createCertificate(),
        chainId: 43113,
        contractAddress: CONTRACT,
        updatedAt: new Date().toISOString(),
        ...overrides,
      };
      const columns = Object.keys(row);
      await client.query(
        `INSERT INTO "Anchor" (${columns.map((c) => `"${c}"`).join(', ')})
         VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      );
      return {
        id: row.id as string,
        certificateId: row.certificateId as string,
      };
    }

    const set = (client: Client, id: string, assignments: string) =>
      client.query(`UPDATE "Anchor" SET ${assignments} WHERE id = $1`, [id]);

    const confirm = (client: Client, id: string) =>
      set(
        client,
        id,
        `"status" = 'CONFIRMED', "txHash" = '${TX}', "blockNumber" = 61003076,
         "anchoredAt" = '2026-11-13T12:18:25Z', "attempts" = 1`,
      );

    async function read(id: string) {
      const { rows } = await asOwner.query<Record<string, unknown>>(
        'SELECT * FROM "Anchor" WHERE id = $1',
        [id],
      );
      return rows[0];
    }

    it('T21: the app creates a PENDING anchor and tracks it to CONFIRMED', async () => {
      const { id } = await createAnchor();
      expect(await read(id)).toMatchObject({
        status: 'PENDING',
        txHash: null,
        blockNumber: null,
        anchoredAt: null,
        attempts: 0,
        lastError: null,
      });

      await set(asApp, id, `"status" = 'SUBMITTED', "txHash" = '${TX}'`);
      await set(asApp, id, `"attempts" = 1, "lastError" = 'TimeoutError'`);
      await confirm(asApp, id);
      expect(await read(id)).toMatchObject({
        status: 'CONFIRMED',
        txHash: TX,
        blockNumber: '61003076',
        attempts: 1,
      });
    });

    it.each([
      ['id', `'${randomUUID()}'`],
      ['certificateId', `'${randomUUID()}'`],
      ['chainId', '43114'],
      ['contractAddress', `'0x${'11'.repeat(20)}'`],
      ['createdAt', `'2000-01-01'`],
    ])(
      'T22: %s cannot be changed: no privilege for the app, a trigger for the owner',
      async (column, value) => {
        const { id } = await createAnchor();
        const before = await read(id);

        const denied = await pgError(set(asApp, id, `"${column}" = ${value}`));
        expect(denied.code).toBe(INSUFFICIENT_PRIVILEGE);

        const blocked = await pgError(
          set(asOwner, id, `"${column}" = ${value}`),
        );
        expect(blocked.code).toBe(RAISE_EXCEPTION);
        expect(blocked.message).toMatch(/is immutable/);
        expect(await read(id)).toEqual(before);
      },
    );

    it.each([
      ['back to PENDING', `"status" = 'PENDING'`],
      ['to FAILED', `"status" = 'FAILED'`],
      ['another transaction', `"txHash" = '0x${'cd'.repeat(32)}'`],
      ['another date', `"anchoredAt" = '2000-01-01'`],
      ['another block', `"blockNumber" = 1`],
    ])('T23: CONFIRMED is final: rejects %s', async (_case, assignments) => {
      const { id } = await createAnchor();
      await confirm(asApp, id);
      const before = await read(id);
      for (const client of [asApp, asOwner]) {
        const error = await pgError(set(client, id, assignments));
        expect(error.code).toBe(RAISE_EXCEPTION);
        expect(error.message).toMatch(/is confirmed/);
      }
      expect(await read(id)).toEqual(before);
    });

    it.each<[string, Record<string, unknown>]>([
      [
        'CONFIRMED',
        { status: 'CONFIRMED', anchoredAt: '2026-11-13T12:18:25Z' },
      ],
      ['SUBMITTED', { status: 'SUBMITTED', txHash: TX }],
      ['FAILED', { status: 'FAILED' }],
      ['PENDING with a transaction', { txHash: TX }],
      ['PENDING with attempts', { attempts: 3 }],
    ])('T24: rejects an anchor inserted as %s', async (_case, overrides) => {
      for (const client of [asApp, asOwner]) {
        const error = await pgError(createAnchor(client, overrides));
        expect(error.code).toBe(RAISE_EXCEPTION);
        expect(error.message).toMatch(/starts as PENDING/);
      }
    });

    it('T25: one anchor per certificate, and only for a certificate that exists', async () => {
      const { certificateId } = await createAnchor();
      const duplicate = await pgError(createAnchor(asApp, { certificateId }));
      expect(duplicate.code).toBe(UNIQUE_VIOLATION);

      const orphan = await pgError(
        createAnchor(asApp, { certificateId: randomUUID() }),
      );
      expect(orphan.code).toBe(FOREIGN_KEY_VIOLATION);
    });

    it.each<[string, Record<string, unknown>]>([
      ['another chain', { chainId: 43114 }],
      ['a malformed contract address', { contractAddress: '0x1234' }],
    ])('T26: rejects an anchor on %s', async (_case, overrides) => {
      const error = await pgError(createAnchor(asApp, overrides));
      expect(error.code).toBe(CHECK_VIOLATION);
    });

    it.each([
      ['a malformed transaction hash', `"txHash" = '0xABC'`],
      ['SUBMITTED without a transaction', `"status" = 'SUBMITTED'`],
      ['CONFIRMED without a date', `"status" = 'CONFIRMED'`],
      ['negative attempts', `"attempts" = -1`],
    ])('T26: rejects %s', async (_case, assignments) => {
      const { id } = await createAnchor();
      const error = await pgError(set(asApp, id, assignments));
      expect(error.code).toBe(CHECK_VIOLATION);
      expect(await read(id)).toMatchObject({ status: 'PENDING' });
    });

    it('T27: rejects DELETE and TRUNCATE, for the app and for the owner', async () => {
      const { id } = await createAnchor();
      for (const query of [
        asApp.query('DELETE FROM "Anchor" WHERE id = $1', [id]),
        asApp.query('TRUNCATE "Anchor"'),
      ]) {
        expect((await pgError(query)).code).toBe(INSUFFICIENT_PRIVILEGE);
      }
      for (const query of [
        asOwner.query('DELETE FROM "Anchor" WHERE id = $1', [id]),
        asOwner.query('TRUNCATE "Anchor"'),
      ]) {
        const error = await pgError(query);
        expect(error.code).toBe(RAISE_EXCEPTION);
        expect(error.message).toMatch(/cannot be deleted/);
      }
      expect(await read(id)).toMatchObject({ id });
    });

    it('T28: an anchor does not change its certificate, which still cannot be updated', async () => {
      const { certificateId } = await createAnchor();
      const error = await pgError(
        asApp.query('UPDATE "Certificate" SET "txHash" = $1 WHERE id = $2', [
          TX,
          certificateId,
        ]),
      );
      expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
      expect((await verify(certificateId)).valid).toBe(true);
    });
  });
});

const randomHash = (): string =>
  randomUUID().replace(/-/g, '').repeat(2).slice(0, 64);
