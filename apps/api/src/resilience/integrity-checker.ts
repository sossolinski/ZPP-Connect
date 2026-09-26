import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { contentDigest, sha256, versionInclude } from "../modules/after-action-reports/after-action-report-types.js";
import { migrationState, repositoryMigrationNames } from "./resilience-tooling.js";

export type IntegrityFailure = { check: string; recordId?: string; message: string };

export type IntegrityReport = {
  status: "pass" | "fail";
  checkedAt: string;
  durationMs: number;
  limit: number;
  counts: {
    migrations: number;
    constraints: number;
    approvedAarVersions: number;
    aarPdfArtifacts: number;
    publishedInternalDocuments: number;
    documentAcknowledgements: number;
  };
  failures: IntegrityFailure[];
};

function digestText(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fail(failures: IntegrityFailure[], check: string, message: string, recordId?: string) {
  if (failures.length < 100) failures.push({ check, message, ...(recordId ? { recordId } : {}) });
}

async function boundedCount(name: string, count: number, limit: number) {
  if (count > limit) throw new Error(`${name} contains ${count} rows, exceeding INTEGRITY_MAX_ROWS=${limit}; increase the explicit bound to scan all rows`);
}

export async function runIntegrityCheck(databaseUrl: string, limit = 10_000): Promise<IntegrityReport> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000_000) throw new Error("Integrity row limit must be between 1 and 1000000");
  const started = Date.now();
  const checkedAt = new Date().toISOString();
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const failures: IntegrityFailure[] = [];
  try {
    const migrations = await migrationState(db);
    const expectedMigrations = await repositoryMigrationNames();
    const appliedNames = migrations.map((item) => item.migrationName).sort();
    if (JSON.stringify(appliedNames) !== JSON.stringify(expectedMigrations)) {
      fail(failures, "prisma-migrations", "Applied migrations do not match this application checkout");
    }

    const invalidConstraints = await db.$queryRawUnsafe<Array<{ table_name: string; constraint_name: string }>>(
      `SELECT conrelid::regclass::text AS table_name, conname AS constraint_name
       FROM pg_constraint
       WHERE connamespace = 'public'::regnamespace AND NOT convalidated
       ORDER BY conrelid::regclass::text, conname`,
    );
    for (const row of invalidConstraints) fail(failures, "postgres-constraint", `Constraint ${row.constraint_name} on ${row.table_name} is not validated`);
    const invalidIndexes = await db.$queryRawUnsafe<Array<{ index_name: string }>>(
      `SELECT indexrelid::regclass::text AS index_name FROM pg_index WHERE NOT indisvalid ORDER BY indexrelid::regclass::text`,
    );
    for (const row of invalidIndexes) fail(failures, "postgres-index", `Index ${row.index_name} is invalid`);

    const [approvedCount, artifactCount, documentCount, acknowledgementCount] = await Promise.all([
      db.afterActionReportVersion.count({ where: { status: "Approved" } }),
      db.afterActionPdfArtifact.count(),
      db.documentVersion.count({ where: { status: "Published", contentMode: "Internal text" } }),
      db.documentAcknowledgement.count({ where: { contentDigestSnapshot: { not: null } } }),
    ]);
    await Promise.all([
      boundedCount("Approved AAR versions", approvedCount, limit),
      boundedCount("AAR PDF artifacts", artifactCount, limit),
      boundedCount("Published internal Document versions", documentCount, limit),
      boundedCount("Document acknowledgements", acknowledgementCount, limit),
    ]);

    const approved = await db.afterActionReportVersion.findMany({ where: { status: "Approved" }, include: versionInclude, orderBy: { id: "asc" }, take: limit + 1 });
    const approvedById = new Map(approved.map((row) => [row.id, row]));
    for (const version of approved) {
      if (!version.contentSha256 || contentDigest(version) !== version.contentSha256) {
        fail(failures, "aar-logical-digest", "Approved AAR logical digest does not match canonical content", version.id);
      }
    }

    const artifacts = await db.afterActionPdfArtifact.findMany({ orderBy: { id: "asc" }, take: limit + 1 });
    for (const artifact of artifacts) {
      const bytes = Buffer.from(artifact.content);
      if (bytes.length !== Number(artifact.contentSizeBytes)) fail(failures, "aar-pdf-size", "AAR PDF byte length does not match metadata", artifact.id);
      if (sha256(bytes) !== artifact.contentSha256) fail(failures, "aar-pdf-digest", "AAR PDF SHA-256 does not match retained bytes", artifact.id);
      const version = approvedById.get(artifact.reportVersionId);
      if (!version) fail(failures, "aar-pdf-source", "AAR PDF does not reference an inspected Approved version", artifact.id);
      else if (artifact.sourceContentSha256 !== version.contentSha256) fail(failures, "aar-pdf-source", "AAR PDF source digest does not match Approved version", artifact.id);
    }

    const documents = await db.documentVersion.findMany({
      where: { status: "Published", contentMode: "Internal text" },
      select: { id: true, contentBody: true, contentDigest: true }, orderBy: { id: "asc" }, take: limit + 1,
    });
    const documentDigestById = new Map<string, string | null>();
    for (const document of documents) {
      const computed = document.contentBody === null ? null : digestText(document.contentBody);
      documentDigestById.set(document.id, document.contentDigest);
      if (!computed || computed !== document.contentDigest) fail(failures, "document-content-digest", "Published internal Document digest does not match content", document.id);
    }

    const acknowledgements = await db.documentAcknowledgement.findMany({
      where: { contentDigestSnapshot: { not: null } },
      select: { id: true, documentVersionId: true, contentDigestSnapshot: true }, orderBy: { id: "asc" }, take: limit + 1,
    });
    const missingVersionIds = [...new Set(acknowledgements.map((row) => row.documentVersionId).filter((id) => !documentDigestById.has(id)))];
    if (missingVersionIds.length) {
      const referenced = await db.documentVersion.findMany({ where: { id: { in: missingVersionIds } }, select: { id: true, contentDigest: true } });
      for (const row of referenced) documentDigestById.set(row.id, row.contentDigest);
    }
    for (const acknowledgement of acknowledgements) {
      if (documentDigestById.get(acknowledgement.documentVersionId) !== acknowledgement.contentDigestSnapshot) {
        fail(failures, "document-acknowledgement-digest", "Acknowledgement digest snapshot does not match referenced Document version", acknowledgement.id);
      }
    }

    return {
      status: failures.length ? "fail" : "pass", checkedAt, durationMs: Date.now() - started, limit,
      counts: {
        migrations: migrations.length,
        constraints: invalidConstraints.length + invalidIndexes.length,
        approvedAarVersions: approvedCount,
        aarPdfArtifacts: artifactCount,
        publishedInternalDocuments: documentCount,
        documentAcknowledgements: acknowledgementCount,
      },
      failures,
    };
  } finally { await db.$disconnect(); }
}

export async function assertIntegrity(databaseUrl: string, limit = 10_000) {
  const report = await runIntegrityCheck(databaseUrl, limit);
  if (report.status !== "pass") throw new Error(`Application integrity verification failed with ${report.failures.length} reported violation(s)`);
  return report;
}
