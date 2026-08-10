CREATE SEQUENCE "MemberProfile_id_seq";
CREATE SEQUENCE "MemberProfile_business_seq";
CREATE SEQUENCE "OperationalGroup_id_seq";
CREATE SEQUENCE "GroupMembership_id_seq";

ALTER TABLE "UserRole" ADD COLUMN "scopeType" TEXT NOT NULL DEFAULT 'GLOBAL';
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_scopeType_check" CHECK ("scopeType" IN ('GLOBAL', 'GROUP'));
CREATE INDEX "UserRole_userId_scopeType_idx" ON "UserRole"("userId", "scopeType");

CREATE TABLE "MemberProfile" (
  "id" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "linkedUserId" UUID,
  "firstName" TEXT NOT NULL,
  "lastName" TEXT NOT NULL,
  "pool" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "assignedFunction" TEXT NOT NULL,
  "contactEmail" TEXT,
  "normalizedContactEmail" TEXT,
  "phone" TEXT,
  "languages" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status" TEXT NOT NULL DEFAULT 'Active',
  "version" INTEGER NOT NULL DEFAULT 1,
  "legacyAvailability" TEXT,
  "legacyTrainingStatus" TEXT,
  "legacyRosterStatus" TEXT,
  "legacyAssignedLeader" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById" UUID,
  "updatedById" UUID,
  CONSTRAINT "MemberProfile_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MemberProfile_status_check" CHECK ("status" IN ('Active', 'Inactive', 'Archived')),
  CONSTRAINT "MemberProfile_pool_check" CHECK ("pool" IN ('ZPP', 'TEC')),
  CONSTRAINT "MemberProfile_version_check" CHECK ("version" >= 1)
);

CREATE TABLE "OperationalGroup" (
  "id" TEXT NOT NULL,
  "operationalId" TEXT NOT NULL,
  "incidentId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "pool" TEXT NOT NULL,
  "functionName" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Active',
  "notes" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById" UUID,
  "updatedById" UUID,
  CONSTRAINT "OperationalGroup_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OperationalGroup_status_check" CHECK ("status" IN ('Active', 'Standby', 'Draft', 'Archived')),
  CONSTRAINT "OperationalGroup_pool_check" CHECK ("pool" IN ('ZPP', 'TEC', 'Mixed')),
  CONSTRAINT "OperationalGroup_version_check" CHECK ("version" >= 1)
);

