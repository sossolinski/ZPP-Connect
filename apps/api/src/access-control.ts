import { defaultRoles, normalizeRoleName, type Permission, type RoleScopeType } from "@zpp/shared";

export type RoleAssignmentStatus = "Active" | "Revoked";

export type RoleAssignment = {
  id: string;
  userId: string;
  roleName: string;
  scopeType: RoleScopeType;
  scopeId?: string | null;
  status: RoleAssignmentStatus;
  assignedAt: string;
  assignedByUserId?: string | null;
  revokedAt?: string | null;
  revokedByUserId?: string | null;
  version?: number;
};

export type PermissionOverride = {
  id: string;
  userId: string;
  permission: Permission;
  effect: "GRANT" | "DENY";
  active: boolean;
  reason?: string | null;
  expiresAt?: string | null;
  createdAt?: string | null;
  createdByUserId?: string | null;
  revokedAt?: string | null;
  revokedByUserId?: string | null;
  version?: number;
};

export type AccessGroup = {
  id: string;
  pool?: string | null;
  status?: string | null;
};

export type EffectiveAccess = {
  roles: string[];
  roleLabels: string[];
  permissions: Permission[];
  roleAssignments: RoleAssignment[];
  grants: PermissionOverride[];
  denies: PermissionOverride[];
  expiredOrRevokedOverrides: PermissionOverride[];
  deniedPermissions: Permission[];
};

export type RoleDefinition = {
  name: string;
  displayName: string;
  description?: string;
  permissions: Permission[];
  scopeTypes: RoleScopeType[];
  pool?: string;
  status?: string;
};

function roleMap(roleDefinitions: RoleDefinition[] = defaultRoles) {
  return new Map(roleDefinitions.map((role) => [canonicalRoleName(role.name), role]));
}

export function canonicalRoleName(roleName: string) {
  return normalizeRoleName(roleName);
}

export function roleDisplayName(roleName: string, roleDefinitions: RoleDefinition[] = defaultRoles) {
  return roleMap(roleDefinitions).get(canonicalRoleName(roleName))?.displayName ?? roleName;
}

export function rolePermissions(roleName: string, roleDefinitions: RoleDefinition[] = defaultRoles) {
  return roleMap(roleDefinitions).get(canonicalRoleName(roleName))?.permissions ?? [];
}

export function permissionsForRoleNames(roleNames: string[], roleDefinitions: RoleDefinition[] = defaultRoles) {
  const permissionSet = new Set<Permission>();
  for (const roleName of roleNames.map(canonicalRoleName)) {
    rolePermissions(roleName, roleDefinitions).forEach((permission) => permissionSet.add(permission));
  }
  return Array.from(permissionSet);
}

export function isActiveRoleAssignment(assignment: RoleAssignment, groups: AccessGroup[] = [], roleDefinitions: RoleDefinition[] = defaultRoles) {
  if (assignment.status !== "Active") return false;
  const role = roleMap(roleDefinitions).get(canonicalRoleName(assignment.roleName));
  if (!role || role.status === "Archived") return false;
  if (assignment.scopeType !== "GROUP") return true;
  const group = groups.find((item) => item.id === assignment.scopeId);
  return Boolean(group && group.status !== "Archived");
}

export function duplicateActiveRoleAssignment(assignments: RoleAssignment[], candidate: Pick<RoleAssignment, "userId" | "roleName" | "scopeType" | "scopeId">) {
  const normalizedRole = canonicalRoleName(candidate.roleName);
  const normalizedScopeId = candidate.scopeId ?? null;
  return assignments.some((assignment) => (
    assignment.status === "Active" &&
    assignment.userId === candidate.userId &&
    canonicalRoleName(assignment.roleName) === normalizedRole &&
    assignment.scopeType === candidate.scopeType &&
    (assignment.scopeId ?? null) === normalizedScopeId
  ));
}

export function validateRoleAssignment(
  candidate: Pick<RoleAssignment, "roleName" | "scopeType" | "scopeId">,
  groups: AccessGroup[] = [],
  roleDefinitions: RoleDefinition[] = defaultRoles
) {
  const roleName = canonicalRoleName(candidate.roleName);
  const role = roleMap(roleDefinitions).get(roleName);
  if (!role) return "Role is not recognized.";
  if (role.status === "Archived") return "Archived roles cannot receive active assignments.";
  if (!role.scopeTypes.includes(candidate.scopeType)) return `${role.displayName} cannot be assigned with ${candidate.scopeType.toLowerCase()} scope.`;
  if (candidate.scopeType === "GROUP") {
    if (!candidate.scopeId) return "Group-scoped roles require a group.";
    const group = groups.find((item) => item.id === candidate.scopeId);
    if (!group) return "Group not found.";
    if (group.status === "Archived") return "Archived groups cannot receive active role assignments.";
    if (role.pool && role.pool !== "ALL" && group.pool !== "Mixed" && group.pool !== role.pool) {
      return `${role.displayName} can only be assigned to compatible groups.`;
    }
  }
  if (candidate.scopeType === "GLOBAL" && candidate.scopeId) return "Global roles cannot include a group scope.";
  return undefined;
}

export function isActivePermissionOverride(override: PermissionOverride, at = new Date()) {
  if (!override.active || override.revokedAt) return false;
  if (!override.expiresAt) return true;
  const expires = new Date(override.expiresAt);
  return Number.isFinite(expires.getTime()) && expires.getTime() > at.getTime();
}

export function effectiveAccessForUser(input: {
  userId: string;
  assignments: RoleAssignment[];
  groups?: AccessGroup[];
  permissionOverrides?: PermissionOverride[];
  roleDefinitions?: RoleDefinition[];
}) {
  const groups = input.groups ?? [];
  const roleDefinitions = input.roleDefinitions ?? defaultRoles;
  const activeAssignments = input.assignments
    .filter((assignment) => assignment.userId === input.userId)
    .map((assignment) => ({ ...assignment, roleName: canonicalRoleName(assignment.roleName) }))
    .filter((assignment) => isActiveRoleAssignment(assignment, groups, roleDefinitions));

  const roleNames = Array.from(new Set(activeAssignments.map((assignment) => assignment.roleName)));
  const permissionSet = new Set<Permission>(permissionsForRoleNames(roleNames, roleDefinitions));
  const deniedPermissions = new Set<Permission>();
  const grants: PermissionOverride[] = [];
  const denies: PermissionOverride[] = [];
  const expiredOrRevokedOverrides: PermissionOverride[] = [];

  for (const override of input.permissionOverrides ?? []) {
    if (override.userId !== input.userId) continue;
    if (!isActivePermissionOverride(override)) {
      expiredOrRevokedOverrides.push(override);
      continue;
    }
    if (override.effect === "GRANT") {
      grants.push(override);
      permissionSet.add(override.permission);
    }
    if (override.effect === "DENY") {
      denies.push(override);
      deniedPermissions.add(override.permission);
    }
  }

  for (const denied of deniedPermissions) {
    permissionSet.delete(denied);
  }

  return {
    roles: roleNames,
    roleLabels: roleNames.map((roleName) => roleDisplayName(roleName, roleDefinitions)),
    permissions: Array.from(permissionSet),
    roleAssignments: activeAssignments,
    grants,
    denies,
    expiredOrRevokedOverrides,
    deniedPermissions: Array.from(deniedPermissions)
  } satisfies EffectiveAccess;
}
