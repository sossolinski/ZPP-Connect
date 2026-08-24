ALTER TABLE "ImportBatch"
  ADD COLUMN "sourceMimeType" TEXT,
  ADD COLUMN "sourceSizeBytes" BIGINT,
  ADD COLUMN "sourceSha256" TEXT,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "validationOperationId" UUID,
  ADD COLUMN "validationFingerprint" TEXT,
  ADD COLUMN "validatedAt" TIMESTAMP(3),
  ADD COLUMN "validatedById" UUID,
  ADD COLUMN "confirmedAt" TIMESTAMP(3),
  ADD COLUMN "confirmedById" UUID,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "ImportBatch"
  ADD CONSTRAINT "ImportBatch_version_positive_check" CHECK ("version" > 0),
  ADD CONSTRAINT "ImportBatch_source_size_nonnegative_check" CHECK ("sourceSizeBytes" IS NULL OR "sourceSizeBytes" >= 0),
  ADD CONSTRAINT "ImportBatch_source_sha256_format_check" CHECK ("sourceSha256" IS NULL OR "sourceSha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "ImportBatch_validation_provenance_check" CHECK (
    "validationOperationId" IS NULL
    OR (
      "sessionId" IS NOT NULL
      AND "validationFingerprint" IS NOT NULL
      AND "sourceFilename" IS NOT NULL
      AND "sourceMimeType" IS NOT NULL
      AND "sourceSizeBytes" IS NOT NULL
      AND "sourceSha256" IS NOT NULL
      AND "validatedAt" IS NOT NULL
      AND "validatedById" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "ImportBatch_confirmation_state_check" CHECK (
    ("confirmedAt" IS NULL AND "confirmedById" IS NULL)
    OR ("confirmedAt" IS NOT NULL AND "confirmedById" IS NOT NULL AND "status" IN ('Imported', 'Imported with errors'))
  );

CREATE UNIQUE INDEX "ImportBatch_validationOperationId_key"
  ON "ImportBatch"("validationOperationId");
CREATE INDEX "ImportBatch_sessionId_createdAt_idx"
  ON "ImportBatch"("sessionId", "createdAt");
CREATE INDEX "ImportBatch_sessionId_importType_status_createdAt_idx"
  ON "ImportBatch"("sessionId", "importType", "status", "createdAt");

CREATE TABLE "ImportValidatedRow" (
  "id" UUID NOT NULL,
  "importBatchId" UUID NOT NULL,
  "rowNumber" INTEGER NOT NULL,
  "validationStatus" TEXT NOT NULL,
  "normalizedPayload" JSONB NOT NULL,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ImportValidatedRow_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ImportValidatedRow_row_number_check" CHECK ("rowNumber" >= 2),
  CONSTRAINT "ImportValidatedRow_status_check" CHECK ("validationStatus" IN ('VALID', 'INVALID')),
  CONSTRAINT "ImportValidatedRow_evidence_check" CHECK (
    ("validationStatus" = 'VALID' AND "errorCode" IS NULL AND "errorMessage" IS NULL)
    OR ("validationStatus" = 'INVALID' AND "errorMessage" IS NOT NULL)
  ),
  CONSTRAINT "ImportValidatedRow_importBatchId_fkey"
    FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ImportValidatedRow_importBatchId_rowNumber_key"
  ON "ImportValidatedRow"("importBatchId", "rowNumber");
CREATE INDEX "ImportValidatedRow_importBatchId_rowNumber_idx"
  ON "ImportValidatedRow"("importBatchId", "rowNumber");
CREATE INDEX "ImportValidatedRow_importBatchId_validationStatus_rowNumber_idx"
  ON "ImportValidatedRow"("importBatchId", "validationStatus", "rowNumber");

-- Prisma's @updatedAt writes this value explicitly. The temporary default only
-- backfills historical rows while the NOT NULL column is introduced.
ALTER TABLE "ImportBatch" ALTER COLUMN "updatedAt" DROP DEFAULT;
