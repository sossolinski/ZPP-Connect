import { Router, type Request } from "express";
import { z } from "zod";
import { asyncHandler } from "../../errors.js";
import { requireAnyPermission, requirePermission } from "../../rbac.js";
import type { DocumentService } from "./document-service.js";
import type { DocumentActor, DocumentVersionRecord } from "./document-types.js";

const id = z.string().trim().min(1).max(100);
const operationId = z.string().uuid();
const expectedVersion = z.coerce.number().int().min(1);
const nullableText = (max: number) => z.preprocess((value) => value === "" ? null : value, z.string().trim().max(max).optional().nullable());
const nullableId = z.preprocess((value) => value === "" ? null : value, id.optional().nullable());
const optionalDate = z.preprocess((value) => value === "" || value === null || value === undefined ? null : value, z.coerce.date().nullable());
const patchDate = z.preprocess((value) => value === "" || value === null ? null : value, z.coerce.date().nullable().optional());
const queryBoolean = z.preprocess((value) => value === "true" ? true : value === "false" ? false : value, z.boolean().optional());
const page = { limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) };
const versionStatus = z.enum(["Draft", "Published", "Superseded", "Withdrawn"]);
const contentMode = z.enum(["Internal text", "External link"]);
const targetType = z.enum(["Role", "Group", "MemberProfile"]);

const documentQuery = z.object({ search: z.string().trim().max(200).optional(), q: z.string().trim().max(200).optional(), active: queryBoolean, category: z.string().trim().max(200).optional(), ownerFunction: z.string().trim().max(200).optional(), mine: queryBoolean, status: z.string().trim().max(50).optional(), overdue: queryBoolean, sort: z.enum(["title", "code", "updatedAt"]).default("title"), direction: z.enum(["asc", "desc"]).default("asc"), ...page }).transform(({ q, ...query }) => ({ ...query, search: query.search ?? q }));
const versionQuery = z.object({ status: versionStatus.optional(), sort: z.enum(["createdAt", "versionLabel", "status"]).default("createdAt"), direction: z.enum(["asc", "desc"]).default("desc"), ...page });
const requirementQuery = z.object({ search: z.string().trim().max(200).optional(), q: z.string().trim().max(200).optional(), documentId: id.optional(), documentVersionId: id.optional(), targetType: targetType.optional(), active: queryBoolean, effective: queryBoolean, sort: z.enum(["document", "target", "dueAt", "updatedAt"]).default("document"), direction: z.enum(["asc", "desc"]).default("asc"), ...page }).transform(({ q, ...query }) => ({ ...query, search: query.search ?? q }));
const acknowledgementQuery = z.object({ memberProfileId: id.optional(), documentId: id.optional(), documentVersionId: id.optional(), dateFrom: optionalDate, dateTo: optionalDate, onBehalf: queryBoolean, sort: z.enum(["acknowledgedAt", "document", "member"]).default("acknowledgedAt"), direction: z.enum(["asc", "desc"]).default("desc"), ...page });

const createDocument = z.object({ code: z.string().trim().min(1).max(100), title: z.string().trim().min(1).max(500), description: nullableText(5_000), category: z.string().trim().min(1).max(200).default("Operational"), ownerFunction: z.string().trim().min(1).max(200).default("ZPP") }).strict();
const updateDocument = createDocument.partial().extend({ expectedVersion }).strict();
const lifecycle = z.object({ expectedVersion }).strict();

const versionFields = z.object({ versionLabel: z.string().trim().min(1).max(100), titleOverride: nullableText(500), changeSummary: nullableText(5_000), effectiveFrom: optionalDate, reviewDueAt: optionalDate, contentMode, contentBody: nullableText(100_000), externalUrl: nullableText(2_000) }).superRefine((value, context) => {
  if (value.contentMode === "Internal text" && value.externalUrl) context.addIssue({ code: z.ZodIssueCode.custom, message: "Internal text cannot include an external URL" });
  if (value.contentMode === "External link" && value.contentBody) context.addIssue({ code: z.ZodIssueCode.custom, message: "External links cannot include internal text" });
});
const createVersion = versionFields;
const updateVersion = z.object({ versionLabel: z.string().trim().min(1).max(100).optional(), titleOverride: nullableText(500), changeSummary: nullableText(5_000), effectiveFrom: patchDate, reviewDueAt: patchDate, contentMode: contentMode.optional(), contentBody: nullableText(100_000), externalUrl: nullableText(2_000), expectedVersion }).strict();
const publishVersion = z.object({ expectedVersion, operationId, expectedCurrentPublishedVersionId: nullableId }).strict();
const withdrawVersion = z.object({ expectedVersion, operationId, reason: nullableText(5_000) }).strict();

