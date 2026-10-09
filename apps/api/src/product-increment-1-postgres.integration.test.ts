import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSharedApp } from "./test-support/listening-test-app.js";
import { prisma as runtimeDb } from "./prisma.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const pgDescribe = databaseUrl ? describe : describe.skip;
const db = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;
const as = (email: string) => ({ "x-user-email": email });
const personas = ["coordinator@lot.pl", "tec@lot.pl", "zpp@lot.pl", "volunteer@lot.pl", "viewer@lot.pl", "admin@lot.pl"];

pgDescribe("PI1 production PostgreSQL operational trust", () => {
  const marker = `PI1-${randomUUID().slice(0, 8)}`;
  let activeId: string, emptyId: string, capableId: string, incapableId: string, urgentId: string, taskId: string;
  let ownerRoleId: string, ownerMembershipId: string, noContextId: string, noContextRoleId: string;
  const app = () => createSharedApp();
  const dashboard = (email: string, incidentId = activeId) => request(app()).get("/api/dashboard").set(as(email)).query({ sessionId: incidentId });

  beforeAll(async () => {
    expect(app().locals.productionComposition).toBe("postgres-explicit");
    activeId = (await db!.session.findUniqueOrThrow({ where: { operationalId: "SES-2026-001" } })).id;
    const admin = await db!.user.findUniqueOrThrow({ where: { email: "admin@lot.pl" } });
    const member = await db!.user.findUniqueOrThrow({ where: { email: "volunteer@lot.pl" } });
    incapableId = (await db!.user.findUniqueOrThrow({ where: { email: "zpp@lot.pl" } })).id;
    emptyId = (await db!.session.create({ data: { operationalId: marker, mode: "REAL", status: "Draft", eventType: "PI1 acceptance" } })).id;
    for (const email of ["coordinator@lot.pl", "viewer@lot.pl"]) {
      const user = await db!.user.findUniqueOrThrow({ where: { email } });
      await db!.incidentAssignment.create({ data: { incidentId: emptyId, userId: user.id, function: marker, createdById: admin.id } });
    }
    const role = await db!.role.create({ data: { name: marker.toLowerCase(), displayName: marker, permissions: ["session:read", "request:read", "request:update", "request:close"] } });
    ownerRoleId = role.id;
    capableId = (await db!.user.create({ data: { email: `${marker.toLowerCase()}@example.test`, displayName: marker, roles: { create: { roleId: role.id, assignedBy: "PI1 acceptance" } } } })).id;
    const noContextRole = await db!.role.create({ data: { name: `${marker.toLowerCase()}-no-context`, displayName: `${marker} no context`, permissions: ["request:read", "request:update", "request:close"] } });
    noContextRoleId = noContextRole.id;
    noContextId = (await db!.user.create({ data: { email: `${marker.toLowerCase()}-no-context@example.test`, displayName: "No incident context access", roles: { create: { roleId: noContextRole.id, assignedBy: "PI1 acceptance" } } } })).id;
    await db!.incidentAssignment.create({ data: { incidentId: activeId, userId: noContextId, function: marker, createdById: admin.id } });
    ownerMembershipId = (await db!.incidentAssignment.create({ data: { incidentId: activeId, userId: capableId, function: marker, createdById: admin.id } })).id;
    urgentId = (await db!.request.create({ data: { operationalId: `${marker}-URGENT`, incidentId: activeId, category: "Transport", priority: "Urgent", details: "PI1 permitted urgent support risk", createdById: admin.id } })).id;
    taskId = (await db!.assignmentTask.create({ data: { operationalId: `${marker}-TASK`, sessionId: activeId, title: "PI1 overdue personal task", assignedUserId: member.id, dueAt: new Date("2000-01-01T00:00:00Z") } })).id;
  });
  afterAll(async () => {
    if (!db) return;
    vi.restoreAllMocks();
    if (!urgentId || !taskId || !capableId || !emptyId) { await db.$disconnect(); return; }
    await db.permissionOverride.deleteMany({ where: { userId: capableId } });
    await db.request.deleteMany({ where: { id: urgentId } });
    await db.assignmentTask.deleteMany({ where: { id: taskId } });
    await db.caseTimelineEvent.deleteMany({ where: { entityId: urgentId } });
    await db.auditLog.deleteMany({ where: { entityId: urgentId } });
    await db.incidentAssignment.deleteMany({ where: { OR: [{ incidentId: emptyId }, { userId: capableId }] } });
    await db.userRole.deleteMany({ where: { userId: capableId } });
    await db.user.deleteMany({ where: { id: capableId } });
    await db.role.deleteMany({ where: { id: ownerRoleId } });
    await db.session.deleteMany({ where: { id: emptyId } });
    if (noContextId) {
      await db.incidentAssignment.deleteMany({ where: { userId: noContextId } });
      await db.userRole.deleteMany({ where: { userId: noContextId } });
      await db.user.delete({ where: { id: noContextId } });
      await db.role.delete({ where: { id: noContextRoleId } });
    }
    await db.$disconnect();
  });

  it("exposes actual coordinator zero and observer unavailable as different contracts", async () => {
    const available = await dashboard("coordinator@lot.pl", emptyId);
    expect(available.status, JSON.stringify(available.body)).toBe(200);
    expect(available.body.operationalStatus.specialist).toMatchObject({ status: "available", value: { manifestCoverage: { inDatabaseTotal: 0, expectedTotal: 0 }, matchingProgress: { totalPax: 0 } } });
    const unavailable = await dashboard("viewer@lot.pl", emptyId);
    expect(unavailable.status).toBe(200);
    expect(unavailable.body.operationalStatus.specialist).toEqual({ status: "unavailable" });
    expect(unavailable.body.operationalStatus.attention).toEqual({ status: "unavailable" });
    expect(unavailable.body.operationalStatus.specialist.value).toBeUndefined();
  });
  it.each(personas)("preserves persona scope and admin boundary for %s", async email => {
    const result = await dashboard(email);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const privileged = ["coordinator@lot.pl", "admin@lot.pl"].includes(email);
    expect(result.body.operationalStatus.specialist.status).toBe(privileged ? "available" : "unavailable");
    const admin = await request(app()).get("/api/admin/users").set(as(email));
    expect(admin.status).toBe(email === "admin@lot.pl" ? 200 : 403);
    const requests = await request(app()).get("/api/requests/queue").set(as(email)).query({ sessionId: activeId });
    expect(requests.status).toBe(["zpp@lot.pl", "volunteer@lot.pl", "viewer@lot.pl"].includes(email) ? 403 : 200);
  });
  it("represents TEC urgent support work and member current obligations without notifications", async () => {
    const tec = await dashboard("tec@lot.pl");
    expect(tec.body.operationalStatus.attention).toMatchObject({ status: "available", value: { items: expect.arrayContaining([expect.objectContaining({ key: `request:${urgentId}` })]) } });
    const member = await dashboard("volunteer@lot.pl");
    expect(member.body.operationalStatus.attention.value.items).toEqual(expect.arrayContaining([expect.objectContaining({ key: `assignment:${taskId}` }), expect.objectContaining({ key: expect.stringMatching(/^document:/) })]));
    expect(member.body.operationalStatus.attention.value.items.some((item: { key: string }) => item.key.startsWith("request:"))).toBe(false);
  });
  it("rejects incapable candidates and direct writes; accepts an owner without assignment/admin capability", async () => {
    const membershipReads = vi.spyOn(runtimeDb.incidentAssignment, "count");
    const graphBatches = vi.spyOn(runtimeDb.user, "findMany");
    const candidates = await request(app()).get("/api/requests/assignees").set(as("coordinator@lot.pl")).query({ sessionId: activeId });
    expect(membershipReads).not.toHaveBeenCalled();
    expect(graphBatches).toHaveBeenCalledTimes(1);
    membershipReads.mockRestore(); graphBatches.mockRestore();
    expect(candidates.status).toBe(200);
    expect(candidates.body.data.map((item: { id: string }) => item.id)).toContain(capableId);
    expect(candidates.body.data.map((item: { id: string }) => item.id)).not.toContain(incapableId);
    expect(candidates.body.data.map((item: { id: string }) => item.id)).not.toContain(noContextId);
    const noContextWrite = await request(app()).post(`/api/requests/${urgentId}/assign`).set(as("coordinator@lot.pl")).send({ sessionId: activeId, expectedVersion: 1, ownerUserId: noContextId });
    expect(noContextWrite.status).toBe(409);
    const rejected = await request(app()).post(`/api/requests/${urgentId}/assign`).set(as("coordinator@lot.pl")).send({ sessionId: activeId, expectedVersion: 1, ownerUserId: incapableId });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error).toMatch(/access the incident, read, progress and resolve/);
    expect((await request(app()).get("/api/requests/queue").set(as("zpp@lot.pl")).query({ sessionId: activeId })).status).toBe(403);
    const accepted = await request(app()).post(`/api/requests/${urgentId}/assign`).set(as("coordinator@lot.pl")).send({ sessionId: activeId, expectedVersion: 1, ownerUserId: capableId });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body).toMatchObject({ ownerUserId: capableId, ownerEligibility: "eligible", reassignmentRequired: false });
    const owner = await db!.user.findUniqueOrThrow({ where: { id: capableId } });
    const started = await request(app()).post(`/api/requests/${urgentId}/start`).set(as(owner.email)).send({ sessionId: activeId, expectedVersion: accepted.body.version });
    expect(started.status).toBe(200);
    expect(await db!.permissionOverride.count({ where: { userId: incapableId, effect: "GRANT" } })).toBe(0);
  });
  it("qualifies permission, incident and account revocation without changing owner/history or granting access", async () => {
    const before = await db!.request.findUniqueOrThrow({ where: { id: urgentId } });
    const history = await db!.auditLog.findMany({ where: { entityId: urgentId }, orderBy: { id: "asc" } });
    const override = await db!.permissionOverride.create({ data: { userId: capableId, permission: "request:close", effect: "DENY", reason: "PI1 test deny", createdById: incapableId } });
    const read = () => request(app()).get(`/api/requests/${urgentId}`).set(as("coordinator@lot.pl")).query({ sessionId: activeId });
    expect((await read()).body).toMatchObject({ ownerUserId: capableId, ownerEligibility: "ineligible", reassignmentRequired: true, version: before.version });
    const stale = await request(app()).post(`/api/requests/${urgentId}/assign`).set(as("coordinator@lot.pl")).send({ sessionId: activeId, expectedVersion: before.version, ownerUserId: capableId });
    expect(stale.status).toBe(409);
    await db!.permissionOverride.delete({ where: { id: override.id } });
    await db!.incidentAssignment.update({ where: { id: ownerMembershipId }, data: { active: false } });
    expect((await read()).body.reassignmentRequired).toBe(true);
    await db!.incidentAssignment.update({ where: { id: ownerMembershipId }, data: { active: true } });
    await db!.user.update({ where: { id: capableId }, data: { status: "Suspended" } });
    expect((await read()).body.reassignmentRequired).toBe(true);
    await db!.user.update({ where: { id: capableId }, data: { status: "Active" } });
    expect((await read()).body.reassignmentRequired).toBe(false);
    expect(await db!.request.findUniqueOrThrow({ where: { id: urgentId } })).toEqual(before);
    expect(await db!.auditLog.findMany({ where: { entityId: urgentId }, orderBy: { id: "asc" } })).toEqual(history);
    expect(await db!.permissionOverride.count({ where: { userId: capableId, effect: "GRANT" } })).toBe(0);
  });
  it("keeps legacy active ownership qualified and terminal ownership historical", async () => {
    await db!.request.update({ where: { id: urgentId }, data: { ownerUserId: null, legacyOwnerLabel: "Legacy support lead" } });
    const read = () => request(app()).get(`/api/requests/${urgentId}`).set(as("coordinator@lot.pl")).query({ sessionId: activeId });
    expect((await read()).body).toMatchObject({ ownerAssignedTo: "Legacy support lead", ownerEligibility: "legacy", reassignmentRequired: true });
    const cancelled = await request(app()).post(`/api/requests/${urgentId}/cancel`).set(as("coordinator@lot.pl")).send({ sessionId: activeId, expectedVersion: (await read()).body.version, reason: "PI1 historical ownership acceptance", operationId: randomUUID() });
    expect(cancelled.status).toBe(200);
    expect((await read()).body).toMatchObject({ ownerEligibility: "historical", reassignmentRequired: false });
  });
  it("fails a genuine aggregate query without zero fallback and recovers on retry", async () => {
    const failure = vi.spyOn(runtimeDb.passengerRecord, "findMany").mockRejectedValueOnce(new Error("PI1 injected database aggregate failure"));
    try {
      const failed = await dashboard("coordinator@lot.pl");
      expect(failed.status).toBe(500);
      expect(failed.body.operationalStatus).toBeUndefined();
    } finally { failure.mockRestore(); }
    expect((await dashboard("coordinator@lot.pl")).status).toBe(200);
  });
  it("rejects missing/nonexistent incident and keeps technical readiness", async () => {
    expect((await dashboard("coordinator@lot.pl", randomUUID())).status).toBe(403);
    expect((await request(app()).get("/api/dashboard").set(as("viewer@lot.pl")).query({ sessionId: "" })).status).toBe(400);
    expect((await request(app()).get("/api/health/readiness")).body).toMatchObject({ ready: true, database: "reachable" });
    expect((await request(app()).get("/api/readiness/summary").set(as("admin@lot.pl"))).status).toBe(404);
  });
});
