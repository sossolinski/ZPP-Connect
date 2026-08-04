import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createMemoryEnquiryRepository } from "./modules/enquiries/memory-enquiry-repository.js";
import { createMemoryIncidentAccessRepository } from "./modules/incident-access/memory-incident-access-repository.js";
import { createMemoryIncidentRepository } from "./modules/incidents/memory-incident-repository.js";

type Row = Record<string, any>;

const sessionA = { id: "incident-exercise-a", operationalId: "SES-A", mode: "EXERCISE", status: "Active", eventType: "Exercise", createdAt: "2026-08-04T10:00:00Z", updatedAt: "2026-08-04T10:00:00Z" };
const sessionB = { id: "incident-real-b", operationalId: "SES-B", mode: "REAL", status: "Active", eventType: "Real", createdAt: "2026-08-04T10:00:00Z", updatedAt: "2026-08-04T10:00:00Z" };

function enquiry(id: string, sessionId: string, callerName: string) {
  return {
    id,
    operationalId: `TEC-${id}`,
    sessionId,
    contactChannel: "Phone",
    callerName,
    enquiryType: "Information request",
    urgency: "Normal",
    status: "New",
    version: 1,
    createdAt: "2026-08-04T10:00:00Z",
    updatedAt: "2026-08-04T10:00:00Z"
  };
}

describe("Enquiry incident isolation", () => {
  let sessions: Row[];
  let enquiries: Row[];
  let passengers: Row[];
  let auditLogs: Row[];
  let timeline: Row[];

  beforeEach(() => {
    sessions = [{ ...sessionA }, { ...sessionB }];
    enquiries = [enquiry("enquiry-a", sessionA.id, "Caller A"), enquiry("enquiry-b", sessionB.id, "Caller B")];
    passengers = [
      { id: "passenger-a", sessionId: sessionA.id },
      { id: "passenger-b", sessionId: sessionB.id }
    ];
    auditLogs = [];
    timeline = [];
  });

  function app() {
    return createApp({
      incidentRepository: createMemoryIncidentRepository({ sessions, auditLogs, timeline }),
      enquiryRepository: createMemoryEnquiryRepository({ enquiries, passengers, auditLogs, timeline }),
      incidentAccessRepository: createMemoryIncidentAccessRepository({
        incidents: sessions,
        assignments: [
          { incidentId: sessionA.id, userEmail: "tec@lot.pl" },
          { incidentId: sessionA.id, userEmail: "viewer@lot.pl" }
        ]
      })
    });
  }

  const as = (email: string) => ({ "x-user-email": email });

  it("requires permission and an incident assignment without leaking another incident", async () => {
    const api = app();
    expect((await request(api).get(`/api/enquiries/enquiry-a?sessionId=${sessionA.id}`).set(as("tec@lot.pl"))).status).toBe(200);
    expect((await request(api).get(`/api/enquiries/enquiry-b?sessionId=${sessionB.id}`).set(as("tec@lot.pl"))).status).toBe(404);
    expect((await request(api).get(`/api/enquiries?sessionId=${sessionB.id}`).set(as("tec@lot.pl"))).status).toBe(404);
    expect((await request(api).get(`/api/dashboard?sessionId=${sessionB.id}`).set(as("tec@lot.pl"))).status).toBe(404);
    expect((await request(api).patch("/api/enquiries/enquiry-b").set(as("tec@lot.pl")).send({
      sessionId: sessionB.id,
      version: 1,
      callerName: "Cross-incident write"
    })).status).toBe(404);

    expect((await request(api).get(`/api/enquiries/enquiry-a?sessionId=${sessionA.id}`).set(as("viewer@lot.pl"))).status).toBe(403);
    expect((await request(api).patch("/api/enquiries/enquiry-a").set(as("viewer@lot.pl")).send({
      sessionId: sessionA.id,
      version: 1,
      callerName: "No update permission"
    })).status).toBe(403);
  });

  it("enforces passenger scope, protected states, optimistic concurrency and closed incidents", async () => {
    const api = app();
    const crossPassenger = await request(api).post("/api/enquiries").set(as("tec@lot.pl")).send({
      sessionId: sessionA.id,
      contactChannel: "Phone",
      callerName: "Cross link",
      passengerRecordId: "passenger-b",
      enquiryType: "Information request",
      urgency: "Normal",
      status: "New"
    });
    expect(crossPassenger.status).toBe(409);

    const protectedStatus = await request(api).patch("/api/enquiries/enquiry-a").set(as("tec@lot.pl")).send({
      sessionId: sessionA.id,
      version: 1,
      status: "Closed"
    });
    expect(protectedStatus.status).toBe(400);

    const updated = await request(api).patch("/api/enquiries/enquiry-a").set(as("tec@lot.pl")).send({
      sessionId: sessionA.id,
      version: 1,
      callerLocation: "Warsaw"
    });
    expect(updated.status).toBe(200);
    expect(updated.body.version).toBe(2);
    expect(auditLogs[0]).toMatchObject({ action: "update_enquiry", sessionId: sessionA.id });

    const stale = await request(api).patch("/api/enquiries/enquiry-a").set(as("tec@lot.pl")).send({
      sessionId: sessionA.id,
      version: 1,
      callerLocation: "Stale"
    });
    expect(stale.status).toBe(409);

    sessions[0]!.status = "Closed";
    const closedIncident = await request(api).patch("/api/enquiries/enquiry-a").set(as("tec@lot.pl")).send({
      sessionId: sessionA.id,
      version: 2,
      callerLocation: "Blocked"
    });
    expect(closedIncident.status).toBe(409);
  });

  it("records controlled transitions and rejects invalid or stale transitions", async () => {
    const api = app();
    const urgent = await request(api).post("/api/enquiries/enquiry-a/mark-urgent").set(as("tec@lot.pl")).send({
      sessionId: sessionA.id,
      version: 1,
      notes: "Caller welfare escalation"
    });
    expect(urgent.status).toBe(200);
    expect(urgent.body).toMatchObject({ status: "Urgent welfare", urgency: "Urgent welfare", version: 2 });
    expect(auditLogs[0]).toMatchObject({ action: "mark_urgent", sessionId: sessionA.id });
    expect(timeline[0]).toMatchObject({ entityType: "enquiry", entityId: "enquiry-a" });

    expect((await request(api).post("/api/enquiries/enquiry-a/mark-urgent").set(as("tec@lot.pl")).send({
      sessionId: sessionA.id,
      version: 2
    })).status).toBe(409);
    expect((await request(api).post("/api/enquiries/enquiry-a/close").set(as("tec@lot.pl")).send({
      sessionId: sessionA.id,
      version: 1
    })).status).toBe(409);
  });
});
