import type { IncidentContext } from "../incident-access/incident-access-types.js";

export type ReleaseActor = {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
  requestId?: string;
};

export type ReleaseActionType = "REUNIFICATION" | "RELEASE";
export type ReleaseStatus = "PREPARED" | "AUTHORIZED" | "COMPLETED" | "CANCELLED";
export type ReleaseCheckType = "IDENTITY" | "HOLD_REVIEW";
export type ReleaseCheckResult = "PASS" | "FAIL";

export type ReleaseCheckRecord = {
  id: string;
  incidentId: string;
  releaseActionId: string;
  type: ReleaseCheckType;
  result: ReleaseCheckResult;
  actorId?: string | null;
  actorDisplayName?: string | null;
  checkedAt: Date | string;
  basis: string;
  evidenceReference?: string | null;
  relationshipClaimId?: string | null;
  claimVersion?: number | null;
  matchDecisionId?: string | null;
  passengerVersion?: number | null;
  operationId: string;
  version: number;
  isCurrent: boolean;
  supersedesCheckId?: string | null;
  requestId?: string | null;
  current: boolean;
};

export type ReleasePrecondition = {
  key: "relationship" | "match" | "identity" | "passengerHold" | "matchingHold" | "holdReview" | "inputs";
  label: string;
  state: "PASS" | "FAIL" | "BLOCKED" | "STALE";
  detail: string;
};

export type ReleaseActionRecord = {
  id: string;
  operationalId: string;
  incidentId: string;
  actionType: ReleaseActionType;
  status: ReleaseStatus;
  effectiveState: "CURRENT" | "BLOCKED" | "REQUIRES_REVIEW";
  relationshipClaimId?: string | null;
  matchDecisionId?: string | null;
  matchingRecordId?: string | null;
  passengerRecordId?: string | null;
  relationshipClaimVersion?: number | null;
  passengerVersion?: number | null;
  releaseDestination?: string | null;
  receivingParty?: string | null;
  transportMode?: string | null;
  notes?: string | null;
  version: number;
  preparedById?: string | null;
  preparedByDisplayName?: string | null;
  preparedAt: Date | string;
  authorizedById?: string | null;
  authorizedByDisplayName?: string | null;
  authorizedAt?: Date | string | null;
  authorizationReason?: string | null;
  completedById?: string | null;
  completedByDisplayName?: string | null;
  completedAt?: Date | string | null;
  completionNotes?: string | null;
  cancelledById?: string | null;
  cancelledAt?: Date | string | null;
  cancelReason?: string | null;
  legacyImported: boolean;
  verificationEvidenceUnavailable: boolean;
  passenger?: {
    id: string;
    operationalId: string;
    firstName: string;
    lastName: string;
    holdStatus: string;
    conditionStatus: string;
    version: number;
  } | null;
  relationship?: {
    id: string;
    status: string;
    isCurrent: boolean;
    version: number;
    relationshipType?: string | null;
    family: { id: string; operationalId: string; firstName: string; lastName: string; caseId?: string | null };
  } | null;
  match?: { id: string; decision: string; validity: string; isCurrent: boolean; decidedAt: Date | string } | null;
  checks: ReleaseCheckRecord[];
  preconditions: ReleasePrecondition[];
  blockers: string[];
  canAuthorize: boolean;
  canComplete: boolean;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type ReleaseCandidateRecord = {
  matchDecisionId: string;
  matchingRecordId?: string | null;
  relationshipClaimId: string;
  passengerRecordId: string;
  claimVersion: number;
  passengerVersion: number;
  relationshipStatus: string;
  passengerHold: string;
  eligible: boolean;
  blockers: string[];
  family: { operationalId: string; firstName: string; lastName: string; relationshipType?: string | null };
  passenger: { operationalId: string; firstName: string; lastName: string; flightNumber?: string | null; version: number };
};

export type ReleaseQueueQuery = {
  search?: string;
  status?: ReleaseStatus;
  eligibility?: "eligible" | "blocked";
  actionType?: ReleaseActionType;
  sortDirection: "asc" | "desc";
  limit: number;
  offset: number;
};

export type ReleaseCandidateQuery = {
  search?: string;
  eligibility?: "eligible" | "blocked";
  sortDirection: "asc" | "desc";
  limit: number;
  offset: number;
};

export type PrepareReleaseInput = {
  matchDecisionId: string;
  actionType: ReleaseActionType;
  releaseDestination?: string | null;
  receivingParty?: string | null;
  transportMode?: string | null;
  notes?: string | null;
  operationId: string;
};

export type RecordIdentityCheckInput = {
  result: ReleaseCheckResult;
  basis: string;
  evidenceReference?: string | null;
  expectedVersion: number;
  operationId: string;
};

export type RecordHoldReviewInput = {
  basis: string;
  expectedVersion: number;
  operationId: string;
};

export type ReleaseDecisionInput = {
  reason: string;
  expectedVersion: number;
  operationId: string;
};

export type ReleaseMutationResult = { record: ReleaseActionRecord | null; conflict: boolean; idempotent?: boolean };
export type ReleaseListResult<T> = { total: number; data: T[] };
export type ReleaseCompatibilityRecord = {
  id: string;
  operationalId: string;
  sessionId: string;
  matchId?: string | null;
  passengerRecordId?: string | null;
  familyRecordId?: string | null;
  actionType: "Reunification" | "Release";
  status: "Prepared" | "Authorized" | "Completed" | "Cancelled";
  identityChecked: boolean;
  holdCleared: boolean;
  releaseDestination?: string | null;
  receivingParty?: string | null;
  transportMode?: string | null;
  notes?: string | null;
  version: number;
  completedAt?: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type ReleaseScopedOperation = { context: IncidentContext; actor: ReleaseActor };
