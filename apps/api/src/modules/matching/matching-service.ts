import { HttpError } from "../../errors.js";
import type { IncidentAccessService } from "../incident-access/incident-access-service.js";
import type { IncidentAccessActor } from "../incident-access/incident-access-types.js";
import type { MatchingRepository } from "./matching-repository.js";
import type { CandidateQuery, GenerateSuggestionsInput, MatchConfirmInput, MatchHoldInput, MatchInvalidateInput, MatchRejectInput, MatchingActor, MatchingPageQuery, MatchingQueueQuery, SuggestionQuery } from "./matching-types.js";

const conflictMessage = "This matching context or decision was changed by another user. Refresh the data before deciding again";

export function createMatchingService(repository: MatchingRepository, incidentAccess: IncidentAccessService) {
  const context = (actor: IncidentAccessActor, incidentId: string) => incidentAccess.authorize(actor, incidentId);
  function assertWritable(value: Awaited<ReturnType<typeof context>>) {
    if (!value.writable) throw new HttpError(409, "Matching in a closed incident is read-only");
  }
  async function mutationContext(actor: MatchingActor, incidentId: string) {
    const value = await context(actor, incidentId);
    assertWritable(value);
    return value;
  }
  function resolved(result: Awaited<ReturnType<MatchingRepository["confirm"]>>) {
    if (result.conflict) throw new HttpError(409, conflictMessage);
    if (!result.record) throw new HttpError(404, "Current relationship claim not found");
    return { ...result.record, idempotent: Boolean(result.idempotent) };
  }
  return {
    kind: repository.kind,
    listQueue: async (actor: IncidentAccessActor, incidentId: string, query: MatchingQueueQuery) => repository.listQueue(await context(actor, incidentId), query),
    getContext: async (actor: IncidentAccessActor, incidentId: string, claimId: string) => {
      const record = await repository.getContext(await context(actor, incidentId), claimId);
      if (!record) throw new HttpError(404, "Current relationship claim not found");
      return record;
    },
    listSuggestions: async (actor: IncidentAccessActor, incidentId: string, claimId: string, query: SuggestionQuery) => repository.listSuggestions(await context(actor, incidentId), claimId, query),
    generateSuggestions: async (actor: MatchingActor, incidentId: string, claimId: string, input: GenerateSuggestionsInput) => repository.generateSuggestions(await mutationContext(actor, incidentId), claimId, input, actor),
    listCandidates: async (actor: IncidentAccessActor, incidentId: string, claimId: string, query: CandidateQuery) => repository.listCandidates(await context(actor, incidentId), claimId, query),
    confirm: async (actor: MatchingActor, incidentId: string, claimId: string, input: MatchConfirmInput) => resolved(await repository.confirm(await mutationContext(actor, incidentId), claimId, input, actor)),
    reject: async (actor: MatchingActor, incidentId: string, claimId: string, input: MatchRejectInput) => resolved(await repository.reject(await mutationContext(actor, incidentId), claimId, input, actor)),
    invalidate: async (actor: MatchingActor, incidentId: string, claimId: string, input: MatchInvalidateInput) => resolved(await repository.invalidate(await mutationContext(actor, incidentId), claimId, input, actor)),
    setHold: async (actor: MatchingActor, incidentId: string, matchingRecordId: string, input: MatchHoldInput) => {
      const result = await repository.setHold(await mutationContext(actor, incidentId), matchingRecordId, input, actor);
      if (result.conflict) throw new HttpError(409, conflictMessage);
      if (!result.record) throw new HttpError(404, "Matching record not found");
      return result.record;
    },
    listCompatibility: async (actor: IncidentAccessActor, incidentId: string, query: MatchingPageQuery) => repository.listCompatibility(await context(actor, incidentId), query),
    getReleaseCompatibility: async (actor: IncidentAccessActor, incidentId: string, matchingRecordId: string) => {
      const record = await repository.getReleaseCompatibility(await context(actor, incidentId), matchingRecordId);
      if (!record) throw new HttpError(404, "Matching record not found");
      return record;
    }
  };
}

export type MatchingService = ReturnType<typeof createMatchingService>;
