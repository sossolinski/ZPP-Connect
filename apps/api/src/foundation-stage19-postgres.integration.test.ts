import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createPrismaReadinessProjectionService } from "./modules/readiness/prisma-readiness-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;
const prisma = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;
const as = (email: string) => ({ "x-user-email": email });

postgresDescribe("Foundation Stage 19 PostgreSQL Readiness projection integrity", () => {
  const marker = `F19-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const at = new Date("2026-08-24T12:00:00.000Z");
  const memberIds = Array.from({ length: 1005 }, (_, index) => `${marker.toLowerCase()}-member-${String(index + 1).padStart(4, "0")}`);
  const groupIds = Array.from({ length: 201 }, (_, index) => `${marker.toLowerCase()}-group-${String(index + 1).padStart(4, "0")}`);
  const roleIds: string[] = [];
  const userIds: string[] = [];
  let admin: { id: string; email: string; displayName: string };
  let incidentId: string;
  let own: { id: string; email: string; displayName: string };
  let scoped: { id: string; email: string; displayName: string };
  let summaryOnly: { id: string; email: string; displayName: string };
  let scopedRoleId: string;
  let scopedAssignmentIds: string[] = [];
  let trainingCourseId: string;
  let trainingRequirementId: string;
  let documentId: string;
  let documentVersionId: string;
  let documentRequirementId: string;
  let availabilityId: string;
  let rosterId: string;
  let baseMemberCount = 0;

  const application = (service = createPrismaReadinessProjectionService(prisma!, { now: () => new Date(at) })) => createApp({ readinessService: service, trainingClock: { now: () => new Date(at) } });

  async function userWithRole(suffix: string, permissions: string[], scopeType: "GLOBAL" | "GROUP" = "GLOBAL") {
    const email = `${marker.toLowerCase()}-${suffix}@example.test`;
    const role = await prisma!.role.create({ data: {
      name: `${marker.toLowerCase()}-${suffix}`, normalizedName: `${marker.toLowerCase()}-${suffix}`, displayName: `${marker} ${suffix}`,
      permissions, scopeTypes: [scopeType], custom: true, status: "Active",
    } });
    const user = await prisma!.user.create({ data: {
      email, normalizedEmail: email, displayName: `${marker} ${suffix}`, status: "Active", authenticationPolicy: "SSO_ONLY",
      roles: { create: { roleId: role.id, scopeType, assignedBy: admin.id } },
    } });
    roleIds.push(role.id); userIds.push(user.id);
    return { id: user.id, email: user.email, displayName: user.displayName, roleId: role.id };
  }

  beforeAll(async () => {
    admin = await prisma!.user.findUniqueOrThrow({ where: { email: "coordinator@lot.pl" }, select: { id: true, email: true, displayName: true } });
    baseMemberCount = await prisma!.memberProfile.count();
    incidentId = (await prisma!.session.create({ data: { operationalId: `${marker}-SESSION`, mode: "EXERCISE", status: "Active", eventType: marker, createdById: admin.id } })).id;
    const [ownActor, scopedActor, summaryActor] = await Promise.all([
      userWithRole("own", ["readiness:read-own"]),
      userWithRole("scoped", ["readiness:read-own", "readiness:read-group", "readiness:read-summary"], "GROUP"),
      userWithRole("summary", ["readiness:read-summary"]),
    ]);
    own = ownActor; scoped = scopedActor; summaryOnly = summaryActor; scopedRoleId = scopedActor.roleId;

    await prisma!.operationalGroup.createMany({ data: groupIds.map((id, index) => ({
      id, operationalId: `${marker}-GRP-${String(index + 1).padStart(4, "0")}`, incidentId,
      name: `${marker} Group ${String(index + 1).padStart(4, "0")}`, pool: "ZPP", functionName: "Readiness", status: "Active", createdById: admin.id,
    })) });
    await prisma!.memberProfile.createMany({ data: memberIds.map((id, index) => ({
      id, memberId: `${marker}-MEM-${String(index + 1).padStart(4, "0")}`, linkedUserId: index === 0 ? own.id : index === 1 ? scoped.id : null,
      firstName: `${marker}`, lastName: `Member ${String(index + 1).padStart(4, "0")}`, pool: "ZPP", role: "Member",
      assignedFunction: index === 1004 ? "Family Assistance Team" : "Readiness", languages: ["PL"], status: "Active", createdById: admin.id,
    })) });
    await prisma!.groupMembership.createMany({ data: memberIds.map((memberProfileId, index) => ({
      id: `${marker}-GMB-${String(index + 1).padStart(4, "0")}`, groupId: groupIds[0]!, memberProfileId, role: index === 0 ? "Leader" : "Member", addedById: admin.id,
    })) });
    await prisma!.groupMembership.create({ data: { id: `${marker}-GMB-MULTI`, groupId: groupIds[200]!, memberProfileId: memberIds[1004]!, role: "Member", addedById: admin.id } });
    scopedAssignmentIds = [`${marker}-GRA-1`, `${marker}-GRA-201`];
    await prisma!.groupRoleAssignment.createMany({ data: [
      { id: scopedAssignmentIds[0]!, userId: scoped.id, roleId: scopedRoleId, groupId: groupIds[0]!, assignedBy: admin.id },
      { id: scopedAssignmentIds[1]!, userId: scoped.id, roleId: scopedRoleId, groupId: groupIds[200]!, assignedBy: admin.id },
    ] });

    trainingCourseId = `${marker}-COURSE`;
    trainingRequirementId = `${marker}-TREQ`;
    await prisma!.trainingCourse.create({ data: { id: trainingCourseId, code: `${marker}-COURSE`, normalizedCode: `${marker.toLowerCase()}-course`, title: `${marker} Required Course`, category: "Readiness", deliveryType: "E-learning", active: true } });
    await prisma!.trainingRequirement.create({ data: { id: trainingRequirementId, courseId: trainingCourseId, targetType: "MemberProfile", memberProfileId: memberIds[1004], requiredStatus: "Required", dueAt: new Date("2026-08-20T00:00:00.000Z"), active: true } });

    documentId = `${marker}-DOC`; documentVersionId = `${marker}-DVER`; documentRequirementId = `${marker}-DREQ`;
    await prisma!.document.create({ data: { id: documentId, code: `${marker}-DOC`, normalizedCode: `${marker.toLowerCase()}-doc`, title: `${marker} Required Document`, category: "Readiness", ownerFunction: "Readiness", active: true, legacyMetadata: { sentinel: "SECRET_DOCUMENT_METADATA" } } });
    await prisma!.documentVersion.create({ data: { id: documentVersionId, documentId, versionLabel: "1.0", normalizedVersionLabel: "1.0", status: "Published", contentMode: "Internal text", contentBody: "SECRET_DOCUMENT_CONTENT", contentDigest: createHash("sha256").update("SECRET_DOCUMENT_CONTENT").digest("hex"), publishedAt: at, publishedById: admin.id } });
    await prisma!.documentRequirement.create({ data: { id: documentRequirementId, documentVersionId, targetType: "MemberProfile", memberProfileId: memberIds[1004], acknowledgementRequired: true, dueAt: new Date("2026-08-25T00:00:00.000Z"), active: true } });

    availabilityId = `${marker}-AVAIL`;
    await prisma!.availability.create({ data: { id: availabilityId, operationalId: `${marker}-AVL-1`, memberProfileId: memberIds[1004]!, startAt: new Date("2026-08-24T00:00:00.000Z"), endAt: new Date("2026-08-25T00:00:00.000Z"), type: "Unavailable", note: "SECRET_AVAILABILITY_NOTE", status: "Active" } });
    rosterId = `${marker}-ROSTER`;
    await prisma!.rosterShift.create({ data: { id: rosterId, operationalId: `${marker}-RST-1`, sessionId: incidentId, groupId: groupIds[0], assignedMemberProfileId: memberIds[1004], title: `${marker} Shift`, duty: "Response", functionName: "Readiness", startAt: new Date("2026-08-25T08:00:00.000Z"), endAt: new Date("2026-08-25T12:00:00.000Z"), location: "HQ", status: "Published", notes: "SECRET_ROSTER_NOTE" } });
  }, 30_000);

  afterAll(async () => {
    if (!prisma) return;
    await prisma.$executeRawUnsafe('ALTER TABLE "DocumentAcknowledgementRequirement" DISABLE TRIGGER USER');
    await prisma.$executeRawUnsafe('ALTER TABLE "DocumentAcknowledgement" DISABLE TRIGGER USER');
    await prisma.documentAcknowledgementRequirement.deleteMany({ where: { acknowledgement: { memberProfileId: { in: memberIds } } } });
    await prisma.documentAcknowledgement.deleteMany({ where: { memberProfileId: { in: memberIds } } });
    await prisma.$executeRawUnsafe('ALTER TABLE "DocumentAcknowledgement" ENABLE TRIGGER USER');
    await prisma.$executeRawUnsafe('ALTER TABLE "DocumentAcknowledgementRequirement" ENABLE TRIGGER USER');
    await prisma.rosterShift.deleteMany({ where: { id: rosterId } });
    await prisma.availability.deleteMany({ where: { memberProfileId: { in: memberIds } } });
    await prisma.memberTrainingRecord.deleteMany({ where: { memberProfileId: { in: memberIds } } });
    await prisma.documentRequirement.deleteMany({ where: { id: documentRequirementId } });
    await prisma.documentVersion.deleteMany({ where: { id: documentVersionId } });
    await prisma.document.deleteMany({ where: { id: documentId } });
    await prisma.trainingRequirement.deleteMany({ where: { id: trainingRequirementId } });
    await prisma.trainingCourse.deleteMany({ where: { id: trainingCourseId } });
    await prisma.permissionOverride.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.groupRoleAssignment.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.groupMembership.deleteMany({ where: { memberProfileId: { in: memberIds } } });
    await prisma.memberProfile.deleteMany({ where: { id: { in: memberIds } } });
    await prisma.operationalGroup.deleteMany({ where: { id: { in: groupIds } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ sessionId: incidentId }, { actorId: { in: userIds } }] } });
    await prisma.caseTimelineEvent.deleteMany({ where: { sessionId: incidentId } });
    await prisma.notification.deleteMany({ where: { OR: [{ sessionId: incidentId }, { recipientUserId: { in: userIds } }] } });
    await prisma.notificationOutbox.deleteMany({ where: { OR: [{ sessionId: incidentId }, { recipientUserId: { in: userIds } }] } });
    await prisma.incidentAssignment.deleteMany({ where: { OR: [{ incidentId }, { userId: { in: userIds } }] } });
    await prisma.session.deleteMany({ where: { id: incidentId } });
    await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.role.deleteMany({ where: { id: { in: roleIds } } });
    await prisma.$disconnect();
  }, 30_000);

  it("retains 21 migrations and computes complete 1,005-member organization totals beyond the old boundary", async () => {
    const migrations = await prisma!.$queryRaw<Array<{ count: bigint }>>`SELECT count(*)::bigint AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    expect(Number(migrations[0]!.count)).toBeGreaterThanOrEqual(21);
    const summary = await request(application()).get("/api/readiness/summary").set(as(admin.email)).query({ evaluationAt: at.toISOString() });
    expect(summary.status, JSON.stringify(summary.body)).toBe(200);
    expect(summary.body.totalMembers).toBe(baseMemberCount + 1005);
    expect(summary.body.byStatus["Not ready"]).toBeGreaterThanOrEqual(1);
    expect(summary.body).toMatchObject({ evaluationMode: "current-topology", policy: { id: "readiness-policy-2026-07", version: 1 } });
    const beyond = await request(application()).get("/api/readiness/members").set(as(admin.email)).query({ search: `${marker} Member 1005`, status: "Not ready", groupId: groupIds[200], limit: 10, offset: 0, evaluationAt: at.toISOString() });
    expect(beyond.body).toMatchObject({ total: 1, data: [{ member: { id: memberIds[1004] }, overallStatus: "Not ready" }] });
    expect(beyond.body.data[0].blockerCount).toBeGreaterThanOrEqual(1);
    expect(beyond.body.data[0]).not.toHaveProperty("dimensions");
    const detail = await request(application()).get(`/api/readiness/members/${memberIds[1004]}`).set(as(admin.email)).query({ evaluationAt: at.toISOString() });
    expect(detail.body.blockers.map((item: any) => item.code)).toContain("training-not-complete");
  }, 30_000);

  it("uses durable own links and GROUP scope without IncidentAssignment, supports multiple groups, and anti-enumerates", async () => {
    const me = await request(application()).get("/api/readiness/me").set(as(own.email)).query({ evaluationAt: at.toISOString() });
    expect(me.body.member.id).toBe(memberIds[0]);
    await prisma!.memberProfile.update({ where: { id: memberIds[0] }, data: { linkedUserId: null } });
    await prisma!.memberProfile.update({ where: { id: memberIds[2] }, data: { linkedUserId: own.id } });
    expect((await request(application()).get("/api/readiness/me").set(as(own.email)).query({ evaluationAt: at.toISOString() })).body.member.id).toBe(memberIds[2]);

    expect(await prisma!.incidentAssignment.count({ where: { userId: scoped.id } })).toBe(0);
    const groups = await request(application()).get("/api/readiness/groups").set(as(scoped.email)).query({ optionsOnly: true, limit: 20 });
    expect(groups.body.total).toBe(2);
    expect(groups.body.data.map((item: any) => item.group.id)).toEqual(expect.arrayContaining([groupIds[0], groupIds[200]]));
    const thousand = await request(application()).get(`/api/readiness/groups/${groupIds[0]}`).set(as(scoped.email)).query({ limit: 200, offset: 800, evaluationAt: at.toISOString() });
    expect(thousand.body).toMatchObject({ total: 1005, limit: 200, offset: 800 });
    expect(new Set(thousand.body.members.map((item: any) => item.member.id)).size).toBe(thousand.body.members.length);
    expect((await request(application()).get(`/api/readiness/members/${memberIds[500]}`).set(as(own.email))).status).toBe(404);
    expect((await request(application()).get("/api/readiness/members/does-not-exist").set(as(own.email))).status).toBe(404);
    expect((await request(application()).get(`/api/readiness/groups/${groupIds[1]}`).set(as(scoped.email))).status).toBe(404);
  }, 30_000);

  it("pages all 201 groups and returns lightweight options separately from bounded readiness summaries", async () => {
    const page = await request(application()).get("/api/readiness/groups").set(as(admin.email)).query({ search: `${marker} Group`, limit: 1, offset: 200, optionsOnly: true, evaluationAt: at.toISOString() });
    expect(page.body).toMatchObject({ total: 201, limit: 1, offset: 200, data: [{ group: { id: groupIds[200] } }] });
    expect(page.body.data[0]).not.toHaveProperty("summary");
    const summaryPage = await request(application()).get("/api/readiness/groups").set(as(admin.email)).query({ search: `${marker} Group 0201`, limit: 10, evaluationAt: at.toISOString() });
    expect(summaryPage.body.data[0].summary.totalMembers).toBe(1);
  }, 30_000);

  it("keeps summary-only disclosure aggregate and reflects durable revocation immediately", async () => {
    const summary = await request(application()).get("/api/readiness/summary").set(as(summaryOnly.email)).query({ evaluationAt: at.toISOString() });
    expect(summary.status).toBe(200);
    expect(summary.body.totalMembers).toBe(baseMemberCount + 1005);
    expect(JSON.stringify(summary.body)).not.toContain(memberIds[1004]!);
    expect(JSON.stringify(summary.body)).not.toContain(`${marker} Member`);
    expect((await request(application()).get("/api/readiness/members").set(as(summaryOnly.email))).status).toBe(403);
    expect((await request(application()).get(`/api/readiness/members/${memberIds[1004]}`).set(as(summaryOnly.email))).status).toBe(404);
    expect((await request(application()).get("/api/readiness/groups").set(as(summaryOnly.email))).status).toBe(403);

    await prisma!.groupRoleAssignment.updateMany({ where: { id: { in: scopedAssignmentIds } }, data: { status: "Revoked", revokedAt: at, revokedBy: admin.id } });
    expect((await request(application()).get("/api/readiness/members").set(as(scoped.email))).status).toBe(403);
    await prisma!.groupRoleAssignment.updateMany({ where: { id: { in: scopedAssignmentIds } }, data: { status: "Active", revokedAt: null, revokedBy: null } });
    expect((await request(application()).get("/api/readiness/members").set(as(scoped.email)).query({ limit: 1 })).status).toBe(200);
  }, 30_000);

  it("honors expired/revoked overrides, unlinked own state, membership changes and archived topology immediately", async () => {
    const deny = await prisma!.permissionOverride.create({ data: { userId: summaryOnly.id, permission: "readiness:read-summary", effect: "DENY", active: true, reason: marker, expiresAt: new Date("2026-08-24T11:59:59.000Z"), createdById: admin.id } });
    expect((await request(application()).get("/api/readiness/summary").set(as(summaryOnly.email)).query({ evaluationAt: at.toISOString() })).status).toBe(200);
    await prisma!.permissionOverride.update({ where: { id: deny.id }, data: { expiresAt: new Date("2026-08-25T00:00:00.000Z") } });
    expect((await request(application()).get("/api/readiness/summary").set(as(summaryOnly.email)).query({ evaluationAt: at.toISOString() })).status).toBe(403);
    await prisma!.permissionOverride.update({ where: { id: deny.id }, data: { active: false, revokedAt: at, revokedById: admin.id } });
    expect((await request(application()).get("/api/readiness/summary").set(as(summaryOnly.email)).query({ evaluationAt: at.toISOString() })).status).toBe(200);

    await prisma!.memberProfile.update({ where: { id: memberIds[2] }, data: { linkedUserId: null } });
    const unlinked = await request(application()).get("/api/readiness/me").set(as(own.email)).query({ evaluationAt: at.toISOString() });
    expect(unlinked.body).toMatchObject({ member: null, overallStatus: "Unknown", warnings: [{ code: "member-profile-not-linked" }] });
    await prisma!.memberProfile.update({ where: { id: memberIds[2] }, data: { linkedUserId: own.id } });

    await prisma!.groupMembership.update({ where: { id: `${marker}-GMB-MULTI` }, data: { removedAt: at, removedById: admin.id } });
    expect((await request(application()).get(`/api/readiness/groups/${groupIds[200]}`).set(as(scoped.email)).query({ limit: 10, evaluationAt: at.toISOString() })).body.total).toBe(0);
    await prisma!.groupMembership.update({ where: { id: `${marker}-GMB-MULTI` }, data: { removedAt: null, removedById: null } });
    expect((await request(application()).get(`/api/readiness/groups/${groupIds[200]}`).set(as(scoped.email)).query({ limit: 10, evaluationAt: at.toISOString() })).body.total).toBe(1);

    await prisma!.groupMembership.update({ where: { id: `${marker}-GMB-MULTI` }, data: { removedAt: at, removedById: admin.id } });
    await prisma!.groupRoleAssignment.update({ where: { id: scopedAssignmentIds[1] }, data: { status: "Revoked", revokedAt: at, revokedBy: admin.id } });
    await prisma!.operationalGroup.update({ where: { id: groupIds[200] }, data: { status: "Archived" } });
    expect((await request(application()).get(`/api/readiness/groups/${groupIds[200]}`).set(as(scoped.email))).status).toBe(404);
    await prisma!.operationalGroup.update({ where: { id: groupIds[200] }, data: { status: "Active" } });
    await prisma!.groupRoleAssignment.update({ where: { id: scopedAssignmentIds[1] }, data: { status: "Active", revokedAt: null, revokedBy: null } });
    await prisma!.groupMembership.update({ where: { id: `${marker}-GMB-MULTI` }, data: { removedAt: null, removedById: null } });

    const archiveMember = memberIds[10]!;
    await prisma!.groupMembership.update({ where: { id: `${marker}-GMB-0011` }, data: { removedAt: at, removedById: admin.id } });
    await prisma!.memberProfile.update({ where: { id: archiveMember }, data: { status: "Archived" } });
    const archived = await request(application()).get(`/api/readiness/members/${archiveMember}`).set(as(admin.email)).query({ evaluationAt: at.toISOString() });
    expect(archived.body.blockers.map((item: any) => item.code)).toContain("profile-not-active");
    await prisma!.memberProfile.update({ where: { id: archiveMember }, data: { status: "Active" } });
    await prisma!.groupMembership.update({ where: { id: `${marker}-GMB-0011` }, data: { removedAt: null, removedById: null } });
  }, 30_000);

  it("returns safe allowlisted source items and reflects Training, Documents, Availability and Roster changes without Readiness writes", async () => {
    const url = `/api/readiness/members/${memberIds[1004]}`;
    const initial = await request(application()).get(url).set(as(admin.email)).query({ evaluationAt: at.toISOString() });
    const serialized = JSON.stringify(initial.body);
    for (const secret of ["SECRET_AVAILABILITY_NOTE", "SECRET_ROSTER_NOTE", "SECRET_DOCUMENT_METADATA", "SECRET_DOCUMENT_CONTENT"]) expect(serialized).not.toContain(secret);
    expect(initial.body.warnings.map((item: any) => item.code)).toEqual(expect.arrayContaining(["document-needs-acknowledgement", "availability-unavailable", "roster-awaiting-confirmation"]));

    await prisma!.memberTrainingRecord.create({ data: { id: `${marker}-TREC`, operationalId: `${marker}-TRN-1`, memberProfileId: memberIds[1004]!, courseId: trainingCourseId, sourceRequirementId: trainingRequirementId, assignedAt: at, status: "Completed", completedAt: at, completedById: admin.id, completionNote: "SECRET_TRAINING_NOTE" } });
    let current = await request(application()).get(url).set(as(admin.email)).query({ evaluationAt: at.toISOString() });
    expect(current.body.blockers.filter((item: any) => item.source?.id === trainingCourseId)).toHaveLength(0);
    expect(JSON.stringify(current.body)).not.toContain("SECRET_TRAINING_NOTE");

    await prisma!.documentAcknowledgement.create({ data: { id: `${marker}-DACK`, documentVersionId, memberProfileId: memberIds[1004]!, acknowledgedAt: at, acknowledgedById: admin.id, acknowledgementStatementVersion: "standard-v1", note: "SECRET_ACK_NOTE", documentCode: `${marker}-DOC`, documentTitle: `${marker} Required Document`, versionLabel: "1.0", contentMode: "Internal text", contentDigestSnapshot: createHash("sha256").update("SECRET_DOCUMENT_CONTENT").digest("hex") } });
    current = await request(application()).get(url).set(as(admin.email)).query({ evaluationAt: at.toISOString() });
    expect(current.body.warnings.map((item: any) => item.code)).not.toContain("document-needs-acknowledgement");
    expect(JSON.stringify(current.body)).not.toContain("SECRET_ACK_NOTE");

    await prisma!.availability.update({ where: { id: availabilityId }, data: { type: "Available" } });
    current = await request(application()).get(url).set(as(admin.email)).query({ evaluationAt: at.toISOString() });
    expect(current.body.warnings.map((item: any) => item.code)).not.toContain("availability-unavailable");
    await prisma!.rosterShift.update({ where: { id: rosterId }, data: { status: "Confirmed", confirmedAt: at, confirmedById: admin.id } });
    current = await request(application()).get(url).set(as(admin.email)).query({ evaluationAt: at.toISOString() });
    expect(current.body.warnings.map((item: any) => item.code)).not.toContain("roster-awaiting-confirmation");
  }, 30_000);

  it("uses deterministic UTC availability precedence and current-topology temporal semantics", async () => {
    const second = `${marker}-AVAIL-2`;
    await prisma!.availability.create({ data: { id: second, operationalId: `${marker}-AVL-2`, memberProfileId: memberIds[1004]!, startAt: new Date("2026-08-24T10:00:00.000Z"), endAt: new Date("2026-08-24T14:00:00.000Z"), type: "Unavailable", status: "Active" } });
    const response = await request(application()).get(`/api/readiness/members/${memberIds[1004]}`).set(as(admin.email)).query({ evaluationAt: "2026-08-24T12:00:00.000Z" });
    expect(response.body).toMatchObject({ calculatedAt: "2026-08-24T12:00:00.000Z", evaluationMode: "current-topology" });
    expect(response.body.dimensions.find((item: any) => item.key === "availability").state).toBe("Unavailable");
    await prisma!.availability.delete({ where: { id: second } });
  });

  it("keeps each response on one repeatable-read snapshot and exposes a later commit only to the next request", async () => {
    await prisma!.memberTrainingRecord.deleteMany({ where: { memberProfileId: memberIds[1004], courseId: trainingCourseId } });
    let changed = false;
    const service = createPrismaReadinessProjectionService(prisma!, { now: () => new Date(at) }, { afterAccess: async () => {
      if (changed) return;
      changed = true;
      await prisma!.memberTrainingRecord.create({ data: { id: `${marker}-SNAPSHOT-TREC`, operationalId: `${marker}-TRN-SNAPSHOT`, memberProfileId: memberIds[1004]!, courseId: trainingCourseId, sourceRequirementId: trainingRequirementId, assignedAt: at, status: "Completed", completedAt: at, completedById: admin.id } });
    } });
    const before = await request(application(service)).get(`/api/readiness/members/${memberIds[1004]}`).set(as(admin.email)).query({ evaluationAt: at.toISOString() });
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(before.body.blockers.some((item: any) => item.source?.id === trainingCourseId && item.code === "training-not-complete")).toBe(true);
    const after = await request(application()).get(`/api/readiness/members/${memberIds[1004]}`).set(as(admin.email)).query({ evaluationAt: at.toISOString() });
    expect(after.body.blockers.some((item: any) => item.source?.id === trainingCourseId && item.code === "training-not-complete")).toBe(false);
  }, 30_000);

  it("fails closed with controlled 500 responses for every source family", async () => {
    for (const family of ["member-group", "training", "documents", "availability", "roster"] as const) {
      const service = createPrismaReadinessProjectionService(prisma!, { now: () => new Date(at) }, { beforeSource: (candidate) => { if (candidate === family) throw new Error(`${family} deterministic failure`); } });
      const response = await request(application(service)).get(`/api/readiness/members/${memberIds[1004]}`).set(as(admin.email)).query({ evaluationAt: at.toISOString() });
      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: "Internal server error" });
      expect(JSON.stringify(response.body)).not.toMatch(/Ready|deterministic failure/);
    }
  }, 30_000);

  it("has no GET side effects and survives a fresh app/service reconstruction without warmup", async () => {
    const counts = async () => ({
      audit: await prisma!.auditLog.count(), timeline: await prisma!.caseTimelineEvent.count(), notifications: await prisma!.notification.count(), outbox: await prisma!.notificationOutbox.count(),
    });
    const before = await counts();
    const fresh = application(createPrismaReadinessProjectionService(prisma!, { now: () => new Date(at) }));
    for (const [path, email] of [["/api/readiness/summary", admin.email], ["/api/readiness/members?limit=2", admin.email], ["/api/readiness/me", own.email], ["/api/readiness/groups?limit=2&optionsOnly=true", admin.email], ["/api/readiness/policy", admin.email]]) {
      expect((await request(fresh).get(path!).set(as(email!))).status).toBe(200);
    }
    expect(await counts()).toEqual(before);
    const restarted = application(createPrismaReadinessProjectionService(prisma!, { now: () => new Date(at) }));
    const direct = await request(restarted).get(`/api/readiness/members/${memberIds[1004]}`).set(as(admin.email)).query({ evaluationAt: at.toISOString() });
    expect(direct.status).toBe(200);
    expect(direct.body.member.id).toBe(memberIds[1004]);
  }, 30_000);

  it("keeps source-query family growth bounded for 10 versus 1,005 group members", async () => {
    const tenGroup = groupIds[1]!;
    await prisma!.groupMembership.createMany({ data: memberIds.slice(0, 10).map((memberProfileId, index) => ({ id: `${marker}-GMB-TEN-${index}`, groupId: tenGroup, memberProfileId, role: "Member", addedById: admin.id })) });
    const counted = new PrismaClient({ datasources: { db: { url: databaseUrl! } }, log: [{ emit: "event", level: "query" }] });
    let queries = 0;
    counted.$on("query", () => { queries += 1; });
    const service = createPrismaReadinessProjectionService(counted, { now: () => new Date(at) });
    queries = 0; await service.group(admin, tenGroup, { limit: 10, offset: 0, evaluationAt: at }); const tenQueries = queries;
    queries = 0; await service.group(admin, groupIds[0]!, { limit: 10, offset: 0, evaluationAt: at }); const thousandQueries = queries;
    expect(thousandQueries).toBeLessThanOrEqual(tenQueries + 2);
    expect(thousandQueries).toBeLessThan(30);
    await counted.$disconnect();
  }, 30_000);
});
