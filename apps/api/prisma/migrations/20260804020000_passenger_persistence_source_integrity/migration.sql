ALTER TABLE "PassengerRecord"
  ADD COLUMN "sourceBatchId" UUID,
  ADD COLUMN "sourceExternalId" TEXT,
  ADD COLUMN "sourceImportedAt" TIMESTAMP(3),
  ADD COLUMN "conditionUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "conditionUpdatedById" UUID,
  ADD COLUMN "conditionBasis" TEXT,
  ADD COLUMN "holdUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "holdUpdatedById" UUID,
  ADD COLUMN "holdReason" TEXT,
  ADD COLUMN "srcConfirmedAt" TIMESTAMP(3),
  ADD COLUMN "srcConfirmedById" UUID,
  ADD COLUMN "srcConfirmationBasis" TEXT,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

UPDATE "PassengerRecord"
SET "sourceImportedAt" = "createdAt"
WHERE "source" <> 'Manual';

UPDATE "PassengerRecord"
SET "srcConfirmedAt" = "updatedAt",
    "srcConfirmationBasis" = 'Historical confirmation migrated without actor detail'
WHERE "srcConfirmed" = true;

ALTER TABLE "PassengerRecord"
  ADD CONSTRAINT "PassengerRecord_version_positive_check" CHECK ("version" > 0),
  ADD CONSTRAINT "PassengerRecord_age_range_check" CHECK ("age" IS NULL OR ("age" >= 0 AND "age" <= 130)),
  ADD CONSTRAINT "PassengerRecord_dob_age_check" CHECK ("dateOfBirth" IS NULL OR "age" IS NULL),
  ADD CONSTRAINT "PassengerRecord_src_confirmation_check" CHECK (
    ("srcConfirmed" = false AND "srcConfirmedAt" IS NULL AND "srcConfirmedById" IS NULL)
    OR ("srcConfirmed" = true AND "srcConfirmedAt" IS NOT NULL)
  );

ALTER TABLE "PassengerRecord"
  ADD CONSTRAINT "PassengerRecord_sourceBatchId_fkey"
  FOREIGN KEY ("sourceBatchId") REFERENCES "ImportBatch"("id")
  ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "PassengerRecord_conditionUpdatedById_fkey"
  FOREIGN KEY ("conditionUpdatedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "PassengerRecord_holdUpdatedById_fkey"
  FOREIGN KEY ("holdUpdatedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "PassengerRecord_srcConfirmedById_fkey"
  FOREIGN KEY ("srcConfirmedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

DROP INDEX "PassengerRecord_sessionId_conditionStatus_idx";
CREATE INDEX "PassengerRecord_sessionId_updatedAt_idx"
  ON "PassengerRecord"("sessionId", "updatedAt");
CREATE INDEX "PassengerRecord_sessionId_conditionStatus_updatedAt_idx"
  ON "PassengerRecord"("sessionId", "conditionStatus", "updatedAt");
CREATE INDEX "PassengerRecord_sessionId_holdStatus_updatedAt_idx"
  ON "PassengerRecord"("sessionId", "holdStatus", "updatedAt");
CREATE INDEX "PassengerRecord_sessionId_source_updatedAt_idx"
  ON "PassengerRecord"("sessionId", "source", "updatedAt");
CREATE INDEX "PassengerRecord_sessionId_sourceBatchId_idx"
  ON "PassengerRecord"("sessionId", "sourceBatchId");
CREATE INDEX "PassengerRecord_sessionId_sourceExternalId_idx"
  ON "PassengerRecord"("sessionId", "sourceExternalId");
CREATE UNIQUE INDEX "PassengerRecord_incident_source_external_unique"
  ON "PassengerRecord"("sessionId", "source", "sourceExternalId")
  WHERE "sourceExternalId" IS NOT NULL;

CREATE SEQUENCE "PassengerRecord_operational_seq";
SELECT setval(
  '"PassengerRecord_operational_seq"',
  GREATEST(
    COALESCE((
      SELECT MAX(substring("operationalId" FROM '([0-9]+)$')::BIGINT)
      FROM "PassengerRecord"
      WHERE "operationalId" ~ '^PAX-[0-9]{4}-[0-9]+$'
    ), 0) + 1,
    1
  ),
  false
);
