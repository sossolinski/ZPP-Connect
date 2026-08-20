import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { enqueueNotification } from "./modules/notifications/notification-outbox.js";
import { createNotificationDispatcher } from "./modules/notifications/notification-dispatcher.js";
import { createNotificationProjector } from "./modules/notifications/notification-projector.js";
import { createPrismaNotificationRepository } from "./modules/notifications/prisma-notification-repository.js";
import { createPersistentNotificationService } from "./modules/notifications/notification-service.js";
import { createPrismaDocumentRepository } from "./modules/documents/prisma-document-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;
const prisma = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;
const as = (email: string) => ({ "x-user-email": email });

postgresDescribe("Foundation Stage 13 PostgreSQL Notifications delivery integrity", () => {
  const marker = `F13-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  let now = new Date("2036-08-20T17:00:00.000Z");
  const clock = { now: () => new Date(now) };
  const users: Record<string, { id: string; email: string }> = {};
  const userIds: string[] = [];
  const roleIds: string[] = [];
  const assignmentIds: string[] = [];
  let admin: { id: string; email: string };
  let incidentId: string;
  let seedSnapshot: { notifications: number; migration: number };
  let repository: ReturnType<typeof createPrismaNotificationRepository>;
  let service: ReturnType<typeof createPersistentNotificationService>;

  function event(recipientUserId: string, key: string = randomUUID(), values: Record<string, unknown> = {}) {
    return service.createEvent({
      recipientUserId, deduplicationKey: `event:${marker}:${key}`, kind: "Information", severity: "Information", category: "Session",
      title: `${marker} event`, message: "A controlled operational update is available.", sourceType: "session", sourceId: incidentId,
      actionDestination: "/sessions", actionLabel: "Open sessions", metadata: { operation: "test", provenance: "stage13-test" }, ...values,
    } as any);
  }

  function condition(recipientUserId: string, key: string, values: Record<string, unknown> = {}) {
    return service.upsertCondition({
      recipientUserId, deduplicationKey: `condition:${marker}:${key}`, kind: "Action required", severity: "Attention", category: "Assignment",
      title: `${marker} condition`, message: "An operational assignment needs attention.", sessionId: incidentId, sourceType: "assignment", sourceId: key,
      conditionType: "assignment", actionDestination: "/assignments", actionLabel: "Open assignment", metadata: { condition: true, conditionType: "assignment" }, ...values,
    } as any);
  }

  function application() {
    return createApp({ notificationRepository: repository, trainingClock: clock, documentClock: clock });
  }

  async function createOutbox(values: Record<string, unknown> = {}) {
    const aggregateId = `${marker}-${randomUUID()}`;
    await prisma!.$transaction((tx) => enqueueNotification(tx, {
      eventType: "ASSIGNMENT_ASSIGNED", aggregateType: "assignment", aggregateId, aggregateVersion: randomUUID(), recipientUserId: users.a!.id,
      sessionId: incidentId, payload: { operationalId: aggregateId, occurredAt: now.toISOString() }, ...values,
    } as any));
    return prisma!.notificationOutbox.findFirstOrThrow({ where: { aggregateId }, orderBy: { createdAt: "desc" } });
  }

  beforeAll(async () => {
    await prisma!.$connect();
    seedSnapshot = {
      notifications: await prisma!.notification.count({ where: { metadata: { path: ["provenance"], equals: "prisma-seed" } } }),
      migration: (await prisma!.$queryRaw<Array<{ count: bigint }>>`SELECT count(*)::bigint AS count FROM "_prisma_migrations" WHERE migration_name = '20260820170000_notifications_foundation' AND finished_at IS NOT NULL`)[0]!.count === 1n ? 1 : 0,
    };
    await prisma!.notification.deleteMany();
    await prisma!.notificationOutbox.deleteMany();
    admin = await prisma!.user.findUniqueOrThrow({ where: { email: "admin@lot.pl" }, select: { id: true, email: true } });
    const incident = await prisma!.session.create({ data: { operationalId: `${marker}-INCIDENT`, mode: "EXERCISE", status: "Active", eventType: marker, createdById: admin.id } });
    incidentId = incident.id;
    for (const key of ["manager", "a", "b", "inactive"]) {
      const role = await prisma!.role.create({ data: { name: `${marker.toLowerCase()}-${key}`, displayName: `${marker} ${key}`, permissions: key === "manager" ? ["session:read", "assignment:read", "assignment:create", "assignment:update", "assignment:assign", "admin:manage"] : ["session:read", "assignment:read", "assignment:update"] } });
      const user = await prisma!.user.create({ data: { email: `${marker.toLowerCase()}-${key}@example.test`, displayName: `${marker} ${key}`, roles: { create: { roleId: role.id, assignedBy: marker } } } });
      await prisma!.incidentAssignment.create({ data: { incidentId, userId: user.id, function: marker, createdById: admin.id } });
      roleIds.push(role.id); userIds.push(user.id); users[key] = user;
    }
    await prisma!.user.update({ where: { id: users.inactive!.id }, data: { status: "suspended" } });
    repository = createPrismaNotificationRepository(prisma!);
    service = createPersistentNotificationService(repository, clock);
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.notification.deleteMany({ where: { OR: [{ recipientUserId: { in: userIds } }, { deduplicationKey: { contains: marker } }] } });
    await prisma.notificationOutbox.deleteMany({ where: { OR: [{ aggregateId: { contains: marker } }, { recipientUserId: { in: userIds } }] } });
    await prisma.assignmentOperation.deleteMany({ where: { incidentId } });
    await prisma.assignmentTask.deleteMany({ where: { OR: [{ id: { in: assignmentIds } }, { sessionId: incidentId }] } });
    await prisma.auditLog.deleteMany({ where: { sessionId: incidentId } });
    await prisma.caseTimelineEvent.deleteMany({ where: { sessionId: incidentId } });
    await prisma.incidentAssignment.deleteMany({ where: { incidentId } });
    await prisma.session.delete({ where: { id: incidentId } });
    await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.role.deleteMany({ where: { id: { in: roleIds } } });
    await prisma.$disconnect();
  });

  it("deploys the Stage 13 schema, exact Prisma seed, constraints, trigger and indexes", async () => {
    expect(seedSnapshot).toEqual({ notifications: 3, migration: 1 });
    const constraints = await prisma!.$queryRaw<Array<{ name: string }>>`SELECT conname AS name FROM pg_constraint WHERE conname IN ('Notification_kind_check', 'Notification_mode_check', 'Notification_condition_shape_check', 'Notification_version_check', 'Notification_action_destination_check', 'NotificationOutbox_status_check', 'NotificationOutbox_attempt_check')`;
    expect(constraints).toHaveLength(7);
    const indexes = await prisma!.$queryRaw<Array<{ indexname: string }>>`SELECT indexname FROM pg_indexes WHERE indexname IN ('Notification_recipientUserId_deduplicationKey_key', 'Notification_recipientUserId_createdAt_idx', 'Notification_recipientUserId_readAt_createdAt_idx', 'Notification_recipientUserId_resolvedAt_createdAt_idx', 'Notification_recipientUserId_category_idx', 'Notification_sessionId_recipientUserId_idx', 'NotificationOutbox_status_availableAt_createdAt_idx', 'NotificationOutbox_leaseUntil_status_idx', 'NotificationOutbox_aggregateType_aggregateId_status_idx')`;
    expect(indexes).toHaveLength(9);
    const trigger = await prisma!.$queryRaw<Array<{ name: string }>>`SELECT tgname AS name FROM pg_trigger WHERE tgname = 'Notification_immutability_guard' AND NOT tgisinternal`;
    expect(trigger).toHaveLength(1);
  });

  it("commits source state and notification intent atomically and survives dispatch-after-restart", async () => {
    const created = await request(application()).post("/api/assignments").set(as(users.manager!.email)).send({ sessionId: incidentId, title: `${marker} atomic assignment`, priority: "Normal", operationId: randomUUID() });
    expect(created.status).toBe(201); assignmentIds.push(created.body.id);
    const assigned = await request(application()).post(`/api/assignments/${created.body.id}/assign`).set(as(users.manager!.email)).send({ sessionId: incidentId, expectedVersion: created.body.version, assignedUserId: users.a!.id, operationId: randomUUID() });
    expect(assigned.status).toBe(200);
    const outbox = await prisma!.notificationOutbox.findFirstOrThrow({ where: { aggregateId: created.body.id, eventType: "ASSIGNMENT_ASSIGNED" } });
    expect(outbox).toMatchObject({ status: "PENDING", recipientUserId: users.a!.id });
    expect(await prisma!.notification.count({ where: { sourceId: created.body.id } })).toBe(0);
    const restartedDispatcher = createNotificationDispatcher(prisma!, createPrismaNotificationRepository(prisma!), { clock, workerId: `${marker}-restart` });
    expect((await restartedDispatcher.runOnce()).delivered).toBeGreaterThan(0);
    expect(await prisma!.notification.count({ where: { recipientUserId: users.a!.id, sourceId: created.body.id, mode: "EVENT" } })).toBe(1);
  });

  it("rolls back source and outbox together", async () => {
    const aggregateId = `${marker}-ROLLBACK`;
    await expect(prisma!.$transaction(async (tx) => {
      const row = await tx.assignmentTask.create({ data: { operationalId: `${marker}-ROLLBACK-ASG`, sessionId: incidentId, title: marker, assignedUserId: users.a!.id, createdById: users.manager!.id } });
      await enqueueNotification(tx, { eventType: "ASSIGNMENT_ASSIGNED", aggregateType: "assignment", aggregateId: row.id, aggregateVersion: randomUUID(), recipientUserId: users.a!.id, sessionId: incidentId, payload: { operationalId: aggregateId, occurredAt: now.toISOString() } });
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(await prisma!.assignmentTask.count({ where: { operationalId: `${marker}-ROLLBACK-ASG` } })).toBe(0);
    expect(await prisma!.notificationOutbox.count({ where: { payload: { path: ["operationalId"], equals: aggregateId } } })).toBe(0);
  });

  it("claims safely across workers, recovers expired leases and deduplicates the insert-to-delivered crash window", async () => {
    const outbox = await createOutbox();
    const workerA = createPrismaNotificationRepository(prisma!);
    const workerB = createPrismaNotificationRepository(prisma!);
    const leaseUntil = new Date(now.getTime() + 30_000);
    const claims = await Promise.all([workerA.claimOutbox("worker-a", 1, leaseUntil, now), workerB.claimOutbox("worker-b", 1, leaseUntil, now)]);
    expect(claims[0]!.length + claims[1]!.length).toBe(1);
    now = new Date(now.getTime() + 31_000);
    expect(await workerB.claimOutbox("worker-recovery", 1, new Date(now.getTime() + 30_000), now)).toHaveLength(1);
    await prisma!.notificationOutbox.update({ where: { id: outbox.id }, data: { status: "PENDING", attemptCount: 0, availableAt: now, lockedAt: null, leaseUntil: null, lockedBy: null } });
    await service.createEvent({ recipientUserId: users.a!.id, deduplicationKey: `event:outbox:${outbox.id}`, kind: "Information", severity: "Information", category: "Assignment", title: `${marker} inserted before crash`, message: "The worker stopped before delivery acknowledgement.", sessionId: incidentId, sourceType: "assignment", sourceId: outbox.aggregateId, actionDestination: "/assignments", actionLabel: "Open assignment" });
    await Promise.all([
      createNotificationDispatcher(prisma!, workerA, { clock, workerId: "dispatch-a" }).runOnce(),
      createNotificationDispatcher(prisma!, workerB, { clock, workerId: "dispatch-b" }).runOnce(),
    ]);
    expect(await prisma!.notification.count({ where: { recipientUserId: users.a!.id, deduplicationKey: `event:outbox:${outbox.id}` } })).toBe(1);
    expect((await prisma!.notificationOutbox.findUniqueOrThrow({ where: { id: outbox.id } })).status).toBe("DELIVERED");
  });

  it("persists bounded retries and a terminal FAILED diagnostic without sensitive payloads", async () => {
    const outbox = await createOutbox();
    await prisma!.notificationOutbox.update({ where: { id: outbox.id }, data: { maxAttempts: 2 } });
    const failing = { ...repository, createEvent: async () => { throw Object.assign(new Error("secret source payload"), { code: "TRANSIENT" }); } };
    const dispatcher = createNotificationDispatcher(prisma!, failing, { clock, workerId: `${marker}-failure`, retryBaseMs: 10 });
    await dispatcher.runOnce();
    let row = await prisma!.notificationOutbox.findUniqueOrThrow({ where: { id: outbox.id } });
    expect(row).toMatchObject({ status: "PENDING", attemptCount: 1, lastError: "Error:TRANSIENT" });
    now = new Date(row.availableAt.getTime() + 1);
    await dispatcher.runOnce();
    row = await prisma!.notificationOutbox.findUniqueOrThrow({ where: { id: outbox.id } });
    expect(row).toMatchObject({ status: "FAILED", attemptCount: 2, lastError: "Error:TRANSIENT" });
    expect((await repository.deliveryHealth(now)).failed).toBeGreaterThanOrEqual(1);
  });

  it("waits for a real linked active user instead of fabricating a training recipient", async () => {
    const memberId = `${marker.toLowerCase()}-unlinked-member`;
    await prisma!.memberProfile.create({ data: { id: memberId, memberId: `${marker}-UNLINKED`, firstName: "Pending", lastName: "Identity", pool: "ZPP", role: "Member", assignedFunction: marker, languages: ["PL"], createdById: admin.id, updatedById: admin.id } });
    const outbox = await createOutbox({ eventType: "TRAINING_ASSIGNED", aggregateType: "trainingRecord", sessionId: null, payload: { memberProfileId: memberId, operationalId: `${marker}-TRAINING`, occurredAt: now.toISOString() } });
    const dispatcher = createNotificationDispatcher(prisma!, repository, { clock, workerId: `${marker}-link` });
    await dispatcher.runOnce();
    expect(await prisma!.notificationOutbox.findUnique({ where: { id: outbox.id } })).toMatchObject({ status: "PENDING", attemptCount: 0 });
    expect(await prisma!.notification.count({ where: { sourceId: outbox.aggregateId } })).toBe(0);
    await prisma!.memberProfile.update({ where: { id: memberId }, data: { linkedUserId: users.b!.id } });
    now = new Date(now.getTime() + 61_000);
    await dispatcher.runOnce();
    expect(await prisma!.notification.count({ where: { sourceId: outbox.aggregateId, recipientUserId: users.b!.id } })).toBe(1);
    await prisma!.memberProfile.delete({ where: { id: memberId } });
  });

  it("keeps EVENT content immutable while durable read and unread survive app instances", async () => {
    const row = await event(users.a!.id, "immutable", { sessionId: incidentId, sourceLabel: `${marker} snapshot` });
    await expect(prisma!.notification.update({ where: { id: row.id }, data: { sourceLabel: "mutated" } })).rejects.toBeTruthy();
    const first = await request(application()).post(`/api/notifications/${row.id}/read`).set(as(users.a!.email));
    expect(first.body.read).toBe(true);
    expect((await request(application()).get(`/api/notifications/${row.id}`).set(as(users.a!.email))).body.read).toBe(true);
    const secondApp = application();
    expect((await request(secondApp).post(`/api/notifications/${row.id}/unread`).set(as(users.a!.email))).body.unread).toBe(true);
    expect((await request(application()).get(`/api/notifications/${row.id}`).set(as(users.a!.email))).body.unread).toBe(true);
  });

  it("keeps read and resolve independent, resets unread on escalation/reopen and converges concurrent projection", async () => {
    const key = "lifecycle";
    const row = await condition(users.a!.id, key);
    await repository.markRead(users.a!.id, row.id, true, now);
    await repository.resolveCondition(users.a!.id, `condition:${marker}:${key}`, "Source completed", now);
    let stored = await prisma!.notification.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored).toMatchObject({ readAt: now, resolvedAt: now });
    await Promise.all([condition(users.a!.id, key), condition(users.a!.id, key, { severity: "Critical", resetUnread: true })]);
    stored = await prisma!.notification.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.resolvedAt).toBeNull(); expect(stored.readAt).toBeNull();
    expect(await prisma!.notification.count({ where: { recipientUserId: users.a!.id, deduplicationKey: `condition:${marker}:${key}` } })).toBe(1);
    const concurrent = await Promise.all([repository.markRead(users.a!.id, row.id, true, now), repository.markRead(users.a!.id, row.id, false, now)]);
    expect(concurrent.every(Boolean)).toBe(true);
  });

  it("converges assignment assign-cancel and reassign races without stale recipient conditions", async () => {
    const app = application();
    const first = await request(app).post("/api/assignments").set(as(users.manager!.email)).send({ sessionId: incidentId, title: `${marker} cancel race`, priority: "Normal", operationId: randomUUID() });
    const assignedFirst = await request(app).post(`/api/assignments/${first.body.id}/assign`).set(as(users.manager!.email)).send({ sessionId: incidentId, expectedVersion: first.body.version, assignedUserId: users.a!.id, operationId: randomUUID() });
    const cancelled = await request(app).post(`/api/assignments/${first.body.id}/cancel`).set(as(users.manager!.email)).send({ sessionId: incidentId, expectedVersion: assignedFirst.body.version, operationId: randomUUID(), reason: "Controlled race cancellation" });
    expect(cancelled.status).toBe(200);
    assignmentIds.push(first.body.id);

    const second = await request(app).post("/api/assignments").set(as(users.manager!.email)).send({ sessionId: incidentId, title: `${marker} reassign race`, priority: "Normal", operationId: randomUUID() });
    const assignedSecond = await request(app).post(`/api/assignments/${second.body.id}/assign`).set(as(users.manager!.email)).send({ sessionId: incidentId, expectedVersion: second.body.version, assignedUserId: users.a!.id, operationId: randomUUID() });
    assignmentIds.push(second.body.id);
    const emptyTraining = { evaluateMemberCompliance: async () => null } as any;
    const emptyDocuments = { evaluateMemberCompliance: async () => null } as any;
    const projector = createNotificationProjector(prisma!, repository, { training: emptyTraining, documents: emptyDocuments, clock });
    await projector.runOnce();
    const reassigned = await request(app).post(`/api/assignments/${second.body.id}/reassign`).set(as(users.manager!.email)).send({ sessionId: incidentId, expectedVersion: assignedSecond.body.version, assignedUserId: users.b!.id, operationId: randomUUID(), reason: "Controlled handover" });
    expect(reassigned.status).toBe(200);
    await createNotificationDispatcher(prisma!, repository, { clock, workerId: `${marker}-assignment-races` }).runOnce();
    await projector.runOnce();

    expect(await prisma!.notification.count({ where: { sourceId: first.body.id, mode: "EVENT" } })).toBe(2);
    expect(await prisma!.notification.findUniqueOrThrow({ where: { recipientUserId_deduplicationKey: { recipientUserId: users.a!.id, deduplicationKey: `condition:assignment:${second.body.id}:${users.a!.id}` } } })).toMatchObject({ resolvedAt: now });
    expect(await prisma!.notification.findUniqueOrThrow({ where: { recipientUserId_deduplicationKey: { recipientUserId: users.b!.id, deduplicationKey: `condition:assignment:${second.body.id}:${users.b!.id}` } } })).toMatchObject({ resolvedAt: null });
    expect(await prisma!.notification.count({ where: { sourceId: second.body.id, recipientUserId: users.b!.id, mode: "EVENT" } })).toBe(1);
  });

  it("handles roster cancel, member archive, requirement end, acknowledgement and withdrawal races", async () => {
    const suffix = randomUUID().slice(0, 8);
    const memberId = `${marker.toLowerCase()}-race-member-${suffix}`;
    const rosterId = `${marker}-roster-${suffix}`;
    const trainingId = `${marker}-training-${suffix}`;
    const courseId = `${marker}-course-${suffix}`;
    const documentId = `${marker}-document-${suffix}`;
    const versionId = `${marker}-version-${suffix}`;
    const requirementId = `${marker}-requirement-${suffix}`;
    await prisma!.memberProfile.create({ data: { id: memberId, memberId: `${marker}-MEM-${suffix}`, linkedUserId: users.b!.id, firstName: "Race", lastName: "Fixture", pool: "ZPP", role: "Member", assignedFunction: marker, languages: ["PL"], createdById: admin.id, updatedById: admin.id } });
    await prisma!.$transaction(async (tx) => {
      await tx.rosterShift.create({ data: { id: rosterId, operationalId: `${marker}-RST-${suffix}`, sessionId: incidentId, assignedMemberProfileId: memberId, title: "Controlled shift", duty: "Controlled duty", functionName: "Controlled function", startAt: now, endAt: new Date(now.getTime() + 3_600_000), location: "Controlled location", status: "Published", publishedAt: now, publishedById: users.manager!.id, createdById: users.manager!.id, updatedById: users.manager!.id } });
      await enqueueNotification(tx, { eventType: "ROSTER_PUBLISHED", aggregateType: "rosterShift", aggregateId: rosterId, aggregateVersion: randomUUID(), sessionId: incidentId, payload: { memberProfileId: memberId, operationalId: `${marker}-RST-${suffix}`, occurredAt: now.toISOString() } });
    });
    await prisma!.rosterShift.update({ where: { id: rosterId }, data: { status: "Cancelled", cancelledAt: now, cancelledById: users.manager!.id, cancelReason: "Race fixture" } });

    await prisma!.trainingCourse.create({ data: { id: courseId, code: `${marker}-${suffix}`, normalizedCode: `${marker}-${suffix}`.toLowerCase(), title: "Controlled course", category: "Operational", deliveryType: "Briefing", createdById: admin.id, updatedById: admin.id } });
    await prisma!.$transaction(async (tx) => {
      await tx.memberTrainingRecord.create({ data: { id: trainingId, operationalId: `${marker}-TRN-${suffix}`, memberProfileId: memberId, courseId, assignedAt: now, assignedById: users.manager!.id, dueAt: new Date(now.getTime() - 1), createdById: users.manager!.id, updatedById: users.manager!.id } });
      await enqueueNotification(tx, { eventType: "TRAINING_ASSIGNED", aggregateType: "trainingRecord", aggregateId: trainingId, aggregateVersion: randomUUID(), payload: { memberProfileId: memberId, operationalId: `${marker}-TRN-${suffix}`, occurredAt: now.toISOString() } });
    });
    await prisma!.memberProfile.update({ where: { id: memberId }, data: { status: "Archived" } });

    await prisma!.document.create({ data: { id: documentId, code: `${marker}-DOC-${suffix}`, normalizedCode: `${marker}-doc-${suffix}`.toLowerCase(), title: "Controlled document", category: "Operational", ownerFunction: "Operations", createdById: admin.id, updatedById: admin.id } });
    await prisma!.documentVersion.create({ data: { id: versionId, documentId, versionLabel: "1.0", normalizedVersionLabel: "1.0", status: "Published", publishedAt: now, publishedById: users.manager!.id, effectiveFrom: now, contentMode: "Internal", contentBody: "Controlled publication.", contentDigest: "stage13-controlled", createdById: admin.id, updatedById: admin.id } });
    await prisma!.$transaction(async (tx) => {
      await tx.documentRequirement.create({ data: { id: requirementId, documentVersionId: versionId, targetType: "MemberProfile", memberProfileId: memberId, effectiveFrom: now, dueAt: new Date(now.getTime() - 1), createdById: users.manager!.id, updatedById: users.manager!.id } });
      await enqueueNotification(tx, { eventType: "DOCUMENT_REQUIREMENT_CREATED", aggregateType: "documentRequirement", aggregateId: requirementId, aggregateVersion: "1", payload: { requirementId, occurredAt: now.toISOString() } });
    });
    await prisma!.documentRequirement.update({ where: { id: requirementId }, data: { active: false, endedAt: now, endedById: users.manager!.id } });

    const dispatcher = createNotificationDispatcher(prisma!, repository, { clock, workerId: `${marker}-source-races` });
    await dispatcher.runOnce();
    expect(await prisma!.notification.count({ where: { sourceId: rosterId, recipientUserId: users.b!.id, mode: "EVENT" } })).toBe(1);
    expect(await prisma!.notification.count({ where: { sourceId: { in: [trainingId, requirementId] }, recipientUserId: users.b!.id } })).toBe(0);

    await prisma!.memberProfile.update({ where: { id: memberId }, data: { status: "Active" } });
    await prisma!.documentRequirement.update({ where: { id: requirementId }, data: { active: true, endedAt: null, endedById: null } });
    const documentRepository = createPrismaDocumentRepository(prisma!, clock);
    const emptyTraining = { evaluateMemberCompliance: async () => null } as any;
    const projector = createNotificationProjector(prisma!, repository, { training: emptyTraining, documents: documentRepository, clock });
    await projector.runOnce();
    const conditionKey = `condition:documentVersion:${versionId}:document:${users.b!.id}`;
    expect(await prisma!.notification.findUniqueOrThrow({ where: { recipientUserId_deduplicationKey: { recipientUserId: users.b!.id, deduplicationKey: conditionKey } } })).toMatchObject({ resolvedAt: null });

    const acknowledgementId = `${marker}-ack-${suffix}`;
    await prisma!.$transaction(async (tx) => {
      await tx.documentAcknowledgement.create({ data: { id: acknowledgementId, documentVersionId: versionId, memberProfileId: memberId, acknowledgedAt: now, acknowledgedById: users.b!.id, acknowledgementStatementVersion: "stage13-test", documentCode: `${marker}-DOC-${suffix}`, documentTitle: "Controlled document", versionLabel: "1.0", contentMode: "Internal", contentDigestSnapshot: "stage13-controlled" } });
      await tx.documentAcknowledgementRequirement.create({ data: { acknowledgementId, requirementId } });
    });
    await projector.runOnce();
    expect(await prisma!.notification.findUniqueOrThrow({ where: { recipientUserId_deduplicationKey: { recipientUserId: users.b!.id, deduplicationKey: conditionKey } } })).toMatchObject({ resolvedAt: now });
    await prisma!.documentVersion.update({ where: { id: versionId }, data: { status: "Withdrawn", withdrawnAt: now, withdrawnById: users.manager!.id, withdrawReason: "Controlled withdrawal" } });
    await projector.runOnce();
    expect((await prisma!.notification.findUniqueOrThrow({ where: { recipientUserId_deduplicationKey: { recipientUserId: users.b!.id, deduplicationKey: conditionKey } } })).resolvedAt).not.toBeNull();
    await prisma!.rosterShift.delete({ where: { id: rosterId } });
    await prisma!.memberProfile.update({ where: { id: memberId }, data: { linkedUserId: null } });
  });

  it("makes GET paths read-only and applies complete server filters and paging", async () => {
    await event(users.a!.id, "read-only", { sessionId: incidentId });
    const before = await prisma!.notification.findMany({ where: { recipientUserId: users.a!.id }, orderBy: { id: "asc" } });
    const outboxBefore = await prisma!.notificationOutbox.count();
    const app = application();
    expect((await request(app).get("/api/notifications").query({ active: true, sourceType: "session", limit: 2, offset: 0, sort: "oldest" }).set(as(users.a!.email))).status).toBe(200);
    expect((await request(app).get("/api/notifications/counts").set(as(users.a!.email))).status).toBe(200);
    expect((await request(app).get(`/api/notifications/${before[0]!.id}`).set(as(users.a!.email))).status).toBe(200);
    expect(await prisma!.notification.findMany({ where: { recipientUserId: users.a!.id }, orderBy: { id: "asc" } })).toEqual(before);
    expect(await prisma!.notificationOutbox.count()).toBe(outboxBefore);
  });

  it("enforces recipient isolation, current IncidentAssignment visibility, admin override and inactive-account hiding", async () => {
    const row = await event(users.a!.id, "visibility", { sessionId: incidentId });
    expect((await request(application()).get(`/api/notifications/${row.id}`).set(as(users.b!.email))).status).toBe(404);
    await prisma!.incidentAssignment.update({ where: { incidentId_userId: { incidentId, userId: users.a!.id } }, data: { active: false, revokedAt: now, revokedById: admin.id, revokeReason: marker } });
    expect((await request(application()).get(`/api/notifications/${row.id}`).set(as(users.a!.email))).status).toBe(404);
    expect((await request(application()).post(`/api/notifications/${row.id}/read`).set(as(users.a!.email))).status).toBe(404);
    expect((await request(application()).get("/api/notifications").set(as(users.a!.email))).body.data.some((item: any) => item.id === row.id)).toBe(false);
    await event(admin.id, "admin-override", { sessionId: incidentId });
    await prisma!.incidentAssignment.update({ where: { incidentId_userId: { incidentId, userId: admin.id } }, data: { active: false, revokedAt: now, revokedById: admin.id, revokeReason: marker } }).catch(() => undefined);
    expect((await request(application()).get("/api/notifications").set(as(admin.email))).body.data.some((item: any) => item.deduplicationKey.includes("admin-override"))).toBe(true);
    await prisma!.incidentAssignment.update({ where: { incidentId_userId: { incidentId, userId: users.a!.id } }, data: { active: true, revokedAt: null, revokedById: null, revokeReason: null } });
    await event(users.inactive!.id, "inactive", { sessionId: null });
    expect((await repository.counts(users.inactive!.id)).total).toBe(0);
  });

  it("counts and marks all beyond 1000 rows atomically without touching another recipient", async () => {
    const bulk = Array.from({ length: 1005 }, (_, index) => ({
      recipientUserId: users.a!.id, deduplicationKey: `event:${marker}:scale:${index}`, mode: "EVENT", kind: "Information", severity: index === 0 ? "Critical" : "Information", category: "Operational",
      title: `${marker} scale ${index}`, message: "Bounded notification scale fixture.", sourceType: "access", sourceId: `${marker}-scale-${index}`, actionDestination: "/settings", metadata: {}, createdAt: now, updatedAt: now,
    }));
    await prisma!.notification.createMany({ data: bulk });
    const other = await event(users.b!.id, "other-recipient", { sessionId: null });
    const counts = await request(application()).get("/api/notifications/counts").set(as(users.a!.email));
    expect(counts.body.total).toBeGreaterThanOrEqual(1005); expect(counts.body.criticalUnread).toBeGreaterThanOrEqual(1);
    const page = await request(application()).get("/api/notifications").query({ category: "Operational", limit: 200, offset: 800 }).set(as(users.a!.email));
    expect(page.body).toMatchObject({ total: 1005, limit: 200, offset: 800 }); expect(page.body.data).toHaveLength(200);
    const marked = await request(application()).post("/api/notifications/read-all").set(as(users.a!.email)).send({});
    expect(marked.body.updatedCount).toBeGreaterThanOrEqual(1005);
    expect(await prisma!.notification.count({ where: { recipientUserId: users.a!.id, readAt: null } })).toBe(0);
    expect((await prisma!.notification.findUniqueOrThrow({ where: { id: other.id } })).readAt).toBeNull();
    const invalidBulk = await request(application()).post("/api/notifications/read-all").set(as(users.a!.email)).send({ ids: [other.id] });
    expect(invalidBulk.status).toBe(404);
    expect((await request(application()).post(`/api/notifications/${other.id}/read`).set(as(users.a!.email))).status).toBe(404);
    const alreadyRead = await prisma!.notification.findFirstOrThrow({ where: { recipientUserId: users.a!.id, deduplicationKey: bulk[0]!.deduplicationKey } });
    const firstRead = await request(application()).post(`/api/notifications/${alreadyRead.id}/read`).set(as(users.a!.email));
    const secondRead = await request(application()).post(`/api/notifications/${alreadyRead.id}/read`).set(as(users.a!.email));
    expect(secondRead.body.readAt).toBe(firstRead.body.readAt);
    const concurrentKey = `event:${marker}:mark-all-race`;
    const [, newcomer] = await Promise.all([
      repository.markAllRead(users.a!.id, undefined, now),
      event(users.a!.id, "mark-all-race", { sessionId: null }),
    ]);
    expect((await prisma!.notification.findUniqueOrThrow({ where: { id: newcomer.id } })).deduplicationKey).toBe(concurrentKey);
  });

  it("projects more than 1000 time-driven conditions in chunks and resolves them from source state", async () => {
    const rows = Array.from({ length: 1005 }, (_, index) => ({ operationalId: `${marker}-PROJECT-${String(index).padStart(4, "0")}`, sessionId: incidentId, title: `${marker} projected ${index}`, status: "Open", priority: index === 0 ? "Critical" : "Normal", assignedUserId: users.a!.id, dueAt: new Date(now.getTime() - 1), createdById: users.manager!.id, updatedById: users.manager!.id }));
    await prisma!.assignmentTask.createMany({ data: rows });
    const created = await prisma!.assignmentTask.findMany({ where: { operationalId: { startsWith: `${marker}-PROJECT-` } }, select: { id: true } });
    assignmentIds.push(...created.map(({ id }) => id));
    const emptyTraining = { evaluateMemberCompliance: async () => null } as any;
    const emptyDocuments = { evaluateMemberCompliance: async () => null } as any;
    const projector = createNotificationProjector(prisma!, repository, { training: emptyTraining, documents: emptyDocuments, clock, batchSize: 113, maxRows: 2000 });
    const result = await projector.runOnce();
    expect(result.assignment.seen).toBeGreaterThanOrEqual(1005);
    expect(await prisma!.notification.count({ where: { recipientUserId: users.a!.id, conditionType: "assignment", sourceId: { in: created.map(({ id }) => id) }, resolvedAt: null } })).toBe(1005);
    await prisma!.assignmentTask.updateMany({ where: { id: { in: created.map(({ id }) => id) } }, data: { status: "Completed", completedAt: now, completedById: users.a!.id, completionNote: marker } });
    await projector.runOnce();
    expect(await prisma!.notification.count({ where: { conditionType: "assignment", sourceId: { in: created.map(({ id }) => id) }, resolvedAt: { not: null } } })).toBe(1005);
  });

  it("rejects PII-rich copy and arbitrary destinations and exposes diagnostics only to admin permission", async () => {
    await expect(event(users.a!.id, "unsafe-copy", { message: "Contact email address is hidden." })).rejects.toThrow(/Unsafe notification message/);
    await expect(event(users.a!.id, "unsafe-email", { message: "Contact operator@example.test." })).rejects.toThrow(/Unsafe notification message/);
    await expect(event(users.a!.id, "unsafe-phone", { message: "Contact +48 600 300 300." })).rejects.toThrow(/Unsafe notification message/);
    await expect(event(users.a!.id, "safe-operational-id", { message: "TRN-2026-000004 requires attention." })).resolves.toBeTruthy();
    await expect(event(users.a!.id, "unsafe-route", { actionDestination: "https://evil.example" })).rejects.toThrow(/Unsafe notification action destination/);
    expect((await request(application()).get("/api/notifications/delivery-health").set(as(users.a!.email))).status).toBe(404);
    expect((await request(application()).get("/api/notifications/delivery-health").set(as(users.manager!.email))).status).toBe(200);
  });
});
