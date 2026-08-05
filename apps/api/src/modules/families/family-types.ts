import type { IncidentContext } from "../incident-access/incident-access-types.js";

export type FamilyActor = {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
  requestId?: string;
};

export type RelationshipDecision = {
  id: string;
  incidentId: string;
  relationshipClaimId: string;
  result: "VERIFIED" | "REJECTED" | "REOPENED";
  basis: string;
  verifiedRelationshipType?: string | null;
  previousStatus: string;
  nextStatus: string;
  claimVersionBefore: number;
  claimVersionAfter: number;
  decisionById?: string | null;
  decisionByDisplayName?: string | null;
  decisionAt: Date | string;
  requestId?: string | null;
};

export type RelationshipClaim = {
  id: string;
  incidentId: string;
  familyRecordId: string;
  passengerRecordId?: string | null;
  claimedRelationshipType?: string | null;
  claimedPassengerFirstName?: string | null;
  claimedPassengerLastName?: string | null;
  claimedPassengerFlight?: string | null;
  source: string;
  status: "PENDING" | "VERIFIED" | "REJECTED" | "SUPERSEDED";
  isCurrent: boolean;
  version: number;
  claimedById?: string | null;
  claimedAt: Date | string;
  supersededAt?: Date | string | null;
  decisions?: RelationshipDecision[];
};

export type FamilyClaimFacts = {
  firstName: string;
  lastName: string;
  phone?: string | null;
  email?: string | null;
  preferredContactChannel?: string | null;
  preferredLanguage?: string | null;
  location?: string | null;
  claimedRelationship?: string | null;
  passengerRecordId?: string | null;
  passengerFirstName?: string | null;
  passengerLastName?: string | null;
  passengerFlight?: string | null;
};

export type FamilyOperatorFields = {
  caseId?: string | null;
  immediateNeeds?: string | null;
  questionsAsked?: string | null;
  commitmentsMade?: string | null;
  nextContactDue?: Date | string | null;
  assignedOfficer?: string | null;
  notes?: string | null;
};

export type FamilyRecord = Omit<FamilyClaimFacts, "passengerRecordId"> & FamilyOperatorFields & {
  id: string;
  operationalId: string;
  sessionId: string;
  normalizedPhone?: string | null;
  normalizedEmail?: string | null;
  sourceBatchId?: string | null;
  sourceImportedAt?: Date | string | null;
  verificationStatus: string;
  verificationNotes?: string | null;
  verificationDecisionById?: string | null;
  verificationDecisionByDisplayName?: string | null;
  verificationDecisionAt?: Date | string | null;
  verifiedRelationship?: string | null;
  version: number;
  createdById?: string | null;
  updatedById?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  currentClaim: RelationshipClaim;
  decisionHistory?: RelationshipDecision[];
  claimHistoryCount?: number;
  potentialDuplicateIds?: string[];
};

export type FamilyCreateInput = FamilyClaimFacts & FamilyOperatorFields & {
  sessionId: string;
  source?: "OPERATOR" | "IMPORT";
};

export type FamilyClaimCorrection = Partial<FamilyClaimFacts> & { reason: string };

export type FamilyDecisionInput = {
  result: "VERIFIED" | "REJECTED" | "REOPENED";
  basis: string;
  verifiedRelationshipType?: string | null;
};

export type FamilyListQuery = {
  search?: string;
  verificationStatus?: string;
  relationship?: string;
  passengerLinked?: boolean;
  sortBy: "updatedAt" | "operationalId" | "lastName" | "verificationStatus" | "nextContactDue";
  sortDirection: "asc" | "desc";
  limit: number;
  offset: number;
};

export type FamilyListResult = { total: number; data: FamilyRecord[] };
export type FamilyMutationResult = { record: FamilyRecord | null; conflict: boolean };

export type FamilyImportInput = {
  batchId: string;
  sourceFilename: string;
  totalRecords: number;
  invalidRecords: number;
  errors: unknown[];
  records: Array<Omit<FamilyCreateInput, "sessionId">>;
};

export type FamilyImportResult = {
  batchId: string;
  status: string;
  totalRecords: number;
  validRecords: number;
  invalidRecords: number;
};

export type FamilyScopedOperation = { context: IncidentContext; actor: FamilyActor };
