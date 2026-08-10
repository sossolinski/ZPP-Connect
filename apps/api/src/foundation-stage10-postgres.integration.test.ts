import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createPrismaIncidentAccessRepository } from "./modules/incident-access/prisma-incident-access-repository.js";
import { createPrismaMemberDirectoryRepository } from "./modules/member-directory/prisma-member-directory-repository.js";
import { createPrismaRosteringRepository } from "./modules/rostering/prisma-rostering-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;
const prisma = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;
const as = (email: string) => ({ "x-user-email": email });

postgresDescribe("Foundation Stage 10 PostgreSQL Rostering and Availability", () => {
  const marker = `F10-${Date.now()}`;
  const incidentIds: string[] = [];
  const userIds: string[] = [];
  const roleIds: string[] = [];
  const memberIds: string[] = [];
  const groupIds: string[] = [];
  const shiftIds: string[] = [];
  const availabilityIds: string[] = [];
  const actors: Record<string, { id: string; email: string; memberId?: string }> = {};
  let incidentA: string;
  let incidentB: string;
  let incidentTraining: string;
  let closedIncident: string;
  let adminId: string;
  let groupA: string;
  let groupB: string;

  function application(hook?: (record: Record<string, unknown>, command: string) => void) {
    return createApp({
      incidentAccessRepository: createPrismaIncidentAccessRepository(prisma!),
      memberDirectoryRepository: createPrismaMemberDirectoryRepository(prisma!),
      rosteringRepository: createPrismaRosteringRepository(prisma!),
      rosteringNotificationHook: hook,
    });
  }

  async function actor(key: string, permissions: string[], incidents: string[] = [], linked = false) {
    const role = await prisma!.role.create({ data: { name: `${marker.toLowerCase()}-${key}`, displayName: `${marker} ${key}`, permissions } });
    const user = await prisma!.user.create({ data: { email: `${marker.toLowerCase()}-${key}@example.test`, displayName: `${marker} ${key}`, roles: { create: { roleId: role.id, assignedBy: "stage10-test" } } } });
    for (const incidentId of incidents) await prisma!.incidentAssignment.create({ data: { incidentId, userId: user.id, function: "Stage 10 test", createdById: adminId } });
    let memberId: string | undefined;
    if (linked) {
      memberId = `${marker.toLowerCase()}-member-${key}`;
      await prisma!.memberProfile.create({ data: { id: memberId, memberId: `${marker}-${key}`.toUpperCase(), linkedUserId: user.id, firstName: "Stage10", lastName: key, pool: "ZPP", role: "Operator", assignedFunction: "Stage 10", languages: ["PL"], createdById: adminId, updatedById: adminId } });
      memberIds.push(memberId);
    }
    roleIds.push(role.id);
    userIds.push(user.id);
    actors[key] = { id: user.id, email: user.email, memberId };
    return actors[key]!;
  }

  async function member(label: string, status = "Active") {
    const id = `${marker.toLowerCase()}-member-${label}-${randomUUID().slice(0, 6)}`;
    await prisma!.memberProfile.create({ data: { id, memberId: `${marker}-${label}-${randomUUID().slice(0, 5)}`.toUpperCase(), firstName: "Roster", lastName: label, pool: "ZPP", role: "Member", assignedFunction: "Stage 10", status, languages: ["PL"], createdById: adminId, updatedById: adminId } });
    memberIds.push(id);
    return id;
  }

  async function group(incidentId: string, label: string, status = "Active") {
    const id = `${marker.toLowerCase()}-group-${label}-${randomUUID().slice(0, 6)}`;
    await prisma!.operationalGroup.create({ data: { id, operationalId: `${marker}-GRP-${randomUUID().slice(0, 6)}`, incidentId, name: `${marker} ${label}`, pool: "ZPP", functionName: "Stage 10", status, createdById: adminId, updatedById: adminId } });
    groupIds.push(id);
    return id;
  }

  async function createShift(values: Record<string, unknown> = {}, email = actors.manager!.email, operationId = randomUUID()) {
    const response = await request(application()).post("/api/roster-shifts").set(as(email)).send({
      sessionId: incidentA,
      title: `${marker} shift ${randomUUID().slice(0, 6)}`,
      duty: "Controlled staffing",
      functionName: "Stage 10",
      groupId: groupA,
      startAt: "2026-09-01T08:00:00.000Z",
      endAt: "2026-09-01T12:00:00.000Z",
      location: "Test location",
      operationId,
      ...values,
    });
    if ([200, 201].includes(response.status) && !shiftIds.includes(response.body.id)) shiftIds.push(response.body.id);
    return response;
  }

  async function createAvailability(values: Record<string, unknown> = {}, email = actors.manager!.email, operationId = randomUUID()) {
    const response = await request(application()).post("/api/availability").set(as(email)).send({
      memberProfileId: actors.worker!.memberId,
      startAt: "2026-09-01T08:00:00.000Z",
      endAt: "2026-09-01T12:00:00.000Z",
      type: "Available",
      note: "Stage 10 availability",
      operationId,
      ...values,
    });
    if ([200, 201].includes(response.status) && !availabilityIds.includes(response.body.id)) availabilityIds.push(response.body.id);
    return response;
  }

  beforeAll(async () => {
    await prisma!.$connect();
    adminId = (await prisma!.user.findUniqueOrThrow({ where: { email: "admin@lot.pl" } })).id;
    const incidents = await Promise.all([
      prisma!.session.create({ data: { operationalId: `${marker}-EXERCISE`, mode: "EXERCISE", status: "Active", eventType: marker, createdById: adminId } }),
      prisma!.session.create({ data: { operationalId: `${marker}-REAL`, mode: "REAL", status: "Draft", eventType: marker, createdById: adminId } }),
      prisma!.session.create({ data: { operationalId: `${marker}-TRAINING`, mode: "TRAINING", status: "Active", eventType: marker, createdById: adminId } }),
      prisma!.session.create({ data: { operationalId: `${marker}-CLOSED`, mode: "EXERCISE", status: "Closed", eventType: marker, createdById: adminId } }),
    ]);
    incidentA = incidents[0]!.id;
    incidentB = incidents[1]!.id;
    incidentTraining = incidents[2]!.id;
    closedIncident = incidents[3]!.id;
    incidentIds.push(incidentA, incidentB, incidentTraining, closedIncident);
    const managerPermissions = ["session:read", "member:read", "member:create", "member:update", "member:archive", "group:read", "group:create", "group:update", "group:archive", "roster:read", "roster:create", "roster:update", "roster:publish", "roster:cancel", "roster:complete", "availability:read-all", "availability:manage-all", "readiness:read-all"];
    await actor("manager", managerPermissions, incidentIds);
    await actor("worker", ["session:read", "member:read", "group:read", "roster:read-own", "roster:confirm-own", "roster:decline-own", "availability:read-own", "availability:update-own", "readiness:read-own"], [incidentA, incidentB, incidentTraining], true);
    await actor("other", ["session:read", "roster:read-own", "roster:confirm-own", "roster:decline-own", "availability:read-own", "availability:update-own"], [incidentA], true);
    await actor("no-incident", ["session:read", "roster:read-own", "roster:confirm-own", "availability:read-own", "availability:update-own"], [], true);
    await actor("reader", ["session:read", "roster:read", "availability:read-all"], [incidentA]);
    groupA = await group(incidentA, "Alpha");
    groupB = await group(incidentB, "Bravo");
    await prisma!.groupMembership.create({ data: { id: `${marker}-GMB-WORKER`, groupId: groupA, memberProfileId: actors.worker!.memberId!, role: "Member", addedById: adminId } });
  });

  afterAll(async () => {
    if (!prisma) return;
    const persistedShiftIds = shiftIds.filter((value): value is string => typeof value === "string");
    const persistedAvailabilityIds = availabilityIds.filter((value): value is string => typeof value === "string");
    await prisma.rosteringOperation.deleteMany({ where: { OR: [{ rosterShiftId: { in: persistedShiftIds } }, { availabilityId: { in: persistedAvailabilityIds } }] } });
    await prisma.rosterShift.deleteMany({ where: { OR: [{ id: { in: persistedShiftIds } }, { sessionId: { in: incidentIds } }] } });
    await prisma.availability.deleteMany({ where: { OR: [{ id: { in: persistedAvailabilityIds } }, { memberProfileId: { in: memberIds } }] } });
    await prisma.groupRoleAssignment.deleteMany({ where: { OR: [{ groupId: { in: groupIds } }, { userId: { in: userIds } }] } });
    await prisma.groupMembership.deleteMany({ where: { OR: [{ groupId: { in: groupIds } }, { memberProfileId: { in: memberIds } }] } });
    await prisma.operationalGroup.deleteMany({ where: { id: { in: groupIds } } });
    await prisma.memberProfile.deleteMany({ where: { id: { in: memberIds } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ sessionId: { in: incidentIds } }, { actorId: { in: userIds } }] } });
    await prisma.incidentAssignment.deleteMany({ where: { incidentId: { in: incidentIds } } });
    await prisma.session.deleteMany({ where: { id: { in: incidentIds } } });
    await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.role.deleteMany({ where: { id: { in: roleIds } } });
    await prisma.$disconnect();
  });

  it("deploys relational, lifecycle, indexing and archive-race database protections", async () => {
    const migrations = await prisma!.$queryRaw<Array<{ migration_name: string }>>`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`;
    expect(migrations.map(({ migration_name }) => migration_name)).toContain("20260810100000_rostering_availability_foundation");
    const checks = await prisma!.$queryRaw<Array<{ conname: string }>>`SELECT conname FROM pg_constraint WHERE conname IN ('RosterShift_version_check', 'RosterShift_range_check', 'RosterShift_status_check', 'Availability_version_check', 'Availability_range_check', 'Availability_type_check', 'Availability_status_check', 'RosterShift_groupId_sessionId_fkey')`;
    expect(checks).toHaveLength(8);
    const triggers = await prisma!.$queryRaw<Array<{ tgname: string }>>`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('RosterShift_integrity_guard', 'OperationalGroup_archive_roster_guard', 'Availability_member_guard')`;
    expect(triggers).toHaveLength(3);
  });

  it("persists idempotent shifts across app instances and projects assigned User only through MemberProfile", async () => {
    const operationId = randomUUID();
    const values = { assignedMemberProfileId: actors.worker!.memberId };
    const created = await createShift(values, actors.manager!.email, operationId);
    const retry = await createShift({ ...values, title: created.body.title }, actors.manager!.email, operationId);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: "Draft", version: 1, assignedMemberProfileId: actors.worker!.memberId, assignedUserId: actors.worker!.id });
    expect(retry.body).toMatchObject({ id: created.body.id, idempotent: true });
    const restored = await request(application()).get(`/api/roster-shifts/${created.body.id}`).query({ sessionId: incidentA }).set(as(actors.manager!.email));
    expect(restored.body).toMatchObject({ id: created.body.id, assignedUserId: actors.worker!.id });
    expect(Object.keys(await prisma!.rosterShift.findUniqueOrThrow({ where: { id: created.body.id } }))).not.toContain("assignedUserId");
  });

  it("isolates incidents and modes, requires IncidentAssignment even for own roster, and enforces revoke immediately", async () => {
    const shift = await createShift({ assignedMemberProfileId: actors.worker!.memberId });
    expect((await request(application()).get("/api/roster-shifts").query({ sessionId: incidentB, limit: 50 }).set(as(actors.reader!.email))).status).toBe(404);
    expect((await request(application()).get("/api/roster-shifts").query({ sessionId: incidentA, mine: true }).set(as(actors["no-incident"]!.email))).status).toBe(404);
    const own = await request(application()).get("/api/roster-shifts").query({ sessionId: incidentA, mine: true }).set(as(actors.worker!.email));
    expect(own.body.data.map((row: any) => row.id)).toContain(shift.body.id);
    await prisma!.incidentAssignment.update({ where: { incidentId_userId: { incidentId: incidentA, userId: actors.worker!.id } }, data: { active: false, revokedAt: new Date(), revokedById: adminId } });
    expect((await request(application()).get("/api/roster-shifts").query({ sessionId: incidentA, mine: true }).set(as(actors.worker!.email))).status).toBe(404);
    await prisma!.incidentAssignment.update({ where: { incidentId_userId: { incidentId: incidentA, userId: actors.worker!.id } }, data: { active: true, revokedAt: null, revokedById: null } });
    for (const [incidentId, mode] of [[incidentB, "REAL"], [incidentTraining, "TRAINING"]] as const) {
      const created = await createShift({ sessionId: incidentId, groupId: incidentId === incidentB ? groupB : null, title: `${marker} ${mode}` });
      expect(created.status).toBe(201);
      expect((await prisma!.rosterShift.findUniqueOrThrow({ where: { id: created.body.id } })).sessionId).toBe(incidentId);
    }
  });

  it("keeps global Availability independent from incidents and enforces own/manage-all ownership", async () => {
    const own = await createAvailability({ memberProfileId: undefined, startAt: "2026-09-02T08:00:00.000Z", endAt: "2026-09-02T12:00:00.000Z" }, actors.worker!.email);
    expect(own.status).toBe(201);
    expect(own.body.memberProfileId).toBe(actors.worker!.memberId);
    const noIncidentOwn = await createAvailability({ memberProfileId: undefined, startAt: "2026-09-03T08:00:00.000Z", endAt: "2026-09-03T12:00:00.000Z" }, actors["no-incident"]!.email);
    expect(noIncidentOwn.status).toBe(201);
    const stolen = await request(application()).patch(`/api/availability/${own.body.id}`).set(as(actors.other!.email)).send({ expectedVersion: own.body.version, memberProfileId: actors.other!.memberId, note: "Forbidden takeover" });
    expect(stolen.status).toBe(404);
    const managed = await createAvailability({ memberProfileId: actors.other!.memberId, startAt: "2026-09-04T08:00:00.000Z", endAt: "2026-09-04T12:00:00.000Z" });
    expect(managed.status).toBe(201);
  });

  it("uses versioned human-controlled FSM commands with retry-safe publish and completion", async () => {
    const created = await createShift({ assignedMemberProfileId: actors.worker!.memberId, startAt: "2026-09-05T08:00:00.000Z", endAt: "2026-09-05T12:00:00.000Z" });
    const publishOperation = randomUUID();
    const publishBody = { sessionId: incidentA, expectedVersion: created.body.version, operationId: publishOperation };
    const published = await request(application()).post(`/api/roster-shifts/${created.body.id}/publish`).set(as(actors.manager!.email)).send(publishBody);
    const retry = await request(application()).post(`/api/roster-shifts/${created.body.id}/publish`).set(as(actors.manager!.email)).send(publishBody);
    expect(published.body).toMatchObject({ status: "Published", version: 2 });
    expect(retry.body).toMatchObject({ id: created.body.id, status: "Published", idempotent: true });
    const confirmed = await request(application()).post(`/api/roster-shifts/${created.body.id}/confirm`).set(as(actors.worker!.email)).send({ sessionId: incidentA, expectedVersion: published.body.version, operationId: randomUUID() });
    expect(confirmed.body).toMatchObject({ status: "Confirmed", confirmedById: actors.worker!.id, version: 3 });
    const completed = await request(application()).post(`/api/roster-shifts/${created.body.id}/complete`).set(as(actors.manager!.email)).send({ sessionId: incidentA, expectedVersion: confirmed.body.version, operationId: randomUUID() });
    expect(completed.body).toMatchObject({ status: "Completed", version: 4 });
    expect((await request(application()).patch(`/api/roster-shifts/${created.body.id}`).set(as(actors.manager!.email)).send({ sessionId: incidentA, expectedVersion: completed.body.version, title: "Forbidden terminal edit" })).status).toBe(409);
  });

  it("reports overlapping shift, unavailable and cross-group conditions as warnings without automatic decisions", async () => {
    const unavailable = await createAvailability({ memberProfileId: actors.worker!.memberId, type: "Unavailable", startAt: "2026-09-06T08:00:00.000Z", endAt: "2026-09-06T14:00:00.000Z" });
    const first = await createShift({ assignedMemberProfileId: actors.worker!.memberId, groupId: groupB, sessionId: incidentB, startAt: "2026-09-06T09:00:00.000Z", endAt: "2026-09-06T11:00:00.000Z" });
    const second = await createShift({ assignedMemberProfileId: actors.worker!.memberId, groupId: groupB, sessionId: incidentB, startAt: "2026-09-06T10:00:00.000Z", endAt: "2026-09-06T12:00:00.000Z" });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.conflictWarnings.join(" ")).toMatch(/Overlapping roster shift|Unavailable during this shift|outside this group/i);
    expect((await prisma!.rosterShift.findUniqueOrThrow({ where: { id: first.body.id } })).status).toBe("Draft");
    expect((await prisma!.availability.findUniqueOrThrow({ where: { id: unavailable.body.id } })).status).toBe("Active");
  });

  it("allows exactly one concurrent staffing update and one publish-vs-edit winner", async () => {
    const memberX = await member("X");
    const memberY = await member("Y");
    const staffing = await createShift({ startAt: "2026-09-07T08:00:00.000Z", endAt: "2026-09-07T12:00:00.000Z" });
    const update = (assignedMemberProfileId: string) => request(application()).patch(`/api/roster-shifts/${staffing.body.id}`).set(as(actors.manager!.email)).send({ sessionId: incidentA, expectedVersion: staffing.body.version, assignedMemberProfileId });
    const race = await Promise.all([update(memberX), update(memberY)]);
    expect(race.map(({ status }) => status).sort()).toEqual([200, 409]);
    const draft = await createShift({ startAt: "2026-09-08T08:00:00.000Z", endAt: "2026-09-08T12:00:00.000Z" });
    const publishEdit = await Promise.all([
      request(application()).post(`/api/roster-shifts/${draft.body.id}/publish`).set(as(actors.manager!.email)).send({ sessionId: incidentA, expectedVersion: draft.body.version, operationId: randomUUID() }),
      request(application()).patch(`/api/roster-shifts/${draft.body.id}`).set(as(actors.manager!.email)).send({ sessionId: incidentA, expectedVersion: draft.body.version, location: "Concurrent location" }),
    ]);
    expect(publishEdit.map(({ status }) => status).sort()).toEqual([200, 409]);
  });

  it("allows exactly one confirm-vs-decline and confirm-vs-cancel result", async () => {
    async function publishedShift(day: string) {
      const draft = await createShift({ assignedMemberProfileId: actors.worker!.memberId, startAt: `2026-09-${day}T08:00:00.000Z`, endAt: `2026-09-${day}T12:00:00.000Z` });
      return request(application()).post(`/api/roster-shifts/${draft.body.id}/publish`).set(as(actors.manager!.email)).send({ sessionId: incidentA, expectedVersion: draft.body.version, operationId: randomUUID() });
    }
    const first = await publishedShift("09");
    const decisionRace = await Promise.all([
      request(application()).post(`/api/roster-shifts/${first.body.id}/confirm`).set(as(actors.worker!.email)).send({ sessionId: incidentA, expectedVersion: first.body.version, operationId: randomUUID() }),
      request(application()).post(`/api/roster-shifts/${first.body.id}/decline`).set(as(actors.worker!.email)).send({ sessionId: incidentA, expectedVersion: first.body.version, operationId: randomUUID() }),
    ]);
    expect(decisionRace.map(({ status }) => status).sort()).toEqual([200, 409]);
    const second = await publishedShift("10");
    const cancelRace = await Promise.all([
      request(application()).post(`/api/roster-shifts/${second.body.id}/confirm`).set(as(actors.worker!.email)).send({ sessionId: incidentA, expectedVersion: second.body.version, operationId: randomUUID() }),
      request(application()).post(`/api/roster-shifts/${second.body.id}/cancel`).set(as(actors.manager!.email)).send({ sessionId: incidentA, expectedVersion: second.body.version, operationId: randomUUID(), reason: "Human planner cancellation" }),
    ]);
    expect(cancelRace.map(({ status }) => status).sort()).toEqual([200, 409]);
  });

  it("allows exactly one Availability update-vs-remove winner and preserves removed history", async () => {
    const record = await createAvailability({ startAt: "2026-09-11T08:00:00.000Z", endAt: "2026-09-11T12:00:00.000Z" });
    const race = await Promise.all([
      request(application()).patch(`/api/availability/${record.body.id}`).set(as(actors.manager!.email)).send({ expectedVersion: record.body.version, note: "Concurrent update" }),
      request(application()).post(`/api/availability/${record.body.id}/remove`).set(as(actors.manager!.email)).send({ expectedVersion: record.body.version, operationId: randomUUID() }),
    ]);
    expect(race.map(({ status }) => status).sort()).toEqual([200, 409]);
    const stored = await prisma!.availability.findUniqueOrThrow({ where: { id: record.body.id } });
    expect(stored.version).toBe(2);
    if (stored.status === "Removed") expect(stored.removedAt).not.toBeNull();
  });

  it("prevents wrong-incident groups and serializes Member/Group archive against new staffing", async () => {
    expect((await createShift({ groupId: groupB })).status).toBe(409);
    await expect(prisma!.rosterShift.create({ data: { id: `${marker}-bad-fk`, operationalId: `${marker}-BAD-FK`, sessionId: incidentA, groupId: groupB, title: "Bad", duty: "Bad", functionName: "Bad", startAt: new Date("2026-09-12T08:00:00Z"), endAt: new Date("2026-09-12T09:00:00Z"), location: "Bad" } })).rejects.toBeTruthy();
    const raceMember = await member("ArchiveRace");
    const memberRow = await prisma!.memberProfile.findUniqueOrThrow({ where: { id: raceMember } });
    const [archiveMember, assignMember] = await Promise.all([
      request(application()).post(`/api/member-profiles/${raceMember}/archive`).set(as(actors.manager!.email)).send({ expectedVersion: memberRow.version }),
      createShift({ assignedMemberProfileId: raceMember, startAt: "2026-09-12T10:00:00.000Z", endAt: "2026-09-12T11:00:00.000Z" }),
    ]);
    expect([archiveMember.status, assignMember.status].some((status) => [200, 201].includes(status))).toBe(true);
    const memberAfter = await prisma!.memberProfile.findUniqueOrThrow({ where: { id: raceMember } });
    const memberActiveShifts = await prisma!.rosterShift.count({ where: { assignedMemberProfileId: raceMember, status: { in: ["Draft", "Published", "Confirmed"] } } });
    expect(memberAfter.status === "Archived" && memberActiveShifts > 0).toBe(false);
    const raceGroup = await group(incidentA, "ArchiveRace");
    const groupRow = await prisma!.operationalGroup.findUniqueOrThrow({ where: { id: raceGroup } });
    await Promise.allSettled([
      request(application()).post(`/api/groups/${raceGroup}/archive`).set(as(actors.manager!.email)).send({ sessionId: incidentA, expectedVersion: groupRow.version }),
      createShift({ groupId: raceGroup, startAt: "2026-09-12T12:00:00.000Z", endAt: "2026-09-12T13:00:00.000Z" }),
    ]);
    const groupAfter = await prisma!.operationalGroup.findUniqueOrThrow({ where: { id: raceGroup } });
    const groupActiveShifts = await prisma!.rosterShift.count({ where: { groupId: raceGroup, status: { in: ["Draft", "Published", "Confirmed"] } } });
    expect(groupAfter.status === "Archived" && groupActiveShifts > 0).toBe(false);
  });

  it("blocks every write in a closed incident", async () => {
    expect((await createShift({ sessionId: closedIncident, groupId: null })).status).toBe(409);
    const created = await createShift({ startAt: "2026-09-13T08:00:00.000Z", endAt: "2026-09-13T12:00:00.000Z" });
    await prisma!.rosterShift.update({ where: { id: created.body.id }, data: { sessionId: closedIncident, groupId: null } });
    expect((await request(application()).patch(`/api/roster-shifts/${created.body.id}`).set(as(actors.manager!.email)).send({ sessionId: closedIncident, expectedVersion: created.body.version, title: "Blocked" })).status).toBe(409);
  });

  it("keeps the roster commit when best-effort notification delivery fails", async () => {
    const app = application(() => { throw new Error("notification unavailable"); });
    const created = await request(app).post("/api/roster-shifts").set(as(actors.manager!.email)).send({ sessionId: incidentA, title: `${marker} notification`, duty: "Notify", functionName: "Stage 10", groupId: groupA, startAt: "2026-09-14T08:00:00Z", endAt: "2026-09-14T12:00:00Z", location: "Test", operationId: randomUUID() });
    shiftIds.push(created.body.id);
    const published = await request(app).post(`/api/roster-shifts/${created.body.id}/publish`).set(as(actors.manager!.email)).send({ sessionId: incidentA, expectedVersion: created.body.version, operationId: randomUUID() });
    expect(published.status).toBe(200);
    expect((await prisma!.rosterShift.findUniqueOrThrow({ where: { id: created.body.id } })).status).toBe("Published");
  });

  it("generates unique operational IDs under burst concurrency", async () => {
    const shifts = await Promise.all(Array.from({ length: 20 }, (_, index) => createShift({ title: `${marker} burst ${index}`, groupId: null, startAt: `2026-10-${String(index + 1).padStart(2, "0")}T08:00:00.000Z`, endAt: `2026-10-${String(index + 1).padStart(2, "0")}T09:00:00.000Z` })));
    expect(shifts.every(({ status }) => status === 201), JSON.stringify(shifts.map(({ status, body }) => ({ status, body })))).toBe(true);
    expect(new Set(shifts.map(({ body }) => body.operationalId)).size).toBe(20);
    const availability = await Promise.all(Array.from({ length: 20 }, (_, index) => createAvailability({ startAt: `2026-11-${String(index + 1).padStart(2, "0")}T08:00:00.000Z`, endAt: `2026-11-${String(index + 1).padStart(2, "0")}T09:00:00.000Z` })));
    expect(availability.every(({ status }) => status === 201)).toBe(true);
    expect(new Set(availability.map(({ body }) => body.operationalId)).size).toBe(20);
  });

  it("paginates, filters and sorts 1000 shifts and 1000 availability records without fetch-all", async () => {
    const scaleMember = await member("Scale");
    const shifts = Array.from({ length: 1000 }, (_, index) => ({ id: `${marker}-scale-rst-${index}`, operationalId: `${marker}-RST-${String(index).padStart(4, "0")}`, sessionId: incidentA, assignedMemberProfileId: scaleMember, title: `${marker} scale shift ${index}`, duty: "Scale", functionName: index % 2 ? "Scale A" : "Scale B", startAt: new Date(2027, 0, 1, 0, index), endAt: new Date(2027, 0, 1, 1, index), location: "Scale", createdById: adminId, updatedById: adminId }));
    const availability = Array.from({ length: 1000 }, (_, index) => ({ id: `${marker}-scale-avl-${index}`, operationalId: `${marker}-AVL-${String(index).padStart(4, "0")}`, memberProfileId: scaleMember, startAt: new Date(2028, 0, 1, 0, index), endAt: new Date(2028, 0, 1, 1, index), type: index % 2 ? "Available" : "Preferred", createdById: adminId, updatedById: adminId }));
    await prisma!.rosterShift.createMany({ data: shifts });
    await prisma!.availability.createMany({ data: availability });
    shiftIds.push(...shifts.map(({ id }) => id));
    availabilityIds.push(...availability.map(({ id }) => id));
    const shiftPage = await request(application()).get("/api/roster-shifts").set(as(actors.manager!.email)).query({ sessionId: incidentA, search: `${marker} scale`, functionName: "Scale A", limit: 37, offset: 74, sortBy: "operationalId", sortDirection: "asc" });
    expect(shiftPage.body).toMatchObject({ total: 500, limit: 37, offset: 74 });
    expect(shiftPage.body.data).toHaveLength(37);
    const availabilityPage = await request(application()).get("/api/availability").set(as(actors.manager!.email)).query({ memberProfileId: scaleMember, type: "Preferred", limit: 41, offset: 82, sortBy: "operationalId", sortDirection: "asc" });
    expect(availabilityPage.body).toMatchObject({ total: 500, limit: 41, offset: 82 });
    expect(availabilityPage.body.data).toHaveLength(41);
  });

  it("serves durable Member, Group and Readiness projections without write-back and audits no PII", async () => {
    const projectedMemberId = "mem-2026-000003";
    const shift = await createShift({ assignedMemberProfileId: projectedMemberId, groupId: null, startAt: "2026-12-01T08:00:00.000Z", endAt: "2026-12-01T12:00:00.000Z" });
    const groupShift = await createShift({ assignedMemberProfileId: null, groupId: groupA, startAt: "2026-12-02T08:00:00.000Z", endAt: "2026-12-02T12:00:00.000Z" });
    const availability = await createAvailability({ memberProfileId: projectedMemberId, startAt: "2026-12-01T07:00:00.000Z", endAt: "2026-12-01T13:00:00.000Z", type: "Preferred" });
    const before = await prisma!.memberProfile.findUniqueOrThrow({ where: { id: projectedMemberId } });
    const memberResponse = await request(application()).get(`/api/member-profiles/${projectedMemberId}`).set(as(actors.manager!.email));
    expect(memberResponse.body).toMatchObject({ rosterSummary: { id: expect.any(String) }, availabilitySummary: { id: expect.any(String) } });
    const groupResponse = await request(application()).get(`/api/groups/${groupA}`).query({ sessionId: incidentA }).set(as(actors.manager!.email));
    expect(groupResponse.body.rosterShiftIds).toContain(groupShift.body.id);
    const readiness = await request(application()).get(`/api/readiness/members/${projectedMemberId}`).query({ evaluationAt: "2026-12-01T09:00:00.000Z" }).set(as("admin@lot.pl"));
    expect(readiness.status, JSON.stringify(readiness.body)).toBe(200);
    expect(readiness.body.dimensions.find((item: any) => item.key === "availability").items.map((item: any) => item.id)).toContain(availability.body.id);
    const after = await prisma!.memberProfile.findUniqueOrThrow({ where: { id: projectedMemberId } });
    expect(after.version).toBe(before.version);
    expect(after.updatedAt).toEqual(before.updatedAt);
    const audits = await prisma!.auditLog.findMany({ where: { actorId: actors.manager!.id, entityType: { in: ["rosterShift", "availability"] } } });
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toMatch(/phone|contactEmail/i);
  });
});
