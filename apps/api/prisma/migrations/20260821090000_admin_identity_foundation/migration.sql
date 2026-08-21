-- Foundation Stage 14: one durable identity/access graph.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "User" GROUP BY lower(btrim("email")) HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot normalize User email: case-insensitive duplicates exist';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "Role" GROUP BY lower(btrim("name")) HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot normalize Role name: normalized duplicates exist';
  END IF;
END $$;

ALTER TABLE "User"
  ADD COLUMN "normalizedEmail" TEXT,
  ADD COLUMN "employeeId" TEXT,
  ADD COLUMN "authenticationPolicy" TEXT NOT NULL DEFAULT 'SSO_ONLY',
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "activatedAt" TIMESTAMP(3),
  ADD COLUMN "suspendedAt" TIMESTAMP(3),
  ADD COLUMN "archivedAt" TIMESTAMP(3),
  ADD COLUMN "restoredAt" TIMESTAMP(3),
  ADD COLUMN "lastSuccessfulSignInAt" TIMESTAMP(3),
  ADD COLUMN "createdById" UUID,
  ADD COLUMN "updatedById" UUID,
  ADD COLUMN "suspendedById" UUID,
  ADD COLUMN "archivedById" UUID,
  ADD COLUMN "restoredById" UUID,
  ADD COLUMN "suspensionReason" TEXT,
  ADD COLUMN "archiveReason" TEXT;

UPDATE "User"
SET "normalizedEmail" = lower(btrim("email")),
    "email" = btrim("email"),
    "status" = CASE lower(btrim("status"))
      WHEN 'pending' THEN 'Pending'
      WHEN 'active' THEN 'Active'
      WHEN 'suspended' THEN 'Suspended'
      WHEN 'archived' THEN 'Archived'
      ELSE 'Pending'
    END,
    "activatedAt" = CASE WHEN lower(btrim("status")) = 'active' THEN COALESCE("updatedAt", "createdAt") ELSE NULL END;

ALTER TABLE "User" ALTER COLUMN "normalizedEmail" SET NOT NULL;
ALTER TABLE "User" ALTER COLUMN "status" SET DEFAULT 'Active';
ALTER TABLE "User" ALTER COLUMN "normalizedEmail" SET DEFAULT '';
CREATE UNIQUE INDEX "User_normalizedEmail_key" ON "User"("normalizedEmail");
CREATE INDEX "User_status_displayName_id_idx" ON "User"("status", "displayName", "id");
ALTER TABLE "User" ADD CONSTRAINT "User_status_check" CHECK ("status" IN ('Pending', 'Active', 'Suspended', 'Archived'));
ALTER TABLE "User" ADD CONSTRAINT "User_authenticationPolicy_check" CHECK ("authenticationPolicy" IN ('SSO_ONLY', 'PASSWORD_ONLY', 'SSO_OR_PASSWORD'));
ALTER TABLE "User" ADD CONSTRAINT "User_version_check" CHECK ("version" > 0);
ALTER TABLE "User" ADD CONSTRAINT "User_normalizedEmail_check" CHECK ("normalizedEmail" = lower(btrim("email")));

ALTER TABLE "Organization"
  ADD COLUMN "normalizedKey" TEXT,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "createdById" UUID,
  ADD COLUMN "updatedById" UUID,
  ADD COLUMN "archivedAt" TIMESTAMP(3),
  ADD COLUMN "archivedById" UUID;
UPDATE "Organization"
SET "normalizedKey" = lower(btrim("key")),
    "key" = btrim("key"),
    "status" = CASE WHEN lower(btrim("status")) = 'archived' THEN 'Archived' ELSE 'Active' END;
ALTER TABLE "Organization" ALTER COLUMN "normalizedKey" SET NOT NULL;
ALTER TABLE "Organization" ALTER COLUMN "status" SET DEFAULT 'Active';
ALTER TABLE "Organization" ALTER COLUMN "normalizedKey" SET DEFAULT '';
CREATE UNIQUE INDEX "Organization_normalizedKey_key" ON "Organization"("normalizedKey");
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_status_check" CHECK ("status" IN ('Active', 'Archived'));
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_normalizedKey_check" CHECK ("normalizedKey" = lower(btrim("key")));

ALTER TABLE "Role"
  ADD COLUMN "normalizedName" TEXT,
  ADD COLUMN "scopeTypes" TEXT[] NOT NULL DEFAULT ARRAY['GLOBAL']::TEXT[],
  ADD COLUMN "pool" TEXT NOT NULL DEFAULT 'ALL',
  ADD COLUMN "protected" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "custom" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "operationalRole" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'Active',
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "createdById" UUID,
  ADD COLUMN "updatedById" UUID,
  ADD COLUMN "archivedAt" TIMESTAMP(3),
  ADD COLUMN "archivedById" UUID;
