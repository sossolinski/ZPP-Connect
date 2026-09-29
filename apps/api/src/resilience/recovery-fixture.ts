import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createPrismaAfterActionReportService } from "../modules/after-action-reports/prisma-after-action-report-service.js";
import { createPrismaEvidenceArtifactStore } from "../modules/evidence/evidence-storage.js";
import { validateEvidenceUpload } from "../modules/evidence/evidence-types.js";
import { createPrismaEvidenceService } from "../modules/evidence/prisma-evidence-service.js";

export async function createRecoveryFixture(db: PrismaClient) {
  if (process.env.NODE_ENV !== "test" || process.env.STAGE23_ALLOW_RECOVERY !== "true") {
    throw new Error("Stage 23 recovery fixture is restricted to an explicitly enabled test environment");
  }
  const actorRow = await db.user.findUnique({ where: { email: "coordinator@lot.pl" } });
  if (!actorRow) throw new Error("Canonical coordinator seed identity is missing");
  const marker = randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase();
  const occurredAt = new Date("2026-09-23T12:00:00.000Z");
  const session = await db.session.create({ data: {
    operationalId: `RECOVERY-${marker}`,
    mode: "REAL",
    status: "Draft",
    eventType: "Stage 25 recovery fixture",
    description: "Synthetic recovery rehearsal incident",
    startAt: new Date("2026-09-23T10:00:00.000Z"),
    createdById: actorRow.id,
  } });
  await db.incidentAssignment.create({ data: {
    incidentId: session.id,
    userId: actorRow.id,
    function: "Stage 25 recovery operator",
    createdById: actorRow.id,
  } });
  await db.auditLog.create({ data: {
    action: "stage25_recovery_fixture_created",
    entityType: "session",
    entityId: session.id,
    sessionId: session.id,
    actorId: actorRow.id,
    actorEmail: actorRow.email,
    summary: "Synthetic Stage 25 recovery fixture created",
    metadata: { marker, synthetic: true },
  } });

  const actor = { id: actorRow.id, email: actorRow.email, displayName: actorRow.displayName, requestId: `stage25-${marker}` };
  const evidenceBytes = Buffer.from(`%PDF-1.4\n% ZPP Connect recovery evidence ${marker}\n%%EOF\n`, "utf8");
  const evidenceInput = validateEvidenceUpload({
    bytes: evidenceBytes, originalName: `recovery-evidence-${marker}.pdf`,
    declaredMimeType: "application/pdf", maxBytes: 10 * 1024 * 1024,
  });
  const evidence = await createPrismaEvidenceService(db, createPrismaEvidenceArtifactStore(db)).upload({
    operationId: randomUUID(), sessionId: session.id, category: "Operational evidence",
    description: "Synthetic retained evidence used to prove metadata and byte recovery.",
    bytes: evidenceBytes, ...evidenceInput,
  }, actor);
  await db.session.update({ where: { id: session.id }, data: { status: "Closed", endAt: occurredAt, closedById: actorRow.id } });
  const service = createPrismaAfterActionReportService(db);
  const created = await service.create({
    operationId: randomUUID(), sessionId: session.id, title: `Recovery report ${marker}`, eventDate: occurredAt.toISOString(),
  }, actor);
  const versionId = created.reportVersionId!;
  const edited = await service.edit(versionId, {
    expectedVersion: created.version,
    title: `Recovery report ${marker}`,
    eventDate: occurredAt.toISOString(),
    executiveSummary: "Synthetic closed incident used to prove database and artifact recovery.",
    findings: [{ area: "Platform resilience", summary: "Recovery must verify meaningful application records and retained bytes.", detail: "This fixture contains no production data." }],
    lessons: [{ statement: "A dump is useful only when a clean restore and application integrity verification succeed." }],
    correctiveActions: [{ recommendation: "Continue automated recovery rehearsals.", owner: "Platform operator", targetDate: null }],
  }, actor);
  const submitted = await service.transition(versionId, "submit", { operationId: randomUUID(), expectedVersion: edited.version }, actor);
  const approved = await service.transition(versionId, "approve", { operationId: randomUUID(), expectedVersion: submitted.version }, actor);
  const generated = await service.generatePdf(versionId, { operationId: randomUUID(), expectedVersion: approved.version }, actor);
  const artifact = await db.afterActionPdfArtifact.findUniqueOrThrow({ where: { id: generated.artifactId! } });
  return {
    marker,
    sessionId: session.id,
    reportId: created.reportId,
    reportVersionId: versionId,
    artifactId: artifact.id,
    artifactSha256: artifact.contentSha256,
    artifactSizeBytes: Number(artifact.contentSizeBytes),
    evidenceId: evidence.id,
    evidenceSha256: evidence.contentSha256,
    evidenceSizeBytes: evidence.sizeBytes,
  };
}
