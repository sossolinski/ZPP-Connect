import { z } from "zod";
import { dictionaries } from "@zpp/shared";

const requestStatuses = [...dictionaries.requestStatuses, "Completed"] as const;
const assignmentStatuses = dictionaries.assignmentStatuses;
const assignmentPriorities = dictionaries.assignmentPriorities;

export const requestStatusSchema = z.enum(requestStatuses);
export const operationalNoteSchema = z.string().trim().min(3);

export const sessionCloseSchema = z.object({
  notes: operationalNoteSchema
});

export const requestStatusUpdateSchema = z
  .object({
    status: requestStatusSchema,
    closureNote: operationalNoteSchema.optional()
  })
  .superRefine((value, ctx) => {
    if (value.status === "Closed" && !value.closureNote) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["closureNote"],
        message: "Closure note is required when closing a request"
      });
    }
  });

export const assignmentStatusUpdateSchema = z.object({
  status: z.enum(assignmentStatuses),
  reason: operationalNoteSchema.optional()
});

export const assignmentAssignSchema = z.object({
  assignedUserId: z.string().uuid(),
  ownerAssignedTo: z.string().trim().min(1).optional()
});

export const assignmentReassignSchema = z.object({
  assignedUserId: z.string().uuid(),
  ownerAssignedTo: z.string().trim().min(1).optional(),
  reason: operationalNoteSchema
});

export const idParam = z.object({ id: z.string().uuid() });

export const listQuery = z.object({
  sessionId: z.string().uuid().optional(),
  status: z.string().optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

const optionalNullableDate = z.preprocess(
  (value) => (value === "" ? null : value),
  z.coerce.date().optional().nullable()
);

export const sessionSchema = z.object({
  mode: z.enum(["REAL", "EXERCISE", "TRAINING"]),
  status: z.enum(dictionaries.sessionStatuses).default("Draft"),
  eventType: z.string().min(1),
  flightNumber: z.string().optional().nullable(),
  route: z.string().optional().nullable(),
  aircraftRegistration: z.string().optional().nullable(),
  airportLocation: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  startAt: optionalNullableDate,
  endAt: optionalNullableDate,
  notes: z.string().optional().nullable()
});

export const enquirySchema = z.object({
  sessionId: z.string().uuid(),
  caseId: z.string().optional().nullable(),
  contactChannel: z.string().min(1),
  callerName: z.string().min(1),
  callerPhone: z.string().optional().nullable(),
  callerEmail: z.string().email().optional().nullable().or(z.literal("")),
  callerLocation: z.string().optional().nullable(),
  preferredLanguage: z.string().optional().nullable(),
  claimedRelationship: z.string().optional().nullable(),
  passengerRecordId: z.string().uuid().optional().nullable(),
  passengerFirstName: z.string().optional().nullable(),
  passengerLastName: z.string().optional().nullable(),
  passengerFlight: z.string().optional().nullable(),
  passengerRoute: z.string().optional().nullable(),
  lastKnownContact: z.string().optional().nullable(),
  enquiryType: z.string().min(1),
  urgency: z.enum(dictionaries.enquiryUrgencies).default("Normal"),
  notes: z.string().optional().nullable(),
  status: z.enum(dictionaries.enquiryStatuses).default("New")
});

export const requestSchema = z.object({
  sessionId: z.string().uuid(),
  caseId: z.string().optional().nullable(),
  relatedEnquiryId: z.string().uuid().optional().nullable(),
  relatedFamilyRecordId: z.string().uuid().optional().nullable(),
  relatedPassengerRecordId: z.string().uuid().optional().nullable(),
  category: z.string().min(1),
  priority: z.enum(dictionaries.requestPriorities).default("Normal"),
  requester: z.string().optional().nullable(),
  ownerAssignedTo: z.string().optional().nullable(),
  details: z.string().min(1),
  approvalStatus: z.enum(dictionaries.approvalStatuses).default("Not required"),
  status: requestStatusSchema.default("Open"),
  closureNote: z.string().optional().nullable(),
  notes: z.string().optional().nullable()
});

export const assignmentSchema = z.object({
  sessionId: z.string().uuid(),
  caseId: z.string().optional().nullable(),
  title: z.string().trim().min(1),
  details: z.string().optional().nullable(),
  status: z.enum(assignmentStatuses).default("Open"),
  priority: z.enum(assignmentPriorities).default("Normal"),
  ownerAssignedTo: z.string().optional().nullable(),
  assignedUserId: z.string().uuid().optional().nullable(),
  assignedUserDisplayName: z.string().optional().nullable(),
  relatedFunction: z.string().optional().nullable(),
  linkedRecord: z.string().optional().nullable(),
  dueAt: z.coerce.date().optional().nullable()
});

export const timelineSchema = z.object({
  sessionId: z.string().uuid(),
  caseId: z.string().optional().nullable(),
  eventType: z.enum(["note", "contact_attempt", "information_received", "operational_update", "handover_note"]),
  title: z.string().min(1),
  body: z.string().optional().nullable()
});

export const exerciseInjectSchema = z.object({
  sessionId: z.string().uuid(),
  injectNumber: z.coerce.number().int().positive(),
  scenarioTime: z.coerce.date().optional().nullable(),
  targetRole: z.string().min(1),
  text: z.string().min(1),
  expectedAction: z.string().optional().nullable(),
  status: z.enum(dictionaries.exerciseInjectStatuses).default("Planned")
});

export const exerciseObservationSchema = z.object({
  sessionId: z.string().uuid(),
  area: z.string().min(1),
  observation: z.string().min(1),
  severity: z.enum(dictionaries.observationSeverities).default("Low"),
  recommendation: z.string().optional().nullable(),
  owner: z.string().optional().nullable(),
  includeInAar: z.boolean().default(true),
  status: z.string().default("Open")
});
