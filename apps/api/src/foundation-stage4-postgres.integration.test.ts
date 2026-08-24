import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createPrismaFamilyRepository } from "./modules/families/prisma-family-repository.js";
import { createPrismaIncidentAccessRepository } from "./modules/incident-access/prisma-incident-access-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;
const prisma = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;

function as(email: string) {
  return { "x-user-email": email };
}

function application() {
  return createApp({
    familyRepository: createPrismaFamilyRepository(prisma!),
    incidentAccessRepository: createPrismaIncidentAccessRepository(prisma!)
  });
}

postgresDescribe("Foundation Stage 4 PostgreSQL Family/NOK relationship claims", () => {
  const marker = `F4-${Date.now()}`;
  const incidentIds: string[] = [];
  const batchIds: string[] = [];
  let incidentA: string;
  let incidentB: string;
  let closedIncident: string;
  let coordinatorId: string;
  let adminId: string;
  let assignmentA: string;
  let passengerA: string;
  let passengerB: string;
  let familyA: string;

  beforeAll(async () => {
    await prisma!.$connect();
    const [admin, coordinator, tec] = await Promise.all([
      prisma!.user.findUniqueOrThrow({ where: { email: "admin@lot.pl" } }),
      prisma!.user.findUniqueOrThrow({ where: { email: "coordinator@lot.pl" } }),
      prisma!.user.findUniqueOrThrow({ where: { email: "tec@lot.pl" } })
    ]);
    adminId = admin.id;
    coordinatorId = coordinator.id;
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
      prisma!.incidentAssignment.create({ data: { incidentId: incidentA, userId: coordinator.id, function: "Family coordinator", createdById: admin.id } }),
      prisma!.incidentAssignment.create({ data: { incidentId: closedIncident, userId: coordinator.id, function: "Historical reader", createdById: admin.id } }),
      prisma!.incidentAssignment.create({ data: { incidentId: incidentA, userId: tec.id, function: "TEC family reader", createdById: admin.id } })
    ]);
    assignmentA = assignments[0].id;
    const [first, second] = await Promise.all([
      prisma!.passengerRecord.create({ data: { operationalId: `${marker}-PAX-A`, sessionId: incidentA, personType: "Passenger", firstName: "Passenger", lastName: "Alpha", source: "Manual", createdById: admin.id, updatedById: admin.id } }),
      prisma!.passengerRecord.create({ data: { operationalId: `${marker}-PAX-B`, sessionId: incidentB, personType: "Passenger", firstName: "Passenger", lastName: "Beta", source: "Manual", createdById: admin.id, updatedById: admin.id } })
    ]);
    passengerA = first.id;
    passengerB = second.id;
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.matchingRecord.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.releaseAction.deleteMany({ where: { incidentId: { in: incidentIds } } });
    await prisma.request.deleteMany({ where: { incidentId: { in: incidentIds } } });
    await prisma.enquiry.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.familyRecord.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.passengerRecord.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.importBatch.deleteMany({ where: { id: { in: batchIds } } });
    await prisma.caseTimelineEvent.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.auditLog.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.incidentAssignment.deleteMany({ where: { incidentId: { in: incidentIds } } });
    await prisma.session.deleteMany({ where: { id: { in: incidentIds } } });
    await prisma.$disconnect();
  });

  it("deploys the relationship migration, guarded constraints, indexes and ID sequence", async () => {
    const migrations = await prisma!.$queryRaw<Array<{ migration_name: string }>>`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`;
    expect(migrations.map((row) => row.migration_name)).toContain("20260805020000_family_relationship_claims");
    const indexes = await prisma!.$queryRaw<Array<{ indexname: string }>>`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename IN ('FamilyRecord', 'RelationshipClaim')`;
    expect(indexes.map((row) => row.indexname)).toEqual(expect.arrayContaining(["FamilyRecord_sessionId_verificationStatus_updatedAt_idx", "RelationshipClaim_one_current_per_family", "RelationshipClaim_incidentId_passengerRecordId_idx"]));
    const constraints = await prisma!.$queryRaw<Array<{ conname: string }>>`SELECT conname FROM pg_constraint WHERE conname IN ('FamilyRecord_version_check', 'RelationshipClaim_version_check', 'RelationshipVerificationDecision_versions_check')`;
    expect(constraints).toHaveLength(3);
    const triggers = await prisma!.$queryRaw<Array<{ tgname: string }>>`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'Relationship%incident_guard'`;
    expect(triggers.map((row) => row.tgname)).toEqual(expect.arrayContaining(["RelationshipClaim_incident_guard", "RelationshipVerificationDecision_incident_guard"]));
    const sequence = await prisma!.$queryRaw<Array<{ name: string }>>`SELECT relname AS name FROM pg_class WHERE relkind = 'S' AND relname = 'FamilyRecord_operational_seq'`;
    expect(sequence).toHaveLength(1);
  });

  it("persists across restarts and enforces assignment, mode, permission, revoke and closed state", async () => {
    const api = application();
    const created = await request(api).post("/api/family-records").set(as("coordinator@lot.pl")).send({ sessionId: incidentA, firstName: "Persistent", lastName: "NOK", phone: "+48 600-100-100", email: " PERSISTENT@EXAMPLE.TEST ", claimedRelationship: "Sibling", passengerRecordId: passengerA });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ version: 1, normalizedPhone: "+48600100100", normalizedEmail: "persistent@example.test", verificationStatus: "Unverified", currentClaim: { status: "PENDING", passengerRecordId: passengerA } });
    expect(created.body.currentClaim).not.toHaveProperty("passengerRecord");
    familyA = created.body.id;

    const restarted = application();
    expect((await request(restarted).get(`/api/family-records/${familyA}`).query({ sessionId: incidentA }).set(as("coordinator@lot.pl"))).body.id).toBe(familyA);
    expect((await request(restarted).get("/api/family-records").query({ sessionId: incidentB }).set(as("coordinator@lot.pl"))).status).toBe(403);
    expect((await request(restarted).get("/api/family-records").query({ sessionId: incidentB }).set(as("admin@lot.pl"))).status).toBe(200);
    expect((await request(restarted).post("/api/family-records").set(as("tec@lot.pl")).send({ sessionId: incidentA, firstName: "Wrong", lastName: "Permission" })).status).toBe(403);
    expect((await request(restarted).post("/api/family-records").set(as("coordinator@lot.pl")).send({ sessionId: closedIncident, firstName: "Closed", lastName: "Incident" })).status).toBe(409);

    await prisma!.incidentAssignment.update({ where: { id: assignmentA }, data: { active: false, revokedAt: new Date(), revokeReason: "Stage 4 immediate revoke" } });
    expect((await request(restarted).get("/api/family-records").query({ sessionId: incidentA }).set(as("coordinator@lot.pl"))).status).toBe(403);
    await prisma!.incidentAssignment.update({ where: { id: assignmentA }, data: { active: true, revokedAt: null, revokeReason: null } });
  });

  it("requires human commands, preserves decision history and resolves concurrent decisions once", async () => {
    const api = application();
    const current = await request(api).get(`/api/family-records/${familyA}`).query({ sessionId: incidentA }).set(as("coordinator@lot.pl"));
    expect((await request(api).patch(`/api/family-records/${familyA}`).set(as("coordinator@lot.pl")).send({ sessionId: incidentA, version: current.body.version, verificationStatus: "Verified" })).status).toBe(400);

    const body = { sessionId: incidentA, version: current.body.version, claimVersion: current.body.currentClaim.version, basis: "Identity and relationship documents reviewed", verifiedRelationshipType: "Sibling" };
    const [operatorA, operatorB] = await Promise.all([
      request(api).post(`/api/family-records/${familyA}/verify`).set(as("coordinator@lot.pl")).send(body),
      request(api).post(`/api/family-records/${familyA}/reject`).set(as("admin@lot.pl")).send({ ...body, basis: "Conflicting evidence" })
    ]);
    expect([operatorA.status, operatorB.status].sort()).toEqual([200, 409]);
    const decided = operatorA.status === 200 ? operatorA.body : operatorB.body;
    expect(decided.currentClaim.decisions).toHaveLength(1);
    expect(decided.currentClaim.decisions[0]).toMatchObject({ decisionById: expect.any(String), basis: expect.any(String), claimVersionBefore: 1, claimVersionAfter: 2 });

    const terminal = await request(api).get(`/api/family-records/${familyA}`).query({ sessionId: incidentA }).set(as("coordinator@lot.pl"));
    const reopened = await request(api).post(`/api/family-records/${familyA}/reopen`).set(as("coordinator@lot.pl")).send({ sessionId: incidentA, version: terminal.body.version, claimVersion: terminal.body.currentClaim.version, basis: "New evidence requires human review" });
    expect(reopened.status).toBe(200);
    const rejected = await request(api).post(`/api/family-records/${familyA}/reject`).set(as("coordinator@lot.pl")).send({ sessionId: incidentA, version: reopened.body.version, claimVersion: reopened.body.currentClaim.version, basis: "Evidence does not support the claimed relationship" });
    expect(rejected.body).toMatchObject({ verificationStatus: "Rejected", currentClaim: { status: "REJECTED" } });

    const corrected = await request(api).post(`/api/family-records/${familyA}/correct-claim`).set(as("coordinator@lot.pl")).send({ sessionId: incidentA, version: rejected.body.version, claimVersion: rejected.body.currentClaim.version, lastName: "Corrected", reason: "Claimant corrected identity information" });
    expect(corrected.body).toMatchObject({ verificationStatus: "Review required", currentClaim: { status: "PENDING", version: 1 } });
    const history = await prisma!.relationshipVerificationDecision.findMany({ where: { incidentId: incidentA, relationshipClaim: { familyRecordId: familyA } } });
    expect(history.length).toBeGreaterThanOrEqual(2);
    const audit = await prisma!.auditLog.findMany({ where: { sessionId: incidentA, entityId: familyA } });
    expect(audit.map((row) => row.action)).toEqual(expect.arrayContaining(["create_family_record", "correct_family_claim"]));
    expect(JSON.stringify(audit)).not.toContain("persistent@example.test");
  });

  it("enforces same-incident Passenger links in service and PostgreSQL while allowing multiple NOK", async () => {
    const api = application();
    expect((await request(api).post("/api/family-records").set(as("coordinator@lot.pl")).send({ sessionId: incidentA, firstName: "Cross", lastName: "Incident", passengerRecordId: passengerB })).status).toBe(409);
    const first = await request(api).post("/api/family-records").set(as("coordinator@lot.pl")).send({ sessionId: incidentA, firstName: "First", lastName: "Claimant", claimedRelationship: "Parent", passengerRecordId: passengerA });
    const second = await request(api).post("/api/family-records").set(as("coordinator@lot.pl")).send({ sessionId: incidentA, firstName: "Second", lastName: "Claimant", claimedRelationship: "Sibling", passengerRecordId: passengerA });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await prisma!.relationshipClaim.count({ where: { incidentId: incidentA, passengerRecordId: passengerA, isCurrent: true } })).toBeGreaterThanOrEqual(2);
    await expect(prisma!.relationshipClaim.create({ data: { incidentId: incidentA, familyRecordId: first.body.id, passengerRecordId: passengerB, status: "PENDING", isCurrent: false, source: "DIRECT_DB_TEST" } })).rejects.toThrow(/same incident/);
  });

  it("imports and paginates 1000 records atomically with one aggregate audit", async () => {
    const rows = Array.from({ length: 1_000 }, (_, index) => [`Scale${index}`, index === 777 ? "TargetFamily" : "Load", `family-${index}@example.test`, index % 2 ? "Sibling" : "Parent"].join(","));
    const csv = ["firstName,lastName,email,claimedRelationship", ...rows].join("\n");
    const createAuditBefore = await prisma!.auditLog.count({ where: { sessionId: incidentA, action: "create_family_record" } });
    const api = application();
    const validated = await request(api).post("/api/imports/family").set(as("coordinator@lot.pl")).field("sessionId", incidentA).field("operationId", randomUUID()).attach("file", Buffer.from(csv), { filename: "family-1000.csv", contentType: "text/csv" });
    expect(validated.status).toBe(201);
    expect(validated.body).toMatchObject({ totalRecords: 1_000, validRecords: 1_000, invalidRecords: 0 });
    batchIds.push(validated.body.id);
    const confirmed = await request(api).post(`/api/imports/${validated.body.id}/confirm`).set(as("coordinator@lot.pl")).send({ sessionId: incidentA });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("Imported");
    const batchId = validated.body.id;
    expect(await prisma!.familyRecord.count({ where: { sessionId: incidentA, sourceBatchId: batchId } })).toBe(1_000);
    expect(await prisma!.relationshipClaim.count({ where: { incidentId: incidentA, familyRecord: { sourceBatchId: batchId } } })).toBe(1_000);
    expect(await prisma!.auditLog.count({ where: { sessionId: incidentA, action: "import_family_records", entityId: batchId } })).toBe(1);
    expect(await prisma!.auditLog.count({ where: { sessionId: incidentA, action: "create_family_record" } })).toBe(createAuditBefore);

    const restarted = application();
    const page = await request(restarted).get("/api/family-records").query({ sessionId: incidentA, search: "Scale", relationship: "Sibling", limit: 25, offset: 25, sortBy: "lastName", sortDirection: "asc" }).set(as("coordinator@lot.pl"));
    expect(page.status).toBe(200);
    expect(page.body.total).toBe(500);
    expect(page.body.data).toHaveLength(25);
    const search = await request(restarted).get("/api/family-records").query({ sessionId: incidentA, search: "targetfamily" }).set(as("coordinator@lot.pl"));
    expect(search.body.data.some((row: Record<string, unknown>) => row.lastName === "TargetFamily")).toBe(true);
  });

  it("keeps Matching suggestions read-only and compatibility consumers from writing Family", async () => {
    const before = await prisma!.familyRecord.count({ where: { sessionId: incidentA } });
    const claimBefore = await prisma!.relationshipClaim.count({ where: { incidentId: incidentA, status: "VERIFIED" } });
    const api = application();
    expect((await request(api).get("/api/matching-records/suggestions").query({ sessionId: incidentA }).set(as("coordinator@lot.pl"))).status).toBe(200);
    expect((await request(api).get("/api/dashboard").query({ sessionId: incidentA }).set(as("coordinator@lot.pl"))).status).toBe(200);
    expect(await prisma!.familyRecord.count({ where: { sessionId: incidentA } })).toBe(before);
    expect(await prisma!.relationshipClaim.count({ where: { incidentId: incidentA, status: "VERIFIED" } })).toBe(claimBefore);
  });

  it("allocates unique Family operational IDs under concurrent registration", async () => {
    const api = application();
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => request(api).post("/api/family-records").set(as("coordinator@lot.pl")).send({ sessionId: incidentA, firstName: "Concurrent", lastName: `${marker}-${index}`, claimedRelationship: "Other" })));
    expect(results.every((result) => result.status === 201)).toBe(true);
    expect(new Set(results.map((result) => result.body.operationalId)).size).toBe(12);
  });
});
