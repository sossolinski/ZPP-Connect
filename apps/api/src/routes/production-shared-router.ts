import type { PrismaClient } from "@prisma/client";
import { defaultProfile, dictionaries, workflowStates } from "@zpp/shared";
import { Router, type Request, type Response } from "express";
import swaggerUi from "swagger-ui-express";
import { asyncHandler, HttpError } from "../errors.js";
import { openApiDocument } from "../openapi.js";
import { requirePermission } from "../rbac.js";
import { redactForUser } from "../redaction.js";
import { listQuery, timelineSchema } from "../validation.js";
import type { IncidentPermissionGate } from "../modules/incident-access/incident-permission-gate.js";

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
type DashboardMatch = { id: string; enquiryId: string | null; passengerRecordId: string | null; familyRecordId: string | null; status: string; holdCheck: string };
type DashboardFamily = { id: string; verificationStatus: string; caseId: string | null; phone: string | null; email: string | null };
type DashboardEnquiry = { id: string; status: string; urgency: string; passengerRecordId: string | null };

const completedMatchStatuses = new Set<string>(workflowStates.completedMatchStatuses);
const pendingMatchStatuses = new Set<string>(workflowStates.pendingMatchStatuses);
const terminalRequestStatuses = new Set<string>(workflowStates.terminalRequestStatuses);
const terminalReleaseStatuses = new Set<string>(workflowStates.terminalReleaseStatuses);
const terminalRequestStatusList = [...terminalRequestStatuses];

function isNoHold(value?: string | null) {
  return !value || value === "No hold";
}

