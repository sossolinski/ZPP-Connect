import { canonicalRoleName, rolePermissions } from "./access-control.js";
import type { DirectoryActor, MemberDirectoryRepository } from "./member-directory.js";

export type PermissionScope = {
  allowed: boolean;
  global: boolean;
  groupIds: Set<string>;
};

function assignmentProvidesPermission(
  assignment: NonNullable<DirectoryActor["roleAssignments"]>[number],
  permission: string
) {
  return (assignment.permissions ?? rolePermissions(canonicalRoleName(assignment.roleName))).includes(permission as never);
}

function isPersonalDirectoryGrant(roleName: string, permission: string) {
  return ["member:read", "group:read"].includes(permission) &&
    ["zpp-member", "tec-member"].includes(canonicalRoleName(roleName));
}

export function permissionScope(actor: DirectoryActor, permission: string): PermissionScope {
  if (!actor.permissions.includes(permission)) {
    return { allowed: false, global: false, groupIds: new Set() };
  }

  const assignments = (actor.roleAssignments ?? []).filter((assignment) => (
    assignment.status === "Active" && assignmentProvidesPermission(assignment, permission)
  ));
  const global = assignments.some((assignment) => (
    assignment.scopeType === "GLOBAL" && !isPersonalDirectoryGrant(assignment.roleName, permission)
  ));
  const groupIds = new Set(assignments
    .filter((assignment) => assignment.scopeType === "GROUP" && assignment.scopeId)
    .map((assignment) => String(assignment.scopeId)));

  // A live grant that is not supplied by a role is global only when the actor
  // has no group-scoped assignment. This conservative fallback prevents a
  // custom group role from being widened if its definition is unavailable.
  // DENY overrides have already removed the permission from actor.permissions.
  const explicitGrant = assignments.length === 0 && !(actor.roleAssignments ?? []).some((assignment) => (
    assignment.status === "Active" && assignment.scopeType === "GROUP"
  ));
  return { allowed: true, global: global || explicitGrant, groupIds };
}

export function canAccessGroup(actor: DirectoryActor, permission: string, groupId: string) {
  const scope = permissionScope(actor, permission);
  return scope.allowed && (scope.global || scope.groupIds.has(groupId));
}

export function assertGroupAccess(actor: DirectoryActor, permission: string, groupId: string) {
  if (!canAccessGroup(actor, permission, groupId)) {
    throw new Error("SCOPE_FORBIDDEN");
  }
}

export function memberGroupIds(directory: MemberDirectoryRepository, memberProfileId: string) {
  return new Set(directory.groupIdsForMember(memberProfileId));
}

export function canAccessMember(
  actor: DirectoryActor,
  permission: string,
  directory: MemberDirectoryRepository,
  memberProfileId: string
) {
  const scope = permissionScope(actor, permission);
  if (!scope.allowed) return false;
  if (scope.global) return true;
  if (directory.resolveMemberForUser(actor.id)?.id === memberProfileId) return true;
  return directory.groupIdsForMember(memberProfileId).some((groupId) => scope.groupIds.has(groupId));
}

export function scopedMemberIds(actor: DirectoryActor, permission: string, directory: MemberDirectoryRepository) {
  const scope = permissionScope(actor, permission);
  if (!scope.allowed || scope.global) return null;
  const ids = new Set<string>();
  const own = directory.resolveMemberForUser(actor.id);
  if (own) ids.add(own.id);
  for (const groupId of scope.groupIds) {
    for (const memberId of directory.lookupGroup(groupId).memberIds) ids.add(memberId);
  }
  return ids;
}
