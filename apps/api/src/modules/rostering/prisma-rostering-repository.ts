import { Prisma, type PrismaClient } from "@prisma/client";
import { HttpError } from "../../errors.js";
import { permissionScope } from "../../scope-policy.js";
import type { DirectoryActor as LegacyDirectoryActor } from "../../member-directory.js";
import type { IncidentContext } from "../incident-access/incident-access-types.js";
import type { FoundationRosteringRepository } from "./rostering-repository.js";
import { enqueueNotification } from "../notifications/notification-outbox.js";
import type {
  AvailabilityAccess,
  AvailabilityRecord,
  AvailabilityType,
  MemberSummary,
  MutationResult,
  RosterAccess,
  RosterShiftRecord,
  RosterStatus,
  RosteringActor,
} from "./rostering-types.js";

const activeRosterStatuses: RosterStatus[] = ["Draft", "Published", "Confirmed"];
const terminalRosterStatuses: RosterStatus[] = ["Cancelled", "Completed"];
const rosterInclude = {
  group: true,
  assignedMemberProfile: true,
} satisfies Prisma.RosterShiftInclude;
const availabilityInclude = { memberProfile: true } satisfies Prisma.AvailabilityInclude;

function json(value: Record<string, unknown>): Prisma.InputJsonValue {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Prisma.InputJsonObject;
}

function fingerprint(command: string, target: string | null, values: unknown[]) {
  return JSON.stringify([command, target, ...values]);
}

function isConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && (["P2002", "P2034"].includes(error.code) || (error.code === "P2010" && (error.meta as { code?: string } | undefined)?.code === "40001"));
}

function isSerializationFailure(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && (error.code === "P2034" || (error.code === "P2010" && (error.meta as { code?: string } | undefined)?.code === "40001"));
}

async function serializable<T>(client: PrismaClient, operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= 64; attempt += 1) {
    try {
      return await client.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (!isSerializationFailure(error) || attempt === 64) throw error;
    }
  }
  throw new Error("Serializable transaction retry limit reached");
}

function memberSummary(member: any): MemberSummary {
  return {
    id: member.id,
    memberId: member.memberId,
    linkedUserId: member.linkedUserId ?? null,
    displayName: `${member.firstName} ${member.lastName}`.trim(),
    pool: member.pool,
    role: member.role,
    assignedFunction: member.assignedFunction,
    status: member.status,
  };
}

function groupSummary(group: any) {
  return {
    id: group.id,
    operationalId: group.operationalId,
    incidentId: group.incidentId,
    name: group.name,
    pool: group.pool,
    functionName: group.functionName,
    status: group.status,
  };
}

function overlaps(left: { startAt: Date; endAt: Date }, right: { startAt: Date; endAt: Date }) {
  return left.startAt.getTime() < right.endAt.getTime() && left.endAt.getTime() > right.startAt.getTime();
}

function rosterWhere(access: RosterAccess): Prisma.RosterShiftWhereInput {
  if (access.global) return {};
  const OR: Prisma.RosterShiftWhereInput[] = [];
  if (access.groupIds.length) OR.push({ groupId: { in: access.groupIds } });
  if (access.ownMemberProfileId) OR.push({ assignedMemberProfileId: access.ownMemberProfileId });
  return OR.length ? { OR } : { id: "__forbidden__" };
}

function availabilityWhere(access: AvailabilityAccess): Prisma.AvailabilityWhereInput {
  if (access.global) return {};
  const OR: Prisma.AvailabilityWhereInput[] = [];
  if (access.ownMemberProfileId) OR.push({ memberProfileId: access.ownMemberProfileId });
  if (access.groupIds.length) OR.push({ memberProfile: { memberships: { some: { groupId: { in: access.groupIds }, removedAt: null } } } });
  return OR.length ? { OR } : { id: "__forbidden__" };
}

async function actorId(db: PrismaClient | Prisma.TransactionClient, actor: RosteringActor) {
  const user = await db.user.findUnique({ where: { email: actor.email.toLowerCase() }, select: { id: true } });
  if (!user) throw new HttpError(404, "Persisted User not found");
  return user.id;
}

