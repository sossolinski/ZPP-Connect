ALTER TABLE "ReunificationReleaseRecord" RENAME TO "ReleaseAction";
ALTER TABLE "ReleaseAction" RENAME COLUMN "sessionId" TO "incidentId";
ALTER TABLE "ReleaseAction" RENAME COLUMN "matchId" TO "matchingRecordId";
ALTER TABLE "ReleaseAction" RENAME COLUMN "authorizedById" TO "preparedById";

ALTER TABLE "ReleaseAction"
  ADD COLUMN "relationshipClaimId" UUID,
  ADD COLUMN "matchDecisionId" UUID,
  ADD COLUMN "relationshipClaimVersion" INTEGER,
  ADD COLUMN "passengerVersion" INTEGER,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "authorizedById" UUID,
  ADD COLUMN "authorizedAt" TIMESTAMP(3),
  ADD COLUMN "authorizationReason" TEXT,
  ADD COLUMN "authorizedClaimVersion" INTEGER,
  ADD COLUMN "authorizedPassengerVersion" INTEGER,
  ADD COLUMN "completionNotes" TEXT,
  ADD COLUMN "cancelledById" UUID,
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "cancelReason" TEXT,
  ADD COLUMN "legacyImported" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "verificationEvidenceUnavailable" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "legacyMetadata" JSONB;

UPDATE "ReleaseAction" action
SET
  "relationshipClaimId" = matching."relationshipClaimId",
  "matchDecisionId" = (
    SELECT candidate."id"
    FROM "MatchDecision" candidate
    WHERE candidate."incidentId" = action."incidentId"
      AND candidate."matchingRecordId" = action."matchingRecordId"
      AND candidate."decision" = 'CONFIRMED'
    ORDER BY candidate."isCurrent" DESC, candidate."decidedAt" DESC
    LIMIT 1
  ),
  "relationshipClaimVersion" = claim."version",
  "passengerVersion" = (SELECT passenger."version" FROM "PassengerRecord" passenger WHERE passenger."id" = action."passengerRecordId"),
  "preparedAt" = action."createdAt",
  "completedAt" = CASE WHEN action."status" IN ('Completed', 'Released', 'Reunited') THEN COALESCE(action."completedAt", action."updatedAt", action."createdAt") ELSE action."completedAt" END,
  "completionNotes" = CASE WHEN action."status" IN ('Completed', 'Released', 'Reunited') THEN action."notes" ELSE NULL END,
  "cancelledAt" = CASE WHEN action."status" = 'Cancelled' THEN action."updatedAt" ELSE NULL END,
  "cancelReason" = CASE WHEN action."status" = 'Cancelled' THEN action."notes" ELSE NULL END,
  "legacyImported" = true,
  "verificationEvidenceUnavailable" = action."identityChecked" OR action."holdCleared" OR action."status" IN ('Completed', 'Released', 'Reunited'),
  "legacyMetadata" = jsonb_build_object(
    'sourceModel', 'ReunificationReleaseRecord',
    'legacyStatus', action."status",
    'legacyIdentityClaimed', action."identityChecked",
    'legacyHoldClaimed', action."holdCleared",
    'legacyFamilyRecordId', action."familyRecordId"
  )
FROM "MatchingRecord" matching
LEFT JOIN "RelationshipClaim" claim ON claim."id" = matching."relationshipClaimId"
WHERE matching."id" = action."matchingRecordId";

