import type { PrismaClient } from "@prisma/client";
import type { FoundationTrainingRepository } from "../training/training-repository.js";
import type { FoundationDocumentRepository } from "../documents/document-repository.js";
import type { NotificationRepository } from "./notification-repository.js";
import type { NotificationClock, NotificationInput } from "./notification-types.js";

const systemActor = { id: "00000000-0000-0000-0000-000000000000", email: "notification-projector@internal", displayName: "Notification projector", roles: [], permissions: ["training:read-all", "document:read-all"] };
const date = (value?: Date | string | null) => value ? new Date(value).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : null;

export function createNotificationProjector(client: PrismaClient, repository: NotificationRepository, dependencies: { training: FoundationTrainingRepository; documents: FoundationDocumentRepository; clock?: NotificationClock; batchSize?: number; maxRows?: number }) {
  const clock = dependencies.clock ?? { now: () => new Date() };
  const batchSize = dependencies.batchSize ?? 200;
  const maxRows = dependencies.maxRows ?? 10_000;

  async function paged<T extends { id: string }>(load: (cursor?: string) => Promise<T[]>, visit: (row: T) => Promise<void>) {
    let cursor: string | undefined, seen = 0, complete = true;
    while (seen < maxRows) {
      const rows = await load(cursor);
      if (!rows.length) break;
      for (const row of rows) { await visit(row); seen += 1; if (seen >= maxRows) { complete = rows.length < batchSize; break; } }
      cursor = rows.at(-1)!.id;
      if (rows.length < batchSize) break;
    }
    return { seen, complete };
  }

  return {
    async runOnce() {
      const now = clock.now();
      const keys: Record<string, string[]> = { assignment: [], rosterConfirmation: [], training: [], document: [] };
      const upsert = async (conditionType: string, input: NotificationInput) => { keys[conditionType]!.push(input.deduplicationKey); await repository.upsertCondition({ ...input, createdAt: now }); };
      const assignment = await paged(
        (cursor) => client.assignmentTask.findMany({ where: { assignedUserId: { not: null }, status: { notIn: ["Completed", "Cancelled"] }, ...(cursor ? { id: { gt: cursor } } : {}) }, include: { assignedUser: true, session: true }, orderBy: { id: "asc" }, take: batchSize }),
        async (row) => { if (!row.assignedUserId || !["active", "Active"].includes(row.assignedUser?.status ?? "")) return; await upsert("assignment", { recipientUserId: row.assignedUserId, deduplicationKey: `condition:assignment:${row.id}:${row.assignedUserId}`, kind: "Action required", severity: row.priority === "Critical" ? "Critical" : "Attention", category: "Assignment", title: row.dueAt && row.dueAt < now ? "Assignment overdue" : row.status === "Escalated" ? "Assignment escalated" : "Assignment awaiting action", message: `${row.operationalId}${row.dueAt ? ` is due ${date(row.dueAt)}.` : " requires attention."}`, sessionId: row.sessionId, sessionLabel: row.session.operationalId, sourceType: "assignment", sourceId: row.id, sourceLabel: row.operationalId, conditionType: "assignment", actionDestination: `/assignments?assignmentId=${encodeURIComponent(row.id)}`, actionLabel: "Open assignment", metadata: { condition: true, conditionType: "assignment", priority: row.priority, status: row.status } }); },
      );
      const roster = await paged(
        (cursor) => client.rosterShift.findMany({ where: { status: "Published", assignedMemberProfileId: { not: null }, ...(cursor ? { id: { gt: cursor } } : {}) }, include: { assignedMemberProfile: { include: { linkedUser: true } }, session: true }, orderBy: { id: "asc" }, take: batchSize }),
        async (row) => { const user = row.assignedMemberProfile?.linkedUser; if (!user || !["active", "Active"].includes(user.status)) return; await upsert("rosterConfirmation", { recipientUserId: user.id, deduplicationKey: `condition:rosterShift:${row.id}:${user.id}`, kind: "Action required", severity: "Attention", category: "Rostering", title: "Shift awaiting confirmation", message: `${row.operationalId} on ${date(row.startAt)} needs your confirmation.`, sessionId: row.sessionId, sessionLabel: row.session.operationalId, sourceType: "rosterShift", sourceId: row.id, sourceLabel: row.operationalId, conditionType: "rosterConfirmation", actionDestination: "/rostering", actionLabel: "Review roster", metadata: { condition: true, conditionType: "rosterConfirmation", status: row.status } }); },
      );
      const members = await paged(
        (cursor) => client.memberProfile.findMany({ where: { linkedUserId: { not: null }, status: { not: "Archived" }, linkedUser: { status: "Active" }, ...(cursor ? { id: { gt: cursor } } : {}) }, include: { linkedUser: true }, orderBy: { id: "asc" }, take: batchSize }),
        async (member) => {
          const recipientUserId = member.linkedUserId!;
          const training = await dependencies.training.evaluateMemberCompliance(member.id, systemActor, now, 45);
          for (const entry of training?.items ?? []) { const record = entry.record; if (!record || !(record.status === "Expired" || record.isOverdue)) continue; const title = record.status === "Expired" ? "Training expired" : "Training overdue"; await upsert("training", { recipientUserId, deduplicationKey: `condition:trainingRecord:${record.id}:training:${recipientUserId}`, kind: "Action required", severity: "Attention", category: "Training", title, message: `${record.operationalId}${record.dueAt ? ` needs attention by ${date(record.dueAt)}.` : " needs attention."}`, sourceType: "trainingRecord", sourceId: record.id, sourceLabel: record.operationalId, conditionType: "training", actionDestination: "/training", actionLabel: "Open training", metadata: { condition: true, conditionType: "training", status: record.status } }); }
          const documents = await dependencies.documents.evaluateMemberCompliance(member.id, systemActor, now);
          for (const entry of documents?.items ?? []) { if (!entry.acknowledgementRequired || entry.status === "Acknowledged") continue; await upsert("document", { recipientUserId, deduplicationKey: `condition:documentVersion:${entry.documentVersionId}:document:${recipientUserId}`, kind: "Action required", severity: entry.status === "Overdue" ? "Attention" : "Information", category: "Documents", title: entry.status === "Overdue" ? "Document acknowledgement overdue" : "Document acknowledgement needed", message: "A published document needs your acknowledgement.", sourceType: "documentVersion", sourceId: entry.documentVersionId, sourceLabel: entry.versionLabel, conditionType: "document", actionDestination: "/documents", actionLabel: "Open documents", metadata: { condition: true, conditionType: "document", status: entry.status } }); }
        },
      );
      if (assignment.complete) await repository.resolveMissingConditions("assignment", keys.assignment!, now);
      if (roster.complete) await repository.resolveMissingConditions("rosterConfirmation", keys.rosterConfirmation!, now);
      if (members.complete) { await repository.resolveMissingConditions("training", keys.training!, now); await repository.resolveMissingConditions("document", keys.document!, now); }
      return { assignment, roster, members, active: Object.values(keys).reduce((sum, list) => sum + list.length, 0) };
    },
  };
}
