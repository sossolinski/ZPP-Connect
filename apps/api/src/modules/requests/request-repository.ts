import type { IncidentContext } from "../incident-access/incident-access-types.js";
import type { AssignRequestInput, ChangePriorityInput, CreateRequestInput, RequestActor, RequestCompatibilityRecord, RequestListResult, RequestMutationResult, RequestOperationInput, RequestQueueQuery, RequestReasonInput, RequestRecord, RequestVersionInput, RequestVisibility, ResolveRequestInput, UpdateRequestInput } from "./request-types.js";

export interface RequestRepository {
  readonly kind: "memory" | "postgres";
  listQueue(context: IncidentContext, query: RequestQueueQuery, visibility: RequestVisibility): Promise<RequestListResult>;
  getContext(context: IncidentContext, id: string, visibility: RequestVisibility): Promise<RequestRecord | null>;
  listAssignees(context: IncidentContext, search?: string): Promise<Array<{ id: string; displayName: string; email: string }>>;
  create(context: IncidentContext, input: CreateRequestInput, actor: RequestActor, visibility: RequestVisibility): Promise<RequestMutationResult>;
  update(context: IncidentContext, id: string, input: UpdateRequestInput, expectedVersion: number, actor: RequestActor, visibility: RequestVisibility): Promise<RequestMutationResult>;
  assign(context: IncidentContext, id: string, input: AssignRequestInput, actor: RequestActor, visibility: RequestVisibility): Promise<RequestMutationResult>;
  unassign(context: IncidentContext, id: string, input: RequestReasonInput, actor: RequestActor, visibility: RequestVisibility): Promise<RequestMutationResult>;
  changePriority(context: IncidentContext, id: string, input: ChangePriorityInput, actor: RequestActor, visibility: RequestVisibility): Promise<RequestMutationResult>;
  transition(context: IncidentContext, id: string, status: "IN_PROGRESS" | "WAITING", input: RequestVersionInput, actor: RequestActor, visibility: RequestVisibility): Promise<RequestMutationResult>;
  resolve(context: IncidentContext, id: string, input: ResolveRequestInput, actor: RequestActor, visibility: RequestVisibility): Promise<RequestMutationResult>;
  reopen(context: IncidentContext, id: string, input: RequestOperationInput, actor: RequestActor, visibility: RequestVisibility): Promise<RequestMutationResult>;
  cancel(context: IncidentContext, id: string, input: RequestOperationInput, actor: RequestActor, visibility: RequestVisibility): Promise<RequestMutationResult>;
  listCompatibility(context: IncidentContext, query: RequestQueueQuery): Promise<{ total: number; data: RequestCompatibilityRecord[] }>;
}
