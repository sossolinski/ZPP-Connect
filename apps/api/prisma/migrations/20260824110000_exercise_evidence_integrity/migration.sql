CREATE SEQUENCE "ExerciseInject_operational_seq" START WITH 1;
CREATE SEQUENCE "ExerciseObservation_operational_seq" START WITH 1;

SELECT setval(
  '"ExerciseInject_operational_seq"',
  GREATEST(COALESCE((SELECT MAX(substring("operationalId" FROM '([0-9]+)$')::BIGINT) FROM "ExerciseInject" WHERE "operationalId" ~ '[0-9]+$'), 0) + 1, 1),
  false
);
SELECT setval(
  '"ExerciseObservation_operational_seq"',
  GREATEST(COALESCE((SELECT MAX(substring("operationalId" FROM '([0-9]+)$')::BIGINT) FROM "ExerciseObservation" WHERE "operationalId" ~ '[0-9]+$'), 0) + 1, 1),
  false
);

ALTER TABLE "ExerciseInject"
  ADD COLUMN "targetRoleId" UUID,
  ADD COLUMN "targetRoleKey" TEXT,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "createOperationId" UUID,
  ADD COLUMN "createCommandFingerprint" TEXT,
  ADD COLUMN "createdById" UUID,
  ADD COLUMN "updatedById" UUID,
  ADD COLUMN "completedById" UUID,
  ADD COLUMN "completedAt" TIMESTAMP(3);

UPDATE "ExerciseInject"
SET "targetRoleKey" = CASE lower(trim("targetRole"))
  WHEN 'system admin' THEN 'system-admin'
  WHEN 'admin' THEN 'system-admin'
  WHEN 'zpp coordinator' THEN 'zpp-coordinator'
  WHEN 'coordinator' THEN 'zpp-coordinator'
  WHEN 'tec coordinator' THEN 'tec-coordinator'
  WHEN 'zpp group leader' THEN 'zpp-group-leader'
  WHEN 'zpp leader' THEN 'zpp-group-leader'
  WHEN 'tec group leader' THEN 'tec-group-leader'
  WHEN 'zpp member' THEN 'zpp-member'
  WHEN 'volunteer' THEN 'zpp-member'
  WHEN 'tec member' THEN 'tec-member'
  WHEN 'tec' THEN 'tec-member'
  WHEN 'observer' THEN 'observer'
  WHEN 'viewer' THEN 'observer'
  ELSE lower(trim("targetRole"))
END;

UPDATE "ExerciseInject" inject
SET "targetRoleId" = role."id"
FROM "Role" role
WHERE role."normalizedName" = inject."targetRoleKey";

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ExerciseInject" WHERE "targetRoleId" IS NULL) THEN
    RAISE EXCEPTION 'Existing Exercise Inject targetRole does not map to a durable Role';
  END IF;
END $$;

