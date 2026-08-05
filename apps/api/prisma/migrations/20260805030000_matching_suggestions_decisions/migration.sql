ALTER TABLE "MatchingRecord"
  ADD COLUMN "relationshipClaimId" UUID,
  ADD COLUMN "suggestionId" UUID,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

CREATE SEQUENCE "MatchingRecord_operational_seq" START WITH 1;
SELECT setval(
  '"MatchingRecord_operational_seq"',
  GREATEST(
    COALESCE((SELECT MAX((regexp_match("operationalId", '([0-9]+)$'))[1]::bigint) FROM "MatchingRecord"), 0),
    1
  ),
  EXISTS (SELECT 1 FROM "MatchingRecord")
);

CREATE TABLE "MatchSuggestion" (
  "id" UUID NOT NULL,
  "incidentId" UUID NOT NULL,
  "relationshipClaimId" UUID NOT NULL,
  "passengerRecordId" UUID NOT NULL,
  "score" DOUBLE PRECISION NOT NULL,
  "positiveSignals" JSONB NOT NULL,
  "conflicts" JSONB NOT NULL,
  "algorithm" TEXT NOT NULL,
  "algorithmVersion" TEXT NOT NULL,
  "generationId" UUID NOT NULL,
  "claimVersion" INTEGER NOT NULL,
  "passengerVersion" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "isCurrent" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MatchSuggestion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MatchSuggestion_score_check" CHECK ("score" >= 0 AND "score" <= 1),
  CONSTRAINT "MatchSuggestion_version_check" CHECK ("version" > 0),
  CONSTRAINT "MatchSuggestion_input_versions_check" CHECK ("claimVersion" > 0 AND "passengerVersion" > 0),
  CONSTRAINT "MatchSuggestion_status_check" CHECK ("status" IN ('ACTIVE', 'USED', 'REJECTED', 'OBSOLETE'))
);

CREATE TABLE "MatchDecision" (
  "id" UUID NOT NULL,
  "incidentId" UUID NOT NULL,
  "relationshipClaimId" UUID NOT NULL,
  "passengerRecordId" UUID NOT NULL,
  "matchingRecordId" UUID,
  "suggestionId" UUID,
  "decision" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "validity" TEXT NOT NULL DEFAULT 'CURRENT',
  "isCurrent" BOOLEAN NOT NULL DEFAULT false,
  "claimVersion" INTEGER NOT NULL,
  "passengerVersion" INTEGER NOT NULL,
  "operationId" UUID NOT NULL,
  "commandFingerprint" TEXT NOT NULL,
  "decisionById" UUID,
  "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "requestId" TEXT,
  "supersedesDecisionId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MatchDecision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MatchDecision_input_versions_check" CHECK ("claimVersion" > 0 AND "passengerVersion" > 0),
  CONSTRAINT "MatchDecision_decision_check" CHECK ("decision" IN ('CONFIRMED', 'REJECTED', 'INVALIDATED')),
  CONSTRAINT "MatchDecision_validity_check" CHECK ("validity" IN ('CURRENT', 'STALE', 'SUPERSEDED', 'HISTORICAL')),
  CONSTRAINT "MatchDecision_current_confirmed_check" CHECK (NOT "isCurrent" OR ("decision" = 'CONFIRMED' AND "validity" = 'CURRENT'))
);

UPDATE "MatchingRecord" matching
SET "relationshipClaimId" = claim."id"
FROM "RelationshipClaim" claim
WHERE claim."familyRecordId" = matching."familyRecordId"
  AND claim."incidentId" = matching."sessionId"
  AND claim."isCurrent" = true;

