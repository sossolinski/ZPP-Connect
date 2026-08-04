import type { NextFunction, Request, Response } from "express";
import { normalizeRoleName, type Permission } from "@zpp/shared";
import { HttpError } from "./errors.js";

export function hasPermission(req: Request, permission: Permission) {
  return Boolean(req.user?.permissions.includes(permission));
}

export function hasRole(req: Request, role: string) {
  const normalized = normalizeRoleName(role);
  return Boolean(req.user?.roles.some((userRole) => normalizeRoleName(userRole) === normalized));
}

export function requirePermission(permission: Permission) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      next(new HttpError(401, "Authentication required"));
      return;
    }
    if (!hasPermission(req, permission)) {
      next(new HttpError(403, "Forbidden"));
      return;
    }
    next();
  };
}

export function requireAnyPermission(required: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      next(new HttpError(401, "Authentication required"));
      return;
    }
    if (!required.some((permission) => hasPermission(req, permission))) {
      next(new HttpError(403, "Forbidden"));
      return;
    }
    next();
  };
}
