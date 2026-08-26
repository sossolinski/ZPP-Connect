import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createPrismaIncidentRepository } from "./modules/incidents/prisma-incident-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;
const prisma = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;
const createdIncidentIds: string[] = [];

function asAdmin<T extends { set(name: string, value: string): T }>(test: T) {
  return test.set("x-user-email", "admin@lot.pl");
}

postgresDescribe("Foundation Stage 1 PostgreSQL vertical slice", () => {
  beforeAll(async () => {
    await prisma!.$connect();
    await prisma!.user.findUniqueOrThrow({ where: { email: "admin@lot.pl" } });
  });

  afterAll(async () => {
    if (!prisma) return;
    if (createdIncidentIds.length) {
      await prisma.caseTimelineEvent.deleteMany({ where: { sessionId: { in: createdIncidentIds } } });
      await prisma.auditLog.deleteMany({ where: { entityType: "session", entityId: { in: createdIncidentIds } } });
      await prisma.session.deleteMany({ where: { id: { in: createdIncidentIds } } });
    }
    await prisma.$disconnect();
  });

  it("persists a session across API instances and records close atomically", async () => {
    const firstApp = createApp({ incidentRepository: createPrismaIncidentRepository(prisma!) });
    const marker = `F1-${Date.now()}`;
    const created = await asAdmin(request(firstApp).post("/api/sessions")).send({
      mode: "EXERCISE",
      status: "Active",
      eventType: "Exercise",
      flightNumber: marker,
      route: "WAW-F1",
      description: "Foundation PostgreSQL persistence test"
    });
    expect(created.status).toBe(201);
    expect(created.body.id).toMatch(/^[0-9a-f-]{36}$/i);
    createdIncidentIds.push(created.body.id);

    const restartedApp = createApp({ incidentRepository: createPrismaIncidentRepository(prisma!) });
    const afterRestart = await asAdmin(request(restartedApp).get("/api/sessions")).query({ search: marker });
    expect(afterRestart.status).toBe(200);
    expect(afterRestart.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.body.id, flightNumber: marker })]));

    const closed = await asAdmin(request(restartedApp).post(`/api/sessions/${created.body.id}/close`)).send({
      notes: "Foundation persistence and atomic audit verified."
    });
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe("Closed");

    const [audit, timeline] = await Promise.all([
      prisma!.auditLog.findMany({ where: { sessionId: created.body.id }, orderBy: { createdAt: "asc" } }),
      prisma!.caseTimelineEvent.findMany({ where: { sessionId: created.body.id } })
    ]);
    expect(audit.map((item) => item.action)).toEqual(expect.arrayContaining([
      "create_session",
      "incident_assignment_assigned",
      "close_session"
    ]));
    expect(await prisma!.incidentAssignment.findUnique({
      where: { incidentId_userId: { incidentId: created.body.id, userId: (await prisma!.user.findUniqueOrThrow({ where: { email: "admin@lot.pl" } })).id } }
    })).toMatchObject({ active: true, function: "Incident creator" });
    expect(timeline).toEqual([expect.objectContaining({ eventType: "session", entityId: created.body.id })]);
  });

  it("allocates globally unique Session operational IDs during a burst larger than the former retry limit", async () => {
    const app = createApp({ incidentRepository: createPrismaIncidentRepository(prisma!) });
    const marker = `F1-BURST-${Date.now()}`;
    const responses = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      asAdmin(request(app).post("/api/sessions")).send({
        mode: index % 2 ? "EXERCISE" : "TRAINING",
        status: "Draft",
        eventType: "Training session",
        flightNumber: `${marker}-${index}`,
        description: `${marker} Concurrent Session ${index}`
      })
    ));

    expect(responses.map(({ status }) => status)).toEqual(Array(20).fill(201));
    const operationalIds = responses.map(({ body }) => body.operationalId as string);
    expect(new Set(operationalIds).size).toBe(20);
    expect(operationalIds.every((value) => /^SES-[0-9]{4}-[0-9]{3,}$/.test(value))).toBe(true);
    createdIncidentIds.push(...responses.map(({ body }) => body.id as string));

    const restartedApp = createApp({ incidentRepository: createPrismaIncidentRepository(prisma!) });
    const persisted = await asAdmin(request(restartedApp).get("/api/sessions")).query({ search: marker, limit: 50 });
    expect(persisted.status).toBe(200);
    expect(persisted.body).toMatchObject({ total: 20 });
    expect(new Set(persisted.body.data.map((row: { operationalId: string }) => row.operationalId)).size).toBe(20);
  });

  it("enforces backend authorization for session mutations", async () => {
    const app = createApp({ incidentRepository: createPrismaIncidentRepository(prisma!) });
    const payload = { mode: "TRAINING", status: "Draft", eventType: "Training session" };
    expect((await request(app).post("/api/sessions").send(payload)).status).toBe(401);
    expect((await request(app).post("/api/sessions").set("x-user-email", "viewer@lot.pl").send(payload)).status).toBe(403);
  });
});
