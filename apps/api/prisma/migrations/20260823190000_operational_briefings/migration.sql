CREATE TABLE "OperationalBriefing" (
    "id" TEXT NOT NULL,
    "sessionId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "situationSummary" TEXT NOT NULL DEFAULT '',
    "overview" TEXT NOT NULL DEFAULT '',
    "nextUpdateDueAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" UUID NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "publishedById" UUID,
    "supersededAt" TIMESTAMP(3),
    CONSTRAINT "OperationalBriefing_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OperationalBriefing_revision_positive" CHECK ("revision" > 0),
    CONSTRAINT "OperationalBriefing_version_positive" CHECK ("version" > 0),
    CONSTRAINT "OperationalBriefing_status_valid" CHECK ("status" IN ('Draft', 'Published', 'Superseded')),
    CONSTRAINT "OperationalBriefing_publication_state_valid" CHECK (
      ("status" = 'Draft' AND "publishedAt" IS NULL AND "publishedById" IS NULL AND "supersededAt" IS NULL) OR
      ("status" = 'Published' AND "publishedAt" IS NOT NULL AND "publishedById" IS NOT NULL AND "supersededAt" IS NULL) OR
      ("status" = 'Superseded' AND "publishedAt" IS NOT NULL AND "publishedById" IS NOT NULL AND "supersededAt" IS NOT NULL)
    )
);

CREATE TABLE "OperationalBriefingFact" (
    "id" TEXT NOT NULL,
    "briefingId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "statement" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceResourceType" TEXT,
    "sourceResourceId" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID NOT NULL,
    CONSTRAINT "OperationalBriefingFact_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OperationalBriefingFact_sort_positive" CHECK ("sortOrder" > 0)
);

CREATE TABLE "OperationalBriefingUnconfirmedItem" (
    "id" TEXT NOT NULL,
    "briefingId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "statement" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "verificationStatus" TEXT NOT NULL,
    "owner" TEXT,
    "reviewDueAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID NOT NULL,
    CONSTRAINT "OperationalBriefingUnconfirmedItem_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OperationalBriefingUnconfirmedItem_sort_positive" CHECK ("sortOrder" > 0)
);

CREATE TABLE "OperationalBriefingPriority" (
    "id" TEXT NOT NULL,
    "briefingId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "responsible" TEXT,
    "linkedAssignmentId" UUID,
    "dueAt" TIMESTAMP(3),
    CONSTRAINT "OperationalBriefingPriority_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OperationalBriefingPriority_sort_positive" CHECK ("sortOrder" > 0),
    CONSTRAINT "OperationalBriefingPriority_status_valid" CHECK ("status" IN ('Not started', 'In progress', 'Completed', 'Blocked'))
);

CREATE TABLE "OperationalBriefingRisk" (
    "id" TEXT NOT NULL,
    "briefingId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "owner" TEXT,
    "mitigation" TEXT,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OperationalBriefingRisk_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OperationalBriefingRisk_sort_positive" CHECK ("sortOrder" > 0),
    CONSTRAINT "OperationalBriefingRisk_severity_valid" CHECK ("severity" IN ('Information', 'Attention', 'Critical'))
);

CREATE TABLE "OperationalBriefingCoordinationNote" (
    "id" TEXT NOT NULL,
    "briefingId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "note" TEXT NOT NULL,
    "functionName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID NOT NULL,
    CONSTRAINT "OperationalBriefingCoordinationNote_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OperationalBriefingCoordinationNote_sort_positive" CHECK ("sortOrder" > 0)
);

