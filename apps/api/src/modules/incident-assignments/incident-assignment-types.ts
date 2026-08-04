import type { IncidentActor } from "../incidents/incident-types.js";

export type IncidentAssignmentActor = IncidentActor;

export type IncidentAssignmentRecord = {
  id: string;
  incidentId: string;
  userId: string;
  userEmail: string;
  userDisplayName: string;
  function: string | null;
  scope: string;
  active: boolean;
  createdAt: Date | string;
  createdById: string | null;
  revokedAt: Date | string | null;
  revokedById: string | null;
  revokeReason: string | null;
  updatedAt: Date | string;
};

export type IncidentAssignmentCreateInput = {
  userId: string;
  function?: string | null;
  scope?: string;
  reason?: string | null;
};

export type IncidentAssignmentMutation =
  | { outcome: "ok"; record: IncidentAssignmentRecord }
  | { outcome: "not_found" | "conflict" };
