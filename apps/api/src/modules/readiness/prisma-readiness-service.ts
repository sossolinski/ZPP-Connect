import { Prisma, type PrismaClient } from "@prisma/client";
import { permissions, type Permission } from "@zpp/shared";
import { HttpError } from "../../errors.js";
import {
  evaluateReadiness,
  readinessPolicy,
  readinessStatusRank,
  summarizeReadiness,
  unlinkedReadiness,
} from "./readiness-policy.js";
import type {
  DocumentSnapshotItem,
  ReadinessAccess,
  ReadinessActor,
  ReadinessAssessment,
  ReadinessGroup,
  ReadinessGroupQuery,
  ReadinessMember,
  ReadinessMemberRow,
  ReadinessMemberSnapshot,
  ReadinessOverallStatus,
  ReadinessPageQuery,
  RosterSnapshotItem,
  TrainingSnapshotItem,
} from "./readiness-types.js";

type Tx = Prisma.TransactionClient;
type Clock = { now(): Date };
export type ReadinessProjectionHooks = {
  afterAccess?: () => void | Promise<void>;
  beforeSource?: (family: "member-group" | "training" | "documents" | "availability" | "roster") => void | Promise<void>;
};
type MemberRow = Awaited<ReturnType<Tx["memberProfile"]["findMany"]>>[number] & Record<string, any>;

const readinessPermissions = new Set<Permission>([
  "readiness:read-own", "readiness:read-group", "readiness:read-all", "readiness:read-summary",
  "readiness:policy:read", "readiness:policy:manage",
]);

function knownPermissions(value: Prisma.JsonValue): Permission[] {
  if (!Array.isArray(value)) return [];
  return value.map(String).filter((item): item is Permission => item in permissions);
}

function memberSummary(row: MemberRow): ReadinessMember {
  return {
    id: row.id, memberId: row.memberId, displayName: `${row.firstName} ${row.lastName}`.trim(), pool: row.pool,
    role: row.role, assignedFunction: row.assignedFunction, status: row.status,
  };
}

function groupSummary(row: Record<string, any>, memberCount?: number): ReadinessGroup {
  return {
    id: row.id, operationalId: row.operationalId, name: row.name, pool: row.pool, functionName: row.functionName,
    status: row.status, memberCount: memberCount ?? row._count?.memberships ?? 0,
  };
}

function roleTargets(member: MemberRow) {
  const values = new Set<string>();
  if (member.pool === "ZPP") values.add("ZPP Member");
  if (member.pool === "TEC") values.add("TEC Member");
  if (member.memberships.some((item: any) => item.role === "Leader") && member.pool === "ZPP") values.add("ZPP Group Leader");
  if (member.memberships.some((item: any) => item.role === "Leader") && member.pool === "TEC") values.add("TEC Group Leader");
  const roles = new Set<string>(member.linkedUser?.roles.map((item: any) => item.role.name) ?? []);
  if (roles.has("zpp-coordinator")) values.add("ZPP Coordinator");
  if (roles.has("tec-coordinator")) values.add("TEC Coordinator");
  if (member.assignedFunction === "Family Assistance Team") values.add("Family Assistance");
  if (member.assignedFunction === "Welfare Support") { values.add("Welfare Support"); values.add("Welfare"); }
  if (member.assignedFunction === "Member Rostering") values.add("Rostering");
  if (member.assignedFunction === "Documentation Support") values.add("Documentation");
  return values;
}

function applies(requirement: { targetType: string; targetRole: string | null; groupId: string | null; memberProfileId: string | null }, member: MemberRow) {
  if (requirement.targetType === "MemberProfile") return requirement.memberProfileId === member.id;
  if (requirement.targetType === "Group") return member.memberships.some((item: any) => item.groupId === requirement.groupId);
  return roleTargets(member).has(requirement.targetRole ?? "");
}

function earliest(values: Array<Date | null | undefined>) {
  return values.filter((item): item is Date => Boolean(item)).sort((left, right) => left.getTime() - right.getTime())[0] ?? null;
}

function effectiveTrainingStatus(record: Record<string, any>, at: Date) {
  return record.status === "Completed" && record.expiryAt && record.expiryAt < at ? "Expired" : record.status;
}

function trainingRank(record: Record<string, any>, at: Date) {
  const status = effectiveTrainingStatus(record, at);
  if (status === "Completed" || status === "Waived") return 0;
  if (["Assigned", "In Progress"].includes(record.status) && !(record.dueAt && record.dueAt < at)) return 1;
  if (["Assigned", "In Progress"].includes(record.status)) return 2;
  if (status === "Expired") return 3;
  return 4;
}

