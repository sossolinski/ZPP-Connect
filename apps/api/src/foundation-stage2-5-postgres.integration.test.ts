import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createPrismaIncidentRepository } from "./modules/incidents/prisma-incident-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;
const prisma = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;

function as(email: string) {
  return { "x-user-email": email };
}

postgresDescribe("Foundation Stage 2.5 PostgreSQL incident access closure", () => {
  const marker = `F25-${Date.now()}`;
  const incidentIds: string[] = [];
  const enquiryIds: string[] = [];
  let exerciseId: string;
  let realId: string;
  let trainingId: string;
  let adminId: string;
  let coordinatorId: string;
  let tecId: string;
  let viewerId: string;

  const app = () => createApp({ incidentRepository: createPrismaIncidentRepository(prisma!) });

  beforeAll(async () => {
    await prisma!.$connect();
    const [admin, coordinator, tec, viewer] = await Promise.all([
      prisma!.user.findUniqueOrThrow({ where: { email: "admin@lot.pl" } }),
      prisma!.user.findUniqueOrThrow({ where: { email: "coordinator@lot.pl" } }),
      prisma!.user.findUniqueOrThrow({ where: { email: "tec@lot.pl" } }),
      prisma!.user.findUniqueOrThrow({ where: { email: "viewer@lot.pl" } })
    ]);
    adminId = admin.id;
    coordinatorId = coordinator.id;
    tecId = tec.id;
    viewerId = viewer.id;

    const [exercise, real, training] = await Promise.all([
      prisma!.session.create({ data: { operationalId: `${marker}-EX`, mode: "EXERCISE", status: "Active", eventType: marker, createdById: adminId } }),
      prisma!.session.create({ data: { operationalId: `${marker}-REAL`, mode: "REAL", status: "Draft", eventType: marker, createdById: adminId } }),
      prisma!.session.create({ data: { operationalId: `${marker}-TR`, mode: "TRAINING", status: "Active", eventType: marker, createdById: adminId } })
    ]);
    exerciseId = exercise.id;
    realId = real.id;
    trainingId = training.id;
    incidentIds.push(exerciseId, realId, trainingId);
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.caseTimelineEvent.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.auditLog.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.enquiry.deleteMany({ where: { id: { in: enquiryIds } } });
    await prisma.incidentAssignment.deleteMany({ where: { incidentId: { in: incidentIds } } });
    await prisma.session.deleteMany({ where: { id: { in: incidentIds } } });
    await prisma.$disconnect();
  });

  it("has all migrations and database-level isolation objects on the fresh database", async () => {
    const migrations = await prisma!.$queryRaw<Array<{ migration_name: string }>>`
      SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY migration_name
    `;
    expect(migrations.map((row) => row.migration_name)).toEqual(expect.arrayContaining([
      "20260701000000_baseline",
      "20260712090000_assignment_identity",
      "20260804000000_enquiry_incident_isolation",
      "20260804010000_incident_assignment_lifecycle"
    ]));

    const indexes = await prisma!.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename IN ('Session', 'IncidentAssignment', 'Enquiry')
    `;
    expect(indexes.map((row) => row.indexname)).toEqual(expect.arrayContaining([
      "Session_one_active_real_idx",
      "IncidentAssignment_incidentId_userId_key",
      "IncidentAssignment_userId_active_idx",
      "IncidentAssignment_incidentId_active_createdAt_idx",
      "Enquiry_sessionId_status_updatedAt_idx"
    ]));
    expect(indexes.find((row) => row.indexname === "Session_one_active_real_idx")?.indexdef).toMatch(/WHERE.*REAL.*Active/i);

    const constraints = await prisma!.$queryRaw<Array<{ conname: string }>>`
      SELECT conname FROM pg_constraint
      WHERE conname IN (
        'Enquiry_version_positive_check',
        'IncidentAssignment_incidentId_fkey',
        'IncidentAssignment_userId_fkey',
        'IncidentAssignment_createdById_fkey',
        'IncidentAssignment_revokedById_fkey'
      )
    `;
    expect(constraints.map((row) => row.conname)).toHaveLength(5);

    const triggers = await prisma!.$queryRaw<Array<{ trigger_name: string }>>`
      SELECT trigger_name FROM information_schema.triggers
      WHERE event_object_schema = 'public' AND event_object_table = 'Enquiry'
    `;
    expect(triggers.map((row) => row.trigger_name)).toContain("Enquiry_passenger_incident_check");
  });

  it("scopes session list/get, applies the named System Admin override and never inherits access across modes", async () => {
    const api = app();
    const initiallyVisible = await request(api).get("/api/sessions").query({ search: marker }).set(as("tec@lot.pl"));
    expect(initiallyVisible.status).toBe(200);
    expect(initiallyVisible.body.data).toHaveLength(0);
    expect((await request(api).get(`/api/sessions/${exerciseId}`).set(as("tec@lot.pl"))).status).toBe(403);

    const adminVisible = await request(api).get("/api/sessions").query({ search: marker }).set(as("admin@lot.pl"));
    expect(adminVisible.status).toBe(200);
    expect(adminVisible.body.data.map((row: { id: string }) => row.id)).toEqual(expect.arrayContaining([exerciseId, realId, trainingId]));
    expect(await prisma!.incidentAssignment.count({ where: { incidentId: { in: [exerciseId, realId, trainingId] }, userId: adminId } })).toBe(0);

    const assigned = await request(api).post(`/api/sessions/${exerciseId}/assignments`).set(as("admin@lot.pl")).send({
      userId: tecId,
      function: "TEC operator",
      scope: "OPERATIONAL",
      reason: "Stage 2.5 PostgreSQL lifecycle test"
    });
    expect(assigned.status).toBe(201);
    expect(assigned.body).toMatchObject({ incidentId: exerciseId, userId: tecId, active: true });

    const scoped = await request(api).get("/api/sessions").query({ search: marker }).set(as("tec@lot.pl"));
    expect(scoped.status).toBe(200);
    expect(scoped.body.data.map((row: { id: string }) => row.id)).toEqual([exerciseId]);
    expect((await request(api).get(`/api/sessions/${exerciseId}`).set(as("tec@lot.pl"))).status).toBe(200);
    expect((await request(api).get(`/api/sessions/${realId}`).set(as("tec@lot.pl"))).status).toBe(403);
    expect((await request(api).get(`/api/sessions/${trainingId}`).set(as("tec@lot.pl"))).status).toBe(403);
  });

  it("revokes access immediately, retains history, and restores the same assignment on reactivation", async () => {
    const api = app();
    const assignment = await prisma!.incidentAssignment.findUniqueOrThrow({
      where: { incidentId_userId: { incidentId: exerciseId, userId: tecId } }
    });
    const createdEnquiry = await request(api).post("/api/enquiries").set(as("tec@lot.pl")).send({
      sessionId: exerciseId,
      contactChannel: "Phone",
      callerName: "Immediate revoke test",
      enquiryType: "Information request",
      urgency: "Normal",
      status: "New"
    });
    expect(createdEnquiry.status).toBe(201);
    enquiryIds.push(createdEnquiry.body.id);

    const revoked = await request(api).post(`/api/sessions/${exerciseId}/assignments/${assignment.id}/revoke`).set(as("admin@lot.pl")).send({
      reason: "Access no longer required"
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({ id: assignment.id, active: false, revokedById: adminId, revokeReason: "Access no longer required" });
    expect((await request(api).get(`/api/sessions/${exerciseId}`).set(as("tec@lot.pl"))).status).toBe(403);
    expect((await request(api).get(`/api/enquiries/${createdEnquiry.body.id}`).query({ sessionId: exerciseId }).set(as("tec@lot.pl"))).status).toBe(403);

    const history = await request(api).get(`/api/sessions/${exerciseId}/assignments`).query({ includeInactive: "true" }).set(as("admin@lot.pl"));
    expect(history.status).toBe(200);
    expect(history.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: assignment.id, active: false })]));

    const reactivated = await request(api).post(`/api/sessions/${exerciseId}/assignments/${assignment.id}/reactivate`).set(as("admin@lot.pl")).send({
      reason: "Returned to duty"
    });
    expect(reactivated.status).toBe(200);
    expect(reactivated.body).toMatchObject({ id: assignment.id, active: true, revokedAt: null, revokedById: null });
    expect((await request(api).get(`/api/enquiries/${createdEnquiry.body.id}`).query({ sessionId: exerciseId }).set(as("tec@lot.pl"))).status).toBe(200);

    const actions = await prisma!.auditLog.findMany({
      where: { entityType: "incident_assignment", entityId: assignment.id },
      orderBy: { createdAt: "asc" }
    });
    expect(actions.map((row) => row.action)).toEqual([
      "incident_assignment_assigned",
      "incident_assignment_revoked",
      "incident_assignment_reactivated"
    ]);
    expect(actions.every((row) => row.actorId === adminId && row.sessionId === exerciseId)).toBe(true);
  });

  it("requires assignment-management permission even when the actor can access the incident", async () => {
    const api = app();
    const viewerAssignment = await request(api).post(`/api/sessions/${exerciseId}/assignments`).set(as("admin@lot.pl")).send({
      userId: viewerId,
      function: "Observer"
    });
    expect(viewerAssignment.status).toBe(201);
    expect((await request(api).post(`/api/sessions/${exerciseId}/assignments`).set(as("viewer@lot.pl")).send({
      userId: coordinatorId
    })).status).toBe(403);
    expect((await request(api).post(`/api/sessions/${exerciseId}/assignments/${viewerAssignment.body.id}/revoke`).set(as("viewer@lot.pl")).send({
      reason: "Must not be allowed"
    })).status).toBe(403);
  });

  it("creates the incident, creator assignment and both audit records atomically", async () => {
    const api = app();
    const created = await request(api).post("/api/sessions").set(as("coordinator@lot.pl")).send({
      mode: "TRAINING",
      status: "Draft",
      eventType: marker,
      flightNumber: `${marker}-CREATOR`
    });
    expect(created.status).toBe(201);
    incidentIds.push(created.body.id);

    const creatorAssignment = await prisma!.incidentAssignment.findUnique({
      where: { incidentId_userId: { incidentId: created.body.id, userId: coordinatorId } }
    });
    expect(creatorAssignment).toMatchObject({ active: true, function: "Incident creator", createdById: coordinatorId });
    const auditActions = await prisma!.auditLog.findMany({ where: { sessionId: created.body.id }, orderBy: { createdAt: "asc" } });
    expect(auditActions.map((row) => row.action)).toEqual(["incident_assignment_assigned", "create_session"]);
    expect((await request(api).get(`/api/sessions/${created.body.id}`).set(as("coordinator@lot.pl"))).status).toBe(200);
  });
});
