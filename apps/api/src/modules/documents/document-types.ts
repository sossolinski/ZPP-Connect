export type DocumentVersionStatus = "Draft" | "Published" | "Superseded" | "Withdrawn";
export type DocumentContentMode = "Internal text" | "External link";
export type DocumentRequirementTargetType = "Role" | "Group" | "MemberProfile";
export type DocumentObligationStatus = "Awareness" | "Required" | "Overdue" | "Acknowledged";

export type DocumentActor = {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
  permissions: string[];
  roleAssignments?: Array<{ roleName: string; scopeType: "GLOBAL" | "GROUP"; scopeId?: string | null; status: string; permissions?: string[] }>;
  requestId?: string;
};

export type DocumentMemberSummary = {
  id: string;
  memberId: string;
  displayName: string;
  pool: string;
  role: string;
  assignedFunction: string;
  status: string;
};

export type DocumentGroupSummary = {
  id: string;
  operationalId: string;
  incidentId: string;
  sessionId: string;
  name: string;
  pool: string;
  functionName: string;
  status: string;
  memberCount: number;
};

export type DocumentVersionRecord = {
  id: string;
  documentId: string;
  title: string;
  versionLabel: string;
  status: DocumentVersionStatus;
  contentMode: DocumentContentMode;
  contentAvailable: boolean;
  contentBody?: string;
  externalUrl?: string;
  contentDigest?: string | null;
  effectiveFrom?: string | null;
  reviewDueAt?: string | null;
  publishedAt?: string | null;
  publishedById?: string | null;
  withdrawnAt?: string | null;
  withdrawnById?: string | null;
  withdrawReason?: string | null;
  changeSummary?: string;
  requirementCount?: number;
  acknowledgementCount?: number;
  outstandingCount?: number;
  basePublishedVersionId?: string | null;
  canPublish?: boolean;
  canEdit?: boolean;
  canWithdraw?: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type DocumentSummary = {
  id: string;
  code: string;
  title: string;
  description: string;
  category: string;
  ownerFunction: string;
  active: boolean;
  status: "Active" | "Archived";
  currentVersion: DocumentVersionRecord | null;
  versionCount?: number;
  activeRequirementCount?: number;
  acknowledgementCount?: number;
  outstandingCount?: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type DocumentRequirementRecord = {
  id: string;
  documentVersionId: string;
  documentId: string;
  document: DocumentSummary;
  version: DocumentVersionRecord;
  targetType: DocumentRequirementTargetType;
  targetRole?: string;
  groupId?: string;
  memberProfileId?: string;
  target: { type: DocumentRequirementTargetType; label: string; group?: DocumentGroupSummary; member?: DocumentMemberSummary };
  targetLabel: string;
  acknowledgementRequired: boolean;
  effectiveFrom?: string | null;
  dueAt?: string | null;
  effectiveTo?: string | null;
  active: boolean;
  effective: boolean;
  resolvedMemberCount: number;
  versionNumber: number;
  recordVersion: number;
  endedAt?: string | null;
  endedById?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DocumentAcknowledgementRecord = {
  id: string;
  documentVersionId: string;
  documentId: string;
  document: DocumentSummary;
  version: DocumentVersionRecord;
  memberProfileId: string;
  member: DocumentMemberSummary;
  sourceRequirementIds: string[];
  sourceRequirements: Array<{ id: string; targetType: DocumentRequirementTargetType; targetLabel: string; acknowledgementRequired: boolean }>;
  acknowledgedAt: string;
  acknowledgedById: string;
  acknowledgementStatementVersion: string;
  note: string;
  onBehalf: boolean;
  legacyImported: boolean;
  legacyMetadata?: Record<string, unknown> | null;
  evidence: {
    documentVersionId: string;
    documentCode: string;
    documentTitle: string;
    versionLabel: string;
    contentMode: DocumentContentMode;
    externalUrl?: string | null;
    contentDigest?: string | null;
    acknowledgementStatementVersion: string;
  };
  duplicate?: boolean;
  idempotent?: boolean;
  createdAt: string;
};

export type PersonalDocument = {
  id: string;
  documentId: string;
  documentVersionId: string;
  code: string;
  title: string;
  description: string;
  category: string;
  ownerFunction: string;
  versionLabel: string;
  contentMode: DocumentContentMode;
  contentAvailable: boolean;
  dueAt?: string | null;
  status: DocumentObligationStatus;
  acknowledgementRequired: boolean;
  acknowledgedAt?: string | null;
  acknowledgement?: DocumentAcknowledgementRecord | null;
  reasons: Array<{ id: string; label: string; targetType: DocumentRequirementTargetType; acknowledgementRequired: boolean }>;
  sourceRequirementIds: string[];
  canAcknowledge: boolean;
};

export type Page<T> = { total: number; limit: number; offset: number; data: T[] };
export type DocumentTotals = { documents: number; published: number; requirements: number; outstanding: number; overdue: number; acknowledged: number };
export type PersonalDocumentTotals = { required: number; awareness: number; outstanding: number; overdue: number; acknowledged: number };
export type DocumentAccess = { global: boolean; groupIds: string[]; ownMemberProfileId?: string | null };

export type DocumentQuery = { search?: string; active?: boolean; category?: string; ownerFunction?: string; sort: "title" | "code" | "updatedAt"; direction: "asc" | "desc"; mine?: boolean; status?: string; overdue?: boolean; limit: number; offset: number };
export type VersionQuery = { status?: DocumentVersionStatus; sort: "createdAt" | "versionLabel" | "status"; direction: "asc" | "desc"; limit: number; offset: number };
export type RequirementQuery = { search?: string; documentId?: string; documentVersionId?: string; targetType?: DocumentRequirementTargetType; active?: boolean; effective?: boolean; sort: "document" | "target" | "dueAt" | "updatedAt"; direction: "asc" | "desc"; limit: number; offset: number };
export type AcknowledgementQuery = { memberProfileId?: string; documentId?: string; documentVersionId?: string; dateFrom?: Date | null; dateTo?: Date | null; onBehalf?: boolean; sort: "acknowledgedAt" | "document" | "member"; direction: "asc" | "desc"; limit: number; offset: number };

export type CreateDocumentInput = { code: string; title: string; description?: string | null; category: string; ownerFunction: string };
export type UpdateDocumentInput = Partial<CreateDocumentInput>;
export type CreateVersionInput = { versionLabel: string; titleOverride?: string | null; changeSummary?: string | null; effectiveFrom?: Date | null; reviewDueAt?: Date | null; contentMode: DocumentContentMode; contentBody?: string | null; externalUrl?: string | null };
export type UpdateVersionInput = Partial<CreateVersionInput>;
export type PublishVersionInput = { expectedVersion: number; operationId: string; expectedCurrentPublishedVersionId?: string | null };
export type WithdrawVersionInput = { expectedVersion: number; operationId: string; reason?: string | null };
export type CreateRequirementInput = { documentVersionId: string; targetType: DocumentRequirementTargetType; targetRole?: string | null; groupId?: string | null; memberProfileId?: string | null; acknowledgementRequired: boolean; effectiveFrom?: Date | null; dueAt?: Date | null };
export type UpdateRequirementInput = Partial<CreateRequirementInput>;
export type EndRequirementInput = { expectedVersion: number; operationId: string; effectiveTo?: Date | null };
export type AcknowledgeInput = { operationId: string; memberProfileId?: string | null; onBehalf?: boolean; note?: string | null };

export type DocumentCompliance = {
  memberProfileId: string;
  member: DocumentMemberSummary;
  evaluationAt: string;
  status: "Not applicable" | "Attention" | "Non-compliant" | "Compliant";
  totals: { required: number; awareness: number; outstanding: number; overdue: number; acknowledged: number; unavailableContent: number };
  items: PersonalDocument[];
};
