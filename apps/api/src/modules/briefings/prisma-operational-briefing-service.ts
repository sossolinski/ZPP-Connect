import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { ActiveEventError, type ActiveEventActor } from "../../active-event.js";
import { enqueueNotification } from "../notifications/notification-outbox.js";

const briefingInclude = {
  createdBy: { select: { id: true, displayName: true, roles: { include: { role: { select: { name: true, status: true } } } } } },
  updatedBy: { select: { id: true, displayName: true, roles: { include: { role: { select: { name: true, status: true } } } } } },
  publishedBy: { select: { id: true, displayName: true, roles: { include: { role: { select: { name: true, status: true } } } } } },
  confirmedFacts: { orderBy: { sortOrder: "asc" as const } },
  unconfirmedInformation: { orderBy: { sortOrder: "asc" as const } },
  priorities: { orderBy: { sortOrder: "asc" as const } },
  risks: { orderBy: { sortOrder: "asc" as const } },
  coordinationNotes: { orderBy: { sortOrder: "asc" as const } },
} as const;

type BriefingRow = Prisma.OperationalBriefingGetPayload<{ include: typeof briefingInclude }>;
type Tx = Prisma.TransactionClient;
type FailureHooks = {
  beforeAudit?: (operation: "create" | "update" | "publish") => void | Promise<void>;
  beforeOutbox?: () => void | Promise<void>;
};

const terminalAssignments = ["Completed", "Cancelled"];
const priorityStatuses = new Set(["Not started", "In progress", "Completed", "Blocked"]);
const riskSeverities = new Set(["Information", "Attention", "Critical"]);

function fail(status: number, message: string): never {
  throw new ActiveEventError(status, message);
}

function has(actor: ActiveEventActor, permission: string) {
  return actor.permissions.includes(permission);
}

function text(value: unknown, fallback = "") {
  return String(value ?? fallback).trim();
}

function date(value: unknown, field = "Timestamp") {
  if (value === undefined || value === null || value === "") return null;
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) fail(400, `${field} is invalid`);
  return parsed;
}

function requiredVersion(value: unknown) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) fail(400, "Expected version is required");
  return parsed;
}

function iso(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

function safeActor(user: BriefingRow["createdBy"] | null | undefined) {
  if (!user) return null;
  return {
    userId: user.id,
    id: user.id,
    displayName: user.displayName,
    roles: user.roles.filter((assignment) => assignment.role.status === "Active").map((assignment) => assignment.role.name),
  };
}

function serialize(record: BriefingRow) {
  return {
    id: record.id,
    sessionId: record.sessionId,
    revision: record.revision,
    status: record.status,
    title: record.title,
    situationSummary: record.situationSummary,
    overview: record.overview,
    confirmedFacts: record.confirmedFacts.map((item) => ({
      id: item.id,
      statement: item.statement,
      source: item.source,
      sourceResourceType: item.sourceResourceType,
      sourceResourceId: item.sourceResourceId,
      confirmedAt: iso(item.confirmedAt),
      createdAt: item.createdAt.toISOString(),
      createdById: item.createdById,
    })),
    unconfirmedInformation: record.unconfirmedInformation.map((item) => ({
      id: item.id,
      statement: item.statement,
      source: item.source,
      verificationStatus: item.verificationStatus,
      owner: item.owner,
      reviewDueAt: iso(item.reviewDueAt),
      createdAt: item.createdAt.toISOString(),
      createdById: item.createdById,
    })),
    priorities: record.priorities.map((item) => ({
      id: item.id,
      description: item.description,
      order: item.sortOrder,
      status: item.status,
      responsible: item.responsible,
      linkedAssignmentId: item.linkedAssignmentId,
      dueAt: iso(item.dueAt),
    })),
    risks: record.risks.map((item) => ({
      id: item.id,
      description: item.description,
      severity: item.severity,
      owner: item.owner,
      mitigation: item.mitigation,
      status: item.status,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    })),
    coordinationNotes: record.coordinationNotes.map((item) => ({
      id: item.id,
      note: item.note,
      functionName: item.functionName,
      createdAt: item.createdAt.toISOString(),
      createdById: item.createdById,
    })),
    nextUpdateDueAt: iso(record.nextUpdateDueAt),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    createdById: record.createdById,
    updatedById: record.updatedById,
    publishedAt: iso(record.publishedAt),
    publishedById: record.publishedById,
    supersededAt: iso(record.supersededAt),
    version: record.version,
    createdBy: safeActor(record.createdBy),
    updatedBy: safeActor(record.updatedBy),
    publishedBy: safeActor(record.publishedBy),
  };
}

function publicId(sessionId: string, revision: number) {
  return `brf-${sessionId}-r${revision}`;
}

function childId(briefingId: string, kind: string, index: number, requested: unknown, existingIds: Set<string>, inputIds: Set<string>) {
  const supplied = text(requested);
  if (supplied) {
    if (!existingIds.has(supplied)) fail(400, `Unknown ${kind} item id`);
    if (inputIds.has(supplied)) fail(400, `Duplicate ${kind} item id`);
    inputIds.add(supplied);
    return supplied;
  }
  const compatible = `${briefingId}-${kind}-${String(index + 1).padStart(2, "0")}`;
  const id = existingIds.has(compatible) || inputIds.has(compatible) ? `${briefingId}-${kind}-${randomUUID()}` : compatible;
  inputIds.add(id);
  return id;
}

async function lockSession(tx: Tx, sessionId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "Session" WHERE "id" = ${sessionId}::uuid FOR UPDATE`);
  if (!rows.length) fail(404, "Session not found");
  return tx.session.findUniqueOrThrow({ where: { id: sessionId } });
}

async function lockBriefing(tx: Tx, briefingId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "OperationalBriefing" WHERE "id" = ${briefingId} FOR UPDATE`);
  if (!rows.length) fail(404, "Briefing not found");
  return tx.operationalBriefing.findUniqueOrThrow({ where: { id: briefingId }, include: briefingInclude });
}

