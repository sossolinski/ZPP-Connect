import { DirectoryError } from "./member-directory.js";
import type { DirectoryActor, MemberDirectoryRepository } from "./member-directory.js";
import { canAccessGroup, canAccessMember, permissionScope } from "./scope-policy.js";

export type RosterStatus = "Draft" | "Published" | "Confirmed" | "Declined" | "Cancelled" | "Completed";
export type AvailabilityType = "Available" | "Unavailable" | "Preferred";
export type AvailabilityStatus = "Active" | "Removed";

type RosterShiftRecord = {
  id: string;
  operationalId: string;
  sessionId: string;
  groupId?: string | null;
  assignedMemberProfileId?: string | null;
  assignedUserId?: string | null;
  title: string;
  duty: string;
  functionName: string;
  startAt: string;
  endAt: string;
  location: string;
  status: RosterStatus;
  notes?: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdById?: string | null;
  updatedById?: string | null;
};

type AvailabilityRecord = {
  id: string;
  operationalId: string;
  memberProfileId: string;
  startAt: string;
  endAt: string;
  type: AvailabilityType;
  note?: string | null;
  status: AvailabilityStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdById?: string | null;
  updatedById?: string | null;
  removedAt?: string | null;
  removedById?: string | null;
};

type Query = Record<string, unknown>;
type DirectoryMember = ReturnType<MemberDirectoryRepository["lookupMember"]>;
type DirectoryGroup = ReturnType<MemberDirectoryRepository["lookupGroup"]>;

const initialTimestamp = "2026-07-09T09:00:00.000Z";
const rosterStatuses = new Set<RosterStatus>(["Draft", "Published", "Confirmed", "Declined", "Cancelled", "Completed"]);
const activeRosterStatuses = new Set<RosterStatus>(["Draft", "Published", "Confirmed"]);
const availabilityTypes = new Set<AvailabilityType>(["Available", "Unavailable", "Preferred"]);

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

function hasPermission(actor: DirectoryActor, permission: string) {
  return actor.permissions.includes(permission);
}

function canReadAllRoster(actor: DirectoryActor) {
  return permissionScope(actor, "roster:read").global;
}

function canReadOwnRoster(actor: DirectoryActor) {
  return hasPermission(actor, "roster:read-own");
}

function canManageRoster(actor: DirectoryActor) {
  return permissionScope(actor, "roster:create").global || permissionScope(actor, "roster:update").global;
}

function canReadAllAvailability(actor: DirectoryActor) {
  return permissionScope(actor, "availability:read-all").global;
}

function canManageAllAvailability(actor: DirectoryActor) {
  return permissionScope(actor, "availability:manage-all").global;
}

