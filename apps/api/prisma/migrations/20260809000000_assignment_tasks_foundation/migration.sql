CREATE SEQUENCE "AssignmentTask_operational_seq" START 1;

DO $$
DECLARE
  current_max BIGINT;
BEGIN
  SELECT COALESCE(MAX((regexp_match("operationalId", '([0-9]+)$'))[1]::BIGINT), 0)
  INTO current_max
  FROM "AssignmentTask";
  IF current_max > 0 THEN
    PERFORM setval('"AssignmentTask_operational_seq"', current_max, true);
  END IF;
END $$;

ALTER TABLE "AssignmentTask"
  ADD COLUMN "legacyAssigneeLabel" TEXT,
  ADD COLUMN "completedById" UUID,
  ADD COLUMN "completedAt" TIMESTAMP(3),
  ADD COLUMN "completionNote" TEXT,
  ADD COLUMN "cancelledById" UUID,
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "cancelReason" TEXT,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "legacyImported" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "legacyMetadata" JSONB;

UPDATE "AssignmentTask"
SET
  "legacyImported" = true,
  "legacyMetadata" = jsonb_strip_nulls(jsonb_build_object(
    'transitionHistoryUnavailable', true,
    'historicalStatus', CASE WHEN "status" NOT IN ('Open', 'In Progress', 'Escalated', 'Completed', 'Cancelled') THEN "status" END,
    'historicalPriority', CASE WHEN "priority" NOT IN ('Normal', 'Urgent', 'Critical') THEN "priority" END,
    'terminalTimestampDerivedFromUpdatedAt', CASE WHEN "status" IN ('Completed', 'Cancelled') THEN true END
  )),
  "completedAt" = CASE WHEN "status" = 'Completed' THEN "updatedAt" ELSE NULL END,
  "cancelledAt" = CASE WHEN "status" = 'Cancelled' THEN "updatedAt" ELSE NULL END;

WITH labels AS (
  SELECT assignment."id", COALESCE(NULLIF(BTRIM(assignment."assignedUserDisplayName"), ''), NULLIF(BTRIM(assignment."ownerAssignedTo"), '')) AS label
  FROM "AssignmentTask" assignment
  WHERE assignment."assignedUserId" IS NULL
), unique_users AS (
  SELECT labels."id" AS assignment_id, MIN(users."id"::TEXT)::UUID AS user_id
  FROM labels
  JOIN "User" users ON users."displayName" = labels.label AND users."status" IN ('active', 'Active')
  WHERE labels.label IS NOT NULL
  GROUP BY labels."id"
  HAVING COUNT(*) = 1
)
UPDATE "AssignmentTask" assignment
SET "assignedUserId" = unique_users.user_id
FROM unique_users
WHERE assignment."id" = unique_users.assignment_id;

UPDATE "AssignmentTask"
SET "legacyAssigneeLabel" = COALESCE(NULLIF(BTRIM("assignedUserDisplayName"), ''), NULLIF(BTRIM("ownerAssignedTo"), ''))
WHERE "assignedUserId" IS NULL
  AND COALESCE(NULLIF(BTRIM("assignedUserDisplayName"), ''), NULLIF(BTRIM("ownerAssignedTo"), '')) IS NOT NULL;

UPDATE "AssignmentTask"
SET
  "status" = CASE WHEN "status" IN ('Open', 'In Progress', 'Escalated', 'Completed', 'Cancelled') THEN "status" ELSE 'Open' END,
  "priority" = CASE WHEN "priority" IN ('Normal', 'Urgent', 'Critical') THEN "priority" ELSE 'Normal' END;

DROP INDEX IF EXISTS "AssignmentTask_sessionId_status_idx";
DROP INDEX IF EXISTS "AssignmentTask_ownerAssignedTo_idx";
DROP INDEX IF EXISTS "AssignmentTask_assignedUserId_idx";

ALTER TABLE "AssignmentTask"
  DROP COLUMN "ownerAssignedTo",
  DROP COLUMN "assignedUserDisplayName";

ALTER TABLE "AssignmentTask"
  ADD CONSTRAINT "AssignmentTask_version_check" CHECK ("version" > 0),
  ADD CONSTRAINT "AssignmentTask_status_check" CHECK ("status" IN ('Open', 'In Progress', 'Escalated', 'Completed', 'Cancelled')),
  ADD CONSTRAINT "AssignmentTask_priority_check" CHECK ("priority" IN ('Normal', 'Urgent', 'Critical')),
  ADD CONSTRAINT "AssignmentTask_completed_check" CHECK (
    "status" <> 'Completed' OR "legacyImported" OR ("completedAt" IS NOT NULL AND "completedById" IS NOT NULL)
  ),
  ADD CONSTRAINT "AssignmentTask_cancelled_check" CHECK (
    "status" <> 'Cancelled' OR "legacyImported" OR ("cancelledAt" IS NOT NULL AND "cancelledById" IS NOT NULL AND NULLIF(BTRIM("cancelReason"), '') IS NOT NULL)
  );

ALTER TABLE "AssignmentTask"
  DROP CONSTRAINT "AssignmentTask_assignedUserId_fkey",
  ADD CONSTRAINT "AssignmentTask_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "AssignmentTask_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "AssignmentTask_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "AssignmentTask_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "AssignmentTask_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "AssignmentTask_sessionId_status_updatedAt_idx" ON "AssignmentTask"("sessionId", "status", "updatedAt" DESC);
CREATE INDEX "AssignmentTask_sessionId_assignedUserId_status_idx" ON "AssignmentTask"("sessionId", "assignedUserId", "status");
CREATE INDEX "AssignmentTask_sessionId_priority_status_idx" ON "AssignmentTask"("sessionId", "priority", "status");
CREATE INDEX "AssignmentTask_sessionId_dueAt_idx" ON "AssignmentTask"("sessionId", "dueAt");
CREATE INDEX "AssignmentTask_sessionId_relatedFunction_idx" ON "AssignmentTask"("sessionId", "relatedFunction");

CREATE TABLE "AssignmentOperation" (
  "id" UUID NOT NULL,
  "incidentId" UUID NOT NULL,
  "assignmentTaskId" UUID NOT NULL,
  "operationId" UUID NOT NULL,
  "command" TEXT NOT NULL,
  "commandFingerprint" TEXT NOT NULL,
  "resultVersion" INTEGER NOT NULL,
  "requestId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssignmentOperation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AssignmentOperation_resultVersion_check" CHECK ("resultVersion" > 0),
  CONSTRAINT "AssignmentOperation_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AssignmentOperation_assignmentTaskId_fkey" FOREIGN KEY ("assignmentTaskId") REFERENCES "AssignmentTask"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "AssignmentOperation_incidentId_operationId_key" ON "AssignmentOperation"("incidentId", "operationId");
CREATE INDEX "AssignmentOperation_assignmentTaskId_createdAt_idx" ON "AssignmentOperation"("assignmentTaskId", "createdAt");

CREATE FUNCTION "enforce_assignment_operation_incident"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "AssignmentTask"
    WHERE "id" = NEW."assignmentTaskId" AND "sessionId" = NEW."incidentId"
  ) THEN
    RAISE EXCEPTION 'AssignmentOperation and AssignmentTask must belong to the same incident';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AssignmentOperation_same_incident"
BEFORE INSERT OR UPDATE ON "AssignmentOperation"
FOR EACH ROW EXECUTE FUNCTION "enforce_assignment_operation_incident"();
