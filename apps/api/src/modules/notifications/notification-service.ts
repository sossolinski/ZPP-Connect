import type { NotificationRepository } from "./notification-repository.js";
import type { NotificationClock, NotificationInput, NotificationListQuery } from "./notification-types.js";
import { safeNotificationInput } from "./notification-policy.js";

export function createPersistentNotificationService(repository: NotificationRepository, clock: NotificationClock = { now: () => new Date() }) {
  return {
    durable: repository.kind === "postgres",
    list: (user: { id?: string; userId?: string }, query: NotificationListQuery) => repository.list(user.id ?? user.userId!, query),
    counts: (user: { id?: string; userId?: string }) => repository.counts(user.id ?? user.userId!),
    get: (user: { id?: string; userId?: string }, id: string) => repository.getVisible(user.id ?? user.userId!, id),
    markRead: (user: { id?: string; userId?: string }, id: string) => repository.markRead(user.id ?? user.userId!, id, true, clock.now()),
    markUnread: (user: { id?: string; userId?: string }, id: string) => repository.markRead(user.id ?? user.userId!, id, false, clock.now()),
    markAllRead: (user: { id?: string; userId?: string }, ids?: string[]) => repository.markAllRead(user.id ?? user.userId!, ids, clock.now()),
    createEvent: (input: NotificationInput) => repository.createEvent(safeNotificationInput({ ...input, createdAt: input.createdAt ?? clock.now() })),
    upsertCondition: (input: NotificationInput) => repository.upsertCondition(safeNotificationInput({ ...input, createdAt: input.createdAt ?? clock.now() })),
    deliveryHealth: () => repository.deliveryHealth(clock.now()),
  };
}
