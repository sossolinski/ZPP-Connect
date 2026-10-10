import type { Prisma, PrismaClient } from "@prisma/client";
import { type DashboardAvailability, type IncidentWorkspace, type WorkspaceList, type WorkspaceWork, type WorkspaceActivity, workflowStates } from "@zpp/shared";
import { HttpError } from "../../errors.js";
import { roleDisplayName } from "../../access-control.js";
import { permissionScope } from "../../scope-policy.js";
import { EffectiveAccessService } from "../identity/effective-access-service.js";
import { eligibleUserIds as eligibleTaskOwnerIds } from "../assignments/prisma-assignment-repository.js";
import { suitableRequestOwnerIds } from "../requests/request-owner-policy.js";

const limit = 6;
const unavailable = { status: "unavailable" } as const;
const available = <T>(value: T): DashboardAvailability<T> => ({ status: "available", value });
const iso = (value: Date | null) => value?.toISOString() ?? null;
const list = <T>(items: T[], total: number, scope: string): WorkspaceList<T> => ({ items, total, scope, limit });

/** Timeline presentation excludes technical identifiers and metadata. */
export function operationalActivityText(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[record]")
    .replace(/\b[0-9a-f]{64}\b/gi, "[reference]")
    .replace(/(?:s3|file):\/\/\S+|(?:storage|evidence|artifacts)\/\S+/gi, "[reference]")
    .replace(/assignmentTask/g, "Task").replace(/operationalBriefing/g, "Briefing")
    .replace(/\bAssignment\b/g, "Task").replace(/\bSession\b/g, "Incident").slice(0, 220);
}

