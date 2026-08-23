import { dictionaries } from "@zpp/shared";
import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";
import { asyncHandler } from "../../errors.js";
import { requirePermission } from "../../rbac.js";
import type { IncidentPermissionGate } from "../incident-access/incident-permission-gate.js";
import type { PassengerService } from "./passenger-service.js";
import type { PassengerActor, PassengerRecord } from "./passenger-types.js";

const scopedId = z.string().trim().min(1).max(100);
const nullableText = (max: number) => z.preprocess(
  (value) => (value === "" ? null : value),
  z.string().trim().max(max).optional().nullable()
);
const nullableDate = z.preprocess(
  (value) => (value === "" ? null : value),
  z.coerce.date().max(new Date()).optional().nullable()
);

const sourceFacts = z.object({
  personType: z.enum(dictionaries.personTypes),
  firstName: z.string().trim().min(1).max(200),
  lastName: z.string().trim().min(1).max(200),
  dateOfBirth: nullableDate,
  age: z.preprocess((value) => (value === "" ? null : value), z.coerce.number().int().min(0).max(130).optional().nullable()),
  gender: nullableText(100),
  nationality: nullableText(100),
  flightNumber: nullableText(50),
  route: nullableText(200),
  seat: nullableText(30),
  pnr: nullableText(100),
  ticketNumber: nullableText(100),
  manifestVersion: nullableText(100),
  source: z.enum(dictionaries.passengerSources),
  travellingCompanions: nullableText(2_000),
  sourceExternalId: nullableText(200)
}).strict();

const createBody = sourceFacts.extend({
  sessionId: scopedId,
  caseId: nullableText(100),
  notes: nullableText(5_000)
}).strict();

const updateBody = z.object({
  sessionId: scopedId,
  version: z.coerce.number().int().min(1),
  caseId: nullableText(100),
  notes: nullableText(5_000)
}).strict();

const correctionBody = sourceFacts.partial().extend({
  sessionId: scopedId,
  version: z.coerce.number().int().min(1),
  reason: z.string().trim().min(3).max(2_000)
}).strict();

const listQuery = z.object({
  sessionId: scopedId,
  search: z.string().trim().max(200).optional(),
  source: z.enum(dictionaries.passengerSources).optional(),
  sourceBatchId: scopedId.optional(),
  conditionStatus: z.enum(dictionaries.conditionStatuses).optional(),
  holdStatus: z.enum(dictionaries.holdTypes).optional(),
  srcConfirmed: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
  sortBy: z.enum(["updatedAt", "operationalId", "lastName", "flightNumber", "conditionStatus", "holdStatus"]).default("updatedAt"),
  sortDirection: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

const versionedAction = z.object({
  sessionId: scopedId,
  version: z.coerce.number().int().min(1),
  basis: z.string().trim().max(2_000).optional()
}).strict();

const conditionAction = z.object({
  sessionId: scopedId,
  version: z.coerce.number().int().min(1),
  conditionStatus: z.enum(dictionaries.conditionStatuses),
  basis: z.string().trim().min(3).max(2_000)
}).strict();

const holdAction = z.object({
  sessionId: scopedId,
  version: z.coerce.number().int().min(1),
  holdStatus: z.enum(dictionaries.holdTypes),
  reason: z.string().trim().min(3).max(2_000)
}).strict();

function actor(req: Request): PassengerActor {
  if (!req.user) throw new Error("Authenticated actor is required");
  return {
    id: req.user.id,
    email: req.user.email,
    displayName: req.user.displayName,
    roles: req.user.roles,
    requestId: req.requestId
  };
}

export function createPassengerRouter(
  service: PassengerService,
  compatibility: { onList?: (records: PassengerRecord[], incidentId: string, offset: number) => void; onChange?: (record: PassengerRecord) => void; requireIncidentPermission?: IncidentPermissionGate } = {}
) {
  const router = Router();
  const authorize = (permission: Parameters<typeof requirePermission>[0], source: "query" | "body", writable = false): RequestHandler => compatibility.requireIncidentPermission
    ? compatibility.requireIncidentPermission(permission, (req) => String(source === "query" ? req.query.sessionId ?? "" : req.body?.sessionId ?? ""), { requireWritable: writable })
    : requirePermission(permission);

  router.get("/passenger-records", authorize("passenger:read", "query"), asyncHandler(async (req, res) => {
    const query = listQuery.parse(req.query);
    const result = await service.list(actor(req), query.sessionId, query);
    compatibility.onList?.(result.data, query.sessionId, query.offset);
    res.json(result);
  }));

  router.get("/passenger-records/:id", authorize("passenger:read", "query"), asyncHandler(async (req, res) => {
    res.json(await service.get(actor(req), scopedId.parse(req.query.sessionId), scopedId.parse(req.params.id)));
  }));

  router.post("/passenger-records", authorize("passenger:create", "body", true), asyncHandler(async (req, res) => {
    const record = await service.create(actor(req), createBody.parse(req.body));
    compatibility.onChange?.(record);
    res.status(201).json(record);
  }));

  router.patch("/passenger-records/:id", authorize("passenger:update", "body", true), asyncHandler(async (req, res) => {
    const { sessionId, version, ...input } = updateBody.parse(req.body);
    const record = await service.update(actor(req), sessionId, scopedId.parse(req.params.id), input, version);
    compatibility.onChange?.(record);
    res.json(record);
  }));

  router.post("/passenger-records/:id/correct-source", authorize("passenger:update", "body", true), asyncHandler(async (req, res) => {
    const { sessionId, version, ...input } = correctionBody.parse(req.body);
    const record = await service.correctSource(actor(req), sessionId, scopedId.parse(req.params.id), input, version);
    compatibility.onChange?.(record);
    res.json(record);
  }));

  router.post("/passenger-records/:id/mark-src-confirmed", authorize("passenger:srcConfirm", "body", true), asyncHandler(async (req, res) => {
    const body = versionedAction.parse(req.body);
    const record = await service.confirmSrc(actor(req), body.sessionId, scopedId.parse(req.params.id), body.version, body.basis);
    compatibility.onChange?.(record);
    res.json(record);
  }));

  router.post("/passenger-records/:id/change-condition", authorize("passenger:control", "body", true), asyncHandler(async (req, res) => {
    const body = conditionAction.parse(req.body);
    const record = await service.control(actor(req), body.sessionId, scopedId.parse(req.params.id), "conditionStatus", body.conditionStatus, body.basis, body.version);
    compatibility.onChange?.(record);
    res.json(record);
  }));

  router.post("/passenger-records/:id/change-hold", authorize("passenger:control", "body", true), asyncHandler(async (req, res) => {
    const body = holdAction.parse(req.body);
    const record = await service.control(actor(req), body.sessionId, scopedId.parse(req.params.id), "holdStatus", body.holdStatus, body.reason, body.version);
    compatibility.onChange?.(record);
    res.json(record);
  }));

  return router;
}
