import type { IncidentContext } from "../incident-access/incident-access-types.js";
import type {
  PrepareReleaseInput,
  RecordHoldReviewInput,
  RecordIdentityCheckInput,
  ReleaseActionRecord,
  ReleaseActor,
  ReleaseCandidateQuery,
  ReleaseCandidateRecord,
  ReleaseCompatibilityRecord,
  ReleaseDecisionInput,
  ReleaseListResult,
  ReleaseMutationResult,
  ReleaseQueueQuery
} from "./release-types.js";

export interface ReleaseRepository {
  readonly kind: "memory" | "postgres";
  listQueue(context: IncidentContext, query: ReleaseQueueQuery): Promise<ReleaseListResult<ReleaseActionRecord>>;
  listCandidates(context: IncidentContext, query: ReleaseCandidateQuery): Promise<ReleaseListResult<ReleaseCandidateRecord>>;
  getContext(context: IncidentContext, releaseActionId: string): Promise<ReleaseActionRecord | null>;
  prepare(context: IncidentContext, input: PrepareReleaseInput, actor: ReleaseActor): Promise<ReleaseMutationResult>;
  recordIdentityCheck(context: IncidentContext, releaseActionId: string, input: RecordIdentityCheckInput, actor: ReleaseActor): Promise<ReleaseMutationResult>;
  recordHoldReview(context: IncidentContext, releaseActionId: string, input: RecordHoldReviewInput, actor: ReleaseActor): Promise<ReleaseMutationResult>;
  authorize(context: IncidentContext, releaseActionId: string, input: ReleaseDecisionInput, actor: ReleaseActor): Promise<ReleaseMutationResult>;
  complete(context: IncidentContext, releaseActionId: string, input: ReleaseDecisionInput, actor: ReleaseActor): Promise<ReleaseMutationResult>;
  cancel(context: IncidentContext, releaseActionId: string, input: ReleaseDecisionInput, actor: ReleaseActor): Promise<ReleaseMutationResult>;
  listCompatibility(context: IncidentContext, query: ReleaseQueueQuery): Promise<ReleaseListResult<ReleaseCompatibilityRecord>>;
}
