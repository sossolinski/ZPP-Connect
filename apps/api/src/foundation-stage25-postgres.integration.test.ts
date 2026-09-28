import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSharedApp } from "./test-support/listening-test-app.js";
import { runIntegrityCheck } from "./resilience/integrity-checker.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const pg = databaseUrl ? describe : describe.skip;
const db = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;

pg("Foundation Stage 25 secure real-incident evidence", () => {
  const marker = `F25-${randomUUID().slice(0, 8)}`;
  const app = () => createSharedApp();
  const as = (email = "coordinator@lot.pl") => ({ "x-user-email": email });
  const pdf = (label = marker) => Buffer.from(`%PDF-1.4\n% ${label}\n%%EOF\n`, "utf8");
  let coordinator: { id: string; email: string };
  let firstIncident: { id: string };
  let secondIncident: { id: string };
  let limitedEmail: string;

  async function incident(mode = "REAL", status = "Draft") {
    const record = await db!.session.create({ data: {
      operationalId: `${marker}-${mode}-${randomUUID()}`, mode, status,
      eventType: "Secure evidence integration", createdById: coordinator.id,
    } });
    await db!.incidentAssignment.create({ data: { incidentId: record.id, userId: coordinator.id, function: marker, createdById: coordinator.id } });
    return record;
  }

  async function upload(sessionId: string, operationId = randomUUID(), name = "incident evidence.pdf", content = pdf()) {
    return request(app()).post(`/api/sessions/${sessionId}/evidence`).set(as())
      .field("operationId", operationId).field("category", "Operational evidence").field("description", "Verified source material")
      .attach("file", content, { filename: name, contentType: "application/pdf" });
  }

  beforeAll(async () => {
    coordinator = await db!.user.findUniqueOrThrow({ where: { email: "coordinator@lot.pl" }, select: { id: true, email: true } });
    firstIncident = await db!.session.findFirstOrThrow({ where: { mode: "REAL", status: "Active" }, select: { id: true } });
    secondIncident = await incident();
    limitedEmail = `${marker.toLowerCase()}@example.test`;
    const role = await db!.role.create({ data: {
      name: `${marker}-evidence-reader`, normalizedName: `${marker.toLowerCase()}-evidence-reader`, displayName: "Scoped evidence reader",
      permissions: ["session:read", "evidence:read"], scopeTypes: ["GLOBAL"], custom: true,
    } });
    const limited = await db!.user.create({ data: {
      email: limitedEmail, normalizedEmail: limitedEmail, displayName: "Scoped evidence reader",
      roles: { create: { roleId: role.id, scopeType: "GLOBAL", assignedBy: coordinator.id } },
    } });
    await db!.incidentAssignment.create({ data: { incidentId: firstIncident.id, userId: limited.id, function: "Evidence review", createdById: coordinator.id } });
  });

  afterAll(async () => db?.$disconnect());

  it("persists authoritative metadata and exact bytes with durable upload replay", async () => {
    const operationId = randomUUID();
    const first = await upload(firstIncident.id, operationId, "folder/zażółć report.pdf");
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ sessionId: firstIncident.id, category: "Operational evidence", status: "Active", scanStatus: "NOT_CONFIGURED", version: 1, replayed: false });
    expect(first.body).not.toHaveProperty("storageKey");
    const replay = await upload(firstIncident.id, operationId, "folder/zażółć report.pdf");
    expect(replay.status).toBe(200); expect(replay.body).toMatchObject({ id: first.body.id, replayed: true });
    expect(await db!.storedFile.count({ where: { uploadOperationId: operationId } })).toBe(1);
    const artifact = await db!.storedArtifact.findUniqueOrThrow({ where: { storageKey: `incident-evidence/${operationId}` } });
    expect(Buffer.from(artifact.content)).toEqual(pdf());
  });

  it("handles concurrent upload retry once and rejects operation reuse", async () => {
    const operationId = randomUUID();
    const responses = await Promise.all([upload(firstIncident.id, operationId), upload(firstIncident.id, operationId)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 201]);
    expect(responses[0]!.body.id).toBe(responses[1]!.body.id);
    const conflict = await upload(firstIncident.id, operationId, "different.pdf", pdf("different"));
    expect(conflict.status).toBe(409);
  });

  it.each(["TRAINING", "EXERCISE"])("rejects new evidence for retained %s sessions", async mode => {
    const historical = await incident(mode);
    expect((await upload(historical.id)).status).toBe(409);
    expect((await request(app()).get(`/api/sessions/${historical.id}/evidence`).set(as())).status).toBe(409);
  });

  it("enforces incident-scoped direct-object access for list, metadata and download", async () => {
    const retained = await upload(firstIncident.id);
    expect((await request(app()).get(`/api/sessions/${firstIncident.id}/evidence`).set(as(limitedEmail))).status).toBe(200);
    expect((await request(app()).get(`/api/sessions/${secondIncident.id}/evidence`).set(as(limitedEmail))).status).toBe(403);
    expect((await request(app()).get(`/api/sessions/${secondIncident.id}/evidence/${retained.body.id}`).set(as(limitedEmail))).status).toBe(403);
    expect((await request(app()).get(`/api/sessions/${secondIncident.id}/evidence/${retained.body.id}/download`).set(as(limitedEmail))).status).toBe(403);
  });

  it("serves only integrity-verified bytes with safe headers and audits access", async () => {
    const retained = await upload(firstIncident.id, randomUUID(), 'unsafe "quoted" report.pdf');
    const download = await request(app()).get(`/api/sessions/${firstIncident.id}/evidence/${retained.body.id}/download`).set(as());
    expect(download.status).toBe(200); expect(Buffer.from(download.body)).toEqual(pdf());
    expect(download.headers["x-content-sha256"]).toBe(retained.body.contentSha256);
    expect(download.headers["content-disposition"]).not.toContain("\r"); expect(download.headers["content-disposition"]).not.toContain("\n");
    expect(await db!.auditLog.count({ where: { entityId: retained.body.id, action: "incident_evidence_downloaded" } })).toBe(1);
  });

  it("withdraws idempotently without deleting metadata or bytes and excludes tombstones by default", async () => {
    const retained = await upload(firstIncident.id);
    const operationId = randomUUID();
    const body = { operationId, expectedVersion: 1, reason: "Incorrect source supplied" };
    const first = await request(app()).post(`/api/sessions/${firstIncident.id}/evidence/${retained.body.id}/withdraw`).set(as()).send(body);
    expect(first.status).toBe(200); expect(first.body).toMatchObject({ status: "Withdrawn", version: 2, replayed: false });
    const replay = await request(app()).post(`/api/sessions/${firstIncident.id}/evidence/${retained.body.id}/withdraw`).set(as()).send(body);
    expect(replay.body).toMatchObject({ status: "Withdrawn", version: 2, replayed: true });
    expect((await request(app()).get(`/api/sessions/${firstIncident.id}/evidence/${retained.body.id}/download`).set(as())).status).toBe(409);
    const active = await request(app()).get(`/api/sessions/${firstIncident.id}/evidence`).set(as());
    expect(active.body.data.some((row: { id: string }) => row.id === retained.body.id)).toBe(false);
    const history = await request(app()).get(`/api/sessions/${firstIncident.id}/evidence`).query({ includeWithdrawn: true }).set(as());
    expect(history.body.data.some((row: { id: string }) => row.id === retained.body.id)).toBe(true);
    expect(await db!.storedArtifact.findUnique({ where: { storageKey: `incident-evidence/${retained.body.id}` } })).not.toBeNull();
    expect(await db!.auditLog.count({ where: { entityId: retained.body.id, action: "incident_evidence_withdrawn" } })).toBe(1);
  });

  it("rejects MIME spoofing, executables, malformed payloads and configured-size excess", async () => {
    const base = `/api/sessions/${firstIncident.id}/evidence`;
    expect((await request(app()).post(base).set(as()).field("operationId", randomUUID()).field("category", "Reference").attach("file", Buffer.from("MZprogram"), { filename: "malware.pdf", contentType: "application/pdf" })).status).toBe(400);
    expect((await request(app()).post(base).set(as()).field("operationId", randomUUID()).field("category", "Reference").attach("file", Buffer.from("plain text"), { filename: "spoof.pdf", contentType: "application/pdf" })).status).toBe(400);
    expect((await request(app()).post(base).set(as()).field("operationId", randomUUID())).status).toBe(400);
  });

  it("paginates deterministically and records upload timeline/audit provenance", async () => {
    await Promise.all([upload(secondIncident.id), upload(secondIncident.id), upload(secondIncident.id)]);
    const page = await request(app()).get(`/api/sessions/${secondIncident.id}/evidence`).query({ limit: 2, offset: 1 }).set(as());
    expect(page.status).toBe(200); expect(page.body.limit).toBe(2); expect(page.body.offset).toBe(1); expect(page.body.total).toBeGreaterThanOrEqual(3); expect(page.body.data).toHaveLength(2);
    const id = page.body.data[0].id;
    expect(await db!.auditLog.count({ where: { entityId: id, action: "incident_evidence_uploaded" } })).toBe(1);
    expect(await db!.caseTimelineEvent.count({ where: { entityId: id, eventType: "evidence" } })).toBe(1);
  });

  it("detects corrupt, missing and metadata-mismatched evidence and never serves it", async () => {
    const retained = await upload(firstIncident.id);
    const row = await db!.storedFile.findUniqueOrThrow({ where: { id: retained.body.id } });
    const artifact = await db!.storedArtifact.findUniqueOrThrow({ where: { storageKey: row.storageKey } });
    await db!.$executeRawUnsafe('ALTER TABLE "StoredArtifact" DISABLE TRIGGER USER');
    try {
      await db!.$executeRaw`UPDATE "StoredArtifact" SET "content" = set_byte("content", 0, 0) WHERE "storageKey" = ${row.storageKey}`;
      expect((await request(app()).get(`/api/sessions/${firstIncident.id}/evidence/${row.id}/download`).set(as())).status).toBe(500);
      expect((await runIntegrityCheck(databaseUrl!)).failures.some(failure => failure.check === "evidence-digest" && failure.recordId === row.id)).toBe(true);
      await db!.storedArtifact.update({ where: { storageKey: row.storageKey }, data: { content: artifact.content } });
      await db!.storedArtifact.delete({ where: { storageKey: row.storageKey } });
      expect((await request(app()).get(`/api/sessions/${firstIncident.id}/evidence/${row.id}/download`).set(as())).status).toBe(500);
      expect((await runIntegrityCheck(databaseUrl!)).failures.some(failure => failure.check === "evidence-artifact-missing" && failure.recordId === row.id)).toBe(true);
      await db!.storedArtifact.create({ data: artifact });
    } finally {
      await db!.$executeRawUnsafe('ALTER TABLE "StoredArtifact" ENABLE TRIGGER USER');
    }
    await db!.$executeRawUnsafe('ALTER TABLE "StoredFile" DISABLE TRIGGER USER');
    try {
      await db!.storedFile.update({ where: { id: row.id }, data: { contentSha256: "0".repeat(64) } });
      expect((await request(app()).get(`/api/sessions/${firstIncident.id}/evidence/${row.id}/download`).set(as())).status).toBe(500);
      await db!.storedFile.update({ where: { id: row.id }, data: { contentSha256: row.contentSha256 } });
    } finally {
      await db!.$executeRawUnsafe('ALTER TABLE "StoredFile" ENABLE TRIGGER USER');
    }
    expect((await runIntegrityCheck(databaseUrl!)).status).toBe("pass");
  });

  it("enforces immutable evidence metadata and byte storage at the database boundary", async () => {
    const retained = await upload(firstIncident.id);
    const row = await db!.storedFile.findUniqueOrThrow({ where: { id: retained.body.id } });
    await expect(db!.storedFile.update({ where: { id: row.id }, data: { fileName: "rewritten.pdf" } })).rejects.toThrow();
    await expect(db!.storedFile.delete({ where: { id: row.id } })).rejects.toThrow();
    await expect(db!.storedArtifact.update({ where: { storageKey: row.storageKey }, data: { contentSha256: "0".repeat(64) } })).rejects.toThrow();
    await expect(db!.storedArtifact.delete({ where: { storageKey: row.storageKey } })).rejects.toThrow();
    await expect(db!.storedFileOperation.delete({ where: { operationId: row.uploadOperationId! } })).rejects.toThrow();
  });
});