CREATE TABLE "GroupMembership" (
  "id" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "memberProfileId" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'Member',
  "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "addedById" UUID,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "removedAt" TIMESTAMP(3),
  "removedById" UUID,
  CONSTRAINT "GroupMembership_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GroupRoleAssignment" (
  "id" TEXT NOT NULL,
  "userId" UUID NOT NULL,
  "roleId" UUID NOT NULL,
  "groupId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Active',
  "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "assignedBy" UUID,
  "revokedAt" TIMESTAMP(3),
  "revokedBy" UUID,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "GroupRoleAssignment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GroupRoleAssignment_status_check" CHECK ("status" IN ('Active', 'Revoked')),
  CONSTRAINT "GroupRoleAssignment_version_check" CHECK ("version" >= 1)
);

CREATE UNIQUE INDEX "MemberProfile_memberId_key" ON "MemberProfile"("memberId");
CREATE UNIQUE INDEX "MemberProfile_memberId_ci_key" ON "MemberProfile"(LOWER("memberId"));
CREATE UNIQUE INDEX "MemberProfile_active_linked_user_key" ON "MemberProfile"("linkedUserId") WHERE "linkedUserId" IS NOT NULL AND "status" <> 'Archived';
CREATE UNIQUE INDEX "MemberProfile_active_email_key" ON "MemberProfile"("normalizedContactEmail") WHERE "normalizedContactEmail" IS NOT NULL AND "status" <> 'Archived';
CREATE INDEX "MemberProfile_status_pool_updatedAt_idx" ON "MemberProfile"("status", "pool", "updatedAt");
CREATE INDEX "MemberProfile_assignedFunction_status_idx" ON "MemberProfile"("assignedFunction", "status");
CREATE INDEX "MemberProfile_linkedUserId_idx" ON "MemberProfile"("linkedUserId");

CREATE UNIQUE INDEX "OperationalGroup_operationalId_key" ON "OperationalGroup"("operationalId");
CREATE UNIQUE INDEX "OperationalGroup_active_name_incident_key" ON "OperationalGroup"("incidentId", LOWER("name")) WHERE "status" <> 'Archived';
CREATE INDEX "OperationalGroup_incident_status_updatedAt_idx" ON "OperationalGroup"("incidentId", "status", "updatedAt");
CREATE INDEX "OperationalGroup_incident_pool_function_idx" ON "OperationalGroup"("incidentId", "pool", "functionName");

CREATE UNIQUE INDEX "GroupMembership_active_member_key" ON "GroupMembership"("groupId", "memberProfileId") WHERE "removedAt" IS NULL;
CREATE UNIQUE INDEX "GroupMembership_active_leader_key" ON "GroupMembership"("groupId") WHERE "removedAt" IS NULL AND "role" = 'Leader';
CREATE INDEX "GroupMembership_group_removed_role_idx" ON "GroupMembership"("groupId", "removedAt", "role");
CREATE INDEX "GroupMembership_member_removed_idx" ON "GroupMembership"("memberProfileId", "removedAt");

CREATE UNIQUE INDEX "GroupRoleAssignment_active_scope_key" ON "GroupRoleAssignment"("userId", "roleId", "groupId") WHERE "status" = 'Active';
CREATE INDEX "GroupRoleAssignment_user_status_idx" ON "GroupRoleAssignment"("userId", "status");
CREATE INDEX "GroupRoleAssignment_group_status_idx" ON "GroupRoleAssignment"("groupId", "status");

ALTER TABLE "MemberProfile" ADD CONSTRAINT "MemberProfile_linkedUserId_fkey" FOREIGN KEY ("linkedUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MemberProfile" ADD CONSTRAINT "MemberProfile_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MemberProfile" ADD CONSTRAINT "MemberProfile_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OperationalGroup" ADD CONSTRAINT "OperationalGroup_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OperationalGroup" ADD CONSTRAINT "OperationalGroup_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OperationalGroup" ADD CONSTRAINT "OperationalGroup_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GroupMembership" ADD CONSTRAINT "GroupMembership_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "OperationalGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GroupMembership" ADD CONSTRAINT "GroupMembership_memberProfileId_fkey" FOREIGN KEY ("memberProfileId") REFERENCES "MemberProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GroupMembership" ADD CONSTRAINT "GroupMembership_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GroupMembership" ADD CONSTRAINT "GroupMembership_removedById_fkey" FOREIGN KEY ("removedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GroupRoleAssignment" ADD CONSTRAINT "GroupRoleAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GroupRoleAssignment" ADD CONSTRAINT "GroupRoleAssignment_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GroupRoleAssignment" ADD CONSTRAINT "GroupRoleAssignment_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "OperationalGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "protect_member_group_integrity"() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'MemberProfile' AND NEW."status" = 'Archived' AND OLD."status" <> 'Archived' AND EXISTS (
    SELECT 1 FROM "GroupMembership" WHERE "memberProfileId" = NEW."id" AND "removedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'ACTIVE_GROUP_MEMBERSHIP';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MemberProfile_archive_membership_guard"
BEFORE UPDATE OF "status" ON "MemberProfile"
FOR EACH ROW EXECUTE FUNCTION "protect_member_group_integrity"();

CREATE OR REPLACE FUNCTION "validate_active_group_membership"() RETURNS trigger AS $$
BEGIN
  IF NEW."removedAt" IS NULL THEN
    IF NOT EXISTS (SELECT 1 FROM "MemberProfile" WHERE "id" = NEW."memberProfileId" AND "status" <> 'Archived') THEN
      RAISE EXCEPTION 'MEMBER_NOT_ACTIVE';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "OperationalGroup" WHERE "id" = NEW."groupId" AND "status" <> 'Archived') THEN
      RAISE EXCEPTION 'GROUP_NOT_ACTIVE';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "GroupMembership_active_integrity_guard"
BEFORE INSERT OR UPDATE ON "GroupMembership"
FOR EACH ROW EXECUTE FUNCTION "validate_active_group_membership"();
