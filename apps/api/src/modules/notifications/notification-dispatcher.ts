import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import { EffectiveAccessService } from "../identity/effective-access-service.js";
import type { NotificationRepository } from "./notification-repository.js";
import type { ClaimedOutbox, NotificationClock, NotificationInput } from "./notification-types.js";

const activeStatus = "Active";
function value(payload: Record<string, unknown>, key: string, fallback: string) { const text = String(payload[key] ?? "").trim(); return text || fallback; }
function route(type: string, id: string) { return type === "session" ? "/sessions" : type === "assignment" ? `/assignments?assignmentId=${encodeURIComponent(id)}` : type === "rosterShift" ? "/rostering" : type === "trainingRecord" ? "/training" : type.startsWith("document") ? "/documents" : "/"; }

export function createNotificationDispatcher(client: PrismaClient, repository: NotificationRepository, options: { clock?: NotificationClock; workerId?: string; batchSize?: number; leaseMs?: number; retryBaseMs?: number; logger?: Logger } = {}) {
  const clock = options.clock ?? { now: () => new Date() };
  const workerId = options.workerId ?? `notifications-${randomUUID()}`;
  const batchSize = options.batchSize ?? 100;
  const leaseMs = options.leaseMs ?? 30_000;
  const retryBaseMs = options.retryBaseMs ?? 1_000;
  const log = options.logger;
  const effectiveAccess = new EffectiveAccessService(client, clock);

  async function activeRecipient(id: string, sessionId?: string | null) {
    return client.user.findFirst({ where: { id, status: activeStatus, ...(sessionId ? { incidentAssignments: { some: { incidentId: sessionId, active: true } } } : {}) }, select: { id: true } });
  }

  async function memberRecipient(memberProfileId: string, sessionId?: string | null) {
    const member = await client.memberProfile.findUnique({ where: { id: memberProfileId }, select: { status: true, linkedUserId: true } });
    if (!member || member.status === "Archived") return { ids: [], waiting: false };
    if (!member.linkedUserId) return { ids: [], waiting: true };
    return { ids: await activeRecipient(member.linkedUserId, sessionId) ? [member.linkedUserId] : [], waiting: false };
  }

  async function documentRecipients(requirementId: string, sessionId?: string | null) {
    const requirement = await client.documentRequirement.findUnique({ where: { id: requirementId }, include: { documentVersion: { include: { document: true } } } });
    if (!requirement || !requirement.active || requirement.documentVersion.status !== "Published" || !requirement.documentVersion.document.active) return [];
    const where = requirement.targetType === "MemberProfile" ? { id: requirement.memberProfileId! }
      : requirement.targetType === "Group" ? { memberships: { some: { groupId: requirement.groupId!, removedAt: null } } }
      : requirement.targetRole === "ZPP Member" ? { pool: "ZPP" }
      : requirement.targetRole === "TEC Member" ? { pool: "TEC" }
      : requirement.targetRole === "Family Assistance" ? { assignedFunction: "Family Assistance Team" }
      : requirement.targetRole === "Welfare Support" ? { assignedFunction: "Welfare Support" }
      : requirement.targetRole === "Rostering" ? { assignedFunction: "Member Rostering" }
      : requirement.targetRole === "ZPP Group Leader" ? { pool: "ZPP", memberships: { some: { role: "Leader", removedAt: null } } }
      : requirement.targetRole === "TEC Group Leader" ? { pool: "TEC", memberships: { some: { role: "Leader", removedAt: null } } }
      : requirement.targetRole === "ZPP Coordinator" ? { linkedUser: { roles: { some: { role: { name: "zpp-coordinator" } } } } }
      : { linkedUser: { roles: { some: { role: { name: "tec-coordinator" } } } } };
    const members = await client.memberProfile.findMany({ where: { ...where, status: { not: "Archived" }, linkedUserId: { not: null }, linkedUser: { status: activeStatus } }, select: { linkedUserId: true } });
    const candidates = [...new Set(members.flatMap((member) => member.linkedUserId ? [member.linkedUserId] : []))];
    if (!sessionId) return candidates;
    const eligible = await Promise.all(candidates.map(async (id) => await activeRecipient(id, sessionId) ? id : null));
    return eligible.filter((id): id is string => Boolean(id));
  }

  async function recipients(row: ClaimedOutbox) {
    if (row.recipientUserId) return { ids: (await activeRecipient(row.recipientUserId, row.sessionId)) ? [row.recipientUserId] : [], waiting: false };
    if (row.eventType === "SESSION_CLOSED") return { ids: await effectiveAccess.eligibleUsersForPermission("session:read", { incidentId: row.sessionId }), waiting: false };
    if (row.eventType === "BRIEFING_PUBLISHED") {
      if (!row.sessionId) throw new Error("BRIEFING_PUBLISHED requires an Incident");
      return { ids: await effectiveAccess.eligibleUsersForPermission("briefing:read", { incidentId: row.sessionId }), waiting: false };
    }
    if (row.eventType === "ROSTER_PUBLISHED" || row.eventType === "TRAINING_ASSIGNED") return memberRecipient(value(row.payload, "memberProfileId", ""), row.sessionId);
    if (row.eventType.startsWith("DOCUMENT_REQUIREMENT_")) return { ids: await documentRecipients(value(row.payload, "requirementId", row.aggregateId), row.sessionId), waiting: false };
    return { ids: [], waiting: false };
  }

  function notification(row: ClaimedOutbox, recipientUserId: string): NotificationInput {
    const p = row.payload;
    const base = { recipientUserId, deduplicationKey: `event:outbox:${row.id}`, kind: "Information" as const, severity: "Information" as const, sessionId: row.sessionId, sourceId: row.aggregateId, createdAt: new Date(value(p, "occurredAt", clock.now().toISOString())), metadata: { operation: row.eventType, version: row.aggregateVersion } };
    if (row.eventType === "SESSION_CLOSED") return { ...base, category: "Session", title: "Session closed", message: `${value(p, "operationalId", "Session")} has been closed.`, sourceType: "session", sourceLabel: value(p, "operationalId", "Session"), actionDestination: route("session", row.aggregateId), actionLabel: "Open sessions" };
    if (row.eventType === "BRIEFING_PUBLISHED") return { ...base, category: "Briefing", title: "Briefing published", message: `Briefing revision ${value(p, "revision", row.aggregateVersion)} is available for review.`, sourceType: "briefing", sourceLabel: "Briefing", actionDestination: "/active-event", actionLabel: "Read briefing" };
    if (row.eventType === "ASSIGNMENT_CANCELLED") return { ...base, category: "Assignment", title: "Assignment cancelled", message: `${value(p, "operationalId", "Assignment")} was cancelled.`, sourceType: "assignment", sourceLabel: value(p, "operationalId", "Assignment"), actionDestination: route("assignment", row.aggregateId), actionLabel: "View assignment" };
    if (row.eventType === "ASSIGNMENT_ESCALATED") return { ...base, category: "Assignment", title: "Assignment escalated", message: `${value(p, "operationalId", "Assignment")} requires renewed attention.`, sourceType: "assignment", sourceLabel: value(p, "operationalId", "Assignment"), actionDestination: route("assignment", row.aggregateId), actionLabel: "Open assignment" };
    if (row.eventType === "ASSIGNMENT_ASSIGNED") return { ...base, category: "Assignment", title: "Assignment assigned to you", message: `${value(p, "operationalId", "Assignment")} is assigned to you.`, sourceType: "assignment", sourceLabel: value(p, "operationalId", "Assignment"), actionDestination: route("assignment", row.aggregateId), actionLabel: "Open assignment" };
    if (row.eventType === "ROSTER_PUBLISHED") return { ...base, category: "Rostering", title: "Roster shift published", message: `${value(p, "operationalId", "Roster shift")} is ready for confirmation.`, sourceType: "rosterShift", sourceLabel: value(p, "operationalId", "Roster shift"), actionDestination: route("rosterShift", row.aggregateId), actionLabel: "Review roster" };
    if (row.eventType === "TRAINING_ASSIGNED") return { ...base, category: "Training", title: "Training assigned", message: `${value(p, "operationalId", "Training")} has been assigned to you.`, sourceType: "trainingRecord", sourceLabel: value(p, "operationalId", "Training"), actionDestination: route("trainingRecord", row.aggregateId), actionLabel: "Open training" };
    if (row.eventType === "ACCESS_CHANGED") return { ...base, category: "Admin", title: value(p, "title", "Account access changed"), message: value(p, "message", "Your account access was updated."), sourceType: "access", sourceLabel: "Account access", actionDestination: "/settings", actionLabel: "Review account" };
    return { ...base, category: "Documents", title: "Document acknowledgement required", message: "A published document requires your attention.", sourceType: "documentRequirement", sourceLabel: "Document requirement", actionDestination: route("documentRequirement", row.aggregateId), actionLabel: "Open documents" };
  }

  async function deliver(row: ClaimedOutbox) {
    const target = await recipients(row);
    if (target.waiting) return { waiting: true, count: 0 };
    for (const recipientUserId of target.ids) {
      await repository.createEvent(notification(row, recipientUserId));
      if (row.eventType === "ASSIGNMENT_ESCALATED") {
        const assignment = await client.assignmentTask.findUnique({ where: { id: row.aggregateId }, include: { session: true } });
        if (assignment && assignment.assignedUserId === recipientUserId && !["Completed", "Cancelled"].includes(assignment.status)) await repository.upsertCondition({
          recipientUserId, deduplicationKey: `condition:assignment:${assignment.id}:${recipientUserId}`, kind: "Action required", severity: assignment.priority === "Critical" ? "Critical" : "Attention", category: "Assignment",
          title: "Assignment escalated", message: `${assignment.operationalId}${assignment.dueAt ? ` is due ${assignment.dueAt.toLocaleDateString("en-GB")}.` : " requires attention."}`,
          sessionId: assignment.sessionId, sessionLabel: assignment.session.operationalId, sourceType: "assignment", sourceId: assignment.id, sourceLabel: assignment.operationalId,
          conditionType: "assignment", actionDestination: `/assignments?assignmentId=${encodeURIComponent(assignment.id)}`, actionLabel: "Open assignment", resetUnread: true,
          metadata: { condition: true, conditionType: "assignment", priority: assignment.priority, status: assignment.status }, createdAt: clock.now(),
        });
      }
    }
    return { waiting: false, count: target.ids.length };
  }

  function failureClassification(error: unknown) {
    if (error && typeof error === "object") {
      const name = "name" in error ? String(error.name) : "Error";
      const code = "code" in error ? String(error.code) : "unknown";
      return `${name}:${code}`.slice(0, 160);
    }
    return "Unknown:unknown";
  }

  return {
    workerId,
    async runOnce() {
      const now = clock.now();
      const claimed = await repository.claimOutbox(workerId, batchSize, new Date(now.getTime() + leaseMs), now);
      let delivered = 0, waiting = 0, failed = 0;
      for (const row of claimed) {
        const startedAt = process.hrtime.bigint();
        try {
          const result = await deliver(row);
          if (result.waiting) {
            waiting += 1;
            const completedAt = clock.now();
            await repository.releaseOutboxWaiting(row.id, workerId, new Date(completedAt.getTime() + 60_000), "Waiting for linked active user", completedAt);
            log?.info({ notificationOutboxId: row.id, eventType: row.eventType, attempt: row.attemptCount, result: "waiting", durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000 }, "Notification delivery completed");
          } else {
            delivered += 1;
            await repository.markOutboxDelivered(row.id, workerId, clock.now());
            log?.info({ notificationOutboxId: row.id, eventType: row.eventType, attempt: row.attemptCount, recipientCount: result.count, result: "delivered", durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000 }, "Notification delivery completed");
          }
        } catch (error) {
          failed += 1;
          const final = row.attemptCount >= row.maxAttempts;
          const backoff = Math.min(300_000, retryBaseMs * 2 ** Math.max(0, row.attemptCount - 1));
          const classification = failureClassification(error);
          const failedAt = clock.now();
          await repository.markOutboxFailed(row.id, workerId, new Date(failedAt.getTime() + backoff), classification, final, failedAt);
          log?.error({ notificationOutboxId: row.id, eventType: row.eventType, attempt: row.attemptCount, result: final ? "failed" : "retry", failureClassification: classification, durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000 }, "Notification delivery failed");
        }
      }
      return { claimed: claimed.length, delivered, waiting, failed };
    },
  };
}