const requirementFields = z.object({ documentVersionId: id, targetType, targetRole: nullableText(200), groupId: nullableId, memberProfileId: nullableId, acknowledgementRequired: z.boolean().default(true), effectiveFrom: optionalDate, dueAt: optionalDate }).superRefine((value, context) => {
  const targetCount = [value.targetRole, value.groupId, value.memberProfileId].filter(Boolean).length;
  if (targetCount !== 1 || (value.targetType === "Role" && !value.targetRole) || (value.targetType === "Group" && !value.groupId) || (value.targetType === "MemberProfile" && !value.memberProfileId)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Choose exactly one target matching targetType" });
});
const createRequirement = requirementFields;
const updateRequirement = z.object({ documentVersionId: id.optional(), targetType: targetType.optional(), targetRole: nullableText(200), groupId: nullableId, memberProfileId: nullableId, acknowledgementRequired: z.boolean().optional(), effectiveFrom: patchDate, dueAt: patchDate, expectedVersion }).strict();
const endRequirement = z.object({ expectedVersion, operationId, effectiveTo: optionalDate }).strict();
const acknowledge = z.object({ operationId, memberProfileId: nullableId, onBehalf: z.boolean().optional(), note: nullableText(5_000) }).strict();

function actor(req: Request): DocumentActor {
  if (!req.user) throw new Error("Authenticated actor is required");
  return { id: req.user.id, email: req.user.email, displayName: req.user.displayName, roles: req.user.roles, permissions: req.user.permissions, roleAssignments: req.user.roleAssignments, requestId: req.requestId };
}

export function createDocumentRouter(service: DocumentService, compatibility: { onPublished?: (record: DocumentVersionRecord) => void } = {}) {
  const router = Router();
  const notifyPublished = (record: DocumentVersionRecord) => { try { compatibility.onPublished?.(record); } catch { /* best effort post-commit */ } };

  router.get("/documents", requireAnyPermission(["document:read-own", "document:read-all"]), asyncHandler(async (req, res) => res.json(await service.listDocuments(actor(req), documentQuery.parse(req.query)))));
  router.get("/documents/:id", requireAnyPermission(["document:read-own", "document:read-all"]), asyncHandler(async (req, res) => res.json(await service.getDocument(actor(req), id.parse(req.params.id)))));
  router.post("/documents", requirePermission("document:manage"), asyncHandler(async (req, res) => res.status(201).json(await service.createDocument(actor(req), createDocument.parse(req.body)))));
  router.patch("/documents/:id", requirePermission("document:manage"), asyncHandler(async (req, res) => { const { expectedVersion, ...input } = updateDocument.parse(req.body); res.json(await service.updateDocument(actor(req), id.parse(req.params.id), input, expectedVersion)); }));
  router.post("/documents/:id/archive", requirePermission("document:manage"), asyncHandler(async (req, res) => res.json(await service.setDocumentActive(actor(req), id.parse(req.params.id), false, lifecycle.parse(req.body).expectedVersion))));
  router.post("/documents/:id/reactivate", requirePermission("document:manage"), asyncHandler(async (req, res) => res.json(await service.setDocumentActive(actor(req), id.parse(req.params.id), true, lifecycle.parse(req.body).expectedVersion))));

  router.get("/documents/:id/versions", requireAnyPermission(["document:read-own", "document:read-all"]), asyncHandler(async (req, res) => res.json(await service.listVersions(actor(req), id.parse(req.params.id), versionQuery.parse(req.query)))));
  router.post("/documents/:id/versions", requirePermission("document:version:manage"), asyncHandler(async (req, res) => res.status(201).json(await service.createVersion(actor(req), id.parse(req.params.id), createVersion.parse(req.body)))));
  router.get("/document-versions/:id", requireAnyPermission(["document:read-own", "document:read-all"]), asyncHandler(async (req, res) => res.json(await service.getVersion(actor(req), id.parse(req.params.id)))));
  router.patch("/document-versions/:id", requirePermission("document:version:manage"), asyncHandler(async (req, res) => { const { expectedVersion, ...input } = updateVersion.parse(req.body); res.json(await service.updateVersion(actor(req), id.parse(req.params.id), input, expectedVersion)); }));
  router.post("/document-versions/:id/publish", requirePermission("document:publish"), asyncHandler(async (req, res) => { const record = await service.publishVersion(actor(req), id.parse(req.params.id), publishVersion.parse(req.body)); if (!(record as any).idempotent) notifyPublished(record); res.status((record as any).idempotent ? 200 : 200).json(record); }));
  router.post("/document-versions/:id/withdraw", requirePermission("document:publish"), asyncHandler(async (req, res) => res.json(await service.withdrawVersion(actor(req), id.parse(req.params.id), withdrawVersion.parse(req.body)))));
  router.get("/document-versions/:id/content", requireAnyPermission(["document:read-own", "document:read-all"]), asyncHandler(async (req, res) => res.json(await service.getVersion(actor(req), id.parse(req.params.id), true))));
  router.post("/document-versions/:id/acknowledge", requireAnyPermission(["document:acknowledge-own", "document:acknowledge-all"]), asyncHandler(async (req, res) => { const record = await service.acknowledgeVersion(actor(req), id.parse(req.params.id), acknowledge.parse(req.body)); res.status(record.duplicate || record.idempotent ? 200 : 201).json(record); }));

  router.get("/document-requirements", requireAnyPermission(["document:read-all", "document:requirement:manage"]), asyncHandler(async (req, res) => res.json(await service.listRequirements(actor(req), requirementQuery.parse(req.query)))));
  router.get("/document-requirements/:id", requireAnyPermission(["document:read-all", "document:requirement:manage"]), asyncHandler(async (req, res) => res.json(await service.getRequirement(actor(req), id.parse(req.params.id)))));
  router.post("/document-requirements", requirePermission("document:requirement:manage"), asyncHandler(async (req, res) => res.status(201).json(await service.createRequirement(actor(req), createRequirement.parse(req.body)))));
  router.patch("/document-requirements/:id", requirePermission("document:requirement:manage"), asyncHandler(async (req, res) => { const { expectedVersion, ...input } = updateRequirement.parse(req.body); res.json(await service.updateRequirement(actor(req), id.parse(req.params.id), input, expectedVersion)); }));
  router.post("/document-requirements/:id/end", requirePermission("document:requirement:manage"), asyncHandler(async (req, res) => res.json(await service.endRequirement(actor(req), id.parse(req.params.id), endRequirement.parse(req.body)))));
  router.get("/document-acknowledgements", requireAnyPermission(["document:read-own", "document:read-all", "document:acknowledge-all"]), asyncHandler(async (req, res) => res.json(await service.listAcknowledgements(actor(req), acknowledgementQuery.parse(req.query)))));

  return router;
}
