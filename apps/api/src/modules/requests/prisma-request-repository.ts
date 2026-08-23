import { Prisma, type PrismaClient } from "@prisma/client";
import { HttpError } from "../../errors.js";
import type { IncidentContext } from "../incident-access/incident-access-types.js";
import type { RequestRepository } from "./request-repository.js";
import {
  toRequestCompatibility,
  type AssignRequestInput,
  type ChangePriorityInput,
  type CreateRequestInput,
  type RequestActor,
  type RequestListResult,
  type RequestMutationResult,
  type RequestOperationInput,
  type RequestPriority,
  type RequestQueueQuery,
  type RequestReasonInput,
  type RequestRecord,
  type RequestStatus,
  type RequestVersionInput,
  type RequestVisibility,
  type ResolveRequestInput,
  type UpdateRequestInput,
} from "./request-types.js";

const terminal = new Set<RequestStatus>(["RESOLVED", "CANCELLED"]);
const include = {
  owner: { select: { id: true, displayName: true, email: true } },
  createdBy: { select: { id: true, displayName: true, email: true } },
  updatedBy: { select: { id: true, displayName: true, email: true } },
  resolvedBy: { select: { id: true, displayName: true, email: true } },
  relatedEnquiry: { select: { id: true, operationalId: true, status: true } },
  relatedFamilyRecord: {
    select: { id: true, operationalId: true, verificationStatus: true },
  },
  relatedPassengerRecord: {
    select: {
      id: true,
      operationalId: true,
      holdStatus: true,
      conditionStatus: true,
    },
  },
  relatedReleaseAction: {
    select: { id: true, operationalId: true, status: true, actionType: true },
  },
} satisfies Prisma.RequestInclude;

