import { DirectoryError } from "./member-directory.js";
import type { DirectoryActor, MemberDirectoryRepository } from "./member-directory.js";
import { canAccessGroup, canAccessMember, permissionScope } from "./scope-policy.js";

export type TrainingDeliveryType = "Classroom" | "E-learning" | "Briefing" | "Exercise" | "Practical" | "Other";
export type TrainingRequirementTargetType = "Role" | "Group" | "MemberProfile";
export type TrainingRequirementStatus = "Required" | "Recommended";
export type TrainingRecordStatus = "Assigned" | "In Progress" | "Completed" | "Expired" | "Waived" | "Cancelled";

type Query = Record<string, unknown>;
type DirectoryMember = ReturnType<MemberDirectoryRepository["lookupMember"]>;
type DirectoryGroup = ReturnType<MemberDirectoryRepository["lookupGroup"]>;

type TrainingCourseRecord = {
  id: string;
  code: string;
  normalizedCode: string;
  title: string;
  description?: string | null;
  category: string;
  deliveryType: TrainingDeliveryType;
  validityMonths?: number | null;
  active: boolean;
  selfCompletable: boolean;
  externalRef?: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdById?: string | null;
  updatedById?: string | null;
  deactivatedAt?: string | null;
  reactivatedAt?: string | null;
};

type TrainingRequirementRecord = {
  id: string;
  courseId: string;
  targetType: TrainingRequirementTargetType;
  targetRole?: string | null;
  groupId?: string | null;
  memberProfileId?: string | null;
  requiredStatus: TrainingRequirementStatus;
  dueAt?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  active: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdById?: string | null;
  updatedById?: string | null;
};

type MemberTrainingRecord = {
  id: string;
  operationalId: string;
  memberProfileId: string;
  courseId: string;
  sourceRequirementId?: string | null;
  assignedAt: string;
  dueAt?: string | null;
  status: TrainingRecordStatus;
  completedAt?: string | null;
  expiryAt?: string | null;
  score?: number | null;
  completionNote?: string | null;
  completionRef?: string | null;
  verifiedById?: string | null;
  verifiedAt?: string | null;
  waiverReason?: string | null;
  cancelledReason?: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdById?: string | null;
  updatedById?: string | null;
};

const initialTimestamp = "2026-07-09T09:00:00.000Z";
const referenceNow = "2026-07-13T09:00:00.000Z";
const expiringSoonDefaultDays = 45;
const deliveryTypes = new Set<TrainingDeliveryType>(["Classroom", "E-learning", "Briefing", "Exercise", "Practical", "Other"]);
const requirementTargetTypes = new Set<TrainingRequirementTargetType>(["Role", "Group", "MemberProfile"]);
const requirementStatuses = new Set<TrainingRequirementStatus>(["Required", "Recommended"]);
const recordStatuses = new Set<TrainingRecordStatus>(["Assigned", "In Progress", "Completed", "Expired", "Waived", "Cancelled"]);
const activeRecordStatuses = new Set<TrainingRecordStatus>(["Assigned", "In Progress"]);
const terminalRecordStatuses = new Set<TrainingRecordStatus>(["Completed", "Expired", "Waived", "Cancelled"]);
const controlledRecordFields = new Set([
  "status",
  "completedAt",
  "expiryAt",
  "score",
  "completionRef",
  "verifiedById",
  "verifiedAt",
  "waiverReason",
  "cancelledReason"
]);

