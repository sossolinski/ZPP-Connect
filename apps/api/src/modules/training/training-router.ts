import { Router, type Request } from "express";
import { z } from "zod";
import { asyncHandler } from "../../errors.js";
import { requireAnyPermission, requirePermission } from "../../rbac.js";
import type { TrainingService } from "./training-service.js";
import type { AssignTrainingResult, MemberTrainingRecord, TrainingActor } from "./training-types.js";

const id = z.string().trim().min(1).max(100);
const operationId = z.string().uuid();
const expectedVersion = z.coerce.number().int().min(1);
const nullableText = (max: number) => z.preprocess((value) => value === "" ? null : value, z.string().trim().max(max).optional().nullable());
const nullableId = z.preprocess((value) => value === "" ? null : value, id.optional().nullable());
const optionalDate = z.preprocess((value) => value === "" || value === null || value === undefined ? null : value, z.coerce.date().nullable());
const queryBoolean = z.preprocess((value) => value === "true" ? true : value === "false" ? false : value, z.boolean().optional());
const deliveryType = z.enum(["Classroom", "E-learning", "Briefing", "Exercise", "Practical", "Other"]);
const targetType = z.enum(["Role", "Group", "MemberProfile"]);
const requiredStatus = z.enum(["Required", "Recommended"]);
const recordStatus = z.enum(["Assigned", "In Progress", "Completed", "Expired", "Waived", "Cancelled"]);

const page = { limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) };
const courseQuery = z.object({ search: z.string().trim().max(200).optional(), q: z.string().trim().max(200).optional(), category: z.string().trim().max(200).optional(), active: queryBoolean, ...page }).transform(({ q, ...query }) => ({ ...query, search: query.search ?? q }));
const requirementQuery = z.object({ search: z.string().trim().max(200).optional(), q: z.string().trim().max(200).optional(), courseId: id.optional(), targetType: targetType.optional(), target: id.optional(), active: queryBoolean, requiredStatus: requiredStatus.optional(), ...page }).transform(({ q, ...query }) => ({ ...query, search: query.search ?? q }));
const recordQuery = z.object({ search: z.string().trim().max(200).optional(), q: z.string().trim().max(200).optional(), memberProfileId: id.optional(), groupId: id.optional(), courseId: id.optional(), category: z.string().trim().max(200).optional(), status: recordStatus.optional(), overdue: queryBoolean, expiringWithin: z.coerce.number().int().min(0).max(3650).optional(), mine: queryBoolean, sort: z.enum(["due", "member", "course", "status", "updatedAt"]).default("due"), direction: z.enum(["asc", "desc"]).default("asc"), ...page }).transform(({ q, ...query }) => ({ ...query, search: query.search ?? q }));

const createCourse = z.object({ code: z.string().trim().min(1).max(100), title: z.string().trim().min(1).max(500), description: nullableText(5_000), category: z.string().trim().min(1).max(200).default("Core"), deliveryType: deliveryType.default("Briefing"), validityMonths: z.preprocess((value) => value === "" || value === null || value === undefined ? null : value, z.coerce.number().int().min(1).max(120).nullable()), selfCompletable: z.boolean().default(false), externalRef: nullableText(500) }).strict();
const updateCourse = createCourse.partial().extend({ expectedVersion }).strict();
const lifecycle = z.object({ expectedVersion }).strict();

