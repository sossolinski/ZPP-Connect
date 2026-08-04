import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Router } from "express";
import type { NextFunction, Request } from "express";
import {
  authenticationPolicies,
  defaultOrganizations,
  defaultProfile,
  defaultRoles,
  dictionaries,
  permissions,
  userInvitationStatuses,
  type AuthenticationMethod,
  type AuthenticationPolicy,
  type Permission,
  type RoleScopeType,
  type UserInvitationStatus,
  workflowStates
} from "@zpp/shared";
import {
  canonicalRoleName,
  duplicateActiveRoleAssignment,
  effectiveAccessForUser,
  permissionsForRoleNames,
  roleDisplayName,
  rolePermissions,
  validateRoleAssignment,
  type AccessGroup,
  type PermissionOverride,
  type RoleAssignment,
  type RoleDefinition
} from "./access-control.js";
import { ActiveEventError, createActiveEventService } from "./active-event.js";
import { createMemberDirectoryRepository, DirectoryError } from "./member-directory.js";
import type { DirectoryActor } from "./member-directory.js";
import { createDocumentRepository } from "./documents.js";
import { normalizeRow, parseWorkbook, workbookBuffer } from "./exporters.js";
import { createNotificationService } from "./notifications.js";
import { createReadinessService } from "./readiness.js";
import { createRosteringRepository } from "./rostering.js";
import type { RosterStatus } from "./rostering.js";
import { permissionScope } from "./scope-policy.js";
import { createTrainingRepository } from "./training.js";
import { upload } from "./storage.js";
import { HttpError } from "./errors.js";
import type { AuthenticatedUser } from "./types.js";
import { authenticate } from "./auth.js";
import { config } from "./config.js";
import { createIncidentRouter } from "./modules/incidents/incident-router.js";
import { createIncidentService } from "./modules/incidents/incident-service.js";
import { createMemoryIncidentRepository } from "./modules/incidents/memory-incident-repository.js";
import type { IncidentRepository } from "./modules/incidents/incident-repository.js";
import { createEnquiryRouter } from "./modules/enquiries/enquiry-router.js";
import { createEnquiryService } from "./modules/enquiries/enquiry-service.js";
import { createMemoryEnquiryRepository } from "./modules/enquiries/memory-enquiry-repository.js";
import type { EnquiryRepository } from "./modules/enquiries/enquiry-repository.js";
import { createIncidentAccessService } from "./modules/incident-access/incident-access-service.js";
import { createMemoryIncidentAccessRepository } from "./modules/incident-access/memory-incident-access-repository.js";
import type { IncidentAccessRepository } from "./modules/incident-access/incident-access-repository.js";
import type { MemoryIncidentAssignment } from "./modules/incident-access/memory-incident-access-repository.js";
import { createIncidentAssignmentRouter } from "./modules/incident-assignments/incident-assignment-router.js";
import { createIncidentAssignmentService } from "./modules/incident-assignments/incident-assignment-service.js";
import { createMemoryIncidentAssignmentRepository } from "./modules/incident-assignments/memory-incident-assignment-repository.js";
import type { IncidentAssignmentRepository } from "./modules/incident-assignments/incident-assignment-repository.js";
import { createPassengerRouter } from "./modules/passengers/passenger-router.js";
import { createPassengerService } from "./modules/passengers/passenger-service.js";
import { createMemoryPassengerRepository } from "./modules/passengers/memory-passenger-repository.js";
import type { PassengerRepository } from "./modules/passengers/passenger-repository.js";
import type { PassengerActor, PassengerImportInput } from "./modules/passengers/passenger-types.js";
import { validatePassengerManifestRows } from "./modules/passengers/passenger-import.js";

type Row = Record<string, any>;
type AccountStatus = "Pending" | "Active" | "Suspended" | "Archived";
type AccountLifecycleAction = "activate" | "suspend" | "archive" | "restore";
type ProductAuthenticationMethod = Extract<AuthenticationMethod, "MICROSOFT_SSO" | "EMAIL_PASSWORD">;
type DemoOrganization = Row & {
  id: string;
  key: string;
  name: string;
  type?: string | null;
  status?: string | null;
  contactEmail?: string | null;
  description?: string | null;
  createdAt: string;
  updatedAt: string;
};
type DemoUserAccount = {
  id: string;
  email: string;
  displayName: string;
  employeeId?: string | null;
  department: string;
  organization: DemoOrganization;
  roles: string[];
  status: AccountStatus;
  authenticationPolicy: AuthenticationPolicy;
  linkedMemberProfileId?: string | null;
  createdAt: string;
  updatedAt: string;
  activatedAt?: string | null;
  suspendedAt?: string | null;
  archivedAt?: string | null;
  restoredAt?: string | null;
  lastSuccessfulSignInAt?: string | null;
  createdByUserId?: string | null;
  updatedByUserId?: string | null;
  version: number;
};
type DemoRoleDefinition = RoleDefinition & {
  id: string;
  protected: boolean;
  custom: boolean;
  operationalRole?: boolean;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  version: number;
};
type DemoUserInvitation = {
  id: string;
  userId: string;
  invitedEmailSnapshot: string;
  intendedAuthenticationPolicy: AuthenticationPolicy;
  status: UserInvitationStatus;
  tokenHash: string;
  tokenExpiresAt: string;
  createdByUserId: string;
  createdAt: string;
  sentAt?: string | null;
  acceptedAt?: string | null;
  revokedAt?: string | null;
  revokedByUserId?: string | null;
  revokeReason?: string | null;
  resendGeneration: number;
  version: number;
  history: Array<{
    status: UserInvitationStatus;
    action: string;
    actorUserId?: string | null;
    reason?: string | null;
    createdAt: string;
    resendGeneration: number;
  }>;
};
type DemoExternalIdentity = {
  id: string;
  userId: string;
  providerType: "LOCAL_DEV" | "DEVELOPMENT";
  provider?: string;
  realmId: string;
  tenantId?: string;
  providerSubject: string;
  subject?: string;
  authenticationMethod: AuthenticationMethod;
  emailSnapshot: string;
  linkedAt: string;
  createdAt: string;
  lastSeenAt?: string | null;
  lastSuccessfulAuthenticationAt?: string | null;
  disabledAt?: string | null;
  invitationId?: string | null;
  version: number;
};
type LocalAuthSession = {
  id: string;
  token: string;
  userId: string;
  authenticationMethod: AuthenticationMethod;
  createdAt: string;
  lastSeenAt: string;
  revokedAt?: string | null;
};

const now = () => new Date().toISOString();
const completedMatchStatuses = new Set<string>(workflowStates.completedMatchStatuses);
const pendingMatchStatuses = new Set<string>(workflowStates.pendingMatchStatuses);
const terminalStatuses = new Set<string>(workflowStates.terminalRequestStatuses);
let memberDirectoryForAdmin: ReturnType<typeof createMemberDirectoryRepository> | undefined;
let rosteringForAdmin: ReturnType<typeof createRosteringRepository> | undefined;
let notificationsForAdmin: ReturnType<typeof createNotificationService> | undefined;

function isNoHold(value?: string | null) {
  return !value || value === "No hold";
}

function matchHasActiveHold(match: Row) {
  return !isNoHold(match.holdCheck) || match.status === "Hold / escalate";
}

function buildDashboardAggregates(sessionId: string, openRequests: number, urgentWelfare: number) {
  const sessionPassengers = passengerRecords.filter((item) => item.sessionId === sessionId);
  const sessionMatches = matchingRecords.filter((item) => item.sessionId === sessionId);
  const sessionFamilies = familyRecords.filter((item) => item.sessionId === sessionId);
  const sessionEnquiries = enquiries.filter((item) => item.sessionId === sessionId);
  const sessionReleases = releases.filter((item) => item.sessionId === sessionId);
  const matchesByPassenger = new Map<string, Row[]>();
  const enquiriesByPassenger = new Map<string, Row[]>();

  for (const match of sessionMatches) {
    if (!match.passengerRecordId) continue;
    const current = matchesByPassenger.get(match.passengerRecordId) ?? [];
    current.push(match);
    matchesByPassenger.set(match.passengerRecordId, current);
  }
  for (const enquiry of sessionEnquiries) {
    if (!enquiry.passengerRecordId) continue;
    const current = enquiriesByPassenger.get(enquiry.passengerRecordId) ?? [];
    current.push(enquiry);
    enquiriesByPassenger.set(enquiry.passengerRecordId, current);
  }

  const matchingProgress = {
    totalPax: sessionPassengers.length,
    done: 0,
    inReview: 0,
    onHold: 0,
    noCandidate: 0,
    rejectedOnly: 0,
    completionRate: 0,
    slices: [] as Row[]
  };

  let reviewedTotal = 0;
  let readyForRelease = 0;
  for (const passenger of sessionPassengers) {
    const passengerMatches = matchesByPassenger.get(passenger.id) ?? [];
    const passengerEnquiries = enquiriesByPassenger.get(passenger.id) ?? [];
    if (passenger.srcConfirmed || passengerMatches.length > 0 || passengerEnquiries.length > 0) reviewedTotal += 1;

    const hasHold = !isNoHold(passenger.holdStatus) || passengerMatches.some(matchHasActiveHold);
    const hasCompleted = passengerMatches.some((match) => completedMatchStatuses.has(match.status) && !matchHasActiveHold(match));
    const hasPending = passengerMatches.some((match) => pendingMatchStatuses.has(match.status));
    const hasRejectedOnly = passengerMatches.length > 0 && passengerMatches.every((match) => match.status === "Rejected");
    if (passengerMatches.some((match) => match.status === "Verified match" && !matchHasActiveHold(match))) readyForRelease += 1;

    if (hasCompleted) matchingProgress.done += 1;
    else if (hasHold) matchingProgress.onHold += 1;
    else if (hasPending) matchingProgress.inReview += 1;
    else if (hasRejectedOnly) matchingProgress.rejectedOnly += 1;
    else matchingProgress.noCandidate += 1;
  }

  matchingProgress.completionRate = matchingProgress.totalPax ? Math.round((matchingProgress.done / matchingProgress.totalPax) * 100) : 0;
  matchingProgress.slices = [
    { key: "done", label: "Verified / ready", value: matchingProgress.done, tone: "success", color: "#059669" },
    { key: "inReview", label: "In review", value: matchingProgress.inReview, tone: "info", color: "#2563eb" },
    { key: "onHold", label: "On hold", value: matchingProgress.onHold, tone: "warning", color: "#f59e0b" },
    { key: "noCandidate", label: "No candidate", value: matchingProgress.noCandidate, tone: "neutral", color: "#94a3b8" },
    { key: "rejectedOnly", label: "Rejected only", value: matchingProgress.rejectedOnly, tone: "danger", color: "#dc2626" }
  ];

  const passengerTypeCount = sessionPassengers.filter((passenger) => passenger.personType === "Passenger").length;
  const crewTypeCount = sessionPassengers.filter((passenger) => passenger.personType === "Crew").length;
  const sourceCounts = sessionPassengers.reduce<Record<string, number>>((acc, passenger) => {
    const source = passenger.source || "Unknown";
    acc[source] = (acc[source] ?? 0) + 1;
    return acc;
  }, {});
  const linkedFamilyIds = new Set(sessionMatches.map((match) => match.familyRecordId).filter(Boolean));

  return {
    manifestCoverage: {
      expectedTotal: sessionPassengers.length,
      inDatabaseTotal: sessionPassengers.length,
      notLoadedTotal: 0,
      invalidTotal: 0,
      reviewedTotal,
      notReviewedTotal: Math.max(0, sessionPassengers.length - reviewedTotal),
      passengersInDatabase: passengerTypeCount,
      crewInDatabase: crewTypeCount,
      unknownTypeInDatabase: Math.max(0, sessionPassengers.length - passengerTypeCount - crewTypeCount),
      sourceBreakdown: Object.entries(sourceCounts).map(([label, value]) => ({ label, value }))
    },
    matchingProgress,
    workRemaining: {
      noCandidate: matchingProgress.noCandidate,
      pendingMatch: matchingProgress.inReview,
      activeHold: matchingProgress.onHold,
      readyForRelease,
      urgentWelfare,
      openRequests,
      unverifiedFamily: sessionFamilies.filter((family) => family.verificationStatus !== "Verified").length,
      unlinkedFamily: sessionFamilies.filter((family) => !linkedFamilyIds.has(family.id)).length,
      unlinkedEnquiries: sessionEnquiries.filter((enquiry) => !terminalStatuses.has(enquiry.status) && !sessionMatches.some((match) => match.enquiryId === enquiry.id)).length
    },
    dataQuality: {
      missingCaseId: sessionPassengers.filter((passenger) => !passenger.caseId).length + sessionFamilies.filter((family) => !family.caseId).length + sessionEnquiries.filter((enquiry) => !enquiry.passengerRecordId).length,
      missingDobOrAge: sessionPassengers.filter((passenger) => !passenger.dateOfBirth && !passenger.age).length,
      missingSeat: sessionPassengers.filter((passenger) => passenger.personType === "Passenger" && !passenger.seat).length,
      srcPending: sessionPassengers.filter((passenger) => !passenger.srcConfirmed).length,
      unknownCondition: sessionPassengers.filter((passenger) => !passenger.conditionStatus || passenger.conditionStatus === "Unknown").length,
      familyContactMissing: sessionFamilies.filter((family) => !family.phone && !family.email).length,
      openReleaseActions: sessionReleases.filter((release) => !terminalStatuses.has(release.status)).length,
      releaseChecklistPending: sessionReleases.filter((release) => !release.identityChecked || !release.holdCleared).length
    }
  };
}

const organizations: DemoOrganization[] = defaultOrganizations.map((organization) => ({
  id: `org-${organization.key}`,
  ...organization,
  createdAt: now(),
  updatedAt: now()
}));

const demoUserIds = {
  admin: "00000000-0000-4000-8000-000000000001",
  coordinator: "00000000-0000-4000-8000-000000000002",
  tec: "00000000-0000-4000-8000-000000000003",
  zpp: "00000000-0000-4000-8000-000000000004",
  volunteer: "00000000-0000-4000-8000-000000000005",
  viewer: "00000000-0000-4000-8000-000000000006",
  adminBackup: "00000000-0000-4000-8000-000000000007",
  tecCoordinator: "00000000-0000-4000-8000-000000000008",
  tecLeader: "00000000-0000-4000-8000-000000000009",
  multiRole: "00000000-0000-4000-8000-000000000010",
  pending: "00000000-0000-4000-8000-000000000011",
  suspended: "00000000-0000-4000-8000-000000000012",
  archived: "00000000-0000-4000-8000-000000000013"
};

function organizationByKey(keyValue: string) {
  return organizations.find((organization) => organization.key === keyValue) ?? organizations[0]!;
}

function userAccount(input: Omit<DemoUserAccount, "createdAt" | "updatedAt" | "activatedAt" | "version" | "roles" | "authenticationPolicy"> & { roles?: string[]; activatedAt?: string | null; authenticationPolicy?: AuthenticationPolicy }): DemoUserAccount {
  const timestamp = "2026-07-09T09:00:00.000Z";
  return {
    ...input,
    email: input.email.toLowerCase(),
    roles: input.roles ?? [],
    createdAt: timestamp,
    updatedAt: timestamp,
    authenticationPolicy: input.authenticationPolicy ?? "SSO_OR_PASSWORD",
    activatedAt: input.activatedAt ?? (input.status === "Active" ? timestamp : null),
    suspendedAt: input.suspendedAt ?? null,
    archivedAt: input.archivedAt ?? null,
    restoredAt: input.restoredAt ?? null,
    lastSuccessfulSignInAt: input.lastSuccessfulSignInAt ?? (input.status === "Active" ? "2026-07-09T09:15:00.000Z" : null),
    version: 1
  };
}

const users: DemoUserAccount[] = [
  userAccount({ id: demoUserIds.admin, email: "admin@lot.pl", displayName: "System Admin", employeeId: "ADM-001", department: "IT / configuration", organization: organizationByKey("lot"), status: "Active", linkedMemberProfileId: null }),
  userAccount({ id: demoUserIds.coordinator, email: "coordinator@lot.pl", displayName: "ZPP Coordinator", employeeId: "ZPP-COORD-001", department: "Emergency Response", organization: organizationByKey("lot"), status: "Active", linkedMemberProfileId: null }),
  userAccount({ id: demoUserIds.tec, email: "tec@lot.pl", displayName: "TEC Member", employeeId: "TEC-001", department: "Telephone Enquiry Centre", organization: organizationByKey("tec"), status: "Active", linkedMemberProfileId: "mem-2026-000002" }),
  userAccount({ id: demoUserIds.zpp, email: "zpp@lot.pl", displayName: "ZPP Group Leader", employeeId: "ZPP-001", department: "Zespół Pomocy Poszkodowanym", organization: organizationByKey("zpp"), status: "Active", linkedMemberProfileId: "mem-2026-000001" }),
  userAccount({ id: demoUserIds.volunteer, email: "volunteer@lot.pl", displayName: "ZPP Member 01", employeeId: "ZPP-221", department: "Zespół Pomocy Poszkodowanym", organization: organizationByKey("zpp"), status: "Active", linkedMemberProfileId: "mem-2026-000008" }),
  userAccount({ id: demoUserIds.viewer, email: "viewer@lot.pl", displayName: "Observer", employeeId: "OBS-001", department: "Training / observation", organization: organizationByKey("lot"), status: "Active", linkedMemberProfileId: null }),
  userAccount({ id: demoUserIds.adminBackup, email: "security@lot.pl", displayName: "Access Administrator", employeeId: "ADM-002", department: "Access administration", organization: organizationByKey("lot"), status: "Active", linkedMemberProfileId: null }),
  userAccount({ id: demoUserIds.tecCoordinator, email: "tec-coordinator@lot.pl", displayName: "TEC Coordinator", employeeId: "TEC-COORD-001", department: "Telephone Enquiry Centre", organization: organizationByKey("tec"), status: "Active", linkedMemberProfileId: null }),
  userAccount({ id: demoUserIds.tecLeader, email: "tec-leader@lot.pl", displayName: "TEC Group Leader", employeeId: "TEC-LEAD-001", department: "Telephone Enquiry Centre", organization: organizationByKey("tec"), status: "Active", linkedMemberProfileId: null }),
  userAccount({ id: demoUserIds.multiRole, email: "multi-role@lot.pl", displayName: "Multi-role Operations User", employeeId: "OPS-010", department: "Emergency Response", organization: organizationByKey("lot"), status: "Active", linkedMemberProfileId: null }),
  userAccount({ id: demoUserIds.pending, email: "pending@lot.pl", displayName: "Pending Account", employeeId: "PEN-001", department: "Access administration", organization: organizationByKey("lot"), status: "Pending", linkedMemberProfileId: null, lastSuccessfulSignInAt: null }),
  userAccount({ id: demoUserIds.suspended, email: "suspended@lot.pl", displayName: "Suspended Account", employeeId: "SUS-001", department: "Access administration", organization: organizationByKey("lot"), status: "Suspended", linkedMemberProfileId: null, suspendedAt: "2026-07-09T10:00:00.000Z", lastSuccessfulSignInAt: "2026-07-09T08:00:00.000Z" }),
  userAccount({ id: demoUserIds.archived, email: "archived@lot.pl", displayName: "Archived Account", employeeId: "ARC-001", department: "Access administration", organization: organizationByKey("lot"), status: "Archived", linkedMemberProfileId: null, archivedAt: "2026-07-09T10:15:00.000Z", lastSuccessfulSignInAt: "2026-07-01T08:00:00.000Z" })
];

const roles: DemoRoleDefinition[] = defaultRoles.map((role) => ({
  id: `role-${role.name}`,
  name: role.name,
  displayName: role.displayName,
  description: role.description,
  permissions: role.permissions,
  scopeTypes: role.scopeTypes,
  pool: role.pool,
  operationalRole: role.operationalRole,
  protected: true,
  custom: false,
  status: "Active",
  createdAt: "2026-07-09T09:00:00.000Z",
  updatedAt: "2026-07-09T09:00:00.000Z",
  version: 1
}));

roles.push({
  id: "role-incident-auditor",
  name: "incident-auditor",
  displayName: "Incident Auditor",
  description: "Custom read-only role for incident review and reports.",
  permissions: ["session:read", "audit:read", "reports:read"],
  scopeTypes: ["GLOBAL"],
  pool: "ALL",
  operationalRole: false,
  protected: false,
  custom: true,
  status: "Active",
  createdAt: "2026-07-09T09:00:00.000Z",
  updatedAt: "2026-07-09T09:00:00.000Z",
  version: 1
});

const roleAssignmentGroups: AccessGroup[] = [
  { id: "grp-2026-000001", pool: "ZPP", status: "Active" },
  { id: "grp-2026-000002", pool: "TEC", status: "Active" },
  { id: "grp-2026-000003", pool: "ZPP", status: "Standby" },
  { id: "grp-2026-000004", pool: "Mixed", status: "Draft" }
];

const userRoleAssignments: RoleAssignment[] = [
  { id: "ura-admin-system", userId: demoUserIds.admin, roleName: "system-admin", scopeType: "GLOBAL", status: "Active", assignedAt: "2026-07-09T09:00:00.000Z", assignedByUserId: demoUserIds.admin, version: 1 },
  { id: "ura-admin-zpp-coordinator", userId: demoUserIds.admin, roleName: "zpp-coordinator", scopeType: "GLOBAL", status: "Active", assignedAt: "2026-07-09T09:00:00.000Z", assignedByUserId: demoUserIds.admin, version: 1 },
  { id: "ura-admin-tec-coordinator", userId: demoUserIds.admin, roleName: "tec-coordinator", scopeType: "GLOBAL", status: "Active", assignedAt: "2026-07-09T09:00:00.000Z", assignedByUserId: demoUserIds.admin, version: 1 },
  { id: "ura-security-system", userId: demoUserIds.adminBackup, roleName: "system-admin", scopeType: "GLOBAL", status: "Active", assignedAt: "2026-07-09T09:01:00.000Z", assignedByUserId: demoUserIds.admin, version: 1 },
  { id: "ura-coordinator-zpp", userId: demoUserIds.coordinator, roleName: "zpp-coordinator", scopeType: "GLOBAL", status: "Active", assignedAt: "2026-07-09T09:00:00.000Z", assignedByUserId: demoUserIds.admin, version: 1 },
  { id: "ura-tec-coordinator", userId: demoUserIds.tecCoordinator, roleName: "tec-coordinator", scopeType: "GLOBAL", status: "Active", assignedAt: "2026-07-09T09:00:00.000Z", assignedByUserId: demoUserIds.admin, version: 1 },
  { id: "ura-tec-member", userId: demoUserIds.tec, roleName: "tec-member", scopeType: "GLOBAL", status: "Active", assignedAt: "2026-07-09T09:00:00.000Z", assignedByUserId: demoUserIds.admin, version: 1 },
  { id: "ura-zpp-group-leader", userId: demoUserIds.zpp, roleName: "zpp-group-leader", scopeType: "GROUP", scopeId: "grp-2026-000001", status: "Active", assignedAt: "2026-07-09T09:00:00.000Z", assignedByUserId: demoUserIds.admin, version: 1 },
  { id: "ura-tec-group-leader", userId: demoUserIds.tecLeader, roleName: "tec-group-leader", scopeType: "GROUP", scopeId: "grp-2026-000002", status: "Active", assignedAt: "2026-07-09T09:00:00.000Z", assignedByUserId: demoUserIds.admin, version: 1 },
  { id: "ura-volunteer-zpp-member", userId: demoUserIds.volunteer, roleName: "zpp-member", scopeType: "GLOBAL", status: "Active", assignedAt: "2026-07-09T09:00:00.000Z", assignedByUserId: demoUserIds.admin, version: 1 },
  { id: "ura-viewer-observer", userId: demoUserIds.viewer, roleName: "observer", scopeType: "GLOBAL", status: "Active", assignedAt: "2026-07-09T09:00:00.000Z", assignedByUserId: demoUserIds.admin, version: 1 },
  { id: "ura-multi-system", userId: demoUserIds.multiRole, roleName: "system-admin", scopeType: "GLOBAL", status: "Active", assignedAt: "2026-07-09T09:02:00.000Z", assignedByUserId: demoUserIds.admin, version: 1 },
  { id: "ura-multi-zpp", userId: demoUserIds.multiRole, roleName: "zpp-coordinator", scopeType: "GLOBAL", status: "Active", assignedAt: "2026-07-09T09:02:00.000Z", assignedByUserId: demoUserIds.admin, version: 1 },
  { id: "ura-multi-custom-auditor", userId: demoUserIds.multiRole, roleName: "incident-auditor", scopeType: "GLOBAL", status: "Active", assignedAt: "2026-07-09T09:02:00.000Z", assignedByUserId: demoUserIds.admin, version: 1 },
  { id: "ura-pending-observer", userId: demoUserIds.pending, roleName: "observer", scopeType: "GLOBAL", status: "Active", assignedAt: "2026-07-09T09:03:00.000Z", assignedByUserId: demoUserIds.admin, version: 1 },
  { id: "ura-suspended-observer", userId: demoUserIds.suspended, roleName: "observer", scopeType: "GLOBAL", status: "Active", assignedAt: "2026-07-09T09:03:00.000Z", assignedByUserId: demoUserIds.admin, version: 1 },
  { id: "ura-archived-observer", userId: demoUserIds.archived, roleName: "observer", scopeType: "GLOBAL", status: "Active", assignedAt: "2026-07-09T09:03:00.000Z", assignedByUserId: demoUserIds.admin, version: 1 }
];

const permissionOverrides: PermissionOverride[] = [
  { id: "ovr-viewer-reports", userId: demoUserIds.viewer, permission: "reports:read", effect: "GRANT", active: true, reason: "Temporary review support", createdAt: "2026-07-09T09:05:00.000Z", createdByUserId: demoUserIds.admin, version: 1 },
  { id: "ovr-viewer-export-deny", userId: demoUserIds.viewer, permission: "export:create", effect: "DENY", active: true, reason: "Export access is not needed for observation work", createdAt: "2026-07-09T09:06:00.000Z", createdByUserId: demoUserIds.admin, version: 1 },
  { id: "ovr-viewer-expired-admin", userId: demoUserIds.viewer, permission: "admin:manage", effect: "GRANT", active: true, reason: "Expired administrative review window", expiresAt: "2026-07-01T09:00:00.000Z", createdAt: "2026-06-30T09:00:00.000Z", createdByUserId: demoUserIds.admin, version: 1 }
];

function refreshUserRoleSnapshot(user: DemoUserAccount) {
  const access = effectiveAccessForUser({
    userId: user.id,
    assignments: userRoleAssignments,
    groups: roleAssignmentGroups,
    permissionOverrides,
    roleDefinitions: roles
  });
  user.roles = access.roles;
  return access;
}

