import { createHash } from "node:crypto";
import { normalizeRoleName } from "@zpp/shared";
import type { AuthenticatedUser } from "./types.js";

export type NotificationKind = "Action required" | "Information";
export type NotificationSeverity = "Critical" | "Attention" | "Information";
export type NotificationCategory = "Session" | "Briefing" | "Assignment" | "Rostering" | "Training" | "Documents" | "Readiness" | "Requests" | "Operational" | "Admin";
export type NotificationSourceType = "session" | "briefing" | "assignment" | "rosterShift" | "trainingRecord" | "documentVersion" | "documentRequirement" | "access";

export type NotificationRecord = {
  id: string;
  deduplicationKey: string;
  recipientUserId: string;
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
  actionDestination?: string | null;
  actionLabel?: string | null;
  createdAt: string;
  updatedAt: string;
  readAt?: string | null;
  resolvedAt?: string | null;
  resolutionReason?: string | null;
  metadata?: Record<string, unknown>;
};

export type NotificationItem = NotificationRecord & {
  createdAtIso: string;
  updatedAtIso: string;
  read: boolean;
  unread: boolean;
  active: boolean;
  resolved: boolean;
  requiresAction: boolean;
  href?: string;
  priority: "critical" | "action" | "update" | "info";
  categoryLegacy: "operational" | "task" | "training" | "admin" | "system";
};

export type NotificationListQuery = {
  unread?: unknown;
  kind?: unknown;
  category?: unknown;
  severity?: unknown;
  sessionId?: unknown;
  sourceType?: unknown;
  status?: unknown;
  active?: unknown;
  resolved?: unknown;
  limit?: unknown;
  offset?: unknown;
  sort?: unknown;
};

export type NotificationCounts = {
  total: number;
  unread: number;
  active: number;
  resolved: number;
  actionRequired: number;
  actionRequiredUnread: number;
  updates: number;
  updatesUnread: number;
  criticalUnread: number;
};

type NotificationUser = Pick<AuthenticatedUser, "userId" | "email" | "displayName" | "roles" | "permissions">;
type AnyRow = Record<string, any>;
type MaybeUser = NotificationUser | null | undefined;
type SourceUser = {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
};

type NotificationSources = {
  users?: SourceUser[];
  sessions?: AnyRow[];
  assignments?: AnyRow[];
  directory?: AnyRow;
  rostering?: AnyRow;
  training?: AnyRow;
  documents?: AnyRow;
  activeEvent?: AnyRow;
  permissionsForRoleNames?: (roles: string[]) => string[];
};

type CreateNotificationInput = Omit<NotificationRecord, "id" | "createdAt" | "updatedAt" | "readAt" | "resolvedAt" | "resolutionReason"> & {
  id?: string;
  createdAt?: string;
  updatedAt?: string;
  readAt?: string | null;
  resolvedAt?: string | null;
  resolutionReason?: string | null;
  reopenResolved?: boolean;
};

const defaultNow = () => new Date().toISOString();
const terminalAssignmentStatuses = new Set(["Completed", "Cancelled"]);
const terminalRosterStatuses = new Set(["Confirmed", "Declined", "Cancelled", "Completed"]);
const terminalTrainingStatuses = new Set(["Completed", "Verified", "Waived", "Cancelled"]);
const technicalWordPattern = /demo|in-memory|reset on restart|database not connected|source not connected|temporary storage|local development/i;

function stableNotificationId(key: string) {
  return `ntf-${createHash("sha1").update(key).digest("hex").slice(0, 16)}`;
}

function dateOnly(value?: unknown) {
  const date = value ? new Date(String(value)) : null;
  return date && Number.isFinite(date.getTime()) ? date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : null;
}

