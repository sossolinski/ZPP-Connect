import type { Prisma, PrismaClient } from "@prisma/client";
import { permissions, type Permission } from "@zpp/shared";
import type { AuthenticatedUser } from "../../types.js";

type DbClient = PrismaClient | Prisma.TransactionClient;

const activeAccountStatus = "Active";
const accessGraphInclude = {
  organization: true,
  roles: { include: { role: true } },
  groupRoleAssignments: { include: { role: true, group: true } },
  incidentAssignments: { where: { active: true }, select: { incidentId: true } },
  permissionOverrides: true,
} satisfies Prisma.UserInclude;

type AccessGraphUser = Prisma.UserGetPayload<{ include: typeof accessGraphInclude }>;
export type EffectiveAccessScope = { incidentId?: string | null };

function permissionList(value: Prisma.JsonValue): Permission[] {
  if (!Array.isArray(value)) return [];
  const known = new Set(Object.keys(permissions));
  return value.map(String).filter((permission): permission is Permission => known.has(permission));
}

function evaluateAccessGraph(user: AccessGraphUser, now: Date, scope: EffectiveAccessScope = {}) {
  const activeIncidentIds = new Set(user.incidentAssignments.map((assignment) => assignment.incidentId));
  const targetIncidentId = scope.incidentId || null;
  const incidentEligible = !targetIncidentId || activeIncidentIds.has(targetIncidentId);
  const roleAssignments: NonNullable<AuthenticatedUser["roleAssignments"]> = [];
  const roleNames = new Set<string>();
  const grantedPermissions = new Set<Permission>();

  if (incidentEligible) {
    for (const assignment of user.roles) {
      if (assignment.role.status !== "Active") continue;
      const rolePermissions = permissionList(assignment.role.permissions);
      if (assignment.scopeType === "GROUP") {
        const scoped = user.groupRoleAssignments.filter((groupAssignment) => (
          groupAssignment.roleId === assignment.roleId &&
          groupAssignment.status === "Active" &&
          groupAssignment.group.status !== "Archived" &&
          activeIncidentIds.has(groupAssignment.group.incidentId) &&
          (!targetIncidentId || groupAssignment.group.incidentId === targetIncidentId)
        ));
        for (const groupAssignment of scoped) {
          roleAssignments.push({
            id: groupAssignment.id,
            userId: user.id,
            roleName: assignment.role.name,
            scopeType: "GROUP",
            scopeId: groupAssignment.groupId,
            status: "Active",
            assignedAt: groupAssignment.assignedAt.toISOString(),
            assignedByUserId: groupAssignment.assignedBy,
            permissions: rolePermissions,
          });
          roleNames.add(assignment.role.name);
          rolePermissions.forEach((permission) => grantedPermissions.add(permission));
        }
      } else {
        roleAssignments.push({
          id: assignment.id,
          userId: user.id,
          roleName: assignment.role.name,
          scopeType: "GLOBAL",
          scopeId: null,
          status: "Active",
          assignedAt: assignment.assignedAt.toISOString(),
          assignedByUserId: assignment.assignedBy,
          permissions: rolePermissions,
        });
        roleNames.add(assignment.role.name);
        rolePermissions.forEach((permission) => grantedPermissions.add(permission));
      }
    }
  }

  const deniedPermissions = new Set<Permission>();
  if (incidentEligible) {
    for (const override of user.permissionOverrides) {
      if (!override.active || override.revokedAt || (override.expiresAt && override.expiresAt <= now)) continue;
      if (!(override.permission in permissions)) continue;
      const permission = override.permission as Permission;
      if (override.effect === "DENY") deniedPermissions.add(permission);
      if (override.effect === "GRANT" && permission !== "admin:manage") grantedPermissions.add(permission);
    }
  }
  deniedPermissions.forEach((permission) => grantedPermissions.delete(permission));

  return { roleAssignments, roleNames, permissions: grantedPermissions };
}

export class EffectiveAccessService {
  constructor(private readonly db: DbClient, private readonly clock: { now(): Date } = { now: () => new Date() }) {}

  async forUser(userId: string, scope: EffectiveAccessScope = {}): Promise<AuthenticatedUser | null> {
    const user = await this.db.user.findUnique({ where: { id: userId }, include: accessGraphInclude });
    if (!user || user.status !== activeAccountStatus) return null;
    const evaluated = evaluateAccessGraph(user, this.clock.now(), scope);

    return {
      id: user.id,
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      department: user.department,
      organizationId: user.organizationId,
      organization: user.organization ? {
        id: user.organization.id,
        key: user.organization.key,
        name: user.organization.name,
        type: user.organization.type,
        status: user.organization.status,
        contactEmail: user.organization.contactEmail
      } : null,
      roles: Array.from(evaluated.roleNames),
      roleAssignments: evaluated.roleAssignments,
      permissions: Array.from(evaluated.permissions)
    };
  }

  async hasEffectivePermission(userId: string, permission: Permission, scope: EffectiveAccessScope = {}) {
    const user = await this.db.user.findUnique({ where: { id: userId }, include: accessGraphInclude });
    return Boolean(user && user.status === activeAccountStatus && evaluateAccessGraph(user, this.clock.now(), scope).permissions.has(permission));
  }

  async eligibleUsersForPermission(permission: Permission, scope: EffectiveAccessScope = {}) {
    const incidentId = scope.incidentId || null;
    const users = await this.db.user.findMany({
      where: {
        status: activeAccountStatus,
        ...(incidentId ? { incidentAssignments: { some: { incidentId, active: true } } } : {})
      },
      include: accessGraphInclude,
      orderBy: { id: "asc" }
    });
    const now = this.clock.now();
    return users.filter((user) => evaluateAccessGraph(user, now, scope).permissions.has(permission)).map((user) => user.id);
  }
}