users.forEach(refreshUserRoleSnapshot);

const externalIdentities: DemoExternalIdentity[] = [
  { id: "ext-admin-dev", userId: demoUserIds.admin, providerType: "DEVELOPMENT", provider: "development", realmId: "local", tenantId: "local", providerSubject: "dev-admin-001", subject: "dev-admin-001", authenticationMethod: "DEVELOPMENT_HEADER", emailSnapshot: "admin@lot.pl", linkedAt: "2026-07-09T09:00:00.000Z", createdAt: "2026-07-09T09:00:00.000Z", lastSeenAt: "2026-07-09T09:15:00.000Z", lastSuccessfulAuthenticationAt: "2026-07-09T09:15:00.000Z", version: 1 },
  { id: "ext-coordinator-dev", userId: demoUserIds.coordinator, providerType: "DEVELOPMENT", provider: "development", realmId: "local", tenantId: "local", providerSubject: "dev-coordinator-001", subject: "dev-coordinator-001", authenticationMethod: "DEVELOPMENT_HEADER", emailSnapshot: "coordinator@lot.pl", linkedAt: "2026-07-09T09:00:00.000Z", createdAt: "2026-07-09T09:00:00.000Z", lastSeenAt: "2026-07-09T09:15:00.000Z", lastSuccessfulAuthenticationAt: "2026-07-09T09:15:00.000Z", version: 1 }
];

const approvedDevelopmentUserIds = new Set(Object.values(demoUserIds).filter((id) => ![demoUserIds.pending, demoUserIds.suspended, demoUserIds.archived].includes(id)));
const localAuthSessions = new Map<string, LocalAuthSession>();
const userInvitations: DemoUserInvitation[] = [];
const invitationExpiryMs = 7 * 24 * 60 * 60 * 1000;
const forbiddenInvitationPayloadKeys = new Set([
  "password",
  "passwordHash",
  "temporaryPassword",
  "passwordResetToken",
  "rawInvitationToken",
  "invitationToken",
  "capabilities",
  "permissions",
  "permissionOverrides",
  "oauthAccessToken",
  "oauthRefreshToken",
  "providerSecret",
  "clientSecret"
]);

function localOnboardingEnabled() {
  return process.env.NODE_ENV !== "production" && process.env.ZPP_ENABLE_LOCAL_ONBOARDING !== "false";
}

function localDevelopmentAuthEnabled() {
  return process.env.NODE_ENV !== "production" && process.env.ZPP_ENABLE_DEV_AUTH !== "false";
}

function productMethodsForPolicy(policy: AuthenticationPolicy): ProductAuthenticationMethod[] {
  if (policy === "SSO_ONLY") return ["MICROSOFT_SSO"];
  if (policy === "PASSWORD_ONLY") return ["EMAIL_PASSWORD"];
  return ["MICROSOFT_SSO", "EMAIL_PASSWORD"];
}

function policyAllowsProductMethod(policy: AuthenticationPolicy, method: AuthenticationMethod) {
  return productMethodsForPolicy(policy).includes(method as ProductAuthenticationMethod);
}

function localMethodForProductMethod(method: AuthenticationMethod): AuthenticationMethod {
  if (method === "MICROSOFT_SSO") return "LOCAL_DEV_SSO";
  if (method === "EMAIL_PASSWORD") return "LOCAL_DEV_PASSWORD";
  return method;
}

function userHasLocalDevelopmentIdentity(user: DemoUserAccount) {
  if (approvedDevelopmentUserIds.has(user.id)) return true;
  return externalIdentities.some((identity) => (
    identity.userId === user.id &&
    !identity.disabledAt &&
    (identity.providerType === "LOCAL_DEV" || identity.providerType === "DEVELOPMENT")
  ));
}

function bearerToken(req: Request) {
  const authorization = req.header("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || req.header("x-zpp-session")?.trim() || "";
}

function userFromLocalSession(req: Request) {
  const token = bearerToken(req);
  if (!token) return undefined;
  const session = localAuthSessions.get(token);
  if (!session || session.revokedAt) return undefined;
  const user = userById(session.userId);
  if (!user || user.status !== "Active") return undefined;
  session.lastSeenAt = now();
  return user;
}

function developmentUserResponse(user: DemoUserAccount) {
  return {
    userId: user.id,
    displayName: user.displayName,
    email: user.email,
    authenticationPolicy: user.authenticationPolicy,
    permittedMethods: productMethodsForPolicy(user.authenticationPolicy)
  };
}

function genericSignInError() {
  return "We could not continue with that sign-in. Check the account details or contact an administrator.";
}

function stableHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function newInvitationHash(invitationId: string, generation: number) {
  return stableHash(`zpp-local-invitation:${invitationId}:${generation}:${randomUUID()}`);
}

function parseAuthenticationPolicy(value: unknown): AuthenticationPolicy {
  const policy = String(value ?? "").trim();
  return authenticationPolicies.includes(policy as AuthenticationPolicy) ? policy as AuthenticationPolicy : "SSO_OR_PASSWORD";
}

function parseInvitationExpiry(value: unknown) {
  const candidate = value ? new Date(String(value)) : null;
  return candidate && Number.isFinite(candidate.getTime()) ? candidate.toISOString() : new Date(Date.now() + invitationExpiryMs).toISOString();
}

function inviteHasForbiddenPayloadKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  for (const [key, nested] of Object.entries(value as Row)) {
    if (forbiddenInvitationPayloadKeys.has(key)) return true;
    if (inviteHasForbiddenPayloadKey(nested)) return true;
  }
  return false;
}

function invitationById(invitationId: string) {
  return userInvitations.find((invitation) => invitation.id === invitationId);
}

function invitationStillAcceptable(invitation: DemoUserInvitation) {
  return ["Prepared", "Sent"].includes(invitation.status) && new Date(invitation.tokenExpiresAt).getTime() > Date.now();
}

function expireInvitationIfNeeded(invitation: DemoUserInvitation, req?: Request) {
  if (!["Prepared", "Sent"].includes(invitation.status)) return invitation;
  const expiry = new Date(invitation.tokenExpiresAt);
  if (!Number.isFinite(expiry.getTime()) || expiry.getTime() > Date.now()) return invitation;
  invitation.status = "Expired";
  invitation.version += 1;
  invitation.history.push({
    status: "Expired",
    action: "invitation_expired",
    actorUserId: null,
    createdAt: now(),
    resendGeneration: invitation.resendGeneration
  });
  if (req) {
    addAudit(req, "invitation_expired", "Invitation expired", activeSessionId(req), {
      targetUserId: invitation.userId,
      invitationId: invitation.id,
      authenticationPolicy: invitation.intendedAuthenticationPolicy
    }, "userInvitation", invitation.id);
  }
  return invitation;
}

function invitationRoleSummary(userId: string) {
  return activeRoleAssignmentsFor(userId).map((assignment) => ({
    roleName: canonicalRoleName(assignment.roleName),
    roleDisplayName: roleDisplayName(assignment.roleName, roles),
    scopeType: assignment.scopeType,
    scopeId: assignment.scopeId ?? null,
    scopeLabel: assignment.scopeType === "GROUP" ? groupSummary(assignment.scopeId)?.name ?? assignment.scopeId ?? "Group" : "Global"
  }));
}

function invitationResponse(invitation: DemoUserInvitation) {
  const user = userById(invitation.userId);
  const createdBy = userById(invitation.createdByUserId);
  const revokedBy = invitation.revokedByUserId ? userById(invitation.revokedByUserId) : null;
  const { tokenHash: _tokenHash, ...publicInvitation } = invitation;
  return {
    ...publicInvitation,
    hasActiveToken: invitationStillAcceptable(invitation),
    localOnboardingAvailable: localOnboardingEnabled() && invitationStillAcceptable(invitation),
    user: user ? adminUserResponse(user) : null,
    createdBy: createdBy ? actorSummary(createdBy) : null,
    revokedBy: revokedBy ? actorSummary(revokedBy) : null,
    roleAssignments: invitationRoleSummary(invitation.userId),
    memberProfile: user?.linkedMemberProfileId ? adminUserResponse(user).linkedMemberProfile : null
  };
}

function parseInviteRoleAssignments(input: Row) {
  const rawAssignments = Array.isArray(input.roleAssignments)
    ? input.roleAssignments
    : Array.isArray(input.roles)
      ? input.roles.map((roleName: unknown) => ({ roleName, scopeType: "GLOBAL" }))
      : [];
  if (!rawAssignments.length) return { status: 400, error: "Select at least one role for this invitation." } as const;

  const assignments: Array<Pick<RoleAssignment, "roleName" | "scopeType" | "scopeId">> = [];
  const seen = new Set<string>();
  for (const raw of rawAssignments) {
    const roleName = canonicalRoleName(String(raw?.roleName ?? raw?.name ?? raw ?? ""));
    const scopeType = (raw?.scopeType === "GROUP" ? "GROUP" : "GLOBAL") as RoleScopeType;
    const scopeId = scopeType === "GROUP" ? String(raw?.scopeId ?? "").trim() || null : null;
    const candidate = { roleName, scopeType, scopeId };
    const error = validateRoleAssignment(candidate, roleAssignmentGroups, roles);
    if (error) return { status: 400, error } as const;
    const key = `${roleName}:${scopeType}:${scopeId ?? ""}`;
    if (seen.has(key)) return { status: 409, error: "Duplicate active role assignment." } as const;
    seen.add(key);
    assignments.push(candidate);
  }
  return { assignments } as const;
}

function localIdentityMethod(policy: AuthenticationPolicy, methodChoice?: unknown): AuthenticationMethod {
  if (policy === "SSO_ONLY") return "LOCAL_DEV_SSO";
  if (policy === "PASSWORD_ONLY") return "LOCAL_DEV_PASSWORD";
  const choice = String(methodChoice ?? "").trim();
  if (choice === "SSO_ONLY") return "LOCAL_DEV_SSO";
  if (choice === "PASSWORD_ONLY") return "LOCAL_DEV_PASSWORD";
  return "LOCAL_DEV_CHOICE";
}

function roleDefinition(roleName: string) {
  return roles.find((role) => canonicalRoleName(role.name) === canonicalRoleName(roleName));
}

function groupSummary(groupId?: string | null) {
  if (!groupId) return null;
  try {
    const group = memberDirectoryForAdmin?.getGroup(groupId);
    if (group) return { id: group.id, operationalId: group.operationalId, name: group.name, pool: group.pool, status: group.status };
  } catch {
    // Fall back to the role-scope cache if the directory is unavailable.
  }
  const group = roleAssignmentGroups.find((item) => item.id === groupId);
  return group ? { id: group.id, operationalId: group.id, name: group.id, pool: group.pool ?? null, status: group.status ?? null } : null;
}

function roleAssignmentResponse(assignment: RoleAssignment) {
  const role = roleDefinition(assignment.roleName);
  return {
    ...assignment,
    roleName: canonicalRoleName(assignment.roleName),
    roleDisplayName: role?.displayName ?? roleDisplayName(assignment.roleName, roles),
    scopeLabel: assignment.scopeType === "GROUP" ? groupSummary(assignment.scopeId)?.name ?? assignment.scopeId ?? "Group" : "Global",
    group: assignment.scopeType === "GROUP" ? groupSummary(assignment.scopeId) : null
  };
}

const sessions: Row[] = [
  {
    id: "ses-demo-1",
    operationalId: "SES-2026-001",
    mode: "EXERCISE",
    status: "Active",
    eventType: "Exercise",
    flightNumber: "LO3924",
    route: "KRK-WAW",
    aircraftRegistration: "SP-LRA",
    airportLocation: "Warsaw Chopin Airport",
    description: "Active exercise session for operational training.",
    startAt: "2026-06-21T08:00:00.000Z",
    endAt: null,
    notes: "Training scenario for ZPP coordination and support workflows.",
    createdAt: now(),
    updatedAt: now()
  },
  {
    id: "ses-demo-2",
    operationalId: "SES-2026-002",
    mode: "TRAINING",
    status: "Closed",
    eventType: "Training session",
    flightNumber: null,
    route: "Training room",
    aircraftRegistration: null,
    airportLocation: "Warsaw training centre",
    description: "Training session for operational briefing practice.",
    startAt: "2026-06-20T09:00:00.000Z",
    endAt: "2026-06-20T12:00:00.000Z",
    notes: "Briefing practice and role familiarization.",
    createdAt: "2026-06-20T09:00:00.000Z",
    updatedAt: "2026-06-20T09:00:00.000Z"
  },
  {
    id: "ses-demo-3",
    operationalId: "SES-2026-003",
    mode: "EXERCISE",
    status: "Closed",
    eventType: "Exercise",
    flightNumber: null,
    route: "Planning",
    aircraftRegistration: null,
    airportLocation: "Planning room",
    description: "Planned exercise session without a published briefing.",
    startAt: null,
    endAt: "2026-06-19T12:00:00.000Z",
    notes: "Prepared session shell.",
    createdAt: "2026-06-19T09:00:00.000Z",
    updatedAt: "2026-06-19T09:00:00.000Z"
  }
];

const enquiries: Row[] = [
  {
    id: "enq-demo-1",
    operationalId: "TEC-2026-000001",
    sessionId: "ses-demo-1",
    caseId: "CASE-2026-0001",
    contactChannel: "Phone",
    callerName: "Anna Kowalska",
    callerPhone: "+48 600 100 100",
    callerEmail: "anna.kowalska@example.test",
    callerLocation: "Krakow",
    preferredLanguage: "Polish",
    claimedRelationship: "Sister",
    passengerRecordId: "pax-demo-1",
    passengerFirstName: "Piotr",
    passengerLastName: "Kowalski",
    passengerFlight: "LO3924",
    passengerRoute: "KRK-WAW",
    enquiryType: "Missing contact",
    urgency: "Urgent welfare",
    status: "Urgent welfare",
    notes: "Caller reports repeated failed contact attempts. No status disclosed.",
    createdAt: now(),
    updatedAt: now()
  }
];

const familyRecords: Row[] = [
  {
    id: "fam-demo-1",
    operationalId: "FAM-2026-000001",
    sessionId: "ses-demo-1",
    caseId: "CASE-2026-0001",
    firstName: "Anna",
    lastName: "Kowalska",
    phone: "+48 600 100 100",
    email: "anna.kowalska@example.test",
    preferredContactChannel: "Phone",
    preferredLanguage: "Polish",
    claimedRelationship: "Sister",
    passengerFirstName: "Piotr",
    passengerLastName: "Kowalski",
    passengerFlight: "LO3924",
    verificationStatus: "Partially verified",
    verificationNotes: "Identity reviewed; relationship verification pending.",
    immediateNeeds: "Psychological First Aid and regular call-back.",
    createdAt: now(),
    updatedAt: now()
  }
];

const passengerRecords: Row[] = [
  {
    id: "pax-demo-1",
    operationalId: "PAX-2026-000001",
    sessionId: "ses-demo-1",
    caseId: "CASE-2026-0001",
    personType: "Passenger",
    firstName: "Piotr",
    lastName: "Kowalski",
    age: 34,
    gender: "Male",
    nationality: "Polish",
    flightNumber: "LO3924",
    route: "KRK-WAW",
    seat: "12A",
    pnr: "LOTABC",
    ticketNumber: "0801234567890",
    manifestVersion: "MNF-EX-001",
    source: "Manifest",
    travellingCompanions: "None listed",
    conditionStatus: "Unknown",
    holdStatus: "Identity verification hold",
    srcConfirmed: false,
    notes: "Manifest record. No status decision is implied.",
    createdAt: now(),
    updatedAt: now()
  }
];

const matchingRecords: Row[] = [
  {
    id: "mat-demo-1",
    operationalId: "MAT-2026-000001",
    sessionId: "ses-demo-1",
    caseId: "CASE-2026-0001",
    enquiryId: "enq-demo-1",
    familyRecordId: "fam-demo-1",
    passengerRecordId: "pax-demo-1",
    status: "Hold / escalate",
    matchScore: 0.92,
    matchBasis: "Name, flight and claimed relationship align. Relationship verification pending.",
    holdCheck: "Identity verification hold",
    decisionNotes: "Potential match held. No disclosure authorized.",
    createdAt: now(),
    updatedAt: now()
  }
];

const releases: Row[] = [];

const requests: Row[] = [
  {
    id: "req-demo-1",
    operationalId: "REQ-2026-000001",
    sessionId: "ses-demo-1",
    caseId: "CASE-2026-0001",
    relatedEnquiryId: "enq-demo-1",
    relatedFamilyRecordId: "fam-demo-1",
    relatedPassengerRecordId: "pax-demo-1",
    category: "Psychological First Aid",
    priority: "Urgent",
    requester: "Anna Kowalska",
    ownerAssignedTo: "ZPP",
    details: "Arrange PFA support and a quiet waiting area.",
    approvalStatus: "Not required",
    status: "Assigned",
    createdAt: now(),
    updatedAt: now()
  }
];

const assignments: Row[] = [
  {
    id: "asn-demo-1",
    operationalId: "ASN-2026-000001",
    sessionId: "ses-demo-1",
    groupId: "grp-2026-000001",
    caseId: "CASE-2026-0001",
    title: "Prepare welfare room briefing note",
    details: "Confirm PFA materials, quiet room setup and callback script before the next briefing.",
    status: "Open",
    priority: "Normal",
    assignedUserId: demoUserIds.volunteer,
    assignedUserDisplayName: "ZPP Member 01",
    ownerAssignedTo: "ZPP Member 01",
    relatedFunction: "Welfare Support",
    linkedRecord: "ERP-2026-001",
    dueAt: "2026-06-21T12:00:00.000Z",
    createdAt: now(),
    updatedAt: now()
  },
  {
    id: "asn-demo-2",
    operationalId: "ASN-2026-000002",
    sessionId: "ses-demo-1",
    groupId: "grp-2026-000002",
    caseId: null,
    title: "Confirm TEC evening shift availability",
    details: "Check trained TEC coverage for the 18:00-22:00 operating period.",
    status: "In Progress",
    priority: "Urgent",
    assignedUserId: null,
    assignedUserDisplayName: "Leader Bravo",
    ownerAssignedTo: "Leader Bravo",
    relatedFunction: "Telephone Enquiry Center",
    linkedRecord: "RST-002",
    dueAt: "2026-06-21T13:00:00.000Z",
    createdAt: now(),
    updatedAt: now()
  },
  {
    id: "asn-demo-3",
    operationalId: "ASN-2026-000003",
    sessionId: "ses-demo-1",
    caseId: "CASE-2026-0001",
    title: "Verify restricted case before first contact",
    details: "Coordinator review is required before outbound contact or disclosure.",
    status: "Escalated",
    priority: "Critical",
    assignedUserId: demoUserIds.coordinator,
    assignedUserDisplayName: "ZPP Coordinator",
    ownerAssignedTo: "ZPP Coordinator",
    relatedFunction: "Family Assistance",
    linkedRecord: "NOK-2026-001",
    dueAt: "2026-06-21T10:30:00.000Z",
    createdAt: now(),
    updatedAt: now()
  },
  {
    id: "asn-demo-4",
    operationalId: "ASN-2026-000004",
    sessionId: "ses-demo-1",
    caseId: null,
    title: "Review role card access levels",
    details: "Confirm who can access restricted family assistance role cards.",
    status: "Completed",
    priority: "Normal",
    assignedUserId: demoUserIds.admin,
    assignedUserDisplayName: "System Admin",
    ownerAssignedTo: "System Admin",
    relatedFunction: "Documentation",
    linkedRecord: "DOC-ROLE-004",
    dueAt: "2026-06-21T16:00:00.000Z",
    createdAt: now(),
    updatedAt: now()
  }
];

const timeline: Row[] = [
  {
    id: "tle-demo-1",
    sessionId: "ses-demo-1",
    caseId: "CASE-2026-0001",
    eventType: "enquiry",
    entityType: "enquiry",
    entityId: "enq-demo-1",
    title: "Urgent TEC enquiry received",
    body: "Caller asked for passenger information; intake did not disclose protected status.",
    occurredAt: now(),
    createdAt: now()
  },
  {
    id: "tle-demo-2",
    sessionId: "ses-demo-1",
    caseId: "CASE-2026-0001",
    eventType: "hold",
    entityType: "matchingRecord",
    entityId: "mat-demo-1",
    title: "Identity verification hold applied",
    body: "ZPP requires additional verification before disclosure or release.",
    occurredAt: now(),
    createdAt: now()
  }
];

const auditLogs: Row[] = [
  {
    id: "aud-demo-1",
    action: "login",
    entityType: "system",
    entityId: null,
    sessionId: "ses-demo-1",
    actorEmail: "coordinator@lot.pl",
    summary: "Operational workspace started.",
    createdAt: now()
  }
];

const files: Row[] = [];
const importBatches: Row[] = [];
const importRowsByBatchId = new Map<string, Row[]>();

const exerciseInjects: Row[] = [
  {
    id: "inj-demo-1",
    operationalId: "INJ-2026-000001",
    sessionId: "ses-demo-1",
    injectNumber: 1,
    scenarioTime: "2026-06-21T08:15:00.000Z",
    targetRole: "TEC Member",
    text: "Caller reports missing contact and asks whether the passenger is injured.",
    expectedAction: "Create enquiry and do not disclose passenger/casualty status.",
    status: "Released",
    createdAt: now(),
    updatedAt: now()
  }
];

const exerciseObservations: Row[] = [
  {
    id: "obs-demo-1",
    operationalId: "OBS-2026-000001",
    sessionId: "ses-demo-1",
    area: "Intake",
    observation: "Intake correctly recorded the enquiry without confirming passenger status.",
    severity: "Low",
    recommendation: "Continue reinforcing controlled disclosure language.",
    owner: "Exercise Director",
    includeInAar: true,
    status: "Open",
    createdAt: now(),
    updatedAt: now()
  }
];

const resources: Record<string, Row[]> = {
  sessions,
  enquiries,
  "family-records": familyRecords,
  "matching-records": matchingRecords,
  releases,
  requests,
  assignments,
  timeline,
  "audit-logs": auditLogs,
  files,
  "import-batches": importBatches,
  "exercise/injects": exerciseInjects,
  "exercise/observations": exerciseObservations
};

const idPrefixes: Record<string, string> = {
  sessions: "SES",
  enquiries: "TEC",
  "family-records": "FAM",
  "matching-records": "MAT",
  releases: "REL",
  requests: "REQ",
  assignments: "ASN",
  timeline: "TLE",
  files: "FIL",
  "import-batches": "IMP",
  "exercise/injects": "INJ",
  "exercise/observations": "OBS"
};

function key(label: string) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function dictionaryRows() {
  const grouped: Record<string, Row[]> = {};
  for (const [category, values] of Object.entries(dictionaries)) {
    grouped[category] = values.map((label, index) => ({
      id: `${category}-${key(label)}`,
      profile: defaultProfile.id,
      category,
      key: key(label),
      label,
      sortOrder: index,
      isActive: true
    }));
  }
  grouped.profile = Object.entries(defaultProfile)
    .filter(([, value]) => typeof value === "string")
    .map(([profileKey, value], index) => ({
      id: `profile-${profileKey}`,
      profile: defaultProfile.id,
      category: "profile",
      key: profileKey,
      label: value,
      sortOrder: index,
      isActive: true
    }));
  return grouped;
}

function demoUserForRequest(req: Request) {
  const sessionUser = userFromLocalSession(req);
  if (sessionUser) return sessionUser;
  if (!localDevelopmentAuthEnabled()) return undefined;
  const email = req.header("x-user-email")?.toLowerCase();
  if (!email) return undefined;
  const user = users.find((item) => item.email === email);
  if (!user || user.status !== "Active") return undefined;
  return user;
}

function toAuthenticatedUser(user: DemoUserAccount, options?: { touchSignIn?: boolean }): AuthenticatedUser {
  const access = refreshUserRoleSnapshot(user);
  if (options?.touchSignIn) user.lastSuccessfulSignInAt = now();
  return {
    id: user.id,
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    department: user.department,
    organizationId: user.organization.id,
    organization: user.organization,
    roles: access.roles,
    roleLabels: access.roleLabels,
    roleAssignments: access.roleAssignments,
    deniedPermissions: access.deniedPermissions,
    permissions: access.permissions
  };
}

function currentUser(req: Request): AuthenticatedUser {
  if (req.user) return req.user;
  const user = demoUserForRequest(req);
  if (!user) throw new Error("Authentication required");
  return toAuthenticatedUser(user);
}

function can(req: Request, permission: string) {
  return Boolean(req.user?.permissions.includes(permission as AuthenticatedUser["permissions"][number]));
}

