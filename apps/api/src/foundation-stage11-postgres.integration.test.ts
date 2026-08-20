import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createPrismaIncidentAccessRepository } from "./modules/incident-access/prisma-incident-access-repository.js";
import { createPrismaMemberDirectoryRepository } from "./modules/member-directory/prisma-member-directory-repository.js";
import { createPrismaTrainingRepository } from "./modules/training/prisma-training-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;
const prisma = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;
const as = (email: string) => ({ "x-user-email": email });

postgresDescribe("Foundation Stage 11 PostgreSQL Training", () => {
  const marker = `F11-${Date.now()}`;
  let referenceNow = new Date("2026-07-13T09:00:00.000Z");
  const clock = { now: () => new Date(referenceNow) };
  const incidentIds: string[] = [];
  const userIds: string[] = [];
  const roleIds: string[] = [];
  const memberIds: string[] = [];
  const groupIds: string[] = [];
  const courseIds: string[] = [];
  const requirementIds: string[] = [];
  const recordIds: string[] = [];
  const actors: Record<string, { id: string; email: string; memberId?: string }> = {};
  let adminId: string;
  let incidentA: string;
  let incidentB: string;
  let groupA: string;
  let groupB: string;

  function application(notificationHook?: (record: Record<string, unknown>, command: string) => void) {
    const training = createPrismaTrainingRepository(prisma!, clock);
    return createApp({
      incidentAccessRepository: createPrismaIncidentAccessRepository(prisma!),
      memberDirectoryRepository: createPrismaMemberDirectoryRepository(prisma!, (memberId) => training.memberTrainingStatus(memberId, clock.now())),
      trainingRepository: training,
      trainingClock: clock,
      trainingNotificationHook: notificationHook,
    });
  }

  async function actor(key: string, permissions: string[], incidents: string[] = [], linked = false, scopedGroupId?: string) {
    const role = await prisma!.role.create({ data: { name: `${marker.toLowerCase()}-${key}`, displayName: `${marker} ${key}`, permissions } });
    const user = await prisma!.user.create({ data: { email: `${marker.toLowerCase()}-${key}@example.test`, displayName: `${marker} ${key}`, roles: { create: { roleId: role.id, scopeType: scopedGroupId ? "GROUP" : "GLOBAL", assignedBy: "stage11-test" } } } });
    if (scopedGroupId) await prisma!.groupRoleAssignment.create({ data: { id: `${marker}-${key}-scope`, userId: user.id, roleId: role.id, groupId: scopedGroupId, assignedBy: adminId } });
    for (const incidentId of incidents) await prisma!.incidentAssignment.create({ data: { incidentId, userId: user.id, function: "Stage 11 test", createdById: adminId } });
    let memberId: string | undefined;
    if (linked) {
      memberId = `${marker.toLowerCase()}-member-${key}`;
      await prisma!.memberProfile.create({ data: { id: memberId, memberId: `${marker}-${key}`.toUpperCase(), linkedUserId: user.id, firstName: "Training", lastName: key, pool: "ZPP", role: "Member", assignedFunction: "Documentation Support", languages: ["PL"], createdById: adminId, updatedById: adminId } });
      memberIds.push(memberId);
    }
    roleIds.push(role.id);
    userIds.push(user.id);
    actors[key] = { id: user.id, email: user.email, memberId };
    return actors[key]!;
  }

  async function member(label: string, values: Record<string, unknown> = {}) {
    const id = `${marker.toLowerCase()}-member-${label}-${randomUUID().slice(0, 6)}`;
    await prisma!.memberProfile.create({ data: { id, memberId: `${marker}-${label}-${randomUUID().slice(0, 5)}`.toUpperCase(), firstName: "Stage11", lastName: label, pool: "ZPP", role: "Member", assignedFunction: "Family Assistance Team", languages: ["PL"], createdById: adminId, updatedById: adminId, ...values } });
    memberIds.push(id);
    return id;
  }

  async function course(values: Record<string, unknown> = {}) {
    const response = await request(application()).post("/api/training/courses").set(as(actors.manager!.email)).send({ code: `${marker}-${randomUUID().slice(0, 6)}`, title: `${marker} course`, category: "Stage 11", deliveryType: "E-learning", validityMonths: 12, selfCompletable: true, ...values });
    if (response.body.id) courseIds.push(response.body.id);
    return response;
  }

  async function requirement(courseId: string, values: Record<string, unknown> = {}) {
    const response = await request(application()).post("/api/training/requirements").set(as(actors.manager!.email)).send({ courseId, targetType: "MemberProfile", memberProfileId: actors.own!.memberId, requiredStatus: "Required", dueAt: "2026-07-20T00:00:00.000Z", ...values });
    if (response.body.id) requirementIds.push(response.body.id);
    return response;
  }

  async function assign(courseId: string, memberProfileId: string, values: Record<string, unknown> = {}, email = actors.manager!.email) {
    const response = await request(application()).post("/api/training/records/assign").set(as(email)).send({ memberProfileId, courseId, operationId: randomUUID(), ...values });
    if (response.body.id && !recordIds.includes(response.body.id)) recordIds.push(response.body.id);
    if (Array.isArray(response.body.records)) for (const row of response.body.records) if (!recordIds.includes(row.id)) recordIds.push(row.id);
    return response;
  }

  beforeAll(async () => {
    await prisma!.$connect();
    adminId = (await prisma!.user.findUniqueOrThrow({ where: { email: "admin@lot.pl" } })).id;
    const incidents = await Promise.all([
      prisma!.session.create({ data: { operationalId: `${marker}-EXERCISE`, mode: "EXERCISE", status: "Active", eventType: marker, createdById: adminId } }),
      prisma!.session.create({ data: { operationalId: `${marker}-REAL`, mode: "REAL", status: "Active", eventType: marker, createdById: adminId } }),
    ]);
    incidentA = incidents[0]!.id;
    incidentB = incidents[1]!.id;
    incidentIds.push(incidentA, incidentB);
    groupA = `${marker.toLowerCase()}-group-a`;
    groupB = `${marker.toLowerCase()}-group-b`;
    await prisma!.operationalGroup.createMany({ data: [
      { id: groupA, operationalId: `${marker}-GRP-A`, incidentId: incidentA, name: `${marker} Alpha`, pool: "ZPP", functionName: "Training", createdById: adminId, updatedById: adminId },
      { id: groupB, operationalId: `${marker}-GRP-B`, incidentId: incidentB, name: `${marker} Bravo`, pool: "TEC", functionName: "Training", createdById: adminId, updatedById: adminId },
    ] });
    groupIds.push(groupA, groupB);
    const manage = ["session:read", "member:read", "member:create", "member:update", "member:archive", "group:read", "group:update", "group:membership:manage", "training:read-all", "training:course:manage", "training:requirement:manage", "training:assign", "training:complete-all", "training:verify", "training:waive", "readiness:read-all"];
    await actor("manager", manage, incidentIds);
    await actor("verifier", ["session:read", "member:read", "training:read-all", "training:verify"], incidentIds);
    await actor("own", ["session:read", "member:read", "training:read-own", "training:complete-own", "readiness:read-own"], [incidentA], true);
    await actor("scoped", ["session:read", "member:read", "group:read", "training:read-all", "training:requirement:manage", "training:assign", "training:complete-all", "training:verify", "training:waive"], [incidentA], false, groupA);
    await actor("noincident", ["session:read", "member:read", "group:read", "training:read-all", "training:requirement:manage", "training:assign"], [], false, groupA);
    const groupMembers = await Promise.all([member("GroupOne"), member("GroupTwo"), member("GroupThree")]);
    await prisma!.groupMembership.createMany({ data: groupMembers.map((memberProfileId, index) => ({ id: `${marker}-GMB-${index}`, groupId: groupA, memberProfileId, role: index === 0 ? "Leader" : "Member", addedById: adminId })) });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.notification.deleteMany({ where: { OR: [{ sessionId: { in: incidentIds } }, { recipientUserId: { in: userIds } }] } });
    await prisma.notificationOutbox.deleteMany({ where: { OR: [{ sessionId: { in: incidentIds } }, { recipientUserId: { in: userIds } }] } });
    await prisma.trainingOperation.deleteMany({ where: { OR: [{ memberTrainingId: { in: recordIds } }, { result: { path: ["course", "title"], string_contains: marker } }] } }).catch(() => undefined);
    await prisma.memberTrainingRecord.deleteMany({ where: { OR: [{ id: { in: recordIds } }, { memberProfileId: { in: memberIds } }, { courseId: { in: courseIds } }] } });
    await prisma.trainingRequirement.deleteMany({ where: { OR: [{ id: { in: requirementIds } }, { courseId: { in: courseIds } }] } });
    await prisma.trainingCourse.deleteMany({ where: { id: { in: courseIds } } });
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

  it("deploys the Stage 11 schema, constraints, seed and global audit boundary", async () => {
    const migrations = await prisma!.$queryRaw<Array<{ migration_name: string }>>`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`;
    expect(migrations.map(({ migration_name }) => migration_name)).toContain("20260810110000_training_foundation");
    expect(await prisma!.trainingCourse.count()).toBeGreaterThanOrEqual(6);
    expect(await prisma!.trainingRequirement.count()).toBeGreaterThanOrEqual(4);
    expect(await prisma!.memberTrainingRecord.count()).toBeGreaterThanOrEqual(6);
    const constraints = await prisma!.$queryRaw<Array<{ name: string }>>`SELECT conname AS name FROM pg_constraint WHERE conname IN ('TrainingRequirement_target_check', 'MemberTrainingRecord_sourceRequirement_course_fkey', 'MemberTrainingRecord_verified_pair_check', 'MemberTrainingRecord_score_check')`;
    expect(constraints).toHaveLength(4);
    const indexes = await prisma!.$queryRaw<Array<{ indexname: string }>>`SELECT indexname FROM pg_indexes WHERE indexname IN ('TrainingCourse_normalizedCode_key', 'MemberTrainingRecord_active_member_course_key', 'TrainingRequirement_active_target_key')`;
    expect(indexes).toHaveLength(3);
    const created = await course();
    const audit = await prisma!.auditLog.findFirstOrThrow({ where: { entityType: "trainingCourse", entityId: created.body.id } });
    expect(audit.sessionId).toBeNull();
  });

  it("persists courses across app instances and protects normalized code under race", async () => {
    const code = `${marker}-RACE`;
    const race = await Promise.all([course({ code }), course({ code: code.toLowerCase() })]);
    expect(race.map(({ status }) => status).sort()).toEqual([201, 409]);
    const winner = race.find(({ status }) => status === 201)!;
    const restored = await request(application()).get(`/api/training/courses/${winner.body.id}`).set(as(actors.manager!.email));
    expect(restored.body).toMatchObject({ id: winner.body.id, version: 1 });
  });

  it("enforces exact requirement targets and blocks course deactivation until active requirements end", async () => {
    const created = await course();
    const req = await requirement(created.body.id);
    expect(req.status).toBe(201);
    const blocked = await request(application()).post(`/api/training/courses/${created.body.id}/deactivate`).set(as(actors.manager!.email)).send({ expectedVersion: created.body.version });
    expect(blocked.status).toBe(409);
    const ended = await request(application()).post(`/api/training/requirements/${req.body.id}/end`).set(as(actors.manager!.email)).send({ expectedVersion: req.body.version });
    expect(ended.body).toMatchObject({ active: false, version: 2 });
    const deactivated = await request(application()).post(`/api/training/courses/${created.body.id}/deactivate`).set(as(actors.manager!.email)).send({ expectedVersion: created.body.version });
    expect(deactivated.body).toMatchObject({ active: false, version: 2 });
    await expect(prisma!.trainingRequirement.create({ data: { id: `${marker}-bad-target`, courseId: created.body.id, targetType: "Role", targetRole: "ZPP Member", groupId: groupA, requiredStatus: "Required" } })).rejects.toBeTruthy();
  });

  it("serializes course deactivation against requirement creation", async () => {
    const created = await course();
    const [deactivate, addRequirement] = await Promise.all([
      request(application()).post(`/api/training/courses/${created.body.id}/deactivate`).set(as(actors.manager!.email)).send({ expectedVersion: created.body.version }),
      requirement(created.body.id),
    ]);
    expect([deactivate.status, addRequirement.status].filter((status) => status < 300)).toHaveLength(1);
    const storedCourse = await prisma!.trainingCourse.findUniqueOrThrow({ where: { id: created.body.id } });
    const activeRequirements = await prisma!.trainingRequirement.count({ where: { courseId: created.body.id, active: true } });
    expect(storedCourse.active ? activeRequirements : 0).toBe(activeRequirements);
  });

  it("preserves exact targets on partial requirement update and allows ended history", async () => {
    const created = await course();
    const target = await member("RequirementTarget");
    const req = await requirement(created.body.id, { memberProfileId: target });
    expect(req.status).toBe(201);
    expect((await requirement(created.body.id, { memberProfileId: target })).status).toBe(409);
    const updated = await request(application()).patch(`/api/training/requirements/${req.body.id}`).set(as(actors.manager!.email)).send({ expectedVersion: 1, dueAt: "2026-08-01T00:00:00.000Z" });
    expect(updated.body).toMatchObject({ targetType: "MemberProfile", memberProfileId: target, targetRole: null, groupId: null, version: 2 });
    expect((await request(application()).patch(`/api/training/requirements/${req.body.id}`).set(as(actors.manager!.email)).send({ expectedVersion: 1, requiredStatus: "Recommended" })).status).toBe(409);
    expect((await request(application()).post(`/api/training/requirements/${req.body.id}/end`).set(as(actors.manager!.email)).send({ expectedVersion: 2 })).status).toBe(200);
    expect((await requirement(created.body.id, { memberProfileId: target })).status).toBe(201);
    const filtered = await request(application()).get("/api/training/requirements").set(as(actors.manager!.email)).query({ target: target, search: created.body.code, limit: 1 });
    expect(filtered.body).toMatchObject({ total: 2, limit: 1 });
    expect(filtered.body.data).toHaveLength(1);
  });

  it("requires IncidentAssignment for group requirements even with a group-scoped role", async () => {
    const created = await course();
    const payload = { courseId: created.body.id, targetType: "Group", groupId: groupA, requiredStatus: "Required" };
    expect((await request(application()).post("/api/training/requirements").set(as(actors.noincident!.email)).send(payload)).status).toBe(404);
    const allowed = await request(application()).post("/api/training/requirements").set(as(actors.scoped!.email)).send(payload);
    expect(allowed.status).toBe(201);
    requirementIds.push(allowed.body.id);
    const audit = await prisma!.auditLog.findFirstOrThrow({ where: { entityId: allowed.body.id, action: "create_training_requirement" } });
    expect(audit.sessionId).toBe(incidentA);
  });

  it("resolves deterministic Role requirements beyond 200 and rejects unknown role authority", async () => {
    const scale = Array.from({ length: 1005 }, (_, index) => ({ id: `${marker.toLowerCase()}-scale-member-${index}`, memberId: `${marker}-SCALE-${String(index).padStart(4, "0")}`.toUpperCase(), firstName: "Scale", lastName: String(index).padStart(4, "0"), pool: "ZPP", role: "Member", assignedFunction: "Scale", languages: ["PL"], createdById: adminId, updatedById: adminId }));
    await prisma!.memberProfile.createMany({ data: scale });
    memberIds.push(...scale.map(({ id }) => id));
    const created = await course();
    const roleRequirement = await requirement(created.body.id, { targetType: "Role", targetRole: "ZPP Member", memberProfileId: null });
    expect(roleRequirement.status).toBe(201);
    expect(roleRequirement.body.resolvedMemberCount).toBeGreaterThan(1000);
    const unknown = await requirement(created.body.id, { targetType: "Role", targetRole: "ZPP-ish maybe", memberProfileId: null });
    expect(unknown.status).toBe(409);
  });

  it("validates source requirement applicability and the composite course defence", async () => {
    const first = await course();
    const second = await course();
    const req = await requirement(first.body.id);
    const outsider = await member("Outside", { pool: "TEC" });
    expect((await assign(first.body.id, outsider, { sourceRequirementId: req.body.id })).status).toBe(409);
    await expect(prisma!.memberTrainingRecord.create({ data: { id: `${marker}-wrong-source`, operationalId: `${marker}-WRONG-SOURCE`, memberProfileId: outsider, courseId: second.body.id, sourceRequirementId: req.body.id, assignedAt: referenceNow, status: "Assigned" } })).rejects.toBeTruthy();
  });

  it("makes individual assignment retry-safe and protects concurrent active duplicates", async () => {
    const created = await course();
    const target = await member("IndividualRace");
    const operationId = randomUUID();
    const first = await assign(created.body.id, target, { operationId });
    const retry = await assign(created.body.id, target, { operationId });
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ id: first.body.id, idempotent: true });
    const misuse = await assign(created.body.id, actors.own!.memberId!, { operationId });
    expect(misuse.status).toBe(409);
    const anotherCourse = await course();
    const race = await Promise.all([assign(anotherCourse.body.id, target), assign(anotherCourse.body.id, target)]);
    expect(race.map(({ status }) => status).sort()).toEqual([201, 409]);
    expect(await prisma!.memberTrainingRecord.count({ where: { memberProfileId: target, courseId: anotherCourse.body.id, status: { in: ["Assigned", "In Progress"] } } })).toBe(1);
  });

  it("serializes group/group and group/individual assignment with stable bulk replay", async () => {
    const created = await course();
    const operationId = randomUUID();
    const body = { groupId: groupA, courseId: created.body.id, operationId };
    const first = await request(application()).post("/api/training/records/assign").set(as(actors.manager!.email)).send(body);
    const retry = await request(application()).post("/api/training/records/assign").set(as(actors.manager!.email)).send(body);
    recordIds.push(...first.body.records.map((row: any) => row.id));
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.records.map((row: any) => row.id)).toEqual(first.body.records.map((row: any) => row.id));
    const secondCourse = await course();
    const memberId = first.body.records[0].memberProfileId;
    const race = await Promise.all([
      request(application()).post("/api/training/records/assign").set(as(actors.manager!.email)).send({ groupId: groupA, courseId: secondCourse.body.id, operationId: randomUUID() }),
      assign(secondCourse.body.id, memberId),
    ]);
    for (const response of race) if (Array.isArray(response.body.records)) recordIds.push(...response.body.records.map((row: any) => row.id));
    expect(await prisma!.memberTrainingRecord.count({ where: { memberProfileId: memberId, courseId: secondCourse.body.id, status: { in: ["Assigned", "In Progress"] } } })).toBe(1);
  });

  it("takes a coherent membership snapshot while group assignment races removal", async () => {
    const created = await course();
    const target = await member("MembershipRace");
    const groupId = `${marker.toLowerCase()}-membership-race`;
    const membershipId = `${marker}-GMB-RACE`;
    await prisma!.operationalGroup.create({ data: { id: groupId, operationalId: `${marker}-GRP-RACE`, incidentId: incidentA, name: `${marker} Membership race`, pool: "ZPP", functionName: "Training", createdById: adminId, updatedById: adminId } });
    groupIds.push(groupId);
    await prisma!.groupMembership.create({ data: { id: membershipId, groupId, memberProfileId: target, role: "Member", addedById: adminId } });
    const [assignment] = await Promise.all([
      request(application()).post("/api/training/records/assign").set(as(actors.manager!.email)).send({ groupId, courseId: created.body.id, operationId: randomUUID() }),
      prisma!.groupMembership.update({ where: { id: membershipId }, data: { removedAt: referenceNow, removedById: adminId } }),
    ]);
    if (Array.isArray(assignment.body.records)) recordIds.push(...assignment.body.records.map((row: any) => row.id));
    expect([201, 409]).toContain(assignment.status);
    expect(await prisma!.memberTrainingRecord.count({ where: { memberProfileId: target, courseId: created.body.id, status: { in: ["Assigned", "In Progress"] } } })).toBeLessThanOrEqual(1);
  });

  it("keeps archive-vs-assign coherent without deleting historical active training", async () => {
    const created = await course();
    const target = await member("ArchiveRace");
    const current = await prisma!.memberProfile.findUniqueOrThrow({ where: { id: target } });
    await Promise.allSettled([
      request(application()).post(`/api/member-profiles/${target}/archive`).set(as(actors.manager!.email)).send({ expectedVersion: current.version }),
      assign(created.body.id, target),
    ]);
    const archived = await prisma!.memberProfile.findUniqueOrThrow({ where: { id: target } });
    if (archived.status === "Archived") expect((await assign(created.body.id, target)).status).toBe(409);
  });

  it("uses a versioned FSM with one terminal winner and stable command replay", async () => {
    const created = await course({ validityMonths: 1 });
    const first = await assign(created.body.id, actors.own!.memberId!);
    const startOperation = randomUUID();
    const startBody = { expectedVersion: first.body.version, operationId: startOperation };
    const started = await request(application()).post(`/api/training/records/${first.body.id}/start`).set(as(actors.own!.email)).send(startBody);
    const startRetry = await request(application()).post(`/api/training/records/${first.body.id}/start`).set(as(actors.own!.email)).send(startBody);
    expect(started.body).toMatchObject({ baseStatus: "In Progress", startedById: actors.own!.id, version: 2 });
    expect(startRetry.body).toMatchObject({ idempotent: true, version: 2 });
    const complete = { expectedVersion: 2, operationId: randomUUID(), completedAt: "2027-01-31T10:00:00.000Z" };
    const race = await Promise.all([
      request(application()).post(`/api/training/records/${first.body.id}/complete`).set(as(actors.own!.email)).send(complete),
      request(application()).post(`/api/training/records/${first.body.id}/cancel`).set(as(actors.manager!.email)).send({ expectedVersion: 2, operationId: randomUUID(), reason: "Concurrent cancellation" }),
    ]);
    expect(race.map(({ status }) => status).sort()).toEqual([200, 409]);
    const stored = await prisma!.memberTrainingRecord.findUniqueOrThrow({ where: { id: first.body.id } });
    if (stored.status === "Completed") {
      expect(stored.completedById).toBe(actors.own!.id);
      expect(stored.expiryAt?.toISOString()).toBe("2027-02-28T10:00:00.000Z");
    }
  });

  it("allows only one start and one terminal outcome under competing operationIds", async () => {
    const startCourse = await course();
    const startTarget = await member("StartRace");
    const startRecord = await assign(startCourse.body.id, startTarget);
    const starts = await Promise.all([
      request(application()).post(`/api/training/records/${startRecord.body.id}/start`).set(as(actors.manager!.email)).send({ expectedVersion: 1, operationId: randomUUID() }),
      request(application()).post(`/api/training/records/${startRecord.body.id}/start`).set(as(actors.manager!.email)).send({ expectedVersion: 1, operationId: randomUUID() }),
    ]);
    expect(starts.map(({ status }) => status).sort()).toEqual([200, 409]);

    const terminalCourse = await course();
    const terminalTarget = await member("CompleteWaiveRace");
    const terminalRecord = await assign(terminalCourse.body.id, terminalTarget);
    const outcomes = await Promise.all([
      request(application()).post(`/api/training/records/${terminalRecord.body.id}/complete`).set(as(actors.manager!.email)).send({ expectedVersion: 1, operationId: randomUUID(), completedAt: referenceNow.toISOString() }),
      request(application()).post(`/api/training/records/${terminalRecord.body.id}/waive`).set(as(actors.manager!.email)).send({ expectedVersion: 1, operationId: randomUUID(), reason: "Equivalent prior qualification" }),
    ]);
    expect(outcomes.map(({ status }) => status).sort()).toEqual([200, 409]);
    expect(["Completed", "Waived"]).toContain((await prisma!.memberTrainingRecord.findUniqueOrThrow({ where: { id: terminalRecord.body.id } })).status);
  });

  it("allows only one immutable verifier and idempotent verification retry", async () => {
    const created = await course();
    const assigned = await assign(created.body.id, actors.own!.memberId!);
    const completed = await request(application()).post(`/api/training/records/${assigned.body.id}/complete`).set(as(actors.own!.email)).send({ expectedVersion: 1, operationId: randomUUID(), completedAt: "2026-07-13T08:00:00.000Z" });
    expect(completed.body).toMatchObject({ verificationStatus: "Pending", verifiedAt: null });
    const managerOperationId = randomUUID();
    const verifierOperationId = randomUUID();
    const body = { expectedVersion: completed.body.version, operationId: managerOperationId };
    const race = await Promise.all([
      request(application()).post(`/api/training/records/${assigned.body.id}/verify`).set(as(actors.manager!.email)).send(body),
      request(application()).post(`/api/training/records/${assigned.body.id}/verify`).set(as(actors.verifier!.email)).send({ ...body, operationId: verifierOperationId }),
    ]);
    expect(race.map(({ status }) => status).sort()).toEqual([200, 409]);
    const winner = race.find(({ status }) => status === 200)!;
    const retryBody = { ...body, operationId: winner.body.verifiedById === actors.manager!.id ? managerOperationId : verifierOperationId };
    const retry = await request(application()).post(`/api/training/records/${assigned.body.id}/verify`).set(as(winner.body.verifiedById === actors.manager!.id ? actors.manager!.email : actors.verifier!.email)).send(retryBody);
    expect(retry.body).toMatchObject({ idempotent: true, verifiedById: winner.body.verifiedById });
    expect((await prisma!.memberTrainingRecord.findUniqueOrThrow({ where: { id: assigned.body.id } })).verifiedById).toBe(winner.body.verifiedById);
  });

  it("derives expiry, overdue and expiring-soon from the injected clock at exact boundaries", async () => {
    const created = await course();
    const target = await member("Clock");
    const id = `${marker}-clock-record`;
    await prisma!.memberTrainingRecord.create({ data: { id, operationalId: `${marker}-CLOCK`, memberProfileId: target, courseId: created.body.id, assignedAt: new Date("2026-07-01T00:00:00Z"), dueAt: new Date("2026-07-13T09:00:00Z"), status: "Completed", completedAt: new Date("2025-07-13T09:00:00Z"), expiryAt: new Date("2026-07-13T09:00:00Z"), legacyImported: true } });
    recordIds.push(id);
    referenceNow = new Date("2026-05-29T09:00:00.000Z");
    const expiringBoundary = await request(application()).get("/api/training/records").set(as(actors.manager!.email)).query({ search: `${marker}-CLOCK`, limit: 10 });
    expect(expiringBoundary.body.data[0]).toMatchObject({ status: "Completed", isExpiringSoon: true });
    referenceNow = new Date("2026-05-29T08:59:59.999Z");
    const beforeExpiringWindow = await request(application()).get("/api/training/records").set(as(actors.manager!.email)).query({ search: `${marker}-CLOCK`, limit: 10 });
    expect(beforeExpiringWindow.body.data[0]).toMatchObject({ status: "Completed", isExpiringSoon: false });
    referenceNow = new Date("2026-07-13T08:59:59.999Z");
    const beforeExpiry = await request(application()).get("/api/training/records").set(as(actors.manager!.email)).query({ search: `${marker}-CLOCK`, limit: 10 });
    expect(beforeExpiry.body.data[0]).toMatchObject({ status: "Completed", isExpiringSoon: true });
    referenceNow = new Date("2026-07-13T09:00:00.000Z");
    const exact = await request(application()).get("/api/training/records").set(as(actors.manager!.email)).query({ search: `${marker}-CLOCK`, limit: 10 });
    expect(exact.body.data[0]).toMatchObject({ status: "Completed", isExpiringSoon: true });
    referenceNow = new Date("2026-07-13T09:00:00.001Z");
    const after = await request(application()).get("/api/training/records").set(as(actors.manager!.email)).query({ search: `${marker}-CLOCK`, limit: 10 });
    expect(after.body.data[0]).toMatchObject({ status: "Expired", isExpiringSoon: false });

    const overdueId = `${marker}-overdue-record`;
    await prisma!.memberTrainingRecord.create({ data: { id: overdueId, operationalId: `${marker}-OVERDUE`, memberProfileId: target, courseId: created.body.id, assignedAt: new Date("2026-07-01T00:00:00Z"), dueAt: new Date("2026-07-20T09:00:00Z"), status: "Assigned", legacyImported: true } });
    recordIds.push(overdueId);
    referenceNow = new Date("2026-07-20T09:00:00.000Z");
    expect((await request(application()).get("/api/training/records").set(as(actors.manager!.email)).query({ search: `${marker}-OVERDUE`, limit: 10 })).body.data[0].isOverdue).toBe(false);
    referenceNow = new Date("2026-07-20T09:00:00.001Z");
    expect((await request(application()).get("/api/training/records").set(as(actors.manager!.email)).query({ search: `${marker}-OVERDUE`, limit: 10 })).body.data[0].isOverdue).toBe(true);
    referenceNow = new Date("2026-07-13T09:00:00.000Z");
  });

  it("uses clamped UTC calendar-month arithmetic for month ends, leap years, 12 and 24 months", async () => {
    const target = await member("CalendarMonths");
    const cases = [
      { months: 1, completedAt: "2023-01-31T10:15:00.000Z", expiryAt: "2023-02-28T10:15:00.000Z" },
      { months: 1, completedAt: "2024-01-31T10:15:00.000Z", expiryAt: "2024-02-29T10:15:00.000Z" },
      { months: 12, completedAt: "2024-02-29T10:15:00.000Z", expiryAt: "2025-02-28T10:15:00.000Z" },
      { months: 24, completedAt: "2024-02-29T10:15:00.000Z", expiryAt: "2026-02-28T10:15:00.000Z" },
    ];
    for (const item of cases) {
      const created = await course({ validityMonths: item.months });
      const assigned = await assign(created.body.id, target);
      const completed = await request(application()).post(`/api/training/records/${assigned.body.id}/complete`).set(as(actors.manager!.email)).send({ expectedVersion: 1, operationId: randomUUID(), completedAt: item.completedAt });
      expect(completed.body.expiryAt).toBe(item.expiryAt);
    }
  });

  it("isolates own and group-scoped record reads", async () => {
    const created = await course();
    const ownRecord = await assign(created.body.id, actors.own!.memberId!);
    const groupMember = await member("ScopedVisible");
    await prisma!.groupMembership.create({ data: { id: `${marker}-GMB-SCOPED`, groupId: groupA, memberProfileId: groupMember, role: "Member", addedById: adminId } });
    const groupRecord = await assign(created.body.id, groupMember);
    const hiddenMember = await member("ScopedHidden");
    await prisma!.groupMembership.create({ data: { id: `${marker}-GMB-HIDDEN`, groupId: groupB, memberProfileId: hiddenMember, role: "Member", addedById: adminId } });
    const hiddenRecord = await assign(created.body.id, hiddenMember);
    const ownPage = await request(application()).get("/api/training/records").set(as(actors.own!.email)).query({ mine: true, limit: 200 });
    expect(ownPage.body.data.some((row: any) => row.id === ownRecord.body.id)).toBe(true);
    expect(ownPage.body.data.some((row: any) => row.id === groupRecord.body.id)).toBe(false);
    expect((await request(application()).get(`/api/training/records/${groupRecord.body.id}`).set(as(actors.own!.email))).status).toBe(404);
    expect((await request(application()).get(`/api/training/records/${groupRecord.body.id}`).set(as(actors.scoped!.email))).status).toBe(200);
    expect((await request(application()).get(`/api/training/records/${hiddenRecord.body.id}`).set(as(actors.scoped!.email))).status).toBe(404);
  });

  it("enforces selfCompletable and feeds Readiness and Member projections without write-back", async () => {
    const blockedCourse = await course({ selfCompletable: false });
    const blocked = await assign(blockedCourse.body.id, actors.own!.memberId!);
    expect((await request(application()).post(`/api/training/records/${blocked.body.id}/complete`).set(as(actors.own!.email)).send({ expectedVersion: 1, operationId: randomUUID(), completedAt: referenceNow.toISOString() })).status).toBe(403);
    await request(application()).post(`/api/training/records/${blocked.body.id}/cancel`).set(as(actors.manager!.email)).send({ expectedVersion: 1, operationId: randomUUID(), reason: "Replace with self course" });
    const selfCourse = await course({ selfCompletable: true });
    const req = await requirement(selfCourse.body.id);
    const assigned = await assign(selfCourse.body.id, actors.own!.memberId!, { sourceRequirementId: req.body.id, dueAt: "2026-07-12T00:00:00Z" });
    const before = await prisma!.memberProfile.findUniqueOrThrow({ where: { id: actors.own!.memberId } });
    const completed = await request(application()).post(`/api/training/records/${assigned.body.id}/complete`).set(as(actors.own!.email)).send({ expectedVersion: 1, operationId: randomUUID(), completedAt: referenceNow.toISOString() });
    expect(completed.body.verificationStatus).toBe("Pending");
    const readiness = await request(application()).get("/api/readiness/me").set(as(actors.own!.email)).query({ evaluationAt: referenceNow.toISOString() });
    expect(readiness.status).toBe(200);
    const memberProjection = await request(application()).get(`/api/member-profiles/${actors.own!.memberId}`).set(as(actors.manager!.email));
    expect(memberProjection.body.derivedFields.trainingStatus).toBe("postgres-projection");
    expect(memberProjection.body.trainingStatus).toMatch(/Compliant|Attention|Non-compliant|Not applicable/);
    const after = await prisma!.memberProfile.findUniqueOrThrow({ where: { id: actors.own!.memberId } });
    expect(after.legacyTrainingStatus).toBe(before.legacyTrainingStatus);
    expect(after.version).toBe(before.version);
  });

  it("keeps committed assignment when best-effort notification delivery fails", async () => {
    const created = await course();
    const target = await member("Notification");
    const response = await request(application(() => { throw new Error("notification unavailable"); })).post("/api/training/records/assign").set(as(actors.manager!.email)).send({ memberProfileId: target, courseId: created.body.id, operationId: randomUUID() });
    recordIds.push(response.body.id);
    expect(response.status).toBe(201);
    expect(await prisma!.memberTrainingRecord.count({ where: { id: response.body.id } })).toBe(1);
  });

  it("paginates and filters 1000+ durable records without fetch-all", async () => {
    const created = await course();
    const scaleMembers = memberIds.filter((id) => id.includes("scale-member")).slice(0, 1000);
    const rows = scaleMembers.map((memberProfileId, index) => ({ id: `${marker}-scale-record-${index}`, operationalId: `${marker}-TRN-${String(index).padStart(4, "0")}`, memberProfileId, courseId: created.body.id, assignedAt: new Date("2026-07-01T00:00:00Z"), dueAt: new Date(2026, 6, 20, 0, index), status: index % 2 ? "Assigned" : "Completed", completedAt: index % 2 ? null : new Date("2026-07-02T00:00:00Z"), expiryAt: index % 2 ? null : new Date("2027-07-02T00:00:00Z"), legacyImported: true }));
    await prisma!.memberTrainingRecord.createMany({ data: rows });
    recordIds.push(...rows.map(({ id }) => id));
    const page = await request(application()).get("/api/training/records").set(as(actors.manager!.email)).query({ courseId: created.body.id, status: "Assigned", limit: 37, offset: 74, sort: "due", direction: "asc" });
    expect(page.body).toMatchObject({ total: 500, limit: 37, offset: 74 });
    expect(page.body.data).toHaveLength(37);
    expect(page.body.totals.assigned).toBeGreaterThanOrEqual(500);
  });
});