CREATE UNIQUE INDEX "OperationalBriefing_sessionId_revision_key" ON "OperationalBriefing"("sessionId", "revision");
CREATE UNIQUE INDEX "OperationalBriefing_one_draft_per_session" ON "OperationalBriefing"("sessionId") WHERE "status" = 'Draft';
CREATE UNIQUE INDEX "OperationalBriefing_one_published_per_session" ON "OperationalBriefing"("sessionId") WHERE "status" = 'Published';
CREATE INDEX "OperationalBriefing_sessionId_status_revision_idx" ON "OperationalBriefing"("sessionId", "status", "revision" DESC);
CREATE INDEX "OperationalBriefing_updatedAt_idx" ON "OperationalBriefing"("updatedAt");
CREATE UNIQUE INDEX "OperationalBriefingFact_briefingId_id_key" ON "OperationalBriefingFact"("briefingId", "id");
CREATE INDEX "OperationalBriefingFact_briefingId_sortOrder_idx" ON "OperationalBriefingFact"("briefingId", "sortOrder");
CREATE UNIQUE INDEX "OperationalBriefingUnconfirmedItem_briefingId_id_key" ON "OperationalBriefingUnconfirmedItem"("briefingId", "id");
CREATE INDEX "OperationalBriefingUnconfirmedItem_briefingId_sortOrder_idx" ON "OperationalBriefingUnconfirmedItem"("briefingId", "sortOrder");
CREATE UNIQUE INDEX "OperationalBriefingPriority_briefingId_id_key" ON "OperationalBriefingPriority"("briefingId", "id");
CREATE INDEX "OperationalBriefingPriority_briefingId_sortOrder_idx" ON "OperationalBriefingPriority"("briefingId", "sortOrder");
CREATE INDEX "OperationalBriefingPriority_linkedAssignmentId_idx" ON "OperationalBriefingPriority"("linkedAssignmentId");
CREATE UNIQUE INDEX "OperationalBriefingRisk_briefingId_id_key" ON "OperationalBriefingRisk"("briefingId", "id");
CREATE INDEX "OperationalBriefingRisk_briefingId_sortOrder_idx" ON "OperationalBriefingRisk"("briefingId", "sortOrder");
CREATE UNIQUE INDEX "OperationalBriefingCoordinationNote_briefingId_id_key" ON "OperationalBriefingCoordinationNote"("briefingId", "id");
CREATE INDEX "OperationalBriefingCoordinationNote_briefingId_sortOrder_idx" ON "OperationalBriefingCoordinationNote"("briefingId", "sortOrder");

ALTER TABLE "OperationalBriefing" ADD CONSTRAINT "OperationalBriefing_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OperationalBriefing" ADD CONSTRAINT "OperationalBriefing_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OperationalBriefing" ADD CONSTRAINT "OperationalBriefing_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OperationalBriefing" ADD CONSTRAINT "OperationalBriefing_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OperationalBriefingFact" ADD CONSTRAINT "OperationalBriefingFact_briefingId_fkey" FOREIGN KEY ("briefingId") REFERENCES "OperationalBriefing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OperationalBriefingFact" ADD CONSTRAINT "OperationalBriefingFact_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OperationalBriefingUnconfirmedItem" ADD CONSTRAINT "OperationalBriefingUnconfirmedItem_briefingId_fkey" FOREIGN KEY ("briefingId") REFERENCES "OperationalBriefing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OperationalBriefingUnconfirmedItem" ADD CONSTRAINT "OperationalBriefingUnconfirmedItem_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OperationalBriefingPriority" ADD CONSTRAINT "OperationalBriefingPriority_briefingId_fkey" FOREIGN KEY ("briefingId") REFERENCES "OperationalBriefing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OperationalBriefingPriority" ADD CONSTRAINT "OperationalBriefingPriority_linkedAssignmentId_fkey" FOREIGN KEY ("linkedAssignmentId") REFERENCES "AssignmentTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OperationalBriefingRisk" ADD CONSTRAINT "OperationalBriefingRisk_briefingId_fkey" FOREIGN KEY ("briefingId") REFERENCES "OperationalBriefing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OperationalBriefingCoordinationNote" ADD CONSTRAINT "OperationalBriefingCoordinationNote_briefingId_fkey" FOREIGN KEY ("briefingId") REFERENCES "OperationalBriefing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OperationalBriefingCoordinationNote" ADD CONSTRAINT "OperationalBriefingCoordinationNote_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
