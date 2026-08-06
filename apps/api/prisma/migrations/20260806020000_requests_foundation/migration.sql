ALTER TABLE "WelfareRequest"
  ADD COLUMN "relatedReleaseActionId" UUID,
  ADD COLUMN "ownerUserId" UUID,
  ADD COLUMN "dueAt" TIMESTAMP(3),
  ADD COLUMN "resolutionOutcome" TEXT,
  ADD COLUMN "resolvedById" UUID,
  ADD COLUMN "resolvedAt" TIMESTAMP(3),
  ADD COLUMN "reopenedById" UUID,
  ADD COLUMN "reopenedAt" TIMESTAMP(3),
  ADD COLUMN "reopenReason" TEXT,
  ADD COLUMN "cancelledById" UUID,
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "cancelReason" TEXT,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "legacyImported" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "legacyMetadata" JSONB;

WITH unique_owner AS (
  SELECT "displayName", MIN("id") AS "id"
  FROM "User"
  GROUP BY "displayName"
  HAVING COUNT(*) = 1
)
UPDATE "WelfareRequest" request
SET
  "ownerUserId" = owner_match."id",
  "resolvedAt" = CASE WHEN request."status" IN ('Done', 'Closed', 'Completed') THEN request."updatedAt" ELSE NULL END,
  "cancelledAt" = CASE WHEN request."status" = 'Cancelled' THEN request."updatedAt" ELSE NULL END,
  "cancelReason" = CASE WHEN request."status" = 'Cancelled' THEN request."closureNote" ELSE NULL END,
  "legacyImported" = true,
  "legacyMetadata" = jsonb_build_object(
    'sourceModel', 'WelfareRequest',
    'legacyStatus', request."status",
    'legacyPriority', request."priority",
    'legacyOwnerLabel', request."ownerAssignedTo",
    'legacyRelatedEnquiryId', request."relatedEnquiryId",
    'legacyRelatedFamilyRecordId', request."relatedFamilyRecordId",
    'legacyRelatedPassengerRecordId', request."relatedPassengerRecordId",
    'legacyCreatedById', request."createdById",
    'legacyUpdatedById', request."updatedById",
    'ownerResolvedByUniqueDisplayName', owner_match."id" IS NOT NULL,
    'transitionHistoryUnavailable', true
  )
FROM unique_owner owner_match
WHERE owner_match."displayName" = request."ownerAssignedTo";

-- Rows without an owner label do not participate in the lateral match above.
UPDATE "WelfareRequest" request
SET
  "resolvedAt" = CASE WHEN request."status" IN ('Done', 'Closed', 'Completed') THEN request."updatedAt" ELSE NULL END,
  "cancelledAt" = CASE WHEN request."status" = 'Cancelled' THEN request."updatedAt" ELSE NULL END,
  "cancelReason" = CASE WHEN request."status" = 'Cancelled' THEN request."closureNote" ELSE NULL END,
  "legacyImported" = true,
  "legacyMetadata" = jsonb_build_object(
    'sourceModel', 'WelfareRequest',
    'legacyStatus', request."status",
    'legacyPriority', request."priority",
    'legacyOwnerLabel', request."ownerAssignedTo",
    'legacyRelatedEnquiryId', request."relatedEnquiryId",
    'legacyRelatedFamilyRecordId', request."relatedFamilyRecordId",
    'legacyRelatedPassengerRecordId', request."relatedPassengerRecordId",
    'legacyCreatedById', request."createdById",
    'legacyUpdatedById', request."updatedById",
    'ownerResolvedByUniqueDisplayName', false,
    'transitionHistoryUnavailable', true
  )
WHERE request."legacyImported" = false;

UPDATE "WelfareRequest"
SET
  "status" = CASE
    WHEN "status" = 'Open' THEN 'OPEN'
    WHEN "status" = 'Assigned' THEN 'ASSIGNED'
    WHEN "status" = 'In progress' THEN 'IN_PROGRESS'
    WHEN "status" = 'Waiting' THEN 'WAITING'
    WHEN "status" IN ('Done', 'Closed', 'Completed') THEN 'RESOLVED'
    WHEN "status" = 'Cancelled' THEN 'CANCELLED'
    ELSE 'OPEN'
  END,
  "priority" = CASE WHEN "priority" IN ('Low', 'Normal', 'High', 'Urgent') THEN "priority" ELSE 'Normal' END;

