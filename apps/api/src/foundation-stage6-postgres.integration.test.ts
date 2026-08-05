import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createPrismaFamilyRepository } from "./modules/families/prisma-family-repository.js";
import { createPrismaIncidentAccessRepository } from "./modules/incident-access/prisma-incident-access-repository.js";
import { createPrismaMatchingRepository } from "./modules/matching/prisma-matching-repository.js";
import { createPrismaPassengerRepository } from "./modules/passengers/prisma-passenger-repository.js";
import { createPrismaReleaseRepository } from "./modules/releases/prisma-release-repository.js";

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
    releaseRepository: createPrismaReleaseRepository(prisma!),
    incidentAccessRepository: createPrismaIncidentAccessRepository(prisma!)
  });
}

postgresDescribe("Foundation Stage 6 PostgreSQL release safety", () => {
  const marker = `F6-${Date.now()}`;
  const incidentIds: string[] = [];
  const temporaryUserIds: string[] = [];
  const temporaryRoleIds: string[] = [];
  let incidentA: string;
  let incidentB: string;
  let closedIncident: string;
  let coordinatorId: string;
  let adminId: string;
  const actors: Record<string, { email: string; id: string; assignmentId: string }> = {};

  async function createRoleActor(key: string, permissions: string[]) {
    const role = await prisma!.role.create({ data: { name: `${marker.toLowerCase()}-${key}`, displayName: `${marker} ${key}`, permissions } });
    const user = await prisma!.user.create({ data: { email: `${marker.toLowerCase()}-${key}@example.test`, displayName: `${marker} ${key}`, roles: { create: { roleId: role.id, assignedBy: "stage6-test" } } } });
    const assignment = await prisma!.incidentAssignment.create({ data: { incidentId: incidentA, userId: user.id, function: `${key} release test`, createdById: adminId } });
    temporaryRoleIds.push(role.id);
    temporaryUserIds.push(user.id);
    actors[key] = { email: user.email, id: user.id, assignmentId: assignment.id };
  }

  async function fixture(incidentId: string, suffix: string, email = "coordinator@lot.pl", passengerId?: string) {
    const api = application();
    const caseId = `${marker}-CASE-${suffix}`;
    const passenger = passengerId
      ? (await request(api).get(`/api/passenger-records/${passengerId}`).query({ sessionId: incidentId }).set(as(email))).body
      : (await request(api).post("/api/passenger-records").set(as(email)).send({ sessionId: incidentId, caseId, personType: "Passenger", firstName: "Passenger", lastName: suffix, source: "Manual" })).body;
    const family = (await request(api).post("/api/family-records").set(as(email)).send({ sessionId: incidentId, caseId, firstName: "NOK", lastName: suffix, claimedRelationship: "Parent", passengerFirstName: passenger.firstName, passengerLastName: passenger.lastName })).body;
    const verified = (await request(api).post(`/api/family-records/${family.id}/verify`).set(as(email)).send({ sessionId: incidentId, version: family.version, claimVersion: family.currentClaim.version, basis: "Relationship evidence independently reviewed for Stage 6.", verifiedRelationshipType: "Parent" })).body;
    const matching = (await request(api).post(`/api/matching/claims/${verified.currentClaim.id}/confirm`).set(as(email)).send({ sessionId: incidentId, passengerRecordId: passenger.id, reason: "Human operator confirmed the Passenger match for Stage 6.", expectedClaimVersion: verified.currentClaim.version, expectedPassengerVersion: passenger.version, operationId: randomUUID() })).body;
    return { incidentId, caseId, passenger, family: verified, claim: verified.currentClaim, decision: matching.currentDecision };
  }

  async function prepare(value: Awaited<ReturnType<typeof fixture>>, email = "coordinator@lot.pl", actionType: "RELEASE" | "REUNIFICATION" = "RELEASE", operationId = randomUUID()) {
    return request(application()).post("/api/releases/prepare").set(as(email)).send({ sessionId: value.incidentId, matchDecisionId: value.decision.id, actionType, receivingParty: actionType === "RELEASE" ? "Authorized receiving party" : null, operationId });
  }

  async function checks(value: Awaited<ReturnType<typeof fixture>>, action: any, email = "coordinator@lot.pl") {
    const identity = await request(application()).post(`/api/releases/${action.id}/checks/identity`).set(as(email)).send({ sessionId: value.incidentId, result: "PASS", basis: "Identity evidence reviewed by the assigned operator.", evidenceReference: "approved evidence type", expectedVersion: action.version, operationId: randomUUID() });
    const hold = await request(application()).post(`/api/releases/${action.id}/checks/hold`).set(as(email)).send({ sessionId: value.incidentId, basis: "Current Passenger hold state reviewed without mutation.", expectedVersion: identity.body.version, operationId: randomUUID() });
    return { identity, hold };
  }

  beforeAll(async () => {
    await prisma!.$connect();
    const [admin, coordinator] = await Promise.all([
      prisma!.user.findUniqueOrThrow({ where: { email: "admin@lot.pl" } }),
      prisma!.user.findUniqueOrThrow({ where: { email: "coordinator@lot.pl" } })
    ]);
    adminId = admin.id;
    coordinatorId = coordinator.id;
    const [exercise, training, closedTarget] = await Promise.all([
      prisma!.session.create({ data: { operationalId: `${marker}-EX`, mode: "EXERCISE", status: "Active", eventType: marker, createdById: admin.id } }),
      prisma!.session.create({ data: { operationalId: `${marker}-TR`, mode: "TRAINING", status: "Draft", eventType: marker, createdById: admin.id } }),
      prisma!.session.create({ data: { operationalId: `${marker}-CLOSED`, mode: "TRAINING", status: "Active", eventType: marker, createdById: admin.id } })
    ]);
    incidentA = exercise.id;
    incidentB = training.id;
    closedIncident = closedTarget.id;
    incidentIds.push(incidentA, incidentB, closedIncident);
    await prisma!.incidentAssignment.createMany({ data: [
      { incidentId: incidentA, userId: coordinator.id, function: "Release coordinator", createdById: admin.id },
      { incidentId: closedIncident, userId: coordinator.id, function: "Closed release coordinator", createdById: admin.id }
    ] });
    await createRoleActor("reader", ["session:read", "release:read"]);
    await createRoleActor("preparer", ["session:read", "release:read", "release:prepare"]);
    await createRoleActor("checker", ["session:read", "release:read", "release:check"]);
    await createRoleActor("authorizer", ["session:read", "release:read", "release:authorize"]);
    await createRoleActor("completer", ["session:read", "release:read", "release:complete"]);
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
    await prisma.userRole.deleteMany({ where: { userId: { in: temporaryUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: temporaryUserIds } } });
    await prisma.role.deleteMany({ where: { id: { in: temporaryRoleIds } } });
    await prisma.$disconnect();
  });

  it("deploys Stage 6 constraints, indexes, triggers and operation sequence", async () => {
    const migrations = await prisma!.$queryRaw<Array<{ migration_name: string }>>`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`;
    expect(migrations.map((row) => row.migration_name)).toContain("20260806010000_release_actions_checks");
    const indexes = await prisma!.$queryRaw<Array<{ indexname: string }>>`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename IN ('ReleaseAction', 'ReleaseCheck', 'ReleaseOperation')`;
    expect(indexes.map((row) => row.indexname)).toEqual(expect.arrayContaining(["ReleaseAction_one_active_process_key", "ReleaseAction_one_completed_outcome_key", "ReleaseCheck_current_type_key", "ReleaseOperation_incidentId_operationId_key"]));
    const triggers = await prisma!.$queryRaw<Array<{ tgname: string }>>`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('ReleaseAction_same_incident', 'ReleaseCheck_integrity', 'ReleaseOperation_same_incident', 'ReleaseAction_completed_immutable')`;
    expect(triggers).toHaveLength(4);
    const checks = await prisma!.$queryRaw<Array<{ conname: string }>>`SELECT conname FROM pg_constraint WHERE conname IN ('ReleaseAction_controlled_state_check', 'ReleaseAction_required_references_check', 'ReleaseCheck_type_check', 'ReleaseOperation_command_check')`;
    expect(checks).toHaveLength(4);
    const sequence = await prisma!.$queryRaw<Array<{ name: string }>>`SELECT relname AS name FROM pg_class WHERE relkind = 'S' AND relname = 'ReleaseAction_operational_seq'`;
    expect(sequence).toHaveLength(1);
  });

  it("persists the full workflow across repository restarts with separated permissions", async () => {
    const value = await fixture(incidentA, `PERSIST-${randomUUID().slice(0, 6)}`);
    expect((await prepare(value, actors.reader!.email)).status).toBe(403);
    const prepared = await prepare(value, actors.preparer!.email);
    expect(prepared.status).toBe(201);
    expect(prepared.body).toMatchObject({ status: "PREPARED", checks: [], canAuthorize: false });
    expect((await request(application()).patch(`/api/releases/${prepared.body.id}`).set(as("coordinator@lot.pl")).send({ sessionId: incidentA, status: "COMPLETED", identityChecked: true, holdCleared: true })).status).toBe(404);
    expect((await request(application()).post(`/api/matching-records/${value.decision.matchingRecordId}/mark-reunited`).set(as("coordinator@lot.pl")).send({ sessionId: incidentA })).status).toBe(404);
    expect((await request(application()).post(`/api/matching-records/${value.decision.matchingRecordId}/mark-released`).set(as("coordinator@lot.pl")).send({ sessionId: incidentA })).status).toBe(404);
    expect(await prisma!.releaseCheck.count({ where: { releaseActionId: prepared.body.id } })).toBe(0);
    expect((await request(application()).post(`/api/releases/${prepared.body.id}/checks/identity`).set(as(actors.preparer!.email)).send({})).status).toBe(403);

    const identity = await request(application()).post(`/api/releases/${prepared.body.id}/checks/identity`).set(as(actors.checker!.email)).send({ sessionId: incidentA, result: "PASS", basis: "Checker independently reviewed identity evidence.", expectedVersion: prepared.body.version, operationId: randomUUID() });
    expect(identity.status).toBe(200);
    const passengerBeforeHoldReview = await prisma!.passengerRecord.findUniqueOrThrow({ where: { id: value.passenger.id } });
    const hold = await request(application()).post(`/api/releases/${prepared.body.id}/checks/hold`).set(as(actors.checker!.email)).send({ sessionId: incidentA, basis: "Checker reviewed the current Passenger hold state.", expectedVersion: identity.body.version, operationId: randomUUID() });
    expect(hold.status).toBe(200);
    expect(await prisma!.passengerRecord.findUniqueOrThrow({ where: { id: value.passenger.id } })).toMatchObject({ holdStatus: passengerBeforeHoldReview.holdStatus, version: passengerBeforeHoldReview.version });
    expect((await request(application()).post(`/api/releases/${prepared.body.id}/authorize`).set(as(actors.checker!.email)).send({})).status).toBe(403);

    const authorizationOperation = randomUUID();
    const authorizationBody = { sessionId: incidentA, reason: "Authorizer performed a fresh policy evaluation.", expectedVersion: hold.body.version, operationId: authorizationOperation };
    const authorized = await request(application()).post(`/api/releases/${prepared.body.id}/authorize`).set(as(actors.authorizer!.email)).send(authorizationBody);
    const retryAfterLostResponse = await request(application()).post(`/api/releases/${prepared.body.id}/authorize`).set(as(actors.authorizer!.email)).send(authorizationBody);
    expect(authorized.status).toBe(200);
    expect(retryAfterLostResponse.body).toMatchObject({ id: prepared.body.id, status: "AUTHORIZED", idempotent: true });
    expect(await prisma!.releaseOperation.count({ where: { incidentId: incidentA, operationId: authorizationOperation } })).toBe(1);
    expect((await request(application()).post(`/api/releases/${prepared.body.id}/complete`).set(as(actors.authorizer!.email)).send({})).status).toBe(403);

    const completed = await request(application()).post(`/api/releases/${prepared.body.id}/complete`).set(as(actors.completer!.email)).send({ sessionId: incidentA, reason: "Physical handover was explicitly completed.", expectedVersion: authorized.body.version, operationId: randomUUID() });
    expect(completed.status).toBe(200);
    expect(completed.body.status).toBe("COMPLETED");
    const afterRestart = await request(application()).get(`/api/releases/${prepared.body.id}`).query({ sessionId: incidentA }).set(as(actors.reader!.email));
    expect(afterRestart.body).toMatchObject({ status: "COMPLETED", preparedById: actors.preparer!.id, authorizedById: actors.authorizer!.id, completedById: actors.completer!.id });
    expect(afterRestart.body.checks).toHaveLength(2);
    expect(await prisma!.auditLog.count({ where: { sessionId: incidentA, entityId: prepared.body.id, action: { in: ["prepare_release", "release_identity_check", "release_hold_review", "authorize_release", "complete_release"] } } })).toBe(5);
    expect(await prisma!.caseTimelineEvent.count({ where: { sessionId: incidentA, entityId: prepared.body.id } })).toBe(5);
  });

  it("enforces operationId misuse, optimistic concurrency and one logical authorization", async () => {
    const value = await fixture(incidentA, `RACE-${randomUUID().slice(0, 6)}`);
    const prepareOperation = randomUUID();
    const prepared = await prepare(value, "coordinator@lot.pl", "REUNIFICATION", prepareOperation);
    const prepareRetry = await prepare(value, "coordinator@lot.pl", "REUNIFICATION", prepareOperation);
    expect(prepareRetry.body).toMatchObject({ id: prepared.body.id, idempotent: true });
    const misuse = await request(application()).post(`/api/releases/${prepared.body.id}/cancel`).set(as("coordinator@lot.pl")).send({ sessionId: incidentA, reason: "Different command with reused operation ID.", expectedVersion: prepared.body.version, operationId: prepareOperation });
    expect(misuse.status).toBe(409);
    expect(misuse.body.error).toContain("operationId");
    const passed = await checks(value, prepared.body);
    const expectedVersion = passed.hold.body.version;
    const [left, right] = await Promise.all([
      request(application()).post(`/api/releases/${prepared.body.id}/authorize`).set(as("coordinator@lot.pl")).send({ sessionId: incidentA, reason: "Concurrent authorization A.", expectedVersion, operationId: randomUUID() }),
      request(application()).post(`/api/releases/${prepared.body.id}/authorize`).set(as("admin@lot.pl")).send({ sessionId: incidentA, reason: "Concurrent authorization B.", expectedVersion, operationId: randomUUID() })
    ]);
    expect([left.status, right.status].sort()).toEqual([200, 409]);
    expect(await prisma!.releaseAction.count({ where: { id: prepared.body.id, status: "AUTHORIZED" } })).toBe(1);
    expect(await prisma!.releaseOperation.count({ where: { releaseActionId: prepared.body.id, command: "AUTHORIZE" } })).toBe(1);
  });

  it("blocks completion after a new hold, RelationshipClaim change or MatchDecision invalidation", async () => {
    const preAuthorizationHoldValue = await fixture(incidentA, `PRE-HOLD-${randomUUID().slice(0, 6)}`);
    const preAuthorizationHoldAction = await prepare(preAuthorizationHoldValue);
    await request(application()).post(`/api/passenger-records/${preAuthorizationHoldValue.passenger.id}/change-hold`).set(as("coordinator@lot.pl")).send({ sessionId: incidentA, version: preAuthorizationHoldValue.passenger.version, holdStatus: "Security hold", reason: "Security hold received before authorization." });
    const blockedContext = await request(application()).get(`/api/releases/${preAuthorizationHoldAction.body.id}`).query({ sessionId: incidentA }).set(as("coordinator@lot.pl"));
    expect(blockedContext.body).toMatchObject({ effectiveState: "REQUIRES_REVIEW", canAuthorize: false });
    expect(blockedContext.body.blockers.join(" ")).toMatch(/Active Passenger hold/i);
    expect((await request(application()).post(`/api/releases/${preAuthorizationHoldAction.body.id}/authorize`).set(as("coordinator@lot.pl")).send({ sessionId: incidentA, reason: "Must fail while active hold exists.", expectedVersion: preAuthorizationHoldAction.body.version, operationId: randomUUID() })).status).toBe(409);

    const matchingHoldValue = await fixture(incidentA, `MATCH-HOLD-${randomUUID().slice(0, 6)}`);
    const matchingHoldAction = await prepare(matchingHoldValue);
    const matchingHoldChecks = await checks(matchingHoldValue, matchingHoldAction.body);
    const matchingProjection = await prisma!.matchingRecord.findUniqueOrThrow({ where: { id: matchingHoldValue.decision.matchingRecordId } });
    expect((await request(application()).post(`/api/matching-records/${matchingProjection.id}/hold`).set(as("coordinator@lot.pl")).send({ sessionId: incidentA, version: matchingProjection.version, holdCheck: "Matching evidence review", reason: "New matching concern requires human review." })).status).toBe(200);
    const matchingBlockedContext = await request(application()).get(`/api/releases/${matchingHoldAction.body.id}`).query({ sessionId: incidentA }).set(as("coordinator@lot.pl"));
    expect(matchingBlockedContext.body.blockers.join(" ")).toMatch(/Active Matching hold/i);
    expect((await request(application()).post(`/api/releases/${matchingHoldAction.body.id}/authorize`).set(as("coordinator@lot.pl")).send({ sessionId: incidentA, reason: "Must fail while Matching hold exists.", expectedVersion: matchingHoldChecks.hold.body.version, operationId: randomUUID() })).status).toBe(409);

    const holdValue = await fixture(incidentA, `HOLD-${randomUUID().slice(0, 6)}`);
    const holdAction = await prepare(holdValue);
    const holdChecks = await checks(holdValue, holdAction.body);
    const holdAuthorized = await request(application()).post(`/api/releases/${holdAction.body.id}/authorize`).set(as("coordinator@lot.pl")).send({ sessionId: incidentA, reason: "Authorized before a new hold appeared.", expectedVersion: holdChecks.hold.body.version, operationId: randomUUID() });
    const held = await request(application()).post(`/api/passenger-records/${holdValue.passenger.id}/change-hold`).set(as("coordinator@lot.pl")).send({ sessionId: incidentA, version: holdValue.passenger.version, holdStatus: "Legal hold", reason: "Legal hold received after authorization." });
    expect(held.status).toBe(200);
    expect((await request(application()).post(`/api/releases/${holdAction.body.id}/complete`).set(as("coordinator@lot.pl")).send({ sessionId: incidentA, reason: "Must fail after hold.", expectedVersion: holdAuthorized.body.version, operationId: randomUUID() })).status).toBe(409);

    const familyValue = await fixture(incidentA, `FAM-${randomUUID().slice(0, 6)}`);
    const familyAction = await prepare(familyValue);
    const familyChecks = await checks(familyValue, familyAction.body);
    const familyAuthorized = await request(application()).post(`/api/releases/${familyAction.body.id}/authorize`).set(as("coordinator@lot.pl")).send({ sessionId: incidentA, reason: "Authorized before family review reopened.", expectedVersion: familyChecks.hold.body.version, operationId: randomUUID() });
    await request(application()).post(`/api/family-records/${familyValue.family.id}/reopen`).set(as("coordinator@lot.pl")).send({ sessionId: incidentA, version: familyValue.family.version, claimVersion: familyValue.claim.version, basis: "New evidence requires reopening." });
    expect((await request(application()).post(`/api/releases/${familyAction.body.id}/complete`).set(as("coordinator@lot.pl")).send({ sessionId: incidentA, reason: "Must fail after relationship reopen.", expectedVersion: familyAuthorized.body.version, operationId: randomUUID() })).status).toBe(409);

    const matchValue = await fixture(incidentA, `MAT-${randomUUID().slice(0, 6)}`);
    const matchAction = await prepare(matchValue);
    const matchChecks = await checks(matchValue, matchAction.body);
    const matchAuthorized = await request(application()).post(`/api/releases/${matchAction.body.id}/authorize`).set(as("coordinator@lot.pl")).send({ sessionId: incidentA, reason: "Authorized before match invalidation.", expectedVersion: matchChecks.hold.body.version, operationId: randomUUID() });
    await request(application()).post(`/api/matching/claims/${matchValue.claim.id}/invalidate`).set(as("coordinator@lot.pl")).send({ sessionId: incidentA, decisionId: matchValue.decision.id, reason: "Human match was invalidated by new evidence.", expectedClaimVersion: matchValue.claim.version, expectedPassengerVersion: matchValue.passenger.version, operationId: randomUUID() });
    expect((await request(application()).post(`/api/releases/${matchAction.body.id}/complete`).set(as("coordinator@lot.pl")).send({ sessionId: incidentA, reason: "Must fail after match invalidation.", expectedVersion: matchAuthorized.body.version, operationId: randomUUID() })).status).toBe(409);
  });

  it("protects same-incident links in service and database while allowing multiple NOK", async () => {
    const primary = await fixture(incidentA, `NOK-A-${randomUUID().slice(0, 5)}`);
    const second = await fixture(incidentA, `NOK-B-${randomUUID().slice(0, 5)}`, "coordinator@lot.pl", primary.passenger.id);
    const firstAction = await prepare(primary, "coordinator@lot.pl", "REUNIFICATION");
    const secondAction = await prepare(second, "coordinator@lot.pl", "REUNIFICATION");
    expect(firstAction.status).toBe(201);
    expect(secondAction.status).toBe(201);
    expect(firstAction.body.passengerRecordId).toBe(secondAction.body.passengerRecordId);
    expect(firstAction.body.relationshipClaimId).not.toBe(secondAction.body.relationshipClaimId);

    const other = await prisma!.session.findUniqueOrThrow({ where: { id: incidentB } });
    const crossPassenger = await prisma!.passengerRecord.create({ data: { operationalId: `${marker}-CROSS-PAX`, sessionId: other.id, personType: "Passenger", firstName: "Cross", lastName: "Mode", source: "Manual", createdById: adminId, updatedById: adminId } });
    await expect(prisma!.releaseAction.create({ data: { operationalId: `${marker}-CROSS-REL`, incidentId: incidentA, actionType: "RELEASE", status: "PREPARED", relationshipClaimId: primary.claim.id, matchDecisionId: primary.decision.id, matchingRecordId: primary.decision.matchingRecordId, passengerRecordId: crossPassenger.id, relationshipClaimVersion: primary.claim.version, passengerVersion: crossPassenger.version, preparedById: adminId } })).rejects.toThrow(/same incident|match its claim/i);
    expect((await request(application()).post("/api/releases/prepare").set(as("admin@lot.pl")).send({ sessionId: incidentB, matchDecisionId: primary.decision.id, actionType: "RELEASE", operationId: randomUUID() })).status).toBe(404);
  });

  it("revokes access immediately and keeps closed incidents read-only", async () => {
    const value = await fixture(incidentA, `REVOKE-${randomUUID().slice(0, 6)}`);
    const prepared = await prepare(value);
    expect((await request(application()).get("/api/releases/queue").query({ sessionId: incidentA }).set(as(actors.reader!.email))).status).toBe(200);
    await prisma!.incidentAssignment.update({ where: { id: actors.reader!.assignmentId }, data: { active: false, revokedAt: new Date(), revokedById: adminId, revokeReason: "Stage 6 immediate revoke" } });
    expect((await request(application()).get("/api/releases/queue").query({ sessionId: incidentA }).set(as(actors.reader!.email))).status).toBe(404);
    expect((await request(application()).get(`/api/releases/${prepared.body.id}`).query({ sessionId: incidentA }).set(as(actors.reader!.email))).status).toBe(404);
    await prisma!.incidentAssignment.update({ where: { id: actors.reader!.assignmentId }, data: { active: true, revokedAt: null, revokedById: null, revokeReason: null } });

    const coordinatorAssignment = await prisma!.incidentAssignment.findFirstOrThrow({ where: { incidentId: incidentA, userId: coordinatorId, active: true } });
    await prisma!.incidentAssignment.update({ where: { id: coordinatorAssignment.id }, data: { active: false, revokedAt: new Date(), revokedById: adminId, revokeReason: "Stage 6 full-command revoke" } });
    const revokedBody = { sessionId: incidentA, reason: "Revoked command attempt.", basis: "Revoked check attempt.", result: "PASS", expectedVersion: prepared.body.version, operationId: randomUUID() };
    expect((await request(application()).get("/api/releases/queue").query({ sessionId: incidentA }).set(as("coordinator@lot.pl"))).status).toBe(404);
    expect((await request(application()).get(`/api/releases/${prepared.body.id}`).query({ sessionId: incidentA }).set(as("coordinator@lot.pl"))).status).toBe(404);
    expect((await request(application()).post("/api/releases/prepare").set(as("coordinator@lot.pl")).send({ sessionId: incidentA, matchDecisionId: value.decision.id, actionType: "RELEASE", operationId: randomUUID() })).status).toBe(404);
    expect((await request(application()).post(`/api/releases/${prepared.body.id}/checks/identity`).set(as("coordinator@lot.pl")).send({ sessionId: revokedBody.sessionId, basis: revokedBody.basis, result: revokedBody.result, expectedVersion: revokedBody.expectedVersion, operationId: randomUUID() })).status).toBe(404);
    expect((await request(application()).post(`/api/releases/${prepared.body.id}/authorize`).set(as("coordinator@lot.pl")).send({ sessionId: revokedBody.sessionId, reason: revokedBody.reason, expectedVersion: revokedBody.expectedVersion, operationId: randomUUID() })).status).toBe(404);
    expect((await request(application()).post(`/api/releases/${prepared.body.id}/complete`).set(as("coordinator@lot.pl")).send({ sessionId: revokedBody.sessionId, reason: revokedBody.reason, expectedVersion: revokedBody.expectedVersion, operationId: randomUUID() })).status).toBe(404);
    await prisma!.incidentAssignment.update({ where: { id: coordinatorAssignment.id }, data: { active: true, revokedAt: null, revokedById: null, revokeReason: null } });

    const closedValue = await fixture(closedIncident, `CLOSED-${randomUUID().slice(0, 6)}`);
    const closedAction = await prepare(closedValue);
    await prisma!.session.update({ where: { id: closedIncident }, data: { status: "Closed" } });
    expect((await request(application()).get(`/api/releases/${closedAction.body.id}`).query({ sessionId: closedIncident }).set(as("coordinator@lot.pl"))).status).toBe(200);
    expect((await request(application()).post(`/api/releases/${closedAction.body.id}/checks/identity`).set(as("coordinator@lot.pl")).send({ sessionId: closedIncident, result: "PASS", basis: "Closed incident write attempt.", expectedVersion: closedAction.body.version, operationId: randomUUID() })).status).toBe(409);
    expect((await request(application()).post(`/api/releases/${closedAction.body.id}/checks/hold`).set(as("coordinator@lot.pl")).send({ sessionId: closedIncident, basis: "Closed incident write attempt.", expectedVersion: closedAction.body.version, operationId: randomUUID() })).status).toBe(409);
    expect((await request(application()).post(`/api/releases/${closedAction.body.id}/authorize`).set(as("coordinator@lot.pl")).send({ sessionId: closedIncident, reason: "Closed incident write attempt.", expectedVersion: closedAction.body.version, operationId: randomUUID() })).status).toBe(409);
    expect((await request(application()).post(`/api/releases/${closedAction.body.id}/complete`).set(as("coordinator@lot.pl")).send({ sessionId: closedIncident, reason: "Closed incident write attempt.", expectedVersion: closedAction.body.version, operationId: randomUUID() })).status).toBe(409);
    expect((await request(application()).post(`/api/releases/${closedAction.body.id}/cancel`).set(as("coordinator@lot.pl")).send({ sessionId: closedIncident, reason: "Closed incident write attempt.", expectedVersion: closedAction.body.version, operationId: randomUUID() })).status).toBe(409);
    expect((await request(application()).post("/api/releases/prepare").set(as("coordinator@lot.pl")).send({ sessionId: closedIncident, matchDecisionId: closedValue.decision.id, actionType: "RELEASE", operationId: randomUUID() })).status).toBe(409);
  });

  it("prevents duplicate completion, terminal rewrites and direct duplicate active processes", async () => {
    const value = await fixture(incidentA, `TERM-${randomUUID().slice(0, 6)}`);
    const action = await prepare(value);
    const passed = await checks(value, action.body);
    const authorized = await request(application()).post(`/api/releases/${action.body.id}/authorize`).set(as("coordinator@lot.pl")).send({ sessionId: incidentA, reason: "Terminal integrity authorization.", expectedVersion: passed.hold.body.version, operationId: randomUUID() });
    const completed = await request(application()).post(`/api/releases/${action.body.id}/complete`).set(as("coordinator@lot.pl")).send({ sessionId: incidentA, reason: "Terminal integrity completion.", expectedVersion: authorized.body.version, operationId: randomUUID() });
    expect(completed.status).toBe(200);
    expect((await request(application()).post(`/api/releases/${action.body.id}/complete`).set(as("coordinator@lot.pl")).send({ sessionId: incidentA, reason: "Duplicate completion attempt.", expectedVersion: completed.body.version, operationId: randomUUID() })).status).toBe(409);
    expect((await prepare(value)).status).toBe(409);
    await expect(prisma!.releaseAction.update({ where: { id: action.body.id }, data: { completionNotes: "Rewritten terminal history" } })).rejects.toThrow(/immutable/i);

    const active = await prepare(value, "coordinator@lot.pl", "REUNIFICATION");
    expect(active.status).toBe(201);
    await expect(prisma!.releaseAction.create({ data: { operationalId: `${marker}-DUPLICATE`, incidentId: incidentA, actionType: "REUNIFICATION", status: "PREPARED", relationshipClaimId: value.claim.id, matchDecisionId: value.decision.id, matchingRecordId: value.decision.matchingRecordId, passengerRecordId: value.passenger.id, relationshipClaimVersion: value.claim.version, passengerVersion: value.passenger.version, preparedById: adminId } })).rejects.toThrow();
  });

  it("pages 1000 persisted release actions and preserves honest legacy provenance", async () => {
    const value = await fixture(incidentA, `SCALE-${randomUUID().slice(0, 6)}`);
    const timestamp = new Date();
    await prisma!.releaseAction.createMany({ data: Array.from({ length: 1_000 }, (_, index) => ({
      id: randomUUID(),
      operationalId: `${marker}-SCALE-${String(index).padStart(4, "0")}`,
      incidentId: incidentA,
      actionType: index % 2 ? "RELEASE" : "REUNIFICATION",
      status: "CANCELLED",
      relationshipClaimId: value.claim.id,
      matchDecisionId: value.decision.id,
      matchingRecordId: value.decision.matchingRecordId,
      passengerRecordId: value.passenger.id,
      relationshipClaimVersion: value.claim.version,
      passengerVersion: value.passenger.version,
      preparedById: adminId,
      cancelledById: adminId,
      cancelledAt: timestamp,
      cancelReason: "Scale-test terminal record"
    })) });
    const page = await request(application()).get("/api/releases/queue").query({ sessionId: incidentA, search: `${marker}-SCALE-`, status: "CANCELLED", limit: 25, offset: 25 }).set(as("coordinator@lot.pl"));
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ total: 1_000 });
    expect(page.body.data).toHaveLength(25);

    const legacy = await prisma!.releaseAction.create({ data: { operationalId: `${marker}-LEGACY`, incidentId: incidentA, actionType: "RELEASE", status: "COMPLETED", relationshipClaimId: value.claim.id, matchDecisionId: value.decision.id, matchingRecordId: value.decision.matchingRecordId, passengerRecordId: value.passenger.id, relationshipClaimVersion: value.claim.version, passengerVersion: value.passenger.version, preparedById: adminId, completedById: adminId, completedAt: timestamp, legacyImported: true, verificationEvidenceUnavailable: true, legacyMetadata: { sourceModel: "ReunificationReleaseRecord", legacyIdentityClaimed: true, legacyHoldClaimed: true } } });
    const projected = await request(application()).get(`/api/releases/${legacy.id}`).query({ sessionId: incidentA }).set(as("coordinator@lot.pl"));
    expect(projected.body).toMatchObject({ legacyImported: true, verificationEvidenceUnavailable: true, checks: [] });
    const compatibility = await request(application()).get("/api/releases").query({ sessionId: incidentA, search: legacy.operationalId }).set(as("coordinator@lot.pl"));
    expect(compatibility.body.data[0]).toMatchObject({ identityChecked: false, holdCleared: false, status: "Completed" });
  });
});