UPDATE "Role" SET "normalizedName" = lower(btrim("name")), "name" = lower(btrim("name"));
ALTER TABLE "Role" ALTER COLUMN "normalizedName" SET NOT NULL;
ALTER TABLE "Role" ALTER COLUMN "normalizedName" SET DEFAULT '';
CREATE UNIQUE INDEX "Role_normalizedName_key" ON "Role"("normalizedName");
ALTER TABLE "Role" ADD CONSTRAINT "Role_status_check" CHECK ("status" IN ('Active', 'Archived'));
ALTER TABLE "Role" ADD CONSTRAINT "Role_normalizedName_check" CHECK ("normalizedName" = lower(btrim("name")));

ALTER TABLE "UserRole" ADD COLUMN "id" UUID NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX "UserRole_id_key" ON "UserRole"("id");

ALTER TABLE "GroupRoleAssignment" ADD COLUMN "revokeReason" TEXT;
CREATE UNIQUE INDEX "GroupRoleAssignment_active_key"
  ON "GroupRoleAssignment"("userId", "roleId", "groupId") WHERE "status" = 'Active';

CREATE TABLE "RoleAssignmentHistory" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "assignmentId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "roleId" UUID NOT NULL,
  "scopeType" TEXT NOT NULL,
  "scopeId" TEXT,
  "action" TEXT NOT NULL,
  "actorUserId" UUID,
  "reason" TEXT,
  "assignmentVersion" INTEGER NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RoleAssignmentHistory_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RoleAssignmentHistory_scope_check" CHECK ("scopeType" IN ('GLOBAL', 'GROUP')),
  CONSTRAINT "RoleAssignmentHistory_action_check" CHECK ("action" IN ('ASSIGNED', 'REVOKED'))
);
CREATE INDEX "RoleAssignmentHistory_userId_occurredAt_idx" ON "RoleAssignmentHistory"("userId", "occurredAt");
CREATE INDEX "RoleAssignmentHistory_assignmentId_occurredAt_idx" ON "RoleAssignmentHistory"("assignmentId", "occurredAt");

CREATE TABLE "PermissionOverride" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "permission" TEXT NOT NULL,
  "effect" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "reason" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById" UUID NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "revokedById" UUID,
  "revokeReason" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "PermissionOverride_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PermissionOverride_effect_check" CHECK ("effect" IN ('GRANT', 'DENY')),
  CONSTRAINT "PermissionOverride_version_check" CHECK ("version" > 0),
  CONSTRAINT "PermissionOverride_user_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "PermissionOverride_userId_active_expiresAt_idx" ON "PermissionOverride"("userId", "active", "expiresAt");
CREATE UNIQUE INDEX "PermissionOverride_active_key"
  ON "PermissionOverride"("userId", "permission", "effect") WHERE "active" = true AND "revokedAt" IS NULL;

CREATE TABLE "ExternalIdentity" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "providerType" TEXT NOT NULL,
  "issuer" TEXT NOT NULL,
  "tenantId" TEXT,
  "providerSubject" TEXT NOT NULL,
  "directoryObjectId" TEXT,
  "authenticationMethod" TEXT NOT NULL,
  "emailSnapshot" TEXT,
  "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "linkedById" UUID,
  "lastSeenAt" TIMESTAMP(3),
  "lastSuccessfulAuthenticationAt" TIMESTAMP(3),
  "disabledAt" TIMESTAMP(3),
  "disabledById" UUID,
  "disableReason" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "ExternalIdentity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ExternalIdentity_version_check" CHECK ("version" > 0),
  CONSTRAINT "ExternalIdentity_user_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ExternalIdentity_provider_subject_key" ON "ExternalIdentity"("providerType", "issuer", "providerSubject");
CREATE UNIQUE INDEX "ExternalIdentity_directory_object_key" ON "ExternalIdentity"("providerType", "tenantId", "directoryObjectId") WHERE "tenantId" IS NOT NULL AND "directoryObjectId" IS NOT NULL;
CREATE INDEX "ExternalIdentity_userId_disabledAt_idx" ON "ExternalIdentity"("userId", "disabledAt");

