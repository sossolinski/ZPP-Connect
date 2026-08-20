import type { ClaimedOutbox, NotificationCounts, NotificationInput, NotificationItem, NotificationListQuery, NotificationPage } from "./notification-types.js";

export interface NotificationRepository {
  readonly kind: "memory" | "postgres";
  list(recipientUserId: string, query: NotificationListQuery): Promise<NotificationPage>;
  counts(recipientUserId: string): Promise<NotificationCounts>;
  getVisible(recipientUserId: string, id: string): Promise<NotificationItem | null>;
  markRead(recipientUserId: string, id: string, read: boolean, at: Date): Promise<NotificationItem | null>;
  markAllRead(recipientUserId: string, ids: string[] | undefined, at: Date): Promise<{ updatedCount: number }>;
  createEvent(input: NotificationInput): Promise<NotificationItem>;
  upsertCondition(input: NotificationInput): Promise<NotificationItem>;
  resolveCondition(recipientUserId: string, deduplicationKey: string, reason: string, at: Date): Promise<void>;
  resolveMissingConditions(conditionType: string, activeKeys: string[], at: Date): Promise<number>;
  claimOutbox(workerId: string, limit: number, leaseUntil: Date, at: Date): Promise<ClaimedOutbox[]>;
  markOutboxDelivered(id: string, workerId: string, at: Date): Promise<void>;
  releaseOutboxWaiting(id: string, workerId: string, availableAt: Date, reason: string, at: Date): Promise<void>;
  markOutboxFailed(id: string, workerId: string, availableAt: Date, error: string, final: boolean, at: Date): Promise<void>;
  deliveryHealth(at: Date): Promise<{ pending: number; failed: number; oldestPendingAgeSeconds: number | null }>;
}
