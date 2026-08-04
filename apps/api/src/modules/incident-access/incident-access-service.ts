import { normalizeRoleName } from "@zpp/shared";
import { HttpError } from "../../errors.js";
import type { IncidentAccessRepository } from "./incident-access-repository.js";
import type { IncidentAccessActor, IncidentContext } from "./incident-access-types.js";

export function createIncidentAccessService(repository: IncidentAccessRepository) {
  function hasSystemAdminGlobalOverride(actor: IncidentAccessActor) {
    return actor.roles.some((role) => normalizeRoleName(role) === "system-admin");
  }

  return {
    hasSystemAdminGlobalOverride,

    async visibleIncidentIds(actor: IncidentAccessActor): Promise<string[] | null> {
      if (hasSystemAdminGlobalOverride(actor)) return null;
      return repository.listAssignedIncidentIds(actor.email);
    },

    async authorize(actor: IncidentAccessActor, incidentId: string): Promise<IncidentContext> {
      const access = await repository.resolve(incidentId, actor.email);
      const systemAdminOverride = hasSystemAdminGlobalOverride(actor);
      if (!access || (!access.assigned && !systemAdminOverride)) {
        // Deliberately hide whether the incident exists.
        throw new HttpError(404, "Incident not found");
      }
      return {
        incidentId: access.incidentId,
        mode: access.mode,
        status: access.status,
        actorId: access.databaseUserId ?? actor.id,
        actorEmail: actor.email,
        systemAdminOverride,
        writable: !["Closed", "Archived"].includes(access.status)
      };
    }
  };
}

export type IncidentAccessService = ReturnType<typeof createIncidentAccessService>;
