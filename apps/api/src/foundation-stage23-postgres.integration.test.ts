import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runIntegrityCheck } from "./resilience/integrity-checker.js";
import { createRecoveryFixture } from "./resilience/recovery-fixture.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const db = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;
const describePostgres = databaseUrl ? describe : describe.skip;
let fixture: Awaited<ReturnType<typeof createRecoveryFixture>>;

describePostgres("Foundation Stage 23 PostgreSQL integrity", () => {
  beforeAll(async () => {
    const previous = process.env.STAGE23_ALLOW_RECOVERY;
    process.env.STAGE23_ALLOW_RECOVERY = "true";
    try { fixture = await createRecoveryFixture(db!); }
    finally {
      if (previous === undefined) delete process.env.STAGE23_ALLOW_RECOVERY;
      else process.env.STAGE23_ALLOW_RECOVERY = previous;
    }
  });

  afterAll(async () => { await db?.$disconnect(); });

  it("verifies migrations, constraints and critical application digests", async () => {
    const report = await runIntegrityCheck(databaseUrl!, 20_000);
    expect(report.status).toBe("pass");
    expect(report.failures).toEqual([]);
    expect(report.counts.migrations).toBe(23);
    expect(report.counts.approvedAarVersions).toBeGreaterThan(0);
    expect(report.counts.aarPdfArtifacts).toBeGreaterThan(0);
  });

  it("detects retained AAR PDF byte corruption and succeeds after exact repair", async () => {
    const artifact = await db!.afterActionPdfArtifact.findUniqueOrThrow({ where: { id: fixture.artifactId } });
    const corrupt = Buffer.from(artifact.content);
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 0xff;
    try {
      await db!.$executeRawUnsafe(`SET session_replication_role = 'replica'`);
      await db!.afterActionPdfArtifact.update({ where: { id: artifact.id }, data: { content: corrupt } });
      await db!.$executeRawUnsafe(`SET session_replication_role = 'origin'`);
      const report = await runIntegrityCheck(databaseUrl!, 20_000);
      expect(report.status).toBe("fail");
      expect(report.failures).toContainEqual(expect.objectContaining({ check: "aar-pdf-digest", recordId: artifact.id }));
    } finally {
      await db!.$executeRawUnsafe(`SET session_replication_role = 'replica'`);
      await db!.afterActionPdfArtifact.update({ where: { id: artifact.id }, data: { content: artifact.content } });
      await db!.$executeRawUnsafe(`SET session_replication_role = 'origin'`);
    }
    expect((await runIntegrityCheck(databaseUrl!, 20_000)).status).toBe("pass");
  });

  it("detects approved AAR logical corruption and succeeds after exact repair", async () => {
    const version = await db!.afterActionReportVersion.findUniqueOrThrow({ where: { id: fixture.reportVersionId } });
    try {
      await db!.$executeRawUnsafe(`SET session_replication_role = 'replica'`);
      await db!.afterActionReportVersion.update({ where: { id: version.id }, data: { executiveSummary: version.executiveSummary + " CORRUPTED" } });
      await db!.$executeRawUnsafe(`SET session_replication_role = 'origin'`);
      const report = await runIntegrityCheck(databaseUrl!, 20_000);
      expect(report.status).toBe("fail");
      expect(report.failures).toContainEqual(expect.objectContaining({ check: "aar-logical-digest", recordId: version.id }));
    } finally {
      await db!.$executeRawUnsafe(`SET session_replication_role = 'replica'`);
      await db!.afterActionReportVersion.update({ where: { id: version.id }, data: { executiveSummary: version.executiveSummary } });
      await db!.$executeRawUnsafe(`SET session_replication_role = 'origin'`);
    }
    expect((await runIntegrityCheck(databaseUrl!, 20_000)).status).toBe("pass");
  });

  it("detects published Document digest corruption and succeeds after exact repair", async () => {
    const version = await db!.documentVersion.findFirstOrThrow({ where: { status: "Published", contentMode: "Internal text", contentBody: { not: null }, contentDigest: { not: null } } });
    const originalDigest = version.contentDigest!;
    try {
      await db!.$executeRawUnsafe(`SET session_replication_role = 'replica'`);
      await db!.documentVersion.update({ where: { id: version.id }, data: { contentDigest: "0".repeat(64) } });
      await db!.$executeRawUnsafe(`SET session_replication_role = 'origin'`);
      const report = await runIntegrityCheck(databaseUrl!, 20_000);
      expect(report.status).toBe("fail");
      expect(report.failures).toContainEqual(expect.objectContaining({ check: "document-content-digest", recordId: version.id }));
    } finally {
      await db!.$executeRawUnsafe(`SET session_replication_role = 'replica'`);
      await db!.documentVersion.update({ where: { id: version.id }, data: { contentDigest: originalDigest } });
      await db!.$executeRawUnsafe(`SET session_replication_role = 'origin'`);
    }
    expect((await runIntegrityCheck(databaseUrl!, 20_000)).status).toBe("pass");
  });
});
