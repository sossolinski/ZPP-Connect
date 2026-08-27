import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { parseWorkbook } from "./exporters.js";
import { createPrismaImportService } from "./modules/imports/prisma-import-service.js";
import { createPrismaIncidentRepository } from "./modules/incidents/prisma-incident-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;
const prisma = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;
const as = (email: string) => ({ "x-user-email": email });

postgresDescribe("Foundation Stage 16 PostgreSQL Imports persistence and orchestration integrity", () => {
  const marker = `F16-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const incidentIds: string[] = [];
  const userIds: string[] = [];
  const roleIds: string[] = [];
  const groupIds: string[] = [];
  let coordinator: { id: string; email: string; displayName: string };
  const actor = () => ({ id: coordinator.id, email: coordinator.email, displayName: coordinator.displayName, roles: ["zpp-coordinator"], requestId: randomUUID() });

  async function incident(suffix: string, status = "Active", assignedUserIds: string[] = []) {
    const row = await prisma!.session.create({ data: { operationalId: `${marker}-${suffix}`, mode: "EXERCISE", status, eventType: marker, createdById: coordinator.id } });
    incidentIds.push(row.id);
    await prisma!.incidentAssignment.createMany({
      data: Array.from(new Set([coordinator.id, ...assignedUserIds])).map((userId) => ({ incidentId: row.id, userId, function: marker, createdById: coordinator.id }))
    });
    return row;
  }

  function manifestCsv(count: number, suffix: string, invalidRow = -1) {
    return [
      "firstName,lastName,personType,source,sourceExternalId,age,seat",
      ...Array.from({ length: count }, (_, index) => index === invalidRow
        ? `,Invalid-${suffix}-${index},Passenger,Manifest,${marker}-${suffix}-${index},30,${index + 1}A`
        : `First-${suffix}-${index},Last-${suffix}-${index},Passenger,Manifest,${marker}-${suffix}-${index},${20 + (index % 50)},${index + 1}A`)
    ].join("\n");
  }

  function familyCsv(count: number, suffix: string, invalidRow = -1) {
    return [
      "firstName,lastName,email,claimedRelationship,passengerFirstName,passengerLastName",
      ...Array.from({ length: count }, (_, index) => index === invalidRow
        ? `Family-${suffix}-${index},Member-${index},invalid-email,Parent,Passenger,${index}`
        : `Family-${suffix}-${index},Member-${index},family-${suffix}-${index}@example.test,Parent,Passenger,${index}`)
    ].join("\n");
  }

  function app(service = createPrismaImportService(prisma!)) {
    return createApp({ importService: service });
  }

  function validate(api: ReturnType<typeof createApp>, incidentId: string, type: "manifest" | "family", csv: string, operationId = randomUUID(), email = coordinator.email, filename = `${type}.csv`) {
    return request(api)
      .post(`/api/imports/${type}`)
      .set(as(email))
      .field("sessionId", incidentId)
      .field("operationId", operationId)
      .attach("file", Buffer.from(csv), { filename, contentType: "text/csv" });
  }

  beforeAll(async () => {
    coordinator = await prisma!.user.findUniqueOrThrow({ where: { email: "coordinator@lot.pl" }, select: { id: true, email: true, displayName: true } });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.notification.deleteMany({ where: { OR: [{ sessionId: { in: incidentIds } }, { recipientUserId: { in: userIds } }] } });
    await prisma.notificationOutbox.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.relationshipVerificationDecision.deleteMany({ where: { incidentId: { in: incidentIds } } });
    await prisma.relationshipClaim.deleteMany({ where: { incidentId: { in: incidentIds } } });
    await prisma.familyRecord.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.passengerRecord.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.caseTimelineEvent.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ sessionId: { in: incidentIds } }, { actorId: { in: userIds } }] } });
    await prisma.importBatch.deleteMany({ where: { sessionId: { in: incidentIds } } });
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

  it("installs migration 19 with durable row constraints and preserves nullable historical provenance", async () => {
    const migrations = await prisma!.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    const indexes = await prisma!.$queryRaw<Array<{ indexname: string }>>`SELECT indexname FROM pg_indexes WHERE tablename IN ('ImportBatch', 'ImportValidatedRow')`;
    const checks = await prisma!.$queryRaw<Array<{ conname: string }>>`SELECT conname FROM pg_constraint WHERE conrelid IN ('"ImportBatch"'::regclass, '"ImportValidatedRow"'::regclass) AND contype = 'c'`;
    expect(Number(migrations[0]!.count)).toBeGreaterThanOrEqual(21);
    expect(indexes.map((row) => row.indexname)).toEqual(expect.arrayContaining([
      "ImportBatch_validationOperationId_key",
      "ImportValidatedRow_importBatchId_rowNumber_key",
      "ImportValidatedRow_importBatchId_validationStatus_rowNumber_idx"
    ]));
    expect(checks.map((row) => row.conname)).toEqual(expect.arrayContaining([
      "ImportBatch_validation_provenance_check",
      "ImportValidatedRow_status_check",
      "ImportValidatedRow_evidence_check"
    ]));
  });

  it("survives manifest Validate -> restart -> read/page -> Confirm -> restart with exact provenance and side effects", async () => {
    const session = await incident("MANIFEST-RESTART");
    const csv = manifestCsv(3, "manifest-restart");
    const validated = await validate(app(), session.id, "manifest", csv);
    expect(validated.status, JSON.stringify(validated.body)).toBe(201);
    expect(validated.body).toMatchObject({ status: "Validated", totalRecords: 3, validRecords: 3, invalidRecords: 0, sourceStored: false, sourceSizeBytes: Buffer.byteLength(csv), previewRows: expect.any(Array) });
    expect(validated.body.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await prisma!.storedFile.count({ where: { importBatchId: validated.body.id } })).toBe(0);
    expect(await prisma!.auditLog.count({ where: { entityId: validated.body.id, action: "validate_import" } })).toBe(1);

    const restarted = app();
    const [batchRead, rowsRead, filesRead] = await Promise.all([
      request(restarted).get(`/api/imports/${validated.body.id}`).set(as(coordinator.email)),
      request(restarted).get(`/api/imports/${validated.body.id}/rows`).set(as(coordinator.email)).query({ limit: 2, offset: 1 }),
      request(restarted).get("/api/files").set(as(coordinator.email)).query({ sessionId: session.id })
    ]);
    expect(batchRead.status).toBe(200);
    expect(rowsRead.body).toMatchObject({ total: 3, limit: 2, offset: 1, data: [{ rowNumber: 3, validationStatus: "VALID" }, { rowNumber: 4, validationStatus: "VALID" }] });
    expect(filesRead.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ importBatchId: validated.body.id, sourceStored: false })]));

    const confirmed = await request(restarted).post(`/api/imports/${validated.body.id}/confirm`).set(as(coordinator.email)).send({ sessionId: randomUUID(), records: [{ firstName: "untrusted" }] });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body).toMatchObject({ status: "Imported", replayed: false, confirmedById: coordinator.id });
    const finalRead = await request(app()).get(`/api/imports/${validated.body.id}`).set(as(coordinator.email));
    expect(finalRead.body).toMatchObject({ status: "Imported", validRecords: 3 });
    expect(await prisma!.passengerRecord.count({ where: { sourceBatchId: validated.body.id } })).toBe(3);
    expect(await prisma!.auditLog.count({ where: { entityId: validated.body.id, action: "import_passenger_manifest" } })).toBe(1);
    expect(await prisma!.caseTimelineEvent.count({ where: { entityId: validated.body.id, eventType: "passenger_import" } })).toBe(1);
  });

  it("survives Family Validate/Confirm restarts and atomically creates RelationshipClaims", async () => {
    const session = await incident("FAMILY-RESTART");
    const validated = await validate(app(), session.id, "family", familyCsv(3, "family-restart"));
    expect(validated.status).toBe(201);
    const readAfterRestart = await request(app()).get(`/api/imports/${validated.body.id}`).set(as(coordinator.email));
    expect(readAfterRestart.body).toMatchObject({ status: "Validated", importType: "family", validRecords: 3 });
    const confirmed = await request(app()).post(`/api/imports/${validated.body.id}/confirm`).set(as(coordinator.email)).send({});
    expect(confirmed.status).toBe(200);
    const families = await prisma!.familyRecord.findMany({ where: { sourceBatchId: validated.body.id }, include: { relationshipClaims: true } });
    expect(families).toHaveLength(3);
    expect(families.every((family) => family.relationshipClaims.length === 1 && family.relationshipClaims[0]!.source === "IMPORT")).toBe(true);
    expect((await request(app()).get(`/api/imports/${validated.body.id}`).set(as(coordinator.email))).body.status).toBe("Imported");
    expect(await prisma!.auditLog.count({ where: { entityId: validated.body.id, action: "import_family_records" } })).toBe(1);
    expect(await prisma!.caseTimelineEvent.count({ where: { entityId: validated.body.id, eventType: "family_import" } })).toBe(1);
  });

  it("binds validation operationId to semantic content with deterministic sequential and concurrent replay", async () => {
    const session = await incident("VALIDATE-IDEMPOTENCY");
    const api = app();
    const operationId = randomUUID();
    const csv = manifestCsv(2, "validate-idempotency");
    const [left, right] = await Promise.all([
      validate(api, session.id, "manifest", csv, operationId),
      validate(api, session.id, "manifest", csv, operationId)
    ]);
    expect([left.status, right.status].sort()).toEqual([200, 201]);
    expect(left.body.id).toBe(right.body.id);
    const replay = await validate(app(), session.id, "manifest", csv, operationId);
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(left.body.id);
    const conflict = await validate(api, session.id, "manifest", manifestCsv(1, "different-content"), operationId);
    expect(conflict.status).toBe(409);
    expect(JSON.stringify(conflict.body)).not.toMatch(/Prisma|P2002|constraint|SQL/i);
    expect(await prisma!.importBatch.count({ where: { validationOperationId: operationId } })).toBe(1);
    expect(await prisma!.auditLog.count({ where: { entityId: left.body.id, action: "validate_import" } })).toBe(1);
  });

  it("imports the valid subset from a durable Validated-with-errors snapshot", async () => {
    const session = await incident("VALID-SUBSET");
    const validated = await validate(app(), session.id, "manifest", manifestCsv(4, "valid-subset", 1));
    expect(validated.body).toMatchObject({ status: "Validated with errors", totalRecords: 4, validRecords: 3, invalidRecords: 1 });
    const invalidRows = await request(app()).get(`/api/imports/${validated.body.id}/rows`).set(as(coordinator.email)).query({ validationStatus: "INVALID" });
    expect(invalidRows.body).toMatchObject({ total: 1, data: [expect.objectContaining({ rowNumber: 3, validationStatus: "INVALID", errorCode: "ROW_VALIDATION_ERROR" })] });
    const confirmed = await request(app()).post(`/api/imports/${validated.body.id}/confirm`).set(as(coordinator.email)).send({});
    expect(confirmed.body).toMatchObject({ status: "Imported with errors", validRecords: 3, invalidRecords: 1 });
    expect(await prisma!.passengerRecord.count({ where: { sourceBatchId: validated.body.id } })).toBe(3);
  });

  it("serializes concurrent Confirm and lost-response replay to [200, 200] with exactly-once effects", async () => {
    const session = await incident("CONFIRM-IDEMPOTENCY");
    const validated = await validate(app(), session.id, "manifest", manifestCsv(5, "confirm-idempotency"));
    const api = app();
    const responses = await Promise.all([
      request(api).post(`/api/imports/${validated.body.id}/confirm`).set(as(coordinator.email)).send({}),
      request(api).post(`/api/imports/${validated.body.id}/confirm`).set(as(coordinator.email)).send({})
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responses.filter((response) => response.body.replayed === false)).toHaveLength(1);
    expect(responses.filter((response) => response.body.replayed === true)).toHaveLength(1);
    const replay = await request(app()).post(`/api/imports/${validated.body.id}/confirm`).set(as(coordinator.email)).send({});
    expect(replay).toMatchObject({ status: 200, body: expect.objectContaining({ status: "Imported", replayed: true }) });
    expect(await prisma!.passengerRecord.count({ where: { sourceBatchId: validated.body.id } })).toBe(5);
    expect(await prisma!.auditLog.count({ where: { entityId: validated.body.id, action: "import_passenger_manifest" } })).toBe(1);
    expect(await prisma!.caseTimelineEvent.count({ where: { entityId: validated.body.id, eventType: "passenger_import" } })).toBe(1);
  });

  it("pages and confirms 1,005 rows with exact counts, bounded preview and no hidden 200-row cap", async () => {
    const session = await incident("SCALE-1005");
    const validated = await validate(app(), session.id, "manifest", manifestCsv(1005, "scale-1005"));
    expect(validated.status, JSON.stringify(validated.body)).toBe(201);
    expect(validated.body).toMatchObject({ totalRecords: 1005, validRecords: 1005, invalidRecords: 0 });
    expect(validated.body.previewRows).toHaveLength(10);
    const page = await request(app()).get(`/api/imports/${validated.body.id}/rows`).set(as(coordinator.email)).query({ limit: 200, offset: 900 });
    expect(page.body).toMatchObject({ total: 1005, limit: 200, offset: 900 });
    expect(page.body.data).toHaveLength(105);
    const confirmed = await request(app()).post(`/api/imports/${validated.body.id}/confirm`).set(as(coordinator.email)).send({});
    expect(confirmed.body).toMatchObject({ status: "Imported", totalRecords: 1005, validRecords: 1005 });
    expect(await prisma!.passengerRecord.count({ where: { sourceBatchId: validated.body.id } })).toBe(1005);
  }, 30_000);

  it("rejects cross-Incident GROUP authority despite an unrelated IncidentAssignment and leaves zero side effects", async () => {
    const email = `${marker.toLowerCase()}-group@example.test`;
    const user = await prisma!.user.create({ data: { email, normalizedEmail: email, displayName: `${marker} group user`, status: "Active", authenticationPolicy: "SSO_ONLY" } });
    userIds.push(user.id);
    const role = await prisma!.role.create({ data: { name: `${marker.toLowerCase()}-group-role`, displayName: `${marker} group role`, permissions: ["import:create", "passenger:create"], scopeTypes: ["GROUP"], custom: true } });
    roleIds.push(role.id);
    await prisma!.userRole.create({ data: { userId: user.id, roleId: role.id, scopeType: "GROUP", assignedBy: coordinator.id } });
    const [incidentA, incidentB] = await Promise.all([incident("GROUP-A", "Active", [user.id]), incident("GROUP-B", "Active", [user.id])]);
    const group = await prisma!.operationalGroup.create({ data: { id: `${marker}-group`, operationalId: `${marker}-GRP`, incidentId: incidentA.id, name: marker, pool: "ZPP", functionName: "Imports", createdById: coordinator.id } });
    groupIds.push(group.id);
    await prisma!.groupRoleAssignment.create({ data: { id: `${marker}-gra`, userId: user.id, roleId: role.id, groupId: group.id, assignedBy: coordinator.id } });

    const uploadDir = path.resolve(config.dataDir, "uploads");
    const beforeFiles = await fs.readdir(uploadDir).catch(() => [] as string[]);
    const denied = await validate(app(), incidentB.id, "manifest", manifestCsv(1, "group-denied"), randomUUID(), email);
    expect(denied.status).toBe(403);
    expect(await prisma!.importBatch.count({ where: { sessionId: incidentB.id } })).toBe(0);
    expect(await prisma!.auditLog.count({ where: { sessionId: incidentB.id, action: "validate_import", actorId: user.id } })).toBe(0);
    expect(await prisma!.caseTimelineEvent.count({ where: { sessionId: incidentB.id, createdById: user.id } })).toBe(0);
    expect(await fs.readdir(uploadDir).catch(() => [] as string[])).toEqual(beforeFiles);

    const allowed = await validate(app(), incidentA.id, "manifest", manifestCsv(1, "group-allowed"), randomUUID(), email);
    expect(allowed.status).toBe(201);
    const deny = await prisma!.permissionOverride.create({ data: { userId: user.id, permission: "passenger:create", effect: "DENY", active: true, reason: marker, createdById: coordinator.id } });
    const deniedOperationId = randomUUID();
    expect((await validate(app(), incidentA.id, "manifest", manifestCsv(1, "active-deny"), deniedOperationId, email)).status).toBe(403);
    expect(await prisma!.importBatch.count({ where: { validationOperationId: deniedOperationId } })).toBe(0);
    await prisma!.permissionOverride.update({ where: { id: deny.id }, data: { active: false, revokedAt: new Date(), revokedById: coordinator.id, revokeReason: marker } });
    expect((await validate(app(), incidentA.id, "manifest", manifestCsv(1, "revoked-deny"), randomUUID(), email)).status).toBe(201);
    const coordBatch = await validate(app(), incidentB.id, "manifest", manifestCsv(1, "group-read-denied"));
    expect((await request(app()).get(`/api/imports/${coordBatch.body.id}`).set(as(email))).status).toBe(403);
    expect((await request(app()).get(`/api/imports/${coordBatch.body.id}/rows`).set(as(email))).status).toBe(403);
    expect((await request(app()).post(`/api/imports/${coordBatch.body.id}/confirm`).set(as(email)).send({})).status).toBe(403);
  });

  it("returns controlled 400/404 for invalid types, files and batch enumeration without durable writes", async () => {
    const session = await incident("INVALID-INPUT");
    const api = app();
    const invalidType = await request(api).post("/api/imports/not-family").set(as(coordinator.email)).field("sessionId", session.id).field("operationId", randomUUID()).attach("file", Buffer.from("a\nb"), { filename: "x.csv", contentType: "text/csv" });
    expect(invalidType.status).toBe(400);
    const invalidMime = await request(api).post("/api/imports/manifest").set(as(coordinator.email)).field("sessionId", session.id).field("operationId", randomUUID()).attach("file", Buffer.from("a\nb"), { filename: "x.csv", contentType: "application/octet-stream" });
    expect(invalidMime.status).toBe(400);
    const malformed = await request(api).post("/api/imports/manifest").set(as(coordinator.email)).field("sessionId", session.id).field("operationId", randomUUID()).attach("file", Buffer.from('firstName,lastName\n"unterminated,value'), { filename: "x.csv", contentType: "text/csv" });
    expect(malformed.status).toBe(400);
    expect((await request(api).get("/api/imports/not-a-uuid").set(as(coordinator.email))).status).toBe(404);
    expect((await request(api).get(`/api/imports/${randomUUID()}`).set(as(coordinator.email))).status).toBe(404);
    expect(await prisma!.importBatch.count({ where: { sessionId: session.id } })).toBe(0);
  });

  it("rolls back validation row and Audit failures completely", async () => {
    const session = await incident("VALIDATE-ROLLBACK");
    for (const [suffix, hooks] of [
      ["rows", { duringValidatedRowWrite: () => { throw new Error("injected row failure"); } }],
      ["audit", { beforeValidationAudit: () => { throw new Error("injected audit failure"); } }]
    ] as const) {
      const operationId = randomUUID();
      const failed = await validate(app(createPrismaImportService(prisma!, hooks)), session.id, "manifest", manifestCsv(2, `validation-${suffix}`), operationId);
      expect(failed.status).toBe(500);
      expect(failed.body).toEqual({ error: "Internal server error" });
      expect(await prisma!.importBatch.count({ where: { validationOperationId: operationId } })).toBe(0);
      expect(await prisma!.auditLog.count({ where: { sessionId: session.id, action: "validate_import", metadata: { path: ["operationId"], equals: operationId } } })).toBe(0);
    }
  });

  it("rolls back target, Audit and Timeline confirmation failures while retaining the validated snapshot", async () => {
    const session = await incident("CONFIRM-ROLLBACK");
    const cases = [
      ["before-target", { beforeConfirmationTargetWrite: () => { throw new Error("injected pre-target failure"); } }],
      ["target", { duringConfirmationTargetWrite: () => { throw new Error("injected target failure"); } }],
      ["audit", { beforeConfirmationAudit: () => { throw new Error("injected audit failure"); } }],
      ["timeline", { beforeConfirmationTimeline: () => { throw new Error("injected timeline failure"); } }]
    ] as const;
    for (const [suffix, hooks] of cases) {
      const validated = await validate(app(), session.id, "manifest", manifestCsv(2, `confirm-${suffix}`));
      const failed = await request(app(createPrismaImportService(prisma!, hooks))).post(`/api/imports/${validated.body.id}/confirm`).set(as(coordinator.email)).send({});
      expect(failed.status).toBe(500);
      expect(await prisma!.passengerRecord.count({ where: { sourceBatchId: validated.body.id } })).toBe(0);
      expect(await prisma!.auditLog.count({ where: { entityId: validated.body.id, action: "import_passenger_manifest" } })).toBe(0);
      expect(await prisma!.caseTimelineEvent.count({ where: { entityId: validated.body.id, eventType: "passenger_import" } })).toBe(0);
      expect(await prisma!.importBatch.findUniqueOrThrow({ where: { id: validated.body.id } })).toMatchObject({ status: "Validated", confirmedAt: null, version: 1 });
      expect(await prisma!.importValidatedRow.count({ where: { importBatchId: validated.body.id } })).toBe(2);
    }
    const family = await validate(app(), session.id, "family", familyCsv(2, "family-target-rollback"));
    const familyFailed = await request(app(createPrismaImportService(prisma!, { duringConfirmationTargetWrite: () => { throw new Error("injected family target failure"); } })))
      .post(`/api/imports/${family.body.id}/confirm`).set(as(coordinator.email)).send({});
    expect(familyFailed.status).toBe(500);
    expect(await prisma!.familyRecord.count({ where: { sourceBatchId: family.body.id } })).toBe(0);
    expect(await prisma!.relationshipClaim.count({ where: { familyRecord: { sourceBatchId: family.body.id } } })).toBe(0);
    expect(await prisma!.importBatch.findUniqueOrThrow({ where: { id: family.body.id } })).toMatchObject({ status: "Validated", confirmedAt: null });
  });

  it("keeps the batch Validated and imports nothing when target-domain source identity changes after validation", async () => {
    const session = await incident("TARGET-CONFLICT");
    const suffix = "target-conflict";
    const validated = await validate(app(), session.id, "manifest", manifestCsv(1, suffix));
    await prisma!.passengerRecord.create({
      data: {
        operationalId: `${marker}-PAX-CONFLICT`, sessionId: session.id, personType: "Passenger", firstName: "Existing", lastName: "Identity",
        source: "Manifest", sourceExternalId: `${marker}-${suffix}-0`, createdById: coordinator.id, updatedById: coordinator.id
      }
    });
    const conflict = await request(app()).post(`/api/imports/${validated.body.id}/confirm`).set(as(coordinator.email)).send({});
    expect(conflict.status).toBe(409);
    expect(JSON.stringify(conflict.body)).not.toMatch(/P2002|Prisma|constraint|SQL/i);
    expect(await prisma!.passengerRecord.count({ where: { sourceBatchId: validated.body.id } })).toBe(0);
    expect(await prisma!.importBatch.findUniqueOrThrow({ where: { id: validated.body.id } })).toMatchObject({ status: "Validated", confirmedAt: null });
    expect(await prisma!.auditLog.count({ where: { entityId: validated.body.id, action: "import_passenger_manifest" } })).toBe(0);
    expect(await prisma!.caseTimelineEvent.count({ where: { entityId: validated.body.id, eventType: "passenger_import" } })).toBe(0);
  });

  it("serializes Confirm versus Incident close to either full-import-first or controlled close-first", async () => {
    const session = await incident("CONFIRM-CLOSE");
    const validated = await validate(app(), session.id, "manifest", manifestCsv(20, "confirm-close"));
    const incidentRepository = createPrismaIncidentRepository(prisma!);
    const [confirmResult, closeResult] = await Promise.allSettled([
      request(app()).post(`/api/imports/${validated.body.id}/confirm`).set(as(coordinator.email)).send({}),
      incidentRepository.close(session.id, "Stage 16 race", actor())
    ]);
    expect(closeResult.status).toBe("fulfilled");
    if (confirmResult.status === "rejected") throw confirmResult.reason;
    expect([200, 409]).toContain(confirmResult.value.status);
    const imported = confirmResult.value.status === 200;
    expect(await prisma!.passengerRecord.count({ where: { sourceBatchId: validated.body.id } })).toBe(imported ? 20 : 0);
    expect(await prisma!.auditLog.count({ where: { entityId: validated.body.id, action: "import_passenger_manifest" } })).toBe(imported ? 1 : 0);
    expect(await prisma!.caseTimelineEvent.count({ where: { entityId: validated.body.id, eventType: "passenger_import" } })).toBe(imported ? 1 : 0);
    expect((await prisma!.importBatch.findUniqueOrThrow({ where: { id: validated.body.id } })).status).toBe(imported ? "Imported" : "Validated");
  });

  it("serializes Validate versus Incident close without partial validation state", async () => {
    const session = await incident("VALIDATE-CLOSE");
    const operationId = randomUUID();
    const incidentRepository = createPrismaIncidentRepository(prisma!);
    const [validation, closure] = await Promise.allSettled([
      validate(app(), session.id, "family", familyCsv(30, "validate-close"), operationId),
      incidentRepository.close(session.id, "Stage 16 validation race", actor())
    ]);
    expect(closure.status).toBe("fulfilled");
    if (validation.status === "rejected") throw validation.reason;
    expect([201, 409]).toContain(validation.value.status);
    const committed = validation.value.status === 201;
    expect(await prisma!.importBatch.count({ where: { validationOperationId: operationId } })).toBe(committed ? 1 : 0);
    expect(await prisma!.importValidatedRow.count({ where: { importBatch: { validationOperationId: operationId } } })).toBe(committed ? 30 : 0);
    expect(await prisma!.auditLog.count({ where: { sessionId: session.id, action: "validate_import", metadata: { path: ["operationId"], equals: operationId } } })).toBe(committed ? 1 : 0);
  });

  it("keeps GET read-only while a confirmation transaction is in flight", async () => {
    const session = await incident("READ-DURING-CONFIRM");
    const validated = await validate(app(), session.id, "manifest", manifestCsv(2, "read-during-confirm"));
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const service = createPrismaImportService(prisma!, { beforeConfirmationAudit: async () => { entered(); await releasePromise; } });
    const confirmation = request(app(service)).post(`/api/imports/${validated.body.id}/confirm`).set(as(coordinator.email)).send({}).then((response: any) => response);
    await enteredPromise;
    const during = await request(app()).get(`/api/imports/${validated.body.id}`).set(as(coordinator.email));
    expect(during.body.status).toBe("Validated");
    expect(await prisma!.passengerRecord.count({ where: { sourceBatchId: validated.body.id } })).toBe(0);
    release();
    const confirmed = await confirmation;
    expect(confirmed.status).toBe(200);
    expect((await request(app()).get(`/api/imports/${validated.body.id}`).set(as(coordinator.email))).body.status).toBe("Imported");
  }, 15_000);

  it("confines durable row payloads to ImportValidatedRow and keeps Audit metadata free of row PII", async () => {
    const session = await incident("PII-BOUNDARY");
    const csv = familyCsv(2, "pii-boundary");
    const validated = await validate(app(), session.id, "family", csv);
    const audits = await prisma!.auditLog.findMany({ where: { entityId: validated.body.id } });
    expect(JSON.stringify(audits)).not.toContain(`family-pii-boundary-0@example.test`);
    expect(JSON.stringify(audits)).not.toContain("Family-pii-boundary-0");
    expect(await prisma!.importValidatedRow.count({ where: { importBatchId: validated.body.id } })).toBe(2);
    expect(parseWorkbook(Buffer.from(csv), "family.csv")).toHaveLength(2);
  });
});
