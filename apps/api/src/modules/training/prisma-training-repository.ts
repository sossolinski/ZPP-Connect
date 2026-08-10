import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { FoundationTrainingRepository, MutationResult } from "./training-repository.js";
import type {
  AssignTrainingInput,
  AssignTrainingResult,
  CourseQuery,
  CreateCourseInput,
  CreateRequirementInput,
  MemberTrainingRecord,
  RecordQuery,
  RequirementQuery,
  TrainingAccess,
  TrainingActor,
  TrainingBaseStatus,
  TrainingCommandInput,
  TrainingCompliance,
  TrainingCourseRecord,
  TrainingEffectiveStatus,
  TrainingGroupSummary,
  TrainingMemberSummary,
  TrainingRequirementRecord,
  TrainingRequirementTargetType,
  TrainingTotals,
  UpdateCourseInput,
  UpdateRequirementInput,
  UpdateTrainingRecordInput,
} from "./training-types.js";

type Db = PrismaClient | Prisma.TransactionClient;
const activeStatuses = ["Assigned", "In Progress"];
const supportedRoleTargets = ["ZPP Member", "TEC Member", "ZPP Group Leader", "TEC Group Leader", "ZPP Coordinator", "TEC Coordinator", "Family Assistance", "Welfare", "Documentation"] as const;

const courseSelect = {
  id: true, code: true, title: true, description: true, category: true, deliveryType: true,
  validityMonths: true, active: true, selfCompletable: true, externalRef: true, version: true,
  deactivatedAt: true, reactivatedAt: true, createdAt: true, updatedAt: true,
} satisfies Prisma.TrainingCourseSelect;
const memberSelect = {
  id: true, memberId: true, linkedUserId: true, firstName: true, lastName: true, pool: true,
  role: true, assignedFunction: true, status: true,
} satisfies Prisma.MemberProfileSelect;
const groupSelect = {
  id: true, operationalId: true, incidentId: true, name: true, pool: true, functionName: true, status: true,
  _count: { select: { memberships: { where: { removedAt: null } } } },
} satisfies Prisma.OperationalGroupSelect;

type CourseRow = Prisma.TrainingCourseGetPayload<{ select: typeof courseSelect }>;
type MemberRow = Prisma.MemberProfileGetPayload<{ select: typeof memberSelect }>;
type GroupRow = Prisma.OperationalGroupGetPayload<{ select: typeof groupSelect }>;
const requirementInclude = { course: { select: courseSelect }, group: { select: groupSelect }, memberProfile: { select: memberSelect } } satisfies Prisma.TrainingRequirementInclude;
type RequirementRow = Prisma.TrainingRequirementGetPayload<{ include: typeof requirementInclude }>;
const recordInclude = {
  course: { select: courseSelect },
  memberProfile: { select: memberSelect },
  sourceRequirement: { include: requirementInclude },
  verifiedBy: { select: { id: true, email: true, displayName: true } },
} satisfies Prisma.MemberTrainingRecordInclude;
type RecordRow = Prisma.MemberTrainingRecordGetPayload<{ include: typeof recordInclude }>;

function courseRecord(row: CourseRow): TrainingCourseRecord {
  return { ...row, description: row.description ?? "", deliveryType: row.deliveryType as TrainingCourseRecord["deliveryType"] };
}

function memberRecord(row: MemberRow): TrainingMemberSummary {
  return { ...row, volunteerId: row.memberId, displayName: `${row.firstName} ${row.lastName}`.trim() };
}

function groupRecord(row: GroupRow): TrainingGroupSummary {
  return { ...row, sessionId: row.incidentId, memberCount: row._count.memberships };
}

function effectiveStatus(row: Pick<RecordRow, "status" | "expiryAt">, now: Date): TrainingEffectiveStatus {
  return row.status === "Completed" && row.expiryAt && row.expiryAt.getTime() < now.getTime() ? "Expired" : row.status as TrainingBaseStatus;
}

function isOverdue(row: Pick<RecordRow, "status" | "dueAt">, now: Date) {
  return activeStatuses.includes(row.status) && Boolean(row.dueAt && row.dueAt.getTime() < now.getTime());
}

function isExpiringSoon(row: Pick<RecordRow, "status" | "expiryAt">, now: Date, days = 45) {
  if (effectiveStatus(row, now) !== "Completed" || !row.expiryAt) return false;
  return row.expiryAt.getTime() >= now.getTime() && row.expiryAt.getTime() <= now.getTime() + days * 86_400_000;
}

function targetLabel(row: RequirementRow) {
  if (row.targetType === "Role") return row.targetRole ?? "Unknown role";
  if (row.targetType === "Group") return row.group?.name ?? "Unknown group";
  return row.memberProfile ? `${row.memberProfile.firstName} ${row.memberProfile.lastName}`.trim() : "Unknown member";
}

async function roleTargetWhere(targetRole: string): Promise<Prisma.MemberProfileWhereInput | null> {
  if (targetRole === "ZPP Member") return { pool: "ZPP" };
  if (targetRole === "TEC Member") return { pool: "TEC" };
  if (targetRole === "ZPP Group Leader") return { pool: "ZPP", memberships: { some: { removedAt: null, role: "Leader" } } };
  if (targetRole === "TEC Group Leader") return { pool: "TEC", memberships: { some: { removedAt: null, role: "Leader" } } };
  if (targetRole === "ZPP Coordinator") return { linkedUser: { roles: { some: { role: { name: "zpp-coordinator" } } } } };
  if (targetRole === "TEC Coordinator") return { linkedUser: { roles: { some: { role: { name: "tec-coordinator" } } } } };
  if (targetRole === "Family Assistance") return { assignedFunction: "Family Assistance Team" };
  if (targetRole === "Welfare") return { assignedFunction: "Welfare Support" };
  if (targetRole === "Documentation") return { assignedFunction: "Documentation Support" };
  return null;
}

