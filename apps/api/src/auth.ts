import { createRemoteJWKSet, jwtVerify } from "jose";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";
import { HttpError } from "./errors.js";
import { prisma } from "./prisma.js";
import { IdentityAuthService, type VerifiedEntraClaims } from "./modules/identity/identity-auth-service.js";
import { developmentSession } from "./modules/identity/development-session-store.js";

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

export async function validateEntraJwt(
  token: string,
  keySet: Parameters<typeof jwtVerify>[1],
  issuer: string,
  audience: string
) {
  return jwtVerify(token, keySet, { issuer, audience });
}

async function verifiedEntraClaims(req: Request): Promise<VerifiedEntraClaims> {
  const header = req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  if (!token) throw new HttpError(401, "Authentication required");
  if (!config.entraJwksUri || !config.entraIssuer || !config.entraAudience) {
    throw new HttpError(500, "Entra authentication is not configured");
  }

  jwks ??= createRemoteJWKSet(new URL(config.entraJwksUri));
  const result = await validateEntraJwt(token, jwks, config.entraIssuer, config.entraAudience);
  const payload = result.payload as Record<string, unknown>;
  const subject = String(payload.sub ?? "").trim();
  if (!subject) throw new HttpError(401, "Verified token has no stable subject");
  return {
    issuer: String(payload.iss ?? config.entraIssuer),
    subject,
    tenantId: String(payload.tid ?? "").trim() || undefined,
    objectId: String(payload.oid ?? "").trim() || undefined,
    email: String(payload.email ?? payload.preferred_username ?? payload.upn ?? "").trim() || undefined
  };
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const service = new IdentityAuthService(prisma);
    if (config.authMode === "entra") {
      req.user = await service.authenticateEntra(await verifiedEntraClaims(req));
    } else {
      if (config.nodeEnv === "production") throw new HttpError(500, "Development authentication is disabled in production");
      const bearer = req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
      const session = bearer ? developmentSession(bearer) : undefined;
      if (session) {
        const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { email: true } });
        if (!user) throw new HttpError(401, "Authentication required");
        req.user = await service.authenticateDevelopmentEmail(user.email);
      } else {
        const email = req.header("x-user-email")?.trim();
        if (!email) throw new HttpError(401, "Authentication required");
        req.user = await service.authenticateDevelopmentEmail(email);
      }
    }
    next();
  } catch (error) {
    next(error);
  }
}