UPDATE "ReleaseAction"
SET
  "preparedAt" = "createdAt",
  "completedAt" = CASE WHEN "status" IN ('Completed', 'Released', 'Reunited') THEN COALESCE("completedAt", "updatedAt", "createdAt") ELSE "completedAt" END,
  "completionNotes" = CASE WHEN "status" IN ('Completed', 'Released', 'Reunited') THEN "notes" ELSE "completionNotes" END,
  "cancelledAt" = CASE WHEN "status" = 'Cancelled' THEN "updatedAt" ELSE "cancelledAt" END,
  "cancelReason" = CASE WHEN "status" = 'Cancelled' THEN "notes" ELSE "cancelReason" END,
  "legacyImported" = true,
  "verificationEvidenceUnavailable" = "identityChecked" OR "holdCleared" OR "status" IN ('Completed', 'Released', 'Reunited'),
  "legacyMetadata" = COALESCE("legacyMetadata", jsonb_build_object(
    'sourceModel', 'ReunificationReleaseRecord',
    'legacyStatus', "status",
    'legacyIdentityClaimed', "identityChecked",
    'legacyHoldClaimed', "holdCleared",
    'legacyFamilyRecordId', "familyRecordId"
  ));

UPDATE "ReleaseAction"
SET
  "actionType" = CASE WHEN lower("actionType") = 'release' THEN 'RELEASE' ELSE 'REUNIFICATION' END,
  "status" = CASE
    WHEN "status" IN ('Completed', 'Released', 'Reunited') THEN 'COMPLETED'
    WHEN "status" = 'Cancelled' THEN 'CANCELLED'
    ELSE 'PREPARED'
  END;

-- Historical rows were written without a database uniqueness invariant. Keep every
-- row and its terminal state, but quarantine older duplicate outcomes/processes from
-- the new controlled key. This is intentionally honest: the row stays auditable,
-- verification evidence remains unavailable, and no ReleaseCheck is invented.
WITH ranked AS (
  SELECT "id", row_number() OVER (
    PARTITION BY "incidentId", "relationshipClaimId", "matchDecisionId", "actionType", "status"
    ORDER BY "updatedAt" DESC, "id" DESC
  ) AS duplicate_rank
  FROM "ReleaseAction"
  WHERE "status" IN ('PREPARED', 'COMPLETED')
    AND "relationshipClaimId" IS NOT NULL
    AND "matchDecisionId" IS NOT NULL
)
UPDATE "ReleaseAction" action
SET
  "matchDecisionId" = NULL,
  "verificationEvidenceUnavailable" = true,
  "legacyMetadata" = COALESCE(action."legacyMetadata", '{}'::jsonb) || jsonb_build_object(
    'duplicateHistoricalControlledKey', true,
    'quarantinedDuringFoundationStage6', true
  )
FROM ranked
WHERE ranked."id" = action."id" AND ranked.duplicate_rank > 1;

ALTER TABLE "ReleaseAction" DROP CONSTRAINT IF EXISTS "ReunificationReleaseRecord_familyRecordId_fkey";
ALTER TABLE "ReleaseAction"
  DROP COLUMN "familyRecordId",
  DROP COLUMN "identityChecked",
  DROP COLUMN "holdCleared";

CREATE SEQUENCE "ReleaseAction_operational_seq" START WITH 1;
SELECT setval(
  '"ReleaseAction_operational_seq"',
  GREATEST(
    COALESCE((SELECT MAX((regexp_match("operationalId", '([0-9]+)$'))[1]::bigint) FROM "ReleaseAction"), 0),
    1
  ),
  EXISTS (SELECT 1 FROM "ReleaseAction")
);

CREATE TABLE "ReleaseCheck" (
  "id" UUID NOT NULL,
  "incidentId" UUID NOT NULL,
  "releaseActionId" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "result" TEXT NOT NULL,
  "actorId" UUID,
  "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "basis" TEXT NOT NULL,
  "evidenceReference" TEXT,
  "relationshipClaimId" UUID,
  "claimVersion" INTEGER,
  "matchDecisionId" UUID,
  "passengerVersion" INTEGER,
  "operationId" UUID NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "isCurrent" BOOLEAN NOT NULL DEFAULT true,
  "supersedesCheckId" UUID,
  "requestId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReleaseCheck_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReleaseCheck_type_check" CHECK ("type" IN ('IDENTITY', 'HOLD_REVIEW')),
  CONSTRAINT "ReleaseCheck_result_check" CHECK ("result" IN ('PASS', 'FAIL')),
  CONSTRAINT "ReleaseCheck_version_check" CHECK ("version" > 0),
  CONSTRAINT "ReleaseCheck_input_versions_check" CHECK (("claimVersion" IS NULL OR "claimVersion" > 0) AND ("passengerVersion" IS NULL OR "passengerVersion" > 0))
);