function trainingItems(member: MemberRow, requirements: Record<string, any>[], records: Record<string, any>[], at: Date): TrainingSnapshotItem[] {
  const byCourse = new Map<string, Record<string, any>[]>();
  requirements.filter((item) => applies(item as any, member)).forEach((item) => byCourse.set(item.courseId, [...(byCourse.get(item.courseId) ?? []), item]));
  const recordsByCourse = new Map<string, Record<string, any>[]>();
  records.filter((item) => item.memberProfileId === member.id).forEach((item) => recordsByCourse.set(item.courseId, [...(recordsByCourse.get(item.courseId) ?? []), item]));
  return [...byCourse.entries()].map(([courseId, sources]): TrainingSnapshotItem => {
    const candidates = [...(recordsByCourse.get(courseId) ?? [])].sort((left, right) => trainingRank(left, at) - trainingRank(right, at) || right.updatedAt.getTime() - left.updatedAt.getTime() || left.id.localeCompare(right.id));
    const record = candidates[0] ?? null;
    const required = sources.some((item) => item.requiredStatus === "Required");
    const dueAt = record?.dueAt ?? earliest(sources.map((item) => item.dueAt));
    const effectiveStatus = record ? effectiveTrainingStatus(record, at) : null;
    const overdue = record ? ["Assigned", "In Progress"].includes(record.status) && Boolean(record.dueAt && record.dueAt < at) : Boolean(dueAt && dueAt < at);
    const expiringSoon = Boolean(record && effectiveStatus === "Completed" && record.expiryAt && record.expiryAt >= at && record.expiryAt.getTime() <= at.getTime() + readinessPolicy.expiringSoonDays * 86_400_000);
    let status: TrainingSnapshotItem["status"] = "Attention";
    if (record && (effectiveStatus === "Completed" || effectiveStatus === "Waived")) status = expiringSoon ? "Attention" : "Compliant";
    else if ((effectiveStatus === "Expired" || overdue) && required) status = "Non-compliant";
    return {
      courseId, title: sources[0]!.course.title, requiredStatus: required ? "Required" : "Recommended", status,
      recordStatus: effectiveStatus, dueAt, expiryAt: record?.expiryAt ?? null, expiringSoon,
    };
  }).sort((left, right) => left.title.localeCompare(right.title) || left.courseId.localeCompare(right.courseId));
}

function validExternalUrl(value: string | null) {
  try { return Boolean(value && new URL(value).protocol === "https:"); } catch { return false; }
}

