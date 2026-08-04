import { useEffect, useMemo, useState, type ReactNode } from "react";
import { History, Search } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useApp } from "../lib/app-context";
import type { AnyRecord } from "../lib/types";
import { Badge, Button, Card, CardHeader, EmptyState, Input, Loading, Select, StatusBadge } from "../components/ui";
import { formatDate } from "../lib/format";
import { isDecisionTimelineEvent, metadataSummary } from "../lib/record-context";

type CaseData = {
  passengers: AnyRecord[];
  enquiries: AnyRecord[];
  families: AnyRecord[];
  matches: AnyRecord[];
  requests: AnyRecord[];
  releases: AnyRecord[];
  timeline: AnyRecord[];
};

const emptyData: CaseData = {
  passengers: [],
  enquiries: [],
  families: [],
  matches: [],
  requests: [],
  releases: [],
  timeline: []
};

function personName(row?: AnyRecord | null) {
  return [row?.lastName, row?.firstName].filter(Boolean).join(", ") || [row?.firstName, row?.lastName].filter(Boolean).join(" ");
}

function compact(values: unknown[], separator = " | ") {
  return values.filter((value) => value !== undefined && value !== null && value !== "").map(String).join(separator);
}

function caseIdFrom(row: AnyRecord) {
  return String(row.caseId ?? "").trim();
}

function matchesCase(row: AnyRecord, caseId: string) {
  return caseIdFrom(row).toLowerCase() === caseId.toLowerCase();
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <Card>
      <CardHeader title={title} action={<Badge tone={count ? "neutral" : "success"}>{count}</Badge>} />
      <div className="grid gap-2 p-4">{children}</div>
    </Card>
  );
}

function MiniRecord({
  title,
  detail,
  status,
  meta
}: {
  title: string;
  detail?: string;
  status?: string | null;
  meta?: Array<string | undefined | null>;
}) {
  return (
    <article className="rounded-md border border-slate-200 bg-slate-50 p-3">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-black text-slate-950">{title}</p>
          {detail ? <p className="mt-1 line-clamp-2 text-xs font-semibold text-slate-500">{detail}</p> : null}
        </div>
        {status ? <StatusBadge value={status} className="max-w-40 shrink-0" /> : null}
      </div>
      {meta?.filter(Boolean).length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {meta.filter(Boolean).map((item) => (
            <span key={item} className="inline-block max-w-full truncate rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-bold text-slate-600">
              {item}
            </span>
          ))}
        </div>
      ) : null}
    </article>
  );
}

