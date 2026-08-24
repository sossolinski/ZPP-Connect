import { Prisma, type PrismaClient } from "@prisma/client";
import { HttpError } from "../../errors.js";
import type { PassengerRepository } from "./passenger-repository.js";
import type {
  PassengerActor,
  PassengerControlledField,
  PassengerCreateInput,
  PassengerImportInput,
  PassengerRecord,
  PassengerSourceCorrection
} from "./passenger-types.js";

function jsonMetadata(value: Record<string, unknown>): Prisma.InputJsonValue {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Prisma.InputJsonObject;
}

function isSourceIdentityConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

async function operationalIds(tx: Prisma.TransactionClient, count = 1) {
  const rows = await tx.$queryRaw<Array<{ value: bigint }>>`
    SELECT nextval('"PassengerRecord_operational_seq"') AS value
    FROM generate_series(1, ${count})
  `;
  const year = new Date().getFullYear();
  return rows.map((row) => `PAX-${year}-${String(row.value).padStart(6, "0")}`);
}

function sourceData(input: PassengerCreateInput | PassengerSourceCorrection) {
  return {
    personType: input.personType,
    firstName: input.firstName,
    lastName: input.lastName,
    dateOfBirth: input.dateOfBirth,
    age: input.age,
    gender: input.gender,
    nationality: input.nationality,
    flightNumber: input.flightNumber,
    route: input.route,
    seat: input.seat,
    pnr: input.pnr,
    ticketNumber: input.ticketNumber,
    manifestVersion: input.manifestVersion,
    source: input.source,
    travellingCompanions: input.travellingCompanions,
    sourceExternalId: input.sourceExternalId
  };
}

function createData(input: PassengerCreateInput, operationalId: string, actorId: string): Prisma.PassengerRecordUncheckedCreateInput {
  return {
    ...sourceData(input),
    operationalId,
    sessionId: input.sessionId,
    caseId: input.caseId,
    notes: input.notes,
    sourceImportedAt: input.source === "Manual" ? null : new Date(),
    createdById: actorId,
    updatedById: actorId
  } as Prisma.PassengerRecordUncheckedCreateInput;
}

async function assertWritable(tx: Prisma.TransactionClient, incidentId: string) {
  const writable = await tx.session.count({ where: { id: incidentId, status: { notIn: ["Closed", "Archived"] } } });
  if (writable !== 1) throw new HttpError(409, "Passenger records in a closed incident are read-only");
}

export async function createPassengerImportRecords(
  tx: Prisma.TransactionClient,
  input: {
    incidentId: string;
    batchId: string;
    records: PassengerImportInput["records"];
    actorId: string;
    importedAt?: Date;
  }
) {
  const ids = await operationalIds(tx, input.records.length);
  if (input.records.length === 0) return;
  const importedAt = input.importedAt ?? new Date();
  await tx.passengerRecord.createMany({
    data: input.records.map((record, index) => ({
      ...sourceData(record as PassengerCreateInput),
      operationalId: ids[index]!,
      sessionId: input.incidentId,
      caseId: record.caseId,
      notes: record.notes,
      sourceBatchId: input.batchId,
      sourceImportedAt: importedAt,
      createdById: input.actorId,
      updatedById: input.actorId
    })) as Prisma.PassengerRecordCreateManyInput[]
  });
}

async function audit(
  tx: Prisma.TransactionClient,
  context: { incidentId: string; actorId: string },
  actor: PassengerActor,
  record: { id: string; operationalId: string },
  action: string,
  summary: string,
  metadata: Record<string, unknown>
) {
  await tx.auditLog.create({
    data: {
      action,
      entityType: "passengerRecord",
      entityId: record.id,
      sessionId: context.incidentId,
      actorId: context.actorId,
      actorEmail: actor.email,
      summary,
      metadata: jsonMetadata({ ...metadata, requestId: actor.requestId })
    }
  });
}

async function timeline(
  tx: Prisma.TransactionClient,
  context: { incidentId: string; actorId: string },
  record: { id: string; operationalId: string; caseId: string | null },
  title: string,
  body: string | null | undefined,
  metadata: Record<string, unknown>
) {
  await tx.caseTimelineEvent.create({
    data: {
      sessionId: context.incidentId,
      caseId: record.caseId,
      eventType: "passenger_record",
      entityType: "passengerRecord",
      entityId: record.id,
      title,
      body,
      metadata: jsonMetadata(metadata),
      createdById: context.actorId
    }
  });
}

