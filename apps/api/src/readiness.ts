import type { Permission } from "@zpp/shared";
import { DirectoryError } from "./member-directory.js";
import type { DirectoryActor, MemberDirectoryRepository } from "./member-directory.js";
import type { DocumentRepository } from "./documents.js";
import type { RosteringRepository } from "./rostering.js";
import type { RosteringService as FoundationRosteringService } from "./modules/rostering/rostering-service.js";
import type { TrainingRepository } from "./training.js";
import type { TrainingService as FoundationTrainingService } from "./modules/training/training-service.js";
import { permissionsForRoleNames } from "./access-control.js";

type Query = Record<string, unknown>;
type DirectoryMember = ReturnType<MemberDirectoryRepository["lookupMember"]>;
type DirectoryGroup = ReturnType<MemberDirectoryRepository["lookupGroup"]>;
type ReadinessSeverity = "blocker" | "warning" | "info";
type ReadinessOverallStatus = "Ready" | "Ready with attention" | "Not ready" | "Unknown" | "Not applicable";
type DimensionStatus = "Compliant" | "Attention" | "Non-compliant" | "Unknown" | "Not applicable";

const defaultPolicy = {
  id: "readiness-policy-2026-07",
  version: 1,
  expiringSoonDays: 45,
  rosterLookaheadDays: 14,
  availabilityLookaheadDays: 1
} as const;