async function targetMemberWhere(requirement: Pick<RequirementRow, "targetType" | "targetRole" | "groupId" | "memberProfileId">): Promise<Prisma.MemberProfileWhereInput> {
  if (requirement.targetType === "Role") return (await roleTargetWhere(requirement.targetRole ?? "")) ?? { id: "__unsupported_training_role__" };
  if (requirement.targetType === "Group") return { memberships: { some: { groupId: requirement.groupId ?? "", removedAt: null } } };
  return { id: requirement.memberProfileId ?? "__missing_training_member__" };
}

async function resolvedMemberCount(db: Db, row: RequirementRow) {
  return db.memberProfile.count({ where: { status: { not: "Archived" }, ...(await targetMemberWhere(row)) } });
}

async function requirementRecord(db: Db, row: RequirementRow): Promise<TrainingRequirementRecord> {
  return {
    id: row.id,
    courseId: row.courseId,
    course: courseRecord(row.course),
    targetType: row.targetType as TrainingRequirementTargetType,
    targetRole: row.targetRole,
    groupId: row.groupId,
    memberProfileId: row.memberProfileId,
    target: row.targetType === "Group" && row.group
      ? { type: "Group", label: row.group.name, group: groupRecord(row.group) }
      : row.targetType === "MemberProfile" && row.memberProfile
        ? { type: "MemberProfile", label: `${row.memberProfile.firstName} ${row.memberProfile.lastName}`.trim(), member: memberRecord(row.memberProfile) }
        : { type: "Role", label: row.targetRole ?? "Unknown role" },
    requiredStatus: row.requiredStatus as TrainingRequirementRecord["requiredStatus"],
    dueAt: row.dueAt,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    active: row.active,
    resolvedMemberCount: await resolvedMemberCount(db, row),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function recordRecord(row: RecordRow, now: Date): MemberTrainingRecord {
  const status = effectiveStatus(row, now);
  return {
    id: row.id,
    operationalId: row.operationalId,
    memberProfileId: row.memberProfileId,
    member: memberRecord(row.memberProfile),
    courseId: row.courseId,
    course: courseRecord(row.course),
    sourceRequirementId: row.sourceRequirementId,
    sourceRequirement: row.sourceRequirement ? {
      id: row.sourceRequirement.id,
      targetType: row.sourceRequirement.targetType as TrainingRequirementTargetType,
      targetLabel: targetLabel(row.sourceRequirement),
      requiredStatus: row.sourceRequirement.requiredStatus as TrainingRequirementRecord["requiredStatus"],
    } : null,
    assignedAt: row.assignedAt,
    assignedById: row.assignedById,
    dueAt: row.dueAt,
    status,
    baseStatus: row.status as TrainingBaseStatus,
    isOverdue: isOverdue(row, now),
    isExpiringSoon: isExpiringSoon(row, now),
    startedAt: row.startedAt,
    startedById: row.startedById,
    completedAt: row.completedAt,
    completedById: row.completedById,
    expiryAt: row.expiryAt,
    score: row.score,
    completionNote: row.completionNote,
    completionRef: row.completionRef,
    verifiedById: row.verifiedById,
    verifiedBy: row.verifiedBy,
    verifiedAt: row.verifiedAt,
    verificationStatus: row.status === "Completed" ? (row.verifiedAt ? "Verified" : "Pending") : "Not applicable",
    waivedAt: row.waivedAt,
    waivedById: row.waivedById,
    waiverReason: row.waiverReason,
    cancelledAt: row.cancelledAt,
    cancelledById: row.cancelledById,
    cancelledReason: row.cancelledReason,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function visibility(access: TrainingAccess): Prisma.MemberProfileWhereInput {
  if (access.global) return {};
  return { OR: [
    ...(access.ownMemberProfileId ? [{ id: access.ownMemberProfileId }] : []),
    ...(access.groupIds.length ? [{ memberships: { some: { removedAt: null, groupId: { in: access.groupIds } } } }] : []),
  ] };
}

function requirementVisibility(access: TrainingAccess): Prisma.TrainingRequirementWhereInput {
  if (access.global) return {};
  return { OR: [
    ...(access.groupIds.length ? [
      { targetType: "Group", groupId: { in: access.groupIds } },
      { targetType: "MemberProfile", memberProfile: { memberships: { some: { removedAt: null, groupId: { in: access.groupIds } } } } },
    ] : []),
    ...(access.ownMemberProfileId ? [{ targetType: "MemberProfile", memberProfileId: access.ownMemberProfileId }] : []),
  ] };
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object" && !(value instanceof Date)) return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)]));
  return value instanceof Date ? value.toISOString() : value;
}

function fingerprint(command: string, target: string, payload: unknown) {
  return createHash("sha256").update(JSON.stringify(stable({ command, target, payload }))).digest("hex");
}

function conflictError(error: unknown) {
  if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2028", "P2034"].includes(error.code)) return true;
  return /could not serialize|serialization|unique constraint|transaction.*conflict/i.test(error instanceof Error ? error.message : String(error));
}

function serializationError(error: unknown) {
  if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2028", "P2034"].includes(error.code)) return true;
  return /could not serialize|serialization/i.test(error instanceof Error ? error.message : String(error));
}

async function serializable<T>(client: PrismaClient, action: (tx: Prisma.TransactionClient) => Promise<T>) {
  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try { return await client.$transaction(action, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); }
    catch (error) { last = error; if (!serializationError(error)) throw error; }
  }
  throw last;
}

async function audit(db: Db, actor: TrainingActor, action: string, entityType: string, entityId: string, summary: string, incidentId: string | null, metadata: Record<string, unknown>) {
  await db.auditLog.create({ data: { action, entityType, entityId, sessionId: incidentId, actorId: actor.id, actorEmail: actor.email, summary, metadata: { ...metadata, requestId: actor.requestId ?? null } } });
}

async function nextSequence(db: Db, name: string) {
  const rows = await db.$queryRawUnsafe<Array<{ value: bigint }>>(`SELECT nextval('"${name}"') AS value`);
  return Number(rows[0]!.value);
}

function businessId(prefix: string, value: number) { return `${prefix}-2026-${String(value).padStart(6, "0")}`; }
function normalizedCode(value: string) { return value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }

async function loadedCourse(db: Db, id: string) { return db.trainingCourse.findUnique({ where: { id }, select: courseSelect }); }
async function loadedRequirement(db: Db, id: string) { return db.trainingRequirement.findUnique({ where: { id }, include: requirementInclude }); }
async function loadedRecord(db: Db, id: string) { return db.memberTrainingRecord.findUnique({ where: { id }, include: recordInclude }); }

function calendarMonths(date: Date, months: number) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const targetYear = year + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, targetMonth, Math.min(date.getUTCDate(), lastDay), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()));
}

