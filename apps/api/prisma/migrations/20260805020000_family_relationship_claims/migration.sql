ALTER TABLE "FamilyRecord"
  ADD COLUMN "normalizedPhone" TEXT,
  ADD COLUMN "normalizedEmail" TEXT,
  ADD COLUMN "sourceBatchId" UUID,
  ADD COLUMN "sourceImportedAt" TIMESTAMP(3),
  ADD COLUMN "verificationDecisionById" UUID,
  ADD COLUMN "verificationDecisionAt" TIMESTAMP(3),
  ADD COLUMN "verifiedRelationship" TEXT,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

UPDATE "FamilyRecord"
SET
  "normalizedEmail" = CASE WHEN "email" IS NULL THEN NULL ELSE lower(trim("email")) END,
  "normalizedPhone" = CASE WHEN "phone" IS NULL THEN NULL ELSE regexp_replace(trim("phone"), '[^0-9+]', '', 'g') END;

CREATE SEQUENCE "FamilyRecord_operational_seq" START WITH 1;

SELECT setval(
  '"FamilyRecord_operational_seq"',
  GREATEST(
    COALESCE((
      SELECT max((regexp_match("operationalId", '^FAM-[0-9]{4}-([0-9]+)$'))[1]::bigint)
      FROM "FamilyRecord"
      WHERE "operationalId" ~ '^FAM-[0-9]{4}-[0-9]+$'
    ), 0),
    1
  ),
  EXISTS (SELECT 1 FROM "FamilyRecord")
);

CREATE TABLE "RelationshipClaim" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "incidentId" UUID NOT NULL,
  "familyRecordId" UUID NOT NULL,
  "passengerRecordId" UUID,
  "claimedRelationshipType" TEXT,
  "claimedPassengerFirstName" TEXT,
  "claimedPassengerLastName" TEXT,
  "claimedPassengerFlight" TEXT,
  "source" TEXT NOT NULL DEFAULT 'OPERATOR',
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "isCurrent" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "claimedById" UUID,
  "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "supersededAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RelationshipClaim_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RelationshipClaim_version_check" CHECK ("version" > 0),
  CONSTRAINT "RelationshipClaim_status_check" CHECK ("status" IN ('PENDING', 'VERIFIED', 'REJECTED', 'SUPERSEDED'))
);

CREATE TABLE "RelationshipVerificationDecision" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "incidentId" UUID NOT NULL,
  "relationshipClaimId" UUID NOT NULL,
  "result" TEXT NOT NULL,
  "basis" TEXT NOT NULL,
  "verifiedRelationshipType" TEXT,
  "previousStatus" TEXT NOT NULL,
  "nextStatus" TEXT NOT NULL,
  "claimVersionBefore" INTEGER NOT NULL,
  "claimVersionAfter" INTEGER NOT NULL,
  "decisionById" UUID,
  "decisionAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "requestId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RelationshipVerificationDecision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RelationshipVerificationDecision_result_check" CHECK ("result" IN ('VERIFIED', 'REJECTED', 'REOPENED')),
  CONSTRAINT "RelationshipVerificationDecision_versions_check" CHECK ("claimVersionBefore" > 0 AND "claimVersionAfter" > "claimVersionBefore")
);

INSERT INTO "RelationshipClaim" (
  "incidentId", "familyRecordId", "claimedRelationshipType", "claimedPassengerFirstName",
  "claimedPassengerLastName", "claimedPassengerFlight", "source", "status", "claimedById",
  "claimedAt", "createdAt", "updatedAt"
)
SELECT
  "sessionId", "id", "claimedRelationship", "passengerFirstName", "passengerLastName",
  "passengerFlight", 'LEGACY',
  CASE
    WHEN "verificationStatus" = 'Verified' THEN 'VERIFIED'
    WHEN "verificationStatus" = 'Disputed' THEN 'REJECTED'
    ELSE 'PENDING'
  END,
  COALESCE("updatedById", "createdById"), "createdAt", "createdAt", "updatedAt"
FROM "FamilyRecord";

INSERT INTO "RelationshipVerificationDecision" (
  "incidentId", "relationshipClaimId", "result", "basis", "verifiedRelationshipType",
  "previousStatus", "nextStatus", "claimVersionBefore", "claimVersionAfter",
  "decisionById", "decisionAt", "requestId"
)
SELECT
  claim."incidentId", claim."id",
  CASE WHEN family."verificationStatus" = 'Verified' THEN 'VERIFIED' ELSE 'REJECTED' END,
  COALESCE(NULLIF(trim(family."verificationNotes"), ''), 'Historical decision migrated from the legacy Family/NOK record.'),
  CASE WHEN family."verificationStatus" = 'Verified' THEN family."claimedRelationship" ELSE NULL END,
  'PENDING', claim."status", 1, 2, COALESCE(family."updatedById", family."createdById"),
  family."updatedAt", 'stage-4-backfill'
FROM "RelationshipClaim" claim
JOIN "FamilyRecord" family ON family."id" = claim."familyRecordId"
WHERE family."verificationStatus" IN ('Verified', 'Disputed');

UPDATE "RelationshipClaim" claim
SET "version" = 2
FROM "FamilyRecord" family
WHERE family."id" = claim."familyRecordId"
  AND family."verificationStatus" IN ('Verified', 'Disputed');

