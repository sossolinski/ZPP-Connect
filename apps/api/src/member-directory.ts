import { canAccessGroup, permissionScope } from "./scope-policy.js";

export type DirectoryUser = {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
};

export type DirectoryActor = DirectoryUser & {
  permissions: string[];
  roleAssignments?: Array<{
    roleName: string;
    scopeType: "GLOBAL" | "GROUP";
    scopeId?: string | null;
    status: string;
    permissions?: string[];
  }>;
};

export type DirectoryQuery = Record<string, unknown>;

export class DirectoryError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type MemberProfileStatus = "Active" | "Inactive" | "Archived";
export type MemberPool = "ZPP" | "TEC";

export type MemberProfileRecord = {
  id: string;
  memberId: string;
  linkedUserId?: string | null;
  firstName: string;
  lastName: string;
  displayName: string;
  pool: MemberPool;
  role: string;
  availability: string;
  contactEmail?: string | null;
  phone?: string | null;
  languages: string[];
  trainingStatus: string;
  assignedFunction: string;
  rosterStatus: string;
  assignedLeader?: string | null;
  status: MemberProfileStatus;
  createdAt: string;
  updatedAt: string;
  createdById?: string | null;
  updatedById?: string | null;
};

export type GroupStatus = "Active" | "Standby" | "Draft" | "Archived";
export type GroupPool = MemberPool | "Mixed";

export type GroupRecord = {
  id: string;
  operationalId: string;
  sessionId?: string | null;
  name: string;
  pool: GroupPool;
  functionName: string;
  status: GroupStatus;
  leaderId?: string | null;
  rosterShiftIds: string[];
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
  createdById?: string | null;
  updatedById?: string | null;
};

export type GroupMembershipRecord = {
  id: string;
  groupId: string;
  memberProfileId: string;
  role: string;
  createdAt: string;
  updatedAt: string;
  createdById?: string | null;
  updatedById?: string | null;
  archivedAt?: string | null;
};

const initialTimestamp = "2026-07-09T09:00:00.000Z";
const memberPools = new Set<MemberPool>(["ZPP", "TEC"]);
const groupPools = new Set<GroupPool>(["ZPP", "TEC", "Mixed"]);
const memberStatuses = new Set<MemberProfileStatus>(["Active", "Inactive", "Archived"]);
const groupStatuses = new Set<GroupStatus>(["Active", "Standby", "Draft", "Archived"]);

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

function normalize(value: unknown) {
  return asString(value).toLowerCase();
}

function uniqueStrings(values: unknown, fallback: string[] = []) {
  if (!Array.isArray(values)) return [...fallback];
  return Array.from(new Set(values.map((value) => asString(value)).filter(Boolean)));
}

function pageQuery(query: DirectoryQuery) {
  const limit = Math.min(Math.max(Math.trunc(asNumber(query.limit, 50)), 1), 200);
  const offset = Math.max(Math.trunc(asNumber(query.offset, 0)), 0);
  return { limit, offset };
}

function page<T>(data: T[], query: DirectoryQuery) {
  const { limit, offset } = pageQuery(query);
  return { total: data.length, limit, offset, data: data.slice(offset, offset + limit) };
}

function assert(condition: unknown, status: number, message: string): asserts condition {
  if (!condition) throw new DirectoryError(status, message);
}

function fullName(firstName: string, lastName: string) {
  return [firstName, lastName].map((part) => part.trim()).filter(Boolean).join(" ");
}

function memberNameFromBody(body: DirectoryQuery, existing?: MemberProfileRecord) {
  const displayName = asString(body.displayName);
  const firstName = asString(body.firstName, existing?.firstName ?? displayName.split(/\s+/)[0] ?? "");
  const lastName = asString(body.lastName, existing?.lastName ?? displayName.split(/\s+/).slice(1).join(" ") ?? "");
  const name = displayName || fullName(firstName, lastName) || existing?.displayName;
  assert(name, 400, "Member name is required.");
  return {
    firstName: firstName || name.split(/\s+/)[0] || "",
    lastName: lastName || name.split(/\s+/).slice(1).join(" "),
    displayName: name
  };
}

function canSeeMemberContact(actor?: DirectoryActor) {
  const permissions = new Set(actor?.permissions ?? []);
  return permissions.has("member:update") || permissions.has("member:create") || permissions.has("admin:manage");
}

function cloneMember(member: MemberProfileRecord, actor?: DirectoryActor) {
  const includeContact = canSeeMemberContact(actor);
  return {
    id: member.id,
    memberId: member.memberId,
    volunteerId: member.memberId,
    linkedUserId: includeContact ? member.linkedUserId ?? null : undefined,
    firstName: member.firstName,
    lastName: member.lastName,
    displayName: member.displayName,
    pool: member.pool,
    role: member.role,
    availability: member.availability,
    contactEmail: includeContact ? member.contactEmail ?? null : undefined,
    phone: includeContact ? member.phone ?? null : undefined,
    languages: [...member.languages],
    trainingStatus: member.trainingStatus,
    assignedFunction: member.assignedFunction,
    rosterStatus: member.rosterStatus,
    assignedLeader: member.assignedLeader ?? null,
    status: member.status,
    createdAt: member.createdAt,
    updatedAt: member.updatedAt
  };
}