CREATE TABLE "UserInvitation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "invitedEmailSnapshot" TEXT NOT NULL,
  "intendedAuthenticationPolicy" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Prepared',
  "tokenHash" TEXT NOT NULL,
  "tokenExpiresAt" TIMESTAMP(3) NOT NULL,
  "createdById" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentAt" TIMESTAMP(3),
  "acceptedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "revokedById" UUID,
  "revokeReason" TEXT,
  "resendGeneration" INTEGER NOT NULL DEFAULT 1,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "UserInvitation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UserInvitation_user_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "UserInvitation_status_check" CHECK ("status" IN ('Prepared', 'Sent', 'Accepted', 'Revoked')),
  CONSTRAINT "UserInvitation_policy_check" CHECK ("intendedAuthenticationPolicy" IN ('SSO_ONLY', 'PASSWORD_ONLY', 'SSO_OR_PASSWORD')),
  CONSTRAINT "UserInvitation_generation_check" CHECK ("resendGeneration" > 0 AND "version" > 0)
);
CREATE UNIQUE INDEX "UserInvitation_tokenHash_key" ON "UserInvitation"("tokenHash");
CREATE INDEX "UserInvitation_userId_createdAt_idx" ON "UserInvitation"("userId", "createdAt");
CREATE INDEX "UserInvitation_status_tokenExpiresAt_idx" ON "UserInvitation"("status", "tokenExpiresAt");
CREATE UNIQUE INDEX "UserInvitation_open_email_key"
  ON "UserInvitation"((lower(btrim("invitedEmailSnapshot")))) WHERE "status" IN ('Prepared', 'Sent');

CREATE TABLE "IdentityOperation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "operationId" UUID NOT NULL,
  "targetUserId" UUID,
  "command" TEXT NOT NULL,
  "commandFingerprint" TEXT NOT NULL,
  "resultEntityType" TEXT NOT NULL,
  "resultEntityId" TEXT NOT NULL,
  "resultVersion" INTEGER NOT NULL,
  "requestId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IdentityOperation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IdentityOperation_targetUser_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "IdentityOperation_operationId_key" ON "IdentityOperation"("operationId");
CREATE INDEX "IdentityOperation_targetUserId_createdAt_idx" ON "IdentityOperation"("targetUserId", "createdAt");

DROP INDEX "MemberProfile_linkedUserId_idx";
CREATE UNIQUE INDEX "MemberProfile_linkedUserId_key" ON "MemberProfile"("linkedUserId") WHERE "linkedUserId" IS NOT NULL;

-- Protected definitions are code-owned. Existing catalogue names are normalized first.
UPDATE "Role" SET
  "protected" = true,
  "custom" = false
WHERE "normalizedName" IN ('system-admin', 'zpp-coordinator', 'tec-coordinator', 'call-centre-agent', 'family-support-agent', 'reunification-officer', 'viewer');

-- Current global assignments receive immutable history rows.
INSERT INTO "RoleAssignmentHistory" ("assignmentId", "userId", "roleId", "scopeType", "action", "actorUserId", "assignmentVersion", "occurredAt")
SELECT "id", "userId", "roleId", 'GLOBAL', 'ASSIGNED', NULL, 1, "assignedAt" FROM "UserRole";

CREATE FUNCTION "identity_normalize_keys"() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'User' THEN NEW."normalizedEmail" := lower(btrim(NEW."email")); END IF;
  IF TG_TABLE_NAME = 'Role' THEN NEW."normalizedName" := lower(btrim(NEW."name")); END IF;
  IF TG_TABLE_NAME = 'Organization' THEN NEW."normalizedKey" := lower(btrim(NEW."key")); END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "User_normalize_email" BEFORE INSERT OR UPDATE OF "email", "normalizedEmail" ON "User" FOR EACH ROW EXECUTE FUNCTION "identity_normalize_keys"();
CREATE TRIGGER "Role_normalize_name" BEFORE INSERT OR UPDATE OF "name", "normalizedName" ON "Role" FOR EACH ROW EXECUTE FUNCTION "identity_normalize_keys"();
CREATE TRIGGER "Organization_normalize_key" BEFORE INSERT OR UPDATE OF "key", "normalizedKey" ON "Organization" FOR EACH ROW EXECUTE FUNCTION "identity_normalize_keys"();

-- Group role assignment and Group archive share a database row lock. This is
-- the final invariant even when future writers bypass the current services.
CREATE FUNCTION "identity_guard_group_role"() RETURNS trigger AS $$
DECLARE group_status TEXT;
BEGIN
  IF NEW."status" = 'Active' THEN
    SELECT "status" INTO group_status FROM "OperationalGroup" WHERE "id" = NEW."groupId" FOR UPDATE;
    IF group_status IS NULL OR group_status = 'Archived' THEN
      RAISE EXCEPTION 'active group role requires an active group' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "GroupRoleAssignment_active_group_guard"
  BEFORE INSERT OR UPDATE OF "status", "groupId" ON "GroupRoleAssignment"
  FOR EACH ROW EXECUTE FUNCTION "identity_guard_group_role"();

CREATE FUNCTION "identity_guard_group_archive"() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = 'Archived' AND OLD."status" IS DISTINCT FROM NEW."status" AND EXISTS (
    SELECT 1 FROM "GroupRoleAssignment" WHERE "groupId" = NEW."id" AND "status" = 'Active'
  ) THEN
    RAISE EXCEPTION 'archive requires group role revocation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "OperationalGroup_archive_role_guard"
  BEFORE UPDATE OF "status" ON "OperationalGroup"
  FOR EACH ROW EXECUTE FUNCTION "identity_guard_group_archive"();
