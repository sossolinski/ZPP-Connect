import type { Prisma } from "@prisma/client";
import type { NotificationOutboxInput } from "./notification-types.js";

const payloadKeys: Record<NotificationOutboxInput["eventType"], ReadonlySet<string>> = {
  SESSION_CLOSED: new Set(["operationalId", "occurredAt"]),
  ASSIGNMENT_ASSIGNED: new Set(["operationalId", "command", "occurredAt"]),
  ASSIGNMENT_CANCELLED: new Set(["operationalId", "occurredAt"]),
  ASSIGNMENT_ESCALATED: new Set(["operationalId", "occurredAt"]),
  ROSTER_PUBLISHED: new Set(["memberProfileId", "operationalId", "occurredAt"]),
  TRAINING_ASSIGNED: new Set(["memberProfileId", "operationalId", "occurredAt"]),
  DOCUMENT_REQUIREMENT_CREATED: new Set(["requirementId", "occurredAt"]),
  DOCUMENT_REQUIREMENT_UPDATED: new Set(["requirementId", "occurredAt"]),
  ACCESS_CHANGED: new Set(["title", "message", "occurredAt"]),
};

function safePayload(input: NotificationOutboxInput) {
  const allowed = payloadKeys[input.eventType];
  const payload = Object.fromEntries(Object.entries(input.payload).filter(([key, value]) => allowed.has(key) && ["string", "number", "boolean"].includes(typeof value)));
  if (!payload.occurredAt) throw new Error("Notification outbox payload requires occurredAt");
  if (Object.values(payload).some((value) => typeof value === "string" && (value.length > 200 || /password|token|secret|passport|medical|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value)))) throw new Error("Unsafe notification outbox payload");
  return payload;
}

export async function enqueueNotification(tx: Prisma.TransactionClient, input: NotificationOutboxInput) {
  await tx.notificationOutbox.upsert({
    where: { eventType_aggregateType_aggregateId_aggregateVersion: {
      eventType: input.eventType,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      aggregateVersion: input.aggregateVersion,
    } },
    update: {},
    create: {
      eventType: input.eventType,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      aggregateVersion: input.aggregateVersion,
      recipientUserId: input.recipientUserId ?? null,
      sessionId: input.sessionId ?? null,
      payload: safePayload(input) as Prisma.InputJsonValue,
    },
  });
}