async function assertWritable(tx: Prisma.TransactionClient, context: IncidentContext, actor: RosteringActor) {
  if (await tx.session.count({ where: { id: context.incidentId, status: { notIn: ["Closed", "Archived"] } } }) !== 1) {
    throw new HttpError(409, "Rostering in a closed incident is read-only");
  }
  if (!context.systemAdminOverride && await tx.incidentAssignment.count({ where: { incidentId: context.incidentId, userId: context.actorId, active: true } }) !== 1) {
    throw new HttpError(404, "Incident not found");
  }
  if (!actor.id) throw new HttpError(401, "Authentication required");
}

async function lockAndValidateMember(tx: Prisma.TransactionClient, memberProfileId?: string | null) {
  if (!memberProfileId) return null;
  await tx.$queryRaw`SELECT "id" FROM "MemberProfile" WHERE "id" = ${memberProfileId} FOR UPDATE`;
  const member = await tx.memberProfile.findUnique({ where: { id: memberProfileId } });
  if (!member || member.status === "Archived") throw new HttpError(409, "Archived profiles cannot receive new roster or availability entries");
  return member;
}

async function lockAndValidateGroup(tx: Prisma.TransactionClient, incidentId: string, groupId?: string | null) {
  if (!groupId) return null;
  await tx.$queryRaw`SELECT "id" FROM "OperationalGroup" WHERE "id" = ${groupId} FOR UPDATE`;
  const group = await tx.operationalGroup.findUnique({ where: { id: groupId } });
  if (!group || group.incidentId !== incidentId) throw new HttpError(409, "Roster group must belong to the same incident");
  if (group.status === "Archived") throw new HttpError(409, "Archived groups cannot receive roster shifts");
  return group;
}

async function nextRosterId(tx: Prisma.TransactionClient) {
  const [row] = await tx.$queryRaw<Array<{ value: bigint }>>`SELECT nextval('"RosterShift_operational_seq"') AS value`;
  const number = Number(row!.value);
  return { id: `rst-${new Date().getUTCFullYear()}-${String(number).padStart(6, "0")}`, operationalId: `RST-${String(number).padStart(3, "0")}` };
}

async function nextAvailabilityId(tx: Prisma.TransactionClient) {
  const [row] = await tx.$queryRaw<Array<{ value: bigint }>>`SELECT nextval('"Availability_operational_seq"') AS value`;
  const number = Number(row!.value);
  return { id: `avl-${new Date().getUTCFullYear()}-${String(number).padStart(6, "0")}`, operationalId: `AVL-${String(number).padStart(3, "0")}` };
}

async function audit(
  tx: Prisma.TransactionClient,
  actor: RosteringActor,
  actorDatabaseId: string,
  action: string,
  entityType: "rosterShift" | "availability",
  entityId: string,
  sessionId: string | null,
  summary: string,
  metadata: Record<string, unknown>,
) {
  await tx.auditLog.create({ data: {
    action,
    entityType,
    entityId,
    sessionId,
    actorId: actorDatabaseId,
    actorEmail: actor.email,
    summary,
    metadata: json({ requestId: actor.requestId, ...metadata }),
  } });
}

async function retryTarget(tx: Prisma.TransactionClient, operationId: string, expectedFingerprint: string, target: "rosterShiftId" | "availabilityId") {
  const existing = await tx.rosteringOperation.findUnique({ where: { operationId } });
  if (!existing) return null;
  if (existing.commandFingerprint !== expectedFingerprint) throw new HttpError(409, "operationId was already used for a different Rostering command");
  return existing[target];
}

async function logOperation(
  tx: Prisma.TransactionClient,
  actor: RosteringActor,
  operationId: string,
  command: string,
  commandFingerprint: string,
  resultVersion: number,
  target: { rosterShiftId: string } | { availabilityId: string },
) {
  await tx.rosteringOperation.create({ data: { operationId, command, commandFingerprint, resultVersion, requestId: actor.requestId, ...target } });
}

