import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { FoundationDocumentRepository, MutationResult } from "./document-repository.js";
import type {
  AcknowledgementQuery,
  AcknowledgeInput,
  CreateDocumentInput,
  CreateRequirementInput,
  CreateVersionInput,
  DocumentAccess,
  DocumentAcknowledgementRecord,
  DocumentActor,
  DocumentCompliance,
  DocumentContentMode,
  DocumentGroupSummary,
  DocumentMemberSummary,
  DocumentQuery,
  DocumentRequirementRecord,
  DocumentRequirementTargetType,
  DocumentSummary,
  DocumentTotals,
  DocumentVersionRecord,
  EndRequirementInput,
  PersonalDocument,
  PersonalDocumentTotals,
  PublishVersionInput,
  RequirementQuery,
  UpdateDocumentInput,
  UpdateRequirementInput,
  UpdateVersionInput,
  VersionQuery,
  WithdrawVersionInput,
} from "./document-types.js";

type Db = PrismaClient | Prisma.TransactionClient;
const supportedRoleTargets = ["ZPP Member", "TEC Member", "ZPP Group Leader", "TEC Group Leader", "ZPP Coordinator", "TEC Coordinator", "Family Assistance", "Welfare Support", "Rostering"] as const;

const memberSelect = {
  id: true, memberId: true, linkedUserId: true, firstName: true, lastName: true, pool: true,
  role: true, assignedFunction: true, status: true,
} as const;
const groupSelect = {
  id: true, operationalId: true, incidentId: true, name: true, pool: true, functionName: true, status: true,
  _count: { select: { memberships: { where: { removedAt: null } } } },
} as const;
const versionInclude = { document: true } as const;
const requirementInclude = { documentVersion: { include: { document: true } }, group: { select: groupSelect }, memberProfile: { select: memberSelect } } as const;
const acknowledgementInclude = {
  documentVersion: { include: { document: true } },
  memberProfile: { select: memberSelect },
  sourceRequirements: { include: { requirement: { include: { group: { select: groupSelect }, memberProfile: { select: memberSelect } } } } },
} as const;

function iso(value?: Date | string | null) { return value ? (value instanceof Date ? value.toISOString() : value) : null; }
function normalizeCode(value: string) { return value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }
function normalizeLabel(value: string) { return value.trim().toLowerCase().replace(/\s+/g, " "); }
function validExternalUrl(value?: string | null) { try { return Boolean(value && new URL(value).protocol === "https:"); } catch { return false; } }
function contentAvailable(row: any) { return row.contentMode === "Internal text" ? Boolean(row.contentBody?.trim()) : validExternalUrl(row.externalUrl); }
function contentDigest(value: string) { return createHash("sha256").update(value, "utf8").digest("hex"); }
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object" && !(value instanceof Date)) return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)]));
  return value instanceof Date ? value.toISOString() : value;
}
function fingerprint(command: string, target: string, payload: unknown) { return createHash("sha256").update(JSON.stringify(stable({ command, target, payload }))).digest("hex"); }
function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
function conflictError(error: unknown) {
  if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2028", "P2034"].includes(error.code)) return true;
  return /could not serialize|serialization|unique constraint|transaction.*conflict|document version transition|immutable|append-only/i.test(error instanceof Error ? error.message : String(error));
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
async function audit(db: Db, actor: DocumentActor, action: string, entityType: string, entityId: string, summary: string, incidentId: string | null, metadata: Record<string, unknown>) {
  await db.auditLog.create({ data: { action, entityType, entityId, sessionId: incidentId, actorId: actor.id, actorEmail: actor.email, summary, metadata: { ...metadata, requestId: actor.requestId ?? null } } });
}
async function nextSequence(db: Db, name: string) {
  const rows = await db.$queryRawUnsafe<Array<{ value: bigint }>>(`SELECT nextval('"${name}"') AS value`);
  return Number(rows[0]!.value);
}
function businessId(prefix: string, value: number, now: Date) { return `${prefix}-${now.getUTCFullYear()}-${String(value).padStart(6, "0")}`; }

function memberRecord(row: any): DocumentMemberSummary {
  return { id: row.id, memberId: row.memberId, displayName: `${row.firstName} ${row.lastName}`.trim(), pool: row.pool, role: row.role, assignedFunction: row.assignedFunction, status: row.status };
}
function groupRecord(row: any): DocumentGroupSummary {
  return { id: row.id, operationalId: row.operationalId, incidentId: row.incidentId, sessionId: row.incidentId, name: row.name, pool: row.pool, functionName: row.functionName, status: row.status, memberCount: row._count?.memberships ?? 0 };
}
function roleTargetWhere(targetRole: string): Prisma.MemberProfileWhereInput | null {
  if (targetRole === "ZPP Member") return { pool: "ZPP" };
  if (targetRole === "TEC Member") return { pool: "TEC" };
  if (targetRole === "ZPP Group Leader") return { pool: "ZPP", memberships: { some: { removedAt: null, role: "Leader" } } };
  if (targetRole === "TEC Group Leader") return { pool: "TEC", memberships: { some: { removedAt: null, role: "Leader" } } };
  if (targetRole === "ZPP Coordinator") return { linkedUser: { roles: { some: { role: { name: "zpp-coordinator" } } } } };
  if (targetRole === "TEC Coordinator") return { linkedUser: { roles: { some: { role: { name: "tec-coordinator" } } } } };
  if (targetRole === "Family Assistance") return { assignedFunction: "Family Assistance Team" };
  if (targetRole === "Welfare Support") return { assignedFunction: "Welfare Support" };
  if (targetRole === "Rostering") return { assignedFunction: "Member Rostering" };
  return null;
}
function targetMemberWhere(row: { targetType: string; targetRole?: string | null; groupId?: string | null; memberProfileId?: string | null }): Prisma.MemberProfileWhereInput {
  if (row.targetType === "Role") return roleTargetWhere(row.targetRole ?? "") ?? { id: "__unsupported_document_role__" };
  if (row.targetType === "Group") return { memberships: { some: { groupId: row.groupId ?? "", removedAt: null } } };
  return { id: row.memberProfileId ?? "__missing_document_member__" };
}
function memberVisibility(access: DocumentAccess): Prisma.MemberProfileWhereInput {
  if (access.global) return {};
  return { OR: [
    ...(access.ownMemberProfileId ? [{ id: access.ownMemberProfileId }] : []),
    ...(access.groupIds.length ? [{ memberships: { some: { removedAt: null, groupId: { in: access.groupIds } } } }] : []),
  ] };
}
function requirementVisibility(access: DocumentAccess): Prisma.DocumentRequirementWhereInput {
  if (access.global) return {};
  return { OR: [
    ...(access.groupIds.length ? [
      { targetType: "Group", groupId: { in: access.groupIds } },
      { targetType: "MemberProfile", memberProfile: { memberships: { some: { removedAt: null, groupId: { in: access.groupIds } } } } },
    ] : []),
    ...(access.ownMemberProfileId ? [{ targetType: "MemberProfile", memberProfileId: access.ownMemberProfileId }] : []),
  ] };
}
function effectiveWhere(now: Date): Prisma.DocumentRequirementWhereInput {
  return { active: true, AND: [{ OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: now } }] }, { OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] }], documentVersion: { status: "Published", document: { active: true } } };
}
function effective(row: any, now: Date) { return row.active && (!row.effectiveFrom || row.effectiveFrom <= now) && (!row.effectiveTo || row.effectiveTo > now) && row.documentVersion?.status === "Published" && row.documentVersion?.document?.active; }

