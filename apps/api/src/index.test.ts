import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  accessAuditActions,
  accessAuditEventMatrix,
  accessRepositoryContractSummary,
  atomicOperationMatrix,
  authenticationPolicies,
  hasAuthorizationClaimField,
  hasSensitiveAuthenticationField,
  type EmailOutboxContract,
  type UserIdentityContract,
  type UserInvitationContract
} from "@zpp/shared";
import { effectiveAccessForUser } from "./access-control.js";
import { createApp } from "./app.js";

const demoIds = {
  admin: "00000000-0000-4000-8000-000000000001",
  coordinator: "00000000-0000-4000-8000-000000000002",
  tec: "00000000-0000-4000-8000-000000000003",
  zpp: "00000000-0000-4000-8000-000000000004",
  volunteer: "00000000-0000-4000-8000-000000000005",
  viewer: "00000000-0000-4000-8000-000000000006",
  security: "00000000-0000-4000-8000-000000000007",
  tecCoordinator: "00000000-0000-4000-8000-000000000008",
  tecLeader: "00000000-0000-4000-8000-000000000009",
  multiRole: "00000000-0000-4000-8000-000000000010",
  pending: "00000000-0000-4000-8000-000000000011",
  suspended: "00000000-0000-4000-8000-000000000012",
  archived: "00000000-0000-4000-8000-000000000013"
};

function asUser<T extends { set(name: string, value: string): T }>(test: T, email = "coordinator@lot.pl") {
  return test.set("x-user-email", email);
}

function apiGet(app: ReturnType<typeof createApp>, path: string, email = "coordinator@lot.pl") {
  return asUser(request(app).get(path), email);
}

function apiPost(app: ReturnType<typeof createApp>, path: string, email = "coordinator@lot.pl") {
  return asUser(request(app).post(path), email);
}

function apiPatch(app: ReturnType<typeof createApp>, path: string, email = "coordinator@lot.pl") {
  return asUser(request(app).patch(path), email);
}

function apiDelete(app: ReturnType<typeof createApp>, path: string, email = "coordinator@lot.pl") {
  return asUser(request(app).delete(path), email);
}

async function createVerifiedLinkedMatch(app: ReturnType<typeof createApp>, token: string) {
  const caseId = `CASE-${token}`;
  const family = await apiPost(app, "/api/family-records").send({ sessionId: "ses-demo-1", caseId, firstName: "Family", lastName: token, claimedRelationship: "Parent", passengerFirstName: "Passenger", passengerLastName: token });
  const passenger = await apiPost(app, "/api/passenger-records").send({ sessionId: "ses-demo-1", caseId, personType: "Passenger", firstName: "Passenger", lastName: token, source: "Manual" });
  const verifiedFamily = await apiPost(app, `/api/family-records/${family.body.id}/verify`).send({
    sessionId: "ses-demo-1",
    version: family.body.version,
    claimVersion: family.body.currentClaim.version,
    basis: "Identity and claimed relationship reviewed for API test.",
    verifiedRelationshipType: "Parent"
  });
  expect(verifiedFamily.status).toBe(200);
  const confirmed = await apiPost(app, `/api/matching/claims/${verifiedFamily.body.currentClaim.id}/confirm`).send({
    sessionId: "ses-demo-1",
    passengerRecordId: passenger.body.id,
    reason: "Authoritative records reviewed for API test.",
    expectedClaimVersion: verifiedFamily.body.currentClaim.version,
    expectedPassengerVersion: passenger.body.version,
    operationId: randomUUID()
  });
  expect(confirmed.status).toBe(200);
  const match = (await apiGet(app, "/api/matching-records").query({ sessionId: "ses-demo-1", search: caseId })).body.data[0];
  expect(match).toMatchObject({ status: "Verified match", holdCheck: "No hold", matchScore: null });
  return match;
}

