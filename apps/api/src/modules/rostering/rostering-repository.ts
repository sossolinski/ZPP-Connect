import type { IncidentContext } from "../incident-access/incident-access-types.js";
import type {
  AvailabilityAccess,
  AvailabilityCommandInput,
  AvailabilityQuery,
  AvailabilityRecord,
  CreateAvailabilityInput,
  CreateRosterShiftInput,
  MemberSummary,
  MutationResult,
  Page,
  RosterAccess,
  RosterCommandInput,
  RosterQuery,
  RosterShiftRecord,
  RosterStatus,
  RosteringActor,
  UpdateAvailabilityInput,
  UpdateRosterShiftInput,
} from "./rostering-types.js";

export interface FoundationRosteringRepository {
  readonly kind: "postgres";
  resolveMemberForUser(actor: RosteringActor): Promise<MemberSummary | null>;
  listShifts(context: IncidentContext, query: RosterQuery, access: RosterAccess, actor: RosteringActor): Promise<Page<RosterShiftRecord>>;
  getShift(context: IncidentContext, id: string, access: RosterAccess, actor: RosteringActor): Promise<RosterShiftRecord | null>;
  createShift(context: IncidentContext, input: CreateRosterShiftInput, actor: RosteringActor): Promise<MutationResult<RosterShiftRecord>>;
  updateShift(context: IncidentContext, id: string, input: UpdateRosterShiftInput, expectedVersion: number, actor: RosteringActor): Promise<MutationResult<RosterShiftRecord>>;
  transitionShift(context: IncidentContext, id: string, nextStatus: RosterStatus, input: RosterCommandInput, actor: RosteringActor): Promise<MutationResult<RosterShiftRecord>>;
  listAvailability(query: AvailabilityQuery, access: AvailabilityAccess, actor: RosteringActor): Promise<Page<AvailabilityRecord>>;
  getAvailability(id: string, access: AvailabilityAccess, actor: RosteringActor): Promise<AvailabilityRecord | null>;
  createAvailability(input: CreateAvailabilityInput, memberProfileId: string, actor: RosteringActor): Promise<MutationResult<AvailabilityRecord>>;
  updateAvailability(id: string, input: UpdateAvailabilityInput, expectedVersion: number, memberProfileId: string, actor: RosteringActor): Promise<MutationResult<AvailabilityRecord>>;
  removeAvailability(id: string, input: AvailabilityCommandInput, actor: RosteringActor): Promise<MutationResult<AvailabilityRecord>>;
  readinessAvailability(memberProfileId: string, from: Date, to: Date): Promise<AvailabilityRecord[]>;
  readinessRoster(memberProfileId: string, from: Date, to: Date, incidentIds: string[] | null): Promise<RosterShiftRecord[]>;
}
