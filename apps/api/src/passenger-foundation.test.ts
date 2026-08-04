import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createIncidentAccessService } from "./modules/incident-access/incident-access-service.js";
import { createMemoryIncidentAccessRepository, type MemoryIncidentAssignment } from "./modules/incident-access/memory-incident-access-repository.js";
import { createMemoryPassengerRepository } from "./modules/passengers/memory-passenger-repository.js";
import { createPassengerService } from "./modules/passengers/passenger-service.js";

type Row = Record<string, any>;

const coordinator = {
  id: "00000000-0000-4000-8000-000000000002",
  email: "coordinator@lot.pl",
  displayName: "ZPP Coordinator",
  roles: ["zpp-coordinator"]
};
const admin = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "admin@lot.pl",
  displayName: "System Admin",
  roles: ["system-admin", "zpp-coordinator"]
};

describe("Passenger foundation contract", () => {
  let incidents: Row[];
  let assignments: MemoryIncidentAssignment[];
  let passengers: Row[];
  let importBatches: Row[];
  let auditLogs: Row[];
  let timeline: Row[];
  let passengerRepository: ReturnType<typeof createMemoryPassengerRepository>;
  let accessRepository: ReturnType<typeof createMemoryIncidentAccessRepository>;

  beforeEach(() => {
    incidents = [
      { id: "incident-a", mode: "EXERCISE", status: "Active" },
      { id: "incident-b", mode: "REAL", status: "Active" },
      { id: "incident-closed", mode: "TRAINING", status: "Closed" }
    ];
    assignments = ["incident-a", "incident-closed"].map((incidentId) => ({
      id: `assignment-${incidentId}`,
      incidentId,
      userId: coordinator.id,
      userEmail: coordinator.email,
      active: true,
      scope: "OPERATIONAL",
      createdAt: "2026-08-04T10:00:00.000Z"
    }));
    passengers = [];
    importBatches = [];
    auditLogs = [];
    timeline = [];
    passengerRepository = createMemoryPassengerRepository({ passengers, importBatches, auditLogs, timeline, now: () => "2026-08-04T12:00:00.000Z" });
    accessRepository = createMemoryIncidentAccessRepository({ incidents, assignments });
  });

  function app() {
    return createApp({ passengerRepository, incidentAccessRepository: accessRepository, skipRuntimeValidation: true });
  }

  const createBody = (sessionId = "incident-a") => ({
    sessionId,
    personType: "Passenger",
    firstName: "Anna",
    lastName: "Nowak",
    flightNumber: "LO123",
    source: "Manifest",
    sourceExternalId: `EXT-${sessionId}`,
    notes: "Initial operator note"
  });

  it("enforces incident access, mode isolation, revocation, closed state and permissions", async () => {
    const application = app();
    expect((await request(application).post("/api/passenger-records").set("x-user-email", coordinator.email).send(createBody())).status).toBe(201);
    expect((await request(application).get("/api/passenger-records").set("x-user-email", coordinator.email).query({ sessionId: "incident-a" })).body.total).toBe(1);
    expect((await request(application).get("/api/passenger-records").set("x-user-email", coordinator.email).query({ sessionId: "incident-b" })).status).toBe(404);
    expect((await request(application).get("/api/passenger-records").set("x-user-email", admin.email).query({ sessionId: "incident-b" })).status).toBe(200);
    expect((await request(application).post("/api/passenger-records").set("x-user-email", coordinator.email).send(createBody("incident-closed"))).status).toBe(409);
    expect((await request(application).post("/api/passenger-records").set("x-user-email", "tec-coordinator@lot.pl").send(createBody())).status).toBe(403);

    assignments[0]!.active = false;
    expect((await request(application).get("/api/passenger-records").set("x-user-email", coordinator.email).query({ sessionId: "incident-a" })).status).toBe(404);
  });

  it("protects source and controlled fields, versions writes and records decisions", async () => {
    const application = app();
    const created = await request(application).post("/api/passenger-records").set("x-user-email", coordinator.email).send(createBody());
    expect(created.body).toMatchObject({ version: 1, conditionStatus: "Unknown", holdStatus: "No hold", srcConfirmed: false });

    const protectedPatch = await request(application).patch(`/api/passenger-records/${created.body.id}`).set("x-user-email", coordinator.email).send({
      sessionId: "incident-a",
      version: 1,
      conditionStatus: "Released"
    });
    expect(protectedPatch.status).toBe(400);

    const updated = await request(application).patch(`/api/passenger-records/${created.body.id}`).set("x-user-email", coordinator.email).send({
      sessionId: "incident-a",
      version: 1,
      notes: "Updated operator note"
    });
    expect(updated.body).toMatchObject({ version: 2, notes: "Updated operator note" });
    expect((await request(application).patch(`/api/passenger-records/${created.body.id}`).set("x-user-email", coordinator.email).send({ sessionId: "incident-a", version: 1, notes: "stale" })).status).toBe(409);

    const condition = await request(application).post(`/api/passenger-records/${created.body.id}/change-condition`).set("x-user-email", coordinator.email).send({
      sessionId: "incident-a",
      version: 2,
      conditionStatus: "Hospital",
      basis: "Hospital liaison confirmed admission"
    });
    expect(condition.body).toMatchObject({ version: 3, conditionStatus: "Hospital", conditionBasis: "Hospital liaison confirmed admission" });

    const hold = await request(application).post(`/api/passenger-records/${created.body.id}/change-hold`).set("x-user-email", coordinator.email).send({
      sessionId: "incident-a",
      version: 3,
      holdStatus: "Police hold",
      reason: "Police liaison requested non-disclosure"
    });
    expect(hold.body).toMatchObject({ version: 4, holdStatus: "Police hold", holdReason: "Police liaison requested non-disclosure" });

    const confirmed = await request(application).post(`/api/passenger-records/${created.body.id}/mark-src-confirmed`).set("x-user-email", coordinator.email).send({
      sessionId: "incident-a",
      version: 4,
      basis: "SRC roster checked"
    });
    expect(confirmed.body).toMatchObject({ version: 5, srcConfirmed: true, srcConfirmationBasis: "SRC roster checked" });

    const corrected = await request(application).post(`/api/passenger-records/${created.body.id}/correct-source`).set("x-user-email", coordinator.email).send({
      sessionId: "incident-a",
      version: 5,
      seat: "14C",
      reason: "Manifest amendment received"
    });
    expect(corrected.body).toMatchObject({ version: 6, seat: "14C", srcConfirmed: false });
    expect(auditLogs.map((row) => row.action)).toEqual(expect.arrayContaining([
      "create_passenger_record",
      "update_passenger_record",
      "change_passenger_condition",
      "change_passenger_hold",
      "mark_src_confirmed",
      "correct_passenger_source"
    ]));
    expect(timeline.some((row) => row.title.includes("conditionStatus changed"))).toBe(true);
  });

  it("imports through the service with provenance and one aggregate audit entry", async () => {
    const service = createPassengerService(passengerRepository, createIncidentAccessService(accessRepository));
    const records = Array.from({ length: 20 }, (_, index) => ({
      personType: "Passenger",
      firstName: `Passenger${index}`,
      lastName: "Scale",
      source: "Manifest",
      sourceExternalId: `ROW-${index}`
    }));
    const result = await service.importRecords(coordinator, "incident-a", {
      batchId: "batch-0000-0000-4000-8000-000000000001",
      sourceFilename: "manifest.csv",
      totalRecords: 21,
      invalidRecords: 1,
      errors: [{ row: 22, error: "lastName is required" }],
      records
    });
    expect(result).toMatchObject({ status: "Imported with errors", validRecords: 20, invalidRecords: 1 });
    expect(passengers).toHaveLength(20);
    expect(passengers.every((row) => row.sourceBatchId === result.batchId && row.sourceImportedAt)).toBe(true);
    expect(auditLogs.filter((row) => row.action === "import_passenger_manifest")).toHaveLength(1);
    expect(auditLogs.filter((row) => row.action === "create_passenger_record")).toHaveLength(0);
  });

  it("searches, filters, sorts and paginates a thousand incident-scoped records", async () => {
    for (let index = 0; index < 1_000; index += 1) {
      passengers.push({
        id: `pax-${index}`,
        operationalId: `PAX-2026-${String(index + 1).padStart(6, "0")}`,
        sessionId: index === 999 ? "incident-b" : "incident-a",
        personType: "Passenger",
        firstName: `Name${index}`,
        lastName: index % 2 ? "Zulu" : "Alpha",
        flightNumber: index === 777 ? "TARGET777" : "LO123",
        source: index % 2 ? "Manifest" : "SRC",
        conditionStatus: "Unknown",
        holdStatus: "No hold",
        srcConfirmed: false,
        version: 1,
        createdAt: "2026-08-04T12:00:00.000Z",
        updatedAt: `2026-08-04T12:${String(index % 60).padStart(2, "0")}:00.000Z`
      });
    }
    const application = app();
    const page = await request(application).get("/api/passenger-records").set("x-user-email", coordinator.email).query({
      sessionId: "incident-a",
      source: "SRC",
      sortBy: "lastName",
      sortDirection: "asc",
      limit: 25,
      offset: 25
    });
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ total: 500 });
    expect(page.body.data).toHaveLength(25);
    expect(page.body.data.every((row: Row) => row.sessionId === "incident-a" && row.source === "SRC")).toBe(true);

    const search = await request(application).get("/api/passenger-records").set("x-user-email", coordinator.email).query({ sessionId: "incident-a", search: "target777" });
    expect(search.body.data).toHaveLength(1);
    expect(search.body.data[0].flightNumber).toBe("TARGET777");
  });
});