function asString(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function optionalString(value: unknown) {
  const next = asString(value);
  return next ? next : null;
}

function asNumber(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
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

function normalize(value: unknown) {
  return asString(value).toLowerCase();
}

function normalizeCode(value: unknown) {
  return asString(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function hasPermission(actor: DirectoryActor, permission: string) {
  return actor.permissions.includes(permission);
}

function canReadOwn(actor: DirectoryActor) {
  return hasPermission(actor, "training:read-own");
}

function canReadAll(actor: DirectoryActor) {
  return permissionScope(actor, "training:read-all").global;
}

function canManageCourses(actor: DirectoryActor) {
  return hasPermission(actor, "training:course:manage");
}

function canManageRequirements(actor: DirectoryActor) {
  return hasPermission(actor, "training:requirement:manage");
}

function canAssign(actor: DirectoryActor) {
  return hasPermission(actor, "training:assign");
}

function canCompleteAll(actor: DirectoryActor) {
  return hasPermission(actor, "training:complete-all");
}

function canCompleteOwn(actor: DirectoryActor) {
  return hasPermission(actor, "training:complete-own");
}

function canVerify(actor: DirectoryActor) {
  return hasPermission(actor, "training:verify");
}

function canWaive(actor: DirectoryActor) {
  return hasPermission(actor, "training:waive");
}

function assert(condition: unknown, status: number, message: string): asserts condition {
  if (!condition) throw new DirectoryError(status, message);
}

function assertTrainingRead(actor: DirectoryActor) {
  assert(hasPermission(actor, "training:read-all") || canReadOwn(actor), 403, "You do not have access to training records.");
}

function assertExpectedUpdatedAt(body: Query, record: { updatedAt: string }) {
  const expectedUpdatedAt = optionalString(body.expectedUpdatedAt);
  assert(!expectedUpdatedAt || expectedUpdatedAt === record.updatedAt, 409, "This item changed. Reload and try again.");
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

function pageQuery(query: Query) {
  const limit = Math.min(Math.max(Math.trunc(asNumber(query.limit, 50)), 1), 200);
  const offset = Math.max(Math.trunc(asNumber(query.offset, 0)), 0);
  return { limit, offset };
}

function page<T>(data: T[], query: Query, extra?: Record<string, unknown>) {
  const { limit, offset } = pageQuery(query);
  return { total: data.length, limit, offset, data: data.slice(offset, offset + limit), ...(extra ?? {}) };
}

function addMonths(isoDate: string, months: number) {
  const date = new Date(isoDate);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString();
}

function daysFromNow(days: number) {
  const date = new Date(referenceNow);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function isBefore(left?: string | null, right = referenceNow) {
  return Boolean(left && new Date(left).getTime() < new Date(right).getTime());
}

function isWithin(left: string | null | undefined, days: number) {
  if (!left) return false;
  const time = new Date(left).getTime();
  const start = new Date(referenceNow).getTime();
  const end = new Date(daysFromNow(days)).getTime();
  return time >= start && time <= end;
}

function bump<T extends { version: number; updatedAt: string; updatedById?: string | null }>(record: T, actor: DirectoryActor) {
  const previousTime = new Date(record.updatedAt).getTime();
  const nextDate = new Date();
  if (Number.isFinite(previousTime) && nextDate.getTime() <= previousTime) nextDate.setTime(previousTime + 1);
  record.version += 1;
  record.updatedAt = nextDate.toISOString();
  record.updatedById = actor.id;
}

function nextId(prefix: string, count: number) {
  return `${prefix}-2026-${String(count).padStart(6, "0")}`;
}

function memberSummary(member: DirectoryMember) {
  return {
    id: member.id,
    memberId: member.memberId,
    volunteerId: member.memberId,
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

function normalizeStatus(value: unknown, fallback: TrainingRecordStatus) {
  const status = asString(value, fallback) as TrainingRecordStatus;
  assert(recordStatuses.has(status), 400, "Training status is invalid.");
  return status;
}

function normalizeDeliveryType(value: unknown, fallback: TrainingDeliveryType = "Briefing") {
  const deliveryType = asString(value, fallback) as TrainingDeliveryType;
  assert(deliveryTypes.has(deliveryType), 400, "Delivery type is invalid.");
  return deliveryType;
}

function normalizeRequirementStatus(value: unknown, fallback: TrainingRequirementStatus = "Required") {
  const status = asString(value, fallback) as TrainingRequirementStatus;
  assert(requirementStatuses.has(status), 400, "Requirement status is invalid.");
  return status;
}

export function createTrainingRepository(directory: MemberDirectoryRepository) {
  let courseCounter = 7;
  let requirementCounter = 5;
  let recordCounter = 7;

  const courses: TrainingCourseRecord[] = [
    {
      id: "crs-2026-000001",
      code: "ERP-FAM",
      normalizedCode: "ERP-FAM",
      title: "ERP Familiarization",
      description: "Core briefing for working inside the active response structure.",
      category: "Core",
      deliveryType: "Briefing",
      validityMonths: 24,
      active: true,
      selfCompletable: true,
      externalRef: null,
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000001",
      updatedById: "00000000-0000-4000-8000-000000000001"
    },
    {
      id: "crs-2026-000002",
      code: "FAC-BASICS",
      normalizedCode: "FAC-BASICS",
      title: "Family Assistance Basics",
      description: "Practical expectations for family support work and handover.",
      category: "Family Assistance",
      deliveryType: "Classroom",
      validityMonths: 12,
      active: true,
      selfCompletable: false,
      externalRef: null,
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000001",
      updatedById: "00000000-0000-4000-8000-000000000001"
    },
    {
      id: "crs-2026-000003",
      code: "PFA-AWARE",
      normalizedCode: "PFA-AWARE",
      title: "Psychological First Aid Awareness",
      description: "Recognition, boundaries and escalation for welfare support.",
      category: "Welfare",
      deliveryType: "E-learning",
      validityMonths: 12,
      active: true,
      selfCompletable: true,
      externalRef: null,
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000001",
      updatedById: "00000000-0000-4000-8000-000000000001"
    },
    {
      id: "crs-2026-000004",
      code: "TEC-PROC",
      normalizedCode: "TEC-PROC",
      title: "Telephone Enquiry Center Procedures",
      description: "Call handling, status boundaries and escalation practice for TEC work.",
      category: "TEC",
      deliveryType: "Practical",
      validityMonths: 6,
      active: true,
      selfCompletable: true,
      externalRef: null,
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000001",
      updatedById: "00000000-0000-4000-8000-000000000001"
    },
    {
      id: "crs-2026-000005",
      code: "DATA-CRISIS",
      normalizedCode: "DATA-CRISIS",
      title: "Data Protection for Crisis Response",
      description: "Sensitive information handling for crisis response records.",
      category: "Data Protection",
      deliveryType: "E-learning",
      validityMonths: 12,
      active: true,
      selfCompletable: true,
      externalRef: null,
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000001",
      updatedById: "00000000-0000-4000-8000-000000000001"
    },
    {
      id: "crs-2026-000006",
      code: "ROLE-CARD",
      normalizedCode: "ROLE-CARD",
      title: "Role Card Briefing",
      description: "Historical role-card briefing retained for previous completion records.",
      category: "Coordination",
      deliveryType: "Briefing",
      validityMonths: 12,
      active: false,
      selfCompletable: false,
      externalRef: null,
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      deactivatedAt: "2026-07-10T12:00:00.000Z",
      createdById: "00000000-0000-4000-8000-000000000001",
      updatedById: "00000000-0000-4000-8000-000000000001"
    }
  ];

  const requirements: TrainingRequirementRecord[] = [
    {
      id: "trq-2026-000001",
      courseId: "crs-2026-000005",
      targetType: "Role",
      targetRole: "ZPP Member",
      requiredStatus: "Required",
      dueAt: "2026-07-25T12:00:00.000Z",
      effectiveFrom: "2026-07-09T00:00:00.000Z",
      effectiveTo: null,
      active: true,
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000001",
      updatedById: "00000000-0000-4000-8000-000000000001"
    },
    {
      id: "trq-2026-000002",
      courseId: "crs-2026-000002",
      targetType: "Group",
      groupId: "grp-2026-000001",
      requiredStatus: "Required",
      dueAt: "2026-07-20T12:00:00.000Z",
      effectiveFrom: "2026-07-09T00:00:00.000Z",
      effectiveTo: null,
      active: true,
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000001",
      updatedById: "00000000-0000-4000-8000-000000000001"
    },
    {
      id: "trq-2026-000003",
      courseId: "crs-2026-000004",
      targetType: "MemberProfile",
      memberProfileId: "mem-2026-000002",
      requiredStatus: "Required",
      dueAt: "2026-07-08T12:00:00.000Z",
      effectiveFrom: "2026-07-09T00:00:00.000Z",
      effectiveTo: null,
      active: true,
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000001",
      updatedById: "00000000-0000-4000-8000-000000000001"
    },
    {
      id: "trq-2026-000004",
      courseId: "crs-2026-000001",
      targetType: "Role",
      targetRole: "ZPP Member",
      requiredStatus: "Recommended",
      dueAt: "2026-08-01T12:00:00.000Z",
      effectiveFrom: "2026-07-09T00:00:00.000Z",
      effectiveTo: null,
      active: true,
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000001",
      updatedById: "00000000-0000-4000-8000-000000000001"
    }
  ];

  const records: MemberTrainingRecord[] = [
    {
      id: "trn-2026-000001",
      operationalId: "TRN-2026-000001",
      memberProfileId: "mem-2026-000008",
      courseId: "crs-2026-000005",
      sourceRequirementId: "trq-2026-000001",
      assignedAt: "2026-07-10T08:00:00.000Z",
      dueAt: "2026-07-20T12:00:00.000Z",
      status: "Assigned",
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000004",
      updatedById: "00000000-0000-4000-8000-000000000004"
    },
    {
      id: "trn-2026-000002",
      operationalId: "TRN-2026-000002",
      memberProfileId: "mem-2026-000008",
      courseId: "crs-2026-000001",
      sourceRequirementId: null,
      assignedAt: "2026-06-15T08:00:00.000Z",
      dueAt: "2026-08-01T12:00:00.000Z",
      status: "Completed",
      completedAt: "2026-07-01T10:00:00.000Z",
      expiryAt: "2028-07-01T10:00:00.000Z",
      completionNote: "Completed during response familiarization.",
      verifiedById: "00000000-0000-4000-8000-000000000004",
      verifiedAt: "2026-07-01T11:00:00.000Z",
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000004",
      updatedById: "00000000-0000-4000-8000-000000000004"
    },
    {
      id: "trn-2026-000003",
      operationalId: "TRN-2026-000003",
      memberProfileId: "mem-2026-000003",
      courseId: "crs-2026-000002",
      sourceRequirementId: "trq-2026-000002",
      assignedAt: "2026-07-09T08:00:00.000Z",
      dueAt: "2026-07-20T12:00:00.000Z",
      status: "In Progress",
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000004",
      updatedById: "00000000-0000-4000-8000-000000000004"
    },
    {
      id: "trn-2026-000004",
      operationalId: "TRN-2026-000004",
      memberProfileId: "mem-2026-000002",
      courseId: "crs-2026-000004",
      sourceRequirementId: "trq-2026-000003",
      assignedAt: "2026-07-05T08:00:00.000Z",
      dueAt: "2026-07-08T12:00:00.000Z",
      status: "Assigned",
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000004",
      updatedById: "00000000-0000-4000-8000-000000000004"
    },
    {
      id: "trn-2026-000005",
      operationalId: "TRN-2026-000005",
      memberProfileId: "mem-2026-000001",
      courseId: "crs-2026-000005",
      sourceRequirementId: "trq-2026-000001",
      assignedAt: "2025-07-01T08:00:00.000Z",
      dueAt: "2025-08-01T12:00:00.000Z",
      status: "Completed",
      completedAt: "2025-08-01T09:00:00.000Z",
      expiryAt: "2026-08-01T09:00:00.000Z",
      completionNote: "Annual refresher completed.",
      verifiedById: "00000000-0000-4000-8000-000000000002",
      verifiedAt: "2025-08-01T10:00:00.000Z",
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000002",
      updatedById: "00000000-0000-4000-8000-000000000002"
    },
    {
      id: "trn-2026-000006",
      operationalId: "TRN-2026-000006",
      memberProfileId: "mem-2026-000005",
      courseId: "crs-2026-000003",
      sourceRequirementId: null,
      assignedAt: "2025-05-01T08:00:00.000Z",
      dueAt: "2025-06-01T12:00:00.000Z",
      status: "Completed",
      completedAt: "2025-06-01T09:00:00.000Z",
      expiryAt: "2026-06-01T09:00:00.000Z",
      completionNote: "Previous welfare support course.",
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000002",
      updatedById: "00000000-0000-4000-8000-000000000002"
    }
  ];

  function nextCourseId() {
    return nextId("crs", courseCounter++);
  }

  function nextRequirementId() {
    return nextId("trq", requirementCounter++);
  }

  function nextRecordId() {
    const next = recordCounter++;
    return { id: nextId("trn", next), operationalId: nextId("TRN", next) };
  }

  function findCourse(id: string) {
    return courses.find((course) => course.id === id);
  }

  function assertCourse(id: string) {
    const course = findCourse(id);
    assert(course, 404, "Training course not found.");
    return course;
  }

  function findRequirement(id: string) {
    return requirements.find((requirement) => requirement.id === id);
  }

  function assertRequirement(id: string) {
    const requirement = findRequirement(id);
    assert(requirement, 404, "Training requirement not found.");
    return requirement;
  }

  function findRecord(id: string) {
    return records.find((record) => record.id === id);
  }

  function assertRecord(id: string) {
    const record = findRecord(id);
    assert(record, 404, "Training record not found.");
    return record;
  }

  function linkedMember(actor: DirectoryActor) {
    return directory.resolveMemberForUser(actor.id);
  }

  function canAccessTrainingMember(actor: DirectoryActor, permission: string, memberProfileId: string) {
    return canAccessMember(actor, permission, directory, memberProfileId);
  }

  function canSeeRequirement(requirement: TrainingRequirementRecord, actor: DirectoryActor, permission: string) {
    const scope = permissionScope(actor, permission);
    if (!scope.allowed) return false;
    if (scope.global) return true;
    if (requirement.targetType === "Group") return Boolean(requirement.groupId && scope.groupIds.has(requirement.groupId));
    if (requirement.targetType === "MemberProfile") {
      return Boolean(requirement.memberProfileId && canAccessTrainingMember(actor, permission, requirement.memberProfileId));
    }
    return false;
  }

  function courseView(course: TrainingCourseRecord) {
    return {
      id: course.id,
      code: course.code,
      title: course.title,
      description: course.description ?? "",
      category: course.category,
      deliveryType: course.deliveryType,
      validityMonths: course.validityMonths ?? null,
      active: course.active,
      selfCompletable: course.selfCompletable,
      externalRef: course.externalRef ?? null,
      createdAt: course.createdAt,
      updatedAt: course.updatedAt,
      version: course.version
    };
  }

  function requirementTarget(requirement: TrainingRequirementRecord) {
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

  function targetMemberIds(requirement: TrainingRequirementRecord) {
    if (requirement.targetType === "Role") {
      return directory.listMembers({ limit: 200 }).data
        .map((member) => directory.lookupMember(member.id))
        .filter((member) => member.status !== "Archived" && roleMatchesMember(requirement.targetRole ?? "", member))
        .map((member) => member.id);
    }
    if (requirement.targetType === "Group") {
      return directory.lookupGroup(requirement.groupId ?? "").memberIds;
    }
    return requirement.memberProfileId ? [requirement.memberProfileId] : [];
  }

  function requirementView(requirement: TrainingRequirementRecord) {
    const course = assertCourse(requirement.courseId);
    return {
      id: requirement.id,
      courseId: requirement.courseId,
      course: courseView(course),
      targetType: requirement.targetType,
      targetRole: requirement.targetRole ?? "",
      groupId: requirement.groupId ?? "",
      memberProfileId: requirement.memberProfileId ?? "",
      target: requirementTarget(requirement),
      requiredStatus: requirement.requiredStatus,
      dueAt: requirement.dueAt ?? null,
      effectiveFrom: requirement.effectiveFrom ?? null,
      effectiveTo: requirement.effectiveTo ?? null,
      active: requirement.active,
      resolvedMemberCount: targetMemberIds(requirement).length,
      createdAt: requirement.createdAt,
      updatedAt: requirement.updatedAt,
      version: requirement.version
    };
  }

  function effectiveStatus(record: MemberTrainingRecord): TrainingRecordStatus {
    if (record.status === "Completed" && isBefore(record.expiryAt)) return "Expired";
    return record.status;
  }

  function isOverdue(record: MemberTrainingRecord) {
    return activeRecordStatuses.has(record.status) && isBefore(record.dueAt);
  }

  function isExpiringSoon(record: MemberTrainingRecord, days = expiringSoonDefaultDays) {
    return effectiveStatus(record) === "Completed" && isWithin(record.expiryAt, days);
  }

  function sourceRequirementSummary(record: MemberTrainingRecord) {
    if (!record.sourceRequirementId) return null;
    const requirement = findRequirement(record.sourceRequirementId);
    if (!requirement) return null;
    return {
      id: requirement.id,
      targetType: requirement.targetType,
      targetLabel: requirementTarget(requirement).label,
      requiredStatus: requirement.requiredStatus
    };
  }

  function recordPermissions(record: MemberTrainingRecord, actor: DirectoryActor) {
    const own = linkedMember(actor)?.id === record.memberProfileId;
    const course = assertCourse(record.courseId);
    const activeState = activeRecordStatuses.has(record.status);
    return {
      canStart: record.status === "Assigned" && (canAccessTrainingMember(actor, "training:complete-all", record.memberProfileId) || (own && canCompleteOwn(actor))),
      canComplete: activeState && (canAccessTrainingMember(actor, "training:complete-all", record.memberProfileId) || (own && canCompleteOwn(actor) && course.selfCompletable)),
      canVerify: record.status === "Completed" && canAccessTrainingMember(actor, "training:verify", record.memberProfileId),
      canWaive: activeState && canAccessTrainingMember(actor, "training:waive", record.memberProfileId),
      canCancel: activeState && canAccessTrainingMember(actor, "training:assign", record.memberProfileId),
      canEdit: activeState && canAccessTrainingMember(actor, "training:assign", record.memberProfileId)
    };
  }

  function recordView(record: MemberTrainingRecord, actor: DirectoryActor) {
    const course = assertCourse(record.courseId);
    const member = directory.lookupMember(record.memberProfileId);
    const status = effectiveStatus(record);
    return {
      id: record.id,
      operationalId: record.operationalId,
      memberProfileId: record.memberProfileId,
      member: memberSummary(member),
      courseId: record.courseId,
      course: courseView(course),
      sourceRequirementId: record.sourceRequirementId ?? null,
      sourceRequirement: sourceRequirementSummary(record),
      assignedAt: record.assignedAt,
      dueAt: record.dueAt ?? null,
      status,
      baseStatus: record.status,
      isOverdue: isOverdue(record),
      isExpiringSoon: isExpiringSoon(record),
      completedAt: record.completedAt ?? null,
      expiryAt: record.expiryAt ?? null,
      score: record.score ?? null,
      completionNote: record.completionNote ?? "",
      completionRef: record.completionRef ?? "",
      verifiedById: record.verifiedById ?? null,
      verifiedAt: record.verifiedAt ?? null,
      waiverReason: record.waiverReason ?? "",
      cancelledReason: record.cancelledReason ?? "",
      permissions: recordPermissions(record, actor),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      version: record.version
    };
  }

  function canSeeRecord(record: MemberTrainingRecord, actor: DirectoryActor) {
    if (canAccessTrainingMember(actor, "training:read-all", record.memberProfileId)) return true;
    if (!canReadOwn(actor)) return false;
    return linkedMember(actor)?.id === record.memberProfileId;
  }

  function assertCanSeeRecord(record: MemberTrainingRecord, actor: DirectoryActor) {
    assertTrainingRead(actor);
    assert(canSeeRecord(record, actor), 403, "You do not have access to this training record.");
  }

  function validateCourseBody(body: Query, existing?: TrainingCourseRecord) {
    const code = asString(body.code, existing?.code ?? "");
    const normalizedCode = normalizeCode(code);
    assert(normalizedCode, 400, "Course code is required.");
    const duplicate = courses.find((course) => course.id !== existing?.id && course.normalizedCode === normalizedCode);
    assert(!duplicate, 409, "A training course with this code already exists.");
    const title = asString(body.title, existing?.title ?? "");
    assert(title, 400, "Course title is required.");
    const validityMonthsRaw = body.validityMonths ?? existing?.validityMonths ?? null;
    const validityMonths = validityMonthsRaw === null || validityMonthsRaw === "" ? null : Math.max(0, Math.trunc(asNumber(validityMonthsRaw, 0)));
    return {
      code,
      normalizedCode,
      title,
      description: optionalString(body.description ?? existing?.description),
      category: asString(body.category, existing?.category ?? "Core"),
      deliveryType: normalizeDeliveryType(body.deliveryType, existing?.deliveryType ?? "Briefing"),
      validityMonths,
      selfCompletable: asBoolean(body.selfCompletable, existing?.selfCompletable ?? true),
      externalRef: optionalString(body.externalRef ?? existing?.externalRef)
    };
  }

  function validateRequirementBody(body: Query, existing: TrainingRequirementRecord | undefined, actor: DirectoryActor) {
    const courseId = asString(body.courseId, existing?.courseId ?? "");
    const course = assertCourse(courseId);
    assert(course.active, 409, "Inactive courses cannot receive new requirements.");
    const targetType = asString(body.targetType, existing?.targetType ?? "") as TrainingRequirementTargetType;
    assert(requirementTargetTypes.has(targetType), 400, "Requirement target is invalid.");
    const targetRole = targetType === "Role" ? optionalString(body.targetRole ?? existing?.targetRole) : null;
    const groupId = targetType === "Group" ? optionalString(body.groupId ?? existing?.groupId) : null;
    const memberProfileId = targetType === "MemberProfile" ? optionalString(body.memberProfileId ?? existing?.memberProfileId) : null;
    const targetCount = [targetRole, groupId, memberProfileId].filter(Boolean).length;
    assert(targetCount === 1, 400, "Choose exactly one requirement target.");
    if (groupId) {
      assert(canAccessGroup(actor, "training:requirement:manage", groupId), 403, "Forbidden");
      const group = directory.lookupGroup(groupId);
      assert(group.status !== "Archived", 409, "Archived groups cannot receive new training requirements.");
    }
    if (memberProfileId) {
      assert(canAccessTrainingMember(actor, "training:requirement:manage", memberProfileId), 403, "Forbidden");
      const member = directory.lookupMember(memberProfileId);
      assert(member.status !== "Archived", 409, "Archived profiles cannot receive new training requirements.");
    }
    if (targetRole) assert(permissionScope(actor, "training:requirement:manage").global, 403, "Role-wide requirements require global access.");
    const duplicate = requirements.find(
      (requirement) =>
        requirement.id !== existing?.id &&
        requirement.active &&
        requirement.courseId === courseId &&
        requirement.targetType === targetType &&
        (requirement.targetRole ?? null) === targetRole &&
        (requirement.groupId ?? null) === groupId &&
        (requirement.memberProfileId ?? null) === memberProfileId
    );
    assert(!duplicate, 409, "An active requirement already exists for this target and course.");
    return {
      courseId,
      targetType,
      targetRole,
      groupId,
      memberProfileId,
      requiredStatus: normalizeRequirementStatus(body.requiredStatus, existing?.requiredStatus ?? "Required"),
      dueAt: parseOptionalDate(body.dueAt ?? existing?.dueAt, "Due date"),
      effectiveFrom: parseOptionalDate(body.effectiveFrom ?? existing?.effectiveFrom ?? referenceNow, "Effective from"),
      effectiveTo: parseOptionalDate(body.effectiveTo ?? existing?.effectiveTo, "Effective to")
    };
  }

  function assertRecordActionAllowed(record: MemberTrainingRecord, actor: DirectoryActor, action: "start" | "complete" | "verify" | "waive" | "cancel") {
    assertCanSeeRecord(record, actor);
    const own = linkedMember(actor)?.id === record.memberProfileId;
    if (action === "start") {
      assert(record.status === "Assigned", 409, "Only assigned training can be started.");
      assert(canAccessTrainingMember(actor, "training:complete-all", record.memberProfileId) || (own && canCompleteOwn(actor)), 403, "You cannot start this training record.");
      return;
    }
    if (action === "complete") {
      assert(activeRecordStatuses.has(record.status), 409, "Only active training can be completed.");
      const course = assertCourse(record.courseId);
      assert(canAccessTrainingMember(actor, "training:complete-all", record.memberProfileId) || (own && canCompleteOwn(actor) && course.selfCompletable), 403, "You cannot complete this training record.");
      return;
    }
    if (action === "verify") {
      assert(record.status === "Completed", 409, "Only completed training can be verified.");
      assert(canAccessTrainingMember(actor, "training:verify", record.memberProfileId), 403, "You cannot verify training records.");
      return;
    }
    if (action === "waive") {
      assert(activeRecordStatuses.has(record.status), 409, "Only active training can be waived.");
      assert(canAccessTrainingMember(actor, "training:waive", record.memberProfileId), 403, "You cannot waive training records.");
      return;
    }
    assert(activeRecordStatuses.has(record.status), 409, "Only active training can be cancelled.");
    assert(canAccessTrainingMember(actor, "training:assign", record.memberProfileId), 403, "You cannot cancel training records.");
  }

  function filterRecords(query: Query, actor: DirectoryActor) {
    assertTrainingRead(actor);
    const mine = asBoolean(query.mine, false);
    const ownMember = linkedMember(actor);
    let visible = records.filter((record) => canSeeRecord(record, actor));
    if (mine) visible = ownMember ? visible.filter((record) => record.memberProfileId === ownMember.id) : [];

    const memberProfileId = asString(query.memberProfileId);
    const groupId = asString(query.groupId);
    const courseId = asString(query.courseId);
    const category = asString(query.category);
    const status = asString(query.status);
    const search = normalize(query.search ?? query.q);
    const overdue = asBoolean(query.overdue, false);
    const expiringWithin = Math.max(0, Math.trunc(asNumber(query.expiringWithin, 0)));
    const activeCourse = query.activeCourse === undefined ? null : asBoolean(query.activeCourse, true);

    if (memberProfileId) visible = visible.filter((record) => record.memberProfileId === memberProfileId);
    if (groupId) {
      assert(canAccessGroup(actor, "training:read-all", groupId), 403, "Forbidden");
      const groupMemberIds = new Set(directory.lookupGroup(groupId).memberIds);
      visible = visible.filter((record) => groupMemberIds.has(record.memberProfileId));
    }
    if (courseId) visible = visible.filter((record) => record.courseId === courseId);
    if (category && category !== "All categories") visible = visible.filter((record) => normalize(assertCourse(record.courseId).category) === normalize(category));
    if (status && status !== "All statuses") visible = visible.filter((record) => effectiveStatus(record) === status);
    if (overdue) visible = visible.filter(isOverdue);
    if (expiringWithin) visible = visible.filter((record) => isExpiringSoon(record, expiringWithin));
    if (activeCourse !== null) visible = visible.filter((record) => assertCourse(record.courseId).active === activeCourse);
    if (search) {
      visible = visible.filter((record) => {
        const member = directory.lookupMember(record.memberProfileId);
        const course = assertCourse(record.courseId);
        return [record.operationalId, member.memberId, member.displayName, course.code, course.title, course.category].some((value) => normalize(value).includes(search));
      });
    }
    return visible;
  }

  function sortRecords(data: MemberTrainingRecord[], query: Query) {
    const sort = asString(query.sort, "due");
    const direction = asString(query.direction, "asc") === "desc" ? -1 : 1;
    return [...data].sort((left, right) => {
      if (sort === "member") return direction * directory.lookupMember(left.memberProfileId).displayName.localeCompare(directory.lookupMember(right.memberProfileId).displayName);
      if (sort === "course") return direction * assertCourse(left.courseId).title.localeCompare(assertCourse(right.courseId).title);
      if (sort === "status") return direction * effectiveStatus(left).localeCompare(effectiveStatus(right));
      const leftDue = left.dueAt ? new Date(left.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
      const rightDue = right.dueAt ? new Date(right.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
      return direction * (leftDue - rightDue || left.operationalId.localeCompare(right.operationalId));
    });
  }

  function effectiveStatusAt(record: MemberTrainingRecord, evaluationAt = referenceNow): TrainingRecordStatus {
    if (record.status === "Completed" && isBefore(record.expiryAt, evaluationAt)) return "Expired";
    return record.status;
  }

  function isOverdueAt(record: MemberTrainingRecord, evaluationAt = referenceNow) {
    return activeRecordStatuses.has(record.status) && isBefore(record.dueAt, evaluationAt);
  }

  function isExpiringSoonAt(record: MemberTrainingRecord, days = expiringSoonDefaultDays, evaluationAt = referenceNow) {
    if (effectiveStatusAt(record, evaluationAt) !== "Completed" || !record.expiryAt) return false;
    const expiryTime = new Date(record.expiryAt).getTime();
    const start = new Date(evaluationAt).getTime();
    const end = new Date(evaluationAt);
    end.setUTCDate(end.getUTCDate() + days);
    return expiryTime >= start && expiryTime <= end.getTime();
  }

  function trainingRecordRank(record: MemberTrainingRecord, evaluationAt: string) {
    const status = effectiveStatusAt(record, evaluationAt);
    if (status === "Completed" || status === "Waived") return 0;
    if (activeRecordStatuses.has(record.status) && !isOverdueAt(record, evaluationAt)) return 1;
    if (activeRecordStatuses.has(record.status)) return 2;
    if (status === "Expired") return 3;
    return 4;
  }

  function earliestRequirementDue(requirementRows: TrainingRequirementRecord[]) {
    return requirementRows
      .map((requirement) => requirement.dueAt)
      .filter((value): value is string => Boolean(value))
      .sort()[0] ?? null;
  }

  function activeRequirementsForMember(member: DirectoryMember) {
    return requirements.filter((requirement) => requirement.active && !requirement.effectiveTo && targetMemberIds(requirement).includes(member.id));
  }

  function bestTrainingRecordFor(memberProfileId: string, courseId: string, evaluationAt: string) {
    return records
      .filter((record) => record.memberProfileId === memberProfileId && record.courseId === courseId && record.status !== "Cancelled")
      .sort((left, right) => {
        const rank = trainingRecordRank(left, evaluationAt) - trainingRecordRank(right, evaluationAt);
        if (rank !== 0) return rank;
        return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
      })[0] ?? null;
  }

  function trainingComplianceRecordView(record: MemberTrainingRecord, actor: DirectoryActor, evaluationAt: string, expiringSoonDays: number) {
    const view = recordView(record, actor);
    return {
      id: view.id,
      operationalId: view.operationalId,
      memberProfileId: view.memberProfileId,
      courseId: view.courseId,
      course: view.course,
      sourceRequirementId: view.sourceRequirementId,
      assignedAt: view.assignedAt,
      dueAt: view.dueAt,
      status: effectiveStatusAt(record, evaluationAt),
      baseStatus: record.status,
      isOverdue: isOverdueAt(record, evaluationAt),
      isExpiringSoon: isExpiringSoonAt(record, expiringSoonDays, evaluationAt),
      completedAt: view.completedAt,
      expiryAt: view.expiryAt,
      verifiedAt: view.verifiedAt,
      updatedAt: view.updatedAt
    };
  }

  return {
    evaluateMemberCompliance(memberProfileId: string, actor: DirectoryActor, options?: { evaluationAt?: string; expiringSoonDays?: number }) {
      assertTrainingRead(actor);
      const member = directory.lookupMember(memberProfileId);
      const own = linkedMember(actor)?.id === member.id;
      assert(canAccessTrainingMember(actor, "training:read-all", member.id) || (canReadOwn(actor) && own), 403, "You do not have access to this member's training records.");
      const evaluationAt = options?.evaluationAt ?? referenceNow;
      const expiringSoonDays = Math.max(1, Math.trunc(options?.expiringSoonDays ?? expiringSoonDefaultDays));
      const groupedRequirements = new Map<string, TrainingRequirementRecord[]>();

      for (const requirement of activeRequirementsForMember(member)) {
        const rows = groupedRequirements.get(requirement.courseId) ?? [];
        rows.push(requirement);
        groupedRequirements.set(requirement.courseId, rows);
      }

      const items = Array.from(groupedRequirements.entries()).map(([courseId, requirementRows]) => {
        const course = assertCourse(courseId);
        const record = bestTrainingRecordFor(member.id, courseId, evaluationAt);
        const required = requirementRows.some((requirement) => requirement.requiredStatus === "Required");
        const requiredStatus: TrainingRequirementStatus = required ? "Required" : "Recommended";
        const dueAt = record?.dueAt ?? earliestRequirementDue(requirementRows);
        const recordStatus = record ? effectiveStatusAt(record, evaluationAt) : null;
        const overdue = record ? isOverdueAt(record, evaluationAt) : isBefore(dueAt, evaluationAt);
        const expiringSoon = record ? isExpiringSoonAt(record, expiringSoonDays, evaluationAt) : false;
        let status: "Compliant" | "Attention" | "Non-compliant" = "Attention";
        if (!record) status = overdue && required ? "Non-compliant" : "Attention";
        else if (recordStatus === "Completed" || recordStatus === "Waived") status = expiringSoon ? "Attention" : "Compliant";
        else if (recordStatus === "Expired") status = required ? "Non-compliant" : "Attention";
        else if (overdue) status = required ? "Non-compliant" : "Attention";

        return {
          courseId,
          course: courseView(course),
          requiredStatus,
          status,
          dueAt,
          expiringSoon,
          sourceRequirementIds: requirementRows.map((requirement) => requirement.id),
          sourceRequirements: requirementRows.map((requirement) => ({
            id: requirement.id,
            targetType: requirement.targetType,
            targetLabel: requirementTarget(requirement).label,
            requiredStatus: requirement.requiredStatus,
            dueAt: requirement.dueAt ?? null
          })),
          record: record ? trainingComplianceRecordView(record, actor, evaluationAt, expiringSoonDays) : null
        };
      });

      const dimensionStatus =
        items.length === 0
          ? "Not applicable"
          : items.some((item) => item.requiredStatus === "Required" && item.status === "Non-compliant")
            ? "Non-compliant"
            : items.some((item) => item.status !== "Compliant")
              ? "Attention"
              : "Compliant";

      return {
        memberProfileId: member.id,
        member: memberSummary(member),
        evaluationAt,
        expiringSoonDays,
        status: dimensionStatus,
        totals: {
          required: items.filter((item) => item.requiredStatus === "Required").length,
          recommended: items.filter((item) => item.requiredStatus === "Recommended").length,
          compliant: items.filter((item) => item.status === "Compliant").length,
          attention: items.filter((item) => item.status === "Attention").length,
          nonCompliant: items.filter((item) => item.status === "Non-compliant").length
        },
        items
      };
    },

    listCourses(query: Query, actor: DirectoryActor) {
      assertTrainingRead(actor);
      let visible = [...courses];
      if (!hasPermission(actor, "training:read-all")) {
        const ownMember = linkedMember(actor);
        const ownCourseIds = new Set(records.filter((record) => ownMember && record.memberProfileId === ownMember.id).map((record) => record.courseId));
        visible = visible.filter((course) => ownCourseIds.has(course.id));
      }
      const active = query.active === undefined ? null : asBoolean(query.active, true);
      const category = asString(query.category);
      const search = normalize(query.search ?? query.q);
      if (active !== null) visible = visible.filter((course) => course.active === active);
      if (category && category !== "All categories") visible = visible.filter((course) => normalize(course.category) === normalize(category));
      if (search) visible = visible.filter((course) => [course.code, course.title, course.category, course.description].some((value) => normalize(value).includes(search)));
      visible.sort((left, right) => Number(right.active) - Number(left.active) || left.title.localeCompare(right.title));
      return page(visible.map(courseView), query);
    },

    getCourse(id: string, actor: DirectoryActor) {
      assertTrainingRead(actor);
      const course = assertCourse(id);
      if (!hasPermission(actor, "training:read-all")) {
        const ownMember = linkedMember(actor);
        const visible = records.some((record) => ownMember && record.memberProfileId === ownMember.id && record.courseId === id);
        assert(visible, 403, "You do not have access to this course.");
      }
      return courseView(course);
    },

    createCourse(body: Query, actor: DirectoryActor) {
      assert(canManageCourses(actor), 403, "You cannot manage training courses.");
      const nowValue = new Date().toISOString();
      const course: TrainingCourseRecord = {
        id: nextCourseId(),
        ...validateCourseBody(body),
        active: true,
        version: 1,
        createdAt: nowValue,
        updatedAt: nowValue,
        createdById: actor.id,
        updatedById: actor.id
      };
      courses.push(course);
      return courseView(course);
    },

    updateCourse(id: string, body: Query, actor: DirectoryActor) {
      assert(canManageCourses(actor), 403, "You cannot manage training courses.");
      const course = assertCourse(id);
      assertExpectedUpdatedAt(body, course);
      Object.assign(course, validateCourseBody(body, course));
      bump(course, actor);
      return courseView(course);
    },

    deactivateCourse(id: string, body: Query, actor: DirectoryActor) {
      assert(canManageCourses(actor), 403, "You cannot manage training courses.");
      const course = assertCourse(id);
      assertExpectedUpdatedAt(body, course);
      assert(course.active, 409, "This course is already inactive.");
      course.active = false;
      course.deactivatedAt = new Date().toISOString();
      bump(course, actor);
      return courseView(course);
    },

    reactivateCourse(id: string, body: Query, actor: DirectoryActor) {
      assert(canManageCourses(actor), 403, "You cannot manage training courses.");
      const course = assertCourse(id);
      assertExpectedUpdatedAt(body, course);
      assert(!course.active, 409, "This course is already active.");
      course.active = true;
      course.reactivatedAt = new Date().toISOString();
      bump(course, actor);
      return courseView(course);
    },

    listRequirements(query: Query, actor: DirectoryActor) {
      assert(hasPermission(actor, "training:read-all") || canManageRequirements(actor), 403, "You do not have access to training requirements.");
      let visible = requirements.filter((requirement) => canSeeRequirement(requirement, actor, hasPermission(actor, "training:read-all") ? "training:read-all" : "training:requirement:manage"));
      const active = query.active === undefined ? null : asBoolean(query.active, true);
      const targetType = asString(query.targetType);
      const courseId = asString(query.courseId);
      const search = normalize(query.search ?? query.q);
      if (active !== null) visible = visible.filter((requirement) => requirement.active === active);
      if (targetType && targetType !== "All targets") visible = visible.filter((requirement) => requirement.targetType === targetType);
      if (courseId) visible = visible.filter((requirement) => requirement.courseId === courseId);
      if (search) visible = visible.filter((requirement) => [assertCourse(requirement.courseId).title, requirementTarget(requirement).label, requirement.requiredStatus].some((value) => normalize(value).includes(search)));
      visible.sort((left, right) => Number(right.active) - Number(left.active) || assertCourse(left.courseId).title.localeCompare(assertCourse(right.courseId).title));
      return page(visible.map(requirementView), query);
    },

    getRequirement(id: string, actor: DirectoryActor) {
      const requirement = assertRequirement(id);
      const permission = hasPermission(actor, "training:read-all") ? "training:read-all" : "training:requirement:manage";
      assert(canSeeRequirement(requirement, actor, permission), 403, "You do not have access to this training requirement.");
      return requirementView(requirement);
    },

    createRequirement(body: Query, actor: DirectoryActor) {
      assert(canManageRequirements(actor), 403, "You cannot manage training requirements.");
      const nowValue = new Date().toISOString();
      const requirement: TrainingRequirementRecord = {
        id: nextRequirementId(),
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
      assert(canManageRequirements(actor), 403, "You cannot manage training requirements.");
      const requirement = assertRequirement(id);
      assert(canSeeRequirement(requirement, actor, "training:requirement:manage"), 403, "Forbidden");
      assertExpectedUpdatedAt(body, requirement);
      assert(requirement.active, 409, "Ended requirements cannot be edited.");
      Object.assign(requirement, validateRequirementBody(body, requirement, actor));
      bump(requirement, actor);
      return requirementView(requirement);
    },

    endRequirement(id: string, body: Query, actor: DirectoryActor) {
      assert(canManageRequirements(actor), 403, "You cannot manage training requirements.");
      const requirement = assertRequirement(id);
      assert(canSeeRequirement(requirement, actor, "training:requirement:manage"), 403, "Forbidden");
      assertExpectedUpdatedAt(body, requirement);
      assert(requirement.active, 409, "This requirement is already ended.");
      requirement.active = false;
      requirement.effectiveTo = parseOptionalDate(body.effectiveTo, "Effective to") ?? new Date().toISOString();
      bump(requirement, actor);
      return requirementView(requirement);
    },

    listRecords(query: Query, actor: DirectoryActor) {
      const linked = linkedMember(actor);
      const filtered = sortRecords(filterRecords(query, actor), query);
      return page(filtered.map((record) => recordView(record, actor)), query, {
        linkedMemberProfile: linked ? memberSummary(linked) : null,
        totals: {
          assigned: filtered.filter((record) => effectiveStatus(record) === "Assigned").length,
          inProgress: filtered.filter((record) => effectiveStatus(record) === "In Progress").length,
          completed: filtered.filter((record) => effectiveStatus(record) === "Completed").length,
          expired: filtered.filter((record) => effectiveStatus(record) === "Expired").length,
          overdue: filtered.filter(isOverdue).length,
          expiringSoon: filtered.filter((record) => isExpiringSoon(record)).length
        }
      });
    },

    getRecord(id: string, actor: DirectoryActor) {
      const record = assertRecord(id);
      assertCanSeeRecord(record, actor);
      return recordView(record, actor);
    },

    assignRecord(body: Query, actor: DirectoryActor) {
      assert(canAssign(actor), 403, "You cannot assign training.");
      const memberProfileId = optionalString(body.memberProfileId);
      const groupId = optionalString(body.groupId);
      const courseId = asString(body.courseId);
      assert(Boolean(memberProfileId) !== Boolean(groupId), 400, "Choose one training target.");
      const course = assertCourse(courseId);
      assert(course.active, 409, "Inactive courses cannot receive new assignments.");
      const sourceRequirementId = optionalString(body.sourceRequirementId);
      if (sourceRequirementId) {
        const requirement = assertRequirement(sourceRequirementId);
        assert(requirement.active, 409, "Ended requirements cannot receive new assignments.");
        assert(requirement.courseId === courseId, 400, "Requirement and course do not match.");
      }
      const group = groupId ? directory.lookupGroup(groupId) : null;
      if (groupId) assert(canAccessGroup(actor, "training:assign", groupId), 403, "Forbidden");
      if (memberProfileId) assert(canAccessTrainingMember(actor, "training:assign", memberProfileId), 403, "Forbidden");
      if (group) assert(group.status !== "Archived", 409, "Archived groups cannot receive new training.");
      const targetIds = group
        ? group.memberIds.filter((id) => directory.lookupMember(id).status !== "Archived")
        : [memberProfileId].filter((id): id is string => Boolean(id));
      assert(targetIds.length > 0, 409, "This group has no active members.");
      const duplicateIds = new Set(records.filter((record) => record.courseId === courseId && activeRecordStatuses.has(record.status)).map((record) => record.memberProfileId));
      const assignableIds = targetIds.filter((id) => !duplicateIds.has(id));
      if (!group) assert(assignableIds.length === 1, 409, "This member already has active training for this course.");
      assert(assignableIds.length > 0, 409, "All selected group members already have active training for this course.");
      const nowValue = new Date().toISOString();
      const assignedAt = parseOptionalDate(body.assignedAt, "Assigned at") ?? nowValue;
      const dueAt = parseOptionalDate(body.dueAt, "Due date");
      const created = assignableIds.map((id) => {
        const member = directory.lookupMember(id);
        assert(member.status !== "Archived", 409, "Archived profiles cannot receive new training.");
        const ids = nextRecordId();
        const record: MemberTrainingRecord = {
          id: ids.id,
          operationalId: ids.operationalId,
          memberProfileId: id,
          courseId,
          sourceRequirementId,
          assignedAt,
          dueAt,
          status: "Assigned",
          version: 1,
          createdAt: nowValue,
          updatedAt: nowValue,
          createdById: actor.id,
          updatedById: actor.id
        };
        records.push(record);
        return record;
      });
      const views = created.map((record) => recordView(record, actor));
      if (group) {
        return {
          targetType: "Group",
          group: groupSummary(group),
          course: courseView(course),
          assignedCount: views.length,
          skippedCount: targetIds.length - views.length,
          records: views
        };
      }
      return views[0]!;
    },

    updateRecord(id: string, body: Query, actor: DirectoryActor) {
      assert(canAssign(actor) || canCompleteAll(actor), 403, "You cannot edit training records.");
      const record = assertRecord(id);
      assert(canAccessTrainingMember(actor, "training:assign", record.memberProfileId) || canAccessTrainingMember(actor, "training:complete-all", record.memberProfileId), 403, "Forbidden");
      assertCanSeeRecord(record, actor);
      assert(!Object.keys(body).some((key) => controlledRecordFields.has(key)), 400, "Use the dedicated action for this training status change.");
      assert(!terminalRecordStatuses.has(effectiveStatus(record)), 409, "Completed or closed training cannot be edited here.");
      assertExpectedUpdatedAt(body, record);
      if (body.dueAt !== undefined) record.dueAt = parseOptionalDate(body.dueAt, "Due date");
      if (body.completionNote !== undefined) record.completionNote = optionalString(body.completionNote);
      bump(record, actor);
      return recordView(record, actor);
    },

    startRecord(id: string, body: Query, actor: DirectoryActor) {
      const record = assertRecord(id);
      assertExpectedUpdatedAt(body, record);
      assertRecordActionAllowed(record, actor, "start");
      record.status = "In Progress";
      bump(record, actor);
      return recordView(record, actor);
    },

    completeRecord(id: string, body: Query, actor: DirectoryActor) {
      const record = assertRecord(id);
      assertExpectedUpdatedAt(body, record);
      assertRecordActionAllowed(record, actor, "complete");
      const completedAt = parseDate(body.completedAt, "Completion time");
      const course = assertCourse(record.courseId);
      record.status = "Completed";
      record.completedAt = completedAt;
      record.expiryAt = course.validityMonths ? addMonths(completedAt, course.validityMonths) : null;
      record.score = body.score === undefined || body.score === null || body.score === "" ? null : Math.min(100, Math.max(0, Math.round(asNumber(body.score, 0))));
      record.completionNote = optionalString(body.completionNote);
      record.completionRef = optionalString(body.completionRef);
      record.waiverReason = null;
      record.cancelledReason = null;
      bump(record, actor);
      return recordView(record, actor);
    },

    verifyRecord(id: string, body: Query, actor: DirectoryActor) {
      const record = assertRecord(id);
      assertExpectedUpdatedAt(body, record);
      assertRecordActionAllowed(record, actor, "verify");
      record.verifiedById = actor.id;
      record.verifiedAt = parseOptionalDate(body.verifiedAt, "Verified at") ?? new Date().toISOString();
      if (body.completionNote !== undefined) record.completionNote = optionalString(body.completionNote);
      bump(record, actor);
      return recordView(record, actor);
    },

    waiveRecord(id: string, body: Query, actor: DirectoryActor) {
      const record = assertRecord(id);
      assertExpectedUpdatedAt(body, record);
      assertRecordActionAllowed(record, actor, "waive");
      const reason = asString(body.reason);
      assert(reason.length >= 3, 400, "Waiver reason is required.");
      record.status = "Waived";
      record.waiverReason = reason;
      bump(record, actor);
      return recordView(record, actor);
    },

    cancelRecord(id: string, body: Query, actor: DirectoryActor) {
      const record = assertRecord(id);
      assertExpectedUpdatedAt(body, record);
      assertRecordActionAllowed(record, actor, "cancel");
      const reason = asString(body.reason);
      assert(reason.length >= 3, 400, "Cancellation reason is required.");
      record.status = "Cancelled";
      record.cancelledReason = reason;
      bump(record, actor);
      return recordView(record, actor);
    }
  };
}

export type TrainingRepository = ReturnType<typeof createTrainingRepository>;
