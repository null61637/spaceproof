-- Least privilege for the runtime role. spaceproof_app is created by
-- backend/db/init/10-roles.sh, which must run before this migration.
-- Prisma does not track privileges: every new table needs its own GRANT here,
-- and the privilege tests (test/db-privileges.e2e-spec.ts) list the exact set.

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO spaceproof_app;

-- Read and issue certificates only: no UPDATE (not even "txHash"), DELETE or TRUNCATE.
REVOKE ALL ON TABLE "Certificate" FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE "Certificate" TO spaceproof_app;