function asString(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function asNumber(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalize(value: unknown) {
  return asString(value).toLowerCase();
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

function assert(condition: unknown, status: number, message: string): asserts condition {
  if (!condition) throw new DirectoryError(status, message);
}

function hasPermission(actor: DirectoryActor, permission: string) {
  return actor.permissions.includes(permission);
}

function parseEvaluationAt(query: Query) {
  const raw = asString(query.evaluationAt ?? query.at);
  if (!raw) return new Date().toISOString();
  const date = new Date(raw);
  assert(Number.isFinite(date.getTime()), 400, "Evaluation time must be a valid date and time.");
  return date.toISOString();
}

function addDays(isoDate: string, days: number) {
  const date = new Date(isoDate);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function dayWindow(isoDate: string) {
  const start = new Date(isoDate);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { startAt: start.toISOString(), endAt: end.toISOString() };
}

function overlaps(leftStart: string, leftEnd: string, rightStart: string, rightEnd: string) {
  return new Date(leftStart).getTime() < new Date(rightEnd).getTime() && new Date(leftEnd).getTime() > new Date(rightStart).getTime();
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

function availabilityItemView(record: any) {
  return {
    id: record.id,
    operationalId: record.operationalId,
    memberProfileId: record.memberProfileId,
    startAt: record.startAt,
    endAt: record.endAt,
    type: record.type,
    note: record.note ?? "",
    status: record.status
  };
}

function rosterItemView(shift: any, directory: MemberDirectoryRepository) {
  return {
    id: shift.id,
    operationalId: shift.operationalId,
    sessionId: shift.sessionId,
    groupId: shift.groupId ?? null,
    assignedMemberProfileId: shift.assignedMemberProfileId ?? null,
    title: shift.title,
    duty: shift.duty,
    functionName: shift.functionName,
    startAt: shift.startAt,
    endAt: shift.endAt,
    location: shift.location,
    status: shift.status,
    notes: shift.notes ?? "",
    assignedMember: shift.assignedMemberProfileId ? memberSummary(directory.lookupMember(shift.assignedMemberProfileId)) : null,
    group: shift.groupId ? groupSummary(directory.lookupGroup(shift.groupId)) : null,
    conflictWarnings: Array.isArray(shift.conflictWarnings) ? shift.conflictWarnings : []
  };
}

function factor(input: {
  code: string;
  category: string;
  severity: ReadinessSeverity;
  title: string;
  detail: string;
  sourceType: string;
  sourceId?: string | null;
  dueAt?: string | null;
  action?: { label: string; href: string };
}) {
  return {
    code: input.code,
    category: input.category,
    severity: input.severity,
    title: input.title,
    detail: input.detail,
    source: {
      type: input.sourceType,
      id: input.sourceId ?? null
    },
    dueAt: input.dueAt ?? null,
    action: input.action ?? null
  };
}

function dimension(input: {
  key: string;
  label: string;
  status: DimensionStatus;
  state: string;
  detail: string;
  sourceType: string;
  sourceId?: string | null;
  factors?: ReturnType<typeof factor>[];
  items?: unknown[];
}) {
  return {
    key: input.key,
    label: input.label,
    status: input.status,
    state: input.state,
    detail: input.detail,
    source: {
      type: input.sourceType,
      id: input.sourceId ?? null
    },
    factors: input.factors ?? [],
    items: input.items ?? []
  };
}

function summarizeOverall(dimensions: ReturnType<typeof dimension>[]): ReadinessOverallStatus {
  const factors = dimensions.flatMap((item) => item.factors);
  if (factors.some((item) => item.severity === "blocker")) return "Not ready";
  if (dimensions.some((item) => item.status === "Unknown")) return "Unknown";
  if (factors.some((item) => item.severity === "warning") || dimensions.some((item) => item.status === "Attention")) return "Ready with attention";
  if (dimensions.every((item) => item.status === "Not applicable")) return "Not applicable";
  return "Ready";
}

function statusRank(status: ReadinessOverallStatus) {
  return { "Not ready": 0, Unknown: 1, "Ready with attention": 2, "Not applicable": 3, Ready: 4 }[status];
}

function dedupeActions(factors: ReturnType<typeof factor>[]) {
  const seen = new Set<string>();
  const actions: Array<{ label: string; href: string; reason: string; severity: ReadinessSeverity }> = [];
  for (const item of factors) {
    if (!item.action) continue;
    const key = `${item.action.href}:${item.action.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    actions.push({ ...item.action, reason: item.title, severity: item.severity });
  }
  return actions.slice(0, 5);
}

export function createReadinessService({
  directory,
  training,
  documents,
  rostering,
  foundationRostering,
  foundationTraining
}: {
  directory: MemberDirectoryRepository;
  training: TrainingRepository;
  documents: DocumentRepository;
  rostering: RosteringRepository;
  foundationRostering?: FoundationRosteringService | null;
  foundationTraining?: FoundationTrainingService | null;
}) {
  function evaluationActor(actor: DirectoryActor): DirectoryActor {
    return {
      ...actor,
      permissions: Array.from(new Set([
        ...actor.permissions,
        "training:read-all",
        "document:read-all",
        "roster:read",
        "availability:read-all"
      ]))
    };
  }

  function linkedMember(actor: DirectoryActor) {
    return directory.resolveMemberForUser(actor.id);
  }

  function allGroups() {
    return directory.listGroups({ limit: 200 }).data.map((group) => directory.lookupGroup(group.id));
  }

  function allMembers() {
    return directory.listMembers({ limit: 200 }).data.map((member) => directory.lookupMember(member.id));
  }

  function groupsForMember(memberProfileId: string) {
    return allGroups().filter((group) => group.status !== "Archived" && group.memberIds.includes(memberProfileId));
  }

  function visibleGroupIds(actor: DirectoryActor) {
    if (hasPermission(actor, "readiness:read-all")) return new Set(allGroups().filter((group) => group.status !== "Archived").map((group) => group.id));
    if (!hasPermission(actor, "readiness:read-group")) return new Set<string>();
    const scopedGroupIds = new Set(
      (actor.roleAssignments ?? [])
        .filter((assignment) => assignment.status === "Active" && assignment.scopeType === "GROUP" && assignment.scopeId)
        .filter((assignment) => permissionsForRoleNames([assignment.roleName]).includes("readiness:read-group" as Permission))
        .map((assignment) => String(assignment.scopeId))
    );
    if (scopedGroupIds.size > 0) {
      return new Set(
        allGroups()
          .filter((group) => group.status !== "Archived" && scopedGroupIds.has(group.id))
          .map((group) => group.id)
      );
    }
    const own = linkedMember(actor);
    return new Set(
      allGroups()
        .filter((group) => group.status !== "Archived")
        .filter((group) => Boolean(own && group.memberIds.includes(own.id)))
        .map((group) => group.id)
    );
  }

  function canReadMember(actor: DirectoryActor, memberProfileId: string) {
    if (hasPermission(actor, "readiness:read-all")) return true;
    const own = linkedMember(actor);
    if (hasPermission(actor, "readiness:read-own") && own?.id === memberProfileId) return true;
    if (!hasPermission(actor, "readiness:read-group")) return false;
    const allowedGroups = visibleGroupIds(actor);
    return groupsForMember(memberProfileId).some((group) => allowedGroups.has(group.id));
  }

  function visibleMembers(actor: DirectoryActor) {
    if (hasPermission(actor, "readiness:read-all")) return allMembers();
    const allowedGroups = visibleGroupIds(actor);
    if (allowedGroups.size > 0) {
      const ids = new Set<string>();
      for (const group of allGroups()) {
        if (!allowedGroups.has(group.id)) continue;
        group.memberIds.forEach((memberId) => ids.add(memberId));
      }
      return Array.from(ids).map((id) => directory.lookupMember(id)).filter((member) => member.status !== "Archived");
    }
    const own = linkedMember(actor);
    return own && hasPermission(actor, "readiness:read-own") ? [own] : [];
  }

  function buildProfileDimension(member: DirectoryMember) {
    const groups = groupsForMember(member.id).map(groupSummary);
    const factors: ReturnType<typeof factor>[] = [];
    if (member.status !== "Active") {
      factors.push(factor({
        code: "profile-not-active",
        category: "Profile",
        severity: "blocker",
        title: "Profile is not active",
        detail: "Only active member profiles can be treated as operationally ready.",
        sourceType: "memberProfile",
        sourceId: member.id,
        action: { label: "Review profile", href: `/members?member=${member.id}` }
      }));
    }
    if (groups.length === 0 && member.status === "Active") {
      factors.push(factor({
        code: "profile-no-group",
        category: "Profile",
        severity: "warning",
        title: "No active group assignment",
        detail: "This member is active but not linked to an active response group.",
        sourceType: "memberProfile",
        sourceId: member.id,
        action: { label: "Review groups", href: "/groups" }
      }));
    }
    return dimension({
      key: "profile",
      label: "Profile",
      status: factors.some((item) => item.severity === "blocker") ? "Non-compliant" : factors.length ? "Attention" : "Compliant",
      state: member.status === "Active" ? "Active profile" : `${member.status} profile`,
      detail: groups.length ? `Linked to ${groups.length} active group${groups.length === 1 ? "" : "s"}.` : "No active group assignment.",
      sourceType: "memberProfile",
      sourceId: member.id,
      factors,
      items: groups
    });
  }

  async function buildTrainingDimension(member: DirectoryMember, actor: DirectoryActor, evaluationAt: string) {
    const result = foundationTraining
      ? await foundationTraining.evaluateMemberCompliance(evaluationActor(actor), member.id, { evaluationAt, expiringSoonDays: defaultPolicy.expiringSoonDays })
      : training.evaluateMemberCompliance(member.id, evaluationActor(actor), {
      evaluationAt,
      expiringSoonDays: defaultPolicy.expiringSoonDays
    });
    const factors = result.items.flatMap((item: any) => {
      if (item.status === "Compliant") return [];
      const required = item.requiredStatus === "Required";
      const severity: ReadinessSeverity = item.status === "Non-compliant" && required ? "blocker" : "warning";
      return [factor({
        code: item.status === "Non-compliant" ? "training-not-complete" : "training-needs-attention",
        category: "Training",
        severity,
        title: item.status === "Non-compliant" ? "Required training not complete" : "Training needs attention",
        detail: `${item.course.title} is ${item.record?.status ?? "not assigned"}.`,
        sourceType: "trainingCourse",
        sourceId: item.courseId,
        dueAt: item.dueAt,
        action: { label: "Open training", href: `/training?memberProfileId=${member.id}` }
      })];
    });
    return dimension({
      key: "training",
      label: "Training",
      status: result.status as DimensionStatus,
      state: result.status === "Compliant" ? "Training current" : result.status,
      detail: `${result.totals.compliant} current, ${result.totals.attention + result.totals.nonCompliant} needing attention.`,
      sourceType: "trainingCompliance",
      sourceId: member.id,
      factors,
      items: result.items
    });
  }

  function buildDocumentDimension(member: DirectoryMember, actor: DirectoryActor, evaluationAt: string) {
    const result = documents.evaluateMemberCompliance(member.id, evaluationActor(actor), { evaluationAt });
    const factors = result.items.flatMap((item: any) => {
      if (item.status === "Acknowledged" && item.contentAvailable) return [];
      const overdue = item.status === "Overdue" || !item.contentAvailable;
      return [factor({
        code: overdue ? "document-not-acknowledged" : "document-needs-acknowledgement",
        category: "Documents",
        severity: overdue ? "blocker" : "warning",
        title: overdue ? "Required document not acknowledged" : "Document acknowledgement needed",
        detail: item.contentAvailable ? `${item.title} is ${item.status.toLowerCase()}.` : `${item.title} is not available for acknowledgement.`,
        sourceType: "documentVersion",
        sourceId: item.documentVersionId,
        dueAt: item.dueAt,
        action: { label: "Open documents", href: "/documents" }
      })];
    });
    return dimension({
      key: "documents",
      label: "Documents",
      status: result.status as DimensionStatus,
      state: result.status === "Compliant" ? "Documents acknowledged" : result.status,
      detail: `${result.totals.acknowledged} acknowledged, ${result.totals.outstanding} outstanding.`,
      sourceType: "documentCompliance",
      sourceId: member.id,
      factors,
      items: result.items
    });
  }

  async function buildAvailabilityDimension(member: DirectoryMember, actor: DirectoryActor, evaluationAt: string) {
    const window = dayWindow(evaluationAt);
    const records = foundationRostering
      ? await foundationRostering.readinessAvailability(member.id, new Date(window.startAt), new Date(window.endAt))
      : rostering.listAvailability({ memberProfileId: member.id, startFrom: window.startAt, startTo: window.endAt, limit: 20 }, evaluationActor(actor)).data as any[];
    const activeNow = records.find((record) => overlaps(record.startAt, record.endAt, evaluationAt, evaluationAt));
    const firstRecord = activeNow ?? records[0] ?? null;
    const factors: ReturnType<typeof factor>[] = [];
    if (!firstRecord) {
      factors.push(factor({
        code: "availability-not-declared",
        category: "Availability",
        severity: "warning",
        title: "Availability not declared",
        detail: "No availability entry was found for the current operating day.",
        sourceType: "availability",
        sourceId: member.id,
        action: { label: "Open rostering", href: "/rostering" }
      }));
    } else if (firstRecord.type === "Unavailable") {
      factors.push(factor({
        code: "availability-unavailable",
        category: "Availability",
        severity: "warning",
        title: "Marked unavailable",
        detail: "This member is marked unavailable in the current availability window.",
        sourceType: "availability",
        sourceId: firstRecord.id,
        action: { label: "Open rostering", href: "/rostering" }
      }));
    }
    return dimension({
      key: "availability",
      label: "Availability",
      status: factors.length ? "Attention" : "Compliant",
      state: firstRecord ? firstRecord.type : "No declaration",
      detail: firstRecord ? `${firstRecord.type} from ${firstRecord.startAt} to ${firstRecord.endAt}.` : "No availability entry for today.",
      sourceType: "availability",
      sourceId: firstRecord?.id ?? member.id,
      factors,
      items: records.map(availabilityItemView)
    });
  }

  async function buildRosterDimension(member: DirectoryMember, actor: DirectoryActor, evaluationAt: string) {
    const endAt = addDays(evaluationAt, defaultPolicy.rosterLookaheadDays);
    const projected = foundationRostering
      ? await foundationRostering.readinessRoster(actor, member.id, new Date(evaluationAt), new Date(endAt))
      : rostering.listShifts({ memberProfileId: member.id, startFrom: evaluationAt, startTo: endAt, limit: 20 }, evaluationActor(actor)).data as any[];
    const shifts = (projected as any[]).filter((shift) => !["Cancelled", "Completed"].includes(String(shift.status)));
    const nextShift = shifts[0] ?? null;
    const factors: ReturnType<typeof factor>[] = [];
    if (!nextShift) {
      factors.push(factor({
        code: "roster-no-upcoming-shift",
        category: "Roster",
        severity: "info",
        title: "No upcoming roster shift",
        detail: "No active roster shift was found in the next roster window.",
        sourceType: "rosterShift",
        sourceId: member.id,
        action: { label: "Open rostering", href: "/rostering" }
      }));
    } else if (nextShift.status === "Published") {
      factors.push(factor({
        code: "roster-awaiting-confirmation",
        category: "Roster",
        severity: "warning",
        title: "Roster shift awaits confirmation",
        detail: `${nextShift.operationalId} is published but not yet confirmed.`,
        sourceType: "rosterShift",
        sourceId: nextShift.id,
        dueAt: nextShift.startAt,
        action: { label: "Open rostering", href: "/rostering" }
      }));
    } else if (nextShift.status === "Declined") {
      factors.push(factor({
        code: "roster-shift-declined",
        category: "Roster",
        severity: "warning",
        title: "Roster shift declined",
        detail: `${nextShift.operationalId} has been declined and needs coverage review.`,
        sourceType: "rosterShift",
        sourceId: nextShift.id,
        dueAt: nextShift.startAt,
        action: { label: "Open rostering", href: "/rostering" }
      }));
    } else if (nextShift.status === "Draft") {
      factors.push(factor({
        code: "roster-shift-draft",
        category: "Roster",
        severity: "warning",
        title: "Roster shift not published",
        detail: `${nextShift.operationalId} is still in draft.`,
        sourceType: "rosterShift",
        sourceId: nextShift.id,
        dueAt: nextShift.startAt,
        action: { label: "Open rostering", href: "/rostering" }
      }));
    }
    return dimension({
      key: "roster",
      label: "Roster",
      status: factors.some((item) => item.severity === "warning") ? "Attention" : "Compliant",
      state: nextShift ? `${nextShift.status} shift` : "No upcoming shift",
      detail: nextShift ? `${nextShift.operationalId} starts at ${nextShift.startAt}.` : `No active shift in the next ${defaultPolicy.rosterLookaheadDays} days.`,
      sourceType: "rosterShift",
      sourceId: nextShift?.id ?? member.id,
      factors,
      items: shifts.map((shift) => rosterItemView(shift, directory))
    });
  }

  async function assessMember(member: DirectoryMember, actor: DirectoryActor, evaluationAt: string) {
    const [trainingDimension, availabilityDimension, rosterDimension] = await Promise.all([
      buildTrainingDimension(member, actor, evaluationAt),
      buildAvailabilityDimension(member, actor, evaluationAt),
      buildRosterDimension(member, actor, evaluationAt),
    ]);
    const dimensions = [
      buildProfileDimension(member),
      trainingDimension,
      buildDocumentDimension(member, actor, evaluationAt),
      availabilityDimension,
      rosterDimension
    ];
    const factors = dimensions.flatMap((item) => item.factors);
    const overallStatus = summarizeOverall(dimensions);
    return {
      member: memberSummary(member),
      calculatedAt: evaluationAt,
      overallStatus,
      dimensions,
      blockers: factors.filter((item) => item.severity === "blocker"),
      warnings: factors.filter((item) => item.severity === "warning"),
      information: factors.filter((item) => item.severity === "info"),
      nextActions: dedupeActions(factors.filter((item) => item.severity !== "info")),
      policy: defaultPolicy
    };
  }

  function applyMemberFilters(data: Awaited<ReturnType<typeof assessMember>>[], query: Query) {
    const search = normalize(query.search ?? query.q);
    const status = asString(query.status);
    const groupId = asString(query.groupId);
    return data.filter((item) => {
      const groupMatch = !groupId || groupsForMember(item.member.id).some((group) => group.id === groupId);
      const statusMatch = !status || status === "All statuses" || item.overallStatus === status;
      const searchMatch = !search || [
        item.member.memberId,
        item.member.displayName,
        item.member.pool,
        item.member.role,
        item.member.assignedFunction,
        item.overallStatus,
        item.blockers.map((blocker) => blocker.title).join(" "),
        item.warnings.map((warning) => warning.title).join(" ")
      ].some((value) => normalize(value).includes(search));
      return groupMatch && statusMatch && searchMatch;
    });
  }

  function summaryFor(assessments: Awaited<ReturnType<typeof assessMember>>[], evaluationAt: string) {
    const byStatus: Record<ReadinessOverallStatus, number> = {
      Ready: 0,
      "Ready with attention": 0,
      "Not ready": 0,
      Unknown: 0,
      "Not applicable": 0
    };
    const byIssue: Record<string, number> = {};
    for (const assessment of assessments) {
      byStatus[assessment.overallStatus] += 1;
      for (const item of [...assessment.blockers, ...assessment.warnings]) {
        byIssue[item.category] = (byIssue[item.category] ?? 0) + 1;
      }
    }
    return {
      calculatedAt: evaluationAt,
      totalMembers: assessments.length,
      byStatus,
      issueCounts: byIssue,
      needsAction: assessments.filter((item) => item.overallStatus === "Not ready" || item.overallStatus === "Ready with attention").length,
      blocked: assessments.filter((item) => item.overallStatus === "Not ready").length,
      attention: assessments.filter((item) => item.overallStatus === "Ready with attention").length,
      ready: assessments.filter((item) => item.overallStatus === "Ready").length,
      policy: defaultPolicy
    };
  }

  async function groupReadiness(group: DirectoryGroup, actor: DirectoryActor, evaluationAt: string) {
    const members = group.memberIds
      .map((memberId) => directory.lookupMember(memberId))
      .filter((member) => member.status !== "Archived");
    const memberAssessments = await Promise.all(members.map((member) => assessMember(member, actor, evaluationAt)));
    return {
      group: groupSummary(group),
      calculatedAt: evaluationAt,
      summary: summaryFor(memberAssessments, evaluationAt),
      members: memberAssessments.map((assessment) => ({
        member: assessment.member,
        overallStatus: assessment.overallStatus,
        blockerCount: assessment.blockers.length,
        warningCount: assessment.warnings.length,
        primaryIssue: assessment.blockers[0] ?? assessment.warnings[0] ?? null
      }))
    };
  }

  return {
    async me(query: Query, actor: DirectoryActor) {
      assert(hasPermission(actor, "readiness:read-own"), 403, "Forbidden");
      const member = linkedMember(actor);
      const evaluationAt = parseEvaluationAt(query);
      if (!member) {
        return {
          member: null,
          calculatedAt: evaluationAt,
          overallStatus: "Unknown" as ReadinessOverallStatus,
          dimensions: [],
          blockers: [],
          warnings: [factor({
            code: "member-profile-not-linked",
            category: "Profile",
            severity: "warning",
            title: "Member profile not linked",
            detail: "This account is not linked to a member profile.",
            sourceType: "memberProfile"
          })],
          information: [],
          nextActions: [],
          policy: defaultPolicy
        };
      }
      return await assessMember(member, actor, evaluationAt);
    },

    async members(query: Query, actor: DirectoryActor) {
      assert(hasPermission(actor, "readiness:read-all") || hasPermission(actor, "readiness:read-group"), 403, "Forbidden");
      const evaluationAt = parseEvaluationAt(query);
      const assessments = applyMemberFilters(await Promise.all(visibleMembers(actor).map((member) => assessMember(member, actor, evaluationAt))), query)
        .sort((left, right) => statusRank(left.overallStatus) - statusRank(right.overallStatus) || left.member.displayName.localeCompare(right.member.displayName));
      return page(assessments, query, { summary: summaryFor(assessments, evaluationAt) });
    },

    async member(id: string, query: Query, actor: DirectoryActor) {
      assert(canReadMember(actor, id), 403, "Forbidden");
      return await assessMember(directory.lookupMember(id), actor, parseEvaluationAt(query));
    },

    async groups(query: Query, actor: DirectoryActor) {
      assert(hasPermission(actor, "readiness:read-all") || hasPermission(actor, "readiness:read-group"), 403, "Forbidden");
      const evaluationAt = parseEvaluationAt(query);
      const allowed = visibleGroupIds(actor);
      const candidates = allGroups()
        .filter((group) => allowed.has(group.id))
        .filter((group) => !asString(query.groupId) || group.id === asString(query.groupId));
      const groups = (await Promise.all(candidates.map((group) => groupReadiness(group, actor, evaluationAt))))
        .sort((left, right) => left.group.name.localeCompare(right.group.name));
      return page(groups, query);
    },

    async group(id: string, query: Query, actor: DirectoryActor) {
      const allowed = visibleGroupIds(actor);
      assert(allowed.has(id), 403, "Forbidden");
      return await groupReadiness(directory.lookupGroup(id), actor, parseEvaluationAt(query));
    },

    async summary(query: Query, actor: DirectoryActor) {
      assert(hasPermission(actor, "readiness:read-summary") || hasPermission(actor, "readiness:read-all") || hasPermission(actor, "readiness:read-group"), 403, "Forbidden");
      const evaluationAt = parseEvaluationAt(query);
      const members = hasPermission(actor, "readiness:read-summary") && !hasPermission(actor, "readiness:read-group") && !hasPermission(actor, "readiness:read-all")
        ? allMembers()
        : visibleMembers(actor);
      return summaryFor(await Promise.all(members.map((member) => assessMember(member, actor, evaluationAt))), evaluationAt);
    },

    policy(actor: DirectoryActor) {
      assert(hasPermission(actor, "readiness:policy:read") || hasPermission(actor, "readiness:policy:manage"), 403, "Forbidden");
      return defaultPolicy;
    }
  };
}

export type ReadinessService = ReturnType<typeof createReadinessService>;
