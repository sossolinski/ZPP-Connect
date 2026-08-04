import type {
  IncidentActor,
  IncidentCreateInput,
  IncidentListQuery,
  IncidentListResult,
  IncidentRecord,
  IncidentUpdateInput
} from "./incident-types.js";

export interface IncidentRepository {
  readonly kind: "memory" | "postgres";
  list(query: IncidentListQuery, visibleIncidentIds: string[] | null): Promise<IncidentListResult>;
  findById(id: string): Promise<IncidentRecord | null>;
  findActiveReal(excludingId?: string): Promise<IncidentRecord | null>;
  create(input: IncidentCreateInput, actor: IncidentActor): Promise<IncidentRecord>;
  update(id: string, input: IncidentUpdateInput, actor: IncidentActor): Promise<IncidentRecord | null>;
  close(id: string, notes: string, actor: IncidentActor): Promise<IncidentRecord | null>;
}
