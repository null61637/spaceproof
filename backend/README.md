# SpaceProof — backend

API REST en NestJS 11 con Prisma 7 y PostgreSQL 17. La instalación, las variables de entorno, los roles de la base y los tests están documentados en el [README principal](../README.md).

```bash
pnpm install
pnpm db:up && pnpm db:bootstrap   # PostgreSQL de desarrollo y roles
pnpm exec prisma migrate deploy   # migraciones pendientes, como spaceproof_owner
pnpm start:dev                    # http://localhost:3001/api
pnpm test && pnpm test:e2e        # unitarios y e2e (spaceproof_test)
pnpm build && pnpm verify:certificates
```

- `src/certificates/`: API de certificados, hash canónico (`certificate-hash.ts`) y verificación masiva (`certificate-audit.ts`).
- `src/health/`: `/api/health/live` y `/api/health/ready`.
- `src/common/`: id de solicitud, filtro de errores y clasificación de errores de base de datos.
- `db/init/10-roles.sh`: bootstrap de roles y bases.
- `prisma/migrations/`: no edites migraciones aplicadas; creá una nueva.
- `test/`: e2e; solo contra `spaceproof_test` (ver `test/test-env.ts`).
