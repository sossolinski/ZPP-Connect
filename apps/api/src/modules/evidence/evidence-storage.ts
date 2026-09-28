import { Prisma, type PrismaClient } from "@prisma/client";
import { HttpError } from "../../errors.js";
import { assertEvidenceStorageKey, sha256 } from "./evidence-types.js";

export type StoredEvidenceBytes = { storageKey: string; bytes: Buffer; sizeBytes: number; contentSha256: string };

export interface EvidenceArtifactStore {
  readonly provider: "postgres";
  put(input: StoredEvidenceBytes): Promise<{ created: boolean }>;
  read(storageKey: string): Promise<StoredEvidenceBytes | null>;
  removeIfUnreferenced(storageKey: string): Promise<void>;
}

export function createPrismaEvidenceArtifactStore(db: PrismaClient): EvidenceArtifactStore {
  return {
    provider: "postgres",

    async put(input) {
      assertEvidenceStorageKey(input.storageKey);
      if (input.bytes.length !== input.sizeBytes || sha256(input.bytes) !== input.contentSha256) {
        throw new Error("Evidence storage input failed integrity verification");
      }
      try {
        await db.storedArtifact.create({ data: {
          storageKey: input.storageKey,
          storageProvider: "postgres",
          sizeBytes: input.sizeBytes,
          contentSha256: input.contentSha256,
          content: new Uint8Array(input.bytes),
        } });
        return { created: true };
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
        const existing = await this.read(input.storageKey);
        if (!existing || existing.sizeBytes !== input.sizeBytes || existing.contentSha256 !== input.contentSha256 || !existing.bytes.equals(input.bytes)) {
          throw new HttpError(409, "Evidence operation conflicts with stored content");
        }
        return { created: false };
      }
    },

    async read(storageKey) {
      assertEvidenceStorageKey(storageKey);
      const row = await db.storedArtifact.findUnique({ where: { storageKey } });
      if (!row) return null;
      return { storageKey, bytes: Buffer.from(row.content), sizeBytes: Number(row.sizeBytes), contentSha256: row.contentSha256 };
    },

    async removeIfUnreferenced(storageKey) {
      assertEvidenceStorageKey(storageKey);
      await db.$transaction(async tx => {
        if (await tx.storedFile.count({ where: { purpose: "INCIDENT_EVIDENCE", storageKey } })) return;
        await tx.storedArtifact.deleteMany({ where: { storageKey } });
      });
    },
  };
}