function baseVersionRecord(row: any, includeContent = false): DocumentVersionRecord {
  const document = row.document;
  return {
    id: row.id, documentId: row.documentId, title: row.titleOverride || document.title, versionLabel: row.versionLabel,
    status: row.status, contentMode: row.contentMode, contentAvailable: contentAvailable(row),
    ...(includeContent ? { contentBody: row.contentMode === "Internal text" ? row.contentBody ?? "" : "" } : {}),
    externalUrl: row.contentMode === "External link" ? row.externalUrl ?? "" : "", contentDigest: row.contentDigest,
    effectiveFrom: iso(row.effectiveFrom), reviewDueAt: iso(row.reviewDueAt), publishedAt: iso(row.publishedAt), publishedById: row.publishedById,
    withdrawnAt: iso(row.withdrawnAt), withdrawnById: row.withdrawnById, withdrawReason: row.withdrawReason,
    changeSummary: row.changeSummary ?? "", basePublishedVersionId: row.basePublishedVersionId,
    canPublish: row.status === "Draft" && contentAvailable(row), canEdit: row.status === "Draft", canWithdraw: row.status === "Draft" || row.status === "Published",
    version: row.version, createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)!,
  };
}
function baseDocumentRecord(row: any, current?: any | null): DocumentSummary {
  const published = current ?? row.versions?.find((item: any) => item.status === "Published") ?? null;
  return { id: row.id, code: row.code, title: row.title, description: row.description ?? "", category: row.category, ownerFunction: row.ownerFunction, active: row.active, status: row.active ? "Active" : "Archived", currentVersion: published ? baseVersionRecord({ ...published, document: row }) : null, version: row.version, createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)! };
}
function targetLabel(row: any) {
  if (row.targetType === "Role") return row.targetRole ?? "Unknown role";
  if (row.targetType === "Group") return row.group?.name ?? "Unknown group";
  return row.memberProfile ? `${row.memberProfile.firstName} ${row.memberProfile.lastName}`.trim() : "Unknown member";
}

async function resolvedMemberCount(db: Db, row: any) { return db.memberProfile.count({ where: { status: { not: "Archived" }, ...targetMemberWhere(row) } }); }

async function versionStats(db: Db, row: any, now: Date) {
  const requirements = await db.documentRequirement.findMany({ where: { documentVersionId: row.id, active: true }, include: { documentVersion: { include: { document: true } } } });
  const acknowledgementCount = await db.documentAcknowledgement.count({ where: { documentVersionId: row.id } });
  const effectiveRequired = requirements.filter((item: any) => effective(item, now) && item.acknowledgementRequired);
  const requiredIds = new Set<string>();
  const overdueIds = new Set<string>();
  for (const requirement of effectiveRequired) {
    const ids = await db.memberProfile.findMany({ where: { status: { not: "Archived" }, ...targetMemberWhere(requirement) }, select: { id: true } });
    ids.forEach((item: any) => {
      requiredIds.add(item.id);
      if (requirement.dueAt && requirement.dueAt < now) overdueIds.add(item.id);
    });
  }
  const acknowledged = requiredIds.size ? await db.documentAcknowledgement.findMany({ where: { documentVersionId: row.id, memberProfileId: { in: [...requiredIds] } }, select: { memberProfileId: true } }) : [];
  const acknowledgedIds = new Set(acknowledged.map((item: any) => item.memberProfileId));
  return {
    requirementCount: requirements.filter((item: any) => item.active).length,
    acknowledgementCount,
    outstandingCount: [...requiredIds].filter((id) => !acknowledgedIds.has(id)).length,
    overdueCount: [...overdueIds].filter((id) => !acknowledgedIds.has(id)).length,
  };
}

async function versionRecord(db: Db, row: any, now: Date, includeContent = false): Promise<DocumentVersionRecord> {
  return { ...baseVersionRecord(row, includeContent), ...(await versionStats(db, row, now)) };
}
async function documentRecord(db: Db, row: any, now: Date): Promise<DocumentSummary> {
  const versions = row.versions ?? await db.documentVersion.findMany({ where: { documentId: row.id }, include: versionInclude });
  const current = versions.find((item: any) => item.status === "Published") ?? null;
  const currentStats = current ? await versionStats(db, current, now) : { requirementCount: 0, acknowledgementCount: 0, outstandingCount: 0, overdueCount: 0 };
  return { ...baseDocumentRecord({ ...row, versions }, current), versionCount: versions.length, activeRequirementCount: currentStats.requirementCount, acknowledgementCount: currentStats.acknowledgementCount, outstandingCount: currentStats.outstandingCount };
}

async function requirementRecord(db: Db, row: any, now: Date): Promise<DocumentRequirementRecord> {
  const document = baseDocumentRecord(row.documentVersion.document, row.documentVersion.status === "Published" ? row.documentVersion : null);
  const version = baseVersionRecord(row.documentVersion);
  const label = targetLabel(row);
  return {
    id: row.id, documentVersionId: row.documentVersionId, documentId: row.documentVersion.documentId, document, version,
    targetType: row.targetType as DocumentRequirementTargetType, targetRole: row.targetRole ?? "", groupId: row.groupId ?? "", memberProfileId: row.memberProfileId ?? "",
    target: row.targetType === "Group" && row.group ? { type: "Group", label, group: groupRecord(row.group) } : row.targetType === "MemberProfile" && row.memberProfile ? { type: "MemberProfile", label, member: memberRecord(row.memberProfile) } : { type: "Role", label },
    targetLabel: label, acknowledgementRequired: row.acknowledgementRequired, effectiveFrom: iso(row.effectiveFrom), dueAt: iso(row.dueAt), effectiveTo: iso(row.effectiveTo),
    active: row.active, effective: effective(row, now), resolvedMemberCount: await resolvedMemberCount(db, row), versionNumber: row.version, recordVersion: row.version,
    endedAt: iso(row.endedAt), endedById: row.endedById, createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)!,
  };
}

async function acknowledgementRecord(db: Db, row: any, now: Date): Promise<DocumentAcknowledgementRecord> {
  const sourceRequirements = row.sourceRequirements.map((link: any) => ({ id: link.requirement.id, targetType: link.requirement.targetType as DocumentRequirementTargetType, targetLabel: targetLabel(link.requirement), acknowledgementRequired: link.requirement.acknowledgementRequired }));
  return {
    id: row.id, documentVersionId: row.documentVersionId, documentId: row.documentVersion.documentId,
    document: baseDocumentRecord(row.documentVersion.document, row.documentVersion.status === "Published" ? row.documentVersion : null),
    version: await versionRecord(db, row.documentVersion, now), memberProfileId: row.memberProfileId, member: memberRecord(row.memberProfile),
    sourceRequirementIds: sourceRequirements.map((item: any) => item.id), sourceRequirements, acknowledgedAt: iso(row.acknowledgedAt)!, acknowledgedById: row.acknowledgedById,
    acknowledgementStatementVersion: row.acknowledgementStatementVersion, note: row.note ?? "", onBehalf: row.onBehalf,
    legacyImported: Boolean(row.legacyImported), legacyMetadata: row.legacyMetadata ?? null,
    evidence: { documentVersionId: row.documentVersionId, documentCode: row.documentCode, documentTitle: row.documentTitle, versionLabel: row.versionLabel, contentMode: row.contentMode, externalUrl: row.externalUrlSnapshot, contentDigest: row.contentDigestSnapshot, acknowledgementStatementVersion: row.acknowledgementStatementVersion },
    createdAt: iso(row.createdAt)!,
  };
}

