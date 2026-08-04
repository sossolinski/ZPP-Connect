import type { IncidentContext } from "../incident-access/incident-access-types.js";
import type {
  PassengerActor,
  PassengerControlledField,
  PassengerCreateInput,
  PassengerImportInput,
  PassengerImportResult,
  PassengerListQuery,
  PassengerListResult,
  PassengerMutationResult,
  PassengerOperatorUpdate,
  PassengerRecord,
  PassengerSourceCorrection
} from "./passenger-types.js";

export interface PassengerRepository {
  readonly kind: "memory" | "postgres";
  list(context: IncidentContext, query: PassengerListQuery): Promise<PassengerListResult>;
  getById(context: IncidentContext, passengerId: string): Promise<PassengerRecord | null>;
  create(context: IncidentContext, input: PassengerCreateInput, actor: PassengerActor): Promise<PassengerRecord>;
  update(context: IncidentContext, passengerId: string, input: PassengerOperatorUpdate, expectedVersion: number, actor: PassengerActor): Promise<PassengerMutationResult>;
  correctSource(context: IncidentContext, passengerId: string, input: PassengerSourceCorrection, expectedVersion: number, actor: PassengerActor): Promise<PassengerMutationResult>;
  confirmSrc(context: IncidentContext, passengerId: string, expectedVersion: number, basis: string | undefined, actor: PassengerActor): Promise<PassengerMutationResult>;
  control(context: IncidentContext, passengerId: string, field: PassengerControlledField, value: string, reason: string, expectedVersion: number, actor: PassengerActor): Promise<PassengerMutationResult>;
  importRecords(context: IncidentContext, input: PassengerImportInput, actor: PassengerActor): Promise<PassengerImportResult>;
}
