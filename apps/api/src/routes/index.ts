import fs from "node:fs/promises";
import type { Express, Request, Response } from "express";
import { Router } from "express";
import swaggerUi from "swagger-ui-express";
import type { Prisma } from "@prisma/client";
import { defaultProfile, normalizeRoleName, workflowStates } from "@zpp/shared";
import { config } from "../config.js";
import { createDemoRouter } from "../demo-router.js";
import { prisma } from "../prisma.js";
import { authenticate } from "../auth.js";
import { addTimelineEvent, logAudit } from "../audit.js";
import { asyncHandler, HttpError } from "../errors.js";
import { nextOperationalId, nextSessionId, withOperationalIdRetry } from "../ids.js";
import { redactForUser } from "../redaction.js";
import { hasRole, requirePermission } from "../rbac.js";
import {
  assignmentAssignSchema,
  assignmentReassignSchema,
  assignmentSchema,
  assignmentStatusUpdateSchema,
  decisionSchema,
  exerciseInjectSchema,
  exerciseObservationSchema,
  familySchema,
  idParam,
  listQuery,
  matchingSchema,
  operationalNoteSchema,
  releaseSchema,
  releaseDecisionSchema,
  requestSchema,
  requestStatusUpdateSchema,
  sessionCloseSchema,
  sessionSchema,
  timelineSchema
} from "../validation.js";
import { normalizeRow, parseWorkbook, pdfSummaryBuffer, workbookBuffer } from "../exporters.js";
import { resolveStorageKey, storageKeyForFile, upload } from "../storage.js";
import { openApiDocument } from "../openapi.js";
import { getNotificationForUser, listNotificationsForUser, markNotificationReadForUser, markNotificationsReadForUser, markNotificationUnreadForUser, notificationCountsForUser } from "../notifications.js";
import { createPrismaIncidentRepository } from "../modules/incidents/prisma-incident-repository.js";
import type { IncidentRepository } from "../modules/incidents/incident-repository.js";
import { createPrismaEnquiryRepository } from "../modules/enquiries/prisma-enquiry-repository.js";
import type { EnquiryRepository } from "../modules/enquiries/enquiry-repository.js";
import { createPrismaIncidentAccessRepository } from "../modules/incident-access/prisma-incident-access-repository.js";
import type { IncidentAccessRepository } from "../modules/incident-access/incident-access-repository.js";
import { createPrismaIncidentAssignmentRepository } from "../modules/incident-assignments/prisma-incident-assignment-repository.js";
import type { IncidentAssignmentRepository } from "../modules/incident-assignments/incident-assignment-repository.js";
import { createPrismaPassengerRepository } from "../modules/passengers/prisma-passenger-repository.js";
import type { PassengerRepository } from "../modules/passengers/passenger-repository.js";

type Delegate = {
  count(args: unknown): Promise<number>;
  findMany(args: unknown): Promise<unknown[]>;
};

const api = Router();

type DashboardPassenger = {
  id: string;
  personType: string;
  source: string;
  conditionStatus: string;
  holdStatus: string;
  srcConfirmed: boolean;
  caseId: string | null;
  dateOfBirth: Date | null;
  age: number | null;
  seat: string | null;
  manifestVersion: string | null;
};

type DashboardMatch = {
  id: string;
  enquiryId: string | null;
  passengerRecordId: string | null;
  familyRecordId: string | null;
  status: string;
  holdCheck: string;
};

type DashboardFamily = {
  id: string;
  verificationStatus: string;
  caseId: string | null;
  phone: string | null;
  email: string | null;
};

type DashboardEnquiry = {
  id: string;
  status: string;
  urgency: string;
  passengerRecordId: string | null;
};

const completedMatchStatuses = new Set<string>(workflowStates.completedMatchStatuses);
const pendingMatchStatuses = new Set<string>(workflowStates.pendingMatchStatuses);
const terminalRequestStatuses = new Set<string>(workflowStates.terminalRequestStatuses);
const terminalReleaseStatuses = new Set<string>(workflowStates.terminalReleaseStatuses);
const terminalRequestStatusList = Array.from(terminalRequestStatuses);

function isNoHold(value?: string | null) {
  return !value || value === "No hold";
}

function matchHasActiveHold(match: DashboardMatch) {
  return !isNoHold(match.holdCheck) || match.status === "Hold / escalate";
}

function buildDashboardAggregates({
  passengers,
  matches,
  families,
  enquiries,
  releases,
  importBatches,
  openRequests,
  urgentWelfare
}: {
  passengers: DashboardPassenger[];
  matches: DashboardMatch[];
  families: DashboardFamily[];
  enquiries: DashboardEnquiry[];
  releases: Array<{ status: string; matchId: string | null; passengerRecordId: string | null; identityChecked: boolean; holdCleared: boolean }>;
  importBatches: Array<{ importType: string; totalRecords: number; validRecords: number; invalidRecords: number }>;
  openRequests: number;
  urgentWelfare: number;
}) {
  const matchesByPassenger = new Map<string, DashboardMatch[]>();
  const enquiriesByPassenger = new Map<string, DashboardEnquiry[]>();
  for (const match of matches) {
    if (!match.passengerRecordId) continue;
    const current = matchesByPassenger.get(match.passengerRecordId) ?? [];
    current.push(match);
    matchesByPassenger.set(match.passengerRecordId, current);
  }
  for (const enquiry of enquiries) {
    if (!enquiry.passengerRecordId) continue;
    const current = enquiriesByPassenger.get(enquiry.passengerRecordId) ?? [];
    current.push(enquiry);
    enquiriesByPassenger.set(enquiry.passengerRecordId, current);
  }

  const matchingProgress = {
    totalPax: passengers.length,
    done: 0,
    inReview: 0,
    onHold: 0,
    noCandidate: 0,
    rejectedOnly: 0,
    completionRate: 0,
    slices: [] as Array<{ key: string; label: string; value: number; tone: string; color: string }>
  };

  let reviewedTotal = 0;
  let readyForRelease = 0;
  for (const passenger of passengers) {
    const passengerMatches = matchesByPassenger.get(passenger.id) ?? [];
    const passengerEnquiries = enquiriesByPassenger.get(passenger.id) ?? [];
    const hasAnyWork = passenger.srcConfirmed || passengerMatches.length > 0 || passengerEnquiries.length > 0;
    if (hasAnyWork) reviewedTotal += 1;

    const hasHold = !isNoHold(passenger.holdStatus) || passengerMatches.some(matchHasActiveHold);
    const hasCompleted = passengerMatches.some((match) => completedMatchStatuses.has(match.status) && !matchHasActiveHold(match));
    const hasPending = passengerMatches.some((match) => pendingMatchStatuses.has(match.status));
    const hasRejectedOnly = passengerMatches.length > 0 && passengerMatches.every((match) => match.status === "Rejected");
    const hasReadyMatch = passengerMatches.some((match) => match.status === "Verified match" && !matchHasActiveHold(match));

    if (hasReadyMatch) readyForRelease += 1;

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

  const manifestImport = importBatches.find((batch) => ["manifest", "passenger"].includes(batch.importType));
  const expectedTotal = manifestImport?.totalRecords ?? passengers.length;
  const invalidTotal = manifestImport?.invalidRecords ?? 0;
  const passengerTypeCount = passengers.filter((passenger) => passenger.personType === "Passenger").length;
  const crewTypeCount = passengers.filter((passenger) => passenger.personType === "Crew").length;
  const unknownTypeCount = Math.max(0, passengers.length - passengerTypeCount - crewTypeCount);
  const notLoadedTotal = Math.max(0, expectedTotal - passengers.length);

  const manifestCoverage = {
    expectedTotal,
    inDatabaseTotal: passengers.length,
    notLoadedTotal,
    invalidTotal,
    reviewedTotal,
    notReviewedTotal: Math.max(0, passengers.length - reviewedTotal),
    passengersInDatabase: passengerTypeCount,
    crewInDatabase: crewTypeCount,
    unknownTypeInDatabase: unknownTypeCount,
    sourceBreakdown: Object.entries(
      passengers.reduce<Record<string, number>>((acc, passenger) => {
        const key = passenger.source || "Unknown";
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {})
    ).map(([label, value]) => ({ label, value }))
  };

  const linkedFamilyIds = new Set(matches.map((match) => match.familyRecordId).filter((id): id is string => Boolean(id)));
  const workRemaining = {
    noCandidate: matchingProgress.noCandidate,
    pendingMatch: matchingProgress.inReview,
    activeHold: matchingProgress.onHold,
    readyForRelease,
    urgentWelfare,
    openRequests,
    unverifiedFamily: families.filter((family) => family.verificationStatus !== "Verified").length,
    unlinkedFamily: families.filter((family) => !linkedFamilyIds.has(family.id)).length,
    unlinkedEnquiries: enquiries.filter(
      (enquiry) =>
        !terminalRequestStatuses.has(enquiry.status) &&
        !matches.some((match) => match.enquiryId === enquiry.id || (match.passengerRecordId && enquiry.passengerRecordId === match.passengerRecordId))
    ).length
  };

  const dataQuality = {
    missingCaseId: passengers.filter((passenger) => !passenger.caseId).length + families.filter((family) => !family.caseId).length + enquiries.filter((enquiry) => !enquiry.passengerRecordId).length,
    missingDobOrAge: passengers.filter((passenger) => !passenger.dateOfBirth && !passenger.age).length,
    missingSeat: passengers.filter((passenger) => passenger.personType === "Passenger" && !passenger.seat).length,
    srcPending: passengers.filter((passenger) => !passenger.srcConfirmed).length,
    unknownCondition: passengers.filter((passenger) => !passenger.conditionStatus || passenger.conditionStatus === "Unknown").length,
    familyContactMissing: families.filter((family) => !family.phone && !family.email).length,
    openReleaseActions: releases.filter((release) => !terminalReleaseStatuses.has(release.status)).length,
    releaseChecklistPending: releases.filter((release) => !release.identityChecked || !release.holdCleared).length
  };

  return { manifestCoverage, matchingProgress, workRemaining, dataQuality };
}

function actorId(req: Request) {
  return req.user?.id;
}

function clean<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => clean(item)) as T;
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = item === "" ? null : clean(item);
  }
  return output as T;
}

function sendRedacted(req: Request, res: Response, value: unknown, status = 200) {
  res.status(status).json(redactForUser(req, value));
}

function actorSummary(user?: { id: string; email: string; displayName: string | null; roles?: Array<{ role: { name: string; displayName: string } }> } | null) {
  return user ? {
    id: user.id,
    userId: user.id,
    email: user.email,
    displayName: user.displayName ?? user.email,
    roles: user.roles?.map((item) => item.role.displayName || item.role.name) ?? []
  } : null;
}

function assignmentManager(req: Request) {
  return hasRole(req, "zpp-coordinator") || hasRole(req, "tec-coordinator") || hasRole(req, "zpp-group-leader") || hasRole(req, "tec-group-leader");
}

function rolePermissions(role: { name: string; permissions: Prisma.JsonValue }) {
  return Array.isArray(role.permissions) ? role.permissions.map(String) : [];
}

function userCanReceiveAssignments(user: { status?: string | null; roles: Array<{ role: { name: string; permissions: Prisma.JsonValue } }> }) {
  if (user.status && user.status !== "active") return false;
  return user.roles.some((item) => rolePermissions(item.role).includes("assignment:read"));
}

function assignmentUserSummary(user?: { id: string; email: string; displayName: string | null; roles?: Array<{ role: { name: string; displayName: string } }> } | null) {
  return user
    ? {
        id: user.id,
        userId: user.id,
        email: user.email,
        displayName: user.displayName ?? user.email,
        roles: user.roles?.map((item) => item.role.name) ?? [],
        roleLabels: user.roles?.map((item) => item.role.displayName || item.role.name) ?? []
      }
    : null;
}

function assignmentResponse(record: Record<string, unknown>) {
  const assignedUser = assignmentUserSummary(record.assignedUser as Parameters<typeof assignmentUserSummary>[0]);
  const displayName = String(record.assignedUserDisplayName ?? assignedUser?.displayName ?? record.ownerAssignedTo ?? "").trim();
  const legacyText = !record.assignedUserId && record.ownerAssignedTo ? String(record.ownerAssignedTo) : "";
  return {
    ...record,
    assignedUser,
    assignedUserId: record.assignedUserId ?? assignedUser?.id ?? null,
    assignedUserDisplayName: displayName || null,
    ownerAssignedTo: displayName || null,
    legacyAssignee: legacyText ? { displayName: legacyText, label: `Legacy/unresolved assignee: ${legacyText}` } : null
  };
}

