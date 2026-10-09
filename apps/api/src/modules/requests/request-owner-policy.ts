import type { Prisma, PrismaClient } from "@prisma/client";
import type { Permission } from "@zpp/shared";
import { EffectiveAccessService } from "../identity/effective-access-service.js";

type Db = PrismaClient | Prisma.TransactionClient;
export const requestOwnerPermissions: Permission[] = ["request:read", "request:update", "request:close"];

/** Active membership is deliberate, including for an administrator proposed as an owner. */
export async function isSuitableRequestOwner(db: Db, incidentId: string, userId: string): Promise<boolean> {
  const member = await db.incidentAssignment.count({ where: { incidentId, userId, active: true, user: { status: "Active" } } });
  return member > 0 && new EffectiveAccessService(db).hasEffectivePermissions(userId, requestOwnerPermissions, { incidentId });
}
