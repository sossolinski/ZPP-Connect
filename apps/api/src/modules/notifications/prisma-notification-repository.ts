import { Prisma, type Notification, type PrismaClient } from "@prisma/client";
import type { NotificationRepository } from "./notification-repository.js";
import type { ClaimedOutbox, NotificationInput, NotificationItem, NotificationListQuery } from "./notification-types.js";
import { safeNotificationInput } from "./notification-policy.js";

const productTime = (date: Date) => new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
const iso = (date?: Date | null) => date?.toISOString() ?? null;

function item(row: Notification): NotificationItem {
  const active = !row.resolvedAt;
  const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : {};
  return {
    id: row.id, deduplicationKey: row.deduplicationKey, recipientUserId: row.recipientUserId,
    mode: row.mode as NotificationItem["mode"],
    kind: row.kind as NotificationItem["kind"], severity: row.severity as NotificationItem["severity"], category: row.category as NotificationItem["category"],
    title: row.title, message: row.message, sessionId: row.sessionId, sessionLabel: row.sessionLabel,
    sourceType: row.sourceType as NotificationItem["sourceType"], sourceId: row.sourceId, sourceLabel: row.sourceLabel,
    conditionType: row.conditionType, actionDestination: row.actionDestination, actionLabel: row.actionLabel, metadata,
    createdAt: productTime(row.createdAt), createdAtIso: row.createdAt.toISOString(), updatedAt: productTime(row.updatedAt), updatedAtIso: row.updatedAt.toISOString(),
    readAt: iso(row.readAt), resolvedAt: iso(row.resolvedAt), resolutionReason: row.resolutionReason, version: row.version,
    read: Boolean(row.readAt), unread: !row.readAt, active, resolved: !active, requiresAction: row.kind === "Action required" && active,
    href: row.actionDestination ?? undefined,
    priority: row.severity === "Critical" ? "critical" : row.kind === "Action required" ? "action" : row.severity === "Attention" ? "update" : "info",
    categoryLegacy: row.category === "Training" || row.category === "Documents" || row.category === "Readiness" ? "training" : row.category === "Assignment" || row.category === "Rostering" ? "task" : row.category === "Session" || row.category === "Briefing" || row.category === "Requests" || row.category === "Operational" ? "operational" : "system",
  };
}

function visible(recipientUserId: string): Prisma.NotificationWhereInput {
  return {
    recipientUserId,
    recipient: { status: { in: ["active", "Active"] } },
    OR: [
      { sessionId: null },
      { session: { incidentAssignments: { some: { userId: recipientUserId, active: true } } } },
      { recipient: { roles: { some: { role: { name: "system-admin" } } } } },
    ],
  };
}

function data(input: NotificationInput): Prisma.NotificationUncheckedCreateInput {
  input = safeNotificationInput(input);
  return {
    recipientUserId: input.recipientUserId, deduplicationKey: input.deduplicationKey, mode: input.conditionType ? "CONDITION" : "EVENT", kind: input.kind, severity: input.severity, category: input.category,
    title: input.title, message: input.message, sessionId: input.sessionId ?? null, sessionLabel: input.sessionLabel ?? null,
    sourceType: input.sourceType, sourceId: input.sourceId, sourceLabel: input.sourceLabel ?? null, conditionType: input.conditionType ?? null,
    actionDestination: input.actionDestination ?? null, actionLabel: input.actionLabel ?? null, metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
    createdAt: input.createdAt, updatedAt: input.createdAt,
  };
}