UPDATE "WelfareRequest" request
SET "createdById" = NULL
WHERE request."createdById" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "User" actor WHERE actor."id" = request."createdById");
UPDATE "WelfareRequest" request
SET "updatedById" = NULL
WHERE request."updatedById" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "User" actor WHERE actor."id" = request."updatedById");

-- Existing foreign keys prove that a target exists, but the legacy schema did not
-- prove that it belonged to the same incident. Preserve the original IDs above and
-- remove only unsafe cross-incident links instead of presenting them as valid.
UPDATE "WelfareRequest" request
SET "relatedEnquiryId" = NULL,
    "legacyMetadata" = request."legacyMetadata" || jsonb_build_object('crossIncidentEnquiryLinkRemoved', true)
FROM "Enquiry" linked
WHERE linked."id" = request."relatedEnquiryId"
  AND linked."sessionId" <> request."sessionId";

UPDATE "WelfareRequest" request
SET "relatedFamilyRecordId" = NULL,
    "legacyMetadata" = request."legacyMetadata" || jsonb_build_object('crossIncidentFamilyLinkRemoved', true)
FROM "FamilyRecord" linked
WHERE linked."id" = request."relatedFamilyRecordId"
  AND linked."sessionId" <> request."sessionId";

UPDATE "WelfareRequest" request
SET "relatedPassengerRecordId" = NULL,
    "legacyMetadata" = request."legacyMetadata" || jsonb_build_object('crossIncidentPassengerLinkRemoved', true)
FROM "PassengerRecord" linked
WHERE linked."id" = request."relatedPassengerRecordId"
  AND linked."sessionId" <> request."sessionId";

DROP INDEX IF EXISTS "WelfareRequest_operationalId_key";
DROP INDEX IF EXISTS "WelfareRequest_sessionId_status_idx";

CREATE SEQUENCE "Request_operational_seq" START WITH 1;
SELECT setval(
  '"Request_operational_seq"',
  GREATEST(
    COALESCE((SELECT MAX((regexp_match("operationalId", '([0-9]+)$'))[1]::bigint) FROM "WelfareRequest"), 0),
    1
  ),
  EXISTS (SELECT 1 FROM "WelfareRequest")
);

CREATE TABLE "RequestOperation" (
  "id" UUID NOT NULL,
  "incidentId" UUID NOT NULL,
  "requestRecordId" UUID NOT NULL,
  "operationId" UUID NOT NULL,
  "command" TEXT NOT NULL,
  "commandFingerprint" TEXT NOT NULL,
  "resultVersion" INTEGER NOT NULL,
  "requestId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RequestOperation_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "WelfareRequest"
  ADD CONSTRAINT "WelfareRequest_version_check" CHECK ("version" > 0),
  ADD CONSTRAINT "WelfareRequest_status_check" CHECK ("status" IN ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'WAITING', 'RESOLVED', 'CANCELLED')),
  ADD CONSTRAINT "WelfareRequest_priority_check" CHECK ("priority" IN ('Low', 'Normal', 'High', 'Urgent')),
  ADD CONSTRAINT "WelfareRequest_terminal_state_check" CHECK (
    ("status" = 'RESOLVED' AND "resolvedAt" IS NOT NULL AND ("legacyImported" OR ("resolvedById" IS NOT NULL AND "resolutionOutcome" IS NOT NULL AND "closureNote" IS NOT NULL))) OR
    ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL AND ("legacyImported" OR ("cancelledById" IS NOT NULL AND "cancelReason" IS NOT NULL))) OR
    ("status" NOT IN ('RESOLVED', 'CANCELLED'))
  );