function productTimestamp(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function asIso(value?: unknown, fallback = defaultNow()) {
  const date = value ? new Date(String(value)) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

function parseBoolean(value: unknown) {
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  return undefined;
}

function parseNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function normalizeString(value: unknown) {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function safeCopyText(value: unknown, fallback: string) {
  const text = String(value ?? fallback).trim() || fallback;
  return technicalWordPattern.test(text) ? fallback : text;
}

function hasObserverRole(user: Pick<SourceUser, "roles">) {
  return user.roles.some((role) => normalizeRoleName(role) === "observer");
}

function userKey(user?: MaybeUser) {
  return user?.userId ?? user?.email?.toLowerCase() ?? "anonymous";
}

function toView(record: NotificationRecord): NotificationItem {
  const active = !record.resolvedAt;
  const requiresAction = record.kind === "Action required" && active;
  return {
    ...record,
    createdAt: productTimestamp(record.createdAt),
    updatedAt: productTimestamp(record.updatedAt),
    createdAtIso: record.createdAt,
    updatedAtIso: record.updatedAt,
    read: Boolean(record.readAt),
    unread: !record.readAt,
    active,
    resolved: !active,
    requiresAction,
    href: record.actionDestination ?? undefined,
    priority: record.severity === "Critical" ? "critical" : record.kind === "Action required" ? "action" : record.severity === "Attention" ? "update" : "info",
    categoryLegacy: record.category === "Training" || record.category === "Documents" || record.category === "Readiness"
      ? "training"
      : record.category === "Assignment" || record.category === "Rostering"
        ? "task"
        : record.category === "Session" || record.category === "Briefing" || record.category === "Requests" || record.category === "Operational"
          ? "operational"
          : "system"
  };
}

function actorFor(user: NotificationUser, permissionsForRoleNames?: (roles: string[]) => string[]) {
  return {
    id: user.userId,
    email: user.email,
    displayName: user.displayName,
    roles: [...(user.roles ?? [])],
    permissions: [...(user.permissions ?? permissionsForRoleNames?.(user.roles ?? []) ?? [])]
  };
}

function userFromSource(sourceUser: SourceUser, permissionsForRoleNames?: (roles: string[]) => string[]): NotificationUser {
  return {
    userId: sourceUser.id,
    email: sourceUser.email,
    displayName: sourceUser.displayName,
    roles: sourceUser.roles,
    permissions: permissionsForRoleNames?.(sourceUser.roles) as AuthenticatedUser["permissions"] ?? []
  };
}

function hasPermission(user: NotificationUser, permission: string, permissionsForRoleNames?: (roles: string[]) => string[]) {
  const permissions = new Set<string>([...(user.permissions ?? []), ...(permissionsForRoleNames?.(user.roles ?? []) ?? [])]);
  return permissions.has(permission) || permissions.has("*");
}

function sessionLabel(sessions: AnyRow[] | undefined, sessionId?: string | null) {
  return sessions?.find((session) => session.id === sessionId)?.operationalId ?? sessionId ?? null;
}

function memberFromDirectory(directory: AnyRow | undefined, memberProfileId?: string | null) {
  if (!directory || !memberProfileId) return undefined;
  for (const method of ["lookupMember", "getMember"]) {
    if (typeof directory[method] !== "function") continue;
    try {
      return directory[method](memberProfileId);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function linkedUserIdForMember(directory: AnyRow | undefined, memberProfileId?: string | null) {
  const member = memberFromDirectory(directory, memberProfileId);
  return member?.linkedUserId ?? member?.userId ?? null;
}

function routeForSource(sourceType: NotificationSourceType, sourceId: string) {
  if (sourceType === "assignment") return `/assignments?assignmentId=${encodeURIComponent(sourceId)}`;
  if (sourceType === "briefing") return "/active-event";
  if (sourceType === "session") return "/sessions";
  if (sourceType === "rosterShift") return "/rostering";
  if (sourceType === "trainingRecord") return "/training";
  if (sourceType === "documentVersion" || sourceType === "documentRequirement") return "/documents";
  if (sourceType === "access") return "/settings";
  return "/";
}

class NotificationRepository {
  private records = new Map<string, NotificationRecord>();
  private idsByDeduplicationKey = new Map<string, string>();

  create(input: CreateNotificationInput) {
    const id = input.id ?? stableNotificationId(input.deduplicationKey);
    const existingId = this.idsByDeduplicationKey.get(input.deduplicationKey) ?? id;
    const existing = this.records.get(existingId);
    const timestamp = input.updatedAt ?? input.createdAt ?? defaultNow();

    if (existing) {
      const shouldReopen = Boolean(input.reopenResolved && existing.resolvedAt);
      const merged: NotificationRecord = {
        ...existing,
        kind: input.kind,
        severity: input.severity,
        category: input.category,
        title: safeCopyText(input.title, existing.title),
        message: safeCopyText(input.message, existing.message),
        sessionId: input.sessionId ?? existing.sessionId ?? null,
        sessionLabel: input.sessionLabel ?? existing.sessionLabel ?? null,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        sourceLabel: input.sourceLabel ?? existing.sourceLabel ?? null,
        actionDestination: input.actionDestination ?? existing.actionDestination ?? null,
        actionLabel: input.actionLabel ?? existing.actionLabel ?? null,
        updatedAt: timestamp,
        readAt: input.readAt !== undefined ? input.readAt : existing.readAt ?? null,
        resolvedAt: shouldReopen ? null : input.resolvedAt !== undefined ? input.resolvedAt : existing.resolvedAt ?? null,
        resolutionReason: shouldReopen ? null : input.resolutionReason !== undefined ? input.resolutionReason : existing.resolutionReason ?? null,
        metadata: { ...(existing.metadata ?? {}), ...(input.metadata ?? {}) }
      };
      this.records.set(existingId, merged);
      return toView(merged);
    }

    const record: NotificationRecord = {
      id,
      deduplicationKey: input.deduplicationKey,
      recipientUserId: input.recipientUserId,
      kind: input.kind,
      severity: input.severity,
      category: input.category,
      title: safeCopyText(input.title, "Notification"),
      message: safeCopyText(input.message, "Open the related record when you are ready."),
      sessionId: input.sessionId ?? null,
      sessionLabel: input.sessionLabel ?? null,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sourceLabel: input.sourceLabel ?? null,
      actionDestination: input.actionDestination ?? routeForSource(input.sourceType, input.sourceId),
      actionLabel: input.actionLabel ?? null,
      createdAt: input.createdAt ?? timestamp,
      updatedAt: timestamp,
      readAt: input.readAt ?? null,
      resolvedAt: input.resolvedAt ?? null,
      resolutionReason: input.resolutionReason ?? null,
      metadata: input.metadata ?? {}
    };
    this.records.set(record.id, record);
    this.idsByDeduplicationKey.set(record.deduplicationKey, record.id);
    return toView(record);
  }

  resolveByDeduplicationKey(deduplicationKey: string, reason = "Source resolved", at = defaultNow()) {
    const id = this.idsByDeduplicationKey.get(deduplicationKey);
    if (!id) return undefined;
    const existing = this.records.get(id);
    if (!existing || existing.resolvedAt) return existing ? toView(existing) : undefined;
    const next = { ...existing, resolvedAt: at, resolutionReason: reason, updatedAt: at };
    this.records.set(id, next);
    return toView(next);
  }

  resolveSource(sourceType: NotificationSourceType, sourceId: string, reason = "Source resolved", at = defaultNow()) {
    const resolved: NotificationItem[] = [];
    for (const record of this.records.values()) {
      if (record.sourceType !== sourceType || record.sourceId !== sourceId || record.resolvedAt) continue;
      const next = { ...record, resolvedAt: at, resolutionReason: reason, updatedAt: at };
      this.records.set(record.id, next);
      resolved.push(toView(next));
    }
    return resolved;
  }

  list(recipientUserId: string, query?: NotificationListQuery) {
    const unread = parseBoolean(query?.unread);
    const active = parseBoolean(query?.active);
    const resolved = parseBoolean(query?.resolved);
    const status = normalizeString(query?.status)?.toLowerCase();
    const kind = normalizeString(query?.kind);
    const category = normalizeString(query?.category);
    const severity = normalizeString(query?.severity);
    const sessionId = normalizeString(query?.sessionId);
    const sourceType = normalizeString(query?.sourceType);
    const offset = parseNumber(query?.offset, 0, 0, 100000);
    const limit = parseNumber(query?.limit, 50, 1, 200);
    const sort = normalizeString(query?.sort) ?? "newest";

    let data = Array.from(this.records.values())
      .filter((record) => record.recipientUserId === recipientUserId)
      .map(toView)
      .filter((item) => unread === undefined || item.unread === unread)
      .filter((item) => active === undefined || item.active === active)
      .filter((item) => resolved === undefined || item.resolved === resolved)
      .filter((item) => !status || (status === "active" ? item.active : status === "resolved" ? item.resolved : true))
      .filter((item) => !kind || item.kind === kind)
      .filter((item) => !category || item.category === category)
      .filter((item) => !severity || item.severity === severity)
      .filter((item) => !sessionId || item.sessionId === sessionId)
      .filter((item) => !sourceType || item.sourceType === sourceType);

    data = data.sort((left, right) => {
      if (sort === "oldest") return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
      return Number(right.unread) - Number(left.unread)
        || Number(right.active) - Number(left.active)
        || new Date(right.createdAtIso).getTime() - new Date(left.createdAtIso).getTime();
    });

    return { total: data.length, limit, offset, data: data.slice(offset, offset + limit) };
  }

  get(recipientUserId: string, id: string) {
    const record = this.records.get(id);
    if (!record || record.recipientUserId !== recipientUserId) return undefined;
    return toView(record);
  }

  markRead(recipientUserId: string, id: string, at = defaultNow()) {
    const existing = this.records.get(id);
    if (!existing || existing.recipientUserId !== recipientUserId) return undefined;
    const next = { ...existing, readAt: existing.readAt ?? at, updatedAt: at };
    this.records.set(id, next);
    return toView(next);
  }

  markUnread(recipientUserId: string, id: string, at = defaultNow()) {
    const existing = this.records.get(id);
    if (!existing || existing.recipientUserId !== recipientUserId) return undefined;
    const next = { ...existing, readAt: null, updatedAt: at };
    this.records.set(id, next);
    return toView(next);
  }

  markAllRead(recipientUserId: string, ids?: string[], at = defaultNow()) {
    const allowedIds = new Set(Array.from(this.records.values()).filter((item) => item.recipientUserId === recipientUserId).map((item) => item.id));
    const selectedIds = ids?.length ? ids.filter((id) => allowedIds.has(id)) : Array.from(allowedIds);
    for (const id of selectedIds) this.markRead(recipientUserId, id, at);
    return this.list(recipientUserId, { limit: 200 });
  }

  counts(recipientUserId: string): NotificationCounts {
    const data = Array.from(this.records.values()).filter((item) => item.recipientUserId === recipientUserId).map(toView);
    return {
      total: data.length,
      unread: data.filter((item) => item.unread).length,
      active: data.filter((item) => item.active).length,
      resolved: data.filter((item) => item.resolved).length,
      actionRequired: data.filter((item) => item.kind === "Action required" && item.active).length,
      actionRequiredUnread: data.filter((item) => item.kind === "Action required" && item.active && item.unread).length,
      updates: data.filter((item) => item.kind === "Information" || item.resolved).length,
      updatesUnread: data.filter((item) => (item.kind === "Information" || item.resolved) && item.unread).length,
      criticalUnread: data.filter((item) => item.severity === "Critical" && item.unread).length
    };
  }

  activeConditionsFor(recipientUserId: string) {
    return Array.from(this.records.values()).filter((item) => item.recipientUserId === recipientUserId).map(toView).filter((item) => item.active && item.metadata?.condition === true);
  }
}

export function createNotificationService(sources: NotificationSources = {}) {
  const repository = new NotificationRepository();
  let seeded = false;

  function create(input: CreateNotificationInput) {
    return repository.create(input);
  }

  function sourceUserById(userId?: string | null) {
    return sources.users?.find((user) => user.id === userId);
  }

  function allUsersWith(permission: string) {
    return (sources.users ?? [])
      .map((user) => userFromSource(user, sources.permissionsForRoleNames))
      .filter((user) => hasPermission(user, permission, sources.permissionsForRoleNames));
  }

  function notifyAssignmentCondition(assignment: AnyRow, recipientUserId: string, readAt?: string | null) {
    const dueDate = dateOnly(assignment.dueAt);
    const isCritical = String(assignment.priority) === "Critical";
    const isOverdue = assignment.dueAt ? new Date(String(assignment.dueAt)).getTime() < Date.now() : false;
    return create({
      deduplicationKey: `condition:assignment:${assignment.id}:${recipientUserId}`,
      recipientUserId,
      kind: "Action required",
      severity: isCritical ? "Critical" : "Attention",
      category: "Assignment",
      title: isOverdue ? "Assignment overdue" : "Assignment awaiting action",
      message: `${safeCopyText(assignment.title, "Open assignment")}${dueDate ? ` is due ${dueDate}.` : "."}`,
      sessionId: assignment.sessionId ?? null,
      sessionLabel: sessionLabel(sources.sessions, assignment.sessionId),
      sourceType: "assignment",
      sourceId: assignment.id,
      sourceLabel: assignment.operationalId ?? null,
      actionDestination: routeForSource("assignment", assignment.id),
      actionLabel: "Open assignment",
      readAt,
      reopenResolved: true,
      metadata: { condition: true, conditionType: "assignment", priority: assignment.priority ?? null }
    });
  }

  function notifyRosterCondition(shift: AnyRow, recipientUserId: string, readAt?: string | null) {
    const date = dateOnly(shift.startsAt ?? shift.startAt);
    return create({
      deduplicationKey: `condition:rosterShift:${shift.id}:${recipientUserId}`,
      recipientUserId,
      kind: "Action required",
      severity: "Attention",
      category: "Rostering",
      title: "Shift awaiting confirmation",
      message: `${safeCopyText(shift.functionName ?? shift.function ?? shift.operationalId, "Roster shift")}${date ? ` on ${date}` : ""} needs your confirmation.`,
      sessionId: shift.sessionId ?? null,
      sessionLabel: sessionLabel(sources.sessions, shift.sessionId),
      sourceType: "rosterShift",
      sourceId: shift.id,
      sourceLabel: shift.operationalId ?? null,
      actionDestination: routeForSource("rosterShift", shift.id),
      actionLabel: "Review roster",
      readAt,
      reopenResolved: true,
      metadata: { condition: true, conditionType: "rosterConfirmation", status: shift.status ?? null }
    });
  }

  function notifyTrainingCondition(record: AnyRow, recipientUserId: string) {
    const title = record.status === "Expired" ? "Training expired" : "Training overdue";
    const due = dateOnly(record.dueAt ?? record.validUntil ?? record.expiryAt);
    return create({
      deduplicationKey: `condition:trainingRecord:${record.id}:${title}:${recipientUserId}`,
      recipientUserId,
      kind: "Action required",
      severity: "Attention",
      category: "Training",
      title,
      message: `${safeCopyText(record.courseTitle ?? record.course?.title ?? record.title, "Required training")}${due ? ` needs attention by ${due}.` : " needs attention."}`,
      sessionId: record.sessionId ?? null,
      sessionLabel: sessionLabel(sources.sessions, record.sessionId),
      sourceType: "trainingRecord",
      sourceId: record.id,
      sourceLabel: record.operationalId ?? null,
      actionDestination: routeForSource("trainingRecord", record.id),
      actionLabel: "Open training",
      reopenResolved: true,
      metadata: { condition: true, conditionType: "training", status: record.status ?? null }
    });
  }

  function notifyDocumentCondition(document: AnyRow, recipientUserId: string) {
    return create({
      deduplicationKey: `condition:document:${document.documentVersionId ?? document.versionId ?? document.id}:${recipientUserId}`,
      recipientUserId,
      kind: "Action required",
      severity: document.status === "Overdue" ? "Attention" : "Information",
      category: "Documents",
      title: document.status === "Overdue" ? "Document acknowledgement overdue" : "Document acknowledgement needed",
      message: `${safeCopyText(document.title ?? document.documentTitle, "Required document")} needs your acknowledgement.`,
      sessionId: document.sessionId ?? null,
      sessionLabel: sessionLabel(sources.sessions, document.sessionId),
      sourceType: "documentVersion",
      sourceId: String(document.documentVersionId ?? document.versionId ?? document.id),
      sourceLabel: document.versionLabel ?? document.code ?? null,
      actionDestination: routeForSource("documentVersion", String(document.documentVersionId ?? document.versionId ?? document.id)),
      actionLabel: "Open documents",
      reopenResolved: true,
      metadata: { condition: true, conditionType: "document", status: document.status ?? null }
    });
  }

  function seedInitialEvents() {
    if (seeded) return;
    seeded = true;

    const base = "2026-07-09T09:00:00.000Z";
    const session = sources.sessions?.find((item) => item.status === "Active") ?? sources.sessions?.[0];
    const zpp = sourceUserById("00000000-0000-4000-8000-000000000004");
    const coordinator = sourceUserById("00000000-0000-4000-8000-000000000002");
    const volunteer = sourceUserById("00000000-0000-4000-8000-000000000005");
    const admin = sourceUserById("00000000-0000-4000-8000-000000000001");
    const publishedBriefing = sources.activeEvent?.getCurrent
      ? (() => {
        try {
          return sources.activeEvent.getCurrent(session?.id, actorFor(userFromSource(coordinator ?? sources.users?.[0]!, sources.permissionsForRoleNames)));
        } catch {
          return null;
        }
      })()
      : null;

    if (session && zpp) {
      create({
        deduplicationKey: `event:session:${session.id}:active:${zpp.id}`,
        recipientUserId: zpp.id,
        kind: "Information",
        severity: "Information",
        category: "Session",
        title: "Session active",
        message: `${safeCopyText(session.operationalId, "The active session")} is ready for operational work.`,
        sessionId: session.id,
        sessionLabel: session.operationalId,
        sourceType: "session",
        sourceId: session.id,
        sourceLabel: session.operationalId,
        actionDestination: "/sessions",
        actionLabel: "Open sessions",
        createdAt: base,
        readAt: "2026-07-09T09:05:00.000Z"
      });
    }

    if (publishedBriefing?.briefing && coordinator) {
      create({
        deduplicationKey: `event:briefing:${publishedBriefing.briefing.id}:published:${coordinator.id}`,
        recipientUserId: coordinator.id,
        kind: "Information",
        severity: "Information",
        category: "Briefing",
        title: "Briefing published",
        message: `Briefing revision ${publishedBriefing.briefing.revision ?? ""} is available for the active event.`.replace(/\s+/g, " ").trim(),
        sessionId: publishedBriefing.briefing.sessionId,
        sessionLabel: sessionLabel(sources.sessions, publishedBriefing.briefing.sessionId),
        sourceType: "briefing",
        sourceId: publishedBriefing.briefing.id,
        sourceLabel: publishedBriefing.briefing.title ?? null,
        actionDestination: "/active-event",
        actionLabel: "Read briefing",
        createdAt: "2026-07-09T09:10:00.000Z"
      });
    }

    const firstVolunteerAssignment = sources.assignments?.find((item) => item.assignedUserId === volunteer?.id);
    if (firstVolunteerAssignment && volunteer) {
      create({
        deduplicationKey: `event:assignment:${firstVolunteerAssignment.id}:assigned:${volunteer.id}:${firstVolunteerAssignment.updatedAt ?? firstVolunteerAssignment.createdAt ?? "initial"}`,
        recipientUserId: volunteer.id,
        kind: "Information",
        severity: "Information",
        category: "Assignment",
        title: "Assignment assigned to you",
        message: safeCopyText(firstVolunteerAssignment.title, "Open your assignment."),
        sessionId: firstVolunteerAssignment.sessionId,
        sessionLabel: sessionLabel(sources.sessions, firstVolunteerAssignment.sessionId),
        sourceType: "assignment",
        sourceId: firstVolunteerAssignment.id,
        sourceLabel: firstVolunteerAssignment.operationalId ?? null,
        actionDestination: routeForSource("assignment", firstVolunteerAssignment.id),
        actionLabel: "Open assignment",
        createdAt: "2026-07-09T09:15:00.000Z"
      });
    }

    const completedAdminAssignment = sources.assignments?.find((item) => item.assignedUserId === admin?.id && terminalAssignmentStatuses.has(String(item.status)));
    if (completedAdminAssignment && admin) {
      create({
        deduplicationKey: `condition:assignment:${completedAdminAssignment.id}:${admin.id}`,
        recipientUserId: admin.id,
        kind: "Action required",
        severity: "Information",
        category: "Assignment",
        title: "Assignment completed",
        message: safeCopyText(completedAdminAssignment.title, "Assignment closed."),
        sessionId: completedAdminAssignment.sessionId,
        sessionLabel: sessionLabel(sources.sessions, completedAdminAssignment.sessionId),
        sourceType: "assignment",
        sourceId: completedAdminAssignment.id,
        sourceLabel: completedAdminAssignment.operationalId ?? null,
        actionDestination: routeForSource("assignment", completedAdminAssignment.id),
        actionLabel: "View assignment",
        createdAt: "2026-07-09T09:20:00.000Z",
        readAt: "2026-07-09T09:25:00.000Z",
        resolvedAt: "2026-07-09T09:30:00.000Z",
        resolutionReason: "Source completed",
        metadata: { condition: true, conditionType: "assignment" }
      });
    }
  }

  function reconcileForUser(user: NotificationUser) {
    const recipientUserId = userKey(user);
    const activeKeys = new Set<string>();
    let canResolve = true;

    try {
      for (const assignment of sources.assignments ?? []) {
        if (assignment.assignedUserId !== recipientUserId) continue;
        const key = `condition:assignment:${assignment.id}:${recipientUserId}`;
        if (!terminalAssignmentStatuses.has(String(assignment.status))) {
          activeKeys.add(key);
          notifyAssignmentCondition(assignment, recipientUserId);
        } else {
          repository.resolveByDeduplicationKey(key, "Source completed");
        }
      }
    } catch {
      canResolve = false;
    }

    try {
      const actor = actorFor(user, sources.permissionsForRoleNames);
      if (sources.rostering?.listShifts) {
        const personal = sources.rostering.listShifts({ mine: true, limit: 200 }, actor);
        for (const shift of personal?.data ?? []) {
          const key = `condition:rosterShift:${shift.id}:${recipientUserId}`;
          if (String(shift.status) === "Published") {
            activeKeys.add(key);
            notifyRosterCondition(shift, recipientUserId, repository.get(recipientUserId, stableNotificationId(key))?.readAt ?? null);
          } else if (terminalRosterStatuses.has(String(shift.status))) {
            repository.resolveByDeduplicationKey(key, "Source resolved");
          }
        }
      }
    } catch {
      canResolve = false;
    }

    try {
      const actor = actorFor(user, sources.permissionsForRoleNames);
      if (sources.training?.listRecords) {
        const personal = sources.training.listRecords({ mine: true, limit: 200 }, actor);
        const nowMs = Date.now();
        for (const record of personal?.data ?? []) {
          const status = String(record.status ?? "");
          const dueMs = record.dueAt ? new Date(String(record.dueAt)).getTime() : NaN;
          const expired = status === "Expired";
          const overdue = Number.isFinite(dueMs) && dueMs < nowMs && !terminalTrainingStatuses.has(status);
          const key = `condition:trainingRecord:${record.id}:${expired ? "Training expired" : "Training overdue"}:${recipientUserId}`;
          if (expired || overdue) {
            activeKeys.add(key);
            notifyTrainingCondition(record, recipientUserId);
          } else {
            repository.resolveByDeduplicationKey(key, "Source resolved");
          }
        }
      }
    } catch {
      canResolve = false;
    }

    try {
      const actor = actorFor(user, sources.permissionsForRoleNames);
      if (sources.documents?.listDocuments) {
        const personal = sources.documents.listDocuments({ mine: true, limit: 200 }, actor);
        for (const document of personal?.data ?? []) {
          const status = String(document.status ?? "");
          const key = `condition:document:${document.documentVersionId ?? document.versionId ?? document.id}:${recipientUserId}`;
          if (status === "Required" || status === "Overdue") {
            activeKeys.add(key);
            notifyDocumentCondition(document, recipientUserId);
          } else {
            repository.resolveByDeduplicationKey(key, "Source resolved");
          }
        }
      }
    } catch {
      canResolve = false;
    }

    if (canResolve) {
      for (const item of repository.activeConditionsFor(recipientUserId)) {
        if (!activeKeys.has(item.deduplicationKey)) repository.resolveByDeduplicationKey(item.deduplicationKey, "Source resolved");
      }
    }
  }

  function userOrAnonymous(user?: MaybeUser) {
    return user ?? { userId: "anonymous", email: "anonymous", displayName: "Anonymous", roles: [], permissions: [] };
  }

  // Test-only compatibility fixtures are materialized when the memory adapter is constructed, never by a read.
  seedInitialEvents();

  return {
    repository,
    create,
    list(user?: MaybeUser, query?: NotificationListQuery) {
      const current = userOrAnonymous(user);
      reconcileForUser(current);
      return repository.list(userKey(current), query);
    },
    counts(user?: MaybeUser) {
      const current = userOrAnonymous(user);
      reconcileForUser(current);
      return repository.counts(userKey(current));
    },
    get(user: MaybeUser, id: string) {
      const current = userOrAnonymous(user);
      reconcileForUser(current);
      return repository.get(userKey(current), id);
    },
    markRead(user: MaybeUser, id: string) {
      const current = userOrAnonymous(user);
      reconcileForUser(current);
      return repository.markRead(userKey(current), id);
    },
    markUnread(user: MaybeUser, id: string) {
      const current = userOrAnonymous(user);
      reconcileForUser(current);
      return repository.markUnread(userKey(current), id);
    },
    markAllRead(user: MaybeUser, ids?: string[]) {
      const current = userOrAnonymous(user);
      reconcileForUser(current);
      return repository.markAllRead(userKey(current), ids);
    },
    notifyBriefingPublished(briefing: AnyRow) {
      for (const recipient of allUsersWith("briefing:read").filter((item) => !hasObserverRole(item))) {
        create({
          deduplicationKey: `event:briefing:${briefing.id}:published:${briefing.version ?? briefing.revision ?? briefing.updatedAt ?? defaultNow()}:${recipient.userId}`,
          recipientUserId: recipient.userId,
          kind: "Information",
          severity: "Information",
          category: "Briefing",
          title: "Briefing published",
          message: `Briefing revision ${briefing.revision ?? ""} is available for review.`.replace(/\s+/g, " ").trim(),
          sessionId: briefing.sessionId ?? null,
          sessionLabel: sessionLabel(sources.sessions, briefing.sessionId),
          sourceType: "briefing",
          sourceId: briefing.id,
          sourceLabel: briefing.title ?? null,
          actionDestination: "/active-event",
          actionLabel: "Read briefing",
          createdAt: asIso(briefing.publishedAt ?? briefing.updatedAt)
        });
      }
    },
    notifySessionClosed(session: AnyRow) {
      for (const recipient of allUsersWith("session:read").filter((item) => !hasObserverRole(item))) {
        create({
          deduplicationKey: `event:session:${session.id}:closed:${session.endAt ?? session.updatedAt ?? defaultNow()}:${recipient.userId}`,
          recipientUserId: recipient.userId,
          kind: "Information",
          severity: "Information",
          category: "Session",
          title: "Session closed",
          message: `${safeCopyText(session.operationalId, "Session")} has been closed.`,
          sessionId: session.id,
          sessionLabel: session.operationalId ?? null,
          sourceType: "session",
          sourceId: session.id,
          sourceLabel: session.operationalId ?? null,
          actionDestination: "/sessions",
          actionLabel: "Open sessions",
          createdAt: asIso(session.endAt ?? session.updatedAt)
        });
      }
    },
    notifyAssignmentAssigned(assignment: AnyRow) {
      if (!assignment.assignedUserId) return;
      create({
        deduplicationKey: `event:assignment:${assignment.id}:assigned:${assignment.assignedUserId}:${assignment.updatedAt ?? defaultNow()}`,
        recipientUserId: assignment.assignedUserId,
        kind: "Information",
        severity: "Information",
        category: "Assignment",
        title: "Assignment assigned to you",
        message: safeCopyText(assignment.title, "Open your assignment."),
        sessionId: assignment.sessionId ?? null,
        sessionLabel: sessionLabel(sources.sessions, assignment.sessionId),
        sourceType: "assignment",
        sourceId: assignment.id,
        sourceLabel: assignment.operationalId ?? null,
        actionDestination: routeForSource("assignment", assignment.id),
        actionLabel: "Open assignment",
        createdAt: asIso(assignment.updatedAt ?? assignment.createdAt)
      });
      notifyAssignmentCondition(assignment, assignment.assignedUserId);
    },
    notifyAssignmentCancelled(assignment: AnyRow) {
      repository.resolveSource("assignment", assignment.id, "Source cancelled");
      if (!assignment.assignedUserId) return;
      create({
        deduplicationKey: `event:assignment:${assignment.id}:cancelled:${assignment.updatedAt ?? defaultNow()}:${assignment.assignedUserId}`,
        recipientUserId: assignment.assignedUserId,
        kind: "Information",
        severity: "Information",
        category: "Assignment",
        title: "Assignment cancelled",
        message: safeCopyText(assignment.title, "Assignment closed."),
        sessionId: assignment.sessionId ?? null,
        sessionLabel: sessionLabel(sources.sessions, assignment.sessionId),
        sourceType: "assignment",
        sourceId: assignment.id,
        sourceLabel: assignment.operationalId ?? null,
        actionDestination: routeForSource("assignment", assignment.id),
        actionLabel: "View assignment",
        createdAt: asIso(assignment.updatedAt ?? assignment.createdAt)
      });
    },
    notifyRosterShiftPublished(shift: AnyRow) {
      const recipientUserId = shift.assignedUserId ?? linkedUserIdForMember(sources.directory, shift.assignedMemberProfileId ?? shift.memberProfileId);
      if (!recipientUserId) return;
      create({
        deduplicationKey: `event:rosterShift:${shift.id}:published:${shift.updatedAt ?? defaultNow()}:${recipientUserId}`,
        recipientUserId,
        kind: "Information",
        severity: "Information",
        category: "Rostering",
        title: "Roster shift published",
        message: `${safeCopyText(shift.functionName ?? shift.operationalId, "Roster shift")} is ready for confirmation.`,
        sessionId: shift.sessionId ?? null,
        sessionLabel: sessionLabel(sources.sessions, shift.sessionId),
        sourceType: "rosterShift",
        sourceId: shift.id,
        sourceLabel: shift.operationalId ?? null,
        actionDestination: routeForSource("rosterShift", shift.id),
        actionLabel: "Review roster",
        createdAt: asIso(shift.updatedAt ?? shift.createdAt)
      });
      notifyRosterCondition(shift, recipientUserId);
    },
    notifyTrainingAssigned(record: AnyRow) {
      const recipientUserId = linkedUserIdForMember(sources.directory, record.memberProfileId);
      if (!recipientUserId) return;
      create({
        deduplicationKey: `event:trainingRecord:${record.id}:assigned:${record.updatedAt ?? defaultNow()}:${recipientUserId}`,
        recipientUserId,
        kind: "Information",
        severity: "Information",
        category: "Training",
        title: "Training assigned",
        message: `${safeCopyText(record.courseTitle ?? record.course?.title ?? record.title, "Training")} has been assigned to you.`,
        sessionId: record.sessionId ?? null,
        sessionLabel: sessionLabel(sources.sessions, record.sessionId),
        sourceType: "trainingRecord",
        sourceId: record.id,
        sourceLabel: record.operationalId ?? null,
        actionDestination: routeForSource("trainingRecord", record.id),
        actionLabel: "Open training",
        createdAt: asIso(record.assignedAt ?? record.updatedAt ?? record.createdAt)
      });
    },
    notifyDocumentVersionPublished(version: AnyRow) {
      for (const recipient of allUsersWith("document:read-own").filter((item) => !hasObserverRole(item))) {
        create({
          deduplicationKey: `event:documentVersion:${version.id}:published:${version.versionNumber ?? version.updatedAt ?? defaultNow()}:${recipient.userId}`,
          recipientUserId: recipient.userId,
          kind: "Information",
          severity: "Information",
          category: "Documents",
          title: "Document version published",
          message: `${safeCopyText(version.title ?? version.documentTitle ?? version.versionLabel, "Document")} is available for review.`,
          sessionId: version.sessionId ?? null,
          sessionLabel: sessionLabel(sources.sessions, version.sessionId),
          sourceType: "documentVersion",
          sourceId: version.id,
          sourceLabel: version.versionLabel ?? null,
          actionDestination: routeForSource("documentVersion", version.id),
          actionLabel: "Open documents",
          createdAt: asIso(version.publishedAt ?? version.updatedAt ?? version.createdAt)
        });
      }
    },
    resolveSource(sourceType: NotificationSourceType, sourceId: string, reason?: string) {
      return repository.resolveSource(sourceType, sourceId, reason);
    }
  };
}
