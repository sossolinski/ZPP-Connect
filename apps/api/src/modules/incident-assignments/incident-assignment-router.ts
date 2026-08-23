import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";
import { asyncHandler } from "../../errors.js";
import { requirePermission } from "../../rbac.js";
import type { IncidentActor } from "../incidents/incident-types.js";
import type { IncidentPermissionGate } from "../incident-access/incident-permission-gate.js";
import type { IncidentAssignmentService } from "./incident-assignment-service.js";

const id = z.string().trim().min(1).max(100);
const params = z.object({ id, assignmentId: id.optional() });
const listQuery = z.object({ includeInactive: z.enum(["true", "false"]).default("false").transform((value) => value === "true") });
const assignBody = z.object({
  userId: id,
  function: z.string().trim().max(200).optional().nullable(),
  scope: z.string().trim().min(1).max(100).default("OPERATIONAL"),
  reason: z.string().trim().max(1_000).optional().nullable()
});
const actionBody = z.object({ reason: z.string().trim().max(1_000).optional().nullable() });

function actor(req: Request): IncidentActor {
  if (!req.user) throw new Error("Authenticated actor is required");
  return {
    id: req.user.id,
    email: req.user.email,
    displayName: req.user.displayName,
    roles: req.user.roles,
    requestId: req.requestId
  };
}

export function createIncidentAssignmentRouter(service: IncidentAssignmentService, requireIncidentPermission?: IncidentPermissionGate) {
  const router = Router();
  const authorize = (permission: Parameters<typeof requirePermission>[0], writable = false): RequestHandler => requireIncidentPermission
    ? requireIncidentPermission(permission, (req) => String(req.params.id ?? ""), { requireWritable: writable })
    : requirePermission(permission);

  router.get("/sessions/:id/assignments", authorize("incident:members:read"), asyncHandler(async (req, res) => {
    const { id: incidentId } = params.parse(req.params);
    const { includeInactive } = listQuery.parse(req.query);
    res.json(await service.list(actor(req), incidentId, includeInactive));
  }));

  router.post("/sessions/:id/assignments", authorize("incident:members:manage", true), asyncHandler(async (req, res) => {
    const { id: incidentId } = params.parse(req.params);
    res.status(201).json(await service.assign(actor(req), incidentId, assignBody.parse(req.body)));
  }));

  router.post("/sessions/:id/assignments/:assignmentId/revoke", authorize("incident:members:manage", true), asyncHandler(async (req, res) => {
    const { id: incidentId, assignmentId } = params.parse(req.params);
    const { reason } = actionBody.parse(req.body ?? {});
    res.json(await service.revoke(actor(req), incidentId, assignmentId!, reason ?? null));
  }));

  router.post("/sessions/:id/assignments/:assignmentId/reactivate", authorize("incident:members:manage", true), asyncHandler(async (req, res) => {
    const { id: incidentId, assignmentId } = params.parse(req.params);
    const { reason } = actionBody.parse(req.body ?? {});
    res.json(await service.reactivate(actor(req), incidentId, assignmentId!, reason ?? null));
  }));

  return router;
}
