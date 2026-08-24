import { createHash } from "node:crypto";
import path from "node:path";
import type { Request, RequestHandler } from "express";
import { Router } from "express";
import multer from "multer";
import type { Permission } from "@zpp/shared";
import { asyncHandler, HttpError } from "../../errors.js";
import { parseWorkbook } from "../../exporters.js";
import type { IncidentPermissionGate } from "../incident-access/incident-permission-gate.js";
import type { FoundationImportType, ImportAuthorizationContext, ImportValidationStatus } from "./import-types.js";
import type { PrismaImportService } from "./prisma-import-service.js";

const supportedTypes = new Set<FoundationImportType>(["manifest", "family"]);
const supportedMimeTypes = new Set(["text/csv", "application/csv", "application/vnd.ms-excel"]);
const operationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: 20 * 1024 * 1024, fields: 8, fieldSize: 16 * 1024 }
});

const parseUpload: RequestHandler = (req, res, next) => {
  upload.single("file")(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      return next(new HttpError(400, "Import CSV must not exceed 20 MB"));
    }
    return next(new HttpError(400, "Unable to parse the import upload"));
  });
};

function importType(req: Request): FoundationImportType {
  const value = String(req.params.type);
  if (!supportedTypes.has(value as FoundationImportType)) throw new HttpError(400, "Only manifest and family CSV imports are supported");
  return value as FoundationImportType;
}

function permissionsForType(type: FoundationImportType): Permission[] {
  return ["import:create", type === "manifest" ? "passenger:create" : "family:create"];
}

function requestActor(req: Request) {
  if (!req.user) throw new HttpError(401, "Authentication required");
  return {
    id: req.user.id,
    email: req.user.email,
    displayName: req.user.displayName,
    roles: req.user.roles,
    requestId: req.requestId
  };
}

function pageQuery(req: Request) {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
  return { limit, offset };
}

function availableTypes(req: Request) {
  const effective = req.incidentPermissions ?? [];
  const types: FoundationImportType[] = [];
  if (effective.includes("passenger:create")) types.push("manifest");
  if (effective.includes("family:create")) types.push("family");
  return types;
}

function cleanFilename(value: string) {
  return path.basename(value).replace(/[\u0000-\u001f\u007f]/g, "_").slice(0, 255) || "import.csv";
}

function assertParsableCsv(buffer: Buffer) {
  const text = buffer.toString("utf8");
  if (!buffer.length || text.includes("\0") || text.includes("\uFFFD")) throw new HttpError(400, "Import file is not a readable UTF-8 CSV");
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '"') continue;
    if (quoted && text[index + 1] === '"') index += 1;
    else quoted = !quoted;
  }
  if (quoted) throw new HttpError(400, "Import CSV contains an unterminated quoted field");
}

export function createImportRouter(service: PrismaImportService, requireIncidentPermission: IncidentPermissionGate) {
  const router = Router();
  const contexts = new WeakMap<Request, ImportAuthorizationContext>();

  const requireValidType: RequestHandler = (req, _res, next) => {
    try {
      importType(req);
      next();
    } catch (error) {
      next(error);
    }
  };

  const loadContext = asyncHandler(async (req, _res, next) => {
    const context = await service.authorizationContext(String(req.params.id));
    contexts.set(req, context);
    next();
  });
  const contextFor = (req: Request) => {
    const context = contexts.get(req);
    if (!context) throw new HttpError(404, "Import batch not found");
    return context;
  };
  const batchGate = (writable: boolean) => requireIncidentPermission(
    (req) => permissionsForType(contextFor(req).importType),
    (req) => contextFor(req).incidentId,
    { requireWritable: writable }
  );

  router.post(
    "/imports/:type",
    requireValidType,
    parseUpload,
    requireIncidentPermission(
      (req) => permissionsForType(importType(req)),
      (req) => String(req.body?.sessionId ?? ""),
      { requireWritable: true }
    ),
    asyncHandler(async (req, res) => {
      const type = importType(req);
      const operationId = String(req.body?.operationId ?? "").trim();
      if (!operationIdPattern.test(operationId)) throw new HttpError(400, "operationId must be a UUID");
      if (!req.file?.buffer) throw new HttpError(400, "file is required");
      const sourceFilename = cleanFilename(req.file.originalname);
      const mimeType = req.file.mimetype.toLowerCase().split(";", 1)[0]!;
      if (!sourceFilename.toLowerCase().endsWith(".csv") || !supportedMimeTypes.has(mimeType)) {
        throw new HttpError(400, "Import requires a CSV file");
      }
      assertParsableCsv(req.file.buffer);
      let rows: Array<Record<string, unknown>>;
      try {
        rows = parseWorkbook(req.file.buffer, sourceFilename);
      } catch {
        throw new HttpError(400, "Unable to parse the import CSV");
      }
      if (rows.length === 0) throw new HttpError(400, "Import CSV must contain a header and at least one data row");
      const sourceSha256 = createHash("sha256").update(req.file.buffer).digest("hex");
      const result = await service.validate({
        operationId,
        incidentId: String(req.body.sessionId),
        importType: type,
        sourceFilename,
        sourceMimeType: mimeType,
        sourceSizeBytes: req.file.size,
        sourceSha256,
        rows
      }, requestActor(req));
      res.status(result.replayed ? 200 : 201).json(result);
    })
  );

  router.get("/imports/:id/rows", loadContext, batchGate(false), asyncHandler(async (req, res) => {
    const statusValue = req.query.validationStatus ? String(req.query.validationStatus).toUpperCase() : undefined;
    if (statusValue && !["VALID", "INVALID"].includes(statusValue)) throw new HttpError(400, "validationStatus must be VALID or INVALID");
    res.json(await service.rows(contextFor(req).id, { ...pageQuery(req), validationStatus: statusValue as ImportValidationStatus | undefined }));
  }));

  router.get("/imports/:id", loadContext, batchGate(false), asyncHandler(async (req, res) => {
    res.json(await service.get(contextFor(req).id));
  }));

  router.post("/imports/:id/confirm", loadContext, batchGate(true), asyncHandler(async (req, res) => {
    res.json(await service.confirm(contextFor(req).id, requestActor(req)));
  }));

  const listGate = (resolveIncidentId: (req: Request) => string) => requireIncidentPermission("import:create", resolveIncidentId);
  const listResponse = async (req: Request, incidentId: string) => service.list(incidentId, { ...pageQuery(req), importTypes: availableTypes(req) });

  router.get("/sessions/:sessionId/imports", listGate((req) => String(req.params.sessionId)), asyncHandler(async (req, res) => {
    res.json(await listResponse(req, String(req.params.sessionId)));
  }));

  router.get("/files", listGate((req) => String(req.query.sessionId ?? "")), asyncHandler(async (req, res) => {
    const incidentId = String(req.query.sessionId ?? "");
    res.json(await service.filesProjection(incidentId, { ...pageQuery(req), importTypes: availableTypes(req) }));
  }));

  return router;
}