WITH ranked AS (
  SELECT
    matching."id" AS matching_id,
    matching."sessionId",
    matching."relationshipClaimId",
    matching."passengerRecordId",
    matching."matchScore",
    matching."createdAt",
    matching."updatedAt",
    claim."version" AS claim_version,
    passenger."version" AS passenger_version,
    row_number() OVER (
      PARTITION BY matching."sessionId", matching."relationshipClaimId", matching."passengerRecordId"
      ORDER BY matching."updatedAt" DESC, matching."id" DESC
    ) AS candidate_rank
  FROM "MatchingRecord" matching
  JOIN "RelationshipClaim" claim ON claim."id" = matching."relationshipClaimId"
  JOIN "PassengerRecord" passenger ON passenger."id" = matching."passengerRecordId" AND passenger."sessionId" = matching."sessionId"
)
INSERT INTO "MatchSuggestion" (
  "id", "incidentId", "relationshipClaimId", "passengerRecordId", "score", "positiveSignals", "conflicts",
  "algorithm", "algorithmVersion", "generationId", "claimVersion", "passengerVersion", "status", "isCurrent",
  "version", "generatedAt", "createdAt", "updatedAt"
)
SELECT
  (substr(md5('match-suggestion:' || matching_id::text), 1, 8) || '-' || substr(md5('match-suggestion:' || matching_id::text), 9, 4) || '-' || substr(md5('match-suggestion:' || matching_id::text), 13, 4) || '-' || substr(md5('match-suggestion:' || matching_id::text), 17, 4) || '-' || substr(md5('match-suggestion:' || matching_id::text), 21, 12))::uuid,
  "sessionId", "relationshipClaimId", "passengerRecordId", COALESCE("matchScore", 0), '[]'::jsonb, '[]'::jsonb,
  'legacy-matching-record', 'legacy-v1',
  (substr(md5('match-generation:' || matching_id::text), 1, 8) || '-' || substr(md5('match-generation:' || matching_id::text), 9, 4) || '-' || substr(md5('match-generation:' || matching_id::text), 13, 4) || '-' || substr(md5('match-generation:' || matching_id::text), 17, 4) || '-' || substr(md5('match-generation:' || matching_id::text), 21, 12))::uuid,
  claim_version, passenger_version, 'ACTIVE', candidate_rank = 1, 1, "createdAt", "createdAt", "updatedAt"
FROM ranked;

UPDATE "MatchingRecord" matching
SET "suggestionId" = suggestion."id"
FROM "MatchSuggestion" suggestion
WHERE suggestion."id" = (
  substr(md5('match-suggestion:' || matching."id"::text), 1, 8) || '-' || substr(md5('match-suggestion:' || matching."id"::text), 9, 4) || '-' || substr(md5('match-suggestion:' || matching."id"::text), 13, 4) || '-' || substr(md5('match-suggestion:' || matching."id"::text), 17, 4) || '-' || substr(md5('match-suggestion:' || matching."id"::text), 21, 12)
)::uuid;

WITH decision_candidates AS (
  SELECT
    matching.*,
    claim."version" AS claim_version,
    claim."isCurrent" AS claim_is_current,
    passenger."version" AS passenger_version,
    row_number() OVER (
      PARTITION BY matching."sessionId", matching."relationshipClaimId"
      ORDER BY COALESCE(matching."approvedAt", matching."updatedAt") DESC, matching."id" DESC
    ) AS decision_rank
  FROM "MatchingRecord" matching
  JOIN "RelationshipClaim" claim ON claim."id" = matching."relationshipClaimId"
  JOIN "PassengerRecord" passenger ON passenger."id" = matching."passengerRecordId" AND passenger."sessionId" = matching."sessionId"
  WHERE matching."status" IN ('Verified match', 'Reunited', 'Released', 'Rejected')
)
INSERT INTO "MatchDecision" (
  "id", "incidentId", "relationshipClaimId", "passengerRecordId", "matchingRecordId", "suggestionId",
  "decision", "reason", "validity", "isCurrent", "claimVersion", "passengerVersion", "operationId",
  "commandFingerprint", "decisionById", "decidedAt", "requestId", "createdAt"
)
SELECT
  (substr(md5('match-decision:' || "id"::text), 1, 8) || '-' || substr(md5('match-decision:' || "id"::text), 9, 4) || '-' || substr(md5('match-decision:' || "id"::text), 13, 4) || '-' || substr(md5('match-decision:' || "id"::text), 17, 4) || '-' || substr(md5('match-decision:' || "id"::text), 21, 12))::uuid,
  "sessionId", "relationshipClaimId", "passengerRecordId", "id", "suggestionId",
  CASE WHEN "status" = 'Rejected' THEN 'REJECTED' ELSE 'CONFIRMED' END,
  COALESCE(NULLIF("decisionNotes", ''), NULLIF("matchBasis", ''), 'Historical matching decision'),
  CASE
    WHEN "status" = 'Rejected' THEN 'HISTORICAL'
    WHEN decision_rank = 1 AND claim_is_current THEN 'CURRENT'
    ELSE 'SUPERSEDED'
  END,
  "status" <> 'Rejected' AND decision_rank = 1 AND claim_is_current,
  claim_version, passenger_version,
  (substr(md5('match-operation:' || "id"::text), 1, 8) || '-' || substr(md5('match-operation:' || "id"::text), 9, 4) || '-' || substr(md5('match-operation:' || "id"::text), 13, 4) || '-' || substr(md5('match-operation:' || "id"::text), 17, 4) || '-' || substr(md5('match-operation:' || "id"::text), 21, 12))::uuid,
  'legacy:' || "id"::text, "approvedById", COALESCE("approvedAt", "updatedAt"), NULL, "createdAt"
FROM decision_candidates;

