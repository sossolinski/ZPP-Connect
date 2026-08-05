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

function post(app: ReturnType<typeof createApp>, path: string, body: Record<string, unknown>, email?: string) {
  return as(request(app).post(`/api${path}`), email).send(body);
}

async function createFixture(app: ReturnType<typeof createApp>, token: string, passengerId?: string) {
  const caseId = `CASE-STAGE5-${token}`;
  const passenger = passengerId
    ? (await as(request(app).get(`/api/passenger-records/${passengerId}`)).query({ sessionId: "ses-demo-1" })).body
    : (await post(app, "/passenger-records", { sessionId: "ses-demo-1", caseId, personType: "Passenger", firstName: "Jan", lastName: token, flightNumber: `LO-${token}`, source: "Manual" })).body;
  const family = (await post(app, "/family-records", {
    sessionId: "ses-demo-1",
    caseId,
    firstName: "NOK",
    lastName: token,
    claimedRelationship: "Parent",
    passengerFirstName: passenger.firstName,
    passengerLastName: passenger.lastName,
    passengerFlight: passenger.flightNumber
  })).body;
  return { family, passenger, claim: family.currentClaim, caseId };
}

type MatchingFixture = Awaited<ReturnType<typeof createFixture>>;

function confirmBody(value: MatchingFixture, operationId = randomUUID(), passenger = value.passenger) {
  return {
    sessionId: "ses-demo-1",
    passengerRecordId: passenger.id,
    reason: "Operator reviewed the source records and documented the match.",
    expectedClaimVersion: value.claim.version,
    expectedPassengerVersion: passenger.version,
    operationId
  };
}

