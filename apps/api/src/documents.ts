import { DirectoryError } from "./member-directory.js";
import type { DirectoryActor, MemberDirectoryRepository } from "./member-directory.js";
import { canAccessGroup, canAccessMember, permissionScope } from "./scope-policy.js";

export type DocumentVersionStatus = "Draft" | "Published" | "Superseded" | "Withdrawn";
export type DocumentContentMode = "Internal text" | "External link";
export type DocumentRequirementTargetType = "Role" | "Group" | "MemberProfile";

type Query = Record<string, unknown>;
type DirectoryLookupMember = ReturnType<MemberDirectoryRepository["lookupMember"]>;
type DirectoryMember = Pick<DirectoryLookupMember, "id" | "memberId" | "displayName" | "pool" | "role" | "assignedFunction" | "rosterStatus" | "status">;
type DirectoryGroup = ReturnType<MemberDirectoryRepository["lookupGroup"]>;

type DocumentRecord = {
  id: string;
  code: string;
  normalizedCode: string;
  title: string;
  description?: string | null;
  category: string;
  ownerFunction: string;
  active: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdById?: string | null;
  updatedById?: string | null;
  archivedAt?: string | null;
};

type DocumentVersionRecord = {
  id: string;
  documentId: string;
  versionLabel: string;
  normalizedVersionLabel: string;
  titleOverride?: string | null;
  changeSummary?: string | null;
  status: DocumentVersionStatus;
  effectiveFrom?: string | null;
  reviewDueAt?: string | null;
  publishedAt?: string | null;
  publishedById?: string | null;
  contentMode: DocumentContentMode;
  contentBody?: string | null;
  externalUrl?: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdById?: string | null;
  updatedById?: string | null;
};

type DocumentRequirementRecord = {
  id: string;
  documentVersionId: string;
  targetType: DocumentRequirementTargetType;
  targetRole?: string | null;
  groupId?: string | null;
  memberProfileId?: string | null;
  acknowledgementRequired: boolean;
  effectiveFrom?: string | null;
  dueAt?: string | null;
  effectiveTo?: string | null;
  active: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdById?: string | null;
  updatedById?: string | null;
};

type DocumentAcknowledgementRecord = {
  id: string;
  documentVersionId: string;
  memberProfileId: string;
  sourceRequirementIds: string[];
  acknowledgedAt: string;
  acknowledgedById: string;
  acknowledgementStatementVersion: string;
  note?: string | null;
  onBehalf: boolean;
  createdAt: string;
};

const initialTimestamp = "2026-07-09T09:00:00.000Z";
const referenceNow = "2026-07-13T09:00:00.000Z";
const versionStatuses = new Set<DocumentVersionStatus>(["Draft", "Published", "Superseded", "Withdrawn"]);
const contentModes = new Set<DocumentContentMode>(["Internal text", "External link"]);
const targetTypes = new Set<DocumentRequirementTargetType>(["Role", "Group", "MemberProfile"]);

function asString(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function optionalString(value: unknown) {
  const next = asString(value);
  return next ? next : null;
}

function asBoolean(value: unknown, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes"].includes(normalized)) return true;
    if (["false", "0", "no"].includes(normalized)) return false;
  }
  return fallback;
}

