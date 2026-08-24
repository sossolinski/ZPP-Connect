CREATE TABLE "ExportGeneration" (
  "id" UUID NOT NULL,
  "operationId" UUID NOT NULL,
  "commandFingerprint" TEXT NOT NULL,
  "incidentId" UUID NOT NULL,
  "exportType" TEXT NOT NULL,
  "format" TEXT NOT NULL,
  "schemaVersion" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "contentSha256" TEXT NOT NULL,
  "contentSizeBytes" BIGINT NOT NULL,
  "rowCount" INTEGER NOT NULL,
  "sectionCounts" JSONB NOT NULL,
  "includedSections" JSONB NOT NULL,
  "preparedById" UUID,
  "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "requestId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'Prepared',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ExportGeneration_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ExportGeneration_incidentId_fkey"
    FOREIGN KEY ("incidentId") REFERENCES "Session"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ExportGeneration_preparedById_fkey"
    FOREIGN KEY ("preparedById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ExportGeneration_status_check" CHECK ("status" = 'Prepared'),
  CONSTRAINT "ExportGeneration_format_check" CHECK ("format" = 'csv'),
  CONSTRAINT "ExportGeneration_export_type_check" CHECK (
    "exportType" IN ('session-package', 'enquiry-log', 'family-register', 'passenger-register', 'matching-log', 'requests-log', 'audit-log')
  ),
  CONSTRAINT "ExportGeneration_fingerprint_check" CHECK ("commandFingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ExportGeneration_sha256_check" CHECK ("contentSha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ExportGeneration_size_check" CHECK ("contentSizeBytes" >= 0),
  CONSTRAINT "ExportGeneration_row_count_check" CHECK ("rowCount" >= 0),
  CONSTRAINT "ExportGeneration_file_name_check" CHECK (
    length("fileName") BETWEEN 1 AND 255 AND "fileName" !~ '[[:cntrl:]/\\\\]'
  ),
  CONSTRAINT "ExportGeneration_sections_shape_check" CHECK (
    jsonb_typeof("sectionCounts") = 'object' AND jsonb_typeof("includedSections") = 'array'
  )
);

CREATE UNIQUE INDEX "ExportGeneration_operationId_key"
  ON "ExportGeneration"("operationId");
CREATE INDEX "ExportGeneration_incidentId_preparedAt_id_idx"
  ON "ExportGeneration"("incidentId", "preparedAt" DESC, "id");
CREATE INDEX "ExportGeneration_incidentId_exportType_preparedAt_idx"
  ON "ExportGeneration"("incidentId", "exportType", "preparedAt" DESC);
CREATE INDEX "ExportGeneration_preparedById_preparedAt_idx"
  ON "ExportGeneration"("preparedById", "preparedAt" DESC);
