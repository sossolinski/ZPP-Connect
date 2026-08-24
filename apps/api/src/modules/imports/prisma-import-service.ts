import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { HttpError } from "../../errors.js";
import { normalizeRow } from "../../exporters.js";
import { parseFamilyImportRow } from "../families/family-import.js";
import { createFamilyImportRecords } from "../families/prisma-family-repository.js";
import type { FamilyImportInput } from "../families/family-types.js";
import { parsePassengerManifestRow } from "../passengers/passenger-import.js";
import { createPassengerImportRecords } from "../passengers/prisma-passenger-repository.js";
import type { PassengerImportInput } from "../passengers/passenger-types.js";
import type {
  FoundationImportType,
  ImportActor,
  ImportAuthorizationContext,
  ImportFailureHooks,
  ImportValidationInput,
  ImportValidationStatus
} from "./import-types.js";

type Db = PrismaClient | Prisma.TransactionClient;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const terminalStatuses = new Set(["Imported", "Imported with errors"]);
const validatedStatuses = new Set(["Validated", "Validated with errors"]);
const rowWriteChunkSize = 500;

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function metadata(value: Record<string, unknown>): Prisma.InputJsonValue {
  return jsonValue(Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)));
}

function assertUuid(value: string) {
  if (!uuidPattern.test(value)) throw new HttpError(404, "Import batch not found");
}

function fingerprint(input: Pick<ImportValidationInput, "incidentId" | "importType" | "sourceSha256">) {
  return createHash("sha256")
    .update(input.incidentId)
    .update("\0")
    .update(input.importType)
    .update("\0")
    .update(input.sourceSha256)
    .digest("hex");
}

