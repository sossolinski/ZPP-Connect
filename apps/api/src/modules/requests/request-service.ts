import { HttpError } from "../../errors.js";
import type { IncidentAccessService } from "../incident-access/incident-access-service.js";
import type { IncidentAccessActor } from "../incident-access/incident-access-types.js";
import type { RequestRepository } from "./request-repository.js";
import type { AssignRequestInput, ChangePriorityInput, CreateRequestInput, RequestActor, RequestOperationInput, RequestQueueQuery, RequestReasonInput, RequestVersionInput, ResolveRequestInput, UpdateRequestInput } from "./request-types.js";

const conflictMessage = "Request was changed by another operator. Refresh before submitting the operation again";

export function createRequestService(repository: RequestRepository, incidentAccess: IncidentAccessService) {
  const context = (actor: IncidentAccessActor, incidentId: string) => incidentAccess.authorize(actor, incidentId);
  const visibility = (actor: RequestActor) => ({
    enquiry: actor.permissions.includes("enquiry:read"),
    family: actor.permissions.includes("family:read"),
    passenger: actor.permissions.includes("passenger:read"),
    release: actor.permissions.includes("release:read")
  });
  async function writeContext(actor: RequestActor, incidentId: string) {
    const value = await context(actor, incidentId);
    if (!value.writable) throw new HttpError(409, "Requests in a closed incident are read-only");
    return value;
  }
  function resolved(result: Awaited<ReturnType<RequestRepository["resolve"]>>) {
    if (result.conflict) throw new HttpError(409, conflictMessage);
    if (!result.record) throw new HttpError(404, "Request not found");
    return { ...result.record, idempotent: Boolean(result.idempotent) };
  }
  return {
    kind: repository.kind,
    listQueue: async (actor: RequestActor, incidentId: string, query: RequestQueueQuery) => repository.listQueue(await context(actor, incidentId), query, visibility(actor)),
    getContext: async (actor: RequestActor, incidentId: string, id: string) => {
      const record = await repository.getContext(await context(actor, incidentId), id, visibility(actor));
      if (!record) throw new HttpError(404, "Request not found");
      return record;
    },
    listAssignees: async (actor: RequestActor, incidentId: string, search?: string) => repository.listAssignees(await context(actor, incidentId), search),
    create: async (actor: RequestActor, incidentId: string, input: CreateRequestInput) => resolved(await repository.create(await writeContext(actor, incidentId), input, actor, visibility(actor))),
    update: async (actor: RequestActor, incidentId: string, id: string, input: UpdateRequestInput, expectedVersion: number) => resolved(await repository.update(await writeContext(actor, incidentId), id, input, expectedVersion, actor, visibility(actor))),
    assign: async (actor: RequestActor, incidentId: string, id: string, input: AssignRequestInput) => resolved(await repository.assign(await writeContext(actor, incidentId), id, input, actor, visibility(actor))),
    unassign: async (actor: RequestActor, incidentId: string, id: string, input: RequestReasonInput) => resolved(await repository.unassign(await writeContext(actor, incidentId), id, input, actor, visibility(actor))),
    changePriority: async (actor: RequestActor, incidentId: string, id: string, input: ChangePriorityInput) => resolved(await repository.changePriority(await writeContext(actor, incidentId), id, input, actor, visibility(actor))),
    transition: async (actor: RequestActor, incidentId: string, id: string, status: "IN_PROGRESS" | "WAITING", input: RequestVersionInput) => resolved(await repository.transition(await writeContext(actor, incidentId), id, status, input, actor, visibility(actor))),
    resolve: async (actor: RequestActor, incidentId: string, id: string, input: ResolveRequestInput) => resolved(await repository.resolve(await writeContext(actor, incidentId), id, input, actor, visibility(actor))),
    reopen: async (actor: RequestActor, incidentId: string, id: string, input: RequestOperationInput) => resolved(await repository.reopen(await writeContext(actor, incidentId), id, input, actor, visibility(actor))),
    cancel: async (actor: RequestActor, incidentId: string, id: string, input: RequestOperationInput) => resolved(await repository.cancel(await writeContext(actor, incidentId), id, input, actor, visibility(actor))),
    listCompatibility: async (actor: RequestActor, incidentId: string, query: RequestQueueQuery) => repository.listCompatibility(await context(actor, incidentId), query)
  };
}

export type RequestService = ReturnType<typeof createRequestService>;
