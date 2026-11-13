-- Anchoring of a certificate's contentHash in the SpaceProofAnchor contract
-- (Avalanche Fuji). Additive only: "Certificate" is not touched, and existing
-- certificates simply have no row here.
--
-- The chain is the source of truth; this table tracks the sending
-- (PENDING -> SUBMITTED -> CONFIRMED, or FAILED) and keeps the transaction.

-- CreateEnum
CREATE TYPE "AnchorStatus" AS ENUM ('PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED');

-- CreateTable
CREATE TABLE "Anchor" (
    "id" TEXT NOT NULL,
    "certificateId" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "contractAddress" CHAR(42) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "AnchorStatus" NOT NULL DEFAULT 'PENDING',
    "txHash" CHAR(66),
    "blockNumber" BIGINT,
    "anchoredAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Anchor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Anchor_certificateId_key" ON "Anchor"("certificateId");

-- AddForeignKey
ALTER TABLE "Anchor" ADD CONSTRAINT "Anchor_certificateId_fkey" FOREIGN KEY ("certificateId") REFERENCES "Certificate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Prisma does not model CHECK constraints: they live only in this migration.

-- Avalanche Fuji is the only chain SpaceProof anchors on.
ALTER TABLE "Anchor" ADD CONSTRAINT "Anchor_chainId_fuji" CHECK ("chainId" = 43113);
ALTER TABLE "Anchor" ADD CONSTRAINT "Anchor_contractAddress_format"
  CHECK ("contractAddress" ~ '^0x[0-9a-fA-F]{40}$');
ALTER TABLE "Anchor" ADD CONSTRAINT "Anchor_txHash_format"
  CHECK ("txHash" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "Anchor" ADD CONSTRAINT "Anchor_blockNumber_positive"
  CHECK ("blockNumber" > 0);
ALTER TABLE "Anchor" ADD CONSTRAINT "Anchor_attempts_not_negative"
  CHECK ("attempts" >= 0);
-- A sent transaction has a hash; a confirmed anchor has the contract's date.
-- (CONFIRMED may have no txHash: the hash was found already on chain.)
ALTER TABLE "Anchor" ADD CONSTRAINT "Anchor_status_shape" CHECK (
  ("status" <> 'SUBMITTED' OR "txHash" IS NOT NULL)
  AND ("status" <> 'CONFIRMED' OR "anchoredAt" IS NOT NULL)
);

-- Rules that hold for every role, the owner included:
--   * a row is born PENDING, with nothing filled in;
--   * what it anchors (certificate, chain, contract) never changes;
--   * CONFIRMED is final.
CREATE FUNCTION anchor_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING'
       OR NEW."txHash" IS NOT NULL
       OR NEW."blockNumber" IS NOT NULL
       OR NEW."anchoredAt" IS NOT NULL
       OR NEW."attempts" <> 0
       OR NEW."lastError" IS NOT NULL THEN
      RAISE EXCEPTION 'An anchor starts as PENDING';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."certificateId" IS DISTINCT FROM OLD."certificateId"
     OR NEW."chainId" IS DISTINCT FROM OLD."chainId"
     OR NEW."contractAddress" IS DISTINCT FROM OLD."contractAddress"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Anchor % is immutable', OLD."id";
  END IF;

  IF OLD."status" = 'CONFIRMED' THEN
    RAISE EXCEPTION 'Anchor % is confirmed', OLD."id";
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "Anchor_guard"
BEFORE INSERT OR UPDATE ON "Anchor"
FOR EACH ROW EXECUTE FUNCTION anchor_guard();

-- Like certificates, anchors are evidence: they cannot be deleted.
CREATE FUNCTION anchor_prevent_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Anchors cannot be deleted';
END;
$$;

CREATE TRIGGER "Anchor_no_delete"
BEFORE DELETE ON "Anchor"
FOR EACH ROW EXECUTE FUNCTION anchor_prevent_delete();

CREATE TRIGGER "Anchor_no_truncate"
BEFORE TRUNCATE ON "Anchor"
FOR EACH STATEMENT EXECUTE FUNCTION anchor_prevent_delete();

-- EXECUTE is already revoked from PUBLIC by default for the owner's functions
-- (revoke_public_execute migration); stated here so it does not depend on it.
REVOKE EXECUTE ON FUNCTION anchor_guard() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION anchor_prevent_delete() FROM PUBLIC;

-- Privileges of the runtime role, explicit as for every table. It may read,
-- create, and UPDATE only the columns that track the sending. No DELETE, no
-- TRUNCATE, and still no UPDATE on "Certificate".
REVOKE ALL ON TABLE "Anchor" FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE "Anchor" TO spaceproof_app;
GRANT UPDATE ("status", "txHash", "blockNumber", "anchoredAt", "attempts", "lastError", "updatedAt")
  ON TABLE "Anchor" TO spaceproof_app;
