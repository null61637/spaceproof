import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { auditCertificates } from '../src/certificates/certificate-audit';
import { computeCertificateHash } from '../src/certificates/certificate-hash';
import { PrismaService } from '../src/prisma/prisma.service';
import { connectAs } from './db';

// The bulk check against PostgreSQL, as spaceproof_app (like the script).
describe('Certificate audit (e2e)', () => {
  let prisma: PrismaService;
  let db: Client;

  beforeAll(async () => {
    prisma = new PrismaService();
    db = await connectAs('DATABASE_URL');
  });

  afterAll(async () => {
    await db.end();
    await prisma.$disconnect();
  });

  async function insert(title: string, hashedTitle: string): Promise<string> {
    const id = randomUUID();
    const createdAt = new Date();
    const contentHash = computeCertificateHash({
      id,
      title: hashedTitle,
      recipient: 'Ada',
      createdAt,
    });
    await db.query(
      `INSERT INTO "Certificate" (id, title, recipient, "contentHash", "createdAt")
       VALUES ($1, $2, 'Ada', $3, $4)`,
      [id, title, contentHash, createdAt.toISOString()],
    );
    return id;
  }

  it('reports intact and tampered certificates without changing them', async () => {
    const intact = await insert('Audit intact', 'Audit intact');
    const forged = await insert('Audit forged', 'Audit original');
    const before = await db.query('SELECT * FROM "Certificate" ORDER BY id');

    const audit = await auditCertificates(prisma, 3);

    expect(audit.invalidIds).toContain(forged);
    expect(audit.invalidIds).not.toContain(intact);
    expect(audit.errors).toBe(0);
    expect(audit.total).toBe(before.rowCount);
    expect(audit.valid + audit.invalid + audit.errors).toBe(audit.total);

    const after = await db.query('SELECT * FROM "Certificate" ORDER BY id');
    expect(after.rows).toEqual(before.rows);
  });
});
