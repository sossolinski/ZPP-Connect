import type { IncidentContext } from "../incident-access/incident-access-types.js";
import type {
  CandidateQuery,
  GenerateSuggestionsInput,
  MatchConfirmInput,
  MatchHoldInput,
  MatchInvalidateInput,
  MatchRejectInput,
  MatchingActor,
  MatchingCompatibilityRecord,
  MatchingContextRecord,
  MatchingListResult,
  MatchingMutationResult,
  MatchingPageQuery,
  MatchingPassengerProjection,
  MatchingQueueItem,
  MatchingQueueQuery,
  MatchSuggestionRecord,
  SuggestionQuery
} from "./matching-types.js";

export interface MatchingRepository {
  readonly kind: "memory" | "postgres";
  listQueue(context: IncidentContext, query: MatchingQueueQuery): Promise<MatchingListResult<MatchingQueueItem>>;
  getContext(context: IncidentContext, claimId: string): Promise<MatchingContextRecord | null>;
  listSuggestions(context: IncidentContext, claimId: string, query: SuggestionQuery): Promise<MatchingListResult<MatchSuggestionRecord>>;
  generateSuggestions(context: IncidentContext, claimId: string, input: GenerateSuggestionsInput, actor: MatchingActor): Promise<MatchingListResult<MatchSuggestionRecord>>;
  listCandidates(context: IncidentContext, claimId: string, query: CandidateQuery): Promise<MatchingListResult<MatchingPassengerProjection>>;
  confirm(context: IncidentContext, claimId: string, input: MatchConfirmInput, actor: MatchingActor): Promise<MatchingMutationResult>;
  reject(context: IncidentContext, claimId: string, input: MatchRejectInput, actor: MatchingActor): Promise<MatchingMutationResult>;
  invalidate(context: IncidentContext, claimId: string, input: MatchInvalidateInput, actor: MatchingActor): Promise<MatchingMutationResult>;
  setHold(context: IncidentContext, matchingRecordId: string, input: MatchHoldInput, actor: MatchingActor): Promise<{ record: MatchingCompatibilityRecord | null; conflict: boolean }>;
  listCompatibility(context: IncidentContext, query: MatchingPageQuery): Promise<MatchingListResult<MatchingCompatibilityRecord>>;
  getReleaseCompatibility(context: IncidentContext, matchingRecordId: string): Promise<MatchingCompatibilityRecord | null>;
}
