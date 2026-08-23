import { dictionaries } from "@zpp/shared";
import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";
import { asyncHandler } from "../../errors.js";
import { requirePermission } from "../../rbac.js";
import type { IncidentPermissionGate } from "../incident-access/incident-permission-gate.js";
import type { AssignmentService } from "./assignment-service.js";
import {
  toAssignmentCompatibility,
  type AssignmentActor,
  type AssignmentCompatibilityRecord,
  type AssignmentRecord,
} from "./assignment-types.js";

const id = z.string().trim().min(1).max(100);
const operationId = z.string().uuid();
const note = z.string().trim().min(3).max(5_000);
const nullableText = (max: number) => z.preprocess((value) => value === "" ? null : value, z.string().trim().max(max).optional().nullable());
const nullableDate = z.preprocess((value) => value === "" ? null : value, z.coerce.date().optional().nullable());
const status = z.enum(dictionaries.assignmentStatuses);
const priority = z.enum(dictionaries.assignmentPriorities);
const queryBoolean = z.preprocess((value) => value === "true" ? true : value === "false" ? false : value, z.boolean().optional());
const scope = z.object({ sessionId: id }).strict();
const queue = scope.extend({
  search: z.string().trim().max(200).optional(),
  status: status.optional(),
  priority: priority.optional(),
  assignedUserId: id.optional(),
  unassigned: queryBoolean,
  mine: queryBoolean,
  due: z.enum(["overdue", "today", "due", "none"]).optional(),
  relatedFunction: z.string().trim().max(200).optional(),
  sortBy: z.enum(["updatedAt", "operationalId", "priority", "status", "assignee", "dueAt", "relatedFunction"]).default("updatedAt"),
  sortDirection: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const create = z.object({
  sessionId: id,
  title: z.string().trim().min(1).max(500),
  details: nullableText(5_000),
  priority: priority.default("Normal"),
  dueAt: nullableDate,
  caseId: nullableText(100),
  relatedFunction: nullableText(200),
  linkedRecord: nullableText(300),
  operationId,
}).strict();
const update = z.object({
  sessionId: id,
  expectedVersion: z.coerce.number().int().min(1),
  title: z.string().trim().min(1).max(500).optional(),
  details: nullableText(5_000),
  priority: priority.optional(),
  dueAt: nullableDate,
  caseId: nullableText(100),
  relatedFunction: nullableText(200),
  linkedRecord: nullableText(300),
}).strict();
const version = z.object({ sessionId: id, expectedVersion: z.coerce.number().int().min(1) }).strict();
const retry = version.extend({ operationId });
const reason = version.extend({ reason: note });
const assign = retry.extend({ assignedUserId: id, reason: note.optional() });
const reassign = retry.extend({ assignedUserId: id, reason: note });
const complete = retry.extend({ completionNote: nullableText(5_000) });
const cancel = retry.extend({ reason: note });

function actor(req: Request): AssignmentActor {
  if (!req.user) throw new Error("Authenticated actor is required");
  return {
    id: req.user.id,
    email: req.user.email,
    displayName: req.user.displayName,
    roles: req.user.roles,
    permissions: req.incidentPermissions ?? req.user.permissions,
    requestId: req.requestId,
  };
}

export function createAssignmentRouter(
  service: AssignmentService,
  compatibility: {
    onList?: (records: AssignmentCompatibilityRecord[], incidentId: string, offset: number) => void;
    onChange?: (record: AssignmentCompatibilityRecord) => void;
    onCommitted?: (record: AssignmentRecord, command: string) => void;
    requireIncidentPermission?: IncidentPermissionGate;
  } = {},
) {
  const router = Router();
  const queryIncident = (req: Request) => String(req.query.sessionId ?? "");
  const bodyIncident = (req: Request) => String(req.body?.sessionId ?? "");
  const authorize = (permission: Parameters<typeof requirePermission>[0], source: "query" | "body", writable = false): RequestHandler => (
    compatibility.requireIncidentPermission
      ? compatibility.requireIncidentPermission(permission, source === "query" ? queryIncident : bodyIncident, { requireWritable: writable })
      : requirePermission(permission)
  );
  const committed = (record: AssignmentRecord, command: string) => {
    compatibility.onChange?.(toAssignmentCompatibility(record));
    try {
      compatibility.onCommitted?.(record, command);
    } catch {
      // Notifications and other best-effort consumers never control the commit.
    }
  };

  router.get("/assignments/assignees", authorize("assignment:assign", "query"), asyncHandler(async (req, res) => {
    const query = z.object({ sessionId: id, search: z.string().trim().max(200).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
    res.json(await service.listAssignees(actor(req), query.sessionId, query.search, query.limit, query.offset));
  }));
  router.get("/assignments/queue", authorize("assignment:read", "query"), asyncHandler(async (req, res) => {
    const query = queue.parse(req.query);
    res.json(await service.listQueue(actor(req), query.sessionId, query));
  }));
  router.get("/assignments/:id", authorize("assignment:read", "query"), asyncHandler(async (req, res) => {
    res.json(await service.getContext(actor(req), id.parse(req.query.sessionId), id.parse(req.params.id)));
  }));
  router.get("/assignments", authorize("assignment:read", "query"), asyncHandler(async (req, res) => {
    const query = queue.parse(req.query);
    const result = await service.listCompatibility(actor(req), query.sessionId, query);
    compatibility.onList?.(result.data, query.sessionId, query.offset);
    res.json({ ...result, deprecated: true, readOnly: true });
  }));
  router.post("/assignments", authorize("assignment:create", "body", true), asyncHandler(async (req, res) => {
    const { sessionId, ...input } = create.parse(req.body);
    const record = await service.create(actor(req), sessionId, input);
    committed(record, "create");
    res.status(201).json(record);
  }));
  router.patch("/assignments/:id", authorize("assignment:update", "body", true), asyncHandler(async (req, res) => {
    const { sessionId, expectedVersion, ...input } = update.parse(req.body);
    const record = await service.update(actor(req), sessionId, id.parse(req.params.id), input, expectedVersion);
    committed(record, "update");
    res.json(record);
  }));
  router.post("/assignments/:id/assign", authorize("assignment:assign", "body", true), asyncHandler(async (req, res) => {
    const { sessionId, ...input } = assign.parse(req.body);
    const record = await service.assign(actor(req), sessionId, id.parse(req.params.id), input);
    committed(record, "assign");
    res.json(record);
  }));
  router.post("/assignments/:id/claim", authorize("assignment:update", "body", true), asyncHandler(async (req, res) => {
    const { sessionId, ...input } = retry.parse(req.body);
    const record = await service.claim(actor(req), sessionId, id.parse(req.params.id), input);
    committed(record, "claim");
    res.json(record);
  }));
  router.post("/assignments/:id/reassign", authorize("assignment:assign", "body", true), asyncHandler(async (req, res) => {
    const { sessionId, ...input } = reassign.parse(req.body);
    const record = await service.reassign(actor(req), sessionId, id.parse(req.params.id), input);
    committed(record, "reassign");
    res.json(record);
  }));
  router.post("/assignments/:id/start", authorize("assignment:update", "body", true), asyncHandler(async (req, res) => {
    const { sessionId, ...input } = version.parse(req.body);
    const record = await service.transition(actor(req), sessionId, id.parse(req.params.id), "In Progress", input);
    committed(record, "start");
    res.json(record);
  }));
  router.post("/assignments/:id/escalate", authorize("assignment:update", "body", true), asyncHandler(async (req, res) => {
    const { sessionId, ...input } = reason.parse(req.body);
    const record = await service.transition(actor(req), sessionId, id.parse(req.params.id), "Escalated", input);
    committed(record, "escalate");
    res.json(record);
  }));
  router.post("/assignments/:id/resume", authorize("assignment:update", "body", true), asyncHandler(async (req, res) => {
    const parsed = version.extend({ reason: note.optional() }).parse(req.body);
    const { sessionId, ...input } = parsed;
    const record = await service.transition(actor(req), sessionId, id.parse(req.params.id), "In Progress", input);
    committed(record, "resume");
    res.json(record);
  }));
  router.post("/assignments/:id/complete", authorize("assignment:update", "body", true), asyncHandler(async (req, res) => {
    const { sessionId, ...input } = complete.parse(req.body);
    const record = await service.complete(actor(req), sessionId, id.parse(req.params.id), input);
    committed(record, "complete");
    res.json(record);
  }));
  router.post("/assignments/:id/cancel", authorize("assignment:update", "body", true), asyncHandler(async (req, res) => {
    const { sessionId, ...input } = cancel.parse(req.body);
    const record = await service.cancel(actor(req), sessionId, id.parse(req.params.id), input);
    committed(record, "cancel");
    res.json(record);
  }));
  return router;
}