async function listAssignmentAssignees() {
  const users = await prisma.user.findMany({
    where: { status: "active" },
    orderBy: { displayName: "asc" },
    include: { roles: { include: { role: true } } }
  });
  return users.filter(userCanReceiveAssignments).map((user) => assignmentUserSummary(user)!);
}

async function findAssignmentAssignee(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { roles: { include: { role: true } } }
  });
  if (!user || !userCanReceiveAssignments(user)) throw new HttpError(404, "Assignee not found");
  return user;
}

async function attachActorMetadata(records: unknown[]) {
  const rows = records as Array<Record<string, unknown>>;
  const actorIds = Array.from(
    new Set(
      rows
        .flatMap((row) => [row.createdById, row.updatedById])
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    )
  );
  if (!actorIds.length) return rows;

  const users = await prisma.user.findMany({
    where: { id: { in: actorIds } },
    select: { id: true, email: true, displayName: true, roles: { include: { role: true } } }
  });
  const usersById = new Map(users.map((user) => [user.id, user]));
  return rows.map((row) => ({
    ...row,
    createdBy: actorSummary(usersById.get(String(row.createdById ?? ""))),
    updatedBy: actorSummary(usersById.get(String(row.updatedById ?? "")))
  }));
}

async function activeSessionId() {
  const session = await prisma.session.findFirst({
    where: { status: "Active" },
    orderBy: { createdAt: "desc" }
  });
  return session?.id;
}

async function listRecords(
  req: Request,
  res: Response,
  delegate: Delegate,
  searchFields: string[],
  baseWhere: Record<string, unknown> = {}
) {
  const query = listQuery.parse(req.query);
  const where: Record<string, unknown> = { ...baseWhere };
  if (query.sessionId) where.sessionId = query.sessionId;
  if (query.status) where.status = query.status;
  if (query.search) {
    where.OR = searchFields.map((field) => ({
      [field]: { contains: query.search, mode: "insensitive" }
    }));
  }
  const [total, records] = await Promise.all([
    delegate.count({ where }),
    delegate.findMany({ where, take: query.limit, skip: query.offset, orderBy: { updatedAt: "desc" } })
  ]);
  const data = await attachActorMetadata(records);
  sendRedacted(req, res, { total, data });
}

function requireDecisionBasis(body: unknown) {
  const parsed = decisionSchema.parse(body);
  return parsed;
}

async function assertActiveRealSessionRule(mode: string, status: string, excludingId?: string) {
  if (mode !== "REAL" || status !== "Active") return;
  const existing = await prisma.session.findFirst({
    where: {
      mode: "REAL",
      status: "Active",
      id: excludingId ? { not: excludingId } : undefined
    }
  });
  if (existing) {
    throw new HttpError(409, "Only one active REAL session is supported by default");
  }
}

async function sessionModeLabel(sessionId?: string | null) {
  if (!sessionId) return undefined;
  const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { mode: true, operationalId: true } });
  return session ? `${session.mode} ${session.operationalId}` : undefined;
}

async function ensureVerifiedMatchForRelease(req: Request, matchId?: string | null, coordinatorOverride?: boolean, overrideReason?: string, expectedSessionId?: string) {
  const canOverrideRelease = Boolean(coordinatorOverride && overrideReason && req.user?.permissions.includes("matching:release"));
  if (!matchId) {
    if (canOverrideRelease) return undefined;
    throw new HttpError(400, "Release requires a verified match or Coordinator-approved exception");
  }

  const match = await prisma.matchingRecord.findUnique({ where: { id: matchId } });
  if (!match) throw new HttpError(404, "Matching record not found");
  if (expectedSessionId && match.sessionId !== expectedSessionId) throw new HttpError(409, "Matching record belongs to a different session");

  if (match.status !== "Verified match" && match.status !== "Reunited" && match.status !== "Released") {
    if (!canOverrideRelease) {
      throw new HttpError(409, "Reunification/release requires a verified match or Coordinator-approved exception");
    }
  }

  if (match.holdCheck && match.holdCheck !== "No hold") {
    if (!canOverrideRelease) {
      throw new HttpError(409, "Hold blocks reunification/release until cleared or Coordinator override is recorded");
    }
  }

  return match;
}

type MatchingLinkInput = {
  sessionId: string;
  enquiryId?: string | null;
  familyRecordId?: string | null;
  passengerRecordId?: string | null;
};

async function validateMatchingLinks(input: MatchingLinkInput, excludeMatchId?: string) {
  if (!input.familyRecordId || !input.passengerRecordId) {
    throw new HttpError(400, "A Family/NOK record and Passenger/SRC record are required");
  }
  const [family, passenger, enquiry] = await Promise.all([
    prisma.familyRecord.findUnique({ where: { id: input.familyRecordId } }),
    prisma.passengerRecord.findUnique({ where: { id: input.passengerRecordId } }),
    input.enquiryId ? prisma.enquiry.findUnique({ where: { id: input.enquiryId } }) : Promise.resolve(null)
  ]);
  if (!family) throw new HttpError(404, "Family/NOK record not found");
  if (!passenger) throw new HttpError(404, "Passenger/SRC record not found");
  if (input.enquiryId && !enquiry) throw new HttpError(404, "TEC enquiry not found");
  if (family.sessionId !== input.sessionId || passenger.sessionId !== input.sessionId || (enquiry && enquiry.sessionId !== input.sessionId)) {
    throw new HttpError(409, "Matching links must belong to the active session");
  }
  if (family.caseId && passenger.caseId && family.caseId !== passenger.caseId) {
    throw new HttpError(409, "Family/NOK and Passenger/SRC records belong to different cases");
  }
  const duplicate = await prisma.matchingRecord.findFirst({
    where: {
      id: excludeMatchId ? { not: excludeMatchId } : undefined,
      sessionId: input.sessionId,
      familyRecordId: input.familyRecordId,
      passengerRecordId: input.passengerRecordId,
      status: { not: "Rejected" }
    }
  });
  if (duplicate) throw new HttpError(409, `An open matching record already links these records (${duplicate.operationalId})`);
  return { family, passenger, enquiry };
}

function responseFile(res: Response, filename: string, mime: string, buffer: Buffer) {
  res.setHeader("content-type", mime);
  res.setHeader("content-disposition", `attachment; filename="${filename}"`);
  res.send(buffer);
}

function assertCsvFile(fileName: string) {
  if (!fileName.toLowerCase().endsWith(".csv")) {
    throw new HttpError(400, "Only CSV imports are supported");
  }
}

api.get("/health", (_req, res) => {
  res.json({ ok: true, service: "zpp-connect-api" });
});

api.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));
api.use(authenticate);

api.get(
  "/auth/me",
  asyncHandler(async (req, res) => {
    await logAudit(req, {
      action: "login",
      summary: `${req.user?.email} accessed ZPP Connect`
    });
    res.json({ user: req.user });
  })
);

api.get(
  "/config/profile",
  requirePermission("session:read"),
  asyncHandler(async (_req, res) => {
    const rows = await prisma.dictionary.findMany({
      where: { profile: defaultProfile.id, category: "profile", isActive: true },
      orderBy: { sortOrder: "asc" }
    });
    const overrides = Object.fromEntries(rows.map((row) => [row.key, row.label]));
    res.json({
      ...defaultProfile,
      ...overrides
    });
  })
);

api.get(
  "/dictionaries",
  requirePermission("session:read"),
  asyncHandler(async (req, res) => {
    const profile = String(req.query.profile ?? defaultProfile.id);
    const rows = await prisma.dictionary.findMany({
      where: { profile, isActive: true },
      orderBy: [{ category: "asc" }, { sortOrder: "asc" }, { label: "asc" }]
    });
    const grouped: Record<string, typeof rows> = {};
    for (const row of rows) {
      grouped[row.category] ??= [];
      grouped[row.category]!.push(row);
    }
    res.json(grouped);
  })
);

api.get(
  "/notifications",
  requirePermission("session:read"),
  asyncHandler(async (req, res) => {
    res.json(listNotificationsForUser(req.user, req.query));
  })
);

api.get(
  "/notifications/counts",
  requirePermission("session:read"),
  asyncHandler(async (req, res) => {
    res.json(notificationCountsForUser(req.user));
  })
);

api.get(
  "/notifications/:id",
  requirePermission("session:read"),
  asyncHandler(async (req, res) => {
    const notification = getNotificationForUser(req.user, String(req.params.id));
    if (!notification) throw new HttpError(404, "Notification not found");
    res.json(notification);
  })
);

api.post(
  "/notifications/read-all",
  requirePermission("session:read"),
  asyncHandler(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : undefined;
    res.json(markNotificationsReadForUser(req.user, ids));
  })
);

api.post(
  "/notifications/:id/read",
  requirePermission("session:read"),
  asyncHandler(async (req, res) => {
    const notification = markNotificationReadForUser(req.user, String(req.params.id));
    if (!notification) throw new HttpError(404, "Notification not found");
    res.json(notification);
  })
);

api.post(
  "/notifications/:id/unread",
  requirePermission("session:read"),
  asyncHandler(async (req, res) => {
    const notification = markNotificationUnreadForUser(req.user, String(req.params.id));
    if (!notification) throw new HttpError(404, "Notification not found");
    res.json(notification);
  })
);