describe("Foundation Stage 5 matching contract (memory)", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
  });

  it("persists explainable suggestions separately from an explicit human decision", async () => {
    const value = await createFixture(app, `SUG-${randomUUID().slice(0, 8)}`);
    const generated = await post(app, `/matching/claims/${value.claim.id}/suggestions/generate`, {
      sessionId: "ses-demo-1",
      expectedClaimVersion: value.claim.version
    });
    expect(generated.status).toBe(201);
    expect(generated.body.data.length).toBeGreaterThan(0);
    const suggestion = generated.body.data.find((item: any) => item.passengerRecordId === value.passenger.id);
    expect(suggestion).toMatchObject({
      algorithm: "zpp-deterministic-candidate",
      algorithmVersion: "1.0.0",
      claimVersion: value.claim.version,
      passengerVersion: value.passenger.version,
      status: "ACTIVE",
      isCurrent: true
    });
    expect(suggestion.positiveSignals.length).toBeGreaterThan(0);
    expect((await as(request(app).get("/api/matching-records")).query({ sessionId: "ses-demo-1", search: value.caseId })).body.data).toHaveLength(0);

    const familyBefore = (await as(request(app).get(`/api/family-records/${value.family.id}`)).query({ sessionId: "ses-demo-1" })).body;
    const confirmed = await post(app, `/matching/claims/${value.claim.id}/confirm`, {
      ...confirmBody(value),
      suggestionId: suggestion.id
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({ state: "CONFIRMED", idempotent: false, currentDecision: { decision: "CONFIRMED", suggestionId: suggestion.id, effectiveValidity: "CURRENT" } });
    expect(confirmed.body.suggestions.find((item: any) => item.id === suggestion.id).status).toBe("USED");

    const familyAfter = (await as(request(app).get(`/api/family-records/${value.family.id}`)).query({ sessionId: "ses-demo-1" })).body;
    expect(familyAfter.verificationStatus).toBe(familyBefore.verificationStatus);
    expect(familyAfter.currentClaim.status).toBe(familyBefore.currentClaim.status);
    expect(familyAfter.version).toBe(familyBefore.version);
    const passengerAfter = (await as(request(app).get(`/api/passenger-records/${value.passenger.id}`)).query({ sessionId: "ses-demo-1" })).body;
    expect(passengerAfter.version).toBe(value.passenger.version);
  });

  it("uses operation IDs for safe retries and rejects reuse for a different command", async () => {
    const value = await createFixture(app, `IDEM-${randomUUID().slice(0, 8)}`);
    const op = randomUUID();
    const body = confirmBody(value, op);
    const first = await post(app, `/matching/claims/${value.claim.id}/confirm`, body);
    const retry = await post(app, `/matching/claims/${value.claim.id}/confirm`, body);
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.body.idempotent).toBe(true);
    expect(retry.body.decisionHistory.filter((item: any) => item.operationId === op)).toHaveLength(1);

    const otherPassenger = (await post(app, "/passenger-records", { sessionId: "ses-demo-1", personType: "Passenger", firstName: "Other", lastName: "Passenger", source: "Manual" })).body;
    const reused = await post(app, `/matching/claims/${value.claim.id}/confirm`, confirmBody(value, op, otherPassenger));
    expect(reused.status).toBe(409);
    expect(reused.body.error).toContain("operationId");
  });

  it("records suggestion rejection without rejecting the relationship and preserves history across regeneration", async () => {
    const value = await createFixture(app, `REJECT-${randomUUID().slice(0, 8)}`);
    const firstGeneration = await post(app, `/matching/claims/${value.claim.id}/suggestions/generate`, { sessionId: "ses-demo-1", expectedClaimVersion: value.claim.version });
    const suggestion = firstGeneration.body.data.find((item: any) => item.passengerRecordId === value.passenger.id);
    const rejected = await post(app, `/matching/claims/${value.claim.id}/reject`, {
      sessionId: "ses-demo-1",
      passengerRecordId: value.passenger.id,
      suggestionId: suggestion.id,
      reason: "The operator found conflicting evidence for this algorithm suggestion.",
      expectedClaimVersion: value.claim.version,
      expectedPassengerVersion: value.passenger.version,
      expectedSuggestionVersion: suggestion.version,
      operationId: randomUUID()
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body.decisionHistory[0]).toMatchObject({ decision: "REJECTED", validity: "HISTORICAL", isCurrent: false });
    const family = (await as(request(app).get(`/api/family-records/${value.family.id}`)).query({ sessionId: "ses-demo-1" })).body;
    expect(family.currentClaim.status).toBe("PENDING");
    const filtered = await as(request(app).get(`/api/matching/claims/${value.claim.id}/suggestions`)).query({ sessionId: "ses-demo-1", status: "REJECTED", hasConflicts: "false" });
    expect(filtered.body.data.map((item: any) => item.id)).toContain(suggestion.id);

    const nextGeneration = await post(app, `/matching/claims/${value.claim.id}/suggestions/generate`, { sessionId: "ses-demo-1", expectedClaimVersion: value.claim.version });
    expect(nextGeneration.body.data[0].id).not.toBe(suggestion.id);
    const history = (await as(request(app).get(`/api/matching/claims/${value.claim.id}/suggestions`)).query({ sessionId: "ses-demo-1", limit: 200 })).body.data;
    expect(history.find((item: any) => item.id === suggestion.id)).toMatchObject({ status: "REJECTED", isCurrent: false });
  });

  it("allows only one concurrent current confirmation for a claim", async () => {
    const value = await createFixture(app, `RACE-${randomUUID().slice(0, 8)}`);
    const otherPassenger = (await post(app, "/passenger-records", { sessionId: "ses-demo-1", personType: "Passenger", firstName: "Other", lastName: "Candidate", source: "Manual" })).body;
    const [left, right] = await Promise.all([
      post(app, `/matching/claims/${value.claim.id}/confirm`, confirmBody(value)),
      post(app, `/matching/claims/${value.claim.id}/confirm`, confirmBody(value, randomUUID(), otherPassenger))
    ]);
    expect([left.status, right.status].sort()).toEqual([200, 409]);
    const context = (await as(request(app).get(`/api/matching/claims/${value.claim.id}`)).query({ sessionId: "ses-demo-1" })).body;
    expect(context.decisionHistory.filter((item: any) => item.decision === "CONFIRMED" && item.isCurrent)).toHaveLength(1);
  });

  it("invalidates without deleting history and safely retries the same critical command", async () => {
    const value = await createFixture(app, `INVALIDATE-${randomUUID().slice(0, 8)}`);
    const confirmed = await post(app, `/matching/claims/${value.claim.id}/confirm`, confirmBody(value));
    const op = randomUUID();
    const body = {
      sessionId: "ses-demo-1",
      decisionId: confirmed.body.currentDecision.id,
      reason: "New evidence showed that the earlier match decision was incorrect.",
      expectedClaimVersion: value.claim.version,
      expectedPassengerVersion: value.passenger.version,
      operationId: op
    };
    const first = await post(app, `/matching/claims/${value.claim.id}/invalidate`, body);
    const retry = await post(app, `/matching/claims/${value.claim.id}/invalidate`, body);
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.body.idempotent).toBe(true);
    expect(retry.body.currentDecision).toBeNull();
    expect(retry.body.decisionHistory.filter((item: any) => item.operationId === op)).toHaveLength(1);
    expect(retry.body.decisionHistory.find((item: any) => item.id === confirmed.body.currentDecision.id)).toMatchObject({ validity: "SUPERSEDED", isCurrent: false });
  });

  it("marks decisions stale after source changes and preserves superseded history on re-confirmation", async () => {
    const value = await createFixture(app, `STALE-${randomUUID().slice(0, 8)}`);
    expect((await post(app, `/matching/claims/${value.claim.id}/confirm`, confirmBody(value))).status).toBe(200);

    const correctedPassenger = await post(app, `/passenger-records/${value.passenger.id}/correct-source`, {
      sessionId: "ses-demo-1",
      version: value.passenger.version,
      firstName: "Janusz",
      reason: "Source record correction received from the manifest owner."
    });
    expect(correctedPassenger.status).toBe(200);
    const stale = (await as(request(app).get(`/api/matching/claims/${value.claim.id}`)).query({ sessionId: "ses-demo-1" })).body;
    expect(stale).toMatchObject({ state: "STALE", currentDecision: { effectiveValidity: "STALE" } });
    const staleProjection = (await as(request(app).get("/api/matching-records")).query({ sessionId: "ses-demo-1", search: value.caseId })).body.data[0];
    expect(staleProjection).toMatchObject({ status: "Requires review", releaseEligibility: { matchDecision: "STALE", eligible: false } });

    const reconfirmed = await post(app, `/matching/claims/${value.claim.id}/confirm`, {
      ...confirmBody({ ...value, passenger: correctedPassenger.body }, randomUUID(), correctedPassenger.body),
      reason: "Corrected source facts were reviewed and the match was reconfirmed."
    });
    expect(reconfirmed.status).toBe(200);
    expect(reconfirmed.body.state).toBe("CONFIRMED");
    expect(reconfirmed.body.decisionHistory.some((item: any) => item.validity === "SUPERSEDED" && !item.isCurrent)).toBe(true);
    expect(reconfirmed.body.currentDecision.supersedesDecisionId).toBeTruthy();
  });

  it("keeps relationship verification independent and permits multiple NOK claims for one passenger", async () => {
    const first = await createFixture(app, `NOK-A-${randomUUID().slice(0, 8)}`);
    const second = await createFixture(app, `NOK-B-${randomUUID().slice(0, 8)}`, first.passenger.id);
    expect((await post(app, `/matching/claims/${first.claim.id}/confirm`, confirmBody(first))).status).toBe(200);
    expect((await post(app, `/matching/claims/${second.claim.id}/confirm`, confirmBody(second))).status).toBe(200);
    const matches = (await as(request(app).get("/api/matching-records")).query({ sessionId: "ses-demo-1", limit: 200 })).body.data.filter((item: any) => item.passengerRecordId === first.passenger.id);
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(matches.every((item: any) => item.releaseEligibility.relationshipVerification === "NOT_VERIFIED")).toBe(true);
  });

  it("isolates incidents and removes generic legacy matching writes", async () => {
    const generic = await post(app, "/matching-records", { sessionId: "ses-demo-1" });
    expect(generic.status).toBe(404);

    const realSession = (await post(app, "/sessions", { mode: "REAL", status: "Active", eventType: "Operational incident", flightNumber: `REAL-${randomUUID().slice(0, 6)}` })).body;
    const passenger = (await post(app, "/passenger-records", { sessionId: realSession.id, personType: "Passenger", firstName: "Real", lastName: "Passenger", source: "Manual" })).body;
    const family = (await post(app, "/family-records", { sessionId: realSession.id, firstName: "Real", lastName: "NOK", passengerFirstName: "Real", passengerLastName: "Passenger" })).body;
    const exerciseQueue = (await as(request(app).get("/api/matching/queue")).query({ sessionId: "ses-demo-1", search: family.operationalId })).body;
    expect(exerciseQueue.total).toBe(0);
    const crossPassenger = await post(app, `/matching/claims/${family.currentClaim.id}/confirm`, {
      sessionId: realSession.id,
      passengerRecordId: "pax-demo-1",
      reason: "Cross-incident records must be rejected.",
      expectedClaimVersion: family.currentClaim.version,
      expectedPassengerVersion: 1,
      operationId: randomUUID()
    });
    expect(crossPassenger.status).toBe(409);
    const correct = await post(app, `/matching/claims/${family.currentClaim.id}/confirm`, {
      sessionId: realSession.id,
      passengerRecordId: passenger.id,
      reason: "Records belong to the same REAL incident.",
      expectedClaimVersion: family.currentClaim.version,
      expectedPassengerVersion: passenger.version,
      operationId: randomUUID()
    });
    expect(correct.status).toBe(200);
    expect((await as(request(app).get("/api/matching-records")).query({ sessionId: "ses-demo-1", search: family.operationalId })).body.total).toBe(0);
  });
});
