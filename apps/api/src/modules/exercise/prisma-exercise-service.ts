import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { normalizeRoleName } from "@zpp/shared";
import { HttpError } from "../../errors.js";
import { EffectiveAccessService } from "../identity/effective-access-service.js";
import {
  exerciseTargetRoleKeys,
  type CreateInjectInput,
  type CreateObservationInput,
  type ExerciseActor,
  type ExerciseFailureHooks,
  type ExerciseListQuery,
  type UpdateInjectInput,
  type UpdateObservationInput
} from "./exercise-types.js";

type Tx = Prisma.TransactionClient;
const actorSelect = { id: true, displayName: true } as const;
const injectInclude = {
  createdBy: { select: actorSelect }, updatedBy: { select: actorSelect },
  releasedBy: { select: actorSelect }, completedBy: { select: actorSelect }
} as const;
const observationInclude = { createdBy: { select: actorSelect }, updatedBy: { select: actorSelect } } as const;
const revisionInclude = { changedBy: { select: actorSelect } } as const;
type InjectRow = Prisma.ExerciseInjectGetPayload<{ include: typeof injectInclude }>;
type ObservationRow = Prisma.ExerciseObservationGetPayload<{ include: typeof observationInclude }>;
type RevisionRow = Prisma.ExerciseObservationRevisionGetPayload<{ include: typeof revisionInclude }>;

const terminalStatuses = new Set(["Closed", "Archived"]);

function safeActor(value: { id: string; displayName: string } | null | undefined) {
  return value ? { id: value.id, displayName: value.displayName } : null;
}

function serializeInject(row: InjectRow) {
  return {
    id: row.id, operationalId: row.operationalId, sessionId: row.sessionId,
    injectNumber: row.injectNumber, scenarioTime: row.scenarioTime?.toISOString() ?? null,
    targetRoleKey: row.targetRoleKey, targetRole: row.targetRole, text: row.text,
    expectedAction: row.expectedAction, status: row.status, version: row.version,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    createdBy: safeActor(row.createdBy), updatedBy: safeActor(row.updatedBy),
    releasedAt: row.releasedAt?.toISOString() ?? null, releasedBy: safeActor(row.releasedBy),
    completedAt: row.completedAt?.toISOString() ?? null, completedBy: safeActor(row.completedBy)
  };
}

function serializeObservation(row: ObservationRow) {
  return {
    id: row.id, operationalId: row.operationalId, sessionId: row.sessionId,
    area: row.area, severity: row.severity, observation: row.observation,
    recommendation: row.recommendation, owner: row.owner, includeInAar: row.includeInAar,
    status: row.status, version: row.version,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    createdBy: safeActor(row.createdBy), updatedBy: safeActor(row.updatedBy)
  };
}

function serializeRevision(row: RevisionRow) {
  return {
    id: row.id, observationId: row.observationId, version: row.version,
    area: row.area, severity: row.severity, observation: row.observation,
    recommendation: row.recommendation, owner: row.owner, includeInAar: row.includeInAar,
    status: row.status, changedFields: row.changedFields,
    changedAt: row.changedAt.toISOString(), changedBy: safeActor(row.changedBy), source: row.source
  };
}

function digest(parts: unknown[]) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function injectFingerprint(input: CreateInjectInput) {
  return digest([input.sessionId, input.injectNumber, input.scenarioTime?.toISOString() ?? null, normalizeRoleName(input.targetRole), input.text, input.expectedAction]);
}

function observationFingerprint(input: CreateObservationInput) {
  return digest([input.sessionId, input.area, input.severity, input.observation, input.recommendation, input.owner, input.includeInAar, input.status]);
}

function uniqueTarget(error: Prisma.PrismaClientKnownRequestError) {
  const target = error.meta?.target;
  return Array.isArray(target) ? target.map(String).join(",") : String(target ?? "");
}

function uniqueConflict(error: unknown, needle: string) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" && uniqueTarget(error).includes(needle);
}

function sameDate(left: Date | null, right: Date | null) {
  return left?.getTime() === right?.getTime();
}

async function audit(tx: Tx, actor: ExerciseActor, input: {
  action: string; entityType: string; entityId: string; sessionId: string; summary: string; metadata: Record<string, unknown>;
}) {
  await tx.auditLog.create({ data: {
    action: input.action, entityType: input.entityType, entityId: input.entityId,
    sessionId: input.sessionId, actorId: actor.id, actorEmail: actor.email,
    summary: input.summary, metadata: { ...input.metadata, requestId: actor.requestId ?? null } as Prisma.InputJsonValue
  } });
}