export function CasesPage() {
  const { activeSession, can } = useApp();
  const navigate = useNavigate();
  const [data, setData] = useState<CaseData>(emptyData);
  const [selectedCase, setSelectedCase] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load() {
    if (!activeSession) {
      setData(emptyData);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError("");
    try {
      const [passengers, enquiries, families, matches, requests, releases, timeline] = await Promise.all([
        can("passenger:read") ? api.listAll("passenger-records", { sessionId: activeSession.id }) : Promise.resolve({ data: [] }),
        can("enquiry:read") ? api.listAll("enquiries", { sessionId: activeSession.id }) : Promise.resolve({ data: [] }),
        can("family:read") ? api.listAll("family-records", { sessionId: activeSession.id }) : Promise.resolve({ data: [] }),
        can("matching:read") ? api.listAll("matching-records", { sessionId: activeSession.id }) : Promise.resolve({ data: [] }),
        can("request:read") ? api.listAll("requests", { sessionId: activeSession.id }) : Promise.resolve({ data: [] }),
        can("release:read") ? api.listAll("releases", { sessionId: activeSession.id }) : Promise.resolve({ data: [] }),
        can("timeline:read") ? api.listAll("timeline", { sessionId: activeSession.id }) : Promise.resolve({ data: [] })
      ]);

      setData({
        passengers: passengers.data,
        enquiries: enquiries.data,
        families: families.data,
        matches: matches.data,
        requests: requests.data,
        releases: releases.data,
        timeline: timeline.data
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load case data");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setSelectedCase("");
    setQuery("");
    void load();
  }, [activeSession?.id]);

  const caseIds = useMemo(() => {
    const ids = new Set<string>();
    for (const rows of Object.values(data)) {
      for (const row of rows) {
        const id = caseIdFrom(row);
        if (id) ids.add(id);
      }
    }
    return Array.from(ids).sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }));
  }, [data]);

  useEffect(() => {
    if (!selectedCase && caseIds[0]) setSelectedCase(caseIds[0]);
    if (selectedCase && !caseIds.includes(selectedCase)) setSelectedCase(caseIds[0] ?? "");
  }, [caseIds, selectedCase]);

  const visibleCaseIds = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return caseIds;
    return caseIds.filter((id) => id.toLowerCase().includes(needle));
  }, [caseIds, query]);

  const current = useMemo(() => {
    if (!selectedCase) return emptyData;
    return {
      passengers: data.passengers.filter((row) => matchesCase(row, selectedCase)),
      enquiries: data.enquiries.filter((row) => matchesCase(row, selectedCase)),
      families: data.families.filter((row) => matchesCase(row, selectedCase)),
      matches: data.matches.filter((row) => matchesCase(row, selectedCase)),
      requests: data.requests.filter((row) => matchesCase(row, selectedCase)),
      releases: data.releases.filter((row) => matchesCase(row, selectedCase)),
      timeline: data.timeline.filter((row) => matchesCase(row, selectedCase))
    };
  }, [data, selectedCase]);

  const attentionCount =
    current.matches.filter((row) => row.holdCheck && row.holdCheck !== "No hold").length +
    current.requests.filter((row) => !["Done", "Closed", "Cancelled", "Completed"].includes(String(row.status ?? ""))).length +
    current.families.filter((row) => row.verificationStatus !== "Verified").length;

  if (loading) return <Loading label="Loading cases" />;
  if (error) return <EmptyState title="Case view unavailable" detail={error} />;

  return (
    <div className="grid gap-5">
      <Card>
        <div className="grid gap-3 p-4 lg:grid-cols-[minmax(260px,360px)_minmax(220px,1fr)_auto] lg:items-end">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <Input className="h-9 pl-9" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search case ID" />
          </div>
          <Select value={selectedCase} onChange={(event) => setSelectedCase(event.target.value)} className="h-9">
            {visibleCaseIds.map((caseId) => (
              <option key={caseId} value={caseId}>
                {caseId}
              </option>
            ))}
          </Select>
          <div className="flex flex-wrap gap-1.5">
            <Badge tone={attentionCount ? "warning" : "success"}>{attentionCount ? `${attentionCount} attention` : "Clear"}</Badge>
            <Badge tone="neutral">{caseIds.length} cases</Badge>
          </div>
        </div>
      </Card>

      {!selectedCase ? (
        <EmptyState title="No cases" detail="Records with case IDs will appear here." />
      ) : (
        <div className="grid gap-5 xl:grid-cols-2">
          <div className="xl:col-span-2">
            <Card>
              <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="truncate text-lg font-black text-slate-950">{selectedCase}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Badge tone={attentionCount ? "warning" : "success"}>{attentionCount ? `${attentionCount} attention` : "Clear"}</Badge>
                    <Badge tone="neutral">{current.timeline.filter(isDecisionTimelineEvent).length} decisions</Badge>
                    <Badge tone="neutral">{current.timeline.length} events</Badge>
                  </div>
                </div>
                <Button icon={History} variant="secondary" onClick={() => navigate(`/timeline?case=${encodeURIComponent(selectedCase)}`)}>
                  Timeline
                </Button>
              </div>
            </Card>
          </div>

          <Section title="Passenger / SRC" count={current.passengers.length}>
            {current.passengers.length ? (
              current.passengers.map((row) => (
                <MiniRecord
                  key={row.id}
                  title={compact([row.operationalId, personName(row)]) || "Passenger"}
                  detail={compact([row.flightNumber, row.route, row.seat]) || "No travel details"}
                  status={row.conditionStatus}
                  meta={[row.personType, row.holdStatus && row.holdStatus !== "No hold" ? row.holdStatus : undefined, row.srcConfirmed ? "SRC confirmed" : undefined]}
                />
              ))
            ) : (
              <EmptyState title="No passenger records" />
            )}
          </Section>

          <Section title="Family / NOK" count={current.families.length}>
            {current.families.length ? (
              current.families.map((row) => (
                <MiniRecord
                  key={row.id}
                  title={compact([row.operationalId, personName(row)]) || "Family/NOK"}
                  detail={row.immediateNeeds ?? row.verificationNotes}
                  status={row.verificationStatus}
                  meta={[row.claimedRelationship, compact([row.phone, row.email], " / ")]}
                />
              ))
            ) : (
              <EmptyState title="No family/NOK records" />
            )}
          </Section>

          <Section title="TEC Intake" count={current.enquiries.length}>
            {current.enquiries.length ? (
              current.enquiries.map((row) => (
                <MiniRecord
                  key={row.id}
                  title={compact([row.operationalId, row.callerName]) || "Enquiry"}
                  detail={row.notes ?? row.lastKnownContact}
                  status={row.status}
                  meta={[row.urgency, row.contactChannel, row.claimedRelationship]}
                />
              ))
            ) : (
              <EmptyState title="No enquiries" />
            )}
          </Section>

          <Section title="Matching" count={current.matches.length}>
            {current.matches.length ? (
              current.matches.map((row) => (
                <MiniRecord
                  key={row.id}
                  title={compact([row.operationalId, row.familyRecord ? personName(row.familyRecord) : row.familyRecordId]) || "Match"}
                  detail={row.matchBasis ?? row.decisionNotes}
                  status={row.status}
                  meta={[typeof row.matchScore === "number" ? `${Math.round(row.matchScore * 100)}%` : undefined, row.holdCheck && row.holdCheck !== "No hold" ? row.holdCheck : undefined]}
                />
              ))
            ) : (
              <EmptyState title="No matching records" />
            )}
          </Section>

          <Section title="Requests" count={current.requests.length}>
            {current.requests.length ? (
              current.requests.map((row) => (
                <MiniRecord
                  key={row.id}
                  title={compact([row.operationalId, row.category]) || "Request"}
                  detail={row.details}
                  status={row.status}
                  meta={[row.priority, row.ownerAssignedTo, row.approvalStatus]}
                />
              ))
            ) : (
              <EmptyState title="No requests" />
            )}
          </Section>

          <Section title="Release" count={current.releases.length}>
            {current.releases.length ? (
              current.releases.map((row) => (
                <MiniRecord
                  key={row.id}
                  title={compact([row.operationalId, row.actionType]) || "Release"}
                  detail={compact([row.releaseDestination, row.receivingParty]) || row.notes}
                  status={row.status}
                  meta={[row.identityChecked ? "Identity checked" : "Identity pending", row.holdCleared ? "Hold cleared" : "Hold pending", row.transportMode]}
                />
              ))
            ) : (
              <EmptyState title="No release actions" />
            )}
          </Section>

          <div className="xl:col-span-2">
            <Section title="Timeline" count={current.timeline.length}>
              {current.timeline.length ? (
                current.timeline.map((row) => (
                  <MiniRecord
                    key={row.id}
                    title={row.title ?? row.eventType}
                    detail={row.body ?? metadataSummary(row.metadata)}
                    status={isDecisionTimelineEvent(row) ? "Decision" : row.eventType}
                    meta={[row.occurredAt ? formatDate(row.occurredAt) : undefined, row.entityType, metadataSummary(row.metadata)]}
                  />
                ))
              ) : (
                <EmptyState title="No timeline events" />
              )}
            </Section>
          </div>
        </div>
      )}
    </div>
  );
}
