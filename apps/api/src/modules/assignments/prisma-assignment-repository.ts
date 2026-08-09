import { Prisma, type PrismaClient } from "@prisma/client";
import { HttpError } from "../../errors.js";
import type { IncidentContext } from "../incident-access/incident-access-types.js";
import type { AssignmentRepository } from "./assignment-repository.js";
import {
  toAssignmentCompatibility,
  type AssignmentActor,
  type AssignmentMutationResult,
  type AssignmentPriority,
  type AssignmentQueueQuery,
  type AssignmentRecord,
  type AssignmentStatus,
} from "./assignment-types.js";

const terminal = new Set<AssignmentStatus>(["Completed", "Cancelled"]);
const include = {
  assignedUser: { select: { id: true, displayName: true } },
  createdBy: { select: { id: true, displayName: true } },
  updatedBy: { select: { id: true, displayName: true } },
  completedBy: { select: { id: true, displayName: true } },
  cancelledBy: { select: { id: true, displayName: true } },
} satisfies Prisma.AssignmentTaskInclude;

function json(value: Record<string, unknown>): Prisma.InputJsonValue {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Prisma.InputJsonObject;
}
function fingerprint(command: string, assignmentId: string | null, values: unknown[]) {
  return JSON.stringify([command, assignmentId, ...values]);
}
function isConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code);
}
function rolePermissions(user: { roles: Array<{ role: { permissions: Prisma.JsonValue } }> }) {
  return new Set(user.roles.flatMap(({ role }) => Array.isArray(role.permissions) ? role.permissions.map(String) : []));
}
function view(row: any, eligibleUsers: Set<string>): AssignmentRecord {
  const status = row.status as AssignmentStatus;
  const assignedUserId = row.assignedUserId ?? null;
  const assigneeEligible = assignedUserId ? eligibleUsers.has(assignedUserId) : null;
  const displayName = row.assignedUser?.displayName ?? row.legacyAssigneeLabel ?? null;
  return {
    ...row,
    incidentId: row.sessionId,
    sessionId: row.sessionId,
    status,
    priority: row.priority as AssignmentPriority,
    assignedUserId,
    assignedUserDisplayName: displayName,
    ownerAssignedTo: displayName,
    assigneeEligible,
    assigneeEligibilityMessage: assignedUserId && !assigneeEligible ? "Assigned user no longer has access to this incident. Reassignment is required." : null,
    overdue: !terminal.has(status) && Boolean(row.dueAt && new Date(row.dueAt).getTime() < Date.now()),
    legacyMetadata: row.legacyMetadata ?? null,
  };
}
async function find(db: PrismaClient | Prisma.TransactionClient, incidentId: string, assignmentId: string) {
  return db.assignmentTask.findFirst({ where: { id: assignmentId, sessionId: incidentId }, include });
}
async function nextOperationalId(tx: Prisma.TransactionClient) {
  const [row] = await tx.$queryRaw<Array<{ value: bigint }>>`SELECT nextval('"AssignmentTask_operational_seq"') AS value`;
  return `ASN-${new Date().getFullYear()}-${String(row!.value).padStart(6, "0")}`;
}
async function eligibleUserIds(db: PrismaClient | Prisma.TransactionClient, incidentId: string, userIds?: string[]) {
  const rows = await db.incidentAssignment.findMany({
    where: {
      incidentId,
      active: true,
      ...(userIds ? { userId: { in: userIds } } : {}),
      user: { status: { in: ["active", "Active"] } },
    },
    select: { userId: true, user: { select: { roles: { select: { role: { select: { permissions: true } } } } } } },
  });
  return new Set(rows.filter(({ user }) => rolePermissions(user).has("assignment:read")).map(({ userId }) => userId));
}
async function assertWritable(tx: Prisma.TransactionClient, context: IncidentContext, actor: AssignmentActor, permission: "assignment:create" | "assignment:update" | "assignment:assign") {
  if (!actor.permissions.includes(permission)) throw new HttpError(403, "Forbidden");
  if (await tx.session.count({ where: { id: context.incidentId, status: { notIn: ["Closed", "Archived"] } } }) !== 1) {
    throw new HttpError(409, "Operational Assignments in a closed incident are read-only");
  }
  if (!context.systemAdminOverride && await tx.incidentAssignment.count({ where: { incidentId: context.incidentId, userId: context.actorId, active: true } }) !== 1) {
    throw new HttpError(404, "Incident not found");
  }
}
async function assertEligibleAssignee(tx: Prisma.TransactionClient, context: IncidentContext, userId: string) {
  const eligible = await eligibleUserIds(tx, context.incidentId, [userId]);
  if (!eligible.has(userId)) throw new HttpError(409, "Assignee must be an active user with incident access and assignment:read");
}
function assertOperator(actor: AssignmentActor, row: any) {
  if (actor.permissions.includes("assignment:assign") || row.assignedUserId === actor.id) return;
  throw new HttpError(403, "Only the current assignee or an assignment manager can change this Operational Assignment");
}
async function audit(
  tx: Prisma.TransactionClient,
  context: IncidentContext,
  actor: AssignmentActor,
  action: string,
  assignment: any,
  summary: string,
  metadata: Record<string, unknown>,
) {
  await tx.auditLog.create({
    data: {
      action,
      entityType: "assignmentTask",
      entityId: assignment.id,
      sessionId: context.incidentId,
      actorId: context.actorId,
      actorEmail: actor.email,
      summary,
      metadata: json({
        assignmentTaskId: assignment.id,
        operationalId: assignment.operationalId,
        resultVersion: assignment.version,
        requestId: actor.requestId,
        ...metadata,
      }),
    },
  });
}
async function timeline(
  tx: Prisma.TransactionClient,
  context: IncidentContext,
  assignment: any,
  title: string,
  body: string | null,
  metadata: Record<string, unknown>,
) {
  await tx.caseTimelineEvent.create({
    data: {
      sessionId: context.incidentId,
      caseId: assignment.caseId,
      eventType: "assignment",
      entityType: "assignmentTask",
      entityId: assignment.id,
      title,
      body,
      metadata: json({ assignmentTaskId: assignment.id, operationalId: assignment.operationalId, status: assignment.status, version: assignment.version, ...metadata }),
      createdById: context.actorId,
    },
  });
}
async function operationRetry(tx: Prisma.TransactionClient, incidentId: string, operationId: string, commandFingerprint: string) {
  const existing = await tx.assignmentOperation.findUnique({ where: { incidentId_operationId: { incidentId, operationId } } });
  if (!existing) return null;
  if (existing.commandFingerprint !== commandFingerprint) throw new HttpError(409, "operationId was already used for a different Operational Assignment command");
  return existing.assignmentTaskId;
}
async function logOperation(
  tx: Prisma.TransactionClient,
  context: IncidentContext,
  actor: AssignmentActor,
  assignmentTaskId: string,
  operationId: string,
  command: string,
  commandFingerprint: string,
  resultVersion: number,
) {
  await tx.assignmentOperation.create({ data: { incidentId: context.incidentId, assignmentTaskId, operationId, command, commandFingerprint, resultVersion, requestId: actor.requestId } });
}

