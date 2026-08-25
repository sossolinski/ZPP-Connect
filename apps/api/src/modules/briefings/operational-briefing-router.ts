import type { Request } from "express";
import { Router } from "express";
import type { Permission } from "@zpp/shared";
import { ActiveEventError, type ActiveEventActor } from "../../active-event.js";
import { asyncHandler } from "../../errors.js";
import type { IncidentPermissionGate } from "../incident-access/incident-permission-gate.js";
import type { PrismaOperationalBriefingService } from "./prisma-operational-briefing-service.js";

function actor(req: Request): ActiveEventActor {
  if (!req.user) throw new Error("Authenticated actor is required");
  return {
    id: req.user.id,
    email: req.user.email,
    displayName: req.user.displayName,
    roles: req.user.roles,
    permissions: req.incidentPermissions ?? req.user.permissions,
  };
}

export function createOperationalBriefingRouter(
  service: PrismaOperationalBriefingService,
  requireIncidentPermission: IncidentPermissionGate,
) {
  const router = Router();
  const route = (handler: (req: Request) => unknown | Promise<unknown>) => asyncHandler(async (req, res) => {
    try {
      res.json(await handler(req));
    } catch (error) {
      if (error instanceof ActiveEventError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  });

  const metadata = new WeakMap<Request, Promise<{ sessionId: string; status: string }>>();
  const securityMetadata = (req: Request) => {
    const cached = metadata.get(req);
    if (cached) return cached;
    const pending = service.securityMetadataForBriefing(String(req.params.briefingId));
    metadata.set(req, pending);
    return pending;
  };
  const incidentForBriefing = async (req: Request) => (await securityMetadata(req)).sessionId;
  const readPermissions = async (req: Request): Promise<Permission[]> => (await securityMetadata(req)).status === "Published"
    ? ["briefing:read"]
    : ["briefing:read", "briefing:read-history"];

  router.get(
    "/sessions/:sessionId/active-event",
    requireIncidentPermission("briefing:read", (req) => String(req.params.sessionId)),
    route((req) => service.getActiveEvent(String(req.params.sessionId), actor(req))),
  );
  router.get(
    "/sessions/:sessionId/briefings",
    requireIncidentPermission("briefing:read-history", (req) => String(req.params.sessionId)),
    route((req) => service.listRevisions(String(req.params.sessionId), actor(req), req.query as Record<string, unknown>)),
  );
  router.get(
    "/sessions/:sessionId/briefings/current",
    requireIncidentPermission("briefing:read", (req) => String(req.params.sessionId)),
    route((req) => service.getCurrent(String(req.params.sessionId), actor(req))),
  );
  router.get(
    "/briefings/:briefingId",
    requireIncidentPermission(readPermissions, incidentForBriefing),
    route((req) => service.getBriefing(String(req.params.briefingId), actor(req))),
  );
  router.post(
    "/sessions/:sessionId/briefings/draft",
    requireIncidentPermission("briefing:create-draft", (req) => String(req.params.sessionId), { requireWritable: true }),
    route((req) => service.createDraft(String(req.params.sessionId), actor(req))),
  );
  router.patch(
    "/briefings/:briefingId",
    requireIncidentPermission("briefing:update-draft", incidentForBriefing, { requireWritable: true }),
    route(async (req) => (await service.updateDraft(String(req.params.briefingId), req.body ?? {}, actor(req))).briefing),
  );
  router.post(
    "/briefings/:briefingId/publish",
    requireIncidentPermission("briefing:publish", incidentForBriefing, { requireWritable: true }),
    route(async (req) => (await service.publishDraft(String(req.params.briefingId), req.body?.expectedVersion, actor(req))).briefing),
  );

  return router;
}
