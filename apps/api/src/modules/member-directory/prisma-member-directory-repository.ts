import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { HttpError } from "../../errors.js";
import { permissionScope } from "../../scope-policy.js";
import type { DirectoryActor as LegacyDirectoryActor } from "../../member-directory.js";
import type { FoundationMemberDirectoryRepository, MutationResult, PersistedRoleAssignment, RoleScopeInput } from "./member-directory-repository.js";
import type {
  CreateGroupInput,
  CreateMemberInput,
  DirectoryActor,
  GroupQuery,
  GroupRecord,
  MemberProfileRecord,
  MemberQuery,
  Page,
  UpdateGroupInput,
  UpdateMemberInput,
} from "./member-directory-types.js";

type Db = PrismaClient | Prisma.TransactionClient;
type MemberRow = Prisma.MemberProfileGetPayload<Record<string, never>>;
const memberProjectionInclude = {
  availabilityRecords: { where: { status: "Active" }, orderBy: [{ startAt: "asc" as const }, { id: "asc" as const }], take: 1 },
  rosterShifts: { where: { status: { in: ["Draft", "Published", "Confirmed", "Declined"] } }, orderBy: [{ startAt: "asc" as const }, { id: "asc" as const }], take: 1 },
};
type GroupRow = Prisma.OperationalGroupGetPayload<{
  include: { memberships: { include: { memberProfile: true } }; rosterShifts: { select: { id: true } } };
}>;

const derivedFields = {
  availability: "postgres-projection",
  trainingStatus: "postgres-projection",
  rosterStatus: "postgres-projection",
  assignedLeader: "legacy-compatibility",
} as const;

function displayName(member: Pick<MemberRow, "firstName" | "lastName">) {
  return [member.firstName, member.lastName].filter(Boolean).join(" ").trim();
}

function canSeeContact(actor: DirectoryActor) {
  return permissionScope(actor as LegacyDirectoryActor, "member:update").allowed ||
    permissionScope(actor as LegacyDirectoryActor, "member:create").global ||
    actor.permissions.includes("admin:manage");
}

function memberRecord(member: MemberRow, actor: DirectoryActor, trainingStatus?: string): MemberProfileRecord {
  const contact = canSeeContact(actor);
  const projected = member as MemberRow & { availabilityRecords?: Array<{ id: string; operationalId: string; type: string; startAt: Date; endAt: Date }>; rosterShifts?: Array<{ id: string; operationalId: string; status: string; startAt: Date; endAt: Date }> };
  const availability = projected.availabilityRecords?.[0] ?? null;
  const roster = projected.rosterShifts?.[0] ?? null;
  return {
    id: member.id,
    memberId: member.memberId,
    volunteerId: member.memberId,
    linkedUserId: contact ? member.linkedUserId : undefined,
    firstName: member.firstName,
    lastName: member.lastName,
    displayName: displayName(member),
    pool: member.pool as MemberProfileRecord["pool"],
    role: member.role,
    assignedFunction: member.assignedFunction,
    contactEmail: contact ? member.contactEmail : undefined,
    phone: contact ? member.phone : undefined,
    languages: member.languages,
    status: member.status as MemberProfileRecord["status"],
    version: member.version,
    availability: availability ? `${availability.type} ${availability.startAt.toISOString()}–${availability.endAt.toISOString()}` : "Managed in Availability",
    trainingStatus: trainingStatus ?? member.legacyTrainingStatus ?? "Managed in Training",
    rosterStatus: roster ? `${roster.status} ${roster.operationalId}` : "Managed in Rostering",
    availabilitySummary: availability,
    rosterSummary: roster,
    assignedLeader: member.legacyAssignedLeader,
    derivedFields,
    createdAt: member.createdAt,
    updatedAt: member.updatedAt,
  };
}

function groupRecord(group: GroupRow): GroupRecord {
  const active = group.memberships.filter((membership) => !membership.removedAt);
  const leader = active.find((membership) => membership.role === "Leader");
  return {
    id: group.id,
    operationalId: group.operationalId,
    incidentId: group.incidentId,
    sessionId: group.incidentId,
    name: group.name,
    pool: group.pool as GroupRecord["pool"],
    functionName: group.functionName,
    status: group.status as GroupRecord["status"],
    notes: group.notes,
    version: group.version,
    leaderId: leader?.memberProfileId ?? "",
    leaderName: leader ? displayName(leader.memberProfile) : "",
    leaderMemberId: leader?.memberProfile.memberId ?? "",
    memberIds: active.map((membership) => membership.memberProfileId),
    memberCount: active.length,
    memberships: active.map((membership) => ({
      id: membership.id,
      groupId: membership.groupId,
      memberProfileId: membership.memberProfileId,
      role: membership.role,
      addedAt: membership.addedAt,
      addedById: membership.addedById,
      updatedAt: membership.updatedAt,
      removedAt: membership.removedAt,
      removedById: membership.removedById,
    })),
    rosterShiftIds: group.rosterShifts.map((shift) => shift.id),
    rosterLinkCount: group.rosterShifts.length,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  };
}

