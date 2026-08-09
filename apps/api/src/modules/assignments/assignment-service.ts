import { HttpError } from "../../errors.js";
import type { IncidentAccessService } from "../incident-access/incident-access-service.js";
import type { AssignmentRepository } from "./assignment-repository.js";
import type {
  AssignAssignmentInput,
  AssignmentAction,
  AssignmentActor,
  AssignmentQueueQuery,
  AssignmentReasonInput,
  AssignmentRetryInput,
  AssignmentRetryReasonInput,
  AssignmentVersionInput,
  CompleteAssignmentInput,
  CreateAssignmentInput,
  ReassignAssignmentInput,
  UpdateAssignmentInput,
} from "./assignment-types.js";

const conflictMessage = "This assignment was claimed or changed by another operator. Refresh before trying again";

export function createAssignmentService(repository: AssignmentRepository, incidentAccess: IncidentAccessService) {
  const context = (actor: AssignmentActor, incidentId: string) => incidentAccess.authorize(actor, incidentId);
  async function writeContext(actor: AssignmentActor, incidentId: string) {
    const value = await context(actor, incidentId);
    if (!value.writable) throw new HttpError(409, "Operational Assignments in a closed incident are read-only");
    return value;
  }
  function resolved(result: Awaited<ReturnType<AssignmentRepository["create"]>>, actor: AssignmentActor) {
    if (result.conflict) throw new HttpError(409, conflictMessage);
    if (!result.record) throw new HttpError(404, "Operational Assignment not found");
    return { ...decorate(result.record, actor), idempotent: Boolean(result.idempotent) };
  }
  function decorate<T extends NonNullable<AssignmentMutationResultRecord>>(record: T, actor: AssignmentActor): T {
    const terminal = ["Completed", "Cancelled"].includes(record.status);
    const manager = actor.permissions.includes("assignment:assign");
    const updater = actor.permissions.includes("assignment:update");
    const assignedToActor = record.assignedUserId === actor.id;
    const actions: AssignmentAction[] = [];
    if (!terminal && updater && (manager || assignedToActor)) actions.push("edit");
    if (!terminal && manager && !record.assignedUserId) actions.push("assign");
    if (!terminal && manager && Boolean(record.assignedUserId)) actions.push("reassign");
    if (record.status === "Open" && !record.assignedUserId && updater) actions.push("claim");
    if (!terminal && record.assignedUserId && record.assigneeEligible !== false && (manager || (updater && assignedToActor))) {
      if (record.status === "Open") actions.push("start");
      if (record.status === "In Progress") actions.push("escalate", "complete");
      if (record.status === "Escalated") actions.push("resume");
      actions.push("cancel");
    }
    return { ...record, availableActions: actions };
  }

  type AssignmentMutationResultRecord = Awaited<ReturnType<AssignmentRepository["getContext"]>>;

  return {
    kind: repository.kind,
    listQueue: async (actor: AssignmentActor, incidentId: string, query: AssignmentQueueQuery) => {
      const result = await repository.listQueue(await context(actor, incidentId), query, actor);
      return { ...result, data: result.data.map((record) => decorate(record, actor)) };
    },
    getContext: async (actor: AssignmentActor, incidentId: string, id: string) => {
      const record = await repository.getContext(await context(actor, incidentId), id, actor);
      if (!record) throw new HttpError(404, "Operational Assignment not found");
      return decorate(record, actor);
    },
    listAssignees: async (actor: AssignmentActor, incidentId: string, search: string | undefined, limit: number, offset: number) => repository.listAssignees(await context(actor, incidentId), search, limit, offset),
    create: async (actor: AssignmentActor, incidentId: string, input: CreateAssignmentInput) => resolved(await repository.create(await writeContext(actor, incidentId), input, actor), actor),
    update: async (actor: AssignmentActor, incidentId: string, id: string, input: UpdateAssignmentInput, expectedVersion: number) => resolved(await repository.update(await writeContext(actor, incidentId), id, input, expectedVersion, actor), actor),
    assign: async (actor: AssignmentActor, incidentId: string, id: string, input: AssignAssignmentInput) => resolved(await repository.assign(await writeContext(actor, incidentId), id, input, actor), actor),
    claim: async (actor: AssignmentActor, incidentId: string, id: string, input: AssignmentRetryInput) => resolved(await repository.claim(await writeContext(actor, incidentId), id, input, actor), actor),
    reassign: async (actor: AssignmentActor, incidentId: string, id: string, input: ReassignAssignmentInput) => resolved(await repository.reassign(await writeContext(actor, incidentId), id, input, actor), actor),
    transition: async (actor: AssignmentActor, incidentId: string, id: string, target: "In Progress" | "Escalated", input: AssignmentVersionInput | AssignmentReasonInput) => resolved(await repository.transition(await writeContext(actor, incidentId), id, target, input, actor), actor),
    complete: async (actor: AssignmentActor, incidentId: string, id: string, input: CompleteAssignmentInput) => resolved(await repository.complete(await writeContext(actor, incidentId), id, input, actor), actor),
    cancel: async (actor: AssignmentActor, incidentId: string, id: string, input: AssignmentRetryReasonInput) => resolved(await repository.cancel(await writeContext(actor, incidentId), id, input, actor), actor),
    listCompatibility: async (actor: AssignmentActor, incidentId: string, query: AssignmentQueueQuery) => repository.listCompatibility(await context(actor, incidentId), query, actor),
  };
}

export type AssignmentService = ReturnType<typeof createAssignmentService>;
