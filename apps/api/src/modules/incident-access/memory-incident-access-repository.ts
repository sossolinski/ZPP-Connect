import type { IncidentAccessRepository } from "./incident-access-repository.js";

type MemoryIncident = Record<string, any>;
export type MemoryIncidentAssignment = {
  id?: string;
  incidentId: string;
  userId?: string;
  userEmail: string;
  function?: string | null;
  scope?: string;
  active?: boolean;
  createdAt?: string;
  createdById?: string | null;
  revokedAt?: string | null;
  revokedById?: string | null;
  revokeReason?: string | null;
  updatedAt?: string;
};

export function createMemoryIncidentAccessRepository(options: {
  incidents: MemoryIncident[];
  assignments: MemoryIncidentAssignment[];
}): IncidentAccessRepository {
  return {
    async resolve(incidentId, actorEmail) {
      const incident = options.incidents.find((row) => row.id === incidentId);
      if (!incident) return null;
      const assigned = Boolean(
        options.assignments.some((row) => row.incidentId === incidentId && row.userEmail.toLowerCase() === actorEmail.toLowerCase() && row.active !== false)
      );
      return {
        incidentId: incident.id,
        mode: incident.mode,
        status: incident.status,
        assigned
      };
    },

    async listAssignedIncidentIds(actorEmail) {
      return options.assignments
        .filter((row) => row.active !== false && row.userEmail.toLowerCase() === actorEmail.toLowerCase())
        .map((row) => row.incidentId);
    }
  };
}