export function createPrismaTrainingRepository(client: PrismaClient, clock: { now(): Date } = { now: () => new Date() }): FoundationTrainingRepository {
  function requirementFilter(where: Prisma.TrainingRequirementWhereInput, query: RequirementQuery): Prisma.TrainingRequirementWhereInput {
    const search = query.search?.trim();
    return { AND: [
      where,
      query.active === undefined ? {} : { active: query.active },
      query.courseId ? { courseId: query.courseId } : {},
      query.targetType ? { targetType: query.targetType } : {},
      query.target ? { OR: [{ targetRole: query.target }, { groupId: query.target }, { memberProfileId: query.target }] } : {},
      query.requiredStatus ? { requiredStatus: query.requiredStatus } : {},
      search ? { OR: [
        { course: { title: { contains: search, mode: "insensitive" } } },
        { course: { code: { contains: search, mode: "insensitive" } } },
        { targetRole: { contains: search, mode: "insensitive" } },
        { group: { name: { contains: search, mode: "insensitive" } } },
        { memberProfile: { OR: [{ memberId: { contains: search, mode: "insensitive" } }, { firstName: { contains: search, mode: "insensitive" } }, { lastName: { contains: search, mode: "insensitive" } }] } },
      ] } : {},
    ] };
  }

  async function requirementRows(db: Db, where: Prisma.TrainingRequirementWhereInput, query: RequirementQuery) {
    return db.trainingRequirement.findMany({
      where: requirementFilter(where, query),
      include: requirementInclude,
      orderBy: [{ active: "desc" }, { updatedAt: "desc" }, { id: "asc" }],
      skip: query.offset,
      take: query.limit,
    });
  }

  async function operationReplay(tx: Prisma.TransactionClient, operationId: string, expectedFingerprint: string): Promise<{ mismatch: boolean; result?: any }> {
    const operation = await tx.trainingOperation.findUnique({ where: { operationId } });
    if (!operation) return { mismatch: false };
    if (operation.commandFingerprint !== expectedFingerprint) return { mismatch: true };
    return { mismatch: false, result: operation.result };
  }

  return {
    kind: "postgres",

    async resolveMemberForUser(actor) {
      const row = await client.memberProfile.findFirst({ where: { linkedUserId: actor.id, status: { not: "Archived" } }, select: memberSelect });
      return row ? memberRecord(row) : null;
    },

    async memberAccessible(memberProfileId, access) {
      return Boolean(await client.memberProfile.count({ where: { id: memberProfileId, ...visibility(access) } }));
    },

    async getGroup(groupId) {
      const row = await client.operationalGroup.findUnique({ where: { id: groupId }, select: groupSelect });
      return row ? groupRecord(row) : null;
    },

    async listCourses(query, access) {
      const search = query.search?.trim();
      const where: Prisma.TrainingCourseWhereInput = { AND: [
        query.active === undefined ? {} : { active: query.active },
        query.category ? { category: query.category } : {},
        search ? { OR: [{ code: { contains: search, mode: "insensitive" } }, { title: { contains: search, mode: "insensitive" } }, { category: { contains: search, mode: "insensitive" } }, { description: { contains: search, mode: "insensitive" } }] } : {},
        access.global ? {} : { records: { some: { memberProfile: visibility(access) } } },
      ] };
      const [total, rows] = await Promise.all([client.trainingCourse.count({ where }), client.trainingCourse.findMany({ where, select: courseSelect, orderBy: [{ active: "desc" }, { title: "asc" }], skip: query.offset, take: query.limit })]);
      return { total, limit: query.limit, offset: query.offset, data: rows.map(courseRecord) };
    },

    async getCourse(id, access) {
      const row = await client.trainingCourse.findFirst({ where: { id, ...(access.global ? {} : { records: { some: { memberProfile: visibility(access) } } }) }, select: courseSelect });
      return row ? courseRecord(row) : null;
    },

    async createCourse(input, actor) {
      try {
        const row = await serializable(client, async (tx) => {
          const value = await nextSequence(tx, "TrainingCourse_id_seq");
          const created = await tx.trainingCourse.create({ data: { id: businessId("crs", value), ...input, normalizedCode: normalizedCode(input.code), createdById: actor.id, updatedById: actor.id }, select: courseSelect });
          await audit(tx, actor, "create_training_course", "trainingCourse", created.id, "Course created", null, { courseId: created.id, code: created.code });
          return created;
        });
        return { record: courseRecord(row), conflict: false };
      } catch (error) { if (conflictError(error)) return { record: null, conflict: true, reason: "duplicate-code" }; throw error; }
    },

    async updateCourse(id, input, expectedVersion, actor) {
      try {
        return await serializable(client, async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "TrainingCourse" WHERE "id" = ${id} FOR UPDATE`;
          const current = await loadedCourse(tx, id);
          if (!current) return { record: null, conflict: false };
          if (current.version !== expectedVersion) return { record: null, conflict: true, reason: "stale" };
          const changed = await tx.trainingCourse.updateMany({ where: { id, version: expectedVersion }, data: { ...input, ...(input.code ? { normalizedCode: normalizedCode(input.code) } : {}), version: { increment: 1 }, updatedById: actor.id } });
          if (changed.count !== 1) return { record: null, conflict: true, reason: "stale" };
          await audit(tx, actor, "update_training_course", "trainingCourse", id, "Course updated", null, { courseId: id, versionBefore: expectedVersion, versionAfter: expectedVersion + 1 });
          return { record: courseRecord((await loadedCourse(tx, id))!), conflict: false };
        });
      } catch (error) { if (conflictError(error)) return { record: null, conflict: true, reason: "duplicate-code" }; throw error; }
    },

    async setCourseActive(id, active, expectedVersion, actor) {
      try {
        return await serializable(client, async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "TrainingCourse" WHERE "id" = ${id} FOR UPDATE`;
          const current = await loadedCourse(tx, id);
          if (!current) return { record: null, conflict: false };
          if (current.version !== expectedVersion || current.active === active) return { record: null, conflict: true, reason: "stale" };
          if (!active && await tx.trainingRequirement.count({ where: { courseId: id, active: true } })) return { record: null, conflict: true, reason: "active-requirements" };
          const changed = await tx.trainingCourse.updateMany({ where: { id, version: expectedVersion, active: !active }, data: { active, version: { increment: 1 }, updatedById: actor.id, ...(active ? { reactivatedAt: clock.now() } : { deactivatedAt: clock.now() }) } });
          if (changed.count !== 1) return { record: null, conflict: true, reason: "stale" };
          await audit(tx, actor, active ? "reactivate_training_course" : "deactivate_training_course", "trainingCourse", id, active ? "Course reactivated" : "Course deactivated", null, { courseId: id, versionBefore: expectedVersion, versionAfter: expectedVersion + 1 });
          return { record: courseRecord((await loadedCourse(tx, id))!), conflict: false };
        });
      } catch (error) { if (conflictError(error)) return { record: null, conflict: true, reason: "stale" }; throw error; }
    },

    async listRequirements(query, access, _now) {
      const where = requirementVisibility(access);
      const filter = requirementFilter(where, query);
      const [total, rows] = await Promise.all([client.trainingRequirement.count({ where: filter }), requirementRows(client, where, query)]);
      return { total, limit: query.limit, offset: query.offset, data: await Promise.all(rows.map((row) => requirementRecord(client, row))) };
    },

    async getRequirement(id, access, _now) {
      const row = await client.trainingRequirement.findFirst({ where: { id, ...requirementVisibility(access) }, include: requirementInclude });
      return row ? requirementRecord(client, row) : null;
    },

    async createRequirement(input, actor, incidentId = null) {
      if (input.targetType === "Role" && !supportedRoleTargets.includes(input.targetRole as any)) return { record: null, conflict: true, reason: "unsupported-role" };
      try {
        const row = await serializable(client, async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "TrainingCourse" WHERE "id" = ${input.courseId} FOR SHARE`;
          const course = await tx.trainingCourse.findUnique({ where: { id: input.courseId } });
          if (!course) return null;
          if (!course.active) throw new Error("inactive-course");
          if (input.groupId) { const group = await tx.operationalGroup.findUnique({ where: { id: input.groupId } }); if (!group || group.status === "Archived") throw new Error("inactive-target"); }
          if (input.memberProfileId) { const member = await tx.memberProfile.findUnique({ where: { id: input.memberProfileId } }); if (!member || member.status === "Archived") throw new Error("inactive-target"); }
          const value = await nextSequence(tx, "TrainingRequirement_id_seq");
          const created = await tx.trainingRequirement.create({ data: { id: businessId("trq", value), ...input, active: true, provenance: { source: "api", requestId: actor.requestId ?? null }, createdById: actor.id, updatedById: actor.id }, include: requirementInclude });
          await audit(tx, actor, "create_training_requirement", "trainingRequirement", created.id, "Requirement added", incidentId, { requirementId: created.id, courseId: created.courseId, targetType: created.targetType });
          return created;
        });
        return { record: row ? await requirementRecord(client, row) : null, conflict: false };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "inactive-course" || message === "inactive-target") return { record: null, conflict: true, reason: message };
        if (conflictError(error)) return { record: null, conflict: true, reason: "duplicate-requirement" };
        throw error;
      }
    },

    async updateRequirement(id, input, expectedVersion, actor, incidentId = null) {
      if (input.targetType === "Role" && !supportedRoleTargets.includes(input.targetRole as any)) return { record: null, conflict: true, reason: "unsupported-role" };
      try {
        return await serializable(client, async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "TrainingRequirement" WHERE "id" = ${id} FOR UPDATE`;
          const current = await loadedRequirement(tx, id);
          if (!current) return { record: null, conflict: false };
          if (!current.active || current.version !== expectedVersion) return { record: null, conflict: true, reason: "stale" };
          const courseId = input.courseId ?? current.courseId;
          const course = await tx.trainingCourse.findUnique({ where: { id: courseId } });
          if (!course?.active) return { record: null, conflict: true, reason: "inactive-course" };
          const targetType = input.targetType ?? current.targetType;
          const next = {
            ...input,
            targetType,
            targetRole: targetType === "Role" ? input.targetRole ?? current.targetRole : null,
            groupId: targetType === "Group" ? input.groupId ?? current.groupId : null,
            memberProfileId: targetType === "MemberProfile" ? input.memberProfileId ?? current.memberProfileId : null,
          };
          if (targetType === "Role" && !supportedRoleTargets.includes(next.targetRole as any)) return { record: null, conflict: true, reason: "unsupported-role" };
          if (next.groupId) { const group = await tx.operationalGroup.findUnique({ where: { id: next.groupId } }); if (!group || group.status === "Archived") return { record: null, conflict: true, reason: "inactive-target" }; }
          if (next.memberProfileId) { const member = await tx.memberProfile.findUnique({ where: { id: next.memberProfileId } }); if (!member || member.status === "Archived") return { record: null, conflict: true, reason: "inactive-target" }; }
          const changed = await tx.trainingRequirement.updateMany({ where: { id, version: expectedVersion, active: true }, data: { ...next, version: { increment: 1 }, updatedById: actor.id } });
          if (changed.count !== 1) return { record: null, conflict: true, reason: "stale" };
          await audit(tx, actor, "update_training_requirement", "trainingRequirement", id, "Requirement updated", incidentId, { requirementId: id, versionBefore: expectedVersion, versionAfter: expectedVersion + 1 });
          return { record: await requirementRecord(tx, (await loadedRequirement(tx, id))!), conflict: false };
        });
      } catch (error) { if (conflictError(error)) return { record: null, conflict: true, reason: "duplicate-requirement" }; throw error; }
    },

    async endRequirement(id, expectedVersion, effectiveTo, actor, incidentId = null) {
      try {
        return await serializable(client, async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "TrainingRequirement" WHERE "id" = ${id} FOR UPDATE`;
          const current = await loadedRequirement(tx, id);
          if (!current) return { record: null, conflict: false };
          if (!current.active || current.version !== expectedVersion) return { record: null, conflict: true, reason: "stale" };
          if (current.effectiveFrom && effectiveTo <= current.effectiveFrom) return { record: null, conflict: true, reason: "invalid-date" };
          const changed = await tx.trainingRequirement.updateMany({ where: { id, version: expectedVersion, active: true }, data: { active: false, effectiveTo, endedAt: effectiveTo, endedById: actor.id, version: { increment: 1 }, updatedById: actor.id } });
          if (changed.count !== 1) return { record: null, conflict: true, reason: "stale" };
          await audit(tx, actor, "end_training_requirement", "trainingRequirement", id, "Requirement ended", incidentId, { requirementId: id, versionBefore: expectedVersion, versionAfter: expectedVersion + 1 });
          return { record: await requirementRecord(tx, (await loadedRequirement(tx, id))!), conflict: false };
        });
      } catch (error) { if (conflictError(error)) return { record: null, conflict: true, reason: "stale" }; throw error; }
    },

    async listRecords(query, access, _actor, now) {
      const memberWhere = visibility(access);
      const search = query.search?.trim();
      const statusWhere: Prisma.MemberTrainingRecordWhereInput = query.status === "Expired" ? { status: "Completed", expiryAt: { lt: now } } : query.status === "Completed" ? { status: "Completed", OR: [{ expiryAt: null }, { expiryAt: { gte: now } }] } : query.status ? { status: query.status } : {};
      const baseWhere: Prisma.MemberTrainingRecordWhereInput = { AND: [
        { memberProfile: memberWhere },
        query.memberProfileId ? { memberProfileId: query.memberProfileId } : {},
        query.groupId ? { memberProfile: { memberships: { some: { groupId: query.groupId, removedAt: null } } } } : {},
        query.courseId ? { courseId: query.courseId } : {},
        query.category ? { course: { category: query.category } } : {},
        statusWhere,
        query.overdue ? { status: { in: activeStatuses }, dueAt: { lt: now } } : {},
        query.expiringWithin ? { status: "Completed", expiryAt: { gte: now, lte: new Date(now.getTime() + query.expiringWithin * 86_400_000) } } : {},
        search ? { OR: [{ operationalId: { contains: search, mode: "insensitive" } }, { memberProfile: { OR: [{ memberId: { contains: search, mode: "insensitive" } }, { firstName: { contains: search, mode: "insensitive" } }, { lastName: { contains: search, mode: "insensitive" } }] } }, { course: { OR: [{ code: { contains: search, mode: "insensitive" } }, { title: { contains: search, mode: "insensitive" } }, { category: { contains: search, mode: "insensitive" } }] } }] } : {},
      ] };
      const direction = query.direction;
      const orderBy: Prisma.MemberTrainingRecordOrderByWithRelationInput[] = query.sort === "member" ? [{ memberProfile: { lastName: direction } }, { memberProfile: { firstName: direction } }] : query.sort === "course" ? [{ course: { title: direction } }] : query.sort === "status" ? [{ status: direction }] : query.sort === "updatedAt" ? [{ updatedAt: direction }] : [{ dueAt: direction }, { operationalId: "asc" }];
      const [total, rows, assigned, inProgress, completed, expired, waived, cancelled, overdue, expiringSoon] = await Promise.all([
        client.memberTrainingRecord.count({ where: baseWhere }),
        client.memberTrainingRecord.findMany({ where: baseWhere, include: recordInclude, orderBy, skip: query.offset, take: query.limit }),
        client.memberTrainingRecord.count({ where: { memberProfile: memberWhere, status: "Assigned" } }),
        client.memberTrainingRecord.count({ where: { memberProfile: memberWhere, status: "In Progress" } }),
        client.memberTrainingRecord.count({ where: { memberProfile: memberWhere, status: "Completed", OR: [{ expiryAt: null }, { expiryAt: { gte: now } }] } }),
        client.memberTrainingRecord.count({ where: { memberProfile: memberWhere, status: "Completed", expiryAt: { lt: now } } }),
        client.memberTrainingRecord.count({ where: { memberProfile: memberWhere, status: "Waived" } }),
        client.memberTrainingRecord.count({ where: { memberProfile: memberWhere, status: "Cancelled" } }),
        client.memberTrainingRecord.count({ where: { memberProfile: memberWhere, status: { in: activeStatuses }, dueAt: { lt: now } } }),
        client.memberTrainingRecord.count({ where: { memberProfile: memberWhere, status: "Completed", expiryAt: { gte: now, lte: new Date(now.getTime() + 45 * 86_400_000) } } }),
      ]);
      const totals: TrainingTotals = { assigned, inProgress, completed, expired, waived, cancelled, overdue, expiringSoon };
      return { total, limit: query.limit, offset: query.offset, data: rows.map((row) => recordRecord(row, now)), totals };
    },

    async getRecord(id, access, _actor, now) {
      const row = await client.memberTrainingRecord.findFirst({ where: { id, memberProfile: visibility(access) }, include: recordInclude });
      return row ? recordRecord(row, now) : null;
    },

    async assign(input, actor, incidentId = null) {
      const fp = fingerprint("assign", input.groupId ?? input.memberProfileId ?? "", input);
      try {
        const result = await serializable(client, async (tx): Promise<MutationResult<AssignTrainingResult>> => {
          const replay = await operationReplay(tx, input.operationId, fp);
          if (replay.mismatch) return { record: null, conflict: true, reason: "operation-misuse" };
          if (replay.result) return { record: replay.result as AssignTrainingResult, conflict: false, idempotent: true };
          await tx.$queryRaw`SELECT "id" FROM "TrainingCourse" WHERE "id" = ${input.courseId} FOR SHARE`;
          const course = await tx.trainingCourse.findUnique({ where: { id: input.courseId }, select: courseSelect });
          if (!course) return { record: null, conflict: false };
          if (!course.active) return { record: null, conflict: true, reason: "inactive-course" };
          const now = clock.now();
          let requirement: RequirementRow | null = null;
          if (input.sourceRequirementId) {
            await tx.$queryRaw`SELECT "id" FROM "TrainingRequirement" WHERE "id" = ${input.sourceRequirementId} FOR SHARE`;
            requirement = await loadedRequirement(tx, input.sourceRequirementId);
            if (!requirement || !requirement.active || requirement.courseId !== input.courseId || (requirement.effectiveFrom && requirement.effectiveFrom > now) || requirement.effectiveTo) return { record: null, conflict: true, reason: "invalid-requirement" };
          }
          let group: GroupRow | null = null;
          let members: MemberRow[] = [];
          if (input.groupId) {
            await tx.$queryRaw`SELECT "id" FROM "OperationalGroup" WHERE "id" = ${input.groupId} FOR SHARE`;
            await tx.$queryRaw`SELECT "id" FROM "GroupMembership" WHERE "groupId" = ${input.groupId} AND "removedAt" IS NULL FOR SHARE`;
            group = await tx.operationalGroup.findUnique({ where: { id: input.groupId }, select: groupSelect });
            if (!group || group.status === "Archived") return { record: null, conflict: true, reason: "inactive-target" };
            members = await tx.memberProfile.findMany({ where: { status: { not: "Archived" }, memberships: { some: { groupId: input.groupId, removedAt: null } } }, select: memberSelect, orderBy: { id: "asc" } });
          } else if (input.memberProfileId) {
            await tx.$queryRaw`SELECT "id" FROM "MemberProfile" WHERE "id" = ${input.memberProfileId} FOR SHARE`;
            const member = await tx.memberProfile.findUnique({ where: { id: input.memberProfileId }, select: memberSelect });
            if (!member) return { record: null, conflict: false };
            if (member.status === "Archived") return { record: null, conflict: true, reason: "inactive-target" };
            members = [member];
          }
          if (!members.length) return { record: null, conflict: true, reason: "empty-target" };
          if (input.groupId) {
            await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "MemberProfile" WHERE "id" IN (${Prisma.join(members.map((member) => member.id))}) FOR SHARE`);
          }
          if (requirement) {
            const applicable = await tx.memberProfile.findMany({
              where: {
                AND: [
                  { id: { in: members.map((member) => member.id) }, status: { not: "Archived" } },
                  await targetMemberWhere(requirement),
                ],
              },
              select: { id: true },
            });
            if (applicable.length !== members.length) return { record: null, conflict: true, reason: "requirement-target-mismatch" };
          }
          const createdRows: RecordRow[] = [];
          let skippedCount = 0;
          for (const member of members) {
            const value = await nextSequence(tx, "MemberTrainingRecord_id_seq");
            const id = businessId("trn", value);
            const operationalId = businessId("TRN", value);
            const inserted = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
              INSERT INTO "MemberTrainingRecord" ("id", "operationalId", "memberProfileId", "courseId", "sourceRequirementId", "assignedAt", "assignedById", "dueAt", "status", "version", "provenance", "createdById", "updatedById", "createdAt", "updatedAt")
              VALUES (${id}, ${operationalId}, ${member.id}, ${input.courseId}, ${input.sourceRequirementId ?? null}, ${input.assignedAt ?? now}, ${actor.id}::uuid, ${input.dueAt ?? null}, 'Assigned', 1, ${JSON.stringify({ source: "api", operationId: input.operationId })}::jsonb, ${actor.id}::uuid, ${actor.id}::uuid, ${now}, ${now})
              ON CONFLICT ("memberProfileId", "courseId") WHERE "status" IN ('Assigned', 'In Progress') DO NOTHING
              RETURNING "id"
            `);
            if (!inserted.length) { skippedCount += 1; continue; }
            createdRows.push((await loadedRecord(tx, id))!);
          }
          if (!input.groupId && createdRows.length !== 1) return { record: null, conflict: true, reason: "active-duplicate" };
          if (input.groupId && !createdRows.length && skippedCount === 0) return { record: null, conflict: true, reason: "empty-target" };
          const records = createdRows.map((row) => recordRecord(row, now));
          const snapshot: AssignTrainingResult = input.groupId && group ? { targetType: "Group", group: groupRecord(group), course: courseRecord(course), assignedCount: records.length, skippedCount, records } : records[0]!;
          await tx.trainingOperation.create({ data: { operationId: input.operationId, memberTrainingId: input.groupId ? null : records[0]!.id, command: "assign", commandFingerprint: fp, resultVersion: 1, result: stable(snapshot) as Prisma.InputJsonValue, requestId: actor.requestId } });
          await audit(tx, actor, "assign_training", input.groupId ? "trainingGroup" : "trainingRecord", input.groupId ?? records[0]!.id, input.groupId ? "Training assigned to group" : "Training assigned", input.groupId ? incidentId : null, { courseId: input.courseId, groupId: input.groupId ?? null, memberProfileId: input.memberProfileId ?? null, assignedCount: records.length, skippedCount, recordIds: records.map((record) => record.id), operationId: input.operationId });
          return { record: snapshot, conflict: false };
        });
        return result.idempotent && result.record ? { ...result, record: { ...(result.record as any), idempotent: true } } : result;
      } catch (error) { if (conflictError(error)) return { record: null, conflict: true, reason: "concurrent-conflict" }; throw error; }
    },

    async updateRecord(id, input, expectedVersion, actor) {
      try {
        return await serializable(client, async (tx) => {
          const current = await loadedRecord(tx, id);
          if (!current) return { record: null, conflict: false };
          if (current.version !== expectedVersion || !activeStatuses.includes(current.status)) return { record: null, conflict: true, reason: "stale" };
          const changed = await tx.memberTrainingRecord.updateMany({ where: { id, version: expectedVersion, status: { in: activeStatuses } }, data: { ...input, version: { increment: 1 }, updatedById: actor.id } });
          if (changed.count !== 1) return { record: null, conflict: true, reason: "stale" };
          await audit(tx, actor, "update_training_record", "trainingRecord", id, "Training updated", null, { recordId: id, versionBefore: expectedVersion, versionAfter: expectedVersion + 1 });
          return { record: recordRecord((await loadedRecord(tx, id))!, clock.now()), conflict: false };
        });
      } catch (error) { if (conflictError(error)) return { record: null, conflict: true, reason: "stale" }; throw error; }
    },

    async command(id, command, input, actor) {
      const fp = fingerprint(command, id, input);
      try {
        const result = await serializable(client, async (tx): Promise<MutationResult<MemberTrainingRecord>> => {
          const replay = await operationReplay(tx, input.operationId, fp);
          if (replay.mismatch) return { record: null, conflict: true, reason: "operation-misuse" };
          if (replay.result) return { record: replay.result as MemberTrainingRecord, conflict: false, idempotent: true };
          await tx.$queryRaw`SELECT "id" FROM "MemberTrainingRecord" WHERE "id" = ${id} FOR UPDATE`;
          const current = await loadedRecord(tx, id);
          if (!current) return { record: null, conflict: false };
          if (current.version !== input.expectedVersion) return { record: null, conflict: true, reason: "stale" };
          const now = clock.now();
          let data: Prisma.MemberTrainingRecordUncheckedUpdateManyInput;
          if (command === "start") {
            if (current.status !== "Assigned") return { record: null, conflict: true, reason: "invalid-transition" };
            data = { status: "In Progress", startedAt: now, startedById: actor.id };
          } else if (command === "complete") {
            if (!activeStatuses.includes(current.status) || !input.completedAt) return { record: null, conflict: true, reason: "invalid-transition" };
            data = { status: "Completed", completedAt: input.completedAt, completedById: actor.id, expiryAt: current.course.validityMonths ? calendarMonths(input.completedAt, current.course.validityMonths) : null, score: input.score, completionNote: input.completionNote, completionRef: input.completionRef, waivedAt: null, waivedById: null, waiverReason: null, cancelledAt: null, cancelledById: null, cancelledReason: null };
          } else if (command === "verify") {
            if (current.status !== "Completed" || current.verifiedAt) return { record: null, conflict: true, reason: current.verifiedAt ? "already-verified" : "invalid-transition" };
            data = { verifiedAt: input.verifiedAt ?? now, verifiedById: actor.id };
          } else if (command === "waive") {
            if (!activeStatuses.includes(current.status) || !input.reason) return { record: null, conflict: true, reason: "invalid-transition" };
            data = { status: "Waived", waivedAt: now, waivedById: actor.id, waiverReason: input.reason };
          } else {
            if (!activeStatuses.includes(current.status) || !input.reason) return { record: null, conflict: true, reason: "invalid-transition" };
            data = { status: "Cancelled", cancelledAt: now, cancelledById: actor.id, cancelledReason: input.reason };
          }
          const changed = await tx.memberTrainingRecord.updateMany({ where: { id, version: input.expectedVersion }, data: { ...data, version: { increment: 1 }, updatedById: actor.id } });
          if (changed.count !== 1) return { record: null, conflict: true, reason: "stale" };
          const snapshot = recordRecord((await loadedRecord(tx, id))!, now);
          await tx.trainingOperation.create({ data: { operationId: input.operationId, memberTrainingId: id, command, commandFingerprint: fp, resultVersion: snapshot.version, result: stable(snapshot) as Prisma.InputJsonValue, requestId: actor.requestId } });
          const summaries = { start: "Training started", complete: "Completion recorded", verify: "Completion verified", waive: "Training waived", cancel: "Training cancelled" };
          await audit(tx, actor, `${command}_training`, "trainingRecord", id, summaries[command], null, { recordId: id, versionBefore: input.expectedVersion, versionAfter: snapshot.version, operationId: input.operationId });
          return { record: snapshot, conflict: false };
        });
        return result.idempotent && result.record ? { ...result, record: { ...result.record, idempotent: true } } : result;
      } catch (error) { if (conflictError(error)) return { record: null, conflict: true, reason: "concurrent-conflict" }; throw error; }
    },

    async evaluateMemberCompliance(memberProfileId, _actor, evaluationAt, expiringSoonDays) {
      const member = await client.memberProfile.findUnique({ where: { id: memberProfileId }, select: memberSelect });
      if (!member) return null;
      const all = await client.trainingRequirement.findMany({ where: { active: true, OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: evaluationAt } }], AND: [{ OR: [{ effectiveTo: null }, { effectiveTo: { gt: evaluationAt } }] }] }, include: requirementInclude, orderBy: { id: "asc" } });
      const applicable: RequirementRow[] = [];
      for (const requirement of all) {
        if (await client.memberProfile.count({ where: { id: memberProfileId, ...(await targetMemberWhere(requirement)) } })) applicable.push(requirement);
      }
      const grouped = new Map<string, RequirementRow[]>();
      for (const requirement of applicable) grouped.set(requirement.courseId, [...(grouped.get(requirement.courseId) ?? []), requirement]);
      const records = await client.memberTrainingRecord.findMany({ where: { memberProfileId, status: { not: "Cancelled" } }, include: recordInclude, orderBy: { updatedAt: "desc" } });
      const items: Array<Record<string, any>> = [];
      for (const [courseId, requirements] of grouped) {
        const course = requirements[0]!.course;
        const candidates = records.filter((record) => record.courseId === courseId).sort((left, right) => {
          const rank = (row: RecordRow) => { const status = effectiveStatus(row, evaluationAt); return status === "Completed" || status === "Waived" ? 0 : activeStatuses.includes(row.status) && !isOverdue(row, evaluationAt) ? 1 : activeStatuses.includes(row.status) ? 2 : status === "Expired" ? 3 : 4; };
          return rank(left) - rank(right) || right.updatedAt.getTime() - left.updatedAt.getTime();
        });
        const record = candidates[0] ?? null;
        const required = requirements.some((requirement) => requirement.requiredStatus === "Required");
        const dueAt = record?.dueAt ?? requirements.map((requirement) => requirement.dueAt).filter(Boolean).sort((a, b) => a!.getTime() - b!.getTime())[0] ?? null;
        const overdue = record ? isOverdue(record, evaluationAt) : Boolean(dueAt && dueAt < evaluationAt);
        const expiringSoon = record ? isExpiringSoon(record, evaluationAt, expiringSoonDays) : false;
        const recordStatus = record ? effectiveStatus(record, evaluationAt) : null;
        let status: "Compliant" | "Attention" | "Non-compliant" = "Attention";
        if (!record) status = overdue && required ? "Non-compliant" : "Attention";
        else if (recordStatus === "Completed" || recordStatus === "Waived") status = expiringSoon ? "Attention" : "Compliant";
        else if (recordStatus === "Expired" || overdue) status = required ? "Non-compliant" : "Attention";
        items.push({ courseId, course: courseRecord(course), requiredStatus: required ? "Required" : "Recommended", status, dueAt, expiringSoon, sourceRequirementIds: requirements.map((requirement) => requirement.id), sourceRequirements: requirements.map((requirement) => ({ id: requirement.id, targetType: requirement.targetType, targetLabel: targetLabel(requirement), requiredStatus: requirement.requiredStatus, dueAt: requirement.dueAt })), record: record ? recordRecord(record, evaluationAt) : null });
      }
      const status: TrainingCompliance["status"] = !items.length ? "Not applicable" : items.some((item) => item.requiredStatus === "Required" && item.status === "Non-compliant") ? "Non-compliant" : items.some((item) => item.status !== "Compliant") ? "Attention" : "Compliant";
      return { memberProfileId, member: memberRecord(member), evaluationAt: evaluationAt.toISOString(), expiringSoonDays, status, totals: { required: items.filter((item) => item.requiredStatus === "Required").length, recommended: items.filter((item) => item.requiredStatus === "Recommended").length, compliant: items.filter((item) => item.status === "Compliant").length, attention: items.filter((item) => item.status === "Attention").length, nonCompliant: items.filter((item) => item.status === "Non-compliant").length }, items };
    },

    async memberTrainingStatus(memberProfileId, evaluationAt) {
      const result = await this.evaluateMemberCompliance(memberProfileId, { id: "00000000-0000-0000-0000-000000000000", email: "projection@internal", displayName: "Projection", roles: [], permissions: [] }, evaluationAt, 45);
      return result?.status ?? "Not applicable";
    },
  };
}
