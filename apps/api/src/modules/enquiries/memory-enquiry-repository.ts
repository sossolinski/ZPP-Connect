import type { IncidentContext } from "../incident-access/incident-access-types.js";
import type { EnquiryRepository } from "./enquiry-repository.js";
import type { EnquiryActor, EnquiryCreateInput, EnquiryRecord, EnquiryTransition, EnquiryUpdateInput } from "./enquiry-types.js";

type Row = Record<string, any>;

type MemoryEnquirySources = {
  enquiries: Row[];
  passengers: Row[];
  auditLogs: Row[];
  timeline: Row[];
  now?: () => string;
};

const transitionValues: Record<EnquiryTransition, { status: string; urgency?: string; title: string; action: string }> = {
  "send-to-family-assistance": { status: "Sent to family assistance", title: "Enquiry sent to family assistance", action: "send_enquiry_to_family_assistance" },
  "mark-urgent": { status: "Urgent welfare", urgency: "Urgent welfare", title: "Urgent welfare flagged", action: "mark_urgent" },
  "mark-duplicate": { status: "Duplicate suspected", title: "Enquiry marked as suspected duplicate", action: "mark_duplicate" },
  close: { status: "Closed", title: "Enquiry closed", action: "close_enquiry" }
};

function nextOperationalId(rows: Row[]) {
  const year = new Date().getFullYear();
  const stem = `TEC-${year}-`;
  const highest = rows.reduce((value, row) => {
    const match = String(row.operationalId ?? "").match(new RegExp(`^${stem}(\\d+)$`));
    return Math.max(value, match ? Number(match[1]) : 0);
  }, 0);
  return `${stem}${String(highest + 1).padStart(6, "0")}`;
}

function actorSnapshot(actor: EnquiryActor) {
  return { id: actor.id, userId: actor.id, email: actor.email, displayName: actor.displayName, roles: actor.roles };
}

export function createMemoryEnquiryRepository(sources: MemoryEnquirySources): EnquiryRepository {
  const currentTime = sources.now ?? (() => new Date().toISOString());

  function appendAudit(context: IncidentContext, actor: EnquiryActor, row: Row, action: string, summary: string, metadata: Row) {
    sources.auditLogs.unshift({
      id: `aud-enquiry-${sources.auditLogs.length + 1}`,
      action,
      entityType: "enquiry",
      entityId: row.id,
      sessionId: context.incidentId,
      actorId: actor.id,
      actorEmail: actor.email,
      summary,
      metadata: { ...metadata, requestId: actor.requestId },
      createdAt: currentTime()
    });
  }

  function appendTimeline(context: IncidentContext, actor: EnquiryActor, row: Row, title: string, body?: string | null) {
    sources.timeline.unshift({
      id: `tle-enquiry-${sources.timeline.length + 1}`,
      sessionId: context.incidentId,
      caseId: row.caseId ?? null,
      eventType: "enquiry",
      entityType: "enquiry",
      entityId: row.id,
      title,
      body: body ?? null,
      metadata: { status: row.status, version: row.version },
      createdById: actor.id,
      occurredAt: currentTime(),
      createdAt: currentTime()
    });
  }

  return {
    kind: "memory",

    async list(context, query) {
      const needle = query.search?.trim().toLowerCase();
      const filtered = sources.enquiries
        .filter((row) => row.sessionId === context.incidentId)
        .filter((row) => !query.status || row.status === query.status)
        .filter((row) => !needle || [row.operationalId, row.callerName, row.passengerFirstName, row.passengerLastName, row.passengerFlight]
          .some((value) => String(value ?? "").toLowerCase().includes(needle)))
        .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
      return {
        total: filtered.length,
        data: filtered.slice(query.offset, query.offset + query.limit).map((row) => ({ ...row, version: Number(row.version ?? 1) })) as EnquiryRecord[]
      };
    },

    async getById(context, enquiryId) {
      const row = sources.enquiries.find((item) => item.id === enquiryId && item.sessionId === context.incidentId);
      return row ? ({ ...row, version: Number(row.version ?? 1) } as EnquiryRecord) : null;
    },

    async passengerBelongsToIncident(context, passengerId) {
      return sources.passengers.some((row) => row.id === passengerId && row.sessionId === context.incidentId);
    },

    async create(context, input: EnquiryCreateInput, actor) {
      const timestamp = currentTime();
      const row: Row = {
        ...input,
        id: `enq-memory-${sources.enquiries.length + 1}-${Date.now()}`,
        operationalId: nextOperationalId(sources.enquiries),
        sessionId: context.incidentId,
        version: 1,
        createdById: actor.id,
        updatedById: actor.id,
        createdBy: actorSnapshot(actor),
        updatedBy: actorSnapshot(actor),
        createdAt: timestamp,
        updatedAt: timestamp
      };
      sources.enquiries.unshift(row);
      appendAudit(context, actor, row, "create_enquiry", `Enquiry ${row.operationalId} created`, { status: row.status, version: row.version });
      appendTimeline(context, actor, row, `Enquiry ${row.operationalId} created`, row.notes);
      return { ...row } as EnquiryRecord;
    },

    async update(context, enquiryId, input: EnquiryUpdateInput, expectedVersion, actor) {
      const row = sources.enquiries.find((item) => item.id === enquiryId && item.sessionId === context.incidentId);
      if (!row) return { record: null, conflict: false };
      if (Number(row.version ?? 1) !== expectedVersion) return { record: null, conflict: true };
      const changedFields = Object.keys(input).filter((key) => input[key as keyof EnquiryUpdateInput] !== undefined);
      const classificationBefore = { status: row.status, urgency: row.urgency };
      Object.assign(row, input, {
        version: expectedVersion + 1,
        updatedById: actor.id,
        updatedBy: actorSnapshot(actor),
        updatedAt: currentTime()
      });
      appendAudit(context, actor, row, "update_enquiry", `Enquiry ${row.operationalId} updated`, {
        changedFields,
        versionBefore: expectedVersion,
        versionAfter: row.version,
        classificationBefore,
        classificationAfter: { status: row.status, urgency: row.urgency }
      });
      return { record: { ...row } as EnquiryRecord, conflict: false };
    },

    async transition(context, enquiryId, transition, expectedVersion, notes, actor) {
      const row = sources.enquiries.find((item) => item.id === enquiryId && item.sessionId === context.incidentId);
      if (!row) return { record: null, conflict: false };
      if (Number(row.version ?? 1) !== expectedVersion) return { record: null, conflict: true };
      const before = { status: row.status, urgency: row.urgency, version: expectedVersion };
      const next = transitionValues[transition];
      Object.assign(row, {
        status: next.status,
        urgency: next.urgency ?? row.urgency,
        notes: notes === undefined ? row.notes : notes,
        version: expectedVersion + 1,
        updatedById: actor.id,
        updatedBy: actorSnapshot(actor),
        updatedAt: currentTime()
      });
      appendAudit(context, actor, row, next.action, next.title, {
        before,
        after: { status: row.status, urgency: row.urgency, version: row.version }
      });
      appendTimeline(context, actor, row, next.title, notes);
      return { record: { ...row } as EnquiryRecord, conflict: false };
    }
  };
}
