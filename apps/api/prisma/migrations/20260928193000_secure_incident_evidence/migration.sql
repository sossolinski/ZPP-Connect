CREATE SEQUENCE "StoredFile_operational_seq";

ALTER TABLE "StoredFile"
  ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'LEGACY',
  ADD COLUMN "originalFileName" TEXT,
  ADD COLUMN "declaredMimeType" TEXT,
  ADD COLUMN "contentSha256" TEXT,
  ADD COLUMN "category" TEXT,
  ADD COLUMN "description" TEXT,
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'Legacy',
  ADD COLUMN "scanStatus" TEXT NOT NULL DEFAULT 'NOT_APPLICABLE',
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "uploadOperationId" UUID,
  ADD COLUMN "uploadFingerprint" TEXT,
  ADD COLUMN "requestId" TEXT,
  ADD COLUMN "withdrawnAt" TIMESTAMP(3),
  ADD COLUMN "withdrawnById" UUID,
  ADD COLUMN "withdrawalReason" TEXT;

CREATE TABLE "StoredArtifact" (
  "storageKey" TEXT NOT NULL,
  "storageProvider" TEXT NOT NULL DEFAULT 'postgres',
  "sizeBytes" BIGINT NOT NULL,
  "contentSha256" TEXT NOT NULL,
  "content" BYTEA NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StoredArtifact_pkey" PRIMARY KEY ("storageKey"),
  CONSTRAINT "StoredArtifact_contract" CHECK (
    "storageProvider" = 'postgres'
    AND "storageKey" ~ '^incident-evidence/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND "sizeBytes" BETWEEN 1 AND 20971520
    AND "contentSha256" ~ '^[0-9a-f]{64}$'
    AND octet_length("content") = "sizeBytes"
  )
);

CREATE TABLE "StoredFileOperation" (
  "operationId" UUID NOT NULL,
  "storedFileId" UUID NOT NULL,
  "command" TEXT NOT NULL,
  "commandFingerprint" TEXT NOT NULL,
  "resultVersion" INTEGER NOT NULL,
  "result" JSONB NOT NULL,
  "requestId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StoredFileOperation_pkey" PRIMARY KEY ("operationId"),
  CONSTRAINT "StoredFileOperation_contract" CHECK (
    "command" IN ('upload', 'withdraw')
    AND "commandFingerprint" ~ '^[0-9a-f]{64}$'
    AND "resultVersion" > 0
    AND octet_length("result"::text) <= 4096
  )
);

CREATE UNIQUE INDEX "StoredFile_uploadOperationId_key" ON "StoredFile"("uploadOperationId");
CREATE UNIQUE INDEX "StoredFile_evidence_storage_key" ON "StoredFile"("storageKey") WHERE "purpose" = 'INCIDENT_EVIDENCE';
CREATE INDEX "StoredFile_sessionId_purpose_status_createdAt_id_idx" ON "StoredFile"("sessionId", "purpose", "status", "createdAt" DESC, "id");
CREATE INDEX "StoredFile_contentSha256_idx" ON "StoredFile"("contentSha256");
CREATE INDEX "StoredFileOperation_storedFileId_createdAt_idx" ON "StoredFileOperation"("storedFileId", "createdAt");

ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_purpose_check" CHECK ("purpose" IN ('LEGACY', 'INCIDENT_EVIDENCE'));
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_evidence_contract" CHECK (
  "purpose" = 'LEGACY' OR (
    "sessionId" IS NOT NULL
    AND "importBatchId" IS NULL
    AND "originalFileName" IS NOT NULL
    AND length("originalFileName") BETWEEN 1 AND 255
    AND "originalFileName" !~ '[[:cntrl:]/\\]'
    AND length("fileName") BETWEEN 1 AND 255
    AND "fileName" !~ '[[:cntrl:]/\\]'
    AND "mimeType" IN ('application/pdf', 'image/jpeg', 'image/png', 'text/plain')
    AND "declaredMimeType" IS NOT NULL
    AND length("declaredMimeType") BETWEEN 1 AND 200
    AND "sizeBytes" BETWEEN 1 AND 20971520
    AND "contentSha256" ~ '^[0-9a-f]{64}$'
    AND "storageProvider" = 'postgres'
    AND "storageKey" ~ '^incident-evidence/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND "category" IN ('Photograph', 'Scanned document', 'Authority correspondence', 'Operational evidence', 'External report', 'Reference')
    AND length("description") <= 4000
    AND "status" IN ('Active', 'Withdrawn')
    AND "scanStatus" = 'NOT_CONFIGURED'
    AND "version" > 0
    AND "uploadOperationId" IS NOT NULL
    AND "uploadFingerprint" ~ '^[0-9a-f]{64}$'
    AND "requestId" IS NOT NULL
    AND length("requestId") BETWEEN 1 AND 200
    AND "entityType" IS NULL
    AND "entityId" IS NULL
    AND "createdById" IS NOT NULL
    AND (
      ("status" = 'Active' AND "withdrawnAt" IS NULL AND "withdrawnById" IS NULL AND "withdrawalReason" IS NULL)
      OR
      ("status" = 'Withdrawn' AND "withdrawnAt" IS NOT NULL AND "withdrawnById" IS NOT NULL
        AND length(trim("withdrawalReason")) BETWEEN 1 AND 2000)
    )
  )
);

