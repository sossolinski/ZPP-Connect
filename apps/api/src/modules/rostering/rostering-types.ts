export type RosterStatus = "Draft" | "Published" | "Confirmed" | "Declined" | "Cancelled" | "Completed";
export type AvailabilityType = "Available" | "Unavailable" | "Preferred";
export type AvailabilityStatus = "Active" | "Removed";

export type RosteringActor = {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
  permissions: string[];
  roleAssignments?: Array<{
    roleName: string;
    scopeType: "GLOBAL" | "GROUP";
    scopeId?: string | null;
    status: string;
    permissions?: string[];
  }>;
  requestId?: string;
};

export type MemberSummary = {
  id: string;
  memberId: string;
  linkedUserId?: string | null;
  displayName: string;
  pool: string;
  role: string;
  assignedFunction: string;
  status: string;
};

export type GroupSummary = {
  id: string;
  operationalId: string;
  incidentId: string;
  name: string;
  pool: string;
  functionName: string;
  status: string;
};

export type RosterPermissions = {
  canUpdate: boolean;
  canPublish: boolean;
  canCancel: boolean;
  canComplete: boolean;
  canConfirm: boolean;
  canDecline: boolean;
};

export type RosterShiftRecord = {
  id: string;
  operationalId: string;
  incidentId: string;
  sessionId: string;
  groupId?: string | null;
  assignedMemberProfileId?: string | null;
  assignedUserId?: string | null;
  title: string;
  duty: string;
  functionName: string;
  startAt: Date | string;
  endAt: Date | string;
  location: string;
  status: RosterStatus;
  notes?: string | null;
  version: number;
  publishedAt?: Date | string | null;
  publishedById?: string | null;
  confirmedAt?: Date | string | null;
  confirmedById?: string | null;
  declinedAt?: Date | string | null;
  declinedById?: string | null;
  cancelledAt?: Date | string | null;
  cancelledById?: string | null;
  cancelReason?: string | null;
  completedAt?: Date | string | null;
  completedById?: string | null;
  assignedMember?: MemberSummary | null;
  group?: GroupSummary | null;
  conflictWarnings: string[];
  warningDetails: Array<{ code: "OVERLAPPING_SHIFT" | "UNAVAILABLE" | "MEMBER_INACTIVE" | "OUTSIDE_GROUP" | "UNASSIGNED"; message: string; sourceId?: string }>;
  permissions?: RosterPermissions;
  idempotent?: boolean;
  legacyImported: boolean;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type AvailabilityRecord = {
  id: string;
  operationalId: string;
  memberProfileId: string;
  startAt: Date | string;
  endAt: Date | string;
  type: AvailabilityType;
  note?: string | null;
  status: AvailabilityStatus;
  version: number;
  member: MemberSummary;
  permissions?: { canUpdate: boolean; canRemove: boolean };
  removedAt?: Date | string | null;
  removedById?: string | null;
  idempotent?: boolean;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type Page<T> = { total: number; limit: number; offset: number; data: T[] };

export type RosterQuery = {
  search?: string;
  status?: RosterStatus;
  groupId?: string;
  memberProfileId?: string;
  functionName?: string;
  from?: Date;
  to?: Date;
  mine?: boolean;
  sortBy: "startAt" | "updatedAt" | "operationalId" | "status" | "functionName";
  sortDirection: "asc" | "desc";
  limit: number;
  offset: number;
};

export type AvailabilityQuery = {
  memberProfileId?: string;
  type?: AvailabilityType;
  status?: AvailabilityStatus;
  from?: Date;
  to?: Date;
  mine?: boolean;
  sortBy: "startAt" | "updatedAt" | "operationalId" | "type" | "status";
  sortDirection: "asc" | "desc";
  limit: number;
  offset: number;
};

export type RosterAccess = { global: boolean; groupIds: string[]; ownMemberProfileId?: string | null };
export type AvailabilityAccess = { global: boolean; groupIds: string[]; ownMemberProfileId?: string | null };

export type CreateRosterShiftInput = {
  title: string;
  duty: string;
  functionName: string;
  groupId?: string | null;
  assignedMemberProfileId?: string | null;
  startAt: Date;
  endAt: Date;
  location: string;
  notes?: string | null;
  operationId: string;
};

export type UpdateRosterShiftInput = Partial<Omit<CreateRosterShiftInput, "operationId">>;
export type RosterCommandInput = { expectedVersion: number; operationId: string; note?: string | null; reason?: string | null };

export type CreateAvailabilityInput = {
  memberProfileId?: string;
  startAt: Date;
  endAt: Date;
  type: AvailabilityType;
  note?: string | null;
  operationId: string;
};

export type UpdateAvailabilityInput = Partial<Omit<CreateAvailabilityInput, "operationId">>;
export type AvailabilityCommandInput = { expectedVersion: number; operationId: string };

export type MutationResult<T> = { record: T | null; conflict: boolean; idempotent?: boolean };