export function createPrismaAssignmentRepository(client: PrismaClient): AssignmentRepository {
  async function result(tx: Prisma.TransactionClient, context: IncidentContext, id: string, idempotent = false): Promise<AssignmentMutationResult> {
    const row = await find(tx, context.incidentId, id);
    if (!row) return { record: null, conflict: false, idempotent };
    const eligible = await eligibleUserIds(tx, context.incidentId, row.assignedUserId ? [row.assignedUserId] : []);
    return { record: view(row, eligible), conflict: false, idempotent };
  }

  async function listQueue(context: IncidentContext, query: AssignmentQueueQuery, actor: AssignmentActor) {
    const now = new Date();
    const where: Prisma.AssignmentTaskWhereInput = { sessionId: context.incidentId };
    if (query.status) where.status = query.status;
    if (query.priority) where.priority = query.priority;
    if (query.mine) where.assignedUserId = actor.id;
    else if (query.unassigned) where.assignedUserId = null;
    else if (query.assignedUserId) where.assignedUserId = query.assignedUserId;
    if (query.relatedFunction) where.relatedFunction = query.relatedFunction;
    if (query.due === "overdue") Object.assign(where, { dueAt: { lt: now }, status: { notIn: ["Completed", "Cancelled"] } });
    if (query.due === "today") {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      where.dueAt = { gte: start, lt: end };
    }
    if (query.due === "due") where.dueAt = { not: null };
    if (query.due === "none") where.dueAt = null;
    if (query.search) where.OR = ["operationalId", "caseId", "title", "details", "legacyAssigneeLabel", "relatedFunction", "linkedRecord"].map((field) => ({ [field]: { contains: query.search, mode: "insensitive" } }));
    const orderBy: Prisma.AssignmentTaskOrderByWithRelationInput = query.sortBy === "assignee"
      ? { assignedUser: { displayName: query.sortDirection } }
      : { [query.sortBy]: query.sortDirection };
    const [total, rows] = await Promise.all([
      client.assignmentTask.count({ where }),
      client.assignmentTask.findMany({ where, include, orderBy: [orderBy, { id: query.sortDirection }], take: query.limit, skip: query.offset }),
    ]);
    const ids = rows.flatMap((row) => row.assignedUserId ? [row.assignedUserId] : []);
    const eligible = await eligibleUserIds(client, context.incidentId, ids);
    return { total, data: rows.map((row) => view(row, eligible)) };
  }

  async function retryableOwnership(
    context: IncidentContext,
    id: string,
    actor: AssignmentActor,
    input: { expectedVersion: number; operationId: string; assignedUserId?: string; reason?: string },
    command: "ASSIGN" | "CLAIM" | "REASSIGN",
  ): Promise<AssignmentMutationResult> {
    const targetUserId = command === "CLAIM" ? actor.id : input.assignedUserId!;
    const fp = fingerprint(command, id, [targetUserId, input.reason ?? null]);
    try {
      return await client.$transaction(async (tx) => {
        await assertWritable(tx, context, actor, command === "CLAIM" ? "assignment:update" : "assignment:assign");
        if (command === "CLAIM" && !actor.permissions.includes("assignment:read")) throw new HttpError(403, "Forbidden");
        const retryId = await operationRetry(tx, context.incidentId, input.operationId, fp);
        if (retryId) return result(tx, context, retryId, true);
        const previous = await find(tx, context.incidentId, id);
        if (!previous) return { record: null, conflict: false };
        const hasOwner = Boolean(previous.assignedUserId || previous.legacyAssigneeLabel);
        const ownershipValid = command === "REASSIGN" ? hasOwner : !hasOwner && previous.status === "Open";
        if (previous.version !== input.expectedVersion || terminal.has(previous.status as AssignmentStatus) || !ownershipValid || previous.assignedUserId === targetUserId) {
          return { record: null, conflict: true };
        }
        await assertEligibleAssignee(tx, context, targetUserId);
        const changed = await tx.assignmentTask.updateMany({
          where: { id, sessionId: context.incidentId, version: input.expectedVersion, assignedUserId: previous.assignedUserId, legacyAssigneeLabel: previous.legacyAssigneeLabel },
          data: { assignedUserId: targetUserId, legacyAssigneeLabel: null, updatedById: actor.id, version: { increment: 1 } },
        });
        if (changed.count !== 1) return { record: null, conflict: true };
        const current = await find(tx, context.incidentId, id);
        if (!current) return { record: null, conflict: true };
        await logOperation(tx, context, actor, id, input.operationId, command, fp, current.version);
        const action = command === "CLAIM" ? "claim_assignment" : command === "ASSIGN" ? "assign_assignment" : "reassign_assignment";
        const verb = command === "CLAIM" ? "claimed" : command === "ASSIGN" ? "assigned" : "reassigned";
        const previousAssigneeDisplayName = previous.assignedUser?.displayName ?? previous.legacyAssigneeLabel ?? null;
        const newAssigneeDisplayName = current.assignedUser?.displayName ?? null;
        const metadata = {
          operationId: input.operationId,
          expectedVersion: input.expectedVersion,
          previousStatus: previous.status,
          newStatus: current.status,
          previousAssigneeId: previous.assignedUserId,
          previousAssigneeLabel: previous.legacyAssigneeLabel,
          previousAssigneeDisplayName,
          newAssigneeId: targetUserId,
          newAssigneeDisplayName,
          reason: input.reason,
        };
        const summary = command === "REASSIGN"
          ? `Assignment ${current.operationalId} reassigned from ${previousAssigneeDisplayName ?? "unresolved owner"} to ${newAssigneeDisplayName}`
          : `Assignment ${current.operationalId} ${verb} ${command === "CLAIM" ? "by" : "to"} ${newAssigneeDisplayName}`;
        await audit(tx, context, actor, action, current, summary, metadata);
        await timeline(tx, context, current, summary, input.reason ?? null, metadata);
        return result(tx, context, id);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (isConflict(error)) return { record: null, conflict: true };
      throw error;
    }
  }

  async function terminalMutation(
    context: IncidentContext,
    id: string,
    actor: AssignmentActor,
    input: { expectedVersion: number; operationId: string; completionNote?: string | null; reason?: string },
    command: "COMPLETE" | "CANCEL",
  ): Promise<AssignmentMutationResult> {
    const fp = fingerprint(command, id, [input.completionNote ?? null, input.reason ?? null]);
    try {
      return await client.$transaction(async (tx) => {
        await assertWritable(tx, context, actor, "assignment:update");
        const retryId = await operationRetry(tx, context.incidentId, input.operationId, fp);
        if (retryId) return result(tx, context, retryId, true);
        const previous = await find(tx, context.incidentId, id);
        if (!previous) return { record: null, conflict: false };
        if (previous.version !== input.expectedVersion || terminal.has(previous.status as AssignmentStatus)) return { record: null, conflict: true };
        assertOperator(actor, previous);
        if (command === "COMPLETE") {
          if (previous.status !== "In Progress" || !previous.assignedUserId) return { record: null, conflict: true };
          await assertEligibleAssignee(tx, context, previous.assignedUserId);
        } else if (!actor.permissions.includes("assignment:assign") && previous.assignedUserId) {
          await assertEligibleAssignee(tx, context, previous.assignedUserId);
        }
        const now = new Date();
        const data: Prisma.AssignmentTaskUncheckedUpdateManyInput = command === "COMPLETE"
          ? { status: "Completed", completedById: actor.id, completedAt: now, completionNote: input.completionNote ?? null }
          : { status: "Cancelled", cancelledById: actor.id, cancelledAt: now, cancelReason: input.reason! };
        const changed = await tx.assignmentTask.updateMany({
          where: { id, sessionId: context.incidentId, version: input.expectedVersion, status: previous.status },
          data: { ...data, updatedById: actor.id, version: { increment: 1 } },
        });
        if (changed.count !== 1) return { record: null, conflict: true };
        const current = await find(tx, context.incidentId, id);
        if (!current) return { record: null, conflict: true };
        await logOperation(tx, context, actor, id, input.operationId, command, fp, current.version);
        const reason = command === "COMPLETE" ? input.completionNote ?? null : input.reason!;
        const metadata = { operationId: input.operationId, expectedVersion: input.expectedVersion, previousStatus: previous.status, newStatus: current.status, previousAssigneeId: previous.assignedUserId, newAssigneeId: current.assignedUserId, reason };
        const verb = command === "COMPLETE" ? "completed" : "cancelled";
        await audit(tx, context, actor, `${verb}_assignment`, current, `Assignment ${current.operationalId} ${verb}`, metadata);
        await timeline(tx, context, current, `Assignment ${current.operationalId} ${verb}`, reason, metadata);
        return result(tx, context, id);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (isConflict(error)) return { record: null, conflict: true };
      throw error;
    }
  }

  return {
    kind: "postgres",
    listQueue,
    async getContext(context, id) {
      const row = await find(client, context.incidentId, id);
      if (!row) return null;
      return view(row, await eligibleUserIds(client, context.incidentId, row.assignedUserId ? [row.assignedUserId] : []));
    },
    async listAssignees(context, search, limit, offset) {
      const rows = await client.incidentAssignment.findMany({
        where: { incidentId: context.incidentId, active: true, user: { status: { in: ["active", "Active"] }, ...(search ? { OR: [{ displayName: { contains: search, mode: "insensitive" } }] } : {}) } },
        select: { user: { select: { id: true, displayName: true, roles: { select: { role: { select: { name: true, permissions: true } } } } } } },
        orderBy: { user: { displayName: "asc" } },
      });
      const data = Array.from(new Map(rows.filter(({ user }) => rolePermissions(user).has("assignment:read")).map(({ user }) => [user.id, { id: user.id, displayName: user.displayName, roles: user.roles.map(({ role }) => role.name), eligible: true }])).values());
      return { total: data.length, data: data.slice(offset, offset + limit) };
    },
    async create(context, input, actor) {
      const fp = fingerprint("CREATE", null, [input.title, input.details ?? null, input.priority, input.dueAt?.toISOString() ?? null, input.caseId ?? null, input.relatedFunction ?? null, input.linkedRecord ?? null]);
      try {
        return await client.$transaction(async (tx) => {
          await assertWritable(tx, context, actor, "assignment:create");
          const retryId = await operationRetry(tx, context.incidentId, input.operationId, fp);
          if (retryId) return result(tx, context, retryId, true);
          const created = await tx.assignmentTask.create({
            data: { sessionId: context.incidentId, operationalId: await nextOperationalId(tx), title: input.title, details: input.details, status: "Open", priority: input.priority, dueAt: input.dueAt, caseId: input.caseId, relatedFunction: input.relatedFunction, linkedRecord: input.linkedRecord, createdById: actor.id, updatedById: actor.id },
            include,
          });
          await logOperation(tx, context, actor, created.id, input.operationId, "CREATE", fp, created.version);
          const metadata = { operationId: input.operationId, expectedVersion: null, previousStatus: null, newStatus: "Open", previousPriority: null, newPriority: created.priority, previousAssigneeId: null, newAssigneeId: null };
          await audit(tx, context, actor, "create_assignment", created, `Assignment ${created.operationalId} created`, metadata);
          await timeline(tx, context, created, `Assignment ${created.operationalId} created`, created.title, metadata);
          return result(tx, context, created.id);
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (isConflict(error)) return { record: null, conflict: true };
        throw error;
      }
    },
    async update(context, id, input, expectedVersion, actor) {
      try {
        return await client.$transaction(async (tx) => {
          await assertWritable(tx, context, actor, "assignment:update");
          const previous = await find(tx, context.incidentId, id);
          if (!previous) return { record: null, conflict: false };
          if (previous.version !== expectedVersion || terminal.has(previous.status as AssignmentStatus)) return { record: null, conflict: true };
          assertOperator(actor, previous);
          const changed = await tx.assignmentTask.updateMany({ where: { id, sessionId: context.incidentId, version: expectedVersion, status: previous.status }, data: { ...input, updatedById: actor.id, version: { increment: 1 } } });
          if (changed.count !== 1) return { record: null, conflict: true };
          const current = await find(tx, context.incidentId, id);
          if (!current) return { record: null, conflict: true };
          await audit(tx, context, actor, "update_assignment", current, `Assignment ${current.operationalId} updated`, { expectedVersion, previousStatus: previous.status, newStatus: current.status, previousAssigneeId: previous.assignedUserId, newAssigneeId: current.assignedUserId, previousPriority: previous.priority, newPriority: current.priority });
          return result(tx, context, id);
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (isConflict(error)) return { record: null, conflict: true };
        throw error;
      }
    },
    async assign(context, id, input, actor) { return retryableOwnership(context, id, actor, input, "ASSIGN"); },
    async claim(context, id, input, actor) { return retryableOwnership(context, id, actor, input, "CLAIM"); },
    async reassign(context, id, input, actor) { return retryableOwnership(context, id, actor, input, "REASSIGN"); },
    async transition(context, id, target, input, actor) {
      try {
        return await client.$transaction(async (tx) => {
          await assertWritable(tx, context, actor, "assignment:update");
          const previous = await find(tx, context.incidentId, id);
          if (!previous) return { record: null, conflict: false };
          const allowed = target === "Escalated" ? ["In Progress"] : previous.status === "Escalated" ? ["Escalated"] : ["Open"];
          if (previous.version !== input.expectedVersion || !allowed.includes(previous.status)) return { record: null, conflict: true };
          assertOperator(actor, previous);
          if (!previous.assignedUserId) return { record: null, conflict: true };
          await assertEligibleAssignee(tx, context, previous.assignedUserId);
          const changed = await tx.assignmentTask.updateMany({ where: { id, sessionId: context.incidentId, version: input.expectedVersion, status: previous.status }, data: { status: target, updatedById: actor.id, version: { increment: 1 } } });
          if (changed.count !== 1) return { record: null, conflict: true };
          const current = await find(tx, context.incidentId, id);
          if (!current) return { record: null, conflict: true };
          const command = target === "Escalated" ? "escalate" : previous.status === "Escalated" ? "resume" : "start";
          const reason = "reason" in input ? input.reason : undefined;
          const metadata = { expectedVersion: input.expectedVersion, previousStatus: previous.status, newStatus: current.status, previousAssigneeId: previous.assignedUserId, newAssigneeId: current.assignedUserId, reason };
          const commandPast = command === "start" ? "started" : command === "escalate" ? "escalated" : "resumed";
          await audit(tx, context, actor, `${command}_assignment`, current, `Assignment ${current.operationalId} ${commandPast}`, metadata);
          await timeline(tx, context, current, `Assignment ${current.operationalId} moved to ${current.status}`, reason ?? null, metadata);
          return result(tx, context, id);
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (isConflict(error)) return { record: null, conflict: true };
        throw error;
      }
    },
    async complete(context, id, input, actor) { return terminalMutation(context, id, actor, input, "COMPLETE"); },
    async cancel(context, id, input, actor) { return terminalMutation(context, id, actor, input, "CANCEL"); },
    async listCompatibility(context, query, actor) {
      const result = await listQueue(context, query, actor);
      return { ...result, data: result.data.map(toAssignmentCompatibility) };
    },
  };
}
