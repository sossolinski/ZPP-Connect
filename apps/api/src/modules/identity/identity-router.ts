import { createHash, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { Router, type Request } from "express";
import { authenticationPolicies, defaultRoles, normalizeRoleName, permissions, type Permission } from "@zpp/shared";
import { authenticate } from "../../auth.js";
import { config } from "../../config.js";
import { asyncHandler, HttpError } from "../../errors.js";
import { requirePermission } from "../../rbac.js";
import { EffectiveAccessService } from "./effective-access-service.js";
import { createDevelopmentSession, revokeDevelopmentSession } from "./development-session-store.js";

type Tx = Prisma.TransactionClient;
const invitationTtlMs = 7 * 24 * 60 * 60 * 1000;
const blockedInviteKeys = new Set(["password", "passwordHash", "temporaryPassword", "token", "rawToken", "clientSecret", "permissions", "capabilities", "grants", "denies"]);

function text(value: unknown) { return String(value ?? "").trim(); }
function lower(value: unknown) { return text(value).toLowerCase(); }
function integer(value: unknown, fallback: number) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback; }
function page(req: Request) { return { limit: Math.min(Math.max(integer(req.query.limit, 50), 1), 200), offset: Math.max(integer(req.query.offset, 0), 0) }; }
function reason(value: unknown) { const result = text(value); if (result.length < 3) throw new HttpError(400, "A reason is required."); return result; }
function expectedVersion(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined; }
function assertVersion(current: number, value: unknown) { const expected = expectedVersion(value); if (expected !== undefined && expected !== current) throw new HttpError(409, "This record changed while you were reviewing it. Refresh and try again."); }
function forbiddenInvitePayload(value: unknown): boolean { return Boolean(value && typeof value === "object" && Object.entries(value as Record<string, unknown>).some(([key, nested]) => blockedInviteKeys.has(key) || forbiddenInvitePayload(nested))); }
function tokenHash() { return createHash("sha256").update(randomUUID()).digest("hex"); }
function actor(req: Request) { if (!req.user) throw new HttpError(401, "Authentication required"); return req.user; }
function param(req: Request, key: string) { return text(req.params[key]); }
function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => key !== "operationId").sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, canonicalJson(nested)]));
  return value;
}

async function beginOperation(tx: Tx, req: Request, command: string, logicalRequest: unknown) {
  const operationId = text(req.body?.operationId);
  if (!operationId) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) throw new HttpError(400, "operationId must be a UUID.");
  const fingerprint = createHash("sha256").update(JSON.stringify({ command, request: canonicalJson(logicalRequest) })).digest("hex");
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`identity-operation:${operationId}`}))`;
  const existing = await tx.identityOperation.findUnique({ where: { operationId } });
  if (existing && (existing.command !== command || existing.commandFingerprint !== fingerprint)) throw new HttpError(409, "operationId was already used for another identity command.");
  return { operationId, command, fingerprint, existing };
}

async function completeOperation(tx: Tx, operation: NonNullable<Awaited<ReturnType<typeof beginOperation>>>, values: { targetUserId?: string | null; resultEntityType: string; resultEntityId: string; resultVersion: number }, req: Request) {
  await tx.identityOperation.create({ data: { operationId: operation.operationId, command: operation.command, commandFingerprint: operation.fingerprint, targetUserId: values.targetUserId ?? null, resultEntityType: values.resultEntityType, resultEntityId: values.resultEntityId, resultVersion: values.resultVersion, requestId: req.requestId } });
}

async function audit(tx: Tx, req: Request, action: string, entityType: string, entityId: string, summary: string, metadata: Record<string, unknown>) {
  const current = actor(req);
  await tx.auditLog.create({ data: { action, entityType, entityId, sessionId: null, actorId: current.id, actorEmail: current.email, summary, metadata: metadata as Prisma.InputJsonObject, ipAddress: req.ip, userAgent: req.header("user-agent") } });
}

async function accessOutbox(tx: Tx, userId: string, sourceId: string, version: number, title: string, message: string) {
  await tx.notificationOutbox.create({ data: {
    eventType: "ACCESS_CHANGED", aggregateType: "userAccess", aggregateId: sourceId,
    aggregateVersion: String(version), recipientUserId: userId, sessionId: null,
    payload: { title, message, occurredAt: new Date().toISOString() }
  } });
}

async function lockAdminInvariant(tx: Tx) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('identity:last-system-admin'))`;
}

