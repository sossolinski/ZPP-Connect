import { ageLabel, assertIncidentWorkspace, dashboardStaleAfterMs, type DashboardAvailability, type DashboardDto, type WorkspaceList, type WorkspaceWork } from "@zpp/shared";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { useApp } from "../lib/app-context";
import { useOperationalClock } from "../lib/use-operational-clock";
import { formatDate } from "../lib/format";
import type { DemoUser, PortalRouteKey } from "../lib/portal-types";
import { BriefingFreshness } from "../components/BriefingFreshness";
import { Badge, Button, Card, CardHeader, EmptyState, Loading } from "../components/ui";

const workAvailable = (sections: DashboardAvailability<WorkspaceList<WorkspaceWork>>[]) => sections.some(section => section.status === "available");
function WorkList({ title, testId, sections }: { title: string; testId: string; sections: DashboardAvailability<WorkspaceList<WorkspaceWork>>[] }) {
  const visible = sections.flatMap(section => section.status === "available" ? [section.value] : []);
  return <section data-testid={testId} aria-label={title}><Card><CardHeader title={title} />
    <div role="region" aria-label={`${title} list`} tabIndex={0} className="focus-ring grid max-h-[32rem] gap-4 overflow-y-auto p-4">{visible.length ? visible.map(section => <div key={section.scope}>
      <p className="mb-2 text-xs font-semibold text-muted-foreground">{section.scope} · {section.items.length} of {section.total} shown</p>
      {section.items.length ? <ul className="grid gap-2">{section.items.map(item => <li key={`${item.type}:${item.id}`}>
        <Link to={item.href} className="focus-ring block rounded-md border border-border p-3">
          <div className="flex flex-wrap items-center gap-2"><span className="text-xs font-bold">{item.type} · {item.operationalId}</span><Badge tone={item.priority === "Urgent" || item.overdue ? "warning" : "neutral"}>{item.priority}</Badge><span className="text-xs">{item.state}</span></div>
          <h3 className="mt-1 font-bold">{item.title}</h3>
          <p className="mt-1 text-sm">Owner: {item.owner ?? "Unassigned"} · {item.dueAt ? `Due ${formatDate(item.dueAt)}` : "No due date"}</p>
          {item.overdue ? <p className="text-sm font-bold text-amber-800 dark:text-amber-300">Overdue</p> : null}
          {item.warning ? <p className="text-sm font-bold text-amber-800 dark:text-amber-300">{item.warning}</p> : null}
          <span className="mt-1 block text-sm font-semibold underline">{item.nextAction}</span>
        </Link>
      </li>)}</ul> : <p className="text-sm">No open work in this scope.</p>}
    </div>) : <p>Work information unavailable for your role.</p>}</div>
  </Card></section>;
}

