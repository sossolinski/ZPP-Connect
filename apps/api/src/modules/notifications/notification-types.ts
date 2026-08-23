export type NotificationKind = "Action required" | "Information";
export type NotificationSeverity = "Critical" | "Attention" | "Information";
export type NotificationCategory = "Session" | "Briefing" | "Assignment" | "Rostering" | "Training" | "Documents" | "Readiness" | "Requests" | "Operational" | "Admin";
export type NotificationSourceType = "session" | "briefing" | "assignment" | "rosterShift" | "trainingRecord" | "documentVersion" | "documentRequirement" | "access";

export type NotificationActor = { id: string; email: string; displayName: string };
export type NotificationClock = { now(): Date };

export type NotificationInput = {
  recipientUserId: string;
  deduplicationKey: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  category: NotificationCategory;
  title: string;
  message: string;
  sessionId?: string | null;
  sessionLabel?: string | null;
  sourceType: NotificationSourceType;
  sourceId: string;
  sourceLabel?: string | null;
  conditionType?: string | null;
  actionDestination?: string | null;
  actionLabel?: string | null;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
  resetUnread?: boolean;
};

export type NotificationListQuery = {
  unread?: boolean;
  kind?: NotificationKind;
  category?: NotificationCategory;
  severity?: NotificationSeverity;
  sessionId?: string;
  sourceType?: NotificationSourceType;
  status?: "active" | "resolved";
  limit: number;
  offset: number;
  sort: "newest" | "oldest";
};

export type NotificationItem = {
  id: string;
  deduplicationKey: string;
  recipientUserId: string;
  mode: "EVENT" | "CONDITION";
  kind: NotificationKind;
  severity: NotificationSeverity;
  category: NotificationCategory;
  title: string;
  message: string;
  sessionId?: string | null;
  sessionLabel?: string | null;
  sourceType: NotificationSourceType;
  sourceId: string;
  sourceLabel?: string | null;
  conditionType?: string | null;
  actionDestination?: string | null;
  actionLabel?: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  createdAtIso: string;
  updatedAt: string;
  updatedAtIso: string;
  readAt?: string | null;
  resolvedAt?: string | null;
  resolutionReason?: string | null;
  version: number;
  read: boolean;
  unread: boolean;
  active: boolean;
  resolved: boolean;
  requiresAction: boolean;
  href?: string;
  priority: "critical" | "action" | "update" | "info";
  categoryLegacy: "operational" | "task" | "training" | "admin" | "system";
};

export type NotificationPage = { total: number; limit: number; offset: number; data: NotificationItem[] };
export type NotificationCounts = { total: number; unread: number; active: number; resolved: number; actionRequired: number; actionRequiredUnread: number; updates: number; updatesUnread: number; criticalUnread: number };

export type NotificationOutboxInput = {
  eventType: "SESSION_CLOSED" | "ASSIGNMENT_ASSIGNED" | "ASSIGNMENT_CANCELLED" | "ASSIGNMENT_ESCALATED" | "ROSTER_PUBLISHED" | "TRAINING_ASSIGNED" | "DOCUMENT_REQUIREMENT_CREATED" | "DOCUMENT_REQUIREMENT_UPDATED" | "ACCESS_CHANGED";
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: string;
  recipientUserId?: string | null;
  sessionId?: string | null;
  payload: Record<string, unknown>;
};

export type ClaimedOutbox = NotificationOutboxInput & { id: string; attemptCount: number; maxAttempts: number };