function requirePermission(permission: string) {
  return (req: Request, res: any, next: any) => {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (!can(req, permission)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  };
}

function requireAnyPermission(permissions: string[]) {
  return (req: Request, res: any, next: any) => {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (!permissions.some((permission) => can(req, permission))) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  };
}

function directoryActor(req: Request): DirectoryActor {
  const user = currentUser(req);
  return {
    id: user.userId,
    email: user.email,
    displayName: user.displayName,
    roles: [...user.roles],
    permissions: [...user.permissions],
    roleAssignments: user.roleAssignments ? user.roleAssignments.map((assignment) => ({
      ...assignment,
      permissions: permissionsForRoleNames([assignment.roleName], roles)
    })) : []
  };
}

function directoryRoute(handler: (req: Request) => unknown, status = 200) {
  return (req: Request, res: any) => {
    try {
      res.status(status).json(handler(req));
    } catch (error) {
      if (error instanceof DirectoryError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  };
}

function syncRoleAssignmentGroup(group: Row) {
  const existing = roleAssignmentGroups.find((item) => item.id === group.id);
  const next = { id: String(group.id), pool: String(group.pool ?? ""), status: String(group.status ?? "") };
  if (existing) Object.assign(existing, next);
  else roleAssignmentGroups.push(next);
}

const globalGroupAccessRoles = new Set(["zpp-coordinator", "tec-coordinator"]);

function roleAssignmentCan(assignment: RoleAssignment, permission: string) {
  return permissionsForRoleNames([assignment.roleName], roles).includes(permission as AuthenticatedUser["permissions"][number]);
}

function hasGlobalGroupAccess(req: Request, permission: string) {
  return (req.user?.roleAssignments ?? []).some((assignment) => (
    assignment.status === "Active" &&
    assignment.scopeType === "GLOBAL" &&
    globalGroupAccessRoles.has(canonicalRoleName(assignment.roleName)) &&
    roleAssignmentCan(assignment as RoleAssignment, permission)
  ));
}

function scopedGroupIds(req: Request, permission: string) {
  return new Set((req.user?.roleAssignments ?? [])
    .filter((assignment) => assignment.status === "Active" && assignment.scopeType === "GROUP" && assignment.scopeId && roleAssignmentCan(assignment as RoleAssignment, permission))
    .map((assignment) => String(assignment.scopeId)));
}

function groupPage(data: Row[], query: Record<string, unknown>) {
  const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(query.offset ?? 0) || 0, 0);
  return { total: data.length, limit, offset, data: data.slice(offset, offset + limit) };
}

function scopedGroupsResponse(req: Request, raw: Row[]) {
  if (hasGlobalGroupAccess(req, "group:read")) return groupPage(raw, req.query);
  const allowed = scopedGroupIds(req, "group:read");
  return groupPage(raw.filter((group) => allowed.has(String(group.id))), req.query);
}

function ensureGroupScope(req: Request, res: any, groupId: string, permission: string) {
  if (hasGlobalGroupAccess(req, permission)) return true;
  if (scopedGroupIds(req, permission).has(groupId)) return true;
  res.status(403).json({ error: "Forbidden" });
  return false;
}

function activeSessionId(req: Request) {
  return String(req.query.sessionId ?? sessions.find((session) => session.status === "Active")?.id ?? sessions[0]?.id ?? "");
}

function listRows(resource: string, req: Request) {
  const sessionId = req.query.sessionId ? String(req.query.sessionId) : undefined;
  const status = req.query.status ? String(req.query.status) : undefined;
  const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 200);
  const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
  const rows = resources[resource] ?? [];
  const filtered = rows
    .filter((row) => (!sessionId || row.sessionId === sessionId || row.id === sessionId) && (!status || row.status === status))
    .filter((row) => resource !== "assignments" || canAccessAssignment(req, row, "assignment:read"));
  const data = filtered.slice(offset, offset + limit).map((row) => {
    if (resource === "assignments") return assignmentResponse(row, req);
    const output = withActorMetadata(resource, row, req);
    if (resource !== "files") return output;
    const batch = importBatches.find((item) => item.id === row.importBatchId);
    return {
      ...output,
      importBatch: batch ?? null,
      importStatus: batch?.status ?? null,
      importType: batch?.importType ?? null,
      totalRecords: batch?.totalRecords ?? null,
      validRecords: batch?.validRecords ?? null,
      invalidRecords: batch?.invalidRecords ?? null,
      importErrors: batch?.errors ?? null
    };
  });
  return { total: filtered.length, data };
}

function actorSummary(user: { id: string; email: string; displayName: string; roles?: string[] }) {
  return { id: user.id, userId: user.id, email: user.email, displayName: user.displayName, roles: user.roles?.map((roleName) => roleDisplayName(roleName, roles)) ?? [] };
}

function defaultActorForResource(resource: string) {
  if (resource === "enquiries") return users.find((user) => user.email === "tec@lot.pl") ?? users[0]!;
  if (["family-records", "matching-records", "requests", "assignments", "groups"].includes(resource)) return users.find((user) => user.email === "zpp@lot.pl") ?? users[0]!;
  return users.find((user) => user.email === "coordinator@lot.pl") ?? users[0]!;
}

function withActorMetadata(resource: string, row: Row, req: Request) {
  const preserveMissingActor = resource === "timeline" || resource === "audit-logs";
  const fallback = row.createdById || row.updatedById || preserveMissingActor ? undefined : defaultActorForResource(resource);
  const createdBy = users.find((user) => user.id === row.createdById) ?? fallback ?? null;
  const updatedBy = users.find((user) => user.id === row.updatedById) ?? createdBy ?? currentUser(req);
  return {
    ...row,
    createdBy: createdBy ? actorSummary(createdBy) : null,
    updatedBy: updatedBy ? actorSummary(updatedBy) : null
  };
}

function isAssignmentManager(req: Request) {
  const roleNames = req.user?.roles ?? [];
  return roleNames.some((roleName) => ["zpp-coordinator", "tec-coordinator", "zpp-group-leader", "tec-group-leader"].includes(canonicalRoleName(roleName)));
}

function canReceiveAssignment(user: DemoUserAccount) {
  return user.status === "Active" && permissionsForRoleNames(user.roles, roles).includes("assignment:read");
}

function assignmentUserSummary(user?: DemoUserAccount | null) {
  return user
    ? {
        id: user.id,
        userId: user.id,
        email: user.email,
        displayName: user.displayName,
        roles: user.roles,
        roleLabels: user.roles.map((roleName) => roleDisplayName(roleName, roles))
      }
    : null;
}

function assignmentActorGroupIds(req: Request, permission: string) {
  const groups = new Set(permissionScope(directoryActor(req), permission).groupIds);
  const user = users.find((item) => item.id === currentUser(req).userId);
  if (user?.linkedMemberProfileId) {
    for (const groupId of memberDirectoryForAdmin?.groupIdsForMember(user.linkedMemberProfileId) ?? []) groups.add(groupId);
  }
  return groups;
}

function assignmentRecordGroupIds(row: Row) {
  const groups = new Set<string>();
  if (row.groupId) groups.add(String(row.groupId));
  const assignedUser = row.assignedUserId ? users.find((item) => item.id === row.assignedUserId) : undefined;
  if (assignedUser?.linkedMemberProfileId) {
    for (const groupId of memberDirectoryForAdmin?.groupIdsForMember(assignedUser.linkedMemberProfileId) ?? []) groups.add(groupId);
  }
  return groups;
}

function canAccessAssignment(req: Request, row: Row, permission: string) {
  const actor = currentUser(req);
  if (row.assignedUserId === actor.userId) return true;
  const scope = permissionScope(directoryActor(req), permission);
  if (!scope.allowed) return false;
  if (scope.global && isAssignmentManager(req)) return true;
  const allowedGroups = assignmentActorGroupIds(req, permission);
  return [...assignmentRecordGroupIds(row)].some((groupId) => allowedGroups.has(groupId));
}

function findAssignmentAssignee(req: Request, userId: string) {
  const user = users.find((item) => item.id === userId);
  if (!user || !canReceiveAssignment(user)) return undefined;
  const scope = permissionScope(directoryActor(req), "assignment:assign");
  if (scope.global && isAssignmentManager(req)) return user;
  if (!user.linkedMemberProfileId) return undefined;
  const allowedGroups = assignmentActorGroupIds(req, "assignment:assign");
  return (memberDirectoryForAdmin?.groupIdsForMember(user.linkedMemberProfileId) ?? []).some((groupId) => allowedGroups.has(groupId)) ? user : undefined;
}

function assigneeMatchesAssignment(row: Row, user: DemoUserAccount) {
  const assignmentGroups = assignmentRecordGroupIds(row);
  if (assignmentGroups.size === 0) return true;
  if (!user.linkedMemberProfileId) return false;
  return (memberDirectoryForAdmin?.groupIdsForMember(user.linkedMemberProfileId) ?? []).some((groupId) => assignmentGroups.has(groupId));
}

function listAssignmentAssignees(req: Request) {
  return users
    .filter((user) => Boolean(findAssignmentAssignee(req, user.id)))
    .sort((first, second) => first.displayName.localeCompare(second.displayName))
    .map((user) => assignmentUserSummary(user)!);
}

function assignmentResponse(row: Row, req: Request) {
  const withActors = withActorMetadata("assignments", row, req);
  const assignedUser = row.assignedUserId ? users.find((user) => user.id === row.assignedUserId) : undefined;
  const assignedSummary = assignmentUserSummary(assignedUser);
  const displayName = String(row.assignedUserDisplayName ?? assignedSummary?.displayName ?? row.ownerAssignedTo ?? "").trim();
  const legacyText = !row.assignedUserId && row.ownerAssignedTo ? String(row.ownerAssignedTo) : "";
  return {
    ...withActors,
    assignedUser: assignedSummary,
    assignedUserId: row.assignedUserId ?? assignedSummary?.id ?? null,
    assignedUserDisplayName: displayName || null,
    ownerAssignedTo: displayName || null,
    legacyAssignee: legacyText ? { displayName: legacyText, label: `Legacy/unresolved assignee: ${legacyText}` } : null
  };
}

function activeRoleAssignmentsFor(userId: string) {
  return userRoleAssignments.filter((assignment) => assignment.userId === userId && assignment.status === "Active");
}

function latestInvitationForUser(userId: string) {
  return userInvitations
    .filter((invitation) => invitation.userId === userId)
    .map((invitation) => expireInvitationIfNeeded(invitation))
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())[0] ?? null;
}

function invitationSummaryForUser(userId: string) {
  const invitation = latestInvitationForUser(userId);
  return invitation
    ? {
        id: invitation.id,
        status: invitation.status,
        intendedAuthenticationPolicy: invitation.intendedAuthenticationPolicy,
        createdAt: invitation.createdAt,
        sentAt: invitation.sentAt,
        acceptedAt: invitation.acceptedAt,
        revokedAt: invitation.revokedAt,
        tokenExpiresAt: invitation.tokenExpiresAt,
        resendGeneration: invitation.resendGeneration,
        hasActiveToken: invitationStillAcceptable(invitation)
      }
    : null;
}

function adminUserResponse(user: DemoUserAccount) {
  const access = refreshUserRoleSnapshot(user);
  const invitation = invitationSummaryForUser(user.id);
  const linkedMember = user.linkedMemberProfileId
    ? (() => {
      try {
        return memberDirectoryForAdmin?.getMember(user.linkedMemberProfileId, undefined) ?? null;
      } catch {
        return null;
      }
    })()
    : null;
  return {
    ...user,
    roles: access.roles,
    roleLabels: access.roleLabels,
    roleAssignments: activeRoleAssignmentsFor(user.id).map((assignment) => roleAssignmentResponse(assignment)),
    deniedPermissions: access.deniedPermissions,
    grantCount: access.grants.length,
    denyCount: access.denies.length,
    permissionCount: access.permissions.length,
    organizationId: user.organization.id,
    status: user.status,
    invitation,
    invitationStatus: invitation?.status ?? "None",
    linkedMemberProfile: linkedMember
      ? { id: linkedMember.id, memberId: linkedMember.memberId, displayName: linkedMember.displayName, pool: linkedMember.pool, status: linkedMember.status }
      : null,
    externalIdentityCount: externalIdentities.filter((identity) => identity.userId === user.id).length
  };
}

function userById(userId: string) {
  return users.find((user) => user.id === userId);
}

function userByEmail(email: string) {
  return users.find((user) => user.email === email.toLowerCase());
}

function parseExpectedVersion(value: unknown) {
  const version = Number(value);
  return Number.isFinite(version) ? Math.trunc(version) : undefined;
}

function assertVersion(currentVersion: number | undefined, expectedVersion: unknown) {
  const expected = parseExpectedVersion(expectedVersion);
  if (expected !== undefined && expected !== currentVersion) return "This record changed while you were reviewing it. Refresh and try again.";
  return undefined;
}

function requireReason(value: unknown) {
  const reason = String(value ?? "").trim();
  return reason.length >= 3 ? reason : "";
}

function roleResponse(role: DemoRoleDefinition) {
  const assignedUserIds = new Set(userRoleAssignments
    .filter((assignment) => assignment.status === "Active" && canonicalRoleName(assignment.roleName) === canonicalRoleName(role.name))
    .map((assignment) => assignment.userId));
  return {
    ...role,
    assignedUserCount: assignedUserIds.size,
    capabilityCount: role.permissions.length
  };
}

function capabilityRows() {
  return Object.entries(permissions).map(([id, description]) => ({ id, description }));
}

function hasUsableAuthenticationPath(user: DemoUserAccount, policy: AuthenticationPolicy = user.authenticationPolicy) {
  if (user.status !== "Active") return false;
  if (!productMethodsForPolicy(policy).length) return false;
  return localDevelopmentAuthEnabled() ? userHasLocalDevelopmentIdentity(user) : true;
}

function isUsableAdmin(userId: string, policyOverride?: AuthenticationPolicy) {
  const user = userById(userId);
  if (!user) return false;
  if (!refreshUserRoleSnapshot(user).permissions.includes("admin:manage")) return false;
  return hasUsableAuthenticationPath(user, policyOverride ?? user.authenticationPolicy);
}

function activeAdminIds() {
  return users.filter((user) => isUsableAdmin(user.id)).map((user) => user.id);
}

function wouldRemoveLastAdmin(userId: string) {
  return isUsableAdmin(userId) && activeAdminIds().length <= 1;
}

function wouldPolicyRemoveLastAdmin(user: DemoUserAccount, nextPolicy: AuthenticationPolicy) {
  if (!isUsableAdmin(user.id)) return false;
  const otherUsableAdmins = activeAdminIds().filter((id) => id !== user.id).length;
  const userRemainsUsable = refreshUserRoleSnapshot(user).permissions.includes("admin:manage") && hasUsableAuthenticationPath(user, nextPolicy);
  return otherUsableAdmins + (userRemainsUsable ? 1 : 0) === 0;
}

function adminDirectoryActor(): DirectoryActor {
  const user = userById(demoUserIds.admin) ?? users[0]!;
  const access = refreshUserRoleSnapshot(user);
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    roles: access.roles,
    permissions: access.permissions,
    roleAssignments: activeRoleAssignmentsFor(user.id)
  };
}

function lifecycleImpactForUser(userId: string) {
  const user = userById(userId);
  const linkedMemberProfileId = user?.linkedMemberProfileId ?? null;
  let directoryAvailable = true;
  let rosterAvailable = true;
  let groupMemberships = 0;
  let groupLeaderships = 0;
  let rosterShifts = 0;

  try {
    const groups = memberDirectoryForAdmin?.listGroups({ limit: 200, offset: 0 }).data ?? [];
    if (linkedMemberProfileId) {
      groupMemberships = groups.filter((group) => Array.isArray(group.memberIds) && group.memberIds.includes(linkedMemberProfileId)).length;
      groupLeaderships = groups.filter((group) => group.leaderId === linkedMemberProfileId).length;
    }
  } catch {
    directoryAvailable = false;
  }

  try {
    if (linkedMemberProfileId) {
      const shifts = rosteringForAdmin?.listShifts({ limit: 200, offset: 0, memberProfileId: linkedMemberProfileId }, adminDirectoryActor()).data ?? [];
      rosterShifts = shifts.filter((shift) => !["Cancelled", "Completed"].includes(String(shift.status))).length;
    }
  } catch {
    rosterAvailable = false;
  }

  const activeAssignments = assignments.filter((assignment) => assignment.assignedUserId === userId && !["Completed", "Cancelled"].includes(String(assignment.status)));
  const activeOverrides = permissionOverrides.filter((override) => (
    override.userId === userId &&
    override.active &&
    (!override.expiresAt || new Date(override.expiresAt).getTime() > Date.now())
  ));
  const roleAssignments = activeRoleAssignmentsFor(userId);
  const pendingInvitations = userInvitations
    .filter((invitation) => invitation.userId === userId)
    .map((invitation) => expireInvitationIfNeeded(invitation))
    .filter((invitation) => invitationStillAcceptable(invitation));

  return {
    userId,
    generatedAt: now(),
    available: directoryAvailable && rosterAvailable,
    assignments: {
      active: activeAssignments.length,
      open: activeAssignments.filter((assignment) => assignment.status === "Open").length,
      claimed: activeAssignments.filter((assignment) => assignment.status !== "Open").length
    },
    rosterShifts: { active: rosterShifts },
    groups: {
      memberships: groupMemberships,
      leaderships: groupLeaderships,
      scopedRoleAssignments: roleAssignments.filter((assignment) => assignment.scopeType === "GROUP").length,
      coordinatorRoles: roleAssignments.filter((assignment) => canonicalRoleName(assignment.roleName).includes("coordinator")).length
    },
    memberProfile: { linked: Boolean(linkedMemberProfileId), id: linkedMemberProfileId },
    invitations: { active: pendingInvitations.length, latest: invitationSummaryForUser(userId) },
    access: {
      roleAssignments: roleAssignments.length,
      activeGrants: activeOverrides.filter((override) => override.effect === "GRANT").length,
      activeDenies: activeOverrides.filter((override) => override.effect === "DENY").length
    }
  };
}

function accessHistoryFor(userId: string) {
  return auditLogs
    .filter((log) => (log.entityType === "userAccount" && log.entityId === userId) || log.metadata?.targetUserId === userId)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
}

function notifyAccessChange(userId: string, title: string, message: string, sourceId: string) {
  try {
    notificationsForAdmin?.create({
      deduplicationKey: `access:${sourceId}:${userId}:${Date.now()}`,
      recipientUserId: userId,
      kind: "Information",
      severity: "Information",
      category: "Admin",
      title,
      message,
      sourceType: "access",
      sourceId,
      actionDestination: "/settings",
      actionLabel: "Review account"
    });
  } catch {
    // Access mutations must not be rolled back because notification delivery failed.
  }
}

function updateUser(user: DemoUserAccount, patch: Partial<DemoUserAccount>, actorId: string) {
  Object.assign(user, patch, { updatedAt: now(), updatedByUserId: actorId, version: user.version + 1 });
  refreshUserRoleSnapshot(user);
  return user;
}

function effectiveAccessDetail(userId: string) {
  const user = userById(userId);
  if (!user) return undefined;
  const access = refreshUserRoleSnapshot(user);
  const roleSources = new Map<Permission, Array<{ source: string; roleName: string; roleDisplayName: string; scopeType: string; scopeId?: string | null; scopeLabel: string }>>();
  for (const assignment of access.roleAssignments) {
    const role = roleDefinition(assignment.roleName);
    const source = assignment.scopeType === "GROUP" ? "Scoped Role" : "Role";
    for (const permission of role?.permissions ?? []) {
      const current = roleSources.get(permission) ?? [];
      current.push({
        source,
        roleName: canonicalRoleName(assignment.roleName),
        roleDisplayName: role?.displayName ?? roleDisplayName(assignment.roleName, roles),
        scopeType: assignment.scopeType,
        scopeId: assignment.scopeId ?? null,
        scopeLabel: assignment.scopeType === "GROUP" ? groupSummary(assignment.scopeId)?.name ?? "Group" : "Global"
      });
      roleSources.set(permission, current);
    }
  }

  const activeGrantByPermission = new Map(access.grants.map((grant) => [grant.permission, grant]));
  const activeDenyByPermission = new Map(access.denies.map((deny) => [deny.permission, deny]));
  const data = capabilityRows().map((capability) => {
    const permission = capability.id as Permission;
    const denied = activeDenyByPermission.get(permission);
    const granted = activeGrantByPermission.get(permission);
    const roleBased = roleSources.get(permission) ?? [];
    const allowed = access.permissions.includes(permission);
    return {
      permission,
      description: capability.description,
      allowed,
      decision: denied ? "Denied" : allowed ? "Allowed" : "Not granted",
      source: denied ? "User Deny" : granted ? "User Grant" : roleBased.length ? roleBased[0]!.source : "Not granted",
      sources: [
        ...roleBased,
        ...(granted ? [{ source: "User Grant", reason: granted.reason ?? "", expiresAt: granted.expiresAt ?? null }] : []),
        ...(denied ? [{ source: "User Deny", reason: denied.reason ?? "", expiresAt: denied.expiresAt ?? null }] : [])
      ]
    };
  });

  return {
    user: adminUserResponse(user),
    assignedRoles: access.roleAssignments.map(roleAssignmentResponse),
    roleDerivedCapabilities: Array.from(roleSources.keys()),
    activeGrants: access.grants,
    activeDenies: access.denies,
    expiredOrRevokedOverrides: access.expiredOrRevokedOverrides,
    finalCapabilities: access.permissions,
    restrictions: wouldRemoveLastAdmin(user.id) ? ["This is the final active administrative access path. Assign another active System Admin before removing it."] : [],
    data
  };
}

function replaceUserRoleAssignments(userId: string, nextAssignments: Array<Pick<RoleAssignment, "roleName" | "scopeType" | "scopeId">>, actorId?: string) {
  const nowValue = now();
  for (const assignment of userRoleAssignments) {
    if (assignment.userId === userId && assignment.status === "Active") {
      assignment.status = "Revoked";
      assignment.revokedAt = nowValue;
      assignment.revokedByUserId = actorId ?? null;
    }
  }

  for (const assignment of nextAssignments) {
    const roleName = canonicalRoleName(assignment.roleName);
    userRoleAssignments.push({
      id: `ura-${userId.slice(-4)}-${roleName}-${userRoleAssignments.length + 1}`,
      userId,
      roleName,
      scopeType: assignment.scopeType,
      scopeId: assignment.scopeId ?? null,
      status: "Active",
      assignedAt: nowValue,
      assignedByUserId: actorId ?? null
    });
  }
}

function createRow(resource: string, body: Row, req?: Request) {
  const rows = resources[resource] ?? [];
  const prefix = idPrefixes[resource] ?? "REC";
  const nextNumber = rows.length + 1;
  const user = req ? currentUser(req) : undefined;
  const row: Row = {
    ...body,
    id: body.id ?? `${prefix.toLowerCase()}-demo-${nextNumber}`,
    operationalId: body.operationalId ?? `${prefix}-2026-${String(nextNumber).padStart(prefix === "SES" ? 3 : 6, "0")}`,
    createdById: body.createdById ?? user?.id,
    updatedById: body.updatedById ?? user?.id,
    createdAt: now(),
    updatedAt: now()
  };
  rows.unshift(row);
  resources[resource] = rows;
  return row;
}

function updateRow(resource: string, id: string, patch: Row, req?: Request) {
  const rows = resources[resource] ?? [];
  const row = rows.find((item) => item.id === id);
  if (!row) return undefined;
  Object.assign(row, patch, { updatedById: req ? currentUser(req).id : row.updatedById, updatedAt: now() });
  return row;
}

function demoMatchingLinkError(input: Row, excludeMatchId?: string) {
  if (!input.familyRecordId || !input.passengerRecordId) return { status: 400, error: "A Family/NOK record and Passenger/SRC record are required" };
  const family = familyRecords.find((item) => item.id === input.familyRecordId);
  const passenger = passengerRecords.find((item) => item.id === input.passengerRecordId);
  const enquiry = input.enquiryId ? enquiries.find((item) => item.id === input.enquiryId) : undefined;
  if (!family) return { status: 404, error: "Family/NOK record not found" };
  if (!passenger) return { status: 404, error: "Passenger/SRC record not found" };
  if (input.enquiryId && !enquiry) return { status: 404, error: "TEC enquiry not found" };
  if (family.sessionId !== input.sessionId || passenger.sessionId !== input.sessionId || (enquiry && enquiry.sessionId !== input.sessionId)) {
    return { status: 409, error: "Matching links must belong to the active session" };
  }
  if (family.caseId && passenger.caseId && family.caseId !== passenger.caseId) {
    return { status: 409, error: "Family/NOK and Passenger/SRC records belong to different cases" };
  }
  const duplicate = matchingRecords.find(
    (item) =>
      item.id !== excludeMatchId &&
      item.sessionId === input.sessionId &&
      item.familyRecordId === input.familyRecordId &&
      item.passengerRecordId === input.passengerRecordId &&
      item.status !== "Rejected"
  );
  if (duplicate) return { status: 409, error: `An open matching record already links these records (${duplicate.operationalId})` };
  return null;
}

function demoReleaseMatchError(input: Row) {
  if (!input.matchId) return { status: 400, error: "A verified matching record is required" };
  const match = matchingRecords.find((item) => item.id === input.matchId);
  if (!match) return { status: 404, error: "Matching record not found" };
  if (match.sessionId !== input.sessionId) return { status: 409, error: "Matching record belongs to a different session" };
  if (!["Verified match", "Reunited", "Released"].includes(String(match.status))) {
    return { status: 409, error: "Reunification/release requires a verified match" };
  }
  if (!isNoHold(match.holdCheck)) return { status: 409, error: "Hold blocks reunification/release until cleared" };
  return null;
}

function addAudit(req: Request, action: string, summary: string, sessionId = "ses-demo-1", metadata?: Row, entityType = "demo", entityId?: string | null) {
  const actor = currentUser(req);
  auditLogs.unshift({
    id: `aud-demo-${auditLogs.length + 1}`,
    action,
    entityType,
    entityId: entityId ?? null,
    sessionId,
    actorId: actor.id,
    actorEmail: actor.email,
    actorDisplayName: actor.displayName,
    actorRoles: actor.roles.map((roleName) => defaultRoles.find((role) => role.name === roleName)?.displayName ?? roleName),
    summary,
    metadata,
    createdAt: now()
  });
}

function addTimeline(req: Request, input: Row) {
  timeline.unshift({
    id: `tle-demo-${timeline.length + 1}`,
    sessionId: input.sessionId ?? activeSessionId(req),
    caseId: input.caseId ?? null,
    eventType: input.eventType,
    entityType: input.entityType,
    entityId: input.entityId,
    title: input.title,
    body: input.body,
    metadata: input.metadata,
    occurredAt: now(),
    createdById: currentUser(req).id,
    createdAt: now()
  });
}

function demoDecisionNote(value: unknown) {
  const note = String(value ?? "").trim();
  return note.length >= 3 ? note : "";
}

function demoNameFromParts(firstName?: unknown, lastName?: unknown) {
  return [lastName, firstName].filter(Boolean).map(String).join(", ");
}

function demoName(row?: Row) {
  return row ? demoNameFromParts(row.firstName, row.lastName) : "";
}

function demoMatchingContext(row: Row): Row {
  const family = familyRecords.find((item) => item.id === row.familyRecordId);
  const passenger = passengerRecords.find((item) => item.id === row.passengerRecordId);
  const enquiry = enquiries.find((item) => item.id === row.enquiryId);
  return {
    ...row,
    familyOperationalId: family?.operationalId ?? null,
    familyName: demoName(family),
    passengerOperationalId: passenger?.operationalId ?? null,
    passengerName: demoName(passenger),
    passengerType: passenger?.personType ?? null,
    enquiryOperationalId: enquiry?.operationalId ?? null,
    enquiryCallerName: enquiry?.callerName ?? null,
    claimedRelationship: family?.claimedRelationship ?? enquiry?.claimedRelationship ?? null
  };
}

function demoRequestContext(row: Row): Row {
  const family = familyRecords.find((item) => item.id === row.relatedFamilyRecordId);
  const passenger = passengerRecords.find((item) => item.id === row.relatedPassengerRecordId);
  const enquiry = enquiries.find((item) => item.id === row.relatedEnquiryId);
  return {
    ...row,
    familyOperationalId: family?.operationalId ?? null,
    familyName: demoName(family),
    passengerOperationalId: passenger?.operationalId ?? null,
    passengerName: demoName(passenger),
    enquiryOperationalId: enquiry?.operationalId ?? null,
    enquiryCallerName: enquiry?.callerName ?? null
  };
}