api.get(
  "/dashboard",
  requirePermission("session:read"),
  asyncHandler(async (req, res) => {
    const sessionId = String(req.query.sessionId ?? (await activeSessionId()) ?? "");
    if (!sessionId) throw new HttpError(404, "No active session found");
    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    if (!session) throw new HttpError(404, "Session not found");

    const permissions = new Set<string>(req.user?.permissions ?? []);
    const canReadEnquiries = permissions.has("enquiry:read");
    const canReadFamily = permissions.has("family:read");
    const canReadPassengers = permissions.has("passenger:read");
    const canReadMatching = permissions.has("matching:read");
    const canReadRequests = permissions.has("request:read");
    const canReadRelease = permissions.has("release:read");
    const canReadImport = permissions.has("import:create");
    const canReadLinkedContext = canReadEnquiries && canReadFamily && canReadPassengers;
    const canReadAllAggregates = canReadLinkedContext && canReadMatching && canReadRequests && canReadRelease && canReadImport;

    const [enquiries, urgentWelfare] = canReadEnquiries
      ? await Promise.all([
          prisma.enquiry.count({ where: { sessionId } }),
          prisma.enquiry.count({ where: { sessionId, urgency: "Urgent welfare" } })
        ])
      : [undefined, undefined];
    const familyRecords = canReadFamily ? await prisma.familyRecord.count({ where: { sessionId } }) : undefined;
    const passengerRecords = canReadPassengers ? await prisma.passengerRecord.count({ where: { sessionId } }) : undefined;
    const [matchingRecords, holds, verified, matchingStatus] = canReadMatching
      ? await Promise.all([
          prisma.matchingRecord.count({ where: { sessionId } }),
          prisma.matchingRecord.count({ where: { sessionId, holdCheck: { not: "No hold" } } }),
          prisma.matchingRecord.count({ where: { sessionId, status: { in: ["Verified match", "Reunited", "Released"] } } }),
          prisma.matchingRecord.groupBy({ by: ["status"], where: { sessionId }, _count: true })
        ])
      : [undefined, undefined, undefined, []];
    const [openRequests, requestStatus] = canReadRequests
      ? await Promise.all([
          prisma.welfareRequest.count({ where: { sessionId, status: { notIn: terminalRequestStatusList } } }),
          prisma.welfareRequest.groupBy({ by: ["status"], where: { sessionId }, _count: true })
        ])
      : [undefined, []];

    type DashboardQueueRecord = Record<string, any>;
    const displayName = (firstName?: unknown, lastName?: unknown) => [lastName, firstName].filter(Boolean).map(String).join(", ");
    const flattenMatchingContext = (row: DashboardQueueRecord) => {
      const { familyRecord, passengerRecord, enquiry, ...rest } = row;
      return {
        ...rest,
        familyOperationalId: familyRecord?.operationalId ?? null,
        familyName: displayName(familyRecord?.firstName, familyRecord?.lastName),
        passengerOperationalId: passengerRecord?.operationalId ?? null,
        passengerName: displayName(passengerRecord?.firstName, passengerRecord?.lastName),
        passengerType: passengerRecord?.personType ?? null,
        enquiryOperationalId: enquiry?.operationalId ?? null,
        enquiryCallerName: enquiry?.callerName ?? null,
        claimedRelationship: familyRecord?.claimedRelationship ?? enquiry?.claimedRelationship ?? null
      };
    };
    const flattenRequestContext = (row: DashboardQueueRecord) => {
      const { relatedFamilyRecord, relatedPassengerRecord, relatedEnquiry, ...rest } = row;
      return {
        ...rest,
        familyOperationalId: relatedFamilyRecord?.operationalId ?? null,
        familyName: displayName(relatedFamilyRecord?.firstName, relatedFamilyRecord?.lastName),
        passengerOperationalId: relatedPassengerRecord?.operationalId ?? null,
        passengerName: displayName(relatedPassengerRecord?.firstName, relatedPassengerRecord?.lastName),
        enquiryOperationalId: relatedEnquiry?.operationalId ?? null,
        enquiryCallerName: relatedEnquiry?.callerName ?? null
      };
    };
    const flattenFamilyContext = (row: DashboardQueueRecord) => ({
      ...row,
      familyName: displayName(row.firstName, row.lastName),
      passengerName: displayName(row.passengerFirstName, row.passengerLastName)
    });
    const flattenEnquiryContext = (row: DashboardQueueRecord) => ({
      ...row,
      enquiryCallerName: row.callerName ?? null,
      passengerName: displayName(row.passengerFirstName, row.passengerLastName)
    });

    const urgentRequests = canReadRequests ? await prisma.welfareRequest.findMany({
        where: { sessionId, priority: "Urgent", status: { notIn: terminalRequestStatusList } },
        ...(canReadLinkedContext ? { include: { relatedEnquiry: true, relatedFamilyRecord: true, relatedPassengerRecord: true } } : {}),
        take: 5,
        orderBy: { updatedAt: "desc" }
      }) : [];
    const unresolvedHolds = canReadMatching ? await prisma.matchingRecord.findMany({
        where: { sessionId, holdCheck: { not: "No hold" } },
        ...(canReadLinkedContext ? { include: { enquiry: true, familyRecord: true, passengerRecord: true } } : {}),
        take: 5,
        orderBy: { updatedAt: "desc" }
      }) : [];
    const pendingMatching = canReadMatching ? await prisma.matchingRecord.findMany({
        where: { sessionId, status: { in: ["Suggested", "Potential match"] } },
        ...(canReadLinkedContext ? { include: { enquiry: true, familyRecord: true, passengerRecord: true } } : {}),
        take: 5,
        orderBy: { updatedAt: "desc" }
      }) : [];
    const unverifiedFamily = canReadFamily ? await prisma.familyRecord.findMany({
        where: { sessionId, verificationStatus: { not: "Verified" } },
        take: 5,
        orderBy: { updatedAt: "desc" }
      }) : [];
    const unlinkedEnquiries = canReadEnquiries ? await prisma.enquiry.findMany({
        where: { sessionId, matches: { none: {} }, status: { not: "Closed" } },
        take: 5,
        orderBy: { updatedAt: "desc" }
      }) : [];

    let aggregates: ReturnType<typeof buildDashboardAggregates> | Record<string, never> = {};
    if (canReadAllAggregates) {
      const [dashboardPassengers, dashboardMatches, dashboardFamilies, dashboardEnquiries, dashboardReleases, dashboardImports] = await Promise.all([
        prisma.passengerRecord.findMany({
          where: { sessionId },
          select: { id: true, personType: true, source: true, conditionStatus: true, holdStatus: true, srcConfirmed: true, caseId: true, dateOfBirth: true, age: true, seat: true, manifestVersion: true }
        }),
        prisma.matchingRecord.findMany({
          where: { sessionId },
          select: { id: true, enquiryId: true, passengerRecordId: true, familyRecordId: true, status: true, holdCheck: true }
        }),
        prisma.familyRecord.findMany({ where: { sessionId }, select: { id: true, verificationStatus: true, caseId: true, phone: true, email: true } }),
        prisma.enquiry.findMany({ where: { sessionId }, select: { id: true, status: true, urgency: true, passengerRecordId: true } }),
        prisma.reunificationReleaseRecord.findMany({ where: { sessionId }, select: { status: true, matchId: true, passengerRecordId: true, identityChecked: true, holdCleared: true } }),
        prisma.importBatch.findMany({
          where: { sessionId, importType: { in: ["manifest", "passenger"] } },
          select: { importType: true, totalRecords: true, validRecords: true, invalidRecords: true },
          orderBy: { createdAt: "desc" },
          take: 5
        })
      ]);
      aggregates = buildDashboardAggregates({
        passengers: dashboardPassengers,
        matches: dashboardMatches,
        families: dashboardFamilies,
        enquiries: dashboardEnquiries,
        releases: dashboardReleases,
        importBatches: dashboardImports,
        openRequests: openRequests ?? 0,
        urgentWelfare: urgentWelfare ?? 0
      });
    }

    const kpis: Record<string, number> = {};
    if (enquiries !== undefined) {
      kpis.enquiries = enquiries;
      kpis.urgentWelfare = urgentWelfare ?? 0;
    }
    if (familyRecords !== undefined) kpis.familyRecords = familyRecords;
    if (passengerRecords !== undefined) kpis.passengerRecords = passengerRecords;
    if (matchingRecords !== undefined) {
      kpis.matchingRecords = matchingRecords;
      kpis.holds = holds ?? 0;
      kpis.verifiedReunited = verified ?? 0;
    }
    if (openRequests !== undefined) kpis.openRequests = openRequests;

    sendRedacted(req, res, {
      session,
      sessionLabel: await sessionModeLabel(sessionId),
      kpis,
      priorityQueue: {
        ...(canReadRequests ? { urgentRequests: urgentRequests.map(flattenRequestContext) } : {}),
        ...(canReadMatching ? {
          unresolvedHolds: unresolvedHolds.map(flattenMatchingContext),
          pendingMatching: pendingMatching.map(flattenMatchingContext)
        } : {}),
        ...(canReadFamily ? { unverifiedFamily: unverifiedFamily.map(flattenFamilyContext) } : {}),
        ...(canReadEnquiries ? { unlinkedEnquiries: unlinkedEnquiries.map(flattenEnquiryContext) } : {})
      },
      status: {
        ...(canReadRequests ? { requests: Object.fromEntries(requestStatus.map((item) => [item.status, item._count])) } : {}),
        ...(canReadMatching ? { matching: Object.fromEntries(matchingStatus.map((item) => [item.status, item._count])) } : {})
      },
      ...aggregates
    });
  })
);

api.get(
  "/sessions",
  requirePermission("session:read"),
  asyncHandler(async (req, res) => {
    const query = listQuery.parse(req.query);
    const where: Record<string, unknown> = {};
    if (query.status) where.status = query.status;
    if (query.search) {
      where.OR = ["operationalId", "eventType", "flightNumber", "route", "airportLocation"].map((field) => ({
        [field]: { contains: query.search, mode: "insensitive" }
      }));
    }
    const [total, data] = await Promise.all([
      prisma.session.count({ where }),
      prisma.session.findMany({ where, take: query.limit, skip: query.offset, orderBy: { createdAt: "desc" } })
    ]);
    res.json({ total, data });
  })
);

api.post(
  "/sessions",
  requirePermission("session:create"),
  asyncHandler(async (req, res) => {
    const body = clean(sessionSchema.parse(req.body));
    await assertActiveRealSessionRule(body.mode, body.status);
    const record = await withOperationalIdRetry(async () => prisma.session.create({
      data: {
        ...body,
        operationalId: await nextSessionId(),
        createdById: actorId(req)
      }
    }));
    await logAudit(req, {
      action: "create_session",
      entityType: "session",
      entityId: record.id,
      sessionId: record.id,
      summary: `Session ${record.operationalId} created`
    });
    res.status(201).json(record);
  })
);

api.patch(
  "/sessions/:id",
  requirePermission("session:update"),
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const existing = await prisma.session.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Session not found");
    const body = clean(sessionSchema.partial().parse(req.body));
    await assertActiveRealSessionRule(String(body.mode ?? existing.mode), String(body.status ?? existing.status), id);
    const record = await prisma.session.update({ where: { id }, data: body });
    await logAudit(req, {
      action: "update_session",
      entityType: "session",
      entityId: id,
      sessionId: id,
      summary: `Session ${record.operationalId} updated`,
      metadata: body
    });
    res.json(record);
  })
);

api.post(
  "/sessions/:id/close",
  requirePermission("session:close"),
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const body = sessionCloseSchema.parse(req.body);
    const record = await prisma.session.update({
      where: { id },
      data: {
        status: "Closed",
        endAt: new Date(),
        closedById: actorId(req),
        notes: body.notes
      }
    });
    await logAudit(req, {
      action: "close_session",
      entityType: "session",
      entityId: id,
      sessionId: id,
      summary: `Session ${record.operationalId} closed`,
      metadata: { status: "Closed", closureNote: body.notes }
    });
    await addTimelineEvent({
      sessionId: id,
      eventType: "session",
      entityType: "session",
      entityId: id,
      title: `Session ${record.operationalId} closed`,
      body: body.notes,
      metadata: { status: "Closed" },
      createdById: actorId(req)
    });
    res.json(record);
  })
);

api.get(
  "/family-records",
  requirePermission("family:read"),
  asyncHandler((req, res) => listRecords(req, res, prisma.familyRecord, ["operationalId", "firstName", "lastName", "passengerFirstName", "passengerLastName", "passengerFlight"]))
);

api.post(
  "/family-records",
  requirePermission("family:create"),
  asyncHandler(async (req, res) => {
    const body = clean(familySchema.parse(req.body));
    const record = await withOperationalIdRetry(async () => prisma.familyRecord.create({
      data: { ...body, operationalId: await nextOperationalId("familyRecord", "FAM"), createdById: actorId(req), updatedById: actorId(req) }
    }));
    await logAudit(req, { action: "create_family_record", entityType: "familyRecord", entityId: record.id, sessionId: record.sessionId, summary: `Family/NOK record ${record.operationalId} created` });
    await addTimelineEvent({ sessionId: record.sessionId, caseId: record.caseId, eventType: "family_record", entityType: "familyRecord", entityId: record.id, title: `Family/NOK record ${record.operationalId} created`, createdById: actorId(req) });
    res.status(201).json(record);
  })
);

api.patch(
  "/family-records/:id",
  requirePermission("family:update"),
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const body = clean(familySchema.partial().parse(req.body));
    const record = await prisma.familyRecord.update({ where: { id }, data: { ...body, updatedById: actorId(req) } });
    await logAudit(req, { action: "update_family_record", entityType: "familyRecord", entityId: id, sessionId: record.sessionId, summary: `Family/NOK record ${record.operationalId} updated` });
    res.json(record);
  })
);

api.post(
  "/family-records/:id/verify",
  requirePermission("family:verify"),
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const verificationNotes = operationalNoteSchema.parse(req.body?.verificationNotes);
    const record = await prisma.familyRecord.update({
      where: { id },
      data: { verificationStatus: "Verified", verificationNotes, updatedById: actorId(req) }
    });
    await logAudit(req, { action: "verify_family_record", entityType: "familyRecord", entityId: id, sessionId: record.sessionId, summary: `Family/NOK record ${record.operationalId} verified`, metadata: { basis: verificationNotes } });
    await addTimelineEvent({ sessionId: record.sessionId, caseId: record.caseId, eventType: "verification", entityType: "familyRecord", entityId: id, title: "Family/NOK verification completed", body: verificationNotes, createdById: actorId(req) });
    res.json(record);
  })
);

api.post(
  "/family-records/:id/mark-disputed",
  requirePermission("family:update"),
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const record = await prisma.familyRecord.update({ where: { id }, data: { verificationStatus: "Disputed", verificationNotes: req.body?.verificationNotes, updatedById: actorId(req) } });
    await logAudit(req, { action: "mark_family_disputed", entityType: "familyRecord", entityId: id, sessionId: record.sessionId, summary: `Family/NOK record ${record.operationalId} marked disputed` });
    res.json(record);
  })
);

api.get(
  "/matching-records",
  requirePermission("matching:read"),
  asyncHandler(async (req, res) => {
    const query = listQuery.parse(req.query);
    const where: Record<string, unknown> = {};
    if (query.sessionId) where.sessionId = query.sessionId;
    if (query.status) where.status = query.status;
    if (query.search) where.OR = [{ operationalId: { contains: query.search, mode: "insensitive" } }, { caseId: { contains: query.search, mode: "insensitive" } }];
    const [total, data] = await Promise.all([
      prisma.matchingRecord.count({ where }),
      prisma.matchingRecord.findMany({
        where,
        take: query.limit,
        skip: query.offset,
        orderBy: { updatedAt: "desc" },
        include: { enquiry: true, familyRecord: true, passengerRecord: true }
      })
    ]);
    sendRedacted(req, res, { total, data });
  })
);

