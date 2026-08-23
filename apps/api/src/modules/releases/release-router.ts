import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";
import { asyncHandler } from "../../errors.js";
import { requirePermission } from "../../rbac.js";
import type { IncidentPermissionGate } from "../incident-access/incident-permission-gate.js";
import type { ReleaseService } from "./release-service.js";
import type { ReleaseActor, ReleaseCompatibilityRecord } from "./release-types.js";

const id = z.string().trim().min(1).max(100);
const operationId = z.string().uuid();
const basis = z.string().trim().min(3).max(2_000);
const optionalText = z.string().trim().max(500).optional().nullable();
const scope = z.object({ sessionId: id }).strict();
const queue = scope.extend({
  search: z.string().trim().max(200).optional(),
  status: z.enum(["PREPARED", "AUTHORIZED", "COMPLETED", "CANCELLED"]).optional(),
  eligibility: z.enum(["eligible", "blocked"]).optional(),
  actionType: z.enum(["REUNIFICATION", "RELEASE"]).optional(),
  sortDirection: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});
const candidates = scope.extend({ search: z.string().trim().max(200).optional(), eligibility: z.enum(["eligible", "blocked"]).optional(), sortDirection: z.enum(["asc", "desc"]).default("asc"), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) });
const prepare = z.object({ sessionId: id, matchDecisionId: id, actionType: z.enum(["REUNIFICATION", "RELEASE"]), releaseDestination: optionalText, receivingParty: optionalText, transportMode: optionalText, notes: z.string().trim().max(2_000).optional().nullable(), operationId }).strict();
const identity = z.object({ sessionId: id, result: z.enum(["PASS", "FAIL"]), basis, evidenceReference: z.string().trim().max(500).optional().nullable(), expectedVersion: z.coerce.number().int().min(1), operationId }).strict();
const hold = z.object({ sessionId: id, basis, expectedVersion: z.coerce.number().int().min(1), operationId }).strict();
const decision = z.object({ sessionId: id, reason: basis, expectedVersion: z.coerce.number().int().min(1), operationId }).strict();

function actor(req: Request): ReleaseActor {
  if (!req.user) throw new Error("Authenticated actor is required");
  return { id: req.user.id, email: req.user.email, displayName: req.user.displayName, roles: req.user.roles, requestId: req.requestId };
}

export function createReleaseRouter(service: ReleaseService, compatibility: { onList?: (records: ReleaseCompatibilityRecord[], incidentId: string, offset: number) => void; onChange?: (record: ReleaseCompatibilityRecord) => void; requireIncidentPermission?: IncidentPermissionGate } = {}) {
  const router = Router();
  const authorize = (permission: Parameters<typeof requirePermission>[0], source: "query" | "body", writable = false): RequestHandler => compatibility.requireIncidentPermission
    ? compatibility.requireIncidentPermission(permission, (req) => String(source === "query" ? req.query.sessionId ?? "" : req.body?.sessionId ?? ""), { requireWritable: writable })
    : requirePermission(permission);
  router.get("/releases/queue", authorize("release:read", "query"), asyncHandler(async (req, res) => {
    const query = queue.parse(req.query);
    res.json(await service.listQueue(actor(req), query.sessionId, query));
  }));
  router.get("/releases/candidates", authorize("release:read", "query"), asyncHandler(async (req, res) => {
    const query = candidates.parse(req.query);
    res.json(await service.listCandidates(actor(req), query.sessionId, query));
  }));
  router.get("/releases/:id", authorize("release:read", "query"), asyncHandler(async (req, res) => {
    res.json(await service.getContext(actor(req), id.parse(req.query.sessionId), id.parse(req.params.id)));
  }));
  router.get("/releases", authorize("release:read", "query"), asyncHandler(async (req, res) => {
    const query = queue.parse(req.query);
    const result = await service.listCompatibility(actor(req), query.sessionId, query);
    compatibility.onList?.(result.data, query.sessionId, query.offset);
    res.json({ ...result, deprecated: true, readOnly: true });
  }));
  router.post("/releases/prepare", authorize("release:prepare", "body", true), asyncHandler(async (req, res) => {
    const { sessionId, ...input } = prepare.parse(req.body);
    res.status(201).json(await service.prepare(actor(req), sessionId, input));
  }));
  router.post("/releases/:id/checks/identity", authorize("release:check", "body", true), asyncHandler(async (req, res) => {
    const { sessionId, ...input } = identity.parse(req.body);
    res.json(await service.recordIdentityCheck(actor(req), sessionId, id.parse(req.params.id), input));
  }));
  router.post("/releases/:id/checks/hold", authorize("release:check", "body", true), asyncHandler(async (req, res) => {
    const { sessionId, ...input } = hold.parse(req.body);
    res.json(await service.recordHoldReview(actor(req), sessionId, id.parse(req.params.id), input));
  }));
  router.post("/releases/:id/authorize", authorize("release:authorize", "body", true), asyncHandler(async (req, res) => {
    const { sessionId, ...input } = decision.parse(req.body);
    res.json(await service.authorize(actor(req), sessionId, id.parse(req.params.id), input));
  }));
  router.post("/releases/:id/complete", authorize("release:complete", "body", true), asyncHandler(async (req, res) => {
    const { sessionId, ...input } = decision.parse(req.body);
    res.json(await service.complete(actor(req), sessionId, id.parse(req.params.id), input));
  }));
  router.post("/releases/:id/cancel", authorize("release:cancel", "body", true), asyncHandler(async (req, res) => {
    const { sessionId, ...input } = decision.parse(req.body);
    res.json(await service.cancel(actor(req), sessionId, id.parse(req.params.id), input));
  }));
  return router;
}
