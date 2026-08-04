import type { IncidentAccessRecord } from "./incident-access-types.js";

export interface IncidentAccessRepository {
  resolve(incidentId: string, actorEmail: string): Promise<IncidentAccessRecord | null>;
  listAssignedIncidentIds(actorEmail: string): Promise<string[]>;
}