api.get(
  "/matching-records/suggestions",
  requirePermission("matching:read"),
  asyncHandler(async (req, res) => {
    const sessionId = String(req.query.sessionId ?? (await activeSessionId()) ?? "");
    const [enquiries, families, passengers] = await Promise.all([
      prisma.enquiry.findMany({ where: { sessionId, matches: { none: {} }, status: { not: "Closed" } }, take: 1000, orderBy: { updatedAt: "desc" } }),
      prisma.familyRecord.findMany({ where: { sessionId }, take: 1000, orderBy: { updatedAt: "desc" } }),
      prisma.passengerRecord.findMany({ where: { sessionId }, take: 1000, orderBy: { updatedAt: "desc" } })
    ]);
    const normalized = (value?: string | null) => String(value ?? "").trim().toLowerCase();
    const passengerByLastName = new Map<string, typeof passengers>();
    const passengerByFlight = new Map<string, typeof passengers>();
    const passengerByLastFlight = new Map<string, typeof passengers>();
    const addIndexed = (index: Map<string, typeof passengers>, key: string, passenger: (typeof passengers)[number]) => {
      if (!key) return;
      const list = index.get(key) ?? [];
      list.push(passenger);
      index.set(key, list);
    };
    for (const passenger of passengers) {
      addIndexed(passengerByLastName, normalized(passenger.lastName), passenger);
      addIndexed(passengerByFlight, normalized(passenger.flightNumber), passenger);
      addIndexed(passengerByLastFlight, `${normalized(passenger.lastName)}|${normalized(passenger.flightNumber)}`, passenger);
    }
    const familyByCaseId = new Map(families.filter((item) => item.caseId).map((item) => [item.caseId!, item]));
    const familyByPassengerFlight = new Map(
      families
        .filter((item) => item.passengerLastName || item.passengerFlight)
        .map((item) => [`${normalized(item.passengerLastName)}|${normalized(item.passengerFlight)}`, item])
    );
    const suggestions = [];
    enquiryLoop:
    for (const enquiry of enquiries) {
      const candidateMap = new Map<string, (typeof passengers)[number]>();
      for (const passenger of passengerByLastName.get(normalized(enquiry.passengerLastName)) ?? []) candidateMap.set(passenger.id, passenger);
      for (const passenger of passengerByFlight.get(normalized(enquiry.passengerFlight)) ?? []) candidateMap.set(passenger.id, passenger);
      for (const passenger of candidateMap.values()) {
        const lastName = Boolean(enquiry.passengerLastName && normalized(passenger.lastName) === normalized(enquiry.passengerLastName));
        const firstName = Boolean(enquiry.passengerFirstName && normalized(passenger.firstName) === normalized(enquiry.passengerFirstName));
        const flight = Boolean(enquiry.passengerFlight && normalized(passenger.flightNumber) === normalized(enquiry.passengerFlight));
        const route = Boolean(enquiry.passengerRoute && normalized(passenger.route) === normalized(enquiry.passengerRoute));
        const sameLastFlight = passengerByLastFlight.get(`${normalized(enquiry.passengerLastName)}|${normalized(enquiry.passengerFlight)}`) ?? [];
        const hasIdentitySignal = lastName && firstName;
        const hasUniqueTravelSignal = lastName && flight && sameLastFlight.length === 1;
        if (!hasIdentitySignal && !hasUniqueTravelSignal) continue;
        const score = [lastName, firstName, flight, route].filter(Boolean).length / 4;
        if (score >= 0.5) {
          const family =
            (enquiry.caseId ? familyByCaseId.get(enquiry.caseId) : undefined) ??
            familyByPassengerFlight.get(`${normalized(passenger.lastName)}|${normalized(passenger.flightNumber)}`);
          suggestions.push({
            enquiry,
            familyRecord: family,
            passengerRecord: passenger,
            matchScore: Number(score.toFixed(2)),
            matchBasis: "Suggested by aligned passenger name, flight and route fields. Requires ZPP verification."
          });
          if (suggestions.length >= 100) break enquiryLoop;
        }
      }
    }
    sendRedacted(req, res, { data: suggestions });
  })
);

api.post(
  "/matching-records",
  requirePermission("matching:create"),
  asyncHandler(async (req, res) => {
    const body = clean(matchingSchema.parse(req.body));
    const links = await validateMatchingLinks(body);
    const data = {
      ...body,
      caseId: body.caseId ?? links.family.caseId ?? links.passenger.caseId,
      status: "Potential match",
      holdCheck: "No hold",
      decisionNotes: undefined,
      verificationChecklist:
        body.verificationChecklist === undefined || body.verificationChecklist === null
          ? undefined
          : (body.verificationChecklist as Prisma.InputJsonValue),
      createdById: actorId(req),
      updatedById: actorId(req)
    };
    const record = await withOperationalIdRetry(async () => prisma.matchingRecord.create({
      data: {
        ...data,
        operationalId: await nextOperationalId("matchingRecord", "MAT")
      }
    }));
    await logAudit(req, { action: "create_potential_match", entityType: "matchingRecord", entityId: record.id, sessionId: record.sessionId, summary: `Potential match ${record.operationalId} created` });
    await addTimelineEvent({ sessionId: record.sessionId, caseId: record.caseId, eventType: "matching", entityType: "matchingRecord", entityId: record.id, title: `Potential match ${record.operationalId} created`, body: record.matchBasis ?? undefined, createdById: actorId(req) });
    res.status(201).json(record);
  })
);

api.patch(
  "/matching-records/:id",
  requirePermission("matching:create"),
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const existing = await prisma.matchingRecord.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Matching record not found");
    const body = clean(matchingSchema.partial().parse(req.body));
    const links = {
      sessionId: existing.sessionId,
      enquiryId: body.enquiryId === undefined ? existing.enquiryId : body.enquiryId,
      familyRecordId: body.familyRecordId === undefined ? existing.familyRecordId : body.familyRecordId,
      passengerRecordId: body.passengerRecordId === undefined ? existing.passengerRecordId : body.passengerRecordId
    };
    await validateMatchingLinks(links, id);
    const {
      sessionId: _sessionId,
      status: _status,
      holdCheck: _holdCheck,
      decisionNotes: _decisionNotes,
      verificationChecklist,
      ...updates
    } = body;
    const record = await prisma.matchingRecord.update({
      where: { id },
      data: {
        ...updates,
        verificationChecklist:
          verificationChecklist === undefined || verificationChecklist === null ? undefined : (verificationChecklist as Prisma.InputJsonValue),
        updatedById: actorId(req)
      }
    });
    await logAudit(req, { action: "update_matching_record", entityType: "matchingRecord", entityId: id, sessionId: record.sessionId, summary: `Matching record ${record.operationalId} updated` });
    res.json(record);
  })
);

api.post(
  "/matching-records/:id/verify",
  requirePermission("matching:verify"),
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const decision = requireDecisionBasis(req.body);
    const existing = await prisma.matchingRecord.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Matching record not found");
    const record = await prisma.matchingRecord.update({
      where: { id },
      data: {
        status: "Verified match",
        matchBasis: decision.matchBasis ?? existing.matchBasis,
        decisionNotes: decision.decisionNotes,
        approvedById: actorId(req),
        approvedAt: new Date(),
        updatedById: actorId(req)
      }
    });
    await logAudit(req, { action: "verify_match", entityType: "matchingRecord", entityId: id, sessionId: record.sessionId, summary: `Match ${record.operationalId} verified`, metadata: decision });
    await addTimelineEvent({ sessionId: record.sessionId, caseId: record.caseId, eventType: "matching", entityType: "matchingRecord", entityId: id, title: "Match verified", body: decision.decisionNotes, createdById: actorId(req) });
    res.json(record);
  })
);

api.post(
  "/matching-records/:id/reject",
  requirePermission("matching:reject"),
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const decision = requireDecisionBasis(req.body);
    const record = await prisma.matchingRecord.update({ where: { id }, data: { status: "Rejected", decisionNotes: decision.decisionNotes, approvedById: actorId(req), approvedAt: new Date(), updatedById: actorId(req) } });
    await logAudit(req, { action: "reject_match", entityType: "matchingRecord", entityId: id, sessionId: record.sessionId, summary: `Match ${record.operationalId} rejected`, metadata: decision });
    await addTimelineEvent({ sessionId: record.sessionId, caseId: record.caseId, eventType: "matching", entityType: "matchingRecord", entityId: id, title: "Match rejected", body: decision.decisionNotes, createdById: actorId(req) });
    res.json(record);
  })
);

api.post(
  "/matching-records/:id/hold",
  requirePermission("matching:hold"),
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const decision = requireDecisionBasis(req.body);
    if (!decision.holdCheck || decision.holdCheck === "No hold") throw new HttpError(400, "A blocking hold type is required");
    const record = await prisma.matchingRecord.update({ where: { id }, data: { status: "Hold / escalate", holdCheck: decision.holdCheck, decisionNotes: decision.decisionNotes, updatedById: actorId(req) } });
    await logAudit(req, { action: "hold_escalate", entityType: "matchingRecord", entityId: id, sessionId: record.sessionId, summary: `Match ${record.operationalId} placed on hold`, metadata: decision });
    await addTimelineEvent({ sessionId: record.sessionId, caseId: record.caseId, eventType: "hold", entityType: "matchingRecord", entityId: id, title: `${decision.holdCheck} applied`, body: decision.decisionNotes, createdById: actorId(req) });
    res.json(record);
  })
);

api.post(
  "/matching-records/:id/clear-hold",
  requirePermission("matching:clearHold"),
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const decision = requireDecisionBasis(req.body);
    const existing = await prisma.matchingRecord.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Matching record not found");
    const record = await prisma.matchingRecord.update({ where: { id }, data: { status: existing.status === "Hold / escalate" ? "Potential match" : existing.status, holdCheck: "No hold", decisionNotes: decision.decisionNotes, updatedById: actorId(req) } });
    await logAudit(req, { action: "clear_hold", entityType: "matchingRecord", entityId: id, sessionId: record.sessionId, summary: `Hold cleared for match ${record.operationalId}`, metadata: decision });
    await addTimelineEvent({ sessionId: record.sessionId, caseId: record.caseId, eventType: "hold", entityType: "matchingRecord", entityId: id, title: "Hold cleared", body: decision.decisionNotes, createdById: actorId(req) });
    res.json(record);
  })
);

api.post(
  "/matching-records/:id/mark-reunited",
  requirePermission("matching:reunite"),
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const decision = requireDecisionBasis(req.body);
    const match = await ensureVerifiedMatchForRelease(req, id, decision.coordinatorOverride, decision.overrideReason);
    const record = await prisma.matchingRecord.update({
      where: { id },
      data: {
        status: "Reunited",
        decisionNotes: decision.decisionNotes,
        coordinatorOverride: Boolean(decision.coordinatorOverride),
        overrideReason: decision.overrideReason,
        approvedById: actorId(req),
        approvedAt: new Date(),
        updatedById: actorId(req)
      }
    });
    await withOperationalIdRetry(async () => prisma.reunificationReleaseRecord.create({
      data: {
        operationalId: await nextOperationalId("reunificationReleaseRecord", "REL"),
        sessionId: record.sessionId,
        matchId: id,
        passengerRecordId: match?.passengerRecordId,
        familyRecordId: match?.familyRecordId,
        actionType: "Reunification",
        status: "Completed",
        identityChecked: true,
        holdCleared: true,
        authorizedById: actorId(req),
        completedById: actorId(req),
        completedAt: new Date(),
        notes: decision.decisionNotes
      }
    }));
    await logAudit(req, { action: "reunite", entityType: "matchingRecord", entityId: id, sessionId: record.sessionId, summary: `Match ${record.operationalId} marked reunited`, metadata: decision });
    await addTimelineEvent({ sessionId: record.sessionId, caseId: record.caseId, eventType: "reunification", entityType: "matchingRecord", entityId: id, title: "Reunification completed", body: decision.decisionNotes, createdById: actorId(req) });
    res.json(record);
  })
);