function documentItems(member: MemberRow, requirements: Record<string, any>[], acknowledgements: Record<string, any>[], at: Date): DocumentSnapshotItem[] {
  if (member.status === "Archived") return [];
  const byVersion = new Map<string, Record<string, any>[]>();
  requirements.filter((item) => applies(item as any, member)).forEach((item) => byVersion.set(item.documentVersionId, [...(byVersion.get(item.documentVersionId) ?? []), item]));
  const ackByVersion = new Map(acknowledgements.filter((item) => item.memberProfileId === member.id).map((item) => [item.documentVersionId, item]));
  return [...byVersion.entries()].map(([documentVersionId, sources]) => {
    const version = sources[0]!.documentVersion;
    const acknowledgement = ackByVersion.get(documentVersionId);
    const acknowledgementRequired = sources.some((item) => item.acknowledgementRequired);
    const dueAt = earliest(sources.filter((item) => item.acknowledgementRequired).map((item) => item.dueAt));
    const contentAvailable = version.contentMode === "Internal text" ? Boolean(version.contentBody?.trim()) : validExternalUrl(version.externalUrl);
    const status: DocumentSnapshotItem["status"] = acknowledgement ? "Acknowledged" : !acknowledgementRequired ? "Awareness" : dueAt && dueAt < at ? "Overdue" : "Required";
    return {
      documentVersionId, title: version.titleOverride || version.document.title, status, acknowledgementRequired,
      contentAvailable, dueAt, acknowledgedAt: acknowledgement?.acknowledgedAt ?? null,
    };
  }).sort((left, right) => Number(left.status === "Acknowledged") - Number(right.status === "Acknowledged") || Number(right.status === "Overdue") - Number(left.status === "Overdue") || (left.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (right.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER) || left.title.localeCompare(right.title));
}

function compact(assessment: ReadinessAssessment): ReadinessMemberRow {
  return {
    member: assessment.member!, overallStatus: assessment.overallStatus, blockerCount: assessment.blockers.length,
    warningCount: assessment.warnings.length, primaryIssue: assessment.blockers[0] ?? assessment.warnings[0] ?? null,
    calculatedAt: assessment.calculatedAt, evaluationMode: assessment.evaluationMode,
    policy: { id: assessment.policy.id, version: assessment.policy.version },
  };
}

async function accessFor(tx: Tx, actorId: string, at: Date): Promise<ReadinessAccess> {
  const user = await tx.user.findUnique({
    where: { id: actorId },
    include: {
      roles: { include: { role: true } },
      groupRoleAssignments: { include: { role: true, group: true } },
      permissionOverrides: true,
      linkedMemberProfiles: { select: { id: true, memberships: { where: { removedAt: null, group: { status: { not: "Archived" } } }, select: { groupId: true } } } },
    },
  });
  if (!user || user.status !== "Active") throw new HttpError(401, "Authentication required");
  const granted = new Set<Permission>();
  const global = new Set<Permission>();
  const grouped = new Map<Permission, Set<string>>();
  const activeGroupAssignments = user.groupRoleAssignments.filter((item) => item.status === "Active" && !item.revokedAt && item.group.status !== "Archived" && item.role.status === "Active");
  for (const assignment of user.roles) {
    if (assignment.role.status !== "Active") continue;
    const rolePermissions = knownPermissions(assignment.role.permissions).filter((item) => readinessPermissions.has(item));
    if (assignment.scopeType === "GROUP") {
      for (const groupAssignment of activeGroupAssignments.filter((item) => item.roleId === assignment.roleId)) {
        for (const permission of rolePermissions) {
          granted.add(permission);
          const ids = grouped.get(permission) ?? new Set<string>();
          ids.add(groupAssignment.groupId);
          grouped.set(permission, ids);
        }
      }
    } else {
      rolePermissions.forEach((permission) => { granted.add(permission); global.add(permission); });
    }
  }
  for (const override of user.permissionOverrides) {
    if (!override.active || override.revokedAt || (override.expiresAt && override.expiresAt <= at) || !readinessPermissions.has(override.permission as Permission)) continue;
    const permission = override.permission as Permission;
    if (override.effect === "GRANT") { granted.add(permission); global.add(permission); }
    if (override.effect === "DENY") { granted.delete(permission); global.delete(permission); grouped.delete(permission); }
  }
  const linked = user.linkedMemberProfiles[0] ?? null;
  return {
    permissions: granted, globalPermissions: global, groupPermissions: grouped,
    linkedMemberProfileId: linked?.id ?? null,
    ownActiveGroupIds: new Set(linked?.memberships.map((item) => item.groupId) ?? []),
  };
}

function allowedGroupIds(access: ReadinessAccess) {
  if (access.globalPermissions.has("readiness:read-all")) return null;
  if (!access.permissions.has("readiness:read-group")) return new Set<string>();
  const explicit = access.groupPermissions.get("readiness:read-group") ?? new Set<string>();
  if (explicit.size) return explicit;
  return access.globalPermissions.has("readiness:read-group") ? access.ownActiveGroupIds : new Set<string>();
}

function visibleMemberWhere(access: ReadinessAccess, summary = false): Prisma.MemberProfileWhereInput {
  if (access.globalPermissions.has("readiness:read-all") || (summary && access.permissions.has("readiness:read-summary") && !access.permissions.has("readiness:read-group"))) return {};
  const groups = allowedGroupIds(access);
  if (groups === null) return {};
  return { status: { not: "Archived" }, memberships: { some: { removedAt: null, groupId: { in: [...groups] }, group: { status: { not: "Archived" } } } } };
}

const memberInclude = {
  memberships: { where: { removedAt: null }, include: { group: { include: { _count: { select: { memberships: { where: { removedAt: null } } } } } } } },
  linkedUser: { select: { roles: { include: { role: { select: { name: true } } } } } },
} satisfies Prisma.MemberProfileInclude;

async function loadSnapshots(tx: Tx, memberWhere: Prisma.MemberProfileWhereInput, at: Date, hooks?: ReadinessProjectionHooks) {
  await hooks?.beforeSource?.("member-group");
  const members = await tx.memberProfile.findMany({ where: memberWhere, include: memberInclude, orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }] }) as MemberRow[];
  if (!members.length) return { members, assessments: [] as ReadinessAssessment[] };
  const memberIds = members.map((item) => item.id);
  const startOfDay = new Date(at); startOfDay.setUTCHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay); endOfDay.setUTCDate(endOfDay.getUTCDate() + readinessPolicy.availabilityLookaheadDays);
  const rosterEnd = new Date(at); rosterEnd.setUTCDate(rosterEnd.getUTCDate() + readinessPolicy.rosterLookaheadDays);
  const source = async <T>(family: Parameters<NonNullable<ReadinessProjectionHooks["beforeSource"]>>[0], action: () => Promise<T>) => {
    await hooks?.beforeSource?.(family);
    return action();
  };
  const [trainingRequirements, trainingRecords, documentRequirements, acknowledgements, availability, roster] = await Promise.all([
    source("training", () => tx.trainingRequirement.findMany({
      where: { active: true, OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: at } }], AND: [{ OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }] }] },
      include: { course: { select: { id: true, title: true } } }, orderBy: { id: "asc" },
    })),
    source("training", () => tx.memberTrainingRecord.findMany({ where: { memberProfileId: { in: memberIds }, status: { not: "Cancelled" } }, orderBy: [{ updatedAt: "desc" }, { id: "asc" }] })),
    source("documents", () => tx.documentRequirement.findMany({
      where: {
        active: true, OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: at } }], AND: [{ OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }] }],
        documentVersion: { status: "Published", document: { active: true } },
      },
      include: { documentVersion: { include: { document: { select: { id: true, title: true } } } } }, orderBy: { id: "asc" },
    })),
    source("documents", () => tx.documentAcknowledgement.findMany({ where: { memberProfileId: { in: memberIds } }, select: { memberProfileId: true, documentVersionId: true, acknowledgedAt: true } })),
    source("availability", () => tx.availability.findMany({
      where: { memberProfileId: { in: memberIds }, status: "Active", startAt: { lt: endOfDay }, endAt: { gt: startOfDay } },
      select: { id: true, operationalId: true, memberProfileId: true, startAt: true, endAt: true, type: true },
      orderBy: [{ startAt: "asc" }, { id: "asc" }],
    })),
    source("roster", () => tx.rosterShift.findMany({
      where: { assignedMemberProfileId: { in: memberIds }, startAt: { lt: rosterEnd }, endAt: { gt: at } },
      select: { id: true, operationalId: true, assignedMemberProfileId: true, title: true, duty: true, functionName: true, startAt: true, endAt: true, location: true, status: true },
      orderBy: [{ startAt: "asc" }, { id: "asc" }],
    })),
  ]);
  const availabilityByMember = new Map<string, typeof availability>();
  availability.forEach((item) => availabilityByMember.set(item.memberProfileId, [...(availabilityByMember.get(item.memberProfileId) ?? []), item]));
  const rosterByMember = new Map<string, RosterSnapshotItem[]>();
  roster.forEach((item) => {
    const memberProfileId = item.assignedMemberProfileId!;
    rosterByMember.set(memberProfileId, [...(rosterByMember.get(memberProfileId) ?? []), item]);
  });
  const activeGroups = (member: MemberRow) => member.memberships.filter((item: any) => item.group.status !== "Archived");
  const snapshots: ReadinessMemberSnapshot[] = members.map((member) => ({
    member: memberSummary(member),
    groups: activeGroups(member).map((membership: any) => groupSummary(membership.group)).sort((left: ReadinessGroup, right: ReadinessGroup) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)),
    training: trainingItems(member, trainingRequirements as any[], trainingRecords as any[], at),
    documents: documentItems(member, documentRequirements as any[], acknowledgements as any[], at),
    availability: availabilityByMember.get(member.id) ?? [],
    roster: rosterByMember.get(member.id) ?? [],
  }));
  return { members, assessments: snapshots.map((snapshot) => evaluateReadiness(snapshot, at)) };
}

