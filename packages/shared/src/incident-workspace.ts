import type { DashboardAvailability } from "./dashboard-contracts.js";

export type WorkspaceList<T> = { items: T[]; total: number; limit: number; scope: string };
export type WorkspaceWork = {
  id: string; operationalId: string; title: string; type: "Task" | "Support request";
  priority: string; owner: string | null; dueAt: string | null; state: string;
  overdue: boolean; warning: string | null; href: string; nextAction: string;
};
export type WorkspaceBriefing = {
  title: string; situation: string; publishedAt: string | null; nextUpdateDueAt: string | null;
  priorities: Array<{ description: string; responsible: string | null; dueAt: string | null; status: string }>;
  risks: Array<{ description: string; severity: string; mitigation: string | null }>;
};
export type WorkspaceCoverage = {
  id: string; title: string; functionName: string; person: string | null; group: string | null;
  location: string; startAt: string; endAt: string; state: "Confirmed coverage" | "Awaiting confirmation" | "Unfilled duty";
  href: string;
};
export type WorkspaceActivity = { id: string; title: string; summary: string | null; occurredAt: string; actor: string; href: string; actionLabel: string };
export type IncidentWorkspace = {
  incident: { operationalId: string; name: string; description: string | null; status: string; location: string | null; flight: string | null; route: string | null; roles: string[] };
  briefing: DashboardAvailability<WorkspaceBriefing | null>;
  myTasks: DashboardAvailability<WorkspaceList<WorkspaceWork>>;
  myRequests: DashboardAvailability<WorkspaceList<WorkspaceWork>>;
  teamTasks: DashboardAvailability<WorkspaceList<WorkspaceWork>>;
  teamRequests: DashboardAvailability<WorkspaceList<WorkspaceWork>>;
  coverage: DashboardAvailability<WorkspaceList<WorkspaceCoverage>>;
  activity: DashboardAvailability<WorkspaceList<WorkspaceActivity>>;
};

/** Only the touched workspace boundary; a missing section is never measured empty. */
export function assertIncidentWorkspace(input: unknown): asserts input is IncidentWorkspace {
  const fail = (): never => { throw new Error("Incident workspace could not be verified. Retry."); };
  const obj = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : fail();
  const str = (v: unknown) => { if (typeof v !== "string") fail(); };
  const nullable = (v: unknown) => { if (v !== null) str(v); };
  const date = (v: unknown, optional = false) => { if (optional && v === null) return; str(v); if (!Number.isFinite(Date.parse(String(v)))) fail(); };
  const link = (v: unknown) => { str(v); if (!String(v).startsWith("/") || String(v).startsWith("//")) fail(); };
  const root = obj(input), incident = obj(root.incident);
  ["operationalId", "name", "status"].forEach(k => str(incident[k]));
  ["description", "location", "flight", "route"].forEach(k => nullable(incident[k]));
  if (!Array.isArray(incident.roles) || !incident.roles.every(v => typeof v === "string")) fail();
  for (const key of ["briefing", "myTasks", "myRequests", "teamTasks", "teamRequests", "coverage", "activity"]) {
    const section = obj(root[key]);
    if (section.status === "unavailable") { if ("value" in section) fail(); continue; }
    if (section.status !== "available") fail();
    if (key === "briefing") {
      if (section.value === null) continue;
      const value = obj(section.value);
      str(value.title); str(value.situation); date(value.publishedAt, true); date(value.nextUpdateDueAt, true);
      if (!Array.isArray(value.priorities) || !Array.isArray(value.risks)) fail();
      for (const item of value.priorities as unknown[]) { const row = obj(item); str(row.description); str(row.status); nullable(row.responsible); date(row.dueAt, true); }
      for (const item of value.risks as unknown[]) { const row = obj(item); str(row.description); str(row.severity); nullable(row.mitigation); }
      continue;
    }
    const value = obj(section.value);
    if (!Array.isArray(value.items) || !Number.isInteger(value.total) || Number(value.total) < value.items.length || !Number.isInteger(value.limit) || Number(value.limit) <= 0 || value.items.length > Number(value.limit)) fail();
    str(value.scope);
    for (const item of value.items as unknown[]) {
      const row = obj(item); str(row.id); str(row.title); link(row.href);
      if (key === "coverage") {
        ["functionName", "location"].forEach(k => str(row[k])); nullable(row.person); nullable(row.group);
        date(row.startAt); date(row.endAt);
        if (!["Confirmed coverage", "Awaiting confirmation", "Unfilled duty"].includes(String(row.state))) fail();
      } else if (key === "activity") { str(row.actor); str(row.actionLabel); nullable(row.summary); date(row.occurredAt); }
      else {
        ["operationalId", "priority", "state", "nextAction"].forEach(k => str(row[k]));
        if (!["Task", "Support request"].includes(String(row.type)) || typeof row.overdue !== "boolean") fail();
        nullable(row.owner); nullable(row.warning); date(row.dueAt, true);
      }
    }
  }
}
