CREATE SEQUENCE "RosterShift_operational_seq" START 7;
CREATE SEQUENCE "Availability_operational_seq" START 5;

ALTER TABLE "OperationalGroup"
  ADD CONSTRAINT "OperationalGroup_id_incidentId_key" UNIQUE ("id", "incidentId");

CREATE TABLE "RosterShift" (
  "id" TEXT NOT NULL,
  "operationalId" TEXT NOT NULL,
  "sessionId" UUID NOT NULL,
  "groupId" TEXT,
  "assignedMemberProfileId" TEXT,
  "title" TEXT NOT NULL,
  "duty" TEXT NOT NULL,
  "functionName" TEXT NOT NULL,
  "startAt" TIMESTAMP(3) NOT NULL,
  "endAt" TIMESTAMP(3) NOT NULL,
  "location" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Draft',
  "notes" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "publishedAt" TIMESTAMP(3),
  "publishedById" UUID,
  "confirmedAt" TIMESTAMP(3),
  "confirmedById" UUID,
  "declinedAt" TIMESTAMP(3),
  "declinedById" UUID,
  "cancelledAt" TIMESTAMP(3),
  "cancelledById" UUID,
  "cancelReason" TEXT,
  "completedAt" TIMESTAMP(3),
  "completedById" UUID,
  "legacyImported" BOOLEAN NOT NULL DEFAULT false,
  "legacyMetadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById" UUID,
  "updatedById" UUID,
  CONSTRAINT "RosterShift_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RosterShift_version_check" CHECK ("version" > 0),
  CONSTRAINT "RosterShift_range_check" CHECK ("endAt" > "startAt"),
  CONSTRAINT "RosterShift_status_check" CHECK ("status" IN ('Draft', 'Published', 'Confirmed', 'Declined', 'Cancelled', 'Completed'))
);

CREATE TABLE "Availability" (
  "id" TEXT NOT NULL,
  "operationalId" TEXT NOT NULL,
  "memberProfileId" TEXT NOT NULL,
  "startAt" TIMESTAMP(3) NOT NULL,
  "endAt" TIMESTAMP(3) NOT NULL,
  "type" TEXT NOT NULL,
  "note" TEXT,
  "status" TEXT NOT NULL DEFAULT 'Active',
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById" UUID,
  "updatedById" UUID,
  "removedAt" TIMESTAMP(3),
  "removedById" UUID,
  CONSTRAINT "Availability_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Availability_version_check" CHECK ("version" > 0),
  CONSTRAINT "Availability_range_check" CHECK ("endAt" > "startAt"),
  CONSTRAINT "Availability_type_check" CHECK ("type" IN ('Available', 'Unavailable', 'Preferred')),
  CONSTRAINT "Availability_status_check" CHECK ("status" IN ('Active', 'Removed')),
  CONSTRAINT "Availability_removed_check" CHECK (("status" = 'Removed') = ("removedAt" IS NOT NULL))
);

CREATE TABLE "RosteringOperation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "operationId" UUID NOT NULL,
  "rosterShiftId" TEXT,
  "availabilityId" TEXT,
  "command" TEXT NOT NULL,
  "commandFingerprint" TEXT NOT NULL,
  "resultVersion" INTEGER NOT NULL,
  "requestId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RosteringOperation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RosteringOperation_target_check" CHECK (num_nonnulls("rosterShiftId", "availabilityId") = 1),
  CONSTRAINT "RosteringOperation_version_check" CHECK ("resultVersion" > 0)
);

CREATE UNIQUE INDEX "RosterShift_operationalId_key" ON "RosterShift"("operationalId");
CREATE INDEX "RosterShift_sessionId_status_startAt_idx" ON "RosterShift"("sessionId", "status", "startAt");
CREATE INDEX "RosterShift_sessionId_assignedMemberProfileId_startAt_idx" ON "RosterShift"("sessionId", "assignedMemberProfileId", "startAt");
CREATE INDEX "RosterShift_sessionId_groupId_startAt_idx" ON "RosterShift"("sessionId", "groupId", "startAt");
CREATE INDEX "RosterShift_sessionId_functionName_startAt_idx" ON "RosterShift"("sessionId", "functionName", "startAt");
CREATE UNIQUE INDEX "Availability_operationalId_key" ON "Availability"("operationalId");
CREATE INDEX "Availability_memberProfileId_status_startAt_idx" ON "Availability"("memberProfileId", "status", "startAt");
CREATE INDEX "Availability_type_status_startAt_idx" ON "Availability"("type", "status", "startAt");
CREATE UNIQUE INDEX "RosteringOperation_operationId_key" ON "RosteringOperation"("operationId");
CREATE INDEX "RosteringOperation_rosterShiftId_createdAt_idx" ON "RosteringOperation"("rosterShiftId", "createdAt");
CREATE INDEX "RosteringOperation_availabilityId_createdAt_idx" ON "RosteringOperation"("availabilityId", "createdAt");