ALTER TABLE "MatchingRecord" ADD CONSTRAINT "MatchingRecord_version_check" CHECK ("version" > 0);

CREATE UNIQUE INDEX "MatchSuggestion_current_candidate_key"
  ON "MatchSuggestion"("incidentId", "relationshipClaimId", "passengerRecordId", "algorithmVersion")
  WHERE "isCurrent" = true;
CREATE UNIQUE INDEX "MatchDecision_incidentId_operationId_key" ON "MatchDecision"("incidentId", "operationId");
CREATE UNIQUE INDEX "MatchDecision_current_confirmed_claim_key"
  ON "MatchDecision"("incidentId", "relationshipClaimId")
  WHERE "isCurrent" = true AND "decision" = 'CONFIRMED' AND "validity" = 'CURRENT';
CREATE INDEX "MatchSuggestion_incidentId_relationshipClaimId_isCurrent_score_idx" ON "MatchSuggestion"("incidentId", "relationshipClaimId", "isCurrent", "score");
CREATE INDEX "MatchSuggestion_incidentId_passengerRecordId_isCurrent_idx" ON "MatchSuggestion"("incidentId", "passengerRecordId", "isCurrent");
CREATE INDEX "MatchSuggestion_generationId_idx" ON "MatchSuggestion"("generationId");
CREATE INDEX "MatchDecision_incidentId_relationshipClaimId_decidedAt_idx" ON "MatchDecision"("incidentId", "relationshipClaimId", "decidedAt");
CREATE INDEX "MatchDecision_incidentId_passengerRecordId_decidedAt_idx" ON "MatchDecision"("incidentId", "passengerRecordId", "decidedAt");
CREATE INDEX "MatchDecision_matchingRecordId_idx" ON "MatchDecision"("matchingRecordId");
CREATE INDEX "MatchDecision_suggestionId_idx" ON "MatchDecision"("suggestionId");
CREATE INDEX "MatchingRecord_sessionId_relationshipClaimId_idx" ON "MatchingRecord"("sessionId", "relationshipClaimId");
CREATE INDEX "MatchingRecord_sessionId_passengerRecordId_idx" ON "MatchingRecord"("sessionId", "passengerRecordId");

ALTER TABLE "MatchingRecord" ADD CONSTRAINT "MatchingRecord_relationshipClaimId_fkey" FOREIGN KEY ("relationshipClaimId") REFERENCES "RelationshipClaim"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MatchingRecord" ADD CONSTRAINT "MatchingRecord_suggestionId_fkey" FOREIGN KEY ("suggestionId") REFERENCES "MatchSuggestion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MatchSuggestion" ADD CONSTRAINT "MatchSuggestion_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MatchSuggestion" ADD CONSTRAINT "MatchSuggestion_relationshipClaimId_fkey" FOREIGN KEY ("relationshipClaimId") REFERENCES "RelationshipClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MatchSuggestion" ADD CONSTRAINT "MatchSuggestion_passengerRecordId_fkey" FOREIGN KEY ("passengerRecordId") REFERENCES "PassengerRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MatchDecision" ADD CONSTRAINT "MatchDecision_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MatchDecision" ADD CONSTRAINT "MatchDecision_relationshipClaimId_fkey" FOREIGN KEY ("relationshipClaimId") REFERENCES "RelationshipClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MatchDecision" ADD CONSTRAINT "MatchDecision_passengerRecordId_fkey" FOREIGN KEY ("passengerRecordId") REFERENCES "PassengerRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MatchDecision" ADD CONSTRAINT "MatchDecision_matchingRecordId_fkey" FOREIGN KEY ("matchingRecordId") REFERENCES "MatchingRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MatchDecision" ADD CONSTRAINT "MatchDecision_suggestionId_fkey" FOREIGN KEY ("suggestionId") REFERENCES "MatchSuggestion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MatchDecision" ADD CONSTRAINT "MatchDecision_decisionById_fkey" FOREIGN KEY ("decisionById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MatchDecision" ADD CONSTRAINT "MatchDecision_supersedesDecisionId_fkey" FOREIGN KEY ("supersedesDecisionId") REFERENCES "MatchDecision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION enforce_match_suggestion_incident() RETURNS trigger AS $$
DECLARE
  claim_incident UUID;
  passenger_incident UUID;
BEGIN
  SELECT "incidentId" INTO claim_incident FROM "RelationshipClaim" WHERE "id" = NEW."relationshipClaimId";
  SELECT "sessionId" INTO passenger_incident FROM "PassengerRecord" WHERE "id" = NEW."passengerRecordId";
  IF claim_incident IS NULL OR passenger_incident IS NULL OR claim_incident <> NEW."incidentId" OR passenger_incident <> NEW."incidentId" THEN
    RAISE EXCEPTION 'MatchSuggestion links must belong to the same incident' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MatchSuggestion_same_incident"
