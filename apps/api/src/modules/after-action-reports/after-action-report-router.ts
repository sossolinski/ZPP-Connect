import { Router, type Request, type RequestHandler } from "express";
import type { Permission } from "@zpp/shared";
import { asyncHandler, HttpError } from "../../errors.js";
import type { IncidentPermissionGate } from "../incident-access/incident-permission-gate.js";
import type { PrismaAfterActionReportService } from "./prisma-after-action-report-service.js";
import { uuid } from "./after-action-report-types.js";

export function createAfterActionReportRouter(service: PrismaAfterActionReportService, requireIncidentPermission: IncidentPermissionGate) {
  const router = Router();
  const actor = (req: Request) => ({ id: req.user!.id, email: req.user!.email, displayName: req.user!.displayName, requestId: req.requestId });
  const antiEnumeration = (handler: RequestHandler): RequestHandler => (req, res, next) => handler(req, res, error => {
    if (error instanceof HttpError && [403, 404].includes(error.status)) return next(new HttpError(404, "After Action Report resource not found"));
    next(error);
  });
  const gate = (kind: "report" | "version" | "artifact", permissions: Permission[]) => antiEnumeration(requireIncidentPermission(["session:read", ...permissions], async req => (await service.context(kind, String(req.params.id))).sessionId));
  const collection = (permission: Permission, fromBody = false) => requireIncidentPermission(["session:read", permission], req => uuid.parse(fromBody ? req.body?.sessionId : req.query.sessionId));
  const route = (fn: (req: Request) => Promise<unknown>) => asyncHandler(async (req, res) => { res.json(await fn(req)); });
  const command = (fn: (req: Request) => Promise<{ replayed: boolean }>, created = false) => asyncHandler(async (req, res) => {
    const result = await fn(req); res.status(created && !result.replayed ? 201 : 200).json(result);
  });
  router.get("/after-action-reports", collection("aar:read"), route(req => service.list(req.query, actor(req))));
  router.post("/after-action-reports", collection("aar:create", true), command(req => service.create(req.body, actor(req)), true));
  router.get("/after-action-reports/:id", gate("report", ["aar:read"]), route(req => service.getReport(String(req.params.id), actor(req))));
  router.get("/after-action-reports/:id/versions", gate("report", ["aar:read"]), route(req => service.history(String(req.params.id), req.query, actor(req))));
  router.get("/after-action-report-versions/:id", gate("version", ["aar:read"]), route(req => service.getVersion(String(req.params.id), actor(req))));
  router.patch("/after-action-report-versions/:id", gate("version", ["aar:update-draft"]), route(req => service.edit(String(req.params.id), req.body, actor(req))));
  for (const action of ["submit", "return-to-draft", "approve"] as const) {
    router.post("/after-action-report-versions/:id/" + action, gate("version", [action === "approve" ? "aar:approve" : "aar:review"]), command(req => service.transition(String(req.params.id), action, req.body, actor(req))));
  }
  router.post("/after-action-reports/:id/revisions", gate("report", ["aar:create", "aar:update-draft"]), command(req => service.revision(String(req.params.id), req.body, actor(req)), true));
  router.post("/after-action-reports/:id/archive", gate("report", ["aar:archive"]), command(req => service.archive(String(req.params.id), req.body, actor(req))));
  router.get("/sessions/:sessionId/aar-source-observations", requireIncidentPermission(["session:read", "aar:create", "exercise:manage"], req => uuid.parse(req.params.sessionId)), route(req => service.sourceObservations(String(req.params.sessionId), req.query, actor(req))));
  router.post("/after-action-report-versions/:id/pdf-artifacts", gate("version", ["aar:read", "aar:pdf:generate"]), command(req => service.generatePdf(String(req.params.id), req.body, actor(req)), true));
  router.get("/after-action-report-versions/:id/pdf-artifacts", gate("version", ["aar:read"]), route(req => service.artifacts(String(req.params.id), req.query, actor(req))));
  router.get("/after-action-pdf-artifacts/:id", gate("artifact", ["aar:read"]), route(req => service.artifact(String(req.params.id), actor(req))));
  router.get("/after-action-pdf-artifacts/:id/download", gate("artifact", ["aar:read"]), asyncHandler(async (req, res) => {
    const { metadata: m, content } = await service.download(String(req.params.id), actor(req));
    res.set({
      "Content-Type": m.mimeType, "Content-Disposition": 'attachment; filename="' + m.fileName + '"',
      "Content-Length": String(content.length), "Cache-Control": "no-store, no-transform",
      "X-AAR-Artifact-Id": m.id, "X-Content-SHA256": m.contentSha256, "X-Source-Content-SHA256": m.sourceContentSha256,
    }).send(content);
  }));
  return router;
}
