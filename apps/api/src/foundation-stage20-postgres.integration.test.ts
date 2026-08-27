import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createPrismaIncidentRepository } from "./modules/incidents/prisma-incident-repository.js";
import type { ProductionRouteClaim } from "./routes/production-route-registry.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;
const prisma = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;
const asAdmin = { "x-user-email": "admin@lot.pl" };

postgresDescribe("Foundation Stage 20 PostgreSQL production composition provenance", () => {
  const marker = `F20-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  let adminId: string;
  let incidentId: string;
  let requestId: string;
  let briefingId: string;
  let importId: string;
  let exportId: string;
  let injectId: string;

  beforeAll(async () => {
    const admin = await prisma!.user.findUniqueOrThrow({ where: { email: "admin@lot.pl" }, select: { id: true } });
    const targetRole = await prisma!.role.findUniqueOrThrow({ where: { normalizedName: "tec-member" }, select: { id: true, name: true, displayName: true } });
    adminId = admin.id;
    incidentId = (await prisma!.session.create({ data: {
      operationalId: `${marker}-SESSION`,
      mode: "EXERCISE",
      status: "Active",
      eventType: marker,
      description: "Stage 20 durable provenance sentinel",
      createdById: adminId,
    } })).id;
    requestId = (await prisma!.request.create({ data: {
      operationalId: `${marker}-REQUEST`,
      incidentId,
      category: "Operational support",
      priority: "Urgent",
      details: "Stage 20 durable request sentinel",
      createdById: adminId,
      updatedById: adminId,
    } })).id;
    briefingId = `${marker}-BRIEFING`;
    await prisma!.operationalBriefing.create({ data: {
      id: briefingId,
      sessionId: incidentId,
      revision: 1,
      status: "Published",
      title: "Stage 20 durable briefing sentinel",
      situationSummary: "PostgreSQL is authoritative",
      createdById: adminId,
      updatedById: adminId,
      publishedById: adminId,
      publishedAt: new Date(),
    } });
    importId = (await prisma!.importBatch.create({ data: {
      operationalId: `${marker}-IMPORT`,
      sessionId: incidentId,
      importType: "manifest",
      sourceFilename: `${marker}.csv`,
      status: "Validated",
      totalRecords: 1,
      validRecords: 1,
      createdById: adminId,
      validatedById: adminId,
      validatedAt: new Date(),
    } })).id;
    exportId = (await prisma!.exportGeneration.create({ data: {
      operationId: randomUUID(),
      commandFingerprint: "a".repeat(64),
      incidentId,
      exportType: "passenger-register",
      format: "csv",
      schemaVersion: "stage17-v1",
      fileName: `${marker}.csv`,
      contentSha256: "b".repeat(64),
      contentSizeBytes: 1,
      rowCount: 1,
      sectionCounts: { Session: 1 },
      includedSections: ["Session"],
      preparedById: adminId,
    } })).id;
    injectId = (await prisma!.exerciseInject.create({ data: {
      operationalId: `${marker}-INJECT`,
      sessionId: incidentId,
      injectNumber: 20,
      targetRoleId: targetRole.id,
      targetRoleKey: targetRole.name,
      targetRole: targetRole.displayName,
      text: "Stage 20 durable exercise sentinel",
      status: "Planned",
      createdById: adminId,
      updatedById: adminId,
    } })).id;
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.exerciseInject.deleteMany({ where: { id: injectId } });
    await prisma.exportGeneration.deleteMany({ where: { id: exportId } });
    await prisma.importBatch.deleteMany({ where: { id: importId } });
    await prisma.operationalBriefing.deleteMany({ where: { id: briefingId } });
    await prisma.request.deleteMany({ where: { id: requestId } });
    await prisma.notification.deleteMany({ where: { sessionId: incidentId } });
    await prisma.notificationOutbox.deleteMany({ where: { sessionId: incidentId } });
    await prisma.auditLog.deleteMany({ where: { sessionId: incidentId } });
    await prisma.caseTimelineEvent.deleteMany({ where: { sessionId: incidentId } });
    await prisma.session.deleteMany({ where: { id: incidentId } });
    await prisma.$disconnect();
  });

  it("retains the Stage 1-20 schema boundary and exposes only the explicit PostgreSQL registry", async () => {
    const migrations = await prisma!.$queryRaw<Array<{ count: bigint }>>`SELECT count(*)::bigint AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    const app = createApp();
    const manifest = app.locals.productionRouteManifest as ProductionRouteClaim[];
    expect(Number(migrations[0]!.count)).toBeGreaterThanOrEqual(21);
    expect(app.locals.productionComposition).toBe("postgres-explicit");
    expect(app.locals.legacyMemoryModuleLoaded).toBe(false);
    expect(app.locals.legacyMemoryRouterMounted).toBe(false);
    expect(manifest.length).toBeGreaterThan(100);
    expect(manifest.every((claim) => !claim.memoryBacked && claim.owner !== "demo-router")).toBe(true);
  });

  it("reads representative Stage 1-19 generations from durable authority on the first request of fresh compositions", async () => {
    const incident = await request(createApp()).get(`/api/sessions/${incidentId}`).set(asAdmin);
    expect(incident.status, JSON.stringify(incident.body)).toBe(200);
    expect(incident.body).toMatchObject({ id: incidentId, description: "Stage 20 durable provenance sentinel" });

    const requests = await request(createApp()).get("/api/requests").set(asAdmin).query({ sessionId: incidentId, limit: 50, offset: 0 });
    expect(requests.status, JSON.stringify(requests.body)).toBe(200);
    expect(requests.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: requestId, details: "Stage 20 durable request sentinel" })]));

    const briefing = await request(createApp()).get(`/api/sessions/${incidentId}/briefings/current`).set(asAdmin);
    expect(briefing.status, JSON.stringify(briefing.body)).toBe(200);
    expect(briefing.body).toMatchObject({ id: briefingId, title: "Stage 20 durable briefing sentinel" });

    const imports = await request(createApp()).get(`/api/sessions/${incidentId}/imports`).set(asAdmin).query({ limit: 50, offset: 0 });
    expect(imports.status, JSON.stringify(imports.body)).toBe(200);
    expect(imports.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: importId, sourceFilename: `${marker}.csv` })]));

    const generation = await request(createApp()).get(`/api/exports/generations/${exportId}`).set(asAdmin);
    expect(generation.status, JSON.stringify(generation.body)).toBe(200);
    expect(generation.body).toMatchObject({ id: exportId, incidentId, fileName: `${marker}.csv` });

    const injects = await request(createApp()).get("/api/exercise/injects").set(asAdmin).query({ sessionId: incidentId, limit: 50, offset: 0 });
    expect(injects.status, JSON.stringify(injects.body)).toBe(200);
    expect(injects.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: injectId, text: "Stage 20 durable exercise sentinel" })]));

    const readiness = await request(createApp()).get("/api/readiness/summary").set(asAdmin);
    expect(readiness.status, JSON.stringify(readiness.body)).toBe(200);
    expect(readiness.body).toHaveProperty("totalMembers");
  }, 30_000);

  it("keeps empty durable results honest after database deletion and process reconstruction", async () => {
    await prisma!.request.delete({ where: { id: requestId } });
    const response = await request(createApp()).get("/api/requests").set(asAdmin).query({ sessionId: incidentId, search: marker, limit: 50, offset: 0 });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ total: 0, data: [] });
  });

  it("propagates durable repository failure instead of falling back to seeded demo state", async () => {
    const durable = createPrismaIncidentRepository(prisma!);
    const failing = {
      ...durable,
      async list(): ReturnType<typeof durable.list> {
        throw new Error("stage20-provenance-failure");
      },
    };
    const app = createApp({ incidentRepository: failing });
    const response = await request(app).get("/api/sessions").set(asAdmin);
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toMatch(/ses-demo|training room|demo incident/i);
    expect(app.locals.productionComposition).toBe("postgres-explicit");
    expect(app.locals.legacyMemoryRouterMounted).toBe(false);
  });
});