/** Derived read composition only. No command/lifecycle or new persistence. */
export async function readIncidentWorkspace(db: PrismaClient, incidentId: string, userId: string, now: Date): Promise<IncidentWorkspace> {
  const actor = await new EffectiveAccessService(db).forUser(userId, { incidentId });
  if (!actor || !actor.permissions.includes("session:read")) throw new HttpError(403, "Forbidden");
  const session = await db.session.findUniqueOrThrow({ where: { id: incidentId } });
  const has = (permission: string) => actor.permissions.includes(permission as never);
  const taskScope = permissionScope(actor, "assignment:assign");
  const requestScope = permissionScope(actor, "request:assign");
  const rosterScope = permissionScope(actor, "roster:read");
  const groupIds = [...new Set([...taskScope.groupIds, ...requestScope.groupIds, ...rosterScope.groupIds])];
  const groups = groupIds.length ? await db.operationalGroup.findMany({ where: { id: { in: groupIds }, incidentId, status: { not: "Archived" } }, select: { id: true, name: true } }) : [];
  const liveGroupIds = new Set(groups.map(group => group.id));
  const usersForGroups = async (ids: Set<string>) => {
    const rows = await db.memberProfile.findMany({ where: { status: { not: "Archived" }, linkedUserId: { not: null }, memberships: { some: { removedAt: null, groupId: { in: [...ids].filter(id => liveGroupIds.has(id)) } } } }, select: { linkedUserId: true } });
    return rows.flatMap(row => row.linkedUserId ? [row.linkedUserId] : []);
  };
  const taskTeamIds = taskScope.allowed && !taskScope.global ? await usersForGroups(taskScope.groupIds) : [];
  const requestTeamIds = requestScope.allowed && !requestScope.global ? await usersForGroups(requestScope.groupIds) : [];
  const groupLabel = (ids: Set<string>) => `Current members of ${groups.filter(group => ids.has(group.id)).map(group => group.name).join(", ") || "your incident groups"}`;

  async function tasks(allowed: boolean, owned: Prisma.AssignmentTaskWhereInput, scope: string): Promise<IncidentWorkspace["myTasks"]> {
    if (!allowed) return unavailable;
    const where: Prisma.AssignmentTaskWhereInput = { sessionId: incidentId, status: { notIn: ["Completed", "Cancelled"] }, ...owned };
    const [total, rows] = await Promise.all([
      db.assignmentTask.count({ where }),
      db.assignmentTask.findMany({ where, include: { assignedUser: { select: { displayName: true } } }, orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { updatedAt: "desc" }, { id: "asc" }], take: limit }),
    ]);
    const eligible = await eligibleTaskOwnerIds(db, incidentId, [...new Set(rows.flatMap(row => row.assignedUserId ? [row.assignedUserId] : []))]);
    return available(list(rows.map(row => ({ id: row.id, operationalId: row.operationalId, title: row.title, type: "Task", priority: row.priority,
      owner: row.assignedUser?.displayName ?? row.legacyAssigneeLabel, dueAt: iso(row.dueAt), state: row.status,
      overdue: Boolean(row.dueAt && row.dueAt < now), warning: row.assignedUserId && !eligible.has(row.assignedUserId) ? "Reassignment required" : row.status === "Escalated" ? "Escalated — coordination needed" : !row.assignedUserId && row.legacyAssigneeLabel ? "Legacy owner — confirm responsibility" : null,
      href: `/assignments?assignmentId=${encodeURIComponent(row.id)}`, nextAction: "Review task",
    })), total, scope));
  }
  async function requests(allowed: boolean, owned: Prisma.RequestWhereInput, scope: string): Promise<IncidentWorkspace["myRequests"]> {
    if (!allowed) return unavailable;
    const where: Prisma.RequestWhereInput = { incidentId, status: { notIn: [...workflowStates.terminalRequestStatuses] }, ...owned };
    const [total, rows] = await Promise.all([
      db.request.count({ where }),
      db.request.findMany({ where, include: { owner: { select: { displayName: true } } }, orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { updatedAt: "desc" }, { id: "asc" }], take: limit }),
    ]);
    const eligible = await suitableRequestOwnerIds(db, incidentId, [...new Set(rows.flatMap(row => row.ownerUserId ? [row.ownerUserId] : []))]);
    return available(list(rows.map(row => ({ id: row.id, operationalId: row.operationalId, title: `${row.category} support`, type: "Support request", priority: row.priority,
      owner: row.owner?.displayName ?? row.legacyOwnerLabel, dueAt: iso(row.dueAt), state: row.status.replaceAll("_", " "),
      overdue: Boolean(row.dueAt && row.dueAt < now), warning: (row.ownerUserId && !eligible.has(row.ownerUserId)) || (!row.ownerUserId && row.legacyOwnerLabel) ? "Reassignment required" : row.status === "WAITING" ? "Waiting — follow-up needed" : null,
      href: `/requests?requestId=${encodeURIComponent(row.id)}`, nextAction: "Review support request",
    })), total, scope));
  }
  const [myTasks, myRequests, teamTasks, teamRequests, published] = await Promise.all([
    tasks(has("assignment:read"), { assignedUserId: userId }, "Your open tasks in this incident"),
    requests(has("request:read"), { ownerUserId: userId }, "Your open support requests in this incident"),
    tasks(has("assignment:read") && taskScope.allowed, taskScope.global ? {} : { assignedUserId: { in: taskTeamIds } }, taskScope.global ? "Open incident tasks, including unassigned work" : groupLabel(taskScope.groupIds)),
    requests(has("request:read") && requestScope.allowed, requestScope.global ? {} : { ownerUserId: { in: requestTeamIds } }, requestScope.global ? "Open incident support requests, including unassigned work" : groupLabel(requestScope.groupIds)),
    has("briefing:read") ? db.operationalBriefing.findFirst({ where: { sessionId: incidentId, status: "Published" }, orderBy: [{ publishedAt: "desc" }, { revision: "desc" }], include: { priorities: { orderBy: { sortOrder: "asc" }, take: 3 }, risks: { where: { status: { notIn: ["Closed", "Resolved"] } }, orderBy: { createdAt: "desc" }, take: 3 } } }) : null,
  ]);
  const member = has("roster:read-own") ? await db.memberProfile.findFirst({ where: { linkedUserId: userId, status: { not: "Archived" } }, select: { id: true } }) : null;
  let coverage: IncidentWorkspace["coverage"] = unavailable;
  if (rosterScope.allowed || (has("roster:read-own") && member)) {
    const permitted: Prisma.RosterShiftWhereInput = rosterScope.global ? {} : { OR: [
      ...(rosterScope.groupIds.size ? [{ groupId: { in: [...rosterScope.groupIds].filter(id => liveGroupIds.has(id)) } }] : []),
      ...(member ? [{ assignedMemberProfileId: member.id }] : []),
    ] };
    const where: Prisma.RosterShiftWhereInput = { sessionId: incidentId, startAt: { lte: now }, endAt: { gt: now }, status: { in: ["Published", "Confirmed"] }, AND: [permitted, { OR: [{ assignedMemberProfileId: null }, { assignedMemberProfile: { status: "Active" } }] }] };
    const [total, rows] = await Promise.all([db.rosterShift.count({ where }), db.rosterShift.findMany({ where, include: { assignedMemberProfile: true, group: true }, orderBy: [{ startAt: "asc" }, { id: "asc" }], take: limit })]);
    coverage = available(list(rows.map(row => ({ id: row.id, title: row.title, functionName: row.functionName, person: row.assignedMemberProfile ? `${row.assignedMemberProfile.firstName} ${row.assignedMemberProfile.lastName}` : null,
      group: row.group?.name ?? null, location: row.location, startAt: row.startAt.toISOString(), endAt: row.endAt.toISOString(),
      state: !row.assignedMemberProfileId ? "Unfilled duty" : row.status === "Confirmed" ? "Confirmed coverage" : "Awaiting confirmation",
      href: `/rostering?shiftId=${encodeURIComponent(row.id)}`,
    })), total, rosterScope.global ? "Current incident staffing period" : rosterScope.groupIds.size ? "Your groups and personal staffing in the current period" : "Your current staffing period"));
  }
  const activity = await recentActivity();
  return {
    incident: { operationalId: session.operationalId, name: session.eventType, description: session.description, status: session.status, location: session.airportLocation, flight: session.flightNumber, route: session.route, roles: actor.roles.map(role => roleDisplayName(role)) },
    briefing: !has("briefing:read") ? unavailable : available(published ? { title: published.title, situation: published.situationSummary,
      publishedAt: iso(published.publishedAt), nextUpdateDueAt: iso(published.nextUpdateDueAt),
      priorities: published.priorities.map(row => ({ description: row.description, responsible: row.responsible, dueAt: iso(row.dueAt), status: row.status })),
      risks: published.risks.map(row => ({ description: row.description, severity: row.severity, mitigation: row.mitigation })),
    } : null), myTasks, myRequests, teamTasks, teamRequests, coverage, activity,
  };

  async function recentActivity(): Promise<IncidentWorkspace["activity"]> {
    if (!has("timeline:read")) return unavailable;
    const definitions = [
      ["assignmentTask", "assignment:read", "/assignments", "assignmentId"], ["request", "request:read", "/requests", "requestId"],
      ["briefing", "briefing:read", "/active-event", ""], ["operationalBriefing", "briefing:read", "/active-event", ""],
      ["rosterShift", "roster:read", "/rostering", "shiftId"], ["session", "session:read", "/sessions", ""],
    ] as const;
    const visible = definitions.filter(([, permission]) => has(permission) || (permission === "roster:read" && has("roster:read-own") && Boolean(member)));
    const items: Array<WorkspaceActivity & { actorId: string | null }> = [];
    let cursor: string | undefined;
    // Source scope can discard a whole page. Continue to the next chronological
    // page until six permitted entries or the actual end, never claim false empty.
    while (items.length < limit) {
      const events = await db.caseTimelineEvent.findMany({
        where: { sessionId: incidentId, occurredAt: { lte: now }, OR: [{ entityType: { in: visible.map(([type]) => type) } }, { entityType: null, eventType: { in: ["note", "status", "coordination", "decision"] } }] },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: 50,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (!events.length) break;
      const taskEventIds = events.filter(row => row.entityType === "assignmentTask").flatMap(row => row.entityId ? [row.entityId] : []);
      const rosterEventIds = events.filter(row => row.entityType === "rosterShift").flatMap(row => row.entityId ? [row.entityId] : []);
      const [visibleTasks, visibleShifts] = await Promise.all([
        taskEventIds.length ? db.assignmentTask.findMany({ where: { sessionId: incidentId, id: { in: taskEventIds }, ...(!taskScope.global ? { assignedUserId: { in: [...taskTeamIds, userId] } } : {}) }, select: { id: true } }) : [],
        rosterEventIds.length ? db.rosterShift.findMany({ where: { sessionId: incidentId, id: { in: rosterEventIds }, ...(!rosterScope.global ? { OR: [{ groupId: { in: [...rosterScope.groupIds].filter(id => liveGroupIds.has(id)) } }, ...(member ? [{ assignedMemberProfileId: member.id }] : [])] } : {}) }, select: { id: true } }) : [],
      ]);
      const taskIds = new Set(visibleTasks.map(row => row.id)), shiftIds = new Set(visibleShifts.map(row => row.id));
      for (const row of events) {
        const source = visible.find(([type]) => type === row.entityType);
        if (source?.[0] === "assignmentTask" && (!row.entityId || !taskIds.has(row.entityId))) continue;
        if (source?.[0] === "rosterShift" && (!row.entityId || !shiftIds.has(row.entityId))) continue;
        if ((source?.[0] === "briefing" || source?.[0] === "operationalBriefing") && !/published/i.test(row.title)) continue;
        if (source?.[0] === "session" && row.eventType !== "session") continue;
        const title = operationalActivityText(row.title) || "Operational update";
        const direct = Boolean(source && row.entityId && source[3]);
        items.push({ id: row.id, title, summary: operationalActivityText(row.body), occurredAt: row.occurredAt.toISOString(), actor: "System", actorId: row.createdById,
          href: source ? direct ? `${source[2]}?${source[3]}=${encodeURIComponent(row.entityId!)}` : source[2] : `/timeline?eventId=${encodeURIComponent(row.id)}`, actionLabel: direct ? "Open record" : source ? source[2] === "/active-event" ? "Read briefing" : "Open incidents" : "Read timeline entry" });
        if (items.length === limit) break;
      }
      if (events.length < 50) break;
      cursor = events.at(-1)!.id;
    }
    const actorIds = [...new Set(items.flatMap(row => row.actorId ? [row.actorId] : []))];
    const actors = actorIds.length ? await db.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, displayName: true } }) : [];
    const projected = items.map(({ actorId, ...row }) => ({ ...row, actor: actors.find(actor => actor.id === actorId)?.displayName ?? "System" }));
    return available(list(projected, projected.length, "Recent permitted significant events; up to 6 shown"));
  }
}
