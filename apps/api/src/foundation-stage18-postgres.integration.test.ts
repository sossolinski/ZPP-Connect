import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createPrismaExerciseService } from "./modules/exercise/prisma-exercise-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;
const prisma = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;
const as = (email: string) => ({ "x-user-email": email });

postgresDescribe("Foundation Stage 18 PostgreSQL Exercise evidence integrity", () => {
  const marker = `F18-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const incidentIds: string[] = [];
  const userIds: string[] = [];
  const roleIds: string[] = [];
  const groupIds: string[] = [];
  let coordinator: { id: string; email: string; displayName: string };

  const application = (service = createPrismaExerciseService(prisma!)) => createApp({ exerciseService: service });
  const actor = () => ({ ...coordinator, requestId: randomUUID() });

  async function incident(suffix: string, options: { status?: string; mode?: string; assigned?: string[] } = {}) {
    const row = await prisma!.session.create({ data: { operationalId: `${marker}-${suffix}`, mode: options.mode ?? "EXERCISE", status: options.status ?? "Active", eventType: marker, createdById: coordinator.id } });
    incidentIds.push(row.id);
    await prisma!.incidentAssignment.createMany({ data: Array.from(new Set([coordinator.id, ...(options.assigned ?? [])])).map((userId) => ({ incidentId: row.id, userId, function: marker, createdById: coordinator.id })) });
    return row;
  }

  async function scopedUser(suffix: string, incidents: Array<{ id: string }>, groupIncident: { id: string }) {
    const email = `${marker.toLowerCase()}-${suffix}@example.test`;
    const user = await prisma!.user.create({ data: { email, normalizedEmail: email, displayName: `${marker} ${suffix}`, status: "Active", authenticationPolicy: "SSO_ONLY" } });
    userIds.push(user.id);
    const role = await prisma!.role.create({ data: { name: `${marker.toLowerCase()}-${suffix}`, normalizedName: `${marker.toLowerCase()}-${suffix}`, displayName: `${marker} ${suffix}`, permissions: ["exercise:manage", "session:read"], scopeTypes: ["GROUP"], custom: true } });
    roleIds.push(role.id);
    await prisma!.userRole.create({ data: { userId: user.id, roleId: role.id, scopeType: "GROUP", assignedBy: coordinator.id } });
    for (const target of incidents) await prisma!.incidentAssignment.create({ data: { incidentId: target.id, userId: user.id, function: marker, createdById: coordinator.id } });
    const group = await prisma!.operationalGroup.create({ data: { id: `${marker}-${suffix}-group`, operationalId: `${marker}-GRP-${suffix}`, incidentId: groupIncident.id, name: `${marker} ${suffix}`, pool: "ZPP", functionName: "Exercise", createdById: coordinator.id } });
    groupIds.push(group.id);
    await prisma!.groupRoleAssignment.create({ data: { id: randomUUID(), userId: user.id, roleId: role.id, groupId: group.id, assignedBy: coordinator.id } });
    return user;
  }

  function injectBody(sessionId: string, injectNumber: number, operationId = randomUUID(), text = `${marker} inject ${injectNumber}`) {
    return { sessionId, operationId, injectNumber, targetRole: "TEC Member", text, expectedAction: `${marker} expected` };
  }

  function observationBody(sessionId: string, operationId = randomUUID(), observation = `${marker} observation`) {
    return { sessionId, operationId, area: "Intake", severity: "Low", observation, recommendation: `${marker} recommendation`, owner: "Exercise Director", includeInAar: true, status: "Open" };
  }

  const createInject = (sessionId: string, injectNumber: number, body: Record<string, unknown> = {}, email = coordinator.email, app = application()) =>
    request(app).post("/api/exercise/injects").set(as(email)).send({ ...injectBody(sessionId, injectNumber), ...body });
  const createObservation = (sessionId: string, body: Record<string, unknown> = {}, email = coordinator.email, app = application()) =>
    request(app).post("/api/exercise/observations").set(as(email)).send({ ...observationBody(sessionId), ...body });

  beforeAll(async () => {
    coordinator = await prisma!.user.findUniqueOrThrow({ where: { email: "coordinator@lot.pl" }, select: { id: true, email: true, displayName: true } });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.notification.deleteMany({ where: { OR: [{ sessionId: { in: incidentIds } }, { recipientUserId: { in: userIds } }] } });
    await prisma.notificationOutbox.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.caseTimelineEvent.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ sessionId: { in: incidentIds } }, { actorId: { in: userIds } }] } });
    await prisma.exerciseObservation.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.exerciseInject.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.permissionOverride.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.groupRoleAssignment.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { groupId: { in: groupIds } }] } });
    await prisma.operationalGroup.deleteMany({ where: { id: { in: groupIds } } });
    await prisma.incidentAssignment.deleteMany({ where: { OR: [{ incidentId: { in: incidentIds } }, { userId: { in: userIds } }] } });
    await prisma.session.deleteMany({ where: { id: { in: incidentIds } } });
    await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.role.deleteMany({ where: { id: { in: roleIds } } });
    await prisma.$disconnect();
  });

  it("installs migration 21 with typed models, constraints, sequences, triggers and no fabricated Exercise rows", async () => {
    const migrations = await prisma!.$queryRaw<Array<{ count: bigint }>>`SELECT count(*)::bigint AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    const triggers = await prisma!.$queryRaw<Array<{ tgname: string }>>`SELECT tgname FROM pg_trigger WHERE tgrelid IN ('"ExerciseInject"'::regclass, '"ExerciseObservation"'::regclass, '"ExerciseObservationRevision"'::regclass) AND NOT tgisinternal`;
    const sequences = await prisma!.$queryRaw<Array<{ relname: string }>>`SELECT relname FROM pg_class WHERE relkind = 'S' AND relname IN ('ExerciseInject_operational_seq', 'ExerciseObservation_operational_seq')`;
    expect(Number(migrations[0]!.count)).toBe(21);
    expect(triggers.map((row) => row.tgname)).toEqual(expect.arrayContaining(["ExerciseInject_evidence_immutable", "ExerciseObservationRevision_immutable", "ExerciseObservation_revision_invariant", "ExerciseObservationRevision_parent_invariant"]));
    expect(sequences).toHaveLength(2);
  });

  it("creates idempotent role-backed Injects and Observations with exactly one safe Audit and revision", async () => {
    const session = await incident("CREATE-IDEMPOTENT");
    const injectOperation = randomUUID();
    expect((await createInject(session.id, 1, { operationId: injectOperation })).status).toBe(201);
    expect((await createInject(session.id, 1, { operationId: injectOperation })).status).toBe(200);
    expect(await prisma!.exerciseInject.count({ where: { createOperationId: injectOperation } })).toBe(1);
    const inject = await prisma!.exerciseInject.findUniqueOrThrow({ where: { createOperationId: injectOperation } });
    expect(inject).toMatchObject({ targetRoleKey: "tec-member", targetRole: "TEC Member", status: "Planned", version: 1, createdById: coordinator.id });
    expect(await prisma!.auditLog.count({ where: { entityId: inject.id, action: "exercise_inject_created" } })).toBe(1);
    expect((await createInject(session.id, 2, { operationId: injectOperation })).status).toBe(409);

    const observationOperation = randomUUID();
    expect((await createObservation(session.id, { operationId: observationOperation })).status).toBe(201);
    expect((await createObservation(session.id, { operationId: observationOperation })).status).toBe(200);
    const observation = await prisma!.exerciseObservation.findUniqueOrThrow({ where: { createOperationId: observationOperation } });
    expect(await prisma!.exerciseObservationRevision.count({ where: { observationId: observation.id } })).toBe(1);
    expect(await prisma!.auditLog.count({ where: { entityId: observation.id, action: "exercise_observation_created" } })).toBe(1);
    const audits = await prisma!.auditLog.findMany({ where: { entityId: { in: [inject.id, observation.id] } } });
    expect(JSON.stringify(audits)).not.toContain(`${marker} inject`);
    expect(JSON.stringify(audits)).not.toContain(`${marker} observation`);
    expect(JSON.stringify(audits)).not.toContain(`${marker} recommendation`);
  });

  it("serializes concurrent creation operations and duplicate Inject numbers without Prisma leakage", async () => {
    const session = await incident("CREATE-CONCURRENCY");
    const operationId = randomUUID();
    const same = await Promise.all([createInject(session.id, 1, { operationId }), createInject(session.id, 1, { operationId })]);
    expect(same.map((response) => response.status).sort()).toEqual([200, 201]);
    const duplicate = await Promise.all([createInject(session.id, 2), createInject(session.id, 2)]);
    expect(duplicate.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(JSON.stringify(duplicate.find((response) => response.status === 409)!.body)).not.toMatch(/P2002|constraint|Prisma|SQL/i);
    expect(await prisma!.exerciseInject.count({ where: { sessionId: session.id } })).toBe(2);
  });

  it("validates Exercise mode, canonical roles, dictionaries, controlled fields and operational text bounds", async () => {
    const exercise = await incident("VALIDATION");
    const real = await incident("REAL", { mode: "REAL" });
    expect((await createInject(real.id, 1)).status).toBe(409);
    expect((await createObservation(real.id)).status).toBe(409);
    for (const body of [
      { injectNumber: 0 }, { injectNumber: -1 }, { injectNumber: 1.5 }, { injectNumber: "2" },
      { targetRole: "Uncontrolled role" }, { text: "x".repeat(10001) }, { status: "Released" }, { operationalId: "INJ-CLIENT" }
    ]) expect((await createInject(exercise.id, 1, body)).status).toBe(400);
    for (const body of [
      { area: "Unsupported" }, { severity: "Critical" }, { status: "Arbitrary" },
      { observation: "x".repeat(10001) }, { version: 99 }, { createdById: coordinator.id }
    ]) expect((await createObservation(exercise.id, body)).status).toBe(400);
    expect((await request(application()).patch("/api/exercise/injects/not-a-uuid").set(as(coordinator.email)).send({ expectedVersion: 1, text: "x" })).status).toBe(404);
    expect((await request(application()).get("/api/exercise/observations/not-a-uuid/history").set(as(coordinator.email))).status).toBe(404);
  });

  it("uses optimistic concurrency for Planned Inject edits and prevents content changes after Release/Completion at service and DB levels", async () => {
    const session = await incident("INJECT-IMMUTABILITY");
    const created = await createInject(session.id, 1);
    const id = created.body.id;
    const updates = await Promise.all([
      request(application()).patch(`/api/exercise/injects/${id}`).set(as(coordinator.email)).send({ expectedVersion: 1, text: `${marker} edit A` }),
      request(application()).patch(`/api/exercise/injects/${id}`).set(as(coordinator.email)).send({ expectedVersion: 1, text: `${marker} edit B` })
    ]);
    expect(updates.map((response) => response.status).sort()).toEqual([200, 409]);
    const current = await prisma!.exerciseInject.findUniqueOrThrow({ where: { id } });
    const released = await request(application()).post(`/api/exercise/injects/${id}/release`).set(as(coordinator.email)).send({ expectedVersion: current.version });
    expect(released.body).toMatchObject({ status: "Released", version: current.version + 1 });
    expect((await request(application()).patch(`/api/exercise/injects/${id}`).set(as(coordinator.email)).send({ expectedVersion: released.body.version, text: "rewrite" })).status).toBe(409);
    await expect(prisma!.exerciseInject.update({ where: { id }, data: { text: "DB rewrite" } })).rejects.toBeTruthy();
    const completed = await request(application()).post(`/api/exercise/injects/${id}/complete`).set(as(coordinator.email)).send({ expectedVersion: released.body.version });
    expect(completed.body.status).toBe("Completed");
    expect((await request(application()).patch(`/api/exercise/injects/${id}`).set(as(coordinator.email)).send({ expectedVersion: completed.body.version, expectedAction: "rewrite" })).status).toBe(409);
    await expect(prisma!.exerciseInject.update({ where: { id }, data: { status: "Released" } })).rejects.toBeTruthy();
  });

  it("enforces Planned → Released → Completed, and lifecycle retries/races create one transition Audit", async () => {
    const session = await incident("LIFECYCLE");
    const planned = (await createInject(session.id, 1)).body;
    expect((await request(application()).post(`/api/exercise/injects/${planned.id}/complete`).set(as(coordinator.email)).send({ expectedVersion: 1 })).status).toBe(409);
    const releases = await Promise.all([
      request(application()).post(`/api/exercise/injects/${planned.id}/release`).set(as(coordinator.email)).send({ expectedVersion: 1 }),
      request(application()).post(`/api/exercise/injects/${planned.id}/release`).set(as(coordinator.email)).send({ expectedVersion: 1 })
    ]);
    expect(releases.map((response) => response.status)).toEqual([200, 200]);
    const released = await prisma!.exerciseInject.findUniqueOrThrow({ where: { id: planned.id } });
    expect(released.status).toBe("Released");
    expect(await prisma!.auditLog.count({ where: { entityId: planned.id, action: "exercise_inject_released" } })).toBe(1);
    const completes = await Promise.all([
      request(application()).post(`/api/exercise/injects/${planned.id}/complete`).set(as(coordinator.email)).send({ expectedVersion: released.version }),
      request(application()).post(`/api/exercise/injects/${planned.id}/complete`).set(as(coordinator.email)).send({ expectedVersion: released.version })
    ]);
    expect(completes.map((response) => response.status)).toEqual([200, 200]);
    const completed = await prisma!.exerciseInject.findUniqueOrThrow({ where: { id: planned.id } });
    expect(completed).toMatchObject({ status: "Completed", version: released.version + 1 });
    expect(await prisma!.auditLog.count({ where: { entityId: planned.id, action: "exercise_inject_completed" } })).toBe(1);
    const replay = await request(application()).post(`/api/exercise/injects/${planned.id}/release`).set(as(coordinator.email)).send({ expectedVersion: 1 });
    expect(replay.body).toMatchObject({ status: "Completed", completedAt: completed.completedAt!.toISOString() });
  });

  it("keeps release/update and release/complete races coherent with no late content rewrite or duplicate evidence", async () => {
    const session = await incident("LIFECYCLE-RACES");
    const first = (await createInject(session.id, 1)).body;
    const updateRelease = await Promise.all([
      request(application()).patch(`/api/exercise/injects/${first.id}`).set(as(coordinator.email)).send({ expectedVersion: 1, text: `${marker} racing edit` }),
      request(application()).post(`/api/exercise/injects/${first.id}/release`).set(as(coordinator.email)).send({ expectedVersion: 1 })
    ]);
    expect(updateRelease.map((response) => response.status).sort()).toEqual([200, 409]);
    const durable = await prisma!.exerciseInject.findUniqueOrThrow({ where: { id: first.id } });
    expect([["Planned", `${marker} racing edit`], ["Released", first.text]]).toContainEqual([durable.status, durable.text]);

    const second = (await createInject(session.id, 2)).body;
    const releaseComplete = await Promise.all([
      request(application()).post(`/api/exercise/injects/${second.id}/release`).set(as(coordinator.email)).send({ expectedVersion: 1 }),
      request(application()).post(`/api/exercise/injects/${second.id}/complete`).set(as(coordinator.email)).send({ expectedVersion: 1 })
    ]);
    expect(releaseComplete.filter((response) => response.status === 200)).toHaveLength(1);
    expect((await prisma!.exerciseInject.findUniqueOrThrow({ where: { id: second.id } })).status).toBe("Released");
    expect(await prisma!.auditLog.count({ where: { entityId: second.id, action: { in: ["exercise_inject_released", "exercise_inject_completed"] } } })).toBe(1);
  });

  it("creates exactly one immutable Observation revision per version and rejects stale concurrent updates", async () => {
    const session = await incident("OBSERVATION-HISTORY");
    const created = (await createObservation(session.id)).body;
    const updates = await Promise.all([
      request(application()).patch(`/api/exercise/observations/${created.id}`).set(as(coordinator.email)).send({ expectedVersion: 1, severity: "High", recommendation: `${marker} revised A` }),
      request(application()).patch(`/api/exercise/observations/${created.id}`).set(as(coordinator.email)).send({ expectedVersion: 1, severity: "Medium", recommendation: `${marker} revised B` })
    ]);
    expect(updates.map((response) => response.status).sort()).toEqual([200, 409]);
    const current = await prisma!.exerciseObservation.findUniqueOrThrow({ where: { id: created.id } });
    const history = await request(application()).get(`/api/exercise/observations/${created.id}/history`).set(as(coordinator.email)).query({ limit: 1, offset: 0 });
    expect(history.body).toMatchObject({ total: 2, limit: 1, offset: 0, data: [{ version: 1 }] });
    const revisions = await prisma!.exerciseObservationRevision.findMany({ where: { observationId: created.id }, orderBy: { version: "asc" } });
    expect(revisions.map((revision) => revision.version)).toEqual([1, 2]);
    expect(revisions).toHaveLength(current.version);
    await expect(prisma!.exerciseObservationRevision.update({ where: { observationId_version: { observationId: created.id, version: 1 } }, data: { severity: "Medium" } })).rejects.toBeTruthy();
    await expect(prisma!.exerciseObservationRevision.delete({ where: { observationId_version: { observationId: created.id, version: 1 } } })).rejects.toBeTruthy();
    await expect(prisma!.$transaction(async (tx) => tx.exerciseObservation.update({ where: { id: created.id }, data: { version: { increment: 1 } } }))).rejects.toBeTruthy();
    await expect(prisma!.$transaction(async (tx) => tx.exerciseObservationRevision.create({ data: {
      id: randomUUID(), observationId: created.id, version: 2, area: created.area, severity: created.severity,
      observation: created.observation, recommendation: created.recommendation, owner: created.owner,
      includeInAar: created.includeInAar, status: created.status, changedFields: [], changedById: coordinator.id, source: "Mutation"
    } }))).rejects.toBeTruthy();
  });

  it("rolls back entity, revision and Audit for every injected transactional failure seam", async () => {
    const session = await incident("ROLLBACK");
    const createCases = [
      { beforeEntityCreate: () => { throw new Error("entity create failure"); } },
      { afterEntityCreateBeforeAudit: () => { throw new Error("entity-audit gap"); } },
      { beforeRevisionInsert: () => { throw new Error("revision failure"); } },
      { afterRevisionInsertBeforeAudit: () => { throw new Error("revision-audit gap"); } }
    ];
    for (const hooks of createCases) {
      const operationId = randomUUID();
      const response = await createObservation(session.id, { operationId }, coordinator.email, application(createPrismaExerciseService(prisma!, hooks)));
      expect(response.status).toBe(500);
      expect(await prisma!.exerciseObservation.count({ where: { createOperationId: operationId } })).toBe(0);
      expect(await prisma!.auditLog.count({ where: { sessionId: session.id, action: "exercise_observation_created", metadata: { path: ["operationId"], equals: operationId } } })).toBe(0);
    }
    const injectOperation = randomUUID();
    const injectFailure = await createInject(session.id, 1, { operationId: injectOperation }, coordinator.email, application(createPrismaExerciseService(prisma!, { afterEntityCreateBeforeAudit: () => { throw new Error("audit failure"); } })));
    expect(injectFailure.status).toBe(500);
    expect(await prisma!.exerciseInject.count({ where: { createOperationId: injectOperation } })).toBe(0);

    const injectable = (await createInject(session.id, 2)).body;
    expect((await request(application(createPrismaExerciseService(prisma!, { beforeReleaseAudit: () => { throw new Error("release audit"); } }))).post(`/api/exercise/injects/${injectable.id}/release`).set(as(coordinator.email)).send({ expectedVersion: 1 })).status).toBe(500);
    expect((await prisma!.exerciseInject.findUniqueOrThrow({ where: { id: injectable.id } })).status).toBe("Planned");
    const released = (await request(application()).post(`/api/exercise/injects/${injectable.id}/release`).set(as(coordinator.email)).send({ expectedVersion: 1 })).body;
    expect((await request(application(createPrismaExerciseService(prisma!, { beforeCompleteAudit: () => { throw new Error("complete audit"); } }))).post(`/api/exercise/injects/${injectable.id}/complete`).set(as(coordinator.email)).send({ expectedVersion: released.version })).status).toBe(500);
    expect((await prisma!.exerciseInject.findUniqueOrThrow({ where: { id: injectable.id } })).status).toBe("Released");
  });

  it("denies every cross-Incident ID/list/create/history path and honors DENY, revoked and expired overrides", async () => {
    const [incidentA, incidentB] = await Promise.all([incident("SCOPE-A"), incident("SCOPE-B")]);
    const user = await scopedUser("scope", [incidentA, incidentB], incidentA);
    const injectB = (await createInject(incidentB.id, 1)).body;
    const observationB = (await createObservation(incidentB.id)).body;
    expect((await request(application()).get("/api/exercise/injects").set(as(user.email)).query({ sessionId: incidentB.id })).status).toBe(403);
    expect((await createInject(incidentB.id, 2, {}, user.email)).status).toBe(403);
    expect((await request(application()).patch(`/api/exercise/injects/${injectB.id}`).set(as(user.email)).send({ expectedVersion: 1, text: "denied" })).status).toBe(404);
    expect((await request(application()).post(`/api/exercise/injects/${injectB.id}/release`).set(as(user.email)).send({ expectedVersion: 1 })).status).toBe(404);
    expect((await request(application()).post(`/api/exercise/injects/${injectB.id}/complete`).set(as(user.email)).send({ expectedVersion: 1 })).status).toBe(404);
    expect((await request(application()).get("/api/exercise/observations").set(as(user.email)).query({ sessionId: incidentB.id })).status).toBe(403);
    expect((await createObservation(incidentB.id, {}, user.email)).status).toBe(403);
    expect((await request(application()).patch(`/api/exercise/observations/${observationB.id}`).set(as(user.email)).send({ expectedVersion: 1, severity: "High" })).status).toBe(404);
    expect((await request(application()).get(`/api/exercise/observations/${observationB.id}/history`).set(as(user.email))).status).toBe(404);
    expect(await prisma!.auditLog.count({ where: { sessionId: incidentB.id, actorId: user.id } })).toBe(0);

    expect((await createInject(incidentA.id, 1, {}, user.email)).status).toBe(201);
    const deny = await prisma!.permissionOverride.create({ data: { userId: user.id, permission: "exercise:manage", effect: "DENY", active: true, reason: marker, createdById: coordinator.id } });
    expect((await createObservation(incidentA.id, {}, user.email)).status).toBe(403);
    await prisma!.permissionOverride.update({ where: { id: deny.id }, data: { active: false, revokedAt: new Date(), revokedById: coordinator.id, revokeReason: marker } });
    expect((await createObservation(incidentA.id, {}, user.email)).status).toBe(201);
    await prisma!.permissionOverride.create({ data: { userId: user.id, permission: "exercise:manage", effect: "DENY", active: true, expiresAt: new Date(Date.now() - 60_000), reason: marker, createdById: coordinator.id } });
    expect((await createInject(incidentA.id, 2, {}, user.email)).status).toBe(201);
    expect((await createInject(incidentB.id, 3, {}, "admin@lot.pl")).status).toBe(201);
  });

  it("allows authorized closed evidence reads but rejects all closed mutations", async () => {
    const session = await incident("CLOSED-SEQUENTIAL");
    const inject = (await createInject(session.id, 1)).body;
    const observation = (await createObservation(session.id)).body;
    await prisma!.session.update({ where: { id: session.id }, data: { status: "Closed" } });
    expect((await request(application()).get("/api/exercise/injects").set(as(coordinator.email)).query({ sessionId: session.id })).status).toBe(200);
    expect((await request(application()).get("/api/exercise/observations").set(as(coordinator.email)).query({ sessionId: session.id })).status).toBe(200);
    expect((await request(application()).get(`/api/exercise/observations/${observation.id}/history`).set(as(coordinator.email))).status).toBe(200);
    expect((await createInject(session.id, 2)).status).toBe(409);
    expect((await createObservation(session.id)).status).toBe(409);
    expect((await request(application()).patch(`/api/exercise/injects/${inject.id}`).set(as(coordinator.email)).send({ expectedVersion: 1, text: "closed" })).status).toBe(409);
    expect((await request(application()).post(`/api/exercise/injects/${inject.id}/release`).set(as(coordinator.email)).send({ expectedVersion: 1 })).status).toBe(409);
    expect((await request(application()).patch(`/api/exercise/observations/${observation.id}`).set(as(coordinator.email)).send({ expectedVersion: 1, severity: "High" })).status).toBe(409);
  });

  it("serializes create and update against Incident close with no close-first evidence or partial revision", async () => {
    const outsider = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    for (const kind of ["inject", "observation"] as const) {
      const session = await incident(`CLOSE-FIRST-${kind}`);
      let locked!: () => void; const lockedPromise = new Promise<void>((resolve) => { locked = resolve; });
      let release!: () => void; const releasePromise = new Promise<void>((resolve) => { release = resolve; });
      const closer = outsider.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Session" WHERE "id" = ${session.id}::uuid FOR UPDATE`);
        locked(); await releasePromise;
        await tx.session.update({ where: { id: session.id }, data: { status: "Closed" } });
      });
      await lockedPromise;
      const mutation = kind === "inject" ? createInject(session.id, 1) : createObservation(session.id);
      release(); await closer;
      expect((await mutation).status).toBe(409);
      const evidenceCount = kind === "inject"
        ? await prisma!.exerciseInject.count({ where: { sessionId: session.id } })
        : await prisma!.exerciseObservation.count({ where: { sessionId: session.id } });
      expect(evidenceCount).toBe(0);
    }

    const session = await incident("UPDATE-CLOSE-FIRST");
    const observation = (await createObservation(session.id)).body;
    let locked!: () => void; const lockedPromise = new Promise<void>((resolve) => { locked = resolve; });
    let release!: () => void; const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const closer = outsider.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Session" WHERE "id" = ${session.id}::uuid FOR UPDATE`);
      locked(); await releasePromise; await tx.session.update({ where: { id: session.id }, data: { status: "Closed" } });
    });
    await lockedPromise;
    const update = request(application()).patch(`/api/exercise/observations/${observation.id}`).set(as(coordinator.email)).send({ expectedVersion: 1, severity: "High" });
    release(); await closer;
    expect((await update).status).toBe(409);
    expect(await prisma!.exerciseObservationRevision.count({ where: { observationId: observation.id } })).toBe(1);
    expect(await prisma!.auditLog.count({ where: { entityId: observation.id, action: "exercise_observation_updated" } })).toBe(0);
    await outsider.$disconnect();
  });

  it("allows mutation-first serialization before close and never commits an Exercise mutation after closure", async () => {
    const session = await incident("MUTATION-FIRST");
    let mutationLocked!: () => void; const mutationLockedPromise = new Promise<void>((resolve) => { mutationLocked = resolve; });
    let releaseMutation!: () => void; const releaseMutationPromise = new Promise<void>((resolve) => { releaseMutation = resolve; });
    const service = createPrismaExerciseService(prisma!, { afterSessionLock: async (operation) => { if (operation === "create-inject") { mutationLocked(); await releaseMutationPromise; } } });
    const mutation = Promise.resolve(createInject(session.id, 1, {}, coordinator.email, application(service)));
    await mutationLockedPromise;
    releaseMutation();
    const close = request(application()).post(`/api/sessions/${session.id}/close`).set(as(coordinator.email)).send({ notes: marker });
    const [mutationResponse, closeResponse] = await Promise.all([mutation, close]);
    expect(mutationResponse.status).toBe(201);
    expect(closeResponse.status).toBe(200);
    expect((await prisma!.session.findUniqueOrThrow({ where: { id: session.id } })).status).toBe("Closed");
    expect(await prisma!.exerciseInject.count({ where: { sessionId: session.id } })).toBe(1);
  }, 15_000);

  it("survives two process reconstructions across create, release, observation update/history and completion", async () => {
    const session = await incident("RESTART");
    const firstApp = application();
    const inject = (await createInject(session.id, 1, {}, coordinator.email, firstApp)).body;
    expect((await request(firstApp).post(`/api/exercise/injects/${inject.id}/release`).set(as(coordinator.email)).send({ expectedVersion: 1 })).status).toBe(200);
    const observation = (await createObservation(session.id, {}, coordinator.email, firstApp)).body;
    expect((await request(firstApp).patch(`/api/exercise/observations/${observation.id}`).set(as(coordinator.email)).send({ expectedVersion: 1, status: "In review", includeInAar: false })).status).toBe(200);
    const restarted = application();
    expect((await request(restarted).get("/api/exercise/injects").set(as(coordinator.email)).query({ sessionId: session.id })).body.data[0]).toMatchObject({ id: inject.id, status: "Released" });
    expect((await request(restarted).get(`/api/exercise/observations/${observation.id}/history`).set(as(coordinator.email))).body.total).toBe(2);
    const released = await prisma!.exerciseInject.findUniqueOrThrow({ where: { id: inject.id } });
    expect((await request(restarted).post(`/api/exercise/injects/${inject.id}/complete`).set(as(coordinator.email)).send({ expectedVersion: released.version })).status).toBe(200);
    const restartedAgain = application();
    expect((await request(restartedAgain).get("/api/exercise/injects").set(as(coordinator.email)).query({ sessionId: session.id })).body.data[0]).toMatchObject({ id: inject.id, status: "Completed" });
  });

  it("pages all 1,005 durable Injects with stable first, middle and final pages and no hidden 200 cap", async () => {
    const session = await incident("SCALE-1005");
    const role = await prisma!.role.findUniqueOrThrow({ where: { normalizedName: "tec-member" } });
    await prisma!.exerciseInject.createMany({ data: Array.from({ length: 1005 }, (_, index) => ({
      operationalId: `${marker}-SCALE-${String(index + 1).padStart(4, "0")}`, sessionId: session.id,
      injectNumber: index + 1, targetRoleId: role.id, targetRoleKey: role.normalizedName,
      targetRole: role.displayName, text: `${marker} scale ${index + 1}`, status: "Planned",
      createdById: coordinator.id, updatedById: coordinator.id
    })) });
    const first = await request(application()).get("/api/exercise/injects").set(as(coordinator.email)).query({ sessionId: session.id, limit: 200, offset: 0 });
    const middle = await request(application()).get("/api/exercise/injects").set(as(coordinator.email)).query({ sessionId: session.id, limit: 200, offset: 400 });
    const final = await request(application()).get("/api/exercise/injects").set(as(coordinator.email)).query({ sessionId: session.id, limit: 200, offset: 1000 });
    expect(first.body.total).toBe(1005);
    expect(first.body.data).toHaveLength(200);
    expect(first.body.data[0]).toMatchObject({ injectNumber: 1 });
    expect(middle.body.data[0].injectNumber).toBe(401);
    expect(final.body.data.map((row: { injectNumber: number }) => row.injectNumber)).toEqual([1001, 1002, 1003, 1004, 1005]);
    const pages = await Promise.all([0, 200, 400, 600, 800, 1000].map((offset) => request(application()).get("/api/exercise/injects").set(as(coordinator.email)).query({ sessionId: session.id, limit: 200, offset })));
    const numbers = pages.flatMap((response) => response.body.data.map((row: { injectNumber: number }) => row.injectNumber));
    expect(numbers).toEqual(Array.from({ length: 1005 }, (_, index) => index + 1));
    expect(new Set(numbers).size).toBe(1005);
  }, 30_000);
});
