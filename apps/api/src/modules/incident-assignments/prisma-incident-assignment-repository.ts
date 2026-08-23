import { Prisma, type PrismaClient } from "@prisma/client";
import type { IncidentAssignmentRepository } from "./incident-assignment-repository.js";
import type { IncidentAssignmentActor, IncidentAssignmentRecord } from "./incident-assignment-types.js";

const withUser = { user: { select: { email: true, displayName: true } } } as const;

type AssignmentWithUser = Prisma.IncidentAssignmentGetPayload<{ include: typeof withUser }>;

function record(row: AssignmentWithUser): IncidentAssignmentRecord {
  return {
    id: row.id,
    incidentId: row.incidentId,
    userId: row.userId,
    userEmail: row.user.email,
    userDisplayName: row.user.displayName,
    function: row.function,
    scope: row.scope,
    active: row.active,
    createdAt: row.createdAt,
    createdById: row.createdById,
    revokedAt: row.revokedAt,
    revokedById: row.revokedById,
    revokeReason: row.revokeReason,
    updatedAt: row.updatedAt
  };
}

export function createPrismaIncidentAssignmentRepository(client: PrismaClient): IncidentAssignmentRepository {
  async function actorId(tx: Prisma.TransactionClient, actor: IncidentAssignmentActor) {
    const user = await tx.user.findUnique({ where: { id: actor.id }, select: { id: true } });
    return user?.id ?? null;
  }

  async function audit(
    tx: Prisma.TransactionClient,
    action: "ASSIGNED" | "REVOKED" | "REACTIVATED",
    assignment: AssignmentWithUser,
    actor: IncidentAssignmentActor,
    actingUserId: string | null,
    metadata: Prisma.InputJsonObject
  ) {
    await tx.auditLog.create({
      data: {
        action: `incident_assignment_${action.toLowerCase()}`,
        entityType: "incident_assignment",
        entityId: assignment.id,
        sessionId: assignment.incidentId,
        actorId: actingUserId,
        actorEmail: actor.email,
        summary: `Incident access ${action.toLowerCase()} for user ${assignment.userId}`,
        metadata: {
          targetUserId: assignment.userId,
          incidentId: assignment.incidentId,
          action,
          requestId: actor.requestId ?? null,
          ...metadata
        }
      }
    });
  }

  return {
    kind: "postgres",

    async list(incidentId, includeInactive) {
      const rows = await client.incidentAssignment.findMany({
        where: { incidentId, active: includeInactive ? undefined : true },
        include: withUser,
        orderBy: [{ active: "desc" }, { createdAt: "asc" }]
      });
      return rows.map(record);
    },

    async assign(incidentId, input, actor) {
      return client.$transaction(async (tx) => {
        const [incident, target, existing, actingUserId] = await Promise.all([
          tx.session.findUnique({ where: { id: incidentId }, select: { id: true } }),
          tx.user.findFirst({ where: { id: input.userId, status: "Active" }, select: { id: true } }),
          tx.incidentAssignment.findUnique({
            where: { incidentId_userId: { incidentId, userId: input.userId } },
            select: { id: true }
          }),
          actorId(tx, actor)
        ]);
        if (!incident || !target) return { outcome: "not_found" } as const;
        if (existing) return { outcome: "conflict" } as const;
        const created = await tx.incidentAssignment.create({
          data: {
            incidentId,
            userId: input.userId,
            function: input.function,
            scope: input.scope ?? "OPERATIONAL",
            createdById: actingUserId
          },
          include: withUser
        });
        await audit(tx, "ASSIGNED", created, actor, actingUserId, {
          previous: { exists: false },
          next: { active: true, scope: created.scope, function: created.function },
          reason: input.reason ?? null
        });
        return { outcome: "ok", record: record(created) } as const;
      });
    },

    async revoke(incidentId, assignmentId, reason, actor) {
      return client.$transaction(async (tx) => {
        const previous = await tx.incidentAssignment.findFirst({ where: { id: assignmentId, incidentId }, include: withUser });
        if (!previous) return { outcome: "not_found" } as const;
        if (!previous.active) return { outcome: "conflict" } as const;
        const actingUserId = await actorId(tx, actor);
        const changed = await tx.incidentAssignment.updateMany({
          where: { id: assignmentId, incidentId, active: true },
          data: { active: false, revokedAt: new Date(), revokedById: actingUserId, revokeReason: reason }
        });
        if (changed.count !== 1) return { outcome: "conflict" } as const;
        const updated = await tx.incidentAssignment.findUniqueOrThrow({ where: { id: assignmentId }, include: withUser });
        await audit(tx, "REVOKED", updated, actor, actingUserId, {
          previous: { active: true, scope: previous.scope, function: previous.function },
          next: { active: false, scope: updated.scope, function: updated.function },
          reason
        });
        return { outcome: "ok", record: record(updated) } as const;
      });
    },

    async reactivate(incidentId, assignmentId, reason, actor) {
      return client.$transaction(async (tx) => {
        const previous = await tx.incidentAssignment.findFirst({ where: { id: assignmentId, incidentId }, include: withUser });
        if (!previous) return { outcome: "not_found" } as const;
        if (previous.active) return { outcome: "conflict" } as const;
        const actingUserId = await actorId(tx, actor);
        const changed = await tx.incidentAssignment.updateMany({
          where: { id: assignmentId, incidentId, active: false },
          data: { active: true, revokedAt: null, revokedById: null, revokeReason: null }
        });
        if (changed.count !== 1) return { outcome: "conflict" } as const;
        const updated = await tx.incidentAssignment.findUniqueOrThrow({ where: { id: assignmentId }, include: withUser });
        await audit(tx, "REACTIVATED", updated, actor, actingUserId, {
          previous: {
            active: false,
            scope: previous.scope,
            function: previous.function,
            revokedAt: previous.revokedAt?.toISOString() ?? null,
            revokedById: previous.revokedById,
            revokeReason: previous.revokeReason
          },
          next: { active: true, scope: updated.scope, function: updated.function },
          reason
        });
        return { outcome: "ok", record: record(updated) } as const;
      });
    }
  };
}
