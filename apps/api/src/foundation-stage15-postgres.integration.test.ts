import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createPrismaOperationalBriefingService } from "./modules/briefings/prisma-operational-briefing-service.js";
import { EffectiveAccessService } from "./modules/identity/effective-access-service.js";
import { createNotificationDispatcher } from "./modules/notifications/notification-dispatcher.js";
import { createPrismaNotificationRepository } from "./modules/notifications/prisma-notification-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;
const prisma = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;
const as = (email: string) => ({ "x-user-email": email });

function expectControlledServiceRace(results: PromiseSettledResult<unknown>[]) {
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  expect(rejected).toHaveLength(1);
  expect(rejected[0]!.reason).toMatchObject({ status: 409 });
  expect(rejected[0]!.reason).not.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  expect(String(rejected[0]!.reason?.message ?? rejected[0]!.reason)).not.toMatch(/P2034|Prisma|serializ|SQL|constraint/i);
}

function expectControlledHttpRace(responses: Array<{ status: number; body: unknown }>) {
  expect(responses.map((response) => response.status).sort((left, right) => left - right)).toEqual([200, 409]);
  const conflict = responses.find((response) => response.status === 409);
  expect(conflict?.body).toMatchObject({ error: expect.any(String) });
  expect(JSON.stringify(conflict?.body)).not.toMatch(/P2034|Prisma|transaction|serializ|SQL|OperationalBriefing|constraint/i);
}