const requirementFields = z.object({ courseId: id, targetType, targetRole: nullableText(200), groupId: nullableId, memberProfileId: nullableId, requiredStatus: requiredStatus.default("Required"), dueAt: optionalDate, effectiveFrom: optionalDate }).superRefine((value, context) => {
  const targetCount = [value.targetRole, value.groupId, value.memberProfileId].filter(Boolean).length;
  if (targetCount !== 1 || (value.targetType === "Role" && !value.targetRole) || (value.targetType === "Group" && !value.groupId) || (value.targetType === "MemberProfile" && !value.memberProfileId)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Choose exactly one target matching targetType" });
});
const createRequirement = requirementFields;
const updateRequirement = z.object({ courseId: id.optional(), targetType: targetType.optional(), targetRole: nullableText(200), groupId: nullableId, memberProfileId: nullableId, requiredStatus: requiredStatus.optional(), dueAt: optionalDate, effectiveFrom: optionalDate, expectedVersion }).strict();
const endRequirement = z.object({ expectedVersion, effectiveTo: optionalDate }).strict();

const assign = z.object({ memberProfileId: nullableId, groupId: nullableId, courseId: id, sourceRequirementId: nullableId, assignedAt: optionalDate, dueAt: optionalDate, operationId }).strict().superRefine((value, context) => { if (Boolean(value.memberProfileId) === Boolean(value.groupId)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Choose exactly one training target" }); });
const updateRecord = z.object({ expectedVersion, dueAt: optionalDate, completionNote: nullableText(5_000) }).strict();
const baseCommand = z.object({ expectedVersion, operationId }).strict();
const completeCommand = z.object({ expectedVersion, operationId, completedAt: z.coerce.date(), score: z.preprocess((value) => value === "" || value === null || value === undefined ? null : value, z.coerce.number().int().min(0).max(100).nullable()), completionNote: nullableText(5_000), completionRef: nullableText(500) }).strict();
const verifyCommand = z.object({ expectedVersion, operationId, verifiedAt: optionalDate }).strict();
const reasonCommand = z.object({ expectedVersion, operationId, reason: z.string().trim().min(3).max(5_000) }).strict();

function actor(req: Request): TrainingActor {
  if (!req.user) throw new Error("Authenticated actor is required");
  return { id: req.user.id, email: req.user.email, displayName: req.user.displayName, roles: req.user.roles, permissions: req.user.permissions, roleAssignments: req.user.roleAssignments, requestId: req.requestId };
}

export function createTrainingRouter(service: TrainingService, compatibility: { onAssigned?: (record: MemberTrainingRecord) => void } = {}) {
  const router = Router();
  const notifyAssigned = (result: AssignTrainingResult) => {
    try {
      if ("records" in result) result.records.forEach((record) => compatibility.onAssigned?.(record));
      else compatibility.onAssigned?.(result);
    } catch { /* best effort only */ }
  };

  router.get("/training/courses", requireAnyPermission(["training:read-all", "training:read-own"]), asyncHandler(async (req, res) => res.json(await service.listCourses(actor(req), courseQuery.parse(req.query)))));
  router.get("/training/courses/:id", requireAnyPermission(["training:read-all", "training:read-own"]), asyncHandler(async (req, res) => res.json(await service.getCourse(actor(req), id.parse(req.params.id)))));
  router.post("/training/courses", requirePermission("training:course:manage"), asyncHandler(async (req, res) => res.status(201).json(await service.createCourse(actor(req), createCourse.parse(req.body)))));
  router.patch("/training/courses/:id", requirePermission("training:course:manage"), asyncHandler(async (req, res) => { const { expectedVersion, ...input } = updateCourse.parse(req.body); res.json(await service.updateCourse(actor(req), id.parse(req.params.id), input, expectedVersion)); }));
  router.post("/training/courses/:id/deactivate", requirePermission("training:course:manage"), asyncHandler(async (req, res) => res.json(await service.setCourseActive(actor(req), id.parse(req.params.id), false, lifecycle.parse(req.body).expectedVersion))));
  router.post("/training/courses/:id/reactivate", requirePermission("training:course:manage"), asyncHandler(async (req, res) => res.json(await service.setCourseActive(actor(req), id.parse(req.params.id), true, lifecycle.parse(req.body).expectedVersion))));

  router.get("/training/requirements", requireAnyPermission(["training:read-all", "training:requirement:manage"]), asyncHandler(async (req, res) => res.json(await service.listRequirements(actor(req), requirementQuery.parse(req.query)))));
  router.get("/training/requirements/:id", requireAnyPermission(["training:read-all", "training:requirement:manage"]), asyncHandler(async (req, res) => res.json(await service.getRequirement(actor(req), id.parse(req.params.id)))));
  router.post("/training/requirements", requirePermission("training:requirement:manage"), asyncHandler(async (req, res) => res.status(201).json(await service.createRequirement(actor(req), createRequirement.parse(req.body)))));
  router.patch("/training/requirements/:id", requirePermission("training:requirement:manage"), asyncHandler(async (req, res) => { const { expectedVersion, ...input } = updateRequirement.parse(req.body); res.json(await service.updateRequirement(actor(req), id.parse(req.params.id), input, expectedVersion)); }));
  router.post("/training/requirements/:id/end", requirePermission("training:requirement:manage"), asyncHandler(async (req, res) => { const input = endRequirement.parse(req.body); res.json(await service.endRequirement(actor(req), id.parse(req.params.id), input.expectedVersion, input.effectiveTo ?? undefined)); }));

  router.get("/training/records", requireAnyPermission(["training:read-all", "training:read-own"]), asyncHandler(async (req, res) => res.json(await service.listRecords(actor(req), recordQuery.parse(req.query)))));
  router.get("/training/records/:id", requireAnyPermission(["training:read-all", "training:read-own"]), asyncHandler(async (req, res) => res.json(await service.getRecord(actor(req), id.parse(req.params.id)))));
  router.post("/training/records/assign", requirePermission("training:assign"), asyncHandler(async (req, res) => { const result = await service.assign(actor(req), assign.parse(req.body)); if (!(result as any).idempotent) notifyAssigned(result); res.status((result as any).idempotent ? 200 : 201).json(result); }));
  router.patch("/training/records/:id", requireAnyPermission(["training:assign", "training:complete-all"]), asyncHandler(async (req, res) => { const { expectedVersion, ...input } = updateRecord.parse(req.body); res.json(await service.updateRecord(actor(req), id.parse(req.params.id), input, expectedVersion)); }));
  router.post("/training/records/:id/start", requireAnyPermission(["training:complete-own", "training:complete-all"]), asyncHandler(async (req, res) => res.json(await service.command(actor(req), id.parse(req.params.id), "start", baseCommand.parse(req.body)))));
  router.post("/training/records/:id/complete", requireAnyPermission(["training:complete-own", "training:complete-all"]), asyncHandler(async (req, res) => res.json(await service.command(actor(req), id.parse(req.params.id), "complete", completeCommand.parse(req.body)))));
  router.post("/training/records/:id/verify", requirePermission("training:verify"), asyncHandler(async (req, res) => { const { verifiedAt, ...input } = verifyCommand.parse(req.body); res.json(await service.command(actor(req), id.parse(req.params.id), "verify", { ...input, verifiedAt: verifiedAt ?? undefined })); }));
  router.post("/training/records/:id/waive", requirePermission("training:waive"), asyncHandler(async (req, res) => res.json(await service.command(actor(req), id.parse(req.params.id), "waive", reasonCommand.parse(req.body)))));
  router.post("/training/records/:id/cancel", requirePermission("training:assign"), asyncHandler(async (req, res) => res.json(await service.command(actor(req), id.parse(req.params.id), "cancel", reasonCommand.parse(req.body)))));
  return router;
}
