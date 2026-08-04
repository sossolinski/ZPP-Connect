import type { IncidentRepository } from "./incident-repository.js";
import type { MemoryIncidentAssignment } from "../incident-access/memory-incident-access-repository.js";
import type {
  IncidentActor,
  IncidentCreateInput,
  IncidentListQuery,
  IncidentRecord,
  IncidentUpdateInput
} from "./incident-types.js";

type MutableRow = Record<string, any>;

type MemoryIncidentSources = {
  sessions: MutableRow[];
  auditLogs: MutableRow[];
  timeline: MutableRow[];
  incidentAssignments?: MemoryIncidentAssignment[];
  now?: () => string;
};

function nextOperationalId(rows: MutableRow[]) {
  const year = new Date().getFullYear();
  const stem = `SES-${year}-`;
  const highest = rows.reduce((value, row) => {
    const match = String(row.operationalId ?? "").match(new RegExp(`^${stem}(\\d+)$`));
    return Math.max(value, match ? Number(match[1]) : 0);
  }, 0);
  return `${stem}${String(highest + 1).padStart(3, "0")}`;
}

function actorSnapshot(actor: IncidentActor) {
  return {
    id: actor.id,
    userId: actor.id,
    email: actor.email,
    displayName: actor.displayName,
    roles: actor.roles
  };
}

export function createMemoryIncidentRepository(sources: MemoryIncidentSources): IncidentRepository {
  const currentTime = sources.now ?? (() => new Date().toISOString());

  function appendAudit(action: string, summary: string, incident: MutableRow, actor: IncidentActor, metadata?: MutableRow) {
    sources.auditLogs.unshift({
      id: `aud-memory-${sources.auditLogs.length + 1}`,
      action,
      entityType: "session",
      entityId: incident.id,
      sessionId: incident.id,
      actorId: actor.id,
      actorEmail: actor.email,
      actorDisplayName: actor.displayName,
      actorRoles: actor.roles,
      summary,
      metadata,
      createdAt: currentTime()
    });
  }

  return {
    kind: "memory",

    async list(query: IncidentListQuery, visibleIncidentIds: string[] | null) {
      const search = query.search?.trim().toLowerCase();
      const filtered = sources.sessions
        .filter((row) => !query.status || row.status === query.status)
        .filter((row) => visibleIncidentIds === null || visibleIncidentIds.includes(String(row.id)))
        .filter((row) => {
          if (!search) return true;
          return [row.operationalId, row.eventType, row.flightNumber, row.route, row.airportLocation]
            .some((value) => String(value ?? "").toLowerCase().includes(search));
        })
        .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
      return {
        total: filtered.length,
        data: filtered.slice(query.offset, query.offset + query.limit).map((row) => ({ ...row })) as IncidentRecord[]
      };
    },

    async findById(id: string) {
      const row = sources.sessions.find((item) => item.id === id);
      return row ? ({ ...row } as IncidentRecord) : null;
    },

    async findActiveReal(excludingId?: string) {
      const row = sources.sessions.find((item) => item.id !== excludingId && item.mode === "REAL" && item.status === "Active");
      return row ? ({ ...row } as IncidentRecord) : null;
    },

    async create(input: IncidentCreateInput, actor: IncidentActor) {
      const timestamp = currentTime();
      const row: MutableRow = {
        ...input,
        id: `ses-memory-${sources.sessions.length + 1}-${Date.now()}`,
        operationalId: nextOperationalId(sources.sessions),
        createdById: actor.id,
        updatedById: actor.id,
        createdBy: actorSnapshot(actor),
        updatedBy: actorSnapshot(actor),
        createdAt: timestamp,
        updatedAt: timestamp
      };
      sources.sessions.unshift(row);
      if (sources.incidentAssignments) {
        const assignment = {
          id: `ias-memory-${Date.now()}-${sources.incidentAssignments.length + 1}`,
          incidentId: row.id,
          userId: actor.id,
          userEmail: actor.email,
          function: "Incident creator",
          scope: "OPERATIONAL",
          active: true,
          createdAt: timestamp,
          createdById: actor.id,
          revokedAt: null,
          revokedById: null,
          revokeReason: null,
          updatedAt: timestamp
        };
        sources.incidentAssignments.push(assignment);
        sources.auditLogs.unshift({
          id: `aud-memory-${sources.auditLogs.length + 1}`,
          action: "incident_assignment_assigned",
          entityType: "incident_assignment",
          entityId: assignment.id,
          sessionId: row.id,
          actorId: actor.id,
          actorEmail: actor.email,
          summary: `Incident access assigned for user ${actor.id}`,
          metadata: {
            targetUserId: actor.id,
            incidentId: row.id,
            action: "ASSIGNED",
            requestId: actor.requestId ?? null,
            previous: null,
            next: { active: true, scope: "OPERATIONAL", function: "Incident creator" },
            reason: "Incident creator auto-assignment"
          },
          createdAt: timestamp
        });
      }
      appendAudit("create_session", `Session ${row.operationalId} created`, row, actor);
      return { ...row } as IncidentRecord;
    },

    async update(id: string, input: IncidentUpdateInput, actor: IncidentActor) {
      const row = sources.sessions.find((item) => item.id === id);
      if (!row || ["Closed", "Archived"].includes(String(row.status))) return null;
      Object.assign(row, input, {
        updatedById: actor.id,
        updatedBy: actorSnapshot(actor),
        updatedAt: currentTime()
      });
      appendAudit("update_session", `Session ${row.operationalId} updated`, row, actor, input);
      return { ...row } as IncidentRecord;
    },

    async close(id: string, notes: string, actor: IncidentActor) {
      const row = sources.sessions.find((item) => item.id === id);
      if (!row || ["Closed", "Archived"].includes(String(row.status))) return null;
      const timestamp = currentTime();
      Object.assign(row, {
        status: "Closed",
        endAt: timestamp,
        notes,
        closedById: actor.id,
        updatedById: actor.id,
        updatedBy: actorSnapshot(actor),
        updatedAt: timestamp
      });
      appendAudit("close_session", `Session ${row.operationalId} closed`, row, actor, { status: "Closed", closureNote: notes });
      sources.timeline.unshift({
        id: `tle-memory-${sources.timeline.length + 1}`,
        sessionId: row.id,
        caseId: null,
        eventType: "session",
        entityType: "session",
        entityId: row.id,
        title: `Session ${row.operationalId} closed`,
        body: notes,
        metadata: { status: "Closed" },
        createdById: actor.id,
        occurredAt: timestamp,
        createdAt: timestamp
      });
      return { ...row } as IncidentRecord;
    }
  };
}
