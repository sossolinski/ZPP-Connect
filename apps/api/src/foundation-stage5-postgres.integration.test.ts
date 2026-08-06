import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createPrismaFamilyRepository } from "./modules/families/prisma-family-repository.js";
import { createPrismaIncidentAccessRepository } from "./modules/incident-access/prisma-incident-access-repository.js";
import { createPrismaMatchingRepository } from "./modules/matching/prisma-matching-repository.js";
import { createPrismaPassengerRepository } from "./modules/passengers/prisma-passenger-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;
const prisma = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;

function as(email: string) {
  return { "x-user-email": email };
}

function application() {
  return createApp({
    passengerRepository: createPrismaPassengerRepository(prisma!),
    familyRepository: createPrismaFamilyRepository(prisma!),
    matchingRepository: createPrismaMatchingRepository(prisma!),
    incidentAccessRepository: createPrismaIncidentAccessRepository(prisma!)
  });
}

postgresDescribe("Foundation Stage 5 PostgreSQL matching persistence and concurrency", () => {
  const marker = `F5-${Date.now()}`;
  const incidentIds: string[] = [];
  let incidentA: string;
  let incidentB: string;
  let closedIncident: string;
  let coordinatorId: string;
  let adminId: string;
  let assignmentA: string;
  let passengerA: any;
  let passengerB: any;
  let familyA: any;
  let claimA: any;
  let suggestionA: any;
  let operationA: string;

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
      prisma!.incidentAssignment.create({ data: { incidentId: incidentA, userId: coordinator.id, function: "Matching coordinator", createdById: admin.id } }),
      prisma!.incidentAssignment.create({ data: { incidentId: incidentA, userId: tec.id, function: "Matching reader", createdById: admin.id } }),
      prisma!.incidentAssignment.create({ data: { incidentId: closedIncident, userId: coordinator.id, function: "Historical reader", createdById: admin.id } })
    ]);
    assignmentA = assignments[0].id;
    const api = application();
    passengerA = (await request(api).post("/api/passenger-records").set(as("coordinator@lot.pl")).send({ sessionId: incidentA, caseId: `${marker}-CASE-A`, personType: "Passenger", firstName: "Jan", lastName: `${marker}-Alpha`, flightNumber: `${marker}-LO1`, source: "Manual" })).body;
    passengerB = (await request(api).post("/api/passenger-records").set(as("admin@lot.pl")).send({ sessionId: incidentB, caseId: `${marker}-CASE-B`, personType: "Passenger", firstName: "Real", lastName: `${marker}-Beta`, flightNumber: `${marker}-LO2`, source: "Manual" })).body;
    familyA = (await request(api).post("/api/family-records").set(as("coordinator@lot.pl")).send({ sessionId: incidentA, caseId: `${marker}-CASE-A`, firstName: "NOK", lastName: `${marker}-Primary`, claimedRelationship: "Parent", passengerFirstName: passengerA.firstName, passengerLastName: passengerA.lastName, passengerFlight: passengerA.flightNumber })).body;
    claimA = familyA.currentClaim;
    await prisma!.familyRecord.create({ data: { operationalId: `${marker}-CLOSED-FAM`, sessionId: closedIncident, firstName: "Closed", lastName: "NOK", claimedRelationship: "Parent", verificationStatus: "Unverified", createdById: admin.id, updatedById: admin.id, relationshipClaims: { create: { incidentId: closedIncident, claimedRelationshipType: "Parent", source: "TEST", status: "PENDING", claimedById: admin.id } } } });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.releaseAction.deleteMany({ where: { incidentId: { in: incidentIds } } });
    await prisma.matchDecision.deleteMany({ where: { incidentId: { in: incidentIds } } });
    await prisma.matchingRecord.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.matchSuggestion.deleteMany({ where: { incidentId: { in: incidentIds } } });
    await prisma.relationshipVerificationDecision.deleteMany({ where: { incidentId: { in: incidentIds } } });
    await prisma.familyRecord.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.passengerRecord.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.caseTimelineEvent.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.auditLog.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.incidentAssignment.deleteMany({ where: { incidentId: { in: incidentIds } } });
    await prisma.session.deleteMany({ where: { id: { in: incidentIds } } });
    await prisma.$disconnect();
  });

  it("deploys Stage 5 tables, checks, partial uniqueness, triggers and the atomic ID sequence", async () => {
    const migrations = await prisma!.$queryRaw<Array<{ migration_name: string }>>`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`;
    expect(migrations.map((row) => row.migration_name)).toContain("20260805030000_matching_suggestions_decisions");
    const indexes = await prisma!.$queryRaw<Array<{ indexname: string }>>`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename IN ('MatchSuggestion', 'MatchDecision', 'MatchingRecord')`;
    expect(indexes.map((row) => row.indexname)).toEqual(expect.arrayContaining([
      "MatchSuggestion_current_candidate_key",
      "MatchDecision_incidentId_operationId_key",
      "MatchDecision_current_confirmed_claim_key",
      "MatchingRecord_sessionId_relationshipClaimId_idx"
    ]));
    const checks = await prisma!.$queryRaw<Array<{ conname: string }>>`SELECT conname FROM pg_constraint WHERE conname IN ('MatchSuggestion_score_check', 'MatchDecision_current_confirmed_check', 'MatchingRecord_version_check')`;
    expect(checks).toHaveLength(3);
    const triggers = await prisma!.$queryRaw<Array<{ tgname: string }>>`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('MatchSuggestion_same_incident', 'MatchDecision_same_incident', 'MatchingRecord_projection_same_incident')`;
    expect(triggers).toHaveLength(3);
    const sequence = await prisma!.$queryRaw<Array<{ name: string }>>`SELECT relname AS name FROM pg_class WHERE relkind = 'S' AND relname = 'MatchingRecord_operational_seq'`;
    expect(sequence).toHaveLength(1);
  });

  it("persists suggestions independently, records provenance and safely recovers a timed-out confirmation", async () => {
    const api = application();
    const generated = await request(api).post(`/api/matching/claims/${claimA.id}/suggestions/generate`).set(as("coordinator@lot.pl")).send({ sessionId: incidentA, expectedClaimVersion: claimA.version });
    expect(generated.status).toBe(201);
    suggestionA = generated.body.data.find((item: any) => item.passengerRecordId === passengerA.id);
    expect(suggestionA).toMatchObject({ algorithm: "zpp-deterministic-candidate", algorithmVersion: "1.0.0", status: "ACTIVE", positiveSignals: expect.any(Array), conflicts: expect.any(Array) });
    expect(await prisma!.matchDecision.count({ where: { relationshipClaimId: claimA.id } })).toBe(0);
    expect(await prisma!.matchingRecord.count({ where: { relationshipClaimId: claimA.id } })).toBe(0);

    operationA = randomUUID();
    const command = { sessionId: incidentA, passengerRecordId: passengerA.id, suggestionId: suggestionA.id, reason: "Human reviewed persisted algorithm evidence and source records.", expectedClaimVersion: claimA.version, expectedPassengerVersion: passengerA.version, operationId: operationA };
    const first = await request(api).post(`/api/matching/claims/${claimA.id}/confirm`).set(as("coordinator@lot.pl")).send(command);
    const retryAfterUnknownOutcome = await request(application()).post(`/api/matching/claims/${claimA.id}/confirm`).set(as("coordinator@lot.pl")).send(command);
    expect(first.status).toBe(200);
    expect(retryAfterUnknownOutcome.status).toBe(200);
    expect(retryAfterUnknownOutcome.body.idempotent).toBe(true);
    expect(await prisma!.matchDecision.count({ where: { incidentId: incidentA, operationId: operationA } })).toBe(1);
    const projection = await prisma!.matchingRecord.findFirstOrThrow({ where: { relationshipClaimId: claimA.id }, include: { suggestion: true } });
    expect(projection).toMatchObject({ matchScore: suggestionA.score, suggestion: { algorithm: "zpp-deterministic-candidate", algorithmVersion: "1.0.0" } });
    expect(await prisma!.relationshipClaim.findUniqueOrThrow({ where: { id: claimA.id } })).toMatchObject({ status: "PENDING", version: claimA.version });
    expect(await prisma!.passengerRecord.findUniqueOrThrow({ where: { id: passengerA.id } })).toMatchObject({ version: passengerA.version, conditionStatus: "Unknown", holdStatus: "No hold" });

    const regenerated = await request(application()).post(`/api/matching/claims/${claimA.id}/suggestions/generate`).set(as("coordinator@lot.pl")).send({ sessionId: incidentA, expectedClaimVersion: claimA.version });
    expect(regenerated.status).toBe(201);
    expect(regenerated.body.data[0].id).not.toBe(suggestionA.id);
    expect(await prisma!.matchSuggestion.findUniqueOrThrow({ where: { id: suggestionA.id } })).toMatchObject({ status: "OBSOLETE", isCurrent: false });
    expect(await prisma!.matchDecision.findFirstOrThrow({ where: { incidentId: incidentA, operationId: operationA } })).toMatchObject({ suggestionId: suggestionA.id, decision: "CONFIRMED" });
    const decisionAudit = await prisma!.auditLog.findFirstOrThrow({ where: { sessionId: incidentA, action: "confirm_suggested_match" } });
    expect(decisionAudit).toMatchObject({ actorId: coordinatorId, actorEmail: "coordinator@lot.pl", entityType: "matchDecision" });
    expect(decisionAudit.metadata).toMatchObject({ relationshipClaimId: claimA.id, passengerRecordId: passengerA.id, suggestionId: suggestionA.id, algorithm: "zpp-deterministic-candidate", algorithmVersion: "1.0.0", claimVersion: claimA.version, passengerVersion: passengerA.version, operationId: operationA, requestId: expect.any(String) });
    expect(await prisma!.caseTimelineEvent.count({ where: { sessionId: incidentA, eventType: "matching", title: { contains: "confirmed" } } })).toBe(1);
    expect(await prisma!.caseTimelineEvent.count({ where: { sessionId: incidentA, title: { contains: "suggestions" } } })).toBe(0);
  });

  it("enforces incident access, mode isolation, permissions, immediate revocation and closed writes", async () => {
    const api = application();
    expect((await request(api).get("/api/matching/queue").query({ sessionId: incidentA, search: familyA.operationalId }).set(as("coordinator@lot.pl"))).body.total).toBe(1);
    expect((await request(api).get("/api/matching/queue").query({ sessionId: incidentB, search: familyA.operationalId }).set(as("admin@lot.pl"))).body.total).toBe(0);
    expect((await request(api).get("/api/matching/queue").query({ sessionId: incidentB }).set(as("coordinator@lot.pl"))).status).toBe(404);
    expect((await request(api).post(`/api/matching/claims/${claimA.id}/confirm`).set(as("tec@lot.pl")).send({})).status).toBe(403);
    expect((await request(api).post("/api/matching-records").set(as("coordinator@lot.pl")).send({ sessionId: incidentA, status: "Verified match" })).status).toBe(404);
    const closedClaim = await prisma!.relationshipClaim.findFirstOrThrow({ where: { incidentId: closedIncident } });
    expect((await request(api).post(`/api/matching/claims/${closedClaim.id}/suggestions/generate`).set(as("coordinator@lot.pl")).send({ sessionId: closedIncident, expectedClaimVersion: closedClaim.version })).status).toBe(409);
    await prisma!.incidentAssignment.update({ where: { id: assignmentA }, data: { active: false, revokedAt: new Date(), revokeReason: "Stage 5 immediate revoke" } });
    expect((await request(api).get("/api/matching/queue").query({ sessionId: incidentA }).set(as("coordinator@lot.pl"))).status).toBe(404);
    await prisma!.incidentAssignment.update({ where: { id: assignmentA }, data: { active: true, revokedAt: null, revokeReason: null } });
  });

  it("resolves concurrent confirmations once and protects current acceptance in PostgreSQL", async () => {
    const api = application();
    const secondPassenger = (await request(api).post("/api/passenger-records").set(as("coordinator@lot.pl")).send({ sessionId: incidentA, personType: "Passenger", firstName: "Second", lastName: `${marker}-Race`, source: "Manual" })).body;
    const raceFamily = (await request(api).post("/api/family-records").set(as("coordinator@lot.pl")).send({ sessionId: incidentA, firstName: "Race", lastName: "NOK", passengerFirstName: passengerA.firstName, passengerLastName: passengerA.lastName })).body;
    const base = { sessionId: incidentA, reason: "Concurrent operator decision with current input versions.", expectedClaimVersion: raceFamily.currentClaim.version };
    const [left, right] = await Promise.all([
      request(api).post(`/api/matching/claims/${raceFamily.currentClaim.id}/confirm`).set(as("coordinator@lot.pl")).send({ ...base, passengerRecordId: passengerA.id, expectedPassengerVersion: passengerA.version, operationId: randomUUID() }),
      request(api).post(`/api/matching/claims/${raceFamily.currentClaim.id}/confirm`).set(as("admin@lot.pl")).send({ ...base, passengerRecordId: secondPassenger.id, expectedPassengerVersion: secondPassenger.version, operationId: randomUUID() })
    ]);
    expect([left.status, right.status].sort()).toEqual([200, 409]);
    expect(await prisma!.matchDecision.count({ where: { relationshipClaimId: raceFamily.currentClaim.id, decision: "CONFIRMED", isCurrent: true } })).toBe(1);
    await expect(prisma!.matchDecision.create({ data: { incidentId: incidentA, relationshipClaimId: raceFamily.currentClaim.id, passengerRecordId: passengerA.id, decision: "CONFIRMED", reason: "Direct duplicate", validity: "CURRENT", isCurrent: true, claimVersion: 1, passengerVersion: passengerA.version, operationId: randomUUID(), commandFingerprint: "direct-duplicate", decisionById: adminId } })).rejects.toThrow();
  });

  it("enforces same-incident links in service and database while allowing multiple NOK for one Passenger", async () => {
    const api = application();
    expect((await request(api).post(`/api/matching/claims/${claimA.id}/confirm`).set(as("coordinator@lot.pl")).send({ sessionId: incidentA, passengerRecordId: passengerB.id, reason: "Cross incident attempt", expectedClaimVersion: claimA.version, expectedPassengerVersion: passengerB.version, operationId: randomUUID() })).status).toBe(409);
    await expect(prisma!.matchSuggestion.create({ data: { incidentId: incidentA, relationshipClaimId: claimA.id, passengerRecordId: passengerB.id, score: 0.5, positiveSignals: [], conflicts: [], algorithm: "direct-test", algorithmVersion: "1", generationId: randomUUID(), claimVersion: claimA.version, passengerVersion: passengerB.version } })).rejects.toThrow(/same incident/i);

    const anotherFamily = (await request(api).post("/api/family-records").set(as("coordinator@lot.pl")).send({ sessionId: incidentA, firstName: "Second", lastName: "NOK", claimedRelationship: "Sibling", passengerFirstName: passengerA.firstName, passengerLastName: passengerA.lastName })).body;
    const secondClaim = await request(api).post(`/api/matching/claims/${anotherFamily.currentClaim.id}/confirm`).set(as("coordinator@lot.pl")).send({ sessionId: incidentA, passengerRecordId: passengerA.id, reason: "Independent NOK claim reviewed by a human.", expectedClaimVersion: anotherFamily.currentClaim.version, expectedPassengerVersion: passengerA.version, operationId: randomUUID() });
    expect(secondClaim.status).toBe(200);
    expect(await prisma!.matchDecision.count({ where: { incidentId: incidentA, passengerRecordId: passengerA.id, decision: "CONFIRMED", isCurrent: true } })).toBeGreaterThanOrEqual(2);
  });

  it("makes changed inputs stale, supersedes history and exposes Release compatibility only after both decisions", async () => {
    const api = application();
    const verified = await request(api).post(`/api/family-records/${familyA.id}/verify`).set(as("coordinator@lot.pl")).send({ sessionId: incidentA, version: familyA.version, claimVersion: claimA.version, basis: "Relationship evidence was independently verified.", verifiedRelationshipType: "Parent" });
    expect(verified.status).toBe(200);
    let context = await request(api).get(`/api/matching/claims/${claimA.id}`).query({ sessionId: incidentA }).set(as("coordinator@lot.pl"));
    expect(context.body).toMatchObject({ state: "STALE", currentDecision: { effectiveValidity: "STALE" } });
    const reaffirmed = await request(api).post(`/api/matching/claims/${claimA.id}/confirm`).set(as("coordinator@lot.pl")).send({ sessionId: incidentA, passengerRecordId: passengerA.id, reason: "Verified relationship and original Passenger record were jointly re-reviewed.", expectedClaimVersion: verified.body.currentClaim.version, expectedPassengerVersion: passengerA.version, operationId: randomUUID() });
    expect(reaffirmed.status).toBe(200);
    expect(reaffirmed.body.currentDecision.supersedesDecisionId).toBeTruthy();

    const corrected = await request(api).post(`/api/passenger-records/${passengerA.id}/correct-source`).set(as("coordinator@lot.pl")).send({ sessionId: incidentA, version: passengerA.version, firstName: "Janusz", reason: "Manifest owner supplied a corrected Passenger name." });
    expect(corrected.status).toBe(200);
    context = await request(api).get(`/api/matching/claims/${claimA.id}`).query({ sessionId: incidentA }).set(as("coordinator@lot.pl"));
    expect(context.body.state).toBe("STALE");
    const staleProjection = (await request(api).get("/api/matching-records").query({ sessionId: incidentA, search: `${marker}-CASE-A`, limit: 200 }).set(as("coordinator@lot.pl"))).body.data.find((item: any) => item.status === "Requires review");
    expect(staleProjection.releaseEligibility).toMatchObject({ relationshipVerification: "VERIFIED", matchDecision: "STALE", eligible: false });

    const final = await request(api).post(`/api/matching/claims/${claimA.id}/confirm`).set(as("coordinator@lot.pl")).send({ sessionId: incidentA, passengerRecordId: passengerA.id, reason: "Corrected Passenger source was reviewed and explicitly reconfirmed.", expectedClaimVersion: verified.body.currentClaim.version, expectedPassengerVersion: corrected.body.version, operationId: randomUUID() });
    expect(final.status).toBe(200);
    const currentProjection = (await request(api).get("/api/matching-records").query({ sessionId: incidentA, search: `${marker}-CASE-A`, limit: 200 }).set(as("coordinator@lot.pl"))).body.data.find((item: any) => item.releaseEligibility?.eligible);
    expect(currentProjection).toMatchObject({ matchScore: null, releaseEligibility: { relationshipVerification: "VERIFIED", matchDecision: "CURRENT_CONFIRMED", eligible: true } });
    const decisions = await prisma!.matchDecision.findMany({ where: { relationshipClaimId: claimA.id }, orderBy: { decidedAt: "asc" } });
    expect(decisions.filter((item) => item.validity === "SUPERSEDED").length).toBeGreaterThanOrEqual(2);
    expect(decisions.filter((item) => item.isCurrent)).toHaveLength(1);

    const correctedClaim = await request(api).post(`/api/family-records/${familyA.id}/correct-claim`).set(as("coordinator@lot.pl")).send({ sessionId: incidentA, version: verified.body.version, claimVersion: verified.body.currentClaim.version, lastName: `${marker}-CorrectedNOK`, reason: "Claimant corrected facts after the match decision." });
    expect(correctedClaim.status).toBe(200);
    expect(correctedClaim.body.currentClaim.id).not.toBe(claimA.id);
    const oldAfterClaimCorrection = (await request(api).get("/api/matching-records").query({ sessionId: incidentA, search: `${marker}-CASE-A`, limit: 200 }).set(as("coordinator@lot.pl"))).body.data.find((item: any) => item.relationshipClaimId === claimA.id && item.status === "Requires review");
    expect(oldAfterClaimCorrection.releaseEligibility).toMatchObject({ matchDecision: "STALE", eligible: false });
    const newQueue = await request(api).get("/api/matching/queue").query({ sessionId: incidentA, search: `${marker}-CorrectedNOK` }).set(as("coordinator@lot.pl"));
    expect(newQueue.body.data[0]).toMatchObject({ state: "UNMATCHED", relationshipClaim: { id: correctedClaim.body.currentClaim.id } });
  });

  it("pages 1000 claims and Passengers on the server without generating a cross-product", async () => {
    const familyRows = Array.from({ length: 1_000 }, (_, index) => ({
      id: randomUUID(),
      operationalId: `${marker}-SCALE-FAM-${String(index).padStart(4, "0")}`,
      sessionId: incidentA,
      caseId: `${marker}-SCALE-CASE-${index}`,
      firstName: `ScaleNOK${index}`,
      lastName: `${marker}-ScaleFamily`,
      claimedRelationship: "Parent",
      passengerFirstName: `ScalePax${index}`,
      passengerLastName: `${marker}-ScalePassenger${index}`,
      verificationStatus: "Unverified",
      createdById: adminId,
      updatedById: adminId
    }));
    const passengerRows = Array.from({ length: 1_000 }, (_, index) => ({
      id: randomUUID(),
      operationalId: `${marker}-SCALE-PAX-${String(index).padStart(4, "0")}`,
      sessionId: incidentA,
      caseId: `${marker}-SCALE-CASE-${index}`,
      personType: "Passenger",
      firstName: `ScalePax${index}`,
      lastName: `${marker}-ScalePassenger${index}`,
      source: "Manual",
      createdById: adminId,
      updatedById: adminId
    }));
    await prisma!.$transaction([
      prisma!.passengerRecord.createMany({ data: passengerRows }),
      prisma!.familyRecord.createMany({ data: familyRows }),
      prisma!.relationshipClaim.createMany({ data: familyRows.map((family, index) => ({ incidentId: incidentA, familyRecordId: family.id, claimedRelationshipType: "Parent", claimedPassengerFirstName: passengerRows[index]!.firstName, claimedPassengerLastName: passengerRows[index]!.lastName, source: "SCALE_TEST", status: "PENDING", claimedById: adminId })) })
    ]);
    const api = application();
    const queue = await request(api).get("/api/matching/queue").query({ sessionId: incidentA, search: `${marker}-ScaleFamily`, limit: 25, offset: 25, sortBy: "claimant", sortDirection: "asc" }).set(as("coordinator@lot.pl"));
    expect(queue.status).toBe(200);
    expect(queue.body).toMatchObject({ total: 1_000 });
    expect(queue.body.data).toHaveLength(25);
    const scaleClaim = await prisma!.relationshipClaim.findFirstOrThrow({ where: { familyRecordId: familyRows[777]!.id } });
    const candidates = await request(api).get(`/api/matching/claims/${scaleClaim.id}/candidates`).query({ sessionId: incidentA, search: `${marker}-SCALE-PAX`, limit: 25, offset: 25 }).set(as("coordinator@lot.pl"));
    expect(candidates.body).toMatchObject({ total: 1_000 });
    expect(candidates.body.data).toHaveLength(25);
    const generated = await request(api).post(`/api/matching/claims/${scaleClaim.id}/suggestions/generate`).set(as("coordinator@lot.pl")).send({ sessionId: incidentA, expectedClaimVersion: scaleClaim.version });
    expect(generated.status).toBe(201);
    expect(generated.body.data).toHaveLength(1);
    expect(await prisma!.matchSuggestion.count({ where: { relationshipClaimId: scaleClaim.id, isCurrent: true } })).toBe(1);
  });
});