function writable(status: string) {
  if (["Closed", "Archived"].includes(status)) fail(409, "The selected incident is read-only");
}

async function audit(tx: Tx, actor: ActiveEventActor, data: {
  action: string;
  entityId: string;
  sessionId: string;
  summary: string;
  metadata: Prisma.InputJsonObject;
}) {
  await tx.auditLog.create({ data: {
    action: data.action,
    entityType: "operationalBriefing",
    entityId: data.entityId,
    sessionId: data.sessionId,
    actorId: actor.id,
    actorEmail: actor.email,
    summary: data.summary,
    metadata: data.metadata,
  } });
}

function sectionSnapshot(row: BriefingRow) {
  return {
    title: row.title,
    situationSummary: row.situationSummary,
    overview: row.overview,
    confirmedFacts: row.confirmedFacts.map(({ id, statement, source, sourceResourceType, sourceResourceId, confirmedAt }) => ({ id, statement, source, sourceResourceType, sourceResourceId, confirmedAt: iso(confirmedAt) })),
    unconfirmedInformation: row.unconfirmedInformation.map(({ id, statement, source, verificationStatus, owner, reviewDueAt }) => ({ id, statement, source, verificationStatus, owner, reviewDueAt: iso(reviewDueAt) })),
    priorities: row.priorities.map(({ id, description, sortOrder, status, responsible, linkedAssignmentId, dueAt }) => ({ id, description, sortOrder, status, responsible, linkedAssignmentId, dueAt: iso(dueAt) })),
    risks: row.risks.map(({ id, description, severity, owner, mitigation, status }) => ({ id, description, severity, owner, mitigation, status })),
    coordinationNotes: row.coordinationNotes.map(({ id, note, functionName }) => ({ id, note, functionName })),
    nextUpdateDueAt: iso(row.nextUpdateDueAt),
  };
}

function changedSections(before: ReturnType<typeof sectionSnapshot>, after: ReturnType<typeof sectionSnapshot>) {
  return Object.keys(before).filter((key) => JSON.stringify(before[key as keyof typeof before]) !== JSON.stringify(after[key as keyof typeof after]));
}

function assignmentRelationChanges(before: BriefingRow, after: BriefingRow, timestamp: Date) {
  const old = new Map(before.priorities.map((item) => [item.id, item.linkedAssignmentId]));
  return after.priorities.flatMap((item) => {
    const previous = old.get(item.id) ?? null;
    const next = item.linkedAssignmentId ?? null;
    if (previous === next) return [];
    return [{
      priorityId: item.id,
      oldAssignmentId: previous,
      newAssignmentId: next,
      changeType: !previous && next ? "linked" : previous && !next ? "unlinked" : "changed",
      timestamp: timestamp.toISOString(),
    }];
  });
}