async function decorateShifts(db: PrismaClient | Prisma.TransactionClient, rows: any[]): Promise<RosterShiftRecord[]> {
  if (!rows.length) return [];
  const assignedIds = [...new Set(rows.flatMap((row) => row.assignedMemberProfileId ? [row.assignedMemberProfileId] : []))];
  const minimum = new Date(Math.min(...rows.map((row) => row.startAt.getTime())));
  const maximum = new Date(Math.max(...rows.map((row) => row.endAt.getTime())));
  const [candidateShifts, unavailable, memberships] = await Promise.all([
    assignedIds.length ? db.rosterShift.findMany({
      where: { assignedMemberProfileId: { in: assignedIds }, status: { in: activeRosterStatuses }, startAt: { lt: maximum }, endAt: { gt: minimum } },
      select: { id: true, operationalId: true, assignedMemberProfileId: true, startAt: true, endAt: true, status: true },
    }) : [],
    assignedIds.length ? db.availability.findMany({
      where: { memberProfileId: { in: assignedIds }, status: "Active", type: "Unavailable", startAt: { lt: maximum }, endAt: { gt: minimum } },
      select: { id: true, operationalId: true, memberProfileId: true, startAt: true, endAt: true },
    }) : [],
    assignedIds.length ? db.groupMembership.findMany({
      where: { memberProfileId: { in: assignedIds }, removedAt: null },
      select: { groupId: true, memberProfileId: true },
    }) : [],
  ]);
  const membershipKeys = new Set(memberships.map((item) => `${item.groupId}:${item.memberProfileId}`));
  return rows.map((row) => {
    const warningDetails: RosterShiftRecord["warningDetails"] = [];
    if (!row.assignedMemberProfileId && activeRosterStatuses.includes(row.status)) {
      warningDetails.push({ code: "UNASSIGNED", message: "No assigned member" });
    }
    if (row.assignedMemberProfile) {
      if (row.assignedMemberProfile.status !== "Active") warningDetails.push({ code: "MEMBER_INACTIVE", message: "Assigned member is no longer active" });
      if (row.groupId && !membershipKeys.has(`${row.groupId}:${row.assignedMemberProfileId}`)) warningDetails.push({ code: "OUTSIDE_GROUP", message: "Assigned member is outside this group" });
      const overlap = candidateShifts.find((candidate) => candidate.id !== row.id && candidate.assignedMemberProfileId === row.assignedMemberProfileId && overlaps(row, candidate));
      if (overlap) warningDetails.push({ code: "OVERLAPPING_SHIFT", message: `Overlapping roster shift ${overlap.operationalId}`, sourceId: overlap.id });
      const blocked = unavailable.find((candidate) => candidate.memberProfileId === row.assignedMemberProfileId && overlaps(row, candidate));
      if (blocked) warningDetails.push({ code: "UNAVAILABLE", message: `Unavailable during this shift (${blocked.operationalId})`, sourceId: blocked.id });
    }
    return {
      ...row,
      incidentId: row.sessionId,
      status: row.status as RosterStatus,
      assignedUserId: row.assignedMemberProfile?.linkedUserId ?? null,
      assignedMember: row.assignedMemberProfile ? memberSummary(row.assignedMemberProfile) : null,
      group: row.group ? groupSummary(row.group) : null,
      conflictWarnings: warningDetails.map((warning) => warning.message),
      warningDetails,
      legacyImported: Boolean(row.legacyImported),
      legacyMetadata: undefined,
    };
  });
}

async function decorateAvailability(rows: any[]): Promise<AvailabilityRecord[]> {
  return rows.map((row) => ({
    ...row,
    type: row.type as AvailabilityType,
    status: row.status as "Active" | "Removed",
    member: memberSummary(row.memberProfile),
  }));
}

async function shiftResult(tx: Prisma.TransactionClient, id: string, idempotent = false): Promise<MutationResult<RosterShiftRecord>> {
  const row = await tx.rosterShift.findUnique({ where: { id }, include: rosterInclude });
  if (!row) return { record: null, conflict: false };
  return { record: (await decorateShifts(tx, [row]))[0]!, conflict: false, idempotent };
}

