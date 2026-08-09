import type { IncidentContext } from "../incident-access/incident-access-types.js";
import type {
  AssignAssignmentInput,
  AssignmentActor,
  AssignmentCandidateResult,
  AssignmentCompatibilityRecord,
  AssignmentListResult,
  AssignmentMutationResult,
  AssignmentQueueQuery,
  AssignmentReasonInput,
  AssignmentRetryInput,
  AssignmentRetryReasonInput,
  AssignmentStatus,
  AssignmentVersionInput,
  CompleteAssignmentInput,
  CreateAssignmentInput,
  ReassignAssignmentInput,
  UpdateAssignmentInput,
} from "./assignment-types.js";

export interface AssignmentRepository {
  readonly kind: "memory" | "postgres";
  listQueue(context: IncidentContext, query: AssignmentQueueQuery, actor: AssignmentActor): Promise<AssignmentListResult>;
  getContext(context: IncidentContext, id: string, actor: AssignmentActor): Promise<AssignmentMutationResult["record"]>;
  listAssignees(context: IncidentContext, search: string | undefined, limit: number, offset: number): Promise<AssignmentCandidateResult>;
  create(context: IncidentContext, input: CreateAssignmentInput, actor: AssignmentActor): Promise<AssignmentMutationResult>;
  update(context: IncidentContext, id: string, input: UpdateAssignmentInput, expectedVersion: number, actor: AssignmentActor): Promise<AssignmentMutationResult>;
  assign(context: IncidentContext, id: string, input: AssignAssignmentInput, actor: AssignmentActor): Promise<AssignmentMutationResult>;
  claim(context: IncidentContext, id: string, input: AssignmentRetryInput, actor: AssignmentActor): Promise<AssignmentMutationResult>;
  reassign(context: IncidentContext, id: string, input: ReassignAssignmentInput, actor: AssignmentActor): Promise<AssignmentMutationResult>;
  transition(context: IncidentContext, id: string, target: Extract<AssignmentStatus, "In Progress" | "Escalated">, input: AssignmentVersionInput | AssignmentReasonInput, actor: AssignmentActor): Promise<AssignmentMutationResult>;
  complete(context: IncidentContext, id: string, input: CompleteAssignmentInput, actor: AssignmentActor): Promise<AssignmentMutationResult>;
  cancel(context: IncidentContext, id: string, input: AssignmentRetryReasonInput, actor: AssignmentActor): Promise<AssignmentMutationResult>;
  listCompatibility(context: IncidentContext, query: AssignmentQueueQuery, actor: AssignmentActor): Promise<{ total: number; data: AssignmentCompatibilityRecord[] }>;
}
