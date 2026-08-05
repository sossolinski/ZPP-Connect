import { HttpError } from "../../errors.js";
import type { IncidentAccessService } from "../incident-access/incident-access-service.js";
import type { IncidentAccessActor } from "../incident-access/incident-access-types.js";
import type { FamilyRepository } from "./family-repository.js";
import type { FamilyActor, FamilyClaimCorrection, FamilyCreateInput, FamilyDecisionInput, FamilyImportInput, FamilyListQuery, FamilyOperatorFields } from "./family-types.js";

export function normalizeEmail(value?: string | null) {
  return value?.trim().toLocaleLowerCase() || null;
}

export function normalizePhone(value?: string | null) {
  if (!value?.trim()) return null;
  const trimmed = value.trim();
  const prefix = trimmed.startsWith("+") ? "+" : "";
  const digits = trimmed.replace(/\D/g, "");
  return digits ? `${prefix}${digits}` : null;
}

export function createFamilyService(repository: FamilyRepository, incidentAccess: IncidentAccessService) {
  const context = (actor: IncidentAccessActor, incidentId: string) => incidentAccess.authorize(actor, incidentId);

  function assertWritable(incidentContext: Awaited<ReturnType<typeof context>>) {
    if (!incidentContext.writable) throw new HttpError(409, "Family/NOK records in a closed incident are read-only");
  }

  async function mutationContext(actor: FamilyActor, incidentId: string, familyId: string) {
    const incidentContext = await context(actor, incidentId);
    assertWritable(incidentContext);
    const existing = await repository.getById(incidentContext, familyId);
    if (!existing) throw new HttpError(404, "Family/NOK record not found");
    return incidentContext;
  }

  function resolved(result: Awaited<ReturnType<FamilyRepository["update"]>>) {
    if (result.conflict) throw new HttpError(409, "This record or decision was changed by another user. Refresh the data before making the decision again");
    if (!result.record) throw new HttpError(404, "Family/NOK record not found");
    return result.record;
  }

  return {
    kind: repository.kind,

    async list(actor: IncidentAccessActor, incidentId: string, query: FamilyListQuery) {
      return repository.list(await context(actor, incidentId), query);
    },

    async get(actor: IncidentAccessActor, incidentId: string, familyId: string) {
      const record = await repository.getById(await context(actor, incidentId), familyId);
      if (!record) throw new HttpError(404, "Family/NOK record not found");
      return record;
    },

    async create(actor: FamilyActor, input: FamilyCreateInput) {
      const incidentContext = await context(actor, input.sessionId);
      assertWritable(incidentContext);
      return repository.create(incidentContext, input, actor);
    },

    async update(actor: FamilyActor, incidentId: string, familyId: string, input: FamilyOperatorFields, expectedVersion: number) {
      return resolved(await repository.update(await mutationContext(actor, incidentId, familyId), familyId, input, expectedVersion, actor));
    },

    async correctClaim(actor: FamilyActor, incidentId: string, familyId: string, input: FamilyClaimCorrection, expectedVersion: number, expectedClaimVersion: number) {
      if (Object.keys(input).every((key) => key === "reason")) throw new HttpError(400, "At least one claimed fact must be corrected");
      return resolved(await repository.correctClaim(await mutationContext(actor, incidentId, familyId), familyId, input, expectedVersion, expectedClaimVersion, actor));
    },

    async decide(actor: FamilyActor, incidentId: string, familyId: string, input: FamilyDecisionInput, expectedVersion: number, expectedClaimVersion: number) {
      const incidentContext = await mutationContext(actor, incidentId, familyId);
      const existing = await repository.getById(incidentContext, familyId);
      if (!existing) throw new HttpError(404, "Family/NOK record not found");
      if (existing.version !== expectedVersion || existing.currentClaim.version !== expectedClaimVersion) {
        throw new HttpError(409, "This record or decision was changed by another user. Refresh the data before making the decision again");
      }
      if (input.result === "REOPENED" && !["VERIFIED", "REJECTED"].includes(existing.currentClaim.status)) {
        throw new HttpError(409, "Only a verified or rejected relationship claim can be reopened");
      }
      if (input.result !== "REOPENED" && existing.currentClaim.status !== "PENDING") {
        throw new HttpError(409, "A terminal relationship decision must be reopened before a new decision");
      }
      if (input.result === "VERIFIED" && !(input.verifiedRelationshipType ?? existing.currentClaim.claimedRelationshipType)) {
        throw new HttpError(400, "A relationship type is required before the claim can be verified");
      }
      return resolved(await repository.decide(incidentContext, familyId, input, expectedVersion, expectedClaimVersion, actor));
    },

    async importRecords(actor: FamilyActor, incidentId: string, input: FamilyImportInput) {
      const incidentContext = await context(actor, incidentId);
      assertWritable(incidentContext);
      return repository.importRecords(incidentContext, input, actor);
    }
  };
}

export type FamilyService = ReturnType<typeof createFamilyService>;
