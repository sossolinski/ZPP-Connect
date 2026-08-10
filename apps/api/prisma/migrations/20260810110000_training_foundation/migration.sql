CREATE SEQUENCE "TrainingCourse_id_seq" START 7;
CREATE SEQUENCE "TrainingRequirement_id_seq" START 5;
CREATE SEQUENCE "MemberTrainingRecord_id_seq" START 7;

CREATE TABLE "TrainingCourse" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "normalizedCode" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "category" TEXT NOT NULL,
  "deliveryType" TEXT NOT NULL,
  "validityMonths" INTEGER,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "selfCompletable" BOOLEAN NOT NULL DEFAULT false,
  "externalRef" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "deactivatedAt" TIMESTAMP(3),
  "reactivatedAt" TIMESTAMP(3),
  "legacyImported" BOOLEAN NOT NULL DEFAULT false,
  "legacyMetadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById" UUID,
  "updatedById" UUID,
  CONSTRAINT "TrainingCourse_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TrainingCourse_version_check" CHECK ("version" > 0),
  CONSTRAINT "TrainingCourse_validity_check" CHECK ("validityMonths" IS NULL OR "validityMonths" > 0),
  CONSTRAINT "TrainingCourse_delivery_check" CHECK ("deliveryType" IN ('Classroom', 'E-learning', 'Briefing', 'Exercise', 'Practical', 'Other'))
);

CREATE UNIQUE INDEX "TrainingCourse_normalizedCode_key" ON "TrainingCourse"("normalizedCode");
CREATE INDEX "TrainingCourse_active_category_title_idx" ON "TrainingCourse"("active", "category", "title");
CREATE INDEX "TrainingCourse_updatedAt_idx" ON "TrainingCourse"("updatedAt");

CREATE TABLE "TrainingRequirement" (
  "id" TEXT NOT NULL,
  "courseId" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetRole" TEXT,
  "groupId" TEXT,
  "memberProfileId" TEXT,
  "requiredStatus" TEXT NOT NULL,
  "dueAt" TIMESTAMP(3),
  "effectiveFrom" TIMESTAMP(3),
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
  CONSTRAINT "TrainingRequirement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TrainingRequirement_id_course_key" UNIQUE ("id", "courseId"),
  CONSTRAINT "TrainingRequirement_version_check" CHECK ("version" > 0),
  CONSTRAINT "TrainingRequirement_status_check" CHECK ("requiredStatus" IN ('Required', 'Recommended')),
  CONSTRAINT "TrainingRequirement_dates_check" CHECK ("effectiveTo" IS NULL OR "effectiveFrom" IS NULL OR "effectiveTo" > "effectiveFrom"),
  CONSTRAINT "TrainingRequirement_active_end_check" CHECK (("active" AND "effectiveTo" IS NULL AND "endedAt" IS NULL AND "endedById" IS NULL) OR (NOT "active" AND "effectiveTo" IS NOT NULL)),
  CONSTRAINT "TrainingRequirement_target_check" CHECK (
    ("targetType" = 'Role' AND "targetRole" IS NOT NULL AND "groupId" IS NULL AND "memberProfileId" IS NULL) OR
    ("targetType" = 'Group' AND "targetRole" IS NULL AND "groupId" IS NOT NULL AND "memberProfileId" IS NULL) OR
    ("targetType" = 'MemberProfile' AND "targetRole" IS NULL AND "groupId" IS NULL AND "memberProfileId" IS NOT NULL)
  )
);

CREATE INDEX "TrainingRequirement_course_active_effective_idx" ON "TrainingRequirement"("courseId", "active", "effectiveFrom", "effectiveTo");
CREATE INDEX "TrainingRequirement_role_active_idx" ON "TrainingRequirement"("targetType", "targetRole", "active");
CREATE INDEX "TrainingRequirement_group_active_idx" ON "TrainingRequirement"("groupId", "active");
CREATE INDEX "TrainingRequirement_member_active_idx" ON "TrainingRequirement"("memberProfileId", "active");
CREATE UNIQUE INDEX "TrainingRequirement_active_target_key" ON "TrainingRequirement" (
  "courseId", "targetType", COALESCE("targetRole", ''), COALESCE("groupId", ''), COALESCE("memberProfileId", '')
) WHERE "active" = true;