function canUpdateOwnAvailability(actor: DirectoryActor) {
  return hasPermission(actor, "availability:update-own");
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

function assertRange(startAt: string, endAt: string) {
  assert(new Date(endAt).getTime() > new Date(startAt).getTime(), 400, "End time must be after start time.");
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

function overlaps(leftStart: string, leftEnd: string, rightStart: string, rightEnd: string) {
  return new Date(leftStart).getTime() < new Date(rightEnd).getTime() && new Date(leftEnd).getTime() > new Date(rightStart).getTime();
}

function nextId(prefix: string, count: number) {
  return `${prefix}-2026-${String(count).padStart(6, "0")}`;
}

function memberName(member?: DirectoryMember | null) {
  return member?.displayName ?? "Unassigned";
}

function assertActiveMember(directory: MemberDirectoryRepository, id: string) {
  const member = directory.lookupMember(id);
  assert(member.status !== "Archived", 409, "Archived profiles cannot receive new roster or availability entries.");
  return member;
}

function assertUsableGroup(directory: MemberDirectoryRepository, id: string) {
  const group = directory.lookupGroup(id);
  assert(group.status !== "Archived", 409, "Archived groups cannot receive new roster shifts.");
  return group;
}

function normalizeStatus(value: unknown, fallback?: RosterStatus) {
  const status = asString(value, fallback);
  assert(rosterStatuses.has(status as RosterStatus), 400, "Roster status is invalid.");
  return status as RosterStatus;
}

function normalizeAvailabilityType(value: unknown, fallback?: AvailabilityType) {
  const type = asString(value, fallback);
  assert(availabilityTypes.has(type as AvailabilityType), 400, "Availability type is invalid.");
  return type as AvailabilityType;
}

function transitionAllowed(from: RosterStatus, to: RosterStatus) {
  const transitions: Record<RosterStatus, RosterStatus[]> = {
    Draft: ["Published", "Cancelled"],
    Published: ["Confirmed", "Declined", "Cancelled"],
    Confirmed: ["Cancelled", "Completed"],
    Declined: ["Cancelled"],
    Cancelled: [],
    Completed: []
  };
  return transitions[from].includes(to);
}

function sortByStart(left: RosterShiftRecord, right: RosterShiftRecord) {
  return new Date(left.startAt).getTime() - new Date(right.startAt).getTime() || left.operationalId.localeCompare(right.operationalId);
}

function sortAvailability(left: AvailabilityRecord, right: AvailabilityRecord) {
  return new Date(left.startAt).getTime() - new Date(right.startAt).getTime() || left.operationalId.localeCompare(right.operationalId);
}

function buildShiftWarnings(shift: RosterShiftRecord, shifts: RosterShiftRecord[], availability: AvailabilityRecord[]) {
  const warnings: string[] = [];
  if (!shift.assignedMemberProfileId && activeRosterStatuses.has(shift.status)) warnings.push("No assigned member");
  if (shift.assignedMemberProfileId) {
    const conflict = shifts.find(
      (candidate) =>
        candidate.id !== shift.id &&
        candidate.assignedMemberProfileId === shift.assignedMemberProfileId &&
        activeRosterStatuses.has(candidate.status) &&
        overlaps(shift.startAt, shift.endAt, candidate.startAt, candidate.endAt)
    );
    if (conflict) warnings.push(`Overlaps ${conflict.operationalId}`);
    const unavailable = availability.find(
      (candidate) =>
        candidate.memberProfileId === shift.assignedMemberProfileId &&
        candidate.status === "Active" &&
        candidate.type === "Unavailable" &&
        overlaps(shift.startAt, shift.endAt, candidate.startAt, candidate.endAt)
    );
    if (unavailable) warnings.push(`Unavailable during ${unavailable.operationalId}`);
  }
  return warnings;
}

export function createRosteringRepository(directory: MemberDirectoryRepository) {
  let shiftCounter = 6;
  let availabilityCounter = 4;
  const shifts: RosterShiftRecord[] = [
    {
      id: "rst-2026-000001",
      operationalId: "RST-001",
      sessionId: "ses-demo-1",
      groupId: "grp-2026-000001",
      assignedMemberProfileId: "mem-2026-000003",
      assignedUserId: null,
      title: "Family Assistance Centre morning support",
      duty: "Family support desk",
      functionName: "Family Assistance Team",
      startAt: "2026-07-13T04:00:00.000Z",
      endAt: "2026-07-13T12:00:00.000Z",
      location: "Family Assistance Centre",
      status: "Published",
      notes: "Confirm readiness before the morning handover.",
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000004",
      updatedById: "00000000-0000-4000-8000-000000000004"
    },
    {
      id: "rst-2026-000002",
      operationalId: "RST-002",
      sessionId: "ses-demo-1",
      groupId: "grp-2026-000004",
      assignedMemberProfileId: "mem-2026-000008",
      assignedUserId: "00000000-0000-4000-8000-000000000005",
      title: "Documentation Cell afternoon support",
      duty: "Record review",
      functionName: "Documentation Support",
      startAt: "2026-07-13T12:00:00.000Z",
      endAt: "2026-07-13T20:00:00.000Z",
      location: "Remote support",
      status: "Published",
      notes: "Review assigned notes and confirm availability.",
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000004",
      updatedById: "00000000-0000-4000-8000-000000000004"
    },
    {
      id: "rst-2026-000003",
      operationalId: "RST-003",
      sessionId: "ses-demo-1",
      groupId: "grp-2026-000002",
      assignedMemberProfileId: "mem-2026-000002",
      assignedUserId: "00000000-0000-4000-8000-000000000003",
      title: "Telephone Enquiry Center evening supervisor",
      duty: "TEC supervision",
      functionName: "Telephone Enquiry Center",
      startAt: "2026-07-13T10:00:00.000Z",
      endAt: "2026-07-13T18:00:00.000Z",
      location: "Hybrid",
      status: "Confirmed",
      notes: "Supervisor confirmed for the evening handover.",
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000004",
      updatedById: "00000000-0000-4000-8000-000000000004"
    },
    {
      id: "rst-2026-000004",
      operationalId: "RST-004",
      sessionId: "ses-demo-1",
      groupId: "grp-2026-000003",
      assignedMemberProfileId: "mem-2026-000005",
      assignedUserId: null,
      title: "Welfare Support reserve shift",
      duty: "Reserve coverage",
      functionName: "Welfare Support",
      startAt: "2026-07-14T06:00:00.000Z",
      endAt: "2026-07-14T14:00:00.000Z",
      location: "On-site",
      status: "Cancelled",
      notes: "Cancelled after coverage plan changed.",
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000004",
      updatedById: "00000000-0000-4000-8000-000000000004"
    },
    {
      id: "rst-2026-000005",
      operationalId: "RST-005",
      sessionId: "ses-demo-1",
      groupId: "grp-2026-000001",
      assignedMemberProfileId: "mem-2026-000001",
      assignedUserId: "00000000-0000-4000-8000-000000000004",
      title: "Family Assistance initial briefing",
      duty: "Briefing support",
      functionName: "Family Assistance Team",
      startAt: "2026-07-08T06:00:00.000Z",
      endAt: "2026-07-08T08:00:00.000Z",
      location: "Command room",
      status: "Completed",
      notes: "Briefing completed.",
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000004",
      updatedById: "00000000-0000-4000-8000-000000000004"
    },
    {
      id: "rst-2026-000006",
      operationalId: "RST-006",
      sessionId: "ses-demo-1",
      groupId: "grp-2026-000003",
      assignedMemberProfileId: null,
      assignedUserId: null,
      title: "Airport Reception Support cover",
      duty: "Reception support",
      functionName: "Airport Reception Support",
      startAt: "2026-07-15T04:00:00.000Z",
      endAt: "2026-07-15T12:00:00.000Z",
      location: "Airport desk",
      status: "Draft",
      notes: "Assign a trained member before publishing.",
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000004",
      updatedById: "00000000-0000-4000-8000-000000000004"
    }
  ];

  const availability: AvailabilityRecord[] = [
    {
      id: "avl-2026-000001",
      operationalId: "AVL-001",
      memberProfileId: "mem-2026-000008",
      startAt: "2026-07-13T12:00:00.000Z",
      endAt: "2026-07-13T20:00:00.000Z",
      type: "Available",
      note: "Can support documentation work remotely.",
      status: "Active",
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000005",
      updatedById: "00000000-0000-4000-8000-000000000005"
    },
    {
      id: "avl-2026-000002",
      operationalId: "AVL-002",
      memberProfileId: "mem-2026-000005",
      startAt: "2026-07-14T05:00:00.000Z",
      endAt: "2026-07-14T13:00:00.000Z",
      type: "Unavailable",
      note: "Unavailable during this window.",
      status: "Active",
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000004",
      updatedById: "00000000-0000-4000-8000-000000000004"
    },
    {
      id: "avl-2026-000003",
      operationalId: "AVL-003",
      memberProfileId: "mem-2026-000006",
      startAt: "2026-07-15T04:00:00.000Z",
      endAt: "2026-07-15T12:00:00.000Z",
      type: "Preferred",
      note: "Prefers airport reception support.",
      status: "Active",
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000004",
      updatedById: "00000000-0000-4000-8000-000000000004"
    },
    {
      id: "avl-2026-000004",
      operationalId: "AVL-004",
      memberProfileId: "mem-2026-000002",
      startAt: "2026-07-13T10:00:00.000Z",
      endAt: "2026-07-13T18:00:00.000Z",
      type: "Available",
      note: "TEC supervisor available for hybrid duty.",
      status: "Active",
      version: 1,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000003",
      updatedById: "00000000-0000-4000-8000-000000000003"
    }
  ];

  function linkedMember(actor: DirectoryActor) {
    return directory.resolveMemberForUser(actor.id);
  }

  function canAccessShift(actor: DirectoryActor, permission: string, shift: RosterShiftRecord) {
    const scope = permissionScope(actor, permission);
    if (!scope.allowed) return false;
    if (scope.global) return true;
    if (shift.groupId) return scope.groupIds.has(shift.groupId);
    return Boolean(shift.assignedMemberProfileId && directory.groupIdsForMember(shift.assignedMemberProfileId).some((groupId) => scope.groupIds.has(groupId)));
  }

  function canAccessAvailability(actor: DirectoryActor, permission: string, memberProfileId: string) {
    return canAccessMember(actor, permission, directory, memberProfileId);
  }

  function visibleRosterShift(shift: RosterShiftRecord, actor: DirectoryActor) {
    const assignee = shift.assignedMemberProfileId ? directory.lookupMember(shift.assignedMemberProfileId) : null;
    const group = shift.groupId ? directory.lookupGroup(shift.groupId) : null;
    const userLinkedMember = linkedMember(actor);
    const canActOnOwn = Boolean(userLinkedMember && shift.assignedMemberProfileId === userLinkedMember.id);
    return {
      ...shift,
      assignedMember: assignee
        ? {
            id: assignee.id,
            memberId: assignee.memberId,
            displayName: assignee.displayName,
            pool: assignee.pool,
            role: assignee.role,
            status: assignee.status
          }
        : null,
      group: group
        ? {
            id: group.id,
            operationalId: group.operationalId,
            name: group.name,
            functionName: group.functionName,
            status: group.status
          }
        : null,
      conflictWarnings: buildShiftWarnings(shift, shifts, availability),
      permissions: {
        canUpdate: canAccessShift(actor, "roster:update", shift),
        canPublish: canAccessShift(actor, "roster:publish", shift) && shift.status === "Draft",
        canCancel: canAccessShift(actor, "roster:cancel", shift) && transitionAllowed(shift.status, "Cancelled"),
        canComplete: canAccessShift(actor, "roster:complete", shift) && transitionAllowed(shift.status, "Completed"),
        canConfirm: transitionAllowed(shift.status, "Confirmed") && (canAccessShift(actor, "roster:update", shift) || (canActOnOwn && hasPermission(actor, "roster:confirm-own"))),
        canDecline: transitionAllowed(shift.status, "Declined") && (canAccessShift(actor, "roster:update", shift) || (canActOnOwn && hasPermission(actor, "roster:decline-own")))
      }
    };
  }

  function assertRosterVisible(shift: RosterShiftRecord, actor: DirectoryActor) {
    if (canAccessShift(actor, "roster:read", shift)) return;
    const member = linkedMember(actor);
    assert(canReadOwnRoster(actor), 403, "Forbidden");
    assert(member && shift.assignedMemberProfileId === member.id, 403, "Forbidden");
  }

  function assertRosterManager(actor: DirectoryActor, permission: string, shift?: RosterShiftRecord) {
    if (shift) {
      assert(canAccessShift(actor, permission, shift), 403, "Forbidden");
      return;
    }
    assert(permissionScope(actor, permission).allowed, 403, "Forbidden");
  }

  function assertCanActOnOwn(shift: RosterShiftRecord, actor: DirectoryActor, permission: string) {
    if (canAccessShift(actor, "roster:update", shift)) return;
    assert(hasPermission(actor, permission), 403, "Forbidden");
    const member = linkedMember(actor);
    assert(member, 409, "No linked member profile is available for this action.");
    assert(shift.assignedMemberProfileId === member.id, 403, "Forbidden");
  }

  function assertNoAssignmentConflict(input: { id?: string; assignedMemberProfileId?: string | null; startAt: string; endAt: string }) {
    if (!input.assignedMemberProfileId) return;
    const overlappingShift = shifts.find(
      (candidate) =>
        candidate.id !== input.id &&
        candidate.assignedMemberProfileId === input.assignedMemberProfileId &&
        activeRosterStatuses.has(candidate.status) &&
        overlaps(input.startAt, input.endAt, candidate.startAt, candidate.endAt)
    );
    assert(!overlappingShift, 409, `This member already has an overlapping shift (${overlappingShift?.operationalId}).`);
    const unavailable = availability.find(
      (candidate) =>
        candidate.memberProfileId === input.assignedMemberProfileId &&
        candidate.status === "Active" &&
        candidate.type === "Unavailable" &&
        overlaps(input.startAt, input.endAt, candidate.startAt, candidate.endAt)
    );
    assert(!unavailable, 409, `This member is unavailable during ${unavailable?.operationalId}.`);
  }

  function assertNoAvailabilityConflict(input: { id?: string; memberProfileId: string; startAt: string; endAt: string }) {
    const conflict = availability.find(
      (candidate) =>
        candidate.id !== input.id &&
        candidate.status === "Active" &&
        candidate.memberProfileId === input.memberProfileId &&
        overlaps(input.startAt, input.endAt, candidate.startAt, candidate.endAt)
    );
    assert(!conflict, 409, `Availability overlaps ${conflict?.operationalId}.`);
  }

  function visibleAvailability(record: AvailabilityRecord, actor: DirectoryActor) {
    const member = directory.lookupMember(record.memberProfileId);
    return {
      ...record,
      member: {
        id: member.id,
        memberId: member.memberId,
        displayName: member.displayName,
        pool: member.pool,
        role: member.role,
        assignedFunction: member.assignedFunction,
        status: member.status
      },
      permissions: {
        canUpdate: canAccessAvailability(actor, "availability:manage-all", record.memberProfileId) || (linkedMember(actor)?.id === record.memberProfileId && canUpdateOwnAvailability(actor)),
        canRemove: canAccessAvailability(actor, "availability:manage-all", record.memberProfileId) || (linkedMember(actor)?.id === record.memberProfileId && canUpdateOwnAvailability(actor))
      }
    };
  }

  function assertAvailabilityVisible(record: AvailabilityRecord, actor: DirectoryActor) {
    if (canAccessAvailability(actor, "availability:read-all", record.memberProfileId)) return;
    const member = linkedMember(actor);
    assert(hasPermission(actor, "availability:read-own"), 403, "Forbidden");
    assert(member && record.memberProfileId === member.id, 403, "Forbidden");
  }

  function mutableAvailabilityMember(body: Query, actor: DirectoryActor) {
    if (permissionScope(actor, "availability:manage-all").allowed) {
      const requested = asString(body.memberProfileId);
      assert(requested, 400, "Member profile is required.");
      assert(canAccessAvailability(actor, "availability:manage-all", requested), 403, "Forbidden");
      return assertActiveMember(directory, requested).id;
    }
    assert(canUpdateOwnAvailability(actor), 403, "Forbidden");
    const member = linkedMember(actor);
    assert(member, 409, "No linked member profile is available for this action.");
    assertActiveMember(directory, member.id);
    return member.id;
  }

  function touch<T extends { version: number; updatedAt: string; updatedById?: string | null }>(record: T, actor: DirectoryActor) {
    record.version += 1;
    record.updatedAt = new Date().toISOString();
    record.updatedById = actor.id;
  }

  function assertFresh(record: { updatedAt: string }, body: Query) {
    const expected = asString(body.expectedUpdatedAt ?? body.updatedAt);
    if (expected) assert(expected === record.updatedAt, 409, "This record changed. Reload it before saving.");
  }

  function assertTransition(shift: RosterShiftRecord, next: RosterStatus) {
    assert(transitionAllowed(shift.status, next), 409, `${shift.status} cannot move to ${next}.`);
  }

  function findShift(id: string) {
    const shift = shifts.find((candidate) => candidate.id === id);
    assert(shift, 404, "Roster shift not found.");
    return shift;
  }

  function findAvailability(id: string) {
    const record = availability.find((candidate) => candidate.id === id && candidate.status !== "Removed");
    assert(record, 404, "Availability record not found.");
    return record;
  }

  return {
    linkedMember,

    listShifts(query: Query, actor: DirectoryActor) {
      assert(permissionScope(actor, "roster:read").allowed || canReadOwnRoster(actor), 403, "Forbidden");
      const sessionId = optionalString(query.sessionId);
      const status = optionalString(query.status);
      const groupId = optionalString(query.groupId);
      const memberProfileId = optionalString(query.memberProfileId);
      const startFrom = optionalString(query.startFrom ?? query.from);
      const startTo = optionalString(query.startTo ?? query.to);
      const mine = String(query.mine ?? "").toLowerCase() === "true";
      const member = linkedMember(actor);

      if (mine && !member) {
        return page([], query, { linkedMemberProfile: null });
      }
      const filtered = shifts
        .filter((shift) => !sessionId || shift.sessionId === sessionId)
        .filter((shift) => !status || shift.status === status)
        .filter((shift) => !groupId || shift.groupId === groupId)
        .filter((shift) => !memberProfileId || shift.assignedMemberProfileId === memberProfileId)
        .filter((shift) => !startFrom || new Date(shift.endAt).getTime() >= new Date(startFrom).getTime())
        .filter((shift) => !startTo || new Date(shift.startAt).getTime() <= new Date(startTo).getTime())
        .filter((shift) => mine
          ? shift.assignedMemberProfileId === member?.id
          : canAccessShift(actor, "roster:read", shift) || (canReadOwnRoster(actor) && shift.assignedMemberProfileId === member?.id))
        .sort(sortByStart);
      return page(filtered.map((shift) => visibleRosterShift(shift, actor)), query, { linkedMemberProfile: member });
    },

    getShift(id: string, actor: DirectoryActor) {
      const shift = findShift(id);
      assertRosterVisible(shift, actor);
      return visibleRosterShift(shift, actor);
    },

    createShift(body: Query, actor: DirectoryActor) {
      assertRosterManager(actor, "roster:create");
      const title = asString(body.title ?? body.duty);
      assert(title, 400, "Shift title is required.");
      const functionName = asString(body.functionName);
      assert(functionName, 400, "Function is required.");
      const startAt = parseDate(body.startAt, "Start time");
      const endAt = parseDate(body.endAt, "End time");
      assertRange(startAt, endAt);
      const groupId = optionalString(body.groupId);
      const createScope = permissionScope(actor, "roster:create");
      assert(createScope.global || (groupId && canAccessGroup(actor, "roster:create", groupId)), 403, "A permitted group is required.");
      if (groupId) assertUsableGroup(directory, groupId);
      const assignedMemberProfileId = optionalString(body.assignedMemberProfileId);
      if (assignedMemberProfileId) assert(canAccessMember(actor, "member:read", directory, assignedMemberProfileId), 403, "Forbidden");
      const assignedMember = assignedMemberProfileId ? assertActiveMember(directory, assignedMemberProfileId) : null;
      assertNoAssignmentConflict({ assignedMemberProfileId, startAt, endAt });
      const nowValue = new Date().toISOString();
      const shift: RosterShiftRecord = {
        id: nextId("rst", ++shiftCounter),
        operationalId: `RST-${String(shiftCounter).padStart(3, "0")}`,
        sessionId: asString(body.sessionId),
        groupId,
        assignedMemberProfileId,
        assignedUserId: assignedMember?.linkedUserId ?? null,
        title,
        duty: asString(body.duty, title),
        functionName,
        startAt,
        endAt,
        location: asString(body.location, "Not set"),
        status: "Draft",
        notes: optionalString(body.notes),
        version: 1,
        createdAt: nowValue,
        updatedAt: nowValue,
        createdById: actor.id,
        updatedById: actor.id
      };
      assert(shift.sessionId, 400, "Session is required.");
      shifts.push(shift);
      return visibleRosterShift(shift, actor);
    },

    updateShift(id: string, body: Query, actor: DirectoryActor) {
      const shift = findShift(id);
      assertRosterManager(actor, "roster:update", shift);
      assertFresh(shift, body);
      assert(!("status" in body) || normalizeStatus(body.status, shift.status) === shift.status, 400, "Use the dedicated roster action for status changes.");
      assert(!["Cancelled", "Completed"].includes(shift.status), 409, `${shift.status} shifts are read-only.`);
      const startAt = body.startAt === undefined ? shift.startAt : parseDate(body.startAt, "Start time");
      const endAt = body.endAt === undefined ? shift.endAt : parseDate(body.endAt, "End time");
      assertRange(startAt, endAt);
      const groupId = body.groupId === undefined ? shift.groupId ?? null : optionalString(body.groupId);
      if (groupId) {
        assert(canAccessGroup(actor, "roster:update", groupId), 403, "Forbidden");
        assertUsableGroup(directory, groupId);
      }
      const assignedMemberProfileId = body.assignedMemberProfileId === undefined ? shift.assignedMemberProfileId ?? null : optionalString(body.assignedMemberProfileId);
      if (assignedMemberProfileId) assert(canAccessMember(actor, "member:read", directory, assignedMemberProfileId), 403, "Forbidden");
      const assignedMember = assignedMemberProfileId ? assertActiveMember(directory, assignedMemberProfileId) : null;
      assertNoAssignmentConflict({ id: shift.id, assignedMemberProfileId, startAt, endAt });

      Object.assign(shift, {
        groupId,
        assignedMemberProfileId,
        assignedUserId: assignedMember?.linkedUserId ?? null,
        title: asString(body.title, shift.title),
        duty: asString(body.duty, shift.duty),
        functionName: asString(body.functionName, shift.functionName),
        startAt,
        endAt,
        location: asString(body.location, shift.location),
        notes: optionalString(body.notes ?? shift.notes)
      });
      touch(shift, actor);
      return visibleRosterShift(shift, actor);
    },

    moveShift(id: string, nextStatus: RosterStatus, actor: DirectoryActor, note?: unknown) {
      const shift = findShift(id);
      if (nextStatus === "Published") assertRosterManager(actor, "roster:publish", shift);
      else if (nextStatus === "Cancelled") assertRosterManager(actor, "roster:cancel", shift);
      else if (nextStatus === "Completed") assertRosterManager(actor, "roster:complete", shift);
      else if (nextStatus === "Confirmed") assertCanActOnOwn(shift, actor, "roster:confirm-own");
      else if (nextStatus === "Declined") assertCanActOnOwn(shift, actor, "roster:decline-own");
      assertTransition(shift, nextStatus);
      if (nextStatus === "Published") assertNoAssignmentConflict({ id: shift.id, assignedMemberProfileId: shift.assignedMemberProfileId, startAt: shift.startAt, endAt: shift.endAt });
      shift.status = nextStatus;
      const nextNote = optionalString(note);
      if (nextNote) shift.notes = shift.notes ? `${shift.notes}\n${nextNote}` : nextNote;
      touch(shift, actor);
      return visibleRosterShift(shift, actor);
    },

    listAvailability(query: Query, actor: DirectoryActor) {
      assert(permissionScope(actor, "availability:read-all").allowed || hasPermission(actor, "availability:read-own"), 403, "Forbidden");
      const member = linkedMember(actor);
      const memberProfileId = optionalString(query.memberProfileId);
      const type = optionalString(query.type);
      const startFrom = optionalString(query.startFrom ?? query.from);
      const startTo = optionalString(query.startTo ?? query.to);
      if (!permissionScope(actor, "availability:read-all").allowed) {
        if (!member) return page([], query, { linkedMemberProfile: null });
        if (memberProfileId) assert(memberProfileId === member.id, 403, "Forbidden");
      } else if (memberProfileId) {
        assert(canAccessAvailability(actor, "availability:read-all", memberProfileId), 403, "Forbidden");
      }
      const filtered = availability
        .filter((record) => record.status === "Active")
        .filter((record) => !memberProfileId || record.memberProfileId === memberProfileId)
        .filter((record) => canAccessAvailability(actor, "availability:read-all", record.memberProfileId) || (hasPermission(actor, "availability:read-own") && record.memberProfileId === member?.id))
        .filter((record) => !type || record.type === type)
        .filter((record) => !startFrom || new Date(record.endAt).getTime() >= new Date(startFrom).getTime())
        .filter((record) => !startTo || new Date(record.startAt).getTime() <= new Date(startTo).getTime())
        .sort(sortAvailability);
      return page(filtered.map((record) => visibleAvailability(record, actor)), query, { linkedMemberProfile: member });
    },

    getAvailability(id: string, actor: DirectoryActor) {
      const record = findAvailability(id);
      assertAvailabilityVisible(record, actor);
      return visibleAvailability(record, actor);
    },

    createAvailability(body: Query, actor: DirectoryActor) {
      const memberProfileId = mutableAvailabilityMember(body, actor);
      const startAt = parseDate(body.startAt, "Start time");
      const endAt = parseDate(body.endAt, "End time");
      assertRange(startAt, endAt);
      const type = normalizeAvailabilityType(body.type, "Available");
      assertNoAvailabilityConflict({ memberProfileId, startAt, endAt });
      const nowValue = new Date().toISOString();
      const record: AvailabilityRecord = {
        id: nextId("avl", ++availabilityCounter),
        operationalId: `AVL-${String(availabilityCounter).padStart(3, "0")}`,
        memberProfileId,
        startAt,
        endAt,
        type,
        note: optionalString(body.note),
        status: "Active",
        version: 1,
        createdAt: nowValue,
        updatedAt: nowValue,
        createdById: actor.id,
        updatedById: actor.id
      };
      availability.push(record);
      return visibleAvailability(record, actor);
    },

    updateAvailability(id: string, body: Query, actor: DirectoryActor) {
      const record = findAvailability(id);
      assertAvailabilityVisible(record, actor);
      const linked = linkedMember(actor);
      assert(canAccessAvailability(actor, "availability:manage-all", record.memberProfileId) || (linked?.id === record.memberProfileId && canUpdateOwnAvailability(actor)), 403, "Forbidden");
      assertFresh(record, body);
      const memberProfileId = body.memberProfileId === undefined ? record.memberProfileId : mutableAvailabilityMember(body, actor);
      const startAt = body.startAt === undefined ? record.startAt : parseDate(body.startAt, "Start time");
      const endAt = body.endAt === undefined ? record.endAt : parseDate(body.endAt, "End time");
      assertRange(startAt, endAt);
      assertActiveMember(directory, memberProfileId);
      assertNoAvailabilityConflict({ id: record.id, memberProfileId, startAt, endAt });
      Object.assign(record, {
        memberProfileId,
        startAt,
        endAt,
        type: normalizeAvailabilityType(body.type, record.type),
        note: optionalString(body.note ?? record.note)
      });
      touch(record, actor);
      return visibleAvailability(record, actor);
    },

    removeAvailability(id: string, actor: DirectoryActor) {
      const record = findAvailability(id);
      assertAvailabilityVisible(record, actor);
      const linked = linkedMember(actor);
      assert(canAccessAvailability(actor, "availability:manage-all", record.memberProfileId) || (linked?.id === record.memberProfileId && canUpdateOwnAvailability(actor)), 403, "Forbidden");
      record.status = "Removed";
      record.removedAt = new Date().toISOString();
      record.removedById = actor.id;
      touch(record, actor);
      return visibleAvailability(record, actor);
    }
  };
}

export type RosteringRepository = ReturnType<typeof createRosteringRepository>;
