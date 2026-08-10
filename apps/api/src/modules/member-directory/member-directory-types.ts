import type { Permission } from "@zpp/shared";

export type DirectoryActor = {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
  permissions: Permission[];
  roleAssignments?: Array<{
    roleName: string;
    scopeType: "GLOBAL" | "GROUP";
    scopeId?: string | null;
    status: string;
    permissions?: string[];
  }>;
  requestId?: string;
};

export type MemberProfileStatus = "Active" | "Inactive" | "Archived";
export type MemberPool = "ZPP" | "TEC";
export type GroupStatus = "Active" | "Standby" | "Draft" | "Archived";
export type GroupPool = MemberPool | "Mixed";

export type MemberProfileRecord = {
  id: string;
  memberId: string;
  volunteerId: string;
  linkedUserId?: string | null;
  firstName: string;
  lastName: string;
  displayName: string;
  pool: MemberPool;
  role: string;
  assignedFunction: string;
  contactEmail?: string | null;
  phone?: string | null;
  languages: string[];
  status: MemberProfileStatus;
  version: number;
  availability: string;
  trainingStatus: string;
  rosterStatus: string;
  assignedLeader?: string | null;
  derivedFields: {
    availability: "legacy-compatibility";
    trainingStatus: "legacy-compatibility";
    rosterStatus: "legacy-compatibility";
    assignedLeader: "legacy-compatibility";
  };
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type GroupMembershipRecord = {
  id: string;
  groupId: string;
  memberProfileId: string;
  role: string;
  addedAt: Date | string;
  addedById?: string | null;
  updatedAt: Date | string;
  removedAt?: Date | string | null;
  removedById?: string | null;
};

export type GroupRecord = {
  id: string;
  operationalId: string;
  incidentId: string;
  sessionId: string;
  name: string;
  pool: GroupPool;
  functionName: string;
  status: GroupStatus;
  notes?: string | null;
  version: number;
  leaderId: string;
  leaderName: string;
  leaderMemberId: string;
  memberIds: string[];
  memberCount: number;
  memberships: GroupMembershipRecord[];
  rosterShiftIds: string[];
  rosterLinkCount: number;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type MemberQuery = {
  search?: string;
  pool?: MemberPool;
  status?: MemberProfileStatus;
  functionName?: string;
  groupId?: string;
  sortBy: "displayName" | "memberId" | "pool" | "assignedFunction" | "status" | "updatedAt";
  sortDirection: "asc" | "desc";
  limit: number;
  offset: number;
};

export type GroupQuery = {
  search?: string;
  pool?: GroupPool;
  status?: GroupStatus;
  functionName?: string;
  sortBy: "name" | "operationalId" | "pool" | "functionName" | "status" | "updatedAt";
  sortDirection: "asc" | "desc";
  limit: number;
  offset: number;
};

export type CreateMemberInput = {
  memberId?: string;
  linkedUserId?: string | null;
  firstName: string;
  lastName: string;
  pool: MemberPool;
  role: string;
  assignedFunction: string;
  contactEmail?: string | null;
  phone?: string | null;
  languages: string[];
  status?: Exclude<MemberProfileStatus, "Archived">;
};

export type UpdateMemberInput = Partial<Omit<CreateMemberInput, "status">> & {
  status?: Exclude<MemberProfileStatus, "Archived">;
};

export type CreateGroupInput = {
  name: string;
  pool: GroupPool;
  functionName: string;
  status: Exclude<GroupStatus, "Archived">;
  notes?: string | null;
  memberIds: string[];
  leaderId?: string | null;
};

export type UpdateGroupInput = Partial<Omit<CreateGroupInput, "memberIds" | "leaderId">>;

export type Page<T> = { total: number; limit: number; offset: number; data: T[] };
