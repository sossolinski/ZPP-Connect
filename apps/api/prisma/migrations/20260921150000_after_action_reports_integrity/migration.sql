-- CreateTable
-- Seven normalized AAR tables; the plan's "five tables" was a counting typo.
CREATE SEQUENCE "AfterActionReport_operational_seq";

CREATE TABLE "AfterActionReport" (
    "id" UUID NOT NULL,
    "operationalId" TEXT NOT NULL,
    "sessionId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" UUID NOT NULL,
    "updatedById" UUID NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "archivedById" UUID,
    "archiveReason" TEXT,

    CONSTRAINT "AfterActionReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AfterActionReportVersion" (
    "id" UUID NOT NULL,
    "reportId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "basedOnVersionId" UUID,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "title" TEXT NOT NULL,
    "eventDate" TIMESTAMP(3) NOT NULL,
    "executiveSummary" TEXT NOT NULL DEFAULT '',
    "schemaVersion" TEXT NOT NULL DEFAULT 'aar-v1',
    "contentSha256" TEXT,
    "contextSnapshot" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" UUID NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "submittedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "approvedById" UUID,

    CONSTRAINT "AfterActionReportVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AfterActionFinding" (
    "id" UUID NOT NULL,
    "reportVersionId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "area" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "detail" TEXT,
    "sourceObservationId" UUID,
    "sourceObservationVersion" INTEGER,
    "sourceObservationOperationalId" TEXT,

    CONSTRAINT "AfterActionFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AfterActionLesson" (
    "id" UUID NOT NULL,
    "reportVersionId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "statement" TEXT NOT NULL,

    CONSTRAINT "AfterActionLesson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AfterActionCorrectiveAction" (
    "id" UUID NOT NULL,
    "reportVersionId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "recommendation" TEXT NOT NULL,
    "owner" TEXT,
    "targetDate" TIMESTAMP(3),

    CONSTRAINT "AfterActionCorrectiveAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AfterActionOperation" (
    "operationId" UUID NOT NULL,
    "command" TEXT NOT NULL,
    "commandFingerprint" TEXT NOT NULL,
    "reportId" UUID,
    "reportVersionId" UUID,
    "artifactId" UUID,
    "resultVersion" INTEGER NOT NULL,
    "result" JSONB NOT NULL,
    "requestId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AfterActionOperation_pkey" PRIMARY KEY ("operationId")
);

-- CreateTable
CREATE TABLE "AfterActionPdfArtifact" (
    "id" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "commandFingerprint" TEXT NOT NULL,
    "reportVersionId" UUID NOT NULL,
    "sourceContentSha256" TEXT NOT NULL,
    "rendererVersion" TEXT NOT NULL DEFAULT 'aar-pdf-v1',
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'application/pdf',
    "contentSizeBytes" BIGINT NOT NULL,
    "contentSha256" TEXT NOT NULL,
    "storageProvider" TEXT NOT NULL DEFAULT 'postgres',
    "storageKey" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generatedById" UUID NOT NULL,
    "requestId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Ready',

    CONSTRAINT "AfterActionPdfArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AfterActionReport_operationalId_key" ON "AfterActionReport"("operationalId");

-- CreateIndex
CREATE UNIQUE INDEX "AfterActionReport_sessionId_key" ON "AfterActionReport"("sessionId");

-- CreateIndex
CREATE INDEX "AfterActionReport_status_createdAt_id_idx" ON "AfterActionReport"("status", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AfterActionReportVersion_reportId_revision_key" ON "AfterActionReportVersion"("reportId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "AfterActionFinding_reportVersionId_sortOrder_key" ON "AfterActionFinding"("reportVersionId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "AfterActionLesson_reportVersionId_sortOrder_key" ON "AfterActionLesson"("reportVersionId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "AfterActionCorrectiveAction_reportVersionId_sortOrder_key" ON "AfterActionCorrectiveAction"("reportVersionId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "AfterActionPdfArtifact_operationId_key" ON "AfterActionPdfArtifact"("operationId");

-- CreateIndex
CREATE UNIQUE INDEX "AfterActionPdfArtifact_storageKey_key" ON "AfterActionPdfArtifact"("storageKey");

-- CreateIndex
CREATE INDEX "AfterActionPdfArtifact_reportVersionId_generatedAt_id_idx" ON "AfterActionPdfArtifact"("reportVersionId", "generatedAt", "id");

-- AddForeignKey
ALTER TABLE "AfterActionReport" ADD CONSTRAINT "AfterActionReport_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AfterActionReport" ADD CONSTRAINT "AfterActionReport_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AfterActionReport" ADD CONSTRAINT "AfterActionReport_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AfterActionReport" ADD CONSTRAINT "AfterActionReport_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AfterActionReport" ADD CONSTRAINT "AfterActionReport_archivedById_fkey" FOREIGN KEY ("archivedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AfterActionReportVersion" ADD CONSTRAINT "AfterActionReportVersion_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "AfterActionReport"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AfterActionReportVersion" ADD CONSTRAINT "AfterActionReportVersion_basedOnVersionId_fkey" FOREIGN KEY ("basedOnVersionId") REFERENCES "AfterActionReportVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AfterActionReportVersion" ADD CONSTRAINT "AfterActionReportVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AfterActionReportVersion" ADD CONSTRAINT "AfterActionReportVersion_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AfterActionReportVersion" ADD CONSTRAINT "AfterActionReportVersion_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AfterActionReportVersion" ADD CONSTRAINT "AfterActionReportVersion_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AfterActionFinding" ADD CONSTRAINT "AfterActionFinding_sourceObservationId_sourceObservationVe_fkey" FOREIGN KEY ("sourceObservationId", "sourceObservationVersion") REFERENCES "ExerciseObservationRevision"("observationId", "version") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AfterActionFinding" ADD CONSTRAINT "AfterActionFinding_reportVersionId_fkey" FOREIGN KEY ("reportVersionId") REFERENCES "AfterActionReportVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AfterActionLesson" ADD CONSTRAINT "AfterActionLesson_reportVersionId_fkey" FOREIGN KEY ("reportVersionId") REFERENCES "AfterActionReportVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AfterActionCorrectiveAction" ADD CONSTRAINT "AfterActionCorrectiveAction_reportVersionId_fkey" FOREIGN KEY ("reportVersionId") REFERENCES "AfterActionReportVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AfterActionOperation" ADD CONSTRAINT "AfterActionOperation_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "AfterActionReport"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AfterActionOperation" ADD CONSTRAINT "AfterActionOperation_reportVersionId_fkey" FOREIGN KEY ("reportVersionId") REFERENCES "AfterActionReportVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AfterActionOperation" ADD CONSTRAINT "AfterActionOperation_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "AfterActionPdfArtifact"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AfterActionPdfArtifact" ADD CONSTRAINT "AfterActionPdfArtifact_reportVersionId_fkey" FOREIGN KEY ("reportVersionId") REFERENCES "AfterActionReportVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AfterActionPdfArtifact" ADD CONSTRAINT "AfterActionPdfArtifact_generatedById_fkey" FOREIGN KEY ("generatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE UNIQUE INDEX "Aar_one_mutable_revision" ON "AfterActionReportVersion" ("reportId") WHERE "status" IN ('Draft','Under review');
ALTER TABLE "AfterActionReport" ADD CONSTRAINT "Aar_report_state" CHECK (
  "version" > 0 AND "operationalId" ~ '^AAR-[0-9]{4}-[0-9]{6,}$' AND
  (("status" = 'Active' AND "archivedAt" IS NULL AND "archivedById" IS NULL AND "archiveReason" IS NULL) OR
   ("status" = 'Archived' AND "archivedAt" IS NOT NULL AND "archivedById" IS NOT NULL AND "archiveReason" IS NOT NULL AND length(trim("archiveReason")) BETWEEN 1 AND 2000)));
ALTER TABLE "AfterActionReportVersion" ADD CONSTRAINT "Aar_version_state" CHECK (
  "version" > 0 AND "revision" > 0 AND "schemaVersion" = 'aar-v1'
  AND length(trim("title")) BETWEEN 1 AND 500 AND length("executiveSummary") <= 50000
  AND (("status" = 'Draft' AND "submittedAt" IS NULL AND "submittedById" IS NULL AND "approvedAt" IS NULL AND "approvedById" IS NULL AND "contentSha256" IS NULL)
    OR ("status" = 'Under review' AND "submittedAt" IS NOT NULL AND "submittedById" IS NOT NULL AND "approvedAt" IS NULL AND "approvedById" IS NULL AND "contentSha256" IS NULL)
    OR ("status" = 'Approved' AND "submittedAt" IS NOT NULL AND "submittedById" IS NOT NULL AND "approvedAt" IS NOT NULL AND "approvedById" IS NOT NULL AND "contentSha256" IS NOT NULL AND "contentSha256" ~ '^[0-9a-f]{64}$' AND length(trim("executiveSummary")) > 0)));
ALTER TABLE "AfterActionFinding" ADD CONSTRAINT "Aar_finding_bounds" CHECK (
  "sortOrder" BETWEEN 1 AND 100 AND length(trim("area")) BETWEEN 1 AND 200 AND length(trim("summary")) BETWEEN 1 AND 10000 AND length("detail") <= 10000
  AND (("sourceObservationId" IS NULL AND "sourceObservationVersion" IS NULL AND "sourceObservationOperationalId" IS NULL)
    OR ("sourceObservationId" IS NOT NULL AND "sourceObservationVersion" IS NOT NULL AND "sourceObservationVersion" > 0 AND "sourceObservationOperationalId" IS NOT NULL)));
ALTER TABLE "AfterActionLesson" ADD CONSTRAINT "Aar_lesson_bounds" CHECK ("sortOrder" BETWEEN 1 AND 100 AND length(trim("statement")) BETWEEN 1 AND 10000);
ALTER TABLE "AfterActionCorrectiveAction" ADD CONSTRAINT "Aar_action_bounds" CHECK ("sortOrder" BETWEEN 1 AND 100 AND length(trim("recommendation")) BETWEEN 1 AND 10000 AND length("owner") <= 200);
ALTER TABLE "AfterActionOperation" ADD CONSTRAINT "Aar_operation_integrity" CHECK ("resultVersion" > 0 AND "commandFingerprint" ~ '^[0-9a-f]{64}$' AND octet_length("result"::text) <= 4096);
ALTER TABLE "AfterActionPdfArtifact" ADD CONSTRAINT "Aar_pdf_integrity" CHECK (
  "commandFingerprint" ~ '^[0-9a-f]{64}$' AND "sourceContentSha256" ~ '^[0-9a-f]{64}$' AND "contentSha256" ~ '^[0-9a-f]{64}$'
  AND "rendererVersion" = 'aar-pdf-v1' AND "mimeType" = 'application/pdf' AND "status" = 'Ready' AND "storageProvider" = 'postgres'
  AND "storageKey" = 'aar-pdf/' || "id"::text AND "fileName" ~ '^[a-zA-Z0-9_-]+[.]pdf$'
  AND "contentSizeBytes" BETWEEN 1 AND 10485760 AND octet_length("content") = "contentSizeBytes");

CREATE FUNCTION aar_report_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE session_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'AAR history cannot be deleted'; END IF;
  SELECT "status" INTO session_status FROM "Session" WHERE "id" = NEW."sessionId" FOR UPDATE;
  IF session_status IS DISTINCT FROM 'Closed' THEN RAISE EXCEPTION 'AAR content requires Closed Session'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."status" = 'Archived' OR (NEW."id",NEW."sessionId",NEW."operationalId",NEW."ownerId",NEW."createdAt",NEW."createdById") IS DISTINCT FROM
      (OLD."id",OLD."sessionId",OLD."operationalId",OLD."ownerId",OLD."createdAt",OLD."createdById") THEN RAISE EXCEPTION 'AAR identity is immutable'; END IF;
    IF NEW."status" = 'Archived' AND EXISTS(SELECT 1 FROM "AfterActionReportVersion" WHERE "reportId"=NEW."id" AND "status" <> 'Approved') THEN RAISE EXCEPTION 'AAR has mutable revision'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Aar_report_guard" BEFORE INSERT OR UPDATE OR DELETE ON "AfterActionReport" FOR EACH ROW EXECUTE FUNCTION aar_report_guard();

CREATE FUNCTION aar_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sid uuid; session_status text; report_status text; base "AfterActionReportVersion"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'AAR versions cannot be deleted'; END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'Approved' THEN RAISE EXCEPTION 'Approved AAR is immutable'; END IF;
  SELECT "sessionId" INTO sid FROM "AfterActionReport" WHERE "id"=NEW."reportId";
  SELECT "status" INTO session_status FROM "Session" WHERE "id"=sid FOR UPDATE;
  SELECT "status" INTO report_status FROM "AfterActionReport" WHERE "id"=NEW."reportId" FOR UPDATE;
  IF session_status IS DISTINCT FROM 'Closed' OR report_status IS DISTINCT FROM 'Active' THEN RAISE EXCEPTION 'AAR is read only'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'Draft' THEN RAISE EXCEPTION 'AAR starts in Draft'; END IF;
    IF NEW."revision" <> COALESCE((SELECT max("revision") FROM "AfterActionReportVersion" WHERE "reportId"=NEW."reportId"),0)+1 THEN RAISE EXCEPTION 'Invalid AAR revision'; END IF;
    IF NEW."revision" = 1 AND NEW."basedOnVersionId" IS NOT NULL THEN RAISE EXCEPTION 'Invalid AAR base'; END IF;
    IF NEW."revision" > 1 THEN
      SELECT * INTO base FROM "AfterActionReportVersion" WHERE "id"=NEW."basedOnVersionId";
      IF base."reportId" IS DISTINCT FROM NEW."reportId" OR base."status" IS DISTINCT FROM 'Approved' OR base."revision" <> NEW."revision"-1 THEN RAISE EXCEPTION 'Invalid AAR base'; END IF;
    END IF;
  ELSE
    IF (NEW."id",NEW."reportId",NEW."revision",NEW."basedOnVersionId",NEW."createdAt",NEW."createdById") IS DISTINCT FROM
       (OLD."id",OLD."reportId",OLD."revision",OLD."basedOnVersionId",OLD."createdAt",OLD."createdById") THEN RAISE EXCEPTION 'AAR version identity is immutable'; END IF;
    IF NOT ((OLD."status"='Draft' AND NEW."status" IN ('Draft','Under review')) OR (OLD."status"='Under review' AND NEW."status" IN ('Draft','Approved'))) THEN RAISE EXCEPTION 'Invalid AAR transition'; END IF;
    IF OLD."status"='Under review' AND (NEW."title",NEW."eventDate",NEW."executiveSummary") IS DISTINCT FROM (OLD."title",OLD."eventDate",OLD."executiveSummary") THEN RAISE EXCEPTION 'Review content is locked'; END IF;
    IF NEW."status"='Approved' AND NOT EXISTS(SELECT 1 FROM "AfterActionFinding" WHERE "reportVersionId"=NEW."id") AND NOT EXISTS(SELECT 1 FROM "AfterActionLesson" WHERE "reportVersionId"=NEW."id") THEN RAISE EXCEPTION 'AAR needs evidence'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Aar_version_guard" BEFORE INSERT OR UPDATE OR DELETE ON "AfterActionReportVersion" FOR EACH ROW EXECUTE FUNCTION aar_version_guard();

CREATE FUNCTION aar_section_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE vid uuid; parent_status text; sid uuid; session_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."reportVersionId" <> OLD."reportVersionId" THEN RAISE EXCEPTION 'Cannot reparent AAR section'; END IF;
  IF TG_OP = 'DELETE' THEN vid := OLD."reportVersionId"; ELSE vid := NEW."reportVersionId"; END IF;
  SELECT r."sessionId" INTO sid FROM "AfterActionReportVersion" v JOIN "AfterActionReport" r ON r."id"=v."reportId" WHERE v."id"=vid;
  SELECT "status" INTO session_status FROM "Session" WHERE "id"=sid FOR UPDATE;
  PERFORM r."id" FROM "AfterActionReport" r JOIN "AfterActionReportVersion" v ON v."reportId"=r."id" WHERE v."id"=vid FOR UPDATE OF r;
  SELECT "status" INTO parent_status FROM "AfterActionReportVersion" WHERE "id"=vid FOR UPDATE;
  IF parent_status IS DISTINCT FROM 'Draft' OR session_status IS DISTINCT FROM 'Closed' THEN RAISE EXCEPTION 'AAR sections are immutable'; END IF;
  IF TG_TABLE_NAME = 'AfterActionFinding' AND TG_OP <> 'DELETE' THEN
    IF NEW."sourceObservationId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "ExerciseObservation" WHERE "id"=NEW."sourceObservationId" AND "sessionId"=sid) THEN RAISE EXCEPTION 'Cross Session observation'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Aar_finding_guard" BEFORE INSERT OR UPDATE OR DELETE ON "AfterActionFinding" FOR EACH ROW EXECUTE FUNCTION aar_section_guard();
CREATE TRIGGER "Aar_lesson_guard" BEFORE INSERT OR UPDATE OR DELETE ON "AfterActionLesson" FOR EACH ROW EXECUTE FUNCTION aar_section_guard();
CREATE TRIGGER "Aar_action_guard" BEFORE INSERT OR UPDATE OR DELETE ON "AfterActionCorrectiveAction" FOR EACH ROW EXECUTE FUNCTION aar_section_guard();

CREATE FUNCTION aar_artifact_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'AAR artifact is immutable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM "AfterActionReportVersion" WHERE "id"=NEW."reportVersionId" AND "status"='Approved' AND "contentSha256"=NEW."sourceContentSha256") THEN RAISE EXCEPTION 'Invalid artifact source'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Aar_artifact_guard" BEFORE INSERT OR UPDATE OR DELETE ON "AfterActionPdfArtifact" FOR EACH ROW EXECUTE FUNCTION aar_artifact_guard();
CREATE FUNCTION aar_operation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'AAR operation is immutable'; END $$;
CREATE TRIGGER "Aar_operation_guard" BEFORE UPDATE OR DELETE ON "AfterActionOperation" FOR EACH ROW EXECUTE FUNCTION aar_operation_guard();

-- Preserve custom roles and add no default content access for System Admin.
UPDATE "Role" SET "permissions" = "permissions"::jsonb || '["aar:read","aar:create","aar:update-draft","aar:review","aar:approve","aar:archive","aar:pdf:generate"]'::jsonb
WHERE "normalizedName" IN ('zpp-coordinator','tec-coordinator') AND "custom" = false;
