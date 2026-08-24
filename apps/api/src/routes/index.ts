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
import { requirePermission } from "../rbac.js";
import {
  exerciseInjectSchema,
  exerciseObservationSchema,
  idParam,
  listQuery,
  sessionCloseSchema,
  sessionSchema,
  timelineSchema
} from "../validation.js";
import { normalizeRow, parseWorkbook, pdfSummaryBuffer, workbookBuffer } from "../exporters.js";
import { resolveStorageKey, storageKeyForFile, upload } from "../storage.js";
import { openApiDocument } from "../openapi.js";
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
import { createPrismaFamilyRepository } from "../modules/families/prisma-family-repository.js";
import type { FamilyRepository } from "../modules/families/family-repository.js";
import { createPrismaMatchingRepository } from "../modules/matching/prisma-matching-repository.js";
import type { MatchingRepository } from "../modules/matching/matching-repository.js";
import { createPrismaReleaseRepository } from "../modules/releases/prisma-release-repository.js";
import type { ReleaseRepository } from "../modules/releases/release-repository.js";
import { createPrismaRequestRepository } from "../modules/requests/prisma-request-repository.js";
import type { RequestRepository } from "../modules/requests/request-repository.js";
import { createPrismaAssignmentRepository } from "../modules/assignments/prisma-assignment-repository.js";
import type { AssignmentRepository } from "../modules/assignments/assignment-repository.js";
import { createPrismaMemberDirectoryRepository } from "../modules/member-directory/prisma-member-directory-repository.js";
import type { FoundationMemberDirectoryRepository } from "../modules/member-directory/member-directory-repository.js";
import { createPrismaRosteringRepository } from "../modules/rostering/prisma-rostering-repository.js";
import type { FoundationRosteringRepository } from "../modules/rostering/rostering-repository.js";
import { createPrismaTrainingRepository } from "../modules/training/prisma-training-repository.js";
import type { FoundationTrainingRepository } from "../modules/training/training-repository.js";
import { createPrismaDocumentRepository } from "../modules/documents/prisma-document-repository.js";
import type { FoundationDocumentRepository } from "../modules/documents/document-repository.js";
import { createPrismaNotificationRepository } from "../modules/notifications/prisma-notification-repository.js";
import type { NotificationRepository } from "../modules/notifications/notification-repository.js";
import { createPersistentNotificationService } from "../modules/notifications/notification-service.js";
import { createNotificationDispatcher } from "../modules/notifications/notification-dispatcher.js";
import { createNotificationProjector } from "../modules/notifications/notification-projector.js";
import { createNotificationRuntime } from "../modules/notifications/notification-runtime.js";
import { logger } from "../logger.js";
import { createIdentityRouter } from "../modules/identity/identity-router.js";
import { EffectiveAccessService } from "../modules/identity/effective-access-service.js";
import { createPrismaOperationalBriefingService, type PrismaOperationalBriefingService } from "../modules/briefings/prisma-operational-briefing-service.js";
import { createPrismaImportService, type PrismaImportService } from "../modules/imports/prisma-import-service.js";
import { createPrismaExportService, type PrismaExportService } from "../modules/exports/prisma-export-service.js";

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
  releases: Array<{ status: string; matchingRecordId: string | null; passengerRecordId: string | null; checks: Array<{ type: string; result: string }>; passengerRecord?: { holdStatus: string } | null }>;
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
    releaseChecklistPending: releases.filter((release) => !release.checks.some((check) => check.type === "IDENTITY" && check.result === "PASS") || !release.checks.some((check) => check.type === "HOLD_REVIEW" && check.result === "PASS") || !isNoHold(release.passengerRecord?.holdStatus)).length
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
          prisma.request.count({ where: { incidentId: sessionId, status: { notIn: terminalRequestStatusList } } }),
          prisma.request.groupBy({ by: ["status"], where: { incidentId: sessionId }, _count: true })
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

    const urgentRequests = canReadRequests ? await prisma.request.findMany({
      where: { incidentId: sessionId, priority: "Urgent", status: { notIn: terminalRequestStatusList } },
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
        prisma.releaseAction.findMany({ where: { incidentId: sessionId }, select: { status: true, matchingRecordId: true, passengerRecordId: true, checks: { where: { isCurrent: true }, select: { type: true, result: true } }, passengerRecord: { select: { holdStatus: true } } } }),
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
  void sessionId;
  void rawRow;
  throw new Error(`Legacy ${type} import is unavailable; use the modular domain importer`);
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
  void req;
  void parsed;
  throw new HttpError(410, "Legacy Request import writes were removed; use RequestService");
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
      prisma.request.findMany({ where: { incidentId: sessionId } }),
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
        prisma.request.count({ where: { incidentId: sessionId } })
      ]),
      prisma.matchingRecord.findMany({ where: { sessionId, holdCheck: { not: "No hold" } }, take: 20 }),
      prisma.request.findMany({ where: { incidentId: sessionId, priority: "Urgent", status: { notIn: terminalRequestStatusList } }, take: 20 })
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
        normalizedKey: String(body.key).trim().toLowerCase(),
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
  familyRepository?: FamilyRepository;
  matchingRepository?: MatchingRepository;
  releaseRepository?: ReleaseRepository;
  requestRepository?: RequestRepository;
  assignmentRepository?: AssignmentRepository;
  memberDirectoryRepository?: FoundationMemberDirectoryRepository;
  rosteringRepository?: FoundationRosteringRepository;
  trainingRepository?: FoundationTrainingRepository;
  trainingClock?: { now(): Date };
  documentRepository?: FoundationDocumentRepository;
  notificationRepository?: NotificationRepository;
  operationalBriefingService?: PrismaOperationalBriefingService;
  importService?: PrismaImportService;
  exportService?: PrismaExportService;
  documentClock?: { now(): Date };
  documentNotificationHook?: (record: Record<string, unknown>) => void;
  assignmentNotificationHook?: (record: Record<string, unknown>, command: string) => void;
  rosteringNotificationHook?: (record: Record<string, unknown>, command: string) => void;
  trainingNotificationHook?: (record: Record<string, unknown>, command: string) => void;
} = {}) {
  const usePostgres = config.persistenceMode === "postgres" || options.incidentRepository?.kind === "postgres" || options.enquiryRepository?.kind === "postgres" || options.passengerRepository?.kind === "postgres" || options.familyRepository?.kind === "postgres" || options.matchingRepository?.kind === "postgres" || options.releaseRepository?.kind === "postgres" || options.requestRepository?.kind === "postgres" || options.assignmentRepository?.kind === "postgres" || options.memberDirectoryRepository?.kind === "postgres" || options.rosteringRepository?.kind === "postgres" || options.trainingRepository?.kind === "postgres" || options.documentRepository?.kind === "postgres" || options.notificationRepository?.kind === "postgres" || options.operationalBriefingService?.kind === "postgres" || options.importService?.kind === "postgres" || options.exportService?.kind === "postgres";
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
  const familyRepository = options.familyRepository ?? (
    usePostgres ? createPrismaFamilyRepository(prisma) : undefined
  );
  const matchingRepository = options.matchingRepository ?? (
    usePostgres ? createPrismaMatchingRepository(prisma) : undefined
  );
  const releaseRepository = options.releaseRepository ?? (
    usePostgres ? createPrismaReleaseRepository(prisma) : undefined
  );
  const requestRepository = options.requestRepository ?? (
    usePostgres ? createPrismaRequestRepository(prisma) : undefined
  );
  const assignmentRepository = options.assignmentRepository ?? (
    usePostgres ? createPrismaAssignmentRepository(prisma) : undefined
  );
  const trainingRepository = options.trainingRepository ?? (
    usePostgres ? createPrismaTrainingRepository(prisma, options.trainingClock) : undefined
  );
  const memberDirectoryRepository = options.memberDirectoryRepository ?? (
    usePostgres ? createPrismaMemberDirectoryRepository(prisma, trainingRepository ? (memberProfileId) => trainingRepository.memberTrainingStatus(memberProfileId, options.trainingClock?.now() ?? new Date()) : undefined) : undefined
  );
  const rosteringRepository = options.rosteringRepository ?? (
    usePostgres ? createPrismaRosteringRepository(prisma) : undefined
  );
  const documentRepository = options.documentRepository ?? (
    usePostgres ? createPrismaDocumentRepository(prisma, options.documentClock) : undefined
  );
  const notificationRepository = options.notificationRepository ?? (usePostgres ? createPrismaNotificationRepository(prisma) : undefined);
  const notificationService = notificationRepository ? createPersistentNotificationService(notificationRepository) : undefined;
  const operationalBriefingService = options.operationalBriefingService ?? (usePostgres ? createPrismaOperationalBriefingService(prisma) : undefined);
  const importService = options.importService ?? (usePostgres ? createPrismaImportService(prisma) : undefined);
  const exportService = options.exportService ?? (usePostgres ? createPrismaExportService(prisma) : undefined);
  if (usePostgres) app.use("/api", createIdentityRouter(prisma));
  app.use("/api", createDemoRouter({ incidentRepository, enquiryRepository, incidentAccessRepository, incidentAssignmentRepository, passengerRepository, familyRepository, matchingRepository, releaseRepository, requestRepository, assignmentRepository, memberDirectoryRepository, rosteringRepository, trainingRepository, trainingClock: options.trainingClock, documentRepository, documentClock: options.documentClock, notificationService, effectiveAccessAuthority: usePostgres ? new EffectiveAccessService(prisma) : undefined, operationalBriefingService, importService, exportService, documentNotificationHook: options.documentNotificationHook, assignmentNotificationHook: options.assignmentNotificationHook, rosteringNotificationHook: options.rosteringNotificationHook, trainingNotificationHook: options.trainingNotificationHook }));
  if (notificationRepository?.kind === "postgres" && trainingRepository && documentRepository) {
    const dispatcher = createNotificationDispatcher(prisma, notificationRepository, { batchSize: config.notificationDispatchBatchSize, logger });
    const projector = createNotificationProjector(prisma, notificationRepository, { training: trainingRepository, documents: documentRepository, batchSize: config.notificationProjectBatchSize, maxRows: config.notificationProjectMaxRows });
    app.locals.notificationRuntime = createNotificationRuntime({ dispatcher, projector, logger, dispatchIntervalMs: config.notificationDispatchIntervalMs, projectIntervalMs: config.notificationProjectIntervalMs });
    app.locals.notificationDispatcher = dispatcher;
    app.locals.notificationProjector = projector;
  }
}
