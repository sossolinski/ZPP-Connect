import { Prisma, type PrismaClient } from "@prisma/client";
import { HttpError } from "../../errors.js";
import type { IncidentRepository } from "./incident-repository.js";
import type {
  IncidentActor,
  IncidentCreateInput,
  IncidentListQuery,
  IncidentRecord,
  IncidentUpdateInput
} from "./incident-types.js";
import { enqueueNotification } from "../notifications/notification-outbox.js";

const terminalStatuses = ["Closed", "Archived"];

async function nextOperationalId(tx: Prisma.TransactionClient) {
  const [row] = await tx.$queryRaw<Array<{ value: bigint }>>`
    SELECT nextval('"Session_operational_seq"') AS value
  `;
  return `SES-${new Date().getFullYear()}-${String(row!.value).padStart(3, "0")}`;
}

function sessionCreateData(input: IncidentCreateInput): Prisma.SessionUncheckedCreateInput {
  return {
    operationalId: "",
    mode: input.mode,
    status: input.status,
    eventType: input.eventType,
    flightNumber: input.flightNumber,
    route: input.route,
    aircraftRegistration: input.aircraftRegistration,
    airportLocation: input.airportLocation,
    description: input.description,
    startAt: input.startAt,
    endAt: input.endAt,
    notes: input.notes
  };
}

function sessionUpdateData(input: IncidentUpdateInput): Prisma.SessionUncheckedUpdateManyInput {
  return {
    mode: input.mode,
    status: input.status,
    eventType: input.eventType,
    flightNumber: input.flightNumber,
    route: input.route,
    aircraftRegistration: input.aircraftRegistration,
    airportLocation: input.airportLocation,
    description: input.description,
    startAt: input.startAt,
    endAt: input.endAt,
    notes: input.notes
  };
}

export function createPrismaIncidentRepository(client: PrismaClient): IncidentRepository {
  async function actorIdForEmail(tx: Prisma.TransactionClient, actor: IncidentActor) {
    const user = await tx.user.findUnique({ where: { email: actor.email.toLowerCase() }, select: { id: true } });
    return user?.id;
  }

  return {
    kind: "postgres",

    async list(query: IncidentListQuery, visibleIncidentIds: string[] | null) {
      const where: Prisma.SessionWhereInput = {
        id: visibleIncidentIds === null ? undefined : { in: visibleIncidentIds },
        status: query.status,
        OR: query.search
          ? ["operationalId", "eventType", "flightNumber", "route", "airportLocation"].map((field) => ({
              [field]: { contains: query.search, mode: "insensitive" }
            }))
          : undefined
      };
      const [total, data] = await Promise.all([
        client.session.count({ where }),
        client.session.findMany({ where, take: query.limit, skip: query.offset, orderBy: { createdAt: "desc" } })
      ]);
      return { total, data: data as IncidentRecord[] };
    },

    async findById(id: string) {
      return (await client.session.findUnique({ where: { id } })) as IncidentRecord | null;
    },

    async findActiveReal(excludingId?: string) {
      return (await client.session.findFirst({
        where: { mode: "REAL", status: "Active", id: excludingId ? { not: excludingId } : undefined }
      })) as IncidentRecord | null;
    },

    async create(input: IncidentCreateInput, actor: IncidentActor) {
      return client.$transaction(async (tx) => {
        const actorId = await actorIdForEmail(tx, actor);
        if (!actorId) throw new HttpError(403, "Authenticated user is not registered in the canonical user directory");
        const data = sessionCreateData(input);
        data.operationalId = await nextOperationalId(tx);
        data.createdById = actorId;
        const record = await tx.session.create({ data });
        const assignment = await tx.incidentAssignment.create({
          data: {
            incidentId: record.id,
            userId: actorId,
            function: "Incident creator",
            scope: "OPERATIONAL",
            createdById: actorId
          }
        });
        await tx.auditLog.create({
          data: {
            action: "incident_assignment_assigned",
            entityType: "incident_assignment",
            entityId: assignment.id,
            sessionId: record.id,
            actorId,
            actorEmail: actor.email,
            summary: `Incident access assigned for user ${actorId}`,
            metadata: {
              targetUserId: actorId,
              incidentId: record.id,
              action: "ASSIGNED",
              requestId: actor.requestId ?? null,
              previous: { exists: false },
              next: { active: true, scope: "OPERATIONAL", function: "Incident creator" },
              reason: "Incident creator auto-assignment"
            }
          }
        });
        await tx.auditLog.create({
          data: {
            action: "create_session",
            entityType: "session",
            entityId: record.id,
            sessionId: record.id,
            actorId,
            actorEmail: actor.email,
            summary: `Session ${record.operationalId} created`
          }
        });
        return record as IncidentRecord;
      });
    },

    async update(id: string, input: IncidentUpdateInput, actor: IncidentActor) {
      return client.$transaction(async (tx) => {
        const actorId = await actorIdForEmail(tx, actor);
        const changed = await tx.session.updateMany({
          where: { id, status: { notIn: terminalStatuses } },
          data: sessionUpdateData(input)
        });
        if (changed.count !== 1) return null;
        const record = await tx.session.findUniqueOrThrow({ where: { id } });
        await tx.auditLog.create({
          data: {
            action: "update_session",
            entityType: "session",
            entityId: id,
            sessionId: id,
            actorId,
            actorEmail: actor.email,
            summary: `Session ${record.operationalId} updated`,
            metadata: input as Prisma.InputJsonValue
          }
        });
        return record as IncidentRecord;
      });
    },

    async close(id: string, notes: string, actor: IncidentActor) {
      return client.$transaction(async (tx) => {
        const actorId = await actorIdForEmail(tx, actor);
        const timestamp = new Date();
        const changed = await tx.session.updateMany({
          where: { id, status: { notIn: terminalStatuses } },
          data: { status: "Closed", endAt: timestamp, notes, closedById: actorId }
        });
        if (changed.count !== 1) return null;
        const record = await tx.session.findUniqueOrThrow({ where: { id } });
        await tx.auditLog.create({
          data: {
            action: "close_session",
            entityType: "session",
            entityId: id,
            sessionId: id,
            actorId,
            actorEmail: actor.email,
            summary: `Session ${record.operationalId} closed`,
            metadata: { status: "Closed", closureNote: notes }
          }
        });
        await tx.caseTimelineEvent.create({
          data: {
            sessionId: id,
            eventType: "session",
            entityType: "session",
            entityId: id,
            title: `Session ${record.operationalId} closed`,
            body: notes,
            metadata: { status: "Closed" },
            createdById: actorId,
            occurredAt: timestamp
          }
        });
        await enqueueNotification(tx, {
          eventType: "SESSION_CLOSED", aggregateType: "session", aggregateId: id,
          aggregateVersion: timestamp.toISOString(), sessionId: id,
          payload: { operationalId: record.operationalId, occurredAt: timestamp.toISOString() },
        });
        return record as IncidentRecord;
      });
    }
  };
}
