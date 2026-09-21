import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, createSharedApp } from "./test-support/listening-test-app.js";
import { createPrismaAfterActionReportService } from "./modules/after-action-reports/prisma-after-action-report-service.js";
import { contentDigest, sha256, versionInclude, aarPdfLimit } from "./modules/after-action-reports/after-action-report-types.js";
import { createPrismaExerciseService } from "./modules/exercise/prisma-exercise-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const pg = databaseUrl ? describe : describe.skip;
const db = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;
pg("Foundation Stage 22 retained AAR evidence", () => {
  const marker = "F22-" + randomUUID().slice(0, 8);
  let coordinator: { id: string; email: string; displayName: string };
  let adminOnlyEmail: string;
  const actor = () => ({ ...coordinator, requestId: randomUUID() });
  const service = () => createPrismaAfterActionReportService(db!);
  const app = () => createSharedApp({ afterActionReportService: service() });
  const headers = (email = coordinator.email) => ({ "x-user-email": email });
  const command = (version: number) => ({ operationId: randomUUID(), expectedVersion: version });
  async function incident(mode = "REAL", status = "Closed") {
    const s = await db!.session.create({ data: { operationalId: marker + "-" + randomUUID(), mode, status, eventType: "AAR test", createdById: coordinator.id } });
    await db!.incidentAssignment.create({ data: { incidentId: s.id, userId: coordinator.id, function: marker, createdById: coordinator.id } });
    return s;
  }
  async function draft(mode = "REAL") {
    const s = await incident(mode);
    const r = await service().create({ sessionId: s.id, title: "Evidence " + marker, operationId: randomUUID() }, actor());
    return { s, r };
  }
  function editBody(v: { version: number }, summary = "Executive evidence") {
    return { expectedVersion: v.version, title: marker + " report", eventDate: "2026-09-21T12:00:00.000Z", executiveSummary: summary,
      findings: [{ area: "Coordination", summary: "Finding evidence", detail: "Finding details" }],
      lessons: [{ statement: "Lesson evidence" }], correctiveActions: [{ recommendation: "Action evidence", owner: "Operations", targetDate: "2026-10-01T00:00:00.000Z" }] };
  }
  async function approved() {
    const { s, r } = await draft();
    const edited = await service().edit(r.reportVersionId!, editBody(r), actor());
    const submitted = await service().transition(r.reportVersionId!, "submit", command(edited.version), actor());
    const a = await service().transition(r.reportVersionId!, "approve", command(submitted.version), actor());
    return { s, r: a };
  }
  beforeAll(async () => {
    coordinator = await db!.user.findUniqueOrThrow({ where: { email: "coordinator@lot.pl" }, select: { id: true, email: true, displayName: true } });
    const role = await db!.role.findUniqueOrThrow({ where: { normalizedName: "system-admin" } });
    adminOnlyEmail = marker.toLowerCase() + "-admin@example.test";
    await db!.user.create({ data: { email: adminOnlyEmail, normalizedEmail: adminOnlyEmail, displayName: "AAR admin only", roles: { create: { roleId: role.id, scopeType: "GLOBAL", assignedBy: coordinator.id } } } });
  });
  // Approved evidence is intentionally not deleted. Every gate uses a disposable DB.
  afterAll(async () => { await db?.$disconnect(); });

  it("deploys 23 migrations, normalized tables, coordinator-only defaults and immutable guards", async () => {
    const migrations = await db!.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    expect(Number(migrations[0]!.count)).toBeGreaterThanOrEqual(23);
    const triggers = await db!.$queryRaw<Array<{ tgname: string }>>`SELECT tgname FROM pg_trigger WHERE tgname LIKE 'Aar_%'`;
    expect(triggers.map(t => t.tgname)).toEqual(expect.arrayContaining(["Aar_version_guard", "Aar_finding_guard", "Aar_lesson_guard", "Aar_action_guard", "Aar_artifact_guard"]));
    const admin = await db!.role.findUniqueOrThrow({ where: { normalizedName: "system-admin" } });
    expect(admin.permissions).not.toContain("aar:read");
  });
  it.each(["REAL", "EXERCISE", "TRAINING"])("creates one report for a Closed %s Session with durable replay", async mode => {
    const s = await incident(mode);
    const body = { sessionId: s.id, title: marker, operationId: randomUUID() };
    const first = await request(app()).post("/api/after-action-reports").set(headers()).send(body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const repeat = await request(app()).post("/api/after-action-reports").set(headers()).send(body);
    expect(repeat.status).toBe(200); expect(repeat.body).toMatchObject({ ...first.body, replayed: true });
    expect((await request(app()).post("/api/after-action-reports").set(headers()).send({ ...body, operationId: randomUUID() })).status).toBe(409);
    expect((await request(app()).post("/api/after-action-reports").set(headers()).send({ ...body, title: "Different" })).status).toBe(409);
  });
  it.each(["Active", "Draft", "Archived"])("rejects new content on %s Sessions", async status => {
    const s = await incident("EXERCISE", status);
    expect((await request(app()).post("/api/after-action-reports").set(headers()).send({ sessionId: s.id, title: marker, operationId: randomUUID() })).status).toBe(409);
    if (status === "Active") await db!.session.update({ where: { id: s.id }, data: { status: "Closed" } });
  });
  it("requires authentication, denies admin content and makes inaccessible IDs indistinguishable", async () => {
    const { s, r } = await draft();
    expect((await request(app()).get("/api/after-action-reports").query({ sessionId: s.id })).status).toBe(401);
    expect((await request(app()).get("/api/after-action-reports").set(headers(adminOnlyEmail)).query({ sessionId: s.id })).status).toBe(403);
    const denied = await request(app()).get("/api/after-action-reports/" + r.reportId).set(headers(adminOnlyEmail));
    const missing = await request(app()).get("/api/after-action-reports/" + randomUUID()).set(headers(adminOnlyEmail));
    expect(denied.status).toBe(404); expect(missing.status).toBe(404); expect(denied.body).toEqual(missing.body);
    expect((await request(app()).get("/api/after-action-reports/not-a-uuid").set(headers())).status).toBe(404);
  });
  it("rejects client lifecycle/provenance and validates bounded sections", async () => {
    const { s, r } = await draft();
    expect((await request(app()).post("/api/after-action-reports").set(headers()).send({ sessionId: s.id, title: marker, operationId: randomUUID(), ownerId: coordinator.id })).status).toBe(400);
    expect((await request(app()).patch("/api/after-action-report-versions/" + r.reportVersionId).set(headers()).send({ ...editBody(r), approvedById: coordinator.id })).status).toBe(400);
    expect((await request(app()).patch("/api/after-action-report-versions/" + r.reportVersionId).set(headers()).send({ ...editBody(r), lessons: Array.from({ length: 101 }, () => ({ statement: "Too many" })) })).status).toBe(400);
  });
  it("edits all ordered sections atomically and rejects stale versions with one concurrent winner", async () => {
    const { r } = await draft();
    const responses = await Promise.all([1, 2].map(n => request(app()).patch("/api/after-action-report-versions/" + r.reportVersionId).set(headers()).send(editBody(r, "Writer " + n))));
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    const v = await service().getVersion(r.reportVersionId!, actor());
    expect(v.findings[0]).toMatchObject({ area: "Coordination", sortOrder: 1 }); expect(v.lessons).toHaveLength(1); expect(v.correctiveActions).toHaveLength(1);
    expect(v.version).toBe(2);
  });
  it("enforces review locking, explicit return, approval prerequisites and terminal approval", async () => {
    const { r } = await draft();
    await expect(service().transition(r.reportVersionId!, "approve", command(1), actor())).rejects.toMatchObject({ status: 409 });
    const submitted = await service().transition(r.reportVersionId!, "submit", command(1), actor());
    await expect(service().edit(r.reportVersionId!, editBody(submitted), actor())).rejects.toMatchObject({ status: 409 });
    await expect(service().transition(r.reportVersionId!, "approve", command(submitted.version), actor())).rejects.toMatchObject({ status: 400 });
    const returned = await service().transition(r.reportVersionId!, "return-to-draft", command(submitted.version), actor());
    const edited = await service().edit(r.reportVersionId!, editBody(returned), actor());
    const review = await service().transition(r.reportVersionId!, "submit", command(edited.version), actor());
    const cmd = command(review.version);
    const result = await service().transition(r.reportVersionId!, "approve", cmd, actor());
    expect((await service().transition(r.reportVersionId!, "approve", cmd, actor())).replayed).toBe(true);
    await expect(service().edit(r.reportVersionId!, editBody(result), actor())).rejects.toMatchObject({ status: 409 });
    const v = await db!.afterActionReportVersion.findUniqueOrThrow({ where: { id: r.reportVersionId }, include: versionInclude });
    expect(v.contentSha256).toBe(contentDigest(v));
    expect(v.approvedById).toBe(coordinator.id);
  });
  it("protects approved versions and every child against direct SQL update/delete/insert", async () => {
    const { r } = await approved();
    for (const table of ["AfterActionReportVersion", "AfterActionFinding", "AfterActionLesson", "AfterActionCorrectiveAction"]) {
      const where = table === "AfterActionReportVersion" ? '"id"' : '"reportVersionId"';
      await expect(db!.$executeRawUnsafe('UPDATE "' + table + '" SET "id" = "id" WHERE ' + where + ' = $1::uuid', r.reportVersionId)).rejects.toThrow();
      await expect(db!.$executeRawUnsafe('DELETE FROM "' + table + '" WHERE ' + where + ' = $1::uuid', r.reportVersionId)).rejects.toThrow();
    }
    await expect(db!.afterActionLesson.create({ data: { reportVersionId: r.reportVersionId!, sortOrder: 2, statement: "Injected" } })).rejects.toThrow();
  });
  it("deep-copies revisions, preserves hashes/history and allows only one mutable successor", async () => {
    const { r } = await approved(), before = await service().getVersion(r.reportVersionId!, actor());
    const report = await service().getReport(r.reportId, actor());
    const responses = await Promise.allSettled([1, 2].map(() => service().revision(r.reportId, command(report.version), actor())));
    expect(responses.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const next = (responses.find(r => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<ReturnType<typeof service>["revision"]>>>).value;
    const copied = await service().getVersion(next.reportVersionId!, actor());
    expect(copied.basedOnVersionId).toBe(before.id); expect(copied.findings[0]!.id).not.toBe(before.findings[0]!.id);
    expect(copied.findings[0]!.summary).toBe(before.findings[0]!.summary);
    await service().edit(copied.id, editBody(copied, "Later summary"), actor());
    expect((await service().getVersion(before.id, actor())).contentSha256).toBe(before.contentSha256);
    expect(await service().history(r.reportId, { limit: 1, offset: 1 }, actor())).toMatchObject({ total: 2, data: [{ id: before.id }] });
  });
  it("snapshots eligible same-Session observations and retains exact source revisions", async () => {
    const s = await incident("EXERCISE", "Active");
    const exercise = createPrismaExerciseService(db!);
    const observation = await exercise.createObservation({ sessionId: s.id, operationId: randomUUID(), area: "Intake", observation: "Original evidence", recommendation: "Original recommendation", severity: "Low", owner: null, status: "Open", includeInAar: true }, actor());
    await db!.session.update({ where: { id: s.id }, data: { status: "Closed" } });
    const r = await service().create({ sessionId: s.id, operationId: randomUUID(), title: marker, sourceObservationIds: [observation.record.id] }, actor());
    const v = await service().getVersion(r.reportVersionId!, actor());
    expect(v.findings[0]).toMatchObject({ summary: "Original evidence", detail: "Original recommendation", sourceObservationVersion: 1 });
    const other = await incident("EXERCISE");
    await expect(service().create({ sessionId: other.id, operationId: randomUUID(), title: marker, sourceObservationIds: [observation.record.id] }, actor())).rejects.toMatchObject({ status: 400 });
    expect(await service().sourceObservations(s.id, { limit: 1 }, actor())).toMatchObject({ total: 1 });
  });
  it("rolls entity and operation back on audit failure without leaking report text", async () => {
    const s = await incident(), operationId = randomUUID();
    const failing = createPrismaAfterActionReportService(db!, { beforeAudit: () => { throw new Error("injected seam"); } });
    await expect(failing.create({ sessionId: s.id, operationId, title: "Private report" }, actor())).rejects.toThrow("injected seam");
    expect(await db!.afterActionReport.count({ where: { sessionId: s.id } })).toBe(0);
    expect(await db!.afterActionOperation.findUnique({ where: { operationId } })).toBeNull();
    const { r } = await approved();
    const logs = await db!.auditLog.findMany({ where: { entityId: r.reportId } });
    expect(logs.length).toBe(4); expect(JSON.stringify(logs)).not.toContain("Executive evidence"); expect(JSON.stringify(logs)).not.toContain("Finding evidence");
  });
  it("generates only approved PDFs with exact retained bytes and restart-safe replay", async () => {
    const draftOnly = await draft();
    await expect(service().generatePdf(draftOnly.r.reportVersionId!, command(1), actor())).rejects.toMatchObject({ status: 409 });
    const { r } = await approved(), cmd = command(r.version);
    const result = await request(app()).post("/api/after-action-report-versions/" + r.reportVersionId + "/pdf-artifacts").set(headers()).send(cmd);
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    const fresh = createApp({ afterActionReportService: service() });
    const repeated = await request(fresh).post("/api/after-action-report-versions/" + r.reportVersionId + "/pdf-artifacts").set(headers()).send(cmd);
    expect(repeated.body.artifactId).toBe(result.body.artifactId);
    const retained = await db!.afterActionPdfArtifact.findUniqueOrThrow({ where: { id: result.body.artifactId } });
    expect(Buffer.from(retained.content).subarray(0, 5).toString()).toBe("%PDF-");
    expect(sha256(retained.content)).toBe(retained.contentSha256);
    const download = await request(fresh).get("/api/after-action-pdf-artifacts/" + retained.id + "/download").set(headers());
    expect(download.status).toBe(200); expect(Buffer.from(download.body)).toEqual(Buffer.from(retained.content));
    expect(download.headers["content-length"]).toBe(String(retained.contentSizeBytes));
    expect(download.headers["cache-control"]).toBe("no-store, no-transform");
    expect(download.headers["x-content-sha256"]).toBe(retained.contentSha256);
    expect(await service().artifact(retained.id, actor())).not.toHaveProperty("content");
    expect((await service().artifacts(r.reportVersionId!, {}, actor())).data[0]).not.toHaveProperty("content");
    const report = await service().getReport(r.reportId, actor());
    await service().revision(report.id, command(report.version), actor());
    expect((await service().download(retained.id, actor())).content).toEqual(Buffer.from(retained.content));
  });
  it("makes artifacts and operation records immutable through SQL", async () => {
    const { r } = await approved(), op = command(r.version);
    const pdf = await service().generatePdf(r.reportVersionId!, op, actor());
    await expect(db!.afterActionPdfArtifact.update({ where: { id: pdf.artifactId }, data: { fileName: "tampered.pdf" } })).rejects.toThrow();
    await expect(db!.afterActionPdfArtifact.delete({ where: { id: pdf.artifactId } })).rejects.toThrow();
    await expect(db!.afterActionOperation.delete({ where: { operationId: op.operationId } })).rejects.toThrow();
  });
  it("detects privileged byte corruption and never serves the corrupt PDF", async () => {
    const { r } = await approved(), pdf = await service().generatePdf(r.reportVersionId!, command(r.version), actor());
    // Deliberate privileged corruption confined to a test-created disposable DB.
    await db!.$transaction(async tx => {
      await tx.$executeRawUnsafe('ALTER TABLE "AfterActionPdfArtifact" DISABLE TRIGGER "Aar_artifact_guard"');
      await tx.$executeRaw`UPDATE "AfterActionPdfArtifact" SET "content" = set_byte("content", 0, 0) WHERE "id"=${pdf.artifactId}::uuid`;
      await tx.$executeRawUnsafe('ALTER TABLE "AfterActionPdfArtifact" ENABLE TRIGGER "Aar_artifact_guard"');
    });
    const response = await request(app()).get("/api/after-action-pdf-artifacts/" + pdf.artifactId + "/download").set(headers());
    expect(response.status).toBe(500); expect(response.body.error).toBe("AAR PDF integrity verification failed");
    expect(response.headers["content-type"]).toContain("application/json");
  });
  it("rejects oversized rendering and rolls back artifact/audit seams", async () => {
    const { r } = await approved(), operationId = randomUUID();
    const oversized = createPrismaAfterActionReportService(db!, { render: async () => Buffer.alloc(aarPdfLimit + 1) });
    await expect(oversized.generatePdf(r.reportVersionId!, { operationId, expectedVersion: r.version }, actor())).rejects.toMatchObject({ status: 413 });
    const failing = createPrismaAfterActionReportService(db!, { beforeAudit: () => { throw new Error("artifact audit seam"); } });
    await expect(failing.generatePdf(r.reportVersionId!, command(r.version), actor())).rejects.toThrow("artifact audit seam");
    expect(await db!.afterActionPdfArtifact.count({ where: { reportVersionId: r.reportVersionId } })).toBe(0);
    expect(await db!.afterActionOperation.findUnique({ where: { operationId } })).toBeNull();
  });
  it("archives only approved reports while retaining historical PDF access after Session archive", async () => {
    const mutable = await draft();
    await expect(service().archive(mutable.r.reportId, { ...command(1), reason: "Done" }, actor())).rejects.toMatchObject({ status: 409 });
    const { s, r } = await approved(), report = await service().getReport(r.reportId, actor());
    await service().archive(report.id, { ...command(report.version), reason: "Review closed" }, actor());
    await db!.session.update({ where: { id: s.id }, data: { status: "Archived" } });
    const pdf = await service().generatePdf(r.reportVersionId!, command(r.version), actor());
    expect((await service().download(pdf.artifactId!, actor())).content.length).toBeGreaterThan(100);
    expect((await service().getReport(report.id, actor())).capabilities.createRevision).toBe(false);
    await expect(service().revision(report.id, command(report.version + 1), actor())).rejects.toMatchObject({ status: 409 });
  });
  it("re-evaluates active deny and revoked/expired overrides inside the write transaction", async () => {
    const { r } = await draft();
    const deny = await db!.permissionOverride.create({ data: { userId: coordinator.id, permission: "aar:update-draft", effect: "DENY", reason: marker, createdById: coordinator.id } });
    try {
      await expect(service().edit(r.reportVersionId!, editBody(r), actor())).rejects.toMatchObject({ status: 404 });
      await db!.permissionOverride.update({ where: { id: deny.id }, data: { expiresAt: new Date(0) } });
      const edited = await service().edit(r.reportVersionId!, editBody(r), actor());
      await db!.permissionOverride.update({ where: { id: deny.id }, data: { expiresAt: null, revokedAt: new Date(), active: false } });
      expect((await service().edit(r.reportVersionId!, editBody(edited), actor())).version).toBe(3);
    } finally { await db!.permissionOverride.delete({ where: { id: deny.id } }); }
  });
  it("closes the route-to-service permission race", async () => {
    const { r } = await draft(); let denyId: string | undefined;
    const racing = createPrismaAfterActionReportService(db!, { afterSessionLock: async () => {
      denyId = (await db!.permissionOverride.create({ data: { userId: coordinator.id, permission: "aar:update-draft", effect: "DENY", reason: marker, createdById: coordinator.id } })).id;
    } });
    try {
      const response = await request(createApp({ afterActionReportService: racing })).patch("/api/after-action-report-versions/" + r.reportVersionId).set(headers()).send(editBody(r));
      expect(response.status).toBe(404);
      expect((await db!.afterActionReportVersion.findUniqueOrThrow({ where: { id: r.reportVersionId } })).version).toBe(1);
    } finally { if (denyId) await db!.permissionOverride.delete({ where: { id: denyId } }); }
  });
  it("separates custom read, edit and approval grants and rejects unassigned Sessions", async () => {
    const { s, r } = await draft();
    const email = marker.toLowerCase() + "-reader@example.test";
    const role = await db!.role.create({ data: { name: email, normalizedName: email, displayName: "AAR reader", custom: true, permissions: ["session:read", "aar:read"], scopeTypes: ["GLOBAL"] } });
    const user = await db!.user.create({ data: { email, normalizedEmail: email, displayName: "Reader", roles: { create: { roleId: role.id, scopeType: "GLOBAL", assignedBy: coordinator.id } } } });
    await db!.incidentAssignment.create({ data: { incidentId: s.id, userId: user.id, function: marker, createdById: coordinator.id } });
    const reader = { id: user.id, email, displayName: user.displayName };
    expect((await service().getReport(r.reportId, reader)).id).toBe(r.reportId);
    await expect(service().edit(r.reportVersionId!, editBody(r), reader)).rejects.toMatchObject({ status: 404 });
    await db!.role.update({ where: { id: role.id }, data: { permissions: ["session:read", "aar:read", "aar:update-draft"] } });
    const edited = await service().edit(r.reportVersionId!, editBody(r), reader);
    const review = await service().transition(r.reportVersionId!, "submit", command(edited.version), actor());
    await expect(service().transition(r.reportVersionId!, "approve", command(review.version), reader)).rejects.toMatchObject({ status: 404 });
    const other = await draft();
    await expect(service().getReport(other.r.reportId, reader)).rejects.toMatchObject({ status: 404 });
    await db!.role.update({ where: { id: role.id }, data: { status: "Archived" } });
    await expect(service().getReport(r.reportId, reader)).rejects.toMatchObject({ status: 404 });
    await db!.role.update({ where: { id: role.id }, data: { status: "Active" } });
    await db!.user.update({ where: { id: user.id }, data: { status: "Archived", archivedAt: new Date() } });
    await expect(service().getReport(r.reportId, reader)).rejects.toMatchObject({ status: 404 });
  });
  it("contains custom GROUP authority to its assigned Incident even with membership in two", async () => {
    const a = await draft(), b = await draft();
    const email = marker.toLowerCase() + "-group@example.test";
    const role = await db!.role.create({ data: { name: email, normalizedName: email, displayName: "Scoped AAR", custom: true, permissions: ["session:read", "aar:read"], scopeTypes: ["GROUP"] } });
    const user = await db!.user.create({ data: { email, normalizedEmail: email, displayName: "Scoped reader", roles: { create: { roleId: role.id, scopeType: "GROUP", assignedBy: coordinator.id } } } });
    await db!.incidentAssignment.createMany({ data: [a.s.id, b.s.id].map(incidentId => ({ incidentId, userId: user.id, function: marker, createdById: coordinator.id })) });
    const group = await db!.operationalGroup.create({ data: { id: randomUUID(), operationalId: marker + "-GRP", incidentId: a.s.id, name: marker, pool: "ZPP", functionName: "AAR", createdById: coordinator.id } });
    await db!.groupRoleAssignment.create({ data: { id: randomUUID(), userId: user.id, roleId: role.id, groupId: group.id, assignedBy: coordinator.id } });
    expect((await request(app()).get("/api/after-action-reports/" + a.r.reportId).set(headers(email))).status).toBe(200);
    expect((await request(app()).get("/api/after-action-reports/" + b.r.reportId).set(headers(email))).status).toBe(404);
  });
  it("serializes competing create, approval and same-operation PDF commands without retries", async () => {
    const s = await incident(), input = { sessionId: s.id, title: marker, operationId: randomUUID() };
    const created = await Promise.all([service().create(input, actor()), service().create(input, actor())]);
    expect(created.map(r => r.replayed).sort()).toEqual([false, true]);
    expect(created[0]!.reportId).toBe(created[1]!.reportId);
    const edited = await service().edit(created[0]!.reportVersionId!, editBody(created[0]!), actor());
    const review = await service().transition(edited.reportVersionId!, "submit", command(edited.version), actor());
    const race = await Promise.allSettled([service().transition(review.reportVersionId!, "approve", command(review.version), actor()), service().transition(review.reportVersionId!, "return-to-draft", command(review.version), actor())]);
    expect(race.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect((race.find(r => r.status === "rejected") as PromiseRejectedResult).reason.status).toBe(409);
    const { r } = await approved(), cmd = command(r.version);
    const pdfs = await Promise.all([service().generatePdf(r.reportVersionId!, cmd, actor()), service().generatePdf(r.reportVersionId!, cmd, actor())]);
    expect(pdfs[0]!.artifactId).toBe(pdfs[1]!.artifactId);
    expect(pdfs.map(r => r.replayed).sort()).toEqual([false, true]);
    await expect(service().generatePdf(r.reportVersionId!, { ...cmd, expectedVersion: 999 }, actor())).rejects.toMatchObject({ status: 409 });
  });
  it("keeps approved Observation and actor/event snapshots stable after later source changes", async () => {
    const s = await incident("EXERCISE", "Active"), exercise = createPrismaExerciseService(db!);
    const original = await exercise.createObservation({ sessionId: s.id, operationId: randomUUID(), area: "Intake", observation: "Historical source", recommendation: "Original advice", severity: "Low", owner: null, status: "Open", includeInAar: true }, actor());
    await db!.session.update({ where: { id: s.id }, data: { status: "Closed" } });
    const r = await service().create({ sessionId: s.id, title: marker, operationId: randomUUID(), sourceObservationIds: [original.record.id] }, actor());
    let v = await service().getVersion(r.reportVersionId!, actor());
    const edited = await service().edit(v.id, { ...editBody(v), findings: v.findings.map(f => ({ id: f.id, area: f.area, summary: f.summary, detail: f.detail })) }, actor());
    const review = await service().transition(v.id, "submit", command(edited.version), actor());
    const approvedResult = await service().transition(v.id, "approve", command(review.version), actor());
    const before = await db!.afterActionReportVersion.findUniqueOrThrow({ where: { id: v.id }, include: versionInclude });
    // Simulate later source evolution on an administratively reopened TEST fixture.
    await db!.session.update({ where: { id: s.id }, data: { status: "Active", eventType: "Changed event description" } });
    await exercise.updateObservation(original.record.id, { expectedVersion: 1, observation: "Later source", recommendation: "Later advice" }, actor());
    await db!.session.update({ where: { id: s.id }, data: { status: "Closed" } });
    const after = await db!.afterActionReportVersion.findUniqueOrThrow({ where: { id: v.id }, include: versionInclude });
    expect(after.findings[0]).toMatchObject({ summary: "Historical source", sourceObservationVersion: 1 });
    expect(after.contextSnapshot).toEqual(before.contextSnapshot);
    expect(contentDigest(after)).toBe(before.contentSha256);
    expect((after.contextSnapshot as { eventType: string }).eventType).toBe("AAR test");
    const pdf = await service().generatePdf(v.id, command(approvedResult.version), actor());
    expect((await service().artifact(pdf.artifactId!, actor())).sourceContentSha256).toBe(before.contentSha256);
  });
  it("serializes Session archival before content edits and rolls updates back on audit failure", async () => {
    const { s, r } = await draft();
    let release!: () => void, signal!: () => void;
    const ready = new Promise<void>(resolve => { signal = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
    const archive = db!.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Session" WHERE "id"=${s.id}::uuid FOR UPDATE`;
      signal(); await hold;
      await tx.session.update({ where: { id: s.id }, data: { status: "Archived" } });
    });
    await ready;
    const edit = service().edit(r.reportVersionId!, editBody(r), actor());
    release(); await archive;
    await expect(edit).rejects.toMatchObject({ status: 409 });
    const other = await draft();
    const failing = createPrismaAfterActionReportService(db!, { beforeAudit: () => { throw new Error("edit rollback"); } });
    await expect(failing.edit(other.r.reportVersionId!, editBody(other.r), actor())).rejects.toThrow("edit rollback");
    const v = await service().getVersion(other.r.reportVersionId!, actor());
    expect(v.version).toBe(1); expect(v.findings).toHaveLength(0);
  });
  it("reports complete totals for 1005 historical revisions beyond the 200-row page cap", async () => {
    const { r } = await draft();
    // Bounded scale fixture uses the real lifecycle triggers; no triggers disabled.
    await db!.$transaction(async tx => {
      for (let i = 1; i <= 1005; i++) {
        const v = i === 1 ? { id: r.reportVersionId! } : await tx.afterActionReportVersion.create({ data: {
          reportId: r.reportId, revision: i, basedOnVersionId: (await tx.afterActionReportVersion.findUniqueOrThrow({ where: { reportId_revision: { reportId: r.reportId, revision: i - 1 } } })).id,
          title: "Scale evidence", eventDate: new Date(), createdById: coordinator.id, updatedById: coordinator.id,
        } });
        await tx.afterActionLesson.create({ data: { reportVersionId: v.id, sortOrder: 1, statement: "Scale evidence" } });
        await tx.afterActionReportVersion.update({ where: { id: v.id }, data: { executiveSummary: "Scale summary", status: "Under review", submittedAt: new Date(), submittedById: coordinator.id } });
        await tx.afterActionReportVersion.update({ where: { id: v.id }, data: { status: "Approved", approvedAt: new Date(), approvedById: coordinator.id, contentSha256: "a".repeat(64) } });
      }
    }, { timeout: 60000 });
    const first = await service().history(r.reportId, { limit: 200 }, actor());
    const last = await service().history(r.reportId, { limit: 200, offset: 1000 }, actor());
    expect(first.total).toBe(1005); expect(first.data).toHaveLength(200);
    expect(last.total).toBe(1005); expect(last.data.map(v => v.revision)).toEqual([5, 4, 3, 2, 1]);
    expect((await service().getReport(r.reportId, actor())).latest.revision).toBe(1005);
    expect(await service().list({ sessionId: (await service().getReport(r.reportId, actor())).sessionId, offset: 1, limit: 1 }, actor())).toMatchObject({ total: 1, data: [] });
  }, 60000);
  it("returns controlled 413 for oversized JSON and denies artifact reads without AAR permission", async () => {
    const response = await request(app()).post("/api/after-action-reports").set(headers()).send({ title: "x".repeat(2 * 1024 * 1024) });
    expect(response.status).toBe(413);
    const { r } = await approved(), pdf = await service().generatePdf(r.reportVersionId!, command(r.version), actor());
    expect((await request(app()).get("/api/after-action-pdf-artifacts/" + pdf.artifactId).set(headers(adminOnlyEmail))).status).toBe(404);
    expect((await request(app()).get("/api/after-action-pdf-artifacts/" + pdf.artifactId + "/download").set(headers(adminOnlyEmail))).status).toBe(404);
  });
});
