import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { dictionaries } from "@zpp/shared";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDictionaries } from "../prisma/dictionary-seed.js";
import { createApp } from "./app.js";
import { dictionaryPolicies } from "./modules/configuration/dictionary-policy.js";
import { createPrismaDictionaryService } from "./modules/configuration/prisma-dictionary-service.js";
import type { DictionaryConfigurationService, DictionaryFailurePoint } from "./modules/configuration/configuration-types.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;
const prisma = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;
const asAdmin = { "x-user-email": "admin@lot.pl" };
const asViewer = { "x-user-email": "viewer@lot.pl" };

postgresDescribe("Foundation Stage 21 PostgreSQL dictionary and configuration integrity", () => {
  const marker = `F21-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const normalizedMarker = marker.toLowerCase().replaceAll("-", "_");
  const dictionaryIds = new Set<string>();
  const requestIds = new Set<string>();
  const sessionIds = new Set<string>();
  let activeIncidentId: string;

  beforeAll(async () => {
    activeIncidentId = (await prisma!.session.findFirstOrThrow({ where: { status: "Active" }, select: { id: true } })).id;
  });

  afterAll(async () => {
    if (!prisma) return;
    if (requestIds.size) {
      const ids = [...requestIds];
      await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } });
      await prisma.caseTimelineEvent.deleteMany({ where: { entityId: { in: ids } } });
      await prisma.request.deleteMany({ where: { id: { in: ids } } });
    }
    if (sessionIds.size) {
      const ids = [...sessionIds];
      await prisma.auditLog.deleteMany({ where: { sessionId: { in: ids } } });
      await prisma.caseTimelineEvent.deleteMany({ where: { sessionId: { in: ids } } });
      await prisma.incidentAssignment.deleteMany({ where: { incidentId: { in: ids } } });
      await prisma.session.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.dictionary.deleteMany({ where: { profile: "lot-zpp", OR: [
      { normalizedKey: { startsWith: normalizedMarker } },
      { label: { contains: marker } },
    ] } });
    if (dictionaryIds.size) await prisma.auditLog.deleteMany({ where: { entityType: "Dictionary", entityId: { in: [...dictionaryIds] } } });
    await prisma.$disconnect();
  });

  function createBody(suffix: string, overrides: Record<string, unknown> = {}) {
    return {
      category: "requestCategories",
      key: `${marker}-${suffix}`,
      label: `${marker} ${suffix}`,
      description: "Stage 21 durable configuration sentinel",
      sortOrder: 900_000,
      ...overrides,
    };
  }

  async function createDictionary(suffix: string, overrides: Record<string, unknown> = {}) {
    const response = await request(createApp()).post("/api/admin/dictionaries").set(asAdmin).send(createBody(suffix, overrides));
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    dictionaryIds.add(response.body.id);
    return response.body;
  }

  async function createWelfareRequest(category: string) {
    const response = await request(createApp()).post("/api/requests").set(asAdmin).send({
      sessionId: activeIncidentId,
      category,
      priority: "Normal",
      details: `${marker} durable request`,
      approvalStatus: "Not required",
      operationId: randomUUID(),
    });
    if (response.status === 201) requestIds.add(response.body.id);
    return response;
  }

  async function createSession(eventType: string, suffix: string) {
    const response = await request(createApp()).post("/api/sessions").set(asAdmin).send({
      mode: "TRAINING",
      status: "Draft",
      eventType,
      description: `${marker} ${suffix}`,
    });
    if (response.status === 201) sessionIds.add(response.body.id);
    return response;
  }

  it("applies migration 22, exposes an exhaustive typed policy, and keeps production ownership durable", async () => {
    const migrations = await prisma!.$queryRaw<Array<{ count: bigint }>>`SELECT count(*)::bigint AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    const columns = await prisma!.$queryRaw<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Dictionary'`;
    expect(Number(migrations[0]!.count)).toBe(22);
    expect(columns.map((row) => row.column_name)).toEqual(expect.arrayContaining(["normalizedKey", "version", "sourceType"]));
    expect(await prisma!.dictionary.count({ where: { category: { in: ["eventTypes", "requestCategories"] }, sourceType: "BOOTSTRAP" } })).toBe(
      dictionaries.eventTypes.length + dictionaries.requestCategories.length,
    );
    expect(Object.keys(dictionaryPolicies).sort()).toHaveLength(29);
    expect(dictionaryPolicies.eventTypes).toMatchObject({ classification: "E", authority: "postgres", protected: false, allowCreate: true, allowDeactivate: true });
    expect(dictionaryPolicies.requestCategories).toMatchObject({ classification: "E", authority: "postgres", protected: false, allowCreate: true, allowDeactivate: true });
    expect(dictionaryPolicies.sessionStatuses).toMatchObject({ classification: "P", authority: "code", protected: true, allowCreate: false });
    const app = createApp();
    expect(app.locals.productionComposition).toBe("postgres-explicit");
    expect(app.locals.legacyMemoryModuleLoaded).toBe(false);
    expect(app.locals.legacyMemoryRouterMounted).toBe(false);
    expect(app.locals.productionRouteManifest).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "GET", path: "/dictionaries", owner: "configuration", authority: "postgres" }),
      expect.objectContaining({ method: "POST", path: "/admin/dictionaries", owner: "configuration", authority: "postgres" }),
    ]));

    const publicResponse = await request(app).get("/api/dictionaries").set(asAdmin);
    expect(publicResponse.status).toBe(200);
    expect(Object.keys(publicResponse.body).sort()).toEqual(Object.keys(dictionaryPolicies).sort());
    for (const [category, policy] of Object.entries(dictionaryPolicies)) {
      const publicRows = publicResponse.body[category] as Array<{ id: string; label: string; sortOrder: number }>;
      if (policy.authority === "code") {
        expect(publicRows.map((row) => row.label), category).toEqual([...dictionaries[category as keyof typeof dictionaries]]);
      } else {
        const durableRows = await prisma!.dictionary.findMany({
          where: { profile: "lot-zpp", category, isActive: true },
          orderBy: [{ category: "asc" }, { sortOrder: "asc" }, { label: "asc" }, { key: "asc" }],
          select: { id: true },
        });
        expect(publicRows.map((row) => row.id), category).toEqual(durableRows.map((row) => row.id));
      }
    }
  });

  it("enforces global admin authorization and rejects protected category mutation", async () => {
    expect((await request(createApp()).get("/api/admin/dictionaries")).status).toBe(401);
    expect((await request(createApp()).get("/api/admin/dictionaries").set(asViewer)).status).toBe(403);
    const viewer = await prisma!.user.findUniqueOrThrow({ where: { email: "viewer@lot.pl" }, select: { id: true } });
    expect(await prisma!.incidentAssignment.count({ where: { userId: viewer.id, active: true } })).toBeGreaterThan(0);
    expect((await request(createApp()).get("/api/admin/dictionary-policies").set(asViewer)).status).toBe(403);
    expect((await request(createApp()).get("/api/admin/dictionaries").set(asAdmin).query({ limit: 10, offset: 0 })).status).toBe(200);
    const denied = await request(createApp()).post("/api/admin/dictionaries").set(asAdmin).send({
      category: "sessionStatuses",
      key: `${marker}-forbidden`,
      label: `${marker} forbidden`,
    });
    expect(denied.status).toBe(409);
    expect(denied.body.error).toMatch(/protected/i);
    expect(await prisma!.dictionary.count({ where: { label: `${marker} forbidden` } })).toBe(0);
  });

  it("creates and updates an editable value with immutable identity, exactly-one Audit, and optimistic concurrency", async () => {
    const created = await createDictionary("editable");
    expect(created).toMatchObject({ category: "requestCategories", key: `${normalizedMarker}_editable`, version: 1, sourceType: "ADMIN", isActive: true });
    expect(await prisma!.auditLog.count({ where: { entityType: "Dictionary", entityId: created.id, action: "dictionary_change" } })).toBe(1);

    const invalidIdentityEdit = await request(createApp()).patch(`/api/admin/dictionaries/${created.id}`).set(asAdmin).send({
      expectedVersion: created.version,
      key: `${marker}-changed`,
      category: "eventTypes",
      label: `${marker} changed`,
    });
    expect(invalidIdentityEdit.status).toBe(400);

    const first = await request(createApp()).patch(`/api/admin/dictionaries/${created.id}`).set(asAdmin).send({
      expectedVersion: created.version,
      label: `${marker} edited`,
      description: "Administrator-owned description",
      sortOrder: 800_000,
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ key: created.key, category: created.category, label: `${marker} edited`, version: 2 });

    const stale = await request(createApp()).patch(`/api/admin/dictionaries/${created.id}`).set(asAdmin).send({ expectedVersion: created.version, label: `${marker} stale overwrite` });
    expect(stale.status).toBe(409);
    expect((await prisma!.dictionary.findUniqueOrThrow({ where: { id: created.id } })).label).toBe(`${marker} edited`);
    const competing = await Promise.all([
      request(createApp()).patch(`/api/admin/dictionaries/${created.id}`).set(asAdmin).send({ expectedVersion: 2, label: `${marker} writer A` }),
      request(createApp()).patch(`/api/admin/dictionaries/${created.id}`).set(asAdmin).send({ expectedVersion: 2, label: `${marker} writer B` }),
    ]);
    expect(competing.filter((response) => response.status === 200)).toHaveLength(1);
    expect(competing.filter((response) => response.status === 409)).toHaveLength(1);
    expect(competing.find((response) => response.status === 409)!.body.error).not.toMatch(/P20|Prisma|SQL/i);
    expect(await prisma!.auditLog.count({ where: { entityType: "Dictionary", entityId: created.id, action: "dictionary_change" } })).toBe(3);
  });

  it("resolves concurrent semantic-key creation deterministically without duplicate rows or Audit", async () => {
    const body = createBody("Concurrent Key", { key: `${marker} Concurrent Key` });
    const attempts = await Promise.all(Array.from({ length: 8 }, () => request(createApp()).post("/api/admin/dictionaries").set(asAdmin).send(body)));
    expect(attempts.filter((response) => response.status === 201)).toHaveLength(1);
    expect(attempts.filter((response) => response.status === 409)).toHaveLength(7);
    const row = await prisma!.dictionary.findUniqueOrThrow({ where: { profile_category_normalizedKey: { profile: "lot-zpp", category: "requestCategories", normalizedKey: `${normalizedMarker}_concurrent_key` } } });
    dictionaryIds.add(row.id);
    expect(await prisma!.dictionary.count({ where: { profile: "lot-zpp", category: "requestCategories", normalizedKey: row.normalizedKey } })).toBe(1);
    expect(await prisma!.auditLog.count({ where: { entityType: "Dictionary", entityId: row.id } })).toBe(1);
  });

  it("reflects create, deactivation, historical readability, rejection, and reactivation through one authority", async () => {
    const created = await createDictionary("runtime");
    const firstBusinessWrite = await createWelfareRequest(created.label);
    expect(firstBusinessWrite.status, JSON.stringify(firstBusinessWrite.body)).toBe(201);

    const deactivated = await request(createApp()).post(`/api/admin/dictionaries/${created.id}/deactivate`).set(asAdmin).send({ expectedVersion: created.version });
    expect(deactivated.status, JSON.stringify(deactivated.body)).toBe(200);
    expect(deactivated.body).toMatchObject({ isActive: false, version: 2 });

    const publicAfter = await request(createApp()).get("/api/dictionaries").set(asAdmin);
    expect(publicAfter.status).toBe(200);
    expect(publicAfter.body.requestCategories.map((row: { label: string }) => row.label)).not.toContain(created.label);
    const historical = await request(createApp()).get(`/api/requests/${firstBusinessWrite.body.id}`).set(asAdmin).query({ sessionId: activeIncidentId });
    expect(historical.status).toBe(200);
    expect(historical.body.category).toBe(created.label);
    expect((await createWelfareRequest(created.label)).status).toBe(400);

    const reactivated = await request(createApp()).post(`/api/admin/dictionaries/${created.id}/reactivate`).set(asAdmin).send({ expectedVersion: 2 });
    expect(reactivated.status).toBe(200);
    expect(reactivated.body).toMatchObject({ isActive: true, version: 3 });
    expect((await createWelfareRequest(created.label)).status).toBe(201);

    const eventType = await createDictionary("runtime-event", { category: "eventTypes" });
    const firstSessionWrite = await createSession(eventType.label, "durable event type");
    expect(firstSessionWrite.status, JSON.stringify(firstSessionWrite.body)).toBe(201);
    const eventDeactivated = await request(createApp()).post(`/api/admin/dictionaries/${eventType.id}/deactivate`).set(asAdmin).send({ expectedVersion: eventType.version });
    expect(eventDeactivated.status).toBe(200);
    const publicEventAfter = await request(createApp()).get("/api/dictionaries").set(asAdmin);
    expect(publicEventAfter.body.eventTypes.map((row: { label: string }) => row.label)).not.toContain(eventType.label);
    const historicalSession = await request(createApp()).get(`/api/sessions/${firstSessionWrite.body.id}`).set(asAdmin);
    expect(historicalSession.status).toBe(200);
    expect(historicalSession.body.eventType).toBe(eventType.label);
    expect((await createSession(eventType.label, "inactive event rejected")).status).toBe(400);
    const rejectedPatch = await request(createApp()).patch(`/api/sessions/${firstSessionWrite.body.id}`).set(asAdmin).send({ eventType: eventType.label });
    expect(rejectedPatch.status).toBe(400);
    const eventReactivated = await request(createApp()).post(`/api/admin/dictionaries/${eventType.id}/reactivate`).set(asAdmin).send({ expectedVersion: 2 });
    expect(eventReactivated.status).toBe(200);
    expect((await createSession(eventType.label, "reactivated event accepted")).status).toBe(201);
  });

  it("rolls back dictionary and Audit atomically at every injected transaction failure seam", async () => {
    const admin = await prisma!.user.findUniqueOrThrow({ where: { email: "admin@lot.pl" }, select: { id: true, email: true, displayName: true } });
    for (const point of ["beforeMutation", "afterMutationBeforeAudit", "duringAudit", "beforeCommit"] as DictionaryFailurePoint[]) {
      const service = createPrismaDictionaryService(prisma!, { failAt: (candidate) => { if (candidate === point) throw new Error(`${marker}-${point}`); } });
      const response = await request(createApp({ dictionaryService: service })).post("/api/admin/dictionaries").set(asAdmin).send(createBody(`failure-${point}`));
      expect(response.status).toBe(500);
      expect(await prisma!.dictionary.count({ where: { label: `${marker} failure-${point}` } })).toBe(0);
      expect(await prisma!.auditLog.count({ where: { action: "dictionary_change", actorId: admin.id, summary: { contains: `failure_${point.toLowerCase()}` } } })).toBe(0);
    }
  });

  it("preserves administrator-owned state across canonical seed rerun while reconciling protected mirrors", async () => {
    await seedDictionaries(prisma!);
    const created = await createDictionary("seed-preserved");
    const eventCreated = await createDictionary("seed-preserved-event", { category: "eventTypes" });
    const changed = await request(createApp()).patch(`/api/admin/dictionaries/${created.id}`).set(asAdmin).send({
      expectedVersion: 1,
      label: `${marker} seed-owned label`,
      description: "must survive seed",
      sortOrder: 777_777,
    });
    expect(changed.status).toBe(200);
    const inactive = await request(createApp()).post(`/api/admin/dictionaries/${created.id}/deactivate`).set(asAdmin).send({ expectedVersion: 2 });
    expect(inactive.status).toBe(200);
    const eventChanged = await request(createApp()).patch(`/api/admin/dictionaries/${eventCreated.id}`).set(asAdmin).send({
      expectedVersion: 1,
      label: `${marker} seed-owned event label`,
      description: "event type must survive seed",
      sortOrder: 777_778,
    });
    expect(eventChanged.status).toBe(200);

    const protectedRow = await prisma!.dictionary.findFirstOrThrow({ where: { profile: "lot-zpp", category: "sessionStatuses" } });
    await prisma!.dictionary.update({ where: { id: protectedRow.id }, data: { label: `${marker} corrupt protected mirror`, isActive: false } });
    await seedDictionaries(prisma!);

    expect(await prisma!.dictionary.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
      label: `${marker} seed-owned label`, description: "must survive seed", sortOrder: 777_777, isActive: false, version: 3,
    });
    expect(await prisma!.dictionary.findUniqueOrThrow({ where: { id: eventCreated.id } })).toMatchObject({
      label: `${marker} seed-owned event label`, description: "event type must survive seed", sortOrder: 777_778, version: 2,
    });
    expect(await prisma!.dictionary.count({ where: { profile: "lot-zpp", category: created.category, normalizedKey: created.normalizedKey } })).toBe(1);
    expect(await prisma!.dictionary.count({ where: { profile: "lot-zpp", category: eventCreated.category, normalizedKey: eventCreated.normalizedKey } })).toBe(1);
    const restoredProtected = await prisma!.dictionary.findUniqueOrThrow({ where: { id: protectedRow.id } });
    expect(restoredProtected.label).not.toContain(marker);
    expect(restoredProtected.isActive).toBe(true);
  });

  it("is restart- and multi-instance-consistent and returns honest errors without static or demo fallback", async () => {
    const created = await createDictionary("instances");
    const instanceB = createApp();
    const publicFromB = await request(instanceB).get("/api/dictionaries").set(asAdmin);
    expect(publicFromB.body.requestCategories).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.id, label: created.label })]));
    const adminFromFresh = await request(createApp()).get("/api/admin/dictionaries").set(asAdmin).query({ category: "requestCategories", search: created.key, limit: 50, offset: 0 });
    expect(adminFromFresh.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.id })]));
    expect((await createWelfareRequest(created.label)).status).toBe(201);

    const durable = createPrismaDictionaryService(prisma!);
    const failingRead: DictionaryConfigurationService = { ...durable, async listAdmin() { throw new Error(`${marker}-admin-read`); } };
    expect((await request(createApp({ dictionaryService: failingRead })).get("/api/admin/dictionaries").set(asAdmin)).status).toBe(500);
    const failingPublic: DictionaryConfigurationService = { ...durable, async publicDictionaries() { throw new Error(`${marker}-public-read`); } };
    const publicFailure = await request(createApp({ dictionaryService: failingPublic })).get("/api/dictionaries").set(asAdmin);
    expect(publicFailure.status).toBe(500);
    expect(JSON.stringify(publicFailure.body)).not.toMatch(/Transport|Accommodation|demo/i);
    const failingValidation: DictionaryConfigurationService = { ...durable, async assertActiveLabel() { throw new Error(`${marker}-validation-read`); } };
    const commandFailure = await request(createApp({ dictionaryService: failingValidation })).post("/api/requests").set(asAdmin).send({
      sessionId: activeIncidentId,
      category: created.label,
      priority: "Normal",
      details: `${marker} must not persist`,
      approvalStatus: "Not required",
      operationId: randomUUID(),
    });
    expect(commandFailure.status).toBe(500);
    expect(await prisma!.request.count({ where: { details: `${marker} must not persist` } })).toBe(0);
    const sessionFailure = await request(createApp({ dictionaryService: failingValidation })).post("/api/sessions").set(asAdmin).send({
      mode: "TRAINING", status: "Draft", eventType: created.label, description: `${marker} failed event validation`,
    });
    expect(sessionFailure.status).toBe(500);
    expect(await prisma!.session.count({ where: { description: `${marker} failed event validation` } })).toBe(0);
  });

  it("pages and filters beyond 200 while public dictionaries return the complete active category", async () => {
    const scalePrefix = `${normalizedMarker}_scale`;
    await prisma!.dictionary.createMany({ data: Array.from({ length: 1_005 }, (_, index) => ({
      profile: "lot-zpp",
      category: "requestCategories",
      key: `${scalePrefix}_${String(index).padStart(4, "0")}`,
      normalizedKey: `${scalePrefix}_${String(index).padStart(4, "0")}`,
      label: `${marker} scale ${String(index).padStart(4, "0")}`,
      sortOrder: 500_000 + index,
      sourceType: "ADMIN",
    })) });

    const laterPage = await request(createApp()).get("/api/admin/dictionaries").set(asAdmin).query({ category: "requestCategories", search: `${marker} scale`, limit: 200, offset: 800 });
    expect(laterPage.status).toBe(200);
    expect(laterPage.body).toMatchObject({ total: 1_005, limit: 200, offset: 800 });
    expect(laterPage.body.data).toHaveLength(200);
    expect(laterPage.body.data[0].label).toBe(`${marker} scale 0800`);

    const publicResponse = await request(createApp()).get("/api/dictionaries").set(asAdmin);
    expect(publicResponse.status).toBe(200);
    const scaleRows = publicResponse.body.requestCategories.filter((row: { key: string }) => row.key.startsWith(scalePrefix));
    expect(scaleRows).toHaveLength(1_005);
    expect(scaleRows.at(-1).label).toBe(`${marker} scale 1004`);
  }, 30_000);
});
