CREATE SEQUENCE "Document_id_seq" START 7;
CREATE SEQUENCE "DocumentVersion_id_seq" START 7;
CREATE SEQUENCE "DocumentRequirement_id_seq" START 6;
CREATE SEQUENCE "DocumentAcknowledgement_id_seq" START 2;

CREATE TABLE "Document" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "normalizedCode" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "category" TEXT NOT NULL,
  "ownerFunction" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "archivedAt" TIMESTAMP(3),
  "reactivatedAt" TIMESTAMP(3),
  "legacyImported" BOOLEAN NOT NULL DEFAULT false,
  "legacyMetadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById" UUID,
  "updatedById" UUID,
  CONSTRAINT "Document_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Document_lifecycle_check" CHECK (
    ("active" = true AND "archivedAt" IS NULL) OR
    ("active" = false AND "archivedAt" IS NOT NULL)
  )
);

CREATE TABLE "DocumentVersion" (
  "id" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "versionLabel" TEXT NOT NULL,
  "normalizedVersionLabel" TEXT NOT NULL,
  "titleOverride" TEXT,
  "changeSummary" TEXT,
  "status" TEXT NOT NULL DEFAULT 'Draft',
  "effectiveFrom" TIMESTAMP(3),
  "reviewDueAt" TIMESTAMP(3),
  "publishedAt" TIMESTAMP(3),
  "publishedById" UUID,
  "withdrawnAt" TIMESTAMP(3),
  "withdrawnById" UUID,
  "withdrawReason" TEXT,
  "contentMode" TEXT NOT NULL,
  "contentBody" TEXT,
  "externalUrl" TEXT,
  "contentDigest" TEXT,
  "basePublishedVersionId" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "provenance" JSONB,
  "legacyImported" BOOLEAN NOT NULL DEFAULT false,
  "legacyMetadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById" UUID,
  "updatedById" UUID,
  CONSTRAINT "DocumentVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DocumentVersion_status_check" CHECK ("status" IN ('Draft', 'Published', 'Superseded', 'Withdrawn')),
  CONSTRAINT "DocumentVersion_content_mode_check" CHECK ("contentMode" IN ('Internal text', 'External link')),
  CONSTRAINT "DocumentVersion_content_shape_check" CHECK (
    ("contentMode" = 'Internal text' AND "externalUrl" IS NULL) OR
    ("contentMode" = 'External link' AND "contentBody" IS NULL)
  ),
  CONSTRAINT "DocumentVersion_published_provenance_check" CHECK (
    "status" NOT IN ('Published', 'Superseded') OR ("publishedAt" IS NOT NULL AND "publishedById" IS NOT NULL)
  ),
  CONSTRAINT "DocumentVersion_published_content_check" CHECK (
    "status" NOT IN ('Published', 'Superseded') OR
    ("contentMode" = 'Internal text' AND length(btrim(COALESCE("contentBody", ''))) > 0 AND "contentDigest" IS NOT NULL) OR
    ("contentMode" = 'External link' AND "externalUrl" ~ '^https://')
  ),
  CONSTRAINT "DocumentVersion_withdraw_provenance_check" CHECK (
    "status" <> 'Withdrawn' OR ("withdrawnAt" IS NOT NULL AND "withdrawnById" IS NOT NULL)
  )
);

CREATE TABLE "DocumentRequirement" (
  "id" TEXT NOT NULL,
  "documentVersionId" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetRole" TEXT,
  "groupId" TEXT,
  "memberProfileId" TEXT,
  "acknowledgementRequired" BOOLEAN NOT NULL DEFAULT true,
  "effectiveFrom" TIMESTAMP(3),
  "dueAt" TIMESTAMP(3),
  "effectiveTo" TIMESTAMP(3),
  "active" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "provenance" JSONB,
  "endedAt" TIMESTAMP(3),
  "endedById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById" UUID,
  "updatedById" UUID,
  CONSTRAINT "DocumentRequirement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DocumentRequirement_target_check" CHECK (
    ("targetType" = 'Role' AND "targetRole" IS NOT NULL AND "groupId" IS NULL AND "memberProfileId" IS NULL) OR
    ("targetType" = 'Group' AND "targetRole" IS NULL AND "groupId" IS NOT NULL AND "memberProfileId" IS NULL) OR
    ("targetType" = 'MemberProfile' AND "targetRole" IS NULL AND "groupId" IS NULL AND "memberProfileId" IS NOT NULL)
  ),
  CONSTRAINT "DocumentRequirement_dates_check" CHECK (
    "effectiveTo" IS NULL OR "effectiveFrom" IS NULL OR "effectiveTo" > "effectiveFrom"
  ),
  CONSTRAINT "DocumentRequirement_end_check" CHECK (
    ("active" = true AND "endedAt" IS NULL AND "endedById" IS NULL) OR
    ("active" = false AND "endedAt" IS NOT NULL)
  )
);

