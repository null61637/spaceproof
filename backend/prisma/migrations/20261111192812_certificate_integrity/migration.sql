-- AlterTable
ALTER TABLE "Certificate" ALTER COLUMN "contentHash" SET NOT NULL,
ALTER COLUMN "contentHash" SET DATA TYPE CHAR(64);

-- CreateIndex
CREATE UNIQUE INDEX "Certificate_contentHash_key" ON "Certificate"("contentHash");

-- Integrity: certificate records are immutable. The only permitted update is
-- filling in "txHash" once, while it is still NULL. DELETE is not blocked.
CREATE FUNCTION certificate_prevent_tampering() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."title" IS DISTINCT FROM OLD."title"
     OR NEW."recipient" IS DISTINCT FROM OLD."recipient"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."contentHash" IS DISTINCT FROM OLD."contentHash" THEN
    RAISE EXCEPTION 'Certificate % is immutable', OLD."id";
  END IF;

  IF OLD."txHash" IS NOT NULL AND NEW."txHash" IS DISTINCT FROM OLD."txHash" THEN
    RAISE EXCEPTION 'Certificate % already has a txHash', OLD."id";
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "Certificate_immutable"
BEFORE UPDATE ON "Certificate"
FOR EACH ROW EXECUTE FUNCTION certificate_prevent_tampering();
