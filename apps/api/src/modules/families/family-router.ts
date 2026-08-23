import { dictionaries } from "@zpp/shared";
import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";
import { asyncHandler } from "../../errors.js";
import { requirePermission } from "../../rbac.js";
import type { IncidentPermissionGate } from "../incident-access/incident-permission-gate.js";
import type { FamilyService } from "./family-service.js";
import type { FamilyActor, FamilyRecord } from "./family-types.js";

const scopedId = z.string().trim().min(1).max(100);
const nullableText = (max: number) => z.preprocess(
  (value) => (value === "" ? null : value),
  z.string().trim().max(max).optional().nullable()
);
const nullableEmail = z.preprocess(
  (value) => (value === "" ? null : value),
  z.string().trim().email().max(320).optional().nullable()
);

const claimFacts = z.object({
  firstName: z.string().trim().min(1).max(200),
  lastName: z.string().trim().min(1).max(200),
  phone: nullableText(50),
  email: nullableEmail,
  preferredContactChannel: nullableText(100),
  preferredLanguage: nullableText(100),
  location: nullableText(200),
  claimedRelationship: z.preprocess((value) => (value === "" ? null : value), z.enum(dictionaries.relationships).optional().nullable()),
  passengerRecordId: z.preprocess((value) => (value === "" ? null : value), scopedId.optional().nullable()),
  passengerFirstName: nullableText(200),
  passengerLastName: nullableText(200),
  passengerFlight: nullableText(100)
}).strict();

const operatorFields = z.object({
  caseId: nullableText(100),
  immediateNeeds: nullableText(5_000),
  questionsAsked: nullableText(5_000),
  commitmentsMade: nullableText(5_000),
  nextContactDue: z.preprocess((value) => (value === "" ? null : value), z.coerce.date().optional().nullable()),
  assignedOfficer: nullableText(200),
  notes: nullableText(5_000)
}).strict();

const createBody = claimFacts.extend({
  sessionId: scopedId,
  ...operatorFields.shape
}).strict();

const updateBody = operatorFields.extend({
  sessionId: scopedId,
  version: z.coerce.number().int().min(1)
}).strict();

const correctionBody = claimFacts.partial().extend({
  sessionId: scopedId,
  version: z.coerce.number().int().min(1),
  claimVersion: z.coerce.number().int().min(1),
  reason: z.string().trim().min(3).max(2_000)
}).strict();

const decisionBody = z.object({
  sessionId: scopedId,
  version: z.coerce.number().int().min(1),
  claimVersion: z.coerce.number().int().min(1),
  basis: z.string().trim().min(3).max(2_000),
  verifiedRelationshipType: z.preprocess((value) => (value === "" ? null : value), z.enum(dictionaries.relationships).optional().nullable())
}).strict();

const listQuery = z.object({
  sessionId: scopedId,
  search: z.string().trim().max(200).optional(),
  verificationStatus: z.enum(dictionaries.verificationStatuses).optional(),
  relationship: z.enum(dictionaries.relationships).optional(),
  passengerLinked: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
  sortBy: z.enum(["updatedAt", "operationalId", "lastName", "verificationStatus", "nextContactDue"]).default("updatedAt"),
  sortDirection: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

function actor(req: Request): FamilyActor {
  if (!req.user) throw new Error("Authenticated actor is required");
  return { id: req.user.id, email: req.user.email, displayName: req.user.displayName, roles: req.user.roles, requestId: req.requestId };
}

export function createFamilyRouter(
  service: FamilyService,
  compatibility: { onList?: (records: FamilyRecord[], incidentId: string, offset: number) => void; onChange?: (record: FamilyRecord) => void; requireIncidentPermission?: IncidentPermissionGate } = {}
) {
  const router = Router();
  const authorize = (permission: Parameters<typeof requirePermission>[0], source: "query" | "body", writable = false): RequestHandler => compatibility.requireIncidentPermission
    ? compatibility.requireIncidentPermission(permission, (req) => String(source === "query" ? req.query.sessionId ?? "" : req.body?.sessionId ?? ""), { requireWritable: writable })
    : requirePermission(permission);

  router.get("/family-records", authorize("family:read", "query"), asyncHandler(async (req, res) => {
    const query = listQuery.parse(req.query);
    const result = await service.list(actor(req), query.sessionId, query);
    compatibility.onList?.(result.data, query.sessionId, query.offset);
    res.json(result);
  }));

  router.get("/family-records/:id", authorize("family:read", "query"), asyncHandler(async (req, res) => {
    res.json(await service.get(actor(req), scopedId.parse(req.query.sessionId), scopedId.parse(req.params.id)));
  }));

  router.post("/family-records", authorize("family:create", "body", true), asyncHandler(async (req, res) => {
    const record = await service.create(actor(req), createBody.parse(req.body));
    compatibility.onChange?.(record);
    res.status(201).json(record);
  }));

  router.patch("/family-records/:id", authorize("family:update", "body", true), asyncHandler(async (req, res) => {
    const { sessionId, version, ...input } = updateBody.parse(req.body);
    const record = await service.update(actor(req), sessionId, scopedId.parse(req.params.id), input, version);
    compatibility.onChange?.(record);
    res.json(record);
  }));

  router.post("/family-records/:id/correct-claim", authorize("family:update", "body", true), asyncHandler(async (req, res) => {
    const { sessionId, version, claimVersion, ...input } = correctionBody.parse(req.body);
    const record = await service.correctClaim(actor(req), sessionId, scopedId.parse(req.params.id), input, version, claimVersion);
    compatibility.onChange?.(record);
    res.json(record);
  }));

  const decision = (path: "verify" | "reject" | "reopen", result: "VERIFIED" | "REJECTED" | "REOPENED") => {
    router.post(`/family-records/:id/${path}`, authorize("family:verify", "body", true), asyncHandler(async (req, res) => {
      const { sessionId, version, claimVersion, ...body } = decisionBody.parse(req.body);
      const record = await service.decide(actor(req), sessionId, scopedId.parse(req.params.id), { ...body, result }, version, claimVersion);
      compatibility.onChange?.(record);
      res.json(record);
    }));
  };

  decision("verify", "VERIFIED");
  decision("reject", "REJECTED");
  decision("reopen", "REOPENED");

  return router;
}