export function DashboardPage({ portalUser, canAccessRoute }: { portalUser: DemoUser; canAccessRoute: (route: PortalRouteKey) => boolean }) {
  const { activeSession, reload } = useApp();
  const [params, setParams] = useSearchParams();
  const handover = params.get("view") === "handover";
  const [snapshot, setSnapshot] = useState<{ sessionId: string; data?: DashboardDto; error: string; refreshing: boolean }>({ sessionId: "", error: "", refreshing: false });
  const [refresh, setRefresh] = useState(0);
  const now = useOperationalClock();
  const dashboard = snapshot.sessionId === activeSession?.id ? snapshot.data : undefined;
  const error = snapshot.sessionId === activeSession?.id ? snapshot.error : "";
  const refreshDashboard = () => setRefresh(value => value + 1);

  useEffect(() => {
    const sessionId = activeSession?.id;
    let cancelled = false;
    if (!sessionId) { setSnapshot({ sessionId: "", error: "", refreshing: false }); return; }
    setSnapshot(previous => ({ sessionId, data: previous.sessionId === sessionId ? previous.data : undefined, error: "", refreshing: true }));
    api.dashboard(sessionId).then(data => {
      assertIncidentWorkspace(data.workspace);
      if (!cancelled) setSnapshot({ sessionId, data, error: "", refreshing: false });
    }).catch((err: Error) => {
      if (!cancelled) setSnapshot(previous => ({ ...previous, error: err.message, refreshing: false }));
    });
    return () => { cancelled = true; };
  }, [activeSession?.id, refresh]);

  if (!activeSession) return <EmptyState title="No active incident" detail="Select an incident to open its operational workspace." action={canAccessRoute("sessions") ? <Link className="focus-ring underline" to="/sessions">Open incidents</Link> : <Button onClick={() => void reload()}>Retry operational context</Button>} />;
  if (!dashboard && !error) return <Loading label="Loading incident workspace" />;
  if (error && !dashboard) return <EmptyState title="Dashboard unavailable" detail={`Incident workspace could not load. ${error}`} action={<Button onClick={refreshDashboard}>Retry</Button>} />;
  if (!dashboard?.workspace) return <EmptyState title="Incident workspace unavailable" action={<Button onClick={refreshDashboard}>Retry</Button>} />;
  const workspace = dashboard.workspace, incident = workspace.incident;
  const briefing = workspace.briefing.status === "available" ? workspace.briefing.value : undefined;
  const attention = dashboard.operationalStatus.attention;
  const attentionItems = attention.status === "available" ? attention.value.items : [];
  const specialist = dashboard.operationalStatus.specialist;
  const stale = Boolean(error || now - Date.parse(dashboard.operationalStatus.loadedAt) >= dashboardStaleAfterMs);
  const own = [workspace.myTasks, workspace.myRequests], team = [workspace.teamTasks, workspace.teamRequests];

  return <div className="grid min-w-0 gap-5" data-testid="incident-workspace">
    <section aria-labelledby="incident-context-heading" data-testid="workspace-incident" className="rounded-md border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0">
        <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Incident {incident.operationalId}</p>
        <h2 id="incident-context-heading" className="mt-1 text-xl font-black">{incident.name}</h2>
        <p className="mt-1 text-sm">{[incident.location, incident.flight, incident.route].filter(Boolean).join(" · ") || "Location / flight context not recorded"}</p>
        {incident.description ? <p className="mt-1 text-sm text-muted-foreground">{incident.description}</p> : null}
        <p className="mt-2 text-xs font-semibold">Needs attention: {attention.status === "available" ? `${attentionItems.length} shown in the checked snapshot` : "Unavailable for your role"}</p>
        <p className="mt-2 text-xs">{portalUser.displayName} · {incident.roles.join(" · ") || "No operational role"}</p>
      </div><div className="flex flex-wrap items-center gap-2"><Badge tone={incident.status === "Active" ? "info" : "neutral"}>{incident.status}</Badge><Button size="sm" variant="secondary" aria-pressed={handover} onClick={() => setParams(handover ? {} : { view: "handover" })}>{handover ? "Return to workspace" : "Read handover"}</Button></div></div>
      <div role="status" data-testid="dashboard-freshness" className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs font-semibold">
        <div><p>{snapshot.refreshing ? "Refreshing…" : error ? "Refresh failed — showing previously loaded data." : stale ? "Data may be stale — loaded more than 5 minutes ago." : "Data loaded successfully."}</p><p>Last loaded {formatDate(dashboard.operationalStatus.loadedAt)} · {ageLabel(dashboard.operationalStatus.loadedAt, now)}. Refresh to check for changes.</p></div>
        <Button size="sm" variant="secondary" disabled={snapshot.refreshing} onClick={refreshDashboard}>{error ? "Retry" : "Refresh dashboard"}</Button>
      </div>
    </section>
    {handover ? <section data-testid="workspace-handover" className="rounded-md border border-border bg-muted p-4"><h2 className="font-black">Incident handover</h2><p className="mt-1 text-sm">Read the published situation, unresolved priorities, responsibilities, current staffing and recent changes below. This handover reflects your permitted sources at the last load; refresh before handing over.</p>{stale ? <p className="mt-1 text-sm font-bold">Snapshot may be stale — refresh before relying on this handover.</p> : null}</section> : null}
    <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section data-testid="workspace-briefing" aria-label="Latest authoritative briefing"><Card><CardHeader title="Latest authoritative briefing" action={workspace.briefing.status === "available" && canAccessRoute("active-event") ? <Link className="focus-ring text-sm font-bold underline" to="/active-event">Read full briefing</Link> : undefined} />
        <div className="p-4">{briefing ? <>
          <h3 className="text-lg font-black">{briefing.title}</h3><p className="mt-2 whitespace-pre-wrap text-sm">{briefing.situation}</p>
          <BriefingFreshness publishedAt={briefing.publishedAt} nextUpdateDueAt={briefing.nextUpdateDueAt} />
          <h3 className="mt-4 text-sm font-black">Key priorities</h3>{briefing.priorities.length ? <ul className="mt-2 grid gap-2">{briefing.priorities.map((item, index) => <li key={index} className="rounded-md bg-muted p-2 text-sm"><p className="font-bold">{item.description}</p><p>{item.status} · {item.responsible ?? "Owner not recorded"}{item.dueAt ? ` · Due ${formatDate(item.dueAt)}` : ""}</p></li>)}</ul> : <p className="mt-1 text-sm">No priorities recorded in the published briefing.</p>}
          {briefing.risks.length ? <><h3 className="mt-3 text-sm font-black">Material risks</h3><ul className="mt-1 grid gap-1">{briefing.risks.map((risk, index) => <li key={index} className="text-sm">{risk.severity}: {risk.description}{risk.mitigation ? ` · ${risk.mitigation}` : ""}</li>)}</ul></> : null}
        </> : <p>{workspace.briefing.status === "available" ? "No published briefing for this incident. Drafts are not an authoritative situation." : "Briefing not available for your role."}</p>}</div>
      </Card></section>
      <section data-testid="dashboard-attention" aria-label="Needs attention"><Card><CardHeader title="Needs attention" action={<Badge tone={attentionItems.length ? "warning" : "neutral"}>{attention.status === "available" ? `${attentionItems.length} shown` : "Unavailable"}</Badge>} />
        <div className="p-4">{attention.status === "available" ? <>
          <p className="mb-3 text-xs text-muted-foreground">Checked: {attention.value.checkedSources.join(" · ")}. Up to {attention.value.limitPerSource} items per queue; personal documents apply across incidents. This is a scoped snapshot.</p>
          {attentionItems.length ? <ul aria-label="Permitted attention items" tabIndex={0} className="focus-ring grid max-h-[26rem] gap-2 overflow-y-auto">{attentionItems.map(item => <li key={item.key}><Link to={item.href} className="focus-ring block rounded-md border border-border p-3"><h3 className="text-sm font-bold">{item.title}</h3><p className="text-sm">{item.detail}</p><span className="text-xs font-semibold underline">{item.actionLabel ?? "Open record"}</span></Link></li>)}</ul> : <p>No attention items in the checked queues. Other work may exist.</p>}
        </> : <p>Attention information unavailable. Not available for your role. Read the operational briefing for incident context.</p>}</div>
      </Card></section>
    </div>
    <div className="grid min-w-0 items-start gap-5 xl:grid-cols-2">
      {handover && workAvailable(team) ? <WorkList title="Team work / coordination" testId="workspace-team-work" sections={team} /> : null}
      {workAvailable(own) ? <WorkList title="My work" testId="workspace-my-work" sections={own} /> : null}
      {!handover && workAvailable(team) ? <WorkList title="Team work / coordination" testId="workspace-team-work" sections={team} /> : null}
    </div>
    <div className="grid min-w-0 items-start gap-5 xl:grid-cols-2">
      <section data-testid="workspace-coverage" aria-label="Current staffing"><Card><CardHeader title="Current staffing" action={workspace.coverage.status === "available" && canAccessRoute("rostering") ? <Link className="focus-ring text-sm underline" to="/rostering">Open rostering</Link> : undefined} />
        <div className="p-4">{workspace.coverage.status === "available" ? <><p className="mb-2 text-xs text-muted-foreground">{workspace.coverage.value.scope} · {workspace.coverage.value.items.length} of {workspace.coverage.value.total} shown. Status at the last load.</p>
          {workspace.coverage.value.items.length ? <ul className="grid gap-2">{workspace.coverage.value.items.map(shift => <li key={shift.id}><Link className="focus-ring block rounded-md border border-border p-3" to={shift.href}><h3 className="font-bold">{shift.functionName} · {shift.title}</h3><p className="text-sm">{shift.person ?? "No assigned person"}{shift.group ? ` · ${shift.group}` : ""}</p><p className="text-sm font-semibold">{shift.state}</p><p className="text-xs">{shift.location} · {formatDate(shift.startAt)} – {formatDate(shift.endAt)}</p><span className="text-xs underline">Review shift</span></Link></li>)}</ul> : <p>No published or confirmed duties in the current permitted period. This does not confirm full coverage.</p>}</> : <p>Staffing information unavailable for your account.</p>}</div>
      </Card></section>
      <section data-testid="workspace-activity" aria-label="Recent significant activity"><Card><CardHeader title="Recent significant activity" action={workspace.activity.status === "available" && canAccessRoute("timeline") ? <Link className="focus-ring text-sm underline" to="/timeline">Full timeline</Link> : undefined} />
        <div className="p-4">{workspace.activity.status === "available" ? <><p className="mb-2 text-xs text-muted-foreground">{workspace.activity.value.scope}</p>{workspace.activity.value.items.length ? <ul className="grid gap-3">{workspace.activity.value.items.map(item => <li key={item.id} className="border-b border-border pb-3 last:border-0"><h3 className="text-sm font-bold">{item.title}</h3><p className="mt-1 text-xs">{formatDate(item.occurredAt)} · {item.actor}</p>{item.summary ? <p className="mt-1 text-sm">{item.summary}</p> : null}<Link className="focus-ring text-sm underline" to={item.href}>{item.actionLabel}</Link></li>)}</ul> : <p>No recent significant events in the checked sources.</p>}</> : <p>Activity information not available for your role.</p>}</div>
      </Card></section>
    </div>
    <details data-testid="dashboard-metrics" className="rounded-md border border-border bg-card p-4"><summary className="focus-ring cursor-pointer font-bold">Specialist family / passenger metrics{specialist.status === "unavailable" ? " — Not available for your role" : ""}</summary>
      {specialist.status === "available" ? <div className="mt-3 grid gap-3 md:grid-cols-3">
        <div className="rounded-md bg-muted p-3"><h3 className="font-bold">Manifest coverage</h3><p className="mt-1 text-2xl font-black">{specialist.value.manifestCoverage.expectedTotal}</p><p>{specialist.value.manifestCoverage.inDatabaseTotal} records loaded</p><p>{specialist.value.manifestCoverage.notLoadedTotal} not loaded · {specialist.value.manifestCoverage.invalidTotal} invalid rows</p></div>
        <div className="rounded-md bg-muted p-3"><h3 className="font-bold">Matching progress</h3><p className="mt-1 text-2xl font-black">{specialist.value.matchingProgress.done}/{specialist.value.matchingProgress.totalPax}</p><p>{specialist.value.matchingProgress.completionRate}% verified or ready</p><p>{specialist.value.matchingProgress.onHold} on hold · {specialist.value.matchingProgress.noCandidate} without a candidate</p></div>
        <div className="rounded-md bg-muted p-3"><h3 className="font-bold">Data Quality</h3>{Object.entries(specialist.value.dataQuality).map(([key, value]) => <p key={key} className="text-sm">{({ missingCaseId: "Missing case link", missingDobOrAge: "DOB / age missing", missingSeat: "Seat missing", srcPending: "SRC pending", unknownCondition: "Unknown condition", familyContactMissing: "Family contact gaps", openReleaseActions: "Open release actions", releaseChecklistPending: "Release checklist pending" } as Record<string, string>)[key]}: {value}</p>)}</div>
      </div> : <p className="mt-2">Specialist metrics are not available for your role.</p>}
    </details>
    <details className="rounded-md border border-border p-4"><summary className="focus-ring cursor-pointer font-bold">Getting-started help and terms</summary><div className="mt-3 grid gap-3 text-sm"><p>Start with the published briefing, review Needs attention and My work, then open the relevant record to continue. Team coordination and staffing reflect your permitted scope.</p><p>Notifications in the header show delivered updates and read state. Tasks and Support Requests show the current work state.</p><p>TEC: telephone enquiry centre; capture calls without confirming passenger status. NOK: next of kin or family contact. PAX: passenger or crew manifest record. SRC: source confirmation for passenger or crew information. FAM: family/NOK record used during matching. Matching suggestions support an explicit human decision; they do not authorize release.</p><div className="flex flex-wrap gap-3">{workspace.briefing.status === "available" && canAccessRoute("active-event") ? <Link className="focus-ring underline" to="/active-event">Operational Briefing</Link> : null}{canAccessRoute("documents") ? <Link className="focus-ring underline" to="/documents">Approved guidance and documents</Link> : null}</div></div></details>
  </div>;
}
