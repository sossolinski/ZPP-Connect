import type {
  AvailabilitySnapshotItem,
  DocumentSnapshotItem,
  ReadinessAssessment,
  ReadinessDimension,
  ReadinessDimensionStatus,
  ReadinessFactor,
  ReadinessMemberSnapshot,
  ReadinessOverallStatus,
  ReadinessPolicy,
  ReadinessSeverity,
  ReadinessSummary,
  RosterSnapshotItem,
  TrainingSnapshotItem,
} from "./readiness-types.js";

export const readinessPolicy: ReadinessPolicy = {
  id: "readiness-policy-2026-07",
  version: 1,
  expiringSoonDays: 45,
  rosterLookaheadDays: 14,
  availabilityLookaheadDays: 1,
  availabilityTimezone: "UTC",
  evaluationMode: "current-topology",
};

function iso(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

function factor(input: Omit<ReadinessFactor, "source" | "dueAt" | "action"> & {
  sourceType: string;
  sourceId?: string | null;
  dueAt?: Date | null;
  action?: { label: string; href: string } | null;
}): ReadinessFactor {
  return {
    code: input.code,
    category: input.category,
    severity: input.severity,
    title: input.title,
    detail: input.detail,
    source: { type: input.sourceType, id: input.sourceId ?? null },
    dueAt: iso(input.dueAt),
    action: input.action ?? null,
  };
}

function dimension(input: Omit<ReadinessDimension, "source"> & { sourceType: string; sourceId?: string | null }): ReadinessDimension {
  const { sourceType, sourceId, ...value } = input;
  return { ...value, source: { type: sourceType, id: sourceId ?? null } };
}

function overall(dimensions: ReadinessDimension[]): ReadinessOverallStatus {
  const factors = dimensions.flatMap((item) => item.factors);
  if (factors.some((item) => item.severity === "blocker")) return "Not ready";
  if (dimensions.some((item) => item.status === "Unknown")) return "Unknown";
  if (factors.some((item) => item.severity === "warning") || dimensions.some((item) => item.status === "Attention")) return "Ready with attention";
  if (dimensions.every((item) => item.status === "Not applicable")) return "Not applicable";
  return "Ready";
}

function profileDimension(snapshot: ReadinessMemberSnapshot): ReadinessDimension {
  const factors: ReadinessFactor[] = [];
  if (snapshot.member.status !== "Active") {
    factors.push(factor({
      code: "profile-not-active", category: "Profile", severity: "blocker", title: "Profile is not active",
      detail: "Only active member profiles can be treated as operationally ready.", sourceType: "memberProfile", sourceId: snapshot.member.id,
      action: { label: "Review profile", href: `/members?member=${snapshot.member.id}` },
    }));
  } else if (snapshot.groups.length === 0) {
    factors.push(factor({
      code: "profile-no-group", category: "Profile", severity: "warning", title: "No active group assignment",
      detail: "This member is active but not linked to an active response group.", sourceType: "memberProfile", sourceId: snapshot.member.id,
      action: { label: "Review groups", href: "/groups" },
    }));
  }
  return dimension({
    key: "profile", label: "Profile",
    status: factors.some((item) => item.severity === "blocker") ? "Non-compliant" : factors.length ? "Attention" : "Compliant",
    state: snapshot.member.status === "Active" ? "Active profile" : `${snapshot.member.status} profile`,
    detail: snapshot.groups.length ? `Linked to ${snapshot.groups.length} active group${snapshot.groups.length === 1 ? "" : "s"}.` : "No active group assignment.",
    sourceType: "memberProfile", sourceId: snapshot.member.id, factors,
    items: snapshot.groups,
  });
}

function trainingDimension(items: TrainingSnapshotItem[], memberId: string): ReadinessDimension {
  const factors = items.flatMap((item): ReadinessFactor[] => {
    if (item.status === "Compliant") return [];
    const blocking = item.status === "Non-compliant" && item.requiredStatus === "Required";
    return [factor({
      code: blocking ? "training-not-complete" : "training-needs-attention", category: "Training",
      severity: blocking ? "blocker" : "warning", title: blocking ? "Required training not complete" : "Training needs attention",
      detail: `${item.title} is ${item.recordStatus ?? "not assigned"}.`, sourceType: "trainingCourse", sourceId: item.courseId,
      dueAt: item.dueAt, action: { label: "Open training", href: `/training?memberProfileId=${memberId}` },
    })];
  });
  const status: ReadinessDimensionStatus = !items.length ? "Not applicable" : factors.some((item) => item.severity === "blocker") ? "Non-compliant" : factors.length ? "Attention" : "Compliant";
  const compliant = items.filter((item) => item.status === "Compliant").length;
  return dimension({
    key: "training", label: "Training", status, state: status === "Compliant" ? "Training current" : status,
    detail: `${compliant} current, ${items.length - compliant} needing attention.`, sourceType: "trainingCompliance", sourceId: memberId,
    factors,
    items: items.map((item) => ({
      courseId: item.courseId, title: item.title, requiredStatus: item.requiredStatus, status: item.status,
      recordStatus: item.recordStatus, dueAt: iso(item.dueAt), expiryAt: iso(item.expiryAt), expiringSoon: item.expiringSoon,
    })),
  });
}

function documentDimension(items: DocumentSnapshotItem[], memberId: string): ReadinessDimension {
  const factors = items.flatMap((item): ReadinessFactor[] => {
    if ((item.status === "Acknowledged" || !item.acknowledgementRequired) && item.contentAvailable) return [];
    const blocking = item.status === "Overdue" || !item.contentAvailable;
    return [factor({
      code: blocking ? "document-not-acknowledged" : "document-needs-acknowledgement", category: "Documents",
      severity: blocking ? "blocker" : "warning", title: blocking ? "Required document not acknowledged" : "Document acknowledgement needed",
      detail: item.contentAvailable ? `${item.title} is ${item.status.toLowerCase()}.` : `${item.title} is not available for acknowledgement.`,
      sourceType: "documentVersion", sourceId: item.documentVersionId, dueAt: item.dueAt,
      action: { label: "Open documents", href: "/documents" },
    })];
  });
  const acknowledged = items.filter((item) => item.status === "Acknowledged").length;
  const status: ReadinessDimensionStatus = !items.length ? "Not applicable" : factors.some((item) => item.severity === "blocker") ? "Non-compliant" : factors.length ? "Attention" : "Compliant";
  return dimension({
    key: "documents", label: "Documents", status, state: status === "Compliant" ? "Documents acknowledged" : status,
    detail: `${acknowledged} acknowledged, ${items.filter((item) => item.acknowledgementRequired && item.status !== "Acknowledged").length} outstanding.`,
    sourceType: "documentCompliance", sourceId: memberId, factors,
    items: items.map((item) => ({
      documentVersionId: item.documentVersionId, title: item.title, status: item.status,
      acknowledgementRequired: item.acknowledgementRequired, contentAvailable: item.contentAvailable,
      dueAt: iso(item.dueAt), acknowledgedAt: iso(item.acknowledgedAt),
    })),
  });
}

const availabilityPriority: Record<string, number> = { Unavailable: 0, Preferred: 1, Available: 2 };

function availabilitySelection(items: AvailabilitySnapshotItem[], at: Date) {
  const active = items.filter((item) => item.startAt <= at && item.endAt > at);
  const candidates = active.length ? active : items;
  return [...candidates].sort((left, right) =>
    (availabilityPriority[left.type] ?? 3) - (availabilityPriority[right.type] ?? 3) ||
    left.startAt.getTime() - right.startAt.getTime() || left.id.localeCompare(right.id)
  )[0] ?? null;
}

function availabilityDimension(items: AvailabilitySnapshotItem[], memberId: string, at: Date): ReadinessDimension {
  const selected = availabilitySelection(items, at);
  const factors: ReadinessFactor[] = [];
  if (!selected) {
    factors.push(factor({
      code: "availability-not-declared", category: "Availability", severity: "warning", title: "Availability not declared",
      detail: "No availability entry was found for the current UTC operating day.", sourceType: "availability", sourceId: memberId,
      action: { label: "Open rostering", href: "/rostering" },
    }));
  } else if (selected.type === "Unavailable") {
    factors.push(factor({
      code: "availability-unavailable", category: "Availability", severity: "warning", title: "Marked unavailable",
      detail: "This member is marked unavailable in the current availability window.", sourceType: "availability", sourceId: selected.id,
      action: { label: "Open rostering", href: "/rostering" },
    }));
  }
  return dimension({
    key: "availability", label: "Availability", status: factors.length ? "Attention" : "Compliant",
    state: selected?.type ?? "No declaration",
    detail: selected ? `${selected.type} from ${selected.startAt.toISOString()} to ${selected.endAt.toISOString()}.` : "No availability entry for the current UTC day.",
    sourceType: "availability", sourceId: selected?.id ?? memberId, factors,
    items: items.map((item) => ({ id: item.id, operationalId: item.operationalId, type: item.type, startAt: item.startAt.toISOString(), endAt: item.endAt.toISOString() })),
  });
}

function rosterDimension(items: RosterSnapshotItem[], memberId: string): ReadinessDimension {
  const shifts = items.filter((item) => !["Cancelled", "Completed"].includes(item.status));
  const next = shifts[0] ?? null;
  const factors: ReadinessFactor[] = [];
  const rosterFactor = (code: string, severity: ReadinessSeverity, title: string, detail: string, dueAt?: Date | null) => factor({
    code, category: "Roster", severity, title, detail, sourceType: "rosterShift", sourceId: next?.id ?? memberId, dueAt,
    action: { label: "Open rostering", href: "/rostering" },
  });
  if (!next) factors.push(rosterFactor("roster-no-upcoming-shift", "info", "No upcoming roster shift", "No active roster shift was found in the next roster window."));
  else if (next.status === "Published") factors.push(rosterFactor("roster-awaiting-confirmation", "warning", "Roster shift awaits confirmation", `${next.operationalId} is published but not yet confirmed.`, next.startAt));
  else if (next.status === "Declined") factors.push(rosterFactor("roster-shift-declined", "warning", "Roster shift declined", `${next.operationalId} has been declined and needs coverage review.`, next.startAt));
  else if (next.status === "Draft") factors.push(rosterFactor("roster-shift-draft", "warning", "Roster shift not published", `${next.operationalId} is still in draft.`, next.startAt));
  return dimension({
    key: "roster", label: "Roster", status: factors.some((item) => item.severity === "warning") ? "Attention" : "Compliant",
    state: next ? `${next.status} shift` : "No upcoming shift",
    detail: next ? `${next.operationalId} starts at ${next.startAt.toISOString()}.` : `No active shift in the next ${readinessPolicy.rosterLookaheadDays} days.`,
    sourceType: "rosterShift", sourceId: next?.id ?? memberId, factors,
    items: shifts.map((item) => ({
      id: item.id, operationalId: item.operationalId, title: item.title, duty: item.duty, functionName: item.functionName,
      startAt: item.startAt.toISOString(), endAt: item.endAt.toISOString(), location: item.location, status: item.status,
    })),
  });
}

function actions(factors: ReadinessFactor[]) {
  const seen = new Set<string>();
  return factors.flatMap((item) => {
    if (!item.action) return [];
    const key = `${item.action.href}:${item.action.label}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ...item.action, reason: item.title, severity: item.severity }];
  }).slice(0, 5);
}

export function evaluateReadiness(snapshot: ReadinessMemberSnapshot, calculatedAt: Date, policy = readinessPolicy): ReadinessAssessment {
  const dimensions = [
    profileDimension(snapshot), trainingDimension(snapshot.training, snapshot.member.id), documentDimension(snapshot.documents, snapshot.member.id),
    availabilityDimension(snapshot.availability, snapshot.member.id, calculatedAt), rosterDimension(snapshot.roster, snapshot.member.id),
  ];
  const factors = dimensions.flatMap((item) => item.factors);
  return {
    member: snapshot.member, calculatedAt: calculatedAt.toISOString(), evaluationMode: policy.evaluationMode,
    overallStatus: overall(dimensions), dimensions,
    blockers: factors.filter((item) => item.severity === "blocker"), warnings: factors.filter((item) => item.severity === "warning"),
    information: factors.filter((item) => item.severity === "info"), nextActions: actions(factors.filter((item) => item.severity !== "info")), policy,
  };
}

export function unlinkedReadiness(calculatedAt: Date, policy = readinessPolicy): ReadinessAssessment {
  const warning = factor({
    code: "member-profile-not-linked", category: "Profile", severity: "warning", title: "Member profile not linked",
    detail: "This account is not linked to a member profile.", sourceType: "memberProfile",
  });
  return {
    member: null, calculatedAt: calculatedAt.toISOString(), evaluationMode: policy.evaluationMode, overallStatus: "Unknown",
    dimensions: [], blockers: [], warnings: [warning], information: [], nextActions: [], policy,
  };
}

export function summarizeReadiness(assessments: ReadinessAssessment[], calculatedAt: Date, policy = readinessPolicy): ReadinessSummary {
  const byStatus: ReadinessSummary["byStatus"] = { Ready: 0, "Ready with attention": 0, "Not ready": 0, Unknown: 0, "Not applicable": 0 };
  const issueCounts: Record<string, number> = {};
  for (const assessment of assessments) {
    byStatus[assessment.overallStatus] += 1;
    for (const item of [...assessment.blockers, ...assessment.warnings]) issueCounts[item.category] = (issueCounts[item.category] ?? 0) + 1;
  }
  return {
    calculatedAt: calculatedAt.toISOString(), evaluationMode: policy.evaluationMode, totalMembers: assessments.length, byStatus, issueCounts,
    needsAction: assessments.filter((item) => ["Not ready", "Ready with attention"].includes(item.overallStatus)).length,
    blocked: byStatus["Not ready"], attention: byStatus["Ready with attention"], ready: byStatus.Ready, policy,
  };
}

export const readinessStatusRank: Record<ReadinessOverallStatus, number> = {
  "Not ready": 0, Unknown: 1, "Ready with attention": 2, "Not applicable": 3, Ready: 4,
};