function operationalId(batchId: string, timestamp = new Date()) {
  return `IMP-${timestamp.getFullYear()}-${batchId.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
}

function importErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Invalid row";
}

function stripSessionId<T extends Record<string, unknown>>(row: T) {
  const { sessionId: _sessionId, ...payload } = row;
  return payload;
}

function validationSnapshot(input: ImportValidationInput) {
  const errors: Array<{ row: number; error: string }> = [];
  const rows = input.rows.map((rawRow, index) => {
    const rowNumber = index + 2;
    const normalizedRaw = normalizeRow(rawRow);
    try {
      const parsed = input.importType === "manifest"
        ? parsePassengerManifestRow(normalizedRaw, input.incidentId)
        : parseFamilyImportRow(normalizedRaw, input.incidentId);
      return {
        id: randomUUID(),
        rowNumber,
        validationStatus: "VALID" as const,
        normalizedPayload: jsonValue(stripSessionId(parsed)),
        errorCode: null,
        errorMessage: null
      };
    } catch (error) {
      const message = importErrorMessage(error);
      errors.push({ row: rowNumber, error: message });
      return {
        id: randomUUID(),
        rowNumber,
        validationStatus: "INVALID" as const,
        normalizedPayload: jsonValue(normalizedRaw),
        errorCode: "ROW_VALIDATION_ERROR",
        errorMessage: message
      };
    }
  });
  return {
    rows,
    errors,
    totalRecords: rows.length,
    validRecords: rows.length - errors.length,
    invalidRecords: errors.length,
    status: errors.length ? "Validated with errors" : "Validated"
  };
}

function asBatch(batch: {
  id: string;
  operationalId: string;
  sessionId: string | null;
  importType: string;
  sourceFilename: string | null;
  sourceMimeType: string | null;
  sourceSizeBytes: bigint | null;
  sourceSha256: string | null;
  status: string;
  totalRecords: number;
  validRecords: number;
  invalidRecords: number;
  errors: Prisma.JsonValue | null;
  version: number;
  validationOperationId: string | null;
  validatedAt: Date | null;
  validatedById: string | null;
  confirmedAt: Date | null;
  confirmedById: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...batch,
    sourceSizeBytes: batch.sourceSizeBytes === null ? null : Number(batch.sourceSizeBytes),
    sourceStored: false
  };
}

async function detail(db: Db, batchId: string) {
  const batch = await db.importBatch.findUnique({ where: { id: batchId } });
  if (!batch) throw new HttpError(404, "Import batch not found");
  return asBatch(batch);
}

async function preview(db: Db, batchId: string) {
  const rows = await db.importValidatedRow.findMany({ where: { importBatchId: batchId }, orderBy: { rowNumber: "asc" }, take: 10 });
  return rows.map((row) => ({
    row: row.rowNumber,
    status: row.validationStatus === "VALID" ? "valid" : "invalid",
    values: row.normalizedPayload,
    ...(row.errorMessage ? { error: row.errorMessage } : {})
  }));
}

function uniqueTarget(error: Prisma.PrismaClientKnownRequestError) {
  const target = error.meta?.target;
  return Array.isArray(target) ? target.map(String).join(",") : String(target ?? "");
}

function isValidationOperationConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && error.code === "P2002"
    && uniqueTarget(error).includes("validationOperationId");
}

function isPassengerSourceIdentityConflict(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") return false;
  const target = uniqueTarget(error);
  return target.includes("PassengerRecord_incident_source_external_unique")
    || (["sessionId", "source", "sourceExternalId"].every((field) => target.includes(field)));
}

function permissionsImportType(value: string): FoundationImportType | null {
  return value === "manifest" || value === "family" ? value : null;
}

function validatedPayloads(rows: Array<{ normalizedPayload: Prisma.JsonValue }>, importType: FoundationImportType, incidentId: string) {
  try {
    if (importType === "manifest") {
      return rows.map((row) => stripSessionId(parsePassengerManifestRow(row.normalizedPayload as Record<string, unknown>, incidentId))) as PassengerImportInput["records"];
    }
    return rows.map((row) => stripSessionId(parseFamilyImportRow(row.normalizedPayload as Record<string, unknown>, incidentId))) as FamilyImportInput["records"];
  } catch {
    throw new Error("Durable Import validation snapshot is invalid");
  }
}

export function createPrismaImportService(client: PrismaClient, hooks: ImportFailureHooks = {}) {
  return {
    kind: "postgres" as const,

    async authorizationContext(batchId: string): Promise<ImportAuthorizationContext> {
      assertUuid(batchId);
      const batch = await client.importBatch.findUnique({ where: { id: batchId }, select: { id: true, sessionId: true, importType: true, status: true } });
      const importType = batch ? permissionsImportType(batch.importType) : null;
      if (!batch || !batch.sessionId || !importType) throw new HttpError(404, "Import batch not found");
      return { id: batch.id, incidentId: batch.sessionId, importType, status: batch.status };
    },

    async validate(input: ImportValidationInput, actor: ImportActor) {
      const commandFingerprint = fingerprint(input);
      const snapshot = validationSnapshot(input);
      const batchId = randomUUID();
      const validatedAt = new Date();

      const recoverReplay = async () => {
        const existing = await client.importBatch.findUnique({ where: { validationOperationId: input.operationId } });
        if (!existing) return null;
        if (existing.validationFingerprint !== commandFingerprint) {
          throw new HttpError(409, "Validation operation ID is already bound to different import content");
        }
        return { ...(await detail(client, existing.id)), previewRows: await preview(client, existing.id), replayed: true };
      };

      const prior = await recoverReplay();
      if (prior) return prior;

      try {
        await client.$transaction(async (tx) => {
          const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>`
            SELECT "id", "status" FROM "Session"
            WHERE "id" = CAST(${input.incidentId} AS uuid)
            FOR UPDATE
          `;
          if (!locked[0]) throw new HttpError(404, "Incident not found");
          if (["Closed", "Archived"].includes(locked[0].status)) throw new HttpError(409, "The selected incident is read-only");

          const replay = await tx.importBatch.findUnique({ where: { validationOperationId: input.operationId } });
          if (replay) {
            if (replay.validationFingerprint !== commandFingerprint) {
              throw new HttpError(409, "Validation operation ID is already bound to different import content");
            }
            return;
          }

          await tx.importBatch.create({
            data: {
              id: batchId,
              operationalId: operationalId(batchId, validatedAt),
              sessionId: input.incidentId,
              importType: input.importType,
              sourceFilename: input.sourceFilename,
              sourceMimeType: input.sourceMimeType,
              sourceSizeBytes: BigInt(input.sourceSizeBytes),
              sourceSha256: input.sourceSha256,
              status: snapshot.status,
              totalRecords: snapshot.totalRecords,
              validRecords: snapshot.validRecords,
              invalidRecords: snapshot.invalidRecords,
              errors: jsonValue(snapshot.errors),
              validationOperationId: input.operationId,
              validationFingerprint: commandFingerprint,
              validatedAt,
              validatedById: actor.id,
              createdById: actor.id
            }
          });

          for (let offset = 0; offset < snapshot.rows.length; offset += rowWriteChunkSize) {
            const chunk = snapshot.rows.slice(offset, offset + rowWriteChunkSize);
            await tx.importValidatedRow.createMany({
              data: chunk.map((row) => ({ ...row, importBatchId: batchId }))
            });
            await hooks.duringValidatedRowWrite?.({ batchId, writtenRows: Math.min(offset + chunk.length, snapshot.rows.length), totalRows: snapshot.rows.length });
          }

          await hooks.beforeValidationAudit?.({ batchId });
          await tx.auditLog.create({
            data: {
              action: "validate_import",
              entityType: "importBatch",
              entityId: batchId,
              sessionId: input.incidentId,
              actorId: actor.id,
              actorEmail: actor.email,
              summary: `Validated ${input.importType}: ${snapshot.validRecords}/${snapshot.totalRecords} valid`,
              metadata: metadata({
                importBatchId: batchId,
                importType: input.importType,
                sourceFilename: input.sourceFilename,
                sourceSha256: input.sourceSha256,
                totalRecords: snapshot.totalRecords,
                validRecords: snapshot.validRecords,
                invalidRecords: snapshot.invalidRecords,
                operationId: input.operationId,
                requestId: actor.requestId
              })
            }
          });
        }, { timeout: 30_000 });
      } catch (error) {
        if (isValidationOperationConflict(error)) {
          const replay = await recoverReplay();
          if (replay) return replay;
        }
        throw error;
      }

      const committed = await client.importBatch.findUnique({ where: { validationOperationId: input.operationId } });
      if (!committed) throw new Error("Durable Import validation commit could not be reloaded");
      const replayed = committed.id !== batchId;
      if (committed.validationFingerprint !== commandFingerprint) {
        throw new HttpError(409, "Validation operation ID is already bound to different import content");
      }
      return { ...(await detail(client, committed.id)), previewRows: await preview(client, committed.id), replayed };
    },

    async get(batchId: string) {
      assertUuid(batchId);
      return detail(client, batchId);
    },

    async rows(batchId: string, query: { limit: number; offset: number; validationStatus?: ImportValidationStatus }) {
      assertUuid(batchId);
      const where = { importBatchId: batchId, validationStatus: query.validationStatus };
      const [total, data] = await Promise.all([
        client.importValidatedRow.count({ where }),
        client.importValidatedRow.findMany({ where, orderBy: { rowNumber: "asc" }, take: query.limit, skip: query.offset })
      ]);
      return {
        total,
        limit: query.limit,
        offset: query.offset,
        data: data.map((row) => ({
          id: row.id,
          importBatchId: row.importBatchId,
          rowNumber: row.rowNumber,
          validationStatus: row.validationStatus,
          normalizedPayload: row.normalizedPayload,
          errorCode: row.errorCode,
          errorMessage: row.errorMessage,
          createdAt: row.createdAt
        }))
      };
    },

    async list(incidentId: string, query: { limit: number; offset: number; importTypes: FoundationImportType[] }) {
      const where = { sessionId: incidentId, importType: { in: query.importTypes } };
      const [total, rows] = await Promise.all([
        client.importBatch.count({ where }),
        client.importBatch.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: query.limit, skip: query.offset })
      ]);
      return { total, limit: query.limit, offset: query.offset, data: rows.map(asBatch) };
    },

    async filesProjection(incidentId: string, query: { limit: number; offset: number; importTypes: FoundationImportType[] }) {
      const listed = await this.list(incidentId, query);
      return {
        ...listed,
        data: listed.data.map((batch) => ({
          id: batch.id,
          operationalId: batch.operationalId,
          sessionId: batch.sessionId,
          importBatchId: batch.id,
          fileName: batch.sourceFilename,
          mimeType: batch.sourceMimeType,
          sizeBytes: batch.sourceSizeBytes,
          sourceSha256: batch.sourceSha256,
          sourceStored: false,
          importBatch: batch,
          importStatus: batch.status,
          importType: batch.importType,
          totalRecords: batch.totalRecords,
          validRecords: batch.validRecords,
          invalidRecords: batch.invalidRecords,
          importErrors: batch.errors,
          createdAt: batch.createdAt,
          updatedAt: batch.updatedAt
        }))
      };
    },

    async confirm(batchId: string, actor: ImportActor) {
      assertUuid(batchId);
      const authorization = await this.authorizationContext(batchId);
      try {
        return await client.$transaction(async (tx) => {
          const lockedBatch = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "ImportBatch"
            WHERE "id" = CAST(${batchId} AS uuid)
            FOR UPDATE
          `;
          if (!lockedBatch[0]) throw new HttpError(404, "Import batch not found");
          const batch = await tx.importBatch.findUniqueOrThrow({ where: { id: batchId } });
          if (terminalStatuses.has(batch.status)) return { ...(await detail(tx, batchId)), replayed: true };
          if (!validatedStatuses.has(batch.status) || !batch.sessionId || !batch.validationOperationId || !batch.validatedAt) {
            throw new HttpError(409, "Import batch does not contain a confirmable durable validation snapshot");
          }
          const importType = permissionsImportType(batch.importType);
          if (!importType) throw new HttpError(409, "Import batch type is not supported");

          const lockedIncident = await tx.$queryRaw<Array<{ id: string; status: string }>>`
            SELECT "id", "status" FROM "Session"
            WHERE "id" = CAST(${batch.sessionId} AS uuid)
            FOR UPDATE
          `;
          if (!lockedIncident[0]) throw new HttpError(409, "Import incident no longer exists");
          if (["Closed", "Archived"].includes(lockedIncident[0].status)) throw new HttpError(409, "The selected incident is read-only");

          const [durableRows, rowCount] = await Promise.all([
            tx.importValidatedRow.findMany({ where: { importBatchId: batchId, validationStatus: "VALID" }, orderBy: { rowNumber: "asc" } }),
            tx.importValidatedRow.count({ where: { importBatchId: batchId } })
          ]);
          if (durableRows.length !== batch.validRecords || rowCount !== batch.totalRecords) {
            throw new Error(`Durable Import validation snapshot is incomplete for batch ${batchId}`);
          }
          const records = validatedPayloads(durableRows, importType, batch.sessionId);
          await hooks.beforeConfirmationTargetWrite?.({ batchId, importType });
          if (importType === "manifest") {
            await createPassengerImportRecords(tx, { incidentId: batch.sessionId, batchId, records: records as PassengerImportInput["records"], actorId: actor.id });
          } else {
            await createFamilyImportRecords(tx, { incidentId: batch.sessionId, batchId, records: records as FamilyImportInput["records"], actorId: actor.id });
          }
          await hooks.duringConfirmationTargetWrite?.({ batchId, importType });

          const finalStatus = batch.invalidRecords > 0 ? "Imported with errors" : "Imported";
          await hooks.beforeConfirmationAudit?.({ batchId, importType });
          await tx.auditLog.create({
            data: {
              action: importType === "manifest" ? "import_passenger_manifest" : "import_family_records",
              entityType: "importBatch",
              entityId: batchId,
              sessionId: batch.sessionId,
              actorId: actor.id,
              actorEmail: actor.email,
              summary: importType === "manifest"
                ? `Imported manifest: ${batch.validRecords}/${batch.totalRecords} valid`
                : `Imported Family/NOK records: ${batch.validRecords}/${batch.totalRecords} valid`,
              metadata: metadata({
                importBatchId: batchId,
                importType,
                sourceFilename: batch.sourceFilename,
                sourceSha256: batch.sourceSha256,
                totalRecords: batch.totalRecords,
                validRecords: batch.validRecords,
                invalidRecords: batch.invalidRecords,
                requestId: actor.requestId
              })
            }
          });
          await hooks.beforeConfirmationTimeline?.({ batchId, importType });
          await tx.caseTimelineEvent.create({
            data: {
              sessionId: batch.sessionId,
              eventType: importType === "manifest" ? "passenger_import" : "family_import",
              entityType: "importBatch",
              entityId: batchId,
              title: importType === "manifest"
                ? `Passenger manifest imported (${batch.validRecords} records)`
                : `Family/NOK records imported (${batch.validRecords} records)`,
              metadata: metadata({ importBatchId: batchId, totalRecords: batch.totalRecords, validRecords: batch.validRecords }),
              createdById: actor.id
            }
          });
          const confirmedAt = new Date();
          await tx.importBatch.update({
            where: { id: batchId },
            data: { status: finalStatus, confirmedAt, confirmedById: actor.id, version: { increment: 1 } }
          });
          return { ...(await detail(tx, batchId)), replayed: false };
        }, { timeout: 30_000 });
      } catch (error) {
        if (authorization.importType === "manifest" && isPassengerSourceIdentityConflict(error)) {
          throw new HttpError(409, "The import conflicts with an existing passenger source identity");
        }
        throw error;
      }
    }
  };
}

export type PrismaImportService = ReturnType<typeof createPrismaImportService>;