function json(value: Record<string, unknown>): Prisma.InputJsonValue {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Prisma.InputJsonObject;
}
function fingerprint(
  command: string,
  requestId: string | null,
  values: unknown[],
) {
  return JSON.stringify([command, requestId, ...values]);
}
function isConflict(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    ["P2002", "P2034"].includes(error.code)
  );
}
function view(row: any, visibility: RequestVisibility): RequestRecord {
  const status = row.status as RequestStatus;
  const overdue =
    !terminal.has(status) &&
    Boolean(row.dueAt && new Date(row.dueAt).getTime() < Date.now());
  return {
    ...row,
    incidentId: row.incidentId,
    sessionId: row.incidentId,
    status,
    priority: row.priority,
    overdue,
    relatedEnquiryId: visibility.enquiry ? row.relatedEnquiryId : null,
    relatedFamilyRecordId: visibility.family ? row.relatedFamilyRecordId : null,
    relatedPassengerRecordId: visibility.passenger
      ? row.relatedPassengerRecordId
      : null,
    relatedReleaseActionId: visibility.release
      ? row.relatedReleaseActionId
      : null,
    ownerAssignedTo: row.owner?.displayName ?? row.legacyOwnerLabel ?? null,
    closureNote: row.resolutionNote ?? null,
    linkedContext: {
      enquiry: visibility.enquiry ? (row.relatedEnquiry ?? null) : null,
      family: visibility.family ? (row.relatedFamilyRecord ?? null) : null,
      passenger: visibility.passenger
        ? (row.relatedPassengerRecord ?? null)
        : null,
      release: visibility.release ? (row.relatedReleaseAction ?? null) : null,
    },
    relatedEnquiry: undefined,
    relatedFamilyRecord: undefined,
    relatedPassengerRecord: undefined,
    relatedReleaseAction: undefined,
  };
}
async function find(
  db: PrismaClient | Prisma.TransactionClient,
  incidentId: string,
  requestId: string,
) {
  return db.request.findFirst({
    where: { id: requestId, incidentId },
    include,
  });
}
async function nextOperationalId(tx: Prisma.TransactionClient) {
  const [row] = await tx.$queryRaw<
    Array<{ value: bigint }>
  >`SELECT nextval('"Request_operational_seq"') AS value`;
  return `REQ-${new Date().getFullYear()}-${String(row!.value).padStart(6, "0")}`;
}
async function assertWritable(
  tx: Prisma.TransactionClient,
  context: IncidentContext,
) {
  if (
    (await tx.session.count({
      where: {
        id: context.incidentId,
        status: { notIn: ["Closed", "Archived"] },
      },
    })) !== 1
  )
    throw new HttpError(409, "Requests in a closed incident are read-only");
  if (
    !context.systemAdminOverride &&
    (await tx.incidentAssignment.count({
      where: {
        incidentId: context.incidentId,
        userId: context.actorId,
        active: true,
      },
    })) !== 1
  )
    throw new HttpError(404, "Incident not found");
}
async function assertReferences(
  tx: Prisma.TransactionClient,
  context: IncidentContext,
  input: CreateRequestInput,
) {
  const checks: Array<Promise<number>> = [];
  if (input.relatedEnquiryId)
    checks.push(
      tx.enquiry.count({
        where: { id: input.relatedEnquiryId, sessionId: context.incidentId },
      }),
    );
  if (input.relatedFamilyRecordId)
    checks.push(
      tx.familyRecord.count({
        where: {
          id: input.relatedFamilyRecordId,
          sessionId: context.incidentId,
        },
      }),
    );
  if (input.relatedPassengerRecordId)
    checks.push(
      tx.passengerRecord.count({
        where: {
          id: input.relatedPassengerRecordId,
          sessionId: context.incidentId,
        },
      }),
    );
  if (input.relatedReleaseActionId)
    checks.push(
      tx.releaseAction.count({
        where: {
          id: input.relatedReleaseActionId,
          incidentId: context.incidentId,
        },
      }),
    );
  const results = await Promise.all(checks);
  if (results.some((count) => count !== 1))
    throw new HttpError(
      409,
      "Every linked record must belong to the same incident as the Request",
    );
}
async function audit(
  tx: Prisma.TransactionClient,
  context: IncidentContext,
  actor: RequestActor,
  action: string,
  request: any,
  summary: string,
  metadata: Record<string, unknown>,
) {
  await tx.auditLog.create({
    data: {
      action,
      entityType: "request",
      entityId: request.id,
      sessionId: context.incidentId,
      actorId: context.actorId,
      actorEmail: actor.email,
      summary,
      metadata: json({
        requestRecordId: request.id,
        operationalId: request.operationalId,
        version: request.version,
        requestId: actor.requestId,
        ...metadata,
      }),
    },
  });
}
async function timeline(
  tx: Prisma.TransactionClient,
  context: IncidentContext,
  actor: RequestActor,
  request: any,
  title: string,
  body: string,
  metadata: Record<string, unknown>,
) {
  await tx.caseTimelineEvent.create({
    data: {
      sessionId: context.incidentId,
      caseId: request.caseId,
      eventType: "request",
      entityType: "request",
      entityId: request.id,
      title,
      body,
      metadata: json({
        requestRecordId: request.id,
        operationalId: request.operationalId,
        status: request.status,
        version: request.version,
        ...metadata,
      }),
      createdById: context.actorId,
    },
  });
}
async function operationRetry(
  tx: Prisma.TransactionClient,
  incidentId: string,
  operationId: string,
  commandFingerprint: string,
) {
  const existing = await tx.requestOperation.findUnique({
    where: { incidentId_operationId: { incidentId, operationId } },
  });
  if (!existing) return null;
  if (existing.commandFingerprint !== commandFingerprint)
    throw new HttpError(
      409,
      "operationId was already used for a different Request command",
    );
  return existing.requestRecordId;
}
async function logOperation(
  tx: Prisma.TransactionClient,
  context: IncidentContext,
  actor: RequestActor,
  requestRecordId: string,
  operationId: string,
  command: string,
  commandFingerprint: string,
  resultVersion: number,
) {
  await tx.requestOperation.create({
    data: {
      incidentId: context.incidentId,
      requestRecordId,
      operationId,
      command,
      commandFingerprint,
      resultVersion,
      requestId: actor.requestId,
    },
  });
}

