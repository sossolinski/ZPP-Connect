import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { parseWorkbook } from "./exporters.js";
import { exportColumnSchemas } from "./modules/exports/prisma-export-service.js";
import { createPrismaExportService } from "./modules/exports/prisma-export-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;
const prisma = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;
const as = (email: string) => ({ "x-user-email": email });

postgresDescribe("Foundation Stage 17 PostgreSQL export disclosure and report integrity", () => {
  const marker = `F17-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const incidentIds: string[] = [];
  const userIds: string[] = [];
  const roleIds: string[] = [];
  const groupIds: string[] = [];
  let coordinator: { id: string; email: string; displayName: string };

  function app(service = createPrismaExportService(prisma!)) {
    return createApp({ exportService: service });
  }

  function responseBytes(response: { body: unknown; text?: string }) {
    if (Buffer.isBuffer(response.body) && response.body.length) return response.body;
    return Buffer.from(response.text ?? "", "utf8");
  }

  function prepare(incidentId: string, type: string, operationId = randomUUID(), email = coordinator.email, application = app()) {
    return request(application).post(`/api/exports/${type}`).set(as(email)).send({ sessionId: incidentId, operationId });
  }

  async function incident(suffix: string, status = "Active", assigned: string[] = []) {
    const row = await prisma!.session.create({ data: { operationalId: `${marker}-${suffix}`, mode: "EXERCISE", status, eventType: marker, createdById: coordinator.id } });
    incidentIds.push(row.id);
    await prisma!.incidentAssignment.createMany({ data: Array.from(new Set([coordinator.id, ...assigned])).map((userId) => ({ incidentId: row.id, userId, function: marker, createdById: coordinator.id })) });
    return row;
  }

  async function passenger(incidentId: string, suffix: string, data: Record<string, unknown> = {}) {
    return prisma!.passengerRecord.create({ data: { operationalId: `${marker}-PAX-${suffix}`, sessionId: incidentId, personType: "Passenger", firstName: `First-${suffix}`, lastName: `Last-${suffix}`, source: "Manifest", createdById: coordinator.id, updatedById: coordinator.id, ...data } });
  }

  async function scopedUser(suffix: string, permissions: string[], incidents: Array<{ id: string }>, groupIncident: { id: string }) {
    const email = `${marker.toLowerCase()}-${suffix}@example.test`;
    const user = await prisma!.user.create({ data: { email, normalizedEmail: email, displayName: `${marker} ${suffix}`, status: "Active", authenticationPolicy: "SSO_ONLY" } });
    userIds.push(user.id);
    const role = await prisma!.role.create({ data: { name: `${marker.toLowerCase()}-${suffix}`, displayName: `${marker} ${suffix}`, permissions, scopeTypes: ["GROUP"], custom: true } });
    roleIds.push(role.id);
    await prisma!.userRole.create({ data: { userId: user.id, roleId: role.id, scopeType: "GROUP", assignedBy: coordinator.id } });
    for (const target of incidents) await prisma!.incidentAssignment.upsert({ where: { incidentId_userId: { incidentId: target.id, userId: user.id } }, update: { active: true }, create: { incidentId: target.id, userId: user.id, function: marker, createdById: coordinator.id } });
    const group = await prisma!.operationalGroup.create({ data: { id: `${marker}-${suffix}-group`, operationalId: `${marker}-GRP-${suffix}`, incidentId: groupIncident.id, name: `${marker} ${suffix}`, pool: "ZPP", functionName: "Disclosure", createdById: coordinator.id } });
    groupIds.push(group.id);
    await prisma!.groupRoleAssignment.create({ data: { id: `${marker}-${suffix}-gra`, userId: user.id, roleId: role.id, groupId: group.id, assignedBy: coordinator.id } });
    return user;
  }

  beforeAll(async () => {
    coordinator = await prisma!.user.findUniqueOrThrow({ where: { email: "coordinator@lot.pl" }, select: { id: true, email: true, displayName: true } });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.notification.deleteMany({ where: { OR: [{ sessionId: { in: incidentIds } }, { recipientUserId: { in: userIds } }] } });
    await prisma.notificationOutbox.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.exportGeneration.deleteMany({ where: { incidentId: { in: incidentIds } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ sessionId: { in: incidentIds } }, { actorId: { in: userIds } }] } });
    await prisma.request.deleteMany({ where: { incidentId: { in: incidentIds } } });
    await prisma.matchingRecord.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.relationshipVerificationDecision.deleteMany({ where: { incidentId: { in: incidentIds } } });
    await prisma.relationshipClaim.deleteMany({ where: { incidentId: { in: incidentIds } } });
    await prisma.familyRecord.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.enquiry.deleteMany({ where: { sessionId: { in: incidentIds } } });
    await prisma.passengerRecord.deleteMany({ where: { sessionId: { in: incidentIds } } });
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

  it("retains migration 20 durable Prepared provenance after migration 21 with no fabricated history", async () => {
    const migrations = await prisma!.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    const indexes = await prisma!.$queryRaw<Array<{ indexname: string }>>`SELECT indexname FROM pg_indexes WHERE tablename = 'ExportGeneration'`;
    const checks = await prisma!.$queryRaw<Array<{ conname: string }>>`SELECT conname FROM pg_constraint WHERE conrelid = '"ExportGeneration"'::regclass AND contype = 'c'`;
    expect(Number(migrations[0]!.count)).toBeGreaterThanOrEqual(21);
    expect(indexes.map((row) => row.indexname)).toEqual(expect.arrayContaining(["ExportGeneration_operationId_key", "ExportGeneration_incidentId_preparedAt_id_idx"]));
    expect(checks.map((row) => row.conname)).toEqual(expect.arrayContaining(["ExportGeneration_status_check", "ExportGeneration_sha256_check", "ExportGeneration_sections_shape_check"]));
  });

  it("prepares Passenger CSV from PostgreSQL after restart and commits exact digest, size, counts and Audit before bytes", async () => {
    const session = await incident("PASSENGER-RESTART");
    await passenger(session.id, "restart", { pnr: "PNR-17", ticketNumber: "TICKET-17" });
    const operationId = randomUUID();
    const response = await prepare(session.id, "passenger-register", operationId, coordinator.email, app());
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv; charset=utf-8");
    expect(response.headers["content-disposition"]).toMatch(/attachment; filename="zpp-.*-passenger-register\.csv"/);
    const generationId = String(response.headers["x-export-generation-id"]);
    const bytes = responseBytes(response);
    const generation = await prisma!.exportGeneration.findUniqueOrThrow({ where: { id: generationId } });
    expect(generation).toMatchObject({ operationId, incidentId: session.id, exportType: "passenger-register", format: "csv", schemaVersion: "stage17-v1", status: "Prepared", rowCount: 1 });
    expect(generation.contentSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(Number(generation.contentSizeBytes)).toBe(bytes.length);
    expect(generation.includedSections).toEqual(["Session", "PassengerRecords"]);
    expect(generation.sectionCounts).toEqual({ Session: 1, PassengerRecords: 1 });
    expect(await prisma!.auditLog.count({ where: { entityId: generationId, action: "export_prepared" } })).toBe(1);
    expect((await request(app()).get(`/api/exports/generations/${generationId}`).set(as(coordinator.email))).body).toMatchObject({ id: generationId, contentSizeBytes: bytes.length });
    expect((await request(app()).get("/api/exports/passenger-register").set(as(coordinator.email)).query({ sessionId: session.id })).status).toBe(405);
  });

  it("uses explicit stable schemas and never exports internal model fields automatically", () => {
    expect(Object.fromEntries(Object.entries(exportColumnSchemas).map(([name, schema]) => [name, schema.map((column) => column.key)]))).toEqual({
      Session: ["operationalId", "mode", "status", "eventType", "flightNumber", "route", "startedAt", "endedAt"],
      Enquiries: ["operationalId", "caseId", "contactChannel", "callerName", "callerPhone", "callerEmail", "callerLocation", "preferredLanguage", "claimedRelationship", "passengerName", "enquiryType", "urgency", "status", "notes", "createdAt", "updatedAt"],
      FamilyRecords: ["operationalId", "caseId", "familyName", "claimedRelationship", "phone", "email", "preferredContactChannel", "preferredLanguage", "verificationStatus", "verifiedRelationship", "verificationDecisionBy", "verificationDecisionAt", "verificationNotes", "immediateNeeds", "createdAt", "updatedAt"],
      PassengerRecords: ["operationalId", "caseId", "personType", "passengerName", "dateOfBirth", "age", "gender", "nationality", "flightNumber", "route", "seat", "pnr", "ticketNumber", "manifestVersion", "source", "conditionStatus", "holdStatus", "travellingCompanions", "notes", "createdAt", "updatedAt"],
      MatchingRecords: ["operationalId", "caseId", "familyOperationalId", "passengerOperationalId", "enquiryOperationalId", "status", "matchBasis", "holdCheck", "decisionNotes", "createdAt", "updatedAt"],
      Requests: ["operationalId", "caseId", "category", "priority", "requester", "ownerAssignedTo", "details", "approvalStatus", "status", "enquiryOperationalId", "familyOperationalId", "passengerOperationalId", "createdAt", "updatedAt"],
      AuditLog: ["action", "actorEmail", "actorDisplayName", "summary", "createdAt"]
    });
  });

  it("includes only effectively authorized session-package sections and persists only disclosed counts", async () => {
    const session = await incident("PARTIAL");
    await passenger(session.id, "partial");
    await prisma!.familyRecord.create({ data: { operationalId: `${marker}-FAM-partial`, sessionId: session.id, firstName: "Hidden", lastName: "Family", verificationStatus: "Unverified", createdById: coordinator.id, updatedById: coordinator.id } });
    const user = await scopedUser("partial", ["export:create", "session:read", "passenger:read"], [session], session);
    const response = await prepare(session.id, "session-package", randomUUID(), user.email);
    expect(response.status).toBe(200);
    const text = responseBytes(response).toString("utf8");
    expect(text).toContain("PassengerRecords");
    expect(text).not.toContain("FamilyRecords");
    const generation = await prisma!.exportGeneration.findUniqueOrThrow({ where: { id: String(response.headers["x-export-generation-id"]) } });
    expect(generation.includedSections).toEqual(["Session", "PassengerRecords"]);
    expect(generation.sectionCounts).toEqual({ Session: 1, PassengerRecords: 1 });
    expect(JSON.stringify(generation, (_key, value) => typeof value === "bigint" ? value.toString() : value)).not.toContain("Hidden");
    expect((await request(app()).get(`/api/exports/generations/${generation.id}`).set(as(user.email))).status).toBe(404);
  });

  it("blocks cross-Incident GROUP disclosure despite unrelated assignment and honors active/revoked DENY", async () => {
    const [incidentA, incidentB] = await Promise.all([incident("GROUP-A"), incident("GROUP-B")]);
    await passenger(incidentA.id, "group-a");
    await passenger(incidentB.id, "group-b");
    const user = await scopedUser("group", ["export:create", "session:read", "passenger:read", "reports:read"], [incidentA, incidentB], incidentA);
    expect((await prepare(incidentB.id, "passenger-register", randomUUID(), user.email)).status).toBe(403);
    expect((await prepare(incidentB.id, "session-package", randomUUID(), user.email)).status).toBe(403);
    expect((await request(app()).get("/api/reports/session-summary").set(as(user.email)).query({ sessionId: incidentB.id })).status).toBe(403);
    expect(await prisma!.exportGeneration.count({ where: { incidentId: incidentB.id, preparedById: user.id } })).toBe(0);
    expect(await prisma!.auditLog.count({ where: { sessionId: incidentB.id, action: "export_prepared", actorId: user.id } })).toBe(0);
    const allowed = await prepare(incidentA.id, "passenger-register", randomUUID(), user.email);
    expect(allowed.status).toBe(200);
    const deny = await prisma!.permissionOverride.create({ data: { userId: user.id, permission: "passenger:read", effect: "DENY", active: true, reason: marker, createdById: coordinator.id } });
    expect((await prepare(incidentA.id, "passenger-register", randomUUID(), user.email)).status).toBe(403);
    await prisma!.permissionOverride.update({ where: { id: deny.id }, data: { active: false, revokedAt: new Date(), revokedById: coordinator.id, revokeReason: marker } });
    expect((await prepare(incidentA.id, "passenger-register", randomUUID(), user.email)).status).toBe(200);
    await prisma!.permissionOverride.create({ data: { userId: user.id, permission: "passenger:read", effect: "DENY", active: true, expiresAt: new Date(Date.now() - 60_000), reason: marker, createdById: coordinator.id } });
    expect((await prepare(incidentA.id, "passenger-register", randomUUID(), user.email)).status).toBe(200);
    expect((await prepare(incidentB.id, "passenger-register", randomUUID(), "admin@lot.pl")).status).toBe(200);
    expect((await request(app()).get(`/api/exports/generations/${allowed.headers["x-export-generation-id"]}`).set(as(user.email))).status).toBe(200);
  });

  it("allows authorized historical exports and reports from Closed and Archived Incidents", async () => {
    for (const status of ["Closed", "Archived"]) {
      const session = await incident(`HISTORICAL-${status}`, status);
      await passenger(session.id, status);
      expect((await prepare(session.id, "passenger-register")).status).toBe(200);
      expect((await request(app()).get("/api/reports/session-summary").set(as(coordinator.email)).query({ sessionId: session.id })).status).toBe(200);
    }
  });

  it("neutralizes formula attacks across operational domains while retaining typed numeric negatives and structural CSV safety", async () => {
    const session = await incident("FORMULA");
    const pax = await passenger(session.id, "formula", { firstName: "+cmd", lastName: "Zażółć", age: 12, notes: 'comma, quote " and\nline' });
    const enquiry = await prisma!.enquiry.create({ data: { operationalId: `${marker}-ENQ-formula`, sessionId: session.id, contactChannel: "Phone", callerName: '=HYPERLINK("https://example.invalid","click")', passengerFirstName: "@SUM(1,1)", passengerLastName: "Person", enquiryType: "Welfare", notes: "\t=1+1", createdById: coordinator.id, updatedById: coordinator.id } });
    const family = await prisma!.familyRecord.create({ data: { operationalId: `${marker}-FAM-formula`, sessionId: session.id, firstName: "=1+1", lastName: "Family", verificationStatus: "Unverified", immediateNeeds: "\r=1+1", createdById: coordinator.id, updatedById: coordinator.id } });
    await prisma!.matchingRecord.create({ data: { operationalId: `${marker}-MAT-formula`, sessionId: session.id, enquiryId: enquiry.id, familyRecordId: family.id, passengerRecordId: pax.id, matchBasis: "-cmd", createdById: coordinator.id, updatedById: coordinator.id } });
    await prisma!.request.create({ data: { operationalId: `${marker}-REQ-formula`, incidentId: session.id, category: "Other", details: "@SUM(1,1)", relatedEnquiryId: enquiry.id, relatedFamilyRecordId: family.id, relatedPassengerRecordId: pax.id, createdById: coordinator.id, updatedById: coordinator.id } });
    await prisma!.auditLog.create({ data: { action: "formula_fixture", sessionId: session.id, actorId: coordinator.id, actorEmail: coordinator.email, summary: "\t=1+1" } });
    for (const type of ["enquiry-log", "family-register", "passenger-register", "matching-log", "requests-log", "audit-log"]) {
      const response = await prepare(session.id, type);
      expect(response.status).toBe(200);
      const text = responseBytes(response).toString("utf8");
      expect(text).not.toMatch(/(?:^|,|\n)[=+@]/);
      expect(text).not.toMatch(/(?:^|,|\n)-cmd/);
      expect(parseWorkbook(responseBytes(response), `${type}.csv`).length).toBeGreaterThanOrEqual(2);
      if (type === "passenger-register") {
        expect(text).toContain(",12,");
        expect(text).toContain("Zażółć");
      }
    }
    const packageResponse = await prepare(session.id, "session-package");
    const packageGeneration = await prisma!.exportGeneration.findUniqueOrThrow({ where: { id: String(packageResponse.headers["x-export-generation-id"]) } });
    expect(packageGeneration.includedSections).toEqual(["Session", "Enquiries", "FamilyRecords", "PassengerRecords", "MatchingRecords", "Requests", "AuditLog"]);
    expect(packageGeneration.rowCount).toBeGreaterThanOrEqual(6);
  });

  it("redacts Matching and Request related-domain enrichment without each underlying permission", async () => {
    const session = await incident("ENRICHMENT");
    const pax = await passenger(session.id, "secret", { pnr: "SECRET-PNR" });
    const enquiry = await prisma!.enquiry.create({ data: { operationalId: `${marker}-ENQ-secret`, sessionId: session.id, contactChannel: "Phone", callerName: "Secret Caller", enquiryType: "Welfare", createdById: coordinator.id, updatedById: coordinator.id } });
    const family = await prisma!.familyRecord.create({ data: { operationalId: `${marker}-FAM-secret`, sessionId: session.id, firstName: "Secret", lastName: "Family", phone: "+481234", verificationStatus: "Unverified", createdById: coordinator.id, updatedById: coordinator.id } });
    await prisma!.matchingRecord.create({ data: { operationalId: `${marker}-MAT-secret`, sessionId: session.id, enquiryId: enquiry.id, familyRecordId: family.id, passengerRecordId: pax.id, createdById: coordinator.id, updatedById: coordinator.id } });
    await prisma!.request.create({ data: { operationalId: `${marker}-REQ-secret`, incidentId: session.id, category: "Other", details: "Primary request", relatedEnquiryId: enquiry.id, relatedFamilyRecordId: family.id, relatedPassengerRecordId: pax.id, createdById: coordinator.id, updatedById: coordinator.id } });
    const matchingUser = await scopedUser("match-only", ["export:create", "session:read", "matching:read"], [session], session);
    const requestUser = await scopedUser("request-only", ["export:create", "session:read", "request:read"], [session], session);
    for (const [type, user] of [["matching-log", matchingUser], ["requests-log", requestUser]] as const) {
      const text = responseBytes(await prepare(session.id, type, randomUUID(), user.email)).toString("utf8");
      expect(text).not.toContain(pax.operationalId);
      expect(text).not.toContain(enquiry.operationalId);
      expect(text).not.toContain(family.operationalId);
      expect(text).not.toContain("SECRET-PNR");
      expect(text).not.toContain("Secret Caller");
      expect(text).not.toContain("+481234");
    }
  });

  it("exports all 1,005 Passenger rows in stable order without the API page cap", async () => {
    const session = await incident("SCALE-1005");
    await prisma!.passengerRecord.createMany({ data: Array.from({ length: 1005 }, (_, index) => ({ operationalId: `${marker}-SCALE-${String(index).padStart(4, "0")}`, sessionId: session.id, personType: "Passenger", firstName: `Scale-${index}`, lastName: "Passenger", source: "Manifest", createdById: coordinator.id, updatedById: coordinator.id, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)), updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)) })) });
    const response = await prepare(session.id, "passenger-register");
    expect(response.status).toBe(200);
    const generation = await prisma!.exportGeneration.findUniqueOrThrow({ where: { id: String(response.headers["x-export-generation-id"]) } });
    expect(generation.rowCount).toBe(1005);
    expect(generation.sectionCounts).toEqual({ Session: 1, PassengerRecords: 1005 });
    const parsed = parseWorkbook(responseBytes(response), "passengers.csv");
    expect(parsed.filter((row) => row.section === "PassengerRecords")).toHaveLength(1005);
    expect(parsed.filter((row) => row.section === "PassengerRecords").map((row) => row.operationalId)).toEqual(Array.from({ length: 1005 }, (_, index) => `${marker}-SCALE-${String(index).padStart(4, "0")}`));
  }, 30_000);

  it("returns controlled 413 without provenance beyond the explicit 20,000-row synchronous boundary", async () => {
    const session = await incident("CAPACITY-20001");
    await prisma!.passengerRecord.createMany({ data: Array.from({ length: 20_001 }, (_, index) => ({ operationalId: `${marker}-CAP-${String(index).padStart(5, "0")}`, sessionId: session.id, personType: "Passenger", firstName: `Capacity-${index}`, lastName: "Passenger", source: "Manifest", createdById: coordinator.id, updatedById: coordinator.id })) });
    const operationId = randomUUID();
    const response = await prepare(session.id, "passenger-register", operationId);
    expect(response.status).toBe(413);
    expect(response.body.error).toContain("20,000 row synchronous limit");
    expect(await prisma!.exportGeneration.count({ where: { operationId } })).toBe(0);
    expect(await prisma!.auditLog.count({ where: { sessionId: session.id, action: "export_prepared", metadata: { path: ["operationId"], equals: operationId } } })).toBe(0);
  }, 30_000);

  it("uses one repeatable-read snapshot across deterministic source pages", async () => {
    const session = await incident("SNAPSHOT");
    await prisma!.passengerRecord.createMany({ data: Array.from({ length: 600 }, (_, index) => ({ operationalId: `${marker}-SNAP-${String(index).padStart(4, "0")}`, sessionId: session.id, personType: "Passenger", firstName: `Snap-${index}`, lastName: "Passenger", source: "Manifest", createdById: coordinator.id, updatedById: coordinator.id })) });
    const outsider = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    let inserted = false;
    const service = createPrismaExportService(prisma!, { duringSourcePaging: async (section, offset) => {
      if (section === "PassengerRecords" && offset === 500 && !inserted) {
        inserted = true;
        await outsider.passengerRecord.create({ data: { operationalId: `${marker}-SNAP-LATE`, sessionId: session.id, personType: "Passenger", firstName: "Late", lastName: "Commit", source: "Manifest", createdById: coordinator.id, updatedById: coordinator.id } });
      }
    } });
    const response = await prepare(session.id, "passenger-register", randomUUID(), coordinator.email, app(service));
    await outsider.$disconnect();
    expect(response.status).toBe(200);
    expect((await prisma!.exportGeneration.findUniqueOrThrow({ where: { id: String(response.headers["x-export-generation-id"]) } })).rowCount).toBe(600);
    expect(responseBytes(response).toString("utf8")).not.toContain(`${marker}-SNAP-LATE`);
    expect((await prepare(session.id, "passenger-register")).text).toContain(`${marker}-SNAP-LATE`);
  });

  it("serializes same-operation concurrency to one artifact and one controlled conflict", async () => {
    const session = await incident("CONCURRENCY");
    await passenger(session.id, "concurrency");
    const operationId = randomUUID();
    const application = app();
    const responses = await Promise.all([prepare(session.id, "passenger-register", operationId, coordinator.email, application), prepare(session.id, "passenger-register", operationId, coordinator.email, application)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(JSON.stringify(responses.find((response) => response.status === 409)!.body)).not.toMatch(/P2002|P2034|P2010|Prisma|constraint|SQL/i);
    expect(await prisma!.exportGeneration.count({ where: { operationId } })).toBe(1);
    const generation = await prisma!.exportGeneration.findUniqueOrThrow({ where: { operationId } });
    expect(await prisma!.auditLog.count({ where: { entityId: generation.id, action: "export_prepared" } })).toBe(1);
    expect((await prepare(session.id, "family-register", operationId)).status).toBe(409);
  });

  it("rolls back provenance and Audit and sends no artifact for every failure seam", async () => {
    const session = await incident("ROLLBACK");
    await passenger(session.id, "rollback");
    const cases = [
      { beforeSourceQuery: () => { throw new Error("source failure"); } },
      { duringSourcePaging: () => { throw new Error("paging failure"); } },
      { beforeSerialization: () => { throw new Error("serialization failure"); } },
      { beforeGenerationWrite: () => { throw new Error("generation failure"); } },
      { beforeAudit: () => { throw new Error("audit failure"); } },
      { afterAuditBeforeReturn: () => { throw new Error("post-audit failure"); } }
    ];
    for (const hooks of cases) {
      const operationId = randomUUID();
      const response = await prepare(session.id, "passenger-register", operationId, coordinator.email, app(createPrismaExportService(prisma!, hooks)));
      expect(response.status).toBe(500);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.body).toEqual({ error: "Internal server error" });
      expect(await prisma!.exportGeneration.count({ where: { operationId } })).toBe(0);
      expect(await prisma!.auditLog.count({ where: { sessionId: session.id, action: "export_prepared", metadata: { path: ["operationId"], equals: operationId } } })).toBe(0);
    }
  });

  it("keeps audit-log source snapshot non-recursive and may include the prior generation on a later export", async () => {
    const session = await incident("AUDIT-RECURSION");
    await prisma!.auditLog.create({ data: { action: "fixture", sessionId: session.id, actorId: coordinator.id, actorEmail: coordinator.email, summary: "Initial audit" } });
    const first = await prepare(session.id, "audit-log");
    const firstId = String(first.headers["x-export-generation-id"]);
    expect(responseBytes(first).toString("utf8")).not.toContain(firstId);
    const second = await prepare(session.id, "audit-log");
    expect(responseBytes(second).toString("utf8")).toContain("export_prepared");
    expect(await prisma!.auditLog.count({ where: { entityId: firstId, action: "export_prepared" } })).toBe(1);
  });

  it("provides scoped paged metadata with anti-enumeration and no artifact re-download", async () => {
    const [incidentA, incidentB] = await Promise.all([incident("META-A"), incident("META-B")]);
    await passenger(incidentA.id, "meta-a");
    const response = await prepare(incidentA.id, "passenger-register");
    const generationId = String(response.headers["x-export-generation-id"]);
    const user = await scopedUser("meta-b", ["export:create", "session:read", "passenger:read"], [incidentB], incidentB);
    expect((await request(app()).get(`/api/exports/generations/${generationId}`).set(as(user.email))).status).toBe(404);
    expect((await request(app()).get(`/api/exports/generations/${randomUUID()}`).set(as(user.email))).status).toBe(404);
    const list = await request(app()).get(`/api/sessions/${incidentA.id}/export-generations`).set(as(coordinator.email)).query({ limit: 1, offset: 0 });
    expect(list.body).toMatchObject({ total: expect.any(Number), data: [expect.objectContaining({ id: generationId, status: "Prepared" })] });
    expect((await request(app()).get(`/api/exports/generations/${generationId}/download`).set(as(coordinator.email))).status).toBe(404);
  });

  it("builds a read-only restart-stable PostgreSQL session summary with explicit field availability", async () => {
    const session = await incident("SUMMARY");
    await passenger(session.id, "summary");
    await prisma!.enquiry.create({ data: { operationalId: `${marker}-ENQ-summary`, sessionId: session.id, contactChannel: "Phone", callerName: "Caller", enquiryType: "Welfare", createdById: coordinator.id, updatedById: coordinator.id } });
    await prisma!.request.create({ data: { operationalId: `${marker}-REQ-summary`, incidentId: session.id, category: "Transport", priority: "Urgent", details: "Need transport", createdById: coordinator.id, updatedById: coordinator.id } });
    const user = await scopedUser("summary", ["reports:read", "session:read", "passenger:read"], [session], session);
    const beforeAudit = await prisma!.auditLog.count({ where: { sessionId: session.id } });
    const beforeGeneration = await prisma!.exportGeneration.count({ where: { incidentId: session.id } });
    const response = await request(app()).get("/api/reports/session-summary").set(as(user.email)).query({ sessionId: session.id });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ session: { id: session.id }, availability: { passengers: true, enquiries: false, requests: false }, counts: { passengers: 1 } });
    expect(response.body.counts).not.toHaveProperty("enquiries");
    expect(response.body.counts).not.toHaveProperty("requests");
    expect(response.body).not.toHaveProperty("urgentRequests");
    expect(await prisma!.auditLog.count({ where: { sessionId: session.id } })).toBe(beforeAudit);
    expect(await prisma!.exportGeneration.count({ where: { incidentId: session.id } })).toBe(beforeGeneration);
  });

  it("persists PII-free provenance across process reconstruction", async () => {
    const session = await incident("PII-PROVENANCE");
    await passenger(session.id, "pii", { firstName: "Sensitive", lastName: "Person", pnr: "SECRET-PNR-17", ticketNumber: "SECRET-TICKET-17", notes: "SECRET-NOTE-17" });
    const response = await prepare(session.id, "passenger-register");
    const generationId = String(response.headers["x-export-generation-id"]);
    const generation = await prisma!.exportGeneration.findUniqueOrThrow({ where: { id: generationId } });
    const audit = await prisma!.auditLog.findFirstOrThrow({ where: { entityId: generationId, action: "export_prepared" } });
    expect(JSON.stringify({ generation, audit }, (_key, value) => typeof value === "bigint" ? value.toString() : value)).not.toMatch(/Sensitive|SECRET-PNR-17|SECRET-TICKET-17|SECRET-NOTE-17/);
    expect((await request(app()).get(`/api/exports/generations/${generationId}`).set(as(coordinator.email))).body).toMatchObject({ id: generationId, status: "Prepared" });
  });

  it("returns controlled input and conflict errors without leaking operation ownership", async () => {
    const session = await incident("ERRORS");
    await passenger(session.id, "errors");
    expect((await prepare(session.id, "not-an-export")).status).toBe(400);
    expect((await prepare(session.id, "pdf-session-summary")).status).toBe(501);
    expect((await request(app()).post("/api/exports/passenger-register").set(as(coordinator.email)).send({ sessionId: session.id, operationId: "bad" })).status).toBe(400);
    const operationId = randomUUID();
    expect((await prepare(session.id, "passenger-register", operationId)).status).toBe(200);
    const conflict = await prepare(session.id, "passenger-register", operationId);
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({ error: "That export generation was already prepared. Start a new export if another copy is required." });
    const other = await scopedUser("operation-owner", ["export:create", "session:read", "passenger:read"], [session], session);
    expect((await prepare(session.id, "passenger-register", operationId, other.email)).body).toEqual(conflict.body);
  });
});
