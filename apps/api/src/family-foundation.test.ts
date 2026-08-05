import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createMemoryFamilyRepository } from "./modules/families/memory-family-repository.js";
import { createMemoryIncidentAccessRepository, type MemoryIncidentAssignment } from "./modules/incident-access/memory-incident-access-repository.js";

type Row = Record<string, any>;

const coordinator = { id: "00000000-0000-4000-8000-000000000002", email: "coordinator@lot.pl" };

describe("Family/NOK foundation contract", () => {
  let incidents: Row[];
  let assignments: MemoryIncidentAssignment[];
  let families: Row[];
  let passengers: Row[];
  let importBatches: Row[];
  let auditLogs: Row[];
  let timeline: Row[];
  let familyRepository: ReturnType<typeof createMemoryFamilyRepository>;
  let accessRepository: ReturnType<typeof createMemoryIncidentAccessRepository>;

  beforeEach(() => {
    incidents = [
      { id: "incident-a", mode: "EXERCISE", status: "Active" },
      { id: "incident-b", mode: "REAL", status: "Active" },
      { id: "incident-closed", mode: "TRAINING", status: "Closed" }
    ];
    assignments = ["incident-a", "incident-closed"].map((incidentId) => ({ id: `assignment-${incidentId}`, incidentId, userId: coordinator.id, userEmail: coordinator.email, active: true, scope: "OPERATIONAL", createdAt: "2026-08-05T10:00:00.000Z" }));
    families = [];
    passengers = [
      { id: "passenger-a", sessionId: "incident-a", firstName: "Piotr", lastName: "Nowak" },
      { id: "passenger-b", sessionId: "incident-b", firstName: "Ewa", lastName: "Nowak" }
    ];
    importBatches = [];
    auditLogs = [];
    timeline = [];
    familyRepository = createMemoryFamilyRepository({ families, passengers, importBatches, auditLogs, timeline, now: () => "2026-08-05T12:00:00.000Z" });
    accessRepository = createMemoryIncidentAccessRepository({ incidents, assignments });
  });

  function app() {
    return createApp({ familyRepository, incidentAccessRepository: accessRepository, skipRuntimeValidation: true });
  }

  const createBody = (sessionId = "incident-a", suffix = "One") => ({ sessionId, firstName: "Anna", lastName: suffix, phone: "+48 600 100 100", email: `ANNA.${suffix}@EXAMPLE.TEST`, claimedRelationship: "Sibling", passengerRecordId: sessionId === "incident-a" ? "passenger-a" : undefined, passengerFirstName: "Piotr", passengerLastName: "Nowak" });

  it("scopes access, revokes immediately, separates permissions and keeps closed incidents read-only", async () => {
    const api = app();
    expect((await request(api).post("/api/family-records").set("x-user-email", coordinator.email).send(createBody())).status).toBe(201);
    expect((await request(api).get("/api/family-records").set("x-user-email", coordinator.email).query({ sessionId: "incident-a" })).body.total).toBe(1);
    expect((await request(api).get("/api/family-records").set("x-user-email", coordinator.email).query({ sessionId: "incident-b" })).status).toBe(404);
    expect((await request(api).get("/api/family-records").set("x-user-email", "admin@lot.pl").query({ sessionId: "incident-b" })).status).toBe(200);
    expect((await request(api).post("/api/family-records").set("x-user-email", coordinator.email).send(createBody("incident-closed"))).status).toBe(409);
    expect((await request(api).post("/api/family-records").set("x-user-email", "tec@lot.pl").send(createBody())).status).toBe(403);
    assignments[0]!.active = false;
    expect((await request(api).get("/api/family-records").set("x-user-email", coordinator.email).query({ sessionId: "incident-a" })).status).toBe(404);
  });

  it("blocks generic verification, records human decisions and rejects stale concurrent decisions", async () => {
    const api = app();
    const created = await request(api).post("/api/family-records").set("x-user-email", coordinator.email).send(createBody());
    expect(created.body).toMatchObject({ version: 1, verificationStatus: "Unverified", normalizedEmail: "anna.one@example.test", currentClaim: { status: "PENDING", version: 1, passengerRecordId: "passenger-a" } });
    expect((await request(api).patch(`/api/family-records/${created.body.id}`).set("x-user-email", coordinator.email).send({ sessionId: "incident-a", version: 1, verificationStatus: "Verified" })).status).toBe(400);

    const verified = await request(api).post(`/api/family-records/${created.body.id}/verify`).set("x-user-email", coordinator.email).send({ sessionId: "incident-a", version: 1, claimVersion: 1, basis: "Identity document and family evidence reviewed", verifiedRelationshipType: "Sibling" });
    expect(verified.body).toMatchObject({ version: 2, verificationStatus: "Verified", verifiedRelationship: "Sibling", verificationDecisionById: coordinator.id, currentClaim: { status: "VERIFIED", version: 2 } });
    expect(verified.body.verificationDecisionAt).toBeTruthy();
    expect(verified.body.currentClaim.decisions).toHaveLength(1);

    const staleReject = await request(api).post(`/api/family-records/${created.body.id}/reject`).set("x-user-email", coordinator.email).send({ sessionId: "incident-a", version: 1, claimVersion: 1, basis: "Conflicting evidence" });
    expect(staleReject.status).toBe(409);

    const reopened = await request(api).post(`/api/family-records/${created.body.id}/reopen`).set("x-user-email", coordinator.email).send({ sessionId: "incident-a", version: 2, claimVersion: 2, basis: "New information requires review" });
    const rejected = await request(api).post(`/api/family-records/${created.body.id}/reject`).set("x-user-email", coordinator.email).send({ sessionId: "incident-a", version: 3, claimVersion: 3, basis: "Claimant evidence conflicts with records" });
    expect(reopened.body.currentClaim.status).toBe("PENDING");
    expect(rejected.body).toMatchObject({ verificationStatus: "Rejected", currentClaim: { status: "REJECTED", version: 4 } });
    expect(auditLogs.map((row) => row.action)).toEqual(expect.arrayContaining(["verify_family_relationship", "reopen_family_relationship", "reject_family_relationship"]));
    expect(auditLogs.find((row) => row.action === "verify_family_relationship")?.metadata).not.toHaveProperty("phone");
  });

  it("requires review after a verified claimed-fact correction and allows multiple NOK for one Passenger", async () => {
    const api = app();
    const first = await request(api).post("/api/family-records").set("x-user-email", coordinator.email).send(createBody("incident-a", "First"));
    const second = await request(api).post("/api/family-records").set("x-user-email", coordinator.email).send(createBody("incident-a", "Second"));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(families.filter((row) => row.passengerRecordId === "passenger-a" || row.id === first.body.id || row.id === second.body.id)).toHaveLength(2);

    const verified = await request(api).post(`/api/family-records/${first.body.id}/verify`).set("x-user-email", coordinator.email).send({ sessionId: "incident-a", version: 1, claimVersion: 1, basis: "Documents reviewed" });
    const corrected = await request(api).post(`/api/family-records/${first.body.id}/correct-claim`).set("x-user-email", coordinator.email).send({ sessionId: "incident-a", version: verified.body.version, claimVersion: verified.body.currentClaim.version, lastName: "Corrected", reason: "Claimant supplied corrected identity data" });
    expect(corrected.body).toMatchObject({ lastName: "Corrected", verificationStatus: "Review required", currentClaim: { status: "PENDING", version: 1 } });
    expect(corrected.body.currentClaim.id).not.toBe(verified.body.currentClaim.id);
    expect(corrected.body.decisionHistory).toHaveLength(1);
    expect(auditLogs.find((row) => row.action === "correct_family_claim")?.metadata.verificationReviewRequired).toBe(true);
  });

  it("paginates and searches one thousand records without fetch-all semantics", async () => {
    for (let index = 0; index < 1_000; index += 1) {
      families.push({ id: `family-${index}`, operationalId: `FAM-2026-${String(index + 10).padStart(6, "0")}`, sessionId: index === 999 ? "incident-b" : "incident-a", firstName: `Name${index}`, lastName: index === 777 ? "TargetSurname" : "Scale", claimedRelationship: index % 2 ? "Sibling" : "Parent", verificationStatus: index % 2 ? "Unverified" : "Verified", version: 1, createdAt: "2026-08-05T12:00:00.000Z", updatedAt: `2026-08-05T12:${String(index % 60).padStart(2, "0")}:00.000Z` });
    }
    const api = app();
    const page = await request(api).get("/api/family-records").set("x-user-email", coordinator.email).query({ sessionId: "incident-a", relationship: "Sibling", limit: 25, offset: 25, sortBy: "lastName", sortDirection: "asc" });
    expect(page.status).toBe(200);
    expect(page.body.total).toBe(499);
    expect(page.body.data).toHaveLength(25);
    const search = await request(api).get("/api/family-records").set("x-user-email", coordinator.email).query({ sessionId: "incident-a", search: "targetsurname" });
    expect(search.body.data).toHaveLength(1);
  });
});
