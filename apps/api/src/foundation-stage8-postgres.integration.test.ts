import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createPrismaAssignmentRepository } from "./modules/assignments/prisma-assignment-repository.js";
import { createPrismaIncidentAccessRepository } from "./modules/incident-access/prisma-incident-access-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;
const prisma = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;
const as = (email: string) => ({ "x-user-email": email });
function application(assignmentNotificationHook?: (record: Record<string, unknown>, command: string) => void) {
  return createApp({
    assignmentRepository: createPrismaAssignmentRepository(prisma!),
    incidentAccessRepository: createPrismaIncidentAccessRepository(prisma!),
    assignmentNotificationHook,
  });
}

postgresDescribe("Foundation Stage 8 PostgreSQL Operational Assignment safety", () => {
  const marker = `F8-${Date.now()}`;
  const incidentIds: string[] = [];
  const userIds: string[] = [];
  const roleIds: string[] = [];
  const actors: Record<string, { id: string; email: string; assignmentIds: string[] }> = {};
  let incidentA: string;
  let incidentB: string;
  let closedIncident: string;
  let adminId: string;

  async function actor(key: string, permissions: string[], incidents = [incidentA]) {
    const role = await prisma!.role.create({ data: { name: `${marker.toLowerCase()}-${key}`, displayName: `${marker} ${key}`, permissions } });
    const user = await prisma!.user.create({
      data: { email: `${marker.toLowerCase()}-${key}@example.test`, displayName: `${marker} ${key}`, roles: { create: { roleId: role.id, assignedBy: "stage8-test" } } },
    });
    const assignments = await Promise.all(incidents.map((incidentId) => prisma!.incidentAssignment.create({
      data: { incidentId, userId: user.id, function: `${key} assignment test`, createdById: adminId },
    })));
    roleIds.push(role.id);
    userIds.push(user.id);
    actors[key] = { id: user.id, email: user.email, assignmentIds: assignments.map(({ id }) => id) };
  }

  async function createAssignment(email = actors.manager!.email, values: Record<string, unknown> = {}, operationId = randomUUID()) {
    return request(application()).post("/api/assignments").set(as(email)).send({
      sessionId: incidentA,
      title: `Assignment ${marker} ${randomUUID()}`,
      priority: "Normal",
      operationId,
      ...values,
    });
  }

  beforeAll(async () => {
    await prisma!.$connect();
    adminId = (await prisma!.user.findUniqueOrThrow({ where: { email: "admin@lot.pl" } })).id;
    const incidents = await Promise.all([
      prisma!.session.create({ data: { operationalId: `${marker}-EX`, mode: "EXERCISE", status: "Active", eventType: marker, createdById: adminId } }),
      prisma!.session.create({ data: { operationalId: `${marker}-REAL`, mode: "REAL", status: "Draft", eventType: marker, createdById: adminId } }),
      prisma!.session.create({ data: { operationalId: `${marker}-CLOSED`, mode: "TRAINING", status: "Closed", eventType: marker, createdById: adminId } }),
    ]);
    incidentA = incidents[0]!.id;
    incidentB = incidents[1]!.id;
    closedIncident = incidents[2]!.id;
    incidentIds.push(incidentA, incidentB, closedIncident);
    await actor("manager", ["session:read", "assignment:read", "assignment:create", "assignment:update", "assignment:assign"], incidentIds);
    await actor("worker-a", ["session:read", "assignment:read", "assignment:update"]);
    await actor("worker-b", ["session:read", "assignment:read", "assignment:update"]);
    await actor("reader", ["session:read", "assignment:read"]);
    await actor("no-reader", ["session:read"]);
    await actor("inactive-candidate", ["session:read", "assignment:read"]);
    await prisma!.user.update({ where: { id: actors["inactive-candidate"]!.id }, data: { status: "suspended" } });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.assignmentOperation.deleteMany({ where: { incidentId: { in: incidentIds } } });
    await prisma.assignmentTask.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.caseTimelineEvent.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.auditLog.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.incidentAssignment.deleteMany({ where: { incidentId: { in: incidentIds } } });
    await prisma.session.deleteMany({ where: { id: { in: incidentIds } } });
    await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.role.deleteMany({ where: { id: { in: roleIds } } });
    await prisma.$disconnect();
  });

  it("deploys version, workflow, queue and idempotency database protections", async () => {
    const migrations = await prisma!.$queryRaw<Array<{ migration_name: string }>>`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`;
    expect(migrations.map(({ migration_name }) => migration_name)).toContain("20260809000000_assignment_tasks_foundation");
    const indexes = await prisma!.$queryRaw<Array<{ indexname: string }>>`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename IN ('AssignmentTask', 'AssignmentOperation')`;
    expect(indexes.map(({ indexname }) => indexname)).toEqual(expect.arrayContaining([
      "AssignmentTask_sessionId_status_updatedAt_idx",
      "AssignmentTask_sessionId_assignedUserId_status_idx",
      "AssignmentTask_sessionId_priority_status_idx",
      "AssignmentTask_sessionId_dueAt_idx",
      "AssignmentOperation_incidentId_operationId_key",
    ]));
    const checks = await prisma!.$queryRaw<Array<{ conname: string }>>`SELECT conname FROM pg_constraint WHERE conname IN ('AssignmentTask_version_check', 'AssignmentTask_status_check', 'AssignmentTask_priority_check', 'AssignmentTask_completed_check', 'AssignmentTask_cancelled_check')`;
    expect(checks).toHaveLength(5);
    const triggers = await prisma!.$queryRaw<Array<{ tgname: string }>>`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'AssignmentOperation_same_incident'`;
    expect(triggers).toHaveLength(1);
  });

  it("persists idempotent create and controlled human workflow across application instances", async () => {
    const operationId = randomUUID();
    const created = await createAssignment(actors.manager!.email, { priority: "Urgent", details: "Persisted facts" }, operationId);
    const retry = await createAssignment(actors.manager!.email, { priority: "Urgent", details: "Persisted facts", title: created.body.title }, operationId);
    expect(created.status).toBe(201);
    expect(retry.body).toMatchObject({ id: created.body.id, idempotent: true });
    const misuse = await createAssignment(actors.manager!.email, { title: "Different command input" }, operationId);
    expect(misuse.status).toBe(409);

    const assigned = await request(application()).post(`/api/assignments/${created.body.id}/assign`).set(as(actors.manager!.email)).send({
      sessionId: incidentA, expectedVersion: created.body.version, assignedUserId: actors["worker-a"]!.id, operationId: randomUUID(),
    });
    const started = await request(application()).post(`/api/assignments/${created.body.id}/start`).set(as(actors["worker-a"]!.email)).send({ sessionId: incidentA, expectedVersion: assigned.body.version });
    const escalated = await request(application()).post(`/api/assignments/${created.body.id}/escalate`).set(as(actors["worker-a"]!.email)).send({ sessionId: incidentA, expectedVersion: started.body.version, reason: "Needs coordinator context" });
    const resumed = await request(application()).post(`/api/assignments/${created.body.id}/resume`).set(as(actors["worker-a"]!.email)).send({ sessionId: incidentA, expectedVersion: escalated.body.version, reason: "Context supplied" });
    const completeOperation = randomUUID();
    const completionBody = { sessionId: incidentA, expectedVersion: resumed.body.version, operationId: completeOperation, completionNote: "Human operator verified completion" };
    const completed = await request(application()).post(`/api/assignments/${created.body.id}/complete`).set(as(actors["worker-a"]!.email)).send(completionBody);
    const completeRetry = await request(application()).post(`/api/assignments/${created.body.id}/complete`).set(as(actors["worker-a"]!.email)).send(completionBody);
    expect(completed.body).toMatchObject({ status: "Completed", completedById: actors["worker-a"]!.id, completionNote: "Human operator verified completion" });
    expect(completeRetry.body).toMatchObject({ id: created.body.id, version: completed.body.version, idempotent: true });
    const restored = await request(application()).get(`/api/assignments/${created.body.id}`).query({ sessionId: incidentA }).set(as(actors.reader!.email));
    expect(restored.body).toMatchObject({ status: "Completed", version: completed.body.version });
    const compatibility = await request(application()).get("/api/assignments").query({ sessionId: incidentA, search: created.body.operationalId }).set(as(actors.reader!.email));
    expect(compatibility.body).toMatchObject({ deprecated: true, readOnly: true, data: [{ id: created.body.id, status: "Completed" }] });
    expect(await prisma!.auditLog.count({ where: { entityId: created.body.id } })).toBe(6);
    expect(await prisma!.caseTimelineEvent.count({ where: { entityId: created.body.id } })).toBe(6);
  });

  it("allows exactly one concurrent claim and one assign-vs-claim winner", async () => {
    const first = await createAssignment();
    const claim = (email: string) => request(application()).post(`/api/assignments/${first.body.id}/claim`).set(as(email)).send({ sessionId: incidentA, expectedVersion: first.body.version, operationId: randomUUID() });
    const claims = await Promise.all([claim(actors["worker-a"]!.email), claim(actors["worker-b"]!.email)]);
    expect(claims.map(({ status }) => status).sort()).toEqual([200, 409]);
    const stored = await prisma!.assignmentTask.findUniqueOrThrow({ where: { id: first.body.id } });
    expect([actors["worker-a"]!.id, actors["worker-b"]!.id]).toContain(stored.assignedUserId);
    expect(stored.version).toBe(2);

    const second = await createAssignment();
    const [assigned, claimed] = await Promise.all([
      request(application()).post(`/api/assignments/${second.body.id}/assign`).set(as(actors.manager!.email)).send({ sessionId: incidentA, expectedVersion: second.body.version, assignedUserId: actors["worker-a"]!.id, operationId: randomUUID() }),
      request(application()).post(`/api/assignments/${second.body.id}/claim`).set(as(actors["worker-b"]!.email)).send({ sessionId: incidentA, expectedVersion: second.body.version, operationId: randomUUID() }),
    ]);
    expect([assigned.status, claimed.status].sort()).toEqual([200, 409]);
    expect((await prisma!.assignmentTask.findUniqueOrThrow({ where: { id: second.body.id } })).version).toBe(2);

    const retryTask = await createAssignment();
    const retryOperation = randomUUID();
    const retryBody = { sessionId: incidentA, expectedVersion: retryTask.body.version, operationId: retryOperation };
    const claimedOnce = await request(application()).post(`/api/assignments/${retryTask.body.id}/claim`).set(as(actors["worker-b"]!.email)).send(retryBody);
    const claimedRetry = await request(application()).post(`/api/assignments/${retryTask.body.id}/claim`).set(as(actors["worker-b"]!.email)).send(retryBody);
    expect(claimedOnce.status).toBe(200);
    expect(claimedRetry.body).toMatchObject({ id: retryTask.body.id, version: claimedOnce.body.version, idempotent: true });
    expect(await prisma!.auditLog.count({ where: { entityId: retryTask.body.id, action: "claim_assignment" } })).toBe(1);
  });

  it("allows exactly one concurrent complete-vs-cancel terminal decision", async () => {
    const created = await createAssignment();
    const assigned = await request(application()).post(`/api/assignments/${created.body.id}/assign`).set(as(actors.manager!.email)).send({ sessionId: incidentA, expectedVersion: created.body.version, assignedUserId: actors["worker-a"]!.id, operationId: randomUUID() });
    const started = await request(application()).post(`/api/assignments/${created.body.id}/start`).set(as(actors["worker-a"]!.email)).send({ sessionId: incidentA, expectedVersion: assigned.body.version });
    const [completed, cancelled] = await Promise.all([
      request(application()).post(`/api/assignments/${created.body.id}/complete`).set(as(actors["worker-a"]!.email)).send({ sessionId: incidentA, expectedVersion: started.body.version, operationId: randomUUID(), completionNote: "Work completed" }),
      request(application()).post(`/api/assignments/${created.body.id}/cancel`).set(as(actors.manager!.email)).send({ sessionId: incidentA, expectedVersion: started.body.version, operationId: randomUUID(), reason: "Operational cancellation" }),
    ]);
    expect([completed.status, cancelled.status].sort()).toEqual([200, 409]);
    expect(["Completed", "Cancelled"]).toContain((await prisma!.assignmentTask.findUniqueOrThrow({ where: { id: created.body.id } })).status);

    const cancelTask = await createAssignment();
    const cancelOperation = randomUUID();
    const cancelBody = { sessionId: incidentA, expectedVersion: cancelTask.body.version, operationId: cancelOperation, reason: "Created in error" };
    const cancelledOnce = await request(application()).post(`/api/assignments/${cancelTask.body.id}/cancel`).set(as(actors.manager!.email)).send(cancelBody);
    const cancelledRetry = await request(application()).post(`/api/assignments/${cancelTask.body.id}/cancel`).set(as(actors.manager!.email)).send(cancelBody);
    expect(cancelledOnce.status).toBe(200);
    expect(cancelledRetry.body).toMatchObject({ id: cancelTask.body.id, version: cancelledOnce.body.version, idempotent: true });
    expect(await prisma!.auditLog.count({ where: { entityId: cancelTask.body.id, action: "cancelled_assignment" } })).toBe(1);
  });

  it("preserves revoked assignee history, excludes ineligible candidates and requires reassignment", async () => {
    const independentRequest = await prisma!.request.create({ data: {
      operationalId: `${marker}-REQ-INDEPENDENT`, incidentId: incidentA, category: "Transport", priority: "Normal",
      details: "Ownership must remain independent", status: "ASSIGNED", ownerUserId: actors["worker-a"]!.id,
      createdById: actors.manager!.id, updatedById: actors.manager!.id,
    } });
    const created = await createAssignment();
    const noPermissionOwner = await request(application()).post(`/api/assignments/${created.body.id}/assign`).set(as(actors.manager!.email)).send({ sessionId: incidentA, expectedVersion: created.body.version, assignedUserId: actors["no-reader"]!.id, operationId: randomUUID() });
    expect(noPermissionOwner.status).toBe(409);
    expect((await request(application()).get("/api/assignments/queue").query({ sessionId: incidentA }).set(as(actors["no-reader"]!.email))).status).toBe(403);
    const assigned = await request(application()).post(`/api/assignments/${created.body.id}/assign`).set(as(actors.manager!.email)).send({ sessionId: incidentA, expectedVersion: created.body.version, assignedUserId: actors["worker-a"]!.id, operationId: randomUUID() });
    await prisma!.incidentAssignment.update({ where: { id: actors["worker-a"]!.assignmentIds[0]! }, data: { active: false, revokedAt: new Date(), revokeReason: "Shift ended" } });
    const context = await request(application()).get(`/api/assignments/${created.body.id}`).query({ sessionId: incidentA }).set(as(actors.manager!.email));
    expect(context.body).toMatchObject({ assignedUserId: actors["worker-a"]!.id, assigneeEligible: false });
    expect(context.body.assigneeEligibilityMessage).toContain("Reassignment is required");
    expect((await request(application()).get(`/api/assignments/${created.body.id}`).query({ sessionId: incidentA }).set(as(actors["worker-a"]!.email))).status).toBe(404);
    const candidates = await request(application()).get("/api/assignments/assignees").query({ sessionId: incidentA }).set(as(actors.manager!.email));
    expect(candidates.body.data.map(({ id }: { id: string }) => id)).not.toEqual(expect.arrayContaining([actors["worker-a"]!.id, actors["inactive-candidate"]!.id]));
    const reassigned = await request(application()).post(`/api/assignments/${created.body.id}/reassign`).set(as(actors.manager!.email)).send({ sessionId: incidentA, expectedVersion: assigned.body.version, assignedUserId: actors["worker-b"]!.id, operationId: randomUUID(), reason: "Revoked operator handover" });
    expect(reassigned.body).toMatchObject({ assignedUserId: actors["worker-b"]!.id, assigneeEligible: true });
    expect((await prisma!.request.findUniqueOrThrow({ where: { id: independentRequest.id } })).ownerUserId).toBe(actors["worker-a"]!.id);
  });

  it("isolates incidents and modes, hides revoked access and makes closed incidents read-only", async () => {
    const created = await createAssignment();
    expect((await request(application()).patch(`/api/assignments/${created.body.id}`).set(as(actors.manager!.email)).send({ sessionId: incidentA, expectedVersion: created.body.version, assignedUserId: actors.reader!.id, status: "Completed" })).status).toBe(400);
    expect((await request(application()).post(`/api/assignments/${created.body.id}/status`).set(as(actors.manager!.email)).send({ sessionId: incidentA, expectedVersion: created.body.version, status: "Completed" })).status).toBe(404);
    expect((await request(application()).get(`/api/assignments/${created.body.id}`).query({ sessionId: incidentB }).set(as(actors.manager!.email))).status).toBe(404);
    expect((await request(application()).patch(`/api/assignments/${created.body.id}`).set(as(actors.manager!.email)).send({ sessionId: incidentB, expectedVersion: created.body.version, title: "Cross-mode overwrite" })).status).toBe(404);
    const closedCreated = await prisma!.assignmentTask.create({ data: { operationalId: `${marker}-CLOSED-ASN`, sessionId: closedIncident, title: "Closed history", status: "Open", priority: "Normal", createdById: actors.manager!.id, updatedById: actors.manager!.id } });
    expect((await request(application()).get(`/api/assignments/${closedCreated.id}`).query({ sessionId: closedIncident }).set(as(actors.manager!.email))).status).toBe(200);
    expect((await request(application()).patch(`/api/assignments/${closedCreated.id}`).set(as(actors.manager!.email)).send({ sessionId: closedIncident, expectedVersion: 1, title: "Forbidden closed write" })).status).toBe(409);
  });

  it("keeps a committed assignment when best-effort notification delivery fails", async () => {
    const response = await request(application(() => { throw new Error("simulated notification outage"); }))
      .post("/api/assignments")
      .set(as(actors.manager!.email))
      .send({ sessionId: incidentA, title: `Notification boundary ${marker}`, priority: "Normal", operationId: randomUUID() });
    expect(response.status).toBe(201);
    expect(await prisma!.assignmentTask.count({ where: { id: response.body.id } })).toBe(1);
    expect(await prisma!.auditLog.count({ where: { entityId: response.body.id, action: "create_assignment" } })).toBe(1);
    expect(await prisma!.caseTimelineEvent.count({ where: { entityId: response.body.id } })).toBe(1);
  });

  it("rejects concurrent stale reassignments without losing the winning handover", async () => {
    const created = await createAssignment();
    const assigned = await request(application()).post(`/api/assignments/${created.body.id}/assign`).set(as(actors.manager!.email)).send({ sessionId: incidentA, expectedVersion: created.body.version, assignedUserId: actors["worker-b"]!.id, operationId: randomUUID() });
    const [toManager, toReader] = await Promise.all([
      request(application()).post(`/api/assignments/${created.body.id}/reassign`).set(as(actors.manager!.email)).send({ sessionId: incidentA, expectedVersion: assigned.body.version, assignedUserId: actors.manager!.id, reason: "Manager handover", operationId: randomUUID() }),
      request(application()).post(`/api/assignments/${created.body.id}/reassign`).set(as(actors.manager!.email)).send({ sessionId: incidentA, expectedVersion: assigned.body.version, assignedUserId: actors.reader!.id, reason: "Reader handover", operationId: randomUUID() }),
    ]);
    expect([toManager.status, toReader.status].sort()).toEqual([200, 409]);
    const stored = await prisma!.assignmentTask.findUniqueOrThrow({ where: { id: created.body.id } });
    expect([actors.manager!.id, actors.reader!.id]).toContain(stored.assignedUserId);
    expect(stored.version).toBe(3);
  });

  it("serves a filtered and paged 1000-row queue without fetch-all semantics", async () => {
    const scalePrefix = `${marker}-SCALE`;
    await prisma!.assignmentTask.createMany({ data: Array.from({ length: 1000 }, (_, index) => ({
      operationalId: `${scalePrefix}-${String(index).padStart(4, "0")}`,
      sessionId: incidentA,
      title: index % 10 === 0 ? `Search needle ${index}` : `Scale assignment ${index}`,
      status: index % 3 === 0 ? "Escalated" : "Open",
      priority: index % 5 === 0 ? "Critical" : "Normal",
      relatedFunction: index % 2 === 0 ? "Welfare Support" : "Documentation",
      assignedUserId: index % 10 === 1 ? actors["worker-b"]!.id : null,
      dueAt: index % 20 === 0 ? new Date("2020-01-01T00:00:00.000Z") : null,
      createdById: actors.manager!.id,
      updatedById: actors.manager!.id,
    })) });
    const page = await request(application()).get("/api/assignments/queue").query({ sessionId: incidentA, search: "Search needle", priority: "Critical", relatedFunction: "Welfare Support", limit: 25, offset: 25, sortBy: "operationalId", sortDirection: "asc" }).set(as(actors.reader!.email));
    expect(page.status).toBe(200);
    expect(page.body.total).toBe(100);
    expect(page.body.data).toHaveLength(25);
    expect(page.body.data.every((row: { title: string; priority: string; relatedFunction: string }) => row.title.includes("Search needle") && row.priority === "Critical" && row.relatedFunction === "Welfare Support")).toBe(true);
    expect(page.body.data[0].operationalId).toBe(`${scalePrefix}-0250`);
    const query = (values: Record<string, unknown>, email = actors.reader!.email) => request(application()).get("/api/assignments/queue").query({ sessionId: incidentA, search: scalePrefix, limit: 1, offset: 0, ...values }).set(as(email));
    expect((await query({ status: "Escalated" })).body.total).toBe(334);
    expect((await query({ assignedUserId: actors["worker-b"]!.id })).body.total).toBe(100);
    expect((await query({ unassigned: true })).body.total).toBe(900);
    expect((await query({ mine: true }, actors["worker-b"]!.email)).body.total).toBe(100);
    expect((await query({ due: "overdue" })).body.total).toBe(50);
  });
});