async function withSerializableRetry<T>(client: PrismaClient, operation: (tx: Tx) => Promise<T>) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await client.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      const retryable = error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code);
      if (!retryable || attempt === 4) throw error;
    }
  }
  throw new Error("Unreachable transaction retry state");
}

export function createPrismaOperationalBriefingService(client: PrismaClient, hooks: FailureHooks = {}) {
  async function metadata(briefingId: string) {
    const row = await client.operationalBriefing.findUnique({ where: { id: briefingId }, select: { sessionId: true, status: true } });
    if (!row) fail(404, "Briefing not found");
    return row;
  }

  async function read(briefingId: string) {
    const row = await client.operationalBriefing.findUnique({ where: { id: briefingId }, include: briefingInclude });
    if (!row) fail(404, "Briefing not found");
    return row;
  }

  async function validateAssignments(tx: Tx, actor: ActiveEventActor, sessionId: string, ids: string[], editing: boolean) {
    if (!ids.length) return new Map<string, { id: string; sessionId: string; assignedUserId: string | null }>();
    const unique = [...new Set(ids)];
    const rows = await tx.assignmentTask.findMany({ where: { id: { in: unique } }, select: { id: true, sessionId: true, assignedUserId: true } });
    if (rows.length !== unique.length) fail(400, "Linked assignment does not exist");
    if (rows.some((row) => row.sessionId !== sessionId)) fail(409, "Linked assignment belongs to a different session");
    if (editing) {
      const manager = has(actor, "assignment:assign");
      if (!has(actor, "assignment:read") || rows.some((row) => !manager && row.assignedUserId !== actor.id)) fail(403, "Assignment is not available to link");
    }
    return new Map(rows.map((row) => [row.id, row]));
  }

  function cloneChildren(current: BriefingRow, briefingId: string) {
    return {
      confirmedFacts: { create: current.confirmedFacts.map((item, index) => ({ id: `${briefingId}-fact-${String(index + 1).padStart(2, "0")}`, sortOrder: index + 1, statement: item.statement, source: item.source, sourceResourceType: item.sourceResourceType, sourceResourceId: item.sourceResourceId, confirmedAt: item.confirmedAt, createdAt: item.createdAt, createdById: item.createdById })) },
      unconfirmedInformation: { create: current.unconfirmedInformation.map((item, index) => ({ id: `${briefingId}-unconfirmed-${String(index + 1).padStart(2, "0")}`, sortOrder: index + 1, statement: item.statement, source: item.source, verificationStatus: item.verificationStatus, owner: item.owner, reviewDueAt: item.reviewDueAt, createdAt: item.createdAt, createdById: item.createdById })) },
      priorities: { create: current.priorities.map((item, index) => ({ id: `${briefingId}-priority-${String(index + 1).padStart(2, "0")}`, sortOrder: index + 1, description: item.description, status: item.status, responsible: item.responsible, linkedAssignmentId: item.linkedAssignmentId, dueAt: item.dueAt })) },
      risks: { create: current.risks.map((item, index) => ({ id: `${briefingId}-risk-${String(index + 1).padStart(2, "0")}`, sortOrder: index + 1, description: item.description, severity: item.severity, owner: item.owner, mitigation: item.mitigation, status: item.status, createdAt: item.createdAt, updatedAt: item.updatedAt })) },
      coordinationNotes: { create: current.coordinationNotes.map((item, index) => ({ id: `${briefingId}-note-${String(index + 1).padStart(2, "0")}`, sortOrder: index + 1, note: item.note, functionName: item.functionName, createdAt: item.createdAt, createdById: item.createdById })) },
    };
  }

  async function createDraft(sessionId: string, actor: ActiveEventActor) {
    if (!has(actor, "briefing:create-draft")) fail(403, "Forbidden");
    return withSerializableRetry(client, async (tx) => {
      const session = await lockSession(tx, sessionId);
      writable(session.status);
      const existing = await tx.operationalBriefing.findFirst({ where: { sessionId, status: "Draft" }, include: briefingInclude });
      if (existing) return { briefing: serialize(existing), created: false };
      const aggregate = await tx.operationalBriefing.aggregate({ where: { sessionId }, _max: { revision: true } });
      const revision = (aggregate._max.revision ?? 0) + 1;
      const id = publicId(sessionId, revision);
      const current = await tx.operationalBriefing.findFirst({ where: { sessionId, status: "Published" }, include: briefingInclude });
      const created = await tx.operationalBriefing.create({
        data: {
          id,
          sessionId,
          revision,
          status: "Draft",
          title: current?.title ?? "Draft briefing",
          situationSummary: current?.situationSummary ?? "",
          overview: current?.overview ?? "",
          nextUpdateDueAt: current?.nextUpdateDueAt ?? null,
          version: 1,
          createdById: actor.id,
          updatedById: actor.id,
          ...(current ? cloneChildren(current, id) : {}),
        },
        include: briefingInclude,
      });
      await hooks.beforeAudit?.("create");
      await audit(tx, actor, { action: "briefing_draft_created", entityId: id, sessionId, summary: `Briefing draft revision ${revision} created`, metadata: { briefingId: id, revision } });
      return { briefing: serialize(created), created: true };
    });
  }

  async function updateDraft(briefingId: string, input: Record<string, unknown>, actor: ActiveEventActor) {
    if (!has(actor, "briefing:update-draft")) fail(403, "Forbidden");
    const disallowed = ["status", "sessionId", "revision", "publishedAt", "publishedById", "supersededAt", "createdById", "updatedById"].filter((key) => key in input);
    if (disallowed.length) fail(400, "Briefing status and session fields cannot be changed here");
    const expectedVersion = requiredVersion(input.expectedVersion);
    const security = await metadata(briefingId);
    return client.$transaction(async (tx) => {
      const session = await lockSession(tx, security.sessionId);
      const before = await lockBriefing(tx, briefingId);
      if (before.status !== "Draft") fail(409, "Only draft briefings can be edited");
      if (before.version !== expectedVersion) fail(409, "Briefing has changed. Reload before saving.");
      writable(session.status);
      const timestamp = new Date();

      const normalize = <T extends { id: string }>(source: unknown, existing: T[], kind: string, mapper: (row: Record<string, unknown>, index: number, id: string, previous?: T) => Record<string, unknown> | null) => {
        if (source === undefined) return undefined;
        if (!Array.isArray(source)) fail(400, `${kind} must be an array`);
        const existingById = new Map(existing.map((item) => [item.id, item]));
        const existingIds = new Set(existingById.keys());
        const inputIds = new Set<string>();
        return source.flatMap((raw, index) => {
          const row = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
          const id = childId(briefingId, kind, index, row.id, existingIds, inputIds);
          const mapped = mapper(row, index, id, existingById.get(id));
          return mapped ? [{ id, previous: existingById.get(id), data: mapped }] : [];
        });
      };

      const facts = normalize(input.confirmedFacts, before.confirmedFacts, "fact", (row, index, _id, previous) => {
        const statement = text(row.statement);
        if (!statement) return null;
        return { sortOrder: index + 1, statement, source: text(row.source, "Operational briefing"), sourceResourceType: row.sourceResourceType ? text(row.sourceResourceType) : null, sourceResourceId: row.sourceResourceId ? text(row.sourceResourceId) : null, confirmedAt: date(row.confirmedAt ?? previous?.confirmedAt ?? timestamp) };
      });
      const unconfirmed = normalize(input.unconfirmedInformation, before.unconfirmedInformation, "unconfirmed", (row, index) => {
        const statement = text(row.statement);
        if (!statement) return null;
        return { sortOrder: index + 1, statement, source: text(row.source, "Operational briefing"), verificationStatus: text(row.verificationStatus, "Needs verification"), owner: row.owner ? text(row.owner) : null, reviewDueAt: date(row.reviewDueAt) };
      });
      const priorities = normalize(input.priorities, before.priorities, "priority", (row, index) => {
        const description = text(row.description);
        if (!description) return null;
        const status = text(row.status, "Not started");
        if (!priorityStatuses.has(status)) fail(400, "Priority status is invalid");
        return { sortOrder: index + 1, description, status, responsible: row.responsible ? text(row.responsible) : null, linkedAssignmentId: row.linkedAssignmentId ? text(row.linkedAssignmentId) : null, dueAt: date(row.dueAt) };
      });
      const risks = normalize(input.risks, before.risks, "risk", (row, index) => {
        const description = text(row.description);
        if (!description) return null;
        const severity = text(row.severity, "Attention");
        if (!riskSeverities.has(severity)) fail(400, "Risk severity is invalid");
        return { sortOrder: index + 1, description, severity, owner: row.owner ? text(row.owner) : null, mitigation: row.mitigation ? text(row.mitigation) : null, status: text(row.status, "Open") };
      });
      const notes = normalize(input.coordinationNotes, before.coordinationNotes, "note", (row, index) => {
        const note = text(row.note);
        return note ? { sortOrder: index + 1, note, functionName: row.functionName ? text(row.functionName) : null } : null;
      });

      const linkedIds = (priorities ?? before.priorities.map((item) => ({ data: { linkedAssignmentId: item.linkedAssignmentId } }))).flatMap((item) => item.data.linkedAssignmentId ? [String(item.data.linkedAssignmentId)] : []);
      await validateAssignments(tx, actor, before.sessionId, linkedIds, true);

      const applyChildren = async (delegate: any, rows: Array<{ id: string; previous?: { id: string }; data: Record<string, unknown> }> | undefined, createExtra: (row: { id: string; data: Record<string, unknown> }) => Record<string, unknown> = () => ({})) => {
        if (!rows) return;
        const keep = rows.map((row) => row.id);
        await delegate.deleteMany({ where: { briefingId, ...(keep.length ? { id: { notIn: keep } } : {}) } });
        for (const row of rows) {
          if (row.previous) await delegate.update({ where: { id: row.id }, data: row.data });
          else await delegate.create({ data: { id: row.id, briefingId, ...row.data, ...createExtra(row) } });
        }
      };

      await applyChildren(tx.operationalBriefingFact, facts, () => ({ createdById: actor.id }));
      await applyChildren(tx.operationalBriefingUnconfirmedItem, unconfirmed, () => ({ createdById: actor.id }));
      await applyChildren(tx.operationalBriefingPriority, priorities);
      await applyChildren(tx.operationalBriefingRisk, risks);
      await applyChildren(tx.operationalBriefingCoordinationNote, notes, () => ({ createdById: actor.id }));

      const changed = await tx.operationalBriefing.updateMany({ where: { id: briefingId, status: "Draft", version: expectedVersion }, data: {
        ...(input.title !== undefined ? { title: text(input.title, "Draft briefing") } : {}),
        ...(input.situationSummary !== undefined ? { situationSummary: text(input.situationSummary) } : {}),
        ...(input.overview !== undefined ? { overview: text(input.overview) } : {}),
        ...(input.nextUpdateDueAt !== undefined ? { nextUpdateDueAt: date(input.nextUpdateDueAt) } : {}),
        updatedById: actor.id,
        updatedAt: timestamp,
        version: { increment: 1 },
      } });
      if (changed.count !== 1) fail(409, "Briefing has changed. Reload before saving.");
      const after = await tx.operationalBriefing.findUniqueOrThrow({ where: { id: briefingId }, include: briefingInclude });
      const sections = changedSections(sectionSnapshot(before), sectionSnapshot(after));
      const relations = assignmentRelationChanges(before, after, timestamp);
      await hooks.beforeAudit?.("update");
      await audit(tx, actor, { action: "briefing_draft_updated", entityId: briefingId, sessionId: after.sessionId, summary: `Briefing draft revision ${after.revision} updated`, metadata: { briefingId, revision: after.revision, changedSections: sections } });
      for (const change of relations) {
        const action = change.changeType === "linked" ? "briefing_priority_assignment_linked" : change.changeType === "changed" ? "briefing_priority_assignment_changed" : "briefing_priority_assignment_unlinked";
        await audit(tx, actor, { action, entityId: briefingId, sessionId: after.sessionId, summary: change.changeType === "linked" ? "Assignment linked to briefing priority" : change.changeType === "changed" ? "Assignment link changed on briefing priority" : "Assignment unlinked from briefing priority", metadata: { briefingId, revision: after.revision, ...change } });
      }
      return { briefing: serialize(after), changedSections: sections, assignmentRelationChanges: relations };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async function publishDraft(briefingId: string, expectedVersionInput: unknown, actor: ActiveEventActor) {
    if (!has(actor, "briefing:publish")) fail(403, "Forbidden");
    const expectedVersion = requiredVersion(expectedVersionInput);
    const security = await metadata(briefingId);
    return client.$transaction(async (tx) => {
      const session = await lockSession(tx, security.sessionId);
      const draft = await lockBriefing(tx, briefingId);
      if (draft.status !== "Draft") fail(409, "Only draft briefings can be published");
      if (draft.version !== expectedVersion) fail(409, "Briefing has changed. Reload before saving.");
      writable(session.status);
      if (!text(draft.situationSummary)) fail(400, "Situation summary is required before publishing");
      if (!draft.priorities.length) fail(400, "At least one operational priority is required before publishing");
      await validateAssignments(tx, actor, draft.sessionId, draft.priorities.flatMap((priority) => priority.linkedAssignmentId ? [priority.linkedAssignmentId] : []), false);
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "OperationalBriefing" WHERE "sessionId" = ${draft.sessionId}::uuid AND "status" = 'Published' FOR UPDATE`);
      const previous = await tx.operationalBriefing.findFirst({ where: { sessionId: draft.sessionId, status: "Published" }, include: briefingInclude });
      const timestamp = new Date();
      let superseded: BriefingRow | null = null;
      if (previous) {
        superseded = await tx.operationalBriefing.update({ where: { id: previous.id }, data: { status: "Superseded", supersededAt: timestamp, updatedAt: timestamp, updatedById: actor.id, version: { increment: 1 } }, include: briefingInclude });
      }
      const published = await tx.operationalBriefing.update({ where: { id: briefingId }, data: { status: "Published", publishedAt: timestamp, publishedById: actor.id, updatedAt: timestamp, updatedById: actor.id, version: { increment: 1 } }, include: briefingInclude });
      await hooks.beforeAudit?.("publish");
      await audit(tx, actor, { action: "briefing_published", entityId: briefingId, sessionId: published.sessionId, summary: `Briefing revision ${published.revision} published`, metadata: { briefingId, revision: published.revision, supersededBriefingId: superseded?.id ?? null } });
      if (superseded) await audit(tx, actor, { action: "briefing_superseded", entityId: superseded.id, sessionId: superseded.sessionId, summary: `Briefing revision ${superseded.revision} superseded`, metadata: { briefingId: superseded.id, revision: superseded.revision, replacedByBriefingId: published.id } });
      await tx.caseTimelineEvent.create({ data: { sessionId: published.sessionId, eventType: "briefing", entityType: "operationalBriefing", entityId: published.id, title: `Briefing revision ${published.revision} published`, body: published.title, metadata: { revision: published.revision }, occurredAt: timestamp, createdById: actor.id } });
      await hooks.beforeOutbox?.();
      await enqueueNotification(tx, { eventType: "BRIEFING_PUBLISHED", aggregateType: "briefing", aggregateId: published.id, aggregateVersion: String(published.version), sessionId: published.sessionId, payload: { revision: published.revision, occurredAt: timestamp.toISOString() } });
      return { briefing: serialize(published), superseded: superseded ? serialize(superseded) : null };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async function getBriefing(briefingId: string, actor: ActiveEventActor) {
    if (!has(actor, "briefing:read")) fail(403, "Forbidden");
    const row = await read(briefingId);
    if (row.status !== "Published" && !has(actor, "briefing:read-history")) fail(403, "Forbidden");
    return serialize(row);
  }

  async function getCurrent(sessionId: string, actor: ActiveEventActor) {
    if (!has(actor, "briefing:read")) fail(403, "Forbidden");
    if (!await client.session.findUnique({ where: { id: sessionId }, select: { id: true } })) fail(404, "Session not found");
    const row = await client.operationalBriefing.findFirst({ where: { sessionId, status: "Published" }, include: briefingInclude });
    if (!row) fail(404, "No published briefing");
    return serialize(row);
  }

  async function listRevisions(sessionId: string, actor: ActiveEventActor, query: Record<string, unknown> = {}) {
    if (!has(actor, "briefing:read-history")) fail(403, "Forbidden");
    if (!await client.session.findUnique({ where: { id: sessionId }, select: { id: true } })) fail(404, "Session not found");
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
    const offset = Math.max(0, Number(query.offset) || 0);
    const [total, rows] = await Promise.all([
      client.operationalBriefing.count({ where: { sessionId } }),
      client.operationalBriefing.findMany({ where: { sessionId }, orderBy: { revision: "desc" }, skip: offset, take: limit, include: briefingInclude }),
    ]);
    return { total, limit, offset, data: rows.map(serialize) };
  }

  async function assignmentProjections(row: BriefingRow, actor: ActiveEventActor) {
    const ids = [...new Set(row.priorities.flatMap((priority) => priority.linkedAssignmentId ? [priority.linkedAssignmentId] : []))];
    if (!ids.length) return new Map<string, Record<string, unknown>>();
    try {
      const assignments = await client.assignmentTask.findMany({ where: { id: { in: ids } }, include: { assignedUser: { select: { displayName: true } } } });
      const found = new Map(assignments.map((assignment) => [assignment.id, assignment]));
      return new Map(ids.map((id) => {
        const assignment = found.get(id);
        if (!assignment || assignment.sessionId !== row.sessionId) return [id, { id, accessState: "Missing", contextLabel: "Linked assignment missing" }];
        const available = has(actor, "assignment:read") && (has(actor, "assignment:assign") || assignment.assignedUserId === actor.id);
        if (!available) return [id, { id, accessState: "Restricted", contextLabel: "Assignment details restricted" }];
        const label = assignment.status === "Completed" ? "Linked task completed" : assignment.status === "Cancelled" ? "Linked task needs attention" : ["In Progress", "Escalated"].includes(assignment.status) ? "Linked task in progress" : assignment.status === "Open" ? "Linked task pending" : "Linked task current";
        return [id, { id, operationalId: assignment.operationalId, title: assignment.title, status: assignment.status, priority: assignment.priority, assignedUserId: assignment.assignedUserId, assignedUserDisplayName: assignment.assignedUser?.displayName ?? assignment.legacyAssigneeLabel, dueAt: iso(assignment.dueAt), updatedAt: assignment.updatedAt.toISOString(), accessState: "Available", contextLabel: label, detailHref: `/assignments?assignmentId=${encodeURIComponent(id)}` }];
      }));
    } catch {
      return new Map(ids.map((id) => [id, { id, accessState: "Unavailable", contextLabel: "Assignment details unavailable" }]));
    }
  }

  async function getActiveEvent(sessionId: string, actor: ActiveEventActor) {
    if (!has(actor, "briefing:read")) fail(403, "Forbidden");
    const session = await client.session.findUnique({ where: { id: sessionId } });
    if (!session) fail(404, "Session not found");
    const canSeeDraft = has(actor, "briefing:update-draft") || has(actor, "briefing:create-draft") || has(actor, "briefing:read-history");
    const canSeeHistory = has(actor, "briefing:read-history");
    const [published, draft, history] = await Promise.all([
      client.operationalBriefing.findFirst({ where: { sessionId, status: "Published" }, include: briefingInclude }),
      canSeeDraft ? client.operationalBriefing.findFirst({ where: { sessionId, status: "Draft" }, include: briefingInclude }) : null,
      canSeeHistory ? client.operationalBriefing.findMany({ where: { sessionId }, orderBy: { revision: "desc" }, take: 50, select: { id: true, revision: true, status: true, title: true, updatedAt: true, publishedAt: true, version: true } }) : [],
    ]);
    const metrics: Array<Record<string, unknown>> = [];
    const warnings: string[] = [];
    const metricJobs: Array<Promise<void>> = [];
    const addCount = (permission: string, label: string, href: string, job: () => Promise<number>) => {
      if (!has(actor, permission)) return;
      metricJobs.push(job()
        .then((value) => { metrics.push({ label, value, status: "available", href }); })
        .catch(() => { metrics.push({ label, value: null, status: "unavailable", href }); warnings.push("Unable to load supporting data"); }));
    };
    addCount("assignment:read", "Open assignments", "/assignments", () => client.assignmentTask.count({ where: { sessionId, status: { notIn: terminalAssignments } } }));
    addCount("enquiry:read", "Unresolved TEC enquiries", "/tec-intake", () => client.enquiry.count({ where: { sessionId, status: { notIn: ["Closed", "Cancelled"] } } }));
    addCount("matching:read", "Active holds", "/matching", () => client.matchingRecord.count({ where: { sessionId, OR: [{ status: "Hold / escalate" }, { holdCheck: { not: "No hold" } }] } }));
    addCount("request:read", "Open support requests", "/requests", () => client.request.count({ where: { incidentId: sessionId, status: { notIn: ["RESOLVED", "CANCELLED"] } } }));
    addCount("release:read", "Pending release actions", "/release-control", () => client.releaseAction.count({ where: { incidentId: sessionId, status: { notIn: ["COMPLETED", "CANCELLED"] } } }));
    if (has(actor, "passenger:read") && has(actor, "matching:read")) metricJobs.push(client.passengerRecord.count({ where: { sessionId, matches: { none: { status: { in: ["Verified match", "Reunited", "Released"] } } } } })
      .then((value) => { metrics.push({ label: "Passenger records needing match review", value, status: "available", href: "/passenger-src" }); })
      .catch(() => { metrics.push({ label: "Passenger records needing match review", value: null, status: "unavailable", href: "/passenger-src" }); warnings.push("Unable to load supporting data"); }));
    await Promise.all(metricJobs);
    const metricOrder = ["Open assignments", "Unresolved TEC enquiries", "Active holds", "Open support requests", "Pending release actions", "Passenger records needing match review"];
    metrics.sort((a, b) => metricOrder.indexOf(String(a.label)) - metricOrder.indexOf(String(b.label)));

    let current: Record<string, any> | null = published ? serialize(published) : null;
    if (published && current) {
      const projections = await assignmentProjections(published, actor);
      current = { ...current, priorities: current.priorities.map((priority: Record<string, unknown>) => ({ ...priority, assignment: priority.linkedAssignmentId ? projections.get(String(priority.linkedAssignmentId)) ?? null : null })) };
    }
    const nextActions: Array<Record<string, unknown>> = [];
    if (has(actor, "assignment:read")) {
      const own = await client.assignmentTask.findFirst({ where: { sessionId, assignedUserId: actor.id, status: { notIn: terminalAssignments } }, orderBy: { updatedAt: "desc" } });
      if (own) nextActions.push({ id: `assignment-${own.id}`, title: own.title, detail: `Assignment ${own.operationalId} is ${own.status}.`, href: "/assignments", actionLabel: "Open assignments", source: "Assignment" });
    }
    if (draft && (has(actor, "briefing:update-draft") || has(actor, "briefing:publish"))) nextActions.push({ id: `draft-${draft.id}`, title: "Review draft briefing update", detail: "A draft exists and is not yet published.", href: "/active-event", actionLabel: "Open draft", source: "Briefing" });
    if (published) nextActions.push({ id: `briefing-${published.id}`, title: "Read the current briefing", detail: "Use the published briefing before taking operational work.", href: "/active-event", actionLabel: "Read briefing", source: "Briefing" });
    const readOnly = ["Closed", "Archived"].includes(session.status);
    return {
      session,
      currentBriefing: current,
      draft: canSeeDraft && draft ? { id: draft.id, revision: draft.revision, status: draft.status, title: draft.title, updatedAt: draft.updatedAt.toISOString(), updatedById: draft.updatedById, version: draft.version } : null,
      metrics,
      nextActions,
      permissions: { canReadHistory: canSeeHistory, canCreateDraft: has(actor, "briefing:create-draft") && !readOnly, canUpdateDraft: has(actor, "briefing:update-draft") && Boolean(draft) && !readOnly, canPublish: has(actor, "briefing:publish") && Boolean(draft) && !readOnly },
      history: canSeeHistory ? history.map((item) => ({ ...item, updatedAt: item.updatedAt.toISOString(), publishedAt: iso(item.publishedAt) })) : undefined,
      warnings: [...new Set(warnings)],
    };
  }

  return {
    kind: "postgres" as const,
    securityMetadataForBriefing: metadata,
    getActiveEvent,
    listRevisions,
    getCurrent,
    getBriefing,
    createDraft,
    updateDraft,
    publishDraft,
  };
}

export type PrismaOperationalBriefingService = ReturnType<typeof createPrismaOperationalBriefingService>;
