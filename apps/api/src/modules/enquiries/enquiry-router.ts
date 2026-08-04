import { Router, type Request } from "express";
import { dictionaries } from "@zpp/shared";
import { z } from "zod";
import { asyncHandler } from "../../errors.js";
import { requirePermission } from "../../rbac.js";
import type { EnquiryService } from "./enquiry-service.js";
import type { EnquiryActor, EnquiryRecord, EnquiryTransition } from "./enquiry-types.js";

const scopedId = z.string().trim().min(1).max(100);
const nullableText = (max: number) => z.preprocess(
  (value) => (value === "" ? null : value),
  z.string().trim().max(max).optional().nullable()
);

const enquiryFields = z.object({
  sessionId: scopedId,
  caseId: nullableText(100),
  contactChannel: z.string().trim().min(1).max(100),
  callerName: z.string().trim().min(1).max(200),
  callerPhone: nullableText(50),
  callerEmail: z.preprocess(
    (value) => (value === "" ? null : value),
    z.string().trim().email().max(320).optional().nullable()
  ),
  callerLocation: nullableText(200),
  preferredLanguage: nullableText(100),
  claimedRelationship: nullableText(100),
  passengerRecordId: z.preprocess((value) => (value === "" ? null : value), scopedId.optional().nullable()),
  passengerFirstName: nullableText(200),
  passengerLastName: nullableText(200),
  passengerFlight: nullableText(100),
  passengerRoute: nullableText(200),
  lastKnownContact: nullableText(2_000),
  enquiryType: z.string().trim().min(1).max(100),
  urgency: z.enum(dictionaries.enquiryUrgencies).default("Normal"),
  notes: nullableText(5_000),
  status: z.enum(dictionaries.enquiryStatuses).default("New")
});

const enquiryUpdate = enquiryFields.partial().extend({
  sessionId: scopedId,
  version: z.coerce.number().int().min(1)
});

const listQuery = z.object({
  sessionId: scopedId,
  status: z.enum(dictionaries.enquiryStatuses).optional(),
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

const actionBody = z.object({
  sessionId: scopedId,
  version: z.coerce.number().int().min(1),
  notes: z.string().trim().max(5_000).optional()
});

function actor(req: Request): EnquiryActor {
  if (!req.user) throw new Error("Authenticated actor is required");
  return {
    id: req.user.id,
    email: req.user.email,
    displayName: req.user.displayName,
    roles: req.user.roles,
    requestId: req.requestId
  };
}

export function createEnquiryRouter(
  service: EnquiryService,
  compatibility: { onList?: (records: EnquiryRecord[], incidentId: string, offset: number) => void; onChange?: (record: EnquiryRecord) => void } = {}
) {
  const router = Router();

  router.get("/enquiries", requirePermission("enquiry:read"), asyncHandler(async (req, res) => {
    const query = listQuery.parse(req.query);
    const result = await service.list(actor(req), query.sessionId, query);
    compatibility.onList?.(result.data, query.sessionId, query.offset);
    res.json(result);
  }));

  router.get("/enquiries/:id", requirePermission("enquiry:read"), asyncHandler(async (req, res) => {
    const enquiryId = scopedId.parse(req.params.id);
    const incidentId = scopedId.parse(req.query.sessionId);
    res.json(await service.get(actor(req), incidentId, enquiryId));
  }));

  router.post("/enquiries", requirePermission("enquiry:create"), asyncHandler(async (req, res) => {
    const record = await service.create(actor(req), enquiryFields.parse(req.body));
    compatibility.onChange?.(record);
    res.status(201).json(record);
  }));

  router.patch("/enquiries/:id", requirePermission("enquiry:update"), asyncHandler(async (req, res) => {
    const enquiryId = scopedId.parse(req.params.id);
    const { sessionId, version, ...input } = enquiryUpdate.parse(req.body);
    const record = await service.update(actor(req), sessionId, enquiryId, input, version);
    compatibility.onChange?.(record);
    res.json(record);
  }));

  const transition = (path: EnquiryTransition, permission: "enquiry:update" | "enquiry:escalate" | "enquiry:close") => {
    router.post(`/enquiries/:id/${path}`, requirePermission(permission), asyncHandler(async (req, res) => {
      const enquiryId = scopedId.parse(req.params.id);
      const body = actionBody.parse(req.body);
      const record = await service.transition(actor(req), body.sessionId, enquiryId, path, body.version, body.notes);
      compatibility.onChange?.(record);
      res.json(record);
    }));
  };

  transition("send-to-family-assistance", "enquiry:update");
  transition("mark-urgent", "enquiry:escalate");
  transition("mark-duplicate", "enquiry:update");
  transition("close", "enquiry:close");

  return router;
}