CREATE TABLE "DocumentAcknowledgement" (
  "id" TEXT NOT NULL,
  "documentVersionId" TEXT NOT NULL,
  "memberProfileId" TEXT NOT NULL,
  "acknowledgedAt" TIMESTAMP(3) NOT NULL,
  "acknowledgedById" UUID NOT NULL,
  "acknowledgementStatementVersion" TEXT NOT NULL,
  "note" TEXT,
  "onBehalf" BOOLEAN NOT NULL DEFAULT false,
  "documentCode" TEXT NOT NULL,
  "documentTitle" TEXT NOT NULL,
  "versionLabel" TEXT NOT NULL,
  "contentMode" TEXT NOT NULL,
  "externalUrlSnapshot" TEXT,
  "contentDigestSnapshot" TEXT,
  "legacyImported" BOOLEAN NOT NULL DEFAULT false,
  "legacyMetadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DocumentAcknowledgement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DocumentAcknowledgement_evidence_check" CHECK (
    "legacyImported" = true OR
    ("contentMode" = 'Internal text' AND "contentDigestSnapshot" IS NOT NULL AND "externalUrlSnapshot" IS NULL) OR
    ("contentMode" = 'External link' AND "externalUrlSnapshot" ~ '^https://' AND "contentDigestSnapshot" IS NULL)
  ),
  CONSTRAINT "DocumentAcknowledgement_behalf_note_check" CHECK (
    "legacyImported" = true OR "onBehalf" = false OR length(btrim(COALESCE("note", ''))) >= 3
  )
);

CREATE TABLE "DocumentAcknowledgementRequirement" (
  "acknowledgementId" TEXT NOT NULL,
  "requirementId" TEXT NOT NULL,
  CONSTRAINT "DocumentAcknowledgementRequirement_pkey" PRIMARY KEY ("acknowledgementId", "requirementId")
);

CREATE TABLE "DocumentOperation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "operationId" UUID NOT NULL,
  "documentVersionId" TEXT,
  "requirementId" TEXT,
  "acknowledgementId" TEXT,
  "command" TEXT NOT NULL,
  "commandFingerprint" TEXT NOT NULL,
  "resultVersion" INTEGER NOT NULL,
  "result" JSONB NOT NULL,
  "requestId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DocumentOperation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Document_normalizedCode_key" ON "Document"("normalizedCode");
CREATE INDEX "Document_active_category_title_idx" ON "Document"("active", "category", "title");
CREATE INDEX "Document_ownerFunction_active_idx" ON "Document"("ownerFunction", "active");
CREATE INDEX "Document_updatedAt_idx" ON "Document"("updatedAt");
CREATE UNIQUE INDEX "DocumentVersion_documentId_normalizedVersionLabel_key" ON "DocumentVersion"("documentId", "normalizedVersionLabel");
CREATE UNIQUE INDEX "DocumentVersion_one_published_per_document_key" ON "DocumentVersion"("documentId") WHERE "status" = 'Published';
CREATE INDEX "DocumentVersion_documentId_status_createdAt_idx" ON "DocumentVersion"("documentId", "status", "createdAt");
CREATE INDEX "DocumentVersion_reviewDueAt_status_idx" ON "DocumentVersion"("reviewDueAt", "status");
CREATE UNIQUE INDEX "DocumentRequirement_active_exact_target_key" ON "DocumentRequirement"(
  "documentVersionId", "targetType", COALESCE("targetRole", ''), COALESCE("groupId", ''), COALESCE("memberProfileId", '')
) WHERE "active" = true AND "effectiveTo" IS NULL;
CREATE INDEX "DocumentRequirement_version_active_window_idx" ON "DocumentRequirement"("documentVersionId", "active", "effectiveFrom", "effectiveTo");
CREATE INDEX "DocumentRequirement_target_role_active_idx" ON "DocumentRequirement"("targetType", "targetRole", "active");
CREATE INDEX "DocumentRequirement_group_active_idx" ON "DocumentRequirement"("groupId", "active");
CREATE INDEX "DocumentRequirement_member_active_idx" ON "DocumentRequirement"("memberProfileId", "active");
CREATE INDEX "DocumentRequirement_due_active_idx" ON "DocumentRequirement"("dueAt", "active");
CREATE UNIQUE INDEX "DocumentAcknowledgement_version_member_key" ON "DocumentAcknowledgement"("documentVersionId", "memberProfileId");
CREATE INDEX "DocumentAcknowledgement_member_date_idx" ON "DocumentAcknowledgement"("memberProfileId", "acknowledgedAt");
CREATE INDEX "DocumentAcknowledgement_version_date_idx" ON "DocumentAcknowledgement"("documentVersionId", "acknowledgedAt");
CREATE INDEX "DocumentAcknowledgement_actor_date_idx" ON "DocumentAcknowledgement"("acknowledgedById", "acknowledgedAt");
CREATE INDEX "DocumentAcknowledgementRequirement_requirement_idx" ON "DocumentAcknowledgementRequirement"("requirementId");
CREATE UNIQUE INDEX "DocumentOperation_operationId_key" ON "DocumentOperation"("operationId");
CREATE INDEX "DocumentOperation_version_createdAt_idx" ON "DocumentOperation"("documentVersionId", "createdAt");
CREATE INDEX "DocumentOperation_requirement_createdAt_idx" ON "DocumentOperation"("requirementId", "createdAt");
CREATE INDEX "DocumentOperation_ack_createdAt_idx" ON "DocumentOperation"("acknowledgementId", "createdAt");

