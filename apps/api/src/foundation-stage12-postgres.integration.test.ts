import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createPrismaDocumentRepository } from "./modules/documents/prisma-document-repository.js";
import { createPrismaIncidentAccessRepository } from "./modules/incident-access/prisma-incident-access-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;
const prisma = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;
const as = (email: string) => ({ "x-user-email": email });

postgresDescribe("Foundation Stage 12 PostgreSQL Documents", () => {
  const marker = `F12-${Date.now()}`;
  let referenceNow = new Date("2026-08-20T09:00:00.000Z");
  const clock = { now: () => new Date(referenceNow) };
  const actors: Record<string, { id: string; email: string; memberId?: string }> = {};
  let adminId: string;
  let incidentId: string;
  let groupId: string;

  function application(publishHook?: (record: Record<string, unknown>) => void) {
    return createApp({
      incidentAccessRepository: createPrismaIncidentAccessRepository(prisma!),
      documentRepository: createPrismaDocumentRepository(prisma!, clock),
      documentClock: clock,
      documentNotificationHook: publishHook,
    });
  }

  async function actor(key: string, permissions: string[], linked = false, incidents: string[] = []) {
    const role = await prisma!.role.create({ data: { name: `${marker.toLowerCase()}-${key}`, displayName: `${marker} ${key}`, permissions } });
    const user = await prisma!.user.create({ data: { email: `${marker.toLowerCase()}-${key}@example.test`, displayName: `${marker} ${key}`, roles: { create: { roleId: role.id, scopeType: "GLOBAL", assignedBy: "stage12-test" } } } });
    for (const assignedIncidentId of incidents) await prisma!.incidentAssignment.create({ data: { incidentId: assignedIncidentId, userId: user.id, function: "Stage 12 test", createdById: adminId } });
    let memberId: string | undefined;
    if (linked) {
      memberId = `${marker.toLowerCase()}-member-${key}`;
      await prisma!.memberProfile.create({ data: { id: memberId, memberId: `${marker}-${key}`.toUpperCase(), linkedUserId: user.id, firstName: "Documents", lastName: key, pool: "ZPP", role: "Member", assignedFunction: "Family Assistance", languages: ["PL"], createdById: adminId, updatedById: adminId } });
    }
    actors[key] = { id: user.id, email: user.email, memberId };
    return actors[key]!;
  }

  async function member(label: string, values: Record<string, unknown> = {}) {
    const id = `${marker.toLowerCase()}-member-${label}-${randomUUID().slice(0, 6)}`;
    await prisma!.memberProfile.create({ data: { id, memberId: `${marker}-${label}-${randomUUID().slice(0, 5)}`.toUpperCase(), firstName: "Stage12", lastName: label, pool: "ZPP", role: "Member", assignedFunction: "Family Assistance", languages: ["PL"], createdById: adminId, updatedById: adminId, ...values } });
    return id;
  }

  async function operationalGroup(label: string) {
    const id = `${marker.toLowerCase()}-group-${label}-${randomUUID().slice(0, 6)}`;
    return prisma!.operationalGroup.create({ data: { id, operationalId: `${marker}-${label}-${randomUUID().slice(0, 5)}`.toUpperCase(), incidentId, name: `${marker} ${label}`, pool: "ZPP", functionName: "Family Assistance", createdById: adminId, updatedById: adminId } });
  }

  async function document(values: Record<string, unknown> = {}) {
    return request(application()).post("/api/documents").set(as(actors.manager!.email)).send({ code: `${marker}-${randomUUID().slice(0, 7)}`, title: `${marker} controlled document`, category: "Operations", ownerFunction: "ZPP", ...values });
  }

  async function draft(documentId: string, values: Record<string, unknown> = {}) {
    return request(application()).post(`/api/documents/${documentId}/versions`).set(as(actors.manager!.email)).send({ versionLabel: `v-${randomUUID().slice(0, 6)}`, contentMode: "Internal text", contentBody: "Controlled plain text.", ...values });
  }

  async function publish(version: any, expectedCurrentPublishedVersionId: string | null = null, operationId = randomUUID()) {
    return request(application()).post(`/api/document-versions/${version.id}/publish`).set(as(actors.manager!.email)).send({ expectedVersion: version.version, expectedCurrentPublishedVersionId, operationId });
  }

  async function publishedDocument() {
    const created = await document();
    const version = await draft(created.body.id);
    const published = await publish(version.body);
    return { document: created.body, version: published.body };
  }

  async function requirement(documentVersionId: string, values: Record<string, unknown> = {}) {
    return request(application()).post("/api/document-requirements").set(as(actors.manager!.email)).send({ documentVersionId, targetType: "MemberProfile", memberProfileId: actors.own!.memberId, acknowledgementRequired: true, effectiveFrom: referenceNow.toISOString(), dueAt: "2026-08-21T09:00:00.000Z", ...values });
  }

  beforeAll(async () => {
    await prisma!.$connect();
    adminId = (await prisma!.user.findUniqueOrThrow({ where: { email: "admin@lot.pl" } })).id;
    const incident = await prisma!.session.create({ data: { operationalId: `${marker}-INCIDENT`, mode: "EXERCISE", status: "Active", eventType: marker, createdById: adminId } });
    incidentId = incident.id;
    groupId = `${marker.toLowerCase()}-group`;
    await prisma!.operationalGroup.create({ data: { id: groupId, operationalId: `${marker}-GROUP`, incidentId, name: `${marker} Group`, pool: "ZPP", functionName: "Family Assistance", createdById: adminId, updatedById: adminId } });
    const managerPermissions = ["session:read", "member:read", "member:archive", "group:read", "group:archive", "group:membership:manage", "document:read-all", "document:manage", "document:version:manage", "document:publish", "document:requirement:manage", "document:acknowledge-all", "readiness:read-all"];
    await actor("manager", managerPermissions, false, [incidentId]);
    await actor("own", ["session:read", "document:read-own", "document:acknowledge-own", "readiness:read-own"], true, [incidentId]);
    await actor("behalf", ["session:read", "document:read-all", "document:acknowledge-all"], false, [incidentId]);
    await actor("noincident", managerPermissions, false, []);
  });

  afterAll(async () => { await prisma?.$disconnect(); });

  it("deploys schema, exact legacy seed and global audit boundaries", async () => {
    const migration = await prisma!.$queryRaw<Array<{ migration_name: string }>>`SELECT migration_name FROM "_prisma_migrations" WHERE migration_name = '20260820090000_documents_foundation' AND finished_at IS NOT NULL`;
    expect(migration).toHaveLength(1);
    expect(await prisma!.document.count({ where: { legacyImported: true } })).toBe(6);
    expect(await prisma!.documentVersion.count({ where: { legacyImported: true } })).toBe(6);
    expect(await prisma!.documentRequirement.count({ where: { provenance: { path: ["source"], equals: "memory-seed" } } })).toBe(5);
    const legacyAck = await prisma!.documentAcknowledgement.findUniqueOrThrow({ where: { id: "dack-2026-000001" } });
    expect(legacyAck).toMatchObject({ legacyImported: true, note: null, contentDigestSnapshot: null, onBehalf: true });
    const created = await document();
    const audit = await prisma!.auditLog.findFirstOrThrow({ where: { entityType: "document", entityId: created.body.id } });
    expect(audit.sessionId).toBeNull();
  });

  it("protects normalized document code and version labels under concurrency", async () => {
    const code = `${marker}-CODE-RACE`;
    const race = await Promise.all([document({ code }), document({ code: code.toLowerCase() })]);
    expect(race.map(({ status }) => status).sort()).toEqual([201, 409]);
    const winner = race.find(({ status }) => status === 201)!;
    const label = `${marker}-LABEL`;
    const versions = await Promise.all([draft(winner.body.id, { versionLabel: label }), draft(winner.body.id, { versionLabel: label.toLowerCase() })]);
    expect(versions.map(({ status }) => status).sort()).toEqual([201, 409]);
  });

  it("publishes atomically, supersedes once, preserves provenance and rejects stale operation reuse", async () => {
    const created = await document();
    const first = await draft(created.body.id, { versionLabel: "v1" });
    const firstPublished = await publish(first.body);
    expect(firstPublished).toMatchObject({ status: 200, body: { status: "Published", publishedById: actors.manager!.id } });
    await expect(prisma!.documentVersion.update({ where: { id: firstPublished.body.id }, data: { contentBody: "tampered while published" } })).rejects.toBeTruthy();
    const second = await draft(created.body.id, { versionLabel: "v2", contentBody: "Second controlled body." });
    const third = await draft(created.body.id, { versionLabel: "v3", contentBody: "Third controlled body." });
    const race = await Promise.all([publish(second.body, firstPublished.body.id), publish(third.body, firstPublished.body.id)]);
    expect(race.filter(({ status }) => status === 200)).toHaveLength(1);
    expect(race.filter(({ status }) => status === 409)).toHaveLength(1);
    expect(await prisma!.documentVersion.count({ where: { documentId: created.body.id, status: "Published" } })).toBe(1);
    expect((await prisma!.documentVersion.findUniqueOrThrow({ where: { id: firstPublished.body.id } })).status).toBe("Superseded");
    await expect(prisma!.documentVersion.update({ where: { id: firstPublished.body.id }, data: { contentBody: "tampered" } })).rejects.toBeTruthy();
    const winner = race.find(({ status }) => status === 200)!;
    const operationId = randomUUID();
    const withdrawn = await request(application()).post(`/api/document-versions/${winner.body.id}/withdraw`).set(as(actors.manager!.email)).send({ expectedVersion: winner.body.version, operationId, reason: "Replaced after review" });
    expect(withdrawn.body).toMatchObject({ status: "Withdrawn", withdrawnById: actors.manager!.id, withdrawReason: "Replaced after review" });
    await expect(prisma!.documentVersion.update({ where: { id: winner.body.id }, data: { contentBody: "tampered while withdrawn" } })).rejects.toBeTruthy();
    const replay = await request(application()).post(`/api/document-versions/${winner.body.id}/withdraw`).set(as(actors.manager!.email)).send({ expectedVersion: winner.body.version, operationId, reason: "Replaced after review" });
    expect(replay).toMatchObject({ status: 200, body: { idempotent: true } });
    expect((await request(application()).post(`/api/document-versions/${winner.body.id}/withdraw`).set(as(actors.manager!.email)).send({ expectedVersion: winner.body.version, operationId, reason: "Different payload" })).status).toBe(409);
  });

  it("validates content modes, HTTPS external links and returns internal text as inert data", async () => {
    const created = await document();
    const unsafe = await draft(created.body.id, { contentMode: "External link", contentBody: null, externalUrl: "http://example.test/manual" });
    expect(unsafe.status).toBe(201);
    expect((await publish(unsafe.body)).status).toBe(409);
    const internal = await draft(created.body.id, { contentBody: "<script>window.compromised=true</script>" });
    const published = await publish(internal.body);
    expect(published.status).toBe(200);
    expect(published.body.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    const content = await request(application()).get(`/api/document-versions/${published.body.id}/content`).set(as(actors.manager!.email));
    expect(content.body.contentBody).toBe("<script>window.compromised=true</script>");
  });

  it("enforces exact requirement targets, published-only attachment and safe archive", async () => {
    const created = await document();
    const draftVersion = await draft(created.body.id);
    expect((await requirement(draftVersion.body.id)).status).toBe(409);
    const version = (await publish(draftVersion.body)).body;
    const req = await requirement(version.id);
    expect(req).toMatchObject({ status: 201, body: { effective: true, resolvedMemberCount: 1 } });
    expect((await requirement(version.id)).status).toBe(409);
    expect((await request(application()).post(`/api/documents/${created.body.id}/archive`).set(as(actors.manager!.email)).send({ expectedVersion: created.body.version })).status).toBe(409);
    await expect(prisma!.documentRequirement.create({ data: { id: `${marker}-bad-target`, documentVersionId: version.id, targetType: "Role", targetRole: "ZPP Member", groupId } })).rejects.toBeTruthy();
    referenceNow = new Date("2026-08-20T09:00:00.001Z");
    const ended = await request(application()).post(`/api/document-requirements/${req.body.id}/end`).set(as(actors.manager!.email)).send({ expectedVersion: req.body.recordVersion, operationId: randomUUID() });
    expect(ended.body).toMatchObject({ active: false, recordVersion: 2, endedById: actors.manager!.id });
    expect((await requirement(version.id)).status).toBe(201);
    referenceNow = new Date("2026-08-20T09:00:00.000Z");
  });

  it("preserves targets on partial update, rejects stale mutations and evaluates exact time boundaries", async () => {
    const { version } = await publishedDocument();
    const req = await requirement(version.id, { effectiveFrom: "2026-08-21T09:00:00.000Z", dueAt: "2026-08-22T09:00:00.000Z" });
    expect(req.body.effective).toBe(false);
    const updated = await request(application()).patch(`/api/document-requirements/${req.body.id}`).set(as(actors.manager!.email)).send({ expectedVersion: req.body.recordVersion, dueAt: "2026-08-22T09:00:00.000Z" });
    expect(updated.body).toMatchObject({ targetType: "MemberProfile", memberProfileId: actors.own!.memberId, effectiveFrom: "2026-08-21T09:00:00.000Z", recordVersion: 2 });
    expect((await request(application()).patch(`/api/document-requirements/${req.body.id}`).set(as(actors.manager!.email)).send({ expectedVersion: 1, dueAt: null })).status).toBe(409);
    referenceNow = new Date("2026-08-22T09:00:00.001Z");
    const personal = await request(application()).get("/api/documents").set(as(actors.own!.email)).query({ mine: true, limit: 50 });
    expect(personal.body.data.find((item: any) => item.documentVersionId === version.id)?.status).toBe("Overdue");
    const endedAtBoundary = await request(application()).post(`/api/document-requirements/${req.body.id}/end`).set(as(actors.manager!.email)).send({ expectedVersion: 2, operationId: randomUUID(), effectiveTo: "2026-08-21T09:00:00.000Z" });
    expect(endedAtBoundary.status).toBe(409);
    referenceNow = new Date("2026-08-20T09:00:00.000Z");
  });

  it("treats acknowledgementRequired=false as awareness without overdue or non-compliance", async () => {
    const { version } = await publishedDocument();
    await requirement(version.id, { acknowledgementRequired: false, effectiveFrom: "2026-08-18T09:00:00.000Z", dueAt: "2026-08-19T09:00:00.000Z" });
    const personal = await request(application()).get("/api/documents").set(as(actors.own!.email)).query({ mine: true, status: "Awareness", limit: 50 });
    const item = personal.body.data.find((row: any) => row.documentVersionId === version.id);
    expect(item).toMatchObject({ status: "Awareness", canAcknowledge: false, acknowledgementRequired: false });
    expect(personal.body.totals.overdue).toBe(0);
  });

  it("records append-only self and on-behalf acknowledgement evidence with deterministic replay", async () => {
    const self = await publishedDocument();
    const roleReq = await requirement(self.version.id, { targetType: "Role", targetRole: "ZPP Member", memberProfileId: null });
    const groupReq = await requirement(self.version.id, { targetType: "Group", groupId, memberProfileId: null });
    await prisma!.groupMembership.create({ data: { id: `${marker}-ACK-GROUP`, groupId, memberProfileId: actors.own!.memberId!, role: "Member", addedById: adminId } });
    const operationId = randomUUID();
    const ack = await request(application()).post(`/api/document-versions/${self.version.id}/acknowledge`).set(as(actors.own!.email)).send({ operationId });
    expect(ack.status).toBe(201);
    expect(ack.body.sourceRequirementIds.sort()).toEqual([groupReq.body.id, roleReq.body.id].sort());
    expect(ack.body.evidence.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect((await request(application()).post(`/api/document-versions/${self.version.id}/acknowledge`).set(as(actors.own!.email)).send({ operationId })).body).toMatchObject({ id: ack.body.id, idempotent: true });
    expect((await request(application()).post(`/api/document-versions/${self.version.id}/acknowledge`).set(as(actors.own!.email)).send({ operationId: randomUUID() })).body).toMatchObject({ id: ack.body.id, duplicate: true });
    await expect(prisma!.documentAcknowledgement.update({ where: { id: ack.body.id }, data: { note: "changed" } })).rejects.toBeTruthy();
    await expect(prisma!.documentAcknowledgement.delete({ where: { id: ack.body.id } })).rejects.toBeTruthy();

    const target = await member("OnBehalf");
    const behalfDoc = await publishedDocument();
    await requirement(behalfDoc.version.id, { memberProfileId: target });
    expect((await request(application()).post(`/api/document-versions/${behalfDoc.version.id}/acknowledge`).set(as(actors.behalf!.email)).send({ operationId: randomUUID(), memberProfileId: target, onBehalf: true })).status).toBe(400);
    const behalf = await request(application()).post(`/api/document-versions/${behalfDoc.version.id}/acknowledge`).set(as(actors.behalf!.email)).send({ operationId: randomUUID(), memberProfileId: target, onBehalf: true, note: "Confirmed during facilitated review" });
    expect(behalf).toMatchObject({ status: 201, body: { memberProfileId: target, acknowledgedById: actors.behalf!.id, onBehalf: true } });
  });

  it("serializes acknowledgement against requirement end and version withdrawal", async () => {
    const first = await publishedDocument();
    const req = await requirement(first.version.id);
    const endOperation = randomUUID();
    const [ack, end] = await Promise.all([
      request(application()).post(`/api/document-versions/${first.version.id}/acknowledge`).set(as(actors.own!.email)).send({ operationId: randomUUID() }),
      request(application()).post(`/api/document-requirements/${req.body.id}/end`).set(as(actors.manager!.email)).send({ expectedVersion: req.body.recordVersion, operationId: endOperation, effectiveTo: "2026-08-20T09:00:00.001Z" }),
    ]);
    expect([ack.status, end.status].filter((status) => status < 300).length).toBeGreaterThanOrEqual(1);
    if (end.status < 300 && ack.status < 300) expect(new Date(ack.body.acknowledgedAt).getTime()).toBeLessThan(new Date(end.body.effectiveTo).getTime());

    const second = await publishedDocument();
    await requirement(second.version.id);
    const [ackRace, withdrawRace] = await Promise.all([
      request(application()).post(`/api/document-versions/${second.version.id}/acknowledge`).set(as(actors.own!.email)).send({ operationId: randomUUID() }),
      request(application()).post(`/api/document-versions/${second.version.id}/withdraw`).set(as(actors.manager!.email)).send({ expectedVersion: second.version.version, operationId: randomUUID(), reason: "Race test" }),
    ]);
    expect([ackRace.status, withdrawRace.status].filter((status) => status < 300)).toHaveLength(1);
  });

  it("serializes publish against draft edit and draft withdrawal", async () => {
    const editDocument = await document();
    const editDraft = await draft(editDocument.body.id);
    const [publishRace, editRace] = await Promise.all([
      publish(editDraft.body),
      request(application()).patch(`/api/document-versions/${editDraft.body.id}`).set(as(actors.manager!.email)).send({ expectedVersion: editDraft.body.version, changeSummary: "Concurrent edit" }),
    ]);
    expect([publishRace.status, editRace.status].filter((status) => status < 300)).toHaveLength(1);

    const withdrawDocument = await document();
    const withdrawDraft = await draft(withdrawDocument.body.id);
    const [publishResult, withdrawResult] = await Promise.all([
      publish(withdrawDraft.body),
      request(application()).post(`/api/document-versions/${withdrawDraft.body.id}/withdraw`).set(as(actors.manager!.email)).send({ expectedVersion: withdrawDraft.body.version, operationId: randomUUID(), reason: "Concurrent decision" }),
    ]);
    expect([publishResult.status, withdrawResult.status].filter((status) => status < 300)).toHaveLength(1);
    expect(await prisma!.documentVersion.count({ where: { documentId: withdrawDocument.body.id, status: "Published" } })).toBeLessThanOrEqual(1);
  });

  it("serializes document archive against new requirements and acknowledgements", async () => {
    const empty = await publishedDocument();
    const [archiveRace, requirementRace] = await Promise.all([
      request(application()).post(`/api/documents/${empty.document.id}/archive`).set(as(actors.manager!.email)).send({ expectedVersion: empty.document.version }),
      requirement(empty.version.id),
    ]);
    expect([archiveRace.status, requirementRace.status].filter((status) => status < 300)).toHaveLength(1);
    const archivedState = await prisma!.document.findUniqueOrThrow({ where: { id: empty.document.id } });
    const activeRequirements = await prisma!.documentRequirement.count({ where: { documentVersion: { documentId: empty.document.id }, active: true } });
    expect(archivedState.active || activeRequirements === 0).toBe(true);

    const obligated = await publishedDocument();
    await requirement(obligated.version.id);
    const [blockedArchive, ack] = await Promise.all([
      request(application()).post(`/api/documents/${obligated.document.id}/archive`).set(as(actors.manager!.email)).send({ expectedVersion: obligated.document.version }),
      request(application()).post(`/api/document-versions/${obligated.version.id}/acknowledge`).set(as(actors.own!.email)).send({ operationId: randomUUID() }),
    ]);
    expect(blockedArchive.status).toBe(409);
    expect(ack.status).toBe(201);
  });

  it("serializes requirement update against end and simultaneous acknowledgement requests", async () => {
    const mutable = await publishedDocument();
    const req = await requirement(mutable.version.id);
    const [updateRace, endRace] = await Promise.all([
      request(application()).patch(`/api/document-requirements/${req.body.id}`).set(as(actors.manager!.email)).send({ expectedVersion: req.body.recordVersion, dueAt: "2026-08-22T09:00:00.000Z" }),
      request(application()).post(`/api/document-requirements/${req.body.id}/end`).set(as(actors.manager!.email)).send({ expectedVersion: req.body.recordVersion, operationId: randomUUID(), effectiveTo: "2026-08-20T09:00:00.001Z" }),
    ]);
    expect([updateRace.status, endRace.status].filter((status) => status < 300)).toHaveLength(1);

    const duplicate = await publishedDocument();
    await requirement(duplicate.version.id);
    const simultaneous = await Promise.all([
      request(application()).post(`/api/document-versions/${duplicate.version.id}/acknowledge`).set(as(actors.own!.email)).send({ operationId: randomUUID() }),
      request(application()).post(`/api/document-versions/${duplicate.version.id}/acknowledge`).set(as(actors.own!.email)).send({ operationId: randomUUID() }),
    ]);
    expect(simultaneous.every(({ status }) => status < 300)).toBe(true);
    expect(await prisma!.documentAcknowledgement.count({ where: { documentVersionId: duplicate.version.id, memberProfileId: actors.own!.memberId } })).toBe(1);

    const ownVsBehalf = await publishedDocument();
    await requirement(ownVsBehalf.version.id);
    const contenders = await Promise.all([
      request(application()).post(`/api/document-versions/${ownVsBehalf.version.id}/acknowledge`).set(as(actors.own!.email)).send({ operationId: randomUUID() }),
      request(application()).post(`/api/document-versions/${ownVsBehalf.version.id}/acknowledge`).set(as(actors.behalf!.email)).send({ operationId: randomUUID(), memberProfileId: actors.own!.memberId, onBehalf: true, note: "Concurrent facilitated confirmation" }),
    ]);
    expect(contenders.every(({ status }) => status < 300)).toBe(true);
    expect(await prisma!.documentAcknowledgement.count({ where: { documentVersionId: ownVsBehalf.version.id, memberProfileId: actors.own!.memberId } })).toBe(1);
  });

  it("serializes Group membership and target lifecycle races", async () => {
    const membershipTarget = await member("MembershipRace");
    const membershipGroup = await operationalGroup("MembershipRace");
    await prisma!.groupMembership.create({ data: { id: `${marker}-MEMBERSHIP-RACE-${randomUUID().slice(0, 5)}`, groupId: membershipGroup.id, memberProfileId: membershipTarget, role: "Member", addedById: adminId } });
    const grouped = await publishedDocument();
    const groupReq = await requirement(grouped.version.id, { targetType: "Group", groupId: membershipGroup.id, memberProfileId: null });
    const [ackRace, removalRace] = await Promise.all([
      request(application()).post(`/api/document-versions/${grouped.version.id}/acknowledge`).set(as(actors.behalf!.email)).send({ operationId: randomUUID(), memberProfileId: membershipTarget, onBehalf: true, note: "Membership race evidence" }),
      request(application()).delete(`/api/groups/${membershipGroup.id}/members/${membershipTarget}`).set(as(actors.manager!.email)).send({ sessionId: incidentId, expectedVersion: membershipGroup.version }),
    ]);
    expect(removalRace.status).toBe(200);
    if (ackRace.status < 300) expect(ackRace.body.sourceRequirementIds).toContain(groupReq.body.id);
    else expect(ackRace.status).toBe(409);

    const groupArchiveTarget = await operationalGroup("ArchiveRace");
    const groupDocument = await publishedDocument();
    const [groupArchive, newGroupRequirement] = await Promise.all([
      request(application()).post(`/api/groups/${groupArchiveTarget.id}/archive`).set(as(actors.manager!.email)).send({ sessionId: incidentId, expectedVersion: groupArchiveTarget.version }),
      requirement(groupDocument.version.id, { targetType: "Group", groupId: groupArchiveTarget.id, memberProfileId: null }),
    ]);
    expect(groupArchive.status).toBe(200);
    if (newGroupRequirement.status >= 300) expect(newGroupRequirement.status).toBe(409);
    if (newGroupRequirement.status < 300) {
      const [storedRequirement, archivedGroup] = await Promise.all([
        prisma!.documentRequirement.findUniqueOrThrow({ where: { id: newGroupRequirement.body.id } }),
        prisma!.operationalGroup.findUniqueOrThrow({ where: { id: groupArchiveTarget.id } }),
      ]);
      expect(archivedGroup.status).toBe("Archived");
      expect(storedRequirement.createdAt.getTime()).toBeLessThanOrEqual(archivedGroup.updatedAt.getTime());
    }

    const memberArchiveTarget = await member("ArchiveRequirementRace");
    const memberRow = await prisma!.memberProfile.findUniqueOrThrow({ where: { id: memberArchiveTarget } });
    const memberDocument = await publishedDocument();
    const [memberArchive, newMemberRequirement] = await Promise.all([
      request(application()).post(`/api/member-profiles/${memberArchiveTarget}/archive`).set(as(actors.manager!.email)).send({ expectedVersion: memberRow.version }),
      requirement(memberDocument.version.id, { memberProfileId: memberArchiveTarget }),
    ]);
    expect(memberArchive.status).toBe(200);
    if (newMemberRequirement.status >= 300) expect(newMemberRequirement.status).toBe(409);
    if (newMemberRequirement.status < 300) {
      const [storedRequirement, archivedMember] = await Promise.all([
        prisma!.documentRequirement.findUniqueOrThrow({ where: { id: newMemberRequirement.body.id } }),
        prisma!.memberProfile.findUniqueOrThrow({ where: { id: memberArchiveTarget } }),
      ]);
      expect(archivedMember.status).toBe("Archived");
      expect(storedRequirement.createdAt.getTime()).toBeLessThanOrEqual(archivedMember.updatedAt.getTime());
    }
  });

  it("serializes member archive against acknowledgement", async () => {
    const target = await member("ArchiveAckRace");
    const targetRow = await prisma!.memberProfile.findUniqueOrThrow({ where: { id: target } });
    const { version } = await publishedDocument();
    await requirement(version.id, { memberProfileId: target });
    const [archiveRace, ackRace] = await Promise.all([
      request(application()).post(`/api/member-profiles/${target}/archive`).set(as(actors.manager!.email)).send({ expectedVersion: targetRow.version }),
      request(application()).post(`/api/document-versions/${version.id}/acknowledge`).set(as(actors.behalf!.email)).send({ operationId: randomUUID(), memberProfileId: target, onBehalf: true, note: "Archive race evidence" }),
    ]);
    expect(archiveRace.status).toBe(200);
    if (ackRace.status >= 300) expect(ackRace.status).toBe(409);
    expect(await prisma!.documentAcknowledgement.count({ where: { documentVersionId: version.id, memberProfileId: target } })).toBe(ackRace.status < 300 ? 1 : 0);
  });

  it("enforces group incident scope and resolves durable group membership", async () => {
    const { version } = await publishedDocument();
    const payload = { documentVersionId: version.id, targetType: "Group", groupId, acknowledgementRequired: true };
    expect((await request(application()).post("/api/document-requirements").set(as(actors.noincident!.email)).send(payload)).status).toBe(404);
    const created = await request(application()).post("/api/document-requirements").set(as(actors.manager!.email)).send(payload);
    expect(created.status).toBe(201);
    const audit = await prisma!.auditLog.findFirstOrThrow({ where: { action: "create_document_requirement", entityId: created.body.id } });
    expect(audit.sessionId).toBe(incidentId);
  });

  it("resolves exact Role targets beyond 1000 members without fuzzy fallback", async () => {
    const scale = Array.from({ length: 1005 }, (_, index) => ({ id: `${marker.toLowerCase()}-scale-${index}`, memberId: `${marker}-SCALE-${String(index).padStart(4, "0")}`.toUpperCase(), firstName: "Scale", lastName: String(index).padStart(4, "0"), pool: "TEC", role: "Member", assignedFunction: "Operations", languages: ["PL"], createdById: adminId, updatedById: adminId }));
    await prisma!.memberProfile.createMany({ data: scale });
    const { version } = await publishedDocument();
    const exact = await requirement(version.id, { targetType: "Role", targetRole: "TEC Member", memberProfileId: null });
    expect(exact.status).toBe(201);
    expect(exact.body.resolvedMemberCount).toBeGreaterThan(1000);
    expect((await requirement(version.id, { targetType: "Role", targetRole: "TEC-ish", memberProfileId: null })).status).toBe(409);
    const farMember = scale.at(-1)!;
    const compliance = await createPrismaDocumentRepository(prisma!, clock).evaluateMemberCompliance(farMember.id, { id: actors.manager!.id, email: actors.manager!.email, displayName: "Manager", roles: [], permissions: ["document:read-all"] }, referenceNow);
    expect(compliance?.items.some((item) => item.documentVersionId === version.id)).toBe(true);
  });

  it("persists the full workflow across repository and app recreation with server totals and paging", async () => {
    const created = await document();
    const version = await draft(created.body.id, { versionLabel: "restart-v1" });
    const published = await publish(version.body);
    const req = await requirement(published.body.id);
    const ack = await request(application()).post(`/api/document-versions/${published.body.id}/acknowledge`).set(as(actors.own!.email)).send({ operationId: randomUUID() });
    const restored = await request(application()).get(`/api/documents/${created.body.id}`).set(as(actors.manager!.email));
    const restoredVersion = await request(application()).get(`/api/document-versions/${published.body.id}/content`).set(as(actors.manager!.email));
    const restoredRequirement = await request(application()).get(`/api/document-requirements/${req.body.id}`).set(as(actors.manager!.email));
    const restoredAcks = await request(application()).get("/api/document-acknowledgements").set(as(actors.manager!.email)).query({ documentVersionId: published.body.id, limit: 1, offset: 0 });
    expect(restored.body.id).toBe(created.body.id);
    expect(restoredVersion.body.contentBody).toBe("Controlled plain text.");
    expect(restoredRequirement.body.id).toBe(req.body.id);
    expect(restoredAcks.body).toMatchObject({ total: 1, limit: 1, data: [{ id: ack.body.id }] });
    const paged = await request(application()).get("/api/documents").set(as(actors.manager!.email)).query({ search: marker, limit: 2, offset: 0, sort: "code" });
    expect(paged.body.data).toHaveLength(2);
    expect(paged.body.total).toBeGreaterThan(2);
    expect(paged.body.totals).toMatchObject({ documents: expect.any(Number), published: expect.any(Number), requirements: expect.any(Number), outstanding: expect.any(Number), overdue: expect.any(Number), acknowledged: expect.any(Number) });
  });

  it("keeps publish notifications best-effort and post-commit", async () => {
    const created = await document();
    const version = await draft(created.body.id);
    const result = await request(application(() => { throw new Error("notification unavailable"); })).post(`/api/document-versions/${version.body.id}/publish`).set(as(actors.manager!.email)).send({ expectedVersion: version.body.version, expectedCurrentPublishedVersionId: null, operationId: randomUUID() });
    expect(result.status).toBe(200);
    expect((await prisma!.documentVersion.findUniqueOrThrow({ where: { id: version.body.id } })).status).toBe("Published");
  });
});
