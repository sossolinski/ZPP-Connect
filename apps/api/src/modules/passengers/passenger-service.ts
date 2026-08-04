import { HttpError } from "../../errors.js";
import type { IncidentAccessService } from "../incident-access/incident-access-service.js";
import type { IncidentAccessActor } from "../incident-access/incident-access-types.js";
import type { PassengerRepository } from "./passenger-repository.js";
import type {
  PassengerActor,
  PassengerControlledField,
  PassengerCreateInput,
  PassengerImportInput,
  PassengerListQuery,
  PassengerOperatorUpdate,
  PassengerSourceCorrection
} from "./passenger-types.js";

export function createPassengerService(repository: PassengerRepository, incidentAccess: IncidentAccessService) {
  const context = (actor: IncidentAccessActor, incidentId: string) => incidentAccess.authorize(actor, incidentId);

  function assertWritable(incidentContext: Awaited<ReturnType<typeof context>>) {
    if (!incidentContext.writable) throw new HttpError(409, "Passenger records in a closed incident are read-only");
  }

  function assertDobAge(input: { dateOfBirth?: Date | string | null; age?: number | null }) {
    if (input.dateOfBirth && input.age !== null && input.age !== undefined) {
      throw new HttpError(400, "Age is only accepted when date of birth is unavailable");
    }
  }

  async function mutationContext(actor: PassengerActor, incidentId: string, passengerId: string) {
    const incidentContext = await context(actor, incidentId);
    assertWritable(incidentContext);
    const existing = await repository.getById(incidentContext, passengerId);
    if (!existing) throw new HttpError(404, "Passenger record not found");
    return incidentContext;
  }

  function resolved(result: Awaited<ReturnType<PassengerRepository["update"]>>) {
    if (result.conflict) throw new HttpError(409, "Passenger record changed since it was opened");
    if (!result.record) throw new HttpError(404, "Passenger record not found");
    return result.record;
  }

  return {
    kind: repository.kind,

    async list(actor: IncidentAccessActor, incidentId: string, query: PassengerListQuery) {
      return repository.list(await context(actor, incidentId), query);
    },

    async get(actor: IncidentAccessActor, incidentId: string, passengerId: string) {
      const record = await repository.getById(await context(actor, incidentId), passengerId);
      if (!record) throw new HttpError(404, "Passenger record not found");
      return record;
    },

    async create(actor: PassengerActor, input: PassengerCreateInput) {
      const incidentContext = await context(actor, input.sessionId);
      assertWritable(incidentContext);
      assertDobAge(input);
      return repository.create(incidentContext, input, actor);
    },

    async update(actor: PassengerActor, incidentId: string, passengerId: string, input: PassengerOperatorUpdate, expectedVersion: number) {
      const incidentContext = await mutationContext(actor, incidentId, passengerId);
      return resolved(await repository.update(incidentContext, passengerId, input, expectedVersion, actor));
    },

    async correctSource(actor: PassengerActor, incidentId: string, passengerId: string, input: PassengerSourceCorrection, expectedVersion: number) {
      const incidentContext = await mutationContext(actor, incidentId, passengerId);
      if (Object.keys(input).every((key) => key === "reason")) throw new HttpError(400, "At least one source field must be corrected");
      const existing = await repository.getById(incidentContext, passengerId);
      assertDobAge({
        dateOfBirth: input.dateOfBirth === undefined ? existing?.dateOfBirth : input.dateOfBirth,
        age: input.age === undefined ? existing?.age : input.age
      });
      return resolved(await repository.correctSource(incidentContext, passengerId, input, expectedVersion, actor));
    },

    async confirmSrc(actor: PassengerActor, incidentId: string, passengerId: string, expectedVersion: number, basis?: string) {
      const incidentContext = await mutationContext(actor, incidentId, passengerId);
      return resolved(await repository.confirmSrc(incidentContext, passengerId, expectedVersion, basis, actor));
    },

    async control(actor: PassengerActor, incidentId: string, passengerId: string, field: PassengerControlledField, value: string, reason: string, expectedVersion: number) {
      const incidentContext = await mutationContext(actor, incidentId, passengerId);
      return resolved(await repository.control(incidentContext, passengerId, field, value, reason, expectedVersion, actor));
    },

    async importRecords(actor: PassengerActor, incidentId: string, input: PassengerImportInput) {
      const incidentContext = await context(actor, incidentId);
      assertWritable(incidentContext);
      input.records.forEach(assertDobAge);
      return repository.importRecords(incidentContext, input, actor);
    }
  };
}

export type PassengerService = ReturnType<typeof createPassengerService>;
