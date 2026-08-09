import { randomUUID } from "node:crypto";
import { permissionsForRoleNames } from "../../access-control.js";
import { HttpError } from "../../errors.js";
import type { IncidentContext } from "../incident-access/incident-access-types.js";
import type { AssignmentRepository } from "./assignment-repository.js";
import { toAssignmentCompatibility, type AssignmentActor, type AssignmentRecord, type AssignmentStatus } from "./assignment-types.js";

type Row = Record<string, any>;
const terminal = new Set<AssignmentStatus>(["Completed", "Cancelled"]);

export function createMemoryAssignmentRepository(sources: {
  assignments: Row[];
  users: Row[];
  incidentAssignments: Row[];
  auditLogs: Row[];
  timeline: Row[];
  now: () => string;
}): AssignmentRepository {
  let sequence = sources.assignments.length + 1;
  const operations: Row[] = [];
  for (const row of sources.assignments) Object.assign(row, {
    version: Number(row.version ?? 1),
    legacyAssigneeLabel: row.assignedUserId ? null : row.legacyAssigneeLabel ?? row.assignedUserDisplayName ?? row.ownerAssignedTo ?? null,
    legacyImported: Boolean(row.legacyImported ?? true),
  });
  const fp = (command: string, id: string | null, values: unknown[]) => JSON.stringify([command, id, ...values]);
  const find = (context: IncidentContext, id: string) => sources.assignments.find((row) => row.id === id && row.sessionId === context.incidentId) ?? null;
  const user = (id: string | null | undefined) => sources.users.find((item) => item.id === id);
  const userCanRead = (item: Row | undefined) => Boolean(item && ["active", "Active"].includes(String(item.status)) && permissionsForRoleNames(item.roles ?? []).includes("assignment:read"));
  const eligible = (incidentId: string, userId: string | null | undefined) => Boolean(userId && userCanRead(user(userId)) && sources.incidentAssignments.some((item) => item.incidentId === incidentId && item.userId === userId && item.active));
  function view(row: Row): AssignmentRecord {
    const assigned = user(row.assignedUserId);
    const displayName = assigned?.displayName ?? row.legacyAssigneeLabel ?? null;
    const isEligible = row.assignedUserId ? eligible(row.sessionId, row.assignedUserId) : null;
    return {
      ...row,
      incidentId: row.sessionId,
      assignedUser: assigned ? { id: assigned.id, displayName: assigned.displayName } : null,
      completedBy: row.completedById && user(row.completedById) ? { id: row.completedById, displayName: user(row.completedById)!.displayName } : null,
      cancelledBy: row.cancelledById && user(row.cancelledById) ? { id: row.cancelledById, displayName: user(row.cancelledById)!.displayName } : null,
      assignedUserDisplayName: displayName,
      ownerAssignedTo: displayName,
      assigneeEligible: isEligible,
      assigneeEligibilityMessage: row.assignedUserId && !isEligible ? "Assigned user no longer has access to this incident. Reassignment is required." : null,
      overdue: !terminal.has(row.status) && Boolean(row.dueAt && new Date(row.dueAt).getTime() < Date.now()),
    } as AssignmentRecord;
  }
  const mutation = (row: Row | null, conflict = false, idempotent = false) => ({ record: row ? view(row) : null, conflict, idempotent });
  function assertPermission(actor: AssignmentActor, permission: "assignment:create" | "assignment:update" | "assignment:assign") {
    if (!actor.permissions.includes(permission)) throw new HttpError(403, "Forbidden");
  }
  function assertOperator(actor: AssignmentActor, row: Row) {
    if (actor.permissions.includes("assignment:assign") || row.assignedUserId === actor.id) return;
    throw new HttpError(403, "Only the current assignee or an assignment manager can change this Operational Assignment");
  }
  function log(context: IncidentContext, actor: AssignmentActor, row: Row, action: string, summary: string, metadata: Row, withTimeline = true, timelineTitle = summary) {
    sources.auditLogs.unshift({ id: randomUUID(), action, entityType: "assignmentTask", entityId: row.id, sessionId: context.incidentId, actorId: actor.id, actorEmail: actor.email, actorDisplayName: actor.displayName, summary, metadata: { assignmentTaskId: row.id, operationalId: row.operationalId, resultVersion: row.version, requestId: actor.requestId, ...metadata }, createdAt: sources.now() });
    if (withTimeline) sources.timeline.unshift({ id: randomUUID(), sessionId: context.incidentId, caseId: row.caseId ?? null, eventType: "assignment", entityType: "assignmentTask", entityId: row.id, title: timelineTitle, body: metadata.reason ?? null, metadata, createdById: actor.id, occurredAt: sources.now(), createdAt: sources.now() });
  }
  function retry(context: IncidentContext, operationId: string, fingerprint: string) {
    const existing = operations.find((item) => item.incidentId === context.incidentId && item.operationId === operationId);
    if (!existing) return null;
    if (existing.commandFingerprint !== fingerprint) throw new HttpError(409, "operationId was already used for a different Operational Assignment command");
    return find(context, existing.assignmentTaskId);
  }
  function addOperation(context: IncidentContext, actor: AssignmentActor, row: Row, operationId: string, command: string, fingerprint: string) {
    operations.push({ id: randomUUID(), incidentId: context.incidentId, assignmentTaskId: row.id, operationId, command, commandFingerprint: fingerprint, resultVersion: row.version, requestId: actor.requestId, createdAt: sources.now() });
  }
  function change(context: IncidentContext, id: string, expectedVersion: number, actor: AssignmentActor, data: Row, action: string, metadata: Row, allowed: AssignmentStatus[], withTimeline = true, timelineTitle?: string) {
    const row = find(context, id);
    if (!row) return mutation(null);
    if (row.version !== expectedVersion || !allowed.includes(row.status)) return mutation(null, true);
    const previous = { status: row.status, assignedUserId: row.assignedUserId ?? null, priority: row.priority };
    Object.assign(row, data, { version: row.version + 1, updatedById: actor.id, updatedAt: sources.now() });
    log(context, actor, row, action, `Assignment ${row.operationalId}: ${action.replaceAll("_", " ")}`, { expectedVersion, previousStatus: previous.status, newStatus: row.status, previousAssigneeId: previous.assignedUserId, newAssigneeId: row.assignedUserId ?? null, previousPriority: previous.priority, newPriority: row.priority, ...metadata }, withTimeline, timelineTitle);
    return mutation(row);
  }
  function ownership(context: IncidentContext, id: string, input: Row, actor: AssignmentActor, command: "ASSIGN" | "CLAIM" | "REASSIGN") {
    assertPermission(actor, command === "CLAIM" ? "assignment:update" : "assignment:assign");
    const target = command === "CLAIM" ? actor.id : input.assignedUserId;
    const fingerprint = fp(command, id, [target, input.reason ?? null]);
    const repeated = retry(context, input.operationId, fingerprint);
    if (repeated) return mutation(repeated, false, true);
    const row = find(context, id);
    if (!row) return mutation(null);
    const hasOwner = Boolean(row.assignedUserId || row.legacyAssigneeLabel);
    if (row.version !== input.expectedVersion || terminal.has(row.status) || (command === "REASSIGN" ? !hasOwner : hasOwner || row.status !== "Open") || row.assignedUserId === target) return mutation(null, true);
    if (!eligible(context.incidentId, target)) throw new HttpError(409, "Assignee must be an active user with incident access and assignment:read");
    const previousAssigneeId = row.assignedUserId ?? null;
    const previousAssigneeDisplayName = user(previousAssigneeId)?.displayName ?? row.legacyAssigneeLabel ?? null;
    Object.assign(row, { assignedUserId: target, legacyAssigneeLabel: null, version: row.version + 1, updatedById: actor.id, updatedAt: sources.now() });
    addOperation(context, actor, row, input.operationId, command, fingerprint);
    const verb = command === "CLAIM" ? "claimed" : command === "ASSIGN" ? "assigned" : "reassigned";
    const newAssigneeDisplayName = user(target)?.displayName ?? null;
    const summary = command === "REASSIGN"
      ? `Assignment ${row.operationalId} reassigned from ${previousAssigneeDisplayName ?? "unresolved owner"} to ${newAssigneeDisplayName}`
      : `Assignment ${row.operationalId} ${verb} ${command === "CLAIM" ? "by" : "to"} ${newAssigneeDisplayName}`;
    log(context, actor, row, `${command.toLowerCase()}_assignment`, summary, { operationId: input.operationId, expectedVersion: input.expectedVersion, previousStatus: row.status, newStatus: row.status, previousAssigneeId, previousAssigneeDisplayName, newAssigneeId: target, newAssigneeDisplayName, reason: input.reason });
    return mutation(row);
  }
  function finish(context: IncidentContext, id: string, input: Row, actor: AssignmentActor, command: "COMPLETE" | "CANCEL") {
    assertPermission(actor, "assignment:update");
    const fingerprint = fp(command, id, [input.completionNote ?? null, input.reason ?? null]);
    const repeated = retry(context, input.operationId, fingerprint);
    if (repeated) return mutation(repeated, false, true);
    const row = find(context, id);
    if (!row) return mutation(null);
    if (row.version !== input.expectedVersion || terminal.has(row.status)) return mutation(null, true);
    assertOperator(actor, row);
    if (command === "COMPLETE" && (row.status !== "In Progress" || !row.assignedUserId || !eligible(context.incidentId, row.assignedUserId))) return mutation(null, true);
    const previousStatus = row.status;
    const stamp = sources.now();
    Object.assign(row, command === "COMPLETE" ? { status: "Completed", completedById: actor.id, completedAt: stamp, completionNote: input.completionNote ?? null } : { status: "Cancelled", cancelledById: actor.id, cancelledAt: stamp, cancelReason: input.reason }, { version: row.version + 1, updatedById: actor.id, updatedAt: stamp });
    addOperation(context, actor, row, input.operationId, command, fingerprint);
    const verb = command === "COMPLETE" ? "completed" : "cancelled";
    log(context, actor, row, `${verb}_assignment`, `Assignment ${row.operationalId} ${verb}`, { operationId: input.operationId, expectedVersion: input.expectedVersion, previousStatus, newStatus: row.status, previousAssigneeId: row.assignedUserId ?? null, newAssigneeId: row.assignedUserId ?? null, reason: input.completionNote ?? input.reason });
    return mutation(row);
  }

  async function listQueue(context: IncidentContext, query: Parameters<AssignmentRepository["listQueue"]>[1], actor: AssignmentActor) {
    const needle = query.search?.toLowerCase();
    const direction = query.sortDirection === "asc" ? 1 : -1;
    const rows = sources.assignments
      .filter((row) => row.sessionId === context.incidentId)
      .filter((row) => !query.status || row.status === query.status)
      .filter((row) => !query.priority || row.priority === query.priority)
      .filter((row) => query.mine ? row.assignedUserId === actor.id : query.unassigned ? !row.assignedUserId : !query.assignedUserId || row.assignedUserId === query.assignedUserId)
      .filter((row) => !query.relatedFunction || row.relatedFunction === query.relatedFunction)
      .filter((row) => {
        if (query.due === "overdue") return row.dueAt && new Date(row.dueAt).getTime() < Date.now() && !terminal.has(row.status);
        if (query.due === "today") {
          if (!row.dueAt) return false;
          const due = new Date(row.dueAt);
          const today = new Date();
          return due.getFullYear() === today.getFullYear() && due.getMonth() === today.getMonth() && due.getDate() === today.getDate();
        }
        if (query.due === "due") return Boolean(row.dueAt);
        if (query.due === "none") return !row.dueAt;
        return true;
      })
      .filter((row) => !needle || [row.operationalId, row.caseId, row.title, row.details, row.legacyAssigneeLabel, row.relatedFunction, row.linkedRecord].some((value) => String(value ?? "").toLowerCase().includes(needle)))
      .sort((left, right) => String(query.sortBy === "assignee" ? left.assignedUserId ?? left.legacyAssigneeLabel ?? "" : left[query.sortBy] ?? "").localeCompare(String(query.sortBy === "assignee" ? right.assignedUserId ?? right.legacyAssigneeLabel ?? "" : right[query.sortBy] ?? "")) * direction);
    return { total: rows.length, data: rows.slice(query.offset, query.offset + query.limit).map(view) };
  }

  return {
    kind: "memory",
    listQueue,
    async getContext(context, id) { const row = find(context, id); return row ? view(row) : null; },
    async listAssignees(context, search, limit, offset) {
      const needle = search?.toLowerCase();
      const data = Array.from(new Set(sources.incidentAssignments.filter((item) => item.incidentId === context.incidentId && item.active).map((item) => item.userId)))
        .map((id) => user(id)).filter((item): item is Row => Boolean(item && userCanRead(item) && (!needle || String(item.displayName).toLowerCase().includes(needle))))
        .sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)))
        .map((item) => ({ id: item.id, displayName: item.displayName, roles: item.roles ?? [], eligible: true }));
      return { total: data.length, data: data.slice(offset, offset + limit) };
    },
    async create(context, input, actor) {
      assertPermission(actor, "assignment:create");
      const fingerprint = fp("CREATE", null, [input.title, input.details ?? null, input.priority, input.dueAt?.toISOString() ?? null, input.caseId ?? null, input.relatedFunction ?? null, input.linkedRecord ?? null]);
      const repeated = retry(context, input.operationId, fingerprint);
      if (repeated) return mutation(repeated, false, true);
      const stamp = sources.now();
      const row = { id: randomUUID(), operationalId: `ASN-${new Date().getFullYear()}-${String(sequence++).padStart(6, "0")}`, sessionId: context.incidentId, title: input.title, details: input.details ?? null, status: "Open", priority: input.priority, assignedUserId: null, legacyAssigneeLabel: null, relatedFunction: input.relatedFunction ?? null, linkedRecord: input.linkedRecord ?? null, caseId: input.caseId ?? null, dueAt: input.dueAt ?? null, version: 1, legacyImported: false, createdById: actor.id, updatedById: actor.id, createdAt: stamp, updatedAt: stamp };
      sources.assignments.unshift(row);
      addOperation(context, actor, row, input.operationId, "CREATE", fingerprint);
      log(context, actor, row, "create_assignment", `Assignment ${row.operationalId} created`, { operationId: input.operationId, expectedVersion: null, previousStatus: null, newStatus: "Open", previousAssigneeId: null, newAssigneeId: null });
      return mutation(row);
    },
    async update(context, id, input, expectedVersion, actor) {
      assertPermission(actor, "assignment:update");
      const row = find(context, id);
      if (row) assertOperator(actor, row);
      return change(context, id, expectedVersion, actor, input, "update_assignment", {}, ["Open", "In Progress", "Escalated"], false);
    },
    async assign(context, id, input, actor) { return ownership(context, id, input, actor, "ASSIGN"); },
    async claim(context, id, input, actor) { return ownership(context, id, input, actor, "CLAIM"); },
    async reassign(context, id, input, actor) { return ownership(context, id, input, actor, "REASSIGN"); },
    async transition(context, id, target, input, actor) {
      assertPermission(actor, "assignment:update");
      const row = find(context, id);
      if (!row) return mutation(null);
      assertOperator(actor, row);
      if (!row.assignedUserId || !eligible(context.incidentId, row.assignedUserId)) return mutation(null, true);
      const allowed: AssignmentStatus[] = target === "Escalated" ? ["In Progress"] : row.status === "Escalated" ? ["Escalated"] : ["Open"];
      const command = target === "Escalated" ? "escalate" : row.status === "Escalated" ? "resume" : "start";
      return change(context, id, input.expectedVersion, actor, { status: target }, `${command}_assignment`, { reason: "reason" in input ? input.reason : undefined }, allowed, true, `Assignment ${row.operationalId} moved to ${target}`);
    },
    async complete(context, id, input, actor) { return finish(context, id, input, actor, "COMPLETE"); },
    async cancel(context, id, input, actor) { return finish(context, id, input, actor, "CANCEL"); },
    async listCompatibility(context, query, actor) { const result = await listQueue(context, query, actor); return { ...result, data: result.data.map(toAssignmentCompatibility) }; },
  };
}