export function createPrismaPassengerRepository(client: PrismaClient): PassengerRepository {
  return {
    kind: "postgres",

    async list(context, query) {
      const where: Prisma.PassengerRecordWhereInput = {
        sessionId: context.incidentId,
        source: query.source,
        sourceBatchId: query.sourceBatchId,
        conditionStatus: query.conditionStatus,
        holdStatus: query.holdStatus,
        srcConfirmed: query.srcConfirmed,
        OR: query.search
          ? ["operationalId", "firstName", "lastName", "flightNumber", "route", "seat", "pnr", "ticketNumber", "sourceExternalId"].map((field) => ({
              [field]: { contains: query.search, mode: "insensitive" }
            }))
          : undefined
      };
      const orderBy = [{ [query.sortBy]: query.sortDirection }, { id: query.sortDirection }] as Prisma.PassengerRecordOrderByWithRelationInput[];
      const [total, data] = await Promise.all([
        client.passengerRecord.count({ where }),
        client.passengerRecord.findMany({ where, take: query.limit, skip: query.offset, orderBy })
      ]);
      return { total, data: data as PassengerRecord[] };
    },

    async getById(context, passengerId) {
      return await client.passengerRecord.findFirst({ where: { id: passengerId, sessionId: context.incidentId } }) as PassengerRecord | null;
    },

    async create(context, input, actor) {
      try {
        return await client.$transaction(async (tx) => {
          await assertWritable(tx, context.incidentId);
          const [operationalId] = await operationalIds(tx);
          const record = await tx.passengerRecord.create({
            data: createData({ ...input, sessionId: context.incidentId }, operationalId!, context.actorId)
          });
          await audit(tx, context, actor, record, "create_passenger_record", `Passenger/Crew record ${record.operationalId} created`, {
            source: record.source,
            sourceExternalId: record.sourceExternalId,
            version: record.version
          });
          await timeline(tx, context, record, `Passenger/Crew record ${record.operationalId} created`, record.notes, { source: record.source, version: record.version });
          return record as PassengerRecord;
        });
      } catch (error) {
        if (isSourceIdentityConflict(error)) throw new HttpError(409, "A passenger with this source identity already exists in the incident");
        throw error;
      }
    },

    async update(context, passengerId, input, expectedVersion, actor) {
      return client.$transaction(async (tx) => {
        const before = await tx.passengerRecord.findFirst({ where: { id: passengerId, sessionId: context.incidentId } });
        if (!before) return { record: null, conflict: false };
        const changed = await tx.passengerRecord.updateMany({
          where: { id: passengerId, sessionId: context.incidentId, version: expectedVersion, session: { status: { notIn: ["Closed", "Archived"] } } },
          data: { caseId: input.caseId, notes: input.notes, updatedById: context.actorId, version: { increment: 1 } }
        });
        if (changed.count !== 1) return { record: null, conflict: true };
        const record = await tx.passengerRecord.findFirstOrThrow({ where: { id: passengerId, sessionId: context.incidentId } });
        await audit(tx, context, actor, record, "update_passenger_record", `Passenger/Crew record ${record.operationalId} updated`, {
          changedFields: Object.keys(input).filter((key) => input[key as keyof typeof input] !== undefined),
          versionBefore: expectedVersion,
          versionAfter: record.version
        });
        return { record: record as PassengerRecord, conflict: false };
      });
    },

    async correctSource(context, passengerId, input, expectedVersion, actor) {
      try {
        return await client.$transaction(async (tx) => {
          const before = await tx.passengerRecord.findFirst({ where: { id: passengerId, sessionId: context.incidentId } });
          if (!before) return { record: null, conflict: false };
          const { reason, ...facts } = input;
          const changedFields = Object.keys(facts).filter((key) => facts[key as keyof typeof facts] !== undefined);
          const changed = await tx.passengerRecord.updateMany({
            where: { id: passengerId, sessionId: context.incidentId, version: expectedVersion, session: { status: { notIn: ["Closed", "Archived"] } } },
            data: {
              ...sourceData(facts as PassengerSourceCorrection),
              srcConfirmed: false,
              srcConfirmedAt: null,
              srcConfirmedById: null,
              srcConfirmationBasis: null,
              updatedById: context.actorId,
              version: { increment: 1 }
            }
          });
          if (changed.count !== 1) return { record: null, conflict: true };
          const record = await tx.passengerRecord.findFirstOrThrow({ where: { id: passengerId, sessionId: context.incidentId } });
          await audit(tx, context, actor, record, "correct_passenger_source", `Source facts corrected for ${record.operationalId}`, {
            changedFields,
            reason,
            srcConfirmationInvalidated: before.srcConfirmed,
            versionBefore: expectedVersion,
            versionAfter: record.version
          });
          await timeline(tx, context, record, `Source facts corrected for ${record.operationalId}`, reason, { changedFields, srcConfirmationInvalidated: before.srcConfirmed, version: record.version });
          return { record: record as PassengerRecord, conflict: false };
        });
      } catch (error) {
        if (isSourceIdentityConflict(error)) throw new HttpError(409, "A passenger with this source identity already exists in the incident");
        throw error;
      }
    },

    async confirmSrc(context, passengerId, expectedVersion, basis, actor) {
      return client.$transaction(async (tx) => {
        const before = await tx.passengerRecord.findFirst({ where: { id: passengerId, sessionId: context.incidentId } });
        if (!before) return { record: null, conflict: false };
        if (before.srcConfirmed) throw new HttpError(409, "SRC is already confirmed for this passenger record");
        const changed = await tx.passengerRecord.updateMany({
          where: { id: passengerId, sessionId: context.incidentId, version: expectedVersion, srcConfirmed: false, session: { status: { notIn: ["Closed", "Archived"] } } },
          data: {
            srcConfirmed: true,
            srcConfirmedAt: new Date(),
            srcConfirmedById: context.actorId,
            srcConfirmationBasis: basis,
            updatedById: context.actorId,
            version: { increment: 1 }
          }
        });
        if (changed.count !== 1) return { record: null, conflict: true };
        const record = await tx.passengerRecord.findFirstOrThrow({ where: { id: passengerId, sessionId: context.incidentId } });
        await audit(tx, context, actor, record, "mark_src_confirmed", `Passenger/Crew record ${record.operationalId} marked SRC confirmed`, {
          basis,
          versionBefore: expectedVersion,
          versionAfter: record.version
        });
        await timeline(tx, context, record, `SRC confirmed for ${record.operationalId}`, basis, { srcConfirmed: true, version: record.version });
        return { record: record as PassengerRecord, conflict: false };
      });
    },

    async control(context, passengerId, field: PassengerControlledField, value, reason, expectedVersion, actor) {
      return client.$transaction(async (tx) => {
        const before = await tx.passengerRecord.findFirst({ where: { id: passengerId, sessionId: context.incidentId } });
        if (!before) return { record: null, conflict: false };
        const timestamp = new Date();
        const data: Prisma.PassengerRecordUncheckedUpdateManyInput = field === "conditionStatus"
          ? { conditionStatus: value, conditionUpdatedAt: timestamp, conditionUpdatedById: context.actorId, conditionBasis: reason }
          : { holdStatus: value, holdUpdatedAt: timestamp, holdUpdatedById: context.actorId, holdReason: reason };
        const changed = await tx.passengerRecord.updateMany({
          where: { id: passengerId, sessionId: context.incidentId, version: expectedVersion, session: { status: { notIn: ["Closed", "Archived"] } } },
          data: { ...data, updatedById: context.actorId, version: { increment: 1 } }
        });
        if (changed.count !== 1) return { record: null, conflict: true };
        const record = await tx.passengerRecord.findFirstOrThrow({ where: { id: passengerId, sessionId: context.incidentId } });
        const beforeValue = before[field];
        await audit(tx, context, actor, record, field === "conditionStatus" ? "change_passenger_condition" : "change_passenger_hold", `${record.operationalId} ${field} changed`, {
          field,
          before: beforeValue,
          after: value,
          reason,
          versionBefore: expectedVersion,
          versionAfter: record.version
        });
        await timeline(tx, context, record, `${record.operationalId}: ${field} changed to ${value}`, reason, { field, before: beforeValue, after: value, version: record.version });
        return { record: record as PassengerRecord, conflict: false };
      });
    },

    async importRecords(context, input, actor) {
      try {
        return await client.$transaction(async (tx) => {
          await assertWritable(tx, context.incidentId);
          const existingBatch = await tx.importBatch.findFirst({ where: { id: input.batchId, sessionId: context.incidentId } });
          if (existingBatch) throw new HttpError(409, "Import batch has already been confirmed");
          const batchStatus = input.invalidRecords > 0 ? "Imported with errors" : "Imported";
          await tx.importBatch.create({
            data: {
              id: input.batchId,
              operationalId: `IMP-${new Date().getFullYear()}-${input.batchId.replaceAll("-", "").slice(0, 12).toUpperCase()}`,
              sessionId: context.incidentId,
              importType: "manifest",
              sourceFilename: input.sourceFilename,
              status: batchStatus,
              totalRecords: input.totalRecords,
              validRecords: input.records.length,
              invalidRecords: input.invalidRecords,
              errors: input.errors as Prisma.InputJsonValue,
              createdById: context.actorId
            }
          });
          await createPassengerImportRecords(tx, {
            incidentId: context.incidentId,
            batchId: input.batchId,
            records: input.records,
            actorId: context.actorId
          });
          await tx.auditLog.create({
            data: {
              action: "import_passenger_manifest",
              entityType: "importBatch",
              entityId: input.batchId,
              sessionId: context.incidentId,
              actorId: context.actorId,
              actorEmail: actor.email,
              summary: `Imported manifest: ${input.records.length}/${input.totalRecords} valid`,
              metadata: jsonMetadata({
                sourceBatchId: input.batchId,
                sourceFilename: input.sourceFilename,
                totalRecords: input.totalRecords,
                validRecords: input.records.length,
                invalidRecords: input.invalidRecords,
                requestId: actor.requestId
              })
            }
          });
          await tx.caseTimelineEvent.create({
            data: {
              sessionId: context.incidentId,
              eventType: "passenger_import",
              entityType: "importBatch",
              entityId: input.batchId,
              title: `Passenger manifest imported (${input.records.length} records)`,
              metadata: { sourceBatchId: input.batchId, totalRecords: input.totalRecords, validRecords: input.records.length },
              createdById: context.actorId
            }
          });
          return {
            batchId: input.batchId,
            status: batchStatus,
            totalRecords: input.totalRecords,
            validRecords: input.records.length,
            invalidRecords: input.invalidRecords
          };
        });
      } catch (error) {
        if (isSourceIdentityConflict(error)) throw new HttpError(409, "The import contains a duplicate source identity for this incident");
        throw error;
      }
    }
  };
}
