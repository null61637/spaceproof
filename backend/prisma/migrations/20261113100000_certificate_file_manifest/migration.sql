-- Certificates of a file and its metadata (manifest v2, docs/manifiesto-v2.md).
-- Additive only: no existing row is rewritten. Existing certificates become
-- "hashVersion" = 1 through the column default and keep verifying as before.
-- The file itself is never stored: only its SHA-256, size and name.
--
-- No new GRANT: spaceproof_app keeps SELECT and INSERT on the table, which
-- cover the new columns. Nobody gains UPDATE.

-- AlterTable
ALTER TABLE "Certificate" ADD COLUMN     "acquiredAt" TIMESTAMP(3),
ADD COLUMN     "fileName" TEXT,
ADD COLUMN     "fileSha256" CHAR(64),
ADD COLUMN     "fileSizeBytes" BIGINT,
ADD COLUMN     "hashVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "satellite" TEXT,
ADD COLUMN     "sceneId" TEXT,
ADD COLUMN     "sensor" TEXT;

-- Prisma does not model CHECK constraints: they live only in this migration.

-- A version-1 certificate covers title and recipient only, so it carries no
-- file or satellite data (which its hash would not protect). A version-2
-- certificate always has the fields its manifest requires.
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_hashVersion_shape" CHECK (
  ("hashVersion" = 1
     AND "fileSha256" IS NULL AND "fileSizeBytes" IS NULL AND "fileName" IS NULL
     AND "satellite" IS NULL AND "sensor" IS NULL AND "sceneId" IS NULL
     AND "acquiredAt" IS NULL)
  OR
  ("hashVersion" = 2
     AND "fileSha256" IS NOT NULL AND "fileSizeBytes" IS NOT NULL
     AND "satellite" IS NOT NULL AND "acquiredAt" IS NOT NULL)
);

-- Same form the manifest requires: lowercase hex, positive size.
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_fileSha256_format"
  CHECK ("fileSha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_fileSizeBytes_positive"
  CHECK ("fileSizeBytes" > 0);

-- Immutability now covers the new columns. Same function and trigger as the
-- certificate_integrity migration (CREATE OR REPLACE keeps its owner and its
-- revoked PUBLIC EXECUTE); "txHash" keeps its fill-once rule.
CREATE OR REPLACE FUNCTION certificate_prevent_tampering() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."title" IS DISTINCT FROM OLD."title"
     OR NEW."recipient" IS DISTINCT FROM OLD."recipient"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."contentHash" IS DISTINCT FROM OLD."contentHash"
     OR NEW."hashVersion" IS DISTINCT FROM OLD."hashVersion"
     OR NEW."fileSha256" IS DISTINCT FROM OLD."fileSha256"
     OR NEW."fileSizeBytes" IS DISTINCT FROM OLD."fileSizeBytes"
     OR NEW."fileName" IS DISTINCT FROM OLD."fileName"
     OR NEW."satellite" IS DISTINCT FROM OLD."satellite"
     OR NEW."sensor" IS DISTINCT FROM OLD."sensor"
     OR NEW."sceneId" IS DISTINCT FROM OLD."sceneId"
     OR NEW."acquiredAt" IS DISTINCT FROM OLD."acquiredAt" THEN
    RAISE EXCEPTION 'Certificate % is immutable', OLD."id";
  END IF;

  IF OLD."txHash" IS NOT NULL AND NEW."txHash" IS DISTINCT FROM OLD."txHash" THEN
    RAISE EXCEPTION 'Certificate % already has a txHash', OLD."id";
  END IF;

  RETURN NEW;
END;
$$;