function memberMatches(assessment: ReadinessAssessment, query: ReadinessPageQuery, member: MemberRow) {
  if (query.status && assessment.overallStatus !== query.status) return false;
  if (query.groupId && !member.memberships.some((item: any) => item.removedAt === null && item.groupId === query.groupId && item.group.status !== "Archived")) return false;
  if (!query.search) return true;
  const needle = query.search.toLowerCase();
  return [
    assessment.member!.memberId, assessment.member!.displayName, assessment.member!.pool, assessment.member!.role,
    assessment.member!.assignedFunction, assessment.overallStatus,
    ...assessment.blockers.map((item) => item.title), ...assessment.warnings.map((item) => item.title),
  ].some((value) => value.toLowerCase().includes(needle));
}

export class PrismaReadinessProjectionService {
  readonly kind = "postgres" as const;

  constructor(
    private readonly db: PrismaClient,
    private readonly clock: Clock = { now: () => new Date() },
    private readonly hooks?: ReadinessProjectionHooks,
  ) {}

  private async access(tx: Tx, actorId: string, at: Date) {
    const access = await accessFor(tx, actorId, at);
    await this.hooks?.afterAccess?.();
    return access;
  }

  private snapshot<T>(action: (tx: Tx, calculatedAt: Date) => Promise<T>, evaluationAt?: Date) {
    const calculatedAt = evaluationAt ?? this.clock.now();
    return this.db.$transaction((tx) => action(tx, calculatedAt), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: 30_000,
    });
  }

  async me(actor: ReadinessActor, evaluationAt?: Date) {
    return this.snapshot(async (tx, at) => {
      const access = await this.access(tx, actor.id, at);
      if (!access.permissions.has("readiness:read-own")) throw new HttpError(403, "Forbidden");
      if (!access.linkedMemberProfileId) return unlinkedReadiness(at);
      const loaded = await loadSnapshots(tx, { id: access.linkedMemberProfileId }, at, this.hooks);
      return loaded.assessments[0] ?? unlinkedReadiness(at);
    }, evaluationAt);
  }

  async members(actor: ReadinessActor, query: ReadinessPageQuery) {
    return this.snapshot(async (tx, at) => {
      const access = await this.access(tx, actor.id, at);
      if (!access.globalPermissions.has("readiness:read-all") && !access.permissions.has("readiness:read-group")) throw new HttpError(403, "Forbidden");
      const visible = visibleMemberWhere(access);
      const memberWhere: Prisma.MemberProfileWhereInput = query.memberProfileIds?.length
        ? { AND: [visible, { id: { in: query.memberProfileIds } }] }
        : visible;
      const loaded = await loadSnapshots(tx, memberWhere, at, this.hooks);
      const memberById = new Map(loaded.members.map((item) => [item.id, item]));
      const filtered = loaded.assessments.filter((item) => memberMatches(item, query, memberById.get(item.member!.id)!))
        .sort((left, right) => readinessStatusRank[left.overallStatus] - readinessStatusRank[right.overallStatus] || left.member!.displayName.localeCompare(right.member!.displayName) || left.member!.id.localeCompare(right.member!.id));
      return { total: filtered.length, limit: query.limit, offset: query.offset, data: filtered.slice(query.offset, query.offset + query.limit).map(compact) };
    }, query.evaluationAt);
  }

  async member(actor: ReadinessActor, id: string, evaluationAt?: Date) {
    return this.snapshot(async (tx, at) => {
      const access = await this.access(tx, actor.id, at);
      const own = access.permissions.has("readiness:read-own") && access.linkedMemberProfileId === id;
      const readAll = access.globalPermissions.has("readiness:read-all");
      const groups = allowedGroupIds(access);
      const groupMember = groups === null || Boolean(groups.size && await tx.groupMembership.count({ where: { memberProfileId: id, removedAt: null, groupId: { in: [...groups] }, group: { status: { not: "Archived" } } } }));
      if (!own && !readAll && !groupMember) throw new HttpError(404, "Readiness record not found");
      const loaded = await loadSnapshots(tx, { id }, at, this.hooks);
      if (!loaded.assessments[0]) throw new HttpError(404, "Readiness record not found");
      return loaded.assessments[0];
    }, evaluationAt);
  }

  async groups(actor: ReadinessActor, query: ReadinessGroupQuery) {
    return this.snapshot(async (tx, at) => {
      const access = await this.access(tx, actor.id, at);
      if (!access.globalPermissions.has("readiness:read-all") && !access.permissions.has("readiness:read-group")) throw new HttpError(403, "Forbidden");
      const ids = allowedGroupIds(access);
      const where: Prisma.OperationalGroupWhereInput = {
        AND: [
          { status: { not: "Archived" } },
          ...(ids ? [{ id: { in: [...ids] } }] : []),
          ...(query.groupIds?.length ? [{ id: { in: query.groupIds } }] : []),
          ...(query.search ? [{ name: { contains: query.search, mode: "insensitive" as const } }] : []),
        ],
      };
      const [total, rows] = await Promise.all([
        tx.operationalGroup.count({ where }),
        tx.operationalGroup.findMany({ where, include: { _count: { select: { memberships: { where: { removedAt: null, memberProfile: { status: { not: "Archived" } } } } } } }, orderBy: [{ name: "asc" }, { id: "asc" }], take: query.limit, skip: query.offset }),
      ]);
      const base = rows.map((row) => ({ group: groupSummary(row), calculatedAt: at.toISOString(), evaluationMode: readinessPolicy.evaluationMode, policy: { id: readinessPolicy.id, version: readinessPolicy.version } }));
      if (query.optionsOnly || rows.length === 0) return { total, limit: query.limit, offset: query.offset, data: base };
      const groupIds = rows.map((row) => row.id);
      const loaded = await loadSnapshots(tx, { status: { not: "Archived" }, memberships: { some: { removedAt: null, groupId: { in: groupIds } } } }, at, this.hooks);
      const assessmentsByMember = new Map(loaded.assessments.map((assessment) => [assessment.member!.id, assessment]));
      const memberIdsByGroup = new Map<string, Set<string>>();
      for (const member of loaded.members) {
        for (const membership of member.memberships.filter((item: any) => groupIds.includes(item.groupId))) {
          const memberIds = memberIdsByGroup.get(membership.groupId) ?? new Set<string>();
          memberIds.add(member.id);
          memberIdsByGroup.set(membership.groupId, memberIds);
        }
      }
      return {
        total, limit: query.limit, offset: query.offset,
        data: base.map((item) => ({
          ...item,
          summary: summarizeReadiness([...(memberIdsByGroup.get(item.group.id) ?? [])].map((memberId) => assessmentsByMember.get(memberId)!).filter(Boolean), at),
        })),
      };
    }, query.evaluationAt);
  }

  async group(actor: ReadinessActor, id: string, query: ReadinessPageQuery) {
    return this.snapshot(async (tx, at) => {
      const access = await this.access(tx, actor.id, at);
      const ids = allowedGroupIds(access);
      if (ids && !ids.has(id)) throw new HttpError(404, "Readiness group not found");
      const group = await tx.operationalGroup.findFirst({ where: { id, status: { not: "Archived" } }, include: { _count: { select: { memberships: { where: { removedAt: null, memberProfile: { status: { not: "Archived" } } } } } } } });
      if (!group) throw new HttpError(404, "Readiness group not found");
      const loaded = await loadSnapshots(tx, { status: { not: "Archived" }, memberships: { some: { groupId: id, removedAt: null } } }, at, this.hooks);
      const ordered = loaded.assessments.sort((left, right) => readinessStatusRank[left.overallStatus] - readinessStatusRank[right.overallStatus] || left.member!.displayName.localeCompare(right.member!.displayName) || left.member!.id.localeCompare(right.member!.id));
      return {
        group: groupSummary(group), calculatedAt: at.toISOString(), evaluationMode: readinessPolicy.evaluationMode,
        summary: summarizeReadiness(ordered, at), total: ordered.length, limit: query.limit, offset: query.offset,
        members: ordered.slice(query.offset, query.offset + query.limit).map(compact),
      };
    }, query.evaluationAt);
  }

  async summary(actor: ReadinessActor, evaluationAt?: Date) {
    return this.snapshot(async (tx, at) => {
      const access = await this.access(tx, actor.id, at);
      if (!access.permissions.has("readiness:read-summary") && !access.globalPermissions.has("readiness:read-all") && !access.permissions.has("readiness:read-group")) throw new HttpError(403, "Forbidden");
      const loaded = await loadSnapshots(tx, visibleMemberWhere(access, true), at, this.hooks);
      return summarizeReadiness(loaded.assessments, at);
    }, evaluationAt);
  }

  async policy(actor: ReadinessActor) {
    return this.snapshot(async (tx, at) => {
      const access = await this.access(tx, actor.id, at);
      if (!access.permissions.has("readiness:policy:read") && !access.permissions.has("readiness:policy:manage")) throw new HttpError(403, "Forbidden");
      return readinessPolicy;
    });
  }
}

export function createPrismaReadinessProjectionService(db: PrismaClient, clock?: Clock, hooks?: ReadinessProjectionHooks) {
  return new PrismaReadinessProjectionService(db, clock, hooks);
}

export type ReadinessProjectionService = PrismaReadinessProjectionService;
