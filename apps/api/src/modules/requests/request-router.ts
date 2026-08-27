import { dictionaries } from "@zpp/shared";
import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";
import { asyncHandler, HttpError } from "../../errors.js";
import { requirePermission } from "../../rbac.js";
import type { IncidentPermissionGate } from "../incident-access/incident-permission-gate.js";
import type { RequestService } from "./request-service.js";
import {
  toRequestCompatibility,
  type RequestActor,
  type RequestCompatibilityRecord,
} from "./request-types.js";

const id = z.string().trim().min(1).max(100);
const operationId = z.string().uuid();
const note = z.string().trim().min(3).max(5_000);
const nullableText = (max: number) =>
  z.preprocess(
    (value) => (value === "" ? null : value),
    z.string().trim().max(max).optional().nullable(),
  );
const nullableId = z.preprocess(
  (value) => (value === "" ? null : value),
  id.optional().nullable(),
);
const nullableDate = z.preprocess(
  (value) => (value === "" ? null : value),
  z.coerce.date().optional().nullable(),
);
const priority = z.enum(dictionaries.requestPriorities);
const status = z.enum([
  "OPEN",
  "ASSIGNED",
  "IN_PROGRESS",
  "WAITING",
  "RESOLVED",
  "CANCELLED",
]);
const scope = z.object({ sessionId: id }).strict();
const queue = scope.extend({
  search: z.string().trim().max(200).optional(),
  status: status.optional(),
  priority: priority.optional(),
  ownerUserId: id.optional(),
  category: z.string().trim().min(1).max(200).optional(),
  due: z.enum(["overdue", "due", "none"]).optional(),
  sortBy: z
    .enum([
      "updatedAt",
      "operationalId",
      "priority",
      "status",
      "owner",
      "dueAt",
      "category",
    ])
    .default("updatedAt"),
  sortDirection: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const create = z
  .object({
    sessionId: id,
    category: z.string().trim().min(1).max(200),
    priority: priority.default("Normal"),
    requester: nullableText(300),
    details: z.string().trim().min(1).max(5_000),
    approvalStatus: z
      .enum(dictionaries.approvalStatuses)
      .default("Not required"),
    notes: nullableText(5_000),
    dueAt: nullableDate,
    caseId: nullableText(100),
    relatedEnquiryId: nullableId,
    relatedFamilyRecordId: nullableId,
    relatedPassengerRecordId: nullableId,
    relatedReleaseActionId: nullableId,
    operationId,
  })
  .strict();
const update = z
  .object({
    sessionId: id,
    expectedVersion: z.coerce.number().int().min(1),
    details: z.string().trim().min(1).max(5_000).optional(),
    requester: nullableText(300),
    notes: nullableText(5_000),
    dueAt: nullableDate,
  })
  .strict();
const version = z
  .object({ sessionId: id, expectedVersion: z.coerce.number().int().min(1) })
  .strict();
const reason = version.extend({ reason: note });
const retryableReason = reason.extend({ operationId });
const assign = version.extend({
  ownerUserId: z.string().uuid(),
  reason: z.string().trim().min(3).max(2_000).optional(),
});
const priorityChange = version.extend({
  priority,
  reason: z.string().trim().min(3).max(2_000).optional(),
});
const resolve = version.extend({
  outcome: z.string().trim().min(1).max(200),
  resolutionNote: note,
  operationId,
});

function actor(req: Request): RequestActor {
  if (!req.user) throw new Error("Authenticated actor is required");
  return {
    id: req.user.id,
    email: req.user.email,
    displayName: req.user.displayName,
    roles: req.user.roles,
    permissions: req.incidentPermissions ?? req.user.permissions,
    requestId: req.requestId,
  };
}

export function createRequestRouter(
  service: RequestService,
  compatibility: {
    onList?: (
      records: RequestCompatibilityRecord[],
      incidentId: string,
      offset: number,
    ) => void;
    onChange?: (record: RequestCompatibilityRecord) => void;
    requireIncidentPermission?: IncidentPermissionGate;
    validateCategory?: (value: string) => Promise<void>;
  } = {},
) {
  const router = Router();
  const validateCategory = async (value: string) => {
    if (compatibility.validateCategory) {
      await compatibility.validateCategory(value);
      return;
    }
    if (!(dictionaries.requestCategories as readonly string[]).includes(value)) {
      throw new HttpError(400, `'${value}' is not an active requestCategories value.`);
    }
  };
  const authorize = (permission: Parameters<typeof requirePermission>[0], source: "query" | "body", writable = false): RequestHandler => compatibility.requireIncidentPermission
    ? compatibility.requireIncidentPermission(permission, (req) => String(source === "query" ? req.query.sessionId ?? "" : req.body?.sessionId ?? ""), { requireWritable: writable })
    : requirePermission(permission);
  router.get(
    "/requests/assignees",
    authorize("request:assign", "query"),
    asyncHandler(async (req, res) => {
      const query = z
        .object({
          sessionId: id,
          search: z.string().trim().max(200).optional(),
        })
        .parse(req.query);
      res.json({
        data: await service.listAssignees(
          actor(req),
          query.sessionId,
          query.search,
        ),
      });
    }),
  );
  router.get(
    "/requests/queue",
    authorize("request:read", "query"),
    asyncHandler(async (req, res) => {
      const query = queue.parse(req.query);
      res.json(await service.listQueue(actor(req), query.sessionId, query));
    }),
  );
  router.get(
    "/requests/:id",
    authorize("request:read", "query"),
    asyncHandler(async (req, res) => {
      res.json(
        await service.getContext(
          actor(req),
          id.parse(req.query.sessionId),
          id.parse(req.params.id),
        ),
      );
    }),
  );
  router.get(
    "/requests",
    authorize("request:read", "query"),
    asyncHandler(async (req, res) => {
      const query = queue.parse(req.query);
      const result = await service.listCompatibility(
        actor(req),
        query.sessionId,
        query,
      );
      compatibility.onList?.(result.data, query.sessionId, query.offset);
      res.json({ ...result, deprecated: true, readOnly: true });
    }),
  );
  router.post(
    "/requests",
    authorize("request:create", "body", true),
    asyncHandler(async (req, res) => {
      const { sessionId, ...input } = create.parse(req.body);
      await validateCategory(input.category);
      const record = await service.create(actor(req), sessionId, input);
      compatibility.onChange?.(toRequestCompatibility(record));
      res.status(201).json(record);
    }),
  );
  router.patch(
    "/requests/:id",
    authorize("request:update", "body", true),
    asyncHandler(async (req, res) => {
      const { sessionId, expectedVersion, ...input } = update.parse(req.body);
      const record = await service.update(
        actor(req),
        sessionId,
        id.parse(req.params.id),
        input,
        expectedVersion,
      );
      compatibility.onChange?.(toRequestCompatibility(record));
      res.json(record);
    }),
  );
  router.post(
    "/requests/:id/assign",
    authorize("request:assign", "body", true),
    asyncHandler(async (req, res) => {
      const { sessionId, ...input } = assign.parse(req.body);
      const record = await service.assign(
        actor(req),
        sessionId,
        id.parse(req.params.id),
        input,
      );
      compatibility.onChange?.(toRequestCompatibility(record));
      res.json(record);
    }),
  );
  router.post(
    "/requests/:id/unassign",
    authorize("request:assign", "body", true),
    asyncHandler(async (req, res) => {
      const { sessionId, ...input } = reason.parse(req.body);
      const record = await service.unassign(
        actor(req),
        sessionId,
        id.parse(req.params.id),
        input,
      );
      compatibility.onChange?.(toRequestCompatibility(record));
      res.json(record);
    }),
  );
  router.post(
    "/requests/:id/priority",
    authorize("request:update", "body", true),
    asyncHandler(async (req, res) => {
      const { sessionId, ...input } = priorityChange.parse(req.body);
      const record = await service.changePriority(
        actor(req),
        sessionId,
        id.parse(req.params.id),
        input,
      );
      compatibility.onChange?.(toRequestCompatibility(record));
      res.json(record);
    }),
  );
  for (const [path, next] of [
    ["start", "IN_PROGRESS"],
    ["wait", "WAITING"],
  ] as const) {
    router.post(
      `/requests/:id/${path}`,
      authorize("request:update", "body", true),
      asyncHandler(async (req, res) => {
        const { sessionId, ...input } = version.parse(req.body);
        const record = await service.transition(
          actor(req),
          sessionId,
          id.parse(req.params.id),
          next,
          input,
        );
        compatibility.onChange?.(toRequestCompatibility(record));
        res.json(record);
      }),
    );
  }
  router.post(
    "/requests/:id/resolve",
    authorize("request:close", "body", true),
    asyncHandler(async (req, res) => {
      const { sessionId, ...input } = resolve.parse(req.body);
      const record = await service.resolve(
        actor(req),
        sessionId,
        id.parse(req.params.id),
        input,
      );
      compatibility.onChange?.(toRequestCompatibility(record));
      res.json(record);
    }),
  );
  router.post(
    "/requests/:id/reopen",
    authorize("request:close", "body", true),
    asyncHandler(async (req, res) => {
      const { sessionId, ...input } = retryableReason.parse(req.body);
      const record = await service.reopen(
        actor(req),
        sessionId,
        id.parse(req.params.id),
        input,
      );
      compatibility.onChange?.(toRequestCompatibility(record));
      res.json(record);
    }),
  );
  router.post(
    "/requests/:id/cancel",
    authorize("request:close", "body", true),
    asyncHandler(async (req, res) => {
      const { sessionId, ...input } = retryableReason.parse(req.body);
      const record = await service.cancel(
        actor(req),
        sessionId,
        id.parse(req.params.id),
        input,
      );
      compatibility.onChange?.(toRequestCompatibility(record));
      res.json(record);
    }),
  );
  return router;
}
