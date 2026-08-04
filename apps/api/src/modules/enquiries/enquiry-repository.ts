import type { IncidentContext } from "../incident-access/incident-access-types.js";
import type {
  EnquiryActor,
  EnquiryCreateInput,
  EnquiryListQuery,
  EnquiryListResult,
  EnquiryMutationResult,
  EnquiryRecord,
  EnquiryTransition,
  EnquiryUpdateInput
} from "./enquiry-types.js";

export interface EnquiryRepository {
  readonly kind: "memory" | "postgres";
  list(context: IncidentContext, query: EnquiryListQuery): Promise<EnquiryListResult>;
  getById(context: IncidentContext, enquiryId: string): Promise<EnquiryRecord | null>;
  passengerBelongsToIncident(context: IncidentContext, passengerId: string): Promise<boolean>;
  create(context: IncidentContext, input: EnquiryCreateInput, actor: EnquiryActor): Promise<EnquiryRecord>;
  update(
    context: IncidentContext,
    enquiryId: string,
    input: EnquiryUpdateInput,
    expectedVersion: number,
    actor: EnquiryActor
  ): Promise<EnquiryMutationResult>;
  transition(
    context: IncidentContext,
    enquiryId: string,
    transition: EnquiryTransition,
    expectedVersion: number,
    notes: string | undefined,
    actor: EnquiryActor
  ): Promise<EnquiryMutationResult>;
}
