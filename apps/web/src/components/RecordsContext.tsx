import { journeyQueuePath, safeJourneyReturn, withJourneyReturn } from "@zpp/shared";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { useApp } from "../lib/app-context";
import type { SessionRecord } from "../lib/types";
import { AlertBox } from "./ui";

export function RecordsContext({ incident }: { incident?: SessionRecord }) {
  const { activeSession, can } = useApp();
  const [params] = useSearchParams();
  const location = useLocation();
  const returnTo = safeJourneyReturn(params.get("returnTo"));
  const origin = journeyQueuePath(location.pathname, params);
  const historical = incident && ["Closed", "Archived"].includes(incident.status);
  return <div className="grid gap-2" data-testid="records-context">
    {incident && <AlertBox><strong>{historical ? "Historical incident — operational records are read-only" : "Records for incident"}: {incident.operationalId}</strong><p>{incident.status} · {incident.eventType}{incident.endAt ? ` · Closed ${new Date(incident.endAt).toLocaleString("en-GB")}` : ""}</p>{activeSession?.id !== incident.id && <p>This differs from the current operational incident {activeSession?.operationalId ?? "(none selected)"}. Reviewing records does not change it.</p>}</AlertBox>}
    <nav aria-label="Records navigation" className="flex flex-wrap gap-3 text-sm font-bold">
      {returnTo && <Link className="focus-ring underline" to={returnTo}>Return to previous view</Link>}
      <Link className="focus-ring underline" to="/dashboard">Return to current Incident Workspace{activeSession ? ` · ${activeSession.operationalId}` : ""}</Link>
      {(can("document:read-own") || can("document:read-all")) && <Link className="focus-ring underline" to={withJourneyReturn("/documents", origin)}>Documents and required guidance</Link>}
      {incident && can("evidence:read") && <Link className="focus-ring underline" to={withJourneyReturn(`/evidence?incidentId=${incident.id}`, origin)}>Incident Evidence</Link>}
      {incident && can("reports:read") && <Link className="focus-ring underline" to={withJourneyReturn(`/reports?incidentId=${incident.id}`, origin)}>Incident exports</Link>}
      {historical && incident.mode === "REAL" && can("aar:read") && <Link className="focus-ring underline" to={withJourneyReturn(`/reports/after-action?incidentId=${incident.id}`, origin)}>Post-Incident Report</Link>}
    </nav>
  </div>;
}