api.post(
  "/matching-records/:id/mark-released",
  requirePermission("matching:release"),
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const decision = requireDecisionBasis(req.body);
    const match = await ensureVerifiedMatchForRelease(req, id, decision.coordinatorOverride, decision.overrideReason);
    const record = await prisma.matchingRecord.update({
      where: { id },
      data: { status: "Released", decisionNotes: decision.decisionNotes, coordinatorOverride: Boolean(decision.coordinatorOverride), overrideReason: decision.overrideReason, approvedById: actorId(req), approvedAt: new Date(), updatedById: actorId(req) }
    });
    await withOperationalIdRetry(async () => prisma.reunificationReleaseRecord.create({
      data: {
        operationalId: await nextOperationalId("reunificationReleaseRecord", "REL"),
        sessionId: record.sessionId,
        matchId: id,
        passengerRecordId: match?.passengerRecordId,
        familyRecordId: match?.familyRecordId,
        actionType: "Release",
        status: "Completed",
        releaseDestination: req.body?.releaseDestination,
        receivingParty: req.body?.receivingParty,
        identityChecked: true,
        holdCleared: true,
        transportMode: req.body?.transportMode,
        authorizedById: actorId(req),
        completedById: actorId(req),
        completedAt: new Date(),
        notes: decision.decisionNotes
      }
    }));
    await logAudit(req, { action: "release", entityType: "matchingRecord", entityId: id, sessionId: record.sessionId, summary: `Match ${record.operationalId} marked released`, metadata: decision });
    await addTimelineEvent({ sessionId: record.sessionId, caseId: record.caseId, eventType: "release", entityType: "matchingRecord", entityId: id, title: "Release completed", body: decision.decisionNotes, createdById: actorId(req) });
    res.json(record);
  })
);

api.get(
  "/releases",
  requirePermission("release:read"),
  asyncHandler((req, res) => listRecords(req, res, prisma.reunificationReleaseRecord, ["operationalId", "receivingParty", "releaseDestination"]))
);

api.post(
  "/releases",
  requirePermission("release:create"),
  asyncHandler(async (req, res) => {
    const body = clean(releaseSchema.parse(req.body));
    const decision = decisionSchema.partial().parse(req.body ?? {});
    const match = await ensureVerifiedMatchForRelease(req, body.matchId, decision.coordinatorOverride, decision.overrideReason, body.sessionId);
    if (!body.matchId) throw new HttpError(400, "A verified matching record is required");
    const duplicate = await prisma.reunificationReleaseRecord.findFirst({
      where: { sessionId: body.sessionId, matchId: body.matchId, status: "Prepared" }
    });
    if (duplicate) throw new HttpError(409, `An open release action already exists (${duplicate.operationalId})`);
    const record = await withOperationalIdRetry(async () => prisma.reunificationReleaseRecord.create({
      data: {
        ...body,
        status: "Prepared",
        passengerRecordId: match?.passengerRecordId,
        familyRecordId: match?.familyRecordId,
        operationalId: await nextOperationalId("reunificationReleaseRecord", "REL"),
        authorizedById: actorId(req)
      }
    }));
    await logAudit(req, { action: "prepare_release", entityType: "reunificationReleaseRecord", entityId: record.id, sessionId: record.sessionId, summary: `${record.actionType} ${record.operationalId} prepared` });
    res.status(201).json(record);
  })
);

api.patch(
  "/releases/:id",
  requirePermission("release:create"),
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const existing = await prisma.reunificationReleaseRecord.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Release/reunification record not found");
    if (existing.status !== "Prepared") throw new HttpError(409, "Completed or cancelled release actions are read-only");
    const body = clean(releaseSchema.partial().parse(req.body));
    const match = await ensureVerifiedMatchForRelease(req, existing.matchId, false, undefined, existing.sessionId);
    const {
      sessionId: _sessionId,
      matchId: _matchId,
      passengerRecordId: _passengerRecordId,
      familyRecordId: _familyRecordId,
      status: _status,
      ...updates
    } = body;
    const record = await prisma.reunificationReleaseRecord.update({
      where: { id },
      data: {
        ...updates,
        passengerRecordId: match?.passengerRecordId,
        familyRecordId: match?.familyRecordId
      }
    });
    await logAudit(req, { action: "update_release", entityType: "reunificationReleaseRecord", entityId: id, sessionId: record.sessionId, summary: `${record.actionType} ${record.operationalId} updated` });
    res.json(record);
  })
);

api.post(
  "/releases/:id/complete",
  requirePermission("release:complete"),
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const decision = releaseDecisionSchema.parse(req.body);
    const existing = await prisma.reunificationReleaseRecord.findUnique({ where: { id }, include: { match: true } });
    if (!existing) throw new HttpError(404, "Release/reunification record not found");
    if (existing.status !== "Prepared") throw new HttpError(409, "Only prepared release actions can be completed");
    await ensureVerifiedMatchForRelease(req, existing.matchId, false, undefined, existing.sessionId);
    if (!existing.identityChecked) throw new HttpError(409, "Identity check must be confirmed before completion");
    if (!existing.holdCleared) throw new HttpError(409, "Hold cleared check must be confirmed before completion");
    if (!existing.receivingParty && existing.actionType === "Release") throw new HttpError(400, "Receiving party is required for release");
    const record = await prisma.reunificationReleaseRecord.update({
      where: { id },
      data: { status: "Completed", completedById: actorId(req), completedAt: new Date(), notes: decision.notes }
    });
    if (record.matchId) {
      await prisma.matchingRecord.update({
        where: { id: record.matchId },
        data: { status: record.actionType === "Release" ? "Released" : "Reunited", updatedById: actorId(req) }
      });
    }
    await logAudit(req, {
      action: record.actionType === "Release" ? "release" : "reunite",
      entityType: "reunificationReleaseRecord",
      entityId: id,
      sessionId: record.sessionId,
      summary: `${record.actionType} ${record.operationalId} completed`,
      metadata: { status: "Completed", actionType: record.actionType, decisionNotes: decision.notes }
    });
    await addTimelineEvent({
      sessionId: record.sessionId,
      caseId: existing.match?.caseId,
      eventType: record.actionType === "Release" ? "release" : "reunification",
      entityType: "reunificationReleaseRecord",
      entityId: id,
      title: `${record.actionType} ${record.operationalId} completed`,
      body: decision.notes,
      metadata: { status: "Completed", actionType: record.actionType },
      createdById: actorId(req)
    });
    res.json(record);
  })
);

api.post(
  "/releases/:id/cancel",
  requirePermission("release:cancel"),
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const decision = releaseDecisionSchema.parse(req.body);
    const existing = await prisma.reunificationReleaseRecord.findUnique({ where: { id }, include: { match: true } });
    if (!existing) throw new HttpError(404, "Release/reunification record not found");
    if (existing.status !== "Prepared") throw new HttpError(409, "Only prepared release actions can be cancelled");
    const record = await prisma.reunificationReleaseRecord.update({ where: { id }, data: { status: "Cancelled", notes: decision.notes } });
    await logAudit(req, {
      action: "cancel_release",
      entityType: "reunificationReleaseRecord",
      entityId: id,
      sessionId: record.sessionId,
      summary: `${record.actionType} ${record.operationalId} cancelled`,
      metadata: { status: "Cancelled", actionType: record.actionType, decisionNotes: decision.notes }
    });
    await addTimelineEvent({
      sessionId: record.sessionId,
      caseId: existing.match?.caseId,
      eventType: "release",
      entityType: "reunificationReleaseRecord",
      entityId: id,
      title: `${record.actionType} ${record.operationalId} cancelled`,
      body: decision.notes,
      metadata: { status: "Cancelled", actionType: record.actionType },
      createdById: actorId(req)
    });
    res.json(record);
  })
);

api.get(
  "/requests",
  requirePermission("request:read"),
  asyncHandler((req, res) => listRecords(req, res, prisma.welfareRequest, ["operationalId", "category", "requester", "ownerAssignedTo", "details"]))
);

api.post(
  "/requests",
  requirePermission("request:create"),
  asyncHandler(async (req, res) => {
    const body = clean(requestSchema.parse(req.body));
    const record = await withOperationalIdRetry(async () => prisma.welfareRequest.create({
      data: { ...body, operationalId: await nextOperationalId("welfareRequest", "REQ"), createdById: actorId(req), updatedById: actorId(req) }
    }));
    await logAudit(req, { action: "create_request", entityType: "request", entityId: record.id, sessionId: record.sessionId, summary: `Request ${record.operationalId} created` });
    await addTimelineEvent({ sessionId: record.sessionId, caseId: record.caseId, eventType: "request", entityType: "request", entityId: record.id, title: `Request ${record.operationalId} created`, body: record.details, createdById: actorId(req) });
    res.status(201).json(record);
  })
);

api.patch(
  "/requests/:id",
  requirePermission("request:update"),
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const body = clean(requestSchema.partial().parse(req.body));
    const record = await prisma.welfareRequest.update({ where: { id }, data: { ...body, updatedById: actorId(req) } });
    await logAudit(req, { action: "update_request", entityType: "request", entityId: id, sessionId: record.sessionId, summary: `Request ${record.operationalId} updated` });
    res.json(record);
  })
);

api.post(
  "/requests/:id/assign-to-me",
  requirePermission("request:assign"),
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const record = await prisma.welfareRequest.update({ where: { id }, data: { status: "Assigned", ownerAssignedTo: req.user?.displayName, updatedById: actorId(req) } });
    await logAudit(req, { action: "assign_request", entityType: "request", entityId: id, sessionId: record.sessionId, summary: `Request ${record.operationalId} assigned to ${req.user?.displayName}` });
    res.json(record);
  })
);

api.post(
  "/requests/:id/status",
  requirePermission("request:update"),
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const decision = requestStatusUpdateSchema.parse(req.body);
    const record = await prisma.welfareRequest.update({
      where: { id },
      data: {
        status: decision.status,
        closureNote: decision.closureNote,
        updatedById: actorId(req)
      }
    });
    await logAudit(req, {
      action: decision.status === "Closed" ? "close_request" : "update_request_status",
      entityType: "request",
      entityId: id,
      sessionId: record.sessionId,
      summary: `Request ${record.operationalId} status changed to ${decision.status}`,
      metadata: decision.status === "Closed" ? { status: decision.status, closureNote: decision.closureNote } : { status: decision.status }
    });
    if (decision.status === "Closed") {
      await addTimelineEvent({
        sessionId: record.sessionId,
        caseId: record.caseId,
        eventType: "request",
        entityType: "request",
        entityId: id,
        title: `Request ${record.operationalId} closed`,
        body: decision.closureNote,
        metadata: { status: decision.status },
        createdById: actorId(req)
      });
    }
    res.json(record);
  })
);

api.get(
  "/assignments",
  requirePermission("assignment:read"),
  asyncHandler(async (req, res) => {
    const query = listQuery.parse(req.query);
    const where: Prisma.AssignmentTaskWhereInput = {};
    if (query.sessionId) where.sessionId = query.sessionId;
    if (query.status) where.status = query.status;
    if (query.search) {
      where.OR = ["operationalId", "caseId", "title", "ownerAssignedTo", "assignedUserDisplayName", "relatedFunction", "linkedRecord"].map((field) => ({
        [field]: { contains: query.search, mode: "insensitive" }
      }));
    }
    const [total, records] = await Promise.all([
      prisma.assignmentTask.count({ where }),
      prisma.assignmentTask.findMany({
        where,
        take: query.limit,
        skip: query.offset,
        orderBy: { updatedAt: "desc" },
        include: { assignedUser: { include: { roles: { include: { role: true } } } } }
      })
    ]);
    const data = (await attachActorMetadata(records)).map(assignmentResponse);
    sendRedacted(req, res, { total, data });
  })
);

api.get(
  "/assignment-assignees",
  requirePermission("assignment:assign"),
  asyncHandler(async (req, res) => {
    if (!assignmentManager(req)) throw new HttpError(403, "Only a Leader, Coordinator or Administrator can assign work to others");
    const data = await listAssignmentAssignees();
    res.json({ total: data.length, data });
  })
);

