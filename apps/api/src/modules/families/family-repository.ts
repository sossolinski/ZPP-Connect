import type { IncidentContext } from "../incident-access/incident-access-types.js";
import type {
  FamilyActor,
  FamilyClaimCorrection,
  FamilyCreateInput,
  FamilyDecisionInput,
  FamilyImportInput,
  FamilyImportResult,
  FamilyListQuery,
  FamilyListResult,
  FamilyMutationResult,
  FamilyOperatorFields,
  FamilyRecord
} from "./family-types.js";

export interface FamilyRepository {
  readonly kind: "memory" | "postgres";
  list(context: IncidentContext, query: FamilyListQuery): Promise<FamilyListResult>;
  getById(context: IncidentContext, familyId: string): Promise<FamilyRecord | null>;
  create(context: IncidentContext, input: FamilyCreateInput, actor: FamilyActor): Promise<FamilyRecord>;
  update(context: IncidentContext, familyId: string, input: FamilyOperatorFields, expectedVersion: number, actor: FamilyActor): Promise<FamilyMutationResult>;
  correctClaim(context: IncidentContext, familyId: string, input: FamilyClaimCorrection, expectedVersion: number, expectedClaimVersion: number, actor: FamilyActor): Promise<FamilyMutationResult>;
  decide(context: IncidentContext, familyId: string, input: FamilyDecisionInput, expectedVersion: number, expectedClaimVersion: number, actor: FamilyActor): Promise<FamilyMutationResult>;
  importRecords(context: IncidentContext, input: FamilyImportInput, actor: FamilyActor): Promise<FamilyImportResult>;
}