UPDATE "FamilyRecord"
SET
  "verificationStatus" = CASE
    WHEN "verificationStatus" = 'Partially verified' THEN 'Review required'
    WHEN "verificationStatus" = 'Disputed' THEN 'Rejected'
    ELSE "verificationStatus"
  END,
  "verificationDecisionAt" = CASE WHEN "verificationStatus" IN ('Verified', 'Disputed') THEN "updatedAt" ELSE NULL END,
  "verificationDecisionById" = CASE WHEN "verificationStatus" IN ('Verified', 'Disputed') THEN COALESCE("updatedById", "createdById") ELSE NULL END,
  "verifiedRelationship" = CASE WHEN "verificationStatus" = 'Verified' THEN "claimedRelationship" ELSE NULL END;

ALTER TABLE "FamilyRecord"
  ADD CONSTRAINT "FamilyRecord_version_check" CHECK ("version" > 0),
  ADD CONSTRAINT "FamilyRecord_session_operational_unique" UNIQUE ("sessionId", "operationalId"),
  ADD CONSTRAINT "FamilyRecord_verification_projection_check" CHECK (
    ("verificationStatus" = 'Verified' AND "verificationDecisionAt" IS NOT NULL)
    OR "verificationStatus" <> 'Verified'
  ),
  ADD CONSTRAINT "FamilyRecord_verificationDecisionById_fkey" FOREIGN KEY ("verificationDecisionById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "FamilyRecord"
  ADD CONSTRAINT "FamilyRecord_sourceBatchId_fkey" FOREIGN KEY ("sourceBatchId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "RelationshipClaim"
  ADD CONSTRAINT "RelationshipClaim_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "RelationshipClaim_familyRecordId_fkey" FOREIGN KEY ("familyRecordId") REFERENCES "FamilyRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "RelationshipClaim_passengerRecordId_fkey" FOREIGN KEY ("passengerRecordId") REFERENCES "PassengerRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "RelationshipClaim_claimedById_fkey" FOREIGN KEY ("claimedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "RelationshipVerificationDecision"
  ADD CONSTRAINT "RelationshipVerificationDecision_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "RelationshipVerificationDecision_relationshipClaimId_fkey" FOREIGN KEY ("relationshipClaimId") REFERENCES "RelationshipClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "RelationshipVerificationDecision_decisionById_fkey" FOREIGN KEY ("decisionById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "RelationshipClaim_one_current_per_family" ON "RelationshipClaim"("familyRecordId") WHERE "isCurrent" = true;
CREATE INDEX "RelationshipClaim_incidentId_status_updatedAt_idx" ON "RelationshipClaim"("incidentId", "status", "updatedAt");
CREATE INDEX "RelationshipClaim_incidentId_familyRecordId_idx" ON "RelationshipClaim"("incidentId", "familyRecordId");
CREATE INDEX "RelationshipClaim_incidentId_passengerRecordId_idx" ON "RelationshipClaim"("incidentId", "passengerRecordId");
CREATE INDEX "RelationshipVerificationDecision_incident_claim_decided_idx" ON "RelationshipVerificationDecision"("incidentId", "relationshipClaimId", "decisionAt");
CREATE INDEX "RelationshipVerificationDecision_incident_result_decided_idx" ON "RelationshipVerificationDecision"("incidentId", "result", "decisionAt");
CREATE INDEX "FamilyRecord_sessionId_verificationStatus_updatedAt_idx" ON "FamilyRecord"("sessionId", "verificationStatus", "updatedAt");
CREATE INDEX "FamilyRecord_sessionId_normalizedPhone_idx" ON "FamilyRecord"("sessionId", "normalizedPhone");
CREATE INDEX "FamilyRecord_sessionId_normalizedEmail_idx" ON "FamilyRecord"("sessionId", "normalizedEmail");
CREATE INDEX "FamilyRecord_sessionId_sourceBatchId_idx" ON "FamilyRecord"("sessionId", "sourceBatchId");

CREATE OR REPLACE FUNCTION enforce_relationship_claim_incident() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "FamilyRecord" family
    WHERE family."id" = NEW."familyRecordId" AND family."sessionId" = NEW."incidentId"
  ) THEN
    RAISE EXCEPTION 'RelationshipClaim FamilyRecord must belong to the same incident' USING ERRCODE = '23514';
  END IF;
  IF NEW."passengerRecordId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "PassengerRecord" passenger
    WHERE passenger."id" = NEW."passengerRecordId" AND passenger."sessionId" = NEW."incidentId"
  ) THEN
    RAISE EXCEPTION 'RelationshipClaim PassengerRecord must belong to the same incident' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RelationshipClaim_incident_guard"
BEFORE INSERT OR UPDATE OF "incidentId", "familyRecordId", "passengerRecordId" ON "RelationshipClaim"
FOR EACH ROW EXECUTE FUNCTION enforce_relationship_claim_incident();

CREATE OR REPLACE FUNCTION enforce_relationship_decision_incident() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "RelationshipClaim" claim
    WHERE claim."id" = NEW."relationshipClaimId" AND claim."incidentId" = NEW."incidentId"
  ) THEN
    RAISE EXCEPTION 'RelationshipVerificationDecision must belong to the claim incident' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RelationshipVerificationDecision_incident_guard"
BEFORE INSERT OR UPDATE OF "incidentId", "relationshipClaimId" ON "RelationshipVerificationDecision"
FOR EACH ROW EXECUTE FUNCTION enforce_relationship_decision_incident();