function demoFamilyContext(row: Row): Row {
  return {
    ...row,
    familyName: demoName(row),
    passengerName: demoNameFromParts(row.passengerFirstName, row.passengerLastName)
  };
}

function demoEnquiryContext(row: Row): Row {
  return {
    ...row,
    enquiryCallerName: row.callerName ?? null,
    passengerName: demoNameFromParts(row.passengerFirstName, row.passengerLastName)
  };
}

function operationalExportRows(type: string, rows: Row[]) {
  if (type === "enquiry-log") {
    return rows.map((row) => ({
      operationalId: row.operationalId,
      caseId: row.caseId,
      contactChannel: row.contactChannel,
      callerName: row.callerName,
      callerPhone: row.callerPhone,
      callerEmail: row.callerEmail,
      callerLocation: row.callerLocation,
      preferredLanguage: row.preferredLanguage,
      claimedRelationship: row.claimedRelationship,
      passengerName: demoNameFromParts(row.passengerFirstName, row.passengerLastName),
      enquiryType: row.enquiryType,
      urgency: row.urgency,
      status: row.status,
      notes: row.notes,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }));
  }
  if (type === "family-register") {
    return rows.map((row) => ({
      operationalId: row.operationalId,
      caseId: row.caseId,
      familyName: demoName(row),
      claimedRelationship: row.claimedRelationship,
      phone: row.phone,
      email: row.email,
      preferredContactChannel: row.preferredContactChannel,
      preferredLanguage: row.preferredLanguage,
      verificationStatus: row.verificationStatus,
      verificationNotes: row.verificationNotes,
      immediateNeeds: row.immediateNeeds,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }));
  }
  if (type === "passenger-register") {
    return rows.map((row) => ({
      operationalId: row.operationalId,
      caseId: row.caseId,
      personType: row.personType,
      passengerName: demoName(row),
      dateOfBirth: row.dateOfBirth,
      age: row.age,
      gender: row.gender,
      nationality: row.nationality,
      flightNumber: row.flightNumber,
      route: row.route,
      seat: row.seat,
      pnr: row.pnr,
      ticketNumber: row.ticketNumber,
      manifestVersion: row.manifestVersion,
      source: row.source,
      conditionStatus: row.conditionStatus,
      holdStatus: row.holdStatus,
      travellingCompanions: row.travellingCompanions,
      notes: row.notes,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }));
  }
  if (type === "matching-log") {
    return rows.map((row) => {
      const context = demoMatchingContext(row);
      return {
        operationalId: row.operationalId,
        caseId: row.caseId,
        familyOperationalId: context.familyOperationalId,
        passengerOperationalId: context.passengerOperationalId,
        enquiryOperationalId: context.enquiryOperationalId,
        status: row.status,
        matchBasis: row.matchBasis,
        holdCheck: row.holdCheck,
        decisionNotes: row.decisionNotes,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
      };
    });
  }
  if (type === "requests-log") {
    return rows.map((row) => {
      const context = demoRequestContext(row);
      return {
        operationalId: row.operationalId,
        caseId: row.caseId,
        category: row.category,
        priority: row.priority,
        requester: row.requester,
        ownerAssignedTo: row.ownerAssignedTo,
        details: row.details,
        approvalStatus: row.approvalStatus,
        status: row.status,
        enquiryOperationalId: context.enquiryOperationalId,
        familyOperationalId: context.familyOperationalId,
        passengerOperationalId: context.passengerOperationalId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
      };
    });
  }
  if (type === "audit-log") {
    return rows.map((row) => ({
      action: row.action,
      actorEmail: row.actorEmail,
      actorDisplayName: row.actorDisplayName,
      summary: row.summary,
      createdAt: row.createdAt
    }));
  }
  return [];
}

function dashboard(req: Request, sessionId: string) {
  const session = sessions.find((item) => item.id === sessionId);
  const canReadEnquiries = can(req, "enquiry:read");
  const canReadFamily = can(req, "family:read");
  const canReadPassengers = can(req, "passenger:read");
  const canReadMatching = can(req, "matching:read");
  const canReadRequests = can(req, "request:read");
  const canReadRelease = can(req, "release:read");
  const canReadImport = can(req, "import:create");
  const canReadMatchingContext = canReadMatching && canReadFamily && canReadPassengers && canReadEnquiries;
  const canReadAllAggregates = canReadEnquiries && canReadFamily && canReadPassengers && canReadMatching && canReadRequests && canReadRelease && canReadImport;
  const openRequests = canReadRequests
    ? requests.filter((item) => item.sessionId === sessionId && !terminalStatuses.has(item.status)).length
    : 0;
  const urgentWelfare = canReadEnquiries
    ? enquiries.filter((item) => item.sessionId === sessionId && item.urgency === "Urgent welfare").length
    : 0;
  const kpis: Record<string, number> = {};
  const priorityQueue: Record<string, Row[]> = {};
  const status: Record<string, Record<string, number>> = {};

  if (canReadEnquiries) {
    kpis.enquiries = enquiries.filter((item) => item.sessionId === sessionId).length;
    kpis.urgentWelfare = urgentWelfare;
    priorityQueue.unlinkedEnquiries = enquiries
      .filter((item) => item.sessionId === sessionId && !matchingRecords.some((match) => match.enquiryId === item.id))
      .map(demoEnquiryContext);
  }
  if (canReadFamily) {
    kpis.familyRecords = familyRecords.filter((item) => item.sessionId === sessionId).length;
    priorityQueue.unverifiedFamily = familyRecords
      .filter((item) => item.sessionId === sessionId && item.verificationStatus !== "Verified")
      .map(demoFamilyContext);
  }
  if (canReadPassengers) {
    kpis.passengerRecords = passengerRecords.filter((item) => item.sessionId === sessionId).length;
  }
  if (canReadMatching) {
    const sessionMatches = matchingRecords.filter((item) => item.sessionId === sessionId);
    kpis.matchingRecords = sessionMatches.length;
    kpis.holds = sessionMatches.filter((item) => item.holdCheck !== "No hold").length;
    kpis.verifiedReunited = sessionMatches.filter((item) => ["Verified match", "Reunited", "Released"].includes(item.status)).length;
    status.matching = Object.fromEntries(["Suggested", "Potential match", "Verified match", "Hold / escalate", "Reunited", "Released"].map((itemStatus) => [itemStatus, sessionMatches.filter((item) => item.status === itemStatus).length]));
    priorityQueue.unresolvedHolds = sessionMatches
      .filter((item) => item.holdCheck !== "No hold")
      .map((item) => canReadMatchingContext ? demoMatchingContext(item) : item);
    priorityQueue.pendingMatching = sessionMatches
      .filter((item) => ["Suggested", "Potential match"].includes(item.status))
      .map((item) => canReadMatchingContext ? demoMatchingContext(item) : item);
  }
  if (canReadRequests) {
    const sessionRequests = requests.filter((item) => item.sessionId === sessionId);
    kpis.openRequests = openRequests;
    status.requests = Object.fromEntries(["Open", "Assigned", "In progress", "Closed"].map((itemStatus) => [itemStatus, sessionRequests.filter((item) => item.status === itemStatus).length]));
    priorityQueue.urgentRequests = sessionRequests
      .filter((item) => item.priority === "Urgent" && !terminalStatuses.has(item.status))
      .map((item) => canReadFamily && canReadPassengers && canReadEnquiries ? demoRequestContext(item) : item);
  }

  return {
    session,
    sessionLabel: session ? `${session.mode} ${session.operationalId}` : undefined,
    kpis,
    priorityQueue,
    status,
    ...(canReadAllAggregates ? buildDashboardAggregates(sessionId, openRequests, urgentWelfare) : {})
  };
}

function ensureWritableSession(sessionId: string) {
  const session = sessions.find((item) => item.id === sessionId);
  if (!session) throw new DirectoryError(404, "Session not found");
  if (["Closed", "Archived"].includes(String(session.status))) throw new DirectoryError(409, "The selected session is read-only");
  return session;
}

