import 'dotenv/config';
import { auditCertificates } from '../certificates/certificate-audit';
import { PrismaService } from '../prisma/prisma.service';

// Bulk integrity check, read only. Uses DATABASE_URL (spaceproof_app).
//   pnpm build && pnpm verify:certificates
//   docker compose -f docker-compose.prod.yml exec backend node dist/scripts/verify-certificates.js
// Prints a JSON summary. Exit code: 0 all valid, 1 invalid or unreadable
// certificates found, 2 the check itself failed.
async function main(): Promise<number> {
  const prisma = new PrismaService();
  try {
    const audit = await auditCertificates(prisma);
    console.log(JSON.stringify(audit, null, 2));
    return audit.invalid + audit.errors === 0 ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    // No URL or query arguments: only the error name and code.
    const { name, code } = (error ?? {}) as { name?: string; code?: string };
    console.error(JSON.stringify({ error: 'verification failed', name, code }));
    process.exit(2);
  },
);
