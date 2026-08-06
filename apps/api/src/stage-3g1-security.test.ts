import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

type App = ReturnType<typeof createApp>;

function apiGet(app: App, path: string, email = "coordinator@lot.pl") {
  return request(app).get(path).set("x-user-email", email);
}

function apiPost(app: App, path: string, email = "coordinator@lot.pl") {
  return request(app).post(path).set("x-user-email", email);
}

function apiPatch(app: App, path: string, email = "coordinator@lot.pl") {
  return request(app).patch(path).set("x-user-email", email);
}

function ids(response: { body: { data?: Array<{ id: string }> } }) {
  return (response.body.data ?? []).map((item) => item.id);
}

function expectNoCaseDetail(body: unknown) {
  const payload = JSON.stringify(body);
  expect(payload).not.toMatch(/\b(?:CASE|TEC|FAM|PAX|MAT|REQ)-2026-/);
  expect(payload).not.toMatch(/Anna Kowalska|Piotr Kowalski|Kowalski, Piotr/);
}

describe("Stage 3G1 security containment", () => {
  it("keeps Dashboard responses within each actor's authoritative source permissions", async () => {
    const app = createApp();

    for (const email of ["security@lot.pl", "zpp@lot.pl", "volunteer@lot.pl", "tec-leader@lot.pl", "viewer@lot.pl"]) {
      const response = await apiGet(app, "/api/dashboard", email).query({ sessionId: "ses-demo-1" });
      expect(response.status, email).toBe(200);
      expect(response.body.kpis, email).toEqual({});
      expect(response.body.priorityQueue, email).toEqual({});
      expect(response.body.status, email).toEqual({});
      expectNoCaseDetail(response.body);
    }

    const tecMember = await apiGet(app, "/api/dashboard", "tec@lot.pl").query({ sessionId: "ses-demo-1" });
    expect(tecMember.status).toBe(200);
    expect(Object.keys(tecMember.body.kpis)).toEqual(expect.arrayContaining(["enquiries", "familyRecords", "openRequests"]));
    expect(tecMember.body.kpis).not.toHaveProperty("passengerRecords");
    expect(tecMember.body.kpis).not.toHaveProperty("matchingRecords");
    expect(tecMember.body.kpis).not.toHaveProperty("holds");
    expect(tecMember.body.priorityQueue).not.toHaveProperty("unresolvedHolds");
    expect(tecMember.body.priorityQueue).not.toHaveProperty("pendingMatching");
    expect((await apiGet(app, "/api/enquiries", "tec@lot.pl").query({ sessionId: "ses-demo-1" })).status).toBe(200);
    expect((await apiGet(app, "/api/family-records", "tec@lot.pl").query({ sessionId: "ses-demo-1" })).status).toBe(200);
    expect((await apiGet(app, "/api/requests", "tec@lot.pl").query({ sessionId: "ses-demo-1" })).status).toBe(200);
    expect((await apiGet(app, "/api/passenger-records", "tec@lot.pl").query({ sessionId: "ses-demo-1" })).status).toBe(403);
    expect((await apiGet(app, "/api/matching-records", "tec@lot.pl").query({ sessionId: "ses-demo-1" })).status).toBe(403);

    const coordinator = await apiGet(app, "/api/dashboard").query({ sessionId: "ses-demo-1" });
    expect(coordinator.status).toBe(200);
    expect(Object.keys(coordinator.body.priorityQueue)).toEqual(expect.arrayContaining([
      "unlinkedEnquiries",
      "unverifiedFamily",
      "unresolvedHolds",
      "pendingMatching",
      "urgentRequests"
    ]));

    const sourceRoutes: Record<string, string> = {
      unlinkedEnquiries: "/api/enquiries",
      unverifiedFamily: "/api/family-records",
      unresolvedHolds: "/api/matching-records",
      pendingMatching: "/api/matching-records",
      urgentRequests: "/api/requests"
    };
    for (const key of Object.keys(coordinator.body.priorityQueue)) {
      expect((await apiGet(app, sourceRoutes[key]!).query({ sessionId: "ses-demo-1" })).status, key).toBe(200);
    }
  });

  it("enforces canonical Group A and Group B boundaries on list, detail, search and mutation", async () => {
    const app = createApp();

    const leaderGroups = await apiGet(app, "/api/groups", "zpp@lot.pl");
    expect(leaderGroups.status).toBe(200);
    expect(ids(leaderGroups)).toEqual(["grp-2026-000001"]);

    const crossGroupSearch = await apiGet(app, "/api/groups", "zpp@lot.pl").query({ search: "TEC Evening Team" });
    expect(crossGroupSearch.status).toBe(200);
    expect(crossGroupSearch.body.data).toEqual([]);

    const crossMemberSearch = await apiGet(app, "/api/member-profiles", "zpp@lot.pl").query({ search: "Piotr Nowak" });
    expect(crossMemberSearch.status).toBe(200);
    expect(crossMemberSearch.body.data).toEqual([]);

    expect((await apiGet(app, "/api/groups/grp-2026-000001", "zpp@lot.pl")).status).toBe(200);
    expect((await apiGet(app, "/api/member-profiles/mem-2026-000001", "zpp@lot.pl")).status).toBe(200);
    expect((await apiGet(app, "/api/groups/grp-2026-000002", "zpp@lot.pl")).status).toBe(403);
    expect((await apiGet(app, "/api/member-profiles/mem-2026-000002", "zpp@lot.pl")).status).toBe(403);
    expect((await apiPatch(app, "/api/groups/grp-2026-000002", "zpp@lot.pl").send({ name: "Cross-scope rename" })).status).toBe(403);
    expect((await apiPatch(app, "/api/member-profiles/mem-2026-000002", "zpp@lot.pl").send({ firstName: "Cross-scope" })).status).toBe(403);

    const coordinatorGroups = await apiGet(app, "/api/groups");
    expect(ids(coordinatorGroups)).toEqual(expect.arrayContaining(["grp-2026-000001", "grp-2026-000002"]));
    expect((await apiGet(app, "/api/groups/grp-2026-000002")).status).toBe(200);
    expect((await apiGet(app, "/api/member-profiles/mem-2026-000002")).status).toBe(200);
  });

  it("applies the same group boundary to Rostering, Availability, Training, Documents, Readiness and Assignments", async () => {
    const app = createApp();
    const groupOneMembers = new Set([
      "mem-2026-000001",
      "mem-2026-000003",
      "mem-2026-000004",
      "mem-2026-000005",
      "mem-2026-000006",
      "mem-2026-000007"
    ]);

    const roster = await apiGet(app, "/api/roster-shifts", "zpp@lot.pl").query({ sessionId: "ses-demo-1", limit: 200 });
    expect(roster.status).toBe(200);
    expect(ids(roster)).toEqual(expect.arrayContaining(["rst-2026-000001", "rst-2026-000005"]));
    for (const foreignShiftId of ["rst-2026-000002", "rst-2026-000003", "rst-2026-000004", "rst-2026-000006"]) {
      expect(ids(roster)).not.toContain(foreignShiftId);
    }
    expect((await apiGet(app, "/api/roster-shifts/rst-2026-000003", "zpp@lot.pl")).status).toBe(403);

    const availability = await apiGet(app, "/api/availability", "zpp@lot.pl").query({ limit: 200 });
    expect(availability.status).toBe(200);
    expect(availability.body.data.every((item: { memberProfileId: string }) => groupOneMembers.has(item.memberProfileId))).toBe(true);

    const training = await apiGet(app, "/api/training/records", "zpp@lot.pl").query({ limit: 200 });
    expect(training.status).toBe(200);
    expect(ids(training)).toContain("trn-2026-000003");
    expect(ids(training)).not.toContain("trn-2026-000004");
    expect((await apiGet(app, "/api/training/records/trn-2026-000004", "zpp@lot.pl")).status).toBe(403);

    expect((await apiGet(app, "/api/readiness/groups/grp-2026-000001", "zpp@lot.pl")).status).toBe(200);
    expect((await apiGet(app, "/api/readiness/groups/grp-2026-000002", "zpp@lot.pl")).status).toBe(403);

    const documentRequirements = await apiGet(app, "/api/document-requirements", "zpp@lot.pl").query({ groupId: "grp-2026-000002", limit: 200 });
    expect(documentRequirements.status).toBe(200);
    expect(documentRequirements.body.data.length).toBeGreaterThan(0);
    expect(documentRequirements.body.data.every((item: { groupId?: string; memberProfileId?: string }) =>
      item.groupId === "grp-2026-000001" || Boolean(item.memberProfileId && groupOneMembers.has(item.memberProfileId))
    )).toBe(true);
    expect(JSON.stringify(documentRequirements.body)).not.toContain("grp-2026-000002");

    const assignments = await apiGet(app, "/api/assignments", "zpp@lot.pl").query({ sessionId: "ses-demo-1", limit: 200 });
    expect(assignments.status).toBe(200);
    expect(ids(assignments)).toContain("asn-demo-1");
    expect(ids(assignments)).not.toEqual(expect.arrayContaining(["asn-demo-2", "asn-demo-3", "asn-demo-4"]));
    expect((await apiPatch(app, "/api/assignments/asn-demo-2", "zpp@lot.pl").send({ details: "Cross-group mutation" })).status).toBe(403);

    expect((await apiGet(app, "/api/roster-shifts/rst-2026-000003")).status).toBe(200);
    expect((await apiGet(app, "/api/training/records/trn-2026-000004")).status).toBe(200);
    expect((await apiGet(app, "/api/readiness/groups/grp-2026-000002")).status).toBe(200);
    const coordinatorAssignments = await apiGet(app, "/api/assignments").query({ sessionId: "ses-demo-1", limit: 200 });
    expect(ids(coordinatorAssignments)).toContain("asn-demo-2");
  });

  it("keeps reports and CSV exports authorized, type-specific and session-contained", async () => {
    const app = createApp();

    expect((await apiGet(app, "/api/exports/session-package", "zpp@lot.pl").query({ sessionId: "ses-demo-1" })).status).toBe(403);
    expect((await apiGet(app, "/api/reports/session-summary", "zpp@lot.pl").query({ sessionId: "ses-demo-1" })).status).toBe(403);

    const systemAdminReport = await apiGet(app, "/api/reports/session-summary", "security@lot.pl").query({ sessionId: "ses-demo-1" });
    expect(systemAdminReport.status).toBe(200);
    expect(systemAdminReport.body.counts).toEqual({});
    expect(systemAdminReport.body.holds).toEqual([]);
    expect(systemAdminReport.body.urgentRequests).toEqual([]);
    expectNoCaseDetail(systemAdminReport.body);

    const expectedSections: Record<string, string> = {
      "enquiry-log": "Enquiries",
      "family-register": "FamilyRecords",
      "passenger-register": "PassengerRecords",
      "matching-log": "MatchingRecords",
      "requests-log": "Requests",
      "audit-log": "AuditLog"
    };
    const exports = new Map<string, string>();
    for (const [type, section] of Object.entries(expectedSections)) {
      const response = await apiGet(app, `/api/exports/${type}`).query({ sessionId: "ses-demo-1" });
      expect(response.status, type).toBe(200);
      expect(response.headers["content-type"], type).toMatch(/text\/csv/);
      expect(response.text, type).toContain(`${section},`);
      expect(response.text, type).not.toMatch(/\b(?:enq|fam|pax|mat|req)-demo-/);
      expect(response.text, type).not.toMatch(/actorUserId|createdById|updatedById|metadata/);
      exports.set(type, response.text);
    }
    expect(new Set(exports.values()).size).toBe(Object.keys(expectedSections).length);
    expect((await apiGet(app, "/api/exports/not-a-format").query({ sessionId: "ses-demo-1" })).status).toBe(400);
    expect((await apiGet(app, "/api/exports/pdf-session-summary").query({ sessionId: "ses-demo-1" })).status).toBe(501);

    const token = `SESSION-B-${Date.now()}`;
    const session = await apiPost(app, "/api/sessions", "admin@lot.pl").send({
      mode: "EXERCISE",
      status: "Active",
      eventType: "Exercise",
      flightNumber: token,
      route: "WAW-TEST",
      startAt: "2026-07-23T08:00:00.000Z"
    });
    expect(session.status).toBe(201);
    const assigned = await apiPost(app, `/api/sessions/${session.body.id}/assignments`, "admin@lot.pl").send({
      userId: "00000000-0000-4000-8000-000000000002",
      function: "Session containment test"
    });
    expect(assigned.status).toBe(201);

    const details = `Only ${token}, \"quoted\"\nsecond line`;
    const createdRequest = await apiPost(app, "/api/requests").send({
      sessionId: session.body.id,
      caseId: `CASE-${token}`,
      category: "Other",
      priority: "Urgent",
      requester: "Scope test",
      details,
      operationId: randomUUID()
    });
    expect(createdRequest.status).toBe(201);

    const reportA = await apiGet(app, "/api/reports/session-summary").query({ sessionId: "ses-demo-1" });
    const reportB = await apiGet(app, "/api/reports/session-summary").query({ sessionId: session.body.id });
    expect(JSON.stringify(reportA.body)).not.toContain(token);
    expect(JSON.stringify(reportB.body)).toContain(token);

    const exportA = await apiGet(app, "/api/exports/requests-log").query({ sessionId: "ses-demo-1" });
    const exportB = await apiGet(app, "/api/exports/requests-log").query({ sessionId: session.body.id });
    expect(exportA.text).not.toContain(token);
    expect(exportB.text).toContain(token);
    expect(exportB.text).toContain(`\"Only ${token}, \"\"quoted\"\"\nsecond line\"`);

    expect((await apiPost(app, `/api/sessions/${session.body.id}/close`, "admin@lot.pl").send({ notes: "Stage 3G1 session isolation verified." })).status).toBe(200);
    const historicalExport = await apiGet(app, "/api/exports/requests-log").query({ sessionId: session.body.id });
    expect(historicalExport.status).toBe(200);
    expect(historicalExport.text).toContain(token);
  });

  it("validates manifest imports before confirmation and accepts only the supported CSV contract", async () => {
    const app = createApp();

    expect((await apiPost(app, "/api/imports/manifest", "viewer@lot.pl")
      .field("sessionId", "ses-demo-1")
      .attach("file", Buffer.from("firstName,lastName\nJan,Kowalski\n"), "manifest.csv")).status).toBe(403);

    expect((await apiPost(app, "/api/imports/unknown")
      .field("sessionId", "ses-demo-1")
      .attach("file", Buffer.from("firstName,lastName\nJan,Kowalski\n"), "manifest.csv")).status).toBe(400);

    expect((await apiPost(app, "/api/imports/manifest")
      .field("sessionId", "ses-demo-1")
      .attach("file", Buffer.from("firstName,lastName\nJan,Kowalski\n"), "manifest.txt")).status).toBe(400);

    const malformed = await apiPost(app, "/api/imports/manifest")
      .field("sessionId", "ses-demo-1")
      .attach("file", Buffer.from("firstName,lastName\nMissing,\n"), "manifest.csv");
    expect(malformed.status).toBe(201);
    expect(malformed.body).toMatchObject({
      status: "Validated with errors",
      totalRecords: 1,
      validRecords: 0,
      invalidRecords: 1
    });
    expect(malformed.body.errors[0]).toMatchObject({ row: 2, error: "lastName is required" });

    const valid = await apiPost(app, "/api/imports/manifest")
      .field("sessionId", "ses-demo-1")
      .attach("file", Buffer.from("firstName,lastName,personType\nStage,Three,Passenger\n"), "manifest.csv");
    expect(valid.status).toBe(201);
    expect(valid.body.status).toBe("Validated");
    expect((await apiPost(app, `/api/imports/${valid.body.id}/confirm`).send({})).status).toBe(200);
    expect((await apiPost(app, `/api/imports/${valid.body.id}/confirm`).send({})).status).toBe(409);
  });

  it("requires an explicit writable Session for every Rostering mutation", async () => {
    const app = createApp();
    const shiftBody = {
      groupId: "grp-2026-000001",
      title: "Stage 3G1 explicit session shift",
      duty: "Scope verification",
      functionName: "Family Assistance Team",
      startAt: "2026-08-20T08:00:00.000Z",
      endAt: "2026-08-20T12:00:00.000Z"
    };

    expect((await apiPost(app, "/api/roster-shifts").send(shiftBody)).status).toBe(400);
    expect((await apiPost(app, "/api/roster-shifts").send({ ...shiftBody, sessionId: "unknown-session" })).status).toBe(404);

    const activeSession = await apiPost(app, "/api/sessions", "admin@lot.pl").send({
      mode: "TRAINING",
      status: "Active",
      eventType: "Training",
      flightNumber: `ROSTER-${Date.now()}`,
      route: "WAW-TEST",
      startAt: "2026-08-20T07:00:00.000Z"
    });
    expect(activeSession.status).toBe(201);

    const created = await apiPost(app, "/api/roster-shifts").send({ ...shiftBody, sessionId: activeSession.body.id });
    expect(created.status).toBe(201);
    expect(created.body.sessionId).toBe(activeSession.body.id);
    expect(created.body.sessionId).not.toBe("ses-demo-1");

    expect((await apiPost(app, `/api/sessions/${activeSession.body.id}/close`, "admin@lot.pl").send({ notes: "Rostering session integrity verified." })).status).toBe(200);
    expect((await apiPatch(app, `/api/roster-shifts/${created.body.id}`).send({ title: "Blocked closed-session update" })).status).toBe(409);
    expect((await apiPost(app, "/api/roster-shifts").send({ ...shiftBody, sessionId: activeSession.body.id })).status).toBe(409);
  });
});