export function createDemoRouter(options: {
  incidentRepository?: IncidentRepository;
  enquiryRepository?: EnquiryRepository;
  incidentAccessRepository?: IncidentAccessRepository;
  incidentAssignmentRepository?: IncidentAssignmentRepository;
  passengerRepository?: PassengerRepository;
} = {}) {
  const router = Router();
  const memoryIncidentAssignments: MemoryIncidentAssignment[] = sessions.flatMap((incident) =>
    users
      .filter((user) => user.status === "Active")
      .map((user) => ({
        id: randomUUID(),
        incidentId: String(incident.id),
        userId: user.id,
        userEmail: user.email,
        function: "Demo incident access",
        scope: "OPERATIONAL",
        active: true,
        createdAt: String(incident.createdAt ?? now()),
        createdById: demoUserIds.admin,
        revokedAt: null,
        revokedById: null,
        revokeReason: null,
        updatedAt: String(incident.updatedAt ?? incident.createdAt ?? now())
      }))
  );
  const incidentAccessRepository = options.incidentAccessRepository ?? createMemoryIncidentAccessRepository({
    incidents: sessions,
    assignments: memoryIncidentAssignments
  });
  const incidentAccessService = createIncidentAccessService(incidentAccessRepository);
  const incidentRepository = options.incidentRepository ?? createMemoryIncidentRepository({
    sessions,
    auditLogs,
    timeline,
    incidentAssignments: memoryIncidentAssignments,
    now
  });
  const incidentService = createIncidentService(incidentRepository, incidentAccessService);
  const incidentAssignmentRepository = options.incidentAssignmentRepository ?? createMemoryIncidentAssignmentRepository({
    incidents: sessions,
    assignments: memoryIncidentAssignments,
    users,
    auditLogs,
    now
  });
  const incidentAssignmentService = createIncidentAssignmentService(incidentAssignmentRepository, incidentAccessService);
  const enquiryRepository = options.enquiryRepository ?? createMemoryEnquiryRepository({
    enquiries,
    passengers: passengerRecords,
    auditLogs,
    timeline,
    now
  });
  const enquiryService = createEnquiryService(enquiryRepository, incidentAccessService);
  const passengerRepository = options.passengerRepository ?? createMemoryPassengerRepository({
    passengers: passengerRecords,
    importBatches,
    auditLogs,
    timeline,
    now
  });
  const passengerService = createPassengerService(passengerRepository, incidentAccessService);
  if (enquiryRepository.kind === "postgres") enquiries.splice(0, enquiries.length);
  if (passengerRepository.kind === "postgres") passengerRecords.splice(0, passengerRecords.length);
  const syncIncident = (record: Record<string, unknown>) => {
    const index = sessions.findIndex((item) => item.id === record.id);
    if (index >= 0) sessions[index] = { ...record };
    else sessions.unshift({ ...record });
  };
  const syncEnquiry = (record: Record<string, unknown>) => {
    const index = enquiries.findIndex((item) => item.id === record.id);
    if (index >= 0) enquiries[index] = { ...record };
    else enquiries.unshift({ ...record });
  };
  const syncPassenger = (record: Record<string, unknown>) => {
    const index = passengerRecords.findIndex((item) => item.id === record.id);
    if (index >= 0) passengerRecords[index] = { ...record };
    else passengerRecords.unshift({ ...record });
  };
  const memberDirectory = createMemberDirectoryRepository(users.map((user) => ({ id: user.id, email: user.email, displayName: user.displayName, roles: user.roles })));
  memberDirectoryForAdmin = memberDirectory;
  const rostering = createRosteringRepository(memberDirectory);
  rosteringForAdmin = rostering;
  const training = createTrainingRepository(memberDirectory);
  const documentsRepository = createDocumentRepository(memberDirectory);
  const readiness = createReadinessService({ directory: memberDirectory, training, documents: documentsRepository, rostering });
  const activeEvent = createActiveEventService({ users, sessions, assignments, enquiries, familyRecords, passengerRecords, matchingRecords, releases, requests });
  const notifications = createNotificationService({ users, sessions, assignments, directory: memberDirectory, rostering, training, documents: documentsRepository, activeEvent, permissionsForRoleNames });
  notificationsForAdmin = notifications;

  const notifySafely = (handler: () => void) => {
    try {
      handler();
    } catch {
      // Notifications must never make the source workflow fail.
    }
  };

  router.get("/health", (_req, res) => {
    res.json({ ok: true, service: "zpp-connect-api", persistence: incidentService.kind });
  });

  router.get("/auth/config", (_req, res) => {
    res.json({ developmentAccessEnabled: localDevelopmentAuthEnabled() });
  });

  const discoverAuthentication = (req: Request, res: any) => {
    const identifier = String(req.body?.identifier ?? req.body?.email ?? "").trim().toLowerCase();
    const user = identifier ? userByEmail(identifier) : undefined;
    if (!user || user.status !== "Active") {
      res.json({
        accountEligible: false,
        permittedMethods: [],
        message: genericSignInError()
      });
      return;
    }
    res.json({
      accountEligible: true,
      authenticationPolicy: user.authenticationPolicy,
      permittedMethods: productMethodsForPolicy(user.authenticationPolicy),
      message: user.authenticationPolicy === "SSO_ONLY"
        ? "Continue with Microsoft for this account."
        : user.authenticationPolicy === "PASSWORD_ONLY"
          ? "Email sign-in is available for this account."
          : "Microsoft and email sign-in are available for this account."
    });
  };

  router.post("/auth/discovery", discoverAuthentication);
  router.post("/auth/discover", discoverAuthentication);

  router.get("/auth/development/users", (_req, res) => {
    if (!localDevelopmentAuthEnabled()) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const data = users
      .filter((user) => user.status === "Active" && userHasLocalDevelopmentIdentity(user))
      .sort((left, right) => left.displayName.localeCompare(right.displayName))
      .map(developmentUserResponse);
    res.json({ data });
  });

  router.post("/auth/development/login", (req, res) => {
    if (!localDevelopmentAuthEnabled()) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const requestedUserId = String(req.body?.userId ?? "").trim();
    const requestedEmail = String(req.body?.email ?? "").trim().toLowerCase();
    const user = requestedUserId ? userById(requestedUserId) : requestedEmail ? userByEmail(requestedEmail) : undefined;
    const requestedMethod = String(req.body?.method ?? "MICROSOFT_SSO").trim() as AuthenticationMethod;
    if (!user || user.status !== "Active" || !userHasLocalDevelopmentIdentity(user)) {
      res.status(401).json({ error: genericSignInError() });
      return;
    }
    if (!["MICROSOFT_SSO", "EMAIL_PASSWORD"].includes(requestedMethod) || !policyAllowsProductMethod(user.authenticationPolicy, requestedMethod)) {
      res.status(403).json({ error: genericSignInError() });
      return;
    }
    const timestamp = now();
    const session: LocalAuthSession = {
      id: `auth-${randomUUID()}`,
      token: randomUUID(),
      userId: user.id,
      authenticationMethod: localMethodForProductMethod(requestedMethod),
      createdAt: timestamp,
      lastSeenAt: timestamp,
      revokedAt: null
    };
    localAuthSessions.set(session.token, session);
    const identity = externalIdentities.find((item) => item.userId === user.id && !item.disabledAt && (item.providerType === "LOCAL_DEV" || item.providerType === "DEVELOPMENT"));
    if (identity) {
      identity.lastSeenAt = timestamp;
      identity.lastSuccessfulAuthenticationAt = timestamp;
      identity.version += 1;
    }
    req.user = toAuthenticatedUser(user, { touchSignIn: true });
    addAudit(req, "local_authentication_completed", "Signed in", activeSessionId(req), {
      targetUserId: user.id,
      sessionId: session.id,
      authenticationPolicy: user.authenticationPolicy,
      authenticationMethod: session.authenticationMethod
    }, "accountSession", session.id);
    res.json({
      session: {
        id: session.id,
        token: session.token,
        userId: session.userId,
        authenticationMethod: session.authenticationMethod,
        createdAt: session.createdAt
      },
      user: req.user
    });
  });

  router.post("/auth/logout", (req, res) => {
    const token = bearerToken(req);
    const session = token ? localAuthSessions.get(token) : undefined;
    if (session && !session.revokedAt) session.revokedAt = now();
    res.status(204).send();
  });

  router.use((req, res, next) => {
    if (config.authMode === "entra") {
      void authenticate(req, res, next);
      return;
    }
    const user = demoUserForRequest(req);
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    req.user = toAuthenticatedUser(user);
    next();
  });

  router.get("/auth/me", (req, res) => {
    res.json({ user: req.user });
  });

  router.get("/config/profile", (_req, res) => res.json(defaultProfile));
  router.get("/dictionaries", (_req, res) => res.json(dictionaryRows()));
  router.use(createIncidentRouter(incidentService, {
    onList: incidentService.kind === "postgres"
      ? (records, query) => {
          if (query.offset === 0) sessions.splice(0, sessions.length);
          records.forEach(syncIncident);
        }
      : undefined,
    onChange: incidentService.kind === "postgres" ? syncIncident : undefined
  }));
  router.use(createIncidentAssignmentRouter(incidentAssignmentService));
  router.use(createEnquiryRouter(enquiryService, {
    onList: enquiryService.kind === "postgres"
      ? (records, incidentId, offset) => {
          if (offset === 0) {
            for (let index = enquiries.length - 1; index >= 0; index -= 1) {
              if (enquiries[index]?.sessionId === incidentId) enquiries.splice(index, 1);
            }
          }
          records.forEach(syncEnquiry);
        }
      : undefined,
    onChange: enquiryService.kind === "postgres" ? syncEnquiry : undefined
  }));
  router.use(createPassengerRouter(passengerService, {
    onList: passengerService.kind === "postgres"
      ? (records, incidentId, offset) => {
          if (offset === 0) {
            for (let index = passengerRecords.length - 1; index >= 0; index -= 1) {
              if (passengerRecords[index]?.sessionId === incidentId) passengerRecords.splice(index, 1);
            }
          }
          records.forEach(syncPassenger);
        }
      : undefined,
    onChange: passengerService.kind === "postgres" ? syncPassenger : undefined
  }));
  const requireIncidentAccess = (resolveIncidentId: (req: Request) => string, hydrateEnquiryCompatibility = false, requireWritable = false) => (req: Request, _res: any, next: NextFunction) => {
    const incidentId = resolveIncidentId(req);
    if (!req.user || !incidentId) {
      next(new HttpError(400, "Incident is required."));
      return;
    }
    const accessActor = { id: req.user.id, email: req.user.email, roles: req.user.roles };
    void (async () => {
      const incidentContext = await incidentAccessService.authorize(accessActor, incidentId);
      if (requireWritable && !incidentContext.writable) throw new HttpError(409, "The selected incident is read-only");
      if (hydrateEnquiryCompatibility && enquiryService.kind === "postgres" && can(req, "enquiry:read")) {
        let offset = 0;
        let total = 0;
        const records: Row[] = [];
        do {
          const page = await enquiryService.list(accessActor, incidentId, { limit: 200, offset });
          total = page.total;
          records.push(...page.data);
          if (page.data.length === 0) break;
          offset += page.data.length;
        } while (offset < total);
        for (let index = enquiries.length - 1; index >= 0; index -= 1) {
          if (enquiries[index]?.sessionId === incidentId) enquiries.splice(index, 1);
        }
        records.forEach(syncEnquiry);
      }
      if (hydrateEnquiryCompatibility && passengerService.kind === "postgres" && can(req, "passenger:read")) {
        let offset = 0;
        let total = 0;
        const records: Row[] = [];
        do {
          const page = await passengerService.list(accessActor, incidentId, {
            limit: 200,
            offset,
            sortBy: "updatedAt",
            sortDirection: "desc"
          });
          total = page.total;
          records.push(...page.data);
          if (page.data.length === 0) break;
          offset += page.data.length;
        } while (offset < total);
        for (let index = passengerRecords.length - 1; index >= 0; index -= 1) {
          if (passengerRecords[index]?.sessionId === incidentId) passengerRecords.splice(index, 1);
        }
        records.forEach(syncPassenger);
      }
      next();
    })().catch(next);
  };
  router.get("/notifications", requirePermission("session:read"), (req, res) => res.json(notifications.list(req.user, req.query)));
  router.get("/notifications/counts", requirePermission("session:read"), (req, res) => res.json(notifications.counts(req.user)));
  router.get("/notifications/:id", requirePermission("session:read"), (req, res) => {
    const notification = notifications.get(req.user, String(req.params.id));
    if (!notification) {
      res.status(404).json({ error: "Notification not found" });
      return;
    }
    res.json(notification);
  });
  router.post("/notifications/read-all", requirePermission("session:read"), (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : undefined;
    res.json(notifications.markAllRead(req.user, ids));
  });
  router.post("/notifications/:id/read", requirePermission("session:read"), (req, res) => {
    const notification = notifications.markRead(req.user, String(req.params.id));
    if (!notification) {
      res.status(404).json({ error: "Notification not found" });
      return;
    }
    res.json(notification);
  });
  router.post("/notifications/:id/unread", requirePermission("session:read"), (req, res) => {
    const notification = notifications.markUnread(req.user, String(req.params.id));
    if (!notification) {
      res.status(404).json({ error: "Notification not found" });
      return;
    }
    res.json(notification);
  });

  const activeEventRoute = (handler: (req: Request) => unknown, status = 200) => (req: Request, res: any) => {
    try {
      res.status(status).json(handler(req));
    } catch (error) {
      if (error instanceof ActiveEventError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  };

  router.get("/sessions/:sessionId/active-event", requirePermission("briefing:read"), requireIncidentAccess((req) => String(req.params.sessionId), true), activeEventRoute((req) => activeEvent.getActiveEvent(String(req.params.sessionId), directoryActor(req))));
  router.get("/sessions/:sessionId/briefings", requirePermission("briefing:read-history"), activeEventRoute((req) => activeEvent.listRevisions(String(req.params.sessionId), directoryActor(req))));
  router.get("/sessions/:sessionId/briefings/current", requirePermission("briefing:read"), activeEventRoute((req) => activeEvent.getCurrent(String(req.params.sessionId), directoryActor(req))));
  router.get("/briefings/:briefingId", requirePermission("briefing:read"), activeEventRoute((req) => activeEvent.getBriefing(String(req.params.briefingId), directoryActor(req))));
  router.post("/sessions/:sessionId/briefings/draft", requirePermission("briefing:create-draft"), activeEventRoute((req) => {
    const result = activeEvent.createDraft(String(req.params.sessionId), directoryActor(req));
    if (result.created) {
      addAudit(req, "briefing_draft_created", `Briefing draft revision ${result.briefing.revision} created`, result.briefing.sessionId, {
        briefingId: result.briefing.id,
        revision: result.briefing.revision
      }, "operationalBriefing", result.briefing.id);
    }
    return result;
  }));
  router.patch("/briefings/:briefingId", requirePermission("briefing:update-draft"), activeEventRoute((req) => {
    const result = activeEvent.updateDraft(String(req.params.briefingId), req.body ?? {}, directoryActor(req));
    addAudit(req, "briefing_draft_updated", `Briefing draft revision ${result.briefing.revision} updated`, result.briefing.sessionId, {
      briefingId: result.briefing.id,
      revision: result.briefing.revision,
      changedSections: result.changedSections
    }, "operationalBriefing", result.briefing.id);
    for (const change of result.assignmentRelationChanges ?? []) {
      const action = change.changeType === "linked" ? "briefing_priority_assignment_linked" : change.changeType === "changed" ? "briefing_priority_assignment_changed" : "briefing_priority_assignment_unlinked";
      const summary = change.changeType === "linked" ? "Assignment linked to briefing priority" : change.changeType === "changed" ? "Assignment link changed on briefing priority" : "Assignment unlinked from briefing priority";
      addAudit(req, action, summary, result.briefing.sessionId, {
        briefingId: result.briefing.id,
        revision: result.briefing.revision,
        priorityId: change.priorityId,
        oldAssignmentId: change.oldAssignmentId,
        newAssignmentId: change.newAssignmentId,
        timestamp: change.timestamp
      }, "operationalBriefing", result.briefing.id);
    }
    return result.briefing;
  }));
  router.post("/briefings/:briefingId/publish", requirePermission("briefing:publish"), activeEventRoute((req) => {
    const result = activeEvent.publishDraft(String(req.params.briefingId), req.body?.expectedVersion, directoryActor(req));
    addAudit(req, "briefing_published", `Briefing revision ${result.briefing.revision} published`, result.briefing.sessionId, {
      briefingId: result.briefing.id,
      revision: result.briefing.revision,
      supersededBriefingId: result.superseded?.id ?? null
    }, "operationalBriefing", result.briefing.id);
    if (result.superseded) {
      addAudit(req, "briefing_superseded", `Briefing revision ${result.superseded.revision} superseded`, result.superseded.sessionId, {
        briefingId: result.superseded.id,
        revision: result.superseded.revision,
        replacedByBriefingId: result.briefing.id
      }, "operationalBriefing", result.superseded.id);
    }
    addTimeline(req, {
      sessionId: result.briefing.sessionId,
      eventType: "briefing",
      entityType: "operationalBriefing",
      entityId: result.briefing.id,
      title: `Briefing revision ${result.briefing.revision} published`,
      body: result.briefing.title,
      metadata: { revision: result.briefing.revision }
    });
    notifySafely(() => notifications.notifyBriefingPublished(result.briefing));
    return result.briefing;
  }));

  router.get("/dashboard", requirePermission("session:read"), requireIncidentAccess(activeSessionId, true), (req, res) => res.json(dashboard(req, activeSessionId(req))));
  router.get("/readiness/me", requirePermission("readiness:read-own"), directoryRoute((req) => readiness.me(req.query, directoryActor(req))));
  router.get("/readiness/members", requireAnyPermission(["readiness:read-all", "readiness:read-group"]), directoryRoute((req) => readiness.members(req.query, directoryActor(req))));
  router.get("/readiness/members/:memberProfileId", requireAnyPermission(["readiness:read-own", "readiness:read-all", "readiness:read-group"]), directoryRoute((req) => readiness.member(String(req.params.memberProfileId), req.query, directoryActor(req))));
  router.get("/readiness/groups", requireAnyPermission(["readiness:read-all", "readiness:read-group"]), directoryRoute((req) => readiness.groups(req.query, directoryActor(req))));
  router.get("/readiness/groups/:groupId", requireAnyPermission(["readiness:read-all", "readiness:read-group"]), directoryRoute((req) => readiness.group(String(req.params.groupId), req.query, directoryActor(req))));
  router.get("/readiness/summary", requireAnyPermission(["readiness:read-summary", "readiness:read-all", "readiness:read-group"]), directoryRoute((req) => readiness.summary(req.query, directoryActor(req))));
  router.get("/readiness/policy", requireAnyPermission(["readiness:policy:read", "readiness:policy:manage"]), directoryRoute((req) => readiness.policy(directoryActor(req))));

  router.get("/member-profiles", requirePermission("member:read"), directoryRoute((req) => memberDirectory.listMembers(req.query, directoryActor(req))));
  router.post("/member-profiles", requirePermission("member:create"), directoryRoute((req) => {
    const member = memberDirectory.createMember(req.body ?? {}, directoryActor(req));
    addAudit(req, "create_member_profile", "Member created", activeSessionId(req), { memberProfileId: member.id, memberId: member.memberId }, "memberProfile", member.id);
    return member;
  }, 201));
  router.get("/member-profile-user-links", requirePermission("member:link-user"), directoryRoute((req) => memberDirectory.listEligibleUsers(req.query)));
  router.get("/member-profiles/:id", requirePermission("member:read"), directoryRoute((req) => memberDirectory.getMember(String(req.params.id), directoryActor(req))));
  router.patch("/member-profiles/:id", requirePermission("member:update"), directoryRoute((req) => {
    const member = memberDirectory.updateMember(String(req.params.id), req.body ?? {}, directoryActor(req));
    addAudit(req, "update_member_profile", "Member updated", activeSessionId(req), { memberProfileId: member.id, memberId: member.memberId }, "memberProfile", member.id);
    return member;
  }));
  router.post("/member-profiles/:id/archive", requirePermission("member:archive"), directoryRoute((req) => {
    const member = memberDirectory.archiveMember(String(req.params.id), directoryActor(req));
    addAudit(req, "archive_member_profile", "Profile archived", activeSessionId(req), { memberProfileId: member.id, memberId: member.memberId }, "memberProfile", member.id);
    return member;
  }));
  router.post("/member-profiles/:id/restore", requirePermission("member:archive"), directoryRoute((req) => {
    const member = memberDirectory.restoreMember(String(req.params.id), directoryActor(req));
    addAudit(req, "restore_member_profile", "Profile restored", activeSessionId(req), { memberProfileId: member.id, memberId: member.memberId }, "memberProfile", member.id);
    return member;
  }));

  router.get("/groups", requirePermission("group:read"), directoryRoute((req) => {
    return memberDirectory.listGroups(req.query, directoryActor(req));
  }));
  router.post("/groups", requirePermission("group:create"), (req, res, next) => {
    if (!hasGlobalGroupAccess(req, "group:create")) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  }, directoryRoute((req) => {
    const group = memberDirectory.createGroup(req.body ?? {}, directoryActor(req));
    syncRoleAssignmentGroup(group);
    addAudit(req, "create_group", "Group created", group.sessionId ?? activeSessionId(req), { groupId: group.id, operationalId: group.operationalId }, "group", group.id);
    return group;
  }, 201));
  router.get("/groups/:id/members", requirePermission("group:read"), (req, res, next) => {
    if (!ensureGroupScope(req, res, String(req.params.id), "group:read")) return;
    next();
  }, directoryRoute((req) => memberDirectory.listGroupMembers(String(req.params.id), req.query, directoryActor(req))));
  router.post("/groups/:id/members", requirePermission("group:membership:manage"), directoryRoute((req) => {
    if (!hasGlobalGroupAccess(req, "group:membership:manage") && !scopedGroupIds(req, "group:membership:manage").has(String(req.params.id))) {
      throw new DirectoryError(403, "Forbidden");
    }
    const group = memberDirectory.addGroupMember(String(req.params.id), req.body ?? {}, directoryActor(req));
    addAudit(req, "add_group_member", "Member added to group", group.sessionId ?? activeSessionId(req), { groupId: group.id, memberProfileId: req.body?.memberProfileId ?? req.body?.memberId }, "group", group.id);
    return group;
  }, 201));
  router.patch("/groups/:id/members/:memberProfileId", requirePermission("group:membership:manage"), directoryRoute((req) => {
    if (!hasGlobalGroupAccess(req, "group:membership:manage") && !scopedGroupIds(req, "group:membership:manage").has(String(req.params.id))) {
      throw new DirectoryError(403, "Forbidden");
    }
    const member = memberDirectory.updateGroupMember(String(req.params.id), String(req.params.memberProfileId), req.body ?? {}, directoryActor(req));
    addAudit(req, "update_group_membership", "Group membership updated", activeSessionId(req), { groupId: String(req.params.id), memberProfileId: member.id, membershipRole: member.membershipRole }, "group", String(req.params.id));
    return member;
  }));
  router.delete("/groups/:id/members/:memberProfileId", requirePermission("group:membership:manage"), directoryRoute((req) => {
    if (!hasGlobalGroupAccess(req, "group:membership:manage") && !scopedGroupIds(req, "group:membership:manage").has(String(req.params.id))) {
      throw new DirectoryError(403, "Forbidden");
    }
    const group = memberDirectory.removeGroupMember(String(req.params.id), String(req.params.memberProfileId), directoryActor(req));
    addAudit(req, "remove_group_member", "Member removed from group", group.sessionId ?? activeSessionId(req), { groupId: group.id, memberProfileId: req.params.memberProfileId }, "group", group.id);
    return group;
  }));
  router.get("/groups/:id", requirePermission("group:read"), (req, res, next) => {
    if (!ensureGroupScope(req, res, String(req.params.id), "group:read")) return;
    next();
  }, directoryRoute((req) => memberDirectory.getGroup(String(req.params.id), directoryActor(req))));
  router.patch("/groups/:id", requirePermission("group:update"), directoryRoute((req) => {
    if (!hasGlobalGroupAccess(req, "group:update") && !scopedGroupIds(req, "group:update").has(String(req.params.id))) {
      throw new DirectoryError(403, "Forbidden");
    }
    const group = memberDirectory.updateGroup(String(req.params.id), req.body ?? {}, directoryActor(req));
    syncRoleAssignmentGroup(group);
    addAudit(req, "update_group", "Group updated", group.sessionId ?? activeSessionId(req), { groupId: group.id, operationalId: group.operationalId }, "group", group.id);
    return group;
  }));
  router.post("/groups/:id/archive", requirePermission("group:archive"), directoryRoute((req) => {
    if (!hasGlobalGroupAccess(req, "group:archive") && !scopedGroupIds(req, "group:archive").has(String(req.params.id))) {
      throw new DirectoryError(403, "Forbidden");
    }
    const group = memberDirectory.archiveGroup(String(req.params.id), directoryActor(req));
    syncRoleAssignmentGroup(group);
    addAudit(req, "archive_group", "Group archived", group.sessionId ?? activeSessionId(req), { groupId: group.id, operationalId: group.operationalId }, "group", group.id);
    return group;
  }));

  router.get("/training/courses", requireAnyPermission(["training:read-all", "training:read-own"]), directoryRoute((req) => training.listCourses(req.query, directoryActor(req))));
  router.get("/training/courses/:id", requireAnyPermission(["training:read-all", "training:read-own"]), directoryRoute((req) => training.getCourse(String(req.params.id), directoryActor(req))));
  router.post("/training/courses", requirePermission("training:course:manage"), directoryRoute((req) => {
    const course = training.createCourse(req.body ?? {}, directoryActor(req));
    addAudit(req, "create_training_course", "Course created", activeSessionId(req), { courseId: course.id, code: course.code, title: course.title }, "trainingCourse", course.id);
    return course;
  }, 201));
  router.patch("/training/courses/:id", requirePermission("training:course:manage"), directoryRoute((req) => {
    const before = training.getCourse(String(req.params.id), directoryActor(req));
    const course = training.updateCourse(String(req.params.id), req.body ?? {}, directoryActor(req));
    addAudit(req, "update_training_course", "Course updated", activeSessionId(req), { courseId: course.id, code: course.code, oldUpdatedAt: before.updatedAt, newUpdatedAt: course.updatedAt }, "trainingCourse", course.id);
    return course;
  }));
  router.post("/training/courses/:id/deactivate", requirePermission("training:course:manage"), directoryRoute((req) => {
    const course = training.deactivateCourse(String(req.params.id), req.body ?? {}, directoryActor(req));
    addAudit(req, "deactivate_training_course", "Course deactivated", activeSessionId(req), { courseId: course.id, code: course.code }, "trainingCourse", course.id);
    return course;
  }));
  router.post("/training/courses/:id/reactivate", requirePermission("training:course:manage"), directoryRoute((req) => {
    const course = training.reactivateCourse(String(req.params.id), req.body ?? {}, directoryActor(req));
    addAudit(req, "reactivate_training_course", "Course reactivated", activeSessionId(req), { courseId: course.id, code: course.code }, "trainingCourse", course.id);
    return course;
  }));

  router.get("/training/requirements", requireAnyPermission(["training:read-all", "training:requirement:manage"]), directoryRoute((req) => training.listRequirements(req.query, directoryActor(req))));
  router.get("/training/requirements/:id", requireAnyPermission(["training:read-all", "training:requirement:manage"]), directoryRoute((req) => training.getRequirement(String(req.params.id), directoryActor(req))));
  router.post("/training/requirements", requirePermission("training:requirement:manage"), directoryRoute((req) => {
    const requirement = training.createRequirement(req.body ?? {}, directoryActor(req));
    addAudit(req, "create_training_requirement", "Requirement added", activeSessionId(req), { requirementId: requirement.id, courseId: requirement.courseId, targetType: requirement.targetType }, "trainingRequirement", requirement.id);
    return requirement;
  }, 201));
  router.patch("/training/requirements/:id", requirePermission("training:requirement:manage"), directoryRoute((req) => {
    const before = training.getRequirement(String(req.params.id), directoryActor(req));
    const requirement = training.updateRequirement(String(req.params.id), req.body ?? {}, directoryActor(req));
    addAudit(req, "update_training_requirement", "Requirement updated", activeSessionId(req), { requirementId: requirement.id, oldUpdatedAt: before.updatedAt, newUpdatedAt: requirement.updatedAt }, "trainingRequirement", requirement.id);
    return requirement;
  }));
  router.post("/training/requirements/:id/end", requirePermission("training:requirement:manage"), directoryRoute((req) => {
    const requirement = training.endRequirement(String(req.params.id), req.body ?? {}, directoryActor(req));
    addAudit(req, "end_training_requirement", "Requirement ended", activeSessionId(req), { requirementId: requirement.id, courseId: requirement.courseId }, "trainingRequirement", requirement.id);
    return requirement;
  }));

  router.get("/training/records", requireAnyPermission(["training:read-all", "training:read-own"]), directoryRoute((req) => training.listRecords(req.query, directoryActor(req))));
  router.get("/training/records/:id", requireAnyPermission(["training:read-all", "training:read-own"]), directoryRoute((req) => training.getRecord(String(req.params.id), directoryActor(req))));
  router.post("/training/records/assign", requirePermission("training:assign"), directoryRoute((req) => {
    const result = training.assignRecord(req.body ?? {}, directoryActor(req));
    if ("records" in result) {
      addAudit(req, "assign_training", "Training assigned to group", activeSessionId(req), {
        groupId: result.group.id,
        groupName: result.group.name,
        courseId: result.course.id,
        assignedCount: result.assignedCount,
        skippedCount: result.skippedCount,
        recordIds: result.records.map((record) => record.id)
      }, "trainingGroup", result.group.id);
      notifySafely(() => result.records.forEach((record) => notifications.notifyTrainingAssigned(record)));
      return result;
    }
    addAudit(req, "assign_training", "Training assigned", activeSessionId(req), { recordId: result.id, operationalId: result.operationalId, memberProfileId: result.memberProfileId, courseId: result.courseId }, "trainingRecord", result.id);
    notifySafely(() => notifications.notifyTrainingAssigned(result));
    return result;
  }, 201));
  router.patch("/training/records/:id", requireAnyPermission(["training:assign", "training:complete-all"]), directoryRoute((req) => {
    const before = training.getRecord(String(req.params.id), directoryActor(req));
    const record = training.updateRecord(String(req.params.id), req.body ?? {}, directoryActor(req));
    addAudit(req, "update_training_record", "Training updated", activeSessionId(req), { recordId: record.id, oldUpdatedAt: before.updatedAt, newUpdatedAt: record.updatedAt }, "trainingRecord", record.id);
    return record;
  }));
  router.post("/training/records/:id/start", requireAnyPermission(["training:complete-own", "training:complete-all"]), directoryRoute((req) => {
    const before = training.getRecord(String(req.params.id), directoryActor(req));
    const record = training.startRecord(String(req.params.id), req.body ?? {}, directoryActor(req));
    addAudit(req, "start_training", "Training started", activeSessionId(req), { recordId: record.id, oldStatus: before.status, newStatus: record.status }, "trainingRecord", record.id);
    return record;
  }));
  router.post("/training/records/:id/complete", requireAnyPermission(["training:complete-own", "training:complete-all"]), directoryRoute((req) => {
    const before = training.getRecord(String(req.params.id), directoryActor(req));
    const record = training.completeRecord(String(req.params.id), req.body ?? {}, directoryActor(req));
    addAudit(req, "complete_training", "Completion recorded", activeSessionId(req), { recordId: record.id, oldStatus: before.status, newStatus: record.status, expiryAt: record.expiryAt }, "trainingRecord", record.id);
    return record;
  }));
  router.post("/training/records/:id/verify", requirePermission("training:verify"), directoryRoute((req) => {
    const record = training.verifyRecord(String(req.params.id), req.body ?? {}, directoryActor(req));
    addAudit(req, "verify_training", "Completion verified", activeSessionId(req), { recordId: record.id, verifiedAt: record.verifiedAt }, "trainingRecord", record.id);
    return record;
  }));
  router.post("/training/records/:id/waive", requirePermission("training:waive"), directoryRoute((req) => {
    const before = training.getRecord(String(req.params.id), directoryActor(req));
    const record = training.waiveRecord(String(req.params.id), req.body ?? {}, directoryActor(req));
    addAudit(req, "waive_training", "Training waived", activeSessionId(req), { recordId: record.id, oldStatus: before.status, newStatus: record.status }, "trainingRecord", record.id);
    return record;
  }));
  router.post("/training/records/:id/cancel", requirePermission("training:assign"), directoryRoute((req) => {
    const before = training.getRecord(String(req.params.id), directoryActor(req));
    const record = training.cancelRecord(String(req.params.id), req.body ?? {}, directoryActor(req));
    addAudit(req, "cancel_training", "Training cancelled", activeSessionId(req), { recordId: record.id, oldStatus: before.status, newStatus: record.status }, "trainingRecord", record.id);
    return record;
  }));

  router.get("/documents", requireAnyPermission(["document:read-own", "document:read-all"]), directoryRoute((req) => documentsRepository.listDocuments(req.query, directoryActor(req))));
  router.post("/documents", requirePermission("document:manage"), directoryRoute((req) => {
    const document = documentsRepository.createDocument(req.body ?? {}, directoryActor(req));
    addAudit(req, "create_document", "Document created", activeSessionId(req), { documentId: document.id, code: document.code, title: document.title }, "document", document.id);
    return document;
  }, 201));
  router.get("/documents/:id", requireAnyPermission(["document:read-own", "document:read-all"]), directoryRoute((req) => documentsRepository.getDocument(String(req.params.id), directoryActor(req))));
  router.patch("/documents/:id", requirePermission("document:manage"), directoryRoute((req) => {
    const before = documentsRepository.getDocument(String(req.params.id), directoryActor(req));
    const document = documentsRepository.updateDocument(String(req.params.id), req.body ?? {}, directoryActor(req));
    addAudit(req, "update_document", "Document updated", activeSessionId(req), { documentId: document.id, oldUpdatedAt: before.updatedAt, newUpdatedAt: document.updatedAt }, "document", document.id);
    return document;
  }));
  router.post("/documents/:id/archive", requirePermission("document:manage"), directoryRoute((req) => {
    const document = documentsRepository.archiveDocument(String(req.params.id), req.body ?? {}, directoryActor(req));
    addAudit(req, "archive_document", "Document archived", activeSessionId(req), { documentId: document.id, code: document.code }, "document", document.id);
    return document;
  }));
  router.post("/documents/:id/reactivate", requirePermission("document:manage"), directoryRoute((req) => {
    const document = documentsRepository.reactivateDocument(String(req.params.id), req.body ?? {}, directoryActor(req));
    addAudit(req, "update_document", "Document updated", activeSessionId(req), { documentId: document.id, code: document.code }, "document", document.id);
    return document;
  }));
  router.get("/documents/:id/versions", requireAnyPermission(["document:read-own", "document:read-all"]), directoryRoute((req) => documentsRepository.listVersions(String(req.params.id), req.query, directoryActor(req))));
  router.post("/documents/:id/versions", requirePermission("document:version:manage"), directoryRoute((req) => {
    const version = documentsRepository.createVersion(String(req.params.id), req.body ?? {}, directoryActor(req));
    addAudit(req, "create_document_version", "Document version created", activeSessionId(req), { documentId: version.documentId, documentVersionId: version.id, versionLabel: version.versionLabel }, "documentVersion", version.id);
    return version;
  }, 201));
  router.get("/document-versions/:id", requireAnyPermission(["document:read-own", "document:read-all"]), directoryRoute((req) => documentsRepository.getVersion(String(req.params.id), directoryActor(req))));
  router.patch("/document-versions/:id", requirePermission("document:version:manage"), directoryRoute((req) => {
    const before = documentsRepository.getVersion(String(req.params.id), directoryActor(req));
    const version = documentsRepository.updateVersion(String(req.params.id), req.body ?? {}, directoryActor(req));
    addAudit(req, "update_document_version", "Document version updated", activeSessionId(req), { documentVersionId: version.id, oldUpdatedAt: before.updatedAt, newUpdatedAt: version.updatedAt }, "documentVersion", version.id);
    return version;
  }));
  router.post("/document-versions/:id/publish", requirePermission("document:publish"), directoryRoute((req) => {
    const version = documentsRepository.publishVersion(String(req.params.id), req.body ?? {}, directoryActor(req));
    addAudit(req, "publish_document_version", "Document version published", activeSessionId(req), { documentId: version.documentId, documentVersionId: version.id, versionLabel: version.versionLabel }, "documentVersion", version.id);
    notifySafely(() => notifications.notifyDocumentVersionPublished(version));
    return version;
  }));
  router.post("/document-versions/:id/withdraw", requirePermission("document:publish"), directoryRoute((req) => {
    const version = documentsRepository.withdrawVersion(String(req.params.id), req.body ?? {}, directoryActor(req));
    addAudit(req, "withdraw_document_version", "Document version withdrawn", activeSessionId(req), { documentId: version.documentId, documentVersionId: version.id, versionLabel: version.versionLabel }, "documentVersion", version.id);
    return version;
  }));
  router.get("/document-versions/:id/content", requireAnyPermission(["document:read-own", "document:read-all"]), directoryRoute((req) => documentsRepository.getVersionContent(String(req.params.id), directoryActor(req))));
  router.post("/document-versions/:id/acknowledge", requireAnyPermission(["document:acknowledge-own", "document:acknowledge-all"]), (req, res) => {
    try {
      const acknowledgement = documentsRepository.acknowledgeVersion(String(req.params.id), req.body ?? {}, directoryActor(req));
      if (!acknowledgement.duplicate) {
        addAudit(req, "acknowledge_document", "Document acknowledged", activeSessionId(req), {
          documentVersionId: acknowledgement.documentVersionId,
          memberProfileId: acknowledgement.memberProfileId,
          onBehalf: acknowledgement.onBehalf
        }, "documentAcknowledgement", acknowledgement.id);
      }
      res.status(acknowledgement.duplicate ? 200 : 201).json(acknowledgement);
    } catch (error) {
      if (error instanceof DirectoryError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  });
  router.get("/document-requirements", requireAnyPermission(["document:read-all", "document:requirement:manage"]), directoryRoute((req) => documentsRepository.listRequirements(req.query, directoryActor(req))));
  router.get("/document-requirements/:id", requireAnyPermission(["document:read-all", "document:requirement:manage"]), directoryRoute((req) => documentsRepository.getRequirement(String(req.params.id), directoryActor(req))));
  router.post("/document-requirements", requirePermission("document:requirement:manage"), directoryRoute((req) => {
    const requirement = documentsRepository.createRequirement(req.body ?? {}, directoryActor(req));
    addAudit(req, "create_document_requirement", "Document requirement created", activeSessionId(req), { requirementId: requirement.id, documentVersionId: requirement.documentVersionId, targetType: requirement.targetType }, "documentRequirement", requirement.id);
    return requirement;
  }, 201));
  router.patch("/document-requirements/:id", requirePermission("document:requirement:manage"), directoryRoute((req) => {
    const before = documentsRepository.getRequirement(String(req.params.id), directoryActor(req));
    const requirement = documentsRepository.updateRequirement(String(req.params.id), req.body ?? {}, directoryActor(req));
    addAudit(req, "update_document_requirement", "Document requirement updated", activeSessionId(req), { requirementId: requirement.id, oldUpdatedAt: before.updatedAt, newUpdatedAt: requirement.updatedAt }, "documentRequirement", requirement.id);
    return requirement;
  }));
  router.post("/document-requirements/:id/end", requirePermission("document:requirement:manage"), directoryRoute((req) => {
    const requirement = documentsRepository.endRequirement(String(req.params.id), req.body ?? {}, directoryActor(req));
    addAudit(req, "end_document_requirement", "Document requirement ended", activeSessionId(req), { requirementId: requirement.id, documentVersionId: requirement.documentVersionId }, "documentRequirement", requirement.id);
    return requirement;
  }));
  router.get("/document-acknowledgements", requireAnyPermission(["document:read-own", "document:read-all", "document:acknowledge-all"]), directoryRoute((req) => documentsRepository.listAcknowledgements(req.query, directoryActor(req))));

  router.get("/roster-shifts", requireAnyPermission(["roster:read", "roster:read-own"]), directoryRoute((req) => rostering.listShifts(req.query, directoryActor(req))));
  router.get("/roster-shifts/:id", requireAnyPermission(["roster:read", "roster:read-own"]), directoryRoute((req) => rostering.getShift(String(req.params.id), directoryActor(req))));
  router.post("/roster-shifts", requirePermission("roster:create"), directoryRoute((req) => {
    const sessionId = String(req.body?.sessionId ?? "").trim();
    if (!sessionId) throw new DirectoryError(400, "Session is required.");
    ensureWritableSession(sessionId);
    const shift = rostering.createShift({ ...(req.body ?? {}), sessionId }, directoryActor(req));
    addAudit(req, "create_roster_shift", "Roster shift created", shift.sessionId ?? activeSessionId(req), { rosterShiftId: shift.id, operationalId: shift.operationalId, status: shift.status }, "rosterShift", shift.id);
    return shift;
  }, 201));
  router.patch("/roster-shifts/:id", requirePermission("roster:update"), directoryRoute((req) => {
    const before = rostering.getShift(String(req.params.id), directoryActor(req));
    ensureWritableSession(before.sessionId);
    const shift = rostering.updateShift(String(req.params.id), req.body ?? {}, directoryActor(req));
    addAudit(req, "update_roster_shift", "Roster shift updated", shift.sessionId ?? activeSessionId(req), { rosterShiftId: shift.id, operationalId: shift.operationalId, oldUpdatedAt: before.updatedAt, newUpdatedAt: shift.updatedAt }, "rosterShift", shift.id);
    return shift;
  }));

  const rosterAction = (action: string, nextStatus: RosterStatus, permission: string, summary: string) =>
    router.post(`/roster-shifts/:id/${action}`, requireAnyPermission([permission, "roster:update"]), directoryRoute((req) => {
      const before = rostering.getShift(String(req.params.id), directoryActor(req));
      ensureWritableSession(before.sessionId);
      const shift = rostering.moveShift(String(req.params.id), nextStatus, directoryActor(req), req.body?.note);
      addAudit(req, `roster_shift_${action}`, summary, shift.sessionId ?? activeSessionId(req), { rosterShiftId: shift.id, operationalId: shift.operationalId, oldStatus: before.status, newStatus: shift.status }, "rosterShift", shift.id);
      notifySafely(() => {
        if (nextStatus === "Published") notifications.notifyRosterShiftPublished(shift);
        if (["Confirmed", "Declined", "Cancelled", "Completed"].includes(nextStatus)) notifications.resolveSource("rosterShift", shift.id, "Source resolved");
      });
      return shift;
    }));

  rosterAction("publish", "Published", "roster:publish", "Roster shift published");
  rosterAction("confirm", "Confirmed", "roster:confirm-own", "Roster shift confirmed");
  rosterAction("decline", "Declined", "roster:decline-own", "Roster shift declined");
  rosterAction("cancel", "Cancelled", "roster:cancel", "Roster shift cancelled");
  rosterAction("complete", "Completed", "roster:complete", "Roster shift completed");

  router.get("/availability", requireAnyPermission(["availability:read-all", "availability:read-own"]), directoryRoute((req) => rostering.listAvailability(req.query, directoryActor(req))));
  router.post("/availability", requireAnyPermission(["availability:manage-all", "availability:update-own"]), directoryRoute((req) => {
    const record = rostering.createAvailability(req.body ?? {}, directoryActor(req));
    addAudit(req, "create_availability", "Availability added", activeSessionId(req), { availabilityId: record.id, operationalId: record.operationalId, memberProfileId: record.memberProfileId, type: record.type }, "availability", record.id);
    return record;
  }, 201));
  router.patch("/availability/:id", requireAnyPermission(["availability:manage-all", "availability:update-own"]), directoryRoute((req) => {
    const before = rostering.getAvailability(String(req.params.id), directoryActor(req));
    const record = rostering.updateAvailability(String(req.params.id), req.body ?? {}, directoryActor(req));
    addAudit(req, "update_availability", "Availability updated", activeSessionId(req), { availabilityId: record.id, operationalId: record.operationalId, memberProfileId: record.memberProfileId, oldType: before.type, newType: record.type, oldUpdatedAt: before.updatedAt, newUpdatedAt: record.updatedAt }, "availability", record.id);
    return record;
  }));
  router.post("/availability/:id/remove", requireAnyPermission(["availability:manage-all", "availability:update-own"]), directoryRoute((req) => {
    const record = rostering.removeAvailability(String(req.params.id), directoryActor(req));
    addAudit(req, "remove_availability", "Availability removed", activeSessionId(req), { availabilityId: record.id, operationalId: record.operationalId, memberProfileId: record.memberProfileId }, "availability", record.id);
    return record;
  }));

  const demoResourceRoutes = [
    { resource: "family-records", read: "family:read", create: "family:create", update: "family:update" },
    { resource: "requests", read: "request:read", create: "request:create", update: "request:update" },
    { resource: "files", read: "import:create", create: "import:create", update: "import:create" },
    { resource: "exercise/injects", read: "exercise:manage", create: "exercise:manage", update: "exercise:manage" },
    { resource: "exercise/observations", read: "exercise:manage", create: "exercise:manage", update: "exercise:manage" }
  ];

  for (const { resource, read, create, update } of demoResourceRoutes) {
    router.get(`/${resource}`, requirePermission(read), (req, res) => res.json(listRows(resource, req)));
    router.post(`/${resource}`, requirePermission(create), (req, res) => {
      const row = createRow(resource, req.body, req);
      addAudit(req, `create_${resource.replaceAll("/", "_")}`, `Created ${row.operationalId ?? row.title ?? resource}`, row.sessionId);
      res.status(201).json(row);
    });
    router.patch(`/${resource}/:id`, requirePermission(update), (req, res) => res.json(updateRow(resource, String(req.params.id), req.body, req) ?? { error: "Not found" }));
  }

  router.get("/timeline", requirePermission("timeline:read"), (req, res) => res.json(listRows("timeline", req)));
  router.post("/timeline", requirePermission("timeline:create"), (req, res) => {
    const manualTypes = new Set(["note", "contact_attempt", "information_received", "operational_update", "handover_note"]);
    const eventType = String(req.body?.eventType ?? "");
    const title = String(req.body?.title ?? "").trim();
    const sessionId = String(req.body?.sessionId ?? "");
    if (!manualTypes.has(eventType)) {
      res.status(400).json({ error: "Manual timeline notes cannot use a protected workflow event type" });
      return;
    }
    if (!title) {
      res.status(400).json({ error: "Title is required" });
      return;
    }
    const session = sessions.find((item) => item.id === sessionId);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    if (["Closed", "Archived"].includes(String(session.status))) {
      res.status(409).json({ error: "Timeline notes cannot be added to a closed session" });
      return;
    }
    addTimeline(req, { sessionId, caseId: req.body?.caseId || null, eventType, entityType: "manualNote", title, body: String(req.body?.body ?? "").trim() || null });
    const row = timeline[0]!;
    addAudit(req, "create_timeline_event", `Timeline event created: ${row.title}`, row.sessionId, { eventType }, "caseTimelineEvent", row.id);
    res.status(201).json(withActorMetadata("timeline", row, req));
  });
  router.get("/audit-logs", requirePermission("audit:read"), (req, res) => res.json(listRows("audit-logs", req)));

  router.get("/matching-records", requirePermission("matching:read"), requireIncidentAccess((req) => String(req.query.sessionId ?? ""), true), (req, res) => res.json(listRows("matching-records", req)));
  router.post("/matching-records", requirePermission("matching:create"), requireIncidentAccess((req) => String(req.body?.sessionId ?? ""), true), (req, res) => {
    const body = { ...req.body, status: "Potential match", holdCheck: "No hold", decisionNotes: undefined };
    const issue = demoMatchingLinkError(body);
    if (issue) {
      res.status(issue.status).json({ error: issue.error });
      return;
    }
    const family = familyRecords.find((item) => item.id === body.familyRecordId);
    const passenger = passengerRecords.find((item) => item.id === body.passengerRecordId);
    const row = createRow("matching-records", { ...body, caseId: body.caseId ?? family?.caseId ?? passenger?.caseId }, req);
    addAudit(req, "create_potential_match", `Potential match ${row.operationalId} created`, row.sessionId, undefined, "matchingRecord", row.id);
    addTimeline(req, { sessionId: row.sessionId, caseId: row.caseId, eventType: "matching", entityType: "matchingRecord", entityId: row.id, title: `Potential match ${row.operationalId} created`, body: row.matchBasis });
    res.status(201).json(row);
  });
  router.patch("/matching-records/:id", requirePermission("matching:create"), requireIncidentAccess((req) => String(matchingRecords.find((item) => item.id === req.params.id)?.sessionId ?? req.body?.sessionId ?? ""), true), (req, res) => {
    const existing = matchingRecords.find((item) => item.id === req.params.id);
    if (!existing) {
      res.status(404).json({ error: "Matching record not found" });
      return;
    }
    const merged = { ...existing, ...req.body, sessionId: existing.sessionId };
    const issue = demoMatchingLinkError(merged, existing.id);
    if (issue) {
      res.status(issue.status).json({ error: issue.error });
      return;
    }
    const { sessionId: _sessionId, status: _status, holdCheck: _holdCheck, decisionNotes: _decisionNotes, ...updates } = req.body ?? {};
    const row = updateRow("matching-records", existing.id, updates, req)!;
    addAudit(req, "update_matching_record", `Matching record ${row.operationalId} updated`, row.sessionId, undefined, "matchingRecord", row.id);
    res.json(row);
  });

  router.get("/releases", requirePermission("release:read"), requireIncidentAccess((req) => String(req.query.sessionId ?? ""), true), (req, res) => res.json(listRows("releases", req)));
  router.post("/releases", requirePermission("release:create"), requireIncidentAccess((req) => String(req.body?.sessionId ?? ""), true), (req, res) => {
    const issue = demoReleaseMatchError(req.body ?? {});
    if (issue) {
      res.status(issue.status).json({ error: issue.error });
      return;
    }
    const duplicate = releases.find((item) => item.sessionId === req.body.sessionId && item.matchId === req.body.matchId && item.status === "Prepared");
    if (duplicate) {
      res.status(409).json({ error: `An open release action already exists (${duplicate.operationalId})` });
      return;
    }
    const match = matchingRecords.find((item) => item.id === req.body.matchId)!;
    const row = createRow("releases", {
      ...req.body,
      status: "Prepared",
      passengerRecordId: match.passengerRecordId,
      familyRecordId: match.familyRecordId
    }, req);
    addAudit(req, "prepare_release", `${row.actionType} ${row.operationalId} prepared`, row.sessionId, undefined, "reunificationReleaseRecord", row.id);
    res.status(201).json(row);
  });
  router.patch("/releases/:id", requirePermission("release:create"), requireIncidentAccess((req) => String(releases.find((item) => item.id === req.params.id)?.sessionId ?? req.body?.sessionId ?? ""), true), (req, res) => {
    const existing = releases.find((item) => item.id === req.params.id);
    if (!existing) {
      res.status(404).json({ error: "Release/reunification record not found" });
      return;
    }
    if (existing.status !== "Prepared") {
      res.status(409).json({ error: "Completed or cancelled release actions are read-only" });
      return;
    }
    const issue = demoReleaseMatchError(existing);
    if (issue) {
      res.status(issue.status).json({ error: issue.error });
      return;
    }
    const { sessionId: _sessionId, matchId: _matchId, passengerRecordId: _passengerRecordId, familyRecordId: _familyRecordId, status: _status, ...updates } = req.body ?? {};
    const row = updateRow("releases", existing.id, updates, req)!;
    addAudit(req, "update_release", `${row.actionType} ${row.operationalId} updated`, row.sessionId, undefined, "reunificationReleaseRecord", row.id);
    res.json(row);
  });

  router.get("/matching-records/suggestions", requirePermission("matching:read"), requireIncidentAccess((req) => String(req.query.sessionId ?? ""), true), (_req, res) => {
    res.json({ data: [] });
  });

  router.post("/family-records/:id/verify", requirePermission("family:verify"), (req, res) => {
    const note = demoDecisionNote(req.body?.verificationNotes);
    if (!note) {
      res.status(400).json({ error: "Verification note must contain at least 3 characters" });
      return;
    }
    const row = updateRow("family-records", String(req.params.id), { verificationStatus: "Verified", verificationNotes: note }, req);
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    addAudit(req, "verify_family_record", `Family/NOK record ${row.operationalId} verified`, row.sessionId, { basis: note }, "familyRecord", row.id);
    addTimeline(req, {
      sessionId: row.sessionId,
      caseId: row.caseId,
      eventType: "verification",
      entityType: "familyRecord",
      entityId: row.id,
      title: "Family/NOK verification completed",
      body: note
    });
    res.json(row);
  });
  router.post("/family-records/:id/mark-disputed", requirePermission("family:update"), (req, res) => res.json(updateRow("family-records", String(req.params.id), { verificationStatus: "Disputed", verificationNotes: req.body?.verificationNotes }, req)));
  router.post("/matching-records/:id/:action", requireIncidentAccess((req) => String(matchingRecords.find((item) => item.id === req.params.id)?.sessionId ?? req.body?.sessionId ?? ""), true), (req, res) => {
    const action = String(req.params.action);
    const matchingId = String(req.params.id);
    const permissionByAction: Record<string, string> = {
      verify: "matching:verify",
      reject: "matching:reject",
      hold: "matching:hold",
      "clear-hold": "matching:clearHold",
      "mark-reunited": "matching:reunite",
      "mark-released": "matching:release"
    };
    const requiredPermission = permissionByAction[action];
    if (!requiredPermission || !can(req, requiredPermission)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const statusByAction: Record<string, string> = {
      verify: "Verified match",
      reject: "Rejected",
      hold: "Hold / escalate",
      "clear-hold": "Potential match",
      "mark-reunited": "Reunited",
      "mark-released": "Released"
    };
    const patch: Row = {
      status: statusByAction[action] ?? "Potential match",
      decisionNotes: req.body?.decisionNotes
    };
    if (action === "hold") patch.holdCheck = req.body?.holdCheck ?? "Identity verification hold";
    if (action === "clear-hold") patch.holdCheck = "No hold";
    const row = updateRow("matching-records", matchingId, patch, req);
    addAudit(req, action, `Matching action ${action}`, row?.sessionId ?? "ses-demo-1", undefined, "matchingRecord", row?.id ?? matchingId);
    res.json(row ?? { error: "Not found" });
  });

  router.post("/releases/:id/complete", requirePermission("release:complete"), requireIncidentAccess((req) => String(releases.find((item) => item.id === req.params.id)?.sessionId ?? req.body?.sessionId ?? ""), true), (req, res) => {
    const note = demoDecisionNote(req.body?.notes);
    if (!note) {
      res.status(400).json({ error: "Decision note must contain at least 3 characters" });
      return;
    }
    const existing = releases.find((item) => item.id === req.params.id);
    if (!existing) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (existing.status !== "Prepared") {
      res.status(409).json({ error: "Only prepared release actions can be completed" });
      return;
    }
    const matchIssue = demoReleaseMatchError(existing);
    if (matchIssue) {
      res.status(matchIssue.status).json({ error: matchIssue.error });
      return;
    }
    if (!existing.identityChecked) {
      res.status(409).json({ error: "Identity check must be confirmed before completion" });
      return;
    }
    if (!existing.holdCleared) {
      res.status(409).json({ error: "Hold cleared check must be confirmed before completion" });
      return;
    }
    if (existing.actionType === "Release" && !existing.receivingParty) {
      res.status(400).json({ error: "Receiving party is required for release" });
      return;
    }
    const row = updateRow("releases", String(req.params.id), { status: "Completed", completedAt: now(), notes: note }, req)!;
    if (row.matchId) updateRow("matching-records", row.matchId, { status: row.actionType === "Release" ? "Released" : "Reunited" }, req);
    const match = matchingRecords.find((item) => item.id === row.matchId);
    addAudit(req, row.actionType === "Release" ? "release" : "reunite", `${row.actionType} ${row.operationalId} completed`, row.sessionId, { status: "Completed", actionType: row.actionType, decisionNotes: note }, "reunificationReleaseRecord", row.id);
    addTimeline(req, {
      sessionId: row.sessionId,
      caseId: match?.caseId,
      eventType: row.actionType === "Release" ? "release" : "reunification",
      entityType: "reunificationReleaseRecord",
      entityId: row.id,
      title: `${row.actionType} ${row.operationalId} completed`,
      body: note,
      metadata: { status: "Completed", actionType: row.actionType }
    });
    res.json(row);
  });
  router.post("/releases/:id/cancel", requirePermission("release:cancel"), requireIncidentAccess((req) => String(releases.find((item) => item.id === req.params.id)?.sessionId ?? req.body?.sessionId ?? ""), true), (req, res) => {
    const note = demoDecisionNote(req.body?.notes);
    if (!note) {
      res.status(400).json({ error: "Decision note must contain at least 3 characters" });
      return;
    }
    const existing = releases.find((item) => item.id === req.params.id);
    if (!existing) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (existing.status !== "Prepared") {
      res.status(409).json({ error: "Only prepared release actions can be cancelled" });
      return;
    }
    const row = updateRow("releases", String(req.params.id), { status: "Cancelled", notes: note }, req)!;
    const match = matchingRecords.find((item) => item.id === row.matchId);
    addAudit(req, "cancel_release", `${row.actionType} ${row.operationalId} cancelled`, row.sessionId, { status: "Cancelled", actionType: row.actionType, decisionNotes: note }, "reunificationReleaseRecord", row.id);
    addTimeline(req, {
      sessionId: row.sessionId,
      caseId: match?.caseId,
      eventType: "release",
      entityType: "reunificationReleaseRecord",
      entityId: row.id,
      title: `${row.actionType} ${row.operationalId} cancelled`,
      body: note,
      metadata: { status: "Cancelled", actionType: row.actionType }
    });
    res.json(row);
  });
  router.post("/requests/:id/assign-to-me", requirePermission("request:assign"), (req, res) => res.json(updateRow("requests", String(req.params.id), { status: "Assigned", ownerAssignedTo: req.user?.displayName }, req)));
  router.post("/requests/:id/status", requirePermission("request:update"), (req, res) => {
    const status = String(req.body?.status ?? "");
    const note = demoDecisionNote(req.body?.closureNote);
    if (status === "Closed" && !note) {
      res.status(400).json({ error: "Closure note must contain at least 3 characters" });
      return;
    }
    const row = updateRow("requests", String(req.params.id), { status, closureNote: note || undefined }, req);
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    addAudit(req, status === "Closed" ? "close_request" : "update_request_status", `Request ${row.operationalId} status changed to ${status}`, row.sessionId, status === "Closed" ? { status, closureNote: note } : { status }, "request", row.id);
    if (status === "Closed") {
      addTimeline(req, {
        sessionId: row.sessionId,
        caseId: row.caseId,
        eventType: "request",
        entityType: "request",
        entityId: row.id,
        title: `Request ${row.operationalId} closed`,
        body: note,
        metadata: { status }
      });
    }
    res.json(row);
  });
  router.get("/assignments", requirePermission("assignment:read"), (req, res) => res.json(listRows("assignments", req)));
  router.get("/assignment-assignees", requirePermission("assignment:assign"), (req, res) => {
    if (!isAssignmentManager(req)) {
      res.status(403).json({ error: "Only a Leader, Coordinator or Administrator can assign work to others" });
      return;
    }
    const data = listAssignmentAssignees(req);
    res.json({ total: data.length, data });
  });
  router.post("/assignments", requirePermission("assignment:create"), (req, res) => {
    const session = sessions.find((item) => item.id === req.body?.sessionId);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    if (["Closed", "Archived"].includes(String(session.status))) {
      res.status(409).json({ error: "Assignments cannot be changed in a closed session" });
      return;
    }
    if (!String(req.body?.title ?? "").trim()) {
      res.status(400).json({ error: "Title is required" });
      return;
    }
    const { status: _status, ownerAssignedTo: _owner, assignedUserId: _assignedUserId, assignedUserDisplayName: _assignedUserDisplayName, ...input } = req.body ?? {};
    const scope = permissionScope(directoryActor(req), "assignment:create");
    let groupId = String(input.groupId ?? "").trim() || undefined;
    if (!(scope.global && isAssignmentManager(req))) {
      const allowedGroups = assignmentActorGroupIds(req, "assignment:create");
      if (!groupId && allowedGroups.size === 1) groupId = [...allowedGroups][0];
      if (!groupId || !allowedGroups.has(groupId)) {
        res.status(403).json({ error: "Assignment must belong to an authorized group" });
        return;
      }
    }
    const row = createRow("assignments", { ...input, groupId, title: String(input.title).trim(), status: "Open", ownerAssignedTo: null, assignedUserId: null, assignedUserDisplayName: null }, req);
    addAudit(req, "create_assignment", `Assignment ${row.operationalId} created`, row.sessionId, undefined, "assignmentTask", row.id);
    addTimeline(req, { sessionId: row.sessionId, caseId: row.caseId, eventType: "assignment", entityType: "assignmentTask", entityId: row.id, title: `Assignment ${row.operationalId} created`, body: row.title, metadata: { status: "Open", priority: row.priority, assignedUserId: null, assignedUserDisplayName: null, ownerAssignedTo: null } });
    res.status(201).json(assignmentResponse(row, req));
  });
  router.patch("/assignments/:id", requirePermission("assignment:update"), (req, res) => {
    const existing = assignments.find((item) => item.id === req.params.id);
    if (!existing) {
      res.status(404).json({ error: "Assignment not found" });
      return;
    }
    if (!canAccessAssignment(req, existing, "assignment:update")) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const session = sessions.find((item) => item.id === existing.sessionId);
    if (!session || ["Closed", "Archived"].includes(String(session.status))) {
      res.status(409).json({ error: "Assignments cannot be changed in a closed session" });
      return;
    }
    if (["Completed", "Cancelled"].includes(String(existing.status))) {
      res.status(409).json({ error: "Terminal assignments are read-only" });
      return;
    }
    const { status: _status, ownerAssignedTo: _owner, assignedUserId: _assignedUserId, assignedUserDisplayName: _assignedUserDisplayName, sessionId: _sessionId, ...updates } = req.body ?? {};
    const row = updateRow("assignments", existing.id, updates, req)!;
    addAudit(req, "update_assignment", `Assignment ${row.operationalId} updated`, row.sessionId, undefined, "assignmentTask", row.id);
    res.json(assignmentResponse(row, req));
  });

  router.post("/assignments/:id/assign", requirePermission("assignment:assign"), (req, res) => {
    if (!isAssignmentManager(req)) {
      res.status(403).json({ error: "Only a Leader, Coordinator or Administrator can assign work to others" });
      return;
    }
    const assignedUserId = String(req.body?.assignedUserId ?? "").trim();
    const assignee = findAssignmentAssignee(req, assignedUserId);
    if (!assignee) {
      res.status(404).json({ error: "Assignee not found" });
      return;
    }
    const existing = assignments.find((item) => item.id === req.params.id);
    if (!existing) {
      res.status(404).json({ error: "Assignment not found" });
      return;
    }
    if (!canAccessAssignment(req, existing, "assignment:assign")) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    if (!assigneeMatchesAssignment(existing, assignee)) {
      res.status(403).json({ error: "Assignee is outside this assignment group" });
      return;
    }
    const session = sessions.find((item) => item.id === existing.sessionId);
    if (!session || ["Closed", "Archived"].includes(String(session.status))) {
      res.status(409).json({ error: "Assignments cannot be changed in a closed session" });
      return;
    }
    if (existing.status !== "Open" || existing.assignedUserId || existing.ownerAssignedTo) {
      res.status(409).json({ error: "Only an unassigned open assignment can be assigned" });
      return;
    }
    const row = updateRow("assignments", existing.id, { assignedUserId: assignee.id, assignedUserDisplayName: assignee.displayName, ownerAssignedTo: assignee.displayName }, req)!;
    const metadata = { previousAssigneeId: null, previousAssigneeDisplayName: null, newAssigneeId: assignee.id, newAssigneeDisplayName: assignee.displayName, oldState: "Open", newState: "Open" };
    addAudit(req, "assign_assignment", `Assignment ${row.operationalId} assigned to ${assignee.displayName}`, row.sessionId, metadata, "assignmentTask", row.id);
    addTimeline(req, { sessionId: row.sessionId, caseId: row.caseId, eventType: "assignment", entityType: "assignmentTask", entityId: row.id, title: `Assignment ${row.operationalId} assigned to ${assignee.displayName}`, metadata });
    notifySafely(() => notifications.notifyAssignmentAssigned(row));
    res.json(assignmentResponse(row, req));
  });
  router.post("/assignments/:id/assign-to-me", requirePermission("assignment:update"), (req, res) => {
    const actor = currentUser(req);
    const existing = assignments.find((item) => item.id === req.params.id);
    if (!existing) {
      res.status(404).json({ error: "Assignment not found" });
      return;
    }
    if (!canAccessAssignment(req, existing, "assignment:update")) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const session = sessions.find((item) => item.id === existing.sessionId);
    if (!session || ["Closed", "Archived"].includes(String(session.status))) {
      res.status(409).json({ error: "Assignments cannot be changed in a closed session" });
      return;
    }
    if (existing.status !== "Open" || existing.assignedUserId || existing.ownerAssignedTo) {
      res.status(409).json({ error: "This assignment is no longer available to claim" });
      return;
    }
    const row = updateRow("assignments", existing.id, { assignedUserId: actor.userId, assignedUserDisplayName: actor.displayName, ownerAssignedTo: actor.displayName }, req)!;
    const metadata = { previousAssigneeId: null, previousAssigneeDisplayName: null, newAssigneeId: actor.userId, newAssigneeDisplayName: actor.displayName, oldState: "Open", newState: "Open" };
    addAudit(req, "claim_assignment", `Assignment ${row.operationalId} claimed by ${actor.displayName}`, row.sessionId, metadata, "assignmentTask", row.id);
    addTimeline(req, { sessionId: row.sessionId, caseId: row.caseId, eventType: "assignment", entityType: "assignmentTask", entityId: row.id, title: `Assignment ${row.operationalId} claimed by ${actor.displayName}`, metadata });
    notifySafely(() => notifications.notifyAssignmentAssigned(row));
    res.json(assignmentResponse(row, req));
  });
  router.post("/assignments/:id/reassign", requirePermission("assignment:assign"), (req, res) => {
    if (!isAssignmentManager(req)) {
      res.status(403).json({ error: "Only a Leader, Coordinator or Administrator can reassign work" });
      return;
    }
    const assignedUserId = String(req.body?.assignedUserId ?? "").trim();
    const assignee = findAssignmentAssignee(req, assignedUserId);
    const reason = String(req.body?.reason ?? "").trim();
    if (!assignee || reason.length < 3) {
      res.status(400).json({ error: "A new assignee and handover reason are required" });
      return;
    }
    const existing = assignments.find((item) => item.id === req.params.id);
    if (!existing) {
      res.status(404).json({ error: "Assignment not found" });
      return;
    }
    if (!canAccessAssignment(req, existing, "assignment:assign")) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    if (!assigneeMatchesAssignment(existing, assignee)) {
      res.status(403).json({ error: "Assignee is outside this assignment group" });
      return;
    }
    const session = sessions.find((item) => item.id === existing.sessionId);
    if (!session || ["Closed", "Archived"].includes(String(session.status))) {
      res.status(409).json({ error: "Assignments cannot be changed in a closed session" });
      return;
    }
    if (["Completed", "Cancelled"].includes(String(existing.status))) {
      res.status(409).json({ error: "Terminal assignments are read-only" });
      return;
    }
    if (!existing.assignedUserId && !existing.ownerAssignedTo) {
      res.status(409).json({ error: "Use Assign or Claim for unassigned work" });
      return;
    }
    if (existing.assignedUserId === assignee.id) {
      res.status(409).json({ error: "Select a different assignee" });
      return;
    }
    const previousAssigneeId = existing.assignedUserId ?? null;
    const previousAssigneeDisplayName = existing.assignedUserDisplayName ?? existing.ownerAssignedTo ?? null;
    const row = updateRow("assignments", existing.id, { assignedUserId: assignee.id, assignedUserDisplayName: assignee.displayName, ownerAssignedTo: assignee.displayName }, req)!;
    const metadata = { previousAssigneeId, previousAssigneeDisplayName, newAssigneeId: assignee.id, newAssigneeDisplayName: assignee.displayName, reason, oldState: row.status, newState: row.status };
    addAudit(req, "reassign_assignment", `Assignment ${row.operationalId} reassigned from ${previousAssigneeDisplayName ?? "unassigned"} to ${assignee.displayName}`, row.sessionId, metadata, "assignmentTask", row.id);
    addTimeline(req, { sessionId: row.sessionId, caseId: row.caseId, eventType: "assignment", entityType: "assignmentTask", entityId: row.id, title: `Assignment ${row.operationalId} reassigned`, body: reason, metadata });
    notifySafely(() => notifications.notifyAssignmentAssigned(row));
    res.json(assignmentResponse(row, req));
  });
  router.post("/assignments/:id/status", requirePermission("assignment:update"), (req, res) => {
    const status = String(req.body?.status ?? "");
    if (!(dictionaries.assignmentStatuses as readonly string[]).includes(status)) {
      res.status(400).json({ error: "Invalid assignment status" });
      return;
    }
    const existing = assignments.find((item) => item.id === req.params.id);
    if (!existing) {
      res.status(404).json({ error: "Assignment not found" });
      return;
    }
    if (!canAccessAssignment(req, existing, "assignment:update")) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const session = sessions.find((item) => item.id === existing.sessionId);
    if (!session || ["Closed", "Archived"].includes(String(session.status))) {
      res.status(409).json({ error: "Assignments cannot be changed in a closed session" });
      return;
    }
    if (["Completed", "Cancelled"].includes(String(existing.status))) {
      res.status(409).json({ error: "Terminal assignments are read-only" });
      return;
    }
    const transitions: Record<string, string[]> = { Open: ["In Progress", "Cancelled"], "In Progress": ["Escalated", "Completed", "Cancelled"], Escalated: ["In Progress", "Cancelled"] };
    if (!transitions[String(existing.status)]?.includes(status)) {
      res.status(409).json({ error: `Invalid assignment transition from ${existing.status} to ${status}` });
      return;
    }
    if (!existing.assignedUserId && !existing.ownerAssignedTo) {
      res.status(409).json({ error: "Assign or claim this work before changing its status" });
      return;
    }
    const actor = currentUser(req);
    const manager = isAssignmentManager(req);
    if (!manager && existing.assignedUserId !== actor.userId) {
      res.status(409).json({ error: "Only the current assignee or a Coordinator can change this status" });
      return;
    }
    const previousStatus = existing.status;
    const row = updateRow("assignments", existing.id, { status }, req)!;
    const metadata = { oldState: previousStatus, newState: status, status, reason: req.body?.reason, assignedUserId: existing.assignedUserId ?? null, assignedUserDisplayName: existing.assignedUserDisplayName ?? existing.ownerAssignedTo ?? null };
    addAudit(req, "update_assignment_status", `Assignment ${row.operationalId} status changed to ${status}`, row.sessionId, metadata, "assignmentTask", row.id);
    addTimeline(req, {
      sessionId: row.sessionId,
      caseId: row.caseId,
      eventType: "assignment",
      entityType: "assignmentTask",
      entityId: row.id,
      title: `Assignment ${row.operationalId} moved to ${status}`,
      body: req.body?.reason || row.title,
      metadata
    });
    notifySafely(() => {
      if (status === "Completed") notifications.resolveSource("assignment", row.id, "Source completed");
      if (status === "Cancelled") notifications.notifyAssignmentCancelled(row);
    });
    res.json(assignmentResponse(row, req));
  });
  router.post("/exercise/injects/:id/release", requirePermission("exercise:manage"), (req, res) => res.json(updateRow("exercise/injects", String(req.params.id), { status: "Released", releasedAt: now() }, req)));
  router.post("/exercise/injects/:id/complete", requirePermission("exercise:manage"), (req, res) => res.json(updateRow("exercise/injects", String(req.params.id), { status: "Completed" }, req)));

  router.post("/imports/:type", requirePermission("import:create"), upload.single("file"), requireIncidentAccess((req) => String(req.body?.sessionId ?? ""), false, true), (req, res) => {
    try {
      if (String(req.params.type) !== "manifest") {
        res.status(400).json({ error: "Only manifest CSV imports are supported" });
        return;
      }
      if (!can(req, "passenger:create")) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: "file is required" });
        return;
      }
      const fileName = req.file.originalname.toLowerCase();
      const supportedMimeTypes = new Set(["text/csv", "application/csv", "application/vnd.ms-excel"]);
      if (!fileName.endsWith(".csv") || !supportedMimeTypes.has(req.file.mimetype.toLowerCase())) {
        res.status(400).json({ error: "Manifest import requires a CSV file" });
        return;
      }
      const sessionId = String(req.body?.sessionId ?? "").trim();
      if (!sessionId) {
        res.status(400).json({ error: "sessionId is required" });
        return;
      }
      const rows = parseWorkbook(readFileSync(req.file.path), req.file.originalname) as Row[];
      const result = validatePassengerManifestRows(rows, sessionId);
      const batch = createRow("import-batches", {
        id: randomUUID(),
        sessionId,
        importType: "manifest",
        sourceFilename: req.file.originalname,
        status: result.errors.length ? "Validated with errors" : "Validated",
        totalRecords: rows.length,
        validRecords: result.validRows.length,
        invalidRecords: result.errors.length,
        errors: result.errors
      }, req);
      importRowsByBatchId.set(String(batch.id), result.validRows);
      createRow("files", {
        sessionId,
        importBatchId: batch.id,
        fileName: req.file.originalname,
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size
      }, req);
      addAudit(req, "validate_import", `Validated manifest: ${result.validRows.length}/${rows.length} valid`, sessionId, {
        importBatchId: batch.id,
        totalRecords: rows.length,
        validRecords: result.validRows.length,
        invalidRecords: result.errors.length
      }, "importBatch", batch.id);
      res.status(201).json({ ...batch, previewRows: result.previewRows });
    } catch (error) {
      const status = error instanceof DirectoryError ? error.status : 400;
      res.status(status).json({ error: error instanceof Error ? error.message : "Unable to validate import" });
    }
  });

  router.post("/imports/:id/confirm", requirePermission("import:create"), (req, res, next) => {
    const batch = importBatches.find((item) => item.id === req.params.id);
    if (!batch) {
      res.status(404).json({ error: "Import batch not found" });
      return;
    }
    if (String(batch.status).startsWith("Imported")) {
      res.status(409).json({ error: "Import batch has already been confirmed" });
      return;
    }
    if (batch.importType !== "manifest" || !can(req, "passenger:create")) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const validRows = importRowsByBatchId.get(String(batch.id));
    if (!validRows) {
      res.status(404).json({ error: "Validated import data not found" });
      return;
    }
    const actor: PassengerActor = {
      id: currentUser(req).id,
      email: currentUser(req).email,
      displayName: currentUser(req).displayName,
      roles: currentUser(req).roles,
      requestId: req.requestId
    };
    void (async () => {
      const records = validRows.map(({ sessionId: _sessionId, ...row }) => row) as PassengerImportInput["records"];
      const result = await passengerService.importRecords(actor, String(batch.sessionId), {
        batchId: String(batch.id),
        sourceFilename: String(batch.sourceFilename ?? "manifest.csv"),
        totalRecords: Number(batch.totalRecords),
        invalidRecords: Number(batch.invalidRecords),
        errors: Array.isArray(batch.errors) ? batch.errors : [],
        records
      });
      Object.assign(batch, { status: result.status, updatedAt: now() });
      importRowsByBatchId.delete(String(batch.id));
      res.json(batch);
    })().catch(next);
  });

  router.get("/exports/:type", requirePermission("export:create"), requireIncidentAccess(activeSessionId, true), (req, res) => {
    const type = String(req.params.type);
    if (type === "pdf-session-summary" || type === "aar-draft") {
      res.status(501).json({
        error: "This report format is not available right now."
      });
      return;
    }
    const sessionId = activeSessionId(req);
    const session = sessions.find((item) => item.id === sessionId);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    if (!can(req, "session:read")) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const sourceByType: Record<string, { permission: string; label: string; rows: Row[] }> = {
      "enquiry-log": { permission: "enquiry:read", label: "Enquiries", rows: enquiries },
      "family-register": { permission: "family:read", label: "FamilyRecords", rows: familyRecords },
      "passenger-register": { permission: "passenger:read", label: "PassengerRecords", rows: passengerRecords },
      "matching-log": { permission: "matching:read", label: "MatchingRecords", rows: matchingRecords },
      "requests-log": { permission: "request:read", label: "Requests", rows: requests },
      "audit-log": { permission: "audit:read", label: "AuditLog", rows: auditLogs }
    };
    const supportedTypes = new Set(["session-package", ...Object.keys(sourceByType)]);
    if (!supportedTypes.has(type)) {
      res.status(400).json({ error: "Unsupported export type" });
      return;
    }
    const selected = sourceByType[type];
    if (selected && !can(req, selected.permission)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const sheets: Record<string, Row[]> = {
      Session: [{
        operationalId: session.operationalId,
        mode: session.mode,
        status: session.status,
        eventType: session.eventType,
        flightNumber: session.flightNumber,
        route: session.route,
        startedAt: session.startedAt,
        endedAt: session.endedAt
      }]
    };
    if (selected) {
      sheets[selected.label] = operationalExportRows(type, selected.rows.filter((item) => item.sessionId === sessionId));
    } else {
      Object.entries(sourceByType).forEach(([sourceType, source]) => {
        if (can(req, source.permission)) {
          sheets[source.label] = operationalExportRows(sourceType, source.rows.filter((item) => item.sessionId === sessionId));
        }
      });
    }
    addAudit(req, "export", `CSV export downloaded for ${type}`, sessionId, { type }, "session", sessionId);
    res.setHeader("content-type", "text/csv");
    res.setHeader("content-disposition", `attachment; filename="${session.operationalId}-${type}.csv"`);
    res.send(workbookBuffer(sheets));
  });

  router.get("/reports/session-summary", requirePermission("reports:read"), requireIncidentAccess(activeSessionId, true), (req, res) => {
    const sessionId = activeSessionId(req);
    const scopedDashboard = dashboard(req, sessionId);
    res.json({
      session: sessions.find((session) => session.id === sessionId),
      counts: scopedDashboard.kpis,
      holds: can(req, "matching:read") ? matchingRecords.filter((item) => item.sessionId === sessionId) : [],
      urgentRequests: can(req, "request:read")
        ? requests.filter((item) => item.sessionId === sessionId && item.priority === "Urgent" && !terminalStatuses.has(item.status))
        : []
    });
  });

  router.get("/admin/users", requirePermission("admin:manage"), (req, res) => {
    const search = String(req.query.search ?? req.query.q ?? "").toLowerCase().trim();
    const status = String(req.query.status ?? "").trim();
    const role = canonicalRoleName(String(req.query.role ?? ""));
    const linked = String(req.query.linked ?? "");
    const authenticationPolicy = String(req.query.authenticationPolicy ?? "").trim();
    const invitationStatus = String(req.query.invitationStatus ?? "").trim();
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
    const filtered = users
      .filter((user) => !status || user.status === status)
      .filter((user) => !role || activeRoleAssignmentsFor(user.id).some((assignment) => canonicalRoleName(assignment.roleName) === role))
      .filter((user) => linked === "linked" ? Boolean(user.linkedMemberProfileId) : linked === "unlinked" ? !user.linkedMemberProfileId : true)
      .filter((user) => !authenticationPolicy || user.authenticationPolicy === authenticationPolicy)
      .filter((user) => !invitationStatus || (invitationStatus === "None" ? !latestInvitationForUser(user.id) : latestInvitationForUser(user.id)?.status === invitationStatus))
      .filter((user) => !search || [user.displayName, user.email, user.employeeId, user.department].some((value) => String(value ?? "").toLowerCase().includes(search)))
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
    res.json({ total: filtered.length, limit, offset, data: filtered.slice(offset, offset + limit).map(adminUserResponse) });
  });

  router.post("/admin/users", requirePermission("admin:manage"), (req, res) => {
    const actor = currentUser(req);
    const displayName = String(req.body?.displayName ?? "").trim();
    const email = String(req.body?.email ?? req.body?.loginEmail ?? "").trim().toLowerCase();
    if (!displayName || !email) {
      res.status(400).json({ error: "Name and email are required." });
      return;
    }
    if (userByEmail(email)) {
      res.status(409).json({ error: "An account with this login identifier already exists." });
      return;
    }
    const organization = organizations.find((item) => item.id === req.body?.organizationId || item.key === req.body?.organizationKey) ?? organizationByKey("lot");
    const nextIndex = users.length + 1;
    const user = userAccount({
      id: `usr-2026-${String(nextIndex).padStart(6, "0")}`,
      email,
      displayName,
      employeeId: String(req.body?.employeeId ?? "").trim() || null,
      department: String(req.body?.department ?? "").trim() || "Access administration",
      organization,
      status: "Pending",
      linkedMemberProfileId: null,
      createdByUserId: actor.id,
      updatedByUserId: actor.id,
      lastSuccessfulSignInAt: null
    });
    users.push(user);
    addAudit(req, "user_created", "User account created", activeSessionId(req), { targetUserId: user.id }, "userAccount", user.id);
    res.status(201).json(adminUserResponse(user));
  });

  router.get("/admin/users/:userId", requirePermission("admin:manage"), (req, res) => {
    const user = userById(String(req.params.userId));
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json(adminUserResponse(user));
  });

  router.patch("/admin/users/:userId", requirePermission("admin:manage"), (req, res) => {
    const actor = currentUser(req);
    const user = userById(String(req.params.userId));
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    if (req.body?.status !== undefined) {
      res.status(400).json({ error: "Use the dedicated account status action." });
      return;
    }
    if (req.body?.authenticationPolicy !== undefined) {
      res.status(400).json({ error: "Use the dedicated authentication policy action." });
      return;
    }
    const stale = assertVersion(user.version, req.body?.expectedVersion);
    if (stale) {
      res.status(409).json({ error: stale });
      return;
    }
    const nextEmail = String(req.body?.email ?? user.email).trim().toLowerCase();
    const duplicate = users.find((candidate) => candidate.id !== user.id && candidate.email === nextEmail);
    if (duplicate) {
      res.status(409).json({ error: "An account with this login identifier already exists." });
      return;
    }
    const previous = {
      email: user.email,
      displayName: user.displayName,
      employeeId: user.employeeId ?? null,
      department: user.department ?? null
    };
    const next = {
      email: nextEmail,
      displayName: String(req.body?.displayName ?? user.displayName).trim() || user.displayName,
      employeeId: String(req.body?.employeeId ?? user.employeeId ?? "").trim() || null,
      department: String(req.body?.department ?? user.department).trim() || user.department
    };
    updateUser(user, {
      email: next.email,
      displayName: next.displayName,
      employeeId: next.employeeId,
      department: next.department
    }, actor.id);
    addAudit(req, "user_metadata_changed", "User account updated", activeSessionId(req), { targetUserId: user.id, previous, next }, "userAccount", user.id);
    res.json(adminUserResponse(user));
  });

  router.get("/admin/users/:userId/lifecycle-impact", requirePermission("admin:manage"), (req, res) => {
    const user = userById(String(req.params.userId));
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json(lifecycleImpactForUser(user.id));
  });

  router.post("/admin/users/:userId/authentication-policy", requirePermission("admin:manage"), (req, res) => {
    const actor = currentUser(req);
    const user = userById(String(req.params.userId));
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const stale = assertVersion(user.version, req.body?.expectedVersion);
    if (stale) {
      res.status(409).json({ error: stale });
      return;
    }
    const requestedPolicy = String(req.body?.authenticationPolicy ?? "").trim();
    if (!authenticationPolicies.includes(requestedPolicy as AuthenticationPolicy)) {
      res.status(400).json({ error: "Select a valid authentication policy." });
      return;
    }
    const nextPolicy = requestedPolicy as AuthenticationPolicy;
    if (nextPolicy === user.authenticationPolicy) {
      res.status(409).json({ error: "This account already uses that authentication policy." });
      return;
    }
    if (actor.id === user.id && !activeAdminIds().some((id) => id !== user.id)) {
      res.status(409).json({ error: "Ask another active System Admin to change your authentication policy." });
      return;
    }
    if (wouldPolicyRemoveLastAdmin(user, nextPolicy)) {
      res.status(409).json({ error: "Assign another active System Admin before changing this authentication policy." });
      return;
    }
    const reason = requireReason(req.body?.reason);
    if (!reason) {
      res.status(400).json({ error: "A reason is required." });
      return;
    }
    const previousPolicy = user.authenticationPolicy;
    updateUser(user, { authenticationPolicy: nextPolicy }, actor.id);
    addAudit(req, "authentication_policy_changed", "Authentication policy changed", activeSessionId(req), {
      targetUserId: user.id,
      previousAuthenticationPolicy: previousPolicy,
      authenticationPolicy: nextPolicy,
      reason
    }, "userAccount", user.id);
    notifyAccessChange(user.id, "Authentication policy changed", "Your account sign-in policy was updated.", "authentication_policy_changed");
    res.json(adminUserResponse(user));
  });

  function lifecycleTargetStatus(action: AccountLifecycleAction, status: AccountStatus): AccountStatus | null {
    if (action === "activate" && status === "Pending") return "Active";
    if (action === "suspend" && status === "Active") return "Suspended";
    if (action === "archive" && status !== "Archived") return "Archived";
    if (action === "restore" && status === "Suspended") return "Active";
    if (action === "restore" && status === "Archived") return "Pending";
    return null;
  }

  function lifecycleTransitionError(action: AccountLifecycleAction, status: AccountStatus) {
    if (action === "activate") return status === "Suspended" ? "Use Restore to reactivate a suspended account." : "Only pending accounts can be activated.";
    if (action === "suspend") return "Only active accounts can be suspended.";
    if (action === "archive") return "This account is already archived.";
    return "Only suspended or archived accounts can be restored.";
  }

  const lifecycleAction = (action: AccountLifecycleAction) =>
    router.post(`/admin/users/:userId/${action}`, requirePermission("admin:manage"), (req, res) => {
      const actor = currentUser(req);
      const user = userById(String(req.params.userId));
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      const stale = assertVersion(user.version, req.body?.expectedVersion);
      if (stale) {
        res.status(409).json({ error: stale });
        return;
      }
      const reason = requireReason(req.body?.reason);
      if ((action === "suspend" || action === "archive") && !reason) {
        res.status(400).json({ error: "A reason is required." });
        return;
      }
      if ((action === "suspend" || action === "archive") && actor.id === user.id) {
        res.status(409).json({ error: "You cannot suspend or archive your own account." });
        return;
      }
      if ((action === "suspend" || action === "archive") && wouldRemoveLastAdmin(user.id)) {
        res.status(409).json({ error: "Assign another active System Admin before removing this access." });
        return;
      }
      const previousStatus = user.status;
      const nextStatus = lifecycleTargetStatus(action, user.status);
      if (!nextStatus) {
        res.status(409).json({ error: lifecycleTransitionError(action, user.status) });
        return;
      }
      const impact = lifecycleImpactForUser(user.id);
      if ((action === "suspend" || action === "archive") && !impact.available) {
        res.status(503).json({ error: "Account impact could not be reviewed. Refresh and try again." });
        return;
      }
      const timestamp = now();
      updateUser(user, {
        status: nextStatus,
        activatedAt: action === "activate" ? timestamp : user.activatedAt,
        suspendedAt: action === "suspend" ? timestamp : user.suspendedAt,
        archivedAt: action === "archive" ? timestamp : user.archivedAt,
        restoredAt: action === "restore" ? timestamp : user.restoredAt
      }, actor.id);
      const actionName = action === "activate" ? "user_activated" : action === "suspend" ? "user_suspended" : action === "archive" ? "user_archived" : "user_restored";
      const summary = action === "activate" ? "User account activated" : action === "suspend" ? "User account suspended" : action === "archive" ? "User account archived" : "User account restored";
      addAudit(req, actionName, summary, activeSessionId(req), { targetUserId: user.id, previousStatus, nextStatus, reason, responsibilities: impact }, "userAccount", user.id);
      if (action !== "archive") notifyAccessChange(user.id, summary, summary, actionName);
      res.json(adminUserResponse(user));
    });

  lifecycleAction("activate");
  lifecycleAction("suspend");
  lifecycleAction("archive");
  lifecycleAction("restore");

  router.post("/admin/users/:userId/revoke-sessions", requirePermission("admin:manage"), (req, res) => {
    const user = userById(String(req.params.userId));
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.status(501).json({ error: "Session revocation is not available." });
  });

  router.post("/admin/users/:userId/role-assignments", requirePermission("admin:manage"), (req, res) => {
    const actor = currentUser(req);
    const user = userById(String(req.params.userId));
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const roleName = canonicalRoleName(String(req.body?.roleName ?? ""));
    const scopeType = (req.body?.scopeType === "GROUP" ? "GROUP" : "GLOBAL") as RoleScopeType;
    const scopeId = scopeType === "GROUP" ? String(req.body?.scopeId ?? "").trim() || null : null;
    if (actor.id === user.id && roleName === "system-admin" && !activeRoleAssignmentsFor(user.id).some((assignment) => canonicalRoleName(assignment.roleName) === "system-admin")) {
      res.status(403).json({ error: "Self-elevation is not allowed." });
      return;
    }
    const candidate = { userId: user.id, roleName, scopeType, scopeId };
    const error = validateRoleAssignment(candidate, roleAssignmentGroups, roles);
    if (error) {
      res.status(400).json({ error });
      return;
    }
    if (duplicateActiveRoleAssignment(userRoleAssignments, candidate)) {
      res.status(409).json({ error: "Duplicate active role assignment." });
      return;
    }
    const assignment: RoleAssignment = {
      id: `ura-${user.id.slice(-4)}-${roleName}-${userRoleAssignments.length + 1}`,
      userId: user.id,
      roleName,
      scopeType,
      scopeId,
      status: "Active",
      assignedAt: now(),
      assignedByUserId: actor.id,
      version: 1
    };
    userRoleAssignments.push(assignment);
    refreshUserRoleSnapshot(user);
    addAudit(req, scopeType === "GROUP" ? "scoped_role_assigned" : "role_assigned", "Role assigned", activeSessionId(req), { targetUserId: user.id, roleName, scopeType, scopeId }, "userAccount", user.id);
    notifyAccessChange(user.id, "Role assignment changed", "Your application access was updated.", assignment.id);
    res.status(201).json(roleAssignmentResponse(assignment));
  });

  router.post("/admin/users/:userId/role-assignments/:assignmentId/revoke", requirePermission("admin:manage"), (req, res) => {
    const actor = currentUser(req);
    const user = userById(String(req.params.userId));
    const assignment = userRoleAssignments.find((item) => item.id === req.params.assignmentId && item.userId === req.params.userId);
    if (!user || !assignment) {
      res.status(404).json({ error: "Role assignment not found" });
      return;
    }
    if (assignment.status !== "Active") {
      res.status(409).json({ error: "This role assignment is already inactive." });
      return;
    }
    const isAdminAssignment = rolePermissions(assignment.roleName, roles).includes("admin:manage");
    if ((actor.id === user.id || isAdminAssignment) && wouldRemoveLastAdmin(user.id)) {
      res.status(409).json({ error: "Assign another active System Admin before removing this access." });
      return;
    }
    assignment.status = "Revoked";
    assignment.revokedAt = now();
    assignment.revokedByUserId = actor.id;
    assignment.version = (assignment.version ?? 1) + 1;
    refreshUserRoleSnapshot(user);
    addAudit(req, "role_assignment_revoked", "Role assignment revoked", activeSessionId(req), { targetUserId: user.id, roleName: assignment.roleName, scopeType: assignment.scopeType, scopeId: assignment.scopeId ?? null }, "userAccount", user.id);
    notifyAccessChange(user.id, "Role assignment changed", "Your application access was updated.", assignment.id);
    res.json(roleAssignmentResponse(assignment));
  });

  router.patch("/admin/users/:id/roles", requirePermission("admin:manage"), (req, res) => {
    const actor = currentUser(req);
    const user = userById(String(req.params.id));
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const rawAssignments = Array.isArray(req.body?.assignments)
      ? req.body.assignments
      : Array.isArray(req.body?.roles)
        ? req.body.roles.map((roleName: unknown) => ({ roleName, scopeType: "GLOBAL" }))
        : [];
    if (!rawAssignments.length) {
      res.status(400).json({ error: "At least one role assignment is required" });
      return;
    }
    const previousAssignments = activeRoleAssignmentsFor(user.id).map((assignment) => ({
      roleName: canonicalRoleName(assignment.roleName),
      scopeType: assignment.scopeType,
      scopeId: assignment.scopeId ?? null
    }));
    const nextAssignments: Array<Pick<RoleAssignment, "roleName" | "scopeType" | "scopeId">> = [];
    const seen = new Set<string>();
    for (const raw of rawAssignments) {
      const roleName = canonicalRoleName(String(raw?.roleName ?? raw?.name ?? raw));
      const scopeType = (raw?.scopeType === "GROUP" ? "GROUP" : "GLOBAL") as RoleScopeType;
      const scopeId = scopeType === "GROUP" ? String(raw?.scopeId ?? "").trim() || null : null;
      const candidate = { roleName, scopeType, scopeId };
      const error = validateRoleAssignment(candidate, roleAssignmentGroups, roles);
      if (error) {
        res.status(400).json({ error });
        return;
      }
      const keyValue = `${roleName}:${scopeType}:${scopeId ?? ""}`;
      if (seen.has(keyValue)) {
        res.status(409).json({ error: "Duplicate active role assignment" });
        return;
      }
      seen.add(keyValue);
      nextAssignments.push(candidate);
    }
    const nextHasAdmin = nextAssignments.some((assignment) => rolePermissions(assignment.roleName, roles).includes("admin:manage"));
    if (wouldRemoveLastAdmin(user.id) && !nextHasAdmin) {
      res.status(409).json({ error: "Assign another active System Admin before removing this access." });
      return;
    }
    const assignmentKey = (assignment: Pick<RoleAssignment, "roleName" | "scopeType" | "scopeId">) =>
      `${assignment.roleName}:${assignment.scopeType}:${assignment.scopeId ?? ""}`;
    const previousKeys = new Set(previousAssignments.map(assignmentKey));
    const nextKeys = new Set(nextAssignments.map(assignmentKey));
    const unmatchedNextByRole = new Map<string, typeof nextAssignments>();
    for (const next of nextAssignments.filter((assignment) => !previousKeys.has(assignmentKey(assignment)))) {
      unmatchedNextByRole.set(next.roleName, [...(unmatchedNextByRole.get(next.roleName) ?? []), next]);
    }
    const scopeChanges = previousAssignments
      .filter((previous) => !nextKeys.has(assignmentKey(previous)))
      .map((previous) => {
        const unmatchedNext = unmatchedNextByRole.get(previous.roleName) ?? [];
        const next = unmatchedNext.shift();
        if (!next) return null;
        unmatchedNextByRole.set(previous.roleName, unmatchedNext);
        return {
          roleName: previous.roleName,
          previousScopeType: previous.scopeType,
          previousScopeId: previous.scopeId,
          nextScopeType: next.scopeType,
          nextScopeId: next.scopeId ?? null
        };
      })
      .filter((change): change is {
        roleName: string;
        previousScopeType: RoleScopeType;
        previousScopeId: string | null;
        nextScopeType: RoleScopeType;
        nextScopeId: string | null;
      } => Boolean(change));
    replaceUserRoleAssignments(user.id, nextAssignments, actor.id);
    refreshUserRoleSnapshot(user);
    addAudit(req, "update_user_roles", `Roles updated for ${user.email}`, activeSessionId(req), { targetUserId: user.id, assignments: nextAssignments }, "userAccount", user.id);
    for (const change of scopeChanges) {
      addAudit(req, "role_scope_changed", "Role scope changed", activeSessionId(req), { targetUserId: user.id, ...change }, "userAccount", user.id);
    }
    notifyAccessChange(user.id, "Role assignment changed", "Your application access was updated.", "update_user_roles");
    res.json(adminUserResponse(user));
  });

  router.post("/admin/users/:userId/capability-overrides", requirePermission("admin:manage"), (req, res) => {
    const actor = currentUser(req);
    const user = userById(String(req.params.userId));
    const permission = String(req.body?.permission ?? "") as Permission;
    const effect = req.body?.effect === "DENY" ? "DENY" : "GRANT";
    const reason = requireReason(req.body?.reason);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    if (!(permission in permissions)) {
      res.status(404).json({ error: "Capability not found." });
      return;
    }
    if (!reason) {
      res.status(400).json({ error: "A reason is required." });
      return;
    }
    if (actor.id === user.id && effect === "GRANT" && permission === "admin:manage") {
      res.status(403).json({ error: "Self-elevation is not allowed." });
      return;
    }
    if (effect === "DENY" && permission === "admin:manage" && wouldRemoveLastAdmin(user.id)) {
      res.status(409).json({ error: "Assign another active System Admin before denying this capability." });
      return;
    }
    const override: PermissionOverride = {
      id: `ovr-${user.id.slice(-4)}-${permission.replace(/[^a-z0-9]+/gi, "-")}-${permissionOverrides.length + 1}`,
      userId: user.id,
      permission,
      effect,
      active: true,
      reason,
      expiresAt: req.body?.expiresAt ? new Date(String(req.body.expiresAt)).toISOString() : null,
      createdAt: now(),
      createdByUserId: actor.id,
      version: 1
    };
    permissionOverrides.push(override);
    refreshUserRoleSnapshot(user);
    addAudit(req, effect === "DENY" ? "user_deny_created" : "user_grant_created", effect === "DENY" ? "User deny created" : "User grant created", activeSessionId(req), { targetUserId: user.id, permission, reason }, "userAccount", user.id);
    notifyAccessChange(user.id, "Access exception changed", "An access exception was updated on your account.", override.id);
    res.status(201).json(override);
  });

  router.post("/admin/users/:userId/capability-overrides/:overrideId/revoke", requirePermission("admin:manage"), (req, res) => {
    const actor = currentUser(req);
    const user = userById(String(req.params.userId));
    const override = permissionOverrides.find((item) => item.id === req.params.overrideId && item.userId === req.params.userId);
    if (!user || !override) {
      res.status(404).json({ error: "Capability override not found" });
      return;
    }
    if (!override.active || override.revokedAt) {
      res.status(409).json({ error: "This override is already inactive." });
      return;
    }
    if (override.effect === "GRANT" && override.permission === "admin:manage" && wouldRemoveLastAdmin(user.id)) {
      res.status(409).json({ error: "Assign another active System Admin before revoking this capability." });
      return;
    }
    override.active = false;
    override.revokedAt = now();
    override.revokedByUserId = actor.id;
    override.version = (override.version ?? 1) + 1;
    refreshUserRoleSnapshot(user);
    addAudit(req, "capability_override_revoked", "Capability override revoked", activeSessionId(req), { targetUserId: user.id, permission: override.permission, effect: override.effect }, "userAccount", user.id);
    notifyAccessChange(user.id, "Access exception changed", "An access exception was updated on your account.", override.id);
    res.json(override);
  });

  router.get("/admin/users/:userId/effective-access", requirePermission("admin:manage"), (req, res) => {
    const detail = effectiveAccessDetail(String(req.params.userId));
    if (!detail) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json(detail);
  });

  router.get("/admin/users/:userId/access-history", requirePermission("admin:manage"), (req, res) => {
    const user = userById(String(req.params.userId));
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json({ data: accessHistoryFor(user.id) });
  });

  router.post("/admin/users/:userId/member-link", requirePermission("admin:manage"), directoryRoute((req) => {
    const actor = currentUser(req);
    const user = userById(String(req.params.userId));
    if (!user) throw new DirectoryError(404, "User not found");
    const memberProfileId = String(req.body?.memberProfileId ?? "").trim();
    if (!memberProfileId) throw new DirectoryError(400, "Member profile is required.");
    const currentLinkedUser = users.find((candidate) => candidate.id !== user.id && candidate.linkedMemberProfileId === memberProfileId && candidate.status !== "Archived");
    if (currentLinkedUser) throw new DirectoryError(409, "This member profile is already linked to another account.");
    const previousMemberProfileId = user.linkedMemberProfileId ?? null;
    if (previousMemberProfileId && previousMemberProfileId !== memberProfileId) {
      memberDirectoryForAdmin?.updateMember(previousMemberProfileId, { linkedUserId: null }, directoryActor(req));
    }
    const member = memberDirectoryForAdmin?.updateMember(memberProfileId, { linkedUserId: user.id }, directoryActor(req));
    updateUser(user, { linkedMemberProfileId: memberProfileId }, actor.id);
    addAudit(req, previousMemberProfileId ? "member_profile_link_changed" : "member_profile_linked", previousMemberProfileId ? "Member profile link changed" : "Member profile linked", activeSessionId(req), { targetUserId: user.id, previousMemberProfileId, memberProfileId }, "userAccount", user.id);
    return { user: adminUserResponse(user), member };
  }));

  router.delete("/admin/users/:userId/member-link", requirePermission("admin:manage"), directoryRoute((req) => {
    const actor = currentUser(req);
    const user = userById(String(req.params.userId));
    if (!user) throw new DirectoryError(404, "User not found");
    const previousMemberProfileId = user.linkedMemberProfileId ?? null;
    if (previousMemberProfileId) memberDirectoryForAdmin?.updateMember(previousMemberProfileId, { linkedUserId: null }, directoryActor(req));
    updateUser(user, { linkedMemberProfileId: null }, actor.id);
    addAudit(req, "member_profile_unlinked", "Member profile unlinked", activeSessionId(req), { targetUserId: user.id, previousMemberProfileId }, "userAccount", user.id);
    return adminUserResponse(user);
  }));

  router.get("/admin/invitations", requirePermission("admin:manage"), (req, res) => {
    const search = String(req.query.search ?? req.query.q ?? "").toLowerCase().trim();
    const status = String(req.query.status ?? "").trim();
    const authenticationPolicy = String(req.query.authenticationPolicy ?? "").trim();
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
    const filtered = userInvitations
      .map((invitation) => expireInvitationIfNeeded(invitation, req))
      .filter((invitation) => !status || invitation.status === status)
      .filter((invitation) => !authenticationPolicy || invitation.intendedAuthenticationPolicy === authenticationPolicy)
      .filter((invitation) => {
        if (!search) return true;
        const user = userById(invitation.userId);
        return [
          invitation.id,
          invitation.invitedEmailSnapshot,
          user?.displayName,
          user?.email,
          user?.employeeId
        ].some((value) => String(value ?? "").toLowerCase().includes(search));
      })
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
    res.json({ total: filtered.length, limit, offset, data: filtered.slice(offset, offset + limit).map(invitationResponse) });
  });

  router.get("/admin/invitations/:invitationId", requirePermission("admin:manage"), (req, res) => {
    const invitation = invitationById(String(req.params.invitationId));
    if (!invitation) {
      res.status(404).json({ error: "Invitation not found" });
      return;
    }
    expireInvitationIfNeeded(invitation, req);
    res.json(invitationResponse(invitation));
  });

  router.post("/admin/invitations", requirePermission("admin:manage"), (req, res) => {
    const actor = currentUser(req);
    if (inviteHasForbiddenPayloadKey(req.body)) {
      res.status(400).json({ error: "Invitation setup cannot include passwords, tokens, provider secrets or direct capability edits." });
      return;
    }
    const displayName = String(req.body?.displayName ?? "").trim();
    const email = String(req.body?.email ?? req.body?.loginEmail ?? "").trim().toLowerCase();
    if (!displayName || !email) {
      res.status(400).json({ error: "Name and email are required." });
      return;
    }
    const rawPolicy = req.body?.authenticationPolicy ?? req.body?.intendedAuthenticationPolicy;
    if (rawPolicy && !authenticationPolicies.includes(String(rawPolicy) as AuthenticationPolicy)) {
      res.status(400).json({ error: "Select a valid authentication policy." });
      return;
    }
    const authenticationPolicy = parseAuthenticationPolicy(rawPolicy);
    if (users.some((candidate) => candidate.email === email && candidate.status !== "Archived")) {
      res.status(409).json({ error: "An account with this login identifier already exists." });
      return;
    }
    const parsedAssignments = parseInviteRoleAssignments(req.body ?? {});
    if ("error" in parsedAssignments) {
      res.status(parsedAssignments.status ?? 400).json({ error: parsedAssignments.error });
      return;
    }
    const memberProfileId = String(req.body?.memberProfileId ?? req.body?.linkedMemberProfileId ?? "").trim() || null;
    let linkedMember: Row | null = null;
    let previousLinkedUserId: string | null = null;
    if (memberProfileId) {
      try {
        linkedMember = memberDirectoryForAdmin?.getMember(memberProfileId, directoryActor(req)) ?? null;
      } catch (error) {
        if (error instanceof DirectoryError) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        throw error;
      }
      if (!linkedMember) {
        res.status(404).json({ error: "Member profile not found" });
        return;
      }
      if (String(linkedMember.status) === "Archived") {
        res.status(409).json({ error: "This member profile is archived." });
        return;
      }
      previousLinkedUserId = String(linkedMember.linkedUserId ?? "").trim() || null;
      if (previousLinkedUserId && users.some((user) => user.id === previousLinkedUserId && user.status !== "Archived")) {
        res.status(409).json({ error: "This member profile is already linked to another account." });
        return;
      }
      if (users.some((user) => user.linkedMemberProfileId === memberProfileId && user.status !== "Archived")) {
        res.status(409).json({ error: "This member profile is already linked to another account." });
        return;
      }
    }

    const timestamp = now();
    const organization = organizations.find((item) => item.id === req.body?.organizationId || item.key === req.body?.organizationKey) ?? organizationByKey("lot");
    const user = userAccount({
      id: `usr-2026-${String(users.length + 1).padStart(6, "0")}`,
      email,
      displayName,
      employeeId: String(req.body?.employeeId ?? "").trim() || null,
      department: String(req.body?.department ?? "").trim() || "Access administration",
      organization,
      status: "Pending",
      authenticationPolicy,
      linkedMemberProfileId: memberProfileId,
      createdByUserId: actor.id,
      updatedByUserId: actor.id,
      lastSuccessfulSignInAt: null
    });
    user.createdAt = timestamp;
    user.updatedAt = timestamp;
    user.activatedAt = null;

    const assignments: RoleAssignment[] = parsedAssignments.assignments.map((assignment, index) => ({
      id: `ura-${user.id.slice(-4)}-${canonicalRoleName(assignment.roleName)}-${userRoleAssignments.length + index + 1}`,
      userId: user.id,
      roleName: canonicalRoleName(assignment.roleName),
      scopeType: assignment.scopeType,
      scopeId: assignment.scopeId ?? null,
      status: "Active",
      assignedAt: timestamp,
      assignedByUserId: actor.id,
      version: 1
    }));
    const invitationId = `inv-2026-${String(userInvitations.length + 1).padStart(6, "0")}`;
    const invitation: DemoUserInvitation = {
      id: invitationId,
      userId: user.id,
      invitedEmailSnapshot: email,
      intendedAuthenticationPolicy: authenticationPolicy,
      status: "Prepared",
      tokenHash: newInvitationHash(invitationId, 1),
      tokenExpiresAt: parseInvitationExpiry(req.body?.expiresAt ?? req.body?.tokenExpiresAt),
      createdByUserId: actor.id,
      createdAt: timestamp,
      sentAt: null,
      acceptedAt: null,
      revokedAt: null,
      revokedByUserId: null,
      revokeReason: null,
      resendGeneration: 1,
      version: 1,
      history: [{
        status: "Prepared",
        action: "invitation_prepared",
        actorUserId: actor.id,
        createdAt: timestamp,
        resendGeneration: 1
      }]
    };

    const usersLength = users.length;
    const assignmentsLength = userRoleAssignments.length;
    const invitationsLength = userInvitations.length;
    try {
      users.push(user);
      userRoleAssignments.push(...assignments);
      refreshUserRoleSnapshot(user);
      memberDirectoryForAdmin?.upsertUser({ id: user.id, email: user.email, displayName: user.displayName, roles: user.roles });
      if (memberProfileId) {
        memberDirectoryForAdmin?.updateMember(memberProfileId, { linkedUserId: user.id }, directoryActor(req));
      }
      userInvitations.unshift(invitation);
    } catch (error) {
      users.splice(usersLength);
      userRoleAssignments.splice(assignmentsLength);
      userInvitations.splice(invitationsLength);
      memberDirectoryForAdmin?.removeUser(user.id);
      if (memberProfileId) {
        try {
          memberDirectoryForAdmin?.updateMember(memberProfileId, { linkedUserId: previousLinkedUserId }, directoryActor(req));
        } catch {
          // The original validation error is returned below.
        }
      }
      if (error instanceof DirectoryError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }

    addAudit(req, "user_created", "User account created", activeSessionId(req), {
      targetUserId: user.id,
      invitationId: invitation.id,
      authenticationPolicy
    }, "userAccount", user.id);
    addAudit(req, "invitation_prepared", "Invitation prepared", activeSessionId(req), {
      targetUserId: user.id,
      invitationId: invitation.id,
      authenticationPolicy,
      roleSummary: invitationRoleSummary(user.id),
      memberProfileId
    }, "userInvitation", invitation.id);
    notifyAccessChange(user.id, "Invitation prepared", "Your account invitation is ready.", invitation.id);
    res.status(201).json(invitationResponse(invitation));
  });

  router.post("/admin/invitations/:invitationId/regenerate", requirePermission("admin:manage"), (req, res) => {
    const actor = currentUser(req);
    const invitation = invitationById(String(req.params.invitationId));
    if (!invitation) {
      res.status(404).json({ error: "Invitation not found" });
      return;
    }
    expireInvitationIfNeeded(invitation, req);
    if (invitation.status === "Accepted" || invitation.status === "Revoked") {
      res.status(409).json({ error: "This invitation cannot be regenerated." });
      return;
    }
    const user = userById(invitation.userId);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    invitation.resendGeneration += 1;
    invitation.status = "Prepared";
    invitation.tokenHash = newInvitationHash(invitation.id, invitation.resendGeneration);
    invitation.tokenExpiresAt = parseInvitationExpiry(req.body?.expiresAt ?? req.body?.tokenExpiresAt);
    invitation.sentAt = null;
    invitation.acceptedAt = null;
    invitation.revokedAt = null;
    invitation.revokedByUserId = null;
    invitation.revokeReason = null;
    invitation.version += 1;
    invitation.history.push({
      status: "Prepared",
      action: "invitation_regenerated",
      actorUserId: actor.id,
      createdAt: now(),
      resendGeneration: invitation.resendGeneration
    });
    addAudit(req, "invitation_regenerated", "Invitation regenerated", activeSessionId(req), {
      targetUserId: user.id,
      invitationId: invitation.id,
      authenticationPolicy: invitation.intendedAuthenticationPolicy,
      resendGeneration: invitation.resendGeneration,
      roleSummary: invitationRoleSummary(user.id)
    }, "userInvitation", invitation.id);
    notifyAccessChange(user.id, "Invitation updated", "A new invitation is ready for your account.", invitation.id);
    res.json(invitationResponse(invitation));
  });

  router.post("/admin/invitations/:invitationId/revoke", requirePermission("admin:manage"), (req, res) => {
    const actor = currentUser(req);
    const invitation = invitationById(String(req.params.invitationId));
    if (!invitation) {
      res.status(404).json({ error: "Invitation not found" });
      return;
    }
    expireInvitationIfNeeded(invitation, req);
    if (invitation.status === "Accepted") {
      res.status(409).json({ error: "Accepted invitations cannot be revoked." });
      return;
    }
    if (invitation.status === "Revoked") {
      res.status(409).json({ error: "This invitation is already revoked." });
      return;
    }
    if (invitation.status === "Expired") {
      res.status(409).json({ error: "Expired invitations can be regenerated instead." });
      return;
    }
    const reason = requireReason(req.body?.reason);
    if (!reason) {
      res.status(400).json({ error: "A reason is required." });
      return;
    }
    const user = userById(invitation.userId);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const timestamp = now();
    invitation.status = "Revoked";
    invitation.revokedAt = timestamp;
    invitation.revokedByUserId = actor.id;
    invitation.revokeReason = reason;
    invitation.version += 1;
    invitation.history.push({
      status: "Revoked",
      action: "invitation_revoked",
      actorUserId: actor.id,
      reason,
      createdAt: timestamp,
      resendGeneration: invitation.resendGeneration
    });
    addAudit(req, "invitation_revoked", "Invitation revoked", activeSessionId(req), {
      targetUserId: user.id,
      invitationId: invitation.id,
      authenticationPolicy: invitation.intendedAuthenticationPolicy,
      reason,
      roleSummary: invitationRoleSummary(user.id)
    }, "userInvitation", invitation.id);
    notifyAccessChange(user.id, "Invitation revoked", "Your account invitation was revoked.", invitation.id);
    res.json(invitationResponse(invitation));
  });

  router.post("/admin/invitations/:invitationId/local-accept", requirePermission("admin:manage"), (req, res) => {
    const actor = currentUser(req);
    if (!localOnboardingEnabled()) {
      res.status(404).json({ error: "Local onboarding is not available." });
      return;
    }
    const invitation = invitationById(String(req.params.invitationId));
    if (!invitation) {
      res.status(404).json({ error: "Invitation not found" });
      return;
    }
    const expectedGeneration = Number(req.body?.expectedGeneration ?? invitation.resendGeneration);
    if (!Number.isFinite(expectedGeneration) || Math.trunc(expectedGeneration) !== invitation.resendGeneration) {
      res.status(409).json({ error: "This invitation has been regenerated. Use the current invitation." });
      return;
    }
    expireInvitationIfNeeded(invitation, req);
    if (invitation.status === "Expired" || invitation.status === "Revoked") {
      res.status(410).json({ error: "This invitation is no longer active." });
      return;
    }
    if (invitation.status === "Accepted") {
      res.status(409).json({ error: "This invitation has already been accepted." });
      return;
    }
    if (!userInvitationStatuses.includes(invitation.status)) {
      res.status(409).json({ error: "This invitation cannot be accepted." });
      return;
    }
    const user = userById(invitation.userId);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    if (user.status !== "Pending") {
      res.status(409).json({ error: "Only pending accounts can complete onboarding through an invitation." });
      return;
    }
    const timestamp = now();
    const authenticationMethod = localIdentityMethod(invitation.intendedAuthenticationPolicy, req.body?.methodChoice);
    const providerSubject = `local-invitation:${invitation.id}:generation:${invitation.resendGeneration}`;
    let identity = externalIdentities.find((item) => item.invitationId === invitation.id || (item.userId === user.id && item.providerType === "LOCAL_DEV" && item.providerSubject === providerSubject));
    if (!identity) {
      identity = {
        id: `ext-local-${invitation.id}`,
        userId: user.id,
        providerType: "LOCAL_DEV",
        provider: "local-onboarding",
        realmId: "local-onboarding",
        providerSubject,
        subject: providerSubject,
        authenticationMethod,
        emailSnapshot: invitation.invitedEmailSnapshot,
        linkedAt: timestamp,
        createdAt: timestamp,
        lastSeenAt: timestamp,
        lastSuccessfulAuthenticationAt: timestamp,
        disabledAt: null,
        invitationId: invitation.id,
        version: 1
      };
      externalIdentities.push(identity);
    }
    invitation.status = "Accepted";
    invitation.acceptedAt = timestamp;
    invitation.version += 1;
    invitation.history.push({
      status: "Accepted",
      action: "invitation_accepted",
      actorUserId: actor.id,
      createdAt: timestamp,
      resendGeneration: invitation.resendGeneration
    });
    const previousStatus = user.status;
    updateUser(user, {
      status: "Active",
      activatedAt: timestamp,
      lastSuccessfulSignInAt: null
    }, actor.id);
    addAudit(req, "invitation_accepted", "Invitation accepted", activeSessionId(req), {
      targetUserId: user.id,
      invitationId: invitation.id,
      identityId: identity.id,
      authenticationPolicy: invitation.intendedAuthenticationPolicy,
      authenticationMethod,
      resendGeneration: invitation.resendGeneration
    }, "userInvitation", invitation.id);
    addAudit(req, "local_identity_linked", "Local identity linked", activeSessionId(req), {
      targetUserId: user.id,
      identityId: identity.id,
      invitationId: invitation.id,
      providerType: identity.providerType,
      authenticationPolicy: invitation.intendedAuthenticationPolicy,
      authenticationMethod
    }, "userIdentity", identity.id);
    addAudit(req, "account_activated_through_invitation", "User account activated through invitation", activeSessionId(req), {
      targetUserId: user.id,
      invitationId: invitation.id,
      identityId: identity.id,
      previousStatus,
      nextStatus: user.status,
      authenticationPolicy: invitation.intendedAuthenticationPolicy
    }, "userAccount", user.id);
    notifyAccessChange(user.id, "Onboarding completed", "Your account is active.", invitation.id);
    res.json(invitationResponse(invitation));
  });

  router.get("/admin/organizations", requirePermission("admin:manage"), (_req, res) => res.json({ data: organizations }));
  router.post("/admin/organizations", requirePermission("admin:manage"), (req, res) => {
    const row = {
      id: `org-demo-${Date.now()}`,
      key: String(req.body?.key ?? `org-${organizations.length + 1}`),
      name: String(req.body?.name ?? "New organization"),
      type: req.body?.type ? String(req.body.type) : "",
      status: req.body?.status ? String(req.body.status) : "active",
      contactEmail: req.body?.contactEmail ? String(req.body.contactEmail) : "",
      description: req.body?.description ? String(req.body.description) : "",
      createdAt: now(),
      updatedAt: now()
    };
    organizations.push(row);
    addAudit(req, "organization_change", `Organization ${row.name} created`);
    res.status(201).json(row);
  });
  router.patch("/admin/organizations/:id", requirePermission("admin:manage"), (req, res) => {
    const organization = organizations.find((item) => item.id === req.params.id);
    if (!organization) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    Object.assign(organization, {
      key: req.body?.key === undefined ? organization.key : String(req.body.key),
      name: req.body?.name === undefined ? organization.name : String(req.body.name),
      type: req.body?.type === undefined ? organization.type : String(req.body.type ?? ""),
      status: req.body?.status === undefined ? organization.status : String(req.body.status),
      contactEmail: req.body?.contactEmail === undefined ? organization.contactEmail : String(req.body.contactEmail ?? ""),
      description: req.body?.description === undefined ? organization.description : String(req.body.description ?? ""),
      updatedAt: now()
    });
    addAudit(req, "organization_change", `Organization ${organization.name} updated`);
    res.json(organization);
  });
  router.get("/admin/roles", requirePermission("admin:manage"), (_req, res) => res.json({ data: roles.map(roleResponse) }));
  router.get("/admin/roles/:roleId", requirePermission("admin:manage"), (req, res) => {
    const roleId = String(req.params.roleId ?? "");
    const role = roles.find((item) => item.id === roleId || canonicalRoleName(item.name) === canonicalRoleName(roleId));
    if (!role) {
      res.status(404).json({ error: "Role not found" });
      return;
    }
    res.json(roleResponse(role));
  });
  router.post("/admin/roles", requirePermission("admin:manage"), (req, res) => {
    const displayName = String(req.body?.displayName ?? "").trim();
    const name = canonicalRoleName(String(req.body?.name ?? displayName));
    const permissionList = Array.isArray(req.body?.permissions) ? req.body.permissions.map(String) as Permission[] : [];
    if (!displayName || !name) {
      res.status(400).json({ error: "Role name is required." });
      return;
    }
    if (roleDefinition(name)) {
      res.status(409).json({ error: "A role with this name already exists." });
      return;
    }
    if (permissionList.some((permission) => !(permission in permissions))) {
      res.status(400).json({ error: "Capabilities must be selected from the existing catalogue." });
      return;
    }
    if (permissionList.includes("admin:manage")) {
      res.status(403).json({ error: "Custom roles cannot create a new administrative safeguard path." });
      return;
    }
    const role: DemoRoleDefinition = {
      id: `role-${name}`,
      name,
      displayName,
      description: String(req.body?.description ?? "").trim(),
      permissions: Array.from(new Set(permissionList)),
      scopeTypes: ["GLOBAL"],
      pool: "ALL",
      protected: false,
      custom: true,
      operationalRole: false,
      status: "Active",
      createdAt: now(),
      updatedAt: now(),
      version: 1
    };
    roles.push(role);
    addAudit(req, "custom_role_created", "Custom role created", activeSessionId(req), { roleId: role.id, permissions: role.permissions }, "role", role.id);
    res.status(201).json(roleResponse(role));
  });
  router.patch("/admin/roles/:roleId", requirePermission("admin:manage"), (req, res) => {
    const roleId = String(req.params.roleId ?? "");
    const role = roles.find((item) => item.id === roleId || canonicalRoleName(item.name) === canonicalRoleName(roleId));
    if (!role) {
      res.status(404).json({ error: "Role not found" });
      return;
    }
    if (role.protected && (req.body?.name !== undefined || req.body?.permissions !== undefined)) {
      res.status(409).json({ error: "Protected role identifiers and capabilities cannot be edited here." });
      return;
    }
    const stale = assertVersion(role.version, req.body?.expectedVersion);
    if (stale) {
      res.status(409).json({ error: stale });
      return;
    }
    const previousPermissions = [...role.permissions];
    if (!role.protected) {
      const permissionList = Array.isArray(req.body?.permissions) ? req.body.permissions.map(String) as Permission[] : role.permissions;
      if (permissionList.some((permission) => !(permission in permissions))) {
        res.status(400).json({ error: "Capabilities must be selected from the existing catalogue." });
        return;
      }
      if (permissionList.includes("admin:manage")) {
        res.status(403).json({ error: "Custom roles cannot create a new administrative safeguard path." });
        return;
      }
      role.permissions = Array.from(new Set(permissionList));
      role.displayName = String(req.body?.displayName ?? role.displayName).trim() || role.displayName;
      role.description = String(req.body?.description ?? role.description ?? "").trim();
    } else {
      role.description = String(req.body?.description ?? role.description ?? "").trim();
    }
    role.updatedAt = now();
    role.version += 1;
    const nextPermissions = [...role.permissions];
    const previousSet = new Set(previousPermissions);
    const nextSet = new Set(nextPermissions);
    const addedPermissions = nextPermissions.filter((permission) => !previousSet.has(permission));
    const removedPermissions = previousPermissions.filter((permission) => !nextSet.has(permission));
    addAudit(req, "custom_role_changed", role.protected ? "Role description updated" : "Custom role updated", activeSessionId(req), { roleId: role.id, previousPermissions, nextPermissions, addedPermissions, removedPermissions }, "role", role.id);
    for (const permission of addedPermissions) {
      addAudit(req, "role_capability_added", "Role capability added", activeSessionId(req), { roleId: role.id, permission }, "role", role.id);
    }
    for (const permission of removedPermissions) {
      addAudit(req, "role_capability_removed", "Role capability removed", activeSessionId(req), { roleId: role.id, permission }, "role", role.id);
    }
    res.json(roleResponse(role));
  });
  router.post("/admin/roles/:roleId/archive", requirePermission("admin:manage"), (req, res) => {
    const roleId = String(req.params.roleId ?? "");
    const role = roles.find((item) => item.id === roleId || canonicalRoleName(item.name) === canonicalRoleName(roleId));
    if (!role) {
      res.status(404).json({ error: "Role not found" });
      return;
    }
    if (role.protected) {
      res.status(409).json({ error: "Protected roles cannot be archived." });
      return;
    }
    role.status = "Archived";
    role.archivedAt = now();
    role.updatedAt = now();
    role.version += 1;
    addAudit(req, "custom_role_archived", "Custom role archived", activeSessionId(req), { roleId: role.id }, "role", role.id);
    res.json(roleResponse(role));
  });
  router.get("/admin/capabilities", requirePermission("admin:manage"), (_req, res) => res.json({ data: capabilityRows() }));
  router.get("/admin/dictionaries", requirePermission("admin:manage"), (_req, res) => res.json({ data: Object.values(dictionaryRows()).flat() }));
  router.post("/admin/dictionaries", requirePermission("admin:manage"), (req, res) => res.status(201).json({ id: `dict-demo-${Date.now()}`, ...req.body }));

  return router;
}
