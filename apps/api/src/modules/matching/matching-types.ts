import type { IncidentContext } from "../incident-access/incident-access-types.js";

export type MatchingActor = {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
  requestId?: string;
};

export type MatchSignal = { key: string; label: string; detail?: string };

export type MatchSuggestionRecord = {
  id: string;
  incidentId: string;
  relationshipClaimId: string;
  passengerRecordId: string;
  score: number;
  positiveSignals: MatchSignal[];
  conflicts: MatchSignal[];
  algorithm: string;
  algorithmVersion: string;
  generationId: string;
  claimVersion: number;
  passengerVersion: number;
  status: "ACTIVE" | "USED" | "REJECTED" | "OBSOLETE";
  isCurrent: boolean;
  version: number;
  generatedAt: Date | string;
  passenger?: MatchingPassengerProjection;
};

export type MatchDecisionRecord = {
  id: string;
  incidentId: string;
  relationshipClaimId: string;
  passengerRecordId: string;
  matchingRecordId?: string | null;
  suggestionId?: string | null;
  decision: "CONFIRMED" | "REJECTED" | "INVALIDATED";
  reason: string;
  validity: "CURRENT" | "STALE" | "SUPERSEDED" | "HISTORICAL";
  effectiveValidity?: "CURRENT" | "STALE" | "SUPERSEDED" | "HISTORICAL";
  isCurrent: boolean;
  claimVersion: number;
  passengerVersion: number;
  operationId: string;
  decisionById?: string | null;
  decisionByDisplayName?: string | null;
  decidedAt: Date | string;
  requestId?: string | null;
  supersedesDecisionId?: string | null;
};

export type MatchingFamilyProjection = {
  id: string;
  operationalId: string;
  firstName: string;
  lastName: string;
  verificationStatus: string;
  verifiedRelationship?: string | null;
};

export type MatchingClaimProjection = {
  id: string;
  incidentId: string;
  familyRecordId: string;
  passengerRecordId?: string | null;
  claimedRelationshipType?: string | null;
  claimedPassengerFirstName?: string | null;
  claimedPassengerLastName?: string | null;
  claimedPassengerFlight?: string | null;
  status: string;
  isCurrent: boolean;
  version: number;
  updatedAt: Date | string;
  family: MatchingFamilyProjection;
};

export type MatchingPassengerProjection = {
  id: string;
  operationalId: string;
  firstName: string;
  lastName: string;
  dateOfBirth?: Date | string | null;
  flightNumber?: string | null;
  route?: string | null;
  seat?: string | null;
  conditionStatus: string;
  holdStatus: string;
  version: number;
};

export type MatchingQueueItem = {
  relationshipClaim: MatchingClaimProjection;
  state: "UNMATCHED" | "SUGGESTED" | "CONFIRMED" | "STALE";
  suggestionCount: number;
  topSuggestion?: MatchSuggestionRecord | null;
  currentDecision?: MatchDecisionRecord | null;
  updatedAt: Date | string;
};

export type MatchingQueueQuery = {
  search?: string;
  state?: "UNMATCHED" | "SUGGESTED" | "CONFIRMED" | "STALE";
  relationshipStatus?: string;
  sortBy: "updatedAt" | "claimant" | "state";
  sortDirection: "asc" | "desc";
  limit: number;
  offset: number;
};

export type MatchingPageQuery = { search?: string; status?: string; sortDirection: "asc" | "desc"; limit: number; offset: number };
export type SuggestionQuery = { status?: string; hasConflicts?: boolean; sortDirection: "asc" | "desc"; limit: number; offset: number };
export type CandidateQuery = { search?: string; sortDirection: "asc" | "desc"; limit: number; offset: number };

export type MatchingContextRecord = MatchingQueueItem & {
  suggestions: MatchSuggestionRecord[];
  decisionHistory: MatchDecisionRecord[];
};

export type GenerateSuggestionsInput = { expectedClaimVersion: number };
export type MatchConfirmInput = {
  passengerRecordId: string;
  suggestionId?: string | null;
  reason: string;
  expectedClaimVersion: number;
  expectedPassengerVersion: number;
  operationId: string;
};
export type MatchRejectInput = MatchConfirmInput & { suggestionId: string; expectedSuggestionVersion: number };
export type MatchInvalidateInput = {
  decisionId: string;
  reason: string;
  expectedClaimVersion: number;
  expectedPassengerVersion: number;
  operationId: string;
};
export type MatchHoldInput = { holdCheck: string; reason: string; expectedVersion: number };

export type MatchingCompatibilityRecord = {
  id: string;
  operationalId: string;
  sessionId: string;
  caseId?: string | null;
  familyRecordId: string;
  passengerRecordId: string;
  relationshipClaimId: string;
  matchDecisionId?: string | null;
  suggestionId?: string | null;
  status: string;
  matchScore?: number | null;
  matchBasis?: string | null;
  verificationChecklist?: unknown;
  holdCheck: string;
  decisionNotes?: string | null;
  approvedById?: string | null;
  approvedAt?: Date | string | null;
  version: number;
  releaseEligibility: {
    relationshipVerification: "VERIFIED" | "NOT_VERIFIED";
    matchDecision: "CURRENT_CONFIRMED" | "NOT_CONFIRMED" | "STALE";
    passengerHold: string;
    passengerCondition: string;
    eligible: boolean;
    blockers: string[];
  };
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type MatchingMutationResult = { record: MatchingContextRecord | null; conflict: boolean; idempotent?: boolean };
export type MatchingListResult<T> = { total: number; data: T[] };
export type MatchingScopedOperation = { context: IncidentContext; actor: MatchingActor };
