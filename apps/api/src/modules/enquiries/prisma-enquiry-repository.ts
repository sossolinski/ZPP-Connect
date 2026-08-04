import { Prisma, type PrismaClient } from "@prisma/client";
import { HttpError } from "../../errors.js";
import type { EnquiryRepository } from "./enquiry-repository.js";
import type { EnquiryActor, EnquiryCreateInput, EnquiryRecord, EnquiryTransition, EnquiryUpdateInput } from "./enquiry-types.js";

const transitionValues: Record<EnquiryTransition, { status: string; urgency?: string; title: string; action: string }> = {
  "send-to-family-assistance": { status: "Sent to family assistance", title: "Enquiry sent to family assistance", action: "send_enquiry_to_family_assistance" },
  "mark-urgent": { status: "Urgent welfare", urgency: "Urgent welfare", title: "Urgent welfare flagged", action: "mark_urgent" },
  "mark-duplicate": { status: "Duplicate suspected", title: "Enquiry marked as suspected duplicate", action: "mark_duplicate" },
  close: { status: "Closed", title: "Enquiry closed", action: "close_enquiry" }
};

function isOperationalIdConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function jsonMetadata(value: Record<string, unknown>): Prisma.InputJsonValue {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Prisma.InputJsonObject;
}

function createData(input: EnquiryCreateInput, operationalId: string, actorId: string): Prisma.EnquiryUncheckedCreateInput {
  return {
    operationalId,
    sessionId: input.sessionId,
    caseId: input.caseId,
    contactChannel: input.contactChannel,
    callerName: input.callerName,
    callerPhone: input.callerPhone,
    callerEmail: input.callerEmail,
    callerLocation: input.callerLocation,
    preferredLanguage: input.preferredLanguage,
    claimedRelationship: input.claimedRelationship,
    passengerRecordId: input.passengerRecordId,
    passengerFirstName: input.passengerFirstName,
    passengerLastName: input.passengerLastName,
    passengerFlight: input.passengerFlight,
    passengerRoute: input.passengerRoute,
    lastKnownContact: input.lastKnownContact,
    enquiryType: input.enquiryType,
    urgency: input.urgency,
    notes: input.notes,
    status: input.status,
    createdById: actorId,
    updatedById: actorId
  };
}

function updateData(input: EnquiryUpdateInput, actorId: string): Prisma.EnquiryUncheckedUpdateManyInput {
  return {
    caseId: input.caseId,
    contactChannel: input.contactChannel,
    callerName: input.callerName,
    callerPhone: input.callerPhone,
    callerEmail: input.callerEmail,
    callerLocation: input.callerLocation,
    preferredLanguage: input.preferredLanguage,
    claimedRelationship: input.claimedRelationship,
    passengerRecordId: input.passengerRecordId,
    passengerFirstName: input.passengerFirstName,
    passengerLastName: input.passengerLastName,
    passengerFlight: input.passengerFlight,
    passengerRoute: input.passengerRoute,
    lastKnownContact: input.lastKnownContact,
    enquiryType: input.enquiryType,
    urgency: input.urgency,
    notes: input.notes,
    status: input.status,
    updatedById: actorId,
    version: { increment: 1 }
  };
}