function cloneGroup(group: GroupRecord, memberships: GroupMembershipRecord[], members: MemberProfileRecord[]) {
  const activeMemberships = memberships.filter((membership) => membership.groupId === group.id && !membership.archivedAt);
  const memberIds = activeMemberships.map((membership) => membership.memberProfileId);
  const memberById = new Map(members.map((member) => [member.id, member]));
  const leader = group.leaderId ? memberById.get(group.leaderId) : undefined;

  return {
    id: group.id,
    operationalId: group.operationalId,
    sessionId: group.sessionId ?? null,
    name: group.name,
    pool: group.pool,
    functionName: group.functionName,
    status: group.status,
    leaderId: group.leaderId ?? "",
    leaderName: leader?.displayName ?? "",
    leaderMemberId: leader?.memberId ?? "",
    memberIds,
    memberCount: memberIds.length,
    rosterShiftIds: [...group.rosterShiftIds],
    rosterLinkCount: group.rosterShiftIds.length,
    notes: group.notes ?? "",
    createdAt: group.createdAt,
    updatedAt: group.updatedAt
  };
}

function rosterMemberSummary(member: MemberProfileRecord) {
  return {
    id: member.id,
    memberId: member.memberId,
    volunteerId: member.memberId,
    linkedUserId: member.linkedUserId ?? null,
    displayName: member.displayName,
    pool: member.pool,
    role: member.role,
    assignedFunction: member.assignedFunction,
    rosterStatus: member.rosterStatus,
    status: member.status
  };
}

