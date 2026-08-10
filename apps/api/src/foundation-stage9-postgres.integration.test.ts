import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createPrismaIncidentAccessRepository } from "./modules/incident-access/prisma-incident-access-repository.js";
import { createPrismaMemberDirectoryRepository } from "./modules/member-directory/prisma-member-directory-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;
const prisma = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;
const as = (email: string) => ({ "x-user-email": email });

function application() {
  return createApp({
    memberDirectoryRepository: createPrismaMemberDirectoryRepository(prisma!),
    incidentAccessRepository: createPrismaIncidentAccessRepository(prisma!),
  });
}

postgresDescribe("Foundation Stage 9 PostgreSQL Member Profiles and Groups", () => {
  const marker = `F9-${Date.now()}`;
  const userIds: string[] = [];
  const roleIds: string[] = [];
  const incidentIds: string[] = [];
  const memberIds: string[] = [];
  const groupIds: string[] = [];
  const actors: Record<string, { id: string; email: string; roleId: string }> = {};
  let incidentA: string;
  let incidentB: string;
  let closedIncident: string;
  let adminId: string;
  let memberA: Record<string, any>;
  let memberB: Record<string, any>;
  let groupA: Record<string, any>;

  async function actor(key: string, permissions: string[], incidents: string[] = [incidentA]) {
    const role = await prisma!.role.create({ data: { name: `${marker.toLowerCase()}-${key}`, displayName: `${marker} ${key}`, permissions } });
    const user = await prisma!.user.create({
      data: { email: `${marker.toLowerCase()}-${key}@example.test`, displayName: `${marker} ${key}`, roles: { create: { roleId: role.id, assignedBy: "stage9-test" } } },
    });
    for (const incidentId of incidents) {
      await prisma!.incidentAssignment.create({ data: { incidentId, userId: user.id, function: "Stage 9 test", createdById: adminId } });
    }
    userIds.push(user.id);
    roleIds.push(role.id);
    actors[key] = { id: user.id, email: user.email, roleId: role.id };
    return user;
  }

  async function createMember(values: Record<string, unknown> = {}) {
    const response = await request(application()).post("/api/member-profiles").set(as(actors.manager!.email)).send({
      firstName: "Stage",
      lastName: `Member ${randomUUID().slice(0, 8)}`,
      pool: "ZPP",
      role: "Member",
      assignedFunction: "Stage 9 Test",
      languages: ["PL"],
      ...values,
    });
    if (response.status === 201) memberIds.push(response.body.id);
    return response;
  }

  async function createGroup(values: Record<string, unknown> = {}) {
    const response = await request(application()).post("/api/groups").set(as(actors.manager!.email)).send({
      sessionId: incidentA,
      name: `Stage 9 Group ${randomUUID().slice(0, 8)}`,
      pool: "ZPP",
      functionName: "Stage 9 Test",
      status: "Active",
      memberIds: [],
      ...values,
    });
    if (response.status === 201) groupIds.push(response.body.id);
    return response;
  }

  beforeAll(async () => {
    await prisma!.$connect();
    adminId = (await prisma!.user.findUniqueOrThrow({ where: { email: "admin@lot.pl" } })).id;
    const incidents = await Promise.all([
      prisma!.session.create({ data: { operationalId: `${marker}-A`, mode: "EXERCISE", status: "Active", eventType: marker, createdById: adminId } }),
      prisma!.session.create({ data: { operationalId: `${marker}-B`, mode: "REAL", status: "Draft", eventType: marker, createdById: adminId } }),
      prisma!.session.create({ data: { operationalId: `${marker}-CLOSED`, mode: "TRAINING", status: "Closed", eventType: marker, createdById: adminId } }),
    ]);
    incidentA = incidents[0]!.id;
    incidentB = incidents[1]!.id;
    closedIncident = incidents[2]!.id;
    incidentIds.push(incidentA, incidentB, closedIncident);
    const management = ["session:read", "member:read", "member:create", "member:update", "member:archive", "member:link-user", "group:read", "group:create", "group:update", "group:archive", "group:membership:manage"];
    await actor("manager", management, incidentIds);
    await actor("reader", ["session:read", "member:read", "group:read"], incidentIds);
    await actor("group-reader", ["session:read", "member:read", "group:read"], [incidentA]);
    await actor("membership-only", ["session:read"], [incidentA]);
    await actor("no-incident", ["session:read", "member:read", "group:read"], []);
    await actor("link-target", [], []);

    const first = await createMember({ memberId: `${marker}-MEM-A`, firstName: "Alpha", lastName: "Member", contactEmail: `${marker.toLowerCase()}-a@example.test`, phone: "+48 600 900 001" });
    const second = await createMember({ memberId: `${marker}-MEM-B`, firstName: "Bravo", lastName: "Member" });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    memberA = first.body;
    memberB = second.body;
    const group = await createGroup({ name: `${marker} Alpha Group`, memberIds: [memberA.id, memberB.id], leaderId: memberA.id });
    expect(group.status).toBe(201);
    groupA = group.body;
    await prisma!.groupRoleAssignment.create({ data: { id: `${marker}-GRA`, userId: actors["group-reader"]!.id, roleId: actors["group-reader"]!.roleId, groupId: groupA.id, assignedBy: adminId } });
    await prisma!.groupRoleAssignment.create({ data: { id: `${marker}-NOINC-GRA`, userId: actors["no-incident"]!.id, roleId: actors["no-incident"]!.roleId, groupId: groupA.id, assignedBy: adminId } });
    await prisma!.userRole.update({ where: { userId_roleId: { userId: actors["group-reader"]!.id, roleId: actors["group-reader"]!.roleId } }, data: { scopeType: "GROUP" } });
    await prisma!.userRole.update({ where: { userId_roleId: { userId: actors["no-incident"]!.id, roleId: actors["no-incident"]!.roleId } }, data: { scopeType: "GROUP" } });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.groupRoleAssignment.deleteMany({ where: { OR: [{ groupId: { in: groupIds } }, { userId: { in: userIds } }] } });
    await prisma.groupMembership.deleteMany({ where: { OR: [{ groupId: { in: groupIds } }, { memberProfileId: { in: memberIds } }] } });
    await prisma.operationalGroup.deleteMany({ where: { id: { in: groupIds } } });
    await prisma.memberProfile.deleteMany({ where: { id: { in: memberIds } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await prisma.incidentAssignment.deleteMany({ where: { incidentId: { in: incidentIds } } });
    await prisma.session.deleteMany({ where: { id: { in: incidentIds } } });
    await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.role.deleteMany({ where: { id: { in: roleIds } } });
    await prisma.$disconnect();
  });

  it("deploys member, membership, leader and scoped-role database protections", async () => {
    const migrations = await prisma!.$queryRaw<Array<{ migration_name: string }>>`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`;
    expect(migrations.map(({ migration_name }) => migration_name)).toContain("20260810000000_member_profiles_groups_foundation");
    const indexes = await prisma!.$queryRaw<Array<{ indexname: string }>>`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('MemberProfile_active_linked_user_key', 'GroupMembership_active_member_key', 'GroupMembership_active_leader_key', 'GroupRoleAssignment_active_scope_key')`;
    expect(indexes).toHaveLength(4);
    expect(await prisma!.userRole.count({ where: { scopeType: { in: ["GLOBAL", "GROUP"] } } })).toBeGreaterThan(0);
    const triggers = await prisma!.$queryRaw<Array<{ tgname: string }>>`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('MemberProfile_archive_membership_guard', 'GroupMembership_active_integrity_guard')`;
    expect(triggers).toHaveLength(2);
  });

  it("persists authoritative member facts, redacts PII and rejects stale edits", async () => {
    const created = await createMember({ contactEmail: `${marker.toLowerCase()}-persist@example.test`, phone: "+48 600 900 099" });
    const updated = await request(application()).patch(`/api/member-profiles/${created.body.id}`).set(as(actors.manager!.email)).send({ expectedVersion: created.body.version, role: "Specialist" });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ role: "Specialist", version: 2 });
    const stale = await request(application()).patch(`/api/member-profiles/${created.body.id}`).set(as(actors.manager!.email)).send({ expectedVersion: created.body.version, role: "Lost overwrite" });
    expect(stale.status).toBe(409);
    const restarted = await request(application()).get(`/api/member-profiles/${created.body.id}`).set(as(actors.reader!.email));
    expect(restarted.body).toMatchObject({ role: "Specialist", version: 2 });
    expect(restarted.body.contactEmail).toBeUndefined();
    expect(restarted.body.phone).toBeUndefined();
    expect(restarted.body.linkedUserId).toBeUndefined();
    const managedContactSearch = await request(application()).get("/api/member-profiles").set(as(actors.manager!.email)).query({ search: `${marker.toLowerCase()}-a@example.test`, limit: 50 });
    expect(managedContactSearch.body.data.map((member: { id: string }) => member.id)).toContain(memberA.id);
    const redactedContactSearch = await request(application()).get("/api/member-profiles").set(as(actors.reader!.email)).query({ search: `${marker.toLowerCase()}-a@example.test`, limit: 50 });
    expect(redactedContactSearch.body.total).toBe(0);
    const archived = await request(application()).post(`/api/member-profiles/${created.body.id}/archive`).set(as(actors.manager!.email)).send({ expectedVersion: updated.body.version });
    expect(archived.body).toMatchObject({ status: "Archived", version: 3, linkedUserId: null });
    const restored = await request(application()).post(`/api/member-profiles/${created.body.id}/restore`).set(as(actors.manager!.email)).send({ expectedVersion: archived.body.version });
    expect(restored.body).toMatchObject({ status: "Active", version: 4 });
    const inactive = await request(application()).patch(`/api/member-profiles/${created.body.id}`).set(as(actors.manager!.email)).send({ expectedVersion: restored.body.version, status: "Inactive" });
    expect(inactive.body).toMatchObject({ status: "Inactive", version: 5 });
  });

  it("uses atomic IDs and database uniqueness during bursts and linked-user races", async () => {
    const burst = await Promise.all(Array.from({ length: 20 }, (_, index) => createMember({ firstName: "Burst", lastName: String(index) })));
    expect(burst.map(({ status }) => status)).toEqual(Array(20).fill(201));
    expect(new Set(burst.map(({ body }) => body.id)).size).toBe(20);
    expect(new Set(burst.map(({ body }) => body.memberId)).size).toBe(20);

    const linkedUserId = actors["link-target"]!.id;
    const race = await Promise.all([
      createMember({ memberId: `${marker}-LINK-A`, linkedUserId }),
      createMember({ memberId: `${marker}-LINK-B`, linkedUserId }),
    ]);
    expect(race.map(({ status }) => status).sort(), JSON.stringify(race.map(({ status, body }) => ({ status, body })))).toEqual([201, 409]);
    expect(await prisma!.memberProfile.count({ where: { linkedUserId, status: { not: "Archived" } } })).toBe(1);
    const missing = await createMember({ memberId: `${marker}-MISSING-USER`, linkedUserId: randomUUID() });
    expect(missing.status).toBe(400);

    const groupBurst = await Promise.all(Array.from({ length: 10 }, (_, index) => createGroup({ name: `${marker} Concurrent Group ${index}` })));
    expect(groupBurst.map(({ status }) => status)).toEqual(Array(10).fill(201));
    expect(new Set(groupBurst.map(({ body }) => body.id)).size).toBe(10);
    expect(new Set(groupBurst.map(({ body }) => body.operationalId)).size).toBe(10);
  });

  it("persists incident groups, isolates incidents and makes closed incidents read-only", async () => {
    const updated = await request(application()).patch(`/api/groups/${groupA.id}`).set(as(actors.manager!.email)).send({ sessionId: incidentA, expectedVersion: groupA.version, notes: "Persisted group facts" });
    expect(updated.body).toMatchObject({ notes: "Persisted group facts", version: 2 });
    groupA = updated.body;
    const restarted = await request(application()).get(`/api/groups/${groupA.id}`).query({ sessionId: incidentA }).set(as(actors.manager!.email));
    expect(restarted.body).toMatchObject({ id: groupA.id, notes: "Persisted group facts" });
    const memberSearch = await request(application()).get("/api/groups").set(as(actors.manager!.email)).query({ sessionId: incidentA, search: memberA.memberId, limit: 50 });
    expect(memberSearch.body.data.map((group: { id: string }) => group.id)).toContain(groupA.id);
    expect((await request(application()).get(`/api/groups/${groupA.id}`).query({ sessionId: incidentB }).set(as(actors.manager!.email))).status).toBe(404);
    const closed = await createGroup({ sessionId: closedIncident, name: `${marker} Closed Group` });
    expect(closed.status).toBe(409);
  });

  it("keeps membership history, supports multiple groups and accepts one concurrent add", async () => {
    const extra = await createMember({ memberId: `${marker}-MULTI` });
    const groupB = await createGroup({ name: `${marker} Bravo Group`, memberIds: [extra.body.id], leaderId: extra.body.id });
    const race = await Promise.all([
      request(application()).post(`/api/groups/${groupA.id}/members`).set(as(actors.manager!.email)).send({ sessionId: incidentA, expectedVersion: groupA.version, memberProfileId: extra.body.id, role: "Member" }),
      request(application()).post(`/api/groups/${groupA.id}/members`).set(as(actors.manager!.email)).send({ sessionId: incidentA, expectedVersion: groupA.version, memberProfileId: extra.body.id, role: "Member" }),
    ]);
    expect(race.map(({ status }) => status).sort(), JSON.stringify(race.map(({ status, body }) => ({ status, body })))).toEqual([201, 409]);
    const winner = race.find(({ status }) => status === 201)!;
    groupA = winner.body;
    expect(await prisma!.groupMembership.count({ where: { groupId: groupA.id, memberProfileId: extra.body.id, removedAt: null } })).toBe(1);
    expect(await prisma!.groupMembership.count({ where: { memberProfileId: extra.body.id, removedAt: null } })).toBe(2);
    const removed = await request(application()).delete(`/api/groups/${groupA.id}/members/${extra.body.id}`).set(as(actors.manager!.email)).send({ sessionId: incidentA, expectedVersion: groupA.version });
    expect(removed.status).toBe(200);
    groupA = removed.body;
    expect(await prisma!.groupMembership.count({ where: { groupId: groupA.id, memberProfileId: extra.body.id, removedAt: { not: null } } })).toBe(1);
    expect((await prisma!.operationalGroup.findUniqueOrThrow({ where: { id: groupB.body.id } })).status).toBe("Active");
  });

  it("uses Leader membership as one source of truth and blocks invalid member archive", async () => {
    const blockedArchive = await request(application()).post(`/api/member-profiles/${memberA.id}/archive`).set(as(actors.manager!.email)).send({ expectedVersion: memberA.version });
    expect(blockedArchive.status).toBe(409);
    const leader = await request(application()).post(`/api/groups/${groupA.id}/set-leader`).set(as(actors.manager!.email)).send({ sessionId: incidentA, expectedVersion: groupA.version, memberProfileId: memberB.id });
    expect(leader.status, JSON.stringify({ body: leader.body, groupA, persisted: await prisma!.operationalGroup.findUnique({ where: { id: groupA.id }, select: { version: true } }) })).toBe(200);
    expect(leader.body).toMatchObject({ leaderId: memberB.id });
    groupA = leader.body;
    expect(await prisma!.groupMembership.count({ where: { groupId: groupA.id, removedAt: null, role: "Leader" } })).toBe(1);
    const outsider = await createMember({ memberId: `${marker}-OUTSIDER` });
    const invalid = await request(application()).post(`/api/groups/${groupA.id}/set-leader`).set(as(actors.manager!.email)).send({ sessionId: incidentA, expectedVersion: groupA.version, memberProfileId: outsider.body.id });
    expect(invalid.status).toBe(409);

    const leaderRemovalTarget = await createGroup({ name: `${marker} Leader Removal`, memberIds: [memberA.id, memberB.id], leaderId: memberA.id });
    const removedLeader = await request(application()).delete(`/api/groups/${leaderRemovalTarget.body.id}/members/${memberA.id}`).set(as(actors.manager!.email)).send({ sessionId: incidentA, expectedVersion: leaderRemovalTarget.body.version });
    expect(removedLeader.status).toBe(200);
    expect(removedLeader.body).toMatchObject({ leaderId: memberB.id, memberCount: 1 });
    expect(await prisma!.groupMembership.count({ where: { groupId: leaderRemovalTarget.body.id, removedAt: null, role: "Leader" } })).toBe(1);
  });

  it("enforces group-scoped RBAC without granting permissions or incident access from membership", async () => {
    const scopedMembers = await request(application()).get("/api/member-profiles").set(as(actors["group-reader"]!.email)).query({ limit: 200 });
    expect(scopedMembers.status).toBe(200);
    expect(scopedMembers.body.data.map((member: { id: string }) => member.id)).toEqual(expect.arrayContaining([memberA.id, memberB.id]));
    expect(scopedMembers.body.data.find((member: { id: string }) => member.id === memberA.id)).not.toHaveProperty("contactEmail");
    const scopedGroups = await request(application()).get("/api/groups").set(as(actors["group-reader"]!.email)).query({ sessionId: incidentA, limit: 200 });
    expect(scopedGroups.body.data.map((group: { id: string }) => group.id)).toEqual([groupA.id]);

    const linkedOnly = await createMember({ memberId: `${marker}-MEMBERSHIP-ONLY`, linkedUserId: actors["membership-only"]!.id });
    const added = await request(application()).post(`/api/groups/${groupA.id}/members`).set(as(actors.manager!.email)).send({ sessionId: incidentA, expectedVersion: groupA.version, memberProfileId: linkedOnly.body.id, role: "Member" });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    groupA = added.body;
    expect((await request(application()).get("/api/member-profiles").set(as(actors["membership-only"]!.email))).status).toBe(403);
    expect((await request(application()).get(`/api/groups/${groupA.id}`).query({ sessionId: incidentA }).set(as(actors["no-incident"]!.email))).status).toBe(404);

    await prisma!.groupRoleAssignment.update({ where: { id: `${marker}-GRA` }, data: { status: "Revoked", revokedAt: new Date(), version: { increment: 1 } } });
    expect((await request(application()).get("/api/member-profiles").set(as(actors["group-reader"]!.email))).status).toBe(403);

    const adminGroups = await request(application()).get("/api/groups").set(as("admin@lot.pl")).query({ sessionId: incidentA, limit: 200 });
    expect(adminGroups.status).toBe(200);
    expect(adminGroups.body.data.map((group: { id: string }) => group.id)).toContain(groupA.id);

    const viewer = await prisma!.user.findUniqueOrThrow({ where: { email: "viewer@lot.pl" } });
    const viewerCompatibilityId = "00000000-0000-4000-8000-000000000006";
    const persistedScope = await request(application()).post(`/api/admin/users/${viewerCompatibilityId}/role-assignments`).set(as("admin@lot.pl")).send({ roleName: "zpp-group-leader", scopeType: "GROUP", scopeId: groupA.id });
    expect(persistedScope.status, JSON.stringify(persistedScope.body)).toBe(201);
    const zppLeaderRole = await prisma!.role.findUniqueOrThrow({ where: { name: "zpp-group-leader" } });
    expect(await prisma!.userRole.findUniqueOrThrow({ where: { userId_roleId: { userId: viewer.id, roleId: zppLeaderRole.id } } })).toMatchObject({ scopeType: "GROUP" });
    expect(await prisma!.groupRoleAssignment.count({ where: { userId: viewer.id, roleId: zppLeaderRole.id, groupId: groupA.id, status: "Active" } })).toBe(1);
    expect((await request(application()).get(`/api/groups/${groupA.id}`).query({ sessionId: incidentA }).set(as(viewer.email))).status).toBe(404);
    const revokedScope = await request(application()).post(`/api/admin/users/${viewerCompatibilityId}/role-assignments/${persistedScope.body.id}/revoke`).set(as("admin@lot.pl")).send({});
    expect(revokedScope.status, JSON.stringify(revokedScope.body)).toBe(200);
    expect(await prisma!.groupRoleAssignment.count({ where: { userId: viewer.id, roleId: zppLeaderRole.id, groupId: groupA.id, status: "Active" } })).toBe(0);
  });

  it("archives groups atomically with memberships and group-scoped grants", async () => {
    const archiveTarget = await createGroup({ name: `${marker} Archive Group`, memberIds: [memberB.id], leaderId: memberB.id });
    await prisma!.groupRoleAssignment.create({ data: { id: `${marker}-ARCHIVE-GRA`, userId: actors["group-reader"]!.id, roleId: actors["group-reader"]!.roleId, groupId: archiveTarget.body.id, assignedBy: adminId } });
    const archived = await request(application()).post(`/api/groups/${archiveTarget.body.id}/archive`).set(as(actors.manager!.email)).send({ sessionId: incidentA, expectedVersion: archiveTarget.body.version });
    expect(archived.body).toMatchObject({ status: "Archived", memberCount: 0 });
    expect(await prisma!.groupMembership.count({ where: { groupId: archiveTarget.body.id, removedAt: null } })).toBe(0);
    expect(await prisma!.groupRoleAssignment.count({ where: { groupId: archiveTarget.body.id, status: "Active" } })).toBe(0);
  });

  it("serializes member archive against membership add and group archive against scoped-role grant", async () => {
    const raceMember = await createMember({ memberId: `${marker}-ARCHIVE-RACE` });
    const membershipGroup = await createGroup({ name: `${marker} Membership Archive Race` });
    const [archiveMember, addMembership] = await Promise.all([
      request(application()).post(`/api/member-profiles/${raceMember.body.id}/archive`).set(as(actors.manager!.email)).send({ expectedVersion: raceMember.body.version }),
      request(application()).post(`/api/groups/${membershipGroup.body.id}/members`).set(as(actors.manager!.email)).send({ sessionId: incidentA, expectedVersion: membershipGroup.body.version, memberProfileId: raceMember.body.id, role: "Member" }),
    ]);
    expect([archiveMember.status, addMembership.status].some((status) => status === 200 || status === 201)).toBe(true);
    const persistedMember = await prisma!.memberProfile.findUniqueOrThrow({ where: { id: raceMember.body.id } });
    const activeMemberships = await prisma!.groupMembership.count({ where: { groupId: membershipGroup.body.id, memberProfileId: raceMember.body.id, removedAt: null } });
    expect(persistedMember.status === "Archived" && activeMemberships > 0).toBe(false);

    const roleGroup = await createGroup({ name: `${marker} Role Archive Race` });
    const repository = createPrismaMemberDirectoryRepository(prisma!);
    const directoryActor = {
      id: actors.manager!.id,
      email: actors.manager!.email,
      displayName: `${marker} manager`,
      roles: [],
      permissions: [],
    };
    await Promise.allSettled([
      request(application()).post(`/api/groups/${roleGroup.body.id}/archive`).set(as(actors.manager!.email)).send({ sessionId: incidentA, expectedVersion: roleGroup.body.version }),
      repository.assignGroupRole(actors.reader!.id, `${marker.toLowerCase()}-reader`, roleGroup.body.id, directoryActor),
    ]);
    const persistedGroup = await prisma!.operationalGroup.findUniqueOrThrow({ where: { id: roleGroup.body.id } });
    expect(persistedGroup.status).toBe("Archived");
    expect(await prisma!.groupRoleAssignment.count({ where: { groupId: roleGroup.body.id, status: "Active" } })).toBe(0);
  });

  it("paginates and searches 1000 MemberProfiles in PostgreSQL without fetch-all", async () => {
    const prefix = `${marker}-SCALE`;
    const rows = Array.from({ length: 1000 }, (_, index) => ({
      id: `${prefix.toLowerCase()}-${String(index).padStart(4, "0")}`,
      memberId: `${prefix}-${String(index).padStart(4, "0")}`,
      firstName: "Scale",
      lastName: `Member ${String(index).padStart(4, "0")}`,
      pool: index % 2 ? "TEC" : "ZPP",
      role: "Scale test",
      assignedFunction: index % 3 ? "Scale A" : "Scale B",
      languages: ["PL"],
      createdById: actors.manager!.id,
      updatedById: actors.manager!.id,
    }));
    await prisma!.memberProfile.createMany({ data: rows });
    memberIds.push(...rows.map(({ id }) => id));
    const page = await request(application()).get("/api/member-profiles").set(as(actors.manager!.email)).query({ search: prefix, pool: "ZPP", limit: 37, offset: 74, sortBy: "memberId", sortDirection: "asc" });
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ total: 500, limit: 37, offset: 74 });
    expect(page.body.data).toHaveLength(37);
    expect(page.body.data[0].memberId.localeCompare(page.body.data[36].memberId)).toBeLessThan(0);
  });

  it("serves read-only legacy consumers without Member/Group write-back and omits contact values from audit", async () => {
    const before = await prisma!.memberProfile.findUniqueOrThrow({ where: { id: memberA.id } });
    const app = application();
    expect((await request(app).get("/api/member-profiles").set(as(actors.manager!.email)).query({ limit: 50 })).status).toBe(200);
    expect((await request(app).get("/api/groups").set(as(actors.manager!.email)).query({ sessionId: incidentA, limit: 50 })).status).toBe(200);
    for (const path of ["/api/roster-shifts", "/api/training/records", "/api/documents", "/api/readiness/members"]) {
      const response = await request(app).get(path).set(as(actors.manager!.email));
      expect([200, 403]).toContain(response.status);
    }
    const after = await prisma!.memberProfile.findUniqueOrThrow({ where: { id: memberA.id } });
    expect(after.version).toBe(before.version);
    expect(after.updatedAt).toEqual(before.updatedAt);
    const audits = await prisma!.auditLog.findMany({ where: { actorId: actors.manager!.id } });
    expect(JSON.stringify(audits)).not.toContain("+48 600 900 001");
    expect(JSON.stringify(audits)).not.toContain(`${marker.toLowerCase()}-a@example.test`);
  });
});
