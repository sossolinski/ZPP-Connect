import type {
  AcknowledgementQuery,
  AcknowledgeInput,
  CreateDocumentInput,
  CreateRequirementInput,
  CreateVersionInput,
  DocumentAccess,
  DocumentAcknowledgementRecord,
  DocumentActor,
  DocumentCompliance,
  DocumentGroupSummary,
  DocumentQuery,
  DocumentRequirementRecord,
  DocumentSummary,
  DocumentVersionRecord,
  EndRequirementInput,
  Page,
  PersonalDocument,
  PersonalDocumentTotals,
  PublishVersionInput,
  RequirementQuery,
  UpdateDocumentInput,
  UpdateRequirementInput,
  UpdateVersionInput,
  VersionQuery,
  WithdrawVersionInput,
  DocumentTotals,
  DocumentMemberSummary,
} from "./document-types.js";

export type MutationResult<T> = { record: T | null; conflict: boolean; reason?: string; idempotent?: boolean };

export interface FoundationDocumentRepository {
  readonly kind: "postgres";
  resolveMemberForUser(actor: DocumentActor): Promise<DocumentMemberSummary | null>;
  memberAccessible(memberProfileId: string, access: DocumentAccess): Promise<boolean>;
  getGroup(groupId: string): Promise<DocumentGroupSummary | null>;

  listDocuments(query: DocumentQuery, access: DocumentAccess, actor: DocumentActor, evaluationAt: Date): Promise<Page<DocumentSummary | PersonalDocument> & { totals: DocumentTotals | PersonalDocumentTotals; linkedMemberProfile?: DocumentMemberSummary | null }>;
  getDocument(id: string, access: DocumentAccess, actor: DocumentActor, evaluationAt: Date): Promise<DocumentSummary | null>;
  createDocument(input: CreateDocumentInput, actor: DocumentActor): Promise<MutationResult<DocumentSummary>>;
  updateDocument(id: string, input: UpdateDocumentInput, expectedVersion: number, actor: DocumentActor): Promise<MutationResult<DocumentSummary>>;
  setDocumentActive(id: string, active: boolean, expectedVersion: number, actor: DocumentActor): Promise<MutationResult<DocumentSummary>>;

  listVersions(documentId: string, query: VersionQuery, access: DocumentAccess, actor: DocumentActor, evaluationAt: Date): Promise<Page<DocumentVersionRecord>>;
  getVersion(id: string, access: DocumentAccess, actor: DocumentActor, evaluationAt: Date, includeContent?: boolean): Promise<DocumentVersionRecord | null>;
  createVersion(documentId: string, input: CreateVersionInput, actor: DocumentActor): Promise<MutationResult<DocumentVersionRecord>>;
  updateVersion(id: string, input: UpdateVersionInput, expectedVersion: number, actor: DocumentActor): Promise<MutationResult<DocumentVersionRecord>>;
  publishVersion(id: string, input: PublishVersionInput, actor: DocumentActor): Promise<MutationResult<DocumentVersionRecord>>;
  withdrawVersion(id: string, input: WithdrawVersionInput, actor: DocumentActor): Promise<MutationResult<DocumentVersionRecord>>;

  listRequirements(query: RequirementQuery, access: DocumentAccess, actor: DocumentActor, evaluationAt: Date): Promise<Page<DocumentRequirementRecord>>;
  getRequirement(id: string, access: DocumentAccess, actor: DocumentActor, evaluationAt: Date): Promise<DocumentRequirementRecord | null>;
  createRequirement(input: CreateRequirementInput, actor: DocumentActor, incidentId?: string | null): Promise<MutationResult<DocumentRequirementRecord>>;
  updateRequirement(id: string, input: UpdateRequirementInput, expectedVersion: number, actor: DocumentActor, incidentId?: string | null): Promise<MutationResult<DocumentRequirementRecord>>;
  endRequirement(id: string, input: EndRequirementInput, actor: DocumentActor, incidentId?: string | null): Promise<MutationResult<DocumentRequirementRecord>>;

  listAcknowledgements(query: AcknowledgementQuery, access: DocumentAccess, actor: DocumentActor, evaluationAt: Date): Promise<Page<DocumentAcknowledgementRecord>>;
  acknowledgeVersion(id: string, input: AcknowledgeInput, memberProfileId: string, actor: DocumentActor): Promise<MutationResult<DocumentAcknowledgementRecord>>;
  evaluateMemberCompliance(memberProfileId: string, actor: DocumentActor, evaluationAt: Date): Promise<DocumentCompliance | null>;
}
