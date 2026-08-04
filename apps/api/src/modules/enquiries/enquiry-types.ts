import type { IncidentContext } from "../incident-access/incident-access-types.js";

export type EnquiryActor = {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
  requestId?: string;
};

export type EnquiryRecord = {
  id: string;
  operationalId: string;
  sessionId: string;
  caseId?: string | null;
  contactChannel: string;
  callerName: string;
  callerPhone?: string | null;
  callerEmail?: string | null;
  callerLocation?: string | null;
  preferredLanguage?: string | null;
  claimedRelationship?: string | null;
  passengerRecordId?: string | null;
  passengerFirstName?: string | null;
  passengerLastName?: string | null;
  passengerFlight?: string | null;
  passengerRoute?: string | null;
  lastKnownContact?: string | null;
  enquiryType: string;
  urgency: string;
  notes?: string | null;
  status: string;
  version: number;
  createdById?: string | null;
  updatedById?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type EnquiryCreateInput = Omit<
  EnquiryRecord,
  "id" | "operationalId" | "version" | "createdById" | "updatedById" | "createdAt" | "updatedAt"
>;

export type EnquiryUpdateInput = Partial<Omit<EnquiryCreateInput, "sessionId">>;

export type EnquiryListQuery = {
  status?: string;
  search?: string;
  limit: number;
  offset: number;
};

export type EnquiryListResult = { total: number; data: EnquiryRecord[] };

export type EnquiryTransition = "send-to-family-assistance" | "mark-urgent" | "mark-duplicate" | "close";

export type EnquiryMutationResult = {
  record: EnquiryRecord | null;
  conflict: boolean;
};

export type ScopedEnquiryOperation = {
  context: IncidentContext;
  actor: EnquiryActor;
};