postgresDescribe("Foundation Stage 15 PostgreSQL Operational Briefings and Active Event integrity", () => {
  const marker = `F15-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const permissions = [
    "session:read", "briefing:read", "briefing:read-history", "briefing:create-draft", "briefing:update-draft", "briefing:publish",
    "assignment:read", "assignment:assign", "enquiry:read", "matching:read", "request:read", "release:read", "passenger:read",
  ];
  const incidentIds: string[] = [];
  const userIds: string[] = [];
  const roleIds: string[] = [];
  const groupIds: string[] = [];
  let coordinator: { id: string; email: string };
  let operator: { id: string; email: string };
  let operatorRoleId: string;

  const actor = () => ({ id: operator.id, email: operator.email, displayName: "Stage 15 operator", roles: ["stage15-operator"], permissions });

  async function incident(suffix: string, status = "Active") {
    const row = await prisma!.session.create({ data: { operationalId: `${marker}-${suffix}`, mode: "EXERCISE", status, eventType: marker, createdById: coordinator.id } });
    incidentIds.push(row.id);
    await prisma!.incidentAssignment.createMany({ data: [coordinator.id, operator.id].map((userId) => ({ incidentId: row.id, userId, function: marker, createdById: coordinator.id })) });
    return row;
  }

  async function validDraft(sessionId: string, service = createPrismaOperationalBriefingService(prisma!)) {
    const created = await service.createDraft(sessionId, actor());
    const updated = await service.updateDraft(created.briefing.id, {
      expectedVersion: created.briefing.version,
      title: `${marker} briefing`,
      situationSummary: "Durable Stage 15 operational situation.",
      confirmedFacts: [{ statement: "Database-backed fact", source: "Stage 15 test" }],
      priorities: [{ description: "Preserve transactional integrity", status: "Not started" }],
      risks: [{ description: "Concurrent mutation", severity: "Attention", status: "Open" }],
    }, actor());
    return updated.briefing;
  }

  beforeAll(async () => {
    coordinator = await prisma!.user.findUniqueOrThrow({ where: { email: "coordinator@lot.pl" }, select: { id: true, email: true } });
    const role = await prisma!.role.create({ data: { name: `${marker.toLowerCase()}-operator`, displayName: `${marker} operator`, permissions, scopeTypes: ["GLOBAL"], custom: true } });
    roleIds.push(role.id);
    operatorRoleId = role.id;
    operator = await prisma!.user.create({ data: { email: `${marker.toLowerCase()}-operator@example.test`, normalizedEmail: `${marker.toLowerCase()}-operator@example.test`, displayName: `${marker} operator`, status: "Active", authenticationPolicy: "SSO_ONLY" }, select: { id: true, email: true } });
    userIds.push(operator.id);
    await prisma!.userRole.create({ data: { userId: operator.id, roleId: role.id, scopeType: "GLOBAL", assignedBy: coordinator.id } });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.notification.deleteMany({ where: { OR: [{ sessionId: { in: incidentIds } }, { recipientUserId: { in: userIds } }] } });
    await prisma.notificationOutbox.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.permissionOverride.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.groupRoleAssignment.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { groupId: { in: groupIds } }] } });
    await prisma.operationalGroup.deleteMany({ where: { id: { in: groupIds } } });
    await prisma.operationalBriefing.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.assignmentTask.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.caseTimelineEvent.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ sessionId: { in: incidentIds } }, { actorId: { in: userIds } }] } });
    await prisma.incidentAssignment.deleteMany({ where: { OR: [{ incidentId: { in: incidentIds } }, { userId: { in: userIds } }] } });
    await prisma.session.deleteMany({ where: { id: { in: incidentIds } } });
    await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.role.deleteMany({ where: { id: { in: roleIds } } });
    await prisma.$disconnect();
  });

  it("retains Operational Briefing constraints after all 19 Foundation migrations", async () => {
    const migrations = await prisma!.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    const indexes = await prisma!.$queryRaw<Array<{ indexname: string }>>`SELECT indexname FROM pg_indexes WHERE tablename = 'OperationalBriefing'`;
    const checks = await prisma!.$queryRaw<Array<{ conname: string }>>`SELECT conname FROM pg_constraint WHERE conrelid = '"OperationalBriefing"'::regclass AND contype = 'c'`;
    expect(Number(migrations[0]!.count)).toBe(21);
    expect(indexes.map((row) => row.indexname)).toEqual(expect.arrayContaining(["OperationalBriefing_one_draft_per_session", "OperationalBriefing_one_published_per_session", "OperationalBriefing_sessionId_revision_key"]));
    expect(checks.map((row) => row.conname)).toEqual(expect.arrayContaining(["OperationalBriefing_revision_positive", "OperationalBriefing_version_positive", "OperationalBriefing_status_valid", "OperationalBriefing_publication_state_valid"]));
  });

  it("serializes 20 createDraft calls to one deterministic Draft and revision", async () => {
    const session = await incident("CREATE-20");
    const service = createPrismaOperationalBriefingService(prisma!);
    const results = await Promise.all(Array.from({ length: 20 }, () => service.createDraft(session.id, actor())));
    expect(new Set(results.map((result) => result.briefing.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await prisma!.operationalBriefing.count({ where: { sessionId: session.id, status: "Draft" } })).toBe(1);
    expect(await prisma!.auditLog.count({ where: { sessionId: session.id, action: "briefing_draft_created" } })).toBe(1);
  });

  it("preserves child provenance, rejects stale updates and rolls back a cross-Incident child payload", async () => {
    const [sessionA, sessionB] = await Promise.all([incident("UPDATE-A"), incident("UPDATE-B")]);
    const assignmentA = await prisma!.assignmentTask.create({ data: { operationalId: `${marker}-ASN-A`, sessionId: sessionA.id, title: "A", status: "Open", assignedUserId: operator.id, createdById: operator.id, updatedById: operator.id } });
    const assignmentB = await prisma!.assignmentTask.create({ data: { operationalId: `${marker}-ASN-B`, sessionId: sessionB.id, title: "B", status: "Open", assignedUserId: operator.id, createdById: operator.id, updatedById: operator.id } });
    const service = createPrismaOperationalBriefingService(prisma!);
    const draft = await validDraft(sessionA.id, service);
    const fact = draft.confirmedFacts[0]!;
    const saved = await service.updateDraft(draft.id, { expectedVersion: draft.version, confirmedFacts: [{ ...fact, statement: "Edited durable fact" }], priorities: [{ ...draft.priorities[0], linkedAssignmentId: assignmentA.id }], risks: draft.risks }, actor());
    expect(saved.briefing.confirmedFacts[0]).toMatchObject({ id: fact.id, createdAt: fact.createdAt, createdById: fact.createdById, statement: "Edited durable fact" });
    await expect(service.updateDraft(draft.id, { expectedVersion: draft.version, title: "Stale" }, actor())).rejects.toMatchObject({ status: 409 });
    const before = await prisma!.operationalBriefing.findUniqueOrThrow({ where: { id: draft.id }, include: { confirmedFacts: true, priorities: true, risks: true } });
    await expect(service.updateDraft(draft.id, { expectedVersion: saved.briefing.version, confirmedFacts: [{ ...saved.briefing.confirmedFacts[0], statement: "Must roll back" }], priorities: [{ ...saved.briefing.priorities[0], linkedAssignmentId: assignmentB.id }], risks: [{ ...saved.briefing.risks[0], description: "Must roll back" }] }, actor())).rejects.toMatchObject({ status: 409 });
    const after = await prisma!.operationalBriefing.findUniqueOrThrow({ where: { id: draft.id }, include: { confirmedFacts: true, priorities: true, risks: true } });
    expect(after).toEqual(before);
    expect(await prisma!.auditLog.count({ where: { sessionId: sessionA.id, action: "briefing_draft_updated" } })).toBe(2);
  });

  it("publishes once under a same-version race and survives fresh app instances", async () => {
    const session = await incident("PUBLISH-RACE");
    const service = createPrismaOperationalBriefingService(prisma!);
    const draft = await validDraft(session.id, service);
    const restartedDraft = await createPrismaOperationalBriefingService(prisma!).getBriefing(draft.id, actor());
    expect(restartedDraft).toMatchObject({ id: draft.id, status: "Draft", situationSummary: "Durable Stage 15 operational situation.", version: draft.version });
    const attempts = await Promise.allSettled([service.publishDraft(draft.id, draft.version, actor()), service.publishDraft(draft.id, draft.version, actor())]);
    expectControlledServiceRace(attempts);
    expect(await prisma!.operationalBriefing.count({ where: { sessionId: session.id, status: "Published" } })).toBe(1);
    expect(await prisma!.auditLog.count({ where: { sessionId: session.id, action: "briefing_published" } })).toBe(1);
    expect(await prisma!.caseTimelineEvent.count({ where: { sessionId: session.id, eventType: "briefing" } })).toBe(1);
    expect(await prisma!.notificationOutbox.count({ where: { sessionId: session.id, eventType: "BRIEFING_PUBLISHED" } })).toBe(1);
    const intent = await prisma!.notificationOutbox.findFirstOrThrow({ where: { sessionId: session.id, eventType: "BRIEFING_PUBLISHED" } });
    expect(Object.keys(intent.payload as Record<string, unknown>).sort()).toEqual(["occurredAt", "revision"]);
    const restored = await request(createApp()).get(`/api/sessions/${session.id}/briefings/current`).set(as(operator.email));
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(restored.body).toMatchObject({ id: draft.id, status: "Published" });
  });

  it("returns HTTP 200/409 for a same-version publish race without duplicate side effects", async () => {
    const session = await incident("HTTP-PUBLISH-RACE");
    const draft = await validDraft(session.id);
    const app = createApp();
    const responses = await Promise.all([
      request(app).post(`/api/briefings/${draft.id}/publish`).set(as(operator.email)).send({ expectedVersion: draft.version }),
      request(app).post(`/api/briefings/${draft.id}/publish`).set(as(operator.email)).send({ expectedVersion: draft.version }),
    ]);
    expectControlledHttpRace(responses);
    expect(await prisma!.operationalBriefing.count({ where: { sessionId: session.id, status: "Published" } })).toBe(1);
    expect(await prisma!.auditLog.count({ where: { sessionId: session.id, action: "briefing_published" } })).toBe(1);
    expect(await prisma!.caseTimelineEvent.count({ where: { sessionId: session.id, eventType: "briefing" } })).toBe(1);
    expect(await prisma!.notificationOutbox.count({ where: { sessionId: session.id, eventType: "BRIEFING_PUBLISHED" } })).toBe(1);
  });

  it("returns HTTP 200/409 for same-version updates and commits only the winner", async () => {
    const session = await incident("HTTP-UPDATE-RACE");
    const draft = await validDraft(session.id);
    const app = createApp();
    const responses = await Promise.all([
      request(app).patch(`/api/briefings/${draft.id}`).set(as(operator.email)).send({ expectedVersion: draft.version, overview: "HTTP update A", confirmedFacts: [{ ...draft.confirmedFacts[0], statement: "HTTP fact A" }] }),
      request(app).patch(`/api/briefings/${draft.id}`).set(as(operator.email)).send({ expectedVersion: draft.version, overview: "HTTP update B", confirmedFacts: [{ ...draft.confirmedFacts[0], statement: "HTTP fact B" }] }),
    ]);
    expectControlledHttpRace(responses);
    const current = await prisma!.operationalBriefing.findUniqueOrThrow({ where: { id: draft.id }, include: { confirmedFacts: true } });
    expect(current).toMatchObject({ status: "Draft", version: draft.version + 1 });
    expect(current.overview).toMatch(/^HTTP update [AB]$/);
    expect(current.confirmedFacts).toHaveLength(1);
    expect(current.confirmedFacts[0]!.statement).toBe(current.overview === "HTTP update A" ? "HTTP fact A" : "HTTP fact B");
    expect(await prisma!.auditLog.count({ where: { sessionId: session.id, action: "briefing_draft_updated" } })).toBe(2);
  });

  it("returns HTTP 200/409 for update versus publish with no loser side effects", async () => {
    const session = await incident("HTTP-UPDATE-PUBLISH-RACE");
    const draft = await validDraft(session.id);
    const app = createApp();
    const responses = await Promise.all([
      request(app).patch(`/api/briefings/${draft.id}`).set(as(operator.email)).send({ expectedVersion: draft.version, overview: "HTTP update won" }),
      request(app).post(`/api/briefings/${draft.id}/publish`).set(as(operator.email)).send({ expectedVersion: draft.version }),
    ]);
    expectControlledHttpRace(responses);
    const publishSucceeded = responses[1]!.status === 200;
    const current = await prisma!.operationalBriefing.findUniqueOrThrow({ where: { id: draft.id } });
    expect(current.status).toBe(publishSucceeded ? "Published" : "Draft");
    expect(current.version).toBe(draft.version + 1);
    expect(await prisma!.auditLog.count({ where: { sessionId: session.id, action: "briefing_published" } })).toBe(publishSucceeded ? 1 : 0);
    expect(await prisma!.caseTimelineEvent.count({ where: { sessionId: session.id, eventType: "briefing" } })).toBe(publishSucceeded ? 1 : 0);
    expect(await prisma!.notificationOutbox.count({ where: { sessionId: session.id, eventType: "BRIEFING_PUBLISHED" } })).toBe(publishSucceeded ? 1 : 0);
    expect(await prisma!.auditLog.count({ where: { sessionId: session.id, action: "briefing_draft_updated" } })).toBe(publishSucceeded ? 1 : 2);
  });

  it("serializes two-user updates and createDraft versus publish without an invalid revision graph", async () => {
    const session = await incident("MULTI-RACE");
    const service = createPrismaOperationalBriefingService(prisma!);
    const draft = await validDraft(session.id, service);
    const coordinatorActor = { ...actor(), id: coordinator.id, email: coordinator.email, displayName: "Coordinator" };
    const updates = await Promise.allSettled([
      service.updateDraft(draft.id, { expectedVersion: draft.version, overview: "Operator wins", confirmedFacts: [{ ...draft.confirmedFacts[0], statement: "Operator fact wins" }] }, actor()),
      service.updateDraft(draft.id, { expectedVersion: draft.version, overview: "Coordinator wins", confirmedFacts: [{ ...draft.confirmedFacts[0], statement: "Coordinator fact wins" }] }, coordinatorActor),
    ]);
    expectControlledServiceRace(updates);
    const current = await prisma!.operationalBriefing.findUniqueOrThrow({ where: { id: draft.id }, include: { confirmedFacts: true } });
    expect(current.version).toBe(draft.version + 1);
    expect(current.overview).toMatch(/^(Operator|Coordinator) wins$/);
    expect(current.confirmedFacts).toHaveLength(1);
    expect(current.confirmedFacts[0]!.statement).toBe(current.overview === "Operator wins" ? "Operator fact wins" : "Coordinator fact wins");
    expect(await prisma!.auditLog.count({ where: { sessionId: session.id, action: "briefing_draft_updated" } })).toBe(2);
    const graphRace = await Promise.allSettled([
      service.publishDraft(draft.id, current.version, actor()),
      service.createDraft(session.id, coordinatorActor),
    ]);
    expect(graphRace.some((result) => result.status === "fulfilled")).toBe(true);
    for (const result of graphRace) if (result.status === "rejected") {
      expect(result.reason).toMatchObject({ status: 409 });
      expect(result.reason).not.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    }
    expect(await prisma!.operationalBriefing.count({ where: { sessionId: session.id, status: "Published" } })).toBe(1);
    expect(await prisma!.operationalBriefing.count({ where: { sessionId: session.id, status: "Draft" } })).toBeLessThanOrEqual(1);
    const revisions = await prisma!.operationalBriefing.findMany({ where: { sessionId: session.id }, orderBy: { revision: "asc" }, select: { revision: true } });
    expect(new Set(revisions.map((row) => row.revision)).size).toBe(revisions.length);
  });

  it("serializes publication against Incident closure and blocks every later write", async () => {
    const session = await incident("CLOSE-RACE");
    const service = createPrismaOperationalBriefingService(prisma!);
    const draft = await validDraft(session.id, service);
    const race = await Promise.allSettled([
      service.publishDraft(draft.id, draft.version, actor()),
      prisma!.session.update({ where: { id: session.id }, data: { status: "Closed", endAt: new Date() } }),
    ]);
    const publicationSucceeded = race[0]!.status === "fulfilled";
    if (race[0]!.status === "rejected") {
      expect(race[0]!.reason).toMatchObject({ status: 409 });
      expect(race[0]!.reason).not.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    }
    expect(await prisma!.operationalBriefing.count({ where: { sessionId: session.id, status: "Published" } })).toBe(publicationSucceeded ? 1 : 0);
    expect(await prisma!.auditLog.count({ where: { sessionId: session.id, action: "briefing_published" } })).toBe(publicationSucceeded ? 1 : 0);
    expect(await prisma!.caseTimelineEvent.count({ where: { sessionId: session.id, eventType: "briefing" } })).toBe(publicationSucceeded ? 1 : 0);
    expect(await prisma!.notificationOutbox.count({ where: { sessionId: session.id, eventType: "BRIEFING_PUBLISHED" } })).toBe(publicationSucceeded ? 1 : 0);
    await expect(service.createDraft(session.id, actor())).rejects.toMatchObject({ status: 409 });
    const row = await prisma!.operationalBriefing.findUniqueOrThrow({ where: { id: draft.id } });
    if (row.status === "Draft") {
      await expect(service.updateDraft(row.id, { expectedVersion: row.version, title: "Closed write" }, actor())).rejects.toMatchObject({ status: 409 });
      await expect(service.publishDraft(row.id, row.version, actor())).rejects.toMatchObject({ status: 409 });
    }
  });

  it("serializes update versus publish and maintains monotonic superseded history", async () => {
    const session = await incident("LIFECYCLE");
    const service = createPrismaOperationalBriefingService(prisma!);
    const firstDraft = await validDraft(session.id, service);
    const race = await Promise.allSettled([
      service.updateDraft(firstDraft.id, { expectedVersion: firstDraft.version, overview: "Concurrent update" }, actor()),
      service.publishDraft(firstDraft.id, firstDraft.version, actor()),
    ]);
    expectControlledServiceRace(race);
    let currentDraft = await prisma!.operationalBriefing.findFirst({ where: { sessionId: session.id, status: "Draft" } });
    if (currentDraft) await service.publishDraft(currentDraft.id, currentDraft.version, actor());
    const next = await service.createDraft(session.id, actor());
    expect(next.briefing).toMatchObject({ revision: 2, status: "Draft", situationSummary: "Durable Stage 15 operational situation." });
    const nextValid = await service.updateDraft(next.briefing.id, { expectedVersion: next.briefing.version, priorities: next.briefing.priorities, situationSummary: "Second durable revision." }, actor());
    await service.publishDraft(next.briefing.id, nextValid.briefing.version, actor());
    const history = await service.listRevisions(session.id, actor(), { limit: 1, offset: 0 });
    expect(history).toMatchObject({ total: 2, limit: 1, offset: 0 });
    expect(history.data).toHaveLength(1);
    expect(await prisma!.operationalBriefing.count({ where: { sessionId: session.id, status: "Published" } })).toBe(1);
    expect(await prisma!.operationalBriefing.count({ where: { sessionId: session.id, status: "Superseded" } })).toBe(1);
    await expect(service.updateDraft(firstDraft.id, { expectedVersion: 1, title: "Forbidden history edit" }, actor())).rejects.toMatchObject({ status: 409 });
  });

  it("rolls back all state when transactional Audit or Outbox persistence fails", async () => {
    const auditSession = await incident("AUDIT-ROLLBACK");
    const auditFailure = createPrismaOperationalBriefingService(prisma!, { beforeAudit: () => { throw new Error("injected audit failure"); } });
    await expect(auditFailure.createDraft(auditSession.id, actor())).rejects.toThrow("injected audit failure");
    expect(await prisma!.operationalBriefing.count({ where: { sessionId: auditSession.id } })).toBe(0);

    const outboxSession = await incident("OUTBOX-ROLLBACK");
    const normal = createPrismaOperationalBriefingService(prisma!);
    const draft = await validDraft(outboxSession.id, normal);
    const outboxFailure = createPrismaOperationalBriefingService(prisma!, { beforeOutbox: () => { throw new Error("injected outbox failure"); } });
    await expect(outboxFailure.publishDraft(draft.id, draft.version, actor())).rejects.toThrow("injected outbox failure");
    expect(await prisma!.operationalBriefing.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({ status: "Draft", version: draft.version });
    expect(await prisma!.caseTimelineEvent.count({ where: { sessionId: outboxSession.id } })).toBe(0);
    expect(await prisma!.notificationOutbox.count({ where: { sessionId: outboxSession.id } })).toBe(0);
    expect(await prisma!.auditLog.count({ where: { sessionId: outboxSession.id, action: "briefing_published" } })).toBe(0);
  });

  it("dispatches BRIEFING_PUBLISHED through EffectiveAccess with retry and no duplicate notification", async () => {
    const session = await incident("DISPATCH");
    const service = createPrismaOperationalBriefingService(prisma!);
    const draft = await validDraft(session.id, service);
    await service.publishDraft(draft.id, draft.version, actor());
    const outbox = await prisma!.notificationOutbox.findFirstOrThrow({ where: { sessionId: session.id, eventType: "BRIEFING_PUBLISHED" } });
    const repository = createPrismaNotificationRepository(prisma!);
    let failOnce = true;
    const failingRepository = new Proxy(repository, { get(target, property, receiver) {
      if (property === "createEvent") return async (...args: Parameters<typeof repository.createEvent>) => {
        if (failOnce) { failOnce = false; throw new Error("temporary delivery failure"); }
        return repository.createEvent(...args);
      };
      return Reflect.get(target, property, receiver);
    } });
    const first = await createNotificationDispatcher(prisma!, failingRepository, { workerId: `${marker}-retry-1`, batchSize: 100, retryBaseMs: 1 }).runOnce();
    expect(first.failed).toBe(1);
    expect(await prisma!.operationalBriefing.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({ status: "Published" });
    await prisma!.notificationOutbox.update({ where: { id: outbox.id }, data: { availableAt: new Date(Date.now() - 1_000) } });
    await createNotificationDispatcher(prisma!, repository, { workerId: `${marker}-retry-2`, batchSize: 100 }).runOnce();
    await prisma!.notificationOutbox.update({ where: { id: outbox.id }, data: { status: "PENDING", deliveredAt: null, availableAt: new Date(Date.now() - 1_000) } });
    await createNotificationDispatcher(prisma!, repository, { workerId: `${marker}-retry-3`, batchSize: 100 }).runOnce();
    const delivered = await prisma!.notification.findMany({ where: { deduplicationKey: `event:outbox:${outbox.id}` } });
    expect(delivered.length).toBeGreaterThan(0);
    expect(new Set(delivered.map((item) => item.recipientUserId)).size).toBe(delivered.length);
    expect(delivered.find((item) => item.recipientUserId === operator.id)).toMatchObject({ category: "Briefing", title: "Briefing published", message: `Briefing revision 1 is available for review.`, sourceType: "briefing", actionDestination: "/active-event", actionLabel: "Read briefing" });
  });

  it("keeps GROUP Briefing access and publication recipients bound to Incident A", async () => {
    const [sessionA, sessionB] = await Promise.all([incident("GROUP-A"), incident("GROUP-B")]);
    const service = createPrismaOperationalBriefingService(prisma!);
    const publishedA = await service.publishDraft((await validDraft(sessionA.id, service)).id, 2, actor());
    const publishedB = await service.publishDraft((await validDraft(sessionB.id, service)).id, 2, actor());
    const groupRole = await prisma!.role.create({ data: { name: `${marker.toLowerCase()}-group-reader`, displayName: `${marker} group reader`, permissions: ["session:read", "briefing:read", "briefing:read-history"], scopeTypes: ["GROUP"], custom: true } });
    roleIds.push(groupRole.id);
    const reader = await prisma!.user.create({ data: { email: `${marker.toLowerCase()}-group@example.test`, normalizedEmail: `${marker.toLowerCase()}-group@example.test`, displayName: `${marker} group`, status: "Active", authenticationPolicy: "SSO_ONLY" } });
    userIds.push(reader.id);
    await prisma!.userRole.create({ data: { userId: reader.id, roleId: groupRole.id, scopeType: "GROUP", assignedBy: coordinator.id } });
    await prisma!.incidentAssignment.createMany({ data: [sessionA.id, sessionB.id].map((incidentId) => ({ incidentId, userId: reader.id, function: marker, createdById: coordinator.id })) });
    const group = await prisma!.operationalGroup.create({ data: { id: `${marker.toLowerCase()}-group-a`, operationalId: `${marker}-GROUP-A`, incidentId: sessionA.id, name: marker, pool: "ZPP", functionName: marker, createdById: coordinator.id, updatedById: coordinator.id } });
    groupIds.push(group.id);
    await prisma!.groupRoleAssignment.create({ data: { id: randomUUID(), userId: reader.id, roleId: groupRole.id, groupId: group.id, assignedBy: coordinator.id } });
    const app = createApp();
    expect((await request(app).get(`/api/sessions/${sessionA.id}/briefings/current`).set(as(reader.email))).status).toBe(200);
    expect((await request(app).get(`/api/sessions/${sessionB.id}/briefings/current`).set(as(reader.email))).status).toBe(403);
    expect((await request(app).get(`/api/sessions/${sessionB.id}/briefings`).set(as(reader.email))).status).toBe(403);
    expect((await request(app).get(`/api/briefings/${publishedB.briefing.id}`).set(as(reader.email))).status).toBe(403);
    expect((await request(app).get(`/api/briefings/${publishedA.briefing.id}`).set(as(reader.email))).status).toBe(200);
    const eligibleA = await new EffectiveAccessService(prisma!).eligibleUsersForPermission("briefing:read", { incidentId: sessionA.id });
    const eligibleB = await new EffectiveAccessService(prisma!).eligibleUsersForPermission("briefing:read", { incidentId: sessionB.id });
    expect(eligibleA).toContain(reader.id);
    expect(eligibleB).not.toContain(reader.id);
  });

  it("uses unbounded candidate discovery and database counts beyond the legacy 200-row cap", async () => {
    const session = await incident("SCALE");
    const scaleIds = Array.from({ length: 1_001 }, () => randomUUID());
    const emails = scaleIds.map((id, index) => `${marker.toLowerCase()}-scale-${index}@example.test`);
    userIds.push(...scaleIds);
    await prisma!.user.createMany({ data: scaleIds.map((id, index) => ({ id, email: emails[index]!, normalizedEmail: emails[index]!, displayName: `${marker} scale ${index}`, status: "Active", authenticationPolicy: "SSO_ONLY" })) });
    await prisma!.userRole.createMany({ data: scaleIds.map((userId) => ({ userId, roleId: operatorRoleId, scopeType: "GLOBAL", assignedBy: coordinator.id })) });
    await prisma!.incidentAssignment.createMany({ data: scaleIds.map((userId) => ({ incidentId: session.id, userId, function: marker, createdById: coordinator.id })) });
    await prisma!.assignmentTask.createMany({ data: Array.from({ length: 1_005 }, (_, index) => ({ operationalId: `${marker}-SCALE-ASN-${index}`, sessionId: session.id, title: `${marker} ${index}`, status: "Open", createdById: coordinator.id, updatedById: coordinator.id })) });
    const historicalAt = new Date("2026-08-23T12:00:00.000Z");
    await prisma!.operationalBriefing.createMany({ data: Array.from({ length: 120 }, (_, index) => ({ id: `${marker}-SCALE-BRF-${index + 1}`, sessionId: session.id, revision: index + 1, status: "Superseded", title: `${marker} historical ${index + 1}`, situationSummary: "Historical scale fixture", overview: "", version: 2, createdById: operator.id, updatedById: operator.id, publishedAt: historicalAt, publishedById: operator.id, supersededAt: historicalAt, createdAt: historicalAt, updatedAt: historicalAt })) });
    const eligible = await new EffectiveAccessService(prisma!).eligibleUsersForPermission("briefing:read", { incidentId: session.id });
    expect(scaleIds.every((id) => eligible.includes(id))).toBe(true);
    const service = createPrismaOperationalBriefingService(prisma!);
    const event = await service.getActiveEvent(session.id, actor());
    expect(event.metrics.find((metric) => metric.label === "Open assignments")?.value).toBe(1_005);
    const history = await service.listRevisions(session.id, actor(), { limit: 37, offset: 74 });
    expect(history).toMatchObject({ total: 120, limit: 37, offset: 74 });
    expect(history.data).toHaveLength(37);
  }, 30_000);
});
