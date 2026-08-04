import type { IncidentContext } from "../incident-access/incident-access-types.js";

export type PassengerActor = {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
  requestId?: string;
};

export type PassengerSourceFacts = {
  personType: string;
  firstName: string;
  lastName: string;
  dateOfBirth?: Date | string | null;
  age?: number | null;
  gender?: string | null;
  nationality?: string | null;
  flightNumber?: string | null;
  route?: string | null;
  seat?: string | null;
  pnr?: string | null;
  ticketNumber?: string | null;
  manifestVersion?: string | null;
  source: string;
  travellingCompanions?: string | null;
  sourceExternalId?: string | null;
};

export type PassengerRecord = PassengerSourceFacts & {
  id: string;
  operationalId: string;
  sessionId: string;
  caseId?: string | null;
  sourceBatchId?: string | null;
  sourceImportedAt?: Date | string | null;
  conditionStatus: string;
  conditionUpdatedAt?: Date | string | null;
  conditionUpdatedById?: string | null;
  conditionBasis?: string | null;
  holdStatus: string;
  holdUpdatedAt?: Date | string | null;
  holdUpdatedById?: string | null;
  holdReason?: string | null;
  srcConfirmed: boolean;
  srcConfirmedAt?: Date | string | null;
  srcConfirmedById?: string | null;
  srcConfirmationBasis?: string | null;
  notes?: string | null;
  version: number;
  createdById?: string | null;
  updatedById?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type PassengerCreateInput = PassengerSourceFacts & {
  sessionId: string;
  caseId?: string | null;
  notes?: string | null;
};

export type PassengerOperatorUpdate = {
  caseId?: string | null;
  notes?: string | null;
};

export type PassengerSourceCorrection = Partial<Omit<PassengerSourceFacts, "source">> & {
  source?: string;
  reason: string;
};

export type PassengerListQuery = {
  search?: string;
  source?: string;
  sourceBatchId?: string;
  conditionStatus?: string;
  holdStatus?: string;
  srcConfirmed?: boolean;
  sortBy: "updatedAt" | "operationalId" | "lastName" | "flightNumber" | "conditionStatus" | "holdStatus";
  sortDirection: "asc" | "desc";
  limit: number;
  offset: number;
};

export type PassengerListResult = { total: number; data: PassengerRecord[] };
export type PassengerMutationResult = { record: PassengerRecord | null; conflict: boolean };
export type PassengerControlledField = "conditionStatus" | "holdStatus";

export type PassengerImportInput = {
  batchId: string;
  sourceFilename: string;
  totalRecords: number;
  invalidRecords: number;
  errors: unknown[];
  records: Array<Omit<PassengerCreateInput, "sessionId">>;
};

export type PassengerImportResult = {
  batchId: string;
  status: string;
  totalRecords: number;
  validRecords: number;
  invalidRecords: number;
};

export type PassengerScopedOperation = { context: IncidentContext; actor: PassengerActor };
