import { HttpError } from "../../errors.js";
import type { IncidentAccessService } from "../incident-access/incident-access-service.js";
import type { IncidentAccessActor } from "../incident-access/incident-access-types.js";
import type { EnquiryRepository } from "./enquiry-repository.js";
import type { EnquiryActor, EnquiryCreateInput, EnquiryListQuery, EnquiryTransition, EnquiryUpdateInput } from "./enquiry-types.js";

const terminalStatuses = new Set(["Closed"]);
const genericEditableStatuses = new Set(["New", "In progress"]);
const transitions: Record<EnquiryTransition, { target: string; allowed: Set<string> }> = {
  "send-to-family-assistance": { target: "Sent to family assistance", allowed: new Set(["New", "In progress", "Urgent welfare", "Duplicate suspected"]) },
  "mark-urgent": { target: "Urgent welfare", allowed: new Set(["New", "In progress", "Sent to family assistance", "Duplicate suspected"]) },
  "mark-duplicate": { target: "Duplicate suspected", allowed: new Set(["New", "In progress", "Sent to family assistance", "Urgent welfare"]) },
  close: { target: "Closed", allowed: new Set(["New", "In progress", "Sent to family assistance", "Urgent welfare", "Duplicate suspected"]) }
};

export function createEnquiryService(repository: EnquiryRepository, incidentAccess: IncidentAccessService) {
  async function context(actor: IncidentAccessActor, incidentId: string) {
    return incidentAccess.authorize(actor, incidentId);
  }

  async function assertPassengerScope(incidentContext: Awaited<ReturnType<typeof context>>, passengerId?: string | null) {
    if (!passengerId) return;
    if (!(await repository.passengerBelongsToIncident(incidentContext, passengerId))) {
      throw new HttpError(409, "Passenger record must belong to the same incident");
    }
  }

  function assertWritable(incidentContext: Awaited<ReturnType<typeof context>>) {
    if (!incidentContext.writable) throw new HttpError(409, "Enquiries in a closed incident are read-only");
  }

  return {
    kind: repository.kind,

    async list(actor: IncidentAccessActor, incidentId: string, query: EnquiryListQuery) {
      return repository.list(await context(actor, incidentId), query);
    },

    async get(actor: IncidentAccessActor, incidentId: string, enquiryId: string) {
      const record = await repository.getById(await context(actor, incidentId), enquiryId);
      if (!record) throw new HttpError(404, "Enquiry not found");
      return record;
    },

    async create(actor: EnquiryActor, input: EnquiryCreateInput) {
      const incidentContext = await context(actor, input.sessionId);
      assertWritable(incidentContext);
      if (input.status !== "New") throw new HttpError(400, "A new enquiry must start with status New");
      if (input.urgency === "Urgent welfare") throw new HttpError(400, "Use the dedicated mark-urgent action");
      await assertPassengerScope(incidentContext, input.passengerRecordId);
      return repository.create(incidentContext, input, actor);
    },

    async update(actor: EnquiryActor, incidentId: string, enquiryId: string, input: EnquiryUpdateInput, expectedVersion: number) {
      const incidentContext = await context(actor, incidentId);
      assertWritable(incidentContext);
      const existing = await repository.getById(incidentContext, enquiryId);
      if (!existing) throw new HttpError(404, "Enquiry not found");
      if (terminalStatuses.has(existing.status)) throw new HttpError(409, "Closed enquiries are read-only");
      if (
        input.status !== undefined &&
        input.status !== existing.status &&
        !(genericEditableStatuses.has(existing.status) && genericEditableStatuses.has(input.status))
      ) {
        throw new HttpError(400, "Enquiry status can only change through a dedicated workflow action");
      }
      if (input.urgency !== undefined && input.urgency !== existing.urgency && (input.urgency === "Urgent welfare" || existing.urgency === "Urgent welfare")) {
        throw new HttpError(400, "Urgent welfare can only change through a dedicated workflow action");
      }
      const editable = { ...input };
      if (editable.status === existing.status) delete editable.status;
      if (editable.urgency === existing.urgency) delete editable.urgency;
      await assertPassengerScope(incidentContext, editable.passengerRecordId);
      const result = await repository.update(incidentContext, enquiryId, editable, expectedVersion, actor);
      if (result.conflict) throw new HttpError(409, "Enquiry changed since it was opened");
      if (!result.record) throw new HttpError(404, "Enquiry not found");
      return result.record;
    },

    async transition(
      actor: EnquiryActor,
      incidentId: string,
      enquiryId: string,
      transition: EnquiryTransition,
      expectedVersion: number,
      notes?: string
    ) {
      const incidentContext = await context(actor, incidentId);
      assertWritable(incidentContext);
      const existing = await repository.getById(incidentContext, enquiryId);
      if (!existing) throw new HttpError(404, "Enquiry not found");
      const rule = transitions[transition];
      if (!rule.allowed.has(existing.status)) throw new HttpError(409, `Invalid enquiry transition from ${existing.status} to ${rule.target}`);
      const result = await repository.transition(incidentContext, enquiryId, transition, expectedVersion, notes, actor);
      if (result.conflict) throw new HttpError(409, "Enquiry changed since it was opened");
      if (!result.record) throw new HttpError(404, "Enquiry not found");
      return result.record;
    }
  };
}

export type EnquiryService = ReturnType<typeof createEnquiryService>;
