import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";
import { asyncHandler } from "../../errors.js";
import { requirePermission } from "../../rbac.js";
import type { IncidentPermissionGate } from "../incident-access/incident-permission-gate.js";
import type { MatchingService } from "./matching-service.js";
import type { MatchingActor, MatchingCompatibilityRecord } from "./matching-types.js";

const id = z.string().trim().min(1).max(100);
const uuid = z.string().uuid();
const basis = z.string().trim().min(3).max(2_000);
const scope = z.object({ sessionId: id }).strict();
const queueQuery = scope.extend({
  search: z.string().trim().max(200).optional(),
  state: z.enum(["UNMATCHED", "SUGGESTED", "CONFIRMED", "STALE"]).optional(),
  relationshipStatus: z.string().trim().max(50).optional(),
  sortBy: z.enum(["updatedAt", "claimant", "state"]).default("updatedAt"),
  sortDirection: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});
const pageQuery = scope.extend({ search: z.string().trim().max(200).optional(), status: z.string().trim().max(50).optional(), sortDirection: z.enum(["asc", "desc"]).default("desc"), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) });
const suggestionQuery = scope.extend({ status: z.enum(["ACTIVE", "USED", "REJECTED", "OBSOLETE"]).optional(), hasConflicts: z.enum(["true", "false"]).transform((value) => value === "true").optional(), sortDirection: z.enum(["asc", "desc"]).default("desc"), limit: z.coerce.number().int().min(1).max(200).default(20), offset: z.coerce.number().int().min(0).default(0) });
const candidateQuery = scope.extend({ search: z.string().trim().max(200).optional(), sortDirection: z.enum(["asc", "desc"]).default("asc"), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) });
const generateBody = z.object({ sessionId: id, expectedClaimVersion: z.coerce.number().int().min(1) }).strict();
const confirmBody = z.object({ sessionId: id, passengerRecordId: id, suggestionId: id.optional().nullable(), reason: basis, expectedClaimVersion: z.coerce.number().int().min(1), expectedPassengerVersion: z.coerce.number().int().min(1), operationId: uuid }).strict();
const rejectBody = confirmBody.extend({ suggestionId: id, expectedSuggestionVersion: z.coerce.number().int().min(1) }).strict();
const invalidateBody = z.object({ sessionId: id, decisionId: id, reason: basis, expectedClaimVersion: z.coerce.number().int().min(1), expectedPassengerVersion: z.coerce.number().int().min(1), operationId: uuid }).strict();
const holdBody = z.object({ sessionId: id, version: z.coerce.number().int().min(1), holdCheck: z.string().trim().min(1).max(200), reason: basis }).strict();

function actor(req: Request): MatchingActor {
  if (!req.user) throw new Error("Authenticated actor is required");
  return { id: req.user.id, email: req.user.email, displayName: req.user.displayName, roles: req.user.roles, requestId: req.requestId };
}

export function createMatchingRouter(service: MatchingService, compatibility: { onList?: (records: MatchingCompatibilityRecord[], incidentId: string, offset: number) => void; onChange?: (record: MatchingCompatibilityRecord) => void; requireIncidentPermission?: IncidentPermissionGate } = {}) {
  const router = Router();
  const authorize = (permission: Parameters<typeof requirePermission>[0], source: "query" | "body", writable = false): RequestHandler => compatibility.requireIncidentPermission
    ? compatibility.requireIncidentPermission(permission, (req) => String(source === "query" ? req.query.sessionId ?? "" : req.body?.sessionId ?? ""), { requireWritable: writable })
    : requirePermission(permission);
  // Read-only transition projection for consumers shipped before the Stage 5 queue.
  router.get("/matching-records/suggestions", authorize("matching:read", "query"), asyncHandler(async (req, res) => {
    const { sessionId } = scope.parse(req.query);
    const result = await service.listQueue(actor(req), sessionId, { sortBy: "updatedAt", sortDirection: "desc", limit: 200, offset: 0 });
    const data = result.data.flatMap((item) => item.topSuggestion ? [item.topSuggestion] : []);
    res.json({ total: data.length, data, deprecated: true });
  }));
  router.get("/matching-records", authorize("matching:read", "query"), asyncHandler(async (req, res) => {
    const query = pageQuery.parse(req.query);
    const result = await service.listCompatibility(actor(req), query.sessionId, query);
    compatibility.onList?.(result.data, query.sessionId, query.offset);
    res.json(result);
  }));
  router.get("/matching/queue", authorize("matching:read", "query"), asyncHandler(async (req, res) => {
    const query = queueQuery.parse(req.query);
    res.json(await service.listQueue(actor(req), query.sessionId, query));
  }));
  router.get("/matching/claims/:claimId", authorize("matching:read", "query"), asyncHandler(async (req, res) => {
    res.json(await service.getContext(actor(req), id.parse(req.query.sessionId), id.parse(req.params.claimId)));
  }));
  router.get("/matching/claims/:claimId/suggestions", authorize("matching:read", "query"), asyncHandler(async (req, res) => {
    const query = suggestionQuery.parse(req.query);
    res.json(await service.listSuggestions(actor(req), query.sessionId, id.parse(req.params.claimId), query));
  }));
  router.post("/matching/claims/:claimId/suggestions/generate", authorize("matching:create", "body", true), asyncHandler(async (req, res) => {
    const { sessionId, ...body } = generateBody.parse(req.body);
    res.status(201).json(await service.generateSuggestions(actor(req), sessionId, id.parse(req.params.claimId), body));
  }));
  router.get("/matching/claims/:claimId/candidates", authorize("matching:read", "query"), asyncHandler(async (req, res) => {
    const query = candidateQuery.parse(req.query);
    res.json(await service.listCandidates(actor(req), query.sessionId, id.parse(req.params.claimId), query));
  }));
  router.post("/matching/claims/:claimId/confirm", authorize("matching:verify", "body", true), asyncHandler(async (req, res) => {
    const { sessionId, ...body } = confirmBody.parse(req.body);
    res.json(await service.confirm(actor(req), sessionId, id.parse(req.params.claimId), body));
  }));
  router.post("/matching/claims/:claimId/reject", authorize("matching:reject", "body", true), asyncHandler(async (req, res) => {
    const { sessionId, ...body } = rejectBody.parse(req.body);
    res.json(await service.reject(actor(req), sessionId, id.parse(req.params.claimId), body));
  }));
  router.post("/matching/claims/:claimId/invalidate", authorize("matching:verify", "body", true), asyncHandler(async (req, res) => {
    const { sessionId, ...body } = invalidateBody.parse(req.body);
    res.json(await service.invalidate(actor(req), sessionId, id.parse(req.params.claimId), body));
  }));
  const hold = (path: "hold" | "clear-hold") => router.post(`/matching-records/:id/${path}`, authorize(path === "hold" ? "matching:hold" : "matching:clearHold", "body", true), asyncHandler(async (req, res) => {
    const { sessionId, version, reason, holdCheck } = holdBody.parse({ ...req.body, holdCheck: path === "clear-hold" ? "No hold" : req.body?.holdCheck });
    const record = await service.setHold(actor(req), sessionId, id.parse(req.params.id), { expectedVersion: version, reason, holdCheck });
    compatibility.onChange?.(record);
    res.json(record);
  }));
  hold("hold");
  hold("clear-hold");
  return router;
}