async function loadedDocument(db: Db, id: string) { return db.document.findUnique({ where: { id }, include: { versions: { include: versionInclude, orderBy: { createdAt: "desc" } } } }); }
async function loadedVersion(db: Db, id: string) { return db.documentVersion.findUnique({ where: { id }, include: versionInclude }); }
async function loadedRequirement(db: Db, id: string) { return db.documentRequirement.findUnique({ where: { id }, include: requirementInclude }); }
async function loadedAcknowledgement(db: Db, id: string) { return db.documentAcknowledgement.findUnique({ where: { id }, include: acknowledgementInclude }); }

async function operationReplay(tx: Prisma.TransactionClient, operationId: string, expectedFingerprint: string) {
  const operation = await tx.documentOperation.findUnique({ where: { operationId } });
  if (!operation) return null;
  return operation.commandFingerprint === expectedFingerprint ? { mismatch: false, result: operation.result as any } : { mismatch: true };
}

export function createPrismaDocumentRepository(client: PrismaClient, clock: { now(): Date } = { now: () => new Date() }): FoundationDocumentRepository {
  async function memberRoleTargets(db: Db, memberId: string) {
    const member = await db.memberProfile.findUnique({ where: { id: memberId }, include: { memberships: { where: { removedAt: null }, select: { role: true, groupId: true } }, linkedUser: { include: { roles: { include: { role: true } } } } } });
    if (!member) return { member: null, groupIds: [] as string[], roleTargets: [] as string[] };
    const roleTargets: string[] = [];
    if (member.pool === "ZPP") roleTargets.push("ZPP Member");
    if (member.pool === "TEC") roleTargets.push("TEC Member");
    if (member.memberships.some((item) => item.role === "Leader") && member.pool === "ZPP") roleTargets.push("ZPP Group Leader");
    if (member.memberships.some((item) => item.role === "Leader") && member.pool === "TEC") roleTargets.push("TEC Group Leader");
    const roles = new Set(member.linkedUser?.roles.map((item) => item.role.name) ?? []);
    if (roles.has("zpp-coordinator")) roleTargets.push("ZPP Coordinator");
    if (roles.has("tec-coordinator")) roleTargets.push("TEC Coordinator");
    if (member.assignedFunction === "Family Assistance Team") roleTargets.push("Family Assistance");
    if (member.assignedFunction === "Welfare Support") roleTargets.push("Welfare Support");
    if (member.assignedFunction === "Member Rostering") roleTargets.push("Rostering");
    return { member, groupIds: member.memberships.map((item) => item.groupId), roleTargets };
  }

  async function personalObligations(memberProfileId: string, actor: DocumentActor, evaluationAt: Date): Promise<{ member: DocumentMemberSummary | null; items: PersonalDocument[] }> {
    const resolved = await memberRoleTargets(client, memberProfileId);
    if (!resolved.member || resolved.member.status === "Archived") return { member: resolved.member ? memberRecord(resolved.member) : null, items: [] };
    const requirements = await client.documentRequirement.findMany({
      where: { ...effectiveWhere(evaluationAt), OR: [
        ...(resolved.roleTargets.length ? [{ targetType: "Role", targetRole: { in: resolved.roleTargets } }] : []),
        ...(resolved.groupIds.length ? [{ targetType: "Group", groupId: { in: resolved.groupIds } }] : []),
        { targetType: "MemberProfile", memberProfileId },
      ] },
      include: requirementInclude,
      orderBy: [{ dueAt: "asc" }, { id: "asc" }],
    });
    const byVersion = new Map<string, any[]>();
    requirements.forEach((requirement) => byVersion.set(requirement.documentVersionId, [...(byVersion.get(requirement.documentVersionId) ?? []), requirement]));
    const acknowledgements = byVersion.size ? await client.documentAcknowledgement.findMany({ where: { memberProfileId, documentVersionId: { in: [...byVersion.keys()] } }, include: acknowledgementInclude }) : [];
    const ackByVersion = new Map(acknowledgements.map((ack) => [ack.documentVersionId, ack]));
    const items: PersonalDocument[] = [];
    for (const [versionId, sourceRequirements] of byVersion) {
      const version = sourceRequirements[0]!.documentVersion;
      const document = version.document;
      const ack = ackByVersion.get(versionId);
      const acknowledgementRequired = sourceRequirements.some((item) => item.acknowledgementRequired);
      const dueAt = sourceRequirements.filter((item) => item.acknowledgementRequired && item.dueAt).map((item) => item.dueAt as Date).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
      const available = contentAvailable(version);
      const status = ack ? "Acknowledged" : !acknowledgementRequired ? "Awareness" : dueAt && dueAt < evaluationAt ? "Overdue" : "Required";
      items.push({
        id: `${versionId}:${memberProfileId}`, documentId: document.id, documentVersionId: versionId, code: document.code,
        title: version.titleOverride || document.title, description: document.description ?? "", category: document.category, ownerFunction: document.ownerFunction,
        versionLabel: version.versionLabel, contentMode: version.contentMode as DocumentContentMode, contentAvailable: available, dueAt: iso(dueAt), status,
        acknowledgementRequired, acknowledgedAt: iso(ack?.acknowledgedAt), acknowledgement: ack ? await acknowledgementRecord(client, ack, evaluationAt) : null,
        reasons: sourceRequirements.map((item) => ({ id: item.id, label: targetLabel(item), targetType: item.targetType as DocumentRequirementTargetType, acknowledgementRequired: item.acknowledgementRequired })),
        sourceRequirementIds: sourceRequirements.map((item) => item.id), canAcknowledge: !ack && acknowledgementRequired && available && actor.permissions.includes("document:acknowledge-own"),
      });
    }
    items.sort((a, b) => Number(a.status === "Acknowledged") - Number(b.status === "Acknowledged") || Number(b.status === "Overdue") - Number(a.status === "Overdue") || String(a.dueAt ?? "9999").localeCompare(String(b.dueAt ?? "9999")) || a.title.localeCompare(b.title));
    return { member: memberRecord(resolved.member), items };
  }

  async function scopedRequirementVisibility(db: Db, access: DocumentAccess): Promise<Prisma.DocumentRequirementWhereInput> {
    if (access.global) return {};
    const own = access.ownMemberProfileId ? await memberRoleTargets(db, access.ownMemberProfileId) : null;
    return { OR: [
      ...(access.groupIds.length ? [
        { targetType: "Group", groupId: { in: access.groupIds } },
        { targetType: "MemberProfile", memberProfile: { memberships: { some: { removedAt: null, groupId: { in: access.groupIds } } } } },
      ] : []),
      ...(access.ownMemberProfileId ? [{ targetType: "MemberProfile", memberProfileId: access.ownMemberProfileId }] : []),
      ...(own?.groupIds.length ? [{ targetType: "Group", groupId: { in: own.groupIds } }] : []),
      ...(own?.roleTargets.length ? [{ targetType: "Role", targetRole: { in: own.roleTargets } }] : []),
    ] };
  }

  async function documentVisibility(db: Db, access: DocumentAccess): Promise<Prisma.DocumentWhereInput> {
    if (access.global) return {};
    return { versions: { some: { requirements: { some: await scopedRequirementVisibility(db, access) } } } };
  }

  return {
    kind: "postgres",

    async resolveMemberForUser(actor) {
      const row = await client.memberProfile.findFirst({ where: { linkedUserId: actor.id, status: { not: "Archived" } }, select: memberSelect });
      return row ? memberRecord(row) : null;
    },
    async memberAccessible(memberProfileId, access) {
      return Boolean(await client.memberProfile.findFirst({ where: { id: memberProfileId, AND: [memberVisibility(access)] }, select: { id: true } }));
    },
    async getGroup(groupId) {
      const row = await client.operationalGroup.findUnique({ where: { id: groupId }, select: groupSelect });
      return row ? groupRecord(row) : null;
    },

    async listDocuments(query, access, actor, evaluationAt) {
      if (query.mine || (!access.global && !access.groupIds.length && access.ownMemberProfileId)) {
        const ownId = access.ownMemberProfileId;
        if (!ownId) return { total: 0, limit: query.limit, offset: query.offset, data: [], linkedMemberProfile: null, totals: { required: 0, awareness: 0, outstanding: 0, overdue: 0, acknowledged: 0 } };
        const result = await personalObligations(ownId, actor, evaluationAt);
        const search = query.search?.toLowerCase();
        let rows = result.items.filter((row) => !search || [row.title, row.code, row.category, row.ownerFunction, row.status].some((value) => value.toLowerCase().includes(search)));
        if (query.status) rows = rows.filter((row) => row.status === query.status);
        if (query.overdue !== undefined) rows = rows.filter((row) => (row.status === "Overdue") === query.overdue);
        const totals: PersonalDocumentTotals = { required: rows.filter((row) => row.acknowledgementRequired).length, awareness: rows.filter((row) => !row.acknowledgementRequired).length, outstanding: rows.filter((row) => row.acknowledgementRequired && row.status !== "Acknowledged").length, overdue: rows.filter((row) => row.status === "Overdue").length, acknowledged: rows.filter((row) => row.status === "Acknowledged").length };
        return { total: rows.length, limit: query.limit, offset: query.offset, data: rows.slice(query.offset, query.offset + query.limit), linkedMemberProfile: result.member, totals };
      }
      const search = query.search?.trim();
      const where: Prisma.DocumentWhereInput = { AND: [await documentVisibility(client, access), query.active === undefined ? {} : { active: query.active }, query.category ? { category: query.category } : {}, query.ownerFunction ? { ownerFunction: query.ownerFunction } : {}, search ? { OR: [{ code: { contains: search, mode: "insensitive" } }, { title: { contains: search, mode: "insensitive" } }, { description: { contains: search, mode: "insensitive" } }, { category: { contains: search, mode: "insensitive" } }, { ownerFunction: { contains: search, mode: "insensitive" } }] } : {}] };
      const orderBy: Prisma.DocumentOrderByWithRelationInput = { [query.sort]: query.direction };
      const [total, rows, allIds] = await client.$transaction([
        client.document.count({ where }),
        client.document.findMany({ where, include: { versions: { include: versionInclude, orderBy: { createdAt: "desc" } } }, orderBy: [orderBy, { id: "asc" }], take: query.limit, skip: query.offset }),
        client.document.findMany({ where, select: { id: true } }),
      ]);
      const data = await Promise.all(rows.map((row) => documentRecord(client, row, evaluationAt)));
      const ids = allIds.map((item) => item.id);
      const allPublished = ids.length ? await client.documentVersion.findMany({ where: { documentId: { in: ids }, status: "Published" }, include: versionInclude }) : [];
      let requirements = 0, outstanding = 0, overdue = 0, acknowledged = 0;
      for (const version of allPublished) {
        const stats = await versionStats(client, version, evaluationAt);
        requirements += stats.requirementCount; outstanding += stats.outstandingCount; acknowledged += stats.acknowledgementCount;
        overdue += stats.overdueCount;
      }
      const totals: DocumentTotals = { documents: total, published: allPublished.length, requirements, outstanding, overdue, acknowledged };
      return { total, limit: query.limit, offset: query.offset, data, totals };
    },

    async getDocument(id, access, _actor, evaluationAt) {
      const row = await client.document.findFirst({ where: { id, AND: [await documentVisibility(client, access)] }, include: { versions: { include: versionInclude, orderBy: { createdAt: "desc" } } } });
      return row ? documentRecord(client, row, evaluationAt) : null;
    },

    async createDocument(input, actor) {
      try {
        return await client.$transaction(async (tx) => {
          const number = await nextSequence(tx, "Document_id_seq");
          const row = await tx.document.create({ data: { id: businessId("doc", number, clock.now()), code: input.code, normalizedCode: normalizeCode(input.code), title: input.title, description: input.description, category: input.category, ownerFunction: input.ownerFunction, createdById: actor.id, updatedById: actor.id } });
          await audit(tx, actor, "create_document", "document", row.id, "Document created", null, { documentId: row.id, code: row.code, versionAfter: 1 });
          return { record: await documentRecord(tx, row, clock.now()), conflict: false };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) { if (conflictError(error)) return { record: null, conflict: true, reason: "duplicate-code" }; throw error; }
    },

    async updateDocument(id, input, expectedVersion, actor) {
      try {
        return await client.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "Document" WHERE "id" = ${id} FOR UPDATE`;
          const current = await tx.document.findUnique({ where: { id } });
          if (!current) return { record: null, conflict: false };
          if (current.version !== expectedVersion) return { record: null, conflict: true, reason: "stale" };
          const changed = await tx.document.updateMany({ where: { id, version: expectedVersion }, data: { ...(input.code !== undefined ? { code: input.code, normalizedCode: normalizeCode(input.code) } : {}), ...(input.title !== undefined ? { title: input.title } : {}), ...(input.description !== undefined ? { description: input.description } : {}), ...(input.category !== undefined ? { category: input.category } : {}), ...(input.ownerFunction !== undefined ? { ownerFunction: input.ownerFunction } : {}), version: { increment: 1 }, updatedById: actor.id } });
          if (changed.count !== 1) return { record: null, conflict: true, reason: "stale" };
          await audit(tx, actor, "update_document", "document", id, "Document updated", null, { documentId: id, changedFields: Object.keys(input), versionBefore: expectedVersion, versionAfter: expectedVersion + 1 });
          return { record: await documentRecord(tx, (await loadedDocument(tx, id))!, clock.now()), conflict: false };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) { if (conflictError(error)) return { record: null, conflict: true, reason: error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" ? "duplicate-code" : "concurrent-conflict" }; throw error; }
    },

    async setDocumentActive(id, active, expectedVersion, actor) {
      try {
        return await serializable(client, async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "Document" WHERE "id" = ${id} FOR UPDATE`;
          const current = await tx.document.findUnique({ where: { id } });
          if (!current) return { record: null, conflict: false };
          if (current.version !== expectedVersion || current.active === active) return { record: null, conflict: true, reason: "stale" };
          const now = clock.now();
          if (!active) {
            const obligations = await tx.documentRequirement.count({ where: { AND: [{ documentVersion: { documentId: id } }, effectiveWhere(now)] } });
            if (obligations > 0) return { record: null, conflict: true, reason: "active-requirements" };
          }
          const changed = await tx.document.updateMany({ where: { id, version: expectedVersion, active: !active }, data: { active, archivedAt: active ? null : now, reactivatedAt: active ? now : undefined, version: { increment: 1 }, updatedById: actor.id } });
          if (changed.count !== 1) return { record: null, conflict: true, reason: "stale" };
          await audit(tx, actor, active ? "reactivate_document" : "archive_document", "document", id, active ? "Document reactivated" : "Document archived", null, { documentId: id, versionBefore: expectedVersion, versionAfter: expectedVersion + 1 });
          return { record: await documentRecord(tx, (await loadedDocument(tx, id))!, now), conflict: false };
        });
      } catch (error) { if (conflictError(error)) return { record: null, conflict: true, reason: "concurrent-conflict" }; throw error; }
    },

    async listVersions(documentId, query, access, _actor, evaluationAt) {
      const visibility = await scopedRequirementVisibility(client, access);
      const visibleDocument = await client.document.findFirst({ where: { id: documentId, AND: [await documentVisibility(client, access)] }, select: { id: true } });
      if (!visibleDocument) return { total: 0, limit: query.limit, offset: query.offset, data: [] };
      const where: Prisma.DocumentVersionWhereInput = { documentId, ...(query.status ? { status: query.status } : {}), ...(access.global ? {} : { OR: [{ status: "Published", requirements: { some: visibility } }, { acknowledgements: { some: { memberProfileId: access.ownMemberProfileId ?? "__none__" } } }] }) };
      const orderBy: Prisma.DocumentVersionOrderByWithRelationInput = { [query.sort]: query.direction };
      const [total, rows] = await client.$transaction([client.documentVersion.count({ where }), client.documentVersion.findMany({ where, include: versionInclude, orderBy: [orderBy, { id: "asc" }], take: query.limit, skip: query.offset })]);
      return { total, limit: query.limit, offset: query.offset, data: await Promise.all(rows.map((row) => versionRecord(client, row, evaluationAt))) };
    },

    async getVersion(id, access, _actor, evaluationAt, includeContent = false) {
      const visibility = await scopedRequirementVisibility(client, access);
      const row = await client.documentVersion.findFirst({ where: { id, ...(access.global ? {} : { OR: [{ status: "Published", requirements: { some: visibility } }, { acknowledgements: { some: { memberProfileId: access.ownMemberProfileId ?? "__none__" } } }] }) }, include: versionInclude });
      return row ? versionRecord(client, row, evaluationAt, includeContent) : null;
    },

    async createVersion(documentId, input, actor) {
      try {
        return await serializable(client, async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "Document" WHERE "id" = ${documentId} FOR UPDATE`;
          const document = await tx.document.findUnique({ where: { id: documentId } });
          if (!document) return { record: null, conflict: false };
          if (!document.active) return { record: null, conflict: true, reason: "inactive-document" };
          const current = await tx.documentVersion.findFirst({ where: { documentId, status: "Published" }, select: { id: true } });
          const number = await nextSequence(tx, "DocumentVersion_id_seq");
          const row = await tx.documentVersion.create({ data: { id: businessId("dver", number, clock.now()), documentId, versionLabel: input.versionLabel, normalizedVersionLabel: normalizeLabel(input.versionLabel), titleOverride: input.titleOverride, changeSummary: input.changeSummary, effectiveFrom: input.effectiveFrom, reviewDueAt: input.reviewDueAt, contentMode: input.contentMode, contentBody: input.contentMode === "Internal text" ? input.contentBody : null, externalUrl: input.contentMode === "External link" ? input.externalUrl : null, basePublishedVersionId: current?.id ?? null, createdById: actor.id, updatedById: actor.id } });
          await audit(tx, actor, "create_document_version", "documentVersion", row.id, "Document version created", null, { documentId, documentVersionId: row.id, versionLabel: row.versionLabel, basePublishedVersionId: current?.id ?? null, versionAfter: 1 });
          return { record: await versionRecord(tx, (await loadedVersion(tx, row.id))!, clock.now()), conflict: false };
        });
      } catch (error) { if (conflictError(error)) return { record: null, conflict: true, reason: "duplicate-label" }; throw error; }
    },

    async updateVersion(id, input, expectedVersion, actor) {
      try {
        return await serializable(client, async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "DocumentVersion" WHERE "id" = ${id} FOR UPDATE`;
          const current = await tx.documentVersion.findUnique({ where: { id } });
          if (!current) return { record: null, conflict: false };
          if (current.version !== expectedVersion) return { record: null, conflict: true, reason: "stale" };
          if (current.status !== "Draft") return { record: null, conflict: true, reason: "invalid-transition" };
          const mode = input.contentMode ?? current.contentMode;
          const changed = await tx.documentVersion.updateMany({ where: { id, version: expectedVersion, status: "Draft" }, data: { ...(input.versionLabel !== undefined ? { versionLabel: input.versionLabel, normalizedVersionLabel: normalizeLabel(input.versionLabel) } : {}), ...(input.titleOverride !== undefined ? { titleOverride: input.titleOverride } : {}), ...(input.changeSummary !== undefined ? { changeSummary: input.changeSummary } : {}), ...(input.effectiveFrom !== undefined ? { effectiveFrom: input.effectiveFrom } : {}), ...(input.reviewDueAt !== undefined ? { reviewDueAt: input.reviewDueAt } : {}), ...(input.contentMode !== undefined ? { contentMode: input.contentMode } : {}), ...(mode === "Internal text" ? { contentBody: input.contentBody !== undefined ? input.contentBody : current.contentBody, externalUrl: null } : { externalUrl: input.externalUrl !== undefined ? input.externalUrl : current.externalUrl, contentBody: null }), version: { increment: 1 }, updatedById: actor.id } });
          if (changed.count !== 1) return { record: null, conflict: true, reason: "stale" };
          await audit(tx, actor, "update_document_version", "documentVersion", id, "Document version updated", null, { documentVersionId: id, changedFields: Object.keys(input), versionBefore: expectedVersion, versionAfter: expectedVersion + 1 });
          return { record: await versionRecord(tx, (await loadedVersion(tx, id))!, clock.now(), true), conflict: false };
        });
      } catch (error) { if (conflictError(error)) return { record: null, conflict: true, reason: error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" ? "duplicate-label" : "concurrent-conflict" }; throw error; }
    },

    async publishVersion(id, input, actor) {
      const commandFingerprint = fingerprint("publish_document_version", id, input);
      try {
        return await serializable(client, async (tx): Promise<MutationResult<DocumentVersionRecord>> => {
          const replay = await operationReplay(tx, input.operationId, commandFingerprint);
          if (replay?.mismatch) return { record: null, conflict: true, reason: "operation-misuse" };
          if (replay) return { record: replay.result as DocumentVersionRecord, conflict: false, idempotent: true };

          const preliminary = await tx.documentVersion.findUnique({ where: { id }, select: { documentId: true } });
          if (!preliminary) return { record: null, conflict: false };
          await tx.$queryRaw`SELECT "id" FROM "Document" WHERE "id" = ${preliminary.documentId} FOR UPDATE`;
          await tx.$queryRaw`SELECT "id" FROM "DocumentVersion" WHERE "id" = ${id} FOR UPDATE`;
          const current = await tx.documentVersion.findUnique({ where: { id }, include: versionInclude });
          if (!current) return { record: null, conflict: false };
          if (current.version !== input.expectedVersion) return { record: null, conflict: true, reason: "stale" };
          if (current.status !== "Draft") return { record: null, conflict: true, reason: "invalid-transition" };
          if (!current.document.active) return { record: null, conflict: true, reason: "inactive-document" };
          if (!contentAvailable(current)) return { record: null, conflict: true, reason: "invalid-content" };

          const published = await tx.documentVersion.findFirst({ where: { documentId: current.documentId, status: "Published" } });
          const expectedPublished = input.expectedCurrentPublishedVersionId === undefined ? current.basePublishedVersionId : input.expectedCurrentPublishedVersionId;
          if ((published?.id ?? null) !== (expectedPublished ?? null)) return { record: null, conflict: true, reason: "published-changed" };

          const now = clock.now();
          const beforeStats = published ? await versionStats(tx, { ...published, document: current.document }, now) : { requirementCount: 0, acknowledgementCount: 0, outstandingCount: 0 };
          if (published) {
            await tx.documentVersion.update({ where: { id: published.id }, data: { status: "Superseded", version: { increment: 1 }, updatedById: actor.id } });
          }
          const digest = current.contentMode === "Internal text" ? contentDigest(current.contentBody!) : null;
          const changed = await tx.documentVersion.updateMany({
            where: { id, version: input.expectedVersion, status: "Draft" },
            data: { status: "Published", publishedAt: now, publishedById: actor.id, effectiveFrom: current.effectiveFrom ?? now, contentDigest: digest, version: { increment: 1 }, updatedById: actor.id },
          });
          if (changed.count !== 1) return { record: null, conflict: true, reason: "stale" };
          const record = await versionRecord(tx, (await loadedVersion(tx, id))!, now, true);
          await tx.documentOperation.create({ data: { operationId: input.operationId, documentVersionId: id, command: "publish_document_version", commandFingerprint, resultVersion: record.version, result: json(record), requestId: actor.requestId } });
          await audit(tx, actor, "publish_document_version", "documentVersion", id, "Document version published", null, {
            documentId: current.documentId, documentVersionId: id, supersededVersionId: published?.id ?? null,
            affectedRequirementCount: beforeStats.requirementCount, affectedAcknowledgementCount: beforeStats.acknowledgementCount,
            affectedOutstandingCount: beforeStats.outstandingCount, versionBefore: input.expectedVersion, versionAfter: record.version,
          });
          return { record, conflict: false };
        });
      } catch (error) {
        if (conflictError(error)) return { record: null, conflict: true, reason: "concurrent-conflict" };
        throw error;
      }
    },

    async withdrawVersion(id, input, actor) {
      const commandFingerprint = fingerprint("withdraw_document_version", id, input);
      try {
        return await serializable(client, async (tx): Promise<MutationResult<DocumentVersionRecord>> => {
          const replay = await operationReplay(tx, input.operationId, commandFingerprint);
          if (replay?.mismatch) return { record: null, conflict: true, reason: "operation-misuse" };
          if (replay) return { record: replay.result as DocumentVersionRecord, conflict: false, idempotent: true };
          const preliminary = await tx.documentVersion.findUnique({ where: { id }, select: { documentId: true } });
          if (!preliminary) return { record: null, conflict: false };
          await tx.$queryRaw`SELECT "id" FROM "Document" WHERE "id" = ${preliminary.documentId} FOR UPDATE`;
          await tx.$queryRaw`SELECT "id" FROM "DocumentVersion" WHERE "id" = ${id} FOR UPDATE`;
          const current = await tx.documentVersion.findUnique({ where: { id }, include: versionInclude });
          if (!current) return { record: null, conflict: false };
          if (current.version !== input.expectedVersion) return { record: null, conflict: true, reason: "stale" };
          if (current.status !== "Draft" && current.status !== "Published") return { record: null, conflict: true, reason: "invalid-transition" };
          if (current.status === "Published" && (!input.reason || input.reason.trim().length < 3)) return { record: null, conflict: true, reason: "reason-required" };
          const now = clock.now();
          const changed = await tx.documentVersion.updateMany({ where: { id, version: input.expectedVersion, status: current.status }, data: { status: "Withdrawn", withdrawnAt: now, withdrawnById: actor.id, withdrawReason: input.reason?.trim() || null, version: { increment: 1 }, updatedById: actor.id } });
          if (changed.count !== 1) return { record: null, conflict: true, reason: "stale" };
          const record = await versionRecord(tx, (await loadedVersion(tx, id))!, now, true);
          await tx.documentOperation.create({ data: { operationId: input.operationId, documentVersionId: id, command: "withdraw_document_version", commandFingerprint, resultVersion: record.version, result: json(record), requestId: actor.requestId } });
          await audit(tx, actor, "withdraw_document_version", "documentVersion", id, "Document version withdrawn", null, { documentId: current.documentId, documentVersionId: id, reason: input.reason ?? null, versionBefore: input.expectedVersion, versionAfter: record.version });
          return { record, conflict: false };
        });
      } catch (error) {
        if (conflictError(error)) return { record: null, conflict: true, reason: "concurrent-conflict" };
        throw error;
      }
    },

    async listRequirements(query, access, _actor, evaluationAt) {
      const search = query.search?.trim();
      const filters: Prisma.DocumentRequirementWhereInput[] = [
        await scopedRequirementVisibility(client, access),
        query.documentId ? { documentVersion: { documentId: query.documentId } } : {},
        query.documentVersionId ? { documentVersionId: query.documentVersionId } : {},
        query.targetType ? { targetType: query.targetType } : {},
        query.active === undefined ? {} : { active: query.active },
        query.effective === undefined ? {} : query.effective ? effectiveWhere(evaluationAt) : { NOT: effectiveWhere(evaluationAt) },
        search ? { OR: [
          { documentVersion: { document: { title: { contains: search, mode: "insensitive" } } } },
          { documentVersion: { document: { code: { contains: search, mode: "insensitive" } } } },
          { targetRole: { contains: search, mode: "insensitive" } },
          { group: { name: { contains: search, mode: "insensitive" } } },
          { memberProfile: { OR: [{ firstName: { contains: search, mode: "insensitive" } }, { lastName: { contains: search, mode: "insensitive" } }, { memberId: { contains: search, mode: "insensitive" } }] } },
        ] } : {},
      ];
      const where: Prisma.DocumentRequirementWhereInput = { AND: filters };
      const primary: Prisma.DocumentRequirementOrderByWithRelationInput = query.sort === "document"
        ? { documentVersion: { document: { title: query.direction } } }
        : query.sort === "target" ? { targetType: query.direction }
        : { [query.sort]: query.direction };
      const [total, rows] = await client.$transaction([
        client.documentRequirement.count({ where }),
        client.documentRequirement.findMany({ where, include: requirementInclude, orderBy: [primary, { id: "asc" }], take: query.limit, skip: query.offset }),
      ]);
      return { total, limit: query.limit, offset: query.offset, data: await Promise.all(rows.map((row) => requirementRecord(client, row, evaluationAt))) };
    },

    async getRequirement(id, access, _actor, evaluationAt) {
      const row = await client.documentRequirement.findFirst({ where: { id, AND: [await scopedRequirementVisibility(client, access)] }, include: requirementInclude });
      return row ? requirementRecord(client, row, evaluationAt) : null;
    },

    async createRequirement(input, actor, incidentId = null) {
      try {
        return await serializable(client, async (tx): Promise<MutationResult<DocumentRequirementRecord>> => {
          await tx.$queryRaw`SELECT "id" FROM "DocumentVersion" WHERE "id" = ${input.documentVersionId} FOR UPDATE`;
          const version = await tx.documentVersion.findUnique({ where: { id: input.documentVersionId }, include: { document: true } });
          if (!version || version.status !== "Published" || !version.document.active) return { record: null, conflict: true, reason: "invalid-version" };
          if (input.targetType === "Role" && !supportedRoleTargets.includes(input.targetRole as any)) return { record: null, conflict: true, reason: "unsupported-role" };
          if (input.targetType === "Group") {
            await tx.$queryRaw`SELECT "id" FROM "OperationalGroup" WHERE "id" = ${input.groupId!} FOR UPDATE`;
            const group = await tx.operationalGroup.findUnique({ where: { id: input.groupId! } });
            if (!group || group.status === "Archived") return { record: null, conflict: true, reason: "inactive-target" };
          }
          if (input.targetType === "MemberProfile") {
            await tx.$queryRaw`SELECT "id" FROM "MemberProfile" WHERE "id" = ${input.memberProfileId!} FOR UPDATE`;
            const member = await tx.memberProfile.findUnique({ where: { id: input.memberProfileId! } });
            if (!member || member.status === "Archived") return { record: null, conflict: true, reason: "inactive-target" };
          }
          const effectiveFrom = input.effectiveFrom ?? clock.now();
          if (input.dueAt && input.dueAt < effectiveFrom) return { record: null, conflict: true, reason: "invalid-date" };
          const number = await nextSequence(tx, "DocumentRequirement_id_seq");
          const row = await tx.documentRequirement.create({ data: {
            id: businessId("dreq", number, clock.now()), documentVersionId: input.documentVersionId, targetType: input.targetType,
            targetRole: input.targetType === "Role" ? input.targetRole : null, groupId: input.targetType === "Group" ? input.groupId : null,
            memberProfileId: input.targetType === "MemberProfile" ? input.memberProfileId : null,
            acknowledgementRequired: input.acknowledgementRequired, effectiveFrom, dueAt: input.dueAt, createdById: actor.id, updatedById: actor.id,
          } });
          const record = await requirementRecord(tx, (await loadedRequirement(tx, row.id))!, clock.now());
          await audit(tx, actor, "create_document_requirement", "documentRequirement", row.id, "Document requirement created", incidentId, { documentVersionId: input.documentVersionId, requirementId: row.id, targetType: row.targetType, targetRole: row.targetRole, groupId: row.groupId, memberProfileId: row.memberProfileId, acknowledgementRequired: row.acknowledgementRequired, versionAfter: 1 });
          return { record, conflict: false };
        });
      } catch (error) {
        if (conflictError(error)) return { record: null, conflict: true, reason: error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" ? "duplicate-requirement" : "concurrent-conflict" };
        throw error;
      }
    },

    async updateRequirement(id, input, expectedVersion, actor, incidentId = null) {
      try {
        return await serializable(client, async (tx): Promise<MutationResult<DocumentRequirementRecord>> => {
          await tx.$queryRaw`SELECT "id" FROM "DocumentRequirement" WHERE "id" = ${id} FOR UPDATE`;
          const current = await tx.documentRequirement.findUnique({ where: { id } });
          if (!current) return { record: null, conflict: false };
          if (!current.active || current.version !== expectedVersion) return { record: null, conflict: true, reason: "stale" };
          const documentVersionId = input.documentVersionId ?? current.documentVersionId;
          await tx.$queryRaw`SELECT "id" FROM "DocumentVersion" WHERE "id" = ${documentVersionId} FOR UPDATE`;
          const version = await tx.documentVersion.findUnique({ where: { id: documentVersionId }, include: { document: true } });
          if (!version || version.status !== "Published" || !version.document.active) return { record: null, conflict: true, reason: "invalid-version" };
          const nextTargetType = input.targetType ?? current.targetType;
          const targetRole = nextTargetType === "Role" ? (input.targetRole !== undefined ? input.targetRole : current.targetRole) : null;
          const groupId = nextTargetType === "Group" ? (input.groupId !== undefined ? input.groupId : current.groupId) : null;
          const memberProfileId = nextTargetType === "MemberProfile" ? (input.memberProfileId !== undefined ? input.memberProfileId : current.memberProfileId) : null;
          if (nextTargetType === "Role" && !supportedRoleTargets.includes(targetRole as any)) return { record: null, conflict: true, reason: "unsupported-role" };
          if (nextTargetType === "Group") {
            if (!groupId) return { record: null, conflict: true, reason: "inactive-target" };
            await tx.$queryRaw`SELECT "id" FROM "OperationalGroup" WHERE "id" = ${groupId} FOR UPDATE`;
            const group = await tx.operationalGroup.findUnique({ where: { id: groupId } });
            if (!group || group.status === "Archived") return { record: null, conflict: true, reason: "inactive-target" };
          }
          if (nextTargetType === "MemberProfile") {
            if (!memberProfileId) return { record: null, conflict: true, reason: "inactive-target" };
            await tx.$queryRaw`SELECT "id" FROM "MemberProfile" WHERE "id" = ${memberProfileId} FOR UPDATE`;
            const member = await tx.memberProfile.findUnique({ where: { id: memberProfileId } });
            if (!member || member.status === "Archived") return { record: null, conflict: true, reason: "inactive-target" };
          }
          const effectiveFrom = input.effectiveFrom !== undefined ? input.effectiveFrom : current.effectiveFrom;
          const dueAt = input.dueAt !== undefined ? input.dueAt : current.dueAt;
          if (dueAt && effectiveFrom && dueAt < effectiveFrom) return { record: null, conflict: true, reason: "invalid-date" };
          const changed = await tx.documentRequirement.updateMany({ where: { id, version: expectedVersion, active: true }, data: {
            documentVersionId, targetType: nextTargetType, targetRole, groupId, memberProfileId,
            acknowledgementRequired: input.acknowledgementRequired ?? current.acknowledgementRequired,
            effectiveFrom, dueAt, version: { increment: 1 }, updatedById: actor.id,
          } });
          if (changed.count !== 1) return { record: null, conflict: true, reason: "stale" };
          const record = await requirementRecord(tx, (await loadedRequirement(tx, id))!, clock.now());
          await audit(tx, actor, "update_document_requirement", "documentRequirement", id, "Document requirement updated", incidentId, { requirementId: id, documentVersionId, targetType: nextTargetType, targetRole, groupId, memberProfileId, changedFields: Object.keys(input), versionBefore: expectedVersion, versionAfter: record.recordVersion });
          return { record, conflict: false };
        });
      } catch (error) {
        if (conflictError(error)) return { record: null, conflict: true, reason: error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" ? "duplicate-requirement" : "concurrent-conflict" };
        throw error;
      }
    },

    async endRequirement(id, input, actor, incidentId = null) {
      const commandFingerprint = fingerprint("end_document_requirement", id, input);
      try {
        return await serializable(client, async (tx): Promise<MutationResult<DocumentRequirementRecord>> => {
          const replay = await operationReplay(tx, input.operationId, commandFingerprint);
          if (replay?.mismatch) return { record: null, conflict: true, reason: "operation-misuse" };
          if (replay) return { record: replay.result as DocumentRequirementRecord, conflict: false, idempotent: true };
          await tx.$queryRaw`SELECT "id" FROM "DocumentRequirement" WHERE "id" = ${id} FOR UPDATE`;
          const current = await tx.documentRequirement.findUnique({ where: { id } });
          if (!current) return { record: null, conflict: false };
          if (!current.active || current.version !== input.expectedVersion) return { record: null, conflict: true, reason: "stale" };
          const now = clock.now();
          const effectiveTo = input.effectiveTo ?? now;
          if (current.effectiveFrom && effectiveTo <= current.effectiveFrom) return { record: null, conflict: true, reason: "invalid-date" };
          const changed = await tx.documentRequirement.updateMany({ where: { id, version: input.expectedVersion, active: true }, data: { active: false, effectiveTo, endedAt: now, endedById: actor.id, version: { increment: 1 }, updatedById: actor.id } });
          if (changed.count !== 1) return { record: null, conflict: true, reason: "stale" };
          const record = await requirementRecord(tx, (await loadedRequirement(tx, id))!, now);
          await tx.documentOperation.create({ data: { operationId: input.operationId, requirementId: id, command: "end_document_requirement", commandFingerprint, resultVersion: record.recordVersion, result: json(record), requestId: actor.requestId } });
          await audit(tx, actor, "end_document_requirement", "documentRequirement", id, "Document requirement ended", incidentId, { requirementId: id, effectiveTo: record.effectiveTo, versionBefore: input.expectedVersion, versionAfter: record.recordVersion });
          return { record, conflict: false };
        });
      } catch (error) {
        if (conflictError(error)) return { record: null, conflict: true, reason: "concurrent-conflict" };
        throw error;
      }
    },

    async listAcknowledgements(query, access, _actor, evaluationAt) {
      const where: Prisma.DocumentAcknowledgementWhereInput = {
        AND: [
          access.global ? {} : { memberProfile: memberVisibility(access) },
          query.memberProfileId ? { memberProfileId: query.memberProfileId } : {},
          query.documentId ? { documentVersion: { documentId: query.documentId } } : {},
          query.documentVersionId ? { documentVersionId: query.documentVersionId } : {},
          query.dateFrom ? { acknowledgedAt: { gte: query.dateFrom } } : {},
          query.dateTo ? { acknowledgedAt: { lte: query.dateTo } } : {},
          query.onBehalf === undefined ? {} : { onBehalf: query.onBehalf },
        ],
      };
      const primary: Prisma.DocumentAcknowledgementOrderByWithRelationInput = query.sort === "document"
        ? { documentVersion: { document: { title: query.direction } } }
        : query.sort === "member" ? { memberProfile: { lastName: query.direction } }
        : { acknowledgedAt: query.direction };
      const [total, rows] = await client.$transaction([
        client.documentAcknowledgement.count({ where }),
        client.documentAcknowledgement.findMany({ where, include: acknowledgementInclude, orderBy: [primary, { id: "asc" }], take: query.limit, skip: query.offset }),
      ]);
      return { total, limit: query.limit, offset: query.offset, data: await Promise.all(rows.map((row) => acknowledgementRecord(client, row, evaluationAt))) };
    },

    async acknowledgeVersion(id, input, memberProfileId, actor) {
      const commandFingerprint = fingerprint("acknowledge_document_version", id, { ...input, memberProfileId });
      try {
        return await serializable(client, async (tx): Promise<MutationResult<DocumentAcknowledgementRecord>> => {
          const replay = await operationReplay(tx, input.operationId, commandFingerprint);
          if (replay?.mismatch) return { record: null, conflict: true, reason: "operation-misuse" };
          if (replay) return { record: replay.result as DocumentAcknowledgementRecord, conflict: false, idempotent: true };
          const preliminary = await tx.documentVersion.findUnique({ where: { id }, select: { documentId: true } });
          if (!preliminary) return { record: null, conflict: false };
          await tx.$queryRaw`SELECT "id" FROM "Document" WHERE "id" = ${preliminary.documentId} FOR UPDATE`;
          await tx.$queryRaw`SELECT "id" FROM "DocumentVersion" WHERE "id" = ${id} FOR UPDATE`;
          await tx.$queryRaw`SELECT "id" FROM "MemberProfile" WHERE "id" = ${memberProfileId} FOR UPDATE`;
          const version = await tx.documentVersion.findUnique({ where: { id }, include: versionInclude });
          if (!version || version.status !== "Published" || !version.document.active) return { record: null, conflict: true, reason: "invalid-version" };
          if (!contentAvailable(version)) return { record: null, conflict: true, reason: "invalid-content" };
          let resolved = await memberRoleTargets(tx, memberProfileId);
          if (!resolved.member || resolved.member.status === "Archived") return { record: null, conflict: true, reason: "inactive-target" };

          const existing = await tx.documentAcknowledgement.findUnique({ where: { documentVersionId_memberProfileId: { documentVersionId: id, memberProfileId } }, include: acknowledgementInclude });
          if (existing) {
            const record = { ...(await acknowledgementRecord(tx, existing, clock.now())), duplicate: true };
            await tx.documentOperation.create({ data: { operationId: input.operationId, documentVersionId: id, acknowledgementId: existing.id, command: "acknowledge_document_version", commandFingerprint, resultVersion: 1, result: json(record), requestId: actor.requestId } });
            return { record, conflict: false };
          }

          if (resolved.groupIds.length) {
            await tx.$queryRaw`SELECT "id" FROM "GroupMembership" WHERE "memberProfileId" = ${memberProfileId} AND "removedAt" IS NULL FOR SHARE`;
            resolved = await memberRoleTargets(tx, memberProfileId);
          }
          const requirements = await tx.documentRequirement.findMany({ where: {
            documentVersionId: id, acknowledgementRequired: true, ...effectiveWhere(clock.now()), OR: [
              ...(resolved.roleTargets.length ? [{ targetType: "Role", targetRole: { in: resolved.roleTargets } }] : []),
              ...(resolved.groupIds.length ? [{ targetType: "Group", groupId: { in: resolved.groupIds } }] : []),
              { targetType: "MemberProfile", memberProfileId },
            ],
          }, include: requirementInclude });
          if (!requirements.length) return { record: null, conflict: true, reason: "not-applicable" };
          const requirementIds = requirements.map((requirement) => requirement.id);
          await tx.$queryRaw`SELECT "id" FROM "DocumentRequirement" WHERE "id" IN (${Prisma.join(requirementIds)}) FOR SHARE`;
          if (input.onBehalf && (!input.note || input.note.trim().length < 3)) return { record: null, conflict: true, reason: "note-required" };

          const now = clock.now();
          const number = await nextSequence(tx, "DocumentAcknowledgement_id_seq");
          const row = await tx.documentAcknowledgement.create({ data: {
            id: businessId("dack", number, now), documentVersionId: id, memberProfileId, acknowledgedAt: now, acknowledgedById: actor.id,
            acknowledgementStatementVersion: "standard-v1", note: input.note?.trim() || null, onBehalf: Boolean(input.onBehalf),
            documentCode: version.document.code, documentTitle: version.titleOverride || version.document.title, versionLabel: version.versionLabel,
            contentMode: version.contentMode, externalUrlSnapshot: version.contentMode === "External link" ? version.externalUrl : null,
            contentDigestSnapshot: version.contentMode === "Internal text" ? version.contentDigest : null,
            sourceRequirements: { create: requirementIds.map((requirementId) => ({ requirementId })) },
          }, include: acknowledgementInclude });
          const record = { ...(await acknowledgementRecord(tx, row, now)), duplicate: false };
          await tx.documentOperation.create({ data: { operationId: input.operationId, documentVersionId: id, acknowledgementId: row.id, command: "acknowledge_document_version", commandFingerprint, resultVersion: 1, result: json(record), requestId: actor.requestId } });
          await audit(tx, actor, "acknowledge_document_version", "documentAcknowledgement", row.id, "Document version acknowledged", null, { acknowledgementId: row.id, documentId: version.documentId, documentVersionId: id, memberProfileId, onBehalf: Boolean(input.onBehalf), sourceRequirementIds: requirementIds, sourceGroupIds: requirements.map((requirement) => requirement.groupId).filter(Boolean) });
          return { record, conflict: false };
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          const existing = await client.documentAcknowledgement.findUnique({ where: { documentVersionId_memberProfileId: { documentVersionId: id, memberProfileId } }, include: acknowledgementInclude });
          if (existing) return { record: { ...(await acknowledgementRecord(client, existing, clock.now())), duplicate: true }, conflict: false };
        }
        if (conflictError(error)) return { record: null, conflict: true, reason: "concurrent-conflict" };
        throw error;
      }
    },

    async evaluateMemberCompliance(memberProfileId, actor, evaluationAt) {
      const { member, items } = await personalObligations(memberProfileId, actor, evaluationAt);
      if (!member) return null;
      const totals = {
        required: items.filter((item) => item.acknowledgementRequired).length,
        awareness: items.filter((item) => !item.acknowledgementRequired).length,
        outstanding: items.filter((item) => item.acknowledgementRequired && item.status !== "Acknowledged").length,
        overdue: items.filter((item) => item.status === "Overdue").length,
        acknowledged: items.filter((item) => item.status === "Acknowledged").length,
        unavailableContent: items.filter((item) => item.acknowledgementRequired && !item.contentAvailable).length,
      };
      const status: DocumentCompliance["status"] = !items.length ? "Not applicable" : totals.overdue ? "Non-compliant" : totals.outstanding || totals.unavailableContent ? "Attention" : "Compliant";
      return { memberProfileId, member, evaluationAt: evaluationAt.toISOString(), status, totals, items };
    },
  };
}
