import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { HttpError } from "../../errors.js";
import type { EvidenceArtifactStore } from "./evidence-storage.js";
import { evidenceCategories, evidenceStorageKey, sha256, unconfiguredEvidenceScanner, type EvidenceActor, type EvidenceCategory, type EvidenceScanner } from "./evidence-types.js";

const evidenceSelect = {
  id: true, operationalId: true, sessionId: true, originalFileName: true, fileName: true,
  mimeType: true, declaredMimeType: true, sizeBytes: true, contentSha256: true, category: true,
  description: true, status: true, scanStatus: true, version: true, createdAt: true,
  withdrawnAt: true, withdrawalReason: true,
  createdBy: { select: { id: true, displayName: true, email: true } },
  withdrawnBy: { select: { id: true, displayName: true, email: true } },
} satisfies Prisma.StoredFileSelect;

type EvidenceRow = Prisma.StoredFileGetPayload<{ select: typeof evidenceSelect }>;

function publicRecord(row: EvidenceRow) {
  return { ...row, sizeBytes: Number(row.sizeBytes) };
}

function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function jsonResult(row: EvidenceRow) {
  return publicRecord(row) as unknown as Prisma.InputJsonValue;
}

async function advisoryLock(tx: Prisma.TransactionClient, operationId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${operationId}, 0))::text AS lock_result`;
}

export function createPrismaEvidenceService(
  db: PrismaClient,
  store: EvidenceArtifactStore,
  scanner: EvidenceScanner = unconfiguredEvidenceScanner,
) {
  async function ensureRealIncident(sessionId: string, writable: boolean) {
    const session = await db.session.findUnique({ where: { id: sessionId }, select: { id: true, mode: true, status: true } });
    if (!session) throw new HttpError(404, "Incident not found");
    if (session.mode !== "REAL") throw new HttpError(409, "Evidence is available only for real incidents");
    if (writable && ["Closed", "Archived"].includes(session.status)) throw new HttpError(409, "The selected incident is read-only");
    return session;
  }

  async function nextOperationalId(tx: Prisma.TransactionClient) {
    const [row] = await tx.$queryRaw<Array<{ value: bigint }>>`SELECT nextval('"StoredFile_operational_seq"') AS value`;
    return `EVD-${new Date().getFullYear()}-${String(row!.value).padStart(6, "0")}`;
  }

  async function findOperation(tx: Prisma.TransactionClient, operationId: string, command: string, commandFingerprint: string) {
    const operation = await tx.storedFileOperation.findUnique({ where: { operationId } });
    if (!operation) return null;
    if (operation.command !== command || operation.commandFingerprint !== commandFingerprint) {
      throw new HttpError(409, "operationId was already used for a different evidence command");
    }
    return tx.storedFile.findUniqueOrThrow({ where: { id: operation.storedFileId }, select: evidenceSelect });
  }

  async function upload(input: {
    operationId: string;
    sessionId: string;
    originalFileName: string;
    fileName: string;
    mimeType: string;
    declaredMimeType: string;
    sizeBytes: number;
    contentSha256: string;
    category: EvidenceCategory;
    description: string | null;
    bytes: Buffer;
  }, actor: EvidenceActor, serializationRetry = 0) {
    await ensureRealIncident(input.sessionId, true);
    const commandFingerprint = fingerprint({
      command: "upload", operationId: input.operationId, sessionId: input.sessionId,
      originalFileName: input.originalFileName, fileName: input.fileName, mimeType: input.mimeType,
      declaredMimeType: input.declaredMimeType, sizeBytes: input.sizeBytes,
      contentSha256: input.contentSha256, category: input.category, description: input.description,
    });
    const storageKey = evidenceStorageKey(input.operationId);
    try {
      return await db.$transaction(async tx => {
        const transactionStore = store.inTransaction(tx);
        await advisoryLock(tx, input.operationId);
        const replay = await findOperation(tx, input.operationId, "upload", commandFingerprint);
        if (replay) {
          const artifact = await transactionStore.read(storageKey);
          if (!artifact || artifact.sizeBytes !== input.sizeBytes || artifact.contentSha256 !== input.contentSha256 || sha256(artifact.bytes) !== input.contentSha256) {
            throw new HttpError(500, "Evidence integrity verification failed");
          }
          return { ...publicRecord(replay), replayed: true };
        }

        const scan = await scanner.scan({ bytes: input.bytes, mimeType: input.mimeType, contentSha256: input.contentSha256 });
        await transactionStore.put({ storageKey, bytes: input.bytes, sizeBytes: input.sizeBytes, contentSha256: input.contentSha256 });
        const row = await tx.storedFile.create({ data: {
          id: input.operationId,
          operationalId: await nextOperationalId(tx),
          sessionId: input.sessionId,
          purpose: "INCIDENT_EVIDENCE",
          originalFileName: input.originalFileName,
          fileName: input.fileName,
          mimeType: input.mimeType,
          declaredMimeType: input.declaredMimeType,
          sizeBytes: input.sizeBytes,
          contentSha256: input.contentSha256,
          storageProvider: store.provider,
          storageKey,
          category: input.category,
          description: input.description,
          status: "Active",
          scanStatus: scan.status,
          version: 1,
          uploadOperationId: input.operationId,
          uploadFingerprint: commandFingerprint,
          requestId: actor.requestId ?? randomUUID(),
          createdById: actor.id,
        }, select: evidenceSelect });
        const result = publicRecord(row);
        await tx.storedFileOperation.create({ data: {
          operationId: input.operationId, storedFileId: row.id, command: "upload",
          commandFingerprint, resultVersion: row.version, result: result as unknown as Prisma.InputJsonValue,
          requestId: actor.requestId ?? randomUUID(),
        } });
        await tx.auditLog.create({ data: {
          action: "incident_evidence_uploaded", entityType: "StoredFile", entityId: row.id,
          sessionId: input.sessionId, actorId: actor.id, actorEmail: actor.email,
          summary: `Incident evidence ${row.operationalId} uploaded`,
          metadata: { operationalId: row.operationalId, category: row.category, mimeType: row.mimeType, sizeBytes: Number(row.sizeBytes), contentSha256: row.contentSha256, operationId: input.operationId, requestId: actor.requestId },
        } });
        await tx.caseTimelineEvent.create({ data: {
          sessionId: input.sessionId, eventType: "evidence", entityType: "StoredFile", entityId: row.id,
          title: `Evidence ${row.operationalId} uploaded`, body: row.description,
          metadata: { category: row.category, fileName: row.fileName, contentSha256: row.contentSha256 }, createdById: actor.id,
        } });
        return { ...result, replayed: false };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10_000, timeout: 30_000 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034" && serializationRetry < 3) {
        return upload(input, actor, serializationRetry + 1);
      }
      throw error;
    }
  }

  async function list(sessionId: string, query: { limit: number; offset: number; includeWithdrawn: boolean }) {
    await ensureRealIncident(sessionId, false);
    const where: Prisma.StoredFileWhereInput = {
      sessionId, purpose: "INCIDENT_EVIDENCE",
      ...(query.includeWithdrawn ? {} : { status: "Active" }),
    };
    const [data, total] = await Promise.all([
      db.storedFile.findMany({ where, select: evidenceSelect, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: query.limit, skip: query.offset }),
      db.storedFile.count({ where }),
    ]);
    return { data: data.map(publicRecord), total, limit: query.limit, offset: query.offset };
  }

  async function get(sessionId: string, evidenceId: string) {
    await ensureRealIncident(sessionId, false);
    const row = await db.storedFile.findFirst({ where: { id: evidenceId, sessionId, purpose: "INCIDENT_EVIDENCE" }, select: evidenceSelect });
    if (!row) throw new HttpError(404, "Evidence not found");
    return publicRecord(row);
  }

  async function download(sessionId: string, evidenceId: string, actor: EvidenceActor) {
    await ensureRealIncident(sessionId, false);
    const row = await db.storedFile.findFirst({ where: { id: evidenceId, sessionId, purpose: "INCIDENT_EVIDENCE" }, select: { ...evidenceSelect, storageKey: true } });
    if (!row) throw new HttpError(404, "Evidence not found");
    if (row.status !== "Active") throw new HttpError(409, "Withdrawn evidence is not available for download");
    const artifact = await store.read(row.storageKey);
    const valid = artifact && artifact.sizeBytes === Number(row.sizeBytes) && artifact.contentSha256 === row.contentSha256
      && artifact.bytes.length === Number(row.sizeBytes) && sha256(artifact.bytes) === row.contentSha256;
    if (!valid) {
      await db.auditLog.create({ data: {
        action: "incident_evidence_integrity_failure", entityType: "StoredFile", entityId: row.id,
        sessionId, actorId: actor.id, actorEmail: actor.email,
        summary: `Incident evidence ${row.operationalId} failed integrity verification`,
        metadata: { operationalId: row.operationalId, requestId: actor.requestId },
      } });
      throw new HttpError(500, "Evidence integrity verification failed");
    }
    await db.auditLog.create({ data: {
      action: "incident_evidence_downloaded", entityType: "StoredFile", entityId: row.id,
      sessionId, actorId: actor.id, actorEmail: actor.email,
      summary: `Incident evidence ${row.operationalId} downloaded`,
      metadata: { operationalId: row.operationalId, contentSha256: row.contentSha256, requestId: actor.requestId },
    } });
    return { record: publicRecord(row), bytes: artifact.bytes };
  }

  async function withdraw(input: { operationId: string; sessionId: string; evidenceId: string; expectedVersion: number; reason: string }, actor: EvidenceActor, serializationRetry = 0) {
    await ensureRealIncident(input.sessionId, true);
    const reason = input.reason.trim();
    const commandFingerprint = fingerprint({ command: "withdraw", ...input, reason });
    try {
      return await db.$transaction(async tx => {
        await advisoryLock(tx, input.operationId);
        const replay = await findOperation(tx, input.operationId, "withdraw", commandFingerprint);
        if (replay) return { ...publicRecord(replay), replayed: true };
        const current = await tx.storedFile.findFirst({ where: { id: input.evidenceId, sessionId: input.sessionId, purpose: "INCIDENT_EVIDENCE" }, select: evidenceSelect });
        if (!current) throw new HttpError(404, "Evidence not found");
        if (current.status === "Withdrawn") {
          if (current.withdrawalReason !== reason) throw new HttpError(409, "Evidence was already withdrawn with a different reason");
          return { ...publicRecord(current), replayed: true };
        }
        if (current.version !== input.expectedVersion) throw new HttpError(409, "Evidence version is stale");
        const row = await tx.storedFile.update({ where: { id: current.id }, data: {
          status: "Withdrawn", version: { increment: 1 }, withdrawnAt: new Date(), withdrawnById: actor.id, withdrawalReason: reason,
        }, select: evidenceSelect });
        const result = publicRecord(row);
        await tx.storedFileOperation.create({ data: {
          operationId: input.operationId, storedFileId: row.id, command: "withdraw", commandFingerprint,
          resultVersion: row.version, result: jsonResult(row), requestId: actor.requestId ?? randomUUID(),
        } });
        await tx.auditLog.create({ data: {
          action: "incident_evidence_withdrawn", entityType: "StoredFile", entityId: row.id,
          sessionId: input.sessionId, actorId: actor.id, actorEmail: actor.email,
          summary: `Incident evidence ${row.operationalId} withdrawn`,
          metadata: { operationalId: row.operationalId, reason, operationId: input.operationId, requestId: actor.requestId, resultVersion: row.version },
        } });
        await tx.caseTimelineEvent.create({ data: {
          sessionId: input.sessionId, eventType: "evidence", entityType: "StoredFile", entityId: row.id,
          title: `Evidence ${row.operationalId} withdrawn`, body: reason,
          metadata: { category: row.category, fileName: row.fileName }, createdById: actor.id,
        } });
        return { ...result, replayed: false };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10_000, timeout: 30_000 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034" && serializationRetry < 3) {
        return withdraw(input, actor, serializationRetry + 1);
      }
      throw error;
    }
  }

  return { kind: "postgres" as const, categories: evidenceCategories, upload, list, get, download, withdraw };
}

export type PrismaEvidenceService = ReturnType<typeof createPrismaEvidenceService>;
