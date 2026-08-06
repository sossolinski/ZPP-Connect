import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";

process.env.NODE_ENV = "test";
process.env.PERSISTENCE_MODE = "memory";
process.env.ALLOW_DEVELOPMENT_AUTH = "true";

function as<T extends { set(name: string, value: string): T }>(test: T, email = "coordinator@lot.pl") {
  return test.set("x-user-email", email);
}

function post(app: ReturnType<typeof createApp>, path: string, body: Record<string, unknown>, email = "coordinator@lot.pl") {
  return as(request(app).post(`/api${path}`), email).send(body);
}

async function fixture(app: ReturnType<typeof createApp>, suffix: string, passengerId?: string) {
  const sessionId = "ses-demo-1";
  const caseId = `CASE-S6-${suffix}`;
  const passenger = passengerId
    ? (await as(request(app).get(`/api/passenger-records/${passengerId}`)).query({ sessionId })).body
    : (await post(app, "/passenger-records", { sessionId, caseId, personType: "Passenger", firstName: "Passenger", lastName: suffix, source: "Manual" })).body;
  const family = (await post(app, "/family-records", { sessionId, caseId, firstName: "NOK", lastName: suffix, claimedRelationship: "Parent", passengerFirstName: passenger.firstName, passengerLastName: passenger.lastName })).body;
  const verified = (await post(app, `/family-records/${family.id}/verify`, { sessionId, version: family.version, claimVersion: family.currentClaim.version, basis: "Relationship evidence reviewed by an authorized operator.", verifiedRelationshipType: "Parent" })).body;
  const matchContext = (await post(app, `/matching/claims/${verified.currentClaim.id}/confirm`, { sessionId, passengerRecordId: passenger.id, reason: "Human operator confirmed the Passenger match.", expectedClaimVersion: verified.currentClaim.version, expectedPassengerVersion: passenger.version, operationId: randomUUID() })).body;
  const projection = (await as(request(app).get("/api/matching-records")).query({ sessionId, search: caseId })).body.data[0];
  return { sessionId, caseId, family: verified, passenger, matchContext, projection };
}

async function prepare(app: ReturnType<typeof createApp>, value: Awaited<ReturnType<typeof fixture>>, actionType: "RELEASE" | "REUNIFICATION" = "RELEASE", operationId = randomUUID()) {
  return post(app, "/releases/prepare", { sessionId: value.sessionId, matchDecisionId: value.projection.matchDecisionId, actionType, receivingParty: actionType === "RELEASE" ? "Authorized receiving party" : null, operationId });
}

async function passChecks(app: ReturnType<typeof createApp>, value: Awaited<ReturnType<typeof fixture>>, action: any) {
  const identity = await post(app, `/releases/${action.id}/checks/identity`, { sessionId: value.sessionId, result: "PASS", basis: "Identity was checked against the approved operational evidence.", evidenceReference: "approved identity evidence type", expectedVersion: action.version, operationId: randomUUID() });
  const hold = await post(app, `/releases/${action.id}/checks/hold`, { sessionId: value.sessionId, basis: "The current Passenger hold state was reviewed without changing it.", expectedVersion: identity.body.version, operationId: randomUUID() });
  return { identity, hold };
}

