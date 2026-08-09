import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createPrismaEnquiryRepository } from "./modules/enquiries/prisma-enquiry-repository.js";
import { createPrismaIncidentAccessRepository } from "./modules/incident-access/prisma-incident-access-repository.js";
import { createPrismaIncidentRepository } from "./modules/incidents/prisma-incident-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;
const prisma = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;
const incidentIds: string[] = [];
const passengerIds: string[] = [];
const enquiryIds: string[] = [];

function as(email: string) {
  return { "x-user-email": email };
}

function application() {
  return createApp({
    incidentRepository: createPrismaIncidentRepository(prisma!),
    enquiryRepository: createPrismaEnquiryRepository(prisma!),
    incidentAccessRepository: createPrismaIncidentAccessRepository(prisma!)
  });
}

postgresDescribe("Foundation Stage 2 PostgreSQL Enquiry isolation", () => {
  let incidentA: string;
  let incidentB: string;
  let incidentC: string;
  let passengerB: string;

  beforeAll(async () => {
    await prisma!.$connect();
    const [admin, tec, viewer] = await Promise.all([
      prisma!.user.findUniqueOrThrow({ where: { email: "admin@lot.pl" } }),
      prisma!.user.findUniqueOrThrow({ where: { email: "tec@lot.pl" } }),
      prisma!.user.findUniqueOrThrow({ where: { email: "viewer@lot.pl" } })
    ]);
    const marker = Date.now();
    const [exercise, real, training] = await Promise.all([
      prisma!.session.create({ data: { operationalId: `F2-EX-${marker}`, mode: "EXERCISE", status: "Active", eventType: "Stage 2 isolation", createdById: admin.id } }),
      prisma!.session.create({ data: { operationalId: `F2-REAL-${marker}`, mode: "REAL", status: "Draft", eventType: "Stage 2 cross-mode", createdById: admin.id } }),
      prisma!.session.create({ data: { operationalId: `F2-TRAINING-${marker}`, mode: "TRAINING", status: "Active", eventType: "Stage 2 cross-mode", createdById: admin.id } })
    ]);
    incidentA = exercise.id;
    incidentB = real.id;
    incidentC = training.id;
    incidentIds.push(exercise.id, real.id, training.id);
    await prisma!.incidentAssignment.createMany({
      data: [
        { incidentId: incidentA, userId: tec.id, function: "TEC operator", createdById: admin.id },
        { incidentId: incidentA, userId: viewer.id, function: "Read-only observer", createdById: admin.id }
      ]
    });
    const passenger = await prisma!.passengerRecord.create({
      data: {
        operationalId: `F2-PAX-${marker}`,
        sessionId: incidentB,
        personType: "Passenger",
        firstName: "Cross",
        lastName: "Mode",
        source: "Manual",
        conditionStatus: "Unknown",
        holdStatus: "No hold",
        createdById: admin.id,
        updatedById: admin.id
      }
    });
    passengerB = passenger.id;
    passengerIds.push(passenger.id);
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.caseTimelineEvent.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.auditLog.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.matchingRecord.deleteMany({ where: { enquiryId: { in: enquiryIds } } });
    await prisma.enquiry.deleteMany({ where: { id: { in: enquiryIds } } });
    await prisma.passengerRecord.deleteMany({ where: { id: { in: passengerIds } } });
    await prisma.incidentAssignment.deleteMany({ where: { incidentId: { in: incidentIds } } });
    await prisma.session.deleteMany({ where: { id: { in: incidentIds } } });
    await prisma.$disconnect();
  });

  it("persists Enquiry across app instances and scopes reads across incidents and modes", async () => {
    const first = application();
    const createdA = await request(first).post("/api/enquiries").set(as("tec@lot.pl")).send({
      sessionId: incidentA,
      contactChannel: "Phone",
      callerName: "Persistent A",
      enquiryType: "Information request",
      urgency: "Normal",
      status: "New"
    });
    expect(createdA.status).toBe(201);
    enquiryIds.push(createdA.body.id);

    const createdB = await request(first).post("/api/enquiries").set(as("admin@lot.pl")).send({
      sessionId: incidentB,
      contactChannel: "Email",
      callerName: "Protected REAL B",
      enquiryType: "Information request",
      urgency: "Normal",
      status: "New"
    });
    expect(createdB.status).toBe(201);
    enquiryIds.push(createdB.body.id);

    const restarted = application();
    const persisted = await request(restarted).get(`/api/enquiries/${createdA.body.id}`).query({ sessionId: incidentA }).set(as("tec@lot.pl"));
    expect(persisted.status).toBe(200);
    expect(persisted.body).toMatchObject({ id: createdA.body.id, callerName: "Persistent A", version: 1 });

    expect((await request(restarted).get(`/api/enquiries/${createdB.body.id}`).query({ sessionId: incidentB }).set(as("tec@lot.pl"))).status).toBe(404);
    expect((await request(restarted).get("/api/enquiries").query({ sessionId: incidentB, search: "Protected REAL" }).set(as("tec@lot.pl"))).status).toBe(404);
    expect((await request(restarted).patch(`/api/enquiries/${createdB.body.id}`).set(as("tec@lot.pl")).send({
      sessionId: incidentB,
      version: 1,
      callerName: "Forbidden"
    })).status).toBe(404);

    await expect(prisma!.enquiry.update({
      where: { id: createdA.body.id },
      data: { passengerRecordId: passengerB }
    })).rejects.toThrow(/same incident/i);

    expect((await request(restarted).get(`/api/enquiries/${createdA.body.id}`).query({ sessionId: incidentA }).set(as("viewer@lot.pl"))).status).toBe(403);
    expect((await request(restarted).patch(`/api/enquiries/${createdA.body.id}`).set(as("viewer@lot.pl")).send({
      sessionId: incidentA,
      version: 1,
      callerName: "No permission"
    })).status).toBe(403);
  });

  it("creates 25 Enquiries concurrently in one Incident and continues safely after restart", async () => {
    const marker = `TEC-BURST-${Date.now()}`;
    const responses = await Promise.all(Array.from({ length: 25 }, (_, index) =>
      request(application()).post("/api/enquiries").set(as("tec@lot.pl")).send({
        sessionId: incidentA,
        contactChannel: "Phone",
        callerName: `${marker}-${index}`,
        enquiryType: "Information request",
        urgency: "Normal",
        status: "New"
      })
    ));

    expect(responses.map(({ status }) => status)).toEqual(Array(25).fill(201));
    const operationalIds = responses.map(({ body }) => body.operationalId as string);
    expect(new Set(operationalIds).size).toBe(25);
    expect(operationalIds.every((value) => /^TEC-[0-9]{4}-[0-9]{6,}$/.test(value))).toBe(true);
    enquiryIds.push(...responses.map(({ body }) => body.id as string));

    const restarted = application();
    const persisted = await request(restarted).get("/api/enquiries").query({ sessionId: incidentA, search: marker, limit: 50 }).set(as("tec@lot.pl"));
    expect(persisted.status).toBe(200);
    expect(persisted.body).toMatchObject({ total: 25 });
    expect(new Set(persisted.body.data.map((row: { operationalId: string }) => row.operationalId)).size).toBe(25);

    const priorMaximum = Math.max(...operationalIds.map((value) => Number(value.split("-").at(-1))));
    const afterRestart = await request(restarted).post("/api/enquiries").set(as("tec@lot.pl")).send({
      sessionId: incidentA,
      contactChannel: "Email",
      callerName: `${marker}-after-restart`,
      enquiryType: "Information request",
      urgency: "Normal",
      status: "New"
    });
    expect(afterRestart.status).toBe(201);
    expect(Number(String(afterRestart.body.operationalId).split("-").at(-1))).toBeGreaterThan(priorMaximum);
    enquiryIds.push(afterRestart.body.id);
  });

  it("keeps concurrent Enquiry IDs globally unique across REAL, EXERCISE and TRAINING Incidents", async () => {
    const marker = `TEC-CROSS-${Date.now()}`;
    const incidents = [incidentA, incidentB, incidentC];
    const responses = await Promise.all(Array.from({ length: 24 }, (_, index) =>
      request(application()).post("/api/enquiries").set(as("admin@lot.pl")).send({
        sessionId: incidents[index % incidents.length],
        contactChannel: index % 2 ? "Phone" : "Email",
        callerName: `${marker}-${index}`,
        enquiryType: "Information request",
        urgency: "Normal",
        status: "New"
      })
    ));

    expect(responses.map(({ status }) => status)).toEqual(Array(24).fill(201));
    const operationalIds = responses.map(({ body }) => body.operationalId as string);
    expect(new Set(operationalIds).size).toBe(24);
    enquiryIds.push(...responses.map(({ body }) => body.id as string));

    const persisted = await prisma!.enquiry.findMany({ where: { id: { in: responses.map(({ body }) => body.id) } }, select: { operationalId: true, sessionId: true } });
    expect(persisted).toHaveLength(24);
    expect(new Set(persisted.map(({ operationalId }) => operationalId)).size).toBe(24);
    expect(new Set(persisted.map(({ sessionId }) => sessionId))).toEqual(new Set(incidents));
  });

  it("enforces relation scope, protected transitions, concurrency, audit and closed incidents", async () => {
    const api = application();
    const crossLink = await request(api).post("/api/enquiries").set(as("tec@lot.pl")).send({
      sessionId: incidentA,
      contactChannel: "Phone",
      callerName: "Cross relation",
      passengerRecordId: passengerB,
      enquiryType: "Information request",
      urgency: "Normal",
      status: "New"
    });
    expect(crossLink.status).toBe(409);

    const list = await request(api).get("/api/enquiries").query({ sessionId: incidentA, search: "Persistent A" }).set(as("tec@lot.pl"));
    const record = list.body.data[0];
    const protectedPatch = await request(api).patch(`/api/enquiries/${record.id}`).set(as("tec@lot.pl")).send({
      sessionId: incidentA,
      version: record.version,
      status: "Closed"
    });
    expect(protectedPatch.status).toBe(400);

    const urgent = await request(api).post(`/api/enquiries/${record.id}/mark-urgent`).set(as("tec@lot.pl")).send({
      sessionId: incidentA,
      version: record.version,
      notes: "Escalated in PostgreSQL integration test"
    });
    expect(urgent.status).toBe(200);
    expect(urgent.body).toMatchObject({ status: "Urgent welfare", version: record.version + 1 });

    expect((await request(api).patch(`/api/enquiries/${record.id}`).set(as("tec@lot.pl")).send({
      sessionId: incidentA,
      version: record.version,
      callerLocation: "Stale update"
    })).status).toBe(409);

    const [audit, timeline] = await Promise.all([
      prisma!.auditLog.findMany({ where: { entityType: "enquiry", entityId: record.id }, orderBy: { createdAt: "asc" } }),
      prisma!.caseTimelineEvent.findMany({ where: { entityType: "enquiry", entityId: record.id }, orderBy: { occurredAt: "asc" } })
    ]);
    expect(audit.map((item) => item.action)).toEqual(["create_enquiry", "mark_urgent"]);
    expect(timeline).toHaveLength(2);

    await prisma!.session.update({ where: { id: incidentA }, data: { status: "Closed" } });
    expect((await request(api).patch(`/api/enquiries/${record.id}`).set(as("tec@lot.pl")).send({
      sessionId: incidentA,
      version: urgent.body.version,
      callerLocation: "Closed incident write"
    })).status).toBe(409);
  });
});
