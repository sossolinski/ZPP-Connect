import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createPrismaEnquiryRepository } from "./modules/enquiries/prisma-enquiry-repository.js";
import { createPrismaIncidentAccessRepository } from "./modules/incident-access/prisma-incident-access-repository.js";
import { createPrismaIncidentRepository } from "./modules/incidents/prisma-incident-repository.js";
import { createPrismaPassengerRepository } from "./modules/passengers/prisma-passenger-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;
const prisma = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;

function as(email: string) {
  return { "x-user-email": email };
}

function application() {
  return createApp({
    incidentRepository: createPrismaIncidentRepository(prisma!),
    enquiryRepository: createPrismaEnquiryRepository(prisma!),
    incidentAccessRepository: createPrismaIncidentAccessRepository(prisma!),
    passengerRepository: createPrismaPassengerRepository(prisma!)
  });
}

postgresDescribe("Foundation Stage 3 PostgreSQL Passenger persistence and source integrity", () => {
  const marker = `F3-${Date.now()}`;
  const incidentIds: string[] = [];
  let incidentA: string;
  let incidentB: string;
  let closedIncident: string;
  let coordinatorId: string;
  let tecId: string;
  let viewerId: string;
  let assignmentA: string;
  let passengerA: string;
  let passengerB: string;

  beforeAll(async () => {
    await prisma!.$connect();
    const [admin, coordinator, tec, viewer] = await Promise.all([
      prisma!.user.findUniqueOrThrow({ where: { email: "admin@lot.pl" } }),
      prisma!.user.findUniqueOrThrow({ where: { email: "coordinator@lot.pl" } }),
      prisma!.user.findUniqueOrThrow({ where: { email: "tec@lot.pl" } }),
      prisma!.user.findUniqueOrThrow({ where: { email: "viewer@lot.pl" } })
    ]);
    coordinatorId = coordinator.id;
    tecId = tec.id;
    viewerId = viewer.id;
    const [exercise, real, closed] = await Promise.all([
      prisma!.session.create({ data: { operationalId: `${marker}-EX`, mode: "EXERCISE", status: "Active", eventType: marker, createdById: admin.id } }),
      prisma!.session.create({ data: { operationalId: `${marker}-REAL`, mode: "REAL", status: "Draft", eventType: marker, createdById: admin.id } }),
      prisma!.session.create({ data: { operationalId: `${marker}-CLOSED`, mode: "TRAINING", status: "Closed", eventType: marker, createdById: admin.id } })
    ]);
    incidentA = exercise.id;
    incidentB = real.id;
    closedIncident = closed.id;
    incidentIds.push(incidentA, incidentB, closedIncident);
    const assignments = await Promise.all([
      prisma!.incidentAssignment.create({ data: { incidentId: incidentA, userId: coordinatorId, function: "Passenger coordinator", createdById: admin.id } }),
      prisma!.incidentAssignment.create({ data: { incidentId: closedIncident, userId: coordinatorId, function: "Historical reader", createdById: admin.id } }),
      prisma!.incidentAssignment.create({ data: { incidentId: incidentA, userId: tecId, function: "TEC linking test", createdById: admin.id } }),
      prisma!.incidentAssignment.create({ data: { incidentId: incidentA, userId: viewerId, function: "Read-only observer", createdById: admin.id } })
    ]);
    assignmentA = assignments[0].id;
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.matchingRecord.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.releaseAction.deleteMany({ where: { incidentId: { in: incidentIds } } });
    await prisma.request.deleteMany({ where: { incidentId: { in: incidentIds } } });
    await prisma.enquiry.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.passengerRecord.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.importBatch.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.caseTimelineEvent.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.auditLog.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.incidentAssignment.deleteMany({ where: { incidentId: { in: incidentIds } } });
    await prisma.session.deleteMany({ where: { id: { in: incidentIds } } });
    await prisma.$disconnect();
  });

  it("deploys the Passenger migration, constraints, indexes and atomic ID sequence", async () => {
    const migrations = await prisma!.$queryRaw<Array<{ migration_name: string }>>`
      SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL
    `;
    expect(migrations.map((row) => row.migration_name)).toContain("20260804020000_passenger_persistence_source_integrity");

    const indexes = await prisma!.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'PassengerRecord'
    `;
    expect(indexes.map((row) => row.indexname)).toEqual(expect.arrayContaining([
      "PassengerRecord_sessionId_updatedAt_idx",
      "PassengerRecord_sessionId_conditionStatus_updatedAt_idx",
      "PassengerRecord_sessionId_source_updatedAt_idx",
      "PassengerRecord_incident_source_external_unique"
    ]));
    const constraints = await prisma!.$queryRaw<Array<{ conname: string }>>`
      SELECT conname FROM pg_constraint WHERE conname LIKE 'PassengerRecord_%_check'
    `;
    expect(constraints.map((row) => row.conname)).toEqual(expect.arrayContaining([
      "PassengerRecord_version_positive_check",
      "PassengerRecord_age_range_check",
      "PassengerRecord_dob_age_check",
      "PassengerRecord_src_confirmation_check"
    ]));
    const sequence = await prisma!.$queryRaw<Array<{ name: string }>>`
      SELECT relname AS name FROM pg_class WHERE relkind = 'S' AND relname = 'PassengerRecord_operational_seq'
    `;
    expect(sequence).toHaveLength(1);
  });

  it("persists across app instances, scopes every mode, revokes immediately and preserves the admin override", async () => {
    const api = application();
    const createdA = await request(api).post("/api/passenger-records").set(as("coordinator@lot.pl")).send({
      sessionId: incidentA,
      personType: "Passenger",
      firstName: "Persistent",
      lastName: "Exercise",
      source: "Manifest",
      sourceExternalId: `${marker}-A`
    });
    expect(createdA.status).toBe(201);
    expect(createdA.body).toMatchObject({ version: 1, source: "Manifest", sourceExternalId: `${marker}-A` });
    passengerA = createdA.body.id;

    const createdB = await request(api).post("/api/passenger-records").set(as("admin@lot.pl")).send({
      sessionId: incidentB,
      personType: "Crew",
      firstName: "Protected",
      lastName: "Real",
      source: "Manual",
      sourceExternalId: `${marker}-B`
    });
    expect(createdB.status).toBe(201);
    passengerB = createdB.body.id;

    const restarted = application();
    expect((await request(restarted).get(`/api/passenger-records/${passengerA}`).query({ sessionId: incidentA }).set(as("coordinator@lot.pl"))).body).toMatchObject({ id: passengerA, firstName: "Persistent" });
    expect((await request(restarted).get(`/api/passenger-records/${passengerB}`).query({ sessionId: incidentB }).set(as("coordinator@lot.pl"))).status).toBe(404);
    expect((await request(restarted).get("/api/passenger-records").query({ sessionId: incidentB }).set(as("coordinator@lot.pl"))).status).toBe(404);
    expect((await request(restarted).get("/api/passenger-records").query({ sessionId: incidentB }).set(as("admin@lot.pl"))).status).toBe(200);
    expect((await request(restarted).get("/api/passenger-records").query({ sessionId: incidentA }).set(as("viewer@lot.pl"))).status).toBe(403);

    await prisma!.incidentAssignment.update({ where: { id: assignmentA }, data: { active: false, revokedAt: new Date(), revokeReason: "Stage 3 immediate revoke" } });
    expect((await request(restarted).get("/api/passenger-records").query({ sessionId: incidentA }).set(as("coordinator@lot.pl"))).status).toBe(404);
    await prisma!.incidentAssignment.update({ where: { id: assignmentA }, data: { active: true, revokedAt: null, revokeReason: null } });
    expect((await request(restarted).get("/api/passenger-records").query({ sessionId: incidentA }).set(as("coordinator@lot.pl"))).status).toBe(200);
  });

  it("protects source and decision fields, enforces concurrency, audits actions and blocks closed incidents", async () => {
    const api = application();
    const current = await request(api).get(`/api/passenger-records/${passengerA}`).query({ sessionId: incidentA }).set(as("coordinator@lot.pl"));
    expect((await request(api).patch(`/api/passenger-records/${passengerA}`).set(as("coordinator@lot.pl")).send({
      sessionId: incidentA,
      version: current.body.version,
      conditionStatus: "Released"
    })).status).toBe(400);

    const updated = await request(api).patch(`/api/passenger-records/${passengerA}`).set(as("coordinator@lot.pl")).send({
      sessionId: incidentA,
      version: current.body.version,
      notes: "PostgreSQL operator note"
    });
    expect(updated.body.version).toBe(current.body.version + 1);
    expect((await request(api).patch(`/api/passenger-records/${passengerA}`).set(as("coordinator@lot.pl")).send({ sessionId: incidentA, version: current.body.version, notes: "stale" })).status).toBe(409);

    const condition = await request(api).post(`/api/passenger-records/${passengerA}/change-condition`).set(as("coordinator@lot.pl")).send({
      sessionId: incidentA,
      version: updated.body.version,
      conditionStatus: "Hospital",
      basis: "Hospital liaison confirmed admission"
    });
    expect(condition.body).toMatchObject({ conditionStatus: "Hospital", conditionUpdatedById: coordinatorId });
    const hold = await request(api).post(`/api/passenger-records/${passengerA}/change-hold`).set(as("coordinator@lot.pl")).send({
      sessionId: incidentA,
      version: condition.body.version,
      holdStatus: "Police hold",
      reason: "Police liaison requested a hold"
    });
    const confirmed = await request(api).post(`/api/passenger-records/${passengerA}/mark-src-confirmed`).set(as("coordinator@lot.pl")).send({
      sessionId: incidentA,
      version: hold.body.version,
      basis: "SRC checked against roster"
    });
    expect(confirmed.body).toMatchObject({ srcConfirmed: true, srcConfirmedById: coordinatorId });
    const corrected = await request(api).post(`/api/passenger-records/${passengerA}/correct-source`).set(as("coordinator@lot.pl")).send({
      sessionId: incidentA,
      version: confirmed.body.version,
      seat: "22A",
      reason: "Manifest amendment received"
    });
    expect(corrected.body).toMatchObject({ seat: "22A", srcConfirmed: false });

    const [audit, timeline] = await Promise.all([
      prisma!.auditLog.findMany({ where: { entityType: "passengerRecord", entityId: passengerA } }),
      prisma!.caseTimelineEvent.findMany({ where: { entityType: "passengerRecord", entityId: passengerA } })
    ]);
    expect(audit.map((row) => row.action)).toEqual(expect.arrayContaining(["update_passenger_record", "change_passenger_condition", "change_passenger_hold", "mark_src_confirmed", "correct_passenger_source"]));
    expect(timeline.length).toBeGreaterThanOrEqual(5);

    expect((await request(api).post("/api/passenger-records").set(as("coordinator@lot.pl")).send({
      sessionId: closedIncident,
      personType: "Passenger",
      firstName: "Closed",
      lastName: "Incident",
      source: "Manual"
    })).status).toBe(409);
  });

  it("enforces Passenger-Enquiry incident integrity in the service and database", async () => {
    const api = application();
    const linked = await request(api).post("/api/enquiries").set(as("tec@lot.pl")).send({
      sessionId: incidentA,
      contactChannel: "Phone",
      callerName: "Passenger linkage",
      passengerRecordId: passengerA,
      enquiryType: "Information request",
      urgency: "Normal",
      status: "New"
    });
    expect(linked.status).toBe(201);
    expect((await request(api).post("/api/enquiries").set(as("tec@lot.pl")).send({
      sessionId: incidentA,
      contactChannel: "Phone",
      callerName: "Cross incident linkage",
      passengerRecordId: passengerB,
      enquiryType: "Information request",
      urgency: "Normal",
      status: "New"
    })).status).toBe(409);
    await expect(prisma!.enquiry.update({ where: { id: linked.body.id }, data: { passengerRecordId: passengerB } })).rejects.toThrow(/same incident/i);
  });

  it("imports 1000 rows through the controlled endpoint, survives restart and never writes through compatibility consumers", async () => {
    const rows = Array.from({ length: 1_000 }, (_, index) => [
      `Passenger${index}`,
      index === 777 ? "SearchTarget" : "Scale",
      "Passenger",
      "LO999",
      "Manifest",
      `${marker}-ROW-${index}`
    ].join(","));
    const csv = ["firstName,lastName,personType,flightNumber,source,sourceExternalId", ...rows].join("\n");
    const api = application();
    const validated = await request(api)
      .post("/api/imports/manifest")
      .set(as("coordinator@lot.pl"))
      .field("sessionId", incidentA)
      .attach("file", Buffer.from(csv), { filename: "stage3-manifest.csv", contentType: "text/csv" });
    expect(validated.status).toBe(201);
    expect(validated.body).toMatchObject({ totalRecords: 1_000, validRecords: 1_000, invalidRecords: 0 });
    const confirmed = await request(api).post(`/api/imports/${validated.body.id}/confirm`).set(as("coordinator@lot.pl")).send({ sessionId: incidentA });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("Imported");

    expect(await prisma!.passengerRecord.count({ where: { sessionId: incidentA, sourceBatchId: validated.body.id } })).toBe(1_000);
    const aggregateAudit = await prisma!.auditLog.findMany({ where: { sessionId: incidentA, action: "import_passenger_manifest", entityId: validated.body.id } });
    expect(aggregateAudit).toHaveLength(1);
    const perRecordAudit = await prisma!.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count
      FROM "AuditLog" audit
      JOIN "PassengerRecord" passenger ON passenger."id"::text = audit."entityId"
      WHERE passenger."sourceBatchId" = ${validated.body.id}::uuid
        AND audit."action" = 'create_passenger_record'
    `;
    expect(Number(perRecordAudit[0]?.count ?? 0)).toBe(0);

    const restarted = application();
    const page = await request(restarted).get("/api/passenger-records").set(as("coordinator@lot.pl")).query({
      sessionId: incidentA,
      sourceBatchId: validated.body.id,
      limit: 25,
      offset: 500,
      sortBy: "operationalId",
      sortDirection: "asc"
    });
    expect(page.body).toMatchObject({ total: 1_000 });
    expect(page.body.data).toHaveLength(25);
    const search = await request(restarted).get("/api/passenger-records").set(as("coordinator@lot.pl")).query({ sessionId: incidentA, search: "searchtarget" });
    expect(search.body.data).toHaveLength(1);

    const before = await prisma!.passengerRecord.count({ where: { sessionId: incidentA } });
    expect((await request(restarted).get("/api/dashboard").set(as("coordinator@lot.pl")).query({ sessionId: incidentA })).status).toBe(200);
    expect((await request(restarted).get("/api/matching-records/suggestions").set(as("coordinator@lot.pl")).query({ sessionId: incidentA })).status).toBe(200);
    expect((await request(restarted).get("/api/exports/passenger-register").set(as("coordinator@lot.pl")).query({ sessionId: incidentA })).status).toBe(200);
    expect(await prisma!.passengerRecord.count({ where: { sessionId: incidentA } })).toBe(before);
  });

  it("allocates unique operational IDs under concurrent creates", async () => {
    const api = application();
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => request(api).post("/api/passenger-records").set(as("coordinator@lot.pl")).send({
      sessionId: incidentA,
      personType: "Passenger",
      firstName: "Concurrent",
      lastName: String(index),
      source: "Manual",
      sourceExternalId: `${marker}-CONCURRENT-${index}`
    })));
    expect(results.every((result) => result.status === 201)).toBe(true);
    expect(new Set(results.map((result) => result.body.operationalId)).size).toBe(12);
  });
});
