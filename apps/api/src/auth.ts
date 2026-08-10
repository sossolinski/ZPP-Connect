import { createRemoteJWKSet, jwtVerify } from "jose";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";
import { HttpError } from "./errors.js";
import { prisma } from "./prisma.js";
import type { AuthenticatedUser } from "./types.js";

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function permissionsFromUser(user: Awaited<ReturnType<typeof loadUserByEmail>>): AuthenticatedUser["permissions"] {
  const permissionSet = new Set<string>();
  for (const userRole of user?.roles ?? []) {
    const scoped = user?.groupRoleAssignments.filter((assignment) => assignment.roleId === userRole.roleId) ?? [];
    if (userRole.scopeType === "GROUP" && !scoped.some((assignment) => assignment.status === "Active" && assignment.group.status !== "Archived")) continue;
    const permissions = userRole.role.permissions;
    if (Array.isArray(permissions)) {
      permissions.forEach((permission) => permissionSet.add(String(permission)));
    }
  }
  return Array.from(permissionSet) as AuthenticatedUser["permissions"];
}

async function loadUserByEmail(email: string) {
  return prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    include: {
      organization: true,
      roles: { include: { role: true } },
      groupRoleAssignments: {
        include: { role: true, group: true }
      }
    }
  });
}

async function emailFromEntra(req: Request) {
  const header = req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  if (!token) return undefined;
  if (!config.entraJwksUri || !config.entraIssuer || !config.entraAudience) {
    throw new HttpError(500, "Entra authentication is not configured");
  }

  jwks ??= createRemoteJWKSet(new URL(config.entraJwksUri));
  const result = await jwtVerify(token, jwks, {
    issuer: config.entraIssuer,
    audience: config.entraAudience
  });

  const payload = result.payload as Record<string, unknown>;
  return String(payload.email ?? payload.preferred_username ?? payload.upn ?? "").toLowerCase();
}

async function resolveEmail(req: Request) {
  if (config.authMode === "entra") {
    return emailFromEntra(req);
  }
  return req.header("x-user-email")?.toLowerCase();
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const email = await resolveEmail(req);
    if (!email) throw new HttpError(401, "Authentication required");

    const user = await loadUserByEmail(email);
    if (!user || user.status !== "active") {
      throw new HttpError(401, "User is not provisioned or active");
    }

    const roleAssignments = user.roles.reduce<NonNullable<AuthenticatedUser["roleAssignments"]>>((result, item) => {
      const scoped = user.groupRoleAssignments.filter((assignment) => assignment.roleId === item.roleId);
      if (item.scopeType === "GROUP") {
        result.push(...scoped.map((assignment) => ({
          id: assignment.id,
          userId: user.id,
          roleName: item.role.name,
          scopeType: "GROUP" as const,
          scopeId: assignment.groupId,
          status: assignment.status === "Active" && assignment.group.status !== "Archived" ? "Active" as const : "Revoked" as const,
          assignedAt: assignment.assignedAt.toISOString(),
          assignedByUserId: assignment.assignedBy,
          permissions: Array.isArray(item.role.permissions) ? item.role.permissions.map(String) as AuthenticatedUser["permissions"] : []
        })));
      } else {
        result.push({
          id: `global:${user.id}:${item.roleId}`,
          userId: user.id,
          roleName: item.role.name,
          scopeType: "GLOBAL",
          scopeId: null,
          status: "Active",
          assignedAt: item.assignedAt.toISOString(),
          assignedByUserId: null,
          permissions: Array.isArray(item.role.permissions) ? item.role.permissions.map(String) as AuthenticatedUser["permissions"] : []
        });
      }
      return result;
    }, []);

    req.user = {
      id: user.id,
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      department: user.department,
      organizationId: user.organizationId,
      organization: user.organization
        ? {
            id: user.organization.id,
            key: user.organization.key,
            name: user.organization.name,
            type: user.organization.type,
            status: user.organization.status,
            contactEmail: user.organization.contactEmail
          }
        : null,
      roles: user.roles.map((item) => item.role.name),
      roleAssignments,
      permissions: permissionsFromUser(user)
    };
    next();
  } catch (error) {
    next(error);
  }
}