function buildDashboardAggregates(input: {
  passengers: DashboardPassenger[];
  matches: DashboardMatch[];
  families: DashboardFamily[];
  enquiries: DashboardEnquiry[];
  releases: Array<{ status: string; checks: Array<{ type: string; result: string }>; passengerRecord?: { holdStatus: string } | null }>;
  importBatches: Array<{ importType: string; totalRecords: number; invalidRecords: number }>;
  openRequests: number;
  urgentWelfare: number;
}) {
  const matchesByPassenger = new Map<string, DashboardMatch[]>();
  const enquiriesByPassenger = new Map<string, DashboardEnquiry[]>();
  for (const match of input.matches) {
    if (!match.passengerRecordId) continue;
    matchesByPassenger.set(match.passengerRecordId, [...(matchesByPassenger.get(match.passengerRecordId) ?? []), match]);
  }
  for (const enquiry of input.enquiries) {
    if (!enquiry.passengerRecordId) continue;
    enquiriesByPassenger.set(enquiry.passengerRecordId, [...(enquiriesByPassenger.get(enquiry.passengerRecordId) ?? []), enquiry]);
  }

  const matchingProgress = { totalPax: input.passengers.length, done: 0, inReview: 0, onHold: 0, noCandidate: 0, rejectedOnly: 0, completionRate: 0, slices: [] as Array<Record<string, unknown>> };
  let reviewedTotal = 0;
  let readyForRelease = 0;
  for (const passenger of input.passengers) {
    const matches = matchesByPassenger.get(passenger.id) ?? [];
    if (passenger.srcConfirmed || matches.length || (enquiriesByPassenger.get(passenger.id)?.length ?? 0)) reviewedTotal += 1;
    const activeHold = !isNoHold(passenger.holdStatus) || matches.some((match) => !isNoHold(match.holdCheck) || match.status === "Hold / escalate");
    const completed = matches.some((match) => completedMatchStatuses.has(match.status) && isNoHold(match.holdCheck));
    const pending = matches.some((match) => pendingMatchStatuses.has(match.status));
    const rejectedOnly = matches.length > 0 && matches.every((match) => match.status === "Rejected");
    if (matches.some((match) => match.status === "Verified match" && isNoHold(match.holdCheck))) readyForRelease += 1;
    if (completed) matchingProgress.done += 1;
    else if (activeHold) matchingProgress.onHold += 1;
    else if (pending) matchingProgress.inReview += 1;
    else if (rejectedOnly) matchingProgress.rejectedOnly += 1;
    else matchingProgress.noCandidate += 1;
  }
  matchingProgress.completionRate = matchingProgress.totalPax ? Math.round((matchingProgress.done / matchingProgress.totalPax) * 100) : 0;
  matchingProgress.slices = [
    { key: "done", label: "Verified / ready", value: matchingProgress.done, tone: "success", color: "#059669" },
    { key: "inReview", label: "In review", value: matchingProgress.inReview, tone: "info", color: "#2563eb" },
    { key: "onHold", label: "On hold", value: matchingProgress.onHold, tone: "warning", color: "#f59e0b" },
    { key: "noCandidate", label: "No candidate", value: matchingProgress.noCandidate, tone: "neutral", color: "#94a3b8" },
    { key: "rejectedOnly", label: "Rejected only", value: matchingProgress.rejectedOnly, tone: "danger", color: "#dc2626" },
  ];

  const manifestImport = input.importBatches.find((batch) => ["manifest", "passenger"].includes(batch.importType));
  const passengerCount = input.passengers.filter((row) => row.personType === "Passenger").length;
  const crewCount = input.passengers.filter((row) => row.personType === "Crew").length;
  const linkedFamilyIds = new Set(input.matches.flatMap((match) => match.familyRecordId ? [match.familyRecordId] : []));
  return {
    manifestCoverage: {
      expectedTotal: manifestImport?.totalRecords ?? input.passengers.length,
      inDatabaseTotal: input.passengers.length,
      notLoadedTotal: Math.max(0, (manifestImport?.totalRecords ?? input.passengers.length) - input.passengers.length),
      invalidTotal: manifestImport?.invalidRecords ?? 0,
      reviewedTotal,
      notReviewedTotal: Math.max(0, input.passengers.length - reviewedTotal),
      passengersInDatabase: passengerCount,
      crewInDatabase: crewCount,
      unknownTypeInDatabase: Math.max(0, input.passengers.length - passengerCount - crewCount),
      sourceBreakdown: Object.entries(input.passengers.reduce<Record<string, number>>((counts, row) => ({ ...counts, [row.source || "Unknown"]: (counts[row.source || "Unknown"] ?? 0) + 1 }), {})).map(([label, value]) => ({ label, value })),
    },
    matchingProgress,
    workRemaining: {
      noCandidate: matchingProgress.noCandidate,
      pendingMatch: matchingProgress.inReview,
      activeHold: matchingProgress.onHold,
      readyForRelease,
      urgentWelfare: input.urgentWelfare,
      openRequests: input.openRequests,
      unverifiedFamily: input.families.filter((row) => row.verificationStatus !== "Verified").length,
      unlinkedFamily: input.families.filter((row) => !linkedFamilyIds.has(row.id)).length,
      unlinkedEnquiries: input.enquiries.filter((enquiry) => !terminalRequestStatuses.has(enquiry.status) && !input.matches.some((match) => match.enquiryId === enquiry.id || (match.passengerRecordId && match.passengerRecordId === enquiry.passengerRecordId))).length,
    },
    dataQuality: {
      missingCaseId: input.passengers.filter((row) => !row.caseId).length + input.families.filter((row) => !row.caseId).length + input.enquiries.filter((row) => !row.passengerRecordId).length,
      missingDobOrAge: input.passengers.filter((row) => !row.dateOfBirth && !row.age).length,
      missingSeat: input.passengers.filter((row) => row.personType === "Passenger" && !row.seat).length,
      srcPending: input.passengers.filter((row) => !row.srcConfirmed).length,
      unknownCondition: input.passengers.filter((row) => !row.conditionStatus || row.conditionStatus === "Unknown").length,
      familyContactMissing: input.families.filter((row) => !row.phone && !row.email).length,
      openReleaseActions: input.releases.filter((row) => !terminalReleaseStatuses.has(row.status)).length,
      releaseChecklistPending: input.releases.filter((row) => !row.checks.some((check) => check.type === "IDENTITY" && check.result === "PASS") || !row.checks.some((check) => check.type === "HOLD_REVIEW" && check.result === "PASS") || !isNoHold(row.passengerRecord?.holdStatus)).length,
    },
  };
}

async function activeIncidentId(db: PrismaClient) {
  return (await db.session.findFirst({ where: { status: "Active" }, orderBy: { createdAt: "desc" }, select: { id: true } }))?.id ?? "";
}

