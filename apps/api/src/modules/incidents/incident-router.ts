import { Router } from "express";
import type { Request, RequestHandler } from "express";
import { z } from "zod";
import { asyncHandler } from "../../errors.js";
import { requirePermission } from "../../rbac.js";
import type { IncidentPermissionGate } from "../incident-access/incident-permission-gate.js";
import { listQuery, sessionCloseSchema, sessionSchema } from "../../validation.js";
import type { IncidentService } from "./incident-service.js";
import type { IncidentActor, IncidentCreateInput, IncidentListQuery, IncidentRecord, IncidentUpdateInput } from "./incident-types.js";

const incidentIdParam = z.object({ id: z.string().trim().min(1) });

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

function clean<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

export function createIncidentRouter(
  service: IncidentService,
  compatibility: {
    onList?: (records: IncidentRecord[], query: IncidentListQuery) => void;
    onChange?: (record: IncidentRecord) => void;
    requireIncidentPermission?: IncidentPermissionGate;
    effectiveIncidentIdsForPermission?: (userId: string) => Promise<string[] | null>;
    validateEventType?: (value: string) => Promise<void>;
  } = {}
) {
  const router = Router();
  const authorize = (permission: "session:read" | "session:update" | "session:close", writable = false): RequestHandler => compatibility.requireIncidentPermission
    ? compatibility.requireIncidentPermission(permission, (req) => String(req.params.id ?? ""), { requireWritable: writable })
    : requirePermission(permission);

  router.get(
    "/sessions",
    requirePermission("session:read"),
    asyncHandler(async (req, res) => {
      const query = listQuery.parse(req.query);
      const permissionIncidentIds = req.user && compatibility.effectiveIncidentIdsForPermission
        ? await compatibility.effectiveIncidentIdsForPermission(req.user.id)
        : undefined;
      const result = await service.list(actor(req), query, permissionIncidentIds);
      compatibility.onList?.(result.data, query);
      res.json(result);
    })
  );

  router.get(
    "/sessions/:id",
    authorize("session:read"),
    asyncHandler(async (req, res) => {
      const { id } = incidentIdParam.parse(req.params);
      res.json(await service.get(id, actor(req)));
    })
  );

  router.post(
    "/sessions",
    requirePermission("session:create"),
    asyncHandler(async (req, res) => {
      const input = clean(sessionSchema.parse(req.body)) as IncidentCreateInput;
      await compatibility.validateEventType?.(input.eventType);
      const record = await service.create(input, actor(req));
      compatibility.onChange?.(record);
      res.status(201).json(record);
    })
  );

  router.patch(
    "/sessions/:id",
    authorize("session:update", true),
    asyncHandler(async (req, res) => {
      const { id } = incidentIdParam.parse(req.params);
      const input = clean(sessionSchema.partial().parse(req.body)) as IncidentUpdateInput;
      if (input.eventType !== undefined) await compatibility.validateEventType?.(input.eventType);
      const record = await service.update(id, input, actor(req));
      compatibility.onChange?.(record);
      res.json(record);
    })
  );

  router.post(
    "/sessions/:id/close",
    authorize("session:close", true),
    asyncHandler(async (req, res) => {
      const { id } = incidentIdParam.parse(req.params);
      const { notes } = sessionCloseSchema.parse(req.body);
      const record = await service.close(id, notes, actor(req));
      compatibility.onChange?.(record);
      res.json(record);
    })
  );

  return router;
}
