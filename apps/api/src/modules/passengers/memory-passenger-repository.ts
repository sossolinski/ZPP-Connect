import type { IncidentContext } from "../incident-access/incident-access-types.js";
import type { PassengerRepository } from "./passenger-repository.js";
import type { PassengerActor, PassengerControlledField, PassengerRecord } from "./passenger-types.js";

type Row = Record<string, any>;
type Sources = { passengers: Row[]; importBatches: Row[]; auditLogs: Row[]; timeline: Row[]; now?: () => string };

function nextOperationalId(rows: Row[]) {
  const year = new Date().getFullYear();
  const stem = `PAX-${year}-`;
  const highest = rows.reduce((value, row) => {
    const match = String(row.operationalId ?? "").match(new RegExp(`^${stem}(\\d+)$`));
    return Math.max(value, match ? Number(match[1]) : 0);
  }, 0);
  return `${stem}${String(highest + 1).padStart(6, "0")}`;
}

function actorSnapshot(actor: PassengerActor) {
  return { id: actor.id, userId: actor.id, email: actor.email, displayName: actor.displayName, roles: actor.roles };
}

export function createMemoryPassengerRepository(sources: Sources): PassengerRepository {
  const currentTime = sources.now ?? (() => new Date().toISOString());

  function normalized(row: Row): PassengerRecord {
    return {
      ...row,
      version: Number(row.version ?? 1),
      sourceBatchId: row.sourceBatchId ?? null,
      sourceExternalId: row.sourceExternalId ?? null,
      sourceImportedAt: row.sourceImportedAt ?? (row.source === "Manual" ? null : row.createdAt),
      srcConfirmedAt: row.srcConfirmedAt ?? null
    } as PassengerRecord;
  }

  function appendAudit(context: IncidentContext, actor: PassengerActor, row: Row, action: string, summary: string, metadata: Row) {
    sources.auditLogs.unshift({
      id: `aud-passenger-${sources.auditLogs.length + 1}`,
      action,
      entityType: "passengerRecord",
      entityId: row.id,
      sessionId: context.incidentId,
      actorId: actor.id,
      actorEmail: actor.email,
      summary,
      metadata: { ...metadata, requestId: actor.requestId },
      createdAt: currentTime()
    });
  }

  function appendTimeline(context: IncidentContext, actor: PassengerActor, row: Row, title: string, body?: string | null, metadata: Row = {}) {
    sources.timeline.unshift({
      id: `tle-passenger-${sources.timeline.length + 1}`,
      sessionId: context.incidentId,
      caseId: row.caseId ?? null,
      eventType: "passenger_record",
      entityType: "passengerRecord",
      entityId: row.id,
      title,
      body: body ?? null,
      metadata: { ...metadata, version: row.version },
      createdById: actor.id,
      occurredAt: currentTime(),
      createdAt: currentTime()
    });
  }

  function find(context: IncidentContext, passengerId: string) {
    return sources.passengers.find((row) => row.id === passengerId && row.sessionId === context.incidentId);
  }

  function conflict(row: Row, expectedVersion: number) {
    return Number(row.version ?? 1) !== expectedVersion;
  }

  function updateActor(row: Row, actor: PassengerActor, expectedVersion: number) {
    Object.assign(row, {
      version: expectedVersion + 1,
      updatedById: actor.id,
      updatedBy: actorSnapshot(actor),
      updatedAt: currentTime()
    });
  }

  return {
    kind: "memory",

    async list(context, query) {
      const needle = query.search?.toLocaleLowerCase();
      const filtered = sources.passengers
        .filter((row) => row.sessionId === context.incidentId)
        .filter((row) => !query.source || row.source === query.source)
        .filter((row) => !query.sourceBatchId || row.sourceBatchId === query.sourceBatchId)
        .filter((row) => !query.conditionStatus || row.conditionStatus === query.conditionStatus)
        .filter((row) => !query.holdStatus || row.holdStatus === query.holdStatus)
        .filter((row) => query.srcConfirmed === undefined || Boolean(row.srcConfirmed) === query.srcConfirmed)
        .filter((row) => !needle || [row.operationalId, row.firstName, row.lastName, row.flightNumber, row.route, row.seat, row.pnr, row.ticketNumber, row.sourceExternalId]
          .some((value) => String(value ?? "").toLocaleLowerCase().includes(needle)))
        .sort((left, right) => {
          const a = String(left[query.sortBy] ?? "");
          const b = String(right[query.sortBy] ?? "");
          return a.localeCompare(b) * (query.sortDirection === "asc" ? 1 : -1);
        });
      return { total: filtered.length, data: filtered.slice(query.offset, query.offset + query.limit).map(normalized) };
    },

    async getById(context, passengerId) {
      const row = find(context, passengerId);
      return row ? normalized(row) : null;
    },

    async create(context, input, actor) {
      const timestamp = currentTime();
      const row: Row = {
        ...input,
        id: `pax-memory-${sources.passengers.length + 1}-${Date.now()}`,
        operationalId: nextOperationalId(sources.passengers),
        sessionId: context.incidentId,
        sourceBatchId: null,
        sourceImportedAt: input.source === "Manual" ? null : timestamp,
        conditionStatus: "Unknown",
        holdStatus: "No hold",
        srcConfirmed: false,
        version: 1,
        createdById: actor.id,
        updatedById: actor.id,
        createdBy: actorSnapshot(actor),
        updatedBy: actorSnapshot(actor),
        createdAt: timestamp,
        updatedAt: timestamp
      };
      sources.passengers.unshift(row);
      appendAudit(context, actor, row, "create_passenger_record", `Passenger/Crew record ${row.operationalId} created`, { source: row.source, sourceExternalId: row.sourceExternalId, version: 1 });
      appendTimeline(context, actor, row, `Passenger/Crew record ${row.operationalId} created`, row.notes, { source: row.source });
      return normalized(row);
    },

    async update(context, passengerId, input, expectedVersion, actor) {
      const row = find(context, passengerId);
      if (!row) return { record: null, conflict: false };
      if (conflict(row, expectedVersion)) return { record: null, conflict: true };
      const changedFields = Object.keys(input).filter((key) => input[key as keyof typeof input] !== undefined);
      Object.assign(row, input);
      updateActor(row, actor, expectedVersion);
      appendAudit(context, actor, row, "update_passenger_record", `Passenger/Crew record ${row.operationalId} updated`, { changedFields, versionBefore: expectedVersion, versionAfter: row.version });
      return { record: normalized(row), conflict: false };
    },

    async correctSource(context, passengerId, input, expectedVersion, actor) {
      const row = find(context, passengerId);
      if (!row) return { record: null, conflict: false };
      if (conflict(row, expectedVersion)) return { record: null, conflict: true };
      const { reason, ...facts } = input;
      const changedFields = Object.keys(facts).filter((key) => facts[key as keyof typeof facts] !== undefined);
      const invalidated = Boolean(row.srcConfirmed);
      Object.assign(row, facts, { srcConfirmed: false, srcConfirmedAt: null, srcConfirmedById: null, srcConfirmationBasis: null });
      updateActor(row, actor, expectedVersion);
      appendAudit(context, actor, row, "correct_passenger_source", `Source facts corrected for ${row.operationalId}`, { changedFields, reason, srcConfirmationInvalidated: invalidated, versionBefore: expectedVersion, versionAfter: row.version });
      appendTimeline(context, actor, row, `Source facts corrected for ${row.operationalId}`, reason, { changedFields, srcConfirmationInvalidated: invalidated });
      return { record: normalized(row), conflict: false };
    },

    async confirmSrc(context, passengerId, expectedVersion, basis, actor) {
      const row = find(context, passengerId);
      if (!row) return { record: null, conflict: false };
      if (row.srcConfirmed || conflict(row, expectedVersion)) return { record: null, conflict: true };
      Object.assign(row, { srcConfirmed: true, srcConfirmedAt: currentTime(), srcConfirmedById: actor.id, srcConfirmationBasis: basis ?? null });
      updateActor(row, actor, expectedVersion);
      appendAudit(context, actor, row, "mark_src_confirmed", `Passenger/Crew record ${row.operationalId} marked SRC confirmed`, { basis, versionBefore: expectedVersion, versionAfter: row.version });
      appendTimeline(context, actor, row, `SRC confirmed for ${row.operationalId}`, basis, { srcConfirmed: true });
      return { record: normalized(row), conflict: false };
    },

    async control(context, passengerId, field: PassengerControlledField, value, reason, expectedVersion, actor) {
      const row = find(context, passengerId);
      if (!row) return { record: null, conflict: false };
      if (conflict(row, expectedVersion)) return { record: null, conflict: true };
      const before = row[field];
      if (field === "conditionStatus") Object.assign(row, { conditionStatus: value, conditionUpdatedAt: currentTime(), conditionUpdatedById: actor.id, conditionBasis: reason });
      else Object.assign(row, { holdStatus: value, holdUpdatedAt: currentTime(), holdUpdatedById: actor.id, holdReason: reason });
      updateActor(row, actor, expectedVersion);
      appendAudit(context, actor, row, field === "conditionStatus" ? "change_passenger_condition" : "change_passenger_hold", `${row.operationalId} ${field} changed`, { field, before, after: value, reason, versionBefore: expectedVersion, versionAfter: row.version });
      appendTimeline(context, actor, row, `${row.operationalId}: ${field} changed to ${value}`, reason, { field, before, after: value });
      return { record: normalized(row), conflict: false };
    },

    async importRecords(context, input, actor) {
      const stagedBatch = sources.importBatches.find((batch) => batch.id === input.batchId);
      if (stagedBatch && String(stagedBatch.status).startsWith("Imported")) throw new Error("Import batch has already been confirmed");
      const timestamp = currentTime();
      input.records.forEach((inputRow) => {
        sources.passengers.unshift({
          ...inputRow,
          id: `pax-memory-${sources.passengers.length + 1}-${Date.now()}`,
          operationalId: nextOperationalId(sources.passengers),
          sessionId: context.incidentId,
          sourceBatchId: input.batchId,
          sourceImportedAt: timestamp,
          conditionStatus: "Unknown",
          holdStatus: "No hold",
          srcConfirmed: false,
          version: 1,
          createdById: actor.id,
          updatedById: actor.id,
          createdAt: timestamp,
          updatedAt: timestamp
        });
      });
      const status = input.invalidRecords > 0 ? "Imported with errors" : "Imported";
      const persistedBatch = {
        id: input.batchId,
        operationalId: `IMP-${new Date().getFullYear()}-${String(sources.importBatches.length + 1).padStart(6, "0")}`,
        sessionId: context.incidentId,
        importType: "manifest",
        sourceFilename: input.sourceFilename,
        status,
        totalRecords: input.totalRecords,
        validRecords: input.records.length,
        invalidRecords: input.invalidRecords,
        errors: input.errors,
        createdById: actor.id,
        createdAt: timestamp
      };
      if (stagedBatch) Object.assign(stagedBatch, persistedBatch);
      else sources.importBatches.unshift(persistedBatch);
      appendAudit(context, actor, { id: input.batchId, operationalId: input.batchId }, "import_passenger_manifest", `Imported manifest: ${input.records.length}/${input.totalRecords} valid`, { sourceBatchId: input.batchId, totalRecords: input.totalRecords, validRecords: input.records.length, invalidRecords: input.invalidRecords });
      appendTimeline(context, actor, { id: input.batchId, operationalId: input.batchId, version: 1 }, `Passenger manifest imported (${input.records.length} records)`, undefined, { sourceBatchId: input.batchId, totalRecords: input.totalRecords, validRecords: input.records.length });
      return { batchId: input.batchId, status, totalRecords: input.totalRecords, validRecords: input.records.length, invalidRecords: input.invalidRecords };
    }
  };
}