BEFORE INSERT OR UPDATE OF "incidentId", "relationshipClaimId", "passengerRecordId" ON "MatchSuggestion"
FOR EACH ROW EXECUTE FUNCTION enforce_match_suggestion_incident();

CREATE OR REPLACE FUNCTION enforce_match_decision_incident() RETURNS trigger AS $$
DECLARE
  claim_incident UUID;
  passenger_incident UUID;
  suggestion_row "MatchSuggestion"%ROWTYPE;
  matching_row "MatchingRecord"%ROWTYPE;
BEGIN
  SELECT "incidentId" INTO claim_incident FROM "RelationshipClaim" WHERE "id" = NEW."relationshipClaimId";
  SELECT "sessionId" INTO passenger_incident FROM "PassengerRecord" WHERE "id" = NEW."passengerRecordId";
  IF claim_incident IS NULL OR passenger_incident IS NULL OR claim_incident <> NEW."incidentId" OR passenger_incident <> NEW."incidentId" THEN
    RAISE EXCEPTION 'MatchDecision links must belong to the same incident' USING ERRCODE = '23514';
  END IF;
  IF NEW."suggestionId" IS NOT NULL THEN
    SELECT * INTO suggestion_row FROM "MatchSuggestion" WHERE "id" = NEW."suggestionId";
    IF NOT FOUND OR suggestion_row."incidentId" <> NEW."incidentId" OR suggestion_row."relationshipClaimId" <> NEW."relationshipClaimId" OR suggestion_row."passengerRecordId" <> NEW."passengerRecordId" THEN
      RAISE EXCEPTION 'MatchDecision suggestion does not match its claim and Passenger' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."matchingRecordId" IS NOT NULL THEN
    SELECT * INTO matching_row FROM "MatchingRecord" WHERE "id" = NEW."matchingRecordId";
    IF NOT FOUND OR matching_row."sessionId" <> NEW."incidentId" OR matching_row."relationshipClaimId" IS DISTINCT FROM NEW."relationshipClaimId" OR matching_row."passengerRecordId" IS DISTINCT FROM NEW."passengerRecordId" THEN
      RAISE EXCEPTION 'MatchDecision projection does not match its claim and Passenger' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MatchDecision_same_incident"
BEFORE INSERT OR UPDATE OF "incidentId", "relationshipClaimId", "passengerRecordId", "suggestionId", "matchingRecordId" ON "MatchDecision"
FOR EACH ROW EXECUTE FUNCTION enforce_match_decision_incident();

CREATE OR REPLACE FUNCTION enforce_matching_projection_incident() RETURNS trigger AS $$
DECLARE
  claim_incident UUID;
  claim_family UUID;
  passenger_incident UUID;
  suggestion_row "MatchSuggestion"%ROWTYPE;
BEGIN
  IF NEW."relationshipClaimId" IS NOT NULL THEN
    SELECT "incidentId", "familyRecordId" INTO claim_incident, claim_family FROM "RelationshipClaim" WHERE "id" = NEW."relationshipClaimId";
    IF claim_incident IS NULL OR claim_incident <> NEW."sessionId" THEN
      RAISE EXCEPTION 'MatchingRecord claim must belong to the same incident' USING ERRCODE = '23514';
    END IF;
    IF NEW."familyRecordId" IS DISTINCT FROM claim_family THEN
      RAISE EXCEPTION 'MatchingRecord Family must own its relationship claim' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."passengerRecordId" IS NOT NULL THEN
    SELECT "sessionId" INTO passenger_incident FROM "PassengerRecord" WHERE "id" = NEW."passengerRecordId";
    IF passenger_incident IS NULL OR passenger_incident <> NEW."sessionId" THEN
      RAISE EXCEPTION 'MatchingRecord Passenger must belong to the same incident' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."suggestionId" IS NOT NULL THEN
    SELECT * INTO suggestion_row FROM "MatchSuggestion" WHERE "id" = NEW."suggestionId";
    IF NOT FOUND OR suggestion_row."incidentId" <> NEW."sessionId" OR suggestion_row."relationshipClaimId" IS DISTINCT FROM NEW."relationshipClaimId" OR suggestion_row."passengerRecordId" IS DISTINCT FROM NEW."passengerRecordId" THEN
      RAISE EXCEPTION 'MatchingRecord suggestion must match its claim and Passenger' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MatchingRecord_projection_same_incident"
BEFORE INSERT OR UPDATE OF "sessionId", "relationshipClaimId", "passengerRecordId", "suggestionId" ON "MatchingRecord"
FOR EACH ROW EXECUTE FUNCTION enforce_matching_projection_incident();