ALTER TABLE "StoredFile" DROP CONSTRAINT "StoredFile_sessionId_fkey";
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_withdrawnById_fkey"
  FOREIGN KEY ("withdrawnById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StoredFileOperation" ADD CONSTRAINT "StoredFileOperation_storedFileId_fkey"
  FOREIGN KEY ("storedFileId") REFERENCES "StoredFile"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "prevent_stored_artifact_mutation"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Stored incident evidence bytes are immutable';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "StoredFile"
    WHERE "purpose" = 'INCIDENT_EVIDENCE' AND "storageKey" = OLD."storageKey"
  ) THEN
    RAISE EXCEPTION 'Referenced incident evidence bytes cannot be deleted';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "StoredArtifact_immutable"
  BEFORE UPDATE OR DELETE ON "StoredArtifact"
  FOR EACH ROW EXECUTE FUNCTION "prevent_stored_artifact_mutation"();

CREATE FUNCTION "prevent_stored_file_evidence_rewrite"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."purpose" = 'INCIDENT_EVIDENCE' THEN
      RAISE EXCEPTION 'Stored incident evidence metadata cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."purpose" = 'INCIDENT_EVIDENCE' AND (
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."operationalId" IS DISTINCT FROM OLD."operationalId"
    OR NEW."sessionId" IS DISTINCT FROM OLD."sessionId"
    OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
    OR NEW."originalFileName" IS DISTINCT FROM OLD."originalFileName"
    OR NEW."fileName" IS DISTINCT FROM OLD."fileName"
    OR NEW."mimeType" IS DISTINCT FROM OLD."mimeType"
    OR NEW."declaredMimeType" IS DISTINCT FROM OLD."declaredMimeType"
    OR NEW."sizeBytes" IS DISTINCT FROM OLD."sizeBytes"
    OR NEW."contentSha256" IS DISTINCT FROM OLD."contentSha256"
    OR NEW."storageProvider" IS DISTINCT FROM OLD."storageProvider"
    OR NEW."storageKey" IS DISTINCT FROM OLD."storageKey"
    OR NEW."category" IS DISTINCT FROM OLD."category"
    OR NEW."description" IS DISTINCT FROM OLD."description"
    OR NEW."scanStatus" IS DISTINCT FROM OLD."scanStatus"
    OR NEW."uploadOperationId" IS DISTINCT FROM OLD."uploadOperationId"
    OR NEW."uploadFingerprint" IS DISTINCT FROM OLD."uploadFingerprint"
    OR NEW."requestId" IS DISTINCT FROM OLD."requestId"
    OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  ) THEN
    RAISE EXCEPTION 'Stored incident evidence metadata is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "StoredFile_evidence_immutable"
  BEFORE UPDATE OR DELETE ON "StoredFile"
  FOR EACH ROW EXECUTE FUNCTION "prevent_stored_file_evidence_rewrite"();

CREATE FUNCTION "prevent_stored_file_operation_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Stored incident evidence operation history is immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "StoredFileOperation_immutable"
  BEFORE UPDATE OR DELETE ON "StoredFileOperation"
  FOR EACH ROW EXECUTE FUNCTION "prevent_stored_file_operation_mutation"();
