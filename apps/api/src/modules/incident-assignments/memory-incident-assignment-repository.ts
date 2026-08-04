import { randomUUID } from "node:crypto";
import type { MemoryIncidentAssignment } from "../incident-access/memory-incident-access-repository.js";
import type { IncidentAssignmentRepository } from "./incident-assignment-repository.js";
import type { IncidentAssignmentActor, IncidentAssignmentRecord } from "./incident-assignment-types.js";

type MemoryUser = { id: string; email: string; displayName: string; status?: string };
type Row = Record<string, any>;

export function createMemoryIncidentAssignmentRepository(options: {
  incidents: Row[];
  assignments: MemoryIncidentAssignment[];
  users: MemoryUser[];
  auditLogs: Row[];
  now?: () => string;
}): IncidentAssignmentRepository {
  const now = options.now ?? (() => new Date().toISOString());

  function user(userId: string) {
    return options.users.find((item) => item.id === userId);
  }

  function output(row: MemoryIncidentAssignment): IncidentAssignmentRecord {
    const target = user(row.userId ?? "") ?? options.users.find((item) => item.email.toLowerCase() === row.userEmail.toLowerCase());
    return {
      id: row.id!,
      incidentId: row.incidentId,
      userId: row.userId ?? target?.id ?? "",
      userEmail: row.userEmail,
      userDisplayName: target?.displayName ?? row.userEmail,
      function: row.function ?? null,
      scope: row.scope ?? "OPERATIONAL",
      active: row.active !== false,
      createdAt: row.createdAt!,
      createdById: row.createdById ?? null,
      revokedAt: row.revokedAt ?? null,
      revokedById: row.revokedById ?? null,
      revokeReason: row.revokeReason ?? null,
      updatedAt: row.updatedAt ?? row.createdAt!
    };
  }

  function audit(action: "ASSIGNED" | "REVOKED" | "REACTIVATED", row: MemoryIncidentAssignment, actor: IncidentAssignmentActor, previous: Row | null, reason: string | null) {
    options.auditLogs.unshift({
      id: `aud-memory-${randomUUID()}`,
      action: `incident_assignment_${action.toLowerCase()}`,
      entityType: "incident_assignment",
      entityId: row.id,
      sessionId: row.incidentId,
      actorId: actor.id,
      actorEmail: actor.email,
      summary: `Incident access ${action.toLowerCase()} for user ${row.userId}`,
      metadata: {
        targetUserId: row.userId,
        incidentId: row.incidentId,
        action,
        requestId: actor.requestId ?? null,
        previous,
        next: { active: row.active !== false, scope: row.scope, function: row.function ?? null },
        reason
      },
      createdAt: now()
    });
  }

  for (const row of options.assignments) {
    const timestamp = row.createdAt ?? now();
    row.id ??= randomUUID();
    row.createdAt = timestamp;
    row.updatedAt ??= timestamp;
    row.scope ??= "OPERATIONAL";
    row.active ??= true;
    if (!row.userId) row.userId = options.users.find((item) => item.email.toLowerCase() === row.userEmail.toLowerCase())?.id;
  }

  return {
    kind: "memory",

    async list(incidentId, includeInactive) {
      return options.assignments
        .filter((row) => row.incidentId === incidentId && (includeInactive || row.active !== false))
        .map(output);
    },

    async assign(incidentId, input, actor) {
      const target = user(input.userId);
      if (!options.incidents.some((item) => item.id === incidentId) || !target || target.status === "Suspended" || target.status === "Archived" || target.status === "Pending") {
        return { outcome: "not_found" };
      }
      if (options.assignments.some((row) => row.incidentId === incidentId && row.userId === input.userId)) return { outcome: "conflict" };
      const timestamp = now();
      const row: MemoryIncidentAssignment = {
        id: randomUUID(),
        incidentId,
        userId: target.id,
        userEmail: target.email,
        function: input.function ?? null,
        scope: input.scope ?? "OPERATIONAL",
        active: true,
        createdAt: timestamp,
        createdById: actor.id,
        updatedAt: timestamp
      };
      options.assignments.push(row);
      audit("ASSIGNED", row, actor, null, input.reason ?? null);
      return { outcome: "ok", record: output(row) };
    },

    async revoke(incidentId, assignmentId, reason, actor) {
      const row = options.assignments.find((item) => item.id === assignmentId && item.incidentId === incidentId);
      if (!row) return { outcome: "not_found" };
      if (row.active === false) return { outcome: "conflict" };
      const previous = { active: true, scope: row.scope, function: row.function ?? null };
      row.active = false;
      row.revokedAt = now();
      row.revokedById = actor.id;
      row.revokeReason = reason;
      row.updatedAt = row.revokedAt;
      audit("REVOKED", row, actor, previous, reason);
      return { outcome: "ok", record: output(row) };
    },

    async reactivate(incidentId, assignmentId, reason, actor) {
      const row = options.assignments.find((item) => item.id === assignmentId && item.incidentId === incidentId);
      if (!row) return { outcome: "not_found" };
      if (row.active !== false) return { outcome: "conflict" };
      const previous = {
        active: false,
        scope: row.scope,
        function: row.function ?? null,
        revokedAt: row.revokedAt ?? null,
        revokedById: row.revokedById ?? null,
        revokeReason: row.revokeReason ?? null
      };
      row.active = true;
      row.revokedAt = null;
      row.revokedById = null;
      row.revokeReason = null;
      row.updatedAt = now();
      audit("REACTIVATED", row, actor, previous, reason);
      return { outcome: "ok", record: output(row) };
    }
  };
}
