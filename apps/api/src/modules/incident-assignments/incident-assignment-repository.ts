import type {
  IncidentAssignmentActor,
  IncidentAssignmentCreateInput,
  IncidentAssignmentMutation,
  IncidentAssignmentRecord
} from "./incident-assignment-types.js";

export interface IncidentAssignmentRepository {
  readonly kind: "memory" | "postgres";
  list(incidentId: string, includeInactive: boolean): Promise<IncidentAssignmentRecord[]>;
  assign(incidentId: string, input: IncidentAssignmentCreateInput, actor: IncidentAssignmentActor): Promise<IncidentAssignmentMutation>;
  revoke(incidentId: string, assignmentId: string, reason: string | null, actor: IncidentAssignmentActor): Promise<IncidentAssignmentMutation>;
  reactivate(incidentId: string, assignmentId: string, reason: string | null, actor: IncidentAssignmentActor): Promise<IncidentAssignmentMutation>;
}
