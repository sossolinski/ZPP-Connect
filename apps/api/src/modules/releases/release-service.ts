import { HttpError } from "../../errors.js";
import type { IncidentAccessService } from "../incident-access/incident-access-service.js";
import type { IncidentAccessActor } from "../incident-access/incident-access-types.js";
import type { ReleaseRepository } from "./release-repository.js";
import type { PrepareReleaseInput, RecordHoldReviewInput, RecordIdentityCheckInput, ReleaseActor, ReleaseCandidateQuery, ReleaseDecisionInput, ReleaseQueueQuery } from "./release-types.js";

const conflictMessage = "This release action or its safety inputs changed. Refresh before submitting the decision again";

export function createReleaseService(repository: ReleaseRepository, incidentAccess: IncidentAccessService) {
  const context = (actor: IncidentAccessActor, incidentId: string) => incidentAccess.authorize(actor, incidentId);
  function assertWritable(value: Awaited<ReturnType<typeof context>>) {
    if (!value.writable) throw new HttpError(409, "Release workflows in a closed incident are read-only");
  }
  async function mutationContext(actor: ReleaseActor, incidentId: string) {
    const value = await context(actor, incidentId);
    assertWritable(value);
    return value;
  }
  function resolved(result: Awaited<ReturnType<ReleaseRepository["authorize"]>>) {
    if (result.conflict) throw new HttpError(409, conflictMessage);
    if (!result.record) throw new HttpError(404, "Release action not found");
    return { ...result.record, idempotent: Boolean(result.idempotent) };
  }
  return {
    kind: repository.kind,
    listQueue: async (actor: IncidentAccessActor, incidentId: string, query: ReleaseQueueQuery) => repository.listQueue(await context(actor, incidentId), query),
    listCandidates: async (actor: IncidentAccessActor, incidentId: string, query: ReleaseCandidateQuery) => repository.listCandidates(await context(actor, incidentId), query),
    getContext: async (actor: IncidentAccessActor, incidentId: string, id: string) => {
      const record = await repository.getContext(await context(actor, incidentId), id);
      if (!record) throw new HttpError(404, "Release action not found");
      return record;
    },
    prepare: async (actor: ReleaseActor, incidentId: string, input: PrepareReleaseInput) => resolved(await repository.prepare(await mutationContext(actor, incidentId), input, actor)),
    recordIdentityCheck: async (actor: ReleaseActor, incidentId: string, id: string, input: RecordIdentityCheckInput) => resolved(await repository.recordIdentityCheck(await mutationContext(actor, incidentId), id, input, actor)),
    recordHoldReview: async (actor: ReleaseActor, incidentId: string, id: string, input: RecordHoldReviewInput) => resolved(await repository.recordHoldReview(await mutationContext(actor, incidentId), id, input, actor)),
    authorize: async (actor: ReleaseActor, incidentId: string, id: string, input: ReleaseDecisionInput) => resolved(await repository.authorize(await mutationContext(actor, incidentId), id, input, actor)),
    complete: async (actor: ReleaseActor, incidentId: string, id: string, input: ReleaseDecisionInput) => resolved(await repository.complete(await mutationContext(actor, incidentId), id, input, actor)),
    cancel: async (actor: ReleaseActor, incidentId: string, id: string, input: ReleaseDecisionInput) => resolved(await repository.cancel(await mutationContext(actor, incidentId), id, input, actor)),
    listCompatibility: async (actor: IncidentAccessActor, incidentId: string, query: ReleaseQueueQuery) => repository.listCompatibility(await context(actor, incidentId), query)
  };
}

export type ReleaseService = ReturnType<typeof createReleaseService>;