api.post(
  "/assignments",
  requirePermission("assignment:create"),
  asyncHandler(async (req, res) => {
    const body = clean(assignmentSchema.parse(req.body));
    const session = await prisma.session.findUnique({ where: { id: body.sessionId } });
    if (!session) throw new HttpError(404, "Session not found");
    if (["Closed", "Archived"].includes(session.status)) throw new HttpError(409, "Assignments cannot be changed in a closed session");
    const { assignedUserId: _assignedUserId, assignedUserDisplayName: _assignedUserDisplayName, ownerAssignedTo: _ownerAssignedTo, ...createBody } = body;
    const record = await withOperationalIdRetry(async () =>
      prisma.assignmentTask.create({
        data: {
          ...createBody,
          status: "Open",
          ownerAssignedTo: null,
          assignedUserId: null,
          assignedUserDisplayName: null,
          operationalId: await nextOperationalId("assignmentTask", "ASN"),
          createdById: actorId(req),
          updatedById: actorId(req)
        }
      })
    );
    await logAudit(req, {
      action: "create_assignment",
      entityType: "assignmentTask",
      entityId: record.id,
      sessionId: record.sessionId,
      summary: `Assignment ${record.operationalId} created`
    });
    await addTimelineEvent({
      sessionId: record.sessionId,
      caseId: record.caseId,
      eventType: "assignment",
      entityType: "assignmentTask",
      entityId: record.id,
      title: `Assignment ${record.operationalId} created`,
      body: record.title,
      metadata: { status: record.status, priority: record.priority, assignedUserId: null, assignedUserDisplayName: null, ownerAssignedTo: null },
      createdById: actorId(req)
    });
    res.status(201).json(assignmentResponse(record));
  })
);

api.patch(
  "/assignments/:id",
  requirePermission("assignment:update"),
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const body = clean(assignmentSchema.partial().parse(req.body));
    const existing = await prisma.assignmentTask.findUnique({ where: { id }, include: { session: true } });
    if (!existing) throw new HttpError(404, "Assignment not found");
    if (["Closed", "Archived"].includes(existing.session.status)) throw new HttpError(409, "Assignments cannot be changed in a closed session");
    if (["Completed", "Cancelled"].includes(existing.status)) throw new HttpError(409, "Terminal assignments are read-only");
    const { status: _status, ownerAssignedTo: _ownerAssignedTo, assignedUserId: _assignedUserId, assignedUserDisplayName: _assignedUserDisplayName, sessionId: _sessionId, ...editable } = body;
    const record = await prisma.assignmentTask.update({
      where: { id },
      data: { ...editable, updatedById: actorId(req) },
      include: { assignedUser: { include: { roles: { include: { role: true } } } } }
    });
    await logAudit(req, {
      action: "update_assignment",
      entityType: "assignmentTask",
      entityId: id,
      sessionId: record.sessionId,
      summary: `Assignment ${record.operationalId} updated`
    });
    res.json(assignmentResponse(record));
  })
);

api.post(
  "/assignments/:id/assign",
  requirePermission("assignment:assign"),
  asyncHandler(async (req, res) => {
    if (!assignmentManager(req)) throw new HttpError(403, "Only a Leader, Coordinator or Administrator can assign work to others");
    const { id } = idParam.parse(req.params);
    const decision = assignmentAssignSchema.parse(req.body);
    const [existing, assignee] = await Promise.all([
      prisma.assignmentTask.findUnique({ where: { id }, include: { session: true } }),
      findAssignmentAssignee(decision.assignedUserId)
    ]);
    if (!existing) throw new HttpError(404, "Assignment not found");
    if (["Closed", "Archived"].includes(existing.session.status)) throw new HttpError(409, "Assignments cannot be changed in a closed session");
    if (existing.status !== "Open" || existing.assignedUserId || existing.ownerAssignedTo) throw new HttpError(409, "Only an unassigned open assignment can be assigned");
    const assigneeName = assignee.displayName ?? assignee.email;
    const changed = await prisma.assignmentTask.updateMany({
      where: { id, status: "Open", assignedUserId: null, ownerAssignedTo: null },
      data: { assignedUserId: assignee.id, assignedUserDisplayName: assigneeName, ownerAssignedTo: assigneeName, updatedById: actorId(req) }
    });
    if (changed.count !== 1) throw new HttpError(409, "This assignment was claimed or changed by another user");
    const record = await prisma.assignmentTask.findUniqueOrThrow({ where: { id }, include: { assignedUser: { include: { roles: { include: { role: true } } } } } });
    const metadata = {
      previousAssigneeId: null,
      previousAssigneeDisplayName: null,
      newAssigneeId: assignee.id,
      newAssigneeDisplayName: assigneeName,
      oldState: existing.status,
      newState: existing.status
    };
    await logAudit(req, {
      action: "assign_assignment",
      entityType: "assignmentTask",
      entityId: id,
      sessionId: record.sessionId,
      summary: `Assignment ${record.operationalId} assigned to ${assigneeName}`,
      metadata
    });
    await addTimelineEvent({
      sessionId: record.sessionId,
      caseId: record.caseId,
      eventType: "assignment",
      entityType: "assignmentTask",
      entityId: id,
      title: `Assignment ${record.operationalId} assigned to ${assigneeName}`,
      metadata,
      createdById: actorId(req)
    });
    res.json(assignmentResponse(record));
  })
);

api.post(
  "/assignments/:id/assign-to-me",
  requirePermission("assignment:update"),
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const assigneeId = req.user?.userId ?? req.user?.id;
    const ownerAssignedTo = req.user?.displayName ?? req.user?.email ?? "Current user";
    if (!assigneeId) throw new HttpError(401, "Authentication required");
    const existing = await prisma.assignmentTask.findUnique({ where: { id }, include: { session: true } });
    if (!existing) throw new HttpError(404, "Assignment not found");
    if (["Closed", "Archived"].includes(existing.session.status)) throw new HttpError(409, "Assignments cannot be changed in a closed session");
    if (existing.status !== "Open" || existing.assignedUserId || existing.ownerAssignedTo) throw new HttpError(409, "This assignment is no longer available to claim");
    const changed = await prisma.assignmentTask.updateMany({
      where: { id, status: "Open", assignedUserId: null, ownerAssignedTo: null },
      data: { assignedUserId: assigneeId, assignedUserDisplayName: ownerAssignedTo, ownerAssignedTo, updatedById: actorId(req) }
    });
    if (changed.count !== 1) throw new HttpError(409, "This assignment was claimed by another user");
    const record = await prisma.assignmentTask.findUniqueOrThrow({ where: { id }, include: { assignedUser: { include: { roles: { include: { role: true } } } } } });
    const metadata = {
      previousAssigneeId: null,
      previousAssigneeDisplayName: null,
      newAssigneeId: assigneeId,
      newAssigneeDisplayName: ownerAssignedTo,
      oldState: existing.status,
      newState: record.status
    };
    await logAudit(req, {
      action: "claim_assignment",
      entityType: "assignmentTask",
      entityId: id,
      sessionId: record.sessionId,
      summary: `Assignment ${record.operationalId} assigned to ${ownerAssignedTo}`,
      metadata
    });
    await addTimelineEvent({
      sessionId: record.sessionId,
      caseId: record.caseId,
      eventType: "assignment",
      entityType: "assignmentTask",
      entityId: id,
      title: `Assignment ${record.operationalId} claimed by ${ownerAssignedTo}`,
      metadata,
      createdById: actorId(req)
    });
    res.json(assignmentResponse(record));
  })
);

api.post(
  "/assignments/:id/reassign",
  requirePermission("assignment:assign"),
  asyncHandler(async (req, res) => {
    if (!assignmentManager(req)) throw new HttpError(403, "Only a Leader, Coordinator or Administrator can reassign work");
    const { id } = idParam.parse(req.params);
    const decision = assignmentReassignSchema.parse(req.body);
    const [existing, assignee] = await Promise.all([
      prisma.assignmentTask.findUnique({ where: { id }, include: { session: true } }),
      findAssignmentAssignee(decision.assignedUserId)
    ]);
    if (!existing) throw new HttpError(404, "Assignment not found");
    if (["Closed", "Archived"].includes(existing.session.status)) throw new HttpError(409, "Assignments cannot be changed in a closed session");
    if (["Completed", "Cancelled"].includes(existing.status)) throw new HttpError(409, "Terminal assignments are read-only");
    if (!existing.assignedUserId && !existing.ownerAssignedTo) throw new HttpError(409, "Use Assign or Claim for unassigned work");
    if (existing.assignedUserId === assignee.id) throw new HttpError(409, "Select a different assignee");
    const previousAssigneeDisplayName = existing.assignedUserDisplayName ?? existing.ownerAssignedTo ?? null;
    const assigneeName = assignee.displayName ?? assignee.email;
    const changed = await prisma.assignmentTask.updateMany({
      where: { id, status: existing.status, assignedUserId: existing.assignedUserId, ownerAssignedTo: existing.ownerAssignedTo },
      data: { assignedUserId: assignee.id, assignedUserDisplayName: assigneeName, ownerAssignedTo: assigneeName, updatedById: actorId(req) }
    });
    if (changed.count !== 1) throw new HttpError(409, "This assignment changed before reassignment could be saved");
    const record = await prisma.assignmentTask.findUniqueOrThrow({ where: { id }, include: { assignedUser: { include: { roles: { include: { role: true } } } } } });
    const metadata = {
      previousAssigneeId: existing.assignedUserId ?? null,
      previousAssigneeDisplayName,
      newAssigneeId: assignee.id,
      newAssigneeDisplayName: assigneeName,
      reason: decision.reason,
      oldState: existing.status,
      newState: existing.status
    };
    await logAudit(req, { action: "reassign_assignment", entityType: "assignmentTask", entityId: id, sessionId: record.sessionId, summary: `Assignment ${record.operationalId} reassigned from ${previousAssigneeDisplayName ?? "unassigned"} to ${assigneeName}`, metadata });
    await addTimelineEvent({ sessionId: record.sessionId, caseId: record.caseId, eventType: "assignment", entityType: "assignmentTask", entityId: id, title: `Assignment ${record.operationalId} reassigned`, body: decision.reason, metadata, createdById: actorId(req) });
    res.json(assignmentResponse(record));
  })
);

api.post(
  "/assignments/:id/status",
  requirePermission("assignment:update"),
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const decision = assignmentStatusUpdateSchema.parse(req.body);
    const existing = await prisma.assignmentTask.findUnique({ where: { id }, include: { session: true } });
    if (!existing) throw new HttpError(404, "Assignment not found");
    if (["Closed", "Archived"].includes(existing.session.status)) throw new HttpError(409, "Assignments cannot be changed in a closed session");
    if (["Completed", "Cancelled"].includes(existing.status)) throw new HttpError(409, "Terminal assignments are read-only");
    const transitions: Record<string, string[]> = { Open: ["In Progress", "Cancelled"], "In Progress": ["Escalated", "Completed", "Cancelled"], Escalated: ["In Progress", "Cancelled"] };
    if (!transitions[existing.status]?.includes(decision.status)) throw new HttpError(409, `Invalid assignment transition from ${existing.status} to ${decision.status}`);
    if (!existing.assignedUserId && !existing.ownerAssignedTo) throw new HttpError(409, "Assign or claim this work before changing its status");
    const manager = assignmentManager(req);
    const currentUserId = req.user?.userId ?? req.user?.id;
    if (!manager && (!currentUserId || existing.assignedUserId !== currentUserId)) throw new HttpError(409, "Only the current assignee or a Coordinator can change this status");
    const changed = await prisma.assignmentTask.updateMany({ where: { id, status: existing.status, assignedUserId: existing.assignedUserId, ownerAssignedTo: existing.ownerAssignedTo }, data: { status: decision.status, updatedById: actorId(req) } });
    if (changed.count !== 1) throw new HttpError(409, "This assignment changed before the transition could be saved");
    const record = await prisma.assignmentTask.findUniqueOrThrow({ where: { id }, include: { assignedUser: { include: { roles: { include: { role: true } } } } } });
    await logAudit(req, {
      action: "update_assignment_status",
      entityType: "assignmentTask",
      entityId: id,
      sessionId: record.sessionId,
      summary: `Assignment ${record.operationalId} status changed to ${decision.status}`,
      metadata: {
        oldState: existing.status,
        newState: decision.status,
        status: decision.status,
        reason: decision.reason,
        assignedUserId: existing.assignedUserId ?? null,
        assignedUserDisplayName: existing.assignedUserDisplayName ?? existing.ownerAssignedTo ?? null
      }
    });
    await addTimelineEvent({
      sessionId: record.sessionId,
      caseId: record.caseId,
      eventType: "assignment",
      entityType: "assignmentTask",
      entityId: id,
      title: `Assignment ${record.operationalId} moved to ${decision.status}`,
      body: decision.reason ?? record.title,
      metadata: {
        oldState: existing.status,
        newState: decision.status,
        status: decision.status,
        reason: decision.reason,
        assignedUserId: existing.assignedUserId ?? null,
        assignedUserDisplayName: existing.assignedUserDisplayName ?? existing.ownerAssignedTo ?? null
      },
      createdById: actorId(req)
    });
    res.json(assignmentResponse(record));
  })
);