CREATE TABLE "MemberTrainingRecord" (
  "id" TEXT NOT NULL,
  "operationalId" TEXT NOT NULL,
  "memberProfileId" TEXT NOT NULL,
  "courseId" TEXT NOT NULL,
  "sourceRequirementId" TEXT,
  "assignedAt" TIMESTAMP(3) NOT NULL,
  "assignedById" UUID,
  "dueAt" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'Assigned',
  "startedAt" TIMESTAMP(3),
  "startedById" UUID,
  "completedAt" TIMESTAMP(3),
  "completedById" UUID,
  "expiryAt" TIMESTAMP(3),
  "score" INTEGER,
  "completionNote" TEXT,
  "completionRef" TEXT,
  "verifiedById" UUID,
  "verifiedAt" TIMESTAMP(3),
  "waivedAt" TIMESTAMP(3),
  "waivedById" UUID,
  "waiverReason" TEXT,
  "cancelledAt" TIMESTAMP(3),
  "cancelledById" UUID,
  "cancelledReason" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "provenance" JSONB,
  "legacyImported" BOOLEAN NOT NULL DEFAULT false,
  "legacyMetadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById" UUID,
  "updatedById" UUID,
  CONSTRAINT "MemberTrainingRecord_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MemberTrainingRecord_status_check" CHECK ("status" IN ('Assigned', 'In Progress', 'Completed', 'Waived', 'Cancelled')),
  CONSTRAINT "MemberTrainingRecord_version_check" CHECK ("version" > 0),
  CONSTRAINT "MemberTrainingRecord_score_check" CHECK ("score" IS NULL OR ("score" >= 0 AND "score" <= 100)),
  CONSTRAINT "MemberTrainingRecord_started_pair_check" CHECK (("startedAt" IS NULL) = ("startedById" IS NULL) OR "legacyImported"),
  CONSTRAINT "MemberTrainingRecord_verified_pair_check" CHECK (("verifiedAt" IS NULL) = ("verifiedById" IS NULL)),
  CONSTRAINT "MemberTrainingRecord_verified_status_check" CHECK ("verifiedAt" IS NULL OR "status" = 'Completed'),
  CONSTRAINT "MemberTrainingRecord_completion_check" CHECK ("status" <> 'Completed' OR ("completedAt" IS NOT NULL AND ("completedById" IS NOT NULL OR "legacyImported"))),
  CONSTRAINT "MemberTrainingRecord_waiver_check" CHECK ("status" <> 'Waived' OR ("waivedAt" IS NOT NULL AND "waiverReason" IS NOT NULL AND ("waivedById" IS NOT NULL OR "legacyImported"))),
  CONSTRAINT "MemberTrainingRecord_cancel_check" CHECK ("status" <> 'Cancelled' OR ("cancelledAt" IS NOT NULL AND "cancelledReason" IS NOT NULL AND ("cancelledById" IS NOT NULL OR "legacyImported")))
);

CREATE UNIQUE INDEX "MemberTrainingRecord_operationalId_key" ON "MemberTrainingRecord"("operationalId");
CREATE UNIQUE INDEX "MemberTrainingRecord_active_member_course_key" ON "MemberTrainingRecord"("memberProfileId", "courseId") WHERE "status" IN ('Assigned', 'In Progress');
CREATE INDEX "MemberTrainingRecord_member_course_status_idx" ON "MemberTrainingRecord"("memberProfileId", "courseId", "status");
CREATE INDEX "MemberTrainingRecord_course_status_due_idx" ON "MemberTrainingRecord"("courseId", "status", "dueAt");
CREATE INDEX "MemberTrainingRecord_sourceRequirementId_idx" ON "MemberTrainingRecord"("sourceRequirementId");
CREATE INDEX "MemberTrainingRecord_expiryAt_idx" ON "MemberTrainingRecord"("expiryAt");

CREATE TABLE "TrainingOperation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "operationId" UUID NOT NULL,
  "memberTrainingId" TEXT,
  "command" TEXT NOT NULL,
  "commandFingerprint" TEXT NOT NULL,
  "resultVersion" INTEGER NOT NULL,
  "result" JSONB NOT NULL,
  "requestId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TrainingOperation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TrainingOperation_result_version_check" CHECK ("resultVersion" > 0)
);

CREATE UNIQUE INDEX "TrainingOperation_operationId_key" ON "TrainingOperation"("operationId");
CREATE INDEX "TrainingOperation_memberTrainingId_createdAt_idx" ON "TrainingOperation"("memberTrainingId", "createdAt");

ALTER TABLE "TrainingRequirement" ADD CONSTRAINT "TrainingRequirement_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "TrainingCourse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TrainingRequirement" ADD CONSTRAINT "TrainingRequirement_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "OperationalGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TrainingRequirement" ADD CONSTRAINT "TrainingRequirement_memberProfileId_fkey" FOREIGN KEY ("memberProfileId") REFERENCES "MemberProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MemberTrainingRecord" ADD CONSTRAINT "MemberTrainingRecord_memberProfileId_fkey" FOREIGN KEY ("memberProfileId") REFERENCES "MemberProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MemberTrainingRecord" ADD CONSTRAINT "MemberTrainingRecord_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "TrainingCourse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MemberTrainingRecord" ADD CONSTRAINT "MemberTrainingRecord_sourceRequirement_course_fkey" FOREIGN KEY ("sourceRequirementId", "courseId") REFERENCES "TrainingRequirement"("id", "courseId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MemberTrainingRecord" ADD CONSTRAINT "MemberTrainingRecord_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TrainingOperation" ADD CONSTRAINT "TrainingOperation_memberTrainingId_fkey" FOREIGN KEY ("memberTrainingId") REFERENCES "MemberTrainingRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
