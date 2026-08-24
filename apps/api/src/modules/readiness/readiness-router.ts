import type { Request } from "express";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler, HttpError } from "../../errors.js";
import { authenticate } from "../../auth.js";
import type { ReadinessActor, ReadinessOverallStatus } from "./readiness-types.js";
import type { ReadinessProjectionService } from "./prisma-readiness-service.js";

const statusValues = ["Ready", "Ready with attention", "Not ready", "Unknown", "Not applicable"] as const;
const evaluationAt = z.string().datetime({ offset: true }).optional().transform((value) => value ? new Date(value) : undefined);
const boundedIds = z.string().max(40_200).optional()
  .transform((value) => value ? [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))] : undefined)
  .refine((value) => !value || (value.length <= 200 && value.every((item) => item.length <= 200)), "At most 200 valid identifiers are allowed");
const page = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  evaluationAt,
});
const memberQuery = page.extend({
  search: z.string().trim().max(200).optional().transform((value) => value || undefined),
  q: z.string().trim().max(200).optional().transform((value) => value || undefined),
  status: z.enum(statusValues).optional(),
  groupId: z.string().trim().max(200).optional().transform((value) => value || undefined),
  memberProfileIds: boundedIds,
});
const groupQuery = page.extend({
  search: z.string().trim().max(200).optional().transform((value) => value || undefined),
  groupIds: boundedIds,
  optionsOnly: z.enum(["true", "false"]).optional().transform((value) => value === "true"),
});

function actor(req: Request): ReadinessActor {
  if (!req.user) throw new HttpError(401, "Authentication required");
  return { id: req.user.id, email: req.user.email, displayName: req.user.displayName, requestId: req.requestId };
}

function id(req: Request, name: string) {
  const value = String(req.params[name] ?? "").trim();
  if (!value || value.length > 200) throw new HttpError(404, "Readiness record not found");
  return value;
}

export function createReadinessRouter(service: ReadinessProjectionService) {
  const router = Router();
  router.use("/readiness", authenticate);

  router.get("/readiness/me", asyncHandler(async (req, res) => {
    const query = page.pick({ evaluationAt: true }).parse(req.query);
    res.json(await service.me(actor(req), query.evaluationAt));
  }));
  router.get("/readiness/members", asyncHandler(async (req, res) => {
    const query = memberQuery.parse(req.query);
    res.json(await service.members(actor(req), { ...query, search: query.search ?? query.q, status: query.status as ReadinessOverallStatus | undefined }));
  }));
  router.get("/readiness/members/:memberProfileId", asyncHandler(async (req, res) => {
    const query = page.pick({ evaluationAt: true }).parse(req.query);
    res.json(await service.member(actor(req), id(req, "memberProfileId"), query.evaluationAt));
  }));
  router.get("/readiness/groups", asyncHandler(async (req, res) => {
    res.json(await service.groups(actor(req), groupQuery.parse(req.query)));
  }));
  router.get("/readiness/groups/:groupId", asyncHandler(async (req, res) => {
    res.json(await service.group(actor(req), id(req, "groupId"), page.parse(req.query)));
  }));
  router.get("/readiness/summary", asyncHandler(async (req, res) => {
    const query = page.pick({ evaluationAt: true }).parse(req.query);
    res.json(await service.summary(actor(req), query.evaluationAt));
  }));
  router.get("/readiness/policy", asyncHandler(async (req, res) => {
    res.json(await service.policy(actor(req)));
  }));

  return router;
}
