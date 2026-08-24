export const exerciseTargetRoleKeys = [
  "system-admin",
  "zpp-coordinator",
  "tec-coordinator",
  "zpp-group-leader",
  "tec-group-leader",
  "zpp-member",
  "tec-member",
  "observer"
] as const;

export const exerciseInjectStatuses = ["Planned", "Released", "Completed", "Cancelled"] as const;
export const observationAreas = ["Intake", "Family Assistance", "Passenger/SRC", "Matching", "Requests", "Coordination", "Other"] as const;
export const observationSeverities = ["Low", "Medium", "High"] as const;
export const observationStatuses = ["Open", "In review", "Resolved"] as const;

export type ExerciseActor = {
  id: string;
  email: string;
  displayName: string;
  requestId?: string;
};

export type ExerciseFailureHooks = {
  beforeEntityCreate?: (entity: "inject" | "observation") => void | Promise<void>;
  afterEntityCreateBeforeAudit?: (entity: "inject" | "observation") => void | Promise<void>;
  beforeRevisionInsert?: (version: number) => void | Promise<void>;
  afterRevisionInsertBeforeAudit?: (version: number) => void | Promise<void>;
  beforeReleaseAudit?: () => void | Promise<void>;
  beforeCompleteAudit?: () => void | Promise<void>;
  afterSessionLock?: (operation: string) => void | Promise<void>;
};

export type ExerciseListQuery = { sessionId: string; status?: string; limit: number; offset: number };

export type CreateInjectInput = {
  sessionId: string;
  operationId: string;
  injectNumber: number;
  scenarioTime: Date | null;
  targetRole: string;
  text: string;
  expectedAction: string | null;
};

export type UpdateInjectInput = {
  expectedVersion: number;
  injectNumber?: number;
  scenarioTime?: Date | null;
  targetRole?: string;
  text?: string;
  expectedAction?: string | null;
};

export type CreateObservationInput = {
  sessionId: string;
  operationId: string;
  area: string;
  severity: string;
  observation: string;
  recommendation: string | null;
  owner: string | null;
  includeInAar: boolean;
  status: string;
};

export type UpdateObservationInput = {
  expectedVersion: number;
  area?: string;
  severity?: string;
  observation?: string;
  recommendation?: string | null;
  owner?: string | null;
  includeInAar?: boolean;
  status?: string;
};