async function availabilityResult(tx: Prisma.TransactionClient, id: string, idempotent = false): Promise<MutationResult<AvailabilityRecord>> {
  const row = await tx.availability.findUnique({ where: { id }, include: availabilityInclude });
  if (!row) return { record: null, conflict: false };
  return { record: (await decorateAvailability([row]))[0]!, conflict: false, idempotent };
}

function transitionAllowed(from: RosterStatus, to: RosterStatus) {
  const transitions: Record<RosterStatus, RosterStatus[]> = {
    Draft: ["Published", "Cancelled"],
    Published: ["Confirmed", "Declined", "Cancelled"],
    Confirmed: ["Cancelled", "Completed"],
    Declined: ["Cancelled"],
    Cancelled: [],
    Completed: [],
  };
  return transitions[from].includes(to);
}

async function assertAvailabilityTarget(tx: Prisma.TransactionClient, actor: RosteringActor, memberProfileId: string) {
  const manage = permissionScope(actor as LegacyDirectoryActor, "availability:manage-all");
  if (manage.allowed && manage.global) return;
  if (manage.allowed && manage.groupIds.size > 0 && await tx.groupMembership.count({ where: { memberProfileId, removedAt: null, groupId: { in: [...manage.groupIds] } } })) return;
  if (!actor.permissions.includes("availability:update-own")) throw new HttpError(403, "Forbidden");
  const user = await tx.user.findUnique({ where: { email: actor.email.toLowerCase() }, select: { linkedMemberProfiles: { where: { status: { not: "Archived" } }, select: { id: true } } } });
  if (!user?.linkedMemberProfiles.some((member) => member.id === memberProfileId)) throw new HttpError(403, "Forbidden");
}

