import type { Request, RequestHandler } from "express";
import { Router } from "express";
import { asyncHandler, HttpError } from "../../errors.js";
import type { IncidentPermissionGate } from "../incident-access/incident-permission-gate.js";
import {
  generationPermissions,
  isFoundationExportType,
  type ExportAuthorizationContext,
  type FoundationExportType
} from "./export-types.js";
import type { PrismaExportService } from "./prisma-export-service.js";

const operationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const unavailableTypes = new Set(["pdf-session-summary", "aar-draft"]);

function requestActor(req: Request) {
  if (!req.user) throw new HttpError(401, "Authentication required");
  return { id: req.user.id, email: req.user.email, displayName: req.user.displayName, requestId: req.requestId };
}

function exportType(req: Request): FoundationExportType {
  const value = String(req.params.type);
  if (unavailableTypes.has(value)) throw new HttpError(501, "This report format is not available right now.");
  if (!isFoundationExportType(value)) throw new HttpError(400, "Unsupported export type");
  return value;
}

function pageQuery(req: Request) {
  return {
    limit: Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200),
    offset: Math.max(Number(req.query.offset ?? 0) || 0, 0)
  };
}

export function createExportRouter(service: PrismaExportService, requireIncidentPermission: IncidentPermissionGate) {
  const router = Router();
  const contexts = new WeakMap<Request, ExportAuthorizationContext>();
  const validateType: RequestHandler = (req, _res, next) => {
    try { exportType(req); next(); } catch (error) { next(error); }
  };
  const loadGeneration = asyncHandler(async (req, _res, next) => {
    contexts.set(req, await service.authorizationContext(String(req.params.id)));
    next();
  });
  const generationContext = (req: Request) => {
    const context = contexts.get(req);
    if (!context) throw new HttpError(404, "Export generation not found");
    return context;
  };
  const authorizeGeneration = requireIncidentPermission(
    (req) => generationPermissions(generationContext(req).exportType),
    (req) => generationContext(req).incidentId
  );
  const generationGate: RequestHandler = (req, res, next) => authorizeGeneration(req, res, (error?: unknown) => {
    if (error instanceof HttpError && (error.status === 403 || error.status === 404)) {
      next(new HttpError(404, "Export generation not found"));
      return;
    }
    next(error);
  });

  router.post(
    "/exports/:type",
    validateType,
    requireIncidentPermission(
      (req) => ["export:create", "session:read", ...(exportType(req) === "session-package" ? [] : generationPermissions(exportType(req)).slice(2))],
      (req) => String(req.body?.sessionId ?? "")
    ),
    asyncHandler(async (req, res) => {
      const operationId = String(req.body?.operationId ?? "").trim();
      if (!operationIdPattern.test(operationId)) throw new HttpError(400, "operationId must be a UUID");
      const result = await service.prepare({ operationId, incidentId: String(req.body.sessionId), exportType: exportType(req) }, requestActor(req));
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${result.generation.fileName}"`);
      res.setHeader("Content-Length", String(result.buffer.byteLength));
      res.setHeader("Content-Encoding", "identity");
      res.setHeader("Cache-Control", "no-store, no-transform");
      res.setHeader("X-Export-Generation-Id", result.generation.id);
      res.send(result.buffer);
    })
  );

  router.get("/exports/generations/:id", loadGeneration, generationGate, asyncHandler(async (req, res) => {
    res.json(await service.get(generationContext(req).id));
  }));

  router.get("/sessions/:sessionId/export-generations", requireIncidentPermission(
    ["export:create", "session:read"],
    (req) => String(req.params.sessionId)
  ), asyncHandler(async (req, res) => {
    res.json(await service.list(String(req.params.sessionId), req.incidentPermissions ?? [], pageQuery(req)));
  }));

  router.get("/reports/session-summary", requireIncidentPermission(
    ["reports:read", "session:read"],
    (req) => String(req.query.sessionId ?? "")
  ), asyncHandler(async (req, res) => {
    res.json(await service.sessionSummary(String(req.query.sessionId), requestActor(req).id));
  }));

  router.get("/exports/:type", (_req, res) => {
    res.status(405).setHeader("Allow", "POST").json({ error: "Use POST to prepare an export" });
  });

  return router;
}