export function createPrismaEnquiryRepository(client: PrismaClient): EnquiryRepository {
  return {
    kind: "postgres",

    async list(context, query) {
      const where: Prisma.EnquiryWhereInput = {
        sessionId: context.incidentId,
        status: query.status,
        OR: query.search
          ? ["operationalId", "callerName", "passengerFirstName", "passengerLastName", "passengerFlight"].map((field) => ({
              [field]: { contains: query.search, mode: "insensitive" }
            }))
          : undefined
      };
      const [total, data] = await Promise.all([
        client.enquiry.count({ where }),
        client.enquiry.findMany({ where, take: query.limit, skip: query.offset, orderBy: [{ updatedAt: "desc" }, { id: "desc" }] })
      ]);
      return { total, data: data as EnquiryRecord[] };
    },

    async getById(context, enquiryId) {
      return (await client.enquiry.findFirst({ where: { id: enquiryId, sessionId: context.incidentId } })) as EnquiryRecord | null;
    },

    async passengerBelongsToIncident(context, passengerId) {
      return (await client.passengerRecord.count({ where: { id: passengerId, sessionId: context.incidentId } })) === 1;
    },

    async create(context, input, actor) {
      let lastError: unknown;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          return await client.$transaction(async (tx) => {
            const writableIncident = await tx.session.count({
              where: { id: context.incidentId, status: { notIn: ["Closed", "Archived"] } }
            });
            if (writableIncident !== 1) throw new HttpError(409, "Enquiries in a closed incident are read-only");
            if (input.passengerRecordId) {
              const linkedPassenger = await tx.passengerRecord.count({
                where: { id: input.passengerRecordId, sessionId: context.incidentId }
              });
              if (linkedPassenger !== 1) throw new HttpError(409, "Passenger record must belong to the same incident");
            }
            const year = new Date().getFullYear();
            const stem = `TEC-${year}-`;
            const count = await tx.enquiry.count({ where: { operationalId: { startsWith: stem } } });
            const operationalId = `${stem}${String(count + 1).padStart(6, "0")}`;
            const record = await tx.enquiry.create({
              data: createData({ ...input, sessionId: context.incidentId }, operationalId, context.actorId)
            });
            await tx.auditLog.create({
              data: {
                action: "create_enquiry",
                entityType: "enquiry",
                entityId: record.id,
                sessionId: context.incidentId,
                actorId: context.actorId,
                actorEmail: actor.email,
                summary: `Enquiry ${record.operationalId} created`,
                metadata: jsonMetadata({ status: record.status, version: record.version, requestId: actor.requestId })
              }
            });
            await tx.caseTimelineEvent.create({
              data: {
                sessionId: context.incidentId,
                caseId: record.caseId,
                eventType: "enquiry",
                entityType: "enquiry",
                entityId: record.id,
                title: `Enquiry ${record.operationalId} created`,
                body: record.notes,
                metadata: { status: record.status, version: record.version },
                createdById: context.actorId
              }
            });
            return record as EnquiryRecord;
          });
        } catch (error) {
          if (!isOperationalIdConflict(error)) throw error;
          lastError = error;
        }
      }
      throw lastError;
    },

    async update(context, enquiryId, input, expectedVersion, actor) {
      return client.$transaction(async (tx) => {
        const before = await tx.enquiry.findFirst({ where: { id: enquiryId, sessionId: context.incidentId } });
        if (!before) return { record: null, conflict: false };
        if (input.passengerRecordId) {
          const linkedPassenger = await tx.passengerRecord.count({
            where: { id: input.passengerRecordId, sessionId: context.incidentId }
          });
          if (linkedPassenger !== 1) throw new HttpError(409, "Passenger record must belong to the same incident");
        }
        const changed = await tx.enquiry.updateMany({
          where: {
            id: enquiryId,
            sessionId: context.incidentId,
            version: expectedVersion,
            status: { not: "Closed" },
            session: { status: { notIn: ["Closed", "Archived"] } }
          },
          data: updateData(input, context.actorId)
        });
        if (changed.count !== 1) {
          return { record: null, conflict: true };
        }
        const record = await tx.enquiry.findFirstOrThrow({ where: { id: enquiryId, sessionId: context.incidentId } });
        await tx.auditLog.create({
          data: {
            action: "update_enquiry",
            entityType: "enquiry",
            entityId: record.id,
            sessionId: context.incidentId,
            actorId: context.actorId,
            actorEmail: actor.email,
            summary: `Enquiry ${record.operationalId} updated`,
            metadata: jsonMetadata({
              changedFields: Object.keys(input).filter((key) => input[key as keyof EnquiryUpdateInput] !== undefined),
              versionBefore: expectedVersion,
              versionAfter: record.version,
              classificationBefore: { status: before.status, urgency: before.urgency },
              classificationAfter: { status: record.status, urgency: record.urgency },
              requestId: actor.requestId
            })
          }
        });
        return { record: record as EnquiryRecord, conflict: false };
      });
    },

    async transition(context, enquiryId, transition, expectedVersion, notes, actor) {
      return client.$transaction(async (tx) => {
        const before = await tx.enquiry.findFirst({ where: { id: enquiryId, sessionId: context.incidentId } });
        if (!before) return { record: null, conflict: false };
        const next = transitionValues[transition];
        const changed = await tx.enquiry.updateMany({
          where: {
            id: enquiryId,
            sessionId: context.incidentId,
            version: expectedVersion,
            status: before.status,
            session: { status: { notIn: ["Closed", "Archived"] } }
          },
          data: {
            status: next.status,
            urgency: next.urgency,
            notes: notes === undefined ? undefined : notes,
            updatedById: context.actorId,
            version: { increment: 1 }
          }
        });
        if (changed.count !== 1) return { record: null, conflict: true };
        const record = await tx.enquiry.findFirstOrThrow({ where: { id: enquiryId, sessionId: context.incidentId } });
        await tx.auditLog.create({
          data: {
            action: next.action,
            entityType: "enquiry",
            entityId: record.id,
            sessionId: context.incidentId,
            actorId: context.actorId,
            actorEmail: actor.email,
            summary: next.title,
            metadata: jsonMetadata({
              before: { status: before.status, urgency: before.urgency, version: before.version },
              after: { status: record.status, urgency: record.urgency, version: record.version },
              requestId: actor.requestId
            })
          }
        });
        await tx.caseTimelineEvent.create({
          data: {
            sessionId: context.incidentId,
            caseId: record.caseId,
            eventType: transition === "mark-urgent" ? "urgent_welfare" : "enquiry",
            entityType: "enquiry",
            entityId: record.id,
            title: next.title,
            body: notes,
            metadata: { status: record.status, version: record.version },
            createdById: context.actorId
          }
        });
        return { record: record as EnquiryRecord, conflict: false };
      });
    }
  };
}