describe("ZPP Connect API", () => {
  it("serves a public health check", async () => {
    const response = await request(createApp()).get("/api/health");
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  it("requires authentication for operational demo endpoints", async () => {
    const app = createApp();
    expect((await request(app).get("/api/config/profile")).status).toBe(401);
    expect((await request(app).get("/api/dashboard")).status).toBe(401);
    expect((await request(app).post("/api/assignments").send({ sessionId: "ses-demo-1", title: "No actor" })).status).toBe(401);
    expect((await asUser(request(app).get("/api/dashboard"), "unknown@lot.pl")).status).toBe(401);
  });

  it("exposes six distinct deterministic users with canonical role assignments", async () => {
    const app = createApp();
    const personas = [
      ["admin@lot.pl", demoIds.admin, "System Admin", ["system-admin", "zpp-coordinator", "tec-coordinator"], ["System Admin", "ZPP Coordinator", "TEC Coordinator"]],
      ["coordinator@lot.pl", demoIds.coordinator, "ZPP Coordinator", ["zpp-coordinator"], ["ZPP Coordinator"]],
      ["tec@lot.pl", demoIds.tec, "TEC Member", ["tec-member"], ["TEC Member"]],
      ["zpp@lot.pl", demoIds.zpp, "ZPP Group Leader", ["zpp-group-leader"], ["ZPP Group Leader"]],
      ["volunteer@lot.pl", demoIds.volunteer, "ZPP Member 01", ["zpp-member"], ["ZPP Member"]],
      ["viewer@lot.pl", demoIds.viewer, "Observer", ["observer"], ["Observer"]]
    ] as const;

    const profiles = [];
    for (const [email, userId, displayName, roles, roleLabels] of personas) {
      const response = await apiGet(app, "/api/auth/me", email);
      expect(response.status).toBe(200);
      expect(response.body.user).toMatchObject({
        id: userId,
        userId,
        email,
        displayName,
        roles
      });
      expect(response.body.user).not.toHaveProperty("identitySource");
      expect(response.body.user).not.toHaveProperty("demo");
      expect(response.body.user).not.toHaveProperty("backedBy");
      expect(response.body.user.roleLabels).toEqual(roleLabels);
      expect(response.body.user.roleAssignments.map((item: any) => item.roleName)).toEqual(roles);
      expect(response.body.user.permissions).toContain("session:read");
      profiles.push(response.body.user);
    }

    expect(new Set(profiles.map((profile) => profile.userId)).size).toBe(6);
    expect(profiles.find((profile) => profile.email === "volunteer@lot.pl")?.userId).not.toBe(profiles.find((profile) => profile.email === "zpp@lot.pl")?.userId);
    expect(profiles.find((profile) => profile.email === "viewer@lot.pl")?.userId).not.toBe(profiles.find((profile) => profile.email === "coordinator@lot.pl")?.userId);
  });

  it("keeps internal data-source details out of product configuration responses", async () => {
    const response = await apiGet(createApp(), "/api/config/profile");

    expect(response.status).toBe(200);
    expect(response.body.dataSource).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toMatch(/demo|in-memory|reset on restart|database not connected|source not connected/i);
  });

  it("Stage 3E3: freezes identity, invitation and outbox contracts without authorization leakage", () => {
    expect(authenticationPolicies).toEqual(["SSO_ONLY", "PASSWORD_ONLY", "SSO_OR_PASSWORD"]);
    expect(accessAuditActions).toEqual(expect.arrayContaining([
      "authentication_policy_changed",
      "identity_linked",
      "identity_disabled",
      "identity_unlinked",
      "role_scope_changed",
      "invitation_prepared",
      "invitation_sent",
      "invitation_regenerated",
      "invitation_resent",
      "invitation_revoked",
      "invitation_accepted",
      "invitation_expired",
      "local_identity_linked",
      "account_activated_through_invitation",
      "email_delivery_failed",
      "account_sessions_revoked"
    ]));
    expect(accessAuditActions).not.toContain("user_sessions_revoked");
    expect(accessAuditEventMatrix.find((item) => item.action === "user_sessions_revoked")).toMatchObject({ lifecycle: "disabled" });

    const identity: UserIdentityContract = {
      id: "idt-stage-3e3",
      userId: demoIds.volunteer,
      providerType: "MICROSOFT_ENTRA",
      realmId: "lot-tenant",
      providerSubject: "provider-subject-123",
      authenticationMethod: "MICROSOFT_SSO",
      emailSnapshot: "volunteer@lot.pl",
      linkedAt: "2026-07-17T09:00:00.000Z",
      lastSuccessfulAuthenticationAt: "2026-07-17T09:15:00.000Z",
      disabledAt: null,
      version: 1
    };
    const invitation: UserInvitationContract = {
      id: "inv-stage-3e3",
      userId: demoIds.volunteer,
      invitedEmailSnapshot: "volunteer@lot.pl",
      intendedAuthenticationPolicy: "SSO_ONLY",
      status: "Prepared",
      tokenHash: "sha256-token-digest-only",
      tokenExpiresAt: "2026-07-24T09:00:00.000Z",
      createdByUserId: demoIds.admin,
      createdAt: "2026-07-17T09:00:00.000Z",
      sentAt: null,
      acceptedAt: null,
      revokedAt: null,
      resendGeneration: 1,
      version: 1
    };
    const outbox: EmailOutboxContract = {
      id: "out-stage-3e3",
      messageType: "invitation",
      recipient: "volunteer@lot.pl",
      templateId: "access-invitation",
      templateVariables: { displayName: "ZPP Member 01", expiresAt: "2026-07-24T09:00:00.000Z" },
      sourceResourceType: "userInvitation",
      sourceResourceId: invitation.id,
      deliveryStatus: "Pending",
      attemptCount: 0,
      nextAttemptAt: null,
      sentAt: null,
      failureCode: null,
      createdAt: "2026-07-17T09:00:00.000Z"
    };

    expect(hasAuthorizationClaimField(identity)).toBe(false);
    expect(hasAuthorizationClaimField(invitation)).toBe(false);
    expect(hasAuthorizationClaimField(outbox)).toBe(false);
    expect(hasSensitiveAuthenticationField(identity)).toBe(false);
    expect(hasSensitiveAuthenticationField(invitation)).toBe(false);
    expect(hasSensitiveAuthenticationField(outbox)).toBe(false);
    expect(accessRepositoryContractSummary.userIdentity.ownershipKey).toEqual(["providerType", "realmId", "providerSubject"]);
    expect(accessRepositoryContractSummary.userInvitation.lookupKey).toBe("tokenHash");
    expect(accessRepositoryContractSummary.userInvitation.repositoryReadsReturnRawToken).toBe(false);
    expect(accessRepositoryContractSummary.userInvitation.acceptanceCanChangeRoles).toBe(false);
    expect(accessRepositoryContractSummary.accessAudit).toMatchObject({ appendOnly: true, supportsUpdate: false, supportsDelete: false });
    expect(accessRepositoryContractSummary.emailOutbox.allowedPayload).toBe("non-sensitive template variables");
    expect(atomicOperationMatrix.map((item) => item.operation)).toEqual([
      "prepareInvitation",
      "sendOrResendInvitation",
      "acceptInvitation",
      "changeAuthenticationPolicy",
      "disableIdentity"
    ]);
  });

  it("Stage 3E3: keeps effective access independent of authentication policy, provider identity and invitation data", () => {
    const hardenedInput = {
      userId: "usr-auth-contract",
      authenticationPolicy: "SSO_ONLY",
      providerIdentity: {
        providerType: "MICROSOFT_ENTRA",
        roles: ["system-admin"],
        permissions: ["admin:manage"]
      },
      invitation: {
        roles: ["system-admin"],
        permissions: ["admin:manage"]
      },
      assignments: [{
        id: "ra-auth-contract",
        userId: "usr-auth-contract",
        roleName: "observer-lite",
        scopeType: "GLOBAL",
        status: "Active",
        assignedAt: "2026-07-17T09:00:00.000Z",
        assignedByUserId: demoIds.admin
      }],
      groups: [],
      permissionOverrides: [],
      roleDefinitions: [{
        name: "observer-lite",
        displayName: "Observer Lite",
        description: "Read sessions only.",
        permissions: ["session:read"],
        scopeTypes: ["GLOBAL"],
        status: "Active"
      }]
    } as Parameters<typeof effectiveAccessForUser>[0] & {
      authenticationPolicy: string;
      providerIdentity: { providerType: string; roles: string[]; permissions: string[] };
      invitation: { roles: string[]; permissions: string[] };
    };

    const access = effectiveAccessForUser(hardenedInput);

    expect(access.roles).toEqual(["observer-lite"]);
    expect(access.permissions).toEqual(["session:read"]);
    expect(access.permissions).not.toContain("admin:manage");
  });

  it("Stage 3E3: keeps raw passwords, invitation tokens and provider secrets out of public contracts", () => {
    const publicContractSources = [
      readFileSync(new URL("./types.ts", import.meta.url), "utf8"),
      readFileSync(new URL("../../web/src/lib/types.ts", import.meta.url), "utf8"),
      readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8")
    ].join("\n");

    expect(publicContractSources).not.toMatch(/\b(passwordHash|encryptedPassword|temporaryPassword|passwordResetToken|resetToken|rawInvitationToken|invitationToken|oauthAccessToken|oauthRefreshToken|providerSecret|clientSecret)\b/i);
  });

  it("enforces scoped multi-role assignments through the admin API", async () => {
    const app = createApp();

    const duplicate = await apiPatch(app, `/api/admin/users/${demoIds.volunteer}/roles`, "admin@lot.pl").send({
      assignments: [
        { roleName: "zpp-group-leader", scopeType: "GROUP", scopeId: "grp-2026-000001" },
        { roleName: "ZPP Leader", scopeType: "GROUP", scopeId: "grp-2026-000001" }
      ]
    });
    expect(duplicate.status).toBe(409);

    const incompatible = await apiPatch(app, `/api/admin/users/${demoIds.volunteer}/roles`, "admin@lot.pl").send({
      assignments: [{ roleName: "zpp-group-leader", scopeType: "GROUP", scopeId: "grp-2026-000002" }]
    });
    expect(incompatible.status).toBe(400);
    expect(incompatible.body.error).toContain("compatible groups");

    const updated = await apiPatch(app, `/api/admin/users/${demoIds.volunteer}/roles`, "admin@lot.pl").send({
      assignments: [
        { roleName: "zpp-member", scopeType: "GLOBAL" },
        { roleName: "zpp-group-leader", scopeType: "GROUP", scopeId: "grp-2026-000001" },
        { roleName: "zpp-group-leader", scopeType: "GROUP", scopeId: "grp-2026-000003" }
      ]
    });
    expect(updated.status).toBe(200);
    expect(updated.body.roles).toEqual(["zpp-member", "zpp-group-leader"]);
    expect(updated.body.roleLabels).toEqual(["ZPP Member", "ZPP Group Leader"]);
    expect(updated.body.roleAssignments.map((item: any) => [item.roleName, item.scopeType, item.scopeId ?? null])).toEqual([
      ["zpp-member", "GLOBAL", null],
      ["zpp-group-leader", "GROUP", "grp-2026-000001"],
      ["zpp-group-leader", "GROUP", "grp-2026-000003"]
    ]);

    const effective = await apiGet(app, "/api/auth/me", "volunteer@lot.pl");
    expect(effective.body.user.permissions).toEqual(expect.arrayContaining(["assignment:update", "group:read"]));

    const singleScoped = await apiPatch(app, `/api/admin/users/${demoIds.volunteer}/roles`, "admin@lot.pl").send({
      assignments: [
        { roleName: "zpp-member", scopeType: "GLOBAL" },
        { roleName: "zpp-group-leader", scopeType: "GROUP", scopeId: "grp-2026-000001" }
      ]
    });
    expect(singleScoped.status).toBe(200);
    const changedScope = await apiPatch(app, `/api/admin/users/${demoIds.volunteer}/roles`, "admin@lot.pl").send({
      assignments: [
        { roleName: "zpp-member", scopeType: "GLOBAL" },
        { roleName: "zpp-group-leader", scopeType: "GROUP", scopeId: "grp-2026-000004" }
      ]
    });
    expect(changedScope.status).toBe(200);
    const scopeHistory = await apiGet(app, `/api/admin/users/${demoIds.volunteer}/access-history`, "admin@lot.pl");
    expect(scopeHistory.body.data.find((item: any) => item.action === "role_scope_changed")?.metadata).toMatchObject({
      targetUserId: demoIds.volunteer,
      roleName: "zpp-group-leader",
      previousScopeType: "GROUP",
      previousScopeId: "grp-2026-000001",
      nextScopeType: "GROUP",
      nextScopeId: "grp-2026-000004"
    });

    const restoredVolunteer = await apiPatch(app, `/api/admin/users/${demoIds.volunteer}/roles`, "admin@lot.pl").send({
      roles: ["zpp-member"]
    });
    expect(restoredVolunteer.status).toBe(200);

    const adminOnly = await apiPatch(app, `/api/admin/users/${demoIds.admin}/roles`, "admin@lot.pl").send({
      roles: ["system-admin"]
    });
    expect(adminOnly.status).toBe(200);
    const adminEffective = await apiGet(app, "/api/auth/me", "admin@lot.pl");
    expect(adminEffective.body.user.permissions).toContain("admin:manage");
    expect(adminEffective.body.user.permissions).not.toContain("assignment:create");
    expect((await apiGet(app, "/api/groups", "admin@lot.pl")).status).toBe(403);

    const restoredAdmin = await apiPatch(app, `/api/admin/users/${demoIds.admin}/roles`, "admin@lot.pl").send({
      roles: ["system-admin", "zpp-coordinator", "tec-coordinator"]
    });
    expect(restoredAdmin.status).toBe(200);
  });

  it("enforces RBAC for read-only and limited personas", async () => {
    const app = createApp();
    const viewerMutation = await apiPost(app, "/api/family-records", "viewer@lot.pl").send({
      sessionId: "ses-demo-1",
      firstName: "Viewer",
      lastName: "Injected",
      roles: ["admin"],
      permissions: ["family:create"]
    });
    expect(viewerMutation.status).toBe(403);
    expect(viewerMutation.body.error).toBe("Forbidden");

    expect((await apiGet(app, "/api/dashboard", "viewer@lot.pl")).status).toBe(200);
    expect((await apiGet(app, "/api/assignments", "viewer@lot.pl")).status).toBe(403);
    expect((await apiGet(app, "/api/assignments/assignees", "volunteer@lot.pl").query({ sessionId: "ses-demo-1" })).status).toBe(403);
    expect((await apiPost(app, "/api/family-records", "volunteer@lot.pl").send({ sessionId: "ses-demo-1" })).status).toBe(403);
    expect((await apiPost(app, "/api/matching/claims/claim-memory-fam-demo-1/confirm", "tec@lot.pl").send({})).status).toBe(403);
  });

  it("keeps import/export behavior behind server-side permissions without technical UI copy", async () => {
    const app = createApp();
    const preview = await asUser(request(app).post("/api/imports/manifest"), "coordinator@lot.pl")
      .field("sessionId", "ses-demo-1")
      .attach("file", Buffer.from("firstName,lastName,personType\nJan,Kowalski,Passenger\nMissing,,Passenger\n"), "manifest.csv");

    expect(preview.status).toBe(201);
    expect(preview.body).toMatchObject({
      status: "Validated with errors",
      totalRecords: 2,
      validRecords: 1,
      invalidRecords: 1
    });
    expect(preview.body.previewRows).toHaveLength(2);
    expect(preview.body.errors[0]).toMatchObject({ row: 3, error: "lastName is required" });
    expect(preview.body.dataSource).toBeUndefined();
    expect(preview.body.id).toBeTruthy();

    const files = await apiGet(app, "/api/files").query({ sessionId: "ses-demo-1" });
    expect(files.status).toBe(200);
    expect(files.body.data.some((file: any) => file.fileName === "manifest.csv" || file.sourceFilename === "manifest.csv")).toBe(true);

    const confirmed = await apiPost(app, `/api/imports/${preview.body.id}/confirm`, "coordinator@lot.pl").send({});
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("Imported with errors");
    expect((await apiPost(app, `/api/imports/${preview.body.id}/confirm`, "coordinator@lot.pl").send({})).status).toBe(409);

    const passengers = await apiGet(app, "/api/passenger-records", "coordinator@lot.pl").query({ sessionId: "ses-demo-1", search: "Kowalski" });
    expect(passengers.status).toBe(200);
    expect(passengers.body.data.some((item: any) => item.firstName === "Jan" && item.lastName === "Kowalski")).toBe(true);

    const csv = await apiGet(app, "/api/exports/session-package").query({ sessionId: "ses-demo-1" });
    expect(csv.status).toBe(200);
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.headers["content-disposition"]).toContain("SES-2026-001-session-package.csv");
    expect(csv.headers["x-zpp-data-source"]).toBeUndefined();
    expect(csv.text).not.toMatch(/demo|sample|in-memory|data-source/i);

    expect((await apiGet(app, "/api/exports/session-package", "viewer@lot.pl").query({ sessionId: "ses-demo-1" })).status).toBe(403);
  });

  it("uses concrete product timestamps in notifications", async () => {
    const response = await apiGet(createApp(), "/api/notifications");

    expect(response.status).toBe(200);
    expect(response.body.data.length).toBeGreaterThan(0);
    for (const item of response.body.data) {
      expect(item.createdAt).toMatch(/\d{2} \w{3} \d{4}, \d{2}:\d{2}/);
      expect(item.createdAt).not.toMatch(/\b(Just now|Today|Yesterday|\d+\s*(min|hr)s?\s+ago)\b/i);
      expect(`${item.title} ${item.message} ${item.createdAt}`).not.toMatch(/demo|sample|in-memory|reset on restart|database not connected/i);
    }
  });

  it("serves member profiles through API with RBAC, redaction and neutral audit summaries", async () => {
    const app = createApp();
    const memberId = `ZPP-T-${Date.now()}`;

    const volunteerList = await apiGet(app, "/api/member-profiles", "volunteer@lot.pl");
    expect(volunteerList.status).toBe(200);
    expect(volunteerList.body.data.length).toBeGreaterThan(0);
    expect(volunteerList.body.data[0].contactEmail).toBeUndefined();
    expect(volunteerList.body.data[0].linkedUserId).toBeUndefined();

    const unscopedLeaderCreate = await apiPost(app, "/api/member-profiles", "zpp@lot.pl").send({
      memberId: `${memberId}-LEADER`,
      roleType: "ZPP",
      firstName: "Unscoped",
      lastName: "Member"
    });
    expect(unscopedLeaderCreate.status).toBe(403);

    const created = await apiPost(app, "/api/member-profiles", "coordinator@lot.pl").send({
      memberId,
      roleType: "ZPP",
      firstName: "Test",
      lastName: "Member",
      functionName: "Welfare Support",
      availability: "Available",
      trainingStatus: "Current",
      contactEmail: "test.member@example.org"
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ memberId, displayName: "Test Member", status: "Active" });
    expect(created.body.contactEmail).toBe("test.member@example.org");
    expect(created.body.readinessScore).toBeUndefined();

    const duplicate = await apiPost(app, "/api/member-profiles", "coordinator@lot.pl").send({ memberId, firstName: "Duplicate", lastName: "Member" });
    expect(duplicate.status).toBe(409);

    const blocked = await apiPost(app, "/api/member-profiles", "volunteer@lot.pl").send({ memberId: `${memberId}-VOL`, firstName: "No", lastName: "Write" });
    expect(blocked.status).toBe(403);

    const updated = await apiPatch(app, `/api/member-profiles/${created.body.id}`, "coordinator@lot.pl").send({ role: "Welfare Support Specialist", readinessScore: 91 });
    expect(updated.status).toBe(200);
    expect(updated.body.role).toBe("Welfare Support Specialist");
    expect(updated.body.readinessScore).toBeUndefined();

    const archived = await apiPost(app, `/api/member-profiles/${created.body.id}/archive`, "coordinator@lot.pl").send({});
    expect(archived.status).toBe(200);
    expect(archived.body.status).toBe("Archived");

    const audit = await apiGet(app, "/api/audit-logs", "admin@lot.pl").query({ sessionId: "ses-demo-1" });
    const summaries = audit.body.data.map((item: any) => item.summary);
    expect(summaries).toEqual(expect.arrayContaining(["Member created", "Member updated", "Profile archived"]));
    expect(summaries.join(" ")).not.toMatch(/demo|in-memory|reset on restart|database/i);
  });

  it("serves groups and memberships through API without frontend fallback assumptions", async () => {
    const app = createApp();
    const groupName = `Support Team ${Date.now()}`;

    const memberGroups = await apiGet(app, "/api/groups", "volunteer@lot.pl");
    expect(memberGroups.status).toBe(200);
    expect(Array.isArray(memberGroups.body.data)).toBe(true);
    expect(memberGroups.body.data.map((item: any) => item.pool)).not.toContain("TEC");

    const created = await apiPost(app, "/api/groups", "coordinator@lot.pl").send({
      sessionId: "ses-demo-1",
      pool: "ZPP",
      name: groupName,
      functionName: "Welfare Support",
      status: "Active"
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: groupName, status: "Active" });
    expect(created.body.readinessScore).toBeUndefined();

    const members = await apiGet(app, "/api/member-profiles", "coordinator@lot.pl");
    const member = members.body.data.find((item: any) => item.status === "Active");
    expect(member).toBeTruthy();

    const added = await apiPost(app, `/api/groups/${created.body.id}/members`, "coordinator@lot.pl").send({ memberProfileId: member.id, role: "Member" });
    expect(added.status).toBe(201);
    expect(added.body.memberIds).toContain(member.id);

    const duplicate = await apiPost(app, `/api/groups/${created.body.id}/members`, "coordinator@lot.pl").send({ memberProfileId: member.id, role: "Member" });
    expect(duplicate.status).toBe(409);

    const removed = await apiDelete(app, `/api/groups/${created.body.id}/members/${member.id}`, "coordinator@lot.pl");
    expect(removed.status).toBe(200);
    expect(removed.body.memberIds).not.toContain(member.id);

    const blocked = await apiPost(app, "/api/groups", "volunteer@lot.pl").send({ name: `${groupName} Volunteer` });
    expect(blocked.status).toBe(403);

    const scopedLeaderGroups = await apiGet(app, "/api/groups", "zpp@lot.pl");
    expect(scopedLeaderGroups.status).toBe(200);
    expect(scopedLeaderGroups.body.data.map((item: any) => item.id)).toEqual(["grp-2026-000001"]);
    expect((await apiGet(app, "/api/groups/grp-2026-000001", "zpp@lot.pl")).status).toBe(200);
    expect((await apiGet(app, "/api/groups/grp-2026-000002", "zpp@lot.pl")).status).toBe(403);
    expect((await apiPost(app, "/api/groups", "zpp@lot.pl").send({ sessionId: "ses-demo-1", pool: "ZPP", name: "Unscoped create" })).status).toBe(403);

    const audit = await apiGet(app, "/api/audit-logs", "admin@lot.pl").query({ sessionId: "ses-demo-1" });
    const summaries = audit.body.data.map((item: any) => item.summary);
    expect(summaries).toEqual(expect.arrayContaining(["Group created", "Member added to group", "Member removed from group"]));
    expect(summaries.join(" ")).not.toMatch(/demo|in-memory|reset on restart|database/i);
  });

  it("does not retain legacy readiness scores in directory seeds or roster contracts", async () => {
    const app = createApp();
    const memberDirectorySource = readFileSync(new URL("./member-directory.ts", import.meta.url), "utf8");
    expect(memberDirectorySource).not.toMatch(/readinessScore/);

    const members = await apiGet(app, "/api/member-profiles", "admin@lot.pl").query({ limit: 200 });
    const groups = await apiGet(app, "/api/groups", "admin@lot.pl").query({ limit: 200 });
    const roster = await apiGet(app, "/api/roster-shifts", "zpp@lot.pl").query({ sessionId: "ses-demo-1", limit: 200 });

    expect(members.status).toBe(200);
    expect(groups.status).toBe(200);
    expect(roster.status).toBe(200);
    expect(JSON.stringify(members.body)).not.toMatch(/readinessScore/);
    expect(JSON.stringify(groups.body)).not.toMatch(/readinessScore/);
    expect(JSON.stringify(roster.body)).not.toMatch(/readinessScore/);
  });

  it("serves Active Event briefings from the selected session with scoped RBAC", async () => {
    const app = createApp();

    const volunteerView = await apiGet(app, "/api/sessions/ses-demo-1/active-event", "volunteer@lot.pl");
    expect(volunteerView.status).toBe(200);
    expect(volunteerView.body.session).toMatchObject({ id: "ses-demo-1", mode: "EXERCISE", status: "Active" });
    expect(volunteerView.body.currentBriefing).toMatchObject({ status: "Published", revision: 1, sessionId: "ses-demo-1" });
    expect(volunteerView.body.currentBriefing.priorities[0]).toHaveProperty("assignment");
    const volunteerOwnPriority = volunteerView.body.currentBriefing.priorities.find((item: any) => item.linkedAssignmentId === "asn-demo-1");
    expect(volunteerOwnPriority.assignment).toMatchObject({
      accessState: "Available",
      title: "Prepare welfare room briefing note",
      status: "Open",
      assignedUserId: demoIds.volunteer,
      detailHref: "/assignments?assignmentId=asn-demo-1"
    });
    const volunteerRestrictedPriority = volunteerView.body.currentBriefing.priorities.find((item: any) => item.linkedAssignmentId === "asn-demo-3");
    expect(volunteerRestrictedPriority.assignment).toMatchObject({ accessState: "Restricted", contextLabel: "Assignment details restricted" });
    expect(volunteerRestrictedPriority.assignment.title).toBeUndefined();
    expect(volunteerRestrictedPriority.assignment.status).toBeUndefined();
    expect(volunteerRestrictedPriority.assignment.assignedUserDisplayName).toBeUndefined();
    expect(volunteerView.body.draft).toBeNull();
    expect(volunteerView.body.history).toBeUndefined();
    expect(JSON.stringify(volunteerView.body)).not.toMatch(/readinessScore|demo mode|in-memory|reset on restart|database not connected|temporary storage/i);

    const adminView = await apiGet(app, "/api/sessions/ses-demo-1/active-event", "admin@lot.pl");
    expect(adminView.status).toBe(200);
    const adminLinkedPriority = adminView.body.currentBriefing.priorities.find((item: any) => item.linkedAssignmentId === "asn-demo-3");
    expect(adminLinkedPriority.assignment).toMatchObject({
      accessState: "Available",
      title: "Verify restricted case before first contact",
      status: "Escalated",
      priority: "Critical",
      assignedUserId: demoIds.coordinator,
      assignedUserDisplayName: "ZPP Coordinator",
      contextLabel: "Linked task in progress",
      detailHref: "/assignments?assignmentId=asn-demo-3"
    });

    const zppTrainingView = await apiGet(app, "/api/sessions/ses-demo-2/active-event", "zpp@lot.pl");
    expect(zppTrainingView.status).toBe(200);
    expect(zppTrainingView.body.session).toMatchObject({ id: "ses-demo-2", mode: "TRAINING", status: "Closed" });
    expect(zppTrainingView.body.currentBriefing).toMatchObject({ status: "Published", revision: 1 });
    expect(zppTrainingView.body.draft).toMatchObject({ id: "brf-ses-demo-2-r2", status: "Draft", revision: 2 });
    expect(zppTrainingView.body.permissions).toMatchObject({ canCreateDraft: false, canUpdateDraft: false, canPublish: false, canReadHistory: true });
    expect(zppTrainingView.body.history.map((item: any) => item.status)).toEqual(["Draft", "Published"]);

    expect((await apiGet(app, "/api/sessions/ses-demo-2/briefings", "volunteer@lot.pl")).status).toBe(403);
    expect((await apiGet(app, "/api/briefings/brf-ses-demo-2-r2", "volunteer@lot.pl")).status).toBe(403);
  });

  it("links briefing priorities to assignments without mutating assignment workflow", async () => {
    const app = createApp();
    const session = await apiPost(app, "/api/sessions", "coordinator@lot.pl").send({
      mode: "EXERCISE",
      status: "Active",
      eventType: "Exercise",
      flightNumber: `BRF-LINK-${Date.now()}`,
      route: "WAW-LNK",
      description: "Briefing assignment link session",
      startAt: "2026-07-02T09:00:00.000Z"
    });
    expect(session.status).toBe(201);
    const sessionId = session.body.id;

    const first = await apiPost(app, "/api/assignments", "coordinator@lot.pl").send({
      sessionId,
      title: "Linkable briefing task one",
      priority: "Urgent",
      dueAt: "2026-07-02T11:00:00.000Z",
      operationId: randomUUID()
    });
    const second = await apiPost(app, "/api/assignments", "coordinator@lot.pl").send({
      sessionId,
      title: "Linkable briefing task two",
      priority: "Normal",
      dueAt: "2026-07-02T12:00:00.000Z",
      operationId: randomUUID()
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const auditBefore = await apiGet(app, "/api/audit-logs", "admin@lot.pl").query({ sessionId });
    const assignmentAuditBefore = auditBefore.body.data.filter((item: any) => item.entityType === "assignmentTask").length;
    const timelineBefore = await apiGet(app, "/api/timeline", "admin@lot.pl").query({ sessionId });

    const draft = await apiPost(app, `/api/sessions/${sessionId}/briefings/draft`, "coordinator@lot.pl").send({});
    const linked = await apiPatch(app, `/api/briefings/${draft.body.briefing.id}`, "coordinator@lot.pl").send({
      expectedVersion: draft.body.briefing.version,
      title: "Briefing with linked work",
      situationSummary: "Exercise briefing has one linked operational task.",
      priorities: [{
        description: "Use this linked work item for handover tracking.",
        status: "Not started",
        linkedAssignmentId: first.body.id,
        title: "Ignored assignment title overwrite"
      }]
    });
    expect(linked.status).toBe(200);
    expect(linked.body.priorities[0]).toMatchObject({ linkedAssignmentId: first.body.id });
    expect(linked.body.priorities[0].assignment).toBeUndefined();

    const firstAfterLink = (await apiGet(app, "/api/assignments", "coordinator@lot.pl").query({ sessionId })).body.data.find((item: any) => item.id === first.body.id);
    expect(firstAfterLink).toMatchObject({ title: "Linkable briefing task one", status: "Open", priority: "Urgent" });

    const replaced = await apiPatch(app, `/api/briefings/${draft.body.briefing.id}`, "coordinator@lot.pl").send({
      expectedVersion: linked.body.version,
      priorities: [{
        id: linked.body.priorities[0].id,
        description: "Use this linked work item for handover tracking.",
        status: "Not started",
        linkedAssignmentId: second.body.id
      }]
    });
    expect(replaced.status).toBe(200);
    expect(replaced.body.priorities[0]).toMatchObject({ linkedAssignmentId: second.body.id });

    const unlinked = await apiPatch(app, `/api/briefings/${draft.body.briefing.id}`, "coordinator@lot.pl").send({
      expectedVersion: replaced.body.version,
      priorities: [{
        id: replaced.body.priorities[0].id,
        description: "Use this linked work item for handover tracking.",
        status: "Not started",
        linkedAssignmentId: null
      }]
    });
    expect(unlinked.status).toBe(200);
    expect(unlinked.body.priorities[0].linkedAssignmentId).toBeNull();

    const auditAfter = await apiGet(app, "/api/audit-logs", "admin@lot.pl").query({ sessionId });
    expect(auditAfter.body.data.map((item: any) => item.action)).toEqual(expect.arrayContaining([
      "briefing_priority_assignment_linked",
      "briefing_priority_assignment_changed",
      "briefing_priority_assignment_unlinked"
    ]));
    expect(auditAfter.body.data.filter((item: any) => item.entityType === "assignmentTask").length).toBe(assignmentAuditBefore);

    const timelineAfter = await apiGet(app, "/api/timeline", "admin@lot.pl").query({ sessionId });
    expect(timelineAfter.body.data.length).toBe(timelineBefore.body.data.length);

    const published = await apiPost(app, `/api/briefings/${draft.body.briefing.id}/publish`, "admin@lot.pl").send({ expectedVersion: unlinked.body.version });
    expect(published.status).toBe(200);
    expect(published.body.priorities[0].linkedAssignmentId).toBeNull();

    const closedSession = await apiPost(app, `/api/sessions/${sessionId}/close`, "admin@lot.pl").send({ notes: "Briefing assignment link API test complete." });
    expect(closedSession.status).toBe(200);
  });

  it("manages Active Event briefing drafts with version checks, publishing rules and audit trail", async () => {
    const app = createApp();
    const session = await apiPost(app, "/api/sessions", "admin@lot.pl").send({
      mode: "EXERCISE",
      status: "Active",
      eventType: "Exercise",
      flightNumber: `BRF-${Date.now()}`,
      route: "WAW-API",
      description: "API briefing lifecycle session",
      startAt: "2026-07-02T08:00:00.000Z"
    });
    expect(session.status).toBe(201);
    const sessionId = session.body.id;

    for (const userId of [demoIds.coordinator, demoIds.volunteer]) {
      const assigned = await apiPost(app, `/api/sessions/${sessionId}/assignments`, "admin@lot.pl").send({
        userId,
        function: "Briefing lifecycle test"
      });
      expect(assigned.status).toBe(201);
    }

    expect((await apiPost(app, `/api/sessions/${sessionId}/briefings/draft`, "zpp@lot.pl").send({})).status).toBe(403);

    const created = await apiPost(app, `/api/sessions/${sessionId}/briefings/draft`, "coordinator@lot.pl").send({});
    expect(created.status).toBe(200);
    expect(created.body.created).toBe(true);
    expect(created.body.briefing).toMatchObject({ sessionId, status: "Draft", revision: 1, version: 1 });

    const existing = await apiPost(app, `/api/sessions/${sessionId}/briefings/draft`, "coordinator@lot.pl").send({});
    expect(existing.status).toBe(200);
    expect(existing.body.created).toBe(false);
    expect(existing.body.briefing.id).toBe(created.body.briefing.id);

    const disallowedPatch = await apiPatch(app, `/api/briefings/${created.body.briefing.id}`, "coordinator@lot.pl").send({
      expectedVersion: created.body.briefing.version,
      status: "Published"
    });
    expect(disallowedPatch.status).toBe(400);

    const crossSessionLink = await apiPatch(app, `/api/briefings/${created.body.briefing.id}`, "coordinator@lot.pl").send({
      expectedVersion: created.body.briefing.version,
      title: "This title should not be applied",
      priorities: [{ description: "Do not link a different session assignment", linkedAssignmentId: "asn-demo-1" }]
    });
    expect(crossSessionLink.status).toBe(409);
    const afterInvalidLink = await apiGet(app, `/api/briefings/${created.body.briefing.id}`, "coordinator@lot.pl");
    expect(afterInvalidLink.status).toBe(200);
    expect(afterInvalidLink.body).toMatchObject({
      title: created.body.briefing.title,
      version: created.body.briefing.version
    });

    expect((await apiPost(app, `/api/briefings/${created.body.briefing.id}/publish`, "zpp@lot.pl").send({ expectedVersion: created.body.briefing.version })).status).toBe(403);
    expect((await apiPost(app, `/api/briefings/${created.body.briefing.id}/publish`, "admin@lot.pl").send({ expectedVersion: created.body.briefing.version })).status).toBe(400);

    const updated = await apiPatch(app, `/api/briefings/${created.body.briefing.id}`, "coordinator@lot.pl").send({
      expectedVersion: created.body.briefing.version,
      title: "Exercise planning briefing",
      situationSummary: "EXERCISE planning session is ready for controlled briefing practice.",
      overview: "Use this briefing before taking planning work.",
      confirmedFacts: [{ statement: "Session SES-2026-003 is open for planning.", source: "Session control" }],
      unconfirmedInformation: [{ statement: "Participant roster is still being checked.", source: "Rostering" }],
      priorities: [{ description: "Read the briefing before starting planning actions.", status: "Not started" }],
      risks: [{ severity: "Attention", description: "Planning information may change before activation.", status: "Open" }],
      coordinationNotes: [{ note: "Keep the planning briefing concise for handover." }],
      nextUpdateDueAt: "2026-07-02T12:00:00.000Z"
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ status: "Draft", version: 2, situationSummary: "EXERCISE planning session is ready for controlled briefing practice." });

    const staleUpdate = await apiPatch(app, `/api/briefings/${created.body.briefing.id}`, "coordinator@lot.pl").send({
      expectedVersion: 1,
      title: "Stale briefing title"
    });
    expect(staleUpdate.status).toBe(409);

    const published = await apiPost(app, `/api/briefings/${created.body.briefing.id}/publish`, "admin@lot.pl").send({ expectedVersion: updated.body.version });
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ status: "Published", sessionId, revision: 1, publishedById: demoIds.admin });

    const activeView = await apiGet(app, `/api/sessions/${sessionId}/active-event`, "volunteer@lot.pl");
    expect(activeView.status).toBe(200);
    expect(activeView.body.session).toMatchObject({ id: sessionId, mode: "EXERCISE", status: "Active" });
    expect(activeView.body.currentBriefing).toMatchObject({ id: created.body.briefing.id, status: "Published" });
    expect(activeView.body.draft).toBeNull();

    const timeline = await apiGet(app, "/api/timeline", "admin@lot.pl").query({ sessionId });
    expect(timeline.body.data.filter((item: any) => item.eventType === "briefing" && item.entityId === created.body.briefing.id)).toHaveLength(1);

    const audit = await apiGet(app, "/api/audit-logs", "admin@lot.pl").query({ sessionId });
    expect(audit.body.data.map((item: any) => item.action)).toEqual(expect.arrayContaining(["briefing_draft_created", "briefing_draft_updated", "briefing_published"]));
    expect(audit.body.data.map((item: any) => item.summary).join(" ")).not.toMatch(/demo|in-memory|reset on restart|database/i);

    const closedSession = await apiPost(app, `/api/sessions/${sessionId}/close`, "admin@lot.pl").send({ notes: "Briefing lifecycle API test complete." });
    expect(closedSession.status).toBe(200);
  });

  it("supersedes the previous Active Event briefing without auditing routine reads", async () => {
    const app = createApp();

    const beforeReadAudit = await apiGet(app, "/api/audit-logs", "admin@lot.pl").query({ sessionId: "ses-demo-1" });
    expect((await apiGet(app, "/api/sessions/ses-demo-1/active-event", "admin@lot.pl")).status).toBe(200);
    const afterReadAudit = await apiGet(app, "/api/audit-logs", "admin@lot.pl").query({ sessionId: "ses-demo-1" });
    expect(afterReadAudit.body.data.length).toBe(beforeReadAudit.body.data.length);

    const draft = await apiPost(app, "/api/sessions/ses-demo-1/briefings/draft", "coordinator@lot.pl").send({});
    expect(draft.status).toBe(200);
    expect(draft.body.briefing).toMatchObject({ status: "Draft", revision: 2 });

    const published = await apiPost(app, `/api/briefings/${draft.body.briefing.id}/publish`, "admin@lot.pl").send({ expectedVersion: draft.body.briefing.version });
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ status: "Published", revision: 2 });

    const history = await apiGet(app, "/api/sessions/ses-demo-1/briefings", "admin@lot.pl");
    expect(history.status).toBe(200);
    expect(history.body.data.map((item: any) => [item.revision, item.status])).toEqual([[2, "Published"], [1, "Superseded"]]);

    const editPublished = await apiPatch(app, `/api/briefings/${published.body.id}`, "coordinator@lot.pl").send({
      expectedVersion: published.body.version,
      title: "Cannot edit published briefing"
    });
    expect(editPublished.status).toBe(409);

    const timeline = await apiGet(app, "/api/timeline", "admin@lot.pl").query({ sessionId: "ses-demo-1" });
    expect(timeline.body.data.filter((item: any) => item.eventType === "briefing" && item.entityId === published.body.id)).toHaveLength(1);
  });

  it("records request closure decisions in audit and timeline with authenticated actors", async () => {
    const app = createApp();
    const closureNote = "Resolved with PFA support arranged.";

    const operationId = randomUUID();
    expect((await apiPost(app, "/api/requests/req-demo-1/resolve", "zpp@lot.pl").send({ sessionId: "ses-demo-1", expectedVersion: 1, outcome: "PFA arranged", resolutionNote: closureNote, operationId })).status).toBe(403);
    const closed = await apiPost(app, "/api/requests/req-demo-1/resolve", "coordinator@lot.pl").send({ sessionId: "ses-demo-1", expectedVersion: 1, outcome: "PFA arranged", resolutionNote: closureNote, operationId });
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe("RESOLVED");

    const audit = await apiGet(app, "/api/audit-logs").query({ sessionId: "ses-demo-1" });
    expect(audit.body.data[0]).toMatchObject({
      action: "request_resolve",
      actorEmail: "coordinator@lot.pl",
      actorDisplayName: "ZPP Coordinator",
      metadata: { previousStatus: "ASSIGNED", newStatus: "RESOLVED", outcome: "PFA arranged" }
    });

    const timeline = await apiGet(app, "/api/timeline").query({ sessionId: "ses-demo-1" });
    expect(timeline.body.data[0]).toMatchObject({
      eventType: "request",
      entityId: "req-demo-1",
      title: "Request REQ-2026-000001 resolved",
      body: closureNote,
      createdBy: { userId: demoIds.coordinator, displayName: "ZPP Coordinator" }
    });
  });

  it("records release completion decisions in audit and timeline", async () => {
    const app = createApp();
    const decisionNote = "Identity, handover and transport confirmed.";
    const eligibleMatch = await createVerifiedLinkedMatch(app, `REL-AUDIT-${Date.now()}`);
    const prepared = await apiPost(app, "/api/releases/prepare", "coordinator@lot.pl").send({
      sessionId: "ses-demo-1",
      matchDecisionId: eligibleMatch.matchDecisionId,
      actionType: "RELEASE",
      releaseDestination: "Family assistance centre",
      receivingParty: "Anna Kowalska",
      operationId: randomUUID()
    });

    expect(prepared.status, JSON.stringify(prepared.body)).toBe(201);
    const identity = await apiPost(app, `/api/releases/${prepared.body.id}/checks/identity`).send({ sessionId: "ses-demo-1", result: "PASS", basis: "Identity evidence reviewed with the receiving person.", expectedVersion: prepared.body.version, operationId: randomUUID() });
    const hold = await apiPost(app, `/api/releases/${prepared.body.id}/checks/hold`).send({ sessionId: "ses-demo-1", basis: "Current Passenger hold state reviewed.", expectedVersion: identity.body.version, operationId: randomUUID() });
    const authorized = await apiPost(app, `/api/releases/${prepared.body.id}/authorize`).send({ sessionId: "ses-demo-1", reason: "All independent checks and upstream decisions reviewed.", expectedVersion: hold.body.version, operationId: randomUUID() });
    const completed = await apiPost(app, `/api/releases/${prepared.body.id}/complete`, "coordinator@lot.pl").send({ sessionId: "ses-demo-1", reason: decisionNote, expectedVersion: authorized.body.version, operationId: randomUUID() });
    expect(completed.status).toBe(200);
    expect(completed.body.status).toBe("COMPLETED");

    const audit = await apiGet(app, "/api/audit-logs").query({ sessionId: "ses-demo-1" });
    expect(audit.body.data[0]).toMatchObject({
      action: "complete_release",
      actorEmail: "coordinator@lot.pl",
      summary: `RELEASE ${prepared.body.operationalId} completed`,
      metadata: { beforeState: "AUTHORIZED", afterState: "COMPLETED", reason: decisionNote }
    });

    const timeline = await apiGet(app, "/api/timeline").query({ sessionId: "ses-demo-1" });
    expect(timeline.body.data[0]).toMatchObject({
      eventType: "release",
      entityType: "releaseAction",
      entityId: prepared.body.id,
      body: decisionNote,
      createdBy: { userId: demoIds.coordinator }
    });
  });

  it("rejects incomplete and cross-session matching links and does not invent a score", async () => {
    const app = createApp();
    const token = `MATCH-${Date.now()}`;
    const incomplete = await apiPost(app, "/api/matching/claims/missing/confirm").send({ sessionId: "ses-demo-1" });
    expect(incomplete.status).toBe(400);

    const family = await apiPost(app, "/api/family-records").send({ sessionId: "ses-demo-1", caseId: token, firstName: "Family", lastName: token, passengerFirstName: "Passenger", passengerLastName: token });
    const otherSession = await apiPost(app, "/api/sessions").send({ mode: "EXERCISE", status: "Active", eventType: "Exercise", flightNumber: token });
    const otherFamily = await apiPost(app, "/api/family-records").send({ sessionId: otherSession.body.id, caseId: token, firstName: "Other", lastName: token });
    const otherPassenger = await apiPost(app, "/api/passenger-records").send({ sessionId: "ses-demo-1", caseId: token, personType: "Passenger", firstName: "Passenger", lastName: token, source: "Manual" });
    const crossSession = await apiPost(app, `/api/matching/claims/${otherFamily.body.currentClaim.id}/confirm`).send({
      sessionId: otherSession.body.id,
      passengerRecordId: otherPassenger.body.id,
      reason: "Attempted cross-incident decision.",
      expectedClaimVersion: otherFamily.body.currentClaim.version,
      expectedPassengerVersion: otherPassenger.body.version,
      operationId: randomUUID()
    });
    expect(crossSession.status).toBe(409);

    const passenger = await apiPost(app, "/api/passenger-records").send({ sessionId: "ses-demo-1", caseId: token, personType: "Passenger", firstName: "Passenger", lastName: token, source: "Manual" });
    const created = await apiPost(app, `/api/matching/claims/${family.body.currentClaim.id}/confirm`).send({
      sessionId: "ses-demo-1",
      passengerRecordId: passenger.body.id,
      reason: "Manual matching evidence reviewed.",
      expectedClaimVersion: family.body.currentClaim.version,
      expectedPassengerVersion: passenger.body.version,
      operationId: randomUUID()
    });
    expect(created.status).toBe(200);
    const compatibility = (await apiGet(app, "/api/matching-records").query({ sessionId: "ses-demo-1", search: token })).body.data[0];
    expect(compatibility).toMatchObject({ status: "Verified match", holdCheck: "No hold", matchScore: null });
    expect((await apiPost(app, `/api/sessions/${otherSession.body.id}/close`).send({ notes: "Cross-incident matching test complete." })).status).toBe(200);
  });

  it("removes generic release writes and prevents duplicate active actions", async () => {
    const app = createApp();
    const match = await createVerifiedLinkedMatch(app, `REL-${Date.now()}`);
    expect((await apiPost(app, "/api/releases").send({ sessionId: "ses-demo-1" })).status).toBe(404);
    const prepared = await apiPost(app, "/api/releases/prepare").send({
      sessionId: "ses-demo-1",
      matchDecisionId: match.matchDecisionId,
      actionType: "RELEASE",
      operationId: randomUUID()
    });
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(201);

    expect((await apiPost(app, "/api/releases/prepare").send({ sessionId: "ses-demo-1", matchDecisionId: match.matchDecisionId, actionType: "RELEASE", operationId: randomUUID() })).status).toBe(409);
    expect((await apiPatch(app, `/api/releases/${prepared.body.id}`).send({ status: "COMPLETED", identityChecked: true, holdCleared: true })).status).toBe(404);
    expect((await apiPost(app, `/api/matching-records/${match.id}/mark-reunited`).send({ sessionId: "ses-demo-1" })).status).toBe(404);
    expect((await apiPost(app, `/api/matching-records/${match.id}/mark-released`).send({ sessionId: "ses-demo-1" })).status).toBe(404);

    const cancelled = await apiPost(app, `/api/releases/${prepared.body.id}/cancel`).send({ sessionId: "ses-demo-1", reason: "Preparation superseded by a corrected action.", expectedVersion: prepared.body.version, operationId: randomUUID() });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe("CANCELLED");

    const replacement = await apiPost(app, "/api/releases/prepare").send({ sessionId: "ses-demo-1", matchDecisionId: match.matchDecisionId, actionType: "RELEASE", operationId: randomUUID() });
    expect(replacement.status).toBe(201);
  });

  it("protects Timeline and Audit history while preserving manual-note provenance", async () => {
    const app = createApp();
    const token = `S3A-NOTE-${Date.now()}`;
    const protectedNote = await apiPost(app, "/api/timeline", "tec@lot.pl").send({
      sessionId: "ses-demo-1",
      eventType: "release",
      title: token,
      body: "This must not impersonate a release decision.",
      createdById: demoIds.admin
    });
    expect(protectedNote.status).toBe(400);

    const note = await apiPost(app, "/api/timeline", "tec@lot.pl").send({
      sessionId: "ses-demo-1",
      caseId: token,
      eventType: "handover_note",
      title: token,
      body: "Full handover context retained for the next operational shift.",
      createdById: demoIds.admin
    });
    expect(note.status).toBe(201);
    expect(note.body).toMatchObject({ eventType: "handover_note", entityType: "manualNote", title: token });
    expect(note.body.createdBy).toMatchObject({ userId: demoIds.tec, displayName: "TEC Member" });

    const audit = await apiGet(app, "/api/audit-logs").query({ sessionId: "ses-demo-1" });
    expect(audit.body.data.find((item: any) => item.entityId === note.body.id)).toMatchObject({
      action: "create_timeline_event",
      actorEmail: "tec@lot.pl",
      actorDisplayName: "TEC Member"
    });

    expect((await apiPatch(app, `/api/timeline/${note.body.id}`).send({ eventType: "release" })).status).toBe(404);
    expect((await asUser(request(app).delete(`/api/timeline/${note.body.id}`))).status).toBe(404);
    expect((await apiPatch(app, `/api/audit-logs/${audit.body.data[0].id}`).send({ actorEmail: "replaced@example.test" })).status).toBe(404);
    expect((await asUser(request(app).delete(`/api/audit-logs/${audit.body.data[0].id}`))).status).toBe(404);
  });

  it("uses stable assignment owner IDs for claim, reassignment, status and legacy handling", async () => {
    const app = createApp();
    const token = `S3A-ASN-${Date.now()}`;
    const protectedCreate = await apiPost(app, "/api/assignments", "coordinator@lot.pl").send({
      sessionId: "ses-demo-1",
      groupId: "grp-2026-000004",
      title: token,
      status: "Completed",
      ownerAssignedTo: "Injected owner",
      assignedUserId: demoIds.admin,
      priority: "Urgent",
      operationId: randomUUID()
    });
    expect(protectedCreate.status).toBe(400);
    const created = await apiPost(app, "/api/assignments", "coordinator@lot.pl").send({
      sessionId: "ses-demo-1",
      title: token,
      priority: "Urgent",
      operationId: randomUUID()
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: "Open", ownerAssignedTo: null, assignedUserId: null });

    const protectedPatch = await apiPatch(app, `/api/assignments/${created.body.id}`, "coordinator@lot.pl").send({
      sessionId: "ses-demo-1",
      expectedVersion: created.body.version,
      title: `${token}-EDITED`,
      status: "Completed",
      ownerAssignedTo: "Silent replacement",
      assignedUserId: demoIds.admin
    });
    expect(protectedPatch.status).toBe(400);
    const patched = await apiPatch(app, `/api/assignments/${created.body.id}`, "coordinator@lot.pl").send({
      sessionId: "ses-demo-1",
      expectedVersion: created.body.version,
      title: `${token}-EDITED`
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ title: `${token}-EDITED`, status: "Open", ownerAssignedTo: null, assignedUserId: null });

    const claimed = await apiPost(app, `/api/assignments/${created.body.id}/claim`, "volunteer@lot.pl").send({ sessionId: "ses-demo-1", expectedVersion: patched.body.version, operationId: randomUUID() });
    expect(claimed.status).toBe(200);
    expect(claimed.body).toMatchObject({
      status: "Open",
      assignedUserId: demoIds.volunteer,
      assignedUserDisplayName: "ZPP Member 01",
      ownerAssignedTo: "ZPP Member 01"
    });
    expect(claimed.body.ownerAssignedTo).not.toBe("ZPP");
    expect((await apiPost(app, `/api/assignments/${created.body.id}/claim`, "zpp@lot.pl").send({ sessionId: "ses-demo-1", expectedVersion: patched.body.version, operationId: randomUUID() })).status).toBe(409);

    const started = await apiPost(app, `/api/assignments/${created.body.id}/start`, "volunteer@lot.pl").send({ sessionId: "ses-demo-1", expectedVersion: claimed.body.version });
    expect(started.status).toBe(200);
    expect((await apiPost(app, `/api/assignments/${created.body.id}/reassign`, "volunteer@lot.pl").send({ sessionId: "ses-demo-1", expectedVersion: started.body.version, operationId: randomUUID(), assignedUserId: demoIds.zpp, reason: "Trying to manage work." })).status).toBe(403);

    const assignees = await apiGet(app, "/api/assignments/assignees", "coordinator@lot.pl").query({ sessionId: "ses-demo-1" });
    expect(assignees.status).toBe(200);
    expect(assignees.body.data.map((item: any) => item.id)).toEqual(expect.arrayContaining([demoIds.volunteer, demoIds.zpp, demoIds.coordinator, demoIds.admin]));
    expect(assignees.body.data.map((item: any) => item.id)).not.toContain(demoIds.viewer);

    const scopedAssignees = await apiGet(app, "/api/assignments/assignees", "zpp@lot.pl").query({ sessionId: "ses-demo-1" });
    expect(scopedAssignees.status).toBe(200);
    expect(scopedAssignees.body.data.map((item: any) => item.id)).toContain(demoIds.zpp);
    expect(scopedAssignees.body.data.map((item: any) => item.id)).not.toContain(demoIds.viewer);

    const globallyManagedAssignmentId = "asn-demo-3";
    const managed = await apiGet(app, `/api/assignments/${globallyManagedAssignmentId}`, "coordinator@lot.pl").query({ sessionId: "ses-demo-1" });
    const noReason = await apiPost(app, `/api/assignments/${globallyManagedAssignmentId}/reassign`, "coordinator@lot.pl").send({ sessionId: "ses-demo-1", expectedVersion: managed.body.version, operationId: randomUUID(), assignedUserId: demoIds.zpp });
    expect(noReason.status).toBe(400);
    const reassigned = await apiPost(app, `/api/assignments/${globallyManagedAssignmentId}/reassign`, "coordinator@lot.pl").send({
      assignedUserId: demoIds.zpp,
      reason: "Shift handover approved by the coordinator.",
      sessionId: "ses-demo-1",
      expectedVersion: managed.body.version,
      operationId: randomUUID()
    });
    expect(reassigned.status).toBe(200);
    expect(reassigned.body).toMatchObject({
      assignedUserId: demoIds.zpp,
      assignedUserDisplayName: "ZPP Group Leader",
      ownerAssignedTo: "ZPP Group Leader"
    });

    const assignmentAudit = await apiGet(app, "/api/audit-logs").query({ sessionId: "ses-demo-1" });
    expect(assignmentAudit.body.data.find((item: any) => item.action === "reassign_assignment" && item.entityId === globallyManagedAssignmentId)?.metadata).toMatchObject({
      previousAssigneeId: demoIds.coordinator,
      newAssigneeId: demoIds.zpp,
    });
    const assignmentTimeline = await apiGet(app, "/api/timeline").query({ sessionId: "ses-demo-1" });
    expect(assignmentTimeline.body.data.find((item: any) => item.entityId === globallyManagedAssignmentId && item.title.includes("reassigned"))?.metadata).toMatchObject({
      previousAssigneeId: demoIds.coordinator,
      newAssigneeId: demoIds.zpp
    });

    const done = await apiPost(app, `/api/assignments/${created.body.id}/complete`, "volunteer@lot.pl").send({ sessionId: "ses-demo-1", expectedVersion: started.body.version, operationId: randomUUID() });
    expect(done.status).toBe(200);
    expect((await apiPatch(app, `/api/assignments/${created.body.id}`, "volunteer@lot.pl").send({ sessionId: "ses-demo-1", expectedVersion: done.body.version, title: "Terminal overwrite" })).status).toBe(409);

    const legacy = (await apiGet(app, "/api/assignments").query({ sessionId: "ses-demo-1" })).body.data.find((item: any) => item.operationalId === "ASN-2026-000002");
    expect(legacy).toMatchObject({
      assignedUserId: null,
      ownerAssignedTo: "Leader Bravo",
      legacyAssigneeLabel: "Leader Bravo"
    });
    const resolvedLegacy = await apiPost(app, `/api/assignments/${legacy.id}/reassign`, "coordinator@lot.pl").send({
      assignedUserId: demoIds.tec,
      reason: "Resolve the legacy string owner to a canonical identity.",
      sessionId: "ses-demo-1",
      expectedVersion: legacy.version,
      operationId: randomUUID()
    });
    expect(resolvedLegacy.status).toBe(200);
    expect(resolvedLegacy.body.assignedUserId).toBe(demoIds.tec);

    const session = await apiPost(app, "/api/sessions").send({ mode: "EXERCISE", status: "Active", eventType: "Exercise", flightNumber: token });
    const closedTask = await apiPost(app, "/api/assignments", "coordinator@lot.pl").send({
      sessionId: session.body.id,
      title: `${token}-CLOSED`,
      priority: "Normal",
      operationId: randomUUID()
    });
    await apiPost(app, `/api/sessions/${session.body.id}/close`).send({ notes: "Stage 3A isolated API test cleanup." });
    expect((await apiPost(app, `/api/assignments/${closedTask.body.id}/claim`, "coordinator@lot.pl").send({ sessionId: session.body.id, expectedVersion: closedTask.body.version, operationId: randomUUID() })).status).toBe(409);
    expect((await apiPatch(app, `/api/assignments/${closedTask.body.id}`, "coordinator@lot.pl").send({ sessionId: session.body.id, expectedVersion: closedTask.body.version, title: "Closed overwrite" })).status).toBe(409);
    expect((await apiGet(app, `/api/assignments/${closedTask.body.id}`, "tec@lot.pl").query({ sessionId: session.body.id })).status).toBe(404);
  });

  it("serves rostering and availability through API with role scope, actions and neutral audit summaries", async () => {
    const app = createApp();

    const viewerRoster = await apiGet(app, "/api/roster-shifts", "viewer@lot.pl").query({ sessionId: "ses-demo-1" });
    expect(viewerRoster.status).toBe(200);
    expect(viewerRoster.body.data.length).toBeGreaterThan(0);
    expect(JSON.stringify(viewerRoster.body)).not.toMatch(/readinessScore/);
    expect((await apiPost(app, "/api/roster-shifts", "viewer@lot.pl").send({ sessionId: "ses-demo-1" })).status).toBe(403);
    expect((await apiGet(app, "/api/availability", "viewer@lot.pl")).status).toBe(403);

    const volunteerRoster = await apiGet(app, "/api/roster-shifts", "volunteer@lot.pl").query({ sessionId: "ses-demo-1" });
    expect(volunteerRoster.status).toBe(200);
    expect(volunteerRoster.body.linkedMemberProfile).toMatchObject({ id: "mem-2026-000008", memberId: "ZPP-221" });
    expect(volunteerRoster.body.data.map((item: any) => item.id)).toEqual(["rst-2026-000002"]);
    expect(volunteerRoster.body.data[0]).toMatchObject({ status: "Published", assignedMemberProfileId: "mem-2026-000008" });
    expect(JSON.stringify(volunteerRoster.body)).not.toMatch(/readinessScore/);

    const blockedOwnAction = await apiPost(app, "/api/roster-shifts/rst-2026-000001/confirm", "volunteer@lot.pl").send({});
    expect(blockedOwnAction.status).toBe(403);

    const confirmed = await apiPost(app, "/api/roster-shifts/rst-2026-000002/confirm", "volunteer@lot.pl").send({});
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("Confirmed");

    const draft = await apiGet(app, "/api/roster-shifts/rst-2026-000006", "coordinator@lot.pl");
    expect(draft.status).toBe(200);
    const genericStatusPatch = await apiPatch(app, "/api/roster-shifts/rst-2026-000006", "coordinator@lot.pl").send({
      status: "Published",
      expectedUpdatedAt: draft.body.updatedAt
    });
    expect(genericStatusPatch.status).toBe(400);
    expect(genericStatusPatch.body.error).toContain("dedicated roster action");

    const stalePatch = await apiPatch(app, "/api/roster-shifts/rst-2026-000006", "coordinator@lot.pl").send({
      title: "Stale update",
      expectedUpdatedAt: "2026-01-01T00:00:00.000Z"
    });
    expect(stalePatch.status).toBe(409);

    const overlap = await apiPost(app, "/api/roster-shifts", "coordinator@lot.pl").send({
      sessionId: "ses-demo-1",
      title: "Overlapping volunteer shift",
      duty: "Documentation",
      functionName: "Documentation Support",
      startAt: "2026-07-13T13:00:00.000Z",
      endAt: "2026-07-13T15:00:00.000Z",
      assignedMemberProfileId: "mem-2026-000008"
    });
    expect(overlap.status).toBe(409);

    const readiness = await apiGet(app, "/api/readiness/members", "zpp@lot.pl").query({ evaluationAt: "2026-07-13T09:00:00.000Z", limit: 200 });
    expect(readiness.status).toBe(200);
    const readinessStatuses = readiness.body.data.map((item: any) => item.overallStatus);
    expect(readinessStatuses.length).toBeGreaterThan(0);
    expect(readinessStatuses.every((status: string) => ["Ready", "Ready with attention", "Not ready", "Unknown", "Not applicable"].includes(status))).toBe(true);

    const readinessInformational = await apiPost(app, "/api/roster-shifts", "zpp@lot.pl").send({
      sessionId: "ses-demo-1",
      groupId: "grp-2026-000001",
      title: "Readiness informational assignment",
      duty: "Coverage check",
      functionName: "Family Assistance Team",
      startAt: "2026-07-20T08:00:00.000Z",
      endAt: "2026-07-20T12:00:00.000Z",
      assignedMemberProfileId: "mem-2026-000007"
    });
    expect(readinessInformational.status).toBe(201);
    expect(readinessInformational.body.assignedMember).toMatchObject({ id: "mem-2026-000007", displayName: "Magdalena Jankowska" });
    expect(JSON.stringify(readinessInformational.body)).not.toMatch(/readinessScore/);

    const created = await apiPost(app, "/api/roster-shifts", "zpp@lot.pl").send({
      sessionId: "ses-demo-1",
      title: "Airport reception handover",
      duty: "Handover support",
      functionName: "Airport Reception Support",
      startAt: "2026-07-16T04:00:00.000Z",
      endAt: "2026-07-16T12:00:00.000Z",
      assignedMemberProfileId: "mem-2026-000006",
      groupId: "grp-2026-000001",
      status: "Published"
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ title: "Airport reception handover", status: "Draft", assignedMemberProfileId: "mem-2026-000006" });

    const published = await apiPost(app, `/api/roster-shifts/${created.body.id}/publish`, "zpp@lot.pl").send({});
    expect(published.status).toBe(200);
    expect(published.body.status).toBe("Published");

    const volunteerAvailability = await apiGet(app, "/api/availability", "volunteer@lot.pl");
    expect(volunteerAvailability.status).toBe(200);
    expect(volunteerAvailability.body.data.every((item: any) => item.memberProfileId === "mem-2026-000008")).toBe(true);

    const availabilityOverlap = await apiPost(app, "/api/availability", "volunteer@lot.pl").send({
      startAt: "2026-07-13T12:30:00.000Z",
      endAt: "2026-07-13T14:30:00.000Z",
      type: "Available"
    });
    expect(availabilityOverlap.status).toBe(409);

    const addedAvailability = await apiPost(app, "/api/availability", "volunteer@lot.pl").send({
      startAt: "2026-07-16T12:00:00.000Z",
      endAt: "2026-07-16T18:00:00.000Z",
      type: "Preferred",
      note: "Can help after the main shift."
    });
    expect(addedAvailability.status).toBe(201);
    expect(addedAvailability.body).toMatchObject({ memberProfileId: "mem-2026-000008", type: "Preferred" });

    const staleAvailability = await apiPatch(app, `/api/availability/${addedAvailability.body.id}`, "volunteer@lot.pl").send({
      note: "Late stale update",
      expectedUpdatedAt: "2026-01-01T00:00:00.000Z"
    });
    expect(staleAvailability.status).toBe(409);

    const removedAvailability = await apiPost(app, `/api/availability/${addedAvailability.body.id}/remove`, "volunteer@lot.pl").send({});
    expect(removedAvailability.status).toBe(200);
    expect(removedAvailability.body.status).toBe("Removed");

    const audit = await apiGet(app, "/api/audit-logs", "admin@lot.pl").query({ sessionId: "ses-demo-1" });
    const summaries = audit.body.data.map((item: any) => item.summary);
    expect(summaries).toEqual(expect.arrayContaining([
      "Roster shift created",
      "Roster shift published",
      "Roster shift confirmed",
      "Availability added",
      "Availability removed"
    ]));
    expect(summaries.join(" ")).not.toMatch(/demo|in-memory|reset on restart|database/i);
  });

  it("serves role-aware training records with scoped personal access and dedicated actions", async () => {
    const app = createApp();

    const volunteerRecords = await apiGet(app, "/api/training/records", "volunteer@lot.pl").query({ mine: true });
    expect(volunteerRecords.status).toBe(200);
    expect(volunteerRecords.body.linkedMemberProfile).toMatchObject({ id: "mem-2026-000008", memberId: "ZPP-221" });
    expect(volunteerRecords.body.data.map((item: any) => item.course.title)).toEqual(expect.arrayContaining(["Data Protection for Crisis Response", "ERP Familiarization"]));
    expect(volunteerRecords.body.data.map((item: any) => item.memberProfileId).every((id: string) => id === "mem-2026-000008")).toBe(true);

    const tecRecords = await apiGet(app, "/api/training/records", "tec@lot.pl").query({ mine: true });
    expect(tecRecords.status).toBe(200);
    expect(tecRecords.body.linkedMemberProfile).toMatchObject({ id: "mem-2026-000002", memberId: "TEC-001" });
    expect(tecRecords.body.data.map((item: any) => item.course.title)).toContain("Telephone Enquiry Center Procedures");
    expect((await apiGet(app, "/api/training/records/trn-2026-000004", "volunteer@lot.pl")).status).toBe(403);

    const started = await apiPost(app, "/api/training/records/trn-2026-000001/start", "volunteer@lot.pl").send({
      expectedUpdatedAt: volunteerRecords.body.data.find((item: any) => item.id === "trn-2026-000001").updatedAt
    });
    expect(started.status).toBe(200);
    expect(started.body.status).toBe("In Progress");

    const completed = await apiPost(app, "/api/training/records/trn-2026-000001/complete", "volunteer@lot.pl").send({
      expectedUpdatedAt: started.body.updatedAt,
      completedAt: "2026-07-13T10:00:00.000Z",
      completionNote: "Completed after reviewing the required module."
    });
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({ status: "Completed", completedAt: "2026-07-13T10:00:00.000Z", expiryAt: "2027-07-13T10:00:00.000Z" });

    const familyTraining = await apiPost(app, "/api/training/records/assign", "coordinator@lot.pl").send({
      memberProfileId: "mem-2026-000008",
      courseId: "crs-2026-000002",
      dueAt: "2026-07-22T12:00:00.000Z"
    });
    expect(familyTraining.status).toBe(201);
    const blockedSelfComplete = await apiPost(app, `/api/training/records/${familyTraining.body.id}/complete`, "volunteer@lot.pl").send({
      expectedUpdatedAt: familyTraining.body.updatedAt,
      completedAt: "2026-07-13T12:00:00.000Z"
    });
    expect(blockedSelfComplete.status).toBe(403);

    const genericStatusPatch = await apiPatch(app, "/api/training/records/trn-2026-000003", "zpp@lot.pl").send({ status: "Completed" });
    expect(genericStatusPatch.status).toBe(400);
    expect(genericStatusPatch.body.error).toContain("dedicated action");

    const missingCompletionTime = await apiPost(app, "/api/training/records/trn-2026-000003/complete", "zpp@lot.pl").send({});
    expect(missingCompletionTime.status).toBe(400);

    const staleStart = await apiPost(app, `/api/training/records/${familyTraining.body.id}/start`, "coordinator@lot.pl").send({
      expectedUpdatedAt: "2026-01-01T00:00:00.000Z"
    });
    expect(staleStart.status).toBe(409);

    const verified = await apiPost(app, "/api/training/records/trn-2026-000002/verify", "coordinator@lot.pl").send({});
    expect(verified.status).toBe(200);
    expect(verified.body.verifiedAt).toBeTruthy();

    const waived = await apiPost(app, "/api/training/records/trn-2026-000003/waive", "coordinator@lot.pl").send({
      reason: "Coordinator accepted equivalent current training evidence."
    });
    expect(waived.status).toBe(200);
    expect(waived.body.status).toBe("Waived");

    const cancelled = await apiPost(app, `/api/training/records/${familyTraining.body.id}/cancel`, "coordinator@lot.pl").send({
      reason: "Assignment replaced by a more specific course."
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe("Cancelled");

    const derived = await apiGet(app, "/api/training/records", "zpp@lot.pl").query({ status: "Expired" });
    expect(derived.status).toBe(200);
    expect(derived.body.data.map((item: any) => item.id)).toContain("trn-2026-000006");

    const expiring = await apiGet(app, "/api/training/records", "zpp@lot.pl").query({ expiringWithin: 45 });
    expect(expiring.status).toBe(200);
    expect(expiring.body.data.map((item: any) => item.id)).toContain("trn-2026-000005");

    const audit = await apiGet(app, "/api/audit-logs", "admin@lot.pl").query({ sessionId: "ses-demo-1" });
    const summaries = audit.body.data.map((item: any) => item.summary);
    expect(summaries).toEqual(expect.arrayContaining([
      "Training assigned",
      "Training started",
      "Completion recorded",
      "Completion verified",
      "Training waived",
      "Training cancelled"
    ]));
    expect(summaries.join(" ")).not.toMatch(/demo|in-memory|reset on restart|database/i);
  });

  it("manages training courses and requirements with RBAC, conflicts and archived-target protection", async () => {
    const app = createApp();

    const courses = await apiGet(app, "/api/training/courses", "viewer@lot.pl");
    expect(courses.status).toBe(200);
    expect(courses.body.data.map((item: any) => item.title)).toContain("Data Protection for Crisis Response");
    expect((await apiPost(app, "/api/training/courses", "viewer@lot.pl").send({ code: "NOPE", title: "No write" })).status).toBe(403);

    const duplicate = await apiPost(app, "/api/training/courses", "admin@lot.pl").send({
      code: "DATA-CRISIS",
      title: "Duplicate data protection"
    });
    expect(duplicate.status).toBe(409);

    const course = await apiPost(app, "/api/training/courses", "admin@lot.pl").send({
      code: `OPS-${Date.now()}`,
      title: "Operations Handover Practice",
      category: "Coordination",
      deliveryType: "Exercise",
      validityMonths: 18,
      selfCompletable: false
    });
    expect(course.status).toBe(201);
    expect(course.body).toMatchObject({ title: "Operations Handover Practice", active: true });

    const updated = await apiPatch(app, `/api/training/courses/${course.body.id}`, "admin@lot.pl").send({
      title: "Operations Handover Drill",
      expectedUpdatedAt: course.body.updatedAt
    });
    expect(updated.status).toBe(200);
    expect(updated.body.title).toBe("Operations Handover Drill");

    const staleCourse = await apiPatch(app, `/api/training/courses/${course.body.id}`, "admin@lot.pl").send({
      title: "Stale title",
      expectedUpdatedAt: course.body.updatedAt
    });
    expect(staleCourse.status).toBe(409);

    const requirement = await apiPost(app, "/api/training/requirements", "admin@lot.pl").send({
      courseId: course.body.id,
      targetType: "Role",
      targetRole: "ZPP Member",
      requiredStatus: "Required",
      dueAt: "2026-08-01T12:00:00.000Z"
    });
    expect(requirement.status).toBe(201);
    expect(requirement.body).toMatchObject({ targetType: "Role", active: true });
    expect(requirement.body.resolvedMemberCount).toBeGreaterThan(0);

    const duplicateRequirement = await apiPost(app, "/api/training/requirements", "admin@lot.pl").send({
      courseId: course.body.id,
      targetType: "Role",
      targetRole: "ZPP Member",
      requiredStatus: "Required"
    });
    expect(duplicateRequirement.status).toBe(409);

    const deactivated = await apiPost(app, `/api/training/courses/${course.body.id}/deactivate`, "admin@lot.pl").send({
      expectedUpdatedAt: updated.body.updatedAt
    });
    expect(deactivated.status).toBe(200);
    expect(deactivated.body.active).toBe(false);

    const inactiveAssignment = await apiPost(app, "/api/training/records/assign", "coordinator@lot.pl").send({
      memberProfileId: "mem-2026-000008",
      courseId: course.body.id
    });
    expect(inactiveAssignment.status).toBe(409);

    const reactivated = await apiPost(app, `/api/training/courses/${course.body.id}/reactivate`, "admin@lot.pl").send({
      expectedUpdatedAt: deactivated.body.updatedAt
    });
    expect(reactivated.status).toBe(200);
    expect(reactivated.body.active).toBe(true);

    const groupAssignment = await apiPost(app, "/api/training/records/assign", "zpp@lot.pl").send({
      groupId: "grp-2026-000001",
      courseId: course.body.id,
      dueAt: "2026-08-05T12:00:00.000Z"
    });
    expect(groupAssignment.status).toBe(201);
    expect(groupAssignment.body).toMatchObject({ targetType: "Group", assignedCount: expect.any(Number), skippedCount: 0 });
    expect(groupAssignment.body.assignedCount).toBeGreaterThan(0);
    expect(groupAssignment.body.records.every((record: any) => record.courseId === course.body.id)).toBe(true);

    const groupRecords = await apiGet(app, "/api/training/records", "zpp@lot.pl").query({ groupId: "grp-2026-000001", courseId: course.body.id });
    expect(groupRecords.status).toBe(200);
    expect(groupRecords.body.total).toBe(groupAssignment.body.assignedCount);

    const duplicateGroupAssignment = await apiPost(app, "/api/training/records/assign", "zpp@lot.pl").send({
      groupId: "grp-2026-000001",
      courseId: course.body.id
    });
    expect(duplicateGroupAssignment.status).toBe(409);
    expect(duplicateGroupAssignment.body.error).toContain("already have active training");

    const ended = await apiPost(app, `/api/training/requirements/${requirement.body.id}/end`, "admin@lot.pl").send({
      expectedUpdatedAt: requirement.body.updatedAt
    });
    expect(ended.status).toBe(200);
    expect(ended.body.active).toBe(false);
    expect((await apiPatch(app, `/api/training/requirements/${requirement.body.id}`, "admin@lot.pl").send({ requiredStatus: "Recommended" })).status).toBe(409);

    const member = await apiPost(app, "/api/member-profiles", "admin@lot.pl").send({
      memberId: `ZPP-TR-${Date.now()}`,
      firstName: "Archived",
      lastName: "Training",
      assignedFunction: "Training"
    });
    expect(member.status).toBe(201);
    await apiPost(app, `/api/member-profiles/${member.body.id}/archive`, "admin@lot.pl").send({});
    const archivedMemberRequirement = await apiPost(app, "/api/training/requirements", "admin@lot.pl").send({
      courseId: course.body.id,
      targetType: "MemberProfile",
      memberProfileId: member.body.id
    });
    expect(archivedMemberRequirement.status).toBe(409);

    const group = await apiPost(app, "/api/groups", "admin@lot.pl").send({
      sessionId: "ses-demo-1",
      pool: "ZPP",
      name: `Training Archive Group ${Date.now()}`,
      functionName: "Training",
      status: "Active"
    });
    expect(group.status).toBe(201);
    await apiPost(app, `/api/groups/${group.body.id}/archive`, "admin@lot.pl").send({});
    const archivedGroupRequirement = await apiPost(app, "/api/training/requirements", "admin@lot.pl").send({
      courseId: course.body.id,
      targetType: "Group",
      groupId: group.body.id
    });
    expect(archivedGroupRequirement.status).toBe(409);

    const audit = await apiGet(app, "/api/audit-logs", "admin@lot.pl").query({ sessionId: "ses-demo-1" });
    const summaries = audit.body.data.map((item: any) => item.summary);
    expect(summaries).toEqual(expect.arrayContaining([
      "Course created",
      "Course updated",
      "Course deactivated",
      "Course reactivated",
      "Requirement added",
      "Requirement ended",
      "Training assigned to group"
    ]));
    expect(summaries.join(" ")).not.toMatch(/demo|in-memory|reset on restart|database/i);
  });

  it("serves personal document obligations and acknowledgements through the API", async () => {
    const app = createApp();

    const personal = await apiGet(app, "/api/documents", "volunteer@lot.pl").query({ mine: true });
    expect(personal.status).toBe(200);
    expect(personal.body.linkedMemberProfile).toMatchObject({ id: "mem-2026-000008", memberId: "ZPP-221" });
    expect(personal.body.data.length).toBeGreaterThan(0);

    const roleCards = personal.body.data.find((item: any) => item.code === "ERP-ROLE-CARDS");
    expect(roleCards).toBeTruthy();
    expect(roleCards.status).toBe("Required");
    expect(roleCards.reasons.map((reason: any) => reason.targetType)).toContain("Role");

    const content = await apiGet(app, `/api/document-versions/${roleCards.documentVersionId}/content`, "volunteer@lot.pl");
    expect(content.status).toBe(200);
    expect(content.body).toMatchObject({ id: roleCards.documentVersionId, contentMode: "Internal text" });
    expect(content.body.contentBody).toContain("Use these role cards");
    expect(JSON.stringify(content.body)).not.toMatch(/demo|in-memory|reset on restart|database not connected|temporary storage/i);

    const acknowledged = await apiPost(app, `/api/document-versions/${roleCards.documentVersionId}/acknowledge`, "volunteer@lot.pl").send({});
    expect(acknowledged.status).toBe(201);
    expect(acknowledged.body).toMatchObject({ documentVersionId: roleCards.documentVersionId, memberProfileId: "mem-2026-000008", duplicate: false });

    const duplicate = await apiPost(app, `/api/document-versions/${roleCards.documentVersionId}/acknowledge`, "volunteer@lot.pl").send({});
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toMatchObject({ id: acknowledged.body.id, duplicate: true });

    const after = await apiGet(app, "/api/documents", "volunteer@lot.pl").query({ mine: true });
    expect(after.body.data.find((item: any) => item.documentVersionId === roleCards.documentVersionId)).toMatchObject({ status: "Acknowledged" });

    const blockedContent = await apiGet(app, `/api/document-versions/${roleCards.documentVersionId}/content`, "tec@lot.pl");
    expect(blockedContent.status).toBe(403);

    const audit = await apiGet(app, "/api/audit-logs", "admin@lot.pl").query({ sessionId: "ses-demo-1" });
    const documentAcks = audit.body.data.filter((item: any) => item.action === "acknowledge_document" && item.entityId === acknowledged.body.id);
    expect(documentAcks).toHaveLength(1);
    expect(audit.body.data.map((item: any) => item.summary)).toContain("Document acknowledged");
    expect(audit.body.data.map((item: any) => item.summary).join(" ")).not.toMatch(/demo|in-memory|reset on restart|database/i);
  });

  it("manages document versions and ongoing group requirements with RBAC and conflicts", async () => {
    const app = createApp();
    const code = `OPS-DOC-${Date.now()}`;

    const created = await apiPost(app, "/api/documents", "admin@lot.pl").send({
      code,
      title: "Operations Handover Note",
      description: "Coordinator handover reference.",
      category: "Coordination",
      ownerFunction: "Crisis Coordination"
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ code, active: true });

    const blockedCreate = await apiPost(app, "/api/documents", "viewer@lot.pl").send({ code: `${code}-VIEW`, title: "No write" });
    expect(blockedCreate.status).toBe(403);

    const draft = await apiPost(app, `/api/documents/${created.body.id}/versions`, "admin@lot.pl").send({
      versionLabel: "v1.0",
      contentMode: "Internal text",
      contentBody: "Confirm the outgoing coordinator, incoming owner and open decisions.",
      changeSummary: "Initial controlled version."
    });
    expect(draft.status).toBe(201);
    expect(draft.body).toMatchObject({ status: "Draft", contentAvailable: true });

    const draftRequirement = await apiPost(app, "/api/document-requirements", "admin@lot.pl").send({
      documentVersionId: draft.body.id,
      targetType: "Group",
      groupId: "grp-2026-000001"
    });
    expect(draftRequirement.status).toBe(409);

    const stalePublish = await apiPost(app, `/api/document-versions/${draft.body.id}/publish`, "admin@lot.pl").send({
      expectedUpdatedAt: "2026-01-01T00:00:00.000Z"
    });
    expect(stalePublish.status).toBe(409);

    const published = await apiPost(app, `/api/document-versions/${draft.body.id}/publish`, "admin@lot.pl").send({
      expectedUpdatedAt: draft.body.updatedAt
    });
    expect(published.status).toBe(200);
    expect(published.body.status).toBe("Published");

    const editPublished = await apiPatch(app, `/api/document-versions/${draft.body.id}`, "admin@lot.pl").send({
      contentBody: "This must not replace a published version."
    });
    expect(editPublished.status).toBe(409);

    const requirement = await apiPost(app, "/api/document-requirements", "zpp@lot.pl").send({
      documentVersionId: published.body.id,
      targetType: "Group",
      groupId: "grp-2026-000001",
      dueAt: "2026-08-01T08:00:00.000Z"
    });
    expect(requirement.status).toBe(201);
    expect(requirement.body).toMatchObject({ targetType: "Group", targetLabel: "Family Assistance Alpha", active: true });
    expect(requirement.body.resolvedMemberCount).toBeGreaterThan(0);

    const duplicateRequirement = await apiPost(app, "/api/document-requirements", "zpp@lot.pl").send({
      documentVersionId: published.body.id,
      targetType: "Group",
      groupId: "grp-2026-000001"
    });
    expect(duplicateRequirement.status).toBe(409);

    const zppMine = await apiGet(app, "/api/documents", "zpp@lot.pl").query({ mine: true });
    expect(zppMine.status).toBe(200);
    expect(zppMine.body.data.map((item: any) => item.documentVersionId)).toContain(published.body.id);

    const ended = await apiPost(app, `/api/document-requirements/${requirement.body.id}/end`, "zpp@lot.pl").send({
      expectedUpdatedAt: requirement.body.updatedAt
    });
    expect(ended.status).toBe(200);
    expect(ended.body.active).toBe(false);

    const audit = await apiGet(app, "/api/audit-logs", "admin@lot.pl").query({ sessionId: "ses-demo-1" });
    const summaries = audit.body.data.map((item: any) => item.summary);
    expect(summaries).toEqual(expect.arrayContaining([
      "Document created",
      "Document version created",
      "Document version published",
      "Document requirement created",
      "Document requirement ended"
    ]));
    expect(summaries.join(" ")).not.toMatch(/demo|in-memory|reset on restart|database/i);
  });

  it("serves explainable readiness from source modules with scoped access", async () => {
    const app = createApp();
    const evaluationAt = "2026-07-13T09:00:00.000Z";

    const personal = await apiGet(app, "/api/readiness/me", "volunteer@lot.pl").query({ evaluationAt });
    expect(personal.status).toBe(200);
    expect(personal.body.member).toMatchObject({ id: "mem-2026-000008", memberId: "ZPP-221" });
    expect(personal.body.overallStatus).toMatch(/Ready|Not ready|Unknown|Not applicable/);
    expect(personal.body.dimensions.map((item: any) => item.key)).toEqual(expect.arrayContaining(["profile", "training", "documents", "availability", "roster"]));
    expect(personal.body).not.toHaveProperty("readinessScore");
    expect(JSON.stringify(personal.body)).not.toMatch(/readinessScore|in-memory|reset on restart|database not connected|temporary storage/i);
    expect(personal.body.nextActions.every((action: any) => String(action.href).startsWith("/"))).toBe(true);

    const blockedMembers = await apiGet(app, "/api/readiness/members", "volunteer@lot.pl").query({ evaluationAt });
    expect(blockedMembers.status).toBe(403);

    const viewerSummary = await apiGet(app, "/api/readiness/summary", "viewer@lot.pl").query({ evaluationAt });
    expect(viewerSummary.status).toBe(200);
    expect(viewerSummary.body.totalMembers).toBeGreaterThan(0);
    expect(viewerSummary.body.byStatus).toHaveProperty("Ready");

    const viewerMembers = await apiGet(app, "/api/readiness/members", "viewer@lot.pl").query({ evaluationAt });
    expect(viewerMembers.status).toBe(403);

    const zppMembers = await apiGet(app, "/api/readiness/members", "zpp@lot.pl").query({ evaluationAt, limit: 200 });
    expect(zppMembers.status).toBe(200);
    expect(zppMembers.body.data.length).toBeGreaterThan(0);
    expect(zppMembers.body.data.map((item: any) => item.member.pool)).not.toContain("TEC");

    const beforeWarnings = personal.body.warnings.length;
    const trainingRecords = await apiGet(app, "/api/training/records", "volunteer@lot.pl").query({ mine: true, search: "Data Protection" });
    const dataProtectionRecord = trainingRecords.body.data.find((item: any) => item.course.code === "DATA-CRISIS");
    expect(dataProtectionRecord).toBeTruthy();

    const completed = await apiPost(app, `/api/training/records/${dataProtectionRecord.id}/complete`, "volunteer@lot.pl").send({
      expectedUpdatedAt: dataProtectionRecord.updatedAt,
      completedAt: "2026-07-13T10:00:00.000Z"
    });
    expect(completed.status).toBe(200);

    const afterTraining = await apiGet(app, "/api/readiness/me", "volunteer@lot.pl").query({ evaluationAt: "2026-07-13T10:30:00.000Z" });
    expect(afterTraining.status).toBe(200);
    expect(afterTraining.body.warnings.length).toBeLessThan(beforeWarnings);
    expect(afterTraining.body.warnings.map((item: any) => item.title).join(" ")).not.toContain("Data Protection for Crisis Response");
  });

  it("keeps temporary training mutations process-local while exposing production-shaped responses", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    const app = createApp();
    const health = await request(app).get("/api/health");
    expect(health.status).toBe(200);
    expect(health.body.ok).toBe(true);
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;

    const code = `LOCAL-${Date.now()}`;
    const created = await apiPost(app, "/api/training/courses", "admin@lot.pl").send({
      code,
      title: "Local process training check",
      category: "Coordination"
    });
    expect(created.status).toBe(201);

    const sameProcess = await apiGet(app, "/api/training/courses", "admin@lot.pl").query({ search: code });
    expect(sameProcess.body.data.map((item: any) => item.id)).toContain(created.body.id);

    const freshProcess = await apiGet(createApp(), "/api/training/courses", "admin@lot.pl").query({ search: code });
    expect(freshProcess.body.data.map((item: any) => item.id)).not.toContain(created.body.id);
    expect(JSON.stringify(freshProcess.body)).not.toMatch(/in-memory|reset on restart|database not connected|temporary storage/i);
  });

  it("keeps temporary rostering mutations process-local while exposing production-shaped responses", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    const app = createApp();
    const health = await request(app).get("/api/health");
    expect(health.status).toBe(200);
    expect(health.body.ok).toBe(true);
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;

    const created = await apiPost(app, "/api/roster-shifts", "zpp@lot.pl").send({
      sessionId: "ses-demo-1",
      groupId: "grp-2026-000001",
      title: "Process local roster check",
      duty: "Coverage check",
      functionName: "Welfare Support",
      startAt: "2026-07-17T06:00:00.000Z",
      endAt: "2026-07-17T14:00:00.000Z"
    });
    expect(created.status).toBe(201);

    const sameProcess = await apiGet(app, "/api/roster-shifts", "zpp@lot.pl").query({ sessionId: "ses-demo-1" });
    expect(sameProcess.body.data.map((item: any) => item.id)).toContain(created.body.id);

    const freshProcess = await apiGet(createApp(), "/api/roster-shifts", "zpp@lot.pl").query({ sessionId: "ses-demo-1" });
    expect(freshProcess.body.data.map((item: any) => item.id)).not.toContain(created.body.id);
    expect(JSON.stringify(freshProcess.body)).not.toMatch(/in-memory|reset on restart|database not connected|temporary storage/i);
  });

  it("serves personal entity-derived notifications with read and unread state", async () => {
    const app = createApp();
    const list = await apiGet(app, "/api/notifications", "volunteer@lot.pl");
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBeGreaterThan(0);
    expect(list.body.data.every((item: any) => item.recipientUserId === demoIds.volunteer)).toBe(true);
    expect(list.body.data.some((item: any) => item.sourceType === "assignment" && item.sourceId === "asn-demo-1")).toBe(true);
    expect(list.body.data.some((item: any) => item.kind === "Action required" && item.active)).toBe(true);
    expect(list.body.data.some((item: any) => item.kind === "Information")).toBe(true);
    expect(list.body.data.some((item: any) => item.audience)).toBe(false);
    for (const item of list.body.data) {
      expect(`${item.title} ${item.message} ${item.actionLabel ?? ""}`).not.toMatch(/demo|in-memory|reset on restart|database not connected|temporary storage/i);
    }

    const unread = list.body.data.find((item: any) => item.unread);
    expect(unread).toBeTruthy();
    const beforeCounts = await apiGet(app, "/api/notifications/counts", "volunteer@lot.pl");
    expect(beforeCounts.status).toBe(200);
    expect(beforeCounts.body.unread).toBeGreaterThan(0);

    const fetched = await apiGet(app, `/api/notifications/${unread.id}`, "volunteer@lot.pl");
    expect(fetched.status).toBe(200);
    expect(fetched.body.id).toBe(unread.id);

    const crossUserRead = await apiPost(app, `/api/notifications/${unread.id}/read`, "coordinator@lot.pl").send({});
    expect(crossUserRead.status).toBe(404);

    const read = await apiPost(app, `/api/notifications/${unread.id}/read`, "volunteer@lot.pl").send({});
    expect(read.status).toBe(200);
    expect(read.body.read).toBe(true);
    expect(read.body.resolved).toBe(false);

    const afterReadCounts = await apiGet(app, "/api/notifications/counts", "volunteer@lot.pl");
    expect(afterReadCounts.body.unread).toBe(beforeCounts.body.unread - 1);

    const unreadAgain = await apiPost(app, `/api/notifications/${unread.id}/unread`, "volunteer@lot.pl").send({});
    expect(unreadAgain.status).toBe(200);
    expect(unreadAgain.body.unread).toBe(true);

    const readAll = await apiPost(app, "/api/notifications/read-all", "volunteer@lot.pl").send({});
    expect(readAll.status).toBe(200);
    expect(readAll.body.data.every((item: any) => item.read)).toBe(true);
    const finalCounts = await apiGet(app, "/api/notifications/counts", "volunteer@lot.pl");
    expect(finalCounts.body.unread).toBe(0);
  });

  it("derives notifications from source workflow events without generic create or resolve routes", async () => {
    const app = createApp();
    const created = await apiPost(app, "/api/assignments").send({
      sessionId: "ses-demo-1",
      title: "Check family assistance handover",
      operationId: randomUUID()
    });
    expect(created.status).toBe(201);

    const assigned = await apiPost(app, `/api/assignments/${created.body.id}/assign`).send({
      sessionId: "ses-demo-1",
      expectedVersion: created.body.version,
      operationId: randomUUID(),
      assignedUserId: demoIds.volunteer
    });
    expect(assigned.status).toBe(200);

    const volunteerFeed = await apiGet(app, "/api/notifications", "volunteer@lot.pl").query({ sourceType: "assignment", limit: 100 });
    expect(volunteerFeed.status).toBe(200);
    expect(volunteerFeed.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "Information",
        category: "Assignment",
        sourceType: "assignment",
        sourceId: created.body.id,
        actionDestination: `/assignments?assignmentId=${created.body.id}`
      }),
      expect.objectContaining({
        kind: "Action required",
        category: "Assignment",
        sourceType: "assignment",
        sourceId: created.body.id,
        active: true,
        resolved: false
      })
    ]));

    const completed = await apiPost(app, `/api/assignments/${created.body.id}/start`, "volunteer@lot.pl").send({ sessionId: "ses-demo-1", expectedVersion: assigned.body.version });
    expect(completed.status).toBe(200);
    const done = await apiPost(app, `/api/assignments/${created.body.id}/complete`, "volunteer@lot.pl").send({ sessionId: "ses-demo-1", expectedVersion: completed.body.version, operationId: randomUUID() });
    expect(done.status).toBe(200);

    const resolvedFeed = await apiGet(app, "/api/notifications", "volunteer@lot.pl").query({ sourceType: "assignment", status: "resolved", limit: 100 });
    expect(resolvedFeed.body.data.some((item: any) => item.sourceId === created.body.id && item.resolved)).toBe(true);

    expect((await apiPost(app, "/api/notifications", "volunteer@lot.pl").send({ title: "Manual" })).status).toBe(404);
    expect((await apiPost(app, `/api/notifications/${resolvedFeed.body.data[0].id}/resolve`, "volunteer@lot.pl").send({})).status).toBe(404);
  });

  it("keeps viewers from receiving hidden operational notification details", async () => {
    const app = createApp();
    const viewerFeed = await apiGet(app, "/api/notifications", "viewer@lot.pl");
    expect(viewerFeed.status).toBe(200);
    expect(viewerFeed.body.data).toEqual([]);
    const viewerCounts = await apiGet(app, "/api/notifications/counts", "viewer@lot.pl");
    expect(viewerCounts.status).toBe(200);
    expect(viewerCounts.body.unread).toBe(0);
    expect(viewerCounts.body.actionRequired).toBe(0);
  });

  it("Stage 3E2: administers account lifecycle with dedicated status actions", async () => {
    const app = createApp();
    const users = await apiGet(app, "/api/admin/users", "admin@lot.pl");
    expect(users.status).toBe(200);
    expect(users.body.total).toBeGreaterThanOrEqual(13);
    expect(users.body.data.map((user: any) => user.id)).toEqual(expect.arrayContaining([
      demoIds.admin,
      demoIds.security,
      demoIds.pending,
      demoIds.suspended,
      demoIds.archived
    ]));
    expect(JSON.stringify(users.body)).not.toMatch(/in-memory|reset on restart|database not connected|source not connected/i);
    expect((await apiGet(app, "/api/admin/users", "viewer@lot.pl")).status).toBe(403);

    const email = `stage-3e2-${Date.now()}@lot.pl`;
    const created = await apiPost(app, "/api/admin/users", "admin@lot.pl").send({
      displayName: "Stage Access Tester",
      email,
      employeeId: "STAGE-3E2",
      department: "Access"
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: "usr-2026-000014", email, status: "Pending" });
    expect((await apiPost(app, "/api/admin/users", "admin@lot.pl").send({ displayName: "Duplicate", email })).status).toBe(409);
    expect((await apiPatch(app, `/api/admin/users/${created.body.id}`, "admin@lot.pl").send({ status: "Active" })).status).toBe(400);
    expect((await apiPost(app, `/api/admin/users/${created.body.id}/activate`, "admin@lot.pl").send({ expectedVersion: 0 })).status).toBe(409);

    const changed = await apiPatch(app, `/api/admin/users/${created.body.id}`, "admin@lot.pl").send({
      displayName: "Stage Access Tester Updated",
      department: "Access Review",
      expectedVersion: created.body.version,
      actorId: demoIds.viewer
    });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ displayName: "Stage Access Tester Updated", department: "Access Review" });

    const activated = await apiPost(app, `/api/admin/users/${created.body.id}/activate`, "admin@lot.pl").send({ expectedVersion: changed.body.version });
    expect(activated.status).toBe(200);
    expect(activated.body.status).toBe("Active");
    expect((await apiPost(app, `/api/admin/users/${created.body.id}/suspend`, "admin@lot.pl").send({ expectedVersion: activated.body.version })).status).toBe(400);

    const suspended = await apiPost(app, `/api/admin/users/${created.body.id}/suspend`, "admin@lot.pl").send({
      expectedVersion: activated.body.version,
      reason: "Training account no longer required."
    });
    expect(suspended.status).toBe(200);
    expect(suspended.body.status).toBe("Suspended");
    expect((await apiGet(app, "/api/auth/me", email)).status).toBe(401);

    const activateSuspended = await apiPost(app, `/api/admin/users/${created.body.id}/activate`, "admin@lot.pl").send({ expectedVersion: suspended.body.version });
    expect(activateSuspended.status).toBe(409);
    expect(activateSuspended.body.error).toContain("Use Restore");
    const reactivated = await apiPost(app, `/api/admin/users/${created.body.id}/restore`, "admin@lot.pl").send({ expectedVersion: suspended.body.version });
    expect(reactivated.status).toBe(200);
    expect(reactivated.body.status).toBe("Active");
    const archived = await apiPost(app, `/api/admin/users/${created.body.id}/archive`, "admin@lot.pl").send({
      expectedVersion: reactivated.body.version,
      reason: "Account closed after test."
    });
    expect(archived.status).toBe(200);
    expect(archived.body.status).toBe("Archived");
    expect((await apiGet(app, "/api/auth/me", email)).status).toBe(401);

    const restored = await apiPost(app, `/api/admin/users/${created.body.id}/restore`, "admin@lot.pl").send({ expectedVersion: archived.body.version });
    expect(restored.status).toBe(200);
    expect(restored.body.status).toBe("Pending");
    const history = await apiGet(app, `/api/admin/users/${created.body.id}/access-history`, "admin@lot.pl");
    expect(history.body.data.map((item: any) => item.action)).toEqual(expect.arrayContaining([
      "user_created",
      "user_metadata_changed",
      "user_activated",
      "user_suspended",
      "user_archived",
      "user_restored"
    ]));
    expect(history.body.data.every((item: any) => item.actorId === demoIds.admin)).toBe(true);
    expect(history.body.data.map((item: any) => item.actorId)).not.toContain(demoIds.viewer);
    expect(history.body.data.find((item: any) => item.action === "user_metadata_changed")?.metadata).toMatchObject({
      targetUserId: created.body.id,
      previous: { displayName: "Stage Access Tester", department: "Access" },
      next: { displayName: "Stage Access Tester Updated", department: "Access Review" }
    });
  });

  it("Stage 3E2: administers role assignments, custom roles and access notifications", async () => {
    const app = createApp();
    const roles = await apiGet(app, "/api/admin/roles", "admin@lot.pl");
    expect(roles.status).toBe(200);
    expect(roles.body.data.filter((role: any) => role.protected)).toHaveLength(8);
    expect(roles.body.data.map((role: any) => role.name)).toContain("incident-auditor");

    const custom = await apiPost(app, "/api/admin/roles", "admin@lot.pl").send({
      name: "handover-reviewer",
      displayName: "Handover Reviewer",
      description: "Can review handover and session material.",
      permissions: ["session:read", "audit:read"]
    });
    expect(custom.status).toBe(201);
    expect(custom.body).toMatchObject({ name: "handover-reviewer", custom: true, status: "Active" });
    expect((await apiPost(app, "/api/admin/roles", "admin@lot.pl").send({ displayName: "Unsafe Admin", permissions: ["admin:manage"] })).status).toBe(403);
    expect((await apiPost(app, "/api/admin/roles/system-admin/archive", "admin@lot.pl").send({})).status).toBe(409);

    const changedRole = await apiPatch(app, `/api/admin/roles/${custom.body.id}`, "admin@lot.pl").send({
      expectedVersion: custom.body.version,
      description: "Can review handover material and reports.",
      permissions: ["audit:read", "reports:read"]
    });
    expect(changedRole.status).toBe(200);
    expect(changedRole.body.permissions).toEqual(["audit:read", "reports:read"]);

    const viewerRole = await apiPost(app, `/api/admin/users/${demoIds.viewer}/role-assignments`, "admin@lot.pl").send({
      roleName: "handover-reviewer",
      scopeType: "GLOBAL"
    });
    expect(viewerRole.status).toBe(201);
    expect((await apiPost(app, `/api/admin/users/${demoIds.viewer}/role-assignments`, "admin@lot.pl").send({ roleName: "handover-reviewer", scopeType: "GLOBAL" })).status).toBe(409);

    const firstScoped = await apiPost(app, `/api/admin/users/${demoIds.volunteer}/role-assignments`, "admin@lot.pl").send({
      roleName: "zpp-group-leader",
      scopeType: "GROUP",
      scopeId: "grp-2026-000001"
    });
    const secondScoped = await apiPost(app, `/api/admin/users/${demoIds.volunteer}/role-assignments`, "admin@lot.pl").send({
      roleName: "zpp-group-leader",
      scopeType: "GROUP",
      scopeId: "grp-2026-000003"
    });
    expect(firstScoped.status).toBe(201);
    expect(secondScoped.status).toBe(201);
    expect((await apiPost(app, `/api/admin/users/${demoIds.volunteer}/role-assignments`, "admin@lot.pl").send({ roleName: "zpp-group-leader", scopeType: "GROUP", scopeId: "grp-2026-000002" })).status).toBe(400);
    expect((await apiPost(app, `/api/admin/users/${demoIds.tec}/role-assignments`, "admin@lot.pl").send({ roleName: "tec-group-leader", scopeType: "GROUP", scopeId: "grp-2026-000001" })).status).toBe(400);

    const revoked = await apiPost(app, `/api/admin/users/${demoIds.volunteer}/role-assignments/${firstScoped.body.id}/revoke`, "admin@lot.pl").send({});
    expect(revoked.status).toBe(200);
    expect(revoked.body.status).toBe("Revoked");
    const archived = await apiPost(app, `/api/admin/roles/${custom.body.id}/archive`, "admin@lot.pl").send({ expectedVersion: changedRole.body.version });
    expect(archived.status).toBe(200);
    expect(archived.body.status).toBe("Archived");

    const effective = await apiGet(app, `/api/admin/users/${demoIds.volunteer}/effective-access`, "admin@lot.pl");
    expect(effective.body.assignedRoles.some((item: any) => item.scopeType === "GROUP" && item.scopeLabel)).toBe(true);
    const audit = await apiGet(app, `/api/admin/users/${demoIds.viewer}/access-history`, "admin@lot.pl");
    expect(audit.body.data.map((item: any) => item.action)).toEqual(expect.arrayContaining(["role_assigned"]));
    const roleAudit = await apiGet(app, "/api/audit-logs", "admin@lot.pl").query({ limit: 200 });
    const roleAuditActions = roleAudit.body.data.filter((item: any) => item.entityId === custom.body.id).map((item: any) => item.action);
    expect(roleAuditActions).toEqual(expect.arrayContaining([
      "custom_role_created",
      "custom_role_changed",
      "role_capability_added",
      "role_capability_removed",
      "custom_role_archived"
    ]));
    expect(roleAudit.body.data.find((item: any) => item.entityId === custom.body.id && item.action === "custom_role_changed")?.metadata).toMatchObject({
      roleId: custom.body.id,
      previousPermissions: ["session:read", "audit:read"],
      nextPermissions: ["audit:read", "reports:read"],
      addedPermissions: ["reports:read"],
      removedPermissions: ["session:read"]
    });
    const notifications = await apiGet(app, "/api/notifications", "viewer@lot.pl");
    expect(notifications.body.data.map((item: any) => item.title)).toContain("Role assignment changed");
  });

  it("Stage 3E2: applies grants and denies through the server effective-access service", async () => {
    const app = createApp();
    const initial = await apiGet(app, `/api/admin/users/${demoIds.viewer}/effective-access`, "admin@lot.pl");
    expect(initial.status).toBe(200);
    expect(initial.body.data.find((item: any) => item.permission === "reports:read")).toMatchObject({ decision: "Allowed", source: "User Grant" });
    expect(initial.body.data.find((item: any) => item.permission === "export:create")).toMatchObject({ decision: "Denied", source: "User Deny" });
    expect(initial.body.data.find((item: any) => item.permission === "admin:manage")).toMatchObject({ decision: "Not granted" });
    expect((await apiPost(app, `/api/admin/users/${demoIds.viewer}/capability-overrides`, "admin@lot.pl").send({ permission: "group:read", effect: "GRANT" })).status).toBe(400);

    const grant = await apiPost(app, `/api/admin/users/${demoIds.viewer}/capability-overrides`, "admin@lot.pl").send({
      permission: "group:read",
      effect: "GRANT",
      reason: "Temporary group review coverage."
    });
    const deny = await apiPost(app, `/api/admin/users/${demoIds.viewer}/capability-overrides`, "admin@lot.pl").send({
      permission: "reports:read",
      effect: "DENY",
      reason: "Report review paused."
    });
    expect(grant.status).toBe(201);
    expect(deny.status).toBe(201);

    const denied = await apiGet(app, `/api/admin/users/${demoIds.viewer}/effective-access`, "admin@lot.pl");
    expect(denied.body.data.find((item: any) => item.permission === "group:read")).toMatchObject({ decision: "Allowed", source: "User Grant" });
    expect(denied.body.data.find((item: any) => item.permission === "reports:read")).toMatchObject({ decision: "Denied", source: "User Deny" });
    expect(denied.body.finalCapabilities).not.toContain("reports:read");

    expect((await apiPost(app, `/api/admin/users/${demoIds.viewer}/capability-overrides/${deny.body.id}/revoke`, "admin@lot.pl").send({})).status).toBe(200);
    const restored = await apiGet(app, `/api/admin/users/${demoIds.viewer}/effective-access`, "admin@lot.pl");
    expect(restored.body.finalCapabilities).toContain("reports:read");
    expect(restored.body.user.roles).toEqual(expect.arrayContaining(["observer"]));
    const history = await apiGet(app, `/api/admin/users/${demoIds.viewer}/access-history`, "admin@lot.pl");
    expect(history.body.data.map((item: any) => item.action)).toEqual(expect.arrayContaining([
      "user_grant_created",
      "user_deny_created",
      "capability_override_revoked"
    ]));
    expect(history.body.data.find((item: any) => item.action === "user_grant_created")?.metadata).toMatchObject({
      targetUserId: demoIds.viewer,
      permission: "group:read",
      reason: "Temporary group review coverage."
    });
    expect(history.body.data.find((item: any) => item.action === "user_deny_created")?.metadata).toMatchObject({
      targetUserId: demoIds.viewer,
      permission: "reports:read",
      reason: "Report review paused."
    });
    expect((await apiPost(app, `/api/admin/users/${demoIds.viewer}/capability-overrides`, "volunteer@lot.pl").send({ permission: "group:read", effect: "GRANT", reason: "Not authorized." })).status).toBe(403);
  });

  it("Stage 3E2: protects the final administrative access path", async () => {
    const app = createApp();
    const security = await apiGet(app, `/api/admin/users/${demoIds.security}`, "admin@lot.pl");
    const multiRole = await apiGet(app, `/api/admin/users/${demoIds.multiRole}`, "admin@lot.pl");
    expect((await apiPost(app, `/api/admin/users/${demoIds.security}/suspend`, "admin@lot.pl").send({ expectedVersion: security.body.version, reason: "Safeguard transfer test." })).status).toBe(200);
    expect((await apiPost(app, `/api/admin/users/${demoIds.multiRole}/suspend`, "admin@lot.pl").send({ expectedVersion: multiRole.body.version, reason: "Safeguard transfer test." })).status).toBe(200);

    const admin = await apiGet(app, `/api/admin/users/${demoIds.admin}`, "admin@lot.pl");
    const suspendLast = await apiPost(app, `/api/admin/users/${demoIds.admin}/suspend`, "admin@lot.pl").send({
      expectedVersion: admin.body.version,
      reason: "Attempt to remove final administrator."
    });
    expect(suspendLast.status).toBe(409);
    expect(suspendLast.body.error).toContain("You cannot suspend or archive your own account");
    expect((await apiPost(app, `/api/admin/users/${demoIds.admin}/archive`, "admin@lot.pl").send({ expectedVersion: admin.body.version, reason: "Attempt to archive final administrator." })).status).toBe(409);
    const selfPolicyChange = await apiPost(app, `/api/admin/users/${demoIds.admin}/authentication-policy`, "admin@lot.pl").send({
      expectedVersion: admin.body.version,
      authenticationPolicy: "PASSWORD_ONLY",
      reason: "Attempt to remove final administrator sign-in options."
    });
    expect(selfPolicyChange.status).toBe(409);
    expect(selfPolicyChange.body.error).toContain("Ask another active System Admin");

    const adminRoleAssignment = admin.body.roleAssignments.find((item: any) => item.roleName === "system-admin");
    expect((await apiPost(app, `/api/admin/users/${demoIds.admin}/role-assignments/${adminRoleAssignment.id}/revoke`, "admin@lot.pl").send({})).status).toBe(409);
    expect((await apiPost(app, `/api/admin/users/${demoIds.admin}/capability-overrides`, "admin@lot.pl").send({
      permission: "admin:manage",
      effect: "DENY",
      reason: "Attempt to deny final administrator."
    })).status).toBe(409);
    expect((await apiPatch(app, "/api/admin/roles/system-admin", "admin@lot.pl").send({
      permissions: ["session:read"],
      expectedVersion: 1
    })).status).toBe(409);
  });

  it("Stage 3F3: reviews account impact and enforces explicit lifecycle transitions", async () => {
    const app = createApp();
    const before = await apiGet(app, `/api/admin/users/${demoIds.volunteer}`, "admin@lot.pl");
    expect(before.status).toBe(200);
    const impact = await apiGet(app, `/api/admin/users/${demoIds.volunteer}/lifecycle-impact`, "admin@lot.pl");
    expect(impact.status).toBe(200);
    expect(impact.body).toMatchObject({
      available: true,
      memberProfile: { linked: true },
      assignments: expect.objectContaining({ active: expect.any(Number) }),
      groups: expect.objectContaining({ memberships: expect.any(Number) }),
      access: expect.objectContaining({ roleAssignments: before.body.roleAssignments.length })
    });
    expect(JSON.stringify(impact.body)).not.toMatch(/passwordHash|temporaryPassword|rawInvitationToken|providerSubject|tenantId|oauth/i);

    expect((await apiPatch(app, `/api/admin/users/${demoIds.volunteer}`, "admin@lot.pl").send({ status: "Suspended" })).status).toBe(400);
    expect((await apiPatch(app, `/api/admin/users/${demoIds.volunteer}`, "admin@lot.pl").send({ authenticationPolicy: "PASSWORD_ONLY" })).status).toBe(400);
    const activateActive = await apiPost(app, `/api/admin/users/${demoIds.volunteer}/activate`, "admin@lot.pl").send({ expectedVersion: before.body.version });
    expect(activateActive.status).toBe(409);
    expect(activateActive.body.error).toContain("Only pending accounts");
    expect((await apiPost(app, `/api/admin/users/${demoIds.volunteer}/suspend`, "admin@lot.pl").send({ expectedVersion: before.body.version })).status).toBe(400);

    const suspended = await apiPost(app, `/api/admin/users/${demoIds.volunteer}/suspend`, "admin@lot.pl").send({
      expectedVersion: before.body.version,
      reason: "Temporary access hold."
    });
    expect(suspended.status).toBe(200);
    expect(suspended.body.status).toBe("Suspended");
    expect(suspended.body.linkedMemberProfileId).toBe(before.body.linkedMemberProfileId);
    expect(suspended.body.roleAssignments.map((item: any) => item.roleName)).toEqual(before.body.roleAssignments.map((item: any) => item.roleName));

    const activateSuspended = await apiPost(app, `/api/admin/users/${demoIds.volunteer}/activate`, "admin@lot.pl").send({ expectedVersion: suspended.body.version });
    expect(activateSuspended.status).toBe(409);
    expect(activateSuspended.body.error).toContain("Use Restore");
    const restoredActive = await apiPost(app, `/api/admin/users/${demoIds.volunteer}/restore`, "admin@lot.pl").send({ expectedVersion: suspended.body.version });
    expect(restoredActive.status).toBe(200);
    expect(restoredActive.body.status).toBe("Active");

    const archived = await apiPost(app, `/api/admin/users/${demoIds.volunteer}/archive`, "admin@lot.pl").send({
      expectedVersion: restoredActive.body.version,
      reason: "Archive after access review."
    });
    expect(archived.status).toBe(200);
    expect(archived.body.status).toBe("Archived");
    const restoredPending = await apiPost(app, `/api/admin/users/${demoIds.volunteer}/restore`, "admin@lot.pl").send({ expectedVersion: archived.body.version });
    expect(restoredPending.status).toBe(200);
    expect(restoredPending.body.status).toBe("Pending");
    expect(restoredPending.body.linkedMemberProfileId).toBe(before.body.linkedMemberProfileId);

    const history = await apiGet(app, `/api/admin/users/${demoIds.volunteer}/access-history`, "admin@lot.pl");
    expect(history.body.data.map((item: any) => item.action)).toEqual(expect.arrayContaining(["user_suspended", "user_restored", "user_archived"]));
    const suspendAudit = history.body.data.find((item: any) => item.action === "user_suspended");
    expect(suspendAudit?.metadata.responsibilities).toMatchObject({
      available: true,
      memberProfile: { linked: true },
      access: expect.objectContaining({ roleAssignments: before.body.roleAssignments.length })
    });
  });

  it("Stage 3F3: changes authentication policy through a dedicated audited action", async () => {
    const app = createApp();
    const token = `3f3-policy-${Date.now()}`;
    const invitation = await apiPost(app, "/api/admin/invitations", "admin@lot.pl").send({
      displayName: "Stage 3F3 Policy User",
      email: `policy-${token}@example.test`,
      authenticationPolicy: "SSO_OR_PASSWORD",
      roleAssignments: [{ roleName: "observer", scopeType: "GLOBAL" }]
    });
    expect(invitation.status).toBe(201);
    const accepted = await apiPost(app, `/api/admin/invitations/${invitation.body.id}/local-accept`, "admin@lot.pl").send({
      expectedGeneration: invitation.body.resendGeneration,
      methodChoice: "PASSWORD_ONLY"
    });
    expect(accepted.status).toBe(200);
    const userId = invitation.body.user.id;
    const before = await apiGet(app, `/api/admin/users/${userId}`, "admin@lot.pl");
    expect(before.body.authenticationPolicy).toBe("SSO_OR_PASSWORD");
    expect(before.body.invitationStatus).toBe("Accepted");

    const missingReason = await apiPost(app, `/api/admin/users/${userId}/authentication-policy`, "admin@lot.pl").send({
      expectedVersion: before.body.version,
      authenticationPolicy: "PASSWORD_ONLY"
    });
    expect(missingReason.status).toBe(400);
    const updated = await apiPost(app, `/api/admin/users/${userId}/authentication-policy`, "admin@lot.pl").send({
      expectedVersion: before.body.version,
      authenticationPolicy: "PASSWORD_ONLY",
      reason: "Restrict account sign-in for this role."
    });
    expect(updated.status).toBe(200);
    expect(updated.body.authenticationPolicy).toBe("PASSWORD_ONLY");
    expect(updated.body.roleAssignments.map((item: any) => item.roleName)).toEqual(before.body.roleAssignments.map((item: any) => item.roleName));
    expect(updated.body.linkedMemberProfileId).toBe(before.body.linkedMemberProfileId);
    expect(updated.body.externalIdentityCount).toBe(before.body.externalIdentityCount);
    expect((await apiPost(app, `/api/admin/users/${userId}/authentication-policy`, "admin@lot.pl").send({
      expectedVersion: updated.body.version,
      authenticationPolicy: "PASSWORD_ONLY",
      reason: "No change."
    })).status).toBe(409);

    const byPolicy = await apiGet(app, "/api/admin/users", "admin@lot.pl").query({ authenticationPolicy: "PASSWORD_ONLY", search: `policy-${token}` });
    expect(byPolicy.body.total).toBe(1);
    expect(byPolicy.body.data[0]).toMatchObject({ id: userId, invitationStatus: "Accepted" });
    const byInvitation = await apiGet(app, "/api/admin/users", "admin@lot.pl").query({ invitationStatus: "Accepted", search: `policy-${token}` });
    expect(byInvitation.body.total).toBe(1);
    const byMissingInvitation = await apiGet(app, "/api/admin/users", "admin@lot.pl").query({ invitationStatus: "None", search: `policy-${token}` });
    expect(byMissingInvitation.body.total).toBe(0);

    const history = await apiGet(app, `/api/admin/users/${userId}/access-history`, "admin@lot.pl");
    expect(history.body.data.map((item: any) => item.action)).toContain("authentication_policy_changed");
    expect(history.body.data.find((item: any) => item.action === "authentication_policy_changed")?.metadata).toMatchObject({
      previousAuthenticationPolicy: "SSO_OR_PASSWORD",
      authenticationPolicy: "PASSWORD_ONLY",
      reason: "Restrict account sign-in for this role."
    });
    expect(JSON.stringify(updated.body)).not.toMatch(/passwordHash|temporaryPassword|rawInvitationToken|providerSubject|tenantId|oauth/i);
  });

  it("Stage 3E2: links users to member profiles by stable IDs without guessing ownership", async () => {
    const app = createApp();
    const token = Date.now();
    const first = await apiPost(app, "/api/member-profiles", "admin@lot.pl").send({
      memberId: `LINK-${token}-A`,
      roleType: "ZPP",
      firstName: "Link",
      lastName: "One",
      functionName: "Welfare Support"
    });
    const second = await apiPost(app, "/api/member-profiles", "admin@lot.pl").send({
      memberId: `LINK-${token}-B`,
      roleType: "ZPP",
      firstName: "Link",
      lastName: "Two",
      functionName: "Welfare Support"
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const linked = await apiPost(app, `/api/admin/users/${demoIds.pending}/member-link`, "admin@lot.pl").send({ memberProfileId: first.body.id });
    expect(linked.status).toBe(200);
    expect(linked.body.user.linkedMemberProfile).toMatchObject({ id: first.body.id });
    expect((await apiPost(app, `/api/admin/users/${demoIds.suspended}/member-link`, "admin@lot.pl").send({ memberProfileId: first.body.id })).status).toBe(409);

    const changed = await apiPost(app, `/api/admin/users/${demoIds.pending}/member-link`, "admin@lot.pl").send({ memberProfileId: second.body.id });
    expect(changed.status).toBe(200);
    expect(changed.body.user.linkedMemberProfile).toMatchObject({ id: second.body.id });
    const unlinked = await apiDelete(app, `/api/admin/users/${demoIds.pending}/member-link`, "admin@lot.pl");
    expect(unlinked.status).toBe(200);
    expect(unlinked.body.linkedMemberProfile).toBeNull();
    expect((await apiGet(app, `/api/member-profiles/${second.body.id}`, "admin@lot.pl")).status).toBe(200);

    const history = await apiGet(app, `/api/admin/users/${demoIds.pending}/access-history`, "admin@lot.pl");
    expect(history.body.data.map((item: any) => item.action)).toEqual(expect.arrayContaining([
      "member_profile_linked",
      "member_profile_link_changed",
      "member_profile_unlinked"
    ]));
  });

  it("Stage 3E3: does not expose fake session revocation as a successful security mutation", async () => {
    const app = createApp();
    const before = await apiGet(app, `/api/admin/users/${demoIds.volunteer}`, "admin@lot.pl");
    const beforeHistory = await apiGet(app, `/api/admin/users/${demoIds.volunteer}/access-history`, "admin@lot.pl");
    const response = await apiPost(app, `/api/admin/users/${demoIds.volunteer}/revoke-sessions`, "admin@lot.pl").send({});
    expect(response.status).toBe(501);
    expect(response.body.error).toBe("Session revocation is not available.");
    const after = await apiGet(app, `/api/admin/users/${demoIds.volunteer}`, "admin@lot.pl");
    expect(after.body).not.toHaveProperty("sessionRevokedAt");
    expect(after.body.status).toBe(before.body.status);
    expect(after.body.roleAssignments.map((item: any) => item.id)).toEqual(before.body.roleAssignments.map((item: any) => item.id));
    const afterHistory = await apiGet(app, `/api/admin/users/${demoIds.volunteer}/access-history`, "admin@lot.pl");
    expect(afterHistory.body.data.length).toBe(beforeHistory.body.data.length);
    expect(afterHistory.body.data.map((item: any) => item.action)).not.toContain("user_sessions_revoked");
  });

  it("Stage 3F1: prepares invitations atomically without exposing credentials or provider secrets", async () => {
    const app = createApp();
    const token = `3f1-${Date.now()}`;
    const forbiddenEmail = `forbidden-${token}@example.test`;
    const forbidden = await apiPost(app, "/api/admin/invitations", "admin@lot.pl").send({
      displayName: "Forbidden Invite",
      email: forbiddenEmail,
      password: "never-accepted",
      roleAssignments: [{ roleName: "observer", scopeType: "GLOBAL" }]
    });
    expect(forbidden.status).toBe(400);
    expect((await apiGet(app, "/api/admin/users", "admin@lot.pl").query({ search: forbiddenEmail })).body.total).toBe(0);
    expect((await apiPost(app, "/api/admin/invitations", "viewer@lot.pl").send({
      displayName: "Unauthorized Invite",
      email: `unauthorized-${token}@example.test`,
      roleAssignments: [{ roleName: "observer", scopeType: "GLOBAL" }]
    })).status).toBe(403);

    const invalidEmail = `invalid-scope-${token}@example.test`;
    const invalidScope = await apiPost(app, "/api/admin/invitations", "admin@lot.pl").send({
      displayName: "Invalid Scope Invite",
      email: invalidEmail,
      roleAssignments: [{ roleName: "zpp-group-leader", scopeType: "GROUP", scopeId: "grp-2026-000002" }]
    });
    expect(invalidScope.status).toBe(400);
    expect((await apiGet(app, "/api/admin/users", "admin@lot.pl").query({ search: invalidEmail })).body.total).toBe(0);

    const member = await apiPost(app, "/api/member-profiles", "admin@lot.pl").send({
      memberId: `INV-${token}`,
      roleType: "ZPP",
      firstName: "Invitation",
      lastName: "Member",
      functionName: "Welfare Support"
    });
    expect(member.status).toBe(201);

    const created = await apiPost(app, "/api/admin/invitations", "admin@lot.pl").send({
      displayName: "Invited ZPP Member",
      email: `invited-${token}@example.test`,
      employeeId: `INV-${token}`,
      department: "Emergency Response",
      authenticationPolicy: "SSO_ONLY",
      memberProfileId: member.body.id,
      roleAssignments: [
        { roleName: "zpp-member", scopeType: "GLOBAL" },
        { roleName: "zpp-group-leader", scopeType: "GROUP", scopeId: "grp-2026-000001" }
      ]
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      status: "Prepared",
      intendedAuthenticationPolicy: "SSO_ONLY",
      resendGeneration: 1,
      invitedEmailSnapshot: `invited-${token}@example.test`
    });
    expect(created.body).not.toHaveProperty("tokenHash");
    expect(JSON.stringify(created.body)).not.toMatch(/tokenHash|rawInvitationToken|temporaryPassword|passwordHash|providerSubject|tenantId|oauth/i);
    expect(created.body.user).toMatchObject({
      displayName: "Invited ZPP Member",
      status: "Pending",
      authenticationPolicy: "SSO_ONLY",
      linkedMemberProfileId: member.body.id
    });
    expect(created.body.roleAssignments.map((item: any) => item.roleName)).toEqual(["zpp-member", "zpp-group-leader"]);
    expect(created.body.roleAssignments.find((item: any) => item.roleName === "zpp-group-leader")).toMatchObject({
      scopeType: "GROUP",
      scopeId: "grp-2026-000001"
    });
    expect((await apiGet(app, "/api/auth/me", `invited-${token}@example.test`)).status).toBe(401);
    expect((await apiPost(app, "/api/admin/invitations", "admin@lot.pl").send({
      displayName: "Duplicate Email",
      email: `invited-${token}@example.test`,
      roleAssignments: [{ roleName: "observer", scopeType: "GLOBAL" }]
    })).status).toBe(409);
    expect((await apiPost(app, "/api/admin/invitations", "admin@lot.pl").send({
      displayName: "Duplicate Member Link",
      email: `duplicate-member-${token}@example.test`,
      memberProfileId: member.body.id,
      roleAssignments: [{ roleName: "observer", scopeType: "GLOBAL" }]
    })).status).toBe(409);

    const detail = await apiGet(app, `/api/admin/invitations/${created.body.id}`, "admin@lot.pl");
    expect(detail.status).toBe(200);
    expect(detail.body.roleAssignments).toHaveLength(2);
    expect(JSON.stringify(detail.body)).not.toMatch(/tokenHash|rawInvitationToken|temporaryPassword|passwordHash|providerSubject|tenantId|oauth/i);
    const list = await apiGet(app, "/api/admin/invitations", "admin@lot.pl").query({ search: `invited-${token}@example.test` });
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].id).toBe(created.body.id);

    const audit = await apiGet(app, "/api/audit-logs", "admin@lot.pl").query({ limit: 200 });
    const renderedAudit = JSON.stringify(audit.body.data.filter((item: any) => [created.body.id, created.body.user.id].includes(item.entityId)));
    expect(renderedAudit).not.toMatch(/tokenHash|rawInvitationToken|temporaryPassword|passwordHash|providerSubject|tenantId|oauth/i);
  });

  it("Stage 3F1: enforces invitation lifecycle, local onboarding and audit boundaries", async () => {
    const app = createApp();
    const token = `3f1-life-${Date.now()}`;
    const revocable = await apiPost(app, "/api/admin/invitations", "admin@lot.pl").send({
      displayName: "Revocable Invite",
      email: `revocable-${token}@example.test`,
      authenticationPolicy: "PASSWORD_ONLY",
      roleAssignments: [{ roleName: "observer", scopeType: "GLOBAL" }]
    });
    expect(revocable.status).toBe(201);
    const beforeRevokeUser = await apiGet(app, `/api/admin/users/${revocable.body.user.id}`, "admin@lot.pl");
    expect(beforeRevokeUser.body.status).toBe("Pending");
    expect(beforeRevokeUser.body.roleAssignments.map((item: any) => item.roleName)).toEqual(["observer"]);

    const regenerated = await apiPost(app, `/api/admin/invitations/${revocable.body.id}/regenerate`, "admin@lot.pl").send({});
    expect(regenerated.status).toBe(200);
    expect(regenerated.body.user.id).toBe(revocable.body.user.id);
    expect(regenerated.body.resendGeneration).toBe(revocable.body.resendGeneration + 1);
    expect(regenerated.body.roleAssignments.map((item: any) => item.roleName)).toEqual(["observer"]);
    expect((await apiPost(app, `/api/admin/invitations/${revocable.body.id}/local-accept`, "admin@lot.pl").send({
      expectedGeneration: revocable.body.resendGeneration
    })).status).toBe(409);

    expect((await apiPost(app, `/api/admin/invitations/${revocable.body.id}/revoke`, "admin@lot.pl").send({})).status).toBe(400);
    const revoked = await apiPost(app, `/api/admin/invitations/${revocable.body.id}/revoke`, "admin@lot.pl").send({
      reason: "Incorrect recipient details."
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body.status).toBe("Revoked");
    const afterRevokeUser = await apiGet(app, `/api/admin/users/${revocable.body.user.id}`, "admin@lot.pl");
    expect(afterRevokeUser.body.status).toBe("Pending");
    expect(afterRevokeUser.body.roleAssignments.map((item: any) => item.roleName)).toEqual(["observer"]);
    expect((await apiPost(app, `/api/admin/invitations/${revocable.body.id}/local-accept`, "admin@lot.pl").send({
      expectedGeneration: regenerated.body.resendGeneration
    })).status).toBe(410);

    const expired = await apiPost(app, "/api/admin/invitations", "admin@lot.pl").send({
      displayName: "Expired Invite",
      email: `expired-${token}@example.test`,
      expiresAt: "2020-01-01T00:00:00.000Z",
      roleAssignments: [{ roleName: "observer", scopeType: "GLOBAL" }]
    });
    expect(expired.status).toBe(201);
    expect((await apiPost(app, `/api/admin/invitations/${expired.body.id}/local-accept`, "admin@lot.pl").send({
      expectedGeneration: expired.body.resendGeneration
    })).status).toBe(410);
    expect((await apiGet(app, `/api/admin/invitations/${expired.body.id}`, "admin@lot.pl")).body.status).toBe("Expired");

    const accepted = await apiPost(app, "/api/admin/invitations", "admin@lot.pl").send({
      displayName: "Accepted Invite",
      email: `accepted-${token}@example.test`,
      authenticationPolicy: "SSO_OR_PASSWORD",
      roleAssignments: [
        { roleName: "observer", scopeType: "GLOBAL" },
        { roleName: "zpp-member", scopeType: "GLOBAL" }
      ]
    });
    expect(accepted.status).toBe(201);
    const timelineBefore = await apiGet(app, "/api/timeline", "admin@lot.pl").query({ limit: 200 });
    const completed = await apiPost(app, `/api/admin/invitations/${accepted.body.id}/local-accept`, "admin@lot.pl").send({
      expectedGeneration: accepted.body.resendGeneration,
      methodChoice: "PASSWORD_ONLY"
    });
    expect(completed.status).toBe(200);
    expect(completed.body.status).toBe("Accepted");
    expect(completed.body.roleAssignments.map((item: any) => item.roleName)).toEqual(["observer", "zpp-member"]);
    expect(JSON.stringify(completed.body)).not.toMatch(/tokenHash|rawInvitationToken|temporaryPassword|passwordHash|providerSubject|tenantId|oauth/i);
    expect((await apiPost(app, `/api/admin/invitations/${accepted.body.id}/local-accept`, "admin@lot.pl").send({
      expectedGeneration: accepted.body.resendGeneration
    })).status).toBe(409);
    expect((await apiPost(app, `/api/admin/invitations/${accepted.body.id}/regenerate`, "admin@lot.pl").send({})).status).toBe(409);

    const activeUser = await apiGet(app, `/api/admin/users/${accepted.body.user.id}`, "admin@lot.pl");
    expect(activeUser.body.status).toBe("Active");
    expect(activeUser.body.externalIdentityCount).toBe(1);
    expect(activeUser.body.roleAssignments.map((item: any) => item.roleName)).toEqual(["observer", "zpp-member"]);
    expect(JSON.stringify(activeUser.body)).not.toMatch(/providerSubject|tenantId|passwordHash|temporaryPassword|rawInvitationToken/i);
    const login = await apiGet(app, "/api/auth/me", `accepted-${token}@example.test`);
    expect(login.status).toBe(200);
    expect(login.body.user.roles).toEqual(expect.arrayContaining(["observer", "zpp-member"]));

    const notifications = await apiGet(app, "/api/notifications", `accepted-${token}@example.test`);
    expect(notifications.body.data.map((item: any) => item.title)).toContain("Onboarding completed");
    const history = await apiGet(app, `/api/admin/users/${accepted.body.user.id}/access-history`, "admin@lot.pl");
    expect(history.body.data.map((item: any) => item.action)).toEqual(expect.arrayContaining([
      "invitation_prepared",
      "invitation_accepted",
      "local_identity_linked",
      "account_activated_through_invitation"
    ]));
    expect(history.body.data.find((item: any) => item.action === "invitation_accepted")?.metadata).toMatchObject({
      targetUserId: accepted.body.user.id,
      invitationId: accepted.body.id,
      identityId: expect.any(String),
      authenticationMethod: "LOCAL_DEV_PASSWORD"
    });
    const timelineAfter = await apiGet(app, "/api/timeline", "admin@lot.pl").query({ limit: 200 });
    expect(timelineAfter.body.total).toBe(timelineBefore.body.total);
  });

  it("Stage 3F2: discovers authentication options without exposing authorization or account-state details", async () => {
    const app = createApp();
    const known = await request(app).post("/api/auth/discovery").send({ identifier: "coordinator@lot.pl" });
    expect(known.status).toBe(200);
    expect(known.body).toMatchObject({
      accountEligible: true,
      authenticationPolicy: "SSO_OR_PASSWORD",
      permittedMethods: ["MICROSOFT_SSO", "EMAIL_PASSWORD"]
    });
    expect(known.body).not.toHaveProperty("roles");
    expect(known.body).not.toHaveProperty("roleLabels");
    expect(known.body).not.toHaveProperty("permissions");
    expect(known.body).not.toHaveProperty("capabilities");
    expect(known.body).not.toHaveProperty("memberProfile");
    expect(JSON.stringify(known.body)).not.toMatch(/providerSubject|tenantId|tokenHash|rawInvitationToken|temporaryPassword|passwordHash/i);

    const unknown = await request(app).post("/api/auth/discovery").send({ identifier: "unknown@example.test" });
    const suspended = await request(app).post("/api/auth/discovery").send({ identifier: "suspended@lot.pl" });
    const archived = await request(app).post("/api/auth/discovery").send({ identifier: "archived@lot.pl" });
    for (const response of [unknown, suspended, archived]) {
      expect(response.status).toBe(200);
      expect(response.body).toEqual(unknown.body);
      expect(response.body).toMatchObject({ accountEligible: false, permittedMethods: [] });
      expect(JSON.stringify(response.body)).not.toMatch(/suspended|archived|role|permission|member|providerSubject|tenantId/i);
    }
  });

  it("Stage 3F2: enforces authentication policy while keeping effective authorization canonical", async () => {
    const app = createApp();
    const token = `3f2-policy-${Date.now()}`;
    const createInvite = (suffix: string, authenticationPolicy: string) =>
      apiPost(app, "/api/admin/invitations", "admin@lot.pl").send({
        displayName: `Stage 3F2 ${suffix}`,
        email: `${suffix}-${token}@example.test`,
        authenticationPolicy,
        roleAssignments: [
          { roleName: "observer", scopeType: "GLOBAL" },
          { roleName: "zpp-member", scopeType: "GLOBAL" }
        ]
      });

    const sso = await createInvite("sso", "SSO_ONLY");
    const password = await createInvite("password", "PASSWORD_ONLY");
    const dual = await createInvite("dual", "SSO_OR_PASSWORD");
    expect(sso.status).toBe(201);
    expect(password.status).toBe(201);
    expect(dual.status).toBe(201);

    const pendingLogin = await request(app).post("/api/auth/development/login").send({
      userId: sso.body.user.id,
      method: "MICROSOFT_SSO"
    });
    expect(pendingLogin.status).toBe(401);

    for (const invitation of [sso, password, dual]) {
      const accepted = await apiPost(app, `/api/admin/invitations/${invitation.body.id}/local-accept`, "admin@lot.pl").send({
        expectedGeneration: invitation.body.resendGeneration,
        methodChoice: invitation.body.intendedAuthenticationPolicy === "PASSWORD_ONLY" ? "PASSWORD_ONLY" : "SSO_ONLY"
      });
      expect(accepted.status).toBe(200);
      expect(accepted.body.roleAssignments.map((item: any) => item.roleName)).toEqual(["observer", "zpp-member"]);
    }

    expect((await request(app).post("/api/auth/development/login").send({ userId: sso.body.user.id, method: "EMAIL_PASSWORD" })).status).toBe(403);
    expect((await request(app).post("/api/auth/development/login").send({ userId: password.body.user.id, method: "MICROSOFT_SSO" })).status).toBe(403);

    const ssoLogin = await request(app).post("/api/auth/development/login").send({
      userId: sso.body.user.id,
      method: "MICROSOFT_SSO",
      roles: ["system-admin"],
      permissions: ["admin:manage"]
    });
    expect(ssoLogin.status).toBe(200);
    expect(ssoLogin.body.session.userId).toBe(sso.body.user.id);
    expect(ssoLogin.body.user.userId).toBe(sso.body.user.id);
    expect(ssoLogin.body.user.roles).toEqual(expect.arrayContaining(["observer", "zpp-member"]));
    expect(ssoLogin.body.user.roles).not.toContain("system-admin");
    expect(ssoLogin.body.user.permissions).not.toContain("admin:manage");

    const ssoMe = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${ssoLogin.body.session.token}`)
      .set("x-user-email", "admin@lot.pl");
    expect(ssoMe.status).toBe(200);
    expect(ssoMe.body.user.userId).toBe(sso.body.user.id);
    expect(ssoMe.body.user.email).toBe(sso.body.user.email);

    const passwordLogin = await request(app).post("/api/auth/development/login").send({ userId: password.body.user.id, method: "EMAIL_PASSWORD" });
    expect(passwordLogin.status).toBe(200);
    const dualSsoLogin = await request(app).post("/api/auth/development/login").send({ userId: dual.body.user.id, method: "MICROSOFT_SSO" });
    const dualPasswordLogin = await request(app).post("/api/auth/development/login").send({ userId: dual.body.user.id, method: "EMAIL_PASSWORD" });
    expect(dualSsoLogin.status).toBe(200);
    expect(dualPasswordLogin.status).toBe(200);
    expect(dualSsoLogin.body.user.roles).toEqual(dualPasswordLogin.body.user.roles);
    expect(dualSsoLogin.body.user.permissions).toEqual(dualPasswordLogin.body.user.permissions);
    expect(dualSsoLogin.body.user.roleAssignments).toEqual(dualPasswordLogin.body.user.roleAssignments);

    const history = await apiGet(app, `/api/admin/users/${dual.body.user.id}/access-history`, "admin@lot.pl");
    expect(history.body.data.map((item: any) => item.action)).toContain("local_authentication_completed");
    expect(JSON.stringify(history.body.data)).not.toMatch(/passwordHash|temporaryPassword|raw.*token|providerSubject|tenantId/i);
  });

  it("Stage 3F2: enforces account status for development authentication sessions", async () => {
    const app = createApp();
    expect((await request(app).post("/api/auth/development/login").send({ userId: demoIds.pending, method: "MICROSOFT_SSO" })).status).toBe(401);
    expect((await request(app).post("/api/auth/development/login").send({ userId: demoIds.suspended, method: "MICROSOFT_SSO" })).status).toBe(401);
    expect((await request(app).post("/api/auth/development/login").send({ userId: demoIds.archived, method: "MICROSOFT_SSO" })).status).toBe(401);

    const token = `3f2-status-${Date.now()}`;
    const invitation = await apiPost(app, "/api/admin/invitations", "admin@lot.pl").send({
      displayName: "Stage 3F2 Status User",
      email: `status-${token}@example.test`,
      authenticationPolicy: "SSO_OR_PASSWORD",
      roleAssignments: [{ roleName: "observer", scopeType: "GLOBAL" }]
    });
    expect(invitation.status).toBe(201);
    const accepted = await apiPost(app, `/api/admin/invitations/${invitation.body.id}/local-accept`, "admin@lot.pl").send({
      expectedGeneration: invitation.body.resendGeneration,
      methodChoice: "SSO_ONLY"
    });
    expect(accepted.status).toBe(200);
    const userId = invitation.body.user.id;

    const activeLogin = await request(app).post("/api/auth/development/login").send({ userId, method: "MICROSOFT_SSO" });
    expect(activeLogin.status).toBe(200);
    expect((await request(app).get("/api/auth/me").set("Authorization", `Bearer ${activeLogin.body.session.token}`)).status).toBe(200);

    expect((await apiPost(app, `/api/admin/users/${userId}/suspend`, "admin@lot.pl").send({ reason: "Lifecycle test." })).status).toBe(200);
    expect((await request(app).post("/api/auth/development/login").send({ userId, method: "MICROSOFT_SSO" })).status).toBe(401);
    expect((await request(app).get("/api/auth/me").set("Authorization", `Bearer ${activeLogin.body.session.token}`)).status).toBe(401);

    expect((await apiPost(app, `/api/admin/users/${userId}/activate`, "admin@lot.pl").send({})).status).toBe(409);
    expect((await apiPost(app, `/api/admin/users/${userId}/restore`, "admin@lot.pl").send({})).status).toBe(200);
    expect((await request(app).post("/api/auth/development/login").send({ userId, method: "EMAIL_PASSWORD" })).status).toBe(200);

    expect((await apiPost(app, `/api/admin/users/${userId}/archive`, "admin@lot.pl").send({ reason: "Lifecycle test." })).status).toBe(200);
    expect((await request(app).post("/api/auth/development/login").send({ userId, method: "MICROSOFT_SSO" })).status).toBe(401);
    const restored = await apiPost(app, `/api/admin/users/${userId}/restore`, "admin@lot.pl").send({});
    expect(restored.status).toBe(200);
    expect(restored.body.status).toBe("Pending");
    expect((await request(app).post("/api/auth/development/login").send({ userId, method: "MICROSOFT_SSO" })).status).toBe(401);
    expect((await apiPost(app, `/api/admin/users/${userId}/activate`, "admin@lot.pl").send({})).status).toBe(200);
    expect((await request(app).post("/api/auth/development/login").send({ userId, method: "MICROSOFT_SSO" })).status).toBe(200);
  });

  it("Stage 3F2: gates development authentication and logout behind the supported session boundary", async () => {
    const previous = process.env.ZPP_ENABLE_DEV_AUTH;
    process.env.ZPP_ENABLE_DEV_AUTH = "false";
    try {
      const disabledApp = createApp();
      expect((await request(disabledApp).get("/api/auth/config")).body.developmentAccessEnabled).toBe(false);
      expect((await request(disabledApp).get("/api/auth/development/users")).status).toBe(404);
      expect((await request(disabledApp).post("/api/auth/development/login").send({ userId: demoIds.admin, method: "MICROSOFT_SSO" })).status).toBe(404);
      expect((await apiGet(disabledApp, "/api/auth/me", "admin@lot.pl")).status).toBe(401);
    } finally {
      if (previous === undefined) delete process.env.ZPP_ENABLE_DEV_AUTH;
      else process.env.ZPP_ENABLE_DEV_AUTH = previous;
    }

    const app = createApp();
    const login = await request(app).post("/api/auth/development/login").send({ userId: demoIds.admin, method: "MICROSOFT_SSO" });
    expect(login.status).toBe(200);
    const token = login.body.session.token;
    expect((await request(app).get("/api/dashboard").set("Authorization", `Bearer ${token}`)).status).toBe(200);
    expect((await request(app).post("/api/auth/logout").set("Authorization", `Bearer ${token}`).send({})).status).toBe(204);
    expect((await request(app).get("/api/dashboard").set("Authorization", `Bearer ${token}`)).status).toBe(401);
  });
});