api.get(
  "/timeline",
  requirePermission("timeline:read"),
  asyncHandler(async (req, res) => {
    const query = listQuery.parse(req.query);
    const where: Record<string, unknown> = {};
    if (query.sessionId) where.sessionId = query.sessionId;
    if (req.query.caseId) where.caseId = String(req.query.caseId);
    const [total, records] = await Promise.all([
      prisma.caseTimelineEvent.count({ where }),
      prisma.caseTimelineEvent.findMany({ where, orderBy: { occurredAt: "desc" }, take: query.limit, skip: query.offset })
    ]);
    const data = await attachActorMetadata(records);
    sendRedacted(req, res, { total, data });
  })
);

api.post(
  "/timeline",
  requirePermission("timeline:create"),
  asyncHandler(async (req, res) => {
    const body = clean(timelineSchema.parse(req.body));
    const session = await prisma.session.findUnique({ where: { id: body.sessionId } });
    if (!session) throw new HttpError(404, "Session not found");
    if (["Closed", "Archived"].includes(session.status)) throw new HttpError(409, "Timeline notes cannot be added to a closed session");
    const record = await prisma.caseTimelineEvent.create({
      data: {
        ...body,
        entityType: "manualNote",
        createdById: actorId(req)
      }
    });
    await logAudit(req, { action: "create_timeline_event", entityType: "caseTimelineEvent", entityId: record.id, sessionId: record.sessionId, summary: `Timeline event created: ${record.title}` });
    res.status(201).json(record);
  })
);

api.get(
  "/audit-logs",
  requirePermission("audit:read"),
  asyncHandler(async (req, res) => {
    const query = listQuery.parse(req.query);
    const where: Record<string, unknown> = {};
    if (query.sessionId) where.sessionId = query.sessionId;
    if (req.query.action) where.action = String(req.query.action);
    const [total, records] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, take: query.limit, skip: query.offset, include: { actor: { include: { roles: { include: { role: true } } } } } })
    ]);
    const data = records.map((record) => ({
      ...record,
      actorDisplayName: record.actor?.displayName ?? record.actorEmail ?? null,
      actorRoles: record.actor?.roles.map((item) => item.role.displayName || item.role.name) ?? []
    }));
    res.json({ total, data });
  })
);

type ImportError = { row: number; error: string };
type ImportPreviewRow = { row: number; status: "valid" | "invalid"; values: Record<string, unknown>; error?: string };
type ImportValidationResult = {
  totalRecords: number;
  validRecords: number;
  invalidRecords: number;
  errors: ImportError[];
  previewRows: ImportPreviewRow[];
};

function cell(row: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function importErrorMessage(error: unknown) {
  if (error && typeof error === "object" && "issues" in error && Array.isArray((error as { issues?: unknown[] }).issues)) {
    return (error as { issues: Array<{ path?: Array<string | number>; message: string }> }).issues
      .map((issue) => {
        const path = issue.path?.length ? `${issue.path.join(".")}: ` : "";
        return `${path}${issue.message}`;
      })
      .join("; ");
  }
  return error instanceof Error ? error.message : "Invalid row";
}

function parseImportRow(type: string, sessionId: string | undefined, rawRow: Record<string, unknown>) {
  if (!sessionId) throw new Error("sessionId is required");
  const row = normalizeRow(rawRow);

  if (type === "family") {
    return {
      model: "familyRecord" as const,
      prefix: "FAM",
      data: clean(
        familySchema.parse({
          sessionId,
          caseId: cell(row, "caseId", "case_id"),
          firstName: cell(row, "firstName", "first_name"),
          lastName: cell(row, "lastName", "last_name"),
          phone: cell(row, "phone"),
          email: cell(row, "email") || undefined,
          preferredContactChannel: cell(row, "preferredContactChannel", "preferred_contact_channel"),
          preferredLanguage: cell(row, "preferredLanguage", "preferred_language"),
          location: cell(row, "location"),
          claimedRelationship: cell(row, "claimedRelationship", "claimed_relationship"),
          passengerFirstName: cell(row, "passengerFirstName", "passenger_first_name"),
          passengerLastName: cell(row, "passengerLastName", "passenger_last_name"),
          passengerFlight: cell(row, "passengerFlight", "passenger_flight"),
          verificationStatus: cell(row, "verificationStatus", "verification_status") || "Unverified",
          verificationNotes: cell(row, "verificationNotes", "verification_notes"),
          immediateNeeds: cell(row, "immediateNeeds", "immediate_needs"),
          questionsAsked: cell(row, "questionsAsked", "questions_asked"),
          commitmentsMade: cell(row, "commitmentsMade", "commitments_made"),
          nextContactDue: cell(row, "nextContactDue", "next_contact_due"),
          assignedOfficer: cell(row, "assignedOfficer", "assigned_officer"),
          notes: cell(row, "notes")
        })
      )
    };
  }

  if (type === "request") {
    return {
      model: "welfareRequest" as const,
      prefix: "REQ",
      data: clean(
        requestSchema.parse({
          sessionId,
          caseId: cell(row, "caseId", "case_id"),
          relatedEnquiryId: cell(row, "relatedEnquiryId", "related_enquiry_id"),
          relatedFamilyRecordId: cell(row, "relatedFamilyRecordId", "related_family_record_id"),
          relatedPassengerRecordId: cell(row, "relatedPassengerRecordId", "related_passenger_record_id"),
          category: cell(row, "category") || "Other",
          priority: cell(row, "priority") || "Normal",
          requester: cell(row, "requester"),
          ownerAssignedTo: cell(row, "ownerAssignedTo", "owner_assigned_to"),
          details: cell(row, "details"),
          approvalStatus: cell(row, "approvalStatus", "approval_status") || "Not required",
          status: cell(row, "status") || "Open",
          closureNote: cell(row, "closureNote", "closure_note"),
          notes: cell(row, "notes")
        })
      )
    };
  }

  throw new Error(`Unsupported import type: ${type}`);
}

function validateImportRows(type: string, sessionId: string | undefined, rows: Array<Record<string, unknown>>): ImportValidationResult {
  let validRecords = 0;
  const errors: ImportError[] = [];
  const previewRows: ImportPreviewRow[] = [];

  for (let index = 0; index < rows.length; index += 1) {
    const rowNumber = index + 2;
    const values = normalizeRow(rows[index]!);
    try {
      parseImportRow(type, sessionId, values);
      validRecords += 1;
      if (previewRows.length < 10) previewRows.push({ row: rowNumber, status: "valid", values });
    } catch (error) {
      const message = importErrorMessage(error);
      errors.push({ row: rowNumber, error: message });
      if (previewRows.length < 10) previewRows.push({ row: rowNumber, status: "invalid", values, error: message });
    }
  }

  return {
    totalRecords: rows.length,
    validRecords,
    invalidRecords: errors.length,
    errors,
    previewRows
  };
}

async function createImportedRecord(req: Request, parsed: ReturnType<typeof parseImportRow>) {
  const baseData = {
    ...parsed.data,
    createdById: actorId(req),
    updatedById: actorId(req)
  };
  const data = async () => ({
    ...baseData,
    operationalId: await nextOperationalId(parsed.model, parsed.prefix)
  });

  if (parsed.model === "familyRecord") {
    await withOperationalIdRetry(async () => prisma.familyRecord.create({ data: (await data()) as Prisma.FamilyRecordUncheckedCreateInput }));
  } else {
    await withOperationalIdRetry(async () => prisma.welfareRequest.create({ data: (await data()) as Prisma.WelfareRequestUncheckedCreateInput }));
  }
}

async function commitImportRows(req: Request, type: string, sessionId: string | undefined, rows: Array<Record<string, unknown>>) {
  let validRecords = 0;
  const errors: ImportError[] = [];

  for (let index = 0; index < rows.length; index += 1) {
    const rowNumber = index + 2;
    try {
      const parsed = parseImportRow(type, sessionId, rows[index]!);
      await createImportedRecord(req, parsed);
      validRecords += 1;
    } catch (error) {
      errors.push({ row: rowNumber, error: importErrorMessage(error) });
    }
  }

  return { totalRecords: rows.length, validRecords, invalidRecords: errors.length, errors };
}

api.post(
  "/imports/:type",
  requirePermission("import:create"),
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, "file is required");
    const uploadedFile = req.file;
    const type = String(req.params.type);
    const sessionId = req.body?.sessionId ? String(req.body.sessionId) : undefined;
    assertCsvFile(uploadedFile.originalname);
    const buffer = await fs.readFile(uploadedFile.path);
    const rows = parseWorkbook(buffer, uploadedFile.originalname);
    const result = validateImportRows(type, sessionId, rows);
    const batch = await withOperationalIdRetry(async () => prisma.importBatch.create({
      data: {
        operationalId: await nextOperationalId("importBatch", "IMP"),
        sessionId,
        importType: type,
        sourceFilename: uploadedFile.originalname,
        status: result.invalidRecords > 0 ? "Validated with errors" : "Validated",
        totalRecords: result.totalRecords,
        validRecords: result.validRecords,
        invalidRecords: result.invalidRecords,
        errors: result.errors,
        createdById: actorId(req)
      }
    }));
    await withOperationalIdRetry(async () => prisma.storedFile.create({
      data: {
        operationalId: await nextOperationalId("storedFile", "FIL"),
        sessionId,
        importBatchId: batch.id,
        fileName: uploadedFile.originalname,
        mimeType: uploadedFile.mimetype,
        sizeBytes: BigInt(uploadedFile.size),
        storageKey: storageKeyForFile(uploadedFile),
        createdById: actorId(req)
      }
    }));
    await logAudit(req, {
      action: "validate_import",
      entityType: "importBatch",
      entityId: batch.id,
      sessionId,
      summary: `Validated ${type}: ${result.validRecords}/${result.totalRecords} valid`,
      metadata: result
    });
    res.status(201).json({ ...batch, previewRows: result.previewRows });
  })
);

api.post(
  "/imports/:id/confirm",
  requirePermission("import:create"),
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const batch = await prisma.importBatch.findUnique({ where: { id } });
    if (!batch) throw new HttpError(404, "Import batch not found");
    if (batch.status.startsWith("Imported")) throw new HttpError(409, "Import batch has already been confirmed");

    const file = await prisma.storedFile.findFirst({ where: { importBatchId: id }, orderBy: { createdAt: "desc" } });
    if (!file) throw new HttpError(404, "Stored import file not found");
    assertCsvFile(file.fileName);

    const buffer = await fs.readFile(resolveStorageKey(file.storageKey));
    const rows = parseWorkbook(buffer, file.fileName);
    const result = await commitImportRows(req, batch.importType, batch.sessionId ?? undefined, rows);
    const updated = await prisma.importBatch.update({
      where: { id },
      data: {
        status: result.invalidRecords > 0 ? "Imported with errors" : "Imported",
        totalRecords: result.totalRecords,
        validRecords: result.validRecords,
        invalidRecords: result.invalidRecords,
        errors: result.errors
      }
    });

    await logAudit(req, {
      action: "import",
      entityType: "importBatch",
      entityId: updated.id,
      sessionId: updated.sessionId,
      summary: `Imported ${updated.importType}: ${result.validRecords}/${result.totalRecords} valid`,
      metadata: result
    });
    res.json(updated);
  })
);

api.get(
  "/files",
  requirePermission("import:create"),
  asyncHandler(async (req, res) => {
    const query = listQuery.parse(req.query);
    const where: Record<string, unknown> = {};
    if (query.sessionId) where.sessionId = query.sessionId;
    const [total, files] = await Promise.all([
      prisma.storedFile.count({ where }),
      prisma.storedFile.findMany({ where, orderBy: { createdAt: "desc" }, take: query.limit, skip: query.offset })
    ]);
    const batchIds = files.map((file) => file.importBatchId).filter((id): id is string => Boolean(id));
    const batches = batchIds.length ? await prisma.importBatch.findMany({ where: { id: { in: batchIds } } }) : [];
    const batchesById = new Map(batches.map((batch) => [batch.id, batch]));
    res.json({
      total,
      data: files.map((file) => {
        const batch = file.importBatchId ? batchesById.get(file.importBatchId) : undefined;
        return {
          ...file,
          sizeBytes: Number(file.sizeBytes),
          importBatch: batch ?? null,
          importStatus: batch?.status ?? null,
          importType: batch?.importType ?? null,
          totalRecords: batch?.totalRecords ?? null,
          validRecords: batch?.validRecords ?? null,
          invalidRecords: batch?.invalidRecords ?? null,
          importErrors: batch?.errors ?? null
        };
      })
    });
  })
);