ALTER TABLE "ExerciseInject"
  ALTER COLUMN "targetRoleId" SET NOT NULL,
  ALTER COLUMN "targetRoleKey" SET NOT NULL,
  ADD CONSTRAINT "ExerciseInject_targetRoleId_fkey" FOREIGN KEY ("targetRoleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ExerciseInject_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "ExerciseInject_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "ExerciseInject_releasedById_fkey" FOREIGN KEY ("releasedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "ExerciseInject_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "ExerciseInject_number_check" CHECK ("injectNumber" BETWEEN 1 AND 999999),
  ADD CONSTRAINT "ExerciseInject_status_check" CHECK ("status" IN ('Planned', 'Released', 'Completed', 'Cancelled')),
  ADD CONSTRAINT "ExerciseInject_role_key_check" CHECK ("targetRoleKey" IN ('system-admin', 'zpp-coordinator', 'tec-coordinator', 'zpp-group-leader', 'tec-group-leader', 'zpp-member', 'tec-member', 'observer')),
  ADD CONSTRAINT "ExerciseInject_version_check" CHECK ("version" > 0),
  ADD CONSTRAINT "ExerciseInject_text_check" CHECK (length("text") BETWEEN 1 AND 10000),
  ADD CONSTRAINT "ExerciseInject_expected_action_check" CHECK ("expectedAction" IS NULL OR length("expectedAction") <= 5000),
  ADD CONSTRAINT "ExerciseInject_fingerprint_check" CHECK ("createCommandFingerprint" IS NULL OR "createCommandFingerprint" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "ExerciseInject_lifecycle_provenance_check" CHECK (
    ("status" = 'Planned' AND "releasedAt" IS NULL AND "releasedById" IS NULL AND "completedAt" IS NULL AND "completedById" IS NULL) OR
    ("status" = 'Released' AND "releasedAt" IS NOT NULL AND "releasedById" IS NOT NULL AND "completedAt" IS NULL AND "completedById" IS NULL) OR
    ("status" = 'Completed' AND "releasedAt" IS NOT NULL AND "releasedById" IS NOT NULL AND "completedAt" IS NOT NULL AND "completedById" IS NOT NULL) OR
    "status" = 'Cancelled'
  );

CREATE UNIQUE INDEX "ExerciseInject_createOperationId_key" ON "ExerciseInject"("createOperationId");
CREATE INDEX "ExerciseInject_sessionId_scenarioTime_id_idx" ON "ExerciseInject"("sessionId", "scenarioTime", "id");
CREATE INDEX "ExerciseInject_sessionId_createdAt_id_idx" ON "ExerciseInject"("sessionId", "createdAt", "id");
CREATE INDEX "ExerciseInject_targetRoleId_idx" ON "ExerciseInject"("targetRoleId");

ALTER TABLE "ExerciseObservation"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "createOperationId" UUID,
  ADD COLUMN "createCommandFingerprint" TEXT,
  ADD COLUMN "updatedById" UUID;

UPDATE "ExerciseObservation" SET "updatedById" = "createdById" WHERE "updatedById" IS NULL;

ALTER TABLE "ExerciseObservation"
  ADD CONSTRAINT "ExerciseObservation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "ExerciseObservation_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "ExerciseObservation_area_check" CHECK ("area" IN ('Intake', 'Family Assistance', 'Passenger/SRC', 'Matching', 'Requests', 'Coordination', 'Other')),
  ADD CONSTRAINT "ExerciseObservation_severity_check" CHECK ("severity" IN ('Low', 'Medium', 'High')),
  ADD CONSTRAINT "ExerciseObservation_status_check" CHECK ("status" IN ('Open', 'In review', 'Resolved')),
  ADD CONSTRAINT "ExerciseObservation_version_check" CHECK ("version" > 0),
  ADD CONSTRAINT "ExerciseObservation_text_check" CHECK (length("observation") BETWEEN 1 AND 10000),
  ADD CONSTRAINT "ExerciseObservation_recommendation_check" CHECK ("recommendation" IS NULL OR length("recommendation") <= 5000),
  ADD CONSTRAINT "ExerciseObservation_owner_check" CHECK ("owner" IS NULL OR length("owner") <= 200),
  ADD CONSTRAINT "ExerciseObservation_fingerprint_check" CHECK ("createCommandFingerprint" IS NULL OR "createCommandFingerprint" ~ '^[0-9a-f]{64}$');

CREATE UNIQUE INDEX "ExerciseObservation_createOperationId_key" ON "ExerciseObservation"("createOperationId");
CREATE INDEX "ExerciseObservation_sessionId_createdAt_id_idx" ON "ExerciseObservation"("sessionId", "createdAt" DESC, "id" DESC);
CREATE INDEX "ExerciseObservation_sessionId_status_idx" ON "ExerciseObservation"("sessionId", "status");
CREATE INDEX "ExerciseObservation_sessionId_includeInAar_idx" ON "ExerciseObservation"("sessionId", "includeInAar");

CREATE TABLE "ExerciseObservationRevision" (
  "id" UUID NOT NULL,
  "observationId" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "area" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "observation" TEXT NOT NULL,
  "recommendation" TEXT,
  "owner" TEXT,
  "includeInAar" BOOLEAN NOT NULL,
  "status" TEXT NOT NULL,
  "changedFields" TEXT[] NOT NULL,
  "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "changedById" UUID,
  "source" TEXT NOT NULL DEFAULT 'Mutation',
  CONSTRAINT "ExerciseObservationRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ExerciseObservationRevision_observationId_fkey" FOREIGN KEY ("observationId") REFERENCES "ExerciseObservation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ExerciseObservationRevision_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ExerciseObservationRevision_version_check" CHECK ("version" > 0),
  CONSTRAINT "ExerciseObservationRevision_source_check" CHECK ("source" IN ('Mutation', 'MigrationBaseline', 'Seed'))
);

INSERT INTO "ExerciseObservationRevision" (
  "id", "observationId", "version", "area", "severity", "observation", "recommendation", "owner", "includeInAar", "status", "changedFields", "changedAt", "changedById", "source"
)
SELECT gen_random_uuid(), "id", 1, "area", "severity", "observation", "recommendation", "owner", "includeInAar", "status",
       ARRAY['area','severity','observation','recommendation','owner','includeInAar','status'], CURRENT_TIMESTAMP, "createdById", 'MigrationBaseline'
FROM "ExerciseObservation";

CREATE UNIQUE INDEX "ExerciseObservationRevision_observationId_version_key" ON "ExerciseObservationRevision"("observationId", "version");
CREATE INDEX "ExerciseObservationRevision_observationId_version_idx" ON "ExerciseObservationRevision"("observationId", "version");
CREATE INDEX "ExerciseObservationRevision_changedById_changedAt_idx" ON "ExerciseObservationRevision"("changedById", "changedAt");

CREATE OR REPLACE FUNCTION enforce_exercise_inject_evidence() RETURNS trigger AS $$
BEGIN
  IF OLD."status" IN ('Released', 'Completed', 'Cancelled') AND (
    NEW."injectNumber" IS DISTINCT FROM OLD."injectNumber" OR
    NEW."scenarioTime" IS DISTINCT FROM OLD."scenarioTime" OR
    NEW."targetRoleId" IS DISTINCT FROM OLD."targetRoleId" OR
    NEW."targetRoleKey" IS DISTINCT FROM OLD."targetRoleKey" OR
    NEW."targetRole" IS DISTINCT FROM OLD."targetRole" OR
    NEW."text" IS DISTINCT FROM OLD."text" OR
    NEW."expectedAction" IS DISTINCT FROM OLD."expectedAction"
  ) THEN
    RAISE EXCEPTION 'Released or terminal Exercise Inject content is immutable' USING ERRCODE = '23514';
  END IF;

  IF OLD."status" IS DISTINCT FROM NEW."status" AND (
    NEW."injectNumber" IS DISTINCT FROM OLD."injectNumber" OR
    NEW."scenarioTime" IS DISTINCT FROM OLD."scenarioTime" OR
    NEW."targetRoleId" IS DISTINCT FROM OLD."targetRoleId" OR
    NEW."targetRoleKey" IS DISTINCT FROM OLD."targetRoleKey" OR
    NEW."targetRole" IS DISTINCT FROM OLD."targetRole" OR
    NEW."text" IS DISTINCT FROM OLD."text" OR
    NEW."expectedAction" IS DISTINCT FROM OLD."expectedAction"
  ) THEN
    RAISE EXCEPTION 'Inject content and lifecycle cannot change in one operation' USING ERRCODE = '23514';
  END IF;

  IF OLD."status" = 'Planned' AND NEW."status" NOT IN ('Planned', 'Released') THEN
    RAISE EXCEPTION 'Illegal Exercise Inject lifecycle transition' USING ERRCODE = '23514';
  ELSIF OLD."status" = 'Released' AND NEW."status" NOT IN ('Released', 'Completed') THEN
    RAISE EXCEPTION 'Illegal Exercise Inject lifecycle transition' USING ERRCODE = '23514';
  ELSIF OLD."status" IN ('Completed', 'Cancelled') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Terminal Exercise Inject evidence is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ExerciseInject_evidence_immutable"
BEFORE UPDATE ON "ExerciseInject"
FOR EACH ROW EXECUTE FUNCTION enforce_exercise_inject_evidence();

CREATE OR REPLACE FUNCTION prevent_exercise_revision_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Exercise Observation revisions are immutable' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "ExerciseObservation" WHERE "id" = OLD."observationId") THEN
    RAISE EXCEPTION 'Exercise Observation revisions are append-only' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ExerciseObservationRevision_immutable"
BEFORE UPDATE OR DELETE ON "ExerciseObservationRevision"
FOR EACH ROW EXECUTE FUNCTION prevent_exercise_revision_mutation();

CREATE OR REPLACE FUNCTION check_exercise_observation_revision_invariant() RETURNS trigger AS $$
DECLARE
  revision_count INTEGER;
  minimum_version INTEGER;
  maximum_version INTEGER;
BEGIN
  SELECT count(*), min("version"), max("version")
  INTO revision_count, minimum_version, maximum_version
  FROM "ExerciseObservationRevision"
  WHERE "observationId" = NEW."id";

  IF revision_count <> NEW."version" OR minimum_version <> 1 OR maximum_version <> NEW."version" THEN
    RAISE EXCEPTION 'Exercise Observation revision history does not match current version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "ExerciseObservation_revision_invariant"
AFTER INSERT OR UPDATE ON "ExerciseObservation"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_exercise_observation_revision_invariant();

CREATE OR REPLACE FUNCTION check_exercise_revision_parent_invariant() RETURNS trigger AS $$
DECLARE
  parent_version INTEGER;
  revision_count INTEGER;
  minimum_version INTEGER;
  maximum_version INTEGER;
BEGIN
  SELECT "version" INTO parent_version
  FROM "ExerciseObservation"
  WHERE "id" = NEW."observationId";

  IF parent_version IS NULL THEN
    RAISE EXCEPTION 'Exercise Observation revision has no current parent' USING ERRCODE = '23514';
  END IF;

  SELECT count(*), min("version"), max("version")
  INTO revision_count, minimum_version, maximum_version
  FROM "ExerciseObservationRevision"
  WHERE "observationId" = NEW."observationId";

  IF revision_count <> parent_version OR minimum_version <> 1 OR maximum_version <> parent_version THEN
    RAISE EXCEPTION 'Exercise Observation revision history does not match current version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "ExerciseObservationRevision_parent_invariant"
AFTER INSERT ON "ExerciseObservationRevision"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_exercise_revision_parent_invariant();
