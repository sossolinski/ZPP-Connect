import type { Request, RequestHandler } from "express";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { config } from "../../config.js";
import { asyncHandler, HttpError } from "../../errors.js";
import type { IncidentPermissionGate } from "../incident-access/incident-permission-gate.js";
import { evidenceCategories, evidenceContentDisposition, validateEvidenceUpload } from "./evidence-types.js";
import type { PrismaEvidenceService } from "./prisma-evidence-service.js";

const uuid = z.string().uuid();
const uploadBody = z.object({
  operationId: uuid,
  category: z.enum(evidenceCategories),
  description: z.string().trim().max(4000).optional().transform((value) => value || null),
}).strict();
const withdrawBody = z.object({
  operationId: uuid,
  expectedVersion: z.coerce.number().int().positive(),
  reason: z.string().trim().min(1).max(2000),
}).strict();
const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  includeWithdrawn: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
}).strict();

const multipart = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: config.evidenceMaxFileSizeBytes, fields: 4, fieldSize: 8 * 1024 },
});

const parseUpload: RequestHandler = (req, res, next) => {
  multipart.single("file")(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") return next(new HttpError(400, "Evidence file exceeds the configured size limit"));
    return next(new HttpError(400, "Unable to parse evidence upload"));
  });
};

function actor(req: Request) {
  if (!req.user) throw new HttpError(401, "Authentication required");
  return { id: req.user.id, email: req.user.email, displayName: req.user.displayName, requestId: req.requestId };
}

function page(req: Request) {
  return pageQuery.parse(req.query);
}

export function createEvidenceRouter(service: PrismaEvidenceService, requireIncidentPermission: IncidentPermissionGate) {
  const router = Router();
  const incidentId = (req: Request) => {
    const value = String(req.params.sessionId ?? "");
    if (!uuid.safeParse(value).success) throw new HttpError(404, "Incident not found");
    return value;
  };
  const evidenceId = (req: Request) => {
    const value = String(req.params.evidenceId ?? "");
    if (!uuid.safeParse(value).success) throw new HttpError(404, "Evidence not found");
    return value;
  };

  router.get("/sessions/:sessionId/evidence", requireIncidentPermission("evidence:read", incidentId), asyncHandler(async (req, res) => {
    res.json(await service.list(incidentId(req), page(req)));
  }));

  router.post(
    "/sessions/:sessionId/evidence",
    requireIncidentPermission("evidence:upload", incidentId, { requireWritable: true }),
    parseUpload,
    asyncHandler(async (req, res) => {
      if (!req.file?.buffer) throw new HttpError(400, "file is required");
      const body = uploadBody.parse(req.body);
      const validated = validateEvidenceUpload({
        bytes: req.file.buffer,
        originalName: req.file.originalname,
        declaredMimeType: req.file.mimetype,
        maxBytes: config.evidenceMaxFileSizeBytes,
      });
      const result = await service.upload({
        ...body,
        sessionId: incidentId(req),
        ...validated,
        bytes: req.file.buffer,
      }, actor(req));
      res.status(result.replayed ? 200 : 201).json(result);
    }),
  );

  router.get("/sessions/:sessionId/evidence/:evidenceId", requireIncidentPermission("evidence:read", incidentId), asyncHandler(async (req, res) => {
    res.json(await service.get(incidentId(req), evidenceId(req)));
  }));

  router.get("/sessions/:sessionId/evidence/:evidenceId/download", requireIncidentPermission("evidence:read", incidentId), asyncHandler(async (req, res) => {
    const result = await service.download(incidentId(req), evidenceId(req), actor(req));
    res.setHeader("Content-Type", String(result.record.mimeType));
    res.setHeader("Content-Length", String(result.bytes.length));
    res.setHeader("Content-Disposition", evidenceContentDisposition(String(result.record.fileName)));
    res.setHeader("X-Content-SHA256", String(result.record.contentSha256));
    res.setHeader("Cache-Control", "no-store, no-transform");
    res.send(result.bytes);
  }));

  router.post("/sessions/:sessionId/evidence/:evidenceId/withdraw", requireIncidentPermission("evidence:withdraw", incidentId, { requireWritable: true }), asyncHandler(async (req, res) => {
    const body = withdrawBody.parse(req.body);
    res.json(await service.withdraw({ ...body, sessionId: incidentId(req), evidenceId: evidenceId(req) }, actor(req)));
  }));

  return router;
}