api.get(
  "/exports/:type",
  requirePermission("export:create"),
  asyncHandler(async (req, res) => {
    const type = String(req.params.type);
    const sessionId = String(req.query.sessionId ?? (await activeSessionId()) ?? "");
    if (!sessionId) throw new HttpError(400, "sessionId is required");
    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    if (!session) throw new HttpError(404, "Session not found");

    const [enquiries, families, passengers, matches, requests, auditLogs] = await Promise.all([
      prisma.enquiry.findMany({ where: { sessionId } }),
      prisma.familyRecord.findMany({ where: { sessionId } }),
      prisma.passengerRecord.findMany({ where: { sessionId } }),
      prisma.matchingRecord.findMany({ where: { sessionId } }),
      prisma.welfareRequest.findMany({ where: { sessionId } }),
      prisma.auditLog.findMany({ where: { sessionId }, orderBy: { createdAt: "desc" }, take: 1000 })
    ]);

    await logAudit(req, { action: "export", entityType: "session", entityId: sessionId, sessionId, summary: `Exported ${type} for ${session.operationalId}` });

    if (type === "pdf-session-summary" || type === "aar-draft") {
      const pdf = await pdfSummaryBuffer({
        title: type === "aar-draft" ? "Exercise AAR Draft" : "ZPP Connect Session Summary",
        subtitle: `${session.operationalId} | ${session.mode} | ${session.eventType}`,
        lines: [
          ["Flight", session.flightNumber ?? "N/A"],
          ["Route", session.route ?? "N/A"],
          ["Status", session.status],
          ["Generated", new Date().toISOString()]
        ],
        sections: [
          { title: "Enquiries", rows: enquiries },
          { title: "Family/NOK Records", rows: families },
          { title: "Passenger/Crew Records", rows: passengers },
          { title: "Matching Records", rows: matches },
          { title: "Requests", rows: requests }
        ]
      });
      responseFile(res, `${session.operationalId}-${type}.pdf`, "application/pdf", pdf);
      return;
    }

    const selectedSheets: Record<string, unknown[]> =
      type === "enquiry-log"
        ? { Enquiries: enquiries }
        : type === "family-register"
          ? { FamilyRecords: families }
          : type === "passenger-register"
            ? { PassengerRecords: passengers }
            : type === "matching-log"
              ? { MatchingRecords: matches }
              : type === "requests-log"
                ? { Requests: requests }
                : type === "audit-log"
                  ? { AuditLog: auditLogs }
                  : {
                      Enquiries: enquiries,
                      FamilyRecords: families,
                      PassengerRecords: passengers,
                      MatchingRecords: matches,
                      Requests: requests,
                      AuditLog: auditLogs
                    };
    const workbook = workbookBuffer(selectedSheets);
    responseFile(res, `${session.operationalId}-${type}.csv`, "text/csv; charset=utf-8", workbook);
  })
);

api.get(
  "/exercise/injects",
  requirePermission("exercise:manage"),
  asyncHandler((req, res) => listRecords(req, res, prisma.exerciseInject, ["operationalId", "targetRole", "text"]))
);

api.post(
  "/exercise/injects",
  requirePermission("exercise:manage"),
  asyncHandler(async (req, res) => {
    const body = clean(exerciseInjectSchema.parse(req.body));
    const record = await withOperationalIdRetry(async () => prisma.exerciseInject.create({ data: { ...body, operationalId: await nextOperationalId("exerciseInject", "INJ") } }));
    await logAudit(req, { action: "create_exercise_inject", entityType: "exerciseInject", entityId: record.id, sessionId: record.sessionId, summary: `Exercise inject ${record.operationalId} created` });
    res.status(201).json(record);
  })
);

api.post(
  "/exercise/injects/:id/release",
  requirePermission("exercise:manage"),
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const record = await prisma.exerciseInject.update({ where: { id }, data: { status: "Released", releasedById: actorId(req), releasedAt: new Date() } });
    await logAudit(req, { action: "release_exercise_inject", entityType: "exerciseInject", entityId: id, sessionId: record.sessionId, summary: `Exercise inject ${record.operationalId} released` });
    res.json(record);
  })
);

api.post(
  "/exercise/injects/:id/complete",
  requirePermission("exercise:manage"),
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const record = await prisma.exerciseInject.update({ where: { id }, data: { status: "Completed" } });
    await logAudit(req, { action: "complete_exercise_inject", entityType: "exerciseInject", entityId: id, sessionId: record.sessionId, summary: `Exercise inject ${record.operationalId} completed` });
    res.json(record);
  })
);

api.get(
  "/exercise/observations",
  requirePermission("exercise:manage"),
  asyncHandler((req, res) => listRecords(req, res, prisma.exerciseObservation, ["operationalId", "area", "observation", "recommendation"]))
);

api.post(
  "/exercise/observations",
  requirePermission("exercise:manage"),
  asyncHandler(async (req, res) => {
    const body = clean(exerciseObservationSchema.parse(req.body));
    const record = await withOperationalIdRetry(async () => prisma.exerciseObservation.create({ data: { ...body, operationalId: await nextOperationalId("exerciseObservation", "OBS"), createdById: actorId(req) } }));
    await logAudit(req, { action: "create_exercise_observation", entityType: "exerciseObservation", entityId: record.id, sessionId: record.sessionId, summary: `Exercise observation ${record.operationalId} created` });
    res.status(201).json(record);
  })
);

api.get(
  "/reports/session-summary",
  requirePermission("reports:read"),
  asyncHandler(async (req, res) => {
    const sessionId = String(req.query.sessionId ?? (await activeSessionId()) ?? "");
    if (!sessionId) throw new HttpError(400, "sessionId is required");
    const [session, kpis, holds, urgentRequests] = await Promise.all([
      prisma.session.findUnique({ where: { id: sessionId } }),
      Promise.all([
        prisma.enquiry.count({ where: { sessionId } }),
        prisma.familyRecord.count({ where: { sessionId } }),
        prisma.passengerRecord.count({ where: { sessionId } }),
        prisma.matchingRecord.count({ where: { sessionId } }),
        prisma.welfareRequest.count({ where: { sessionId } })
      ]),
      prisma.matchingRecord.findMany({ where: { sessionId, holdCheck: { not: "No hold" } }, take: 20 }),
      prisma.welfareRequest.findMany({ where: { sessionId, priority: "Urgent", status: { notIn: terminalRequestStatusList } }, take: 20 })
    ]);
    res.json({ session, counts: { enquiries: kpis[0], families: kpis[1], passengers: kpis[2], matches: kpis[3], requests: kpis[4] }, holds, urgentRequests });
  })
);

api.get(
  "/admin/users",
  requirePermission("admin:manage"),
  asyncHandler(async (_req, res) => {
    const users = await prisma.user.findMany({
      orderBy: { email: "asc" },
      include: { organization: true, roles: { include: { role: true } } }
    });
    res.json({ data: users });
  })
);

api.get(
  "/admin/organizations",
  requirePermission("admin:manage"),
  asyncHandler(async (_req, res) => {
    const organizations = await prisma.organization.findMany({ orderBy: [{ status: "asc" }, { name: "asc" }] });
    res.json({ data: organizations });
  })
);

api.post(
  "/admin/organizations",
  requirePermission("admin:manage"),
  asyncHandler(async (req, res) => {
    const body = clean(req.body ?? {});
    const organization = await prisma.organization.create({
      data: {
        key: String(body.key),
        name: String(body.name),
        type: body.type ? String(body.type) : undefined,
        status: body.status ? String(body.status) : "active",
        contactEmail: body.contactEmail ? String(body.contactEmail) : undefined,
        description: body.description ? String(body.description) : undefined
      }
    });
    await logAudit(req, {
      action: "organization_change",
      entityType: "organization",
      entityId: organization.id,
      summary: `Organization ${organization.name} created`
    });
    res.status(201).json(organization);
  })
);

api.patch(
  "/admin/organizations/:id",
  requirePermission("admin:manage"),
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const body = clean(req.body ?? {});
    const organization = await prisma.organization.update({
      where: { id },
      data: {
        key: body.key === undefined ? undefined : String(body.key),
        name: body.name === undefined ? undefined : String(body.name),
        type: body.type === undefined ? undefined : body.type ? String(body.type) : null,
        status: body.status === undefined ? undefined : String(body.status),
        contactEmail: body.contactEmail === undefined ? undefined : body.contactEmail ? String(body.contactEmail) : null,
        description: body.description === undefined ? undefined : body.description ? String(body.description) : null
      }
    });
    await logAudit(req, {
      action: "organization_change",
      entityType: "organization",
      entityId: organization.id,
      summary: `Organization ${organization.name} updated`
    });
    res.json(organization);
  })
);

api.patch(
  "/admin/users/:id/roles",
  requirePermission("admin:manage"),
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const roleNames = Array.isArray(req.body?.roles) ? req.body.roles.map((roleName: unknown) => normalizeRoleName(String(roleName))) : [];
    const roles = await prisma.role.findMany({ where: { name: { in: roleNames } } });
    await prisma.userRole.deleteMany({ where: { userId: id } });
    await prisma.userRole.createMany({ data: roles.map((role) => ({ userId: id, roleId: role.id, assignedBy: req.user?.email })) });
    const user = await prisma.user.findUnique({ where: { id }, include: { organization: true, roles: { include: { role: true } } } });
    await logAudit(req, { action: "role_change", entityType: "user", entityId: id, summary: `Roles changed for ${user?.email}`, metadata: { roles: roleNames } });
    res.json(user);
  })
);

api.get(
  "/admin/roles",
  requirePermission("admin:manage"),
  asyncHandler(async (_req, res) => {
    const roles = await prisma.role.findMany({ orderBy: { displayName: "asc" } });
    res.json({ data: roles });
  })
);

api.get(
  "/admin/dictionaries",
  requirePermission("admin:manage"),
  asyncHandler(async (_req, res) => {
    const dictionaries = await prisma.dictionary.findMany({ orderBy: [{ category: "asc" }, { sortOrder: "asc" }] });
    res.json({ data: dictionaries });
  })
);

api.post(
  "/admin/dictionaries",
  requirePermission("admin:manage"),
  asyncHandler(async (req, res) => {
    const body = clean(req.body ?? {});
    const record = await prisma.dictionary.create({
      data: {
        profile: String(body.profile ?? defaultProfile.id),
        category: String(body.category),
        key: String(body.key),
        label: String(body.label),
        description: body.description ? String(body.description) : undefined,
        sortOrder: Number(body.sortOrder ?? 0),
        isActive: body.isActive === undefined ? true : Boolean(body.isActive),
        metadata: body.metadata
      }
    });
    await logAudit(req, { action: "dictionary_change", entityType: "dictionary", entityId: record.id, summary: `Dictionary ${record.category}/${record.key} created` });
    res.status(201).json(record);
  })
);

export function registerRoutes(app: Express, options: {
  incidentRepository?: IncidentRepository;
  enquiryRepository?: EnquiryRepository;
  incidentAccessRepository?: IncidentAccessRepository;
  incidentAssignmentRepository?: IncidentAssignmentRepository;
  passengerRepository?: PassengerRepository;
} = {}) {
  const usePostgres = config.persistenceMode === "postgres" || options.incidentRepository?.kind === "postgres" || options.enquiryRepository?.kind === "postgres" || options.passengerRepository?.kind === "postgres";
  const incidentRepository = options.incidentRepository ?? (
    usePostgres ? createPrismaIncidentRepository(prisma) : undefined
  );
  const enquiryRepository = options.enquiryRepository ?? (
    usePostgres ? createPrismaEnquiryRepository(prisma) : undefined
  );
  const incidentAccessRepository = options.incidentAccessRepository ?? (
    usePostgres ? createPrismaIncidentAccessRepository(prisma) : undefined
  );
  const incidentAssignmentRepository = options.incidentAssignmentRepository ?? (
    usePostgres ? createPrismaIncidentAssignmentRepository(prisma) : undefined
  );
  const passengerRepository = options.passengerRepository ?? (
    usePostgres ? createPrismaPassengerRepository(prisma) : undefined
  );
  app.use("/api", createDemoRouter({ incidentRepository, enquiryRepository, incidentAccessRepository, incidentAssignmentRepository, passengerRepository }));
}
