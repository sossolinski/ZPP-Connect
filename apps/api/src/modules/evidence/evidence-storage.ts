import type { Prisma, PrismaClient } from "@prisma/client";
import { HttpError } from "../../errors.js";
import { assertEvidenceStorageKey, sha256 } from "./evidence-types.js";

export type StoredEvidenceBytes = { storageKey: string; bytes: Buffer; sizeBytes: number; contentSha256: string };

export interface EvidenceArtifactStore {
  readonly provider: "postgres";
  put(input: StoredEvidenceBytes): Promise<{ created: boolean }>;
  read(storageKey: string): Promise<StoredEvidenceBytes | null>;
  inTransaction(transaction: Prisma.TransactionClient): EvidenceArtifactStore;
}

export function createPrismaEvidenceArtifactStore(db: PrismaClient): EvidenceArtifactStore {
  return createStore(db);
}

function createStore(db: PrismaClient | Prisma.TransactionClient): EvidenceArtifactStore {
  return {
    provider: "postgres",

    inTransaction(transaction) {
      return createStore(transaction);
    },

    async put(input) {
      assertEvidenceStorageKey(input.storageKey);
      if (input.bytes.length !== input.sizeBytes || sha256(input.bytes) !== input.contentSha256) {
        throw new Error("Evidence storage input failed integrity verification");
      }
      // A caught unique violation still aborts a PostgreSQL transaction. Insert
      // without raising that violation so replay verification uses a live transaction;
      // serializable conflicts remain visible to the service's existing retry loop.
      const inserted = await db.storedArtifact.createMany({ data: [{
        storageKey: input.storageKey,
        storageProvider: "postgres",
        sizeBytes: input.sizeBytes,
        contentSha256: input.contentSha256,
        content: new Uint8Array(input.bytes),
      }], skipDuplicates: true });
      if (inserted.count === 1) return { created: true };
      const existing = await this.read(input.storageKey);
      if (!existing || existing.sizeBytes !== input.sizeBytes || existing.contentSha256 !== input.contentSha256 || !existing.bytes.equals(input.bytes)) {
        throw new HttpError(409, "Evidence operation conflicts with stored content");
      }
      return { created: false };
    },

    async read(storageKey) {
      assertEvidenceStorageKey(storageKey);
      const row = await db.storedArtifact.findUnique({ where: { storageKey } });
      if (!row) return null;
      return { storageKey, bytes: Buffer.from(row.content), sizeBytes: Number(row.sizeBytes), contentSha256: row.contentSha256 };
    },
  };
}
