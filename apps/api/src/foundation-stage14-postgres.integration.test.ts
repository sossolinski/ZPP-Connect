import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { validateEntraJwt } from "./auth.js";
import { resolveConfig, validateRuntimeConfig } from "./config.js";
import { EffectiveAccessService } from "./modules/identity/effective-access-service.js";
import { IdentityAuthService } from "./modules/identity/identity-auth-service.js";
import { createNotificationDispatcher } from "./modules/notifications/notification-dispatcher.js";
import { createPrismaNotificationRepository } from "./modules/notifications/prisma-notification-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;
const prisma = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;
const as = (email: string) => ({ "x-user-email": email });

postgresDescribe("Foundation Stage 14 PostgreSQL Admin and identity access integrity", () => {
  const marker = `F14-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const markerEmail = marker.toLowerCase();
  const userIds: string[] = [];
  const roleIds: string[] = [];
  const incidentIds: string[] = [];
  const groupIds: string[] = [];
  const memberIds: string[] = [];
  let admin: { id: string; email: string; version: number };
  let testAdmin: { id: string; email: string; version: number };
  let systemAdminRoleId: string;

  function application() {
    return createApp();
  }

  async function createUser(suffix: string, values: Record<string, unknown> = {}) {
    const user = await prisma!.user.create({
      data: {
        email: `${markerEmail}-${suffix}@example.test`,
        displayName: `${marker} ${suffix}`,
        status: "Active",
        authenticationPolicy: "SSO_ONLY",
        ...values,
      },
    });
    userIds.push(user.id);
    return user;
  }

  async function createRole(suffix: string, rolePermissions: string[], scopeTypes = ["GLOBAL"]) {
    const role = await prisma!.role.create({
      data: {
        name: `${markerEmail}-${suffix}`,
        displayName: `${marker} ${suffix}`,
        permissions: rolePermissions,
        scopeTypes,
        custom: true,
      },
    });
    roleIds.push(role.id);
    return role;
  }

  async function createIncident(suffix: string) {
    const incident = await prisma!.session.create({ data: { operationalId: `${marker}-${suffix}`, mode: "EXERCISE", status: "Active", eventType: marker, createdById: admin.id } });
    incidentIds.push(incident.id);
    return incident;
  }

  async function assignIncident(userId: string, incidentId: string) {
    return prisma!.incidentAssignment.create({ data: { incidentId, userId, function: marker, createdById: admin.id } });
  }

  async function assignGroupRole(userId: string, roleId: string, incidentId: string, suffix: string) {
    const group = await prisma!.operationalGroup.create({ data: {
      id: `${markerEmail}-${suffix}-group`, operationalId: `${marker}-${suffix}-GROUP`, incidentId,
      name: `${marker} ${suffix} group`, pool: "ZPP", functionName: "Stage 14 request authorization",
      createdById: admin.id, updatedById: admin.id
    } });
    groupIds.push(group.id);
    await prisma!.userRole.create({ data: { userId, roleId, scopeType: "GROUP", assignedBy: admin.id } });
    const assignment = await prisma!.groupRoleAssignment.create({ data: { id: randomUUID(), userId, roleId, groupId: group.id, assignedBy: admin.id } });
    return { group, assignment };
  }

  async function publishBriefing(app: ReturnType<typeof createApp>, email: string, incidentId: string) {
    const draft = await request(app).post(`/api/sessions/${incidentId}/briefings/draft`).set(as(email)).send({});
    expect(draft.status, JSON.stringify(draft.body)).toBe(200);
    const updated = await request(app).patch(`/api/briefings/${draft.body.briefing.id}`).set(as(email)).send({
      expectedVersion: draft.body.briefing.version,
      title: `${marker} scoped briefing`,
      situationSummary: "Incident-scoped request authorization regression fixture.",
      priorities: [{ description: "Keep permissions bound to the target Incident.", status: "Not started" }]
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    const published = await request(app).post(`/api/briefings/${draft.body.briefing.id}/publish`).set(as(email)).send({ expectedVersion: updated.body.version });
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    return published.body;
  }

  async function dispatchSessionClosed(incidentId: string, suffix: string) {
    const outbox = await prisma!.notificationOutbox.create({ data: {
      eventType: "SESSION_CLOSED", aggregateType: "session", aggregateId: incidentId,
      aggregateVersion: `${suffix}-${randomUUID()}`, sessionId: incidentId,
      payload: { operationalId: `${marker}-${suffix}`, occurredAt: new Date().toISOString() },
      // The dispatcher clock is process-based while the default is database-based;
      // make this intentionally dispatchable instead of racing two clocks in the test.
      availableAt: new Date(Date.now() - 1_000)
    } });
    const dispatcher = createNotificationDispatcher(prisma!, createPrismaNotificationRepository(prisma!), { workerId: `${marker}-${suffix}`, batchSize: 10_000 });
    await dispatcher.runOnce();
    const notifications = await prisma!.notification.findMany({ where: { deduplicationKey: `event:outbox:${outbox.id}` }, orderBy: { recipientUserId: "asc" } });
    return { outbox, notifications };
  }

  async function createInvitation(suffix: string) {
    const response = await request(application()).post("/api/admin/invitations").set(as(admin.email)).send({
      operationId: randomUUID(), email: `${markerEmail}-${suffix}@example.test`, displayName: `${marker} ${suffix}`, roles: ["zpp-member"]
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    userIds.push(response.body.user.id);
    return response.body;
  }

  beforeAll(async () => {
    await prisma!.$connect();
    admin = await prisma!.user.findUniqueOrThrow({ where: { normalizedEmail: "admin@lot.pl" }, select: { id: true, email: true, version: true } });
    systemAdminRoleId = (await prisma!.role.findUniqueOrThrow({ where: { normalizedName: "system-admin" } })).id;
    const created = await createUser("second-admin");
    await prisma!.userRole.create({ data: { userId: created.id, roleId: systemAdminRoleId, assignedBy: admin.id } });
    testAdmin = { id: created.id, email: created.email, version: created.version };
  });

  afterAll(async () => {
    if (!prisma) return;
    // A failed invariant test must never leave the durable seed administrator inactive.
    await prisma.user.updateMany({ where: { id: admin?.id }, data: { status: "Active", suspensionReason: null } });
    await prisma.notification.deleteMany({ where: { recipientUserId: { in: userIds } } });
    await prisma.notificationOutbox.deleteMany({ where: { OR: [{ recipientUserId: { in: userIds } }, { sessionId: { in: incidentIds } }, { aggregateId: { startsWith: marker } }] } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: userIds } }, { entityId: { in: userIds } }, { summary: { contains: marker } }] } });
    await prisma.identityOperation.deleteMany({ where: { targetUserId: { in: userIds } } });
    await prisma.roleAssignmentHistory.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { roleId: { in: roleIds } }] } });
    await prisma.permissionOverride.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.externalIdentity.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.userInvitation.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.groupRoleAssignment.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { groupId: { in: groupIds } }] } });
    await prisma.incidentAssignment.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { incidentId: { in: incidentIds } }] } });
    await prisma.memberProfile.deleteMany({ where: { id: { in: memberIds } } });
    await prisma.operationalGroup.deleteMany({ where: { id: { in: groupIds } } });
    await prisma.session.deleteMany({ where: { id: { in: incidentIds } } });
    await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.role.deleteMany({ where: { id: { in: roleIds } } });
    await prisma.organization.deleteMany({ where: { normalizedKey: { startsWith: markerEmail } } });
    await prisma.$disconnect();
  });

  it("deploys canonical Stage 14 constraints, indexes, history and stable identity tables", async () => {
    const migration = await prisma!.$queryRaw<Array<{ count: bigint }>>`SELECT count(*)::bigint AS count FROM "_prisma_migrations" WHERE migration_name = '20260821090000_admin_identity_foundation' AND finished_at IS NOT NULL`;
    expect(migration[0]!.count).toBe(1n);
    const constraints = await prisma!.$queryRaw<Array<{ name: string }>>`SELECT conname AS name FROM pg_constraint WHERE conname IN ('User_status_check', 'User_authenticationPolicy_check', 'User_normalizedEmail_check', 'Role_status_check', 'PermissionOverride_effect_check', 'UserInvitation_status_check')`;
    expect(constraints).toHaveLength(6);
    const indexes = await prisma!.$queryRaw<Array<{ name: string }>>`SELECT indexname AS name FROM pg_indexes WHERE indexname IN ('User_normalizedEmail_key', 'Role_normalizedName_key', 'GroupRoleAssignment_active_key', 'PermissionOverride_active_key', 'ExternalIdentity_provider_subject_key', 'ExternalIdentity_directory_object_key', 'UserInvitation_open_email_key')`;
    expect(indexes).toHaveLength(7);
    const historyTable = await prisma!.$queryRaw<Array<{ name: string }>>`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'RoleAssignmentHistory'`;
    expect(historyTable).toHaveLength(1);
  });

  it("normalizes e-mail and role keys and allows exactly one concurrent duplicate", async () => {
    const email = `${markerEmail}-race@example.test`;
    const attempts = await Promise.allSettled([
      prisma!.user.create({ data: { email: email.toUpperCase(), displayName: `${marker} race A` } }),
      prisma!.user.create({ data: { email, displayName: `${marker} race B` } }),
    ]);
    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const winner = attempts.find((result): result is PromiseFulfilledResult<any> => result.status === "fulfilled")!.value;
    userIds.push(winner.id);
    expect(winner.normalizedEmail).toBe(email);
    expect(await prisma!.user.count({ where: { normalizedEmail: email } })).toBe(1);
  });

  it("persists Pending user, role, override and invitation across fresh app/service instances", async () => {
    const role = await createRole("restart-reader", ["session:read"]);
    const created = await request(application()).post("/api/admin/users").set(as(admin.email)).send({
      email: `${markerEmail}-restart@example.test`, displayName: `${marker} restart`,
    });
    expect(created.status).toBe(201);
    userIds.push(created.body.id);
    const assignment = await request(application()).post(`/api/admin/users/${created.body.id}/role-assignments`).set(as(admin.email)).send({ roleName: role.name, scopeType: "GLOBAL" });
    expect(assignment.status).toBe(201);
    const override = await request(application()).post(`/api/admin/users/${created.body.id}/capability-overrides`).set(as(admin.email)).send({ permission: "reports:read", effect: "GRANT", reason: "Stage 14 restart evidence" });
    expect(override.status).toBe(201);
    const invitation = await prisma!.userInvitation.create({ data: { userId: created.body.id, invitedEmailSnapshot: created.body.email, intendedAuthenticationPolicy: "SSO_ONLY", tokenHash: randomUUID(), tokenExpiresAt: new Date(Date.now() + 60_000), createdById: admin.id } });
    const restartedApp = application();
    const read = await request(restartedApp).get(`/api/admin/users/${created.body.id}`).set(as(admin.email));
    expect(read.body).toMatchObject({ id: created.body.id, status: "Pending", invitationStatus: "Prepared" });
    const projection = await new EffectiveAccessService(prisma!).forUser(created.body.id);
    expect(projection).toBeNull();
    expect((await prisma!.userInvitation.findUniqueOrThrow({ where: { id: invitation.id } })).status).toBe("Prepared");
  });

  it("applies lifecycle and override changes to real authorization on the next request", async () => {
    const role = await createRole("immediate-reader", ["session:read", "reports:read"]);
    const user = await createUser("immediate");
    await prisma!.userRole.create({ data: { userId: user.id, roleId: role.id, assignedBy: admin.id } });
    expect((await request(application()).get("/api/auth/me").set(as(user.email))).body.user.permissions).toContain("reports:read");
    const denied = await request(application()).post(`/api/admin/users/${user.id}/capability-overrides`).set(as(admin.email)).send({ permission: "reports:read", effect: "DENY", reason: "Validate immediate deny" });
    expect(denied.status).toBe(201);
    expect((await request(application()).get("/api/auth/me").set(as(user.email))).body.user.permissions).not.toContain("reports:read");
    const current = await prisma!.user.findUniqueOrThrow({ where: { id: user.id } });
    const suspended = await request(application()).post(`/api/admin/users/${user.id}/suspend`).set(as(admin.email)).send({ expectedVersion: current.version, reason: "Validate immediate suspension" });
    expect(suspended.status).toBe(200);
    expect((await request(application()).get("/api/auth/me").set(as(user.email))).status).toBe(401);
    expect((await prisma!.user.findUniqueOrThrow({ where: { id: user.id } })).status).toBe("Suspended");
  });

  it("requires IncidentAssignment before a group role contributes permissions", async () => {
    const user = await createUser("group-scope");
    const role = await createRole("group-reader", ["passenger:read"], ["GROUP"]);
    const incident = await prisma!.session.create({ data: { operationalId: `${marker}-INC`, mode: "EXERCISE", status: "Active", eventType: marker, createdById: admin.id } });
    incidentIds.push(incident.id);
    const group = await prisma!.operationalGroup.create({ data: { id: `${markerEmail}-group`, operationalId: `${marker}-GROUP`, incidentId: incident.id, name: `${marker} group`, pool: "ZPP", functionName: "Family assistance", createdById: admin.id, updatedById: admin.id } });
    groupIds.push(group.id);
    await prisma!.userRole.create({ data: { userId: user.id, roleId: role.id, scopeType: "GROUP", assignedBy: admin.id } });
    await prisma!.groupRoleAssignment.create({ data: { id: randomUUID(), userId: user.id, roleId: role.id, groupId: group.id, assignedBy: admin.id } });
    expect((await new EffectiveAccessService(prisma!).forUser(user.id))!.permissions).not.toContain("passenger:read");
    await prisma!.incidentAssignment.create({ data: { incidentId: incident.id, userId: user.id, function: marker, createdById: admin.id } });
    expect((await new EffectiveAccessService(prisma!).forUser(user.id))!.permissions).toContain("passenger:read");
  });

  it("delivers SESSION_CLOSED exactly once for an effective GLOBAL session:read role", async () => {
    const user = await createUser("notification-global");
    const role = await createRole("notification-global", ["session:read"]);
    const incident = await createIncident("NOTIFY-GLOBAL");
    await prisma!.userRole.create({ data: { userId: user.id, roleId: role.id, assignedBy: admin.id } });
    await assignIncident(user.id, incident.id);

    const { notifications } = await dispatchSessionClosed(incident.id, "notify-global");
    expect(notifications.map(({ recipientUserId }) => recipientUserId)).toEqual([user.id]);
  });

  it("keeps GROUP notification permission tied to the matching Incident", async () => {
    const user = await createUser("notification-group");
    const role = await createRole("notification-group", ["session:read"], ["GROUP"]);
    const incidentA = await createIncident("NOTIFY-GROUP-A");
    const incidentB = await createIncident("NOTIFY-GROUP-B");
    const group = await prisma!.operationalGroup.create({ data: { id: `${markerEmail}-notify-group`, operationalId: `${marker}-NOTIFY-GROUP`, incidentId: incidentA.id, name: `${marker} notification group`, pool: "ZPP", functionName: "Family assistance", createdById: admin.id, updatedById: admin.id } });
    groupIds.push(group.id);
    await prisma!.userRole.create({ data: { userId: user.id, roleId: role.id, scopeType: "GROUP", assignedBy: admin.id } });
    await prisma!.groupRoleAssignment.create({ data: { id: randomUUID(), userId: user.id, roleId: role.id, groupId: group.id, assignedBy: admin.id } });
    await assignIncident(user.id, incidentA.id);
    await assignIncident(user.id, incidentB.id);

    const correct = await dispatchSessionClosed(incidentA.id, "notify-group-a");
    const wrong = await dispatchSessionClosed(incidentB.id, "notify-group-b");
    expect(correct.notifications.map(({ recipientUserId }) => recipientUserId)).toEqual([user.id]);
    expect(wrong.notifications).toHaveLength(0);
  });

  it("applies active, expired and revoked DENY overrides identically during notification targeting", async () => {
    const role = await createRole("notification-deny", ["session:read"]);
    const incident = await createIncident("NOTIFY-DENY");
    const denied = await createUser("notification-denied");
    const expired = await createUser("notification-expired-deny");
    const revoked = await createUser("notification-revoked-deny");
    for (const user of [denied, expired, revoked]) {
      await prisma!.userRole.create({ data: { userId: user.id, roleId: role.id, assignedBy: admin.id } });
      await assignIncident(user.id, incident.id);
    }
    await prisma!.permissionOverride.create({ data: { userId: denied.id, permission: "session:read", effect: "DENY", reason: marker, createdById: admin.id } });
    await prisma!.permissionOverride.create({ data: { userId: expired.id, permission: "session:read", effect: "DENY", reason: marker, expiresAt: new Date(Date.now() - 1_000), createdById: admin.id } });
    await prisma!.permissionOverride.create({ data: { userId: revoked.id, permission: "session:read", effect: "DENY", reason: marker, active: false, revokedAt: new Date(), revokedById: admin.id, revokeReason: marker, createdById: admin.id } });

    const { notifications } = await dispatchSessionClosed(incident.id, "notify-deny");
    expect(notifications.map(({ recipientUserId }) => recipientUserId).sort()).toEqual([expired.id, revoked.id].sort());
  });

  it("honors an active GRANT override for an incident-assigned notification recipient", async () => {
    const user = await createUser("notification-grant");
    const incident = await createIncident("NOTIFY-GRANT");
    await assignIncident(user.id, incident.id);
    await prisma!.permissionOverride.create({ data: { userId: user.id, permission: "session:read", effect: "GRANT", reason: marker, createdById: admin.id } });

    const { outbox, notifications } = await dispatchSessionClosed(incident.id, "notify-grant");
    const durableOutbox = await prisma!.notificationOutbox.findUniqueOrThrow({ where: { id: outbox.id } });
    expect(notifications.map(({ recipientUserId }) => recipientUserId), JSON.stringify({ status: durableOutbox.status, error: durableOutbox.lastError })).toEqual([user.id]);
  });

  it("excludes inactive accounts, archived roles and users without IncidentAssignment", async () => {
    const role = await createRole("notification-lifecycle", ["session:read"]);
    const archivedRole = await createRole("notification-archived-role", ["session:read"]);
    const incident = await createIncident("NOTIFY-LIFECYCLE");
    const suspended = await createUser("notification-suspended", { status: "Suspended" });
    const archived = await createUser("notification-archived", { status: "Archived" });
    const staleRole = await createUser("notification-stale-role");
    const noIncident = await createUser("notification-no-incident");
    for (const user of [suspended, archived]) {
      await prisma!.userRole.create({ data: { userId: user.id, roleId: role.id, assignedBy: admin.id } });
      await assignIncident(user.id, incident.id);
    }
    await prisma!.userRole.create({ data: { userId: staleRole.id, roleId: archivedRole.id, assignedBy: admin.id } });
    await assignIncident(staleRole.id, incident.id);
    await prisma!.role.update({ where: { id: archivedRole.id }, data: { status: "Archived" } });
    await prisma!.userRole.create({ data: { userId: noIncident.id, roleId: role.id, assignedBy: admin.id } });

    const { notifications } = await dispatchSessionClosed(incident.id, "notify-lifecycle");
    expect(notifications).toHaveLength(0);
  });

  it("removes GROUP notification eligibility after assignment revoke and Group archive", async () => {
    const role = await createRole("notification-group-lifecycle", ["session:read"], ["GROUP"]);
    const incident = await createIncident("NOTIFY-GROUP-LIFECYCLE");
    const user = await createUser("notification-group-lifecycle");
    const group = await prisma!.operationalGroup.create({ data: { id: `${markerEmail}-notify-group-lifecycle`, operationalId: `${marker}-NOTIFY-GROUP-LIFECYCLE`, incidentId: incident.id, name: `${marker} notification group lifecycle`, pool: "ZPP", functionName: "Family assistance", createdById: admin.id, updatedById: admin.id } });
    groupIds.push(group.id);
    await prisma!.userRole.create({ data: { userId: user.id, roleId: role.id, scopeType: "GROUP", assignedBy: admin.id } });
    const assignment = await prisma!.groupRoleAssignment.create({ data: { id: randomUUID(), userId: user.id, roleId: role.id, groupId: group.id, assignedBy: admin.id } });
    await assignIncident(user.id, incident.id);
    await prisma!.groupRoleAssignment.update({ where: { id: assignment.id }, data: { status: "Revoked", revokedAt: new Date(), revokedBy: admin.id, revokeReason: marker } });
    await prisma!.operationalGroup.update({ where: { id: group.id }, data: { status: "Archived" } });

    const { notifications } = await dispatchSessionClosed(incident.id, "notify-group-lifecycle");
    expect(notifications).toHaveLength(0);
  });

  it("matches scoped forUser authorization with permission recipient eligibility", async () => {
    const role = await createRole("notification-consistency", ["session:read"], ["GLOBAL", "GROUP"]);
    const incidentA = await createIncident("NOTIFY-CONSISTENCY-A");
    const incidentB = await createIncident("NOTIFY-CONSISTENCY-B");
    const global = await createUser("notification-consistency-global");
    const groupOnly = await createUser("notification-consistency-group");
    const denied = await createUser("notification-consistency-denied");
    const granted = await createUser("notification-consistency-granted");
    await prisma!.userRole.createMany({ data: [
      { userId: global.id, roleId: role.id, scopeType: "GLOBAL", assignedBy: admin.id },
      { userId: groupOnly.id, roleId: role.id, scopeType: "GROUP", assignedBy: admin.id },
      { userId: denied.id, roleId: role.id, scopeType: "GLOBAL", assignedBy: admin.id },
    ] });
    const group = await prisma!.operationalGroup.create({ data: { id: `${markerEmail}-notify-consistency`, operationalId: `${marker}-NOTIFY-CONSISTENCY`, incidentId: incidentA.id, name: `${marker} notification consistency`, pool: "ZPP", functionName: "Family assistance", createdById: admin.id, updatedById: admin.id } });
    groupIds.push(group.id);
    await prisma!.groupRoleAssignment.create({ data: { id: randomUUID(), userId: groupOnly.id, roleId: role.id, groupId: group.id, assignedBy: admin.id } });
    for (const user of [global, groupOnly, denied, granted]) {
      await assignIncident(user.id, incidentA.id);
      await assignIncident(user.id, incidentB.id);
    }
    await prisma!.permissionOverride.create({ data: { userId: denied.id, permission: "session:read", effect: "DENY", reason: marker, createdById: admin.id } });
    await prisma!.permissionOverride.create({ data: { userId: granted.id, permission: "session:read", effect: "GRANT", reason: marker, createdById: admin.id } });

    const service = new EffectiveAccessService(prisma!);
    for (const incident of [incidentA, incidentB]) {
      const eligible = new Set(await service.eligibleUsersForPermission("session:read", { incidentId: incident.id }));
      for (const user of [global, groupOnly, denied, granted]) {
        const authorized = (await service.forUser(user.id, { incidentId: incident.id }))!.permissions.includes("session:read");
        expect(eligible.has(user.id)).toBe(authorized);
      }
    }
    expect(await service.hasEffectivePermission(groupOnly.id, "session:read", { incidentId: incidentA.id })).toBe(true);
    expect(await service.hasEffectivePermission(groupOnly.id, "session:read", { incidentId: incidentB.id })).toBe(false);
  });

  it("binds built-in and custom GROUP Briefing permissions to the target Incident at the HTTP boundary", async () => {
    const incidentA = await createIncident("HTTP-SCOPE-A");
    const incidentB = await createIncident("HTTP-SCOPE-B");
    const builtIn = await createUser("http-built-in-group");
    const custom = await createUser("http-custom-group");
    const creator = await createUser("http-global-creator");
    const builtInRole = await prisma!.role.findUniqueOrThrow({ where: { normalizedName: "zpp-group-leader" } });
    const customRole = await createRole("http-custom-group", ["briefing:read", "briefing:read-history", "briefing:create-draft", "briefing:update-draft", "briefing:publish"], ["GROUP"]);
    const creatorRole = await createRole("http-global-creator", ["briefing:read", "briefing:read-history", "briefing:create-draft", "briefing:update-draft", "briefing:publish"]);
    await assignGroupRole(builtIn.id, builtInRole.id, incidentA.id, "http-built-in");
    await assignGroupRole(custom.id, customRole.id, incidentA.id, "http-custom");
    await prisma!.userRole.create({ data: { userId: creator.id, roleId: creatorRole.id, scopeType: "GLOBAL", assignedBy: admin.id } });
    for (const user of [builtIn, custom]) {
      await assignIncident(user.id, incidentA.id);
      await assignIncident(user.id, incidentB.id);
    }
    await assignIncident(creator.id, incidentB.id);

    const app = application();
    const briefingB = await publishBriefing(app, creator.email, incidentB.id);
    const service = new EffectiveAccessService(prisma!);

    expect((await request(app).get("/api/auth/me").set(as(builtIn.email))).body.user.permissions).toContain("briefing:read");
    expect(await service.hasEffectivePermission(builtIn.id, "briefing:read", { incidentId: incidentA.id })).toBe(true);
    expect(await service.hasEffectivePermission(builtIn.id, "briefing:read", { incidentId: incidentB.id })).toBe(false);
    expect((await request(app).get(`/api/sessions/${incidentA.id}/active-event`).set(as(builtIn.email))).status).toBe(200);
    expect((await request(app).get(`/api/sessions/${incidentB.id}/active-event`).set(as(builtIn.email))).status).toBe(403);
    expect((await request(app).get(`/api/sessions/${incidentB.id}/briefings/current`).set(as(builtIn.email))).status).toBe(403);
    expect((await request(app).get(`/api/sessions/${incidentB.id}/briefings`).set(as(builtIn.email))).status).toBe(403);
    expect((await request(app).get(`/api/briefings/${briefingB.id}`).set(as(builtIn.email))).status).toBe(403);

    expect(await service.hasEffectivePermission(custom.id, "briefing:create-draft", { incidentId: incidentA.id })).toBe(true);
    expect(await service.hasEffectivePermission(custom.id, "briefing:create-draft", { incidentId: incidentB.id })).toBe(false);
    expect((await request(app).get(`/api/sessions/${incidentA.id}/active-event`).set(as(custom.email))).status).toBe(200);

    const sideEffectsBefore = await Promise.all([
      prisma!.auditLog.count({ where: { sessionId: incidentB.id } }),
      prisma!.caseTimelineEvent.count({ where: { sessionId: incidentB.id } }),
      prisma!.notificationOutbox.count({ where: { sessionId: incidentB.id } }),
      prisma!.notification.count({ where: { sessionId: incidentB.id } })
    ]);
    const deniedWrite = await request(app).post(`/api/sessions/${incidentB.id}/briefings/draft`).set(as(custom.email)).send({});
    expect(deniedWrite.status).toBe(403);
    const sideEffectsAfter = await Promise.all([
      prisma!.auditLog.count({ where: { sessionId: incidentB.id } }),
      prisma!.caseTimelineEvent.count({ where: { sessionId: incidentB.id } }),
      prisma!.notificationOutbox.count({ where: { sessionId: incidentB.id } }),
      prisma!.notification.count({ where: { sessionId: incidentB.id } })
    ]);
    expect(sideEffectsAfter).toEqual(sideEffectsBefore);
    expect((await request(app).get(`/api/sessions/${incidentB.id}/briefings/current`).set(as(creator.email))).body).toMatchObject({ id: briefingB.id, version: briefingB.version });
  });

  it("preserves GLOBAL and override behavior in scoped Briefing HTTP decisions", async () => {
    const incident = await createIncident("HTTP-CONTROLS");
    const role = await createRole("http-global-reader", ["briefing:read"]);
    const creatorRole = await createRole("http-controls-creator", ["briefing:read", "briefing:read-history", "briefing:create-draft", "briefing:update-draft", "briefing:publish"]);
    const creator = await createUser("http-controls-creator");
    await prisma!.userRole.create({ data: { userId: creator.id, roleId: creatorRole.id, assignedBy: admin.id } });
    await assignIncident(creator.id, incident.id);
    const app = application();
    await publishBriefing(app, creator.email, incident.id);

    const global = await createUser("http-global-reader");
    const denied = await createUser("http-denied-reader");
    const expired = await createUser("http-expired-deny");
    const revoked = await createUser("http-revoked-deny");
    const granted = await createUser("http-granted-reader");
    const unassigned = await createUser("http-unassigned-reader");
    for (const user of [global, denied, expired, revoked, unassigned]) {
      await prisma!.userRole.create({ data: { userId: user.id, roleId: role.id, assignedBy: admin.id } });
    }
    for (const user of [global, denied, expired, revoked, granted]) await assignIncident(user.id, incident.id);
    await prisma!.permissionOverride.create({ data: { userId: denied.id, permission: "briefing:read", effect: "DENY", reason: marker, createdById: admin.id } });
    await prisma!.permissionOverride.create({ data: { userId: expired.id, permission: "briefing:read", effect: "DENY", reason: marker, expiresAt: new Date(Date.now() - 1_000), createdById: admin.id } });
    await prisma!.permissionOverride.create({ data: { userId: revoked.id, permission: "briefing:read", effect: "DENY", reason: marker, active: false, revokedAt: new Date(), revokedById: admin.id, revokeReason: marker, createdById: admin.id } });
    await prisma!.permissionOverride.create({ data: { userId: granted.id, permission: "briefing:read", effect: "GRANT", reason: marker, createdById: admin.id } });

    const service = new EffectiveAccessService(prisma!);
    for (const [user, allowed] of [[global, true], [denied, false], [expired, true], [revoked, true], [granted, true], [unassigned, false]] as const) {
      const effective = await service.hasEffectivePermission(user.id, "briefing:read", { incidentId: incident.id });
      const response = await request(app).get(`/api/sessions/${incident.id}/briefings/current`).set(as(user.email));
      expect(effective).toBe(allowed);
      expect(response.status).toBe(allowed ? 200 : 403);
    }
  });

  it("removes GROUP request permission on assignment, Group and Role lifecycle changes without restart", async () => {
    const incident = await createIncident("HTTP-LIFECYCLE");
    const user = await createUser("http-lifecycle");
    const role = await createRole("http-lifecycle", ["briefing:read"], ["GROUP"]);
    const { group, assignment } = await assignGroupRole(user.id, role.id, incident.id, "http-lifecycle");
    await assignIncident(user.id, incident.id);
    const app = application();
    const route = () => request(app).get(`/api/sessions/${incident.id}/active-event`).set(as(user.email));

    expect((await route()).status).toBe(200);
    await prisma!.groupRoleAssignment.update({ where: { id: assignment.id }, data: { status: "Revoked", revokedAt: new Date(), revokedBy: admin.id, revokeReason: marker } });
    expect((await route()).status).toBe(403);
    await prisma!.operationalGroup.update({ where: { id: group.id }, data: { status: "Archived" } });
    expect((await route()).status).toBe(403);
    await prisma!.operationalGroup.update({ where: { id: group.id }, data: { status: "Active" } });
    await prisma!.groupRoleAssignment.update({ where: { id: assignment.id }, data: { status: "Active", revokedAt: null, revokedBy: null, revokeReason: null } });
    expect((await route()).status).toBe(200);
    await prisma!.role.update({ where: { id: role.id }, data: { status: "Archived" } });
    expect((await route()).status).toBe(403);
  });

  it("discovers permission recipients beyond 1000 candidates without first-page truncation", async () => {
    const role = await createRole("notification-scale", ["session:read"]);
    const incident = await createIncident("NOTIFY-SCALE");
    const count = 1_005;
    await prisma!.user.createMany({ data: Array.from({ length: count }, (_, index) => ({ email: `${markerEmail}-notify-scale-${index}@example.test`, displayName: `${marker} notify scale ${index}`, status: "Active", authenticationPolicy: "SSO_ONLY" })) });
    const users = await prisma!.user.findMany({ where: { normalizedEmail: { startsWith: `${markerEmail}-notify-scale-` } }, select: { id: true } });
    userIds.push(...users.map(({ id }) => id));
    await prisma!.userRole.createMany({ data: users.map(({ id }) => ({ userId: id, roleId: role.id, scopeType: "GLOBAL", assignedBy: admin.id })) });
    await prisma!.incidentAssignment.createMany({ data: users.map(({ id }) => ({ incidentId: incident.id, userId: id, function: marker, createdById: admin.id })) });

    const eligible = new Set(await new EffectiveAccessService(prisma!).eligibleUsersForPermission("session:read", { incidentId: incident.id }));
    expect(users).toHaveLength(count);
    expect(users.every(({ id }) => eligible.has(id))).toBe(true);
  });

  it("binds Entra once by stable provider identity and cannot be hijacked by e-mail recycling", async () => {
    const first = await createUser("entra-original");
    const service = new IdentityAuthService(prisma!);
    const claims = { issuer: `https://login.example/${marker}`, subject: `${marker}-subject`, tenantId: `${marker}-tenant`, objectId: `${marker}-object`, email: first.email };
    const concurrentFirstBind = await Promise.all([service.authenticateEntra(claims), service.authenticateEntra(claims)]);
    expect(concurrentFirstBind.map(({ id }) => id)).toEqual([first.id, first.id]);
    const changedEmail = `${markerEmail}-entra-renamed@example.test`;
    await prisma!.user.update({ where: { id: first.id }, data: { email: changedEmail, normalizedEmail: changedEmail } });
    const recycled = await createUser("entra-original");
    expect((await service.authenticateEntra({ ...claims, email: recycled.email })).id).toBe(first.id);
    expect(await prisma!.externalIdentity.count({ where: { providerType: "MICROSOFT_ENTRA", tenantId: claims.tenantId, directoryObjectId: claims.objectId } })).toBe(1);
    await expect(service.authenticateEntra({ issuer: claims.issuer, subject: "unknown", tenantId: claims.tenantId, objectId: "unknown", email: `${markerEmail}-unknown@example.test` })).rejects.toMatchObject({ status: 401 });
  });

  it("atomically accepts a current invitation on the first verified Entra bind", async () => {
    const pending = await createUser("entra-invited", { status: "Pending" });
    const invitation = await prisma!.userInvitation.create({ data: { userId: pending.id, invitedEmailSnapshot: pending.email, intendedAuthenticationPolicy: "SSO_ONLY", tokenHash: randomUUID(), tokenExpiresAt: new Date(Date.now() + 60_000), createdById: admin.id } });
    const claims = { issuer: `https://login.example/${marker}`, subject: `${marker}-invited`, tenantId: `${marker}-tenant`, objectId: `${marker}-invited`, email: pending.email };
    const projection = await new IdentityAuthService(prisma!).authenticateEntra(claims);
    expect(projection.id).toBe(pending.id);
    expect(await prisma!.user.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({ status: "Active" });
    expect(await prisma!.userInvitation.findUniqueOrThrow({ where: { id: invitation.id } })).toMatchObject({ status: "Accepted" });
    const outbox = await prisma!.notificationOutbox.findFirstOrThrow({ where: { eventType: "ACCESS_CHANGED", aggregateId: invitation.id } });
    const dispatcher = createNotificationDispatcher(prisma!, createPrismaNotificationRepository(prisma!), { workerId: `${marker}-access`, batchSize: 200 });
    await dispatcher.runOnce();
    expect(await prisma!.notificationOutbox.findUniqueOrThrow({ where: { id: outbox.id } })).toMatchObject({ status: "DELIVERED" });
    expect(await prisma!.notification.findUniqueOrThrow({ where: { recipientUserId_deduplicationKey: { recipientUserId: pending.id, deduplicationKey: `event:outbox:${outbox.id}` } } })).toMatchObject({ sessionId: null, actionDestination: "/settings" });

    const noInvitation = await createUser("entra-pending-without-invite", { status: "Pending" });
    await expect(new IdentityAuthService(prisma!).authenticateEntra({ ...claims, subject: `${marker}-no-invite`, objectId: `${marker}-no-invite`, email: noInvitation.email })).rejects.toMatchObject({ status: 401 });
    expect(await prisma!.externalIdentity.count({ where: { userId: noInvitation.id } })).toBe(0);
  });

  it("rejects disabled identity authentication and protects the final usable identity", async () => {
    const user = await createUser("identity-disable");
    const claims = { issuer: `https://login.example/${marker}`, subject: `${marker}-disable`, tenantId: `${marker}-tenant`, objectId: `${marker}-disable`, email: user.email };
    const service = new IdentityAuthService(prisma!);
    await service.authenticateEntra(claims);
    const identity = await prisma!.externalIdentity.findFirstOrThrow({ where: { userId: user.id } });
    const blocked = await request(application()).post(`/api/admin/users/${user.id}/external-identities/${identity.id}/disable`).set(as(admin.email)).send({ expectedVersion: identity.version, reason: "Validate final identity protection" });
    expect(blocked.status).toBe(409);
    await prisma!.externalIdentity.update({ where: { id: identity.id }, data: { disabledAt: new Date(), disabledById: admin.id, disableReason: "Direct security fixture" } });
    await expect(service.authenticateEntra(claims)).rejects.toMatchObject({ status: 401 });
  });

  it("derives invitation expiry on read without mutating the durable command state", async () => {
    const user = await createUser("expired-invite", { status: "Pending" });
    const invitation = await prisma!.userInvitation.create({ data: { userId: user.id, invitedEmailSnapshot: user.email, intendedAuthenticationPolicy: "SSO_ONLY", tokenHash: randomUUID(), tokenExpiresAt: new Date(Date.now() - 1_000), createdById: admin.id } });
    const before = await prisma!.userInvitation.findUniqueOrThrow({ where: { id: invitation.id } });
    const response = await request(application()).get(`/api/admin/invitations/${invitation.id}`).set(as(admin.email));
    const after = await prisma!.userInvitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(response.body).toMatchObject({ status: "Expired", hasActiveToken: false });
    expect(after).toMatchObject({ status: "Prepared", version: before.version, tokenExpiresAt: before.tokenExpiresAt });
  });

  it("replays the same invitation operation and rejects operationId payload reuse", async () => {
    const operationId = randomUUID();
    const body = { operationId, email: `${markerEmail}-idempotent@example.test`, displayName: `${marker} idempotent`, roles: ["zpp-member"] };
    const created = await request(application()).post("/api/admin/invitations").set(as(admin.email)).send(body);
    const retry = await request(application()).post("/api/admin/invitations").set(as(admin.email)).send(body);
    expect(created.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(created.body.id);
    userIds.push(created.body.user.id);
    const misuse = await request(application()).post("/api/admin/invitations").set(as(admin.email)).send({ ...body, displayName: `${marker} changed` });
    expect(misuse.status).toBe(409);
    expect(await prisma!.identityOperation.count({ where: { operationId } })).toBe(1);
  });

  it("serializes User email updates against invitation creation and duplicate invitation races", async () => {
    const user = await createUser("email-vs-invite");
    const target = `${markerEmail}-email-race@example.test`;
    const [update, invitation] = await Promise.all([
      request(application()).patch(`/api/admin/users/${user.id}`).set(as(admin.email)).send({ expectedVersion: user.version, email: target }),
      request(application()).post("/api/admin/invitations").set(as(admin.email)).send({ operationId: randomUUID(), email: target, displayName: `${marker} email race`, roles: ["zpp-member"] }),
    ]);
    expect([update.status, invitation.status].sort()).toEqual([update.status === 200 ? 200 : 201, 409].sort());
    if (invitation.status === 201) userIds.push(invitation.body.user.id);
    expect(await prisma!.user.count({ where: { normalizedEmail: target } })).toBe(1);

    const duplicateEmail = `${markerEmail}-double-invite@example.test`;
    const invite = () => request(application()).post("/api/admin/invitations").set(as(admin.email)).send({ operationId: randomUUID(), email: duplicateEmail, displayName: `${marker} duplicate invite`, roles: ["zpp-member"] });
    const duplicates = await Promise.all([invite(), invite()]);
    expect(duplicates.map(({ status }) => status).sort()).toEqual([201, 409]);
    userIds.push(duplicates.find(({ status }) => status === 201)!.body.user.id);
  });

  it("serializes invitation accept against regenerate, revoke and duplicate accepts", async () => {
    const regenerateFixture = await createInvitation("accept-regenerate");
    const [acceptedOrStale, regeneratedOrConflict] = await Promise.all([
      request(application()).post(`/api/admin/invitations/${regenerateFixture.id}/local-accept`).set(as(admin.email)).send({ expectedGeneration: regenerateFixture.resendGeneration }),
      request(application()).post(`/api/admin/invitations/${regenerateFixture.id}/regenerate`).set(as(admin.email)).send({ operationId: randomUUID(), expectedVersion: regenerateFixture.version }),
    ]);
    expect([[200, 409], [410, 200]]).toContainEqual([acceptedOrStale.status, regeneratedOrConflict.status]);

    const revokeFixture = await createInvitation("accept-revoke");
    const [acceptedOrRevoked, revokedOrConflict] = await Promise.all([
      request(application()).post(`/api/admin/invitations/${revokeFixture.id}/local-accept`).set(as(admin.email)).send({ expectedGeneration: revokeFixture.resendGeneration }),
      request(application()).post(`/api/admin/invitations/${revokeFixture.id}/revoke`).set(as(admin.email)).send({ operationId: randomUUID(), expectedVersion: revokeFixture.version, reason: "Concurrent invitation revoke" }),
    ]);
    expect([[200, 409], [410, 200]]).toContainEqual([acceptedOrRevoked.status, revokedOrConflict.status]);

    const duplicateFixture = await createInvitation("double-accept");
    const accept = () => request(application()).post(`/api/admin/invitations/${duplicateFixture.id}/local-accept`).set(as(admin.email)).send({ expectedGeneration: duplicateFixture.resendGeneration });
    const accepts = await Promise.all([accept(), accept()]);
    expect(accepts.map(({ status }) => status).sort()).toEqual([200, 410]);
    expect(await prisma!.externalIdentity.count({ where: { userId: duplicateFixture.user.id } })).toBe(1);
  });

  it("binds one stable Entra identity to exactly one of two concurrent eligible Users", async () => {
    const first = await createUser("identity-owner-a");
    const second = await createUser("identity-owner-b");
    const stable = { issuer: `https://login.example/${marker}/shared`, subject: `${marker}-shared`, tenantId: `${marker}-shared-tenant`, objectId: `${marker}-shared-object` };
    const service = new IdentityAuthService(prisma!);
    const projections = await Promise.all([service.authenticateEntra({ ...stable, email: first.email }), service.authenticateEntra({ ...stable, email: second.email })]);
    expect(new Set(projections.map(({ id }) => id)).size).toBe(1);
    expect([first.id, second.id]).toContain(projections[0]!.id);
    expect(await prisma!.externalIdentity.count({ where: { tenantId: stable.tenantId, directoryObjectId: stable.objectId } })).toBe(1);
  });

  it("keeps concurrent suspend/archive and authentication linearizable on the next request", async () => {
    const suspendUser = await createUser("auth-suspend-race");
    const suspendResults = await Promise.allSettled([
      new IdentityAuthService(prisma!).authenticateDevelopmentEmail(suspendUser.email),
      request(application()).post(`/api/admin/users/${suspendUser.id}/suspend`).set(as(admin.email)).send({ expectedVersion: suspendUser.version, reason: "Concurrent auth suspension" }),
    ]);
    expect(suspendResults[1].status === "fulfilled" && suspendResults[1].value.status).toBe(200);
    await expect(new IdentityAuthService(prisma!).authenticateDevelopmentEmail(suspendUser.email)).rejects.toMatchObject({ status: 401 });

    const archiveUser = await createUser("auth-archive-race");
    await Promise.allSettled([
      new IdentityAuthService(prisma!).authenticateDevelopmentEmail(archiveUser.email),
      request(application()).post(`/api/admin/users/${archiveUser.id}/archive`).set(as(admin.email)).send({ expectedVersion: archiveUser.version, reason: "Concurrent auth archive" }),
    ]);
    expect((await prisma!.user.findUniqueOrThrow({ where: { id: archiveUser.id } })).status).toBe("Archived");
    await expect(new IdentityAuthService(prisma!).authenticateDevelopmentEmail(archiveUser.email)).rejects.toMatchObject({ status: 401 });
  });

  it("serializes the combined last-admin race so exactly one removal wins", async () => {
    const seeded = await prisma!.user.findUniqueOrThrow({ where: { id: admin.id } });
    const second = await prisma!.user.findUniqueOrThrow({ where: { id: testAdmin.id } });
    const [removeSeeded, removeSecond] = await Promise.all([
      request(application()).post(`/api/admin/users/${admin.id}/suspend`).set(as(testAdmin.email)).send({ expectedVersion: seeded.version, reason: "Concurrent last-admin test A" }),
      request(application()).post(`/api/admin/users/${testAdmin.id}/suspend`).set(as(admin.email)).send({ expectedVersion: second.version, reason: "Concurrent last-admin test B" }),
    ]);
    expect([removeSeeded.status, removeSecond.status].sort()).toEqual([200, 409]);
    const currentSeed = await prisma!.user.findUniqueOrThrow({ where: { id: admin.id } });
    const currentSecond = await prisma!.user.findUniqueOrThrow({ where: { id: testAdmin.id } });
    expect([currentSeed.status, currentSecond.status].filter((status) => status === "Active")).toHaveLength(1);
    if (currentSeed.status !== "Active") await prisma!.user.update({ where: { id: currentSeed.id }, data: { status: "Active", version: { increment: 1 }, suspensionReason: null } });
    if (currentSecond.status !== "Active") await prisma!.user.update({ where: { id: currentSecond.id }, data: { status: "Active", version: { increment: 1 }, suspensionReason: null } });
  });

  it("protects the last admin across suspend-vs-role-revoke and archive-vs-suspend combinations", async () => {
    const startedAt = new Date();
    const restoreAdmins = async () => {
      await prisma!.user.updateMany({ where: { id: { in: [admin.id, testAdmin.id] } }, data: { status: "Active", suspensionReason: null, archiveReason: null, archivedAt: null } });
      for (const userId of [admin.id, testAdmin.id]) await prisma!.userRole.upsert({ where: { userId_roleId: { userId, roleId: systemAdminRoleId } }, update: { scopeType: "GLOBAL" }, create: { userId, roleId: systemAdminRoleId, assignedBy: admin.id } });
    };
    await restoreAdmins();
    const seedAssignment = await prisma!.userRole.findUniqueOrThrow({ where: { userId_roleId: { userId: admin.id, roleId: systemAdminRoleId } } });
    const secondBefore = await prisma!.user.findUniqueOrThrow({ where: { id: testAdmin.id } });
    const suspendVsRevoke = await Promise.all([
      request(application()).post(`/api/admin/users/${testAdmin.id}/suspend`).set(as(admin.email)).send({ expectedVersion: secondBefore.version, reason: "Combined last-admin suspend" }),
      request(application()).post(`/api/admin/users/${admin.id}/role-assignments/${seedAssignment.id}/revoke`).set(as(testAdmin.email)).send({ reason: "Combined last-admin revoke" }),
    ]);
    expect(suspendVsRevoke.map(({ status }) => status).sort()).toEqual([200, 409]);

    await restoreAdmins();
    const seedBefore = await prisma!.user.findUniqueOrThrow({ where: { id: admin.id } });
    const secondAgain = await prisma!.user.findUniqueOrThrow({ where: { id: testAdmin.id } });
    const archiveVsSuspend = await Promise.all([
      request(application()).post(`/api/admin/users/${testAdmin.id}/archive`).set(as(admin.email)).send({ expectedVersion: secondAgain.version, reason: "Combined last-admin archive" }),
      request(application()).post(`/api/admin/users/${admin.id}/suspend`).set(as(testAdmin.email)).send({ expectedVersion: seedBefore.version, reason: "Combined last-admin suspend other" }),
    ]);
    expect(archiveVsSuspend.map(({ status }) => status).sort()).toEqual([200, 409]);
    await restoreAdmins();
    await prisma!.notification.deleteMany({ where: { recipientUserId: { in: [admin.id, testAdmin.id] }, createdAt: { gte: startedAt } } });
    await prisma!.notificationOutbox.deleteMany({ where: { recipientUserId: { in: [admin.id, testAdmin.id] }, createdAt: { gte: startedAt } } });
    await prisma!.auditLog.deleteMany({ where: { createdAt: { gte: startedAt }, entityId: { in: [admin.id, testAdmin.id] } } });
    await prisma!.roleAssignmentHistory.deleteMany({ where: { occurredAt: { gte: startedAt }, userId: { in: [admin.id, testAdmin.id] } } });
  });

  it("blocks self elevation, prohibited custom admin roles and protected role archive", async () => {
    const user = await createUser("no-self-elevation");
    const self = await request(application()).post(`/api/admin/users/${admin.id}/role-assignments`).set(as(admin.email)).send({ roleName: "system-admin", scopeType: "GLOBAL" });
    expect(self.status).toBe(403);
    const custom = await request(application()).post("/api/admin/roles").set(as(admin.email)).send({ name: `${marker}-admin-role`, displayName: `${marker} admin role`, permissions: ["admin:manage"] });
    expect(custom.status).toBe(403);
    const protectedArchive = await request(application()).post(`/api/admin/roles/${systemAdminRoleId}/archive`).set(as(admin.email)).send({ expectedVersion: 1 });
    expect(protectedArchive.status).toBe(409);
    expect(user.id).toBeTruthy();
  });

  it("allows exactly one concurrent duplicate role assignment", async () => {
    const user = await createUser("assignment-race");
    const role = await createRole("assignment-race", ["reports:read"]);
    const assign = () => request(application()).post(`/api/admin/users/${user.id}/role-assignments`).set(as(admin.email)).send({ roleName: role.name, scopeType: "GLOBAL" });
    const attempts = await Promise.all([assign(), assign()]);
    expect(attempts.map(({ status }) => status).sort()).toEqual([201, 409]);
    expect(await prisma!.userRole.count({ where: { userId: user.id, roleId: role.id } })).toBe(1);
    expect(await prisma!.roleAssignmentHistory.count({ where: { userId: user.id, roleId: role.id, action: "ASSIGNED" } })).toBe(1);
  });

  it("serializes role archive against assignment so an archived role cannot retain a new active assignment", async () => {
    const user = await createUser("archive-assignment-race");
    const role = await createRole("archive-assignment-race", ["reports:read"]);
    const [assignment, archive] = await Promise.all([
      request(application()).post(`/api/admin/users/${user.id}/role-assignments`).set(as(admin.email)).send({ roleName: role.name, scopeType: "GLOBAL" }),
      request(application()).post(`/api/admin/roles/${role.id}/archive`).set(as(admin.email)).send({ expectedVersion: role.version }),
    ]);
    expect([[201, 409], [400, 200]]).toContainEqual([assignment.status, archive.status]);
    const durableRole = await prisma!.role.findUniqueOrThrow({ where: { id: role.id } });
    const activeAssignments = await prisma!.userRole.count({ where: { roleId: role.id } });
    expect(durableRole.status === "Archived" ? activeAssignments === 0 : durableRole.status === "Active" && activeAssignments === 1).toBeTruthy();
  });

  it("serializes role revoke with User archive without leaving live access on an archived account", async () => {
    const user = await createUser("revoke-archive-race");
    const role = await createRole("revoke-archive-race", ["reports:read"]);
    const assigned = await request(application()).post(`/api/admin/users/${user.id}/role-assignments`).set(as(admin.email)).send({ roleName: role.name, scopeType: "GLOBAL" });
    expect(assigned.status).toBe(201);
    const current = await prisma!.user.findUniqueOrThrow({ where: { id: user.id } });
    const [revoked, archived] = await Promise.all([
      request(application()).post(`/api/admin/users/${user.id}/role-assignments/${assigned.body.id}/revoke`).set(as(admin.email)).send({ reason: "Concurrent archive revoke" }),
      request(application()).post(`/api/admin/users/${user.id}/archive`).set(as(admin.email)).send({ expectedVersion: current.version, reason: "Concurrent role revoke" }),
    ]);
    expect(revoked.status).toBe(200);
    expect([200, 409]).toContain(archived.status);
    expect((await prisma!.user.findUniqueOrThrow({ where: { id: user.id } })).status).toBe(archived.status === 200 ? "Archived" : "Active");
    expect(await prisma!.userRole.count({ where: { userId: user.id, roleId: role.id } })).toBe(0);
  });

  it("keeps group assignment, Group archive and IncidentAssignment revocation scope-safe under concurrency", async () => {
    const user = await createUser("group-concurrency");
    const role = await createRole("group-concurrency", ["passenger:read"], ["GROUP"]);
    const incident = await prisma!.session.create({ data: { operationalId: `${marker}-GROUP-RACE`, mode: "EXERCISE", status: "Active", eventType: marker, createdById: admin.id } });
    incidentIds.push(incident.id);
    const group = await prisma!.operationalGroup.create({ data: { id: `${markerEmail}-group-race`, operationalId: `${marker}-GROUP-RACE`, incidentId: incident.id, name: `${marker} group race`, pool: "ZPP", functionName: "Family assistance", createdById: admin.id, updatedById: admin.id } });
    groupIds.push(group.id);
    const [assigned, archived] = await Promise.all([
      request(application()).post(`/api/admin/users/${user.id}/role-assignments`).set(as(admin.email)).send({ roleName: role.name, scopeType: "GROUP", scopeId: group.id }),
      request(application()).post(`/api/groups/${group.id}/archive`).set(as(admin.email)).send({ sessionId: incident.id, expectedVersion: group.version }),
    ]);
    expect([200, 409]).toContain(archived.status);
    expect([201, 400, 409]).toContain(assigned.status);
    const activeGroupRoles = await prisma!.groupRoleAssignment.count({ where: { groupId: group.id, status: "Active" } });
    const durableGroupStatus = (await prisma!.operationalGroup.findUniqueOrThrow({ where: { id: group.id } })).status;
    const raceEvidence = JSON.stringify({ assigned: { status: assigned.status, body: assigned.body }, archived: { status: archived.status, body: archived.body }, activeGroupRoles, durableGroupStatus });
    expect(activeGroupRoles, raceEvidence).toBe(archived.status === 200 ? 0 : 1);
    expect(durableGroupStatus, raceEvidence).toBe(archived.status === 200 ? "Archived" : "Active");

    const liveGroup = await prisma!.operationalGroup.create({ data: { id: `${markerEmail}-group-access-race`, operationalId: `${marker}-GROUP-ACCESS`, incidentId: incident.id, name: `${marker} group access`, pool: "ZPP", functionName: "Family assistance", createdById: admin.id, updatedById: admin.id } });
    groupIds.push(liveGroup.id);
    await prisma!.userRole.upsert({ where: { userId_roleId: { userId: user.id, roleId: role.id } }, update: { scopeType: "GROUP" }, create: { userId: user.id, roleId: role.id, scopeType: "GROUP", assignedBy: admin.id } });
    await prisma!.groupRoleAssignment.create({ data: { id: randomUUID(), userId: user.id, roleId: role.id, groupId: liveGroup.id, assignedBy: admin.id } });
    const incidentAssignment = await prisma!.incidentAssignment.create({ data: { incidentId: incident.id, userId: user.id, function: marker, createdById: admin.id } });
    await Promise.all([new EffectiveAccessService(prisma!).forUser(user.id), prisma!.incidentAssignment.update({ where: { id: incidentAssignment.id }, data: { active: false, revokedAt: new Date(), revokedById: admin.id, revokeReason: "Concurrent access revoke" } })]);
    expect((await new EffectiveAccessService(prisma!).forUser(user.id))!.permissions).not.toContain("passenger:read");
  });

  it("makes custom Role and PermissionOverride races visible on the next authorization read", async () => {
    const user = await createUser("role-override-race");
    const role = await createRole("role-update-auth", ["reports:read"]);
    await prisma!.userRole.create({ data: { userId: user.id, roleId: role.id, assignedBy: admin.id } });
    await Promise.all([
      new IdentityAuthService(prisma!).authenticateDevelopmentEmail(user.email),
      request(application()).patch(`/api/admin/roles/${role.id}`).set(as(admin.email)).send({ expectedVersion: role.version, permissions: ["session:read"] }),
    ]);
    expect((await new IdentityAuthService(prisma!).authenticateDevelopmentEmail(user.email)).permissions).not.toContain("reports:read");

    const existing = await request(application()).post(`/api/admin/users/${user.id}/capability-overrides`).set(as(admin.email)).send({ permission: "reports:read", effect: "GRANT", reason: "Initial override race fixture" });
    expect(existing.status).toBe(201);
    const [revoked, recreated] = await Promise.all([
      request(application()).post(`/api/admin/users/${user.id}/capability-overrides/${existing.body.id}/revoke`).set(as(admin.email)).send({ expectedVersion: existing.body.version, reason: "Concurrent override revoke" }),
      request(application()).post(`/api/admin/users/${user.id}/capability-overrides`).set(as(admin.email)).send({ permission: "reports:read", effect: "GRANT", reason: "Concurrent override create" }),
    ]);
    expect(revoked.status).toBe(200);
    expect([201, 409]).toContain(recreated.status);
    expect(await prisma!.permissionOverride.count({ where: { userId: user.id, permission: "reports:read", effect: "GRANT", active: true } })).toBe(recreated.status === 201 ? 1 : 0);

    const boundary = await prisma!.permissionOverride.create({ data: { userId: user.id, permission: "training:read-own", effect: "GRANT", reason: "Expiry boundary", expiresAt: new Date(Date.now() + 20), createdById: admin.id } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await new EffectiveAccessService(prisma!).forUser(user.id))!.permissions).not.toContain("training:read-own");
    await prisma!.permissionOverride.update({ where: { id: boundary.id }, data: { active: false, revokedAt: new Date() } });
  });

  it("keeps MemberProfile linking one-to-one and does not grant access", async () => {
    const user = await createUser("member-link");
    const memberId = `${markerEmail}-member`;
    memberIds.push(memberId);
    await prisma!.memberProfile.create({ data: { id: memberId, memberId: `${marker}-MEMBER`, firstName: "Stage", lastName: "Fourteen", pool: "ZPP", role: "Member", assignedFunction: marker, languages: ["PL"], createdById: admin.id, updatedById: admin.id } });
    const linked = await request(application()).post(`/api/admin/users/${user.id}/member-link`).set(as(admin.email)).send({ memberProfileId: memberId });
    expect(linked.status).toBe(200);
    expect((await new EffectiveAccessService(prisma!).forUser(user.id))!.permissions).toEqual([]);
    const other = await createUser("member-link-other");
    expect((await request(application()).post(`/api/admin/users/${other.id}/member-link`).set(as(admin.email)).send({ memberProfileId: memberId })).status).toBe(409);
  });

  it("allows only one concurrent User to acquire the same MemberProfile link", async () => {
    const first = await createUser("member-race-a");
    const second = await createUser("member-race-b");
    const memberId = `${markerEmail}-member-race`;
    memberIds.push(memberId);
    await prisma!.memberProfile.create({ data: { id: memberId, memberId: `${marker}-MEMBER-RACE`, firstName: "Member", lastName: "Race", pool: "ZPP", role: "Member", assignedFunction: marker, languages: ["PL"], createdById: admin.id, updatedById: admin.id } });
    const links = await Promise.all([
      request(application()).post(`/api/admin/users/${first.id}/member-link`).set(as(admin.email)).send({ memberProfileId: memberId }),
      request(application()).post(`/api/admin/users/${second.id}/member-link`).set(as(admin.email)).send({ memberProfileId: memberId }),
    ]);
    expect(links.map(({ status }) => status).sort()).toEqual([200, 409]);
    expect([first.id, second.id]).toContain((await prisma!.memberProfile.findUniqueOrThrow({ where: { id: memberId } })).linkedUserId);
  });

  it("commits access state independently while concurrent outbox dispatch remains durable", async () => {
    const user = await createUser("access-outbox-race");
    const role = await createRole("access-outbox-race", ["reports:read"]);
    const assigned = await request(application()).post(`/api/admin/users/${user.id}/role-assignments`).set(as(admin.email)).send({ roleName: role.name, scopeType: "GLOBAL" });
    expect(assigned.status).toBe(201);
    const current = await prisma!.user.findUniqueOrThrow({ where: { id: user.id } });
    const dispatcher = createNotificationDispatcher(prisma!, createPrismaNotificationRepository(prisma!), { workerId: `${marker}-access-race`, batchSize: 200 });
    await Promise.all([
      request(application()).post(`/api/admin/users/${user.id}/suspend`).set(as(admin.email)).send({ expectedVersion: current.version, reason: "Concurrent outbox dispatch" }),
      dispatcher.runOnce(),
    ]);
    await dispatcher.runOnce();
    expect((await prisma!.user.findUniqueOrThrow({ where: { id: user.id } })).status).toBe("Suspended");
    expect(await prisma!.notificationOutbox.count({ where: { recipientUserId: user.id, status: { not: "DELIVERED" } } })).toBe(0);
  });

  it("persists organization CRUD lifecycle with version checks and no hard delete", async () => {
    const key = `${markerEmail}-organization`;
    const created = await request(application()).post("/api/admin/organizations").set(as(admin.email)).send({ key, name: `${marker} organization` });
    expect(created.status).toBe(201);
    const updated = await request(application()).patch(`/api/admin/organizations/${created.body.id}`).set(as(admin.email)).send({ expectedVersion: created.body.version, description: "Stage 14 durable organization" });
    expect(updated.status).toBe(200);
    const archived = await request(application()).post(`/api/admin/organizations/${created.body.id}/archive`).set(as(admin.email)).send({ expectedVersion: updated.body.version, reason: "Stage 14 lifecycle test" });
    expect(archived.body).toMatchObject({ status: "Archived", version: updated.body.version + 1 });
    const staleRestore = await request(application()).post(`/api/admin/organizations/${created.body.id}/restore`).set(as(admin.email)).send({ expectedVersion: updated.body.version });
    expect(staleRestore.status).toBe(409);
    const restored = await request(application()).post(`/api/admin/organizations/${created.body.id}/restore`).set(as(admin.email)).send({ expectedVersion: archived.body.version });
    expect(restored.body).toMatchObject({ status: "Active", version: archived.body.version + 1, archivedAt: null });
  });

  it("pages and searches durable Admin users without returning an unbounded collection", async () => {
    const bulk = Array.from({ length: 225 }, (_, index) => ({ email: `${markerEmail}-scale-${index}@example.test`, displayName: `${marker} scale ${String(index).padStart(3, "0")}`, status: "Active", authenticationPolicy: "SSO_ONLY" }));
    await prisma!.user.createMany({ data: bulk });
    const rows = await prisma!.user.findMany({ where: { normalizedEmail: { startsWith: `${markerEmail}-scale-` } }, select: { id: true } });
    userIds.push(...rows.map(({ id }) => id));
    const response = await request(application()).get("/api/admin/users").query({ search: `${marker} scale`, limit: 75, offset: 150 }).set(as(admin.email));
    expect(response.body).toMatchObject({ total: 225, limit: 75, offset: 150 });
    expect(response.body.data).toHaveLength(75);
  });

  it("forbids production development auth configuration", () => {
    const invalid = resolveConfig({ NODE_ENV: "production", AUTH_MODE: "dev", PERSISTENCE_MODE: "postgres", DATABASE_URL: databaseUrl });
    expect(() => validateRuntimeConfig(invalid)).toThrow(/AUTH_MODE=dev is forbidden/);
  });

  it("rejects otherwise valid Entra JWTs with the wrong issuer or audience", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    const keySet = createLocalJWKSet({ keys: [{ ...jwk, kid: `${marker}-kid`, alg: "RS256", use: "sig" }] });
    const token = await new SignJWT({ tid: `${marker}-tenant`, oid: `${marker}-object` })
      .setProtectedHeader({ alg: "RS256", kid: `${marker}-kid` })
      .setSubject(`${marker}-subject`)
      .setIssuer(`https://issuer.example/${marker}`)
      .setAudience(`${marker}-audience`)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    await expect(validateEntraJwt(token, keySet, "https://issuer.example/wrong", `${marker}-audience`)).rejects.toThrow();
    await expect(validateEntraJwt(token, keySet, `https://issuer.example/${marker}`, `${marker}-wrong-audience`)).rejects.toThrow();
    await expect(validateEntraJwt(token, keySet, `https://issuer.example/${marker}`, `${marker}-audience`)).resolves.toBeTruthy();
  });
});
