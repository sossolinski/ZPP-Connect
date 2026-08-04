import { HttpError } from "../../errors.js";
import type { IncidentAccessService } from "../incident-access/incident-access-service.js";
import type { IncidentRepository } from "./incident-repository.js";
import type { IncidentActor, IncidentCreateInput, IncidentListQuery, IncidentUpdateInput } from "./incident-types.js";

const terminalStatuses = new Set(["Closed", "Archived"]);

export function createIncidentService(repository: IncidentRepository, access: IncidentAccessService) {
  async function assertSingleActiveReal(mode: string, status: string, excludingId?: string) {
    if (mode !== "REAL" || status !== "Active") return;
    const existing = await repository.findActiveReal(excludingId);
    if (existing) throw new HttpError(409, "Only one active REAL session is supported by default");
  }

  return {
    kind: repository.kind,
    async list(actor: IncidentActor, query: IncidentListQuery) {
      return repository.list(query, await access.visibleIncidentIds(actor));
    },

    async get(id: string, actor: IncidentActor) {
      await access.authorize(actor, id);
      const existing = await repository.findById(id);
      if (!existing) throw new HttpError(404, "Session not found");
      return existing;
    },

    async create(input: IncidentCreateInput, actor: IncidentActor) {
      if (terminalStatuses.has(input.status)) {
        throw new HttpError(400, "A session cannot be created in a terminal state");
      }
      await assertSingleActiveReal(input.mode, input.status);
      return repository.create(input, actor);
    },

    async update(id: string, input: IncidentUpdateInput, actor: IncidentActor) {
      await access.authorize(actor, id);
      const existing = await repository.findById(id);
      if (!existing) throw new HttpError(404, "Session not found");
      if (terminalStatuses.has(existing.status)) throw new HttpError(409, "Closed or archived sessions are read-only");
      if (input.status && terminalStatuses.has(input.status)) {
        throw new HttpError(400, "Use the dedicated close session action for terminal state changes");
      }
      await assertSingleActiveReal(String(input.mode ?? existing.mode), String(input.status ?? existing.status), id);
      const updated = await repository.update(id, input, actor);
      if (!updated) throw new HttpError(409, "Session changed while it was being updated");
      return updated;
    },

    async close(id: string, notes: string, actor: IncidentActor) {
      await access.authorize(actor, id);
      const existing = await repository.findById(id);
      if (!existing) throw new HttpError(404, "Session not found");
      if (terminalStatuses.has(existing.status)) throw new HttpError(409, "Session is already closed or archived");
      const closed = await repository.close(id, notes, actor);
      if (!closed) throw new HttpError(409, "Session changed while it was being closed");
      return closed;
    }
  };
}

export type IncidentService = ReturnType<typeof createIncidentService>;