function normalizeEmail(value?: string | null) {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

function classifiedMemberChange(current: MemberRow, input: UpdateMemberInput) {
  return Object.fromEntries(Object.keys(input).map((field) => {
    if (field === "contactEmail" || field === "phone") {
      const before = Boolean(current[field]);
      const after = Boolean(input[field]);
      return [field, { before: before ? "present" : "absent", after: after ? "present" : "absent" }];
    }
    if (field === "linkedUserId") {
      return [field, { before: current.linkedUserId ? "linked" : "unlinked", after: input.linkedUserId ? "linked" : "unlinked" }];
    }
    if (field === "languages") {
      return [field, { before: current.languages.length ? "present" : "absent", after: input.languages?.length ? "present" : "absent" }];
    }
    return [field, { before: "recorded", after: "changed" }];
  }));
}

function isConflict(error: unknown) {
  if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2028", "P2034"].includes(error.code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /could not serialize access|serialization conflict|unique constraint|transaction.*conflict/i.test(message);
}

function isSerializationConflict(error: unknown) {
  if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2028", "P2034"].includes(error.code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /could not serialize access|serialization conflict|transaction.*conflict/i.test(message);
}

function groupInclude() {
  return {
    memberships: {
      where: { removedAt: null },
      include: { memberProfile: true },
      orderBy: [{ role: "asc" as const }, { addedAt: "asc" as const }],
    },
    rosterShifts: { select: { id: true }, orderBy: { startAt: "asc" as const } },
  };
}

async function audit(db: Db, actor: DirectoryActor, action: string, entityType: string, entityId: string, summary: string, sessionId: string | null, metadata: Record<string, unknown>) {
  await db.auditLog.create({
    data: {
      action,
      entityType,
      entityId,
      sessionId,
      actorId: actor.id,
      actorEmail: actor.email,
      summary,
      metadata: { ...metadata, requestId: actor.requestId ?? null },
    },
  });
}

async function sequence(db: Db, name: string) {
  const rows = await db.$queryRawUnsafe<Array<{ value: bigint }>>(`SELECT nextval('"${name}"') AS value`);
  return Number(rows[0]!.value);
}

function memberVisibility(actor: DirectoryActor, permission: string): Prisma.MemberProfileWhereInput {
  const scope = permissionScope(actor as LegacyDirectoryActor, permission);
  if (scope.global) return {};
  return {
    OR: [
      { linkedUserId: actor.id },
      { memberships: { some: { removedAt: null, groupId: { in: [...scope.groupIds] } } } },
    ],
  };
}

function groupVisibility(actor: DirectoryActor, permission: string): Prisma.OperationalGroupWhereInput {
  const scope = permissionScope(actor as LegacyDirectoryActor, permission);
  if (scope.global) return {};
  return {
    OR: [
      { id: { in: [...scope.groupIds] } },
      { memberships: { some: { removedAt: null, memberProfile: { linkedUserId: actor.id, status: { not: "Archived" } } } } },
    ],
  };
}

async function loadedGroup(db: Db, incidentId: string, id: string) {
  return db.operationalGroup.findFirst({ where: { id, incidentId }, include: groupInclude() });
}

function roleAssignmentRecord(input: { id: string; userId: string; groupId: string; status: string; version: number; role: { name: string } }): PersistedRoleAssignment {
  return {
    id: input.id,
    userId: input.userId,
    roleName: input.role.name,
    scopeType: "GROUP",
    scopeId: input.groupId,
    status: input.status === "Active" ? "Active" : "Revoked",
    version: input.version,
  };
}

export function createPrismaMemberDirectoryRepository(client: PrismaClient, trainingStatus?: (memberProfileId: string) => Promise<string>): FoundationMemberDirectoryRepository {
  const projectMember = async (row: MemberRow, actor: DirectoryActor) => memberRecord(row, actor, trainingStatus ? await trainingStatus(row.id) : undefined);
  async function mutateGroup(
    incidentId: string,
    groupId: string,
    expectedVersion: number,
    actor: DirectoryActor,
    action: (tx: Prisma.TransactionClient, group: Awaited<ReturnType<typeof loadedGroup>>) => Promise<Prisma.OperationalGroupUncheckedUpdateManyInput | void>,
    auditAction: string,
    summary: string,
    metadata: Record<string, unknown> | ((group: NonNullable<Awaited<ReturnType<typeof loadedGroup>>>) => Record<string, unknown>),
  ): Promise<MutationResult<GroupRecord>> {
    try {
      return await client.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "OperationalGroup" WHERE "id" = ${groupId} AND "incidentId" = ${incidentId}::uuid FOR UPDATE`;
        const group = await loadedGroup(tx, incidentId, groupId);
        if (!group) return { record: null, conflict: false };
        if (group.version !== expectedVersion || group.status === "Archived") return { record: null, conflict: true };
        const groupChange = await action(tx, group);
        const changed = await tx.operationalGroup.updateMany({
          where: { id: groupId, incidentId, version: expectedVersion, status: { not: "Archived" } },
          data: { ...(groupChange ?? {}), version: { increment: 1 }, updatedById: actor.id },
        });
        if (changed.count !== 1) return { record: null, conflict: true };
        const auditMetadata = typeof metadata === "function" ? metadata(group) : metadata;
        await audit(tx, actor, auditAction, "group", groupId, summary, incidentId, { groupId, versionBefore: expectedVersion, versionAfter: expectedVersion + 1, ...auditMetadata });
        return { record: groupRecord((await loadedGroup(tx, incidentId, groupId))!), conflict: false };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (isConflict(error)) return { record: null, conflict: true };
      throw error;
    }
  }

  return {
    kind: "postgres",

    async resolveUserId(email) {
      return (await client.user.findUnique({ where: { email: email.trim().toLowerCase() }, select: { id: true } }))?.id ?? null;
    },

    async listMembers(query, actor) {
      const search = query.search?.trim();
      const where: Prisma.MemberProfileWhereInput = {
        AND: [
          memberVisibility(actor, "member:read"),
          query.status ? { status: query.status } : { status: { not: "Archived" } },
          query.pool ? { pool: query.pool } : {},
          query.functionName ? { assignedFunction: query.functionName } : {},
          query.groupId ? { memberships: { some: { groupId: query.groupId, removedAt: null } } } : {},
          search ? { OR: [
            { memberId: { contains: search, mode: "insensitive" } },
            { firstName: { contains: search, mode: "insensitive" } },
            { lastName: { contains: search, mode: "insensitive" } },
            { role: { contains: search, mode: "insensitive" } },
            { assignedFunction: { contains: search, mode: "insensitive" } },
            ...(canSeeContact(actor) ? [
              { contactEmail: { contains: search, mode: "insensitive" as const } },
              { phone: { contains: search, mode: "insensitive" as const } },
            ] : []),
          ] } : {},
        ],
      };
      const orderBy: Prisma.MemberProfileOrderByWithRelationInput = query.sortBy === "displayName"
        ? { lastName: query.sortDirection }
        : { [query.sortBy]: query.sortDirection };
      const [total, rows] = await client.$transaction([
        client.memberProfile.count({ where }),
        client.memberProfile.findMany({ where, include: memberProjectionInclude, orderBy: [orderBy, { id: "asc" }], take: query.limit, skip: query.offset }),
      ]);
      return { total, limit: query.limit, offset: query.offset, data: await Promise.all(rows.map((row) => projectMember(row, actor))) };
    },

    async getMember(id, actor) {
      const row = await client.memberProfile.findFirst({ where: { id, AND: [memberVisibility(actor, "member:read")] }, include: memberProjectionInclude });
      return row ? projectMember(row, actor) : null;
    },

    async listEligibleUsers(search, currentMemberId, limit, offset) {
      const where: Prisma.UserWhereInput = {
        status: "active",
        AND: [
          search ? { OR: [{ email: { contains: search, mode: "insensitive" } }, { displayName: { contains: search, mode: "insensitive" } }] } : {},
          { linkedMemberProfiles: { none: { status: { not: "Archived" }, ...(currentMemberId ? { id: { not: currentMemberId } } : {}) } } },
        ],
      };
      const [total, users] = await client.$transaction([
        client.user.count({ where }),
        client.user.findMany({ where, select: { id: true, email: true, displayName: true, roles: { include: { role: true } } }, orderBy: [{ displayName: "asc" }, { id: "asc" }], take: limit, skip: offset }),
      ]);
      return { total, limit, offset, data: users.map((user) => ({ id: user.id, userId: user.id, email: user.email, displayName: user.displayName, roles: user.roles.map((item) => item.role.name) })) };
    },

    async createMember(input, actor) {
      try {
        return await client.$transaction(async (tx) => {
          if (input.linkedUserId && !(await tx.user.findFirst({ where: { id: input.linkedUserId, status: "active" } }))) throw new HttpError(400, "Linked user account was not found");
          const profileNumber = await sequence(tx, "MemberProfile_id_seq");
          const businessNumber = input.memberId ? null : await sequence(tx, "MemberProfile_business_seq");
          const row = await tx.memberProfile.create({ data: {
            id: `mem-${new Date().getUTCFullYear()}-${String(profileNumber).padStart(6, "0")}`,
            memberId: input.memberId ?? `${input.pool}-${String(businessNumber).padStart(3, "0")}`,
            linkedUserId: input.linkedUserId,
            firstName: input.firstName,
            lastName: input.lastName,
            pool: input.pool,
            role: input.role,
            assignedFunction: input.assignedFunction,
            contactEmail: input.contactEmail,
            normalizedContactEmail: normalizeEmail(input.contactEmail),
            phone: input.phone,
            languages: input.languages,
            status: input.status ?? "Active",
            createdById: actor.id,
            updatedById: actor.id,
          } });
          await audit(tx, actor, "create_member_profile", "memberProfile", row.id, "Member created", null, {
            memberProfileId: row.id,
            memberId: row.memberId,
            changedFields: ["memberId", "linkedUserId", "firstName", "lastName", "pool", "role", "assignedFunction", "contactEmail", "phone", "languages", "status"],
            beforeAfterClassification: { before: "absent", after: "active_profile" },
            versionAfter: 1,
          });
          return { record: await projectMember(row, actor), conflict: false };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (isConflict(error)) return { record: null, conflict: true };
        throw error;
      }
    },

    async updateMember(id, input, expectedVersion, actor) {
      try {
        return await client.$transaction(async (tx) => {
          const current = await tx.memberProfile.findFirst({ where: { id, AND: [memberVisibility(actor, "member:update")] } });
          if (!current) return { record: null, conflict: false };
          if (current.version !== expectedVersion || current.status === "Archived") return { record: null, conflict: true };
          if (input.linkedUserId && !(await tx.user.findFirst({ where: { id: input.linkedUserId, status: "active" } }))) throw new HttpError(400, "Linked user account was not found");
          const data: Prisma.MemberProfileUncheckedUpdateManyInput = {
            ...(input.memberId !== undefined ? { memberId: input.memberId } : {}),
            ...(input.linkedUserId !== undefined ? { linkedUserId: input.linkedUserId } : {}),
            ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
            ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
            ...(input.pool !== undefined ? { pool: input.pool } : {}),
            ...(input.role !== undefined ? { role: input.role } : {}),
            ...(input.assignedFunction !== undefined ? { assignedFunction: input.assignedFunction } : {}),
            ...(input.contactEmail !== undefined ? { contactEmail: input.contactEmail, normalizedContactEmail: normalizeEmail(input.contactEmail) } : {}),
            ...(input.phone !== undefined ? { phone: input.phone } : {}),
            ...(input.languages !== undefined ? { languages: input.languages } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            version: { increment: 1 },
            updatedById: actor.id,
          };
          const changed = await tx.memberProfile.updateMany({ where: { id, version: expectedVersion, status: { not: "Archived" }, AND: [memberVisibility(actor, "member:update")] }, data });
          if (changed.count !== 1) return { record: null, conflict: true };
          const row = await tx.memberProfile.findUniqueOrThrow({ where: { id } });
          const changedFields = Object.keys(input);
          await audit(tx, actor, "update_member_profile", "memberProfile", id, "Member updated", null, {
            memberProfileId: id,
            changedFields,
            beforeAfterClassification: classifiedMemberChange(current, input),
            versionBefore: expectedVersion,
            versionAfter: expectedVersion + 1,
          });
          return { record: await projectMember(row, actor), conflict: false };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (isConflict(error)) return { record: null, conflict: true };
        throw error;
      }
    },

    async archiveMember(id, expectedVersion, actor) {
      try {
        return await client.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "MemberProfile" WHERE "id" = ${id} FOR UPDATE`;
          const visible = await tx.memberProfile.findFirst({ where: { id, AND: [memberVisibility(actor, "member:archive")] } });
          if (!visible) return { record: null, conflict: false };
          if (await tx.groupMembership.findFirst({ where: { memberProfileId: id, removedAt: null } })) throw new HttpError(409, "Remove this member from active groups before archiving");
          if (await tx.rosterShift.findFirst({ where: { assignedMemberProfileId: id, status: { in: ["Draft", "Published", "Confirmed"] } } })) throw new HttpError(409, "Resolve active roster shifts before archiving this member");
          const changed = await tx.memberProfile.updateMany({ where: { id, version: expectedVersion, status: { not: "Archived" }, AND: [memberVisibility(actor, "member:archive")] }, data: { status: "Archived", linkedUserId: null, version: { increment: 1 }, updatedById: actor.id } });
          if (changed.count !== 1) return { record: null, conflict: true };
          const row = await tx.memberProfile.findUniqueOrThrow({ where: { id } });
          await audit(tx, actor, "archive_member_profile", "memberProfile", id, "Profile archived", null, { memberProfileId: id, changedFields: ["status", "linkedUserId"], beforeAfterClassification: { status: { before: visible.status, after: "Archived" }, linkedUserId: { before: visible.linkedUserId ? "linked" : "unlinked", after: "unlinked" } }, versionBefore: expectedVersion, versionAfter: expectedVersion + 1 });
          return { record: await projectMember(row, actor), conflict: false };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (isConflict(error)) return { record: null, conflict: true };
        throw error;
      }
    },

    async restoreMember(id, expectedVersion, actor) {
      return client.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "MemberProfile" WHERE "id" = ${id} FOR UPDATE`;
        const visible = await tx.memberProfile.findFirst({ where: { id, AND: [memberVisibility(actor, "member:archive")] } });
        if (!visible) return { record: null, conflict: false };
        const changed = await tx.memberProfile.updateMany({ where: { id, version: expectedVersion, status: "Archived", AND: [memberVisibility(actor, "member:archive")] }, data: { status: "Active", version: { increment: 1 }, updatedById: actor.id } });
        if (changed.count !== 1) return { record: null, conflict: true };
        const row = await tx.memberProfile.findUniqueOrThrow({ where: { id } });
        await audit(tx, actor, "restore_member_profile", "memberProfile", id, "Profile restored", null, { memberProfileId: id, versionBefore: expectedVersion, versionAfter: expectedVersion + 1 });
        return { record: await projectMember(row, actor), conflict: false };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    },

    async listGroups(incidentId, query, actor) {
      const search = query.search?.trim();
      const where: Prisma.OperationalGroupWhereInput = { ...(incidentId
        ? { incidentId }
        : actor.permissions.includes("admin:manage")
          ? {}
          : { incident: { incidentAssignments: { some: { userId: actor.id, active: true } } } }), AND: [
        groupVisibility(actor, "group:read"),
        query.status ? { status: query.status } : { status: { not: "Archived" } },
        query.pool ? { pool: query.pool } : {},
        query.functionName ? { functionName: query.functionName } : {},
        search ? { OR: [
          { operationalId: { contains: search, mode: "insensitive" } },
          { name: { contains: search, mode: "insensitive" } },
          { functionName: { contains: search, mode: "insensitive" } },
          { memberships: { some: { removedAt: null, memberProfile: { OR: [
            { memberId: { contains: search, mode: "insensitive" } },
            { firstName: { contains: search, mode: "insensitive" } },
            { lastName: { contains: search, mode: "insensitive" } },
          ] } } } },
        ] } : {},
      ] };
      const orderBy: Prisma.OperationalGroupOrderByWithRelationInput = { [query.sortBy]: query.sortDirection };
      const [total, rows] = await client.$transaction([
        client.operationalGroup.count({ where }),
        client.operationalGroup.findMany({ where, include: groupInclude(), orderBy: [orderBy, { id: "asc" }], take: query.limit, skip: query.offset }),
      ]);
      return { total, limit: query.limit, offset: query.offset, data: rows.map(groupRecord) };
    },

    async getGroup(incidentId, id, actor) {
      const row = await client.operationalGroup.findFirst({ where: { id, incidentId, AND: [groupVisibility(actor, "group:read")] }, include: groupInclude() });
      return row ? groupRecord(row) : null;
    },

    async createGroup(incidentId, input, actor) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          return await client.$transaction(async (tx) => {
          const memberIds = [...new Set(input.memberIds)];
          if (input.leaderId && !memberIds.includes(input.leaderId)) throw new HttpError(400, "The leader must be an active member of the group");
          if (memberIds.length) {
            await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "MemberProfile" WHERE "id" IN (${Prisma.join(memberIds)}) FOR UPDATE`);
          }
          const validMembers = await tx.memberProfile.count({ where: { id: { in: memberIds }, status: { not: "Archived" } } });
          if (validMembers !== memberIds.length) throw new HttpError(400, "One or more member profiles are unavailable");
          const number = await sequence(tx, "OperationalGroup_id_seq");
          const year = new Date().getUTCFullYear();
          const group = await tx.operationalGroup.create({ data: {
            id: `grp-${year}-${String(number).padStart(6, "0")}`,
            operationalId: `GRP-${year}-${String(number).padStart(6, "0")}`,
            incidentId,
            name: input.name,
            pool: input.pool,
            functionName: input.functionName,
            status: input.status,
            notes: input.notes,
            createdById: actor.id,
            updatedById: actor.id,
          } });
          for (const memberId of memberIds) {
            const membershipNumber = await sequence(tx, "GroupMembership_id_seq");
            await tx.groupMembership.create({ data: {
              id: `gmb-${year}-${String(membershipNumber).padStart(6, "0")}`,
              groupId: group.id,
              memberProfileId: memberId,
              role: memberId === input.leaderId ? "Leader" : "Member",
              addedById: actor.id,
            } });
          }
          await audit(tx, actor, "create_group", "group", group.id, "Group created", incidentId, { groupId: group.id, operationalId: group.operationalId, memberCount: memberIds.length, leaderId: input.leaderId ?? null, versionAfter: 1 });
          return { record: groupRecord((await loadedGroup(tx, incidentId, group.id))!), conflict: false };
          }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
        } catch (error) {
          if (isSerializationConflict(error) && attempt < 4) continue;
          if (isConflict(error)) return { record: null, conflict: true };
          throw error;
        }
      }
      return { record: null, conflict: true };
    },

    async updateGroup(incidentId, id, input, expectedVersion, actor) {
      return mutateGroup(incidentId, id, expectedVersion, actor, async (tx) => {
        await tx.operationalGroup.update({ where: { id }, data: { ...input, updatedById: actor.id } });
      }, "update_group", "Group updated", { changedFields: Object.keys(input) });
    },

    async archiveGroup(incidentId, id, expectedVersion, actor) {
      return mutateGroup(incidentId, id, expectedVersion, actor, async (tx) => {
        if (await tx.rosterShift.findFirst({ where: { groupId: id, status: { in: ["Draft", "Published", "Confirmed"] } } })) throw new HttpError(409, "Resolve active roster shifts before archiving this group");
        const timestamp = new Date();
        await tx.groupMembership.updateMany({ where: { groupId: id, removedAt: null }, data: { removedAt: timestamp, removedById: actor.id } });
        await tx.groupRoleAssignment.updateMany({ where: { groupId: id, status: "Active" }, data: { status: "Revoked", revokedAt: timestamp, revokedBy: actor.id, version: { increment: 1 } } });
        return { status: "Archived" };
      }, "archive_group", "Group archived", {});
    },

    async listGroupMembers(incidentId, groupId, limit, offset, actor) {
      const group = await client.operationalGroup.findFirst({ where: { id: groupId, incidentId, AND: [groupVisibility(actor, "group:read")] } });
      if (!group) throw new HttpError(404, "Group not found");
      const where = { groupId, removedAt: null };
      const [total, memberships] = await client.$transaction([
        client.groupMembership.count({ where }),
        client.groupMembership.findMany({ where, include: { memberProfile: true }, orderBy: [{ role: "asc" }, { addedAt: "asc" }], take: limit, skip: offset }),
      ]);
      return { total, limit, offset, data: await Promise.all(memberships.map(async (membership) => ({ ...await projectMember(membership.memberProfile, actor), membershipId: membership.id, membershipRole: membership.role, membershipCreatedAt: membership.addedAt, membershipUpdatedAt: membership.updatedAt }))) };
    },

    async addGroupMember(incidentId, groupId, memberProfileId, role, expectedVersion, actor) {
      return mutateGroup(incidentId, groupId, expectedVersion, actor, async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "MemberProfile" WHERE "id" = ${memberProfileId} FOR UPDATE`;
        const member = await tx.memberProfile.findFirst({ where: { id: memberProfileId, status: { not: "Archived" } } });
        if (!member) throw new HttpError(404, "Member profile not found");
        if (role === "Leader") await tx.groupMembership.updateMany({ where: { groupId, removedAt: null, role: "Leader" }, data: { role: "Member" } });
        const number = await sequence(tx, "GroupMembership_id_seq");
        await tx.groupMembership.create({ data: { id: `gmb-${new Date().getUTCFullYear()}-${String(number).padStart(6, "0")}`, groupId, memberProfileId, role, addedById: actor.id } });
      }, "add_group_member", "Member added to group", { memberProfileId, membershipRole: role });
    },

    async changeGroupMemberRole(incidentId, groupId, memberProfileId, role, expectedVersion, actor) {
      return mutateGroup(incidentId, groupId, expectedVersion, actor, async (tx) => {
        const membership = await tx.groupMembership.findFirst({ where: { groupId, memberProfileId, removedAt: null } });
        if (!membership) throw new HttpError(404, "Group membership not found");
        if (role === "Leader") await tx.groupMembership.updateMany({ where: { groupId, removedAt: null, role: "Leader", id: { not: membership.id } }, data: { role: "Member" } });
        await tx.groupMembership.update({ where: { id: membership.id }, data: { role } });
      }, "change_group_membership_role", "Group membership updated", { memberProfileId, membershipRole: role });
    },

    async removeGroupMember(incidentId, groupId, memberProfileId, expectedVersion, actor) {
      return mutateGroup(incidentId, groupId, expectedVersion, actor, async (tx) => {
        const membership = await tx.groupMembership.findFirst({ where: { groupId, memberProfileId, removedAt: null } });
        if (!membership) throw new HttpError(404, "Group membership not found");
        const timestamp = new Date();
        await tx.groupMembership.update({ where: { id: membership.id }, data: { removedAt: timestamp, removedById: actor.id } });
        if (membership.role === "Leader") {
          const replacement = await tx.groupMembership.findFirst({ where: { groupId, removedAt: null, id: { not: membership.id } }, orderBy: { addedAt: "asc" } });
          if (replacement) await tx.groupMembership.update({ where: { id: replacement.id }, data: { role: "Leader" } });
        }
      }, "remove_group_member", "Member removed from group", { memberProfileId });
    },

    async setLeader(incidentId, groupId, memberProfileId, expectedVersion, actor) {
      return mutateGroup(incidentId, groupId, expectedVersion, actor, async (tx) => {
        const membership = await tx.groupMembership.findFirst({ where: { groupId, memberProfileId, removedAt: null, memberProfile: { status: { not: "Archived" } } } });
        if (!membership) throw new HttpError(409, "The leader must be an active member of this group");
        await tx.groupMembership.updateMany({ where: { groupId, removedAt: null, role: "Leader", id: { not: membership.id } }, data: { role: "Member" } });
        await tx.groupMembership.update({ where: { id: membership.id }, data: { role: "Leader" } });
      }, "set_group_leader", "Group leader changed", (group) => ({
        memberProfileId,
        previousLeaderId: group.memberships.find((membership) => membership.role === "Leader")?.memberProfileId ?? null,
        nextLeaderId: memberProfileId,
      }));
    },

    async assignGroupRole(userId, roleName, groupId, actor) {
      try {
        return await client.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId}::uuid FOR UPDATE`;
          await tx.$queryRaw`SELECT "id" FROM "OperationalGroup" WHERE "id" = ${groupId} FOR UPDATE`;
          const [user, role, group, existingUserRole] = await Promise.all([
            tx.user.findFirst({ where: { id: userId, status: "active" } }),
            tx.role.findUnique({ where: { name: roleName } }),
            tx.operationalGroup.findFirst({ where: { id: groupId, status: { not: "Archived" } } }),
            tx.userRole.findFirst({ where: { userId, role: { name: roleName } } }),
          ]);
          if (!user) throw new HttpError(404, "User not found");
          if (!role) throw new HttpError(404, "Role not found");
          if (!group) throw new HttpError(404, "Group not found");
          if (existingUserRole?.scopeType === "GLOBAL") throw new HttpError(409, "This role is already assigned globally");
          await tx.userRole.upsert({
            where: { userId_roleId: { userId, roleId: role.id } },
            update: { scopeType: "GROUP", assignedBy: actor.id },
            create: { userId, roleId: role.id, scopeType: "GROUP", assignedBy: actor.id },
          });
          const assignment = await tx.groupRoleAssignment.create({
            data: { id: `gra-${randomUUID()}`, userId, roleId: role.id, groupId, assignedBy: actor.id },
            include: { role: true },
          });
          await audit(tx, actor, "assign_group_role", "groupRoleAssignment", assignment.id, "Group-scoped role assigned", group.incidentId, { targetUserId: userId, roleName, groupId, scopeType: "GROUP", versionAfter: 1 });
          return roleAssignmentRecord(assignment);
        }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
      } catch (error) {
        if (isConflict(error)) throw new HttpError(409, "Duplicate active role assignment");
        throw error;
      }
    },

    async revokeGroupRole(assignmentId, userId, actor) {
      return client.$transaction(async (tx) => {
        const current = await tx.groupRoleAssignment.findFirst({ where: { id: assignmentId, userId }, include: { role: true, group: true } });
        if (!current) return null;
        if (current.status !== "Active") return roleAssignmentRecord(current);
        const assignment = await tx.groupRoleAssignment.update({
          where: { id: assignmentId },
          data: { status: "Revoked", revokedAt: new Date(), revokedBy: actor.id, version: { increment: 1 } },
          include: { role: true },
        });
        await audit(tx, actor, "revoke_group_role", "groupRoleAssignment", assignment.id, "Group-scoped role revoked", current.group.incidentId, { targetUserId: userId, roleName: current.role.name, groupId: current.groupId, scopeType: "GROUP", versionBefore: current.version, versionAfter: assignment.version });
        return roleAssignmentRecord(assignment);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    },

    async replaceRoleScopes(userId, assignments: RoleScopeInput[], actor) {
      await client.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId}::uuid FOR UPDATE`;
        if (!(await tx.user.findFirst({ where: { id: userId, status: { not: "archived" } } }))) throw new HttpError(404, "User not found");
        const roleNames = [...new Set(assignments.map(({ roleName }) => roleName))];
        const roles = await tx.role.findMany({ where: { name: { in: roleNames } } });
        if (roles.length !== roleNames.length) throw new HttpError(400, "One or more roles do not exist");
        const rolesByName = new Map(roles.map((role) => [role.name, role]));
        const groupIds = [...new Set(assignments.filter(({ scopeType }) => scopeType === "GROUP").map(({ scopeId }) => String(scopeId ?? "")).filter(Boolean))];
        if (groupIds.length) {
          await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "OperationalGroup" WHERE "id" IN (${Prisma.join(groupIds)}) FOR UPDATE`);
        }
        const groups = await tx.operationalGroup.findMany({ where: { id: { in: groupIds }, status: { not: "Archived" } } });
        if (groups.length !== groupIds.length) throw new HttpError(400, "One or more group scopes do not exist");

        const scopeByRole = new Map<string, "GLOBAL" | "GROUP">();
        for (const roleName of roleNames) {
          scopeByRole.set(roleName, assignments.some((assignment) => assignment.roleName === roleName && assignment.scopeType === "GLOBAL") ? "GLOBAL" : "GROUP");
        }
        for (const [roleName, scopeType] of scopeByRole) {
          const role = rolesByName.get(roleName)!;
          await tx.userRole.upsert({
            where: { userId_roleId: { userId, roleId: role.id } },
            update: { scopeType, assignedBy: actor.id },
            create: { userId, roleId: role.id, scopeType, assignedBy: actor.id },
          });
        }

        const desiredGroupScopes = assignments.filter((assignment) => assignment.scopeType === "GROUP" && scopeByRole.get(assignment.roleName) === "GROUP");
        const desiredKeys = new Set(desiredGroupScopes.map((assignment) => `${rolesByName.get(assignment.roleName)!.id}:${assignment.scopeId}`));
        const current = await tx.groupRoleAssignment.findMany({ where: { userId, status: "Active" }, include: { role: true } });
        const timestamp = new Date();
        for (const assignment of current) {
          if (!desiredKeys.has(`${assignment.roleId}:${assignment.groupId}`)) {
            await tx.groupRoleAssignment.update({ where: { id: assignment.id }, data: { status: "Revoked", revokedAt: timestamp, revokedBy: actor.id, version: { increment: 1 } } });
          }
        }
        const activeKeys = new Set(current.filter((assignment) => desiredKeys.has(`${assignment.roleId}:${assignment.groupId}`)).map((assignment) => `${assignment.roleId}:${assignment.groupId}`));
        for (const desired of desiredGroupScopes) {
          const role = rolesByName.get(desired.roleName)!;
          const key = `${role.id}:${desired.scopeId}`;
          if (activeKeys.has(key)) continue;
          await tx.groupRoleAssignment.create({ data: { id: `gra-${randomUUID()}`, userId, roleId: role.id, groupId: String(desired.scopeId), assignedBy: actor.id } });
        }

        const desiredRoleIds = roles.map(({ id }) => id);
        await tx.userRole.deleteMany({ where: { userId, ...(desiredRoleIds.length ? { roleId: { notIn: desiredRoleIds } } : {}) } });
        await audit(tx, actor, "replace_role_scopes", "userAccount", userId, "Role scopes replaced", null, { targetUserId: userId, roleScopes: assignments.map(({ roleName, scopeType, scopeId }) => ({ roleName, scopeType, scopeId: scopeId ?? null })) });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    },
  };
}
