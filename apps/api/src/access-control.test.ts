import { describe, expect, it } from "vitest";
import {
  duplicateActiveRoleAssignment,
  effectiveAccessForUser,
  validateRoleAssignment,
  type AccessGroup,
  type PermissionOverride,
  type RoleAssignment
} from "./access-control.js";

const groups: AccessGroup[] = [
  { id: "zpp-alpha", pool: "ZPP", status: "Active" },
  { id: "zpp-bravo", pool: "ZPP", status: "Active" },
  { id: "tec-alpha", pool: "TEC", status: "Active" },
  { id: "zpp-archived", pool: "ZPP", status: "Archived" }
];

function assignment(overrides: Partial<RoleAssignment> & Pick<RoleAssignment, "userId" | "roleName" | "scopeType">): RoleAssignment {
  return {
    id: `ura-${overrides.userId}-${overrides.roleName}-${overrides.scopeId ?? "global"}`,
    status: "Active",
    assignedAt: "2026-07-16T08:00:00.000Z",
    ...overrides
  };
}

describe("access-control role model", () => {
  it("unions multiple active role permissions and preserves role labels", () => {
    const access = effectiveAccessForUser({
      userId: "u-admin",
      groups,
      assignments: [
        assignment({ userId: "u-admin", roleName: "system-admin", scopeType: "GLOBAL" }),
        assignment({ userId: "u-admin", roleName: "zpp-coordinator", scopeType: "GLOBAL" })
      ]
    });

    expect(access.roles).toEqual(["system-admin", "zpp-coordinator"]);
    expect(access.roleLabels).toEqual(["System Admin", "ZPP Coordinator"]);
    expect(access.permissions).toEqual(expect.arrayContaining(["admin:manage", "group:read", "assignment:create"]));
  });

  it("lets explicit user denies override role grants and user grants", () => {
    const overrides: PermissionOverride[] = [
      { id: "grant-1", userId: "u-member", permission: "group:create", effect: "GRANT", active: true },
      { id: "deny-1", userId: "u-member", permission: "group:create", effect: "DENY", active: true },
      { id: "deny-2", userId: "u-member", permission: "assignment:update", effect: "DENY", active: true }
    ];

    const access = effectiveAccessForUser({
      userId: "u-member",
      groups,
      permissionOverrides: overrides,
      assignments: [assignment({ userId: "u-member", roleName: "zpp-member", scopeType: "GLOBAL" })]
    });

    expect(access.permissions).toContain("assignment:read");
    expect(access.permissions).not.toContain("assignment:update");
    expect(access.permissions).not.toContain("group:create");
    expect(access.deniedPermissions).toEqual(expect.arrayContaining(["assignment:update", "group:create"]));
  });

  it("rejects duplicate active assignments for the same role and scope", () => {
    const existing = [
      assignment({ userId: "u-leader", roleName: "zpp-group-leader", scopeType: "GROUP", scopeId: "zpp-alpha" })
    ];

    expect(duplicateActiveRoleAssignment(existing, { userId: "u-leader", roleName: "ZPP Leader", scopeType: "GROUP", scopeId: "zpp-alpha" })).toBe(true);
    expect(duplicateActiveRoleAssignment(existing, { userId: "u-leader", roleName: "zpp-group-leader", scopeType: "GROUP", scopeId: "zpp-bravo" })).toBe(false);
  });

  it("validates group-scoped role compatibility and archived group ineffectiveness", () => {
    expect(validateRoleAssignment({ roleName: "zpp-group-leader", scopeType: "GROUP", scopeId: "zpp-alpha" }, groups)).toBeUndefined();
    expect(validateRoleAssignment({ roleName: "zpp-group-leader", scopeType: "GROUP", scopeId: "tec-alpha" }, groups)).toContain("compatible groups");
    expect(validateRoleAssignment({ roleName: "tec-group-leader", scopeType: "GROUP", scopeId: "zpp-alpha" }, groups)).toContain("compatible groups");
    expect(validateRoleAssignment({ roleName: "zpp-group-leader", scopeType: "GROUP", scopeId: "zpp-archived" }, groups)).toContain("Archived groups");

    const access = effectiveAccessForUser({
      userId: "u-archived",
      groups,
      assignments: [assignment({ userId: "u-archived", roleName: "zpp-group-leader", scopeType: "GROUP", scopeId: "zpp-archived" })]
    });
    expect(access.roles).toEqual([]);
    expect(access.permissions).toEqual([]);
  });

  it("keeps System Admin separate from operational coordination", () => {
    const adminOnly = effectiveAccessForUser({
      userId: "u-admin",
      groups,
      assignments: [assignment({ userId: "u-admin", roleName: "system-admin", scopeType: "GLOBAL" })]
    });

    const adminCoordinator = effectiveAccessForUser({
      userId: "u-admin",
      groups,
      assignments: [
        assignment({ userId: "u-admin", roleName: "system-admin", scopeType: "GLOBAL" }),
        assignment({ userId: "u-admin", roleName: "zpp-coordinator", scopeType: "GLOBAL" })
      ]
    });

    expect(adminOnly.permissions).toContain("admin:manage");
    expect(adminOnly.permissions).not.toContain("assignment:create");
    expect(adminOnly.permissions).not.toContain("group:read");
    expect(adminCoordinator.permissions).toEqual(expect.arrayContaining(["admin:manage", "assignment:create", "group:read"]));
  });
});