CREATE TABLE "ReleaseOperation" (
  "id" UUID NOT NULL,
  "incidentId" UUID NOT NULL,
  "releaseActionId" UUID NOT NULL,
  "operationId" UUID NOT NULL,
  "command" TEXT NOT NULL,
  "commandFingerprint" TEXT NOT NULL,
  "resultVersion" INTEGER NOT NULL,
  "requestId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReleaseOperation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReleaseOperation_command_check" CHECK ("command" IN ('PREPARE', 'IDENTITY_CHECK', 'HOLD_REVIEW', 'AUTHORIZE', 'COMPLETE', 'CANCEL')),
  CONSTRAINT "ReleaseOperation_result_version_check" CHECK ("resultVersion" > 0)
);

ALTER TABLE "ReleaseAction" ADD CONSTRAINT "ReleaseAction_action_type_check" CHECK ("actionType" IN ('REUNIFICATION', 'RELEASE'));
ALTER TABLE "ReleaseAction" ADD CONSTRAINT "ReleaseAction_status_check" CHECK ("status" IN ('PREPARED', 'AUTHORIZED', 'COMPLETED', 'CANCELLED'));
ALTER TABLE "ReleaseAction" ADD CONSTRAINT "ReleaseAction_version_check" CHECK ("version" > 0);
ALTER TABLE "ReleaseAction" ADD CONSTRAINT "ReleaseAction_snapshot_versions_check" CHECK (("relationshipClaimVersion" IS NULL OR "relationshipClaimVersion" > 0) AND ("passengerVersion" IS NULL OR "passengerVersion" > 0));
ALTER TABLE "ReleaseAction" ADD CONSTRAINT "ReleaseAction_required_references_check" CHECK (
  "legacyImported" = true OR (
    "relationshipClaimId" IS NOT NULL AND "matchDecisionId" IS NOT NULL AND "passengerRecordId" IS NOT NULL
    AND "relationshipClaimVersion" IS NOT NULL AND "passengerVersion" IS NOT NULL AND "preparedById" IS NOT NULL
  )
);
ALTER TABLE "ReleaseAction" ADD CONSTRAINT "ReleaseAction_controlled_state_check" CHECK (
  ("status" = 'PREPARED' AND "authorizedAt" IS NULL AND "completedAt" IS NULL AND "cancelledAt" IS NULL) OR
  ("status" = 'AUTHORIZED' AND "authorizedAt" IS NOT NULL AND "completedAt" IS NULL AND "cancelledAt" IS NULL AND ("legacyImported" OR ("authorizedById" IS NOT NULL AND "authorizationReason" IS NOT NULL))) OR
  ("status" = 'COMPLETED' AND "completedAt" IS NOT NULL AND "cancelledAt" IS NULL AND ("legacyImported" OR ("authorizedById" IS NOT NULL AND "authorizedAt" IS NOT NULL AND "authorizationReason" IS NOT NULL AND "completedById" IS NOT NULL AND "completionNotes" IS NOT NULL))) OR
  ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL AND "completedAt" IS NULL AND ("legacyImported" OR ("cancelledById" IS NOT NULL AND "cancelReason" IS NOT NULL)))
);

DROP INDEX IF EXISTS "ReunificationReleaseRecord_sessionId_status_idx";
CREATE INDEX "ReleaseAction_incidentId_status_updatedAt_idx" ON "ReleaseAction"("incidentId", "status", "updatedAt");
CREATE INDEX "ReleaseAction_incidentId_actionType_updatedAt_idx" ON "ReleaseAction"("incidentId", "actionType", "updatedAt");
CREATE INDEX "ReleaseAction_relationshipClaimId_idx" ON "ReleaseAction"("relationshipClaimId");
CREATE INDEX "ReleaseAction_matchDecisionId_idx" ON "ReleaseAction"("matchDecisionId");
CREATE INDEX "ReleaseAction_passengerRecordId_idx" ON "ReleaseAction"("passengerRecordId");
CREATE UNIQUE INDEX "ReleaseAction_one_active_process_key"
  ON "ReleaseAction"("incidentId", "relationshipClaimId", "matchDecisionId", "actionType")
  WHERE "status" IN ('PREPARED', 'AUTHORIZED') AND "relationshipClaimId" IS NOT NULL AND "matchDecisionId" IS NOT NULL;
