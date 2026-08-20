import { Router, type Request } from "express";
import { z } from "zod";
import { asyncHandler, HttpError } from "../../errors.js";
import type { createPersistentNotificationService } from "./notification-service.js";

const booleanQuery = z.preprocess((v) => v === "true" ? true : v === "false" ? false : v, z.boolean().optional());
const listQuery = z.object({
  unread: booleanQuery,
  kind: z.enum(["Action required", "Information"]).optional(), category: z.enum(["Session", "Briefing", "Assignment", "Rostering", "Training", "Documents", "Readiness", "Requests", "Operational", "Admin"]).optional(),
  severity: z.enum(["Critical", "Attention", "Information"]).optional(), sessionId: z.string().uuid().optional(), sourceType: z.enum(["session", "briefing", "assignment", "rosterShift", "trainingRecord", "documentVersion", "documentRequirement", "access"]).optional(),
  status: z.enum(["active", "resolved"]).optional(), active: booleanQuery, resolved: booleanQuery,
  limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0), sort: z.enum(["newest", "oldest"]).default("newest"),
}).strict().transform(({ active, resolved, ...query }) => ({ ...query, status: query.status ?? (active === true || resolved === false ? "active" : resolved === true || active === false ? "resolved" : undefined) }));
const ids = z.object({ ids: z.array(z.string().uuid()).max(5000).optional() }).strict();
const id = z.string().uuid();
type Service = ReturnType<typeof createPersistentNotificationService>;
function actor(req: Request) { if (!req.user) throw new HttpError(401, "Authentication required"); return req.user; }

export function createNotificationRouter(service: Service) {
  const router = Router();
  router.get("/notifications", asyncHandler(async (req, res) => res.json(await service.list(actor(req), listQuery.parse(req.query)))));
  router.get("/notifications/counts", asyncHandler(async (req, res) => res.json(await service.counts(actor(req)))));
  router.get("/notifications/delivery-health", asyncHandler(async (req, res) => {
    const user = actor(req);
    if (!user.permissions.includes("admin:manage")) throw new HttpError(404, "Notification diagnostic not found");
    res.json(await service.deliveryHealth());
  }));
  router.get("/notifications/:id", asyncHandler(async (req, res) => { const row = await service.get(actor(req), id.parse(req.params.id)); if (!row) throw new HttpError(404, "Notification not found"); res.json(row); }));
  router.post("/notifications/read-all", asyncHandler(async (req, res) => { try { res.json(await service.markAllRead(actor(req), ids.parse(req.body).ids)); } catch (error) { if (error instanceof Error && error.message === "NOTIFICATION_NOT_FOUND") throw new HttpError(404, "Notification not found"); throw error; } }));
  router.post("/notifications/:id/read", asyncHandler(async (req, res) => { const row = await service.markRead(actor(req), id.parse(req.params.id)); if (!row) throw new HttpError(404, "Notification not found"); res.json(row); }));
  router.post("/notifications/:id/unread", asyncHandler(async (req, res) => { const row = await service.markUnread(actor(req), id.parse(req.params.id)); if (!row) throw new HttpError(404, "Notification not found"); res.json(row); }));
  return router;
}
