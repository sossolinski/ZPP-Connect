import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertIncidentWorkspace, type IncidentWorkspace } from "@zpp/shared";
import { createSharedApp } from "./test-support/listening-test-app.js";
import { prisma as runtimeDb } from "./prisma.js";
import { readIncidentWorkspace } from "./modules/workspace/incident-workspace-reader.js";

const url = process.env.TEST_DATABASE_URL;
const db = url ? new PrismaClient({ datasources: { db: { url } } }) : null;
const pg = url ? describe : describe.skip;
pg("PI2 production PostgreSQL Incident Workspace", () => {
  const mark = `PI2-${randomUUID().slice(0, 8)}`, epoch = new Date("2030-01-01T12:00:00Z");
  let incidentId: string, otherIncidentId: string, groupId: string, betaId: string, roleId: string, outsiderId: string, adminOnlyId: string;
  const users: Record<string, string> = {};
  const taskIds: Record<string, string> = {};
  const get = (email: string, sessionId = incidentId) => request(createSharedApp()).get("/api/dashboard").set("x-user-email", email).query({ sessionId });
  const workspace = async (email: string): Promise<IncidentWorkspace> => {
    const response = await get(email); expect(response.status).toBe(200); assertIncidentWorkspace(response.body.workspace); return response.body.workspace;
  };
  beforeAll(async () => {
    expect(createSharedApp().locals.productionComposition).toBe("postgres-explicit");
    incidentId = (await db!.session.findUniqueOrThrow({ where: { operationalId: "SES-2026-001" } })).id;
    for (const email of ["coordinator@lot.pl", "tec@lot.pl", "zpp@lot.pl", "volunteer@lot.pl", "viewer@lot.pl", "admin@lot.pl"]) users[email] = (await db!.user.findUniqueOrThrow({ where: { email } })).id;
    groupId = (await db!.groupRoleAssignment.findFirstOrThrow({ where: { userId: users["zpp@lot.pl"], status: "Active", group: { incidentId } } })).groupId;
    const alphaMember = await db!.memberProfile.findUniqueOrThrow({ where: { linkedUserId: users["volunteer@lot.pl"] } });
    await db!.groupMembership.create({ data: { id: `${mark}-alpha-membership`, groupId, memberProfileId: alphaMember.id } });
    betaId = `${mark}-beta`;
    await db!.operationalGroup.create({ data: { id: betaId, operationalId: `${mark}-BETA`, incidentId, name: `${mark} outside group`, pool: "ZPP", functionName: "Logistics" } });
    roleId = (await db!.role.create({ data: { name: mark.toLowerCase(), displayName: mark, permissions: ["session:read", "assignment:read"] } })).id;
    outsiderId = (await db!.user.create({ data: { email: `${mark.toLowerCase()}@example.test`, displayName: `${mark} outside operator`, roles: { create: { roleId, assignedBy: "PI2 test" } } } })).id;
    await db!.incidentAssignment.create({ data: { incidentId, userId: outsiderId, function: "Logistics", createdById: users["coordinator@lot.pl"] } });
    await db!.memberProfile.create({ data: { id: `${mark}-member`, memberId: `${mark}-MEMBER`, linkedUserId: outsiderId, firstName: "Outside", lastName: "Operator", pool: "ZPP", role: "Member", assignedFunction: "Logistics", languages: [], memberships: { create: { id: `${mark}-membership`, groupId: betaId } } } });
    const adminRole = await db!.role.findUniqueOrThrow({ where: { normalizedName: "system-admin" } });
    adminOnlyId = (await db!.user.create({ data: { email: `${mark.toLowerCase()}-admin@example.test`, displayName: "Admin only", roles: { create: { roleId: adminRole.id, assignedBy: "PI2 test" } } } })).id;
    for (const email of ["coordinator@lot.pl", "tec@lot.pl", "zpp@lot.pl", "volunteer@lot.pl"]) taskIds[email] = (await db!.assignmentTask.create({ data: { operationalId: `${mark}-${email.split("@")[0]}`, sessionId: incidentId, title: `${mark} ${email} personal task`, assignedUserId: users[email], priority: "Urgent", status: "Escalated", dueAt: new Date("2000-01-01T00:00:00Z") } })).id;
    taskIds.outside = (await db!.assignmentTask.create({ data: { operationalId: `${mark}-OUTSIDE`, sessionId: incidentId, title: `${mark} outside task`, assignedUserId: outsiderId, dueAt: new Date("1999-01-01T00:00:00Z") } })).id;
    taskIds.unassigned = (await db!.assignmentTask.create({ data: { operationalId: `${mark}-UNASSIGNED`, sessionId: incidentId, title: `${mark} unassigned task`, dueAt: new Date("1998-01-01T00:00:00Z") } })).id;
    await db!.request.create({ data: { operationalId: `${mark}-REQUEST`, incidentId, category: "Transport", details: "Owned support work", ownerUserId: users["coordinator@lot.pl"], status: "WAITING", priority: "Urgent", dueAt: new Date("1997-01-01T00:00:00Z") } });
    otherIncidentId = (await db!.session.create({ data: { operationalId: `${mark}-OTHER`, mode: "REAL", status: "Draft", eventType: "Private other incident" } })).id;
    await db!.assignmentTask.create({ data: { operationalId: `${mark}-CROSS`, sessionId: otherIncidentId, title: "Other incident secret", assignedUserId: users["coordinator@lot.pl"] } });
    for (const [key, status, startAt, endAt, group, person] of [
      ["CONFIRMED", "Confirmed", new Date(epoch.getTime() - 1), new Date(epoch.getTime() + 1), groupId, true],
      ["PUBLISHED", "Published", epoch, new Date(epoch.getTime() + 1), groupId, true],
      ["UNFILLED", "Published", epoch, new Date(epoch.getTime() + 1), groupId, false],
      ["ENDED", "Confirmed", new Date(epoch.getTime() - 1), epoch, groupId, true],
      ["FUTURE", "Confirmed", new Date(epoch.getTime() + 1), new Date(epoch.getTime() + 2), groupId, true],
      ["DRAFT", "Draft", epoch, new Date(epoch.getTime() + 1), groupId, true],
      ["DECLINED", "Declined", epoch, new Date(epoch.getTime() + 1), groupId, true],
      ["BETA", "Confirmed", epoch, new Date(epoch.getTime() + 1), betaId, true],
    ] as const) await db!.rosterShift.create({ data: { id: `${mark}-${key}`, operationalId: `${mark}-ROS-${key}`, sessionId: incidentId, groupId: group, assignedMemberProfileId: person ? group === groupId ? alphaMember.id : `${mark}-member` : null, title: key, duty: "Support", functionName: key, location: "Synthetic desk", status, startAt, endAt } });
    await db!.caseTimelineEvent.create({ data: { sessionId: incidentId, eventType: "note", title: `${mark} handover note ${outsiderId}`, body: `Operational handover. s3://private/key ${"a".repeat(64)}`, createdById: users["coordinator@lot.pl"], metadata: { privateStorageKey: "DO-NOT-PROJECT" }, occurredAt: new Date("2000-01-01T00:00:00Z") } });
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    if (!db) return;
    await db.caseTimelineEvent.deleteMany({ where: { title: { startsWith: mark } } });
    await db.rosterShift.deleteMany({ where: { id: { startsWith: mark } } });
    await db.request.deleteMany({ where: { operationalId: { startsWith: mark } } });
    await db.assignmentTask.deleteMany({ where: { operationalId: { startsWith: mark } } });
    await db.groupMembership.deleteMany({ where: { id: { startsWith: mark } } });
    await db.memberProfile.deleteMany({ where: { id: { startsWith: mark } } });
    await db.incidentAssignment.deleteMany({ where: { userId: { in: [outsiderId, adminOnlyId].filter(Boolean) } } });
    await db.userRole.deleteMany({ where: { userId: { in: [outsiderId, adminOnlyId].filter(Boolean) } } });
    await db.user.deleteMany({ where: { id: { in: [outsiderId, adminOnlyId].filter(Boolean) } } });
    if (roleId) await db.role.delete({ where: { id: roleId } });
    if (betaId) await db.operationalGroup.delete({ where: { id: betaId } });
    if (otherIncidentId) await db.session.delete({ where: { id: otherIncidentId } });
    await db.$disconnect();
  });
  for (const email of ["coordinator@lot.pl", "tec@lot.pl", "zpp@lot.pl", "volunteer@lot.pl", "viewer@lot.pl", "admin@lot.pl"]) it(`projects authoritative incident and scoped workspace for ${email}`, async () => {
    const data = await workspace(email); expect(data.incident.operationalId).toBe("SES-2026-001"); expect(data.briefing.status).toBe("available");
    const full = ["coordinator@lot.pl", "admin@lot.pl"].includes(email);
    const response = await get(email); expect(response.body.operationalStatus.specialist.status).toBe(full ? "available" : "unavailable");
    if (email === "viewer@lot.pl") { expect(data.myTasks.status).toBe("unavailable"); expect(data.myRequests.status).toBe("unavailable"); expect(data.teamTasks.status).toBe("unavailable"); }
    else { expect(data.myTasks.status).toBe("available"); if (data.myTasks.status === "available") expect(data.myTasks.value.items.every(row => !row.title.includes("outside task"))).toBe(true); }
    if (email === "tec@lot.pl") expect(response.body.operationalStatus.attention.value.items.some((item: { key: string }) => item.key.startsWith("request:"))).toBe(true);
    if (email === "zpp@lot.pl") expect(data.myRequests.status).toBe("unavailable");
    expect((await request(createSharedApp()).get("/api/admin/users").set("x-user-email", email)).status).toBe(email === "admin@lot.pl" ? 200 : 403);
  });
  it("limits leader work to active group-member owners without attributing unassigned tasks", async () => {
    const data = await workspace("zpp@lot.pl"); expect(data.teamTasks.status).toBe("available");
    if (data.teamTasks.status !== "available") throw new Error("Missing scoped team");
    expect(data.teamTasks.value.items.some(row => row.id === taskIds["volunteer@lot.pl"])).toBe(true);
    expect(data.teamTasks.value.items.map(row => row.id)).not.toContain(taskIds.outside);
    expect(data.teamTasks.value.items.map(row => row.id)).not.toContain(taskIds.unassigned);
    const coord = await workspace("coordinator@lot.pl"); if (coord.teamTasks.status !== "available") throw new Error("Missing coordination");
    expect(coord.teamTasks.value.items.map(row => row.id)).toContain(taskIds.unassigned);
    if (coord.myRequests.status !== "available") throw new Error("Missing requests");
    expect(coord.myRequests.value.items.find(row => row.operationalId === `${mark}-REQUEST`)?.warning).toContain("Waiting");
  });
  it("uses exact current period and publication/confirmation states, with group scope", async () => {
    const leader = await readIncidentWorkspace(db!, incidentId, users["zpp@lot.pl"]!, epoch);
    if (leader.coverage.status !== "available") throw new Error("Missing coverage");
    const rows = leader.coverage.value.items.filter(row => row.id.startsWith(mark));
    expect(rows.map(row => row.title).sort()).toEqual(["CONFIRMED", "PUBLISHED", "UNFILLED"]);
    expect(rows.find(row => row.title === "CONFIRMED")?.state).toBe("Confirmed coverage");
    expect(rows.find(row => row.title === "PUBLISHED")?.state).toBe("Awaiting confirmation");
    expect(rows.find(row => row.title === "UNFILLED")?.state).toBe("Unfilled duty");
    const coord = await readIncidentWorkspace(db!, incidentId, users["coordinator@lot.pl"]!, epoch);
    if (coord.coverage.status !== "available") throw new Error("Missing coverage"); expect(coord.coverage.value.items.map(row => row.title)).toContain("BETA");
  });
  it("keeps system administration alone separate from operational capabilities", async () => {
    const data = await workspace(`${mark.toLowerCase()}-admin@example.test`);
    for (const key of ["briefing", "myTasks", "myRequests", "teamTasks", "teamRequests", "coverage", "activity"] as const) expect(data[key]).toEqual({ status: "unavailable" });
  });
  it("exposes measured empty own work while preserving unavailable team scope", async () => {
    const data = await workspace(`${mark.toLowerCase()}@example.test`); expect(data.myTasks.status).toBe("available"); expect(data.teamTasks.status).toBe("unavailable");
    await db!.assignmentTask.update({ where: { id: taskIds.outside }, data: { status: "Completed", completedAt: new Date(), completionNote: "Fixture complete", completedById: users["coordinator@lot.pl"] } });
    const empty = await workspace(`${mark.toLowerCase()}@example.test`); expect(empty.myTasks).toMatchObject({ status: "available", value: { total: 0, items: [] } });
  });
  it("never leaks another incident and treats missing context as an error", async () => {
    const data = await workspace("coordinator@lot.pl"); expect(JSON.stringify(data)).not.toContain("Other incident secret"); expect([403, 404]).toContain((await get("coordinator@lot.pl", otherIncidentId)).status);
    expect([403, 404]).toContain((await get("coordinator@lot.pl", randomUUID())).status);
  });
  it("shows only published authority, never the newer draft, and represents no publication explicitly", async () => {
    const incident = await db!.session.create({ data: { operationalId: `${mark}-BRIEFING`, mode: "REAL", status: "Draft", eventType: "Briefing acceptance" } });
    await db!.incidentAssignment.create({ data: { incidentId: incident.id, userId: users["coordinator@lot.pl"]!, function: "Coordination", createdById: users["coordinator@lot.pl"]! } });
    try {
      expect((await get("coordinator@lot.pl", incident.id)).body.workspace.briefing).toEqual({ status: "available", value: null });
      for (const [status, title, revision] of [["Published", "Authoritative published situation", 1], ["Draft", "DRAFT-SECRET", 2]] as const) await db!.operationalBriefing.create({ data: { id: `${mark}-${status}`, sessionId: incident.id, revision, status, title, situationSummary: title, publishedAt: status === "Published" ? new Date("2000-01-01T00:00:00Z") : null, publishedById: status === "Published" ? users["coordinator@lot.pl"]! : null, createdById: users["coordinator@lot.pl"]!, updatedById: users["coordinator@lot.pl"]! } });
      const response = await get("coordinator@lot.pl", incident.id); expect(response.status).toBe(200); expect(response.body.workspace.briefing.value.title).toBe("Authoritative published situation"); expect(JSON.stringify(response.body.workspace)).not.toContain("DRAFT-SECRET");
    } finally { await db!.operationalBriefing.deleteMany({ where: { sessionId: incident.id } }); await db!.incidentAssignment.deleteMany({ where: { incidentId: incident.id } }); await db!.session.delete({ where: { id: incident.id } }); }
  });
  it("filters denies on the server and does not broaden roles", async () => {
    const deny = await db!.permissionOverride.create({ data: { userId: users["zpp@lot.pl"]!, permission: "assignment:read", effect: "DENY", reason: "PI2 test", createdById: users["admin@lot.pl"]! } });
    try { const data = await workspace("zpp@lot.pl"); expect(data.myTasks.status).toBe("unavailable"); expect(data.teamTasks.status).toBe("unavailable"); } finally { await db!.permissionOverride.delete({ where: { id: deny.id } }); }
  });
  it("curates readable Timeline data with actor/source and excludes technical metadata", async () => {
    const data = await readIncidentWorkspace(db!, incidentId, users["coordinator@lot.pl"]!, new Date("2001-01-01T00:00:00Z"));
    if (data.activity.status !== "available") throw new Error("Missing activity");
    const item = data.activity.value.items.find(row => row.title.includes(mark)); expect(item?.actor).toBe("ZPP Coordinator"); expect(item?.href).toContain("/timeline?eventId=");
    expect(JSON.stringify(data.activity)).not.toContain(outsiderId); expect(JSON.stringify(data.activity)).not.toContain("DO-NOT-PROJECT"); expect(JSON.stringify(data.activity)).not.toContain("private/key"); expect(JSON.stringify(data.activity)).not.toContain("a".repeat(64));
  });
  it("fails an authoritative workspace read rather than presenting an empty success, then retries", async () => {
    const spy = vi.spyOn(runtimeDb.operationalBriefing, "findFirst").mockRejectedValueOnce(new Error("PI2 source unavailable"));
    try { const failed = await get("coordinator@lot.pl"); expect(failed.status).toBe(500); expect(failed.body).not.toHaveProperty("workspace"); } finally { spy.mockRestore(); }
    expect((await get("coordinator@lot.pl")).status).toBe(200);
  });
});
