import { randomUUID } from "node:crypto";
import { HttpError } from "../../errors.js";
import type { IncidentContext } from "../incident-access/incident-access-types.js";
import type { RequestRepository } from "./request-repository.js";
import {
  toRequestCompatibility,
  type RequestActor,
  type RequestPriority,
  type RequestRecord,
  type RequestStatus,
  type RequestVisibility,
} from "./request-types.js";

type Row = Record<string, any>;
const terminal = new Set(["RESOLVED", "CANCELLED"]);
const statusMap: Record<string, RequestStatus> = {
  Open: "OPEN",
  Assigned: "ASSIGNED",
  "In progress": "IN_PROGRESS",
  Waiting: "WAITING",
  Done: "RESOLVED",
  Closed: "RESOLVED",
  Completed: "RESOLVED",
  Cancelled: "CANCELLED",
};

export function createMemoryRequestRepository(sources: {
  requests: Row[];
  enquiries: Row[];
  families: Row[];
  passengers: Row[];
  releases: Row[];
  users: Row[];
  incidentAssignments: Row[];
  auditLogs: Row[];
  timeline: Row[];
  now: () => string;
}): RequestRepository {
  let sequence = sources.requests.length + 1;
  const operations: Row[] = [];
  for (const row of sources.requests)
    Object.assign(row, {
      incidentId: row.incidentId ?? row.sessionId,
      status: statusMap[row.status] ?? row.status ?? "OPEN",
      version: Number(row.version ?? 1),
      legacyOwnerLabel: row.legacyOwnerLabel ?? row.ownerAssignedTo ?? null,
      legacyImported: true,
    });
  const fp = (command: string, id: string | null, values: unknown[]) =>
    JSON.stringify([command, id, ...values]);
  const find = (context: IncidentContext, id: string) =>
    sources.requests.find(
      (row) =>
        row.id === id &&
        (row.incidentId ?? row.sessionId) === context.incidentId,
    ) ?? null;
  function view(row: Row, visibility: RequestVisibility): RequestRecord {
    const owner = sources.users.find((user) => user.id === row.ownerUserId);
    const linked = (
      rows: Row[],
      id: string | null | undefined,
      incident: (row: Row) => unknown,
    ) =>
      rows.find((item) => item.id === id && incident(item) === row.incidentId);
    const enquiry = linked(
      sources.enquiries,
      row.relatedEnquiryId,
      (item) => item.sessionId,
    );
    const family = linked(
      sources.families,
      row.relatedFamilyRecordId,
      (item) => item.sessionId,
    );
    const passenger = linked(
      sources.passengers,
      row.relatedPassengerRecordId,
      (item) => item.sessionId,
    );
    const release = linked(
      sources.releases,
      row.relatedReleaseActionId,
      (item) => item.incidentId ?? item.sessionId,
    );
    return {
      ...row,
      sessionId: row.incidentId,
      relatedEnquiryId: visibility.enquiry
        ? (row.relatedEnquiryId ?? null)
        : null,
      relatedFamilyRecordId: visibility.family
        ? (row.relatedFamilyRecordId ?? null)
        : null,
      relatedPassengerRecordId: visibility.passenger
        ? (row.relatedPassengerRecordId ?? null)
        : null,
      relatedReleaseActionId: visibility.release
        ? (row.relatedReleaseActionId ?? null)
        : null,
      owner: owner
        ? { id: owner.id, displayName: owner.displayName, email: owner.email }
        : null,
      ownerAssignedTo: owner?.displayName ?? row.legacyOwnerLabel ?? null,
      overdue:
        !terminal.has(row.status) &&
        Boolean(row.dueAt && new Date(row.dueAt).getTime() < Date.now()),
      closureNote: row.resolutionNote ?? row.closureNote ?? null,
      linkedContext: {
        enquiry:
          visibility.enquiry && enquiry
            ? {
                id: enquiry.id,
                operationalId: enquiry.operationalId,
                status: enquiry.status,
              }
            : null,
        family:
          visibility.family && family
            ? {
                id: family.id,
                operationalId: family.operationalId,
                verificationStatus: family.verificationStatus,
              }
            : null,
        passenger:
          visibility.passenger && passenger
            ? {
                id: passenger.id,
                operationalId: passenger.operationalId,
                holdStatus: passenger.holdStatus,
                conditionStatus: passenger.conditionStatus,
              }
            : null,
        release:
          visibility.release && release
            ? {
                id: release.id,
                operationalId: release.operationalId,
                status: release.status,
                actionType: release.actionType,
              }
            : null,
      },
    } as RequestRecord;
  }
  function mutation(
    row: Row | null,
    visibility: RequestVisibility,
    conflict = false,
    idempotent = false,
  ) {
    return { record: row ? view(row, visibility) : null, conflict, idempotent };
  }
  function log(
    context: IncidentContext,
    actor: RequestActor,
    row: Row,
    action: string,
    summary: string,
    metadata: Row,
    withTimeline = true,
  ) {
    sources.auditLogs.unshift({
      id: randomUUID(),
      action,
      entityType: "request",
      entityId: row.id,
      sessionId: context.incidentId,
      actorId: actor.id,
      actorEmail: actor.email,
      actorDisplayName: actor.displayName,
      summary,
      metadata: {
        requestRecordId: row.id,
        operationalId: row.operationalId,
        version: row.version,
        requestId: actor.requestId,
        ...metadata,
      },
      createdAt: sources.now(),
    });
    if (withTimeline)
      sources.timeline.unshift({
        id: randomUUID(),
        sessionId: context.incidentId,
        caseId: row.caseId ?? null,
        eventType: "request",
        entityType: "request",
        entityId: row.id,
        title: summary,
        body: metadata.reason ?? row.details,
        metadata,
        createdById: actor.id,
        occurredAt: sources.now(),
        createdAt: sources.now(),
      });
  }
  function retry(
    context: IncidentContext,
    operationId: string,
    fingerprint: string,
  ) {
    const existing = operations.find(
      (item) =>
        item.incidentId === context.incidentId &&
        item.operationId === operationId,
    );
    if (!existing) return null;
    if (existing.commandFingerprint !== fingerprint)
      throw new HttpError(
        409,
        "operationId was already used for a different Request command",
      );
    return find(context, existing.requestRecordId);
  }
  function addOperation(
    context: IncidentContext,
    actor: RequestActor,
    row: Row,
    operationId: string,
    command: string,
    fingerprint: string,
  ) {
    operations.push({
      id: randomUUID(),
      incidentId: context.incidentId,
      requestRecordId: row.id,
      operationId,
      command,
      commandFingerprint: fingerprint,
      resultVersion: row.version,
      requestId: actor.requestId,
      createdAt: sources.now(),
    });
  }
  function change(
    context: IncidentContext,
    id: string,
    expectedVersion: number,
    allowed: string[],
    data: Row,
    actor: RequestActor,
    visibility: RequestVisibility,
    action: string,
    metadata: Row,
    withTimeline = true,
  ) {
    const row = find(context, id);
    if (!row) return mutation(null, visibility);
    if (row.version !== expectedVersion || !allowed.includes(row.status))
      return mutation(null, visibility, true);
    const previous = {
      status: row.status,
      ownerUserId: row.ownerUserId ?? null,
      priority: row.priority,
    };
    Object.assign(row, data, {
      version: row.version + 1,
      updatedById: actor.id,
      updatedAt: sources.now(),
    });
    log(
      context,
      actor,
      row,
      action,
      `Request ${row.operationalId}: ${action.replaceAll("_", " ")}`,
      {
        previousStatus: previous.status,
        newStatus: row.status,
        previousOwnerUserId: previous.ownerUserId,
        newOwnerUserId: row.ownerUserId ?? null,
        previousPriority: previous.priority,
        newPriority: row.priority,
        ...metadata,
      },
      withTimeline,
    );
    return mutation(row, visibility);
  }
  function assertReferences(context: IncidentContext, input: Row) {
    const valid = (rows: Row[], id: unknown, incident: (row: Row) => unknown) =>
      !id ||
      rows.some((row) => row.id === id && incident(row) === context.incidentId);
    if (
      !valid(
        sources.enquiries,
        input.relatedEnquiryId,
        (row) => row.sessionId,
      ) ||
      !valid(
        sources.families,
        input.relatedFamilyRecordId,
        (row) => row.sessionId,
      ) ||
      !valid(
        sources.passengers,
        input.relatedPassengerRecordId,
        (row) => row.sessionId,
      ) ||
      !valid(
        sources.releases,
        input.relatedReleaseActionId,
        (row) => row.incidentId ?? row.sessionId,
      )
    )
      throw new HttpError(
        409,
        "Every linked record must belong to the same incident as the Request",
      );
  }
  function terminalChange(
    context: IncidentContext,
    id: string,
    input: Row,
    actor: RequestActor,
    visibility: RequestVisibility,
    command: "RESOLVE" | "REOPEN" | "CANCEL",
  ) {
    const values =
      command === "RESOLVE"
        ? [input.outcome, input.resolutionNote]
        : [input.reason];
    const fingerprint = fp(command, id, values);
    const repeated = retry(context, input.operationId, fingerprint);
    if (repeated) return mutation(repeated, visibility, false, true);
    const row = find(context, id);
    if (!row) return mutation(null, visibility);
    const allowed =
      command === "REOPEN"
        ? ["RESOLVED"]
        : ["OPEN", "ASSIGNED", "IN_PROGRESS", "WAITING"];
    if (row.version !== input.expectedVersion || !allowed.includes(row.status))
      return mutation(null, visibility, true);
    const previousStatus = row.status;
    const stamp = sources.now();
    if (command === "RESOLVE")
      Object.assign(row, {
        status: "RESOLVED",
        resolutionOutcome: input.outcome,
        resolutionNote: input.resolutionNote,
        resolvedById: actor.id,
        resolvedAt: stamp,
      });
    else if (command === "REOPEN")
      Object.assign(row, {
        status: row.ownerUserId ? "IN_PROGRESS" : "OPEN",
        reopenedById: actor.id,
        reopenedAt: stamp,
        reopenReason: input.reason,
      });
    else
      Object.assign(row, {
        status: "CANCELLED",
        cancelledById: actor.id,
        cancelledAt: stamp,
        cancelReason: input.reason,
      });
    Object.assign(row, {
      version: row.version + 1,
      updatedById: actor.id,
      updatedAt: stamp,
    });
    addOperation(context, actor, row, input.operationId, command, fingerprint);
    const pastTense = {
      RESOLVE: "resolved",
      REOPEN: "reopened",
      CANCEL: "cancelled",
    }[command];
    log(
      context,
      actor,
      row,
      `request_${command.toLowerCase()}`,
      `Request ${row.operationalId} ${pastTense}`,
      {
        operationId: input.operationId,
        previousStatus,
        newStatus: row.status,
        reason: input.reason ?? input.resolutionNote,
        outcome: input.outcome,
      },
    );
    return mutation(row, visibility);
  }
  return {
    kind: "memory",
    async listQueue(context, query, visibility) {
      const needle = query.search?.toLowerCase();
      const now = Date.now();
      const dir = query.sortDirection === "asc" ? 1 : -1;
      const all = sources.requests
        .filter((row) => row.incidentId === context.incidentId)
        .filter((row) => !query.status || row.status === query.status)
        .filter((row) => !query.priority || row.priority === query.priority)
        .filter(
          (row) =>
            !query.ownerUserId ||
            (query.ownerUserId === "unassigned"
              ? !row.ownerUserId
              : row.ownerUserId === query.ownerUserId),
        )
        .filter((row) => !query.category || row.category === query.category)
        .filter((row) =>
          query.due === "overdue"
            ? row.dueAt &&
              new Date(row.dueAt).getTime() < now &&
              !terminal.has(row.status)
            : query.due === "due"
              ? Boolean(row.dueAt)
              : query.due === "none"
                ? !row.dueAt
                : true,
        )
        .filter(
          (row) =>
            !needle ||
            [
              row.operationalId,
              row.caseId,
              row.requester,
              row.details,
              row.legacyOwnerLabel,
            ].some((value) =>
              String(value ?? "")
                .toLowerCase()
                .includes(needle),
            ),
        )
        .sort(
          (a, b) =>
            String(
              query.sortBy === "owner"
                ? (a.ownerUserId ?? "")
                : (a[query.sortBy] ?? ""),
            ).localeCompare(
              String(
                query.sortBy === "owner"
                  ? (b.ownerUserId ?? "")
                  : (b[query.sortBy] ?? ""),
              ),
            ) * dir,
        );
      return {
        total: all.length,
        data: all
          .slice(query.offset, query.offset + query.limit)
          .map((row) => view(row, visibility)),
      };
    },
    async getContext(context, id, visibility) {
      const row = find(context, id);
      return row ? view(row, visibility) : null;
    },
    async listAssignees(context, search) {
      const needle = search?.toLowerCase();
      return sources.incidentAssignments
        .filter((item) => item.incidentId === context.incidentId && item.active)
        .map((item) => sources.users.find((user) => user.id === item.userId))
        .filter((user): user is Row =>
          Boolean(
            user &&
            user.status === "Active" &&
            (!needle ||
              [user.displayName, user.email].some((value) =>
                String(value).toLowerCase().includes(needle),
              )),
          ),
        )
        .map((user) => ({
          id: user.id,
          displayName: user.displayName,
          email: user.email,
        }));
    },
    async create(context, input, actor, visibility) {
      const fingerprint = fp("CREATE", null, [
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
      const repeated = retry(context, input.operationId, fingerprint);
      if (repeated) return mutation(repeated, visibility, false, true);
      assertReferences(context, input);
      const stamp = sources.now();
      const row = {
        id: randomUUID(),
        operationalId: `REQ-${new Date().getFullYear()}-${String(sequence++).padStart(6, "0")}`,
        incidentId: context.incidentId,
        sessionId: context.incidentId,
        category: input.category,
        priority: input.priority,
        requester: input.requester ?? null,
        details: input.details,
        approvalStatus: input.approvalStatus ?? "Not required",
        notes: input.notes ?? null,
        dueAt: input.dueAt ?? null,
        caseId: input.caseId ?? null,
        relatedEnquiryId: input.relatedEnquiryId ?? null,
        relatedFamilyRecordId: input.relatedFamilyRecordId ?? null,
        relatedPassengerRecordId: input.relatedPassengerRecordId ?? null,
        relatedReleaseActionId: input.relatedReleaseActionId ?? null,
        status: "OPEN",
        version: 1,
        legacyImported: false,
        createdById: actor.id,
        updatedById: actor.id,
        createdAt: stamp,
        updatedAt: stamp,
      };
      sources.requests.unshift(row);
      addOperation(
        context,
        actor,
        row,
        input.operationId,
        "CREATE",
        fingerprint,
      );
      log(
        context,
        actor,
        row,
        "create_request",
        `Request ${row.operationalId} created`,
        {
          operationId: input.operationId,
          previousStatus: null,
          newStatus: "OPEN",
          priority: row.priority,
        },
      );
      return mutation(row, visibility);
    },
    async update(context, id, input, expectedVersion, actor, visibility) {
      return change(
        context,
        id,
        expectedVersion,
        ["OPEN", "ASSIGNED", "IN_PROGRESS", "WAITING"],
        input,
        actor,
        visibility,
        "update_request",
        {},
        false,
      );
    },
    async assign(context, id, input, actor, visibility) {
      if (
        !sources.incidentAssignments.some(
          (item) =>
            item.incidentId === context.incidentId &&
            item.userId === input.ownerUserId &&
            item.active,
        )
      )
        throw new HttpError(
          409,
          "Request owner must be an active user assigned to this incident",
        );
      const row = find(context, id);
      return change(
        context,
        id,
        input.expectedVersion,
        ["OPEN", "ASSIGNED", "IN_PROGRESS", "WAITING"],
        {
          ownerUserId: input.ownerUserId,
          legacyOwnerLabel: null,
          status: row?.status === "OPEN" ? "ASSIGNED" : row?.status,
        },
        actor,
        visibility,
        row?.ownerUserId ? "reassign_request" : "assign_request",
        { reason: input.reason },
      );
    },
    async unassign(context, id, input, actor, visibility) {
      const row = find(context, id);
      return change(
        context,
        id,
        input.expectedVersion,
        ["OPEN", "ASSIGNED", "IN_PROGRESS", "WAITING"],
        {
          ownerUserId: null,
          legacyOwnerLabel: null,
          status: row?.status === "ASSIGNED" ? "OPEN" : row?.status,
        },
        actor,
        visibility,
        "unassign_request",
        { reason: input.reason },
      );
    },
    async changePriority(context, id, input, actor, visibility) {
      return change(
        context,
        id,
        input.expectedVersion,
        ["OPEN", "ASSIGNED", "IN_PROGRESS", "WAITING"],
        { priority: input.priority },
        actor,
        visibility,
        "change_request_priority",
        { reason: input.reason },
      );
    },
    async transition(context, id, status, input, actor, visibility) {
      return change(
        context,
        id,
        input.expectedVersion,
        status === "IN_PROGRESS"
          ? ["OPEN", "ASSIGNED", "WAITING"]
          : ["OPEN", "ASSIGNED", "IN_PROGRESS"],
        { status },
        actor,
        visibility,
        status === "IN_PROGRESS" ? "start_request" : "wait_request",
        {},
      );
    },
    async resolve(context, id, input, actor, visibility) {
      return terminalChange(context, id, input, actor, visibility, "RESOLVE");
    },
    async reopen(context, id, input, actor, visibility) {
      return terminalChange(context, id, input, actor, visibility, "REOPEN");
    },
    async cancel(context, id, input, actor, visibility) {
      return terminalChange(context, id, input, actor, visibility, "CANCEL");
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