export function createPrismaRequestRepository(
  client: PrismaClient,
): RequestRepository {
  async function result(
    tx: Prisma.TransactionClient,
    context: IncidentContext,
    id: string,
    visibility: RequestVisibility,
    idempotent = false,
  ): Promise<RequestMutationResult> {
    const row = await find(tx, context.incidentId, id);
    return {
      record: row ? view(row, visibility) : null,
      conflict: !row,
      idempotent,
    };
  }
  async function simpleMutation(
    context: IncidentContext,
    id: string,
    expectedVersion: number,
    actor: RequestActor,
    visibility: RequestVisibility,
    allowed: RequestStatus[],
    data: Prisma.RequestUncheckedUpdateManyInput,
    action: string,
    summary: (row: any) => string,
    metadata: (row: any) => Record<string, unknown>,
    timelineEvent?: (row: any) => { title: string; body: string },
    precondition?: (
      tx: Prisma.TransactionClient,
      previous: any,
    ) => Promise<void>,
  ) {
    try {
      return await client.$transaction(
        async (tx) => {
          await assertWritable(tx, context);
          const previous = await find(tx, context.incidentId, id);
          if (!previous) return { record: null, conflict: false };
          if (
            previous.version !== expectedVersion ||
            !allowed.includes(previous.status as RequestStatus)
          )
            return { record: null, conflict: true };
          await precondition?.(tx, previous);
          const changed = await tx.request.updateMany({
            where: {
              id,
              incidentId: context.incidentId,
              version: expectedVersion,
              status: { in: allowed },
            },
            data: {
              ...data,
              updatedById: context.actorId,
              version: { increment: 1 },
            },
          });
          if (changed.count !== 1) return { record: null, conflict: true };
          const current = await find(tx, context.incidentId, id);
          if (!current) return { record: null, conflict: true };
          await audit(
            tx,
            context,
            actor,
            action,
            current,
            summary(current),
            metadata(previous),
          );
          if (timelineEvent) {
            const event = timelineEvent(current);
            await timeline(
              tx,
              context,
              actor,
              current,
              event.title,
              event.body,
              metadata(previous),
            );
          }
          return { record: view(current, visibility), conflict: false };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (isConflict(error)) return { record: null, conflict: true };
      throw error;
    }
  }
  async function terminalMutation(
    context: IncidentContext,
    id: string,
    input: ResolveRequestInput | RequestOperationInput,
    actor: RequestActor,
    visibility: RequestVisibility,
    command: "RESOLVE" | "REOPEN" | "CANCEL",
  ) {
    const values =
      command === "RESOLVE"
        ? [
            (input as ResolveRequestInput).outcome,
            (input as ResolveRequestInput).resolutionNote,
          ]
        : [(input as RequestOperationInput).reason];
    const fp = fingerprint(command, id, values);
    try {
      return await client.$transaction(
        async (tx) => {
          await assertWritable(tx, context);
          const retryId = await operationRetry(
            tx,
            context.incidentId,
            input.operationId,
            fp,
          );
          if (retryId) return result(tx, context, retryId, visibility, true);
          const previous = await find(tx, context.incidentId, id);
          if (!previous) return { record: null, conflict: false };
          const allowed =
            command === "REOPEN"
              ? ["RESOLVED"]
              : ["OPEN", "ASSIGNED", "IN_PROGRESS", "WAITING"];
          if (
            previous.version !== input.expectedVersion ||
            !allowed.includes(previous.status)
          )
            return { record: null, conflict: true };
          const now = new Date();
          const data: Prisma.RequestUncheckedUpdateManyInput =
            command === "RESOLVE"
              ? {
                  status: "RESOLVED",
                  resolutionOutcome: (input as ResolveRequestInput).outcome,
                  resolutionNote: (input as ResolveRequestInput).resolutionNote,
                  resolvedById: context.actorId,
                  resolvedAt: now,
                }
              : command === "REOPEN"
                ? {
                    status: previous.ownerUserId ? "IN_PROGRESS" : "OPEN",
                    reopenedById: context.actorId,
                    reopenedAt: now,
                    reopenReason: (input as RequestOperationInput).reason,
                  }
                : {
                    status: "CANCELLED",
                    cancelledById: context.actorId,
                    cancelledAt: now,
                    cancelReason: (input as RequestOperationInput).reason,
                  };
          const changed = await tx.request.updateMany({
            where: {
              id,
              incidentId: context.incidentId,
              version: input.expectedVersion,
              status: { in: allowed },
            },
            data: {
              ...data,
              updatedById: context.actorId,
              version: { increment: 1 },
            },
          });
          if (changed.count !== 1) return { record: null, conflict: true };
          const current = await find(tx, context.incidentId, id);
          if (!current) return { record: null, conflict: true };
          await logOperation(
            tx,
            context,
            actor,
            id,
            input.operationId,
            command,
            fp,
            current.version,
          );
          const reason =
            command === "RESOLVE"
              ? (input as ResolveRequestInput).resolutionNote
              : (input as RequestOperationInput).reason;
          const pastTense = {
            RESOLVE: "resolved",
            REOPEN: "reopened",
            CANCEL: "cancelled",
          }[command];
          await audit(
            tx,
            context,
            actor,
            `request_${command.toLowerCase()}`,
            current,
            `Request ${current.operationalId} ${pastTense}`,
            {
              operationId: input.operationId,
              previousStatus: previous.status,
              newStatus: current.status,
              reason,
              outcome:
                command === "RESOLVE"
                  ? (input as ResolveRequestInput).outcome
                  : undefined,
            },
          );
          await timeline(
            tx,
            context,
            actor,
            current,
            `Request ${current.operationalId} ${pastTense}`,
            reason,
            {
              operationId: input.operationId,
              previousStatus: previous.status,
              newStatus: current.status,
            },
          );
          return { record: view(current, visibility), conflict: false };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (isConflict(error)) return { record: null, conflict: true };
      throw error;
    }
  }

  return {
    kind: "postgres",
    async listQueue(context, query, visibility) {
      const now = new Date();
      const where: Prisma.RequestWhereInput = {
        incidentId: context.incidentId,
      };
      if (query.status) where.status = query.status;
      if (query.priority) where.priority = query.priority;
      if (query.ownerUserId)
        where.ownerUserId =
          query.ownerUserId === "unassigned" ? null : query.ownerUserId;
      if (query.category) where.category = query.category;
      if (query.due === "overdue")
        Object.assign(where, {
          dueAt: { lt: now },
          status: { notIn: ["RESOLVED", "CANCELLED"] },
        });
      if (query.due === "due") where.dueAt = { not: null };
      if (query.due === "none") where.dueAt = null;
      if (query.search)
        where.OR = [
          "operationalId",
          "caseId",
          "requester",
          "details",
          "legacyOwnerLabel",
        ].map((field) => ({
          [field]: { contains: query.search, mode: "insensitive" },
        }));
      const orderBy: Prisma.RequestOrderByWithRelationInput =
        query.sortBy === "owner"
          ? { owner: { displayName: query.sortDirection } }
          : { [query.sortBy]: query.sortDirection };
      const [total, rows] = await Promise.all([
        client.request.count({ where }),
        client.request.findMany({
          where,
          include,
          orderBy: [orderBy, { id: query.sortDirection }],
          take: query.limit,
          skip: query.offset,
        }),
      ]);
      return { total, data: rows.map((row) => view(row, visibility)) };
    },
    async getContext(context, id, visibility) {
      const row = await find(client, context.incidentId, id);
      return row ? view(row, visibility) : null;
    },
    async listAssignees(context, search) {
      const rows = await client.incidentAssignment.findMany({
        where: {
          incidentId: context.incidentId,
          active: true,
          user: {
            status: "Active",
            ...(search
              ? {
                  OR: [
                    { displayName: { contains: search, mode: "insensitive" } },
                    { email: { contains: search, mode: "insensitive" } },
                  ],
                }
              : {}),
          },
        },
        select: {
          user: { select: { id: true, displayName: true, email: true } },
        },
        orderBy: { user: { displayName: "asc" } },
      });
      return Array.from(
        new Map(rows.map(({ user }) => [user.id, user])).values(),
      );
    },
    async create(context, input, actor, visibility) {
      const fp = fingerprint("CREATE", null, [
        input.category,
        input.priority,
        input.requester ?? null,
        input.details,
        input.approvalStatus ?? "Not required",
        input.notes ?? null,
        input.dueAt?.toISOString() ?? null,
        input.caseId ?? null,
        input.relatedEnquiryId ?? null,
        input.relatedFamilyRecordId ?? null,
        input.relatedPassengerRecordId ?? null,
        input.relatedReleaseActionId ?? null,
      ]);
      try {
        return await client.$transaction(
          async (tx) => {
            await assertWritable(tx, context);
            const retryId = await operationRetry(
              tx,
              context.incidentId,
              input.operationId,
              fp,
            );
            if (retryId) return result(tx, context, retryId, visibility, true);
            await assertReferences(tx, context, input);
            const created = await tx.request.create({
              data: {
                incidentId: context.incidentId,
                operationalId: await nextOperationalId(tx),
                category: input.category,
                priority: input.priority,
                requester: input.requester,
                details: input.details,
                approvalStatus: input.approvalStatus ?? "Not required",
                notes: input.notes,
                dueAt: input.dueAt,
                caseId: input.caseId,
                relatedEnquiryId: input.relatedEnquiryId,
                relatedFamilyRecordId: input.relatedFamilyRecordId,
                relatedPassengerRecordId: input.relatedPassengerRecordId,
                relatedReleaseActionId: input.relatedReleaseActionId,
                status: "OPEN",
                createdById: context.actorId,
                updatedById: context.actorId,
              },
              include,
            });
            await logOperation(
              tx,
              context,
              actor,
              created.id,
              input.operationId,
              "CREATE",
              fp,
              created.version,
            );
            await audit(
              tx,
              context,
              actor,
              "create_request",
              created,
              `Request ${created.operationalId} created`,
              {
                operationId: input.operationId,
                previousStatus: null,
                newStatus: "OPEN",
                priority: created.priority,
              },
            );
            await timeline(
              tx,
              context,
              actor,
              created,
              `Request ${created.operationalId} created`,
              created.details,
              { operationId: input.operationId, priority: created.priority },
            );
            return { record: view(created, visibility), conflict: false };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (isConflict(error)) return { record: null, conflict: true };
        throw error;
      }
    },
    async update(context, id, input, expectedVersion, actor, visibility) {
      return simpleMutation(
        context,
        id,
        expectedVersion,
        actor,
        visibility,
        ["OPEN", "ASSIGNED", "IN_PROGRESS", "WAITING"],
        input,
        "update_request",
        (row) => `Request ${row.operationalId} updated`,
        (previous) => ({
          previousStatus: previous.status,
          newStatus: previous.status,
        }),
      );
    },
    async assign(context, id, input, actor, visibility) {
      const previous = await find(client, context.incidentId, id);
      const nextStatus =
        previous?.status === "OPEN" ? "ASSIGNED" : previous?.status;
      return simpleMutation(
        context,
        id,
        input.expectedVersion,
        actor,
        visibility,
        ["OPEN", "ASSIGNED", "IN_PROGRESS", "WAITING"],
        {
          ownerUserId: input.ownerUserId,
          legacyOwnerLabel: null,
          status: nextStatus,
        },
        previous?.ownerUserId ? "reassign_request" : "assign_request",
        (row) => `Request ${row.operationalId} assigned`,
        (row) => ({
          previousStatus: row.status,
          newStatus: nextStatus,
          previousOwnerUserId: row.ownerUserId,
          newOwnerUserId: input.ownerUserId,
          reason: input.reason,
        }),
        (row) => ({
          title: `Request ${row.operationalId} assigned`,
          body: input.reason ?? "Operational owner assigned",
        }),
        async (tx) => {
          const eligible = await tx.incidentAssignment.count({
            where: {
              incidentId: context.incidentId,
              userId: input.ownerUserId,
              active: true,
              user: { status: "Active" },
            },
          });
          if (!eligible)
            throw new HttpError(
              409,
              "Request owner must be an active user assigned to this incident",
            );
        },
      );
    },
    async unassign(context, id, input, actor, visibility) {
      const previous = await find(client, context.incidentId, id);
      const nextStatus =
        previous?.status === "ASSIGNED" ? "OPEN" : previous?.status;
      return simpleMutation(
        context,
        id,
        input.expectedVersion,
        actor,
        visibility,
        ["OPEN", "ASSIGNED", "IN_PROGRESS", "WAITING"],
        { ownerUserId: null, legacyOwnerLabel: null, status: nextStatus },
        "unassign_request",
        (row) => `Request ${row.operationalId} unassigned`,
        (row) => ({
          previousStatus: row.status,
          newStatus: nextStatus,
          previousOwnerUserId: row.ownerUserId,
          newOwnerUserId: null,
          reason: input.reason,
        }),
        (row) => ({
          title: `Request ${row.operationalId} unassigned`,
          body: input.reason,
        }),
      );
    },
    async changePriority(context, id, input, actor, visibility) {
      return simpleMutation(
        context,
        id,
        input.expectedVersion,
        actor,
        visibility,
        ["OPEN", "ASSIGNED", "IN_PROGRESS", "WAITING"],
        { priority: input.priority },
        "change_request_priority",
        (row) =>
          `Request ${row.operationalId} priority changed to ${input.priority}`,
        (previous) => ({
          previousStatus: previous.status,
          newStatus: previous.status,
          previousPriority: previous.priority,
          newPriority: input.priority,
          reason: input.reason,
        }),
        ["High", "Urgent"].includes(input.priority)
          ? (row) => ({
              title: `Request ${row.operationalId} priority: ${input.priority}`,
              body: input.reason ?? `Priority changed to ${input.priority}`,
            })
          : undefined,
      );
    },
    async transition(context, id, status, input, actor, visibility) {
      const allowed: RequestStatus[] =
        status === "IN_PROGRESS"
          ? ["OPEN", "ASSIGNED", "WAITING"]
          : ["OPEN", "ASSIGNED", "IN_PROGRESS"];
      return simpleMutation(
        context,
        id,
        input.expectedVersion,
        actor,
        visibility,
        allowed,
        { status },
        status === "IN_PROGRESS" ? "start_request" : "wait_request",
        (row) => `Request ${row.operationalId} moved to ${status}`,
        (previous) => ({ previousStatus: previous.status, newStatus: status }),
        (row) => ({
          title: `Request ${row.operationalId}: ${status}`,
          body: `Workflow moved to ${status}`,
        }),
      );
    },
    async resolve(context, id, input, actor, visibility) {
      return terminalMutation(context, id, input, actor, visibility, "RESOLVE");
    },
    async reopen(context, id, input, actor, visibility) {
      return terminalMutation(context, id, input, actor, visibility, "REOPEN");
    },
    async cancel(context, id, input, actor, visibility) {
      return terminalMutation(context, id, input, actor, visibility, "CANCEL");
    },
    async listCompatibility(context, query) {
      const all = await this.listQueue(context, query, {
        enquiry: false,
        family: false,
        passenger: false,
        release: false,
      });
      return { ...all, data: all.data.map(toRequestCompatibility) };
    },
  };
}