describe("Foundation Stage 6 release contract (memory)", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => { app = createApp(); });

  it("keeps prepared, authorized and completed states distinct with explicit checks", async () => {
    const value = await fixture(app, randomUUID().slice(0, 8));
    const prepared = await prepare(app, value);
    expect(prepared.status).toBe(201);
    expect(prepared.body).toMatchObject({ status: "PREPARED", canAuthorize: false, checks: [] });
    expect(prepared.body.preconditions.find((item: any) => item.key === "identity").state).toBe("FAIL");

    const { identity, hold } = await passChecks(app, value, prepared.body);
    expect(identity.body.checks[0]).toMatchObject({ type: "IDENTITY", result: "PASS", current: true });
    expect(hold.body.canAuthorize).toBe(true);
    const authorized = await post(app, `/releases/${prepared.body.id}/authorize`, { sessionId: value.sessionId, reason: "All independent conditions were freshly reviewed.", expectedVersion: hold.body.version, operationId: randomUUID() });
    expect(authorized.body).toMatchObject({ status: "AUTHORIZED", canComplete: true });
    expect(authorized.body.completedAt).toBeFalsy();
    const completed = await post(app, `/releases/${prepared.body.id}/complete`, { sessionId: value.sessionId, reason: "The physical handover was completed and recorded by the operator.", expectedVersion: authorized.body.version, operationId: randomUUID() });
    expect(completed.body).toMatchObject({ status: "COMPLETED", canAuthorize: false, canComplete: false });
  });

  it("does not synthesize identity or hold checks through legacy shortcuts", async () => {
    const value = await fixture(app, randomUUID().slice(0, 8));
    const prepared = await prepare(app, value);
    expect((await post(app, `/matching-records/${value.projection.id}/mark-reunited`, { sessionId: value.sessionId })).status).toBe(404);
    expect((await post(app, `/matching-records/${value.projection.id}/mark-released`, { sessionId: value.sessionId })).status).toBe(404);
    expect((await post(app, "/releases", { sessionId: value.sessionId, identityChecked: true, holdCleared: true })).status).toBe(404);
    expect((await as(request(app).patch(`/api/releases/${prepared.body.id}`)).send({ status: "COMPLETED", identityChecked: true, holdCleared: true })).status).toBe(404);
    const current = (await as(request(app).get(`/api/releases/${prepared.body.id}`)).query({ sessionId: value.sessionId })).body;
    expect(current).toMatchObject({ status: "PREPARED", checks: [], canAuthorize: false });
  });

  it("never changes Passenger hold and blocks authorization when a hold appears", async () => {
    const value = await fixture(app, randomUUID().slice(0, 8));
    const prepared = await prepare(app, value);
    const held = await post(app, `/passenger-records/${value.passenger.id}/change-hold`, { sessionId: value.sessionId, version: value.passenger.version, holdStatus: "Security hold", reason: "Security team placed a controlled Passenger hold." });
    expect(held.body.holdStatus).toBe("Security hold");
    const holdReview = await post(app, `/releases/${prepared.body.id}/checks/hold`, { sessionId: value.sessionId, basis: "Operator reviewed the newly active hold.", expectedVersion: prepared.body.version, operationId: randomUUID() });
    expect(holdReview.status).toBe(409);
    const passengerAfter = (await as(request(app).get(`/api/passenger-records/${value.passenger.id}`)).query({ sessionId: value.sessionId })).body;
    expect(passengerAfter).toMatchObject({ holdStatus: "Security hold", version: held.body.version });
    const release = (await as(request(app).get(`/api/releases/${prepared.body.id}`)).query({ sessionId: value.sessionId })).body;
    expect(release).toMatchObject({ effectiveState: "REQUIRES_REVIEW", canAuthorize: false });
  });

  it("revalidates Passenger hold after authorization and blocks completion", async () => {
    const value = await fixture(app, randomUUID().slice(0, 8));
    const prepared = await prepare(app, value);
    const { hold } = await passChecks(app, value, prepared.body);
    const authorized = await post(app, `/releases/${prepared.body.id}/authorize`, { sessionId: value.sessionId, reason: "Fresh authorization review completed.", expectedVersion: hold.body.version, operationId: randomUUID() });
    const held = await post(app, `/passenger-records/${value.passenger.id}/change-hold`, { sessionId: value.sessionId, version: value.passenger.version, holdStatus: "Legal hold", reason: "A new legal restriction was received after authorization." });
    expect(held.status).toBe(200);
    const completion = await post(app, `/releases/${prepared.body.id}/complete`, { sessionId: value.sessionId, reason: "Attempt after upstream hold change.", expectedVersion: authorized.body.version, operationId: randomUUID() });
    expect(completion.status).toBe(409);
    expect((await as(request(app).get(`/api/releases/${prepared.body.id}`)).query({ sessionId: value.sessionId })).body.status).toBe("AUTHORIZED");
  });

  it("blocks completion after RelationshipClaim reopen or MatchDecision invalidation", async () => {
    const relationshipValue = await fixture(app, `REL-${randomUUID().slice(0, 6)}`);
    const relationshipAction = await prepare(app, relationshipValue);
    const relationshipChecks = await passChecks(app, relationshipValue, relationshipAction.body);
    const relationshipAuthorized = await post(app, `/releases/${relationshipAction.body.id}/authorize`, { sessionId: relationshipValue.sessionId, reason: "Relationship and match reviewed.", expectedVersion: relationshipChecks.hold.body.version, operationId: randomUUID() });
    const reopened = await post(app, `/family-records/${relationshipValue.family.id}/reopen`, { sessionId: relationshipValue.sessionId, version: relationshipValue.family.version, claimVersion: relationshipValue.family.currentClaim.version, basis: "New relationship evidence requires review." });
    expect(reopened.status).toBe(200);
    expect((await post(app, `/releases/${relationshipAction.body.id}/complete`, { sessionId: relationshipValue.sessionId, reason: "Must be blocked after family change.", expectedVersion: relationshipAuthorized.body.version, operationId: randomUUID() })).status).toBe(409);

    const matchingValue = await fixture(app, `MAT-${randomUUID().slice(0, 6)}`);
    const matchingAction = await prepare(app, matchingValue, "REUNIFICATION");
    const matchingChecks = await passChecks(app, matchingValue, matchingAction.body);
    const matchingAuthorized = await post(app, `/releases/${matchingAction.body.id}/authorize`, { sessionId: matchingValue.sessionId, reason: "Current match reviewed before authorization.", expectedVersion: matchingChecks.hold.body.version, operationId: randomUUID() });
    const invalidated = await post(app, `/matching/claims/${matchingValue.family.currentClaim.id}/invalidate`, { sessionId: matchingValue.sessionId, decisionId: matchingValue.matchContext.currentDecision.id, reason: "New evidence invalidated the human match.", expectedClaimVersion: matchingValue.family.currentClaim.version, expectedPassengerVersion: matchingValue.passenger.version, operationId: randomUUID() });
    expect(invalidated.status).toBe(200);
    expect((await post(app, `/releases/${matchingAction.body.id}/complete`, { sessionId: matchingValue.sessionId, reason: "Must be blocked after match invalidation.", expectedVersion: matchingAuthorized.body.version, operationId: randomUUID() })).status).toBe(409);
  });

  it("supports safe timeout retries and rejects operationId misuse", async () => {
    const value = await fixture(app, randomUUID().slice(0, 8));
    const prepareOperation = randomUUID();
    const first = await prepare(app, value, "RELEASE", prepareOperation);
    const retry = await prepare(app, value, "RELEASE", prepareOperation);
    expect(retry.status).toBe(201);
    expect(retry.body).toMatchObject({ id: first.body.id, idempotent: true });
    const misuse = await post(app, `/releases/${first.body.id}/cancel`, { sessionId: value.sessionId, reason: "Different command using the same operation ID.", expectedVersion: first.body.version, operationId: prepareOperation });
    expect(misuse.status).toBe(409);
    expect(misuse.body.error).toContain("operationId");

    const checks = await passChecks(app, value, first.body);
    const authorizationOperation = randomUUID();
    const body = { sessionId: value.sessionId, reason: "All current safety inputs reviewed.", expectedVersion: checks.hold.body.version, operationId: authorizationOperation };
    const authorized = await post(app, `/releases/${first.body.id}/authorize`, body);
    const authorizationRetry = await post(app, `/releases/${first.body.id}/authorize`, body);
    expect(authorized.status).toBe(200);
    expect(authorizationRetry.body).toMatchObject({ id: first.body.id, status: "AUTHORIZED", idempotent: true });
  });

  it("allows only one logical authorization and one completion", async () => {
    const value = await fixture(app, randomUUID().slice(0, 8));
    const prepared = await prepare(app, value);
    const checks = await passChecks(app, value, prepared.body);
    const [left, right] = await Promise.all([
      post(app, `/releases/${prepared.body.id}/authorize`, { sessionId: value.sessionId, reason: "Operator A authorization basis.", expectedVersion: checks.hold.body.version, operationId: randomUUID() }),
      post(app, `/releases/${prepared.body.id}/authorize`, { sessionId: value.sessionId, reason: "Operator B authorization basis.", expectedVersion: checks.hold.body.version, operationId: randomUUID() })
    ]);
    expect([left.status, right.status].sort()).toEqual([200, 409]);
    const authorized = left.status === 200 ? left.body : right.body;
    const completed = await post(app, `/releases/${prepared.body.id}/complete`, { sessionId: value.sessionId, reason: "Physical handover completed exactly once.", expectedVersion: authorized.version, operationId: randomUUID() });
    expect(completed.status).toBe(200);
    expect((await post(app, `/releases/${prepared.body.id}/complete`, { sessionId: value.sessionId, reason: "Second independent completion must fail.", expectedVersion: completed.body.version, operationId: randomUUID() })).status).toBe(409);
    expect((await prepare(app, value)).status).toBe(409);
  });

  it("supports separate workflows for multiple NOK linked to one Passenger", async () => {
    const first = await fixture(app, `A-${randomUUID().slice(0, 6)}`);
    const second = await fixture(app, `B-${randomUUID().slice(0, 6)}`, first.passenger.id);
    const firstAction = await prepare(app, first, "REUNIFICATION");
    const secondAction = await prepare(app, second, "REUNIFICATION");
    expect(firstAction.status).toBe(201);
    expect(secondAction.status).toBe(201);
    expect(firstAction.body.relationshipClaimId).not.toBe(secondAction.body.relationshipClaimId);
    expect(firstAction.body.passengerRecordId).toBe(secondAction.body.passengerRecordId);
  });
});
