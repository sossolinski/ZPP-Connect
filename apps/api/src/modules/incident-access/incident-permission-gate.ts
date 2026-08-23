import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Permission } from "@zpp/shared";
import { HttpError } from "../../errors.js";
import type { IncidentAccessService } from "./incident-access-service.js";
import type { IncidentContext } from "./incident-access-types.js";

export type IncidentPermissionAuthority = {
  effectivePermissionsForUser(
    userId: string,
    scope: { incidentId: string }
  ): Promise<Permission[]>;
  effectiveIncidentIdsForPermission?(userId: string, permission: Permission): Promise<string[] | null>;
};

export type IncidentPermissionGateOptions = {
  requireWritable?: boolean;
  permissionMatch?: "all" | "any";
  afterAuthorize?: (req: Request, context: IncidentContext) => void | Promise<void>;
};

type PermissionResolver = Permission | Permission[] | ((req: Request) => Permission | Permission[]);
type IncidentIdResolver = (req: Request) => string | Promise<string>;

export function createIncidentPermissionGate(
  authority: IncidentPermissionAuthority,
  incidentAccessService: IncidentAccessService
) {
  return function requireIncidentPermission(
    required: PermissionResolver,
    resolveIncidentId: IncidentIdResolver,
    options: IncidentPermissionGateOptions = {}
  ): RequestHandler {
    return async (req: Request, _res: Response, next: NextFunction) => {
      try {
        if (!req.user) throw new HttpError(401, "Authentication required");
        const resolved = typeof required === "function" ? required(req) : required;
        const permissions = Array.isArray(resolved) ? resolved : [resolved];
        const broadlyAvailable = options.permissionMatch === "any"
          ? permissions.some((permission) => req.user!.permissions.includes(permission))
          : permissions.every((permission) => req.user!.permissions.includes(permission));
        if (!broadlyAvailable) throw new HttpError(403, "Forbidden");

        const incidentId = String(await resolveIncidentId(req)).trim();
        if (!incidentId) throw new HttpError(400, "Incident is required.");
        const effectivePermissions = await authority.effectivePermissionsForUser(req.user.id, { incidentId });
        const allowed = options.permissionMatch === "any"
          ? permissions.some((permission) => effectivePermissions.includes(permission))
          : permissions.every((permission) => effectivePermissions.includes(permission));
        if (!allowed) {
          throw new HttpError(403, "Forbidden");
        }
        req.incidentPermissions = effectivePermissions;

        const accessActor = { id: req.user.id, email: req.user.email, roles: req.user.roles };
        const incidentContext = await incidentAccessService.authorize(accessActor, incidentId);
        if (options.requireWritable && !incidentContext.writable) {
          throw new HttpError(409, "The selected incident is read-only");
        }
        req.incidentContext = incidentContext;
        await options.afterAuthorize?.(req, incidentContext);
        next();
      } catch (error) {
        next(error);
      }
    };
  };
}

export type IncidentPermissionGate = ReturnType<typeof createIncidentPermissionGate>;
