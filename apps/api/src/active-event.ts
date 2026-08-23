export type ActiveEventActor = {
  id: string;
  email: string;
  displayName?: string | null;
  roles: string[];
  permissions: string[];
};

export type ActiveEventRow = Record<string, any>;
export type BriefingStatus = "Draft" | "Published" | "Superseded";
export type PriorityStatus = "Not started" | "In progress" | "Completed" | "Blocked";
export type RiskSeverity = "Information" | "Attention" | "Critical";
export type AssignmentAccessState = "Available" | "Restricted" | "Missing" | "Unavailable";

export class ActiveEventError extends HttpError {
  constructor(status: number, message: string) {
    super(status, message);
  }
}

type BriefingFact = {
  id: string;
  statement: string;
  source: string;
  sourceResourceType?: string | null;
  sourceResourceId?: string | null;
  confirmedAt?: string | null;
  createdAt: string;
  createdById: string;
};

type BriefingUnconfirmedItem = {
  id: string;
  statement: string;
  source: string;
  verificationStatus: string;
  owner?: string | null;
  reviewDueAt?: string | null;
  createdAt: string;
  createdById: string;
};

type BriefingPriority = {
  id: string;
  description: string;
  order: number;
  status: PriorityStatus;
  responsible?: string | null;
  linkedAssignmentId?: string | null;
  dueAt?: string | null;
};

type AssignmentProjection = {
  id: string;
  operationalId?: string | null;
  title?: string | null;
  status?: string | null;
  priority?: string | null;
  assignedUserId?: string | null;
  assignedUserDisplayName?: string | null;
  dueAt?: string | null;
  updatedAt?: string | null;
  accessState: AssignmentAccessState;
  contextLabel: string;
  detailHref?: string | null;
};

