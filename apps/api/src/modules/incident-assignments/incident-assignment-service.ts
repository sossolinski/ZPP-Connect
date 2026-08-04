import { HttpError } from "../../errors.js";
import type { IncidentAccessService } from "../incident-access/incident-access-service.js";
import type { IncidentAssignmentRepository } from "./incident-assignment-repository.js";
import type { IncidentAssignmentActor, IncidentAssignmentCreateInput, IncidentAssignmentMutation } from "./incident-assignment-types.js";

function unwrap(result: IncidentAssignmentMutation, conflictMessage: string) {
  if (result.outcome === "not_found") throw new HttpError(404, "Incident assignment not found");
  if (result.outcome === "conflict") throw new HttpError(409, conflictMessage);
  if (result.outcome === "ok") return result.record;
  throw new HttpError(500, "Unexpected incident assignment state");
}

export function createIncidentAssignmentService(repository: IncidentAssignmentRepository, access: IncidentAccessService) {
  return {
    kind: repository.kind,

    async list(actor: IncidentAssignmentActor, incidentId: string, includeInactive: boolean) {
      await access.authorize(actor, incidentId);
      return { data: await repository.list(incidentId, includeInactive) };
    },

    async assign(actor: IncidentAssignmentActor, incidentId: string, input: IncidentAssignmentCreateInput) {
      await access.authorize(actor, incidentId);
      return unwrap(await repository.assign(incidentId, input, actor), "The user already has an assignment; reactivate an inactive assignment explicitly");
    },

    async revoke(actor: IncidentAssignmentActor, incidentId: string, assignmentId: string, reason: string | null) {
      await access.authorize(actor, incidentId);
      return unwrap(await repository.revoke(incidentId, assignmentId, reason, actor), "The incident assignment is already inactive");
    },

    async reactivate(actor: IncidentAssignmentActor, incidentId: string, assignmentId: string, reason: string | null) {
      await access.authorize(actor, incidentId);
      return unwrap(await repository.reactivate(incidentId, assignmentId, reason, actor), "The incident assignment is already active");
    }
  };
}

export type IncidentAssignmentService = ReturnType<typeof createIncidentAssignmentService>;