export function createPrismaRosteringRepository(client: PrismaClient): FoundationRosteringRepository {
  return {
    kind: "postgres",

    async resolveMemberForUser(actor) {
      const row = await client.memberProfile.findFirst({ where: { linkedUser: { email: actor.email.toLowerCase() }, status: { not: "Archived" } } });
      return row ? memberSummary(row) : null;
    },

    async listShifts(context, query, access) {
      const where: Prisma.RosterShiftWhereInput = { sessionId: context.incidentId, AND: [rosterWhere(access)] };
      if (query.status) where.status = query.status;
      if (query.groupId) where.groupId = query.groupId;
      if (query.memberProfileId) where.assignedMemberProfileId = query.memberProfileId;
      if (query.functionName) where.functionName = query.functionName;
      if (query.from) where.endAt = { gte: query.from };
      if (query.to) where.startAt = { lte: query.to };
      if (query.search) where.OR = [
        { operationalId: { contains: query.search, mode: "insensitive" } },
        { title: { contains: query.search, mode: "insensitive" } },
        { duty: { contains: query.search, mode: "insensitive" } },
        { functionName: { contains: query.search, mode: "insensitive" } },
        { location: { contains: query.search, mode: "insensitive" } },
        { assignedMemberProfile: { OR: [{ firstName: { contains: query.search, mode: "insensitive" } }, { lastName: { contains: query.search, mode: "insensitive" } }, { memberId: { contains: query.search, mode: "insensitive" } }] } },
      ];
      const orderBy: Prisma.RosterShiftOrderByWithRelationInput = { [query.sortBy]: query.sortDirection };
      const [total, rows] = await Promise.all([
        client.rosterShift.count({ where }),
        client.rosterShift.findMany({ where, include: rosterInclude, orderBy: [orderBy, { id: query.sortDirection }], take: query.limit, skip: query.offset }),
      ]);
      return { total, limit: query.limit, offset: query.offset, data: await decorateShifts(client, rows) };
    },

    async getShift(context, id, access) {
      const row = await client.rosterShift.findFirst({ where: { id, sessionId: context.incidentId, AND: [rosterWhere(access)] }, include: rosterInclude });
      return row ? (await decorateShifts(client, [row]))[0]! : null;
    },

    async createShift(context, input, actor) {
      const fp = fingerprint("CREATE_SHIFT", null, [context.incidentId, input.title, input.duty, input.functionName, input.groupId ?? null, input.assignedMemberProfileId ?? null, input.startAt.toISOString(), input.endAt.toISOString(), input.location, input.notes ?? null]);
      try {
        return await serializable(client, async (tx) => {
          await assertWritable(tx, context, actor);
          const retryId = await retryTarget(tx, input.operationId, fp, "rosterShiftId");
          if (retryId) return shiftResult(tx, retryId, true);
          if (input.endAt <= input.startAt) throw new HttpError(400, "End time must be after start time");
          await lockAndValidateGroup(tx, context.incidentId, input.groupId);
          await lockAndValidateMember(tx, input.assignedMemberProfileId);
          const generated = await nextRosterId(tx);
          const row = await tx.rosterShift.create({ data: {
            ...generated,
            sessionId: context.incidentId,
            groupId: input.groupId,
            assignedMemberProfileId: input.assignedMemberProfileId,
            title: input.title,
            duty: input.duty || input.title,
            functionName: input.functionName,
            startAt: input.startAt,
            endAt: input.endAt,
            location: input.location || "Not set",
            notes: input.notes,
            status: "Draft",
            createdById: context.actorId,
            updatedById: context.actorId,
          } });
          await logOperation(tx, actor, input.operationId, "CREATE_SHIFT", fp, row.version, { rosterShiftId: row.id });
          await audit(tx, actor, context.actorId, "create_roster_shift", "rosterShift", row.id, context.incidentId, `Roster shift ${row.operationalId} created`, {
            rosterShiftId: row.id, operationalId: row.operationalId, statusAfter: row.status, memberAfter: row.assignedMemberProfileId, groupAfter: row.groupId, startAtAfter: row.startAt.toISOString(), endAtAfter: row.endAt.toISOString(), versionAfter: row.version, operationId: input.operationId,
          });
          return shiftResult(tx, row.id);
        });
      } catch (error) {
        if (isConflict(error)) return { record: null, conflict: true };
        throw error;
      }
    },

    async updateShift(context, id, input, expectedVersion, actor) {
      try {
        return await serializable(client, async (tx) => {
          await assertWritable(tx, context, actor);
          await tx.$queryRaw`SELECT "id" FROM "RosterShift" WHERE "id" = ${id} AND "sessionId" = ${context.incidentId}::uuid FOR UPDATE`;
          const current = await tx.rosterShift.findFirst({ where: { id, sessionId: context.incidentId } });
          if (!current) return { record: null, conflict: false };
          if (current.version !== expectedVersion || terminalRosterStatuses.includes(current.status as RosterStatus)) return { record: null, conflict: true };
          const next = {
            groupId: input.groupId === undefined ? current.groupId : input.groupId,
            assignedMemberProfileId: input.assignedMemberProfileId === undefined ? current.assignedMemberProfileId : input.assignedMemberProfileId,
            startAt: input.startAt ?? current.startAt,
            endAt: input.endAt ?? current.endAt,
          };
          if (next.endAt <= next.startAt) throw new HttpError(400, "End time must be after start time");
          await lockAndValidateGroup(tx, context.incidentId, next.groupId);
          await lockAndValidateMember(tx, next.assignedMemberProfileId);
          const changed = await tx.rosterShift.updateMany({ where: { id, sessionId: context.incidentId, version: expectedVersion }, data: {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.duty !== undefined ? { duty: input.duty } : {}),
            ...(input.functionName !== undefined ? { functionName: input.functionName } : {}),
            ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
            ...(input.assignedMemberProfileId !== undefined ? { assignedMemberProfileId: input.assignedMemberProfileId } : {}),
            ...(input.startAt !== undefined ? { startAt: input.startAt } : {}),
            ...(input.endAt !== undefined ? { endAt: input.endAt } : {}),
            ...(input.location !== undefined ? { location: input.location } : {}),
            ...(input.notes !== undefined ? { notes: input.notes } : {}),
            version: { increment: 1 }, updatedById: context.actorId,
          } });
          if (changed.count !== 1) return { record: null, conflict: true };
          const row = await tx.rosterShift.findUniqueOrThrow({ where: { id } });
          await audit(tx, actor, context.actorId, "update_roster_shift", "rosterShift", id, context.incidentId, `Roster shift ${row.operationalId} updated`, {
            rosterShiftId: id, operationalId: row.operationalId, statusBefore: current.status, statusAfter: row.status, memberBefore: current.assignedMemberProfileId, memberAfter: row.assignedMemberProfileId, groupBefore: current.groupId, groupAfter: row.groupId, startAtBefore: current.startAt.toISOString(), startAtAfter: row.startAt.toISOString(), endAtBefore: current.endAt.toISOString(), endAtAfter: row.endAt.toISOString(), changedFields: Object.keys(input), versionBefore: expectedVersion, versionAfter: row.version,
          });
          return shiftResult(tx, id);
        });
      } catch (error) {
        if (isConflict(error)) return { record: null, conflict: true };
        throw error;
      }
    },

    async transitionShift(context, id, nextStatus, input, actor) {
      const command = `SHIFT_${nextStatus.toUpperCase()}`;
      const fp = fingerprint(command, id, [input.note ?? null, input.reason ?? null]);
      try {
        return await serializable(client, async (tx) => {
          await assertWritable(tx, context, actor);
          const retryId = await retryTarget(tx, input.operationId, fp, "rosterShiftId");
          if (retryId) return shiftResult(tx, retryId, true);
          await tx.$queryRaw`SELECT "id" FROM "RosterShift" WHERE "id" = ${id} AND "sessionId" = ${context.incidentId}::uuid FOR UPDATE`;
          const current = await tx.rosterShift.findFirst({ where: { id, sessionId: context.incidentId } });
          if (!current) return { record: null, conflict: false };
          if (current.version !== input.expectedVersion || !transitionAllowed(current.status as RosterStatus, nextStatus)) return { record: null, conflict: true };
          const timestamp = new Date();
          const appendedNote = input.note ? [current.notes, input.note].filter(Boolean).join("\n") : current.notes;
          const lifecycle = nextStatus === "Published" ? { publishedAt: timestamp, publishedById: context.actorId }
            : nextStatus === "Confirmed" ? { confirmedAt: timestamp, confirmedById: context.actorId }
              : nextStatus === "Declined" ? { declinedAt: timestamp, declinedById: context.actorId }
                : nextStatus === "Cancelled" ? { cancelledAt: timestamp, cancelledById: context.actorId, cancelReason: input.reason ?? input.note ?? null }
                  : { completedAt: timestamp, completedById: context.actorId };
          const changed = await tx.rosterShift.updateMany({ where: { id, sessionId: context.incidentId, version: input.expectedVersion, status: current.status }, data: { status: nextStatus, notes: appendedNote, ...lifecycle, version: { increment: 1 }, updatedById: context.actorId } });
          if (changed.count !== 1) return { record: null, conflict: true };
          const row = await tx.rosterShift.findUniqueOrThrow({ where: { id } });
          await logOperation(tx, actor, input.operationId, command, fp, row.version, { rosterShiftId: id });
          await audit(tx, actor, context.actorId, `roster_shift_${nextStatus.toLowerCase()}`, "rosterShift", id, context.incidentId, `Roster shift ${row.operationalId} changed from ${current.status} to ${nextStatus}`, {
            rosterShiftId: id, operationalId: row.operationalId, statusBefore: current.status, statusAfter: nextStatus, memberBefore: current.assignedMemberProfileId, memberAfter: row.assignedMemberProfileId, groupBefore: current.groupId, groupAfter: row.groupId, versionBefore: input.expectedVersion, versionAfter: row.version, operationId: input.operationId, reason: input.reason,
          });
          if (nextStatus === "Published" && row.assignedMemberProfileId) await enqueueNotification(tx, {
            eventType: "ROSTER_PUBLISHED", aggregateType: "rosterShift", aggregateId: id, aggregateVersion: input.operationId,
            sessionId: context.incidentId,
            payload: { memberProfileId: row.assignedMemberProfileId, operationalId: row.operationalId, occurredAt: timestamp.toISOString() },
          });
          return shiftResult(tx, id);
        });
      } catch (error) {
        if (isConflict(error)) return { record: null, conflict: true };
        throw error;
      }
    },

    async listAvailability(query, access) {
      const where: Prisma.AvailabilityWhereInput = { AND: [availabilityWhere(access)] };
      where.status = query.status ?? "Active";
      if (query.memberProfileId) where.memberProfileId = query.memberProfileId;
      if (query.type) where.type = query.type;
      if (query.from) where.endAt = { gte: query.from };
      if (query.to) where.startAt = { lte: query.to };
      const orderBy: Prisma.AvailabilityOrderByWithRelationInput = { [query.sortBy]: query.sortDirection };
      const [total, rows] = await Promise.all([
        client.availability.count({ where }),
        client.availability.findMany({ where, include: availabilityInclude, orderBy: [orderBy, { id: query.sortDirection }], take: query.limit, skip: query.offset }),
      ]);
      return { total, limit: query.limit, offset: query.offset, data: await decorateAvailability(rows) };
    },

    async getAvailability(id, access) {
      const row = await client.availability.findFirst({ where: { id, AND: [availabilityWhere(access)] }, include: availabilityInclude });
      return row ? (await decorateAvailability([row]))[0]! : null;
    },

    async createAvailability(input, memberProfileId, actor) {
      const fp = fingerprint("CREATE_AVAILABILITY", null, [memberProfileId, input.startAt.toISOString(), input.endAt.toISOString(), input.type, input.note ?? null]);
      try {
        return await serializable(client, async (tx) => {
          const retryId = await retryTarget(tx, input.operationId, fp, "availabilityId");
          if (retryId) return availabilityResult(tx, retryId, true);
          const databaseActorId = await actorId(tx, actor);
          await assertAvailabilityTarget(tx, actor, memberProfileId);
          await lockAndValidateMember(tx, memberProfileId);
          if (input.endAt <= input.startAt) throw new HttpError(400, "End time must be after start time");
          if (await tx.availability.count({ where: { memberProfileId, status: "Active", startAt: { lt: input.endAt }, endAt: { gt: input.startAt } } })) throw new HttpError(409, "Availability overlaps an existing active declaration");
          const generated = await nextAvailabilityId(tx);
          const row = await tx.availability.create({ data: { ...generated, memberProfileId, startAt: input.startAt, endAt: input.endAt, type: input.type, note: input.note, createdById: databaseActorId, updatedById: databaseActorId } });
          await logOperation(tx, actor, input.operationId, "CREATE_AVAILABILITY", fp, row.version, { availabilityId: row.id });
          await audit(tx, actor, databaseActorId, "create_availability", "availability", row.id, null, `Availability ${row.operationalId} created`, { availabilityId: row.id, operationalId: row.operationalId, memberProfileId, typeAfter: row.type, startAtAfter: row.startAt.toISOString(), endAtAfter: row.endAt.toISOString(), versionAfter: row.version, operationId: input.operationId });
          return availabilityResult(tx, row.id);
        });
      } catch (error) {
        if (isConflict(error)) return { record: null, conflict: true };
        throw error;
      }
    },

    async updateAvailability(id, input, expectedVersion, memberProfileId, actor) {
      try {
        return await serializable(client, async (tx) => {
          const databaseActorId = await actorId(tx, actor);
          await tx.$queryRaw`SELECT "id" FROM "Availability" WHERE "id" = ${id} FOR UPDATE`;
          const current = await tx.availability.findUnique({ where: { id } });
          if (!current) return { record: null, conflict: false };
          if (current.version !== expectedVersion || current.status !== "Active") return { record: null, conflict: true };
          await assertAvailabilityTarget(tx, actor, current.memberProfileId);
          await assertAvailabilityTarget(tx, actor, memberProfileId);
          await lockAndValidateMember(tx, memberProfileId);
          const startAt = input.startAt ?? current.startAt;
          const endAt = input.endAt ?? current.endAt;
          if (endAt <= startAt) throw new HttpError(400, "End time must be after start time");
          if (await tx.availability.count({ where: { id: { not: id }, memberProfileId, status: "Active", startAt: { lt: endAt }, endAt: { gt: startAt } } })) throw new HttpError(409, "Availability overlaps an existing active declaration");
          const changed = await tx.availability.updateMany({ where: { id, version: expectedVersion, status: "Active" }, data: {
            memberProfileId,
            ...(input.startAt !== undefined ? { startAt: input.startAt } : {}),
            ...(input.endAt !== undefined ? { endAt: input.endAt } : {}),
            ...(input.type !== undefined ? { type: input.type } : {}),
            ...(input.note !== undefined ? { note: input.note } : {}),
            version: { increment: 1 }, updatedById: databaseActorId,
          } });
          if (changed.count !== 1) return { record: null, conflict: true };
          const row = await tx.availability.findUniqueOrThrow({ where: { id } });
          await audit(tx, actor, databaseActorId, "update_availability", "availability", id, null, `Availability ${row.operationalId} updated`, { availabilityId: id, operationalId: row.operationalId, memberProfileIdBefore: current.memberProfileId, memberProfileIdAfter: row.memberProfileId, typeBefore: current.type, typeAfter: row.type, startAtBefore: current.startAt.toISOString(), startAtAfter: row.startAt.toISOString(), endAtBefore: current.endAt.toISOString(), endAtAfter: row.endAt.toISOString(), changedFields: Object.keys(input), versionBefore: expectedVersion, versionAfter: row.version });
          return availabilityResult(tx, id);
        });
      } catch (error) {
        if (isConflict(error)) return { record: null, conflict: true };
        throw error;
      }
    },

    async removeAvailability(id, input, actor) {
      const fp = fingerprint("REMOVE_AVAILABILITY", id, []);
      try {
        return await serializable(client, async (tx) => {
          const retryId = await retryTarget(tx, input.operationId, fp, "availabilityId");
          if (retryId) return availabilityResult(tx, retryId, true);
          const databaseActorId = await actorId(tx, actor);
          await tx.$queryRaw`SELECT "id" FROM "Availability" WHERE "id" = ${id} FOR UPDATE`;
          const current = await tx.availability.findUnique({ where: { id } });
          if (!current) return { record: null, conflict: false };
          await assertAvailabilityTarget(tx, actor, current.memberProfileId);
          if (current.version !== input.expectedVersion || current.status !== "Active") return { record: null, conflict: true };
          const timestamp = new Date();
          const changed = await tx.availability.updateMany({ where: { id, version: input.expectedVersion, status: "Active" }, data: { status: "Removed", removedAt: timestamp, removedById: databaseActorId, updatedById: databaseActorId, version: { increment: 1 } } });
          if (changed.count !== 1) return { record: null, conflict: true };
          const row = await tx.availability.findUniqueOrThrow({ where: { id } });
          await logOperation(tx, actor, input.operationId, "REMOVE_AVAILABILITY", fp, row.version, { availabilityId: id });
          await audit(tx, actor, databaseActorId, "remove_availability", "availability", id, null, `Availability ${row.operationalId} removed`, { availabilityId: id, operationalId: row.operationalId, memberProfileId: row.memberProfileId, type: row.type, versionBefore: input.expectedVersion, versionAfter: row.version, operationId: input.operationId });
          return availabilityResult(tx, id);
        });
      } catch (error) {
        if (isConflict(error)) return { record: null, conflict: true };
        throw error;
      }
    },

    async readinessAvailability(memberProfileId, from, to) {
      const rows = await client.availability.findMany({
        where: { memberProfileId, status: "Active", startAt: { lt: to }, endAt: { gt: from } },
        include: availabilityInclude,
        orderBy: [{ startAt: "asc" }, { id: "asc" }],
        take: 200,
      });
      return decorateAvailability(rows);
    },

    async readinessRoster(memberProfileId, from, to, incidentIds) {
      if (incidentIds?.length === 0) return [];
      const rows = await client.rosterShift.findMany({
        where: { assignedMemberProfileId: memberProfileId, startAt: { lt: to }, endAt: { gt: from }, ...(incidentIds ? { sessionId: { in: incidentIds } } : {}) },
        include: rosterInclude,
        orderBy: [{ startAt: "asc" }, { id: "asc" }],
        take: 200,
      });
      return decorateShifts(client, rows);
    },
  };
}