export function createMemberDirectoryRepository(users: DirectoryUser[]) {
  const members: MemberProfileRecord[] = [
    {
      id: "mem-2026-000001",
      memberId: "ZPP-001",
      linkedUserId: "00000000-0000-4000-8000-000000000004",
      firstName: "Anna",
      lastName: "Kowalska",
      displayName: "Anna Kowalska",
      pool: "ZPP",
      role: "Family Assistance Lead",
      availability: "Today 06:00-14:00",
      contactEmail: "anna.kowalska@lot.pl",
      phone: "+48 600 100 001",
      languages: ["PL", "EN"],
      trainingStatus: "Confirmed",
      assignedFunction: "Family Assistance Team",
      rosterStatus: "Confirmed",
      assignedLeader: "ZPP Coordinator",
      status: "Active",
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000001",
      updatedById: "00000000-0000-4000-8000-000000000001"
    },
    {
      id: "mem-2026-000002",
      memberId: "TEC-001",
      linkedUserId: "00000000-0000-4000-8000-000000000003",
      firstName: "Piotr",
      lastName: "Nowak",
      displayName: "Piotr Nowak",
      pool: "TEC",
      role: "TEC Supervisor",
      availability: "Today 12:00-20:00",
      contactEmail: "piotr.nowak@lot.pl",
      phone: "+48 600 200 001",
      languages: ["PL", "EN"],
      trainingStatus: "Confirmed",
      assignedFunction: "Telephone Enquiry Center",
      rosterStatus: "Confirmed",
      assignedLeader: "Leader Bravo",
      status: "Active",
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
      createdById: "00000000-0000-4000-8000-000000000001",
      updatedById: "00000000-0000-4000-8000-000000000001"
    },
    {
      id: "mem-2026-000003",
      memberId: "ZPP-006",
      firstName: "Marta",
      lastName: "Zielinska",
      displayName: "Marta Zielinska",
      pool: "ZPP",
      role: "Family Assistance Member",
      availability: "Today 06:00-14:00",
      contactEmail: "marta.zielinska@lot.pl",
      phone: "+48 600 100 006",
      languages: ["PL", "EN"],
      trainingStatus: "Confirmed",
      assignedFunction: "Family Assistance Team",
      rosterStatus: "Confirmed",
      assignedLeader: "Leader Alpha",
      status: "Active",
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp
    },
    {
      id: "mem-2026-000004",
      memberId: "ZPP-012",
      firstName: "Monika",
      lastName: "Wozniak",
      displayName: "Monika Wozniak",
      pool: "ZPP",
      role: "Family Assistance Member",
      availability: "Today 06:00-14:00",
      contactEmail: "monika.wozniak@lot.pl",
      phone: "+48 600 100 012",
      languages: ["PL"],
      trainingStatus: "Pending",
      assignedFunction: "Family Assistance Team",
      rosterStatus: "Pending",
      assignedLeader: "Leader Alpha",
      status: "Active",
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp
    },
    {
      id: "mem-2026-000005",
      memberId: "ZPP-018",
      firstName: "Ewa",
      lastName: "Lewandowska",
      displayName: "Ewa Lewandowska",
      pool: "ZPP",
      role: "Welfare Support",
      availability: "Today 06:00-14:00",
      contactEmail: "ewa.lewandowska@lot.pl",
      phone: "+48 600 100 018",
      languages: ["PL", "UA"],
      trainingStatus: "Confirmed",
      assignedFunction: "Welfare Support",
      rosterStatus: "Available",
      assignedLeader: "Leader Echo",
      status: "Active",
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp
    },
    {
      id: "mem-2026-000006",
      memberId: "ZPP-024",
      firstName: "Agnieszka",
      lastName: "Kaczmarek",
      displayName: "Agnieszka Kaczmarek",
      pool: "ZPP",
      role: "Welfare Support",
      availability: "Tomorrow 06:00-14:00",
      contactEmail: "agnieszka.kaczmarek@lot.pl",
      phone: "+48 600 100 024",
      languages: ["PL", "EN"],
      trainingStatus: "Confirmed",
      assignedFunction: "Welfare Support",
      rosterStatus: "Available",
      assignedLeader: "Leader Echo",
      status: "Active",
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp
    },
    {
      id: "mem-2026-000007",
      memberId: "ZPP-030",
      firstName: "Magdalena",
      lastName: "Jankowska",
      displayName: "Magdalena Jankowska",
      pool: "ZPP",
      role: "Family Assistance Member",
      availability: "Today 06:00-14:00",
      contactEmail: "magdalena.jankowska@lot.pl",
      phone: "+48 600 100 030",
      languages: ["PL"],
      trainingStatus: "Restricted",
      assignedFunction: "Family Assistance Team",
      rosterStatus: "Confirmed",
      assignedLeader: "Leader Alpha",
      status: "Active",
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp
    },
    {
      id: "mem-2026-000008",
      memberId: "ZPP-221",
      linkedUserId: "00000000-0000-4000-8000-000000000005",
      firstName: "Adam",
      lastName: "Dabrowski",
      displayName: "Adam Dabrowski",
      pool: "ZPP",
      role: "Roster Support",
      availability: "Unavailable today",
      contactEmail: "adam.dabrowski@lot.pl",
      phone: "+48 600 100 221",
      languages: ["PL", "EN", "UA"],
      trainingStatus: "Restricted",
      assignedFunction: "Member Rostering",
      rosterStatus: "Unavailable",
      assignedLeader: "Leader Foxtrot",
      status: "Active",
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp
    },
    {
      id: "mem-2026-000009",
      memberId: "TEC-170",
      firstName: "Adam",
      lastName: "Pawlak",
      displayName: "Adam Pawlak",
      pool: "TEC",
      role: "Contact Center Agent",
      availability: "Today 12:00-20:00",
      contactEmail: "adam.pawlak@lot.pl",
      phone: "+48 600 200 170",
      languages: ["PL", "EN", "DE"],
      trainingStatus: "Restricted",
      assignedFunction: "Contact Center",
      rosterStatus: "Available",
      assignedLeader: "Leader Charlie",
      status: "Active",
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp
    },
    {
      id: "mem-2026-000010",
      memberId: "ZPP-255",
      firstName: "Krzysztof",
      lastName: "Szymanski",
      displayName: "Krzysztof Szymanski",
      pool: "ZPP",
      role: "Logistics Support",
      availability: "Today 14:00-22:00",
      contactEmail: "krzysztof.szymanski@lot.pl",
      phone: "+48 600 100 255",
      languages: ["PL", "EN", "FR"],
      trainingStatus: "Restricted",
      assignedFunction: "Logistics Support",
      rosterStatus: "Confirmed",
      assignedLeader: "Leader Delta",
      status: "Active",
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp
    }
  ];

  const groups: GroupRecord[] = [
    {
      id: "grp-2026-000001",
      operationalId: "GRP-2026-000001",
      sessionId: "ses-demo-1",
      name: "Family Assistance Alpha",
      pool: "ZPP",
      functionName: "Family Assistance Team",
      status: "Active",
      leaderId: "mem-2026-000001",
      rosterShiftIds: ["RST-001"],
      notes: "Primary family assistance group for the current operating period.",
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp
    },
    {
      id: "grp-2026-000002",
      operationalId: "GRP-2026-000002",
      sessionId: "ses-demo-1",
      name: "TEC Evening Team",
      pool: "TEC",
      functionName: "Telephone Enquiry Center",
      status: "Active",
      leaderId: "mem-2026-000002",
      rosterShiftIds: ["RST-002"],
      notes: "Evening call intake and enquiry triage coverage.",
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp
    },
    {
      id: "grp-2026-000003",
      operationalId: "GRP-2026-000003",
      sessionId: "ses-demo-1",
      name: "Welfare Support Reserve",
      pool: "ZPP",
      functionName: "Welfare Support",
      status: "Standby",
      leaderId: "mem-2026-000006",
      rosterShiftIds: ["RST-003"],
      notes: "Reserve pool for welfare support escalation.",
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp
    },
    {
      id: "grp-2026-000004",
      operationalId: "GRP-2026-000004",
      sessionId: "ses-demo-1",
      name: "Documentation Cell",
      pool: "Mixed",
      functionName: "Documentation Support",
      status: "Draft",
      leaderId: "mem-2026-000008",
      rosterShiftIds: ["RST-005"],
      notes: "Documentation and handover support group.",
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp
    }
  ];

  const memberships: GroupMembershipRecord[] = [
    { id: "gmb-2026-000001", groupId: "grp-2026-000001", memberProfileId: "mem-2026-000001", role: "Leader", createdAt: initialTimestamp, updatedAt: initialTimestamp },
    { id: "gmb-2026-000002", groupId: "grp-2026-000001", memberProfileId: "mem-2026-000003", role: "Member", createdAt: initialTimestamp, updatedAt: initialTimestamp },
    { id: "gmb-2026-000003", groupId: "grp-2026-000001", memberProfileId: "mem-2026-000004", role: "Member", createdAt: initialTimestamp, updatedAt: initialTimestamp },
    { id: "gmb-2026-000004", groupId: "grp-2026-000001", memberProfileId: "mem-2026-000005", role: "Member", createdAt: initialTimestamp, updatedAt: initialTimestamp },
    { id: "gmb-2026-000005", groupId: "grp-2026-000001", memberProfileId: "mem-2026-000006", role: "Member", createdAt: initialTimestamp, updatedAt: initialTimestamp },
    { id: "gmb-2026-000006", groupId: "grp-2026-000001", memberProfileId: "mem-2026-000007", role: "Member", createdAt: initialTimestamp, updatedAt: initialTimestamp },
    { id: "gmb-2026-000007", groupId: "grp-2026-000002", memberProfileId: "mem-2026-000002", role: "Leader", createdAt: initialTimestamp, updatedAt: initialTimestamp },
    { id: "gmb-2026-000008", groupId: "grp-2026-000002", memberProfileId: "mem-2026-000009", role: "Member", createdAt: initialTimestamp, updatedAt: initialTimestamp },
    { id: "gmb-2026-000009", groupId: "grp-2026-000002", memberProfileId: "mem-2026-000010", role: "Member", createdAt: initialTimestamp, updatedAt: initialTimestamp },
    { id: "gmb-2026-000010", groupId: "grp-2026-000003", memberProfileId: "mem-2026-000005", role: "Reserve", createdAt: initialTimestamp, updatedAt: initialTimestamp },
    { id: "gmb-2026-000011", groupId: "grp-2026-000003", memberProfileId: "mem-2026-000006", role: "Leader", createdAt: initialTimestamp, updatedAt: initialTimestamp },
    { id: "gmb-2026-000012", groupId: "grp-2026-000004", memberProfileId: "mem-2026-000008", role: "Leader", createdAt: initialTimestamp, updatedAt: initialTimestamp }
  ];

  let memberCounter = members.length + 1;
  let groupCounter = groups.length + 1;
  let membershipCounter = memberships.length + 1;

  function nextMemberId(pool: MemberPool) {
    const next = String(memberCounter).padStart(3, "0");
    return `${pool}-${next}`;
  }

  function nextProfileId() {
    return `mem-2026-${String(memberCounter++).padStart(6, "0")}`;
  }

  function nextGroupId() {
    return `grp-2026-${String(groupCounter++).padStart(6, "0")}`;
  }

  function nextMembershipId() {
    return `gmb-2026-${String(membershipCounter++).padStart(6, "0")}`;
  }

  function findMember(id: string) {
    return members.find((member) => member.id === id);
  }

  function findGroup(id: string) {
    return groups.find((group) => group.id === id);
  }

  function assertMember(id: string, includeArchived = false) {
    const member = findMember(id);
    assert(member, 404, "Member profile not found.");
    assert(includeArchived || member.status !== "Archived", 409, "This member profile is archived.");
    return member;
  }

  function assertGroup(id: string, includeArchived = false) {
    const group = findGroup(id);
    assert(group, 404, "Group not found.");
    assert(includeArchived || group.status !== "Archived", 409, "This group is archived.");
    return group;
  }

  function groupIdsForMember(memberProfileId: string) {
    return memberships
      .filter((membership) => membership.memberProfileId === memberProfileId && !membership.archivedAt)
      .map((membership) => membership.groupId);
  }

  function canAccessMember(actor: DirectoryActor, permission: string, memberProfileId: string) {
    const scope = permissionScope(actor, permission);
    if (!scope.allowed) return false;
    if (scope.global) return true;
    const own = members.find((member) => member.linkedUserId === actor.id && member.status !== "Archived");
    if (own?.id === memberProfileId) return true;
    return groupIdsForMember(memberProfileId).some((groupId) => scope.groupIds.has(groupId));
  }

  function assertMemberScope(actor: DirectoryActor | undefined, permission: string, memberProfileId: string) {
    if (actor) assert(canAccessMember(actor, permission, memberProfileId), 403, "Forbidden");
  }

  function assertGroupScope(actor: DirectoryActor | undefined, permission: string, groupId: string) {
    if (!actor) return;
    const own = members.find((member) => member.linkedUserId === actor.id && member.status !== "Archived");
    const ownGroupRead = permission === "group:read" && Boolean(own && groupIdsForMember(own.id).includes(groupId));
    assert(ownGroupRead || canAccessGroup(actor, permission, groupId), 403, "Forbidden");
  }

  function assertGlobalScope(actor: DirectoryActor | undefined, permission: string) {
    if (actor) {
      const scope = permissionScope(actor, permission);
      assert(scope.allowed && scope.global, 403, "Forbidden");
    }
  }

  function validateLinkedUser(linkedUserId: string | null | undefined, profileId?: string) {
    if (!linkedUserId) return null;
    const user = users.find((candidate) => candidate.id === linkedUserId);
    assert(user, 400, "Linked user account was not found.");
    const existing = members.find((member) => member.linkedUserId === linkedUserId && member.id !== profileId && member.status !== "Archived");
    assert(!existing, 409, "This user account is already linked to another member profile.");
    return linkedUserId;
  }

  function validateMemberIds(values: unknown) {
    return uniqueStrings(values).map((id) => assertMember(id).id);
  }

  function syncMemberships(groupId: string, memberIds: string[], actor?: DirectoryActor) {
    const nowValue = new Date().toISOString();
    const desired = new Set(memberIds);
    for (const membership of memberships) {
      if (membership.groupId === groupId && !membership.archivedAt && !desired.has(membership.memberProfileId)) {
        membership.archivedAt = nowValue;
        membership.updatedAt = nowValue;
        membership.updatedById = actor?.id ?? null;
      }
    }
    for (const memberId of desired) {
      const existing = memberships.find((membership) => membership.groupId === groupId && membership.memberProfileId === memberId && !membership.archivedAt);
      if (existing) continue;
      memberships.push({
        id: nextMembershipId(),
        groupId,
        memberProfileId: memberId,
        role: "Member",
        createdAt: nowValue,
        updatedAt: nowValue,
        createdById: actor?.id ?? null,
        updatedById: actor?.id ?? null
      });
    }
  }

  function memberFilter(query: DirectoryQuery, member: MemberProfileRecord) {
    const search = normalize(query.search ?? query.q);
    const pool = asString(query.pool);
    const status = asString(query.status);
    const functionName = asString(query.functionName ?? query.function);
    const groupId = asString(query.groupId);

    if (status && status !== "All statuses" && member.status !== status) return false;
    if (!status && member.status === "Archived") return false;
    if (pool && pool !== "All" && pool !== "All pools" && member.pool !== pool) return false;
    if (functionName && functionName !== "All functions" && member.assignedFunction !== functionName) return false;
    if (groupId) {
      const linked = memberships.some((membership) => membership.groupId === groupId && membership.memberProfileId === member.id && !membership.archivedAt);
      if (!linked) return false;
    }
    if (!search) return true;
    return [
      member.memberId,
      member.displayName,
      member.firstName,
      member.lastName,
      member.role,
      member.assignedFunction,
      member.assignedLeader,
      member.contactEmail,
      member.phone,
      member.languages.join(" ")
    ].some((value) => normalize(value).includes(search));
  }

  function groupFilter(query: DirectoryQuery, group: GroupRecord) {
    const search = normalize(query.search ?? query.q);
    const pool = asString(query.pool);
    const status = asString(query.status);
    const functionName = asString(query.functionName ?? query.function);
    const sessionId = asString(query.sessionId);

    if (sessionId && group.sessionId !== sessionId) return false;
    if (status && status !== "All statuses" && group.status !== status) return false;
    if (!status && group.status === "Archived") return false;
    if (pool && pool !== "All" && pool !== "All pools" && group.pool !== pool) return false;
    if (functionName && functionName !== "All functions" && group.functionName !== functionName) return false;
    if (!search) return true;
    const leader = group.leaderId ? findMember(group.leaderId) : undefined;
    return [group.operationalId, group.name, group.pool, group.functionName, group.status, leader?.displayName, group.notes].some((value) => normalize(value).includes(search));
  }

  return {
    replaceMemberProjection(record: Record<string, any>) {
      const existing = members.find((member) => member.id === record.id);
      const projected: MemberProfileRecord = {
        id: String(record.id),
        memberId: String(record.memberId ?? record.volunteerId),
        linkedUserId: record.linkedUserId === undefined ? existing?.linkedUserId ?? null : record.linkedUserId,
        firstName: String(record.firstName ?? ""),
        lastName: String(record.lastName ?? ""),
        displayName: String(record.displayName ?? fullName(String(record.firstName ?? ""), String(record.lastName ?? ""))),
        pool: record.pool as MemberPool,
        role: String(record.role ?? "Member"),
        availability: String(record.availability ?? existing?.availability ?? "Managed in Availability"),
        contactEmail: record.contactEmail === undefined ? existing?.contactEmail ?? null : record.contactEmail,
        phone: record.phone === undefined ? existing?.phone ?? null : record.phone,
        languages: uniqueStrings(record.languages),
        trainingStatus: String(record.trainingStatus ?? existing?.trainingStatus ?? "Managed in Training"),
        assignedFunction: String(record.assignedFunction ?? "Unassigned"),
        rosterStatus: String(record.rosterStatus ?? existing?.rosterStatus ?? "Managed in Rostering"),
        assignedLeader: record.assignedLeader ?? existing?.assignedLeader ?? null,
        status: record.status as MemberProfileStatus,
        createdAt: new Date(record.createdAt).toISOString(),
        updatedAt: new Date(record.updatedAt).toISOString(),
        createdById: existing?.createdById ?? null,
        updatedById: existing?.updatedById ?? null,
      };
      if (existing) Object.assign(existing, projected);
      else members.push(projected);
    },

    replaceMemberProjectionPage(records: Array<Record<string, any>>, _offset: number) {
      records.forEach((record) => this.replaceMemberProjection(record));
    },

    replaceGroupProjection(record: Record<string, any>) {
      const existing = groups.find((group) => group.id === record.id);
      const projected: GroupRecord = {
        id: String(record.id),
        operationalId: String(record.operationalId),
        sessionId: String(record.sessionId ?? record.incidentId),
        name: String(record.name),
        pool: record.pool as GroupPool,
        functionName: String(record.functionName ?? "Operational Support"),
        status: record.status as GroupStatus,
        leaderId: String(record.leaderId ?? "") || null,
        rosterShiftIds: Array.isArray(record.rosterShiftIds) && record.rosterShiftIds.length
          ? uniqueStrings(record.rosterShiftIds)
          : existing?.rosterShiftIds ?? [],
        notes: optionalString(record.notes),
        createdAt: new Date(record.createdAt).toISOString(),
        updatedAt: new Date(record.updatedAt).toISOString(),
        createdById: existing?.createdById ?? null,
        updatedById: existing?.updatedById ?? null,
      };
      if (existing) Object.assign(existing, projected);
      else groups.push(projected);

      const activeIds = new Set<string>(Array.isArray(record.memberIds) ? record.memberIds.map(String) : []);
      const roleByMember = new Map<string, string>((Array.isArray(record.memberships) ? record.memberships : []).map((item: any) => [String(item.memberProfileId), String(item.role ?? "Member")]));
      const timestamp = projected.updatedAt;
      memberships.forEach((membership) => {
        if (membership.groupId === projected.id && !membership.archivedAt && !activeIds.has(membership.memberProfileId)) {
          membership.archivedAt = timestamp;
          membership.updatedAt = timestamp;
        }
      });
      activeIds.forEach((memberProfileId) => {
        const membership = memberships.find((item) => item.groupId === projected.id && item.memberProfileId === memberProfileId && !item.archivedAt);
        if (membership) {
          membership.role = roleByMember.get(memberProfileId) ?? (projected.leaderId === memberProfileId ? "Leader" : membership.role);
          membership.updatedAt = timestamp;
        } else {
          memberships.push({
            id: String((record.memberships ?? []).find((item: any) => String(item.memberProfileId) === memberProfileId)?.id ?? nextMembershipId()),
            groupId: projected.id,
            memberProfileId,
            role: roleByMember.get(memberProfileId) ?? (projected.leaderId === memberProfileId ? "Leader" : "Member"),
            createdAt: timestamp,
            updatedAt: timestamp,
          });
        }
      });
    },

    replaceGroupProjectionPage(records: Array<Record<string, any>>, _offset: number) {
      records.forEach((record) => this.replaceGroupProjection(record));
    },

    upsertUser(user: DirectoryUser) {
      const existing = users.find((candidate) => candidate.id === user.id);
      const nextUser = { ...user, roles: [...user.roles] };
      if (existing) {
        Object.assign(existing, nextUser);
        return;
      }
      users.push(nextUser);
    },

    removeUser(userId: string) {
      const index = users.findIndex((candidate) => candidate.id === userId);
      if (index >= 0) users.splice(index, 1);
    },

    listMembers(query: DirectoryQuery, actor?: DirectoryActor) {
      const visibleIds = actor && !permissionScope(actor, "member:read").global
        ? new Set(members.filter((member) => canAccessMember(actor, "member:read", member.id)).map((member) => member.id))
        : null;
      const sorted = members
        .filter((member) => (!visibleIds || visibleIds.has(member.id)) && memberFilter(query, member))
        .sort((left, right) => left.displayName.localeCompare(right.displayName));
      const result = page(sorted.map((member) => cloneMember(member, actor)), query);
      return result;
    },

    getMember(id: string, actor?: DirectoryActor) {
      assertMemberScope(actor, "member:read", id);
      return cloneMember(assertMember(id, true), actor);
    },

    createMember(body: DirectoryQuery, actor?: DirectoryActor) {
      assertGlobalScope(actor, "member:create");
      const nowValue = new Date().toISOString();
      const pool = asString(body.pool, "ZPP") as MemberPool;
      assert(memberPools.has(pool), 400, "Member pool is invalid.");
      const memberId = asString(body.memberId ?? body.volunteerId, nextMemberId(pool));
      const names = memberNameFromBody(body);
      const linkedUserId = validateLinkedUser(optionalString(body.linkedUserId));
      const existingId = members.find((member) => normalize(member.memberId) === normalize(memberId) && member.status !== "Archived");
      assert(!existingId, 409, "A member profile with this identifier already exists.");
      const existingEmail = optionalString(body.contactEmail)
        ? members.find((member) => normalize(member.contactEmail) === normalize(body.contactEmail) && member.status !== "Archived")
        : undefined;
      assert(!existingEmail, 409, "A member profile with this email already exists.");

      const member: MemberProfileRecord = {
        id: nextProfileId(),
        memberId,
        linkedUserId,
        ...names,
        pool,
        role: asString(body.role, "Member"),
        availability: asString(body.availability, "Availability not set"),
        contactEmail: optionalString(body.contactEmail),
        phone: optionalString(body.phone),
        languages: uniqueStrings(body.languages, ["PL"]),
        trainingStatus: asString(body.trainingStatus, "Pending"),
        assignedFunction: asString(body.assignedFunction, "Unassigned"),
        rosterStatus: asString(body.rosterStatus, "Unassigned"),
        assignedLeader: optionalString(body.assignedLeader),
        status: memberStatuses.has(asString(body.status) as MemberProfileStatus) ? (asString(body.status) as MemberProfileStatus) : "Active",
        createdAt: nowValue,
        updatedAt: nowValue,
        createdById: actor?.id ?? null,
        updatedById: actor?.id ?? null
      };
      members.push(member);
      return cloneMember(member, actor);
    },

    updateMember(id: string, body: DirectoryQuery, actor?: DirectoryActor) {
      assertMemberScope(actor, "member:update", id);
      const member = assertMember(id);
      const nextMemberIdValue = asString(body.memberId ?? body.volunteerId, member.memberId);
      const duplicateId = members.find((candidate) => candidate.id !== id && normalize(candidate.memberId) === normalize(nextMemberIdValue) && candidate.status !== "Archived");
      assert(!duplicateId, 409, "A member profile with this identifier already exists.");
      const nextEmail = optionalString(body.contactEmail ?? member.contactEmail);
      const duplicateEmail = nextEmail
        ? members.find((candidate) => candidate.id !== id && normalize(candidate.contactEmail) === normalize(nextEmail) && candidate.status !== "Archived")
        : undefined;
      assert(!duplicateEmail, 409, "A member profile with this email already exists.");
      const nextStatus = asString(body.status, member.status) as MemberProfileStatus;
      assert(memberStatuses.has(nextStatus), 400, "Member status is invalid.");
      const pool = asString(body.pool, member.pool) as MemberPool;
      assert(memberPools.has(pool), 400, "Member pool is invalid.");
      const names = memberNameFromBody(body, member);
      const nowValue = new Date().toISOString();
      const nextLinkedUserId = Object.prototype.hasOwnProperty.call(body, "linkedUserId") ? optionalString(body.linkedUserId) : member.linkedUserId;

      Object.assign(member, {
        memberId: nextMemberIdValue,
        linkedUserId: validateLinkedUser(nextLinkedUserId, id),
        ...names,
        pool,
        role: asString(body.role, member.role),
        availability: asString(body.availability, member.availability),
        contactEmail: nextEmail,
        phone: optionalString(body.phone ?? member.phone),
        languages: uniqueStrings(body.languages, member.languages),
        trainingStatus: asString(body.trainingStatus, member.trainingStatus),
        assignedFunction: asString(body.assignedFunction, member.assignedFunction),
        rosterStatus: asString(body.rosterStatus, member.rosterStatus),
        assignedLeader: optionalString(body.assignedLeader ?? member.assignedLeader),
        status: nextStatus,
        updatedAt: nowValue,
        updatedById: actor?.id ?? null
      });
      return cloneMember(member, actor);
    },

    archiveMember(id: string, actor?: DirectoryActor) {
      assertMemberScope(actor, "member:archive", id);
      const member = assertMember(id);
      const activeMembership = memberships.find((membership) => membership.memberProfileId === id && !membership.archivedAt);
      assert(!activeMembership, 409, "Remove this member from active groups before archiving.");
      member.status = "Archived";
      member.linkedUserId = null;
      member.updatedAt = new Date().toISOString();
      member.updatedById = actor?.id ?? null;
      return cloneMember(member, actor);
    },

    restoreMember(id: string, actor?: DirectoryActor) {
      assertMemberScope(actor, "member:archive", id);
      const member = assertMember(id, true);
      assert(member.status === "Archived", 409, "This member profile is already active.");
      member.status = "Active";
      member.updatedAt = new Date().toISOString();
      member.updatedById = actor?.id ?? null;
      return cloneMember(member, actor);
    },

    listEligibleUsers(query: DirectoryQuery) {
      const currentMemberId = asString(query.memberProfileId);
      const linkedUserIds = new Set(members.filter((member) => member.id !== currentMemberId && member.linkedUserId && member.status !== "Archived").map((member) => member.linkedUserId));
      const data = users
        .filter((user) => !linkedUserIds.has(user.id))
        .map((user) => ({
          id: user.id,
          userId: user.id,
          email: user.email,
          displayName: user.displayName,
          roles: [...user.roles]
        }));
      return page(data, query);
    },

    listGroups(query: DirectoryQuery, actor?: DirectoryActor) {
      const scope = actor ? permissionScope(actor, "group:read") : null;
      const own = actor ? members.find((member) => member.linkedUserId === actor.id && member.status !== "Archived") : null;
      const ownGroupIds = new Set(own ? groupIdsForMember(own.id) : []);
      const sorted = groups
        .filter((group) => (!scope || scope.global || scope.groupIds.has(group.id) || ownGroupIds.has(group.id)) && groupFilter(query, group))
        .sort((left, right) => left.name.localeCompare(right.name));
      return page(sorted.map((group) => cloneGroup(group, memberships, members)), query);
    },

    getGroup(id: string, actor?: DirectoryActor) {
      assertGroupScope(actor, "group:read", id);
      return cloneGroup(assertGroup(id, true), memberships, members);
    },

    createGroup(body: DirectoryQuery, actor?: DirectoryActor) {
      assertGlobalScope(actor, "group:create");
      const nowValue = new Date().toISOString();
      const name = asString(body.name);
      assert(name, 400, "Group name is required.");
      const pool = asString(body.pool, "ZPP") as GroupPool;
      assert(groupPools.has(pool), 400, "Group pool is invalid.");
      const status = asString(body.status, "Active") as GroupStatus;
      assert(groupStatuses.has(status), 400, "Group status is invalid.");
      assert(status !== "Archived", 400, "Create the group first, then archive it if needed.");
      const duplicate = groups.find((group) => normalize(group.name) === normalize(name) && group.status !== "Archived");
      assert(!duplicate, 409, "A group with this name already exists.");
      const leaderId = optionalString(body.leaderId);
      if (leaderId) assertMember(leaderId);
      const memberIds = validateMemberIds(body.memberIds);
      const group: GroupRecord = {
        id: nextGroupId(),
        operationalId: `GRP-2026-${String(groupCounter - 1).padStart(6, "0")}`,
        sessionId: optionalString(body.sessionId),
        name,
        pool,
        functionName: asString(body.functionName, "Operational Support"),
        status,
        leaderId,
        rosterShiftIds: uniqueStrings(body.rosterShiftIds),
        notes: optionalString(body.notes),
        createdAt: nowValue,
        updatedAt: nowValue,
        createdById: actor?.id ?? null,
        updatedById: actor?.id ?? null
      };
      groups.push(group);
      syncMemberships(group.id, memberIds, actor);
      return cloneGroup(group, memberships, members);
    },

    updateGroup(id: string, body: DirectoryQuery, actor?: DirectoryActor) {
      assertGroupScope(actor, "group:update", id);
      const group = assertGroup(id);
      const name = asString(body.name, group.name);
      assert(name, 400, "Group name is required.");
      const duplicate = groups.find((candidate) => candidate.id !== id && normalize(candidate.name) === normalize(name) && candidate.status !== "Archived");
      assert(!duplicate, 409, "A group with this name already exists.");
      const pool = asString(body.pool, group.pool) as GroupPool;
      assert(groupPools.has(pool), 400, "Group pool is invalid.");
      const status = asString(body.status, group.status) as GroupStatus;
      assert(groupStatuses.has(status), 400, "Group status is invalid.");
      assert(status !== "Archived", 400, "Use the archive action to archive a group.");
      const leaderId = optionalString(body.leaderId ?? group.leaderId);
      if (leaderId) assertMember(leaderId);
      const nowValue = new Date().toISOString();
      Object.assign(group, {
        name,
        pool,
        functionName: asString(body.functionName, group.functionName),
        status,
        leaderId,
        rosterShiftIds: uniqueStrings(body.rosterShiftIds, group.rosterShiftIds),
        notes: optionalString(body.notes ?? group.notes),
        updatedAt: nowValue,
        updatedById: actor?.id ?? null
      });
      if (Array.isArray(body.memberIds)) {
        const memberIds = validateMemberIds(body.memberIds);
        memberIds.forEach((memberId) => assertMemberScope(actor, "member:read", memberId));
        syncMemberships(group.id, memberIds, actor);
      }
      return cloneGroup(group, memberships, members);
    },

    archiveGroup(id: string, actor?: DirectoryActor) {
      assertGroupScope(actor, "group:archive", id);
      const group = assertGroup(id);
      const nowValue = new Date().toISOString();
      group.status = "Archived";
      group.updatedAt = nowValue;
      group.updatedById = actor?.id ?? null;
      for (const membership of memberships) {
        if (membership.groupId === id && !membership.archivedAt) {
          membership.archivedAt = nowValue;
          membership.updatedAt = nowValue;
          membership.updatedById = actor?.id ?? null;
        }
      }
      return cloneGroup(group, memberships, members);
    },

    listGroupMembers(groupId: string, query: DirectoryQuery, actor?: DirectoryActor) {
      assertGroupScope(actor, "group:read", groupId);
      assertGroup(groupId, true);
      const data = memberships
        .filter((membership) => membership.groupId === groupId && !membership.archivedAt)
        .map((membership) => {
          const member = assertMember(membership.memberProfileId, true);
          return {
            ...cloneMember(member, actor),
            membershipId: membership.id,
            membershipRole: membership.role,
            membershipCreatedAt: membership.createdAt,
            membershipUpdatedAt: membership.updatedAt
          };
        })
        .sort((left, right) => left.displayName.localeCompare(right.displayName));
      return page(data, query);
    },

    addGroupMember(groupId: string, body: DirectoryQuery, actor?: DirectoryActor) {
      assertGroupScope(actor, "group:membership:manage", groupId);
      assertGroup(groupId);
      const memberProfileId = asString(body.memberProfileId ?? body.memberId);
      assert(memberProfileId, 400, "Member profile is required.");
      assertMember(memberProfileId);
      assertMemberScope(actor, "member:read", memberProfileId);
      const existing = memberships.find((membership) => membership.groupId === groupId && membership.memberProfileId === memberProfileId && !membership.archivedAt);
      assert(!existing, 409, "This member is already in the group.");
      const nowValue = new Date().toISOString();
      memberships.push({
        id: nextMembershipId(),
        groupId,
        memberProfileId,
        role: asString(body.role, "Member"),
        createdAt: nowValue,
        updatedAt: nowValue,
        createdById: actor?.id ?? null,
        updatedById: actor?.id ?? null
      });
      return cloneGroup(assertGroup(groupId, true), memberships, members);
    },

    updateGroupMember(groupId: string, memberProfileId: string, body: DirectoryQuery, actor?: DirectoryActor) {
      assertGroupScope(actor, "group:membership:manage", groupId);
      assertGroup(groupId);
      const membership = memberships.find((candidate) => candidate.groupId === groupId && candidate.memberProfileId === memberProfileId && !candidate.archivedAt);
      assert(membership, 404, "Group membership not found.");
      membership.role = asString(body.role, membership.role);
      membership.updatedAt = new Date().toISOString();
      membership.updatedById = actor?.id ?? null;
      return {
        ...cloneMember(assertMember(memberProfileId, true), actor),
        membershipId: membership.id,
        membershipRole: membership.role,
        membershipCreatedAt: membership.createdAt,
        membershipUpdatedAt: membership.updatedAt
      };
    },

    removeGroupMember(groupId: string, memberProfileId: string, actor?: DirectoryActor) {
      assertGroupScope(actor, "group:membership:manage", groupId);
      assertGroup(groupId);
      const membership = memberships.find((candidate) => candidate.groupId === groupId && candidate.memberProfileId === memberProfileId && !candidate.archivedAt);
      assert(membership, 404, "Group membership not found.");
      membership.archivedAt = new Date().toISOString();
      membership.updatedAt = membership.archivedAt;
      membership.updatedById = actor?.id ?? null;
      const group = assertGroup(groupId, true);
      if (group.leaderId === memberProfileId) {
        const nextLeaderMembership = memberships.find((candidate) => candidate.groupId === groupId && !candidate.archivedAt);
        group.leaderId = nextLeaderMembership?.memberProfileId ?? null;
        group.updatedAt = membership.updatedAt;
        group.updatedById = actor?.id ?? null;
      }
      return cloneGroup(group, memberships, members);
    },

    lookupMember(id: string) {
      const member = assertMember(id, true);
      return rosterMemberSummary(member);
    },

    resolveMemberForUser(userId: string) {
      const member = members.find((candidate) => candidate.linkedUserId === userId && candidate.status !== "Archived");
      return member ? rosterMemberSummary(member) : null;
    },

    lookupGroup(id: string) {
      return cloneGroup(assertGroup(id, true), memberships, members);
    },

    groupIdsForMember(memberProfileId: string) {
      return groupIdsForMember(memberProfileId);
    }
  };
}

export type MemberDirectoryRepository = ReturnType<typeof createMemberDirectoryRepository>;
