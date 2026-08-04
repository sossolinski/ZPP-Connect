import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createMemoryIncidentAccessRepository, type MemoryIncidentAssignment } from "./modules/incident-access/memory-incident-access-repository.js";
import { createMemoryIncidentAssignmentRepository } from "./modules/incident-assignments/memory-incident-assignment-repository.js";
import { createMemoryIncidentRepository } from "./modules/incidents/memory-incident-repository.js";

type Row = Record<string, any>;

const demoUsers = {
  admin: { id: "00000000-0000-4000-8000-000000000001", email: "admin@lot.pl", displayName: "System Admin", status: "Active" },
  coordinator: { id: "00000000-0000-4000-8000-000000000002", email: "coordinator@lot.pl", displayName: "ZPP Coordinator", status: "Active" },
  tec: { id: "00000000-0000-4000-8000-000000000003", email: "tec@lot.pl", displayName: "TEC Member", status: "Active" },
  viewer: { id: "00000000-0000-4000-8000-000000000006", email: "viewer@lot.pl", displayName: "Observer", status: "Active" }
};

describe("Incident access lifecycle", () => {
  let sessions: Row[];
  let assignments: MemoryIncidentAssignment[];
  let auditLogs: Row[];
  let timeline: Row[];

  beforeEach(() => {
    sessions = [
      { id: "incident-exercise", operationalId: "SES-EX", mode: "EXERCISE", status: "Active", eventType: "Exercise", createdAt: "2026-08-04T10:00:00Z", updatedAt: "2026-08-04T10:00:00Z" },
      { id: "incident-real", operationalId: "SES-REAL", mode: "REAL", status: "Draft", eventType: "Real", createdAt: "2026-08-04T10:00:00Z", updatedAt: "2026-08-04T10:00:00Z" },
      { id: "incident-training", operationalId: "SES-TR", mode: "TRAINING", status: "Active", eventType: "Training", createdAt: "2026-08-04T10:00:00Z", updatedAt: "2026-08-04T10:00:00Z" }
    ];
    assignments = [];
    auditLogs = [];
    timeline = [];
  });

  function application() {
    const access = createMemoryIncidentAccessRepository({ incidents: sessions, assignments });
    const lifecycle = createMemoryIncidentAssignmentRepository({
      incidents: sessions,
      assignments,
      users: Object.values(demoUsers),
      auditLogs,
      now: () => "2026-08-04T12:00:00.000Z"
    });
    return createApp({
      incidentRepository: createMemoryIncidentRepository({ sessions, incidentAssignments: assignments, auditLogs, timeline }),
      incidentAccessRepository: access,
      incidentAssignmentRepository: lifecycle
    });
  }

  const as = (email: string) => ({ "x-user-email": email });

  it("scopes all modes, revokes immediately, reactivates in place and records audit history", async () => {
    const app = application();
    expect((await request(app).get("/api/sessions").set(as(demoUsers.tec.email))).body.data).toEqual([]);
    expect((await request(app).get("/api/sessions").set(as(demoUsers.admin.email))).body.data).toHaveLength(3);

    const assigned = await request(app).post("/api/sessions/incident-exercise/assignments").set(as(demoUsers.admin.email)).send({
      userId: demoUsers.tec.id,
      function: "TEC operator"
    });
    expect(assigned.status).toBe(201);
    expect((await request(app).get("/api/sessions").set(as(demoUsers.tec.email))).body.data.map((row: Row) => row.id)).toEqual(["incident-exercise"]);
    expect((await request(app).get("/api/sessions/incident-real").set(as(demoUsers.tec.email))).status).toBe(404);
    expect((await request(app).get("/api/sessions/incident-training").set(as(demoUsers.tec.email))).status).toBe(404);

    const revoked = await request(app).post(`/api/sessions/incident-exercise/assignments/${assigned.body.id}/revoke`).set(as(demoUsers.admin.email)).send({ reason: "Shift ended" });
    expect(revoked.status).toBe(200);
    expect((await request(app).get("/api/sessions/incident-exercise").set(as(demoUsers.tec.email))).status).toBe(404);

    const reactivated = await request(app).post(`/api/sessions/incident-exercise/assignments/${assigned.body.id}/reactivate`).set(as(demoUsers.admin.email)).send({ reason: "Shift resumed" });
    expect(reactivated.status).toBe(200);
    expect(reactivated.body).toMatchObject({ id: assigned.body.id, active: true });
    expect((await request(app).get("/api/sessions/incident-exercise").set(as(demoUsers.tec.email))).status).toBe(200);
    expect(auditLogs.map((row) => row.action).reverse()).toEqual([
      "incident_assignment_assigned",
      "incident_assignment_revoked",
      "incident_assignment_reactivated"
    ]);
  });

  it("does not turn incident access into assignment-management permission", async () => {
    const app = application();
    const assigned = await request(app).post("/api/sessions/incident-exercise/assignments").set(as(demoUsers.admin.email)).send({ userId: demoUsers.viewer.id });
    expect(assigned.status).toBe(201);
    expect((await request(app).post("/api/sessions/incident-exercise/assignments").set(as(demoUsers.viewer.email)).send({ userId: demoUsers.tec.id })).status).toBe(403);
    expect((await request(app).post(`/api/sessions/incident-exercise/assignments/${assigned.body.id}/revoke`).set(as(demoUsers.viewer.email)).send({})).status).toBe(403);
  });
});