function asNumber(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalize(value: unknown) {
  return asString(value).toLowerCase();
}

function normalizeCode(value: unknown) {
  return asString(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeLabel(value: unknown) {
  return asString(value).toLowerCase().replace(/\s+/g, " ");
}

function assert(condition: unknown, status: number, message: string): asserts condition {
  if (!condition) throw new DirectoryError(status, message);
}

function parseDate(value: unknown, label: string) {
  const raw = asString(value);
  assert(raw, 400, `${label} is required.`);
  const date = new Date(raw);
  assert(Number.isFinite(date.getTime()), 400, `${label} must be a valid date and time.`);
  return date.toISOString();
}

function parseOptionalDate(value: unknown, label: string) {
  if (value === undefined || value === null || asString(value) === "") return null;
  return parseDate(value, label);
}

function isPastAt(value?: string | null, evaluationAt = referenceNow) {
  return Boolean(value && new Date(value).getTime() < new Date(evaluationAt).getTime());
}

function pageQuery(query: Query) {
  const limit = Math.min(Math.max(Math.trunc(asNumber(query.limit, 50)), 1), 200);
  const offset = Math.max(Math.trunc(asNumber(query.offset, 0)), 0);
  return { limit, offset };
}

function page<T>(data: T[], query: Query, extra?: Record<string, unknown>) {
  const { limit, offset } = pageQuery(query);
  return { total: data.length, limit, offset, data: data.slice(offset, offset + limit), ...(extra ?? {}) };
}

function nextId(prefix: string, count: number) {
  return `${prefix}-2026-${String(count).padStart(6, "0")}`;
}

function bump<T extends { version: number; updatedAt: string; updatedById?: string | null }>(record: T, actor: DirectoryActor) {
  const previousTime = new Date(record.updatedAt).getTime();
  const nextDate = new Date();
  if (Number.isFinite(previousTime) && nextDate.getTime() <= previousTime) nextDate.setTime(previousTime + 1);
  record.version += 1;
  record.updatedAt = nextDate.toISOString();
  record.updatedById = actor.id;
}

function hasPermission(actor: DirectoryActor, permission: string) {
  return actor.permissions.includes(permission);
}

function canReadOwn(actor: DirectoryActor) {
  return hasPermission(actor, "document:read-own");
}

function canReadAll(actor: DirectoryActor) {
  return permissionScope(actor, "document:read-all").global;
}

function canManageDocuments(actor: DirectoryActor) {
  return hasPermission(actor, "document:manage");
}

function canManageVersions(actor: DirectoryActor) {
  return hasPermission(actor, "document:version:manage");
}

function canPublish(actor: DirectoryActor) {
  return hasPermission(actor, "document:publish");
}

function canManageRequirements(actor: DirectoryActor) {
  return hasPermission(actor, "document:requirement:manage");
}

function canAcknowledgeOwn(actor: DirectoryActor) {
  return hasPermission(actor, "document:acknowledge-own");
}

function canAcknowledgeAll(actor: DirectoryActor) {
  return hasPermission(actor, "document:acknowledge-all");
}

function assertDocumentRead(actor: DirectoryActor) {
  assert(canReadOwn(actor) || hasPermission(actor, "document:read-all"), 403, "You do not have access to documents.");
}

function assertExpectedUpdatedAt(body: Query, record: { updatedAt: string }) {
  const expectedUpdatedAt = optionalString(body.expectedUpdatedAt);
  assert(!expectedUpdatedAt || expectedUpdatedAt === record.updatedAt, 409, "This item changed. Reload and try again.");
}

function validExternalUrl(value?: string | null) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function memberSummary(member: DirectoryMember) {
  return {
    id: member.id,
    memberId: member.memberId,
    displayName: member.displayName,
    pool: member.pool,
    role: member.role,
    assignedFunction: member.assignedFunction,
    status: member.status
  };
}

function groupSummary(group: DirectoryGroup) {
  return {
    id: group.id,
    operationalId: group.operationalId,
    name: group.name,
    pool: group.pool,
    functionName: group.functionName,
    status: group.status,
    memberCount: group.memberCount
  };
}

function roleMatchesMember(targetRole: string, member: DirectoryMember) {
  const target = normalize(targetRole);
  if (!target) return false;
  const pool = normalize(member.pool);
  const role = normalize(member.role);
  if (target === "zpp" || target === "zpp member") return pool === "zpp";
  if (target === "tec" || target === "tec member") return pool === "tec";
  if (target === "zpp group leader") return pool === "zpp" && role.includes("lead");
  if (target === "tec group leader") return pool === "tec" && role.includes("lead");
  return [member.role, member.pool, member.assignedFunction].some((value) => normalize(value).includes(target));
}

export function createDocumentRepository(directory: MemberDirectoryRepository) {
  let documentCounter = 7;
  let versionCounter = 7;
  let requirementCounter = 6;
  let acknowledgementCounter = 2;

  const documents: DocumentRecord[] = [
    {
      id: "doc-2026-000001",
      code: "ERP-ROLE-CARDS",
      normalizedCode: "ERP-ROLE-CARDS",
      title: "ERP Role Cards",
      description: "Role cards for response functions during an active session.",
      category: "Coordination",
      ownerFunction: "Crisis Coordination",
      active: true,
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000002",
      updatedById: "00000000-0000-4000-8000-000000000002"
    },
    {
      id: "doc-2026-000002",
      code: "TEC-CALL-GUIDE",
      normalizedCode: "TEC-CALL-GUIDE",
      title: "TEC Call Intake Guide",
      description: "Call intake guidance for enquiries without disclosing passenger or casualty status.",
      category: "TEC",
      ownerFunction: "Telephone Enquiry Center",
      active: true,
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000002",
      updatedById: "00000000-0000-4000-8000-000000000002"
    },
    {
      id: "doc-2026-000003",
      code: "FAC-HANDOVER",
      normalizedCode: "FAC-HANDOVER",
      title: "Family Assistance Handover",
      description: "Handover notes and minimum briefing content for FAC teams.",
      category: "Family Assistance",
      ownerFunction: "Family Assistance Team",
      active: true,
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000004",
      updatedById: "00000000-0000-4000-8000-000000000004"
    },
    {
      id: "doc-2026-000004",
      code: "DATA-SENSITIVE",
      normalizedCode: "DATA-SENSITIVE",
      title: "Sensitive Data Handling",
      description: "Rules for protecting passenger, crew and family information.",
      category: "Data Protection",
      ownerFunction: "Data Protection",
      active: true,
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000002",
      updatedById: "00000000-0000-4000-8000-000000000002"
    },
    {
      id: "doc-2026-000005",
      code: "ROSTER-BRIEF",
      normalizedCode: "ROSTER-BRIEF",
      title: "Roster Coverage Briefing",
      description: "Draft briefing format for roster coverage reviews.",
      category: "Rostering",
      ownerFunction: "Member Rostering",
      active: true,
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000004",
      updatedById: "00000000-0000-4000-8000-000000000004"
    },
    {
      id: "doc-2026-000006",
      code: "AIRPORT-RECEPTION",
      normalizedCode: "AIRPORT-RECEPTION",
      title: "Airport Reception Checklist",
      description: "Historical checklist retained for reference.",
      category: "Airport Support",
      ownerFunction: "Airport Support",
      active: false,
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: "2026-07-01T09:00:00.000Z",
      archivedAt: "2026-07-01T09:00:00.000Z",
      createdById: "00000000-0000-4000-8000-000000000002",
      updatedById: "00000000-0000-4000-8000-000000000002"
    }
  ];

  const versions: DocumentVersionRecord[] = [
    {
      id: "dver-2026-000001",
      documentId: "doc-2026-000001",
      versionLabel: "v1.0",
      normalizedVersionLabel: "v1.0",
      status: "Superseded",
      changeSummary: "Initial role-card set.",
      effectiveFrom: "2026-05-01T08:00:00.000Z",
      reviewDueAt: "2026-08-01T08:00:00.000Z",
      publishedAt: "2026-05-01T08:00:00.000Z",
      publishedById: "00000000-0000-4000-8000-000000000002",
      contentMode: "Internal text",
      contentBody: "Earlier role-card guidance retained for audit history.",
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000002",
      updatedById: "00000000-0000-4000-8000-000000000002"
    },
    {
      id: "dver-2026-000002",
      documentId: "doc-2026-000001",
      versionLabel: "v2.0",
      normalizedVersionLabel: "v2.0",
      status: "Published",
      changeSummary: "Clarifies first action, escalation and handover checks.",
      effectiveFrom: "2026-07-09T08:00:00.000Z",
      reviewDueAt: "2026-10-01T08:00:00.000Z",
      publishedAt: "2026-07-09T08:00:00.000Z",
      publishedById: "00000000-0000-4000-8000-000000000002",
      contentMode: "Internal text",
      contentBody: [
        "Use these role cards before taking work in a specialist queue.",
        "",
        "1. Confirm the active session and your assigned function.",
        "2. Open your own work queue before searching wider records.",
        "3. Escalate anything that involves disclosure, identity uncertainty or a welfare risk.",
        "4. Leave a concise handover note when work moves to another person."
      ].join("\n"),
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000002",
      updatedById: "00000000-0000-4000-8000-000000000002"
    },
    {
      id: "dver-2026-000003",
      documentId: "doc-2026-000002",
      versionLabel: "v1.1",
      normalizedVersionLabel: "v1.1",
      status: "Published",
      changeSummary: "Adds caller-contact confirmation before enquiry save.",
      effectiveFrom: "2026-07-09T08:00:00.000Z",
      reviewDueAt: "2026-09-15T08:00:00.000Z",
      publishedAt: "2026-07-09T08:00:00.000Z",
      publishedById: "00000000-0000-4000-8000-000000000002",
      contentMode: "Internal text",
      contentBody: "Capture who is calling, how to contact them, what they reported and whether support action is needed. Do not confirm passenger, casualty or NOK status from this workflow.",
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000002",
      updatedById: "00000000-0000-4000-8000-000000000002"
    },
    {
      id: "dver-2026-000004",
      documentId: "doc-2026-000003",
      versionLabel: "v1.0",
      normalizedVersionLabel: "v1.0",
      status: "Published",
      changeSummary: "First controlled handover guide.",
      effectiveFrom: "2026-07-09T08:00:00.000Z",
      reviewDueAt: "2026-09-01T08:00:00.000Z",
      publishedAt: "2026-07-09T08:00:00.000Z",
      publishedById: "00000000-0000-4000-8000-000000000004",
      contentMode: "Internal text",
      contentBody: "Before handover, record the family reference, agreed next contact, open welfare needs, owner and any disclosure restriction. Keep handover notes concise and suitable for the next response member.",
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000004",
      updatedById: "00000000-0000-4000-8000-000000000004"
    },
    {
      id: "dver-2026-000005",
      documentId: "doc-2026-000004",
      versionLabel: "v3.0",
      normalizedVersionLabel: "v3.0",
      status: "Published",
      changeSummary: "Links to the current sensitive data handling standard.",
      effectiveFrom: "2026-07-09T08:00:00.000Z",
      reviewDueAt: "2026-12-01T08:00:00.000Z",
      publishedAt: "2026-07-09T08:00:00.000Z",
      publishedById: "00000000-0000-4000-8000-000000000002",
      contentMode: "External link",
      externalUrl: "https://example.com/zpp/sensitive-data-handling",
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000002",
      updatedById: "00000000-0000-4000-8000-000000000002"
    },
    {
      id: "dver-2026-000006",
      documentId: "doc-2026-000005",
      versionLabel: "draft-2026-07",
      normalizedVersionLabel: "draft-2026-07",
      status: "Draft",
      changeSummary: "Draft roster briefing structure.",
      contentMode: "Internal text",
      contentBody: "Draft: identify gaps, confirm owners and record next contact time.",
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000004",
      updatedById: "00000000-0000-4000-8000-000000000004"
    }
  ];

  const requirements: DocumentRequirementRecord[] = [
    {
      id: "dreq-2026-000001",
      documentVersionId: "dver-2026-000002",
      targetType: "Role",
      targetRole: "ZPP Member",
      acknowledgementRequired: true,
      effectiveFrom: "2026-07-09T08:00:00.000Z",
      dueAt: "2026-07-30T12:00:00.000Z",
      active: true,
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000002",
      updatedById: "00000000-0000-4000-8000-000000000002"
    },
    {
      id: "dreq-2026-000002",
      documentVersionId: "dver-2026-000003",
      targetType: "Role",
      targetRole: "TEC Member",
      acknowledgementRequired: true,
      effectiveFrom: "2026-07-09T08:00:00.000Z",
      dueAt: "2026-07-20T12:00:00.000Z",
      active: true,
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000002",
      updatedById: "00000000-0000-4000-8000-000000000002"
    },
    {
      id: "dreq-2026-000003",
      documentVersionId: "dver-2026-000004",
      targetType: "Group",
      groupId: "grp-2026-000001",
      acknowledgementRequired: true,
      effectiveFrom: "2026-07-09T08:00:00.000Z",
      dueAt: "2026-07-22T12:00:00.000Z",
      active: true,
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000004",
      updatedById: "00000000-0000-4000-8000-000000000004"
    },
    {
      id: "dreq-2026-000004",
      documentVersionId: "dver-2026-000005",
      targetType: "MemberProfile",
      memberProfileId: "mem-2026-000001",
      acknowledgementRequired: true,
      effectiveFrom: "2026-07-09T08:00:00.000Z",
      active: true,
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000002",
      updatedById: "00000000-0000-4000-8000-000000000002"
    },
    {
      id: "dreq-2026-000005",
      documentVersionId: "dver-2026-000002",
      targetType: "Group",
      groupId: "grp-2026-000001",
      acknowledgementRequired: true,
      effectiveFrom: "2026-07-09T08:00:00.000Z",
      dueAt: "2026-07-25T12:00:00.000Z",
      active: true,
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000004",
      updatedById: "00000000-0000-4000-8000-000000000004"
    }
  ];

  const acknowledgements: DocumentAcknowledgementRecord[] = [
    {
      id: "dack-2026-000001",
      documentVersionId: "dver-2026-000002",
      memberProfileId: "mem-2026-000003",
      sourceRequirementIds: ["dreq-2026-000001", "dreq-2026-000005"],
      acknowledgedAt: "2026-07-10T09:00:00.000Z",
      acknowledgedById: "00000000-0000-4000-8000-000000000004",
      acknowledgementStatementVersion: "standard-v1",
      onBehalf: true,
      createdAt: "2026-07-10T09:00:00.000Z"
    }
  ];

  function allMembers(actor?: DirectoryActor) {
    return directory.listMembers({ limit: 200 }, actor).data as DirectoryMember[];
  }

  function allGroups() {
    return directory.listGroups({ limit: 200 }).data as DirectoryGroup[];
  }

  function linkedMember(actor: DirectoryActor) {
    return directory.resolveMemberForUser(actor.id);
  }

  function findDocument(id: string) {
    return documents.find((document) => document.id === id);
  }

  function assertDocument(id: string) {
    const document = findDocument(id);
    assert(document, 404, "Document not found.");
    return document;
  }

  function findVersion(id: string) {
    return versions.find((version) => version.id === id);
  }

  function assertVersion(id: string) {
    const version = findVersion(id);
    assert(version, 404, "Document version not found.");
    return version;
  }

  function assertRequirement(id: string) {
    const requirement = requirements.find((candidate) => candidate.id === id);
    assert(requirement, 404, "Document requirement not found.");
    return requirement;
  }

  function currentPublishedVersion(documentId: string) {
    return versions.find((version) => version.documentId === documentId && version.status === "Published") ?? null;
  }

  function contentAvailable(version: DocumentVersionRecord) {
    return version.contentMode === "Internal text" ? Boolean(asString(version.contentBody)) : validExternalUrl(version.externalUrl);
  }

  function targetMemberIds(requirement: DocumentRequirementRecord, actor?: DirectoryActor) {
    if (requirement.targetType === "Role") {
      return allMembers(actor)
        .filter((member) => member.status !== "Archived" && roleMatchesMember(requirement.targetRole ?? "", member))
        .map((member) => member.id);
    }
    if (requirement.targetType === "Group") {
      const group = directory.lookupGroup(requirement.groupId ?? "");
      if (group.status === "Archived") return [];
      return group.memberIds.filter((id) => directory.lookupMember(id).status !== "Archived");
    }
    const memberId = requirement.memberProfileId;
    if (!memberId) return [];
    return directory.lookupMember(memberId).status === "Archived" ? [] : [memberId];
  }

  function requirementAppliesToMember(requirement: DocumentRequirementRecord, member: DirectoryMember, actor?: DirectoryActor) {
    return targetMemberIds(requirement, actor).includes(member.id);
  }

  function requirementTarget(requirement: DocumentRequirementRecord) {
    if (requirement.targetType === "Role") {
      return { type: requirement.targetType, label: requirement.targetRole ?? "Role", targetRole: requirement.targetRole ?? "" };
    }
    if (requirement.targetType === "Group") {
      const group = directory.lookupGroup(requirement.groupId ?? "");
      return { type: requirement.targetType, label: group.name, group: groupSummary(group), groupId: group.id };
    }
    const member = directory.lookupMember(requirement.memberProfileId ?? "");
    return { type: requirement.targetType, label: member.displayName, member: memberSummary(member), memberProfileId: member.id };
  }

  function activeRequirementsForVersion(versionId: string) {
    return requirements.filter((requirement) => requirement.documentVersionId === versionId && requirement.active && !requirement.effectiveTo);
  }

  function activeRequirementsForMember(versionId: string, member: DirectoryMember, actor?: DirectoryActor) {
    return activeRequirementsForVersion(versionId).filter((requirement) => requirementAppliesToMember(requirement, member, actor));
  }

  function acknowledgementFor(versionId: string, memberProfileId: string) {
    return acknowledgements.find((acknowledgement) => acknowledgement.documentVersionId === versionId && acknowledgement.memberProfileId === memberProfileId) ?? null;
  }

  function acknowledgementView(acknowledgement: DocumentAcknowledgementRecord) {
    const version = assertVersion(acknowledgement.documentVersionId);
    const document = assertDocument(version.documentId);
    const member = directory.lookupMember(acknowledgement.memberProfileId);
    return {
      id: acknowledgement.id,
      documentVersionId: acknowledgement.documentVersionId,
      documentId: document.id,
      document: documentSummary(document),
      version: versionSummary(version),
      memberProfileId: member.id,
      member: memberSummary(member),
      sourceRequirementIds: [...acknowledgement.sourceRequirementIds],
      acknowledgedAt: acknowledgement.acknowledgedAt,
      acknowledgedById: acknowledgement.acknowledgedById,
      acknowledgementStatementVersion: acknowledgement.acknowledgementStatementVersion,
      note: acknowledgement.note ?? "",
      onBehalf: acknowledgement.onBehalf,
      createdAt: acknowledgement.createdAt
    };
  }

  function versionSummary(version: DocumentVersionRecord) {
    const document = assertDocument(version.documentId);
    return {
      id: version.id,
      documentId: version.documentId,
      title: version.titleOverride || document.title,
      versionLabel: version.versionLabel,
      status: version.status,
      contentMode: version.contentMode,
      contentAvailable: contentAvailable(version),
      externalUrl: version.contentMode === "External link" ? version.externalUrl ?? "" : "",
      effectiveFrom: version.effectiveFrom ?? null,
      reviewDueAt: version.reviewDueAt ?? null,
      publishedAt: version.publishedAt ?? null,
      publishedById: version.publishedById ?? null,
      changeSummary: version.changeSummary ?? "",
      createdAt: version.createdAt,
      updatedAt: version.updatedAt,
      version: version.version
    };
  }

  function versionView(version: DocumentVersionRecord) {
    const document = assertDocument(version.documentId);
    const activeRequirementRows = activeRequirementsForVersion(version.id);
    return {
      ...versionSummary(version),
      document: documentSummary(document),
      requirementCount: activeRequirementRows.length,
      acknowledgementCount: acknowledgements.filter((acknowledgement) => acknowledgement.documentVersionId === version.id).length,
      canPublish: version.status === "Draft" && contentAvailable(version),
      canEdit: version.status === "Draft",
      canWithdraw: version.status === "Draft" || version.status === "Published"
    };
  }

  function documentSummary(document: DocumentRecord) {
    const currentVersion = currentPublishedVersion(document.id);
    return {
      id: document.id,
      code: document.code,
      title: document.title,
      description: document.description ?? "",
      category: document.category,
      ownerFunction: document.ownerFunction,
      active: document.active,
      status: document.active ? "Active" : "Archived",
      currentVersion: currentVersion ? versionSummary(currentVersion) : null,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
      version: document.version
    };
  }

  function documentView(document: DocumentRecord, actor?: DirectoryActor) {
    const documentVersions = versions.filter((version) => version.documentId === document.id);
    const activeRequirementRows = requirements.filter((requirement) => {
      const version = findVersion(requirement.documentVersionId);
      return requirement.active && version?.documentId === document.id && version.status === "Published" && (!actor || canSeeRequirement(requirement, actor, "document:read-all"));
    });
    const requiredMemberIds = new Set(activeRequirementRows.flatMap((requirement) => targetMemberIds(requirement)));
    const acknowledgedMemberIds = new Set(
      acknowledgements
        .filter((acknowledgement) => documentVersions.some((version) => version.id === acknowledgement.documentVersionId))
        .map((acknowledgement) => acknowledgement.memberProfileId)
    );
    return {
      ...documentSummary(document),
      versionCount: documentVersions.length,
      activeRequirementCount: activeRequirementRows.length,
      acknowledgementCount: acknowledgedMemberIds.size,
      outstandingCount: Array.from(requiredMemberIds).filter((id) => !acknowledgedMemberIds.has(id)).length
    };
  }

  function validateDocumentBody(body: Query, existing?: DocumentRecord) {
    const code = asString(body.code, existing?.code ?? "");
    const normalizedCode = normalizeCode(code);
    assert(normalizedCode, 400, "Document code is required.");
    const duplicate = documents.find((document) => document.id !== existing?.id && document.normalizedCode === normalizedCode);
    assert(!duplicate, 409, "A document with this code already exists.");
    const title = asString(body.title, existing?.title ?? "");
    assert(title, 400, "Document title is required.");
    return {
      code,
      normalizedCode,
      title,
      description: optionalString(body.description ?? existing?.description),
      category: asString(body.category, existing?.category ?? "Operational"),
      ownerFunction: asString(body.ownerFunction, existing?.ownerFunction ?? "ZPP")
    };
  }

  function validateVersionBody(documentId: string, body: Query, existing?: DocumentVersionRecord) {
    const document = assertDocument(documentId);
    assert(document.active || existing, 409, "Archived documents cannot receive new versions.");
    const versionLabel = asString(body.versionLabel, existing?.versionLabel ?? "");
    const normalizedVersionLabel = normalizeLabel(versionLabel);
    assert(versionLabel, 400, "Version label is required.");
    const duplicate = versions.find((version) => version.id !== existing?.id && version.documentId === documentId && version.normalizedVersionLabel === normalizedVersionLabel);
    assert(!duplicate, 409, "This document already has a version with that label.");
    const contentMode = asString(body.contentMode, existing?.contentMode ?? "Internal text") as DocumentContentMode;
    assert(contentModes.has(contentMode), 400, "Content mode is invalid.");
    return {
      documentId,
      versionLabel,
      normalizedVersionLabel,
      titleOverride: optionalString(body.titleOverride ?? existing?.titleOverride),
      changeSummary: optionalString(body.changeSummary ?? existing?.changeSummary),
      effectiveFrom: parseOptionalDate(body.effectiveFrom ?? existing?.effectiveFrom, "Effective from"),
      reviewDueAt: parseOptionalDate(body.reviewDueAt ?? existing?.reviewDueAt, "Review due"),
      contentMode,
      contentBody: contentMode === "Internal text" ? optionalString(body.contentBody ?? existing?.contentBody) : null,
      externalUrl: contentMode === "External link" ? optionalString(body.externalUrl ?? existing?.externalUrl) : null
    };
  }

  function validateRequirementBody(body: Query, existing: DocumentRequirementRecord | undefined, actor: DirectoryActor) {
    const documentVersionId = asString(body.documentVersionId, existing?.documentVersionId ?? "");
    const version = assertVersion(documentVersionId);
    assert(version.status === "Published", 409, "Requirements can only be added to published document versions.");
    assert(assertDocument(version.documentId).active, 409, "Archived documents cannot receive new requirements.");
    const targetType = asString(body.targetType, existing?.targetType ?? "Role") as DocumentRequirementTargetType;
    assert(targetTypes.has(targetType), 400, "Requirement target is invalid.");
    let targetRole: string | null = null;
    let groupId: string | null = null;
    let memberProfileId: string | null = null;
    if (targetType === "Role") {
      assert(permissionScope(actor, "document:requirement:manage").global, 403, "Role-wide requirements require global access.");
      targetRole = asString(body.targetRole, existing?.targetType === "Role" ? existing.targetRole ?? "" : "");
      assert(targetRole, 400, "Role target is required.");
    } else if (targetType === "Group") {
      groupId = asString(body.groupId, existing?.targetType === "Group" ? existing.groupId ?? "" : "");
      assert(groupId, 400, "Group is required.");
      assert(canAccessGroup(actor, "document:requirement:manage", groupId), 403, "Forbidden");
      const group = directory.lookupGroup(groupId);
      assert(group.status !== "Archived", 409, "Archived groups cannot receive new document requirements.");
    } else {
      memberProfileId = asString(body.memberProfileId, existing?.targetType === "MemberProfile" ? existing.memberProfileId ?? "" : "");
      assert(memberProfileId, 400, "Member profile is required.");
      assert(canAccessMember(actor, "document:requirement:manage", directory, memberProfileId), 403, "Forbidden");
      const member = directory.lookupMember(memberProfileId);
      assert(member.status !== "Archived", 409, "Archived profiles cannot receive new document requirements.");
    }
    const duplicate = requirements.find((requirement) =>
      requirement.id !== existing?.id &&
      requirement.active &&
      !requirement.effectiveTo &&
      requirement.documentVersionId === documentVersionId &&
      requirement.targetType === targetType &&
      normalize(requirement.targetRole) === normalize(targetRole) &&
      requirement.groupId === groupId &&
      requirement.memberProfileId === memberProfileId
    );
    assert(!duplicate, 409, "An active requirement for this document version and target already exists.");
    return {
      documentVersionId,
      targetType,
      targetRole,
      groupId,
      memberProfileId,
      acknowledgementRequired: asBoolean(body.acknowledgementRequired, existing?.acknowledgementRequired ?? true),
      effectiveFrom: parseOptionalDate(body.effectiveFrom ?? existing?.effectiveFrom, "Effective from") ?? new Date().toISOString(),
      dueAt: parseOptionalDate(body.dueAt ?? existing?.dueAt, "Due"),
      effectiveTo: parseOptionalDate(body.effectiveTo ?? existing?.effectiveTo, "Effective to")
    };
  }

  function requirementView(requirement: DocumentRequirementRecord) {
    const version = assertVersion(requirement.documentVersionId);
    const document = assertDocument(version.documentId);
    return {
      id: requirement.id,
      documentVersionId: requirement.documentVersionId,
      documentId: document.id,
      document: documentSummary(document),
      version: versionSummary(version),
      targetType: requirement.targetType,
      targetRole: requirement.targetRole ?? "",
      groupId: requirement.groupId ?? "",
      memberProfileId: requirement.memberProfileId ?? "",
      target: requirementTarget(requirement),
      targetLabel: requirementTarget(requirement).label,
      acknowledgementRequired: requirement.acknowledgementRequired,
      effectiveFrom: requirement.effectiveFrom ?? null,
      dueAt: requirement.dueAt ?? null,
      effectiveTo: requirement.effectiveTo ?? null,
      active: requirement.active,
      resolvedMemberCount: targetMemberIds(requirement).length,
      createdAt: requirement.createdAt,
      updatedAt: requirement.updatedAt,
      recordVersion: requirement.version
    };
  }

  function canSeeRequirement(requirement: DocumentRequirementRecord, actor: DirectoryActor, permission: string) {
    const scope = permissionScope(actor, permission);
    if (!scope.allowed) return false;
    if (scope.global) return true;
    if (requirement.targetType === "Group") return Boolean(requirement.groupId && scope.groupIds.has(requirement.groupId));
    if (requirement.targetType === "MemberProfile") {
      return Boolean(requirement.memberProfileId && canAccessMember(actor, permission, directory, requirement.memberProfileId));
    }
    return false;
  }

  function canSeeVersion(version: DocumentVersionRecord, actor: DirectoryActor) {
    if (canReadAll(actor)) return true;
    if (hasPermission(actor, "document:read-all")) {
      return requirements.some((requirement) => requirement.documentVersionId === version.id && canSeeRequirement(requirement, actor, "document:read-all"));
    }
    const member = linkedMember(actor);
    if (!member) return false;
    if (acknowledgementFor(version.id, member.id)) return true;
    return version.status === "Published" && activeRequirementsForMember(version.id, member, actor).length > 0;
  }

  function documentObligationsForMember(member: DirectoryMember, actor: DirectoryActor, evaluationAt = referenceNow) {
    const byVersion = new Map<string, DocumentRequirementRecord[]>();
    for (const requirement of requirements) {
      const version = findVersion(requirement.documentVersionId);
      if (!requirement.active || requirement.effectiveTo || !version || version.status !== "Published") continue;
      const document = findDocument(version.documentId);
      if (!document?.active) continue;
      if (!requirementAppliesToMember(requirement, member, actor)) continue;
      const rows = byVersion.get(version.id) ?? [];
      rows.push(requirement);
      byVersion.set(version.id, rows);
    }

    return Array.from(byVersion.entries()).map(([versionId, sourceRequirements]) => {
      const version = assertVersion(versionId);
      const document = assertDocument(version.documentId);
      const acknowledgement = acknowledgementFor(versionId, member.id);
      const dueAt = sourceRequirements
        .map((requirement) => requirement.dueAt)
        .filter((value): value is string => Boolean(value))
        .sort()[0] ?? null;
      const available = contentAvailable(version);
      const status = acknowledgement ? "Acknowledged" : isPastAt(dueAt, evaluationAt) ? "Overdue" : "Required";
      return {
        id: `${versionId}:${member.id}`,
        documentId: document.id,
        documentVersionId: version.id,
        code: document.code,
        title: version.titleOverride || document.title,
        description: document.description ?? "",
        category: document.category,
        ownerFunction: document.ownerFunction,
        versionLabel: version.versionLabel,
        contentMode: version.contentMode,
        contentAvailable: available,
        dueAt,
        status,
        acknowledgedAt: acknowledgement?.acknowledgedAt ?? null,
        acknowledgement: acknowledgement ? acknowledgementView(acknowledgement) : null,
        reasons: sourceRequirements.map((requirement) => ({
          id: requirement.id,
          targetType: requirement.targetType,
          label: requirementTarget(requirement).label
        })),
        sourceRequirementIds: sourceRequirements.map((requirement) => requirement.id),
        canAcknowledge: !acknowledgement && available && canAcknowledgeOwn(actor)
      };
    });
  }

  function personalDocuments(query: Query, actor: DirectoryActor) {
    assertDocumentRead(actor);
    const member = linkedMember(actor);
    if (!member) return page([], query, { linkedMemberProfile: null, totals: { required: 0, outstanding: 0, overdue: 0, acknowledged: 0 } });
    const rows = documentObligationsForMember(member, actor);
    const search = normalize(query.search ?? query.q);
    const filtered = search ? rows.filter((row) => [row.title, row.code, row.category, row.ownerFunction, row.status].some((value) => normalize(value).includes(search))) : rows;
    filtered.sort((left, right) => Number(left.status === "Acknowledged") - Number(right.status === "Acknowledged") || Number(right.status === "Overdue") - Number(left.status === "Overdue") || String(left.dueAt ?? "9999").localeCompare(String(right.dueAt ?? "9999")) || left.title.localeCompare(right.title));
    return page(filtered, query, {
      linkedMemberProfile: memberSummary(member),
      totals: {
        required: filtered.length,
        outstanding: filtered.filter((row) => row.status !== "Acknowledged").length,
        overdue: filtered.filter((row) => row.status === "Overdue").length,
        acknowledged: filtered.filter((row) => row.status === "Acknowledged").length
      }
    });
  }

  return {
    evaluateMemberCompliance(memberProfileId: string, actor: DirectoryActor, options?: { evaluationAt?: string }) {
      assertDocumentRead(actor);
      const member = directory.lookupMember(memberProfileId);
      const own = linkedMember(actor)?.id === member.id;
      assert(canAccessMember(actor, "document:read-all", directory, member.id) || (canReadOwn(actor) && own), 403, "You do not have access to this member's document requirements.");
      const evaluationAt = options?.evaluationAt ?? referenceNow;
      const obligations = documentObligationsForMember(member, actor, evaluationAt);
      const status =
        obligations.length === 0
          ? "Not applicable"
          : obligations.some((item) => item.status === "Overdue" || !item.contentAvailable)
            ? "Non-compliant"
            : obligations.some((item) => item.status !== "Acknowledged")
              ? "Attention"
              : "Compliant";

      return {
        memberProfileId: member.id,
        member: memberSummary(member),
        evaluationAt,
        status,
        totals: {
          required: obligations.length,
          outstanding: obligations.filter((item) => item.status !== "Acknowledged").length,
          overdue: obligations.filter((item) => item.status === "Overdue").length,
          acknowledged: obligations.filter((item) => item.status === "Acknowledged").length,
          unavailableContent: obligations.filter((item) => !item.contentAvailable).length
        },
        items: obligations
      };
    },

    listDocuments(query: Query, actor: DirectoryActor) {
      if (asBoolean(query.mine, false) || !hasPermission(actor, "document:read-all")) return personalDocuments(query, actor);
      assertDocumentRead(actor);
      let visible = [...documents];
      const active = query.active === undefined ? null : asBoolean(query.active, true);
      const search = normalize(query.search ?? query.q);
      if (active !== null) visible = visible.filter((document) => document.active === active);
      if (search) visible = visible.filter((document) => [document.code, document.title, document.description, document.category, document.ownerFunction].some((value) => normalize(value).includes(search)));
      visible.sort((left, right) => Number(right.active) - Number(left.active) || left.title.localeCompare(right.title));
      const mapped = visible.map((document) => documentView(document, actor));
      return page(mapped, query, {
        totals: {
          documents: mapped.length,
          published: mapped.filter((document) => document.currentVersion).length,
          activeRequirements: mapped.reduce((sum, document) => sum + document.activeRequirementCount, 0),
          outstanding: mapped.reduce((sum, document) => sum + document.outstandingCount, 0)
        }
      });
    },

    getDocument(id: string, actor: DirectoryActor) {
      assertDocumentRead(actor);
      const document = assertDocument(id);
      if (!canReadAll(actor)) {
        const version = currentPublishedVersion(id);
        assert(version && canSeeVersion(version, actor), 403, "You do not have access to this document.");
      }
      return documentView(document, actor);
    },

    createDocument(body: Query, actor: DirectoryActor) {
      assert(canManageDocuments(actor), 403, "You cannot manage documents.");
      const nowValue = new Date().toISOString();
      const document: DocumentRecord = {
        id: nextId("doc", documentCounter++),
        ...validateDocumentBody(body),
        active: true,
        version: 1,
        createdAt: nowValue,
        updatedAt: nowValue,
        createdById: actor.id,
        updatedById: actor.id
      };
      documents.push(document);
      return documentView(document);
    },

    updateDocument(id: string, body: Query, actor: DirectoryActor) {
      assert(canManageDocuments(actor), 403, "You cannot manage documents.");
      const document = assertDocument(id);
      assertExpectedUpdatedAt(body, document);
      Object.assign(document, validateDocumentBody(body, document));
      bump(document, actor);
      return documentView(document);
    },

    archiveDocument(id: string, body: Query, actor: DirectoryActor) {
      assert(canManageDocuments(actor), 403, "You cannot manage documents.");
      const document = assertDocument(id);
      assertExpectedUpdatedAt(body, document);
      assert(document.active, 409, "This document is already archived.");
      document.active = false;
      document.archivedAt = new Date().toISOString();
      bump(document, actor);
      return documentView(document);
    },

    reactivateDocument(id: string, body: Query, actor: DirectoryActor) {
      assert(canManageDocuments(actor), 403, "You cannot manage documents.");
      const document = assertDocument(id);
      assertExpectedUpdatedAt(body, document);
      assert(!document.active, 409, "This document is already active.");
      document.active = true;
      document.archivedAt = null;
      bump(document, actor);
      return documentView(document);
    },

    listVersions(documentId: string, query: Query, actor: DirectoryActor) {
      assertDocumentRead(actor);
      assertDocument(documentId);
      let visible = versions.filter((version) => version.documentId === documentId && canSeeVersion(version, actor));
      const status = asString(query.status);
      if (status) {
        assert(versionStatuses.has(status as DocumentVersionStatus), 400, "Version status is invalid.");
        visible = visible.filter((version) => version.status === status);
      }
      visible.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      return page(visible.map(versionView), query);
    },

    getVersion(id: string, actor: DirectoryActor) {
      assertDocumentRead(actor);
      const version = assertVersion(id);
      assert(canSeeVersion(version, actor), 403, "You do not have access to this document version.");
      return versionView(version);
    },

    createVersion(documentId: string, body: Query, actor: DirectoryActor) {
      assert(canManageVersions(actor), 403, "You cannot manage document versions.");
      const nowValue = new Date().toISOString();
      const version: DocumentVersionRecord = {
        id: nextId("dver", versionCounter++),
        ...validateVersionBody(documentId, body),
        status: "Draft",
        publishedAt: null,
        publishedById: null,
        version: 1,
        createdAt: nowValue,
        updatedAt: nowValue,
        createdById: actor.id,
        updatedById: actor.id
      };
      versions.push(version);
      return versionView(version);
    },

    updateVersion(id: string, body: Query, actor: DirectoryActor) {
      assert(canManageVersions(actor), 403, "You cannot manage document versions.");
      const version = assertVersion(id);
      assert(version.status === "Draft", 409, "Published or closed versions cannot be edited.");
      assert(!Object.keys(body).includes("status"), 400, "Use the dedicated action for this version status change.");
      assertExpectedUpdatedAt(body, version);
      Object.assign(version, validateVersionBody(version.documentId, body, version));
      bump(version, actor);
      return versionView(version);
    },

    publishVersion(id: string, body: Query, actor: DirectoryActor) {
      assert(canPublish(actor), 403, "You cannot publish document versions.");
      const version = assertVersion(id);
      assertExpectedUpdatedAt(body, version);
      assert(version.status === "Draft", 409, "Only draft versions can be published.");
      assert(contentAvailable(version), 409, "This version needs readable content or a valid link before publishing.");
      const document = assertDocument(version.documentId);
      assert(document.active, 409, "Archived documents cannot publish new versions.");
      const nowValue = new Date().toISOString();
      for (const existing of versions) {
        if (existing.documentId === version.documentId && existing.status === "Published") {
          existing.status = "Superseded";
          bump(existing, actor);
        }
      }
      version.status = "Published";
      version.publishedAt = nowValue;
      version.publishedById = actor.id;
      version.effectiveFrom = version.effectiveFrom ?? nowValue;
      bump(version, actor);
      return versionView(version);
    },

    withdrawVersion(id: string, body: Query, actor: DirectoryActor) {
      assert(canPublish(actor), 403, "You cannot withdraw document versions.");
      const version = assertVersion(id);
      assertExpectedUpdatedAt(body, version);
      assert(version.status === "Draft" || version.status === "Published", 409, "This version is already closed.");
      version.status = "Withdrawn";
      bump(version, actor);
      return versionView(version);
    },

    getVersionContent(id: string, actor: DirectoryActor) {
      assertDocumentRead(actor);
      const version = assertVersion(id);
      assert(canSeeVersion(version, actor), 403, "You do not have access to this document version.");
      assert(version.status === "Published" || canReadAll(actor), 403, "This version is not available for review.");
      assert(contentAvailable(version), 409, "This version has no readable content.");
      return {
        ...versionView(version),
        contentBody: version.contentMode === "Internal text" ? version.contentBody ?? "" : "",
        externalUrl: version.contentMode === "External link" ? version.externalUrl ?? "" : ""
      };
    },

    listRequirements(query: Query, actor: DirectoryActor) {
      assert(hasPermission(actor, "document:read-all") || canManageRequirements(actor), 403, "You do not have access to document requirements.");
      const permission = hasPermission(actor, "document:read-all") ? "document:read-all" : "document:requirement:manage";
      let visible = requirements.filter((requirement) => canSeeRequirement(requirement, actor, permission));
      const active = query.active === undefined ? null : asBoolean(query.active, true);
      const documentVersionId = asString(query.documentVersionId);
      const documentId = asString(query.documentId);
      const search = normalize(query.search ?? query.q);
      if (active !== null) visible = visible.filter((requirement) => requirement.active === active);
      if (documentVersionId) visible = visible.filter((requirement) => requirement.documentVersionId === documentVersionId);
      if (documentId) visible = visible.filter((requirement) => assertVersion(requirement.documentVersionId).documentId === documentId);
      if (search) visible = visible.filter((requirement) => {
        const version = assertVersion(requirement.documentVersionId);
        const document = assertDocument(version.documentId);
        return [document.title, document.code, requirementTarget(requirement).label, requirement.targetType].some((value) => normalize(value).includes(search));
      });
      visible.sort((left, right) => Number(right.active) - Number(left.active) || assertDocument(assertVersion(left.documentVersionId).documentId).title.localeCompare(assertDocument(assertVersion(right.documentVersionId).documentId).title));
      return page(visible.map(requirementView), query);
    },

    getRequirement(id: string, actor: DirectoryActor) {
      const requirement = assertRequirement(id);
      const permission = hasPermission(actor, "document:read-all") ? "document:read-all" : "document:requirement:manage";
      assert(canSeeRequirement(requirement, actor, permission), 403, "You do not have access to this document requirement.");
      return requirementView(requirement);
    },

    createRequirement(body: Query, actor: DirectoryActor) {
      assert(canManageRequirements(actor), 403, "You cannot manage document requirements.");
      const nowValue = new Date().toISOString();
      const requirement: DocumentRequirementRecord = {
        id: nextId("dreq", requirementCounter++),
        ...validateRequirementBody(body, undefined, actor),
        active: true,
        version: 1,
        createdAt: nowValue,
        updatedAt: nowValue,
        createdById: actor.id,
        updatedById: actor.id
      };
      requirements.push(requirement);
      return requirementView(requirement);
    },

    updateRequirement(id: string, body: Query, actor: DirectoryActor) {
      assert(canManageRequirements(actor), 403, "You cannot manage document requirements.");
      const requirement = assertRequirement(id);
      assert(canSeeRequirement(requirement, actor, "document:requirement:manage"), 403, "Forbidden");
      assertExpectedUpdatedAt(body, requirement);
      assert(requirement.active, 409, "Ended requirements cannot be edited.");
      Object.assign(requirement, validateRequirementBody(body, requirement, actor));
      bump(requirement, actor);
      return requirementView(requirement);
    },

    endRequirement(id: string, body: Query, actor: DirectoryActor) {
      assert(canManageRequirements(actor), 403, "You cannot manage document requirements.");
      const requirement = assertRequirement(id);
      assert(canSeeRequirement(requirement, actor, "document:requirement:manage"), 403, "Forbidden");
      assertExpectedUpdatedAt(body, requirement);
      assert(requirement.active, 409, "This requirement is already ended.");
      requirement.active = false;
      requirement.effectiveTo = parseOptionalDate(body.effectiveTo, "Effective to") ?? new Date().toISOString();
      bump(requirement, actor);
      return requirementView(requirement);
    },

    listAcknowledgements(query: Query, actor: DirectoryActor) {
      assert(canReadAll(actor) || canAcknowledgeAll(actor) || canAcknowledgeOwn(actor), 403, "You do not have access to document acknowledgements.");
      let visible = [...acknowledgements];
      if (!canReadAll(actor) && !canAcknowledgeAll(actor)) {
        const member = linkedMember(actor);
        visible = visible.filter((acknowledgement) => (
          acknowledgement.memberProfileId === member?.id ||
          canAccessMember(actor, "document:read-all", directory, acknowledgement.memberProfileId) ||
          canAccessMember(actor, "document:acknowledge-all", directory, acknowledgement.memberProfileId)
        ));
      }
      const memberProfileId = asString(query.memberProfileId);
      const documentVersionId = asString(query.documentVersionId);
      const documentId = asString(query.documentId);
      if (memberProfileId) visible = visible.filter((acknowledgement) => acknowledgement.memberProfileId === memberProfileId);
      if (documentVersionId) visible = visible.filter((acknowledgement) => acknowledgement.documentVersionId === documentVersionId);
      if (documentId) visible = visible.filter((acknowledgement) => assertVersion(acknowledgement.documentVersionId).documentId === documentId);
      visible.sort((left, right) => right.acknowledgedAt.localeCompare(left.acknowledgedAt));
      return page(visible.map(acknowledgementView), query);
    },

    acknowledgeVersion(id: string, body: Query, actor: DirectoryActor) {
      const version = assertVersion(id);
      assert(version.status === "Published", 409, "Only published versions can be acknowledged.");
      assert(contentAvailable(version), 409, "This version has no readable content.");
      const document = assertDocument(version.documentId);
      assert(document.active, 409, "Archived documents cannot receive new acknowledgements.");
      const ownMember = linkedMember(actor);
      const requestedMemberId = optionalString(body.memberProfileId);
      const memberProfileId = requestedMemberId ?? ownMember?.id ?? "";
      assert(memberProfileId, 409, "No linked member profile is available for this user.");
      const onBehalf = Boolean(requestedMemberId && requestedMemberId !== ownMember?.id);
      if (onBehalf) {
        assert(canAccessMember(actor, "document:acknowledge-all", directory, memberProfileId), 403, "You cannot record acknowledgements for this member.");
        assert(asBoolean(body.onBehalf, false), 400, "On-behalf acknowledgement must be explicit.");
      } else {
        assert(canAcknowledgeOwn(actor) || canAcknowledgeAll(actor), 403, "You cannot acknowledge documents.");
      }
      const member = directory.lookupMember(memberProfileId);
      assert(member.status !== "Archived", 409, "Archived profiles cannot acknowledge documents.");
      const applicableRequirements = activeRequirementsForMember(version.id, member, actor);
      assert(applicableRequirements.length > 0, 409, "This document is not currently required for this member.");
      const existing = acknowledgementFor(version.id, member.id);
      if (existing) return { ...acknowledgementView(existing), duplicate: true };
      const nowValue = new Date().toISOString();
      const acknowledgement: DocumentAcknowledgementRecord = {
        id: nextId("dack", acknowledgementCounter++),
        documentVersionId: version.id,
        memberProfileId: member.id,
        sourceRequirementIds: applicableRequirements.map((requirement) => requirement.id),
        acknowledgedAt: parseOptionalDate(body.acknowledgedAt, "Acknowledged at") ?? nowValue,
        acknowledgedById: actor.id,
        acknowledgementStatementVersion: "standard-v1",
        note: optionalString(body.note),
        onBehalf,
        createdAt: nowValue
      };
      acknowledgements.push(acknowledgement);
      return { ...acknowledgementView(acknowledgement), duplicate: false };
    }
  };
}

export type DocumentRepository = ReturnType<typeof createDocumentRepository>;
