import type { Permission } from "@zpp/shared";

export type AssignmentStatus = "Open" | "In Progress" | "Escalated" | "Completed" | "Cancelled";
export type AssignmentPriority = "Normal" | "Urgent" | "Critical";

export type AssignmentActor = {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
  permissions: Permission[];
  requestId?: string;
};

export type AssignmentAssignee = {
  id: string;
  displayName: string;
  roles: string[];
  eligible: boolean;
};

export type AssignmentRecord = {
  id: string;
  operationalId: string;
  incidentId: string;
  sessionId: string;
  caseId?: string | null;
  title: string;
  details?: string | null;
  status: AssignmentStatus;
  priority: AssignmentPriority;
  assignedUserId?: string | null;
  assignedUser?: { id: string; displayName: string } | null;
  assignedUserDisplayName?: string | null;
  ownerAssignedTo?: string | null;
  legacyAssigneeLabel?: string | null;
  assigneeEligible: boolean | null;
  assigneeEligibilityMessage?: string | null;
  relatedFunction?: string | null;
  linkedRecord?: string | null;
  dueAt?: Date | string | null;
  overdue: boolean;
  completedById?: string | null;
  completedAt?: Date | string | null;
  completionNote?: string | null;
  cancelledById?: string | null;
  cancelledAt?: Date | string | null;
  cancelReason?: string | null;
  version: number;
  legacyImported: boolean;
  legacyMetadata?: Record<string, unknown> | null;
  createdBy?: { id: string; displayName: string } | null;
  updatedBy?: { id: string; displayName: string } | null;
  completedBy?: { id: string; displayName: string } | null;
  cancelledBy?: { id: string; displayName: string } | null;
  availableActions?: AssignmentAction[];
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type AssignmentAction = "edit" | "assign" | "claim" | "reassign" | "start" | "escalate" | "resume" | "complete" | "cancel";

export type AssignmentQueueQuery = {
  search?: string;
  status?: AssignmentStatus;
  priority?: AssignmentPriority;
  assignedUserId?: string;
  unassigned?: boolean;
  mine?: boolean;
  due?: "overdue" | "today" | "due" | "none";
  relatedFunction?: string;
  sortBy: "updatedAt" | "operationalId" | "priority" | "status" | "assignee" | "dueAt" | "relatedFunction";
  sortDirection: "asc" | "desc";
  limit: number;
  offset: number;
};

export type CreateAssignmentInput = {
  title: string;
  details?: string | null;
  priority: AssignmentPriority;
  dueAt?: Date | null;
  caseId?: string | null;
  relatedFunction?: string | null;
  linkedRecord?: string | null;
  operationId: string;
};

export type UpdateAssignmentInput = {
  title?: string;
  details?: string | null;
  priority?: AssignmentPriority;
  dueAt?: Date | null;
  caseId?: string | null;
  relatedFunction?: string | null;
  linkedRecord?: string | null;
};

export type AssignmentVersionInput = { expectedVersion: number };
export type AssignmentReasonInput = AssignmentVersionInput & { reason: string };
export type AssignmentRetryInput = AssignmentVersionInput & { operationId: string };
export type AssignmentRetryReasonInput = AssignmentRetryInput & { reason: string };
export type AssignAssignmentInput = AssignmentRetryInput & { assignedUserId: string; reason?: string };
export type ReassignAssignmentInput = AssignmentRetryInput & { assignedUserId: string; reason: string };
export type CompleteAssignmentInput = AssignmentRetryInput & { completionNote?: string | null };

export type AssignmentMutationResult = { record: AssignmentRecord | null; conflict: boolean; idempotent?: boolean };
export type AssignmentListResult = { total: number; data: AssignmentRecord[] };
export type AssignmentCandidateResult = { total: number; data: AssignmentAssignee[] };

export type AssignmentCompatibilityRecord = AssignmentRecord;

/** Read-only projection for Dashboard, Active Event, Reports and Export consumers. */
export function toAssignmentCompatibility(record: AssignmentRecord): AssignmentCompatibilityRecord {
  return { ...record };
}
