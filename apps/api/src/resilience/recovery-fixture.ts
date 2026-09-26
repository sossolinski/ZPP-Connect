import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createPrismaAfterActionReportService } from "../modules/after-action-reports/prisma-after-action-report-service.js";

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
    status: "Closed",
    eventType: "Stage 23 recovery fixture",
    description: "Synthetic recovery rehearsal incident",
    startAt: new Date("2026-09-23T10:00:00.000Z"),
    endAt: occurredAt,
    createdById: actorRow.id,
    closedById: actorRow.id,
  } });
  await db.incidentAssignment.create({ data: {
    incidentId: session.id,
    userId: actorRow.id,
    function: "Stage 23 recovery operator",
    createdById: actorRow.id,
  } });
  await db.auditLog.create({ data: {
    action: "stage23_recovery_fixture_created",
    entityType: "session",
    entityId: session.id,
    sessionId: session.id,
    actorId: actorRow.id,
    actorEmail: actorRow.email,
    summary: "Synthetic Stage 23 recovery fixture created",
    metadata: { marker, synthetic: true },
  } });

  const actor = { id: actorRow.id, email: actorRow.email, displayName: actorRow.displayName, requestId: `stage23-${marker}` };
  const service = createPrismaAfterActionReportService(db);
  const created = await service.create({
    operationId: randomUUID(), sessionId: session.id, title: `Recovery report ${marker}`, eventDate: occurredAt.toISOString(), sourceObservationIds: [],
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
    sourceObservationIds: [],
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
  };
}
