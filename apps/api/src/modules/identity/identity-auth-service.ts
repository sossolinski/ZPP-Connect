import type { PrismaClient } from "@prisma/client";
import { HttpError } from "../../errors.js";
import { EffectiveAccessService } from "./effective-access-service.js";

export type VerifiedEntraClaims = {
  issuer: string;
  subject: string;
  tenantId?: string;
  objectId?: string;
  email?: string;
};

function normalizedEmail(email: string | undefined) {
  return email?.trim().toLowerCase() || undefined;
}

export class IdentityAuthService {
  constructor(private readonly db: PrismaClient) {}

  async authenticateDevelopmentEmail(email: string) {
    const user = await this.db.user.findUnique({ where: { normalizedEmail: email.trim().toLowerCase() }, select: { id: true } });
    if (!user) throw new HttpError(401, "User is not provisioned or active");
    const projection = await new EffectiveAccessService(this.db).forUser(user.id);
    if (!projection) throw new HttpError(401, "User is not provisioned or active");
    return projection;
  }

  async authenticateEntra(claims: VerifiedEntraClaims) {
    const providerType = "MICROSOFT_ENTRA";
    const providerSubject = claims.objectId && claims.tenantId ? claims.objectId : claims.subject;
    const issuer = claims.issuer;

    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`external-identity:${providerType}:${issuer}:${providerSubject}`}))`;
      let identity = await tx.externalIdentity.findUnique({
        where: { providerType_issuer_providerSubject: { providerType, issuer, providerSubject } },
        include: { user: true }
      });

      if (!identity && claims.tenantId && claims.objectId) {
        identity = await tx.externalIdentity.findFirst({
          where: { providerType, tenantId: claims.tenantId, directoryObjectId: claims.objectId },
          include: { user: true }
        });
      }

      if (!identity) {
        const email = normalizedEmail(claims.email);
        if (!email) throw new HttpError(401, "Identity is not provisioned");
        const candidates = await tx.user.findMany({
          where: { normalizedEmail: email, status: { in: ["Pending", "Active"] } },
          include: { externalIdentities: true },
          take: 2
        });
        if (candidates.length !== 1 || candidates[0]!.externalIdentities.length > 0) {
          throw new HttpError(401, "Identity is not provisioned");
        }
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${candidates[0]!.id}::uuid FOR UPDATE`;
        const user = await tx.user.findUniqueOrThrow({ where: { id: candidates[0]!.id }, include: { externalIdentities: true } });
        if (!["Pending", "Active"].includes(user.status) || user.externalIdentities.length > 0 || user.normalizedEmail !== email) throw new HttpError(401, "Identity is not provisioned");
        let invitation = user.status === "Pending" ? await tx.userInvitation.findFirst({
          where: {
            userId: user.id,
            invitedEmailSnapshot: email,
            status: { in: ["Prepared", "Sent"] },
            tokenExpiresAt: { gt: new Date() }
          },
          orderBy: { createdAt: "desc" }
        }) : null;
        if (invitation) {
          await tx.$queryRaw`SELECT "id" FROM "UserInvitation" WHERE "id" = ${invitation.id}::uuid FOR UPDATE`;
          invitation = await tx.userInvitation.findFirst({ where: { id: invitation.id, status: { in: ["Prepared", "Sent"] }, tokenExpiresAt: { gt: new Date() } } });
        }
        if (user.status === "Pending" && !invitation) throw new HttpError(401, "Identity is not provisioned");
        identity = await tx.externalIdentity.create({
          data: {
            userId: user.id,
            providerType,
            issuer,
            tenantId: claims.tenantId,
            providerSubject,
            directoryObjectId: claims.objectId,
            authenticationMethod: "MICROSOFT_SSO",
            emailSnapshot: email,
            lastSeenAt: new Date(),
            lastSuccessfulAuthenticationAt: new Date()
          },
          include: { user: true }
        });
        await tx.auditLog.create({
          data: {
            action: "identity_linked",
            entityType: "userIdentity",
            entityId: identity.id,
            sessionId: null,
            actorId: user.id,
            actorEmail: user.email,
            summary: "Microsoft Entra identity linked",
            metadata: { targetUserId: user.id, identityId: identity.id, providerType, issuer, legacyFirstBind: true }
          }
        });
        if (invitation) {
          const acceptedAt = new Date();
          const accepted = await tx.userInvitation.update({
            where: { id: invitation.id },
            data: { status: "Accepted", acceptedAt, version: { increment: 1 } }
          });
          await tx.user.update({
            where: { id: user.id },
            data: { status: "Active", activatedAt: acceptedAt, updatedById: user.id, version: { increment: 1 } }
          });
          await tx.auditLog.create({
            data: {
              action: "invitation_accepted",
              entityType: "userInvitation",
              entityId: invitation.id,
              sessionId: null,
              actorId: user.id,
              actorEmail: user.email,
              summary: "Invitation accepted through Microsoft Entra",
              metadata: { targetUserId: user.id, invitationId: invitation.id, identityId: identity.id, authenticationMethod: "MICROSOFT_SSO" }
            }
          });
          await tx.notificationOutbox.create({
            data: {
              eventType: "ACCESS_CHANGED",
              aggregateType: "userAccess",
              aggregateId: invitation.id,
              aggregateVersion: String(accepted.version),
              recipientUserId: user.id,
              sessionId: null,
              payload: { title: "Onboarding completed", message: "Your account is active.", occurredAt: acceptedAt.toISOString() }
            }
          });
        }
      } else if (identity.disabledAt) {
        throw new HttpError(401, "Identity is disabled");
      }

      // Authentication middleware runs for every protected API request. Durable
      // sign-in telemetry belongs at the interactive login boundary, not here;
      // otherwise normal API traffic becomes an identity writer.

      const projection = await new EffectiveAccessService(tx).forUser(identity.userId);
      if (!projection) throw new HttpError(401, "User is not provisioned or active");
      return projection;
    });
  }
}