type BriefingRisk = {
  id: string;
  description: string;
  severity: RiskSeverity;
  owner?: string | null;
  mitigation?: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

type BriefingCoordinationNote = {
  id: string;
  note: string;
  functionName?: string | null;
  createdAt: string;
  createdById: string;
};

export type OperationalBriefing = {
  id: string;
  sessionId: string;
  revision: number;
  status: BriefingStatus;
  title: string;
  situationSummary: string;
  overview: string;
  confirmedFacts: BriefingFact[];
  unconfirmedInformation: BriefingUnconfirmedItem[];
  priorities: BriefingPriority[];
  risks: BriefingRisk[];
  coordinationNotes: BriefingCoordinationNote[];
  nextUpdateDueAt?: string | null;
  createdAt: string;
  updatedAt: string;
  createdById: string;
  updatedById: string;
  publishedAt?: string | null;
  publishedById?: string | null;
  supersededAt?: string | null;
  version: number;
};

type ActiveEventSources = {
  users: ActiveEventRow[];
  sessions: ActiveEventRow[];
  assignments: ActiveEventRow[];
  enquiries: ActiveEventRow[];
  familyRecords: ActiveEventRow[];
  passengerRecords: ActiveEventRow[];
  matchingRecords: ActiveEventRow[];
  releases: ActiveEventRow[];
  requests: ActiveEventRow[];
};

type UpdateDraftInput = Partial<Pick<OperationalBriefing, "title" | "situationSummary" | "overview" | "nextUpdateDueAt">> & {
  expectedVersion?: number;
  confirmedFacts?: Array<Partial<BriefingFact>>;
  unconfirmedInformation?: Array<Partial<BriefingUnconfirmedItem>>;
  priorities?: Array<Partial<BriefingPriority>>;
  risks?: Array<Partial<BriefingRisk>>;
  coordinationNotes?: Array<Partial<BriefingCoordinationNote>>;
};

const terminalAssignmentStatuses = new Set(["Completed", "Cancelled"]);
const terminalRequestStatuses = new Set(["Closed", "Cancelled"]);
const terminalReleaseStatuses = new Set(["Completed", "Cancelled"]);

function now() {
  return new Date().toISOString();
}

function assert(condition: unknown, status: number, message: string): asserts condition {
  if (!condition) throw new ActiveEventError(status, message);
}

function hasPermission(actor: ActiveEventActor, permission: string) {
  return actor.permissions.includes(permission);
}

function sessionClosed(session: ActiveEventRow) {
  return ["Closed", "Archived"].includes(String(session.status));
}

function stableItemId(prefix: string, briefing: OperationalBriefing, index: number, existing?: string | null) {
  return existing || `${briefing.id}-${prefix}-${String(index + 1).padStart(2, "0")}`;
}

function requireVersion(record: OperationalBriefing, expectedVersion: unknown) {
  const parsed = Number(expectedVersion);
  assert(Number.isInteger(parsed), 400, "Expected version is required");
  assert(parsed === record.version, 409, "Briefing has changed. Reload before saving.");
}

function plainText(value: unknown, fallback = "") {
  return String(value ?? fallback).trim();
}

function optionalIso(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  const date = new Date(String(value));
  assert(!Number.isNaN(date.getTime()), 400, "Timestamp is invalid");
  return date.toISOString();
}

function actorName(actor: ActiveEventActor) {
  return actor.displayName || actor.email;
}

function cloneBriefing(record: OperationalBriefing): OperationalBriefing {
  return {
    ...record,
    confirmedFacts: record.confirmedFacts.map((item) => ({ ...item })),
    unconfirmedInformation: record.unconfirmedInformation.map((item) => ({ ...item })),
    priorities: record.priorities.map((item) => ({ ...item })),
    risks: record.risks.map((item) => ({ ...item })),
    coordinationNotes: record.coordinationNotes.map((item) => ({ ...item }))
  };
}

function cloneForDraft(record: OperationalBriefing, revision: number, actor: ActiveEventActor): OperationalBriefing {
  const timestamp = now();
  const draft: OperationalBriefing = {
    ...cloneBriefing(record),
    id: `brf-${record.sessionId}-r${revision}`,
    revision,
    status: "Draft",
    createdAt: timestamp,
    updatedAt: timestamp,
    createdById: actor.id,
    updatedById: actor.id,
    publishedAt: null,
    publishedById: null,
    supersededAt: null,
    version: 1
  };
  draft.confirmedFacts = draft.confirmedFacts.map((item, index) => ({ ...item, id: stableItemId("fact", draft, index, null) }));
  draft.unconfirmedInformation = draft.unconfirmedInformation.map((item, index) => ({ ...item, id: stableItemId("unconfirmed", draft, index, null) }));
  draft.priorities = draft.priorities.map((item, index) => ({ ...item, id: stableItemId("priority", draft, index, null), order: index + 1 }));
  draft.risks = draft.risks.map((item, index) => ({ ...item, id: stableItemId("risk", draft, index, null), updatedAt: timestamp }));
  draft.coordinationNotes = draft.coordinationNotes.map((item, index) => ({ ...item, id: stableItemId("note", draft, index, null) }));
  return draft;
}

function blankDraft(sessionId: string, revision: number, actor: ActiveEventActor): OperationalBriefing {
  const timestamp = now();
  return {
    id: `brf-${sessionId}-r${revision}`,
    sessionId,
    revision,
    status: "Draft",
    title: "Draft briefing",
    situationSummary: "",
    overview: "",
    confirmedFacts: [],
    unconfirmedInformation: [],
    priorities: [],
    risks: [],
    coordinationNotes: [],
    nextUpdateDueAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    createdById: actor.id,
    updatedById: actor.id,
    publishedAt: null,
    publishedById: null,
    supersededAt: null,
    version: 1
  };
}

function seededBriefings(): OperationalBriefing[] {
  const publishedAt = "2026-06-21T09:45:00.000Z";
  const coordinatorId = "00000000-0000-4000-8000-000000000002";
  const zppId = "00000000-0000-4000-8000-000000000004";
  const ses1: OperationalBriefing = {
    id: "brf-ses-demo-1-r1",
    sessionId: "ses-demo-1",
    revision: 1,
    status: "Published",
    title: "Current operational briefing",
    situationSummary: "EXERCISE session is active for ZPP coordination training. Telephone enquiry intake, family support, matching review and roster coverage are operating under exercise conditions.",
    overview: "Training scenario for flight LO3924 KRK-WAW. No passenger or casualty status may be disclosed from TEC intake or family support workflows.",
    confirmedFacts: [
      {
        id: "brf-ses-demo-1-r1-fact-01",
        statement: "Session SES-2026-001 is active in EXERCISE mode.",
        source: "Session control",
        sourceResourceType: "session",
        sourceResourceId: "ses-demo-1",
        confirmedAt: "2026-06-21T08:00:00.000Z",
        createdAt: publishedAt,
        createdById: coordinatorId
      },
      {
        id: "brf-ses-demo-1-r1-fact-02",
        statement: "TEC enquiry intake is open for the exercise and must not confirm protected passenger status.",
        source: "TEC operating rule",
        sourceResourceType: "enquiry",
        sourceResourceId: "enq-demo-1",
        confirmedAt: publishedAt,
        createdAt: publishedAt,
        createdById: coordinatorId
      }
    ],
    unconfirmedInformation: [
      {
        id: "brf-ses-demo-1-r1-unconfirmed-01",
        statement: "Family relationship verification remains pending for the active hold.",
        source: "Matching review",
        verificationStatus: "Needs verification",
        owner: "Family Assistance",
        reviewDueAt: "2026-06-21T11:00:00.000Z",
        createdAt: publishedAt,
        createdById: coordinatorId
      }
    ],
    priorities: [
      {
        id: "brf-ses-demo-1-r1-priority-01",
        description: "Read this briefing before handling operational work.",
        order: 1,
        status: "In progress",
        responsible: "All active response roles"
      },
      {
        id: "brf-ses-demo-1-r1-priority-02",
        description: "Verify the restricted case before first outbound contact.",
        order: 2,
        status: "In progress",
        responsible: "ZPP Coordinator",
        linkedAssignmentId: "asn-demo-3",
        dueAt: "2026-06-21T10:30:00.000Z"
      },
      {
        id: "brf-ses-demo-1-r1-priority-03",
        description: "Confirm TEC evening coverage for the operating period.",
        order: 3,
        status: "Not started",
        responsible: "ZPP Group Leader",
        linkedAssignmentId: "asn-demo-2",
        dueAt: "2026-06-21T13:00:00.000Z"
      },
      {
        id: "brf-ses-demo-1-r1-priority-04",
        description: "Prepare the welfare room briefing note for handover.",
        order: 4,
        status: "Not started",
        responsible: "Member support",
        linkedAssignmentId: "asn-demo-1",
        dueAt: "2026-06-21T12:00:00.000Z"
      }
    ],
    risks: [
      {
        id: "brf-ses-demo-1-r1-risk-01",
        description: "Identity verification hold remains active before any disclosure or release workflow.",
        severity: "Attention",
        owner: "Family Assistance",
        mitigation: "Coordinator review is required before first contact.",
        status: "Open",
        createdAt: publishedAt,
        updatedAt: publishedAt
      }
    ],
    coordinationNotes: [
      {
        id: "brf-ses-demo-1-r1-note-01",
        note: "Use anonymized family references in broad operational views.",
        functionName: "Information handling",
        createdAt: publishedAt,
        createdById: coordinatorId
      },
      {
        id: "brf-ses-demo-1-r1-note-02",
        note: "No release of sensitive data without coordinator approval.",
        functionName: "Controlled disclosure",
        createdAt: publishedAt,
        createdById: coordinatorId
      }
    ],
    nextUpdateDueAt: "2026-06-21T14:00:00.000Z",
    createdAt: "2026-06-21T09:20:00.000Z",
    updatedAt: publishedAt,
    createdById: coordinatorId,
    updatedById: coordinatorId,
    publishedAt,
    publishedById: coordinatorId,
    supersededAt: null,
    version: 1
  };

  const ses2Published = {
    ...cloneBriefing(ses1),
    id: "brf-ses-demo-2-r1",
    sessionId: "ses-demo-2",
    revision: 1,
    title: "Training briefing",
    situationSummary: "TRAINING session is prepared for briefing practice and role familiarization.",
    overview: "Training context only. Participants should practice reading the current briefing before taking module actions.",
    publishedAt: "2026-06-20T10:00:00.000Z",
    publishedById: zppId,
    createdById: zppId,
    updatedById: zppId,
    createdAt: "2026-06-20T09:40:00.000Z",
    updatedAt: "2026-06-20T10:00:00.000Z",
    version: 1
  };
  const ses2Draft = cloneForDraft(ses2Published, 2, {
    id: zppId,
    email: "zpp@lot.pl",
    displayName: "ZPP Group Leader",
    roles: ["zpp-group-leader"],
    permissions: []
  });
  ses2Draft.title = "Draft training briefing update";
  ses2Draft.situationSummary = "TRAINING session is ready for a refreshed briefing practice round.";
  ses2Draft.updatedAt = "2026-06-20T11:00:00.000Z";
  ses2Draft.version = 2;

  return [ses1, ses2Published, ses2Draft];
}

function normalizeFacts(input: Array<Partial<BriefingFact>> | undefined, briefing: OperationalBriefing, actor: ActiveEventActor) {
  if (input === undefined) return briefing.confirmedFacts;
  return input.flatMap<BriefingFact>((item, index) => {
      const statement = plainText(item.statement);
      if (!statement) return [];
      return [{
        id: stableItemId("fact", briefing, index, item.id),
        statement,
        source: plainText(item.source, "Operational briefing"),
        sourceResourceType: item.sourceResourceType ?? null,
        sourceResourceId: item.sourceResourceId ?? null,
        confirmedAt: optionalIso(item.confirmedAt ?? now()),
        createdAt: item.createdAt ?? now(),
        createdById: item.createdById ?? actor.id
      }];
    });
}

function normalizeUnconfirmed(input: Array<Partial<BriefingUnconfirmedItem>> | undefined, briefing: OperationalBriefing, actor: ActiveEventActor) {
  if (input === undefined) return briefing.unconfirmedInformation;
  return input.flatMap<BriefingUnconfirmedItem>((item, index) => {
      const statement = plainText(item.statement);
      if (!statement) return [];
      return [{
        id: stableItemId("unconfirmed", briefing, index, item.id),
        statement,
        source: plainText(item.source, "Operational briefing"),
        verificationStatus: plainText(item.verificationStatus, "Needs verification"),
        owner: item.owner ? plainText(item.owner) : null,
        reviewDueAt: optionalIso(item.reviewDueAt),
        createdAt: item.createdAt ?? now(),
        createdById: item.createdById ?? actor.id
      }];
    });
}

function normalizePriorities(input: Array<Partial<BriefingPriority>> | undefined, briefing: OperationalBriefing, sources: ActiveEventSources, actor: ActiveEventActor) {
  if (input === undefined) return briefing.priorities;
  const statuses = new Set<PriorityStatus>(["Not started", "In progress", "Completed", "Blocked"]);
  return input.flatMap<BriefingPriority>((item, index) => {
    const description = plainText(item.description);
    if (!description) return [];
    const linkedAssignmentId = item.linkedAssignmentId ? plainText(item.linkedAssignmentId) : null;
    if (linkedAssignmentId) validateLinkedAssignmentReference(linkedAssignmentId, briefing, sources, actor, "update");
    return [{
      id: stableItemId("priority", briefing, index, item.id),
      description,
      order: index + 1,
      status: statuses.has(item.status as PriorityStatus) ? item.status as PriorityStatus : "Not started",
      responsible: item.responsible ? plainText(item.responsible) : null,
      linkedAssignmentId,
      dueAt: optionalIso(item.dueAt)
    }];
  });
}

function assignmentRelationChanges(before: OperationalBriefing, after: OperationalBriefing, timestamp = now()) {
  const changes: Array<{
    changeType: "linked" | "changed" | "unlinked";
    priorityId: string;
    oldAssignmentId: string | null;
    newAssignmentId: string | null;
    timestamp: string;
  }> = [];
  const beforeById = new Map(before.priorities.map((item) => [item.id, item]));
  const afterById = new Map(after.priorities.map((item) => [item.id, item]));

  for (const priority of after.priorities) {
    const previous = beforeById.get(priority.id);
    const oldAssignmentId = previous?.linkedAssignmentId ?? null;
    const newAssignmentId = priority.linkedAssignmentId ?? null;
    if (oldAssignmentId === newAssignmentId) continue;
    changes.push({
      changeType: oldAssignmentId && newAssignmentId ? "changed" : newAssignmentId ? "linked" : "unlinked",
      priorityId: priority.id,
      oldAssignmentId,
      newAssignmentId,
      timestamp
    });
  }

  for (const priority of before.priorities) {
    if (!priority.linkedAssignmentId || afterById.has(priority.id)) continue;
    changes.push({
      changeType: "unlinked",
      priorityId: priority.id,
      oldAssignmentId: priority.linkedAssignmentId,
      newAssignmentId: null,
      timestamp
    });
  }

  return changes;
}

function normalizeRisks(input: Array<Partial<BriefingRisk>> | undefined, briefing: OperationalBriefing) {
  if (input === undefined) return briefing.risks;
  const severities = new Set<RiskSeverity>(["Information", "Attention", "Critical"]);
  const timestamp = now();
  return input.flatMap<BriefingRisk>((item, index) => {
      const description = plainText(item.description);
      if (!description) return [];
      return [{
        id: stableItemId("risk", briefing, index, item.id),
        description,
        severity: severities.has(item.severity as RiskSeverity) ? item.severity as RiskSeverity : "Attention",
        owner: item.owner ? plainText(item.owner) : null,
        mitigation: item.mitigation ? plainText(item.mitigation) : null,
        status: plainText(item.status, "Open"),
        createdAt: item.createdAt ?? timestamp,
        updatedAt: timestamp
      }];
    });
}

function normalizeNotes(input: Array<Partial<BriefingCoordinationNote>> | undefined, briefing: OperationalBriefing, actor: ActiveEventActor) {
  if (input === undefined) return briefing.coordinationNotes;
  return input.flatMap<BriefingCoordinationNote>((item, index) => {
      const note = plainText(item.note);
      if (!note) return [];
      return [{
        id: stableItemId("note", briefing, index, item.id),
        note,
        functionName: item.functionName ? plainText(item.functionName) : null,
        createdAt: item.createdAt ?? now(),
        createdById: item.createdById ?? actor.id
      }];
    });
}

function summarizeChanges(before: OperationalBriefing, after: OperationalBriefing) {
  const sections = [
    ["title", before.title, after.title],
    ["situationSummary", before.situationSummary, after.situationSummary],
    ["overview", before.overview, after.overview],
    ["confirmedFacts", before.confirmedFacts.length, after.confirmedFacts.length],
    ["unconfirmedInformation", before.unconfirmedInformation.length, after.unconfirmedInformation.length],
    ["priorities", before.priorities.length, after.priorities.length],
    ["risks", before.risks.length, after.risks.length],
    ["coordinationNotes", before.coordinationNotes.length, after.coordinationNotes.length],
    ["nextUpdateDueAt", before.nextUpdateDueAt ?? "", after.nextUpdateDueAt ?? ""]
  ];
  return sections.filter(([, oldValue, newValue]) => oldValue !== newValue).map(([section]) => section);
}

function actorSummary(actor: ActiveEventActor) {
  return {
    userId: actor.id,
    id: actor.id,
    email: actor.email,
    displayName: actorName(actor),
    roles: actor.roles
  };
}

function metric(label: string, value: number | null, href?: string) {
  return { label, value, status: value === null ? "unavailable" : "available", href };
}

function buildMetrics(sessionId: string, sources: ActiveEventSources, actor: ActiveEventActor) {
  const result = [];
  if (hasPermission(actor, "assignment:read")) {
    result.push(metric("Open assignments", sources.assignments.filter((item) => item.sessionId === sessionId && !terminalAssignmentStatuses.has(String(item.status))).length, "/assignments"));
  }
  if (hasPermission(actor, "enquiry:read")) {
    result.push(metric("Unresolved TEC enquiries", sources.enquiries.filter((item) => item.sessionId === sessionId && !terminalRequestStatuses.has(String(item.status))).length, "/tec-intake"));
  }
  if (hasPermission(actor, "matching:read")) {
    result.push(metric("Active holds", sources.matchingRecords.filter((item) => item.sessionId === sessionId && (String(item.status) === "Hold / escalate" || String(item.holdCheck ?? "No hold") !== "No hold")).length, "/matching"));
  }
  if (hasPermission(actor, "request:read")) {
    result.push(metric("Open support requests", sources.requests.filter((item) => item.sessionId === sessionId && !terminalRequestStatuses.has(String(item.status))).length, "/requests"));
  }
  if (hasPermission(actor, "release:read")) {
    result.push(metric("Pending release actions", sources.releases.filter((item) => item.sessionId === sessionId && !terminalReleaseStatuses.has(String(item.status))).length, "/release-control"));
  }
  if (hasPermission(actor, "passenger:read") && hasPermission(actor, "matching:read")) {
    const matchedPassengerIds = new Set(sources.matchingRecords.filter((item) => item.sessionId === sessionId && ["Verified match", "Reunited", "Released"].includes(String(item.status))).map((item) => item.passengerRecordId).filter(Boolean));
    result.push(metric("Passenger records needing match review", sources.passengerRecords.filter((item) => item.sessionId === sessionId && !matchedPassengerIds.has(item.id)).length, "/passenger-src"));
  }
  return result;
}

function assignmentContext(assignmentId: string | null | undefined, sources: ActiveEventSources) {
  if (!assignmentId) return null;
  const assignment = sources.assignments.find((item) => item.id === assignmentId);
  return assignment ? { ...assignment } : null;
}

function isAssignmentManager(actor: ActiveEventActor) {
  return hasPermission(actor, "assignment:assign");
}

function canReadAssignmentProjection(assignment: ActiveEventRow, actor: ActiveEventActor) {
  if (!hasPermission(actor, "assignment:read")) return false;
  if (isAssignmentManager(actor)) return true;
  if (assignment.assignedUserId && assignment.assignedUserId === actor.id) return true;
  return false;
}

function assignmentContextLabel(status?: string | null) {
  if (status === "Completed") return "Linked task completed";
  if (status === "Cancelled") return "Linked task needs attention";
  if (status === "In Progress" || status === "Escalated") return "Linked task in progress";
  if (status === "Open") return "Linked task pending";
  return "Linked task current";
}

function assignmentProjection(assignmentId: string, assignment: ActiveEventRow | undefined, sessionId: string, actor: ActiveEventActor): AssignmentProjection {
  if (!assignment) return { id: assignmentId, accessState: "Missing", contextLabel: "Linked assignment missing" };
  if (assignment.sessionId !== sessionId) return { id: assignmentId, accessState: "Missing", contextLabel: "Linked assignment missing" };
  if (!canReadAssignmentProjection(assignment, actor)) {
    return { id: assignmentId, accessState: "Restricted", contextLabel: "Assignment details restricted" };
  }
  const assignedUserId = assignment.assignedUserId ?? null;
  const assignedUserDisplayName = assignment.assignedUserDisplayName ?? assignment.ownerAssignedTo ?? null;
  return {
    id: assignment.id,
    operationalId: assignment.operationalId ?? null,
    title: assignment.title ?? null,
    status: assignment.status ?? null,
    priority: assignment.priority ?? null,
    assignedUserId,
    assignedUserDisplayName,
    dueAt: assignment.dueAt ?? null,
    updatedAt: assignment.updatedAt ?? null,
    accessState: "Available",
    contextLabel: assignmentContextLabel(assignment.status),
    detailHref: `/assignments?assignmentId=${encodeURIComponent(assignment.id)}`
  };
}

function assignmentProjectionMap(priorities: BriefingPriority[], sessionId: string, sources: ActiveEventSources, actor: ActiveEventActor) {
  const ids = Array.from(new Set(priorities.map((item) => item.linkedAssignmentId).filter(Boolean))) as string[];
  const result = new Map<string, AssignmentProjection>();
  if (!ids.length) return result;
  try {
    const idSet = new Set(ids);
    const assignmentsById = new Map(sources.assignments.filter((item) => idSet.has(item.id)).map((item) => [item.id, item]));
    for (const id of ids) result.set(id, assignmentProjection(id, assignmentsById.get(id), sessionId, actor));
  } catch {
    for (const id of ids) {
      result.set(id, { id, accessState: "Unavailable", contextLabel: "Assignment details unavailable" });
    }
  }
  return result;
}

function prioritiesWithAssignments(priorities: BriefingPriority[], sessionId: string, sources: ActiveEventSources, actor: ActiveEventActor) {
  const projections = assignmentProjectionMap(priorities, sessionId, sources, actor);
  return priorities.map((priority) => ({
    ...priority,
    assignment: priority.linkedAssignmentId ? projections.get(priority.linkedAssignmentId) ?? { id: priority.linkedAssignmentId, accessState: "Unavailable", contextLabel: "Assignment details unavailable" } : null
  }));
}

function validateLinkedAssignmentReference(assignmentId: string, briefing: OperationalBriefing, sources: ActiveEventSources, actor: ActiveEventActor, operation: "update" | "publish") {
  const assignment = assignmentContext(assignmentId, sources);
  assert(assignment, 400, "Linked assignment does not exist");
  assert(assignment.sessionId === briefing.sessionId, 409, "Linked assignment belongs to a different session");
  assert(operation === "publish" || canReadAssignmentProjection(assignment, actor), 403, "Assignment is not available to link");
  if (operation === "publish") return assignment;
  return assignment;
}

function buildNextActions(sessionId: string, briefing: OperationalBriefing | null, sources: ActiveEventSources, actor: ActiveEventActor, activeDraft: OperationalBriefing | null) {
  const actions: Array<{ id: string; title: string; detail: string; href: string; actionLabel: string; source: string }> = [];
  if (hasPermission(actor, "assignment:read")) {
    const ownAssignment = sources.assignments.find((item) => item.sessionId === sessionId && item.assignedUserId === actor.id && !terminalAssignmentStatuses.has(String(item.status)));
    if (ownAssignment) {
      actions.push({
        id: `assignment-${ownAssignment.id}`,
        title: String(ownAssignment.title),
        detail: `Assignment ${ownAssignment.operationalId} is ${ownAssignment.status}.`,
        href: "/assignments",
        actionLabel: "Open assignments",
        source: "Assignment"
      });
    }
  }
  if (activeDraft && (hasPermission(actor, "briefing:update-draft") || hasPermission(actor, "briefing:publish"))) {
    actions.push({
      id: `draft-${activeDraft.id}`,
      title: "Review draft briefing update",
      detail: "A draft exists and is not yet published.",
      href: "/active-event",
      actionLabel: "Open draft",
      source: "Briefing"
    });
  }
  if (briefing) {
    actions.push({
      id: `briefing-${briefing.id}`,
      title: "Read the current briefing",
      detail: "Use the published briefing before taking operational work.",
      href: "/active-event",
      actionLabel: "Read briefing",
      source: "Briefing"
    });
  }
  return actions;
}

export function createActiveEventService(sources: ActiveEventSources) {
  const briefings = seededBriefings();

  function sessionById(sessionId: string) {
    const session = sources.sessions.find((item) => item.id === sessionId);
    assert(session, 404, "Session not found");
    return session;
  }

  function revisionsForSession(sessionId: string) {
    return briefings.filter((item) => item.sessionId === sessionId).sort((first, second) => second.revision - first.revision);
  }

  function currentPublished(sessionId: string) {
    const published = revisionsForSession(sessionId).filter((item) => item.status === "Published");
    return published.sort((first, second) => second.revision - first.revision)[0] ?? null;
  }

  function activeDraft(sessionId: string) {
    return revisionsForSession(sessionId).find((item) => item.status === "Draft") ?? null;
  }

  function byId(briefingId: string) {
    return briefings.find((item) => item.id === briefingId) ?? null;
  }

  function securityMetadataForBriefing(briefingId: string) {
    const record = byId(briefingId);
    assert(record, 404, "Briefing not found");
    return { sessionId: record.sessionId, status: record.status };
  }

  function assertRead(actor: ActiveEventActor) {
    assert(hasPermission(actor, "briefing:read"), 403, "Forbidden");
  }

  function assertHistory(actor: ActiveEventActor) {
    assert(hasPermission(actor, "briefing:read-history"), 403, "Forbidden");
  }

  function assertCreateDraft(actor: ActiveEventActor) {
    assert(hasPermission(actor, "briefing:create-draft"), 403, "Forbidden");
  }

  function assertUpdateDraft(actor: ActiveEventActor) {
    assert(hasPermission(actor, "briefing:update-draft"), 403, "Forbidden");
  }

  function assertPublish(actor: ActiveEventActor) {
    assert(hasPermission(actor, "briefing:publish"), 403, "Forbidden");
  }

  function serialize(record: OperationalBriefing, actor?: ActiveEventActor) {
    return {
      ...cloneBriefing(record),
      createdBy: actor ? undefined : undefined,
      updatedBy: actor ? undefined : undefined
    };
  }

  function getActiveEvent(sessionId: string, actor: ActiveEventActor) {
    assertRead(actor);
    const session = sessionById(sessionId);
    const published = currentPublished(sessionId);
    const draft = activeDraft(sessionId);
    const canSeeDraft = hasPermission(actor, "briefing:update-draft") || hasPermission(actor, "briefing:create-draft") || hasPermission(actor, "briefing:read-history");
    const canSeeHistory = hasPermission(actor, "briefing:read-history");
    const metrics = buildMetrics(sessionId, sources, actor);
    return {
      session,
      currentBriefing: published ? {
        ...serialize(published),
        priorities: prioritiesWithAssignments(published.priorities, sessionId, sources, actor),
        publishedBy: published.publishedById ? actorSummary(userActor(published.publishedById)) : null
      } : null,
      draft: canSeeDraft && draft ? {
        id: draft.id,
        revision: draft.revision,
        status: draft.status,
        title: draft.title,
        updatedAt: draft.updatedAt,
        updatedById: draft.updatedById,
        version: draft.version
      } : null,
      metrics,
      nextActions: buildNextActions(sessionId, published, sources, actor, canSeeDraft ? draft : null),
      permissions: {
        canReadHistory: canSeeHistory,
        canCreateDraft: hasPermission(actor, "briefing:create-draft") && !sessionClosed(session),
        canUpdateDraft: hasPermission(actor, "briefing:update-draft") && Boolean(draft) && !sessionClosed(session),
        canPublish: hasPermission(actor, "briefing:publish") && Boolean(draft) && !sessionClosed(session)
      },
      history: canSeeHistory ? revisionsForSession(sessionId).map((item) => ({
        id: item.id,
        revision: item.revision,
        status: item.status,
        title: item.title,
        updatedAt: item.updatedAt,
        publishedAt: item.publishedAt,
        version: item.version
      })) : undefined,
      warnings: metrics.some((item) => item.status === "unavailable") ? ["Unable to load supporting data"] : []
    };
  }

  function userActor(userId: string): ActiveEventActor {
    const user = sources.users.find((item) => item.id === userId);
    return {
      id: userId,
      email: user?.email ?? "",
      displayName: user?.displayName ?? userId,
      roles: Array.isArray(user?.roles) ? user.roles : [],
      permissions: []
    };
  }

  function listRevisions(sessionId: string, actor: ActiveEventActor) {
    assertHistory(actor);
    sessionById(sessionId);
    return { total: revisionsForSession(sessionId).length, data: revisionsForSession(sessionId).map((item) => serialize(item)) };
  }

  function getCurrent(sessionId: string, actor: ActiveEventActor) {
    assertRead(actor);
    sessionById(sessionId);
    const published = currentPublished(sessionId);
    assert(published, 404, "No published briefing");
    return serialize(published);
  }

  function getBriefing(briefingId: string, actor: ActiveEventActor) {
    assertRead(actor);
    const record = byId(briefingId);
    assert(record, 404, "Briefing not found");
    if (record.status !== "Published") assertHistory(actor);
    return serialize(record);
  }

  function createDraft(sessionId: string, actor: ActiveEventActor) {
    assertCreateDraft(actor);
    const session = sessionById(sessionId);
    assert(!sessionClosed(session), 409, "Closed sessions cannot receive briefing drafts");
    const existing = activeDraft(sessionId);
    if (existing) return { briefing: serialize(existing), created: false };
    const revisions = revisionsForSession(sessionId);
    const revision = Math.max(0, ...revisions.map((item) => item.revision)) + 1;
    const current = currentPublished(sessionId);
    const draft = current ? cloneForDraft(current, revision, actor) : blankDraft(sessionId, revision, actor);
    briefings.push(draft);
    return { briefing: serialize(draft), created: true };
  }

  function updateDraft(briefingId: string, input: UpdateDraftInput, actor: ActiveEventActor) {
    assertUpdateDraft(actor);
    const record = byId(briefingId);
    assert(record, 404, "Briefing not found");
    assert(record.status === "Draft", 409, "Only draft briefings can be edited");
    const session = sessionById(record.sessionId);
    assert(!sessionClosed(session), 409, "Closed sessions cannot receive briefing updates");
    const disallowed = ["status", "sessionId", "revision", "publishedAt", "publishedById", "supersededAt", "createdById", "updatedById"].filter((key) => key in (input as Record<string, unknown>));
    assert(disallowed.length === 0, 400, "Briefing status and session fields cannot be changed here");
    requireVersion(record, input.expectedVersion);
    const before = cloneBriefing(record);
    const nextTitle = input.title !== undefined ? plainText(input.title, "Draft briefing") : record.title;
    const nextSituationSummary = input.situationSummary !== undefined ? plainText(input.situationSummary) : record.situationSummary;
    const nextOverview = input.overview !== undefined ? plainText(input.overview) : record.overview;
    const nextUpdateDueAt = input.nextUpdateDueAt !== undefined ? optionalIso(input.nextUpdateDueAt) : record.nextUpdateDueAt;
    const nextConfirmedFacts = normalizeFacts(input.confirmedFacts, record, actor);
    const nextUnconfirmedInformation = normalizeUnconfirmed(input.unconfirmedInformation, record, actor);
    const nextPriorities = normalizePriorities(input.priorities, record, sources, actor);
    const nextRisks = normalizeRisks(input.risks, record);
    const nextCoordinationNotes = normalizeNotes(input.coordinationNotes, record, actor);
    record.title = nextTitle;
    record.situationSummary = nextSituationSummary;
    record.overview = nextOverview;
    record.nextUpdateDueAt = nextUpdateDueAt;
    record.confirmedFacts = nextConfirmedFacts;
    record.unconfirmedInformation = nextUnconfirmedInformation;
    record.priorities = nextPriorities;
    record.risks = nextRisks;
    record.coordinationNotes = nextCoordinationNotes;
    record.updatedAt = now();
    record.updatedById = actor.id;
    record.version += 1;
    return { briefing: serialize(record), changedSections: summarizeChanges(before, record), assignmentRelationChanges: assignmentRelationChanges(before, record) };
  }

  function publishDraft(briefingId: string, expectedVersion: unknown, actor: ActiveEventActor) {
    assertPublish(actor);
    const record = byId(briefingId);
    assert(record, 404, "Briefing not found");
    assert(record.status === "Draft", 409, "Only draft briefings can be published");
    requireVersion(record, expectedVersion);
    const session = sessionById(record.sessionId);
    assert(!sessionClosed(session), 409, "Closed sessions cannot publish briefing updates");
    assert(plainText(record.situationSummary), 400, "Situation summary is required before publishing");
    assert(record.priorities.length > 0, 400, "At least one operational priority is required before publishing");
    for (const priority of record.priorities) {
      if (!priority.linkedAssignmentId) continue;
      validateLinkedAssignmentReference(priority.linkedAssignmentId, record, sources, actor, "publish");
    }
    const timestamp = now();
    const previous = currentPublished(record.sessionId);
    if (previous) {
      previous.status = "Superseded";
      previous.supersededAt = timestamp;
      previous.updatedAt = timestamp;
      previous.updatedById = actor.id;
      previous.version += 1;
    }
    record.status = "Published";
    record.publishedAt = timestamp;
    record.publishedById = actor.id;
    record.updatedAt = timestamp;
    record.updatedById = actor.id;
    record.version += 1;
    return { briefing: serialize(record), superseded: previous ? serialize(previous) : null };
  }

  return {
    kind: "memory" as const,
    securityMetadataForBriefing,
    getActiveEvent,
    listRevisions,
    getCurrent,
    getBriefing,
    createDraft,
    updateDraft,
    publishDraft
  };
}
import { HttpError } from "./errors.js";