CREATE UNIQUE INDEX "WelfareRequest_sessionId_operationalId_key" ON "WelfareRequest"("sessionId", "operationalId");
CREATE INDEX "WelfareRequest_sessionId_status_updatedAt_idx" ON "WelfareRequest"("sessionId", "status", "updatedAt" DESC);
CREATE INDEX "WelfareRequest_sessionId_priority_status_idx" ON "WelfareRequest"("sessionId", "priority", "status");
CREATE INDEX "WelfareRequest_sessionId_ownerUserId_status_idx" ON "WelfareRequest"("sessionId", "ownerUserId", "status");
CREATE INDEX "WelfareRequest_sessionId_dueAt_idx" ON "WelfareRequest"("sessionId", "dueAt");
CREATE UNIQUE INDEX "RequestOperation_incidentId_operationId_key" ON "RequestOperation"("incidentId", "operationId");
CREATE INDEX "RequestOperation_requestRecordId_createdAt_idx" ON "RequestOperation"("requestRecordId", "createdAt");

ALTER TABLE "WelfareRequest" ADD CONSTRAINT "WelfareRequest_relatedReleaseActionId_fkey" FOREIGN KEY ("relatedReleaseActionId") REFERENCES "ReleaseAction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WelfareRequest" ADD CONSTRAINT "WelfareRequest_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WelfareRequest" ADD CONSTRAINT "WelfareRequest_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WelfareRequest" ADD CONSTRAINT "WelfareRequest_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WelfareRequest" ADD CONSTRAINT "WelfareRequest_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WelfareRequest" ADD CONSTRAINT "WelfareRequest_reopenedById_fkey" FOREIGN KEY ("reopenedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WelfareRequest" ADD CONSTRAINT "WelfareRequest_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RequestOperation" ADD CONSTRAINT "RequestOperation_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RequestOperation" ADD CONSTRAINT "RequestOperation_requestRecordId_fkey" FOREIGN KEY ("requestRecordId") REFERENCES "WelfareRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION enforce_request_incident() RETURNS trigger AS $$
DECLARE
  referenced_incident UUID;
BEGIN
  IF NEW."relatedEnquiryId" IS NOT NULL THEN
    SELECT "sessionId" INTO referenced_incident FROM "Enquiry" WHERE "id" = NEW."relatedEnquiryId";
    IF referenced_incident IS NULL OR referenced_incident <> NEW."sessionId" THEN
      RAISE EXCEPTION 'Request Enquiry must belong to the same incident' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."relatedFamilyRecordId" IS NOT NULL THEN
    SELECT "sessionId" INTO referenced_incident FROM "FamilyRecord" WHERE "id" = NEW."relatedFamilyRecordId";
    IF referenced_incident IS NULL OR referenced_incident <> NEW."sessionId" THEN
      RAISE EXCEPTION 'Request FamilyRecord must belong to the same incident' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."relatedPassengerRecordId" IS NOT NULL THEN
    SELECT "sessionId" INTO referenced_incident FROM "PassengerRecord" WHERE "id" = NEW."relatedPassengerRecordId";
    IF referenced_incident IS NULL OR referenced_incident <> NEW."sessionId" THEN
      RAISE EXCEPTION 'Request PassengerRecord must belong to the same incident' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."relatedReleaseActionId" IS NOT NULL THEN
    SELECT "incidentId" INTO referenced_incident FROM "ReleaseAction" WHERE "id" = NEW."relatedReleaseActionId";
    IF referenced_incident IS NULL OR referenced_incident <> NEW."sessionId" THEN
      RAISE EXCEPTION 'Request ReleaseAction must belong to the same incident' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "WelfareRequest_same_incident"
BEFORE INSERT OR UPDATE OF "sessionId", "relatedEnquiryId", "relatedFamilyRecordId", "relatedPassengerRecordId", "relatedReleaseActionId" ON "WelfareRequest"
FOR EACH ROW EXECUTE FUNCTION enforce_request_incident();

CREATE OR REPLACE FUNCTION enforce_request_operation_incident() RETURNS trigger AS $$
DECLARE
  request_incident UUID;
BEGIN
  SELECT "sessionId" INTO request_incident FROM "WelfareRequest" WHERE "id" = NEW."requestRecordId";
  IF request_incident IS NULL OR request_incident <> NEW."incidentId" THEN
    RAISE EXCEPTION 'RequestOperation must belong to the same incident as Request' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RequestOperation_same_incident"
BEFORE INSERT OR UPDATE ON "RequestOperation"
FOR EACH ROW EXECUTE FUNCTION enforce_request_operation_incident();