ALTER TABLE "RosterShift" ADD CONSTRAINT "RosterShift_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RosterShift" ADD CONSTRAINT "RosterShift_groupId_sessionId_fkey" FOREIGN KEY ("groupId", "sessionId") REFERENCES "OperationalGroup"("id", "incidentId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RosterShift" ADD CONSTRAINT "RosterShift_assignedMemberProfileId_fkey" FOREIGN KEY ("assignedMemberProfileId") REFERENCES "MemberProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RosterShift" ADD CONSTRAINT "RosterShift_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RosterShift" ADD CONSTRAINT "RosterShift_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RosterShift" ADD CONSTRAINT "RosterShift_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RosterShift" ADD CONSTRAINT "RosterShift_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RosterShift" ADD CONSTRAINT "RosterShift_declinedById_fkey" FOREIGN KEY ("declinedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RosterShift" ADD CONSTRAINT "RosterShift_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RosterShift" ADD CONSTRAINT "RosterShift_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Availability" ADD CONSTRAINT "Availability_memberProfileId_fkey" FOREIGN KEY ("memberProfileId") REFERENCES "MemberProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Availability" ADD CONSTRAINT "Availability_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Availability" ADD CONSTRAINT "Availability_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Availability" ADD CONSTRAINT "Availability_removedById_fkey" FOREIGN KEY ("removedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RosteringOperation" ADD CONSTRAINT "RosteringOperation_rosterShiftId_fkey" FOREIGN KEY ("rosterShiftId") REFERENCES "RosterShift"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RosteringOperation" ADD CONSTRAINT "RosteringOperation_availabilityId_fkey" FOREIGN KEY ("availabilityId") REFERENCES "Availability"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "protect_member_group_integrity"() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'MemberProfile' AND NEW."status" = 'Archived' AND OLD."status" <> 'Archived' THEN
    IF EXISTS (SELECT 1 FROM "GroupMembership" WHERE "memberProfileId" = NEW."id" AND "removedAt" IS NULL) THEN
      RAISE EXCEPTION 'ACTIVE_GROUP_MEMBERSHIP';
    END IF;
    IF EXISTS (SELECT 1 FROM "RosterShift" WHERE "assignedMemberProfileId" = NEW."id" AND "status" IN ('Draft', 'Published', 'Confirmed')) THEN
      RAISE EXCEPTION 'ACTIVE_ROSTER_SHIFT';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "validate_roster_shift_integrity"() RETURNS trigger AS $$
DECLARE member_status TEXT;
DECLARE group_status TEXT;
DECLARE group_incident UUID;
BEGIN
  IF NEW."assignedMemberProfileId" IS NOT NULL THEN
    SELECT "status" INTO member_status FROM "MemberProfile" WHERE "id" = NEW."assignedMemberProfileId" FOR UPDATE;
    IF member_status IS NULL OR member_status = 'Archived' THEN
      RAISE EXCEPTION 'ROSTER_MEMBER_NOT_ACTIVE';
    END IF;
  END IF;
  IF NEW."groupId" IS NOT NULL THEN
    SELECT "status", "incidentId" INTO group_status, group_incident FROM "OperationalGroup" WHERE "id" = NEW."groupId" FOR UPDATE;
    IF group_status IS NULL OR group_status = 'Archived' THEN
      RAISE EXCEPTION 'ROSTER_GROUP_NOT_ACTIVE';
    END IF;
    IF group_incident <> NEW."sessionId" THEN
      RAISE EXCEPTION 'ROSTER_GROUP_WRONG_INCIDENT';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RosterShift_integrity_guard"
BEFORE INSERT OR UPDATE OF "sessionId", "groupId", "assignedMemberProfileId" ON "RosterShift"
FOR EACH ROW EXECUTE FUNCTION "validate_roster_shift_integrity"();

CREATE OR REPLACE FUNCTION "protect_group_roster_integrity"() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = 'Archived' AND OLD."status" <> 'Archived' AND EXISTS (
    SELECT 1 FROM "RosterShift" WHERE "groupId" = NEW."id" AND "status" IN ('Draft', 'Published', 'Confirmed')
  ) THEN
    RAISE EXCEPTION 'ACTIVE_ROSTER_GROUP';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "OperationalGroup_archive_roster_guard"
BEFORE UPDATE OF "status" ON "OperationalGroup"
FOR EACH ROW EXECUTE FUNCTION "protect_group_roster_integrity"();

CREATE OR REPLACE FUNCTION "validate_availability_member"() RETURNS trigger AS $$
DECLARE member_status TEXT;
BEGIN
  SELECT "status" INTO member_status FROM "MemberProfile" WHERE "id" = NEW."memberProfileId" FOR UPDATE;
  IF member_status IS NULL OR member_status = 'Archived' THEN
    RAISE EXCEPTION 'AVAILABILITY_MEMBER_NOT_ACTIVE';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Availability_member_guard"
BEFORE INSERT OR UPDATE OF "memberProfileId" ON "Availability"
FOR EACH ROW EXECUTE FUNCTION "validate_availability_member"();