export function createPrismaExerciseService(client: PrismaClient, hooks: ExerciseFailureHooks = {}) {
  async function assertAccess(tx: Tx, actorId: string, sessionId: string) {
    const permissions = await new EffectiveAccessService(tx).effectivePermissionsForUser(actorId, { incidentId: sessionId });
    if (!permissions.includes("exercise:manage")) throw new HttpError(403, "Forbidden");
  }

  async function lockSession(tx: Tx, sessionId: string, actorId: string, operation: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "Session" WHERE "id" = ${sessionId}::uuid FOR UPDATE`);
    if (!rows.length) throw new HttpError(404, "Incident not found");
    await hooks.afterSessionLock?.(operation);
    const session = await tx.session.findUniqueOrThrow({ where: { id: sessionId }, select: { id: true, mode: true, status: true } });
    await assertAccess(tx, actorId, sessionId);
    if (session.mode !== "EXERCISE") throw new HttpError(409, "Exercise evidence can only be changed in an EXERCISE Incident");
    if (terminalStatuses.has(session.status)) throw new HttpError(409, "Exercise evidence in a closed Incident is read-only");
    return session;
  }

  async function readSession(tx: Tx, sessionId: string, actorId: string) {
    const session = await tx.session.findUnique({ where: { id: sessionId }, select: { id: true, mode: true, status: true } });
    if (!session) throw new HttpError(404, "Incident not found");
    await assertAccess(tx, actorId, sessionId);
    return session;
  }

  async function targetRole(tx: Tx, value: string) {
    const key = normalizeRoleName(value);
    if (!exerciseTargetRoleKeys.includes(key as (typeof exerciseTargetRoleKeys)[number])) throw new HttpError(400, "Unsupported Exercise target role");
    const role = await tx.role.findUnique({ where: { normalizedName: key }, select: { id: true, normalizedName: true, displayName: true, status: true } });
    if (!role || role.status !== "Active") throw new HttpError(400, "Unsupported Exercise target role");
    return { id: role.id, key: role.normalizedName, snapshot: role.displayName };
  }

  async function nextOperationalId(tx: Tx, sequence: "ExerciseInject_operational_seq" | "ExerciseObservation_operational_seq", prefix: "INJ" | "OBS") {
    const rows = await tx.$queryRaw<Array<{ value: bigint }>>(Prisma.raw(`SELECT nextval('"${sequence}"') AS value`));
    return `${prefix}-${new Date().getFullYear()}-${String(rows[0]!.value).padStart(6, "0")}`;
  }

  async function injectReplay(operationId: string, fingerprint: string, actorId: string) {
    const row = await client.exerciseInject.findUnique({ where: { createOperationId: operationId }, include: injectInclude });
    if (!row) return null;
    if (row.createCommandFingerprint !== fingerprint || row.createdById !== actorId) throw new HttpError(409, "Exercise creation operation already exists");
    return { record: serializeInject(row), replayed: true };
  }

  async function observationReplay(operationId: string, fingerprint: string, actorId: string) {
    const row = await client.exerciseObservation.findUnique({ where: { createOperationId: operationId }, include: observationInclude });
    if (!row) return null;
    if (row.createCommandFingerprint !== fingerprint || row.createdById !== actorId) throw new HttpError(409, "Exercise creation operation already exists");
    return { record: serializeObservation(row), replayed: true };
  }

  async function lockedInject(tx: Tx, id: string) {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ExerciseInject" WHERE "id" = ${id}::uuid FOR UPDATE`);
    const row = await tx.exerciseInject.findUnique({ where: { id }, include: injectInclude });
    if (!row) throw new HttpError(404, "Exercise Inject not found");
    return row;
  }

  async function lockedObservation(tx: Tx, id: string) {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ExerciseObservation" WHERE "id" = ${id}::uuid FOR UPDATE`);
    const row = await tx.exerciseObservation.findUnique({ where: { id }, include: observationInclude });
    if (!row) throw new HttpError(404, "Exercise Observation not found");
    return row;
  }

  async function createRevision(tx: Tx, row: ObservationRow, actorId: string, changedFields: string[], source = "Mutation") {
    await hooks.beforeRevisionInsert?.(row.version);
    await tx.exerciseObservationRevision.create({ data: {
      id: randomUUID(), observationId: row.id, version: row.version,
      area: row.area, severity: row.severity, observation: row.observation,
      recommendation: row.recommendation, owner: row.owner, includeInAar: row.includeInAar,
      status: row.status, changedFields, changedById: actorId, source
    } });
    await hooks.afterRevisionInsertBeforeAudit?.(row.version);
  }

  return {
    kind: "postgres" as const,

    async injectContext(id: string) {
      const row = await client.exerciseInject.findUnique({ where: { id }, select: { id: true, sessionId: true } });
      if (!row) throw new HttpError(404, "Exercise Inject not found");
      return row;
    },

    async observationContext(id: string) {
      const row = await client.exerciseObservation.findUnique({ where: { id }, select: { id: true, sessionId: true } });
      if (!row) throw new HttpError(404, "Exercise Observation not found");
      return row;
    },

    async listInjects(query: ExerciseListQuery, actor: ExerciseActor) {
      return client.$transaction(async (tx) => {
        await readSession(tx, query.sessionId, actor.id);
        const where = { sessionId: query.sessionId, status: query.status };
        const [total, rows] = await Promise.all([
          tx.exerciseInject.count({ where }),
          tx.exerciseInject.findMany({ where, include: injectInclude, orderBy: [{ injectNumber: "asc" }, { id: "asc" }], take: query.limit, skip: query.offset })
        ]);
        return { total, limit: query.limit, offset: query.offset, data: rows.map(serializeInject) };
      });
    },

    async listObservations(query: ExerciseListQuery, actor: ExerciseActor) {
      return client.$transaction(async (tx) => {
        await readSession(tx, query.sessionId, actor.id);
        const where = { sessionId: query.sessionId, status: query.status };
        const [total, rows] = await Promise.all([
          tx.exerciseObservation.count({ where }),
          tx.exerciseObservation.findMany({ where, include: observationInclude, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: query.limit, skip: query.offset })
        ]);
        return { total, limit: query.limit, offset: query.offset, data: rows.map(serializeObservation) };
      });
    },

    async createInject(input: CreateInjectInput, actor: ExerciseActor) {
      const fingerprint = injectFingerprint(input);
      const replay = await injectReplay(input.operationId, fingerprint, actor.id);
      if (replay) return replay;
      try {
        const record = await client.$transaction(async (tx) => {
          await lockSession(tx, input.sessionId, actor.id, "create-inject");
          const role = await targetRole(tx, input.targetRole);
          await hooks.beforeEntityCreate?.("inject");
          const row = await tx.exerciseInject.create({ data: {
            id: randomUUID(), operationalId: await nextOperationalId(tx, "ExerciseInject_operational_seq", "INJ"),
            sessionId: input.sessionId, injectNumber: input.injectNumber, scenarioTime: input.scenarioTime,
            targetRoleId: role.id, targetRoleKey: role.key, targetRole: role.snapshot,
            text: input.text, expectedAction: input.expectedAction, status: "Planned", version: 1,
            createOperationId: input.operationId, createCommandFingerprint: fingerprint,
            createdById: actor.id, updatedById: actor.id
          }, include: injectInclude });
          await hooks.afterEntityCreateBeforeAudit?.("inject");
          await audit(tx, actor, { action: "exercise_inject_created", entityType: "exerciseInject", entityId: row.id, sessionId: row.sessionId, summary: `Exercise Inject ${row.operationalId} created`, metadata: { operationalId: row.operationalId, injectNumber: row.injectNumber, targetRoleKey: row.targetRoleKey, version: row.version, status: row.status, operationId: input.operationId } });
          return row;
        });
        return { record: serializeInject(record), replayed: false };
      } catch (error) {
        if (uniqueConflict(error, "createOperationId")) {
          const raced = await injectReplay(input.operationId, fingerprint, actor.id);
          if (raced) return raced;
        }
        if (uniqueConflict(error, "sessionId") || uniqueConflict(error, "injectNumber")) throw new HttpError(409, "Inject number already exists in this Incident");
        throw error;
      }
    },

    async updateInject(id: string, input: UpdateInjectInput, actor: ExerciseActor) {
      try {
        const row = await client.$transaction(async (tx) => {
          const preliminary = await tx.exerciseInject.findUnique({ where: { id }, select: { sessionId: true } });
          if (!preliminary) throw new HttpError(404, "Exercise Inject not found");
          await lockSession(tx, preliminary.sessionId, actor.id, "update-inject");
          const current = await lockedInject(tx, id);
          if (current.status !== "Planned") throw new HttpError(409, "Released or terminal Exercise Inject content is immutable");
          if (current.version !== input.expectedVersion) throw new HttpError(409, "Exercise Inject changed; reload and retry");
          const role = input.targetRole !== undefined ? await targetRole(tx, input.targetRole) : null;
          const data: Prisma.ExerciseInjectUpdateInput = {};
          const changedFields: string[] = [];
          if (input.injectNumber !== undefined && input.injectNumber !== current.injectNumber) { data.injectNumber = input.injectNumber; changedFields.push("injectNumber"); }
          if (input.scenarioTime !== undefined && !sameDate(input.scenarioTime, current.scenarioTime)) { data.scenarioTime = input.scenarioTime; changedFields.push("scenarioTime"); }
          if (role && role.id !== current.targetRoleId) { data.targetRoleRecord = { connect: { id: role.id } }; data.targetRoleKey = role.key; data.targetRole = role.snapshot; changedFields.push("targetRole"); }
          if (input.text !== undefined && input.text !== current.text) { data.text = input.text; changedFields.push("text"); }
          if (input.expectedAction !== undefined && input.expectedAction !== current.expectedAction) { data.expectedAction = input.expectedAction; changedFields.push("expectedAction"); }
          if (!changedFields.length) return current;
          data.version = { increment: 1 }; data.updatedBy = { connect: { id: actor.id } };
          const updated = await tx.exerciseInject.update({ where: { id }, data, include: injectInclude });
          await audit(tx, actor, { action: "exercise_inject_updated", entityType: "exerciseInject", entityId: id, sessionId: updated.sessionId, summary: `Exercise Inject ${updated.operationalId} updated`, metadata: { operationalId: updated.operationalId, injectNumber: updated.injectNumber, changedFields, versionBefore: current.version, versionAfter: updated.version, status: updated.status } });
          return updated;
        });
        return serializeInject(row);
      } catch (error) {
        if (uniqueConflict(error, "sessionId") || uniqueConflict(error, "injectNumber")) throw new HttpError(409, "Inject number already exists in this Incident");
        throw error;
      }
    },

    async releaseInject(id: string, expectedVersion: number | undefined, actor: ExerciseActor) {
      const row = await client.$transaction(async (tx) => {
        const preliminary = await tx.exerciseInject.findUnique({ where: { id }, select: { sessionId: true } });
        if (!preliminary) throw new HttpError(404, "Exercise Inject not found");
        await lockSession(tx, preliminary.sessionId, actor.id, "release-inject");
        const current = await lockedInject(tx, id);
        if (current.status === "Released" || current.status === "Completed") return current;
        if (current.status !== "Planned") throw new HttpError(409, "Exercise Inject cannot be released from its current status");
        if (expectedVersion !== undefined && current.version !== expectedVersion) throw new HttpError(409, "Exercise Inject changed; reload and retry");
        const updated = await tx.exerciseInject.update({ where: { id }, data: { status: "Released", releasedAt: new Date(), releasedBy: { connect: { id: actor.id } }, updatedBy: { connect: { id: actor.id } }, version: { increment: 1 } }, include: injectInclude });
        await hooks.beforeReleaseAudit?.();
        await audit(tx, actor, { action: "exercise_inject_released", entityType: "exerciseInject", entityId: id, sessionId: updated.sessionId, summary: `Exercise Inject ${updated.operationalId} released`, metadata: { operationalId: updated.operationalId, injectNumber: updated.injectNumber, fromStatus: current.status, toStatus: updated.status, versionBefore: current.version, versionAfter: updated.version } });
        return updated;
      });
      return serializeInject(row);
    },

    async completeInject(id: string, expectedVersion: number | undefined, actor: ExerciseActor) {
      const row = await client.$transaction(async (tx) => {
        const preliminary = await tx.exerciseInject.findUnique({ where: { id }, select: { sessionId: true } });
        if (!preliminary) throw new HttpError(404, "Exercise Inject not found");
        await lockSession(tx, preliminary.sessionId, actor.id, "complete-inject");
        const current = await lockedInject(tx, id);
        if (current.status === "Completed") return current;
        if (current.status !== "Released") throw new HttpError(409, "Only a Released Exercise Inject can be completed");
        if (expectedVersion !== undefined && current.version !== expectedVersion) throw new HttpError(409, "Exercise Inject changed; reload and retry");
        const updated = await tx.exerciseInject.update({ where: { id }, data: { status: "Completed", completedAt: new Date(), completedBy: { connect: { id: actor.id } }, updatedBy: { connect: { id: actor.id } }, version: { increment: 1 } }, include: injectInclude });
        await hooks.beforeCompleteAudit?.();
        await audit(tx, actor, { action: "exercise_inject_completed", entityType: "exerciseInject", entityId: id, sessionId: updated.sessionId, summary: `Exercise Inject ${updated.operationalId} completed`, metadata: { operationalId: updated.operationalId, injectNumber: updated.injectNumber, fromStatus: current.status, toStatus: updated.status, versionBefore: current.version, versionAfter: updated.version } });
        return updated;
      });
      return serializeInject(row);
    },

    async createObservation(input: CreateObservationInput, actor: ExerciseActor) {
      const fingerprint = observationFingerprint(input);
      const replay = await observationReplay(input.operationId, fingerprint, actor.id);
      if (replay) return replay;
      try {
        const record = await client.$transaction(async (tx) => {
          await lockSession(tx, input.sessionId, actor.id, "create-observation");
          await hooks.beforeEntityCreate?.("observation");
          const row = await tx.exerciseObservation.create({ data: {
            id: randomUUID(), operationalId: await nextOperationalId(tx, "ExerciseObservation_operational_seq", "OBS"),
            sessionId: input.sessionId, area: input.area, severity: input.severity,
            observation: input.observation, recommendation: input.recommendation, owner: input.owner,
            includeInAar: input.includeInAar, status: input.status, version: 1,
            createOperationId: input.operationId, createCommandFingerprint: fingerprint,
            createdById: actor.id, updatedById: actor.id
          }, include: observationInclude });
          await hooks.afterEntityCreateBeforeAudit?.("observation");
          const fields = ["area", "severity", "observation", "recommendation", "owner", "includeInAar", "status"];
          await createRevision(tx, row, actor.id, fields);
          await audit(tx, actor, { action: "exercise_observation_created", entityType: "exerciseObservation", entityId: row.id, sessionId: row.sessionId, summary: `Exercise Observation ${row.operationalId} created`, metadata: { operationalId: row.operationalId, area: row.area, severity: row.severity, includeInAar: row.includeInAar, changedFields: fields, version: row.version, status: row.status, operationId: input.operationId } });
          return row;
        });
        return { record: serializeObservation(record), replayed: false };
      } catch (error) {
        if (uniqueConflict(error, "createOperationId")) {
          const raced = await observationReplay(input.operationId, fingerprint, actor.id);
          if (raced) return raced;
        }
        throw error;
      }
    },

    async updateObservation(id: string, input: UpdateObservationInput, actor: ExerciseActor) {
      const row = await client.$transaction(async (tx) => {
        const preliminary = await tx.exerciseObservation.findUnique({ where: { id }, select: { sessionId: true } });
        if (!preliminary) throw new HttpError(404, "Exercise Observation not found");
        await lockSession(tx, preliminary.sessionId, actor.id, "update-observation");
        const current = await lockedObservation(tx, id);
        if (current.version !== input.expectedVersion) throw new HttpError(409, "Exercise Observation changed; reload and retry");
        const data: Prisma.ExerciseObservationUpdateInput = {};
        const changedFields: string[] = [];
        for (const field of ["area", "severity", "observation", "recommendation", "owner", "includeInAar", "status"] as const) {
          if (input[field] !== undefined && input[field] !== current[field]) { (data as Record<string, unknown>)[field] = input[field]; changedFields.push(field); }
        }
        if (!changedFields.length) return current;
        data.version = { increment: 1 }; data.updatedBy = { connect: { id: actor.id } };
        const updated = await tx.exerciseObservation.update({ where: { id }, data, include: observationInclude });
        await createRevision(tx, updated, actor.id, changedFields);
        await audit(tx, actor, { action: "exercise_observation_updated", entityType: "exerciseObservation", entityId: id, sessionId: updated.sessionId, summary: `Exercise Observation ${updated.operationalId} updated`, metadata: { operationalId: updated.operationalId, area: updated.area, severity: updated.severity, includeInAar: updated.includeInAar, changedFields, versionBefore: current.version, versionAfter: updated.version, status: updated.status } });
        return updated;
      });
      return serializeObservation(row);
    },

    async observationHistory(id: string, page: { limit: number; offset: number }, actor: ExerciseActor) {
      return client.$transaction(async (tx) => {
        const observation = await tx.exerciseObservation.findUnique({ where: { id }, select: { id: true, sessionId: true } });
        if (!observation) throw new HttpError(404, "Exercise Observation not found");
        await readSession(tx, observation.sessionId, actor.id);
        const where = { observationId: id };
        const [total, rows] = await Promise.all([
          tx.exerciseObservationRevision.count({ where }),
          tx.exerciseObservationRevision.findMany({ where, include: revisionInclude, orderBy: { version: "asc" }, take: page.limit, skip: page.offset })
        ]);
        return { total, limit: page.limit, offset: page.offset, data: rows.map(serializeRevision) };
      });
    }
  };
}

export type PrismaExerciseService = ReturnType<typeof createPrismaExerciseService>;
