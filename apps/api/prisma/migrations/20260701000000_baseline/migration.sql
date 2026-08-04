CREATE SCHEMA IF NOT EXISTS "public";

CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "department" TEXT,
    "organizationId" UUID,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Organization" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "contactEmail" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Role" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "permissions" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserRole" (
    "userId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedBy" TEXT,
    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("userId","roleId")
);

CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "operationalId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "eventType" TEXT NOT NULL,
    "flightNumber" TEXT,
    "route" TEXT,
    "aircraftRegistration" TEXT,
    "airportLocation" TEXT,
    "description" TEXT,
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "createdById" UUID,
    "closedById" UUID,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Enquiry" (
    "id" UUID NOT NULL,
    "operationalId" TEXT NOT NULL,
    "sessionId" UUID NOT NULL,
    "caseId" TEXT,
    "contactChannel" TEXT NOT NULL,
    "callerName" TEXT NOT NULL,
    "callerPhone" TEXT,
    "callerEmail" TEXT,
    "callerLocation" TEXT,
    "preferredLanguage" TEXT,
    "claimedRelationship" TEXT,
    "passengerRecordId" UUID,
    "passengerFirstName" TEXT,
    "passengerLastName" TEXT,
    "passengerFlight" TEXT,
    "passengerRoute" TEXT,
    "lastKnownContact" TEXT,
    "enquiryType" TEXT NOT NULL,
    "urgency" TEXT NOT NULL DEFAULT 'Normal',
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'New',
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Enquiry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FamilyRecord" (
    "id" UUID NOT NULL,
    "operationalId" TEXT NOT NULL,
    "sessionId" UUID NOT NULL,
    "caseId" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "preferredContactChannel" TEXT,
    "preferredLanguage" TEXT,
    "location" TEXT,
    "claimedRelationship" TEXT,
    "passengerFirstName" TEXT,
    "passengerLastName" TEXT,
    "passengerFlight" TEXT,
    "verificationStatus" TEXT NOT NULL DEFAULT 'Unverified',
    "verificationNotes" TEXT,
    "immediateNeeds" TEXT,
    "questionsAsked" TEXT,
    "commitmentsMade" TEXT,
    "nextContactDue" TIMESTAMP(3),
    "assignedOfficer" TEXT,
    "notes" TEXT,
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FamilyRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PassengerRecord" (
    "id" UUID NOT NULL,
    "operationalId" TEXT NOT NULL,
    "sessionId" UUID NOT NULL,
    "caseId" TEXT,
    "personType" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "dateOfBirth" TIMESTAMP(3),
    "age" INTEGER,
    "gender" TEXT,
    "nationality" TEXT,
    "flightNumber" TEXT,
    "route" TEXT,
    "seat" TEXT,
    "pnr" TEXT,
    "ticketNumber" TEXT,
    "manifestVersion" TEXT,
    "source" TEXT NOT NULL,
    "travellingCompanions" TEXT,
    "conditionStatus" TEXT NOT NULL DEFAULT 'Unknown',
    "holdStatus" TEXT NOT NULL DEFAULT 'No hold',
    "srcConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PassengerRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MatchingRecord" (
    "id" UUID NOT NULL,
    "operationalId" TEXT NOT NULL,
    "sessionId" UUID NOT NULL,
    "caseId" TEXT,
    "enquiryId" UUID,
    "familyRecordId" UUID,
    "passengerRecordId" UUID,
    "status" TEXT NOT NULL DEFAULT 'Potential match',
    "matchScore" DOUBLE PRECISION,
    "matchBasis" TEXT,
    "verificationChecklist" JSONB,
    "holdCheck" TEXT NOT NULL DEFAULT 'No hold',
    "decisionNotes" TEXT,
    "coordinatorOverride" BOOLEAN NOT NULL DEFAULT false,
    "overrideReason" TEXT,
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MatchingRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReunificationReleaseRecord" (
    "id" UUID NOT NULL,
    "operationalId" TEXT NOT NULL,
    "sessionId" UUID NOT NULL,
    "matchId" UUID,
    "passengerRecordId" UUID,
    "familyRecordId" UUID,
    "actionType" TEXT NOT NULL DEFAULT 'Reunification',
    "status" TEXT NOT NULL DEFAULT 'Prepared',
    "releaseDestination" TEXT,
    "receivingParty" TEXT,
    "identityChecked" BOOLEAN NOT NULL DEFAULT false,
    "holdCleared" BOOLEAN NOT NULL DEFAULT false,
    "transportMode" TEXT,
    "authorizedById" UUID,
    "completedById" UUID,
    "completedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ReunificationReleaseRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WelfareRequest" (
    "id" UUID NOT NULL,
    "operationalId" TEXT NOT NULL,
    "sessionId" UUID NOT NULL,
    "caseId" TEXT,
    "relatedEnquiryId" UUID,
    "relatedFamilyRecordId" UUID,
    "relatedPassengerRecordId" UUID,
    "category" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'Normal',
    "requester" TEXT,
    "ownerAssignedTo" TEXT,
    "details" TEXT NOT NULL,
    "approvalStatus" TEXT NOT NULL DEFAULT 'Not required',
    "status" TEXT NOT NULL DEFAULT 'Open',
    "closureNote" TEXT,
    "notes" TEXT,
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WelfareRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AssignmentTask" (
    "id" UUID NOT NULL,
    "operationalId" TEXT NOT NULL,
    "sessionId" UUID NOT NULL,
    "caseId" TEXT,
    "title" TEXT NOT NULL,
    "details" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Open',
    "priority" TEXT NOT NULL DEFAULT 'Normal',
    "ownerAssignedTo" TEXT,
    "assignedUserId" UUID,
    "assignedUserDisplayName" TEXT,
    "relatedFunction" TEXT,
    "linkedRecord" TEXT,
    "dueAt" TIMESTAMP(3),
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AssignmentTask_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CaseTimelineEvent" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "caseId" TEXT,
    "eventType" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "metadata" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CaseTimelineEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ImportBatch" (
    "id" UUID NOT NULL,
    "operationalId" TEXT NOT NULL,
    "sessionId" UUID,
    "importType" TEXT NOT NULL,
    "sourceFilename" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Validated',
    "totalRecords" INTEGER NOT NULL DEFAULT 0,
    "validRecords" INTEGER NOT NULL DEFAULT 0,
    "invalidRecords" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StoredFile" (
    "id" UUID NOT NULL,
    "operationalId" TEXT NOT NULL,
    "sessionId" UUID,
    "importBatchId" UUID,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" BIGINT NOT NULL DEFAULT 0,
    "storageProvider" TEXT NOT NULL DEFAULT 'local',
    "storageKey" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StoredFile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExerciseInject" (
    "id" UUID NOT NULL,
    "operationalId" TEXT NOT NULL,
    "sessionId" UUID NOT NULL,
    "injectNumber" INTEGER NOT NULL,
    "scenarioTime" TIMESTAMP(3),
    "targetRole" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "expectedAction" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Planned',
    "releasedById" UUID,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ExerciseInject_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExerciseObservation" (
    "id" UUID NOT NULL,
    "operationalId" TEXT NOT NULL,
    "sessionId" UUID NOT NULL,
    "area" TEXT NOT NULL,
    "observation" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'Low',
    "recommendation" TEXT,
    "owner" TEXT,
    "includeInAar" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'Open',
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ExerciseObservation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Dictionary" (
    "id" UUID NOT NULL,
    "profile" TEXT NOT NULL DEFAULT 'lot-zpp',
    "category" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Dictionary_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "sessionId" UUID,
    "actorId" UUID,
    "actorEmail" TEXT,
    "summary" TEXT NOT NULL,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE INDEX "User_organizationId_idx" ON "User"("organizationId");
CREATE UNIQUE INDEX "Organization_key_key" ON "Organization"("key");
CREATE INDEX "Organization_status_name_idx" ON "Organization"("status", "name");
CREATE UNIQUE INDEX "Role_name_key" ON "Role"("name");
CREATE UNIQUE INDEX "Session_operationalId_key" ON "Session"("operationalId");
CREATE INDEX "Session_mode_status_idx" ON "Session"("mode", "status");
CREATE UNIQUE INDEX "Session_one_active_real_idx" ON "Session"("mode") WHERE "mode" = 'REAL' AND "status" = 'Active';
CREATE UNIQUE INDEX "Enquiry_operationalId_key" ON "Enquiry"("operationalId");
CREATE INDEX "Enquiry_sessionId_status_idx" ON "Enquiry"("sessionId", "status");
CREATE INDEX "Enquiry_caseId_idx" ON "Enquiry"("caseId");
CREATE INDEX "Enquiry_passengerRecordId_idx" ON "Enquiry"("passengerRecordId");
CREATE UNIQUE INDEX "FamilyRecord_operationalId_key" ON "FamilyRecord"("operationalId");
CREATE INDEX "FamilyRecord_sessionId_verificationStatus_idx" ON "FamilyRecord"("sessionId", "verificationStatus");
CREATE INDEX "FamilyRecord_caseId_idx" ON "FamilyRecord"("caseId");
CREATE UNIQUE INDEX "PassengerRecord_operationalId_key" ON "PassengerRecord"("operationalId");
CREATE INDEX "PassengerRecord_sessionId_conditionStatus_idx" ON "PassengerRecord"("sessionId", "conditionStatus");
CREATE INDEX "PassengerRecord_caseId_idx" ON "PassengerRecord"("caseId");
CREATE UNIQUE INDEX "MatchingRecord_operationalId_key" ON "MatchingRecord"("operationalId");
CREATE INDEX "MatchingRecord_sessionId_status_idx" ON "MatchingRecord"("sessionId", "status");
CREATE INDEX "MatchingRecord_caseId_idx" ON "MatchingRecord"("caseId");
CREATE UNIQUE INDEX "ReunificationReleaseRecord_operationalId_key" ON "ReunificationReleaseRecord"("operationalId");
CREATE INDEX "ReunificationReleaseRecord_sessionId_status_idx" ON "ReunificationReleaseRecord"("sessionId", "status");
CREATE UNIQUE INDEX "WelfareRequest_operationalId_key" ON "WelfareRequest"("operationalId");
CREATE INDEX "WelfareRequest_sessionId_status_idx" ON "WelfareRequest"("sessionId", "status");
CREATE INDEX "WelfareRequest_caseId_idx" ON "WelfareRequest"("caseId");
CREATE UNIQUE INDEX "AssignmentTask_operationalId_key" ON "AssignmentTask"("operationalId");
CREATE INDEX "AssignmentTask_sessionId_status_idx" ON "AssignmentTask"("sessionId", "status");
CREATE INDEX "AssignmentTask_caseId_idx" ON "AssignmentTask"("caseId");
CREATE INDEX "AssignmentTask_ownerAssignedTo_idx" ON "AssignmentTask"("ownerAssignedTo");
CREATE INDEX "AssignmentTask_assignedUserId_idx" ON "AssignmentTask"("assignedUserId");
CREATE INDEX "CaseTimelineEvent_sessionId_caseId_occurredAt_idx" ON "CaseTimelineEvent"("sessionId", "caseId", "occurredAt");
CREATE UNIQUE INDEX "ImportBatch_operationalId_key" ON "ImportBatch"("operationalId");
CREATE UNIQUE INDEX "StoredFile_operationalId_key" ON "StoredFile"("operationalId");
CREATE UNIQUE INDEX "ExerciseInject_operationalId_key" ON "ExerciseInject"("operationalId");
CREATE INDEX "ExerciseInject_sessionId_status_idx" ON "ExerciseInject"("sessionId", "status");
CREATE UNIQUE INDEX "ExerciseInject_sessionId_injectNumber_key" ON "ExerciseInject"("sessionId", "injectNumber");
CREATE UNIQUE INDEX "ExerciseObservation_operationalId_key" ON "ExerciseObservation"("operationalId");
CREATE INDEX "ExerciseObservation_sessionId_severity_idx" ON "ExerciseObservation"("sessionId", "severity");
CREATE INDEX "Dictionary_profile_category_isActive_idx" ON "Dictionary"("profile", "category", "isActive");
CREATE UNIQUE INDEX "Dictionary_profile_category_key_key" ON "Dictionary"("profile", "category", "key");
CREATE INDEX "AuditLog_sessionId_createdAt_idx" ON "AuditLog"("sessionId", "createdAt");
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Session" ADD CONSTRAINT "Session_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Session" ADD CONSTRAINT "Session_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Enquiry" ADD CONSTRAINT "Enquiry_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Enquiry" ADD CONSTRAINT "Enquiry_passengerRecordId_fkey" FOREIGN KEY ("passengerRecordId") REFERENCES "PassengerRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FamilyRecord" ADD CONSTRAINT "FamilyRecord_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PassengerRecord" ADD CONSTRAINT "PassengerRecord_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MatchingRecord" ADD CONSTRAINT "MatchingRecord_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MatchingRecord" ADD CONSTRAINT "MatchingRecord_enquiryId_fkey" FOREIGN KEY ("enquiryId") REFERENCES "Enquiry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MatchingRecord" ADD CONSTRAINT "MatchingRecord_familyRecordId_fkey" FOREIGN KEY ("familyRecordId") REFERENCES "FamilyRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MatchingRecord" ADD CONSTRAINT "MatchingRecord_passengerRecordId_fkey" FOREIGN KEY ("passengerRecordId") REFERENCES "PassengerRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MatchingRecord" ADD CONSTRAINT "MatchingRecord_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReunificationReleaseRecord" ADD CONSTRAINT "ReunificationReleaseRecord_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReunificationReleaseRecord" ADD CONSTRAINT "ReunificationReleaseRecord_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "MatchingRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReunificationReleaseRecord" ADD CONSTRAINT "ReunificationReleaseRecord_passengerRecordId_fkey" FOREIGN KEY ("passengerRecordId") REFERENCES "PassengerRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReunificationReleaseRecord" ADD CONSTRAINT "ReunificationReleaseRecord_familyRecordId_fkey" FOREIGN KEY ("familyRecordId") REFERENCES "FamilyRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReunificationReleaseRecord" ADD CONSTRAINT "ReunificationReleaseRecord_authorizedById_fkey" FOREIGN KEY ("authorizedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReunificationReleaseRecord" ADD CONSTRAINT "ReunificationReleaseRecord_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WelfareRequest" ADD CONSTRAINT "WelfareRequest_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WelfareRequest" ADD CONSTRAINT "WelfareRequest_relatedEnquiryId_fkey" FOREIGN KEY ("relatedEnquiryId") REFERENCES "Enquiry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WelfareRequest" ADD CONSTRAINT "WelfareRequest_relatedFamilyRecordId_fkey" FOREIGN KEY ("relatedFamilyRecordId") REFERENCES "FamilyRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WelfareRequest" ADD CONSTRAINT "WelfareRequest_relatedPassengerRecordId_fkey" FOREIGN KEY ("relatedPassengerRecordId") REFERENCES "PassengerRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AssignmentTask" ADD CONSTRAINT "AssignmentTask_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssignmentTask" ADD CONSTRAINT "AssignmentTask_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CaseTimelineEvent" ADD CONSTRAINT "CaseTimelineEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExerciseInject" ADD CONSTRAINT "ExerciseInject_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExerciseObservation" ADD CONSTRAINT "ExerciseObservation_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
