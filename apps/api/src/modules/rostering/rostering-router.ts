import { Router, type Request } from "express";
import { z } from "zod";
import { asyncHandler } from "../../errors.js";
import { requireAnyPermission, requirePermission } from "../../rbac.js";
import type { RosteringService } from "./rostering-service.js";
import type { AvailabilityRecord, RosterShiftRecord, RosterStatus, RosteringActor } from "./rostering-types.js";

const id = z.string().trim().min(1).max(100);
const operationId = z.string().uuid();
const nullableText = (max: number) => z.preprocess((value) => value === "" ? null : value, z.string().trim().max(max).optional().nullable());
const nullableId = z.preprocess((value) => value === "" ? null : value, id.optional().nullable());
const date = z.coerce.date();
const queryDate = z.preprocess((value) => value === "" || value === undefined ? undefined : value, z.coerce.date().optional());
const queryBoolean = z.preprocess((value) => value === "true" ? true : value === "false" ? false : value, z.boolean().optional());
const rosterStatus = z.enum(["Draft", "Published", "Confirmed", "Declined", "Cancelled", "Completed"]);
const availabilityType = z.enum(["Available", "Unavailable", "Preferred"]);
const availabilityStatus = z.enum(["Active", "Removed"]);

const rosterQuery = z.object({
  sessionId: id,
  search: z.string().trim().max(200).optional(),
  status: rosterStatus.optional(),
  groupId: id.optional(),
  memberProfileId: id.optional(),
  functionName: z.string().trim().max(200).optional(),
  from: queryDate,
  to: queryDate,
  startFrom: queryDate,
  startTo: queryDate,
  mine: queryBoolean,
  sortBy: z.enum(["startAt", "updatedAt", "operationalId", "status", "functionName"]).default("startAt"),
  sortDirection: z.enum(["asc", "desc"]).default("asc"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
}).transform(({ startFrom, startTo, ...query }) => ({ ...query, from: query.from ?? startFrom, to: query.to ?? startTo }));

const createShift = z.object({
  sessionId: id,
  title: z.string().trim().min(1).max(500),
  duty: z.string().trim().max(500).default(""),
  functionName: z.string().trim().min(1).max(200),
  groupId: nullableId,
  assignedMemberProfileId: nullableId,
  startAt: date,
  endAt: date,
  location: z.string().trim().max(500).default("Not set"),
  notes: nullableText(5_000),
  operationId,
}).strict();

const updateShift = z.object({
  sessionId: id,
  expectedVersion: z.coerce.number().int().min(1),
  title: z.string().trim().min(1).max(500).optional(),
  duty: z.string().trim().max(500).optional(),
  functionName: z.string().trim().min(1).max(200).optional(),
  groupId: nullableId,
  assignedMemberProfileId: nullableId,
  startAt: date.optional(),
  endAt: date.optional(),
  location: z.string().trim().max(500).optional(),
  notes: nullableText(5_000),
}).strict();

const rosterCommand = z.object({
  sessionId: id,
  expectedVersion: z.coerce.number().int().min(1),
  operationId: operationId,
  note: nullableText(5_000),
  reason: nullableText(5_000),
}).strict();

const availabilityQuery = z.object({
  memberProfileId: id.optional(),
  type: availabilityType.optional(),
  status: availabilityStatus.optional(),
  from: queryDate,
  to: queryDate,
  startFrom: queryDate,
  startTo: queryDate,
  mine: queryBoolean,
  sortBy: z.enum(["startAt", "updatedAt", "operationalId", "type", "status"]).default("startAt"),
  sortDirection: z.enum(["asc", "desc"]).default("asc"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
}).transform(({ startFrom, startTo, ...query }) => ({ ...query, from: query.from ?? startFrom, to: query.to ?? startTo }));

const createAvailability = z.object({
  memberProfileId: id.optional(),
  startAt: date,
  endAt: date,
  type: availabilityType.default("Available"),
  note: nullableText(5_000),
  operationId,
}).strict();

const updateAvailability = z.object({
  expectedVersion: z.coerce.number().int().min(1),
  memberProfileId: id.optional(),
  startAt: date.optional(),
  endAt: date.optional(),
  type: availabilityType.optional(),
  note: nullableText(5_000),
}).strict();

const removeAvailability = z.object({ expectedVersion: z.coerce.number().int().min(1), operationId }).strict();

function actor(req: Request): RosteringActor {
  if (!req.user) throw new Error("Authenticated actor is required");
  return {
    id: req.user.id,
    email: req.user.email,
    displayName: req.user.displayName,
    roles: req.user.roles,
    permissions: req.user.permissions,
    roleAssignments: req.user.roleAssignments,
    requestId: req.requestId,
  };
}

export function createRosteringRouter(service: RosteringService, compatibility: {
  onShiftCommitted?: (record: RosterShiftRecord, command: string) => void;
  onAvailabilityCommitted?: (record: AvailabilityRecord, command: string) => void;
} = {}) {
  const router = Router();
  const shiftCommitted = (record: RosterShiftRecord, command: string) => {
    try { compatibility.onShiftCommitted?.(record, command); } catch { /* best effort only */ }
  };
  const availabilityCommitted = (record: AvailabilityRecord, command: string) => {
    try { compatibility.onAvailabilityCommitted?.(record, command); } catch { /* best effort only */ }
  };

  router.get("/roster-shifts", requireAnyPermission(["roster:read", "roster:read-own"]), asyncHandler(async (req, res) => {
    const { sessionId, ...query } = rosterQuery.parse(req.query);
    res.json(await service.listShifts(actor(req), sessionId, query));
  }));
  router.get("/roster-shifts/:id", requireAnyPermission(["roster:read", "roster:read-own"]), asyncHandler(async (req, res) => {
    res.json(await service.getShift(actor(req), id.parse(req.query.sessionId), id.parse(req.params.id)));
  }));
  router.post("/roster-shifts", requirePermission("roster:create"), asyncHandler(async (req, res) => {
    const { sessionId, ...input } = createShift.parse(req.body);
    const record = await service.createShift(actor(req), sessionId, input);
    shiftCommitted(record, "create");
    res.status(record.idempotent ? 200 : 201).json(record);
  }));
  router.patch("/roster-shifts/:id", requirePermission("roster:update"), asyncHandler(async (req, res) => {
    const { sessionId, expectedVersion, ...input } = updateShift.parse(req.body);
    const record = await service.updateShift(actor(req), sessionId, id.parse(req.params.id), input, expectedVersion);
    shiftCommitted(record, "update");
    res.json(record);
  }));
  for (const [action, status, permissions] of [
    ["publish", "Published", ["roster:publish", "roster:update"]],
    ["confirm", "Confirmed", ["roster:confirm-own", "roster:update"]],
    ["decline", "Declined", ["roster:decline-own", "roster:update"]],
    ["cancel", "Cancelled", ["roster:cancel"]],
    ["complete", "Completed", ["roster:complete"]],
  ] as Array<[string, RosterStatus, any[]]>) {
    router.post(`/roster-shifts/:id/${action}`, requireAnyPermission(permissions), asyncHandler(async (req, res) => {
      const { sessionId, ...input } = rosterCommand.parse(req.body);
      const record = await service.transitionShift(actor(req), sessionId, id.parse(req.params.id), status, input);
      shiftCommitted(record, action);
      res.json(record);
    }));
  }

  router.get("/availability", requireAnyPermission(["availability:read-all", "availability:read-own"]), asyncHandler(async (req, res) => {
    res.json(await service.listAvailability(actor(req), availabilityQuery.parse(req.query)));
  }));
  router.post("/availability", requireAnyPermission(["availability:manage-all", "availability:update-own"]), asyncHandler(async (req, res) => {
    const record = await service.createAvailability(actor(req), createAvailability.parse(req.body));
    availabilityCommitted(record, "create");
    res.status(record.idempotent ? 200 : 201).json(record);
  }));
  router.patch("/availability/:id", requireAnyPermission(["availability:manage-all", "availability:update-own"]), asyncHandler(async (req, res) => {
    const { expectedVersion, ...input } = updateAvailability.parse(req.body);
    const record = await service.updateAvailability(actor(req), id.parse(req.params.id), input, expectedVersion);
    availabilityCommitted(record, "update");
    res.json(record);
  }));
  router.post("/availability/:id/remove", requireAnyPermission(["availability:manage-all", "availability:update-own"]), asyncHandler(async (req, res) => {
    const record = await service.removeAvailability(actor(req), id.parse(req.params.id), removeAvailability.parse(req.body));
    availabilityCommitted(record, "remove");
    res.json(record);
  }));
  return router;
}