async function lockUser(tx: Tx, userId: string) {
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId}::uuid FOR UPDATE`;
}

async function lockInvitation(tx: Tx, invitationId: string) {
  await tx.$queryRaw`SELECT "id" FROM "UserInvitation" WHERE "id" = ${invitationId}::uuid FOR UPDATE`;
}

async function activeAdminCount(tx: Tx, excludedUserId?: string) {
  return tx.user.count({ where: {
    status: "Active",
    ...(excludedUserId ? { id: { not: excludedUserId } } : {}),
    roles: { some: { scopeType: "GLOBAL", role: { normalizedName: "system-admin", status: "Active", protected: true } } },
    NOT: { permissionOverrides: { some: { permission: "admin:manage", effect: "DENY", active: true, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } } }
  } });
}

const userInclude = {
  organization: true,
  roles: { include: { role: true } },
  groupRoleAssignments: { include: { role: true, group: true } },
  permissionOverrides: true,
  externalIdentities: true,
  invitations: { orderBy: { createdAt: "desc" as const }, take: 1 },
  linkedMemberProfiles: true
} satisfies Prisma.UserInclude;

type UserDetail = Prisma.UserGetPayload<{ include: typeof userInclude }>;

function invitationStatus(invitation: { status: string; tokenExpiresAt: Date }) {
  return ["Prepared", "Sent"].includes(invitation.status) && invitation.tokenExpiresAt <= new Date() ? "Expired" : invitation.status;
}

function assignmentRows(user: UserDetail) {
  const globalRows = user.roles.filter((item) => item.scopeType !== "GROUP").map((item) => ({
    id: item.id, userId: user.id, roleName: item.role.name, roleDisplayName: item.role.displayName,
    scopeType: "GLOBAL", scopeId: null, scopeLabel: "Global", group: null, status: "Active",
    assignedAt: item.assignedAt.toISOString(), assignedByUserId: item.assignedBy, version: 1
  }));
  const groupRows = user.groupRoleAssignments.filter((item) => item.status === "Active").map((item) => ({
    id: item.id, userId: user.id, roleName: item.role.name, roleDisplayName: item.role.displayName,
    scopeType: "GROUP", scopeId: item.groupId, scopeLabel: item.group.name,
    group: { id: item.group.id, operationalId: item.group.operationalId, name: item.group.name, pool: item.group.pool, status: item.group.status },
    status: item.status, assignedAt: item.assignedAt.toISOString(), assignedByUserId: item.assignedBy, version: item.version
  }));
  return [...globalRows, ...groupRows];
}

async function userResponse(db: PrismaClient | Tx, user: UserDetail) {
  const projection = user.status === "Active" ? await new EffectiveAccessService(db).forUser(user.id) : null;
  const invitation = user.invitations[0];
  const derivedInvitation = invitation ? {
    id: invitation.id, status: invitationStatus(invitation), intendedAuthenticationPolicy: invitation.intendedAuthenticationPolicy,
    createdAt: invitation.createdAt.toISOString(), sentAt: invitation.sentAt?.toISOString() ?? null,
    acceptedAt: invitation.acceptedAt?.toISOString() ?? null, revokedAt: invitation.revokedAt?.toISOString() ?? null,
    tokenExpiresAt: invitation.tokenExpiresAt.toISOString(), resendGeneration: invitation.resendGeneration,
    hasActiveToken: ["Prepared", "Sent"].includes(invitationStatus(invitation))
  } : null;
  const member = user.linkedMemberProfiles[0];
  return {
    id: user.id, email: user.email, primaryEmail: user.email, displayName: user.displayName, employeeId: user.employeeId,
    department: user.department, organization: user.organization, organizationId: user.organizationId, status: user.status,
    authenticationPolicy: user.authenticationPolicy, version: user.version,
    createdAt: user.createdAt.toISOString(), updatedAt: user.updatedAt.toISOString(), activatedAt: user.activatedAt?.toISOString() ?? null,
    suspendedAt: user.suspendedAt?.toISOString() ?? null, archivedAt: user.archivedAt?.toISOString() ?? null, restoredAt: user.restoredAt?.toISOString() ?? null,
    lastSuccessfulSignInAt: user.lastSuccessfulSignInAt?.toISOString() ?? null,
    roles: projection?.roles ?? [], roleLabels: projection?.roles ?? [], roleAssignments: assignmentRows(user),
    deniedPermissions: user.permissionOverrides.filter((item) => item.active && item.effect === "DENY").map((item) => item.permission),
    grantCount: user.permissionOverrides.filter((item) => item.active && item.effect === "GRANT").length,
    denyCount: user.permissionOverrides.filter((item) => item.active && item.effect === "DENY").length,
    permissionCount: projection?.permissions.length ?? 0,
    invitation: derivedInvitation, invitationStatus: derivedInvitation?.status ?? "None",
    linkedMemberProfileId: member?.id ?? null,
    linkedMemberProfile: member ? { id: member.id, memberId: member.memberId, displayName: `${member.firstName} ${member.lastName}`, pool: member.pool, status: member.status } : null,
    externalIdentityCount: user.externalIdentities.length
  };
}

async function detailedUser(db: PrismaClient | Tx, id: string) {
  const user = await db.user.findUnique({ where: { id }, include: userInclude });
  if (!user) throw new HttpError(404, "User not found");
  return user;
}

function roleResponse(role: Prisma.RoleGetPayload<{ include: { users: true; groupAssignments: true } }>) {
  return { ...role, assignedUserCount: new Set([...role.users.map((item) => item.userId), ...role.groupAssignments.filter((item) => item.status === "Active").map((item) => item.userId)]).size, capabilityCount: Array.isArray(role.permissions) ? role.permissions.length : 0 };
}

export function createIdentityRouter(db: PrismaClient) {
  const router = Router();

  router.get("/auth/config", (_req, res) => res.json({ developmentAccessEnabled: config.authMode === "dev" && config.nodeEnv !== "production", authenticationMethods: config.authMode === "entra" ? ["MICROSOFT_SSO"] : ["DEVELOPMENT"] }));
  const discoverAuthentication = asyncHandler(async (req, res) => {
    const email = lower(req.body?.identifier ?? req.body?.email);
    const user = email ? await db.user.findUnique({ where: { normalizedEmail: email }, select: { status: true, authenticationPolicy: true } }) : null;
    res.json({ accountEligible: Boolean(user && ["Pending", "Active"].includes(user.status)), authenticationPolicy: user?.authenticationPolicy, permittedMethods: user && config.authMode === "entra" ? ["MICROSOFT_SSO"] : [], message: "Continue with an available organization sign-in method." });
  });
  router.post("/auth/discovery", discoverAuthentication);
  router.post("/auth/discover", discoverAuthentication);
  router.get("/auth/development/users", asyncHandler(async (_req, res) => {
    if (config.authMode !== "dev" || config.nodeEnv === "production") throw new HttpError(404, "Development authentication is not available.");
    const users = await db.user.findMany({ where: { status: "Active" }, orderBy: [{ displayName: "asc" }, { id: "asc" }], take: 200 });
    res.json({ total: users.length, data: users.map((user) => ({ userId: user.id, displayName: user.displayName, email: user.email, authenticationPolicy: user.authenticationPolicy, permittedMethods: ["MICROSOFT_SSO"] })) });
  }));
  router.post("/auth/development/login", asyncHandler(async (req, res) => {
    if (config.authMode !== "dev" || config.nodeEnv === "production") throw new HttpError(404, "Development authentication is not available.");
    const user = await db.user.findUnique({ where: { id: text(req.body?.userId) } });
    if (!user || user.status !== "Active") throw new HttpError(401, "We could not continue with that sign-in.");
    const projection = await new EffectiveAccessService(db).forUser(user.id);
    if (!projection) throw new HttpError(401, "We could not continue with that sign-in.");
    const session = createDevelopmentSession(user.id, "LOCAL_DEV_SSO");
    res.json({ session, user: projection });
  }));
  router.post("/auth/logout", (req, res) => { const token = req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim(); if (token) revokeDevelopmentSession(token); res.status(204).send(); });

  router.get("/auth/me", authenticate, (req, res) => res.json({ user: req.user }));
  router.use("/admin", authenticate, requirePermission("admin:manage"));

  router.get("/admin/users", asyncHandler(async (req, res) => {
    const { limit, offset } = page(req); const search = text(req.query.search ?? req.query.q); const status = text(req.query.status); const role = normalizeRoleName(text(req.query.role));
    const where: Prisma.UserWhereInput = {
      ...(status ? { status } : {}),
      ...(role ? { OR: [{ roles: { some: { role: { normalizedName: role } } } }, { groupRoleAssignments: { some: { status: "Active", role: { normalizedName: role } } } }] } : {}),
      ...(search ? { OR: [{ displayName: { contains: search, mode: "insensitive" } }, { normalizedEmail: { contains: search.toLowerCase() } }, { employeeId: { contains: search, mode: "insensitive" } }, { department: { contains: search, mode: "insensitive" } }] } : {})
    };
    const [total, users] = await db.$transaction([db.user.count({ where }), db.user.findMany({ where, include: userInclude, orderBy: [{ displayName: "asc" }, { id: "asc" }], take: limit, skip: offset })]);
    res.json({ total, limit, offset, data: await Promise.all(users.map((user) => userResponse(db, user))) });
  }));

  router.post("/admin/users", asyncHandler(async (req, res) => {
    const email = lower(req.body?.email ?? req.body?.loginEmail); const displayName = text(req.body?.displayName);
    if (!email || !displayName) throw new HttpError(400, "Name and email are required.");
    const created = await db.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { email, normalizedEmail: email, displayName, employeeId: text(req.body?.employeeId) || null, department: text(req.body?.department) || null, organizationId: text(req.body?.organizationId) || null, status: "Pending", authenticationPolicy: "SSO_ONLY", createdById: actor(req).id, updatedById: actor(req).id } });
      await audit(tx, req, "user_created", "userAccount", user.id, "User account created", { targetUserId: user.id });
      return detailedUser(tx, user.id);
    });
    res.status(201).json(await userResponse(db, created));
  }));

  router.get("/admin/users/:userId", asyncHandler(async (req, res) => res.json(await userResponse(db, await detailedUser(db, param(req, "userId"))))));
  router.patch("/admin/users/:userId", asyncHandler(async (req, res) => {
    if (req.body?.status !== undefined || req.body?.authenticationPolicy !== undefined) throw new HttpError(400, "Use the dedicated account action.");
    const result = await db.$transaction(async (tx) => {
      await lockUser(tx, param(req, "userId"));
      const current = await detailedUser(tx, param(req, "userId")); assertVersion(current.version, req.body?.expectedVersion);
      const email = lower(req.body?.email ?? current.email);
      const updated = await tx.user.update({ where: { id: current.id }, data: { email, normalizedEmail: email, displayName: text(req.body?.displayName) || current.displayName, employeeId: req.body?.employeeId === undefined ? current.employeeId : text(req.body.employeeId) || null, department: req.body?.department === undefined ? current.department : text(req.body.department) || null, updatedById: actor(req).id, version: { increment: 1 } } });
      await audit(tx, req, "user_metadata_changed", "userAccount", current.id, "User account updated", { targetUserId: current.id, previous: { email: current.email, displayName: current.displayName, employeeId: current.employeeId, department: current.department }, next: { email: updated.email, displayName: updated.displayName, employeeId: updated.employeeId, department: updated.department } });
      return detailedUser(tx, current.id);
    });
    res.json(await userResponse(db, result));
  }));

  router.get("/admin/users/:userId/lifecycle-impact", asyncHandler(async (req, res) => {
    const user = await detailedUser(db, param(req, "userId"));
    const [incidents, groups, assignments, requests, memberProfiles] = await Promise.all([db.incidentAssignment.count({ where: { userId: user.id, active: true } }), db.groupRoleAssignment.count({ where: { userId: user.id, status: "Active" } }), db.assignmentTask.count({ where: { assignedUserId: user.id, status: { notIn: ["Completed", "Cancelled"] } } }), db.request.count({ where: { ownerUserId: user.id, status: { notIn: ["RESOLVED", "CANCELLED"] } } }), db.memberProfile.count({ where: { linkedUserId: user.id } })]);
    res.json({ available: true, incidents, groupRoleAssignments: groups, operationalAssignments: assignments, openRequests: requests, linkedMemberProfiles: memberProfiles });
  }));

  router.post("/admin/users/:userId/authentication-policy", asyncHandler(async (req, res) => {
    const policy = text(req.body?.authenticationPolicy);
    if (!authenticationPolicies.includes(policy as never)) throw new HttpError(400, "Select a valid authentication policy.");
    if (config.nodeEnv === "production" && policy !== "SSO_ONLY") throw new HttpError(409, "This authentication method is not available in the current runtime.");
    const result = await db.$transaction(async (tx) => {
      await lockUser(tx, param(req, "userId"));
      const current = await detailedUser(tx, param(req, "userId")); assertVersion(current.version, req.body?.expectedVersion);
      if (current.id === actor(req).id) throw new HttpError(409, "Ask another active System Admin to change your authentication policy.");
      const why = reason(req.body?.reason); const updated = await tx.user.update({ where: { id: current.id }, data: { authenticationPolicy: policy, updatedById: actor(req).id, version: { increment: 1 } } });
      await audit(tx, req, "authentication_policy_changed", "userAccount", current.id, "Authentication policy changed", { targetUserId: current.id, previousPolicy: current.authenticationPolicy, nextPolicy: policy, reason: why });
      await accessOutbox(tx, current.id, current.id, updated.version, "Authentication policy changed", "Your account sign-in policy was updated."); return detailedUser(tx, current.id);
    }); res.json(await userResponse(db, result));
  }));

  for (const action of ["activate", "suspend", "archive", "restore"] as const) {
    router.post(`/admin/users/:userId/${action}`, asyncHandler(async (req, res) => {
      const result = await db.$transaction(async (tx) => {
        if (action === "suspend" || action === "archive") await lockAdminInvariant(tx);
        await lockUser(tx, param(req, "userId"));
        const current = await detailedUser(tx, param(req, "userId")); assertVersion(current.version, req.body?.expectedVersion);
        if ((action === "suspend" || action === "archive") && current.id === actor(req).id) throw new HttpError(409, "You cannot suspend or archive your own account.");
        if ((action === "suspend" || action === "archive") && await new EffectiveAccessService(tx).forUser(current.id) && (await new EffectiveAccessService(tx).forUser(current.id))!.permissions.includes("admin:manage") && await activeAdminCount(tx, current.id) === 0) throw new HttpError(409, "Assign another active System Admin before removing this access.");
        const transitions: Partial<Record<string, string>> = action === "activate" ? { Pending: "Active" } : action === "suspend" ? { Active: "Suspended" } : action === "archive" ? { Pending: "Archived", Active: "Archived", Suspended: "Archived" } : { Suspended: "Active", Archived: "Pending" };
        const nextStatus = transitions[current.status]; if (!nextStatus) throw new HttpError(409, "This lifecycle transition is not allowed.");
        const why = action === "suspend" || action === "archive" ? reason(req.body?.reason) : null; const now = new Date();
        const updated = await tx.user.update({ where: { id: current.id }, data: { status: nextStatus, version: { increment: 1 }, updatedById: actor(req).id, ...(action === "activate" ? { activatedAt: now } : action === "suspend" ? { suspendedAt: now, suspendedById: actor(req).id, suspensionReason: why } : action === "archive" ? { archivedAt: now, archivedById: actor(req).id, archiveReason: why } : { restoredAt: now, restoredById: actor(req).id }) } });
        const event = `user_${action === "restore" ? "restored" : action + (action.endsWith("e") ? "d" : "ed")}`;
        await audit(tx, req, event, "userAccount", current.id, `User account ${action}d`, { targetUserId: current.id, previousStatus: current.status, nextStatus, reason: why });
        if (action !== "archive") await accessOutbox(tx, current.id, current.id, updated.version, "Account access changed", `Your account is now ${nextStatus.toLowerCase()}.`); return detailedUser(tx, current.id);
      }); res.json(await userResponse(db, result));
    }));
  }

  router.post("/admin/users/:userId/revoke-sessions", (_req, res) => res.status(501).json({ error: "Session revocation is not available." }));
  router.patch("/admin/users/:userId/roles", (_req, res) => res.status(410).json({ error: "Bulk role replacement is retired. Use explicit role assignment and revocation commands." }));

  router.post("/admin/users/:userId/role-assignments", asyncHandler(async (req, res) => {
    const roleName = normalizeRoleName(text(req.body?.roleName)); const scopeType = req.body?.scopeType === "GROUP" ? "GROUP" : "GLOBAL"; const scopeId = scopeType === "GROUP" ? text(req.body?.scopeId) : null;
    const targetUserId = param(req, "userId");
    const row = await db.$transaction(async (tx) => {
      await lockUser(tx, targetUserId);
      const user = await tx.user.findUniqueOrThrow({ where: { id: targetUserId } }); const roleCandidate = await tx.role.findUnique({ where: { normalizedName: roleName }, select: { id: true } });
      if (roleCandidate) await tx.$queryRaw`SELECT "id" FROM "Role" WHERE "id" = ${roleCandidate.id}::uuid FOR UPDATE`;
      const role = roleCandidate ? await tx.role.findUnique({ where: { id: roleCandidate.id } }) : null;
      if (!role || role.status !== "Active") throw new HttpError(400, "Role is not recognized or active.");
      if (actor(req).id === user.id && role.normalizedName === "system-admin") throw new HttpError(403, "Self-elevation is not allowed.");
      if (!role.scopeTypes.includes(scopeType)) throw new HttpError(400, "Role does not support this scope.");
      let assignmentId: string; let version: number;
      if (scopeType === "GLOBAL") {
        const assignment = await tx.userRole.create({ data: { userId: user.id, roleId: role.id, scopeType: "GLOBAL", assignedBy: actor(req).id } }); assignmentId = assignment.id; version = 1;
      } else {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`group-lifecycle:${scopeId!}`}))`;
        await tx.$queryRaw`SELECT "id" FROM "OperationalGroup" WHERE "id" = ${scopeId!} FOR UPDATE`;
        const group = await tx.operationalGroup.findUnique({ where: { id: scopeId! } }); if (!group || group.status === "Archived") throw new HttpError(400, "Group not found or archived.");
        await tx.userRole.upsert({ where: { userId_roleId: { userId: user.id, roleId: role.id } }, update: { scopeType: "GROUP" }, create: { userId: user.id, roleId: role.id, scopeType: "GROUP", assignedBy: actor(req).id } });
        const assignment = await tx.groupRoleAssignment.create({ data: { id: randomUUID(), userId: user.id, roleId: role.id, groupId: group.id, assignedBy: actor(req).id } }); assignmentId = assignment.id; version = assignment.version;
      }
      await tx.roleAssignmentHistory.create({ data: { assignmentId, userId: user.id, roleId: role.id, scopeType, scopeId, action: "ASSIGNED", actorUserId: actor(req).id, assignmentVersion: version } });
      const bumped = await tx.user.update({ where: { id: user.id }, data: { version: { increment: 1 }, updatedById: actor(req).id } });
      await audit(tx, req, scopeType === "GROUP" ? "scoped_role_assigned" : "role_assigned", "userAccount", user.id, "Role assigned", { targetUserId: user.id, roleName, scopeType, scopeId }); await accessOutbox(tx, user.id, assignmentId, bumped.version, "Role assignment changed", "Your application access was updated.");
      return { id: assignmentId, userId: user.id, roleName, roleDisplayName: role.displayName, scopeType, scopeId, status: "Active", assignedAt: new Date().toISOString(), assignedByUserId: actor(req).id, version };
    }); res.status(201).json(row);
  }));

  router.post("/admin/users/:userId/role-assignments/:assignmentId/revoke", asyncHandler(async (req, res) => {
    const result = await db.$transaction(async (tx) => {
      await lockAdminInvariant(tx); const userId = param(req, "userId"); const assignmentId = param(req, "assignmentId");
      await lockUser(tx, userId);
      const global = await tx.userRole.findFirst({ where: { id: assignmentId, userId }, include: { role: true } }); const group = global ? null : await tx.groupRoleAssignment.findFirst({ where: { id: assignmentId, userId, status: "Active" }, include: { role: true } });
      if (!global && !group) throw new HttpError(404, "Role assignment not found"); const role = global?.role ?? group!.role;
      if (actor(req).id === userId && role.normalizedName === "system-admin") throw new HttpError(409, "You cannot remove your own System Admin access.");
      if (role.normalizedName === "system-admin" && await activeAdminCount(tx, userId) === 0) throw new HttpError(409, "Assign another active System Admin before removing this access.");
      if (global) await tx.userRole.delete({ where: { userId_roleId: { userId, roleId: global.roleId } } });
      else await tx.groupRoleAssignment.update({ where: { id: group!.id }, data: { status: "Revoked", revokedAt: new Date(), revokedBy: actor(req).id, revokeReason: text(req.body?.reason) || null, version: { increment: 1 } } });
      await tx.roleAssignmentHistory.create({ data: { assignmentId, userId, roleId: role.id, scopeType: global ? "GLOBAL" : "GROUP", scopeId: group?.groupId ?? null, action: "REVOKED", actorUserId: actor(req).id, reason: text(req.body?.reason) || null, assignmentVersion: group ? group.version + 1 : 2 } });
      const bumped = await tx.user.update({ where: { id: userId }, data: { version: { increment: 1 }, updatedById: actor(req).id } }); await audit(tx, req, "role_assignment_revoked", "userAccount", userId, "Role assignment revoked", { targetUserId: userId, roleName: role.name, scopeType: global ? "GLOBAL" : "GROUP", scopeId: group?.groupId ?? null }); await accessOutbox(tx, userId, assignmentId, bumped.version, "Role assignment changed", "Your application access was updated.");
      return { id: assignmentId, userId, roleName: role.name, status: "Revoked", revokedAt: new Date().toISOString(), version: group ? group.version + 1 : 2 };
    }); res.json(result);
  }));

  router.post("/admin/users/:userId/capability-overrides", asyncHandler(async (req, res) => {
    const permission = text(req.body?.permission) as Permission; const effect = req.body?.effect === "DENY" ? "DENY" : "GRANT"; if (!(permission in permissions)) throw new HttpError(404, "Capability not found."); if (permission === "admin:manage" && effect === "GRANT") throw new HttpError(403, "admin:manage cannot be granted by an override.");
    const userId = param(req, "userId");
    const result = await db.$transaction(async (tx) => { if (permission === "admin:manage") await lockAdminInvariant(tx); await lockUser(tx, userId); const targetAccess = permission === "admin:manage" ? await new EffectiveAccessService(tx).forUser(userId) : null; if (targetAccess?.permissions.includes("admin:manage") && await activeAdminCount(tx, userId) === 0) throw new HttpError(409, "Assign another active System Admin before denying this capability.");
      const override = await tx.permissionOverride.create({ data: { userId, permission, effect, reason: reason(req.body?.reason), expiresAt: req.body?.expiresAt ? new Date(text(req.body.expiresAt)) : null, createdById: actor(req).id } }); const bumped = await tx.user.update({ where: { id: userId }, data: { version: { increment: 1 }, updatedById: actor(req).id } }); await audit(tx, req, effect === "DENY" ? "user_deny_created" : "user_grant_created", "userAccount", userId, "Capability override created", { targetUserId: userId, permission, effect, reason: override.reason }); await accessOutbox(tx, userId, override.id, bumped.version, "Access exception changed", "An access exception was updated on your account."); return override; }); res.status(201).json(result);
  }));

  router.post("/admin/users/:userId/capability-overrides/:overrideId/revoke", asyncHandler(async (req, res) => {
    const userId = param(req, "userId"); const overrideId = param(req, "overrideId");
    const result = await db.$transaction(async (tx) => { await lockUser(tx, userId); await tx.$queryRaw`SELECT "id" FROM "PermissionOverride" WHERE "id" = ${overrideId}::uuid FOR UPDATE`; const current = await tx.permissionOverride.findFirst({ where: { id: overrideId, userId, active: true } }); if (!current) throw new HttpError(404, "Capability override not found"); assertVersion(current.version, req.body?.expectedVersion); const updated = await tx.permissionOverride.update({ where: { id: current.id }, data: { active: false, revokedAt: new Date(), revokedById: actor(req).id, revokeReason: text(req.body?.reason) || null, version: { increment: 1 } } }); const bumped = await tx.user.update({ where: { id: userId }, data: { version: { increment: 1 }, updatedById: actor(req).id } }); await audit(tx, req, "capability_override_revoked", "userAccount", userId, "Capability override revoked", { targetUserId: userId, permission: current.permission, effect: current.effect }); await accessOutbox(tx, userId, updated.id, bumped.version, "Access exception changed", "An access exception was updated on your account."); return updated; }); res.json(result);
  }));

  router.get("/admin/users/:userId/effective-access", asyncHandler(async (req, res) => { const userId = param(req, "userId"); const projection = await new EffectiveAccessService(db).forUser(userId); if (!projection) throw new HttpError(404, "Active user not found"); const overrides = await db.permissionOverride.findMany({ where: { userId } }); res.json({ ...projection, grants: overrides.filter((item) => item.effect === "GRANT" && item.active), denies: overrides.filter((item) => item.effect === "DENY" && item.active), deniedPermissions: overrides.filter((item) => item.effect === "DENY" && item.active).map((item) => item.permission) }); }));
  router.get("/admin/users/:userId/access-history", asyncHandler(async (req, res) => { const userId = param(req, "userId"); await detailedUser(db, userId); const data = await db.auditLog.findMany({ where: { OR: [{ entityType: "userAccount", entityId: userId }, { metadata: { path: ["targetUserId"], equals: userId } }] }, orderBy: { createdAt: "desc" }, take: 200 }); res.json({ total: data.length, data }); }));

  router.get("/admin/users/:userId/external-identities", asyncHandler(async (req, res) => {
    const userId = param(req, "userId");
    await detailedUser(db, userId);
    const data = await db.externalIdentity.findMany({ where: { userId }, orderBy: [{ linkedAt: "desc" }, { id: "asc" }] });
    res.json({ total: data.length, data });
  }));

  router.post("/admin/users/:userId/external-identities/:identityId/disable", asyncHandler(async (req, res) => {
    const userId = param(req, "userId");
    const identityId = param(req, "identityId");
    const result = await db.$transaction(async (tx) => {
      await lockUser(tx, userId);
      await tx.$queryRaw`SELECT "id" FROM "ExternalIdentity" WHERE "id" = ${identityId}::uuid FOR UPDATE`;
      const user = await detailedUser(tx, userId);
      const identity = await tx.externalIdentity.findFirst({ where: { id: identityId, userId } });
      if (!identity) throw new HttpError(404, "External identity not found");
      if (identity.disabledAt) return identity;
      assertVersion(identity.version, req.body?.expectedVersion);
      const why = reason(req.body?.reason);
      const usableIdentityCount = await tx.externalIdentity.count({ where: { userId, disabledAt: null } });
      if (user.status === "Active" && usableIdentityCount <= 1) {
        throw new HttpError(409, "Suspend the account or link another identity before disabling its final usable identity.");
      }
      const updated = await tx.externalIdentity.update({
        where: { id: identity.id },
        data: { disabledAt: new Date(), disabledById: actor(req).id, disableReason: why, version: { increment: 1 } }
      });
      const bumped = await tx.user.update({ where: { id: userId }, data: { version: { increment: 1 }, updatedById: actor(req).id } });
      await audit(tx, req, "external_identity_disabled", "userIdentity", identity.id, "External identity disabled", { targetUserId: userId, identityId: identity.id, providerType: identity.providerType, reason: why });
      await accessOutbox(tx, userId, identity.id, bumped.version, "Sign-in identity changed", "A sign-in identity was disabled on your account.");
      return updated;
    });
    res.json(result);
  }));

  router.post("/admin/users/:userId/member-link", asyncHandler(async (req, res) => { const userId = param(req, "userId"); const memberProfileId = text(req.body?.memberProfileId); if (!memberProfileId) throw new HttpError(400, "Member profile is required."); const result = await db.$transaction(async (tx) => { await lockUser(tx, userId); await tx.$queryRaw`SELECT "id" FROM "MemberProfile" WHERE "id" = ${memberProfileId} FOR UPDATE`; const user = await detailedUser(tx, userId); const member = await tx.memberProfile.findUnique({ where: { id: memberProfileId } }); if (!member || member.status === "Archived") throw new HttpError(404, "Member profile not found"); if (member.linkedUserId && member.linkedUserId !== user.id) throw new HttpError(409, "This member profile is already linked to another account."); if (user.linkedMemberProfiles.length && user.linkedMemberProfiles[0]!.id !== member.id) throw new HttpError(409, "Unlink the current member profile first."); await tx.memberProfile.update({ where: { id: member.id }, data: { linkedUserId: user.id, updatedById: actor(req).id, version: { increment: 1 } } }); await audit(tx, req, "member_profile_linked", "userAccount", user.id, "Member profile linked", { targetUserId: user.id, memberProfileId }); return detailedUser(tx, user.id); }); res.json({ user: await userResponse(db, result), member: result.linkedMemberProfiles[0] }); }));
  router.delete("/admin/users/:userId/member-link", asyncHandler(async (req, res) => { const userId = param(req, "userId"); const result = await db.$transaction(async (tx) => { const user = await detailedUser(tx, userId); const previous = user.linkedMemberProfiles[0]?.id ?? null; if (previous) await tx.memberProfile.update({ where: { id: previous }, data: { linkedUserId: null, updatedById: actor(req).id, version: { increment: 1 } } }); await audit(tx, req, "member_profile_unlinked", "userAccount", user.id, "Member profile unlinked", { targetUserId: user.id, previousMemberProfileId: previous }); return detailedUser(tx, user.id); }); res.json(await userResponse(db, result)); }));

  async function invitationView(invitationId: string) { const invitation = await db.userInvitation.findUnique({ where: { id: invitationId }, include: { user: { include: userInclude } } }); if (!invitation) throw new HttpError(404, "Invitation not found"); const status = invitationStatus(invitation); return { ...invitation, tokenHash: undefined, status, hasActiveToken: ["Prepared", "Sent"].includes(status), localOnboardingAvailable: config.authMode === "dev" && config.nodeEnv !== "production" && ["Prepared", "Sent"].includes(status), user: await userResponse(db, invitation.user), roleAssignments: assignmentRows(invitation.user) }; }
  router.get("/admin/invitations", asyncHandler(async (req, res) => { const { limit, offset } = page(req); const [total, rows] = await db.$transaction([db.userInvitation.count(), db.userInvitation.findMany({ orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: limit, skip: offset })]); res.json({ total, limit, offset, data: await Promise.all(rows.map((row) => invitationView(row.id))) }); }));
  router.get("/admin/invitations/:invitationId", asyncHandler(async (req, res) => res.json(await invitationView(param(req, "invitationId")))));
  router.post("/admin/invitations", asyncHandler(async (req, res) => {
    if (forbiddenInvitePayload(req.body)) throw new HttpError(400, "Invitation setup cannot include secrets or direct capability edits."); const email = lower(req.body?.email ?? req.body?.loginEmail); const displayName = text(req.body?.displayName); if (!email || !displayName) throw new HttpError(400, "Name and email are required."); const roleInputs = Array.isArray(req.body?.roleAssignments) ? req.body.roleAssignments : Array.isArray(req.body?.roles) ? req.body.roles.map((roleName: unknown) => ({ roleName, scopeType: "GLOBAL" })) : []; if (!roleInputs.length) throw new HttpError(400, "Select at least one role for this invitation.");
    const id = await db.$transaction(async (tx) => { const operation = await beginOperation(tx, req, "invitation_create", { email, displayName, employeeId: req.body?.employeeId, department: req.body?.department, organizationId: req.body?.organizationId, expiresAt: req.body?.expiresAt, roleInputs }); if (operation?.existing) return operation.existing.resultEntityId; const user = await tx.user.create({ data: { email, normalizedEmail: email, displayName, employeeId: text(req.body?.employeeId) || null, department: text(req.body?.department) || null, organizationId: text(req.body?.organizationId) || null, status: "Pending", authenticationPolicy: "SSO_ONLY", createdById: actor(req).id, updatedById: actor(req).id } });
      for (const raw of roleInputs) { const roleName = normalizeRoleName(text(raw?.roleName ?? raw)); const scopeType = raw?.scopeType === "GROUP" ? "GROUP" : "GLOBAL"; const roleCandidate = await tx.role.findUnique({ where: { normalizedName: roleName }, select: { id: true } }); if (roleCandidate) await tx.$queryRaw`SELECT "id" FROM "Role" WHERE "id" = ${roleCandidate.id}::uuid FOR UPDATE`; const role = roleCandidate ? await tx.role.findUnique({ where: { id: roleCandidate.id } }) : null; if (!role || role.status !== "Active" || !role.scopeTypes.includes(scopeType)) throw new HttpError(400, "Invalid role assignment."); const marker = await tx.userRole.upsert({ where: { userId_roleId: { userId: user.id, roleId: role.id } }, update: { scopeType }, create: { userId: user.id, roleId: role.id, scopeType, assignedBy: actor(req).id } }); let assignmentId = marker.id; const scopeId = scopeType === "GROUP" ? text(raw?.scopeId) : null; if (scopeType === "GROUP") { await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`group-lifecycle:${scopeId!}`}))`; await tx.$queryRaw`SELECT "id" FROM "OperationalGroup" WHERE "id" = ${scopeId!} FOR UPDATE`; const group = await tx.operationalGroup.findUnique({ where: { id: scopeId! } }); if (!group || group.status === "Archived") throw new HttpError(400, "Group not found or archived."); const scoped = await tx.groupRoleAssignment.create({ data: { id: randomUUID(), userId: user.id, roleId: role.id, groupId: group.id, assignedBy: actor(req).id } }); assignmentId = scoped.id; } await tx.roleAssignmentHistory.create({ data: { assignmentId, userId: user.id, roleId: role.id, scopeType, scopeId, action: "ASSIGNED", actorUserId: actor(req).id, assignmentVersion: 1 } }); }
      const invitation = await tx.userInvitation.create({ data: { userId: user.id, invitedEmailSnapshot: email, intendedAuthenticationPolicy: "SSO_ONLY", tokenHash: tokenHash(), tokenExpiresAt: req.body?.expiresAt ? new Date(text(req.body.expiresAt)) : new Date(Date.now() + invitationTtlMs), createdById: actor(req).id } }); await audit(tx, req, "user_created", "userAccount", user.id, "User account created", { targetUserId: user.id, invitationId: invitation.id }); await audit(tx, req, "invitation_prepared", "userInvitation", invitation.id, "Invitation prepared", { targetUserId: user.id, invitationId: invitation.id, authenticationPolicy: "SSO_ONLY" }); await accessOutbox(tx, user.id, invitation.id, invitation.version, "Invitation prepared", "Your account invitation is ready."); if (operation) await completeOperation(tx, operation, { targetUserId: user.id, resultEntityType: "userInvitation", resultEntityId: invitation.id, resultVersion: invitation.version }, req); return invitation.id; }); res.status(201).json(await invitationView(id));
  }));
  router.post("/admin/invitations/:invitationId/regenerate", asyncHandler(async (req, res) => { const invitationId = param(req, "invitationId"); await db.$transaction(async (tx) => { const operation = await beginOperation(tx, req, "invitation_regenerate", { invitationId, expectedVersion: req.body?.expectedVersion, expiresAt: req.body?.expiresAt }); if (operation?.existing) return; const candidate = await tx.userInvitation.findUnique({ where: { id: invitationId }, select: { userId: true } }); if (!candidate) throw new HttpError(404, "Invitation not found"); await lockUser(tx, candidate.userId); await lockInvitation(tx, invitationId); const current = await tx.userInvitation.findUnique({ where: { id: invitationId } }); if (!current) throw new HttpError(404, "Invitation not found"); assertVersion(current.version, req.body?.expectedVersion); const derived = invitationStatus(current); if (["Accepted", "Revoked"].includes(derived)) throw new HttpError(409, "This invitation cannot be regenerated."); const updated = await tx.userInvitation.update({ where: { id: current.id }, data: { status: "Prepared", tokenHash: tokenHash(), tokenExpiresAt: req.body?.expiresAt ? new Date(text(req.body.expiresAt)) : new Date(Date.now() + invitationTtlMs), resendGeneration: { increment: 1 }, version: { increment: 1 }, sentAt: null } }); await audit(tx, req, "invitation_regenerated", "userInvitation", current.id, "Invitation regenerated", { targetUserId: current.userId, invitationId: current.id, resendGeneration: updated.resendGeneration }); await accessOutbox(tx, current.userId, current.id, updated.version, "Invitation updated", "A new invitation is ready for your account."); if (operation) await completeOperation(tx, operation, { targetUserId: current.userId, resultEntityType: "userInvitation", resultEntityId: current.id, resultVersion: updated.version }, req); }); res.json(await invitationView(invitationId)); }));
  router.post("/admin/invitations/:invitationId/revoke", asyncHandler(async (req, res) => { const invitationId = param(req, "invitationId"); await db.$transaction(async (tx) => { const operation = await beginOperation(tx, req, "invitation_revoke", { invitationId, expectedVersion: req.body?.expectedVersion, reason: req.body?.reason }); if (operation?.existing) return; const candidate = await tx.userInvitation.findUnique({ where: { id: invitationId }, select: { userId: true } }); if (!candidate) throw new HttpError(404, "Invitation not found"); await lockUser(tx, candidate.userId); await lockInvitation(tx, invitationId); const current = await tx.userInvitation.findUnique({ where: { id: invitationId } }); if (!current) throw new HttpError(404, "Invitation not found"); assertVersion(current.version, req.body?.expectedVersion); if (!["Prepared", "Sent"].includes(invitationStatus(current))) throw new HttpError(409, "This invitation cannot be revoked."); const updated = await tx.userInvitation.update({ where: { id: current.id }, data: { status: "Revoked", revokedAt: new Date(), revokedById: actor(req).id, revokeReason: reason(req.body?.reason), version: { increment: 1 } } }); await audit(tx, req, "invitation_revoked", "userInvitation", current.id, "Invitation revoked", { targetUserId: current.userId, invitationId: current.id, reason: updated.revokeReason }); await accessOutbox(tx, current.userId, current.id, updated.version, "Invitation revoked", "Your account invitation was revoked."); if (operation) await completeOperation(tx, operation, { targetUserId: current.userId, resultEntityType: "userInvitation", resultEntityId: current.id, resultVersion: updated.version }, req); }); res.json(await invitationView(invitationId)); }));
  router.post("/admin/invitations/:invitationId/local-accept", asyncHandler(async (req, res) => { const invitationId = param(req, "invitationId"); if (config.authMode !== "dev" || config.nodeEnv === "production") throw new HttpError(404, "Local onboarding is not available."); await db.$transaction(async (tx) => { const candidate = await tx.userInvitation.findUnique({ where: { id: invitationId }, select: { userId: true } }); if (!candidate) throw new HttpError(404, "Invitation not found"); await lockUser(tx, candidate.userId); await lockInvitation(tx, invitationId); const current = await tx.userInvitation.findUnique({ where: { id: invitationId }, include: { user: true } }); if (!current) throw new HttpError(404, "Invitation not found"); if (!["Prepared", "Sent"].includes(invitationStatus(current)) || current.resendGeneration !== integer(req.body?.expectedGeneration, current.resendGeneration)) throw new HttpError(410, "This invitation is no longer active."); if (current.user.status !== "Pending") throw new HttpError(409, "Only pending accounts can complete onboarding."); const identity = await tx.externalIdentity.create({ data: { userId: current.userId, providerType: "LOCAL_DEV", issuer: "local-development", providerSubject: `invitation:${current.id}:${current.resendGeneration}`, authenticationMethod: "LOCAL_DEV_SSO", emailSnapshot: current.invitedEmailSnapshot, linkedById: actor(req).id } }); const invitation = await tx.userInvitation.update({ where: { id: current.id }, data: { status: "Accepted", acceptedAt: new Date(), version: { increment: 1 } } }); const user = await tx.user.update({ where: { id: current.userId }, data: { status: "Active", activatedAt: new Date(), updatedById: actor(req).id, version: { increment: 1 } } }); await audit(tx, req, "invitation_accepted", "userInvitation", current.id, "Invitation accepted", { targetUserId: user.id, invitationId: current.id, identityId: identity.id }); await audit(tx, req, "local_identity_linked", "userIdentity", identity.id, "Local identity linked", { targetUserId: user.id, identityId: identity.id, providerType: identity.providerType, authenticationMethod: identity.authenticationMethod }); await accessOutbox(tx, user.id, current.id, invitation.version, "Onboarding completed", "Your account is active."); }); res.json(await invitationView(invitationId)); }));

  router.get("/admin/organizations", asyncHandler(async (req, res) => { const { limit, offset } = page(req); const [total, data] = await db.$transaction([db.organization.count(), db.organization.findMany({ orderBy: [{ name: "asc" }, { id: "asc" }], take: limit, skip: offset })]); res.json({ total, limit, offset, data }); }));
  router.post("/admin/organizations", asyncHandler(async (req, res) => {
    const key = lower(req.body?.key);
    if (!key || !text(req.body?.name)) throw new HttpError(400, "Organization key and name are required.");
    const organization = await db.$transaction(async (tx) => {
      const created = await tx.organization.create({ data: { key, normalizedKey: key, name: text(req.body?.name), type: text(req.body?.type) || null, status: "Active", contactEmail: lower(req.body?.contactEmail) || null, description: text(req.body?.description) || null, createdById: actor(req).id, updatedById: actor(req).id } });
      await audit(tx, req, "organization_created", "organization", created.id, "Organization created", { organizationId: created.id, key: created.normalizedKey });
      return created;
    });
    res.status(201).json(organization);
  }));
  router.patch("/admin/organizations/:id", asyncHandler(async (req, res) => {
    const organization = await db.$transaction(async (tx) => {
      const current = await tx.organization.findUnique({ where: { id: param(req, "id") } });
      if (!current) throw new HttpError(404, "Organization not found");
      assertVersion(current.version, req.body?.expectedVersion);
      const key = lower(req.body?.key ?? current.key);
      const updated = await tx.organization.update({ where: { id: current.id }, data: { key, normalizedKey: key, name: text(req.body?.name) || current.name, type: req.body?.type === undefined ? current.type : text(req.body.type) || null, contactEmail: req.body?.contactEmail === undefined ? current.contactEmail : lower(req.body.contactEmail) || null, description: req.body?.description === undefined ? current.description : text(req.body.description) || null, updatedById: actor(req).id, version: { increment: 1 } } });
      await audit(tx, req, "organization_updated", "organization", updated.id, "Organization updated", { organizationId: updated.id, previousVersion: current.version, nextVersion: updated.version });
      return updated;
    });
    res.json(organization);
  }));
  router.post("/admin/organizations/:id/archive", asyncHandler(async (req, res) => {
    const organization = await db.$transaction(async (tx) => {
      const id = param(req, "id");
      await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const current = await tx.organization.findUnique({ where: { id } });
      if (!current) throw new HttpError(404, "Organization not found");
      assertVersion(current.version, req.body?.expectedVersion);
      if (current.status === "Archived") return current;
      const activeUsers = await tx.user.count({ where: { organizationId: id, status: { in: ["Pending", "Active", "Suspended"] } } });
      if (activeUsers) throw new HttpError(409, "Move or archive organization users before archiving this organization.");
      const updated = await tx.organization.update({ where: { id }, data: { status: "Archived", archivedAt: new Date(), archivedById: actor(req).id, updatedById: actor(req).id, version: { increment: 1 } } });
      await audit(tx, req, "organization_archived", "organization", id, "Organization archived", { organizationId: id, reason: reason(req.body?.reason), previousVersion: current.version, nextVersion: updated.version });
      return updated;
    });
    res.json(organization);
  }));
  router.post("/admin/organizations/:id/restore", asyncHandler(async (req, res) => {
    const organization = await db.$transaction(async (tx) => {
      const id = param(req, "id");
      await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const current = await tx.organization.findUnique({ where: { id } });
      if (!current) throw new HttpError(404, "Organization not found");
      assertVersion(current.version, req.body?.expectedVersion);
      if (current.status === "Active") return current;
      const updated = await tx.organization.update({ where: { id }, data: { status: "Active", archivedAt: null, archivedById: null, updatedById: actor(req).id, version: { increment: 1 } } });
      await audit(tx, req, "organization_restored", "organization", id, "Organization restored", { organizationId: id, previousVersion: current.version, nextVersion: updated.version });
      return updated;
    });
    res.json(organization);
  }));

  router.get("/admin/roles", asyncHandler(async (req, res) => { const { limit, offset } = page(req); const [total, rows] = await db.$transaction([db.role.count(), db.role.findMany({ include: { users: true, groupAssignments: true }, orderBy: [{ displayName: "asc" }, { id: "asc" }], take: limit, skip: offset })]); res.json({ total, limit, offset, data: rows.map(roleResponse) }); }));
  router.get("/admin/roles/:roleId", asyncHandler(async (req, res) => { const roleId = param(req, "roleId"); const key = normalizeRoleName(roleId); const row = await db.role.findFirst({ where: { OR: [{ id: roleId }, { normalizedName: key }] }, include: { users: true, groupAssignments: true } }); if (!row) throw new HttpError(404, "Role not found"); res.json(roleResponse(row)); }));
  router.post("/admin/roles", asyncHandler(async (req, res) => { const name = normalizeRoleName(text(req.body?.name ?? req.body?.displayName)); const capabilityList = (Array.isArray(req.body?.permissions) ? [...new Set(req.body.permissions.map(String))] : []) as string[]; if (!name || !text(req.body?.displayName)) throw new HttpError(400, "Role name is required."); if (capabilityList.includes("admin:manage")) throw new HttpError(403, "Custom roles cannot create administrative access."); if (capabilityList.some((item) => !(item in permissions))) throw new HttpError(400, "Capabilities must use the existing catalogue."); const role = await db.$transaction(async (tx) => { const created = await tx.role.create({ data: { name, normalizedName: name, displayName: text(req.body.displayName), description: text(req.body?.description) || null, permissions: capabilityList, scopeTypes: ["GLOBAL"], custom: true, protected: false, operationalRole: false, createdById: actor(req).id, updatedById: actor(req).id } }); await audit(tx, req, "custom_role_created", "role", created.id, "Custom role created", { roleId: created.id, permissions: capabilityList }); return created; }); res.status(201).json({ ...role, assignedUserCount: 0, capabilityCount: capabilityList.length }); }));
  router.patch("/admin/roles/:roleId", asyncHandler(async (req, res) => {
    const roleId = param(req, "roleId");
    const updated = await db.$transaction(async (tx) => {
      const roleCandidate = await tx.role.findFirst({ where: { OR: [{ id: roleId }, { normalizedName: normalizeRoleName(roleId) }] }, select: { id: true } });
      if (!roleCandidate) throw new HttpError(404, "Role not found");
      await tx.$queryRaw`SELECT "id" FROM "Role" WHERE "id" = ${roleCandidate.id}::uuid FOR UPDATE`;
      const role = await tx.role.findUniqueOrThrow({ where: { id: roleCandidate.id } });
      assertVersion(role.version, req.body?.expectedVersion);
      if (role.protected && (req.body?.name !== undefined || req.body?.permissions !== undefined)) throw new HttpError(409, "Protected role identifiers and capabilities are code-owned.");
      const capabilityList = (req.body?.permissions === undefined ? (Array.isArray(role.permissions) ? role.permissions.map(String) : []) : [...new Set((req.body.permissions as unknown[]).map(String))]) as string[];
      if (capabilityList.includes("admin:manage")) throw new HttpError(403, "Custom roles cannot create administrative access.");
      if (capabilityList.some((item) => !(item in permissions))) throw new HttpError(400, "Capabilities must use the existing catalogue.");
      const result = await tx.role.update({ where: { id: role.id }, data: { displayName: role.protected ? role.displayName : text(req.body?.displayName) || role.displayName, description: text(req.body?.description ?? role.description) || null, permissions: role.protected ? role.permissions as Prisma.InputJsonValue : capabilityList, updatedById: actor(req).id, version: { increment: 1 } } });
      await audit(tx, req, "role_updated", "role", role.id, "Role updated", { roleId: role.id, previousVersion: role.version, nextVersion: result.version });
      return result;
    });
    res.json({ ...updated, capabilityCount: Array.isArray(updated.permissions) ? updated.permissions.length : 0 });
  }));
  router.post("/admin/roles/:roleId/archive", asyncHandler(async (req, res) => {
    const roleId = param(req, "roleId");
    const updated = await db.$transaction(async (tx) => {
      const roleCandidate = await tx.role.findFirst({ where: { OR: [{ id: roleId }, { normalizedName: normalizeRoleName(roleId) }] }, select: { id: true } });
      if (!roleCandidate) throw new HttpError(404, "Role not found");
      await tx.$queryRaw`SELECT "id" FROM "Role" WHERE "id" = ${roleCandidate.id}::uuid FOR UPDATE`;
      const role = await tx.role.findUniqueOrThrow({ where: { id: roleCandidate.id } });
      if (role.protected) throw new HttpError(409, "Protected roles cannot be archived.");
      assertVersion(role.version, req.body?.expectedVersion);
      const assignments = await tx.userRole.count({ where: { roleId: role.id } }) + await tx.groupRoleAssignment.count({ where: { roleId: role.id, status: "Active" } });
      if (assignments) throw new HttpError(409, "Revoke active role assignments before archiving this role.");
      const result = await tx.role.update({ where: { id: role.id }, data: { status: "Archived", archivedAt: new Date(), archivedById: actor(req).id, updatedById: actor(req).id, version: { increment: 1 } } });
      await audit(tx, req, "role_archived", "role", role.id, "Role archived", { roleId: role.id, previousVersion: role.version, nextVersion: result.version });
      return result;
    });
    res.json(updated);
  }));
  router.get("/admin/capabilities", (_req, res) => res.json({ total: Object.keys(permissions).length, data: Object.entries(permissions).map(([id, description]) => ({ id, description })) }));

  return router;
}