CREATE UNIQUE INDEX "ReleaseAction_one_completed_outcome_key"
  ON "ReleaseAction"("incidentId", "relationshipClaimId", "matchDecisionId", "actionType")
  WHERE "status" = 'COMPLETED' AND "relationshipClaimId" IS NOT NULL AND "matchDecisionId" IS NOT NULL;
CREATE UNIQUE INDEX "ReleaseCheck_incidentId_operationId_key" ON "ReleaseCheck"("incidentId", "operationId");
CREATE UNIQUE INDEX "ReleaseCheck_current_type_key" ON "ReleaseCheck"("releaseActionId", "type") WHERE "isCurrent" = true;
CREATE INDEX "ReleaseCheck_incidentId_releaseActionId_type_checkedAt_idx" ON "ReleaseCheck"("incidentId", "releaseActionId", "type", "checkedAt");
CREATE UNIQUE INDEX "ReleaseOperation_incidentId_operationId_key" ON "ReleaseOperation"("incidentId", "operationId");
CREATE INDEX "ReleaseOperation_releaseActionId_createdAt_idx" ON "ReleaseOperation"("releaseActionId", "createdAt");

ALTER TABLE "ReleaseAction" ADD CONSTRAINT "ReleaseAction_relationshipClaimId_fkey" FOREIGN KEY ("relationshipClaimId") REFERENCES "RelationshipClaim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReleaseAction" ADD CONSTRAINT "ReleaseAction_matchDecisionId_fkey" FOREIGN KEY ("matchDecisionId") REFERENCES "MatchDecision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReleaseAction" ADD CONSTRAINT "ReleaseAction_authorizedById_fkey" FOREIGN KEY ("authorizedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReleaseAction" ADD CONSTRAINT "ReleaseAction_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReleaseCheck" ADD CONSTRAINT "ReleaseCheck_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReleaseCheck" ADD CONSTRAINT "ReleaseCheck_releaseActionId_fkey" FOREIGN KEY ("releaseActionId") REFERENCES "ReleaseAction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReleaseCheck" ADD CONSTRAINT "ReleaseCheck_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReleaseCheck" ADD CONSTRAINT "ReleaseCheck_supersedesCheckId_fkey" FOREIGN KEY ("supersedesCheckId") REFERENCES "ReleaseCheck"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReleaseOperation" ADD CONSTRAINT "ReleaseOperation_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReleaseOperation" ADD CONSTRAINT "ReleaseOperation_releaseActionId_fkey" FOREIGN KEY ("releaseActionId") REFERENCES "ReleaseAction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION enforce_release_action_incident() RETURNS trigger AS $$
DECLARE
  claim_row "RelationshipClaim"%ROWTYPE;
  decision_row "MatchDecision"%ROWTYPE;
  passenger_incident UUID;
  matching_row "MatchingRecord"%ROWTYPE;
BEGIN
  IF NEW."relationshipClaimId" IS NOT NULL THEN
    SELECT * INTO claim_row FROM "RelationshipClaim" WHERE "id" = NEW."relationshipClaimId";
    IF NOT FOUND OR claim_row."incidentId" <> NEW."incidentId" THEN
      RAISE EXCEPTION 'ReleaseAction claim must belong to the same incident' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."passengerRecordId" IS NOT NULL THEN
    SELECT "sessionId" INTO passenger_incident FROM "PassengerRecord" WHERE "id" = NEW."passengerRecordId";
    IF passenger_incident IS NULL OR passenger_incident <> NEW."incidentId" THEN
      RAISE EXCEPTION 'ReleaseAction Passenger must belong to the same incident' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."matchDecisionId" IS NOT NULL THEN
    SELECT * INTO decision_row FROM "MatchDecision" WHERE "id" = NEW."matchDecisionId";
    IF NOT FOUND OR decision_row."incidentId" <> NEW."incidentId"
      OR decision_row."relationshipClaimId" IS DISTINCT FROM NEW."relationshipClaimId"
      OR decision_row."passengerRecordId" IS DISTINCT FROM NEW."passengerRecordId" THEN
      RAISE EXCEPTION 'ReleaseAction MatchDecision must match its claim and Passenger' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."matchingRecordId" IS NOT NULL THEN
    SELECT * INTO matching_row FROM "MatchingRecord" WHERE "id" = NEW."matchingRecordId";
    IF NOT FOUND OR matching_row."sessionId" <> NEW."incidentId"
      OR (NEW."relationshipClaimId" IS NOT NULL AND matching_row."relationshipClaimId" IS DISTINCT FROM NEW."relationshipClaimId")
      OR (NEW."passengerRecordId" IS NOT NULL AND matching_row."passengerRecordId" IS DISTINCT FROM NEW."passengerRecordId") THEN
      RAISE EXCEPTION 'ReleaseAction matching projection must match its claim and Passenger' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ReleaseAction_same_incident"
BEFORE INSERT OR UPDATE OF "incidentId", "relationshipClaimId", "matchDecisionId", "matchingRecordId", "passengerRecordId" ON "ReleaseAction"
FOR EACH ROW EXECUTE FUNCTION enforce_release_action_incident();

CREATE OR REPLACE FUNCTION enforce_release_check_integrity() RETURNS trigger AS $$
DECLARE
  action_row "ReleaseAction"%ROWTYPE;
BEGIN
  SELECT * INTO action_row FROM "ReleaseAction" WHERE "id" = NEW."releaseActionId";
  IF NOT FOUND OR action_row."incidentId" <> NEW."incidentId" THEN
    RAISE EXCEPTION 'ReleaseCheck must belong to the same incident as ReleaseAction' USING ERRCODE = '23514';
  END IF;
  IF action_row."status" IN ('COMPLETED', 'CANCELLED') THEN
    RAISE EXCEPTION 'Terminal ReleaseAction cannot receive checks' USING ERRCODE = '23514';
  END IF;
  IF NEW."relationshipClaimId" IS DISTINCT FROM action_row."relationshipClaimId"
    OR NEW."matchDecisionId" IS DISTINCT FROM action_row."matchDecisionId" THEN
    RAISE EXCEPTION 'ReleaseCheck input references must match ReleaseAction' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ReleaseCheck_integrity"
BEFORE INSERT OR UPDATE ON "ReleaseCheck"
FOR EACH ROW EXECUTE FUNCTION enforce_release_check_integrity();

CREATE OR REPLACE FUNCTION enforce_release_operation_incident() RETURNS trigger AS $$
DECLARE
  action_incident UUID;
BEGIN
  SELECT "incidentId" INTO action_incident FROM "ReleaseAction" WHERE "id" = NEW."releaseActionId";
  IF action_incident IS NULL OR action_incident <> NEW."incidentId" THEN
    RAISE EXCEPTION 'ReleaseOperation must belong to the same incident as ReleaseAction' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ReleaseOperation_same_incident"
BEFORE INSERT OR UPDATE ON "ReleaseOperation"
FOR EACH ROW EXECUTE FUNCTION enforce_release_operation_incident();

CREATE OR REPLACE FUNCTION protect_completed_release_action() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'COMPLETED' THEN
    RAISE EXCEPTION 'Completed ReleaseAction is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ReleaseAction_completed_immutable"
BEFORE UPDATE ON "ReleaseAction"
FOR EACH ROW EXECUTE FUNCTION protect_completed_release_action();