async function incidentId(req: Request, db: PrismaClient, source: "query" | "body" = "query") {
  const supplied = source === "query" ? req.query.sessionId : req.body?.sessionId;
  return String(supplied ?? await activeIncidentId(db));
}

function dictionaryRows() {
  const grouped: Record<string, Array<Record<string, unknown>>> = {};
  for (const [category, values] of Object.entries(dictionaries)) {
    grouped[category] = values.map((label, sortOrder) => ({
      id: `${category}-${String(label).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}`,
      profile: defaultProfile.id,
      category,
      key: String(label).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""),
      label,
      sortOrder,
      isActive: true,
    }));
  }
  return grouped;
}

export function createPublicProductionRouter() {
  const router = Router();
  router.get("/health", (_req, res) => res.json({ ok: true, service: "zpp-connect-api", persistence: "postgres" }));
  router.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));
  return router;
}

export function createProductionSharedRouter(db: PrismaClient, requireIncidentPermission: IncidentPermissionGate) {
  const router = Router();
  router.get("/config/profile", (_req, res) => res.json(defaultProfile));
  router.get("/dictionaries", (_req, res) => res.json(dictionaryRows()));

  router.get(
    "/dashboard",
    requireIncidentPermission("session:read", (req) => incidentId(req, db)),
    asyncHandler(async (req, res) => {
      const sessionId = await incidentId(req, db);
      const session = await db.session.findUnique({ where: { id: sessionId } });
      if (!session) throw new HttpError(404, "Session not found");
      const permissions = new Set(req.incidentPermissions ?? req.user?.permissions ?? []);
      const canEnquiry = permissions.has("enquiry:read");
      const canFamily = permissions.has("family:read");
      const canPassenger = permissions.has("passenger:read");
      const canMatching = permissions.has("matching:read");
      const canRequest = permissions.has("request:read");
      const canRelease = permissions.has("release:read");
      const canImport = permissions.has("import:create");
      const linkedContext = canEnquiry && canFamily && canPassenger;

      const [enquiries, urgentWelfare] = canEnquiry ? await Promise.all([
        db.enquiry.count({ where: { sessionId } }),
        db.enquiry.count({ where: { sessionId, urgency: "Urgent welfare" } }),
      ]) : [undefined, undefined];
      const familyRecords = canFamily ? await db.familyRecord.count({ where: { sessionId } }) : undefined;
      const passengerRecords = canPassenger ? await db.passengerRecord.count({ where: { sessionId } }) : undefined;
      const [matchingRecords, holds, verified, matchingStatus] = canMatching ? await Promise.all([
        db.matchingRecord.count({ where: { sessionId } }),
        db.matchingRecord.count({ where: { sessionId, holdCheck: { not: "No hold" } } }),
        db.matchingRecord.count({ where: { sessionId, status: { in: ["Verified match", "Reunited", "Released"] } } }),
        db.matchingRecord.groupBy({ by: ["status"], where: { sessionId }, _count: true }),
      ]) : [undefined, undefined, undefined, []];
      const [openRequests, requestStatus] = canRequest ? await Promise.all([
        db.request.count({ where: { incidentId: sessionId, status: { notIn: terminalRequestStatusList } } }),
        db.request.groupBy({ by: ["status"], where: { incidentId: sessionId }, _count: true }),
      ]) : [undefined, []];

      const includeMatching = linkedContext ? { enquiry: true, familyRecord: true, passengerRecord: true } as const : undefined;
      const includeRequest = linkedContext ? { relatedEnquiry: true, relatedFamilyRecord: true, relatedPassengerRecord: true } as const : undefined;
      const [urgentRequests, unresolvedHolds, pendingMatching, unverifiedFamily, unlinkedEnquiries] = await Promise.all([
        canRequest ? db.request.findMany({ where: { incidentId: sessionId, priority: "Urgent", status: { notIn: terminalRequestStatusList } }, include: includeRequest, take: 5, orderBy: { updatedAt: "desc" } }) : [],
        canMatching ? db.matchingRecord.findMany({ where: { sessionId, holdCheck: { not: "No hold" } }, include: includeMatching, take: 5, orderBy: { updatedAt: "desc" } }) : [],
        canMatching ? db.matchingRecord.findMany({ where: { sessionId, status: { in: ["Suggested", "Potential match"] } }, include: includeMatching, take: 5, orderBy: { updatedAt: "desc" } }) : [],
        canFamily ? db.familyRecord.findMany({ where: { sessionId, verificationStatus: { not: "Verified" } }, take: 5, orderBy: { updatedAt: "desc" } }) : [],
        canEnquiry ? db.enquiry.findMany({ where: { sessionId, matches: { none: {} }, status: { not: "Closed" } }, take: 5, orderBy: { updatedAt: "desc" } }) : [],
      ]);
      const name = (first?: unknown, last?: unknown) => [last, first].filter(Boolean).map(String).join(", ");
      const matchingContext = (row: Record<string, any>) => { const { familyRecord, passengerRecord, enquiry, ...rest } = row; return { ...rest, familyOperationalId: familyRecord?.operationalId ?? null, familyName: name(familyRecord?.firstName, familyRecord?.lastName), passengerOperationalId: passengerRecord?.operationalId ?? null, passengerName: name(passengerRecord?.firstName, passengerRecord?.lastName), passengerType: passengerRecord?.personType ?? null, enquiryOperationalId: enquiry?.operationalId ?? null, enquiryCallerName: enquiry?.callerName ?? null, claimedRelationship: familyRecord?.claimedRelationship ?? enquiry?.claimedRelationship ?? null }; };
      const requestContext = (row: Record<string, any>) => { const { relatedFamilyRecord, relatedPassengerRecord, relatedEnquiry, ...rest } = row; return { ...rest, familyOperationalId: relatedFamilyRecord?.operationalId ?? null, familyName: name(relatedFamilyRecord?.firstName, relatedFamilyRecord?.lastName), passengerOperationalId: relatedPassengerRecord?.operationalId ?? null, passengerName: name(relatedPassengerRecord?.firstName, relatedPassengerRecord?.lastName), enquiryOperationalId: relatedEnquiry?.operationalId ?? null, enquiryCallerName: relatedEnquiry?.callerName ?? null }; };

      let aggregates: Record<string, unknown> = {};
      if (canEnquiry && canFamily && canPassenger && canMatching && canRequest && canRelease && canImport) {
        const [passengers, matches, families, enquiryRows, releases, batches] = await Promise.all([
          db.passengerRecord.findMany({ where: { sessionId }, select: { id: true, personType: true, source: true, conditionStatus: true, holdStatus: true, srcConfirmed: true, caseId: true, dateOfBirth: true, age: true, seat: true, manifestVersion: true } }),
          db.matchingRecord.findMany({ where: { sessionId }, select: { id: true, enquiryId: true, passengerRecordId: true, familyRecordId: true, status: true, holdCheck: true } }),
          db.familyRecord.findMany({ where: { sessionId }, select: { id: true, verificationStatus: true, caseId: true, phone: true, email: true } }),
          db.enquiry.findMany({ where: { sessionId }, select: { id: true, status: true, urgency: true, passengerRecordId: true } }),
          db.releaseAction.findMany({ where: { incidentId: sessionId }, select: { status: true, checks: { where: { isCurrent: true }, select: { type: true, result: true } }, passengerRecord: { select: { holdStatus: true } } } }),
          db.importBatch.findMany({ where: { sessionId, importType: { in: ["manifest", "passenger"] } }, select: { importType: true, totalRecords: true, invalidRecords: true }, orderBy: { createdAt: "desc" }, take: 5 }),
        ]);
        aggregates = buildDashboardAggregates({ passengers, matches, families, enquiries: enquiryRows, releases, importBatches: batches, openRequests: openRequests ?? 0, urgentWelfare: urgentWelfare ?? 0 });
      }
      const kpis: Record<string, number> = {};
      if (enquiries !== undefined) Object.assign(kpis, { enquiries, urgentWelfare: urgentWelfare ?? 0 });
      if (familyRecords !== undefined) kpis.familyRecords = familyRecords;
      if (passengerRecords !== undefined) kpis.passengerRecords = passengerRecords;
      if (matchingRecords !== undefined) Object.assign(kpis, { matchingRecords, holds: holds ?? 0, verifiedReunited: verified ?? 0 });
      if (openRequests !== undefined) kpis.openRequests = openRequests;
      res.json(redactForUser(req, {
        session,
        sessionLabel: `${session.mode} ${session.operationalId}`,
        kpis,
        priorityQueue: {
          ...(canRequest ? { urgentRequests: urgentRequests.map(requestContext) } : {}),
          ...(canMatching ? { unresolvedHolds: unresolvedHolds.map(matchingContext), pendingMatching: pendingMatching.map(matchingContext) } : {}),
          ...(canFamily ? { unverifiedFamily: unverifiedFamily.map((row) => ({ ...row, familyName: name(row.firstName, row.lastName), passengerName: name(row.passengerFirstName, row.passengerLastName) })) } : {}),
          ...(canEnquiry ? { unlinkedEnquiries: unlinkedEnquiries.map((row) => ({ ...row, enquiryCallerName: row.callerName, passengerName: name(row.passengerFirstName, row.passengerLastName) })) } : {}),
        },
        status: {
          ...(canRequest ? { requests: Object.fromEntries(requestStatus.map((row) => [row.status, row._count])) } : {}),
          ...(canMatching ? { matching: Object.fromEntries(matchingStatus.map((row) => [row.status, row._count])) } : {}),
        },
        ...aggregates,
      }));
    }),
  );

  router.get(
    "/timeline",
    requireIncidentPermission("timeline:read", (req) => incidentId(req, db)),
    asyncHandler(async (req, res) => {
      const query = listQuery.parse(req.query);
      const sessionId = await incidentId(req, db);
      const where = { sessionId, ...(req.query.caseId ? { caseId: String(req.query.caseId) } : {}) };
      const [total, records] = await Promise.all([
        db.caseTimelineEvent.count({ where }),
        db.caseTimelineEvent.findMany({ where, orderBy: { occurredAt: "desc" }, take: query.limit, skip: query.offset }),
      ]);
      res.json(redactForUser(req, { total, data: records }));
    }),
  );
  router.post(
    "/timeline",
    requireIncidentPermission("timeline:create", (req) => incidentId(req, db, "body"), { requireWritable: true }),
    asyncHandler(async (req, res) => {
      const body = timelineSchema.parse(req.body);
      const manualTypes = new Set(["note", "contact_attempt", "information_received", "operational_update", "handover_note"]);
      if (!manualTypes.has(body.eventType)) throw new HttpError(400, "Manual timeline notes cannot use a protected workflow event type");
      const record = await db.$transaction(async (tx) => {
        const created = await tx.caseTimelineEvent.create({ data: { ...body, entityType: "manualNote", createdById: req.user?.id } });
        await tx.auditLog.create({ data: { action: "create_timeline_event", entityType: "caseTimelineEvent", entityId: created.id, sessionId: created.sessionId, actorId: req.user?.id, actorEmail: req.user?.email, summary: `Timeline event created: ${created.title}`, metadata: { eventType: created.eventType } } });
        return created;
      });
      res.status(201).json(record);
    }),
  );
  router.get(
    "/audit-logs",
    requireIncidentPermission("audit:read", (req) => incidentId(req, db)),
    asyncHandler(async (req, res) => {
      const query = listQuery.parse(req.query);
      const sessionId = await incidentId(req, db);
      const where = { sessionId, ...(req.query.action ? { action: String(req.query.action) } : {}) };
      const [total, records] = await Promise.all([
        db.auditLog.count({ where }),
        db.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, take: query.limit, skip: query.offset, include: { actor: { include: { roles: { include: { role: true } } } } } }),
      ]);
      res.json({ total, data: records.map((record) => ({ ...record, actorDisplayName: record.actor?.displayName ?? record.actorEmail ?? null, actorRoles: record.actor?.roles.map((item) => item.role.displayName || item.role.name) ?? [] })) });
    }),
  );

  return router;
}

export function createDeferredProductionRouter() {
  const router = Router();
  const deferred = (_req: Request, res: Response) => res.status(501).json({
    error: "Admin dictionary management remains an explicitly deferred Foundation domain.",
  });
  router.get("/admin/dictionaries", requirePermission("admin:manage"), deferred);
  router.post("/admin/dictionaries", requirePermission("admin:manage"), deferred);
  return router;
}