ALTER TABLE "DocumentVersion" ADD CONSTRAINT "DocumentVersion_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DocumentVersion" ADD CONSTRAINT "DocumentVersion_basePublishedVersionId_fkey" FOREIGN KEY ("basePublishedVersionId") REFERENCES "DocumentVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DocumentRequirement" ADD CONSTRAINT "DocumentRequirement_documentVersionId_fkey" FOREIGN KEY ("documentVersionId") REFERENCES "DocumentVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DocumentRequirement" ADD CONSTRAINT "DocumentRequirement_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "OperationalGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DocumentRequirement" ADD CONSTRAINT "DocumentRequirement_memberProfileId_fkey" FOREIGN KEY ("memberProfileId") REFERENCES "MemberProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DocumentAcknowledgement" ADD CONSTRAINT "DocumentAcknowledgement_documentVersionId_fkey" FOREIGN KEY ("documentVersionId") REFERENCES "DocumentVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DocumentAcknowledgement" ADD CONSTRAINT "DocumentAcknowledgement_memberProfileId_fkey" FOREIGN KEY ("memberProfileId") REFERENCES "MemberProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DocumentAcknowledgementRequirement" ADD CONSTRAINT "DocumentAcknowledgementRequirement_acknowledgementId_fkey" FOREIGN KEY ("acknowledgementId") REFERENCES "DocumentAcknowledgement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DocumentAcknowledgementRequirement" ADD CONSTRAINT "DocumentAcknowledgementRequirement_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "DocumentRequirement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DocumentOperation" ADD CONSTRAINT "DocumentOperation_documentVersionId_fkey" FOREIGN KEY ("documentVersionId") REFERENCES "DocumentVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DocumentOperation" ADD CONSTRAINT "DocumentOperation_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "DocumentRequirement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DocumentOperation" ADD CONSTRAINT "DocumentOperation_acknowledgementId_fkey" FOREIGN KEY ("acknowledgementId") REFERENCES "DocumentAcknowledgement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "enforce_document_version_transition"() RETURNS trigger AS $$
BEGIN
  IF NOT (
    (OLD."status" = 'Draft' AND NEW."status" IN ('Draft', 'Published', 'Withdrawn')) OR
    (OLD."status" = 'Published' AND NEW."status" IN ('Published', 'Superseded', 'Withdrawn')) OR
    (OLD."status" = 'Superseded' AND NEW."status" = 'Superseded') OR
    (OLD."status" = 'Withdrawn' AND NEW."status" = 'Withdrawn')
  ) THEN
    RAISE EXCEPTION 'invalid document version transition';
  END IF;
  IF OLD."status" <> 'Draft' AND (
    NEW."documentId" IS DISTINCT FROM OLD."documentId" OR
    NEW."versionLabel" IS DISTINCT FROM OLD."versionLabel" OR
    NEW."normalizedVersionLabel" IS DISTINCT FROM OLD."normalizedVersionLabel" OR
    NEW."titleOverride" IS DISTINCT FROM OLD."titleOverride" OR
    NEW."changeSummary" IS DISTINCT FROM OLD."changeSummary" OR
    NEW."effectiveFrom" IS DISTINCT FROM OLD."effectiveFrom" OR
    NEW."reviewDueAt" IS DISTINCT FROM OLD."reviewDueAt" OR
    NEW."contentMode" IS DISTINCT FROM OLD."contentMode" OR
    NEW."contentBody" IS DISTINCT FROM OLD."contentBody" OR
    NEW."externalUrl" IS DISTINCT FROM OLD."externalUrl" OR
    NEW."contentDigest" IS DISTINCT FROM OLD."contentDigest"
  ) THEN
    RAISE EXCEPTION 'published document version content is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "DocumentVersion_transition_guard"
BEFORE UPDATE ON "DocumentVersion"
FOR EACH ROW EXECUTE FUNCTION "enforce_document_version_transition"();

CREATE FUNCTION "prevent_acknowledgement_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'document acknowledgement is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "DocumentAcknowledgement_append_only_update"
BEFORE UPDATE OR DELETE ON "DocumentAcknowledgement"
FOR EACH ROW EXECUTE FUNCTION "prevent_acknowledgement_mutation"();

CREATE TRIGGER "DocumentAcknowledgementRequirement_append_only_update"
BEFORE UPDATE OR DELETE ON "DocumentAcknowledgementRequirement"
FOR EACH ROW EXECUTE FUNCTION "prevent_acknowledgement_mutation"();
