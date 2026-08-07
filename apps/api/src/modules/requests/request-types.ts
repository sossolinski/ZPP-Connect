import type { Permission } from "@zpp/shared";

export type RequestStatus =
  "OPEN" | "ASSIGNED" | "IN_PROGRESS" | "WAITING" | "RESOLVED" | "CANCELLED";
export type RequestPriority = "Low" | "Normal" | "High" | "Urgent";

export type RequestActor = {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
  permissions: Permission[];
  requestId?: string;
};

export type RequestVisibility = {
  enquiry: boolean;
  family: boolean;
  passenger: boolean;
  release: boolean;
};

export type RequestRecord = {
  id: string;
  operationalId: string;
  incidentId: string;
  sessionId: string;
  caseId?: string | null;
  relatedEnquiryId?: string | null;
  relatedFamilyRecordId?: string | null;
  relatedPassengerRecordId?: string | null;
  relatedReleaseActionId?: string | null;
  category: string;
  priority: RequestPriority;
  requester?: string | null;
  ownerUserId?: string | null;
  ownerAssignedTo?: string | null;
  legacyOwnerLabel?: string | null;
  details: string;
  approvalStatus: string;
  status: RequestStatus;
  dueAt?: Date | string | null;
  overdue: boolean;
  resolutionOutcome?: string | null;
  resolutionNote?: string | null;
  closureNote?: string | null;
  resolvedById?: string | null;
  resolvedAt?: Date | string | null;
  reopenedById?: string | null;
  reopenedAt?: Date | string | null;
  reopenReason?: string | null;
  cancelledById?: string | null;
  cancelledAt?: Date | string | null;
  cancelReason?: string | null;
  notes?: string | null;
  version: number;
  legacyImported: boolean;
  owner?: { id: string; displayName: string; email: string } | null;
  createdBy?: { id: string; displayName: string; email: string } | null;
  updatedBy?: { id: string; displayName: string; email: string } | null;
  resolvedBy?: { id: string; displayName: string; email: string } | null;
  linkedContext?: {
    enquiry?: { id: string; operationalId: string; status: string } | null;
    family?: {
      id: string;
      operationalId: string;
      verificationStatus: string;
    } | null;
    passenger?: {
      id: string;
      operationalId: string;
      holdStatus: string;
      conditionStatus: string;
    } | null;
    release?: {
      id: string;
      operationalId: string;
      status: string;
      actionType: string;
    } | null;
  };
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type RequestQueueQuery = {
  search?: string;
  status?: RequestStatus;
  priority?: RequestPriority;
  ownerUserId?: string;
  category?: string;
  due?: "overdue" | "due" | "none";
  sortBy:
    | "updatedAt"
    | "operationalId"
    | "priority"
    | "status"
    | "owner"
    | "dueAt"
    | "category";
  sortDirection: "asc" | "desc";
  limit: number;
  offset: number;
};

export type CreateRequestInput = {
  category: string;
  priority: RequestPriority;
  requester?: string | null;
  details: string;
  approvalStatus?: string;
  notes?: string | null;
  dueAt?: Date | null;
  caseId?: string | null;
  relatedEnquiryId?: string | null;
  relatedFamilyRecordId?: string | null;
  relatedPassengerRecordId?: string | null;
  relatedReleaseActionId?: string | null;
  operationId: string;
};

export type UpdateRequestInput = {
  details?: string;
  requester?: string | null;
  notes?: string | null;
  dueAt?: Date | null;
};
export type RequestVersionInput = { expectedVersion: number };
export type RequestReasonInput = RequestVersionInput & { reason: string };
export type RequestOperationInput = RequestReasonInput & {
  operationId: string;
};
export type ResolveRequestInput = RequestVersionInput & {
  outcome: string;
  resolutionNote: string;
  operationId: string;
};
export type AssignRequestInput = RequestVersionInput & {
  ownerUserId: string;
  reason?: string;
};
export type ChangePriorityInput = RequestVersionInput & {
  priority: RequestPriority;
  reason?: string;
};
export type RequestMutationResult = {
  record: RequestRecord | null;
  conflict: boolean;
  idempotent?: boolean;
};
export type RequestListResult = { total: number; data: RequestRecord[] };
export type RequestCompatibilityRecord = Omit<RequestRecord, "status"> & {
  status:
    "Open" | "Assigned" | "In progress" | "Waiting" | "Closed" | "Cancelled";
};

const compatibilityStatuses: Record<
  RequestStatus,
  RequestCompatibilityRecord["status"]
> = {
  OPEN: "Open",
  ASSIGNED: "Assigned",
  IN_PROGRESS: "In progress",
  WAITING: "Waiting",
  RESOLVED: "Closed",
  CANCELLED: "Cancelled",
};

/** Read-only projection for legacy Dashboard, Active Event, Reports and Exports consumers. */
export function toRequestCompatibility(
  record: RequestRecord,
): RequestCompatibilityRecord {
  return { ...record, status: compatibilityStatuses[record.status] };
}