export function createPrismaNotificationRepository(client: PrismaClient): NotificationRepository {
  return {
    kind: "postgres",
    async list(recipientUserId, query) {
      const where: Prisma.NotificationWhereInput = {
        ...visible(recipientUserId),
        ...(query.unread === undefined ? {} : query.unread ? { readAt: null } : { readAt: { not: null } }),
        ...(query.kind ? { kind: query.kind } : {}), ...(query.category ? { category: query.category } : {}), ...(query.severity ? { severity: query.severity } : {}),
        ...(query.sessionId ? { sessionId: query.sessionId } : {}), ...(query.sourceType ? { sourceType: query.sourceType } : {}),
        ...(query.status === "active" ? { resolvedAt: null } : query.status === "resolved" ? { resolvedAt: { not: null } } : {}),
      };
      const [total, rows] = await client.$transaction([
        client.notification.count({ where }),
        client.notification.findMany({ where, orderBy: query.sort === "oldest" ? [{ createdAt: "asc" }, { id: "asc" }] : [{ readAt: { sort: "asc", nulls: "first" } }, { resolvedAt: { sort: "asc", nulls: "first" } }, { createdAt: "desc" }, { id: "desc" }], skip: query.offset, take: query.limit }),
      ]);
      return { total, limit: query.limit, offset: query.offset, data: rows.map(item) };
    },
    async counts(recipientUserId) {
      const where = visible(recipientUserId);
      const [total, unread, active, resolved, actionRequired, actionRequiredUnread, updates, updatesUnread, criticalUnread] = await client.$transaction([
        client.notification.count({ where }),
        client.notification.count({ where: { ...where, readAt: null } }),
        client.notification.count({ where: { ...where, resolvedAt: null } }),
        client.notification.count({ where: { ...where, resolvedAt: { not: null } } }),
        client.notification.count({ where: { ...where, kind: "Action required", resolvedAt: null } }),
        client.notification.count({ where: { ...where, kind: "Action required", resolvedAt: null, readAt: null } }),
        client.notification.count({ where: { AND: [where, { OR: [{ kind: "Information" }, { resolvedAt: { not: null } }] }] } }),
        client.notification.count({ where: { AND: [where, { readAt: null, OR: [{ kind: "Information" }, { resolvedAt: { not: null } }] }] } }),
        client.notification.count({ where: { ...where, severity: "Critical", readAt: null } }),
      ]);
      return {
        total, unread, active, resolved, actionRequired, actionRequiredUnread, updates, updatesUnread, criticalUnread,
      };
    },
    async getVisible(recipientUserId, id) { const row = await client.notification.findFirst({ where: { id, ...visible(recipientUserId) } }); return row ? item(row) : null; },
    async markRead(recipientUserId, id, read, at) {
      return client.$transaction(async (tx) => {
        const current = await tx.notification.findFirst({ where: { id, ...visible(recipientUserId) } });
        if (!current) return null;
        if ((read && current.readAt) || (!read && !current.readAt)) return item(current);
        return item(await tx.notification.update({ where: { id }, data: { readAt: read ? at : null, updatedAt: at } }));
      });
    },
    async markAllRead(recipientUserId, ids, at) {
      return client.$transaction(async (tx) => {
        const unique = ids ? [...new Set(ids)] : undefined;
        if (unique) {
          const count = await tx.notification.count({ where: { ...visible(recipientUserId), id: { in: unique } } });
          if (count !== unique.length) throw new Error("NOTIFICATION_NOT_FOUND");
        }
        const result = await tx.notification.updateMany({ where: { ...visible(recipientUserId), ...(unique ? { id: { in: unique } } : {}), readAt: null }, data: { readAt: at, updatedAt: at } });
        return { updatedCount: result.count };
      });
    },
    async createEvent(input) {
      try { return item(await client.notification.create({ data: data({ ...input, conditionType: null }) })); }
      catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
        return item(await client.notification.findUniqueOrThrow({ where: { recipientUserId_deduplicationKey: { recipientUserId: input.recipientUserId, deduplicationKey: input.deduplicationKey } } }));
      }
    },
    async upsertCondition(input) {
      input = safeNotificationInput(input);
      const at = input.createdAt ?? new Date();
      const [row] = await client.$queryRaw<Notification[]>(Prisma.sql`
        INSERT INTO "Notification" ("recipientUserId", "deduplicationKey", "mode", "kind", "severity", "category", "title", "message", "sessionId", "sessionLabel", "sourceType", "sourceId", "sourceLabel", "conditionType", "actionDestination", "actionLabel", "metadata", "createdAt", "updatedAt")
        VALUES (${input.recipientUserId}::uuid, ${input.deduplicationKey}, 'CONDITION', ${input.kind}, ${input.severity}, ${input.category}, ${input.title}, ${input.message}, ${input.sessionId ?? null}::uuid, ${input.sessionLabel ?? null}, ${input.sourceType}, ${input.sourceId}, ${input.sourceLabel ?? null}, ${input.conditionType ?? null}, ${input.actionDestination ?? null}, ${input.actionLabel ?? null}, ${JSON.stringify(input.metadata ?? {})}::jsonb, ${at}, ${at})
        ON CONFLICT ("recipientUserId", "deduplicationKey") DO UPDATE SET
          "kind" = EXCLUDED."kind", "severity" = EXCLUDED."severity", "category" = EXCLUDED."category", "title" = EXCLUDED."title", "message" = EXCLUDED."message",
          "sessionId" = EXCLUDED."sessionId", "sessionLabel" = EXCLUDED."sessionLabel", "sourceLabel" = EXCLUDED."sourceLabel", "actionDestination" = EXCLUDED."actionDestination",
          "actionLabel" = EXCLUDED."actionLabel", "metadata" = EXCLUDED."metadata", "resolvedAt" = NULL, "resolutionReason" = NULL,
          "readAt" = CASE WHEN "Notification"."resolvedAt" IS NOT NULL OR ${Boolean(input.resetUnread)} THEN NULL ELSE "Notification"."readAt" END,
          "version" = "Notification"."version" + 1, "updatedAt" = EXCLUDED."updatedAt"
        RETURNING *
      `);
      return item(row!);
    },
    async resolveCondition(recipientUserId, deduplicationKey, reason, at) { await client.notification.updateMany({ where: { recipientUserId, deduplicationKey, conditionType: { not: null }, resolvedAt: null }, data: { resolvedAt: at, resolutionReason: reason, version: { increment: 1 }, updatedAt: at } }); },
    async resolveMissingConditions(conditionType, activeKeys, at) {
      const result = await client.notification.updateMany({ where: { conditionType, resolvedAt: null, ...(activeKeys.length ? { deduplicationKey: { notIn: activeKeys } } : {}) }, data: { resolvedAt: at, resolutionReason: "Source no longer requires action", version: { increment: 1 }, updatedAt: at } });
      return result.count;
    },
    async claimOutbox(workerId, limit, leaseUntil, at) {
      const rows = await client.$queryRaw<Array<any>>(Prisma.sql`
        WITH candidates AS (
          SELECT "id" FROM "NotificationOutbox"
          WHERE (("status" = 'PENDING' AND "availableAt" <= ${at}) OR ("status" = 'PROCESSING' AND "leaseUntil" < ${at}))
          ORDER BY "availableAt", "createdAt" FOR UPDATE SKIP LOCKED LIMIT ${limit}
        )
        UPDATE "NotificationOutbox" o SET "status" = 'PROCESSING', "lockedBy" = ${workerId}, "lockedAt" = ${at}, "leaseUntil" = ${leaseUntil}, "attemptCount" = o."attemptCount" + 1, "updatedAt" = ${at}
        FROM candidates WHERE o."id" = candidates."id" RETURNING o.*
      `);
      return rows.map((row) => ({ id: row.id, eventType: row.eventType, aggregateType: row.aggregateType, aggregateId: row.aggregateId, aggregateVersion: row.aggregateVersion, recipientUserId: row.recipientUserId, sessionId: row.sessionId, payload: row.payload as Record<string, unknown>, attemptCount: row.attemptCount, maxAttempts: row.maxAttempts })) as ClaimedOutbox[];
    },
    async markOutboxDelivered(id, workerId, at) { await client.notificationOutbox.updateMany({ where: { id, status: "PROCESSING", lockedBy: workerId }, data: { status: "DELIVERED", deliveredAt: at, lockedAt: null, leaseUntil: null, lockedBy: null, lastError: null, updatedAt: at } }); },
    async releaseOutboxWaiting(id, workerId, availableAt, reason, at) { await client.$executeRaw`UPDATE "NotificationOutbox" SET "status"='PENDING', "attemptCount"=GREATEST("attemptCount"-1,0), "availableAt"=${availableAt}, "lockedAt"=NULL, "leaseUntil"=NULL, "lockedBy"=NULL, "lastError"=${reason}, "updatedAt"=${at} WHERE "id"=${id}::uuid AND "status"='PROCESSING' AND "lockedBy"=${workerId}`; },
    async markOutboxFailed(id, workerId, availableAt, error, final, at) { await client.notificationOutbox.updateMany({ where: { id, status: "PROCESSING", lockedBy: workerId }, data: final ? { status: "FAILED", failedAt: at, lastError: error.slice(0, 1000), lockedAt: null, leaseUntil: null, lockedBy: null, updatedAt: at } : { status: "PENDING", availableAt, lastError: error.slice(0, 1000), lockedAt: null, leaseUntil: null, lockedBy: null, updatedAt: at } }); },
    async deliveryHealth(at) {
      const [pending, failed, oldest] = await client.$transaction([
        client.notificationOutbox.count({ where: { status: { in: ["PENDING", "PROCESSING"] } } }),
        client.notificationOutbox.count({ where: { status: "FAILED" } }),
        client.notificationOutbox.findFirst({ where: { status: { in: ["PENDING", "PROCESSING"] } }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
      ]);
      return { pending, failed, oldestPendingAgeSeconds: oldest ? Math.max(0, Math.floor((at.getTime() - oldest.createdAt.getTime()) / 1000)) : null };
    },
  };
}
