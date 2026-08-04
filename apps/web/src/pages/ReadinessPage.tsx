import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw, X } from "lucide-react";
import { DialogSurface } from "../components/DialogSurface";
import { PageIntro } from "../components/portal";
import { AlertBox, Badge, Button, Card, CardHeader, Input, Loading, Select } from "../components/ui";
import { useApp } from "../lib/app-context";
import { api } from "../lib/api";

type ReadinessStatus = "Ready" | "Ready with attention" | "Not ready" | "Unknown" | "Not applicable";
type Assessment = Record<string, any>;

const statusOptions: ReadinessStatus[] = ["Ready", "Ready with attention", "Not ready", "Unknown", "Not applicable"];

function statusTone(status?: string) {
  if (status === "Ready") return "success";
  if (status === "Not ready") return "danger";
  if (status === "Ready with attention") return "warning";
  if (status === "Unknown") return "info";
  return "neutral";
}

function issueTone(severity?: string) {
  if (severity === "blocker") return "danger";
  if (severity === "warning") return "warning";
  return "neutral";
}

function formatDateTime(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function StatusPill({ status }: { status?: string }) {
  return <Badge tone={statusTone(status)}>{status ?? "Unknown"}</Badge>;
}

function SummaryCard({
  label,
  value,
  status,
  active,
  onClick
}: {
  label: string;
  value: number;
  status?: ReadinessStatus;
  active?: boolean;
  onClick?: () => void;
}) {
  const content = (
    <div className="grid gap-2 text-left">
      <span className="text-xs font-black uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-3xl font-black text-foreground">{value}</span>
      {status ? <StatusPill status={status} /> : null}
    </div>
  );
  if (!onClick) {
    return <Card className="p-4">{content}</Card>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={`focus-ring rounded-lg text-left transition hover:bg-muted ${active ? "ring-2 ring-ring" : ""}`}
    >
      <Card className="h-full p-4 shadow-none">{content}</Card>
    </button>
  );
}

function IssueList({ title, items }: { title: string; items: any[] }) {
  if (!items.length) return null;
  return (
    <div>
      <h3 className="text-sm font-black text-foreground">{title}</h3>
      <div className="mt-2 grid gap-2">
        {items.map((item, index) => (
          <div key={`${item.code}-${item.source?.id ?? index}`} className="rounded-md border border-border bg-muted px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={issueTone(item.severity)}>{item.category}</Badge>
              {item.dueAt ? <span className="text-xs font-semibold text-muted-foreground">Due {formatDateTime(item.dueAt)}</span> : null}
            </div>
            <p className="mt-2 text-sm font-black text-foreground">{item.title}</p>
            <p className="mt-1 text-sm font-semibold leading-6 text-muted-foreground">{item.detail}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function NextActions({ actions }: { actions: any[] }) {
  if (!actions.length) {
    return (
      <div className="rounded-md border border-border bg-muted px-3 py-3 text-sm font-semibold text-muted-foreground">
        No immediate readiness action is required for this view.
      </div>
    );
  }
  return (
    <div className="grid gap-2">
      {actions.map((action, index) => (
        <Link
          key={`${action.href}-${index}`}
          to={action.href}
          className="focus-ring flex items-center justify-between rounded-md border border-border bg-card px-3 py-2 text-sm font-black text-foreground transition hover:bg-muted"
        >
          <span>{action.label}</span>
          <span className="text-xs font-semibold text-muted-foreground">{action.reason}</span>
        </Link>
      ))}
    </div>
  );
}

function DimensionGrid({ dimensions }: { dimensions: any[] }) {
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
      {dimensions.map((item) => (
        <Card key={item.key} className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-black uppercase tracking-wide text-muted-foreground">{item.label}</p>
              <p className="mt-2 text-lg font-black text-foreground">{item.state}</p>
            </div>
            <StatusPill status={item.status} />
          </div>
          <p className="mt-3 text-sm font-semibold leading-6 text-muted-foreground">{item.detail}</p>
        </Card>
      ))}
    </div>
  );
}

function PersonalReadiness({ assessment }: { assessment?: Assessment | null }) {
  if (!assessment) return null;
  return (
    <Card>
      <CardHeader
        title="My readiness"
        description={assessment.member ? `${assessment.member.displayName} · ${assessment.member.memberId}` : "No linked member profile"}
        action={<StatusPill status={assessment.overallStatus} />}
      />
      <div className="grid gap-4 p-4">
        <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-muted-foreground">
          <span>Calculated {formatDateTime(assessment.calculatedAt)}</span>
          <span>·</span>
          <span>{assessment.blockers?.length ?? 0} blockers</span>
          <span>·</span>
          <span>{assessment.warnings?.length ?? 0} warnings</span>
        </div>
        <DimensionGrid dimensions={assessment.dimensions ?? []} />
        <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
          <div>
            <h3 className="mb-2 text-sm font-black text-foreground">Next actions</h3>
            <NextActions actions={assessment.nextActions ?? []} />
          </div>
          <div className="grid gap-4">
            <IssueList title="Blockers" items={assessment.blockers ?? []} />
            <IssueList title="Warnings" items={assessment.warnings ?? []} />
          </div>
        </div>
      </div>
    </Card>
  );
}

function MemberTable({
  members,
  onSelect
}: {
  members: Assessment[];
  onSelect: (assessment: Assessment) => void;
}) {
  if (!members.length) {
    return (
      <div className="rounded-md border border-border bg-muted px-4 py-8 text-center text-sm font-semibold text-muted-foreground">
        No readiness records match the selected filters.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="min-w-full divide-y divide-border text-sm">
        <thead className="bg-muted text-xs font-black uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-3 text-left">Member</th>
            <th className="px-3 py-3 text-left">Status</th>
            <th className="px-3 py-3 text-left">Needs attention</th>
            <th className="px-3 py-3 text-left">Primary issue</th>
            <th className="px-3 py-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border bg-card">
          {members.map((item) => {
            const primary = item.blockers?.[0] ?? item.warnings?.[0] ?? null;
            return (
              <tr key={item.member.id} className="hover:bg-muted">
                <td className="px-3 py-3">
                  <p className="font-black text-foreground">{item.member.displayName}</p>
                  <p className="text-xs font-semibold text-muted-foreground">{item.member.memberId} · {item.member.assignedFunction}</p>
                </td>
                <td className="px-3 py-3"><StatusPill status={item.overallStatus} /></td>
                <td className="px-3 py-3 text-sm font-semibold text-muted-foreground">
                  {item.blockers.length} blockers · {item.warnings.length} warnings
                </td>
                <td className="px-3 py-3">
                  {primary ? (
                    <div>
                      <p className="font-bold text-foreground">{primary.title}</p>
                      <p className="text-xs font-semibold text-muted-foreground">{primary.category}</p>
                    </div>
                  ) : <span className="text-sm font-semibold text-muted-foreground">No open readiness issue</span>}
                </td>
                <td className="px-3 py-3 text-right">
                  <Button size="sm" onClick={() => onSelect(item)}>View</Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ReadinessDrawer({ assessment, onClose }: { assessment: Assessment; onClose: () => void }) {
  return (
    <DialogSurface
      title={`${assessment.member.displayName} readiness`}
      onClose={onClose}
      className="fixed inset-y-0 right-0 z-50 flex w-full max-w-3xl flex-col border-l border-border bg-card text-foreground shadow-2xl"
    >
      <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 data-dialog-heading="true" tabIndex={-1} className="text-xl font-black text-foreground">{assessment.member.displayName}</h2>
          <p className="mt-1 text-sm font-semibold text-muted-foreground">{assessment.member.memberId} · {assessment.member.assignedFunction}</p>
        </div>
        <button type="button" className="focus-ring rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={onClose} aria-label="Close readiness detail">
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="scrollbar-soft flex-1 overflow-y-auto p-5">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <StatusPill status={assessment.overallStatus} />
          <span className="text-sm font-semibold text-muted-foreground">Calculated {formatDateTime(assessment.calculatedAt)}</span>
        </div>
        <DimensionGrid dimensions={assessment.dimensions ?? []} />
        <div className="mt-5 grid gap-5">
          <IssueList title="Blockers" items={assessment.blockers ?? []} />
          <IssueList title="Warnings" items={assessment.warnings ?? []} />
          <div>
            <h3 className="mb-2 text-sm font-black text-foreground">Next actions</h3>
            <NextActions actions={assessment.nextActions ?? []} />
          </div>
        </div>
      </div>
    </DialogSurface>
  );
}

export function ReadinessPage() {
  const { can } = useApp();
  const canOwn = can("readiness:read-own");
  const canManage = can("readiness:read-group") || can("readiness:read-all");
  const canSummary = can("readiness:read-summary") || canManage;
  const [personal, setPersonal] = useState<Assessment | null>(null);
  const [summary, setSummary] = useState<any | null>(null);
  const [members, setMembers] = useState<Assessment[]>([]);
  const [groups, setGroups] = useState<any[]>([]);
  const [selected, setSelected] = useState<Assessment | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const query = useMemo(() => ({ status: statusFilter, groupId: groupFilter, search }), [groupFilter, search, statusFilter]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [nextPersonal, nextSummary, nextMembers, nextGroups] = await Promise.all([
        canOwn ? api.readinessMe() : Promise.resolve(null),
        canSummary ? api.readinessSummary() : Promise.resolve(null),
        canManage ? api.readinessMembers(query) : Promise.resolve({ data: [] }),
        canManage ? api.readinessGroups() : Promise.resolve({ data: [] })
      ]);
      setPersonal(nextPersonal);
      setSummary(nextSummary);
      setMembers(nextMembers?.data ?? []);
      setGroups(nextGroups?.data ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Readiness could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [canManage, canOwn, canSummary, query]);

  useEffect(() => {
    void load();
  }, [load]);

  const groupOptions = groups.map((item) => item.group).filter(Boolean);
  const summaryStatusCounts = summary?.byStatus ?? {};

  return (
    <>
      <PageIntro
        eyebrow="Readiness"
        title="Readiness"
        description="Next: resolve blockers first, then clear warnings before taking specialist work."
      >
        <Button icon={RefreshCw} onClick={() => void load()} disabled={loading}>Refresh</Button>
      </PageIntro>

      {error ? (
        <div className="mb-4">
          <AlertBox>{error}</AlertBox>
        </div>
      ) : null}

      {loading ? <Loading label="Loading readiness" /> : (
        <div className="grid gap-5">
          {canOwn ? <PersonalReadiness assessment={personal} /> : null}

          {canSummary && summary ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              {statusOptions.map((status) => (
                <SummaryCard
                  key={status}
                  label={status}
                  value={summaryStatusCounts[status] ?? 0}
                  status={status}
                  active={statusFilter === status}
                  onClick={canManage ? () => setStatusFilter(statusFilter === status ? "" : status) : undefined}
                />
              ))}
            </div>
          ) : null}

          {canManage ? (
            <Card>
              <CardHeader title="Readiness management" description="Filter members, open a record, then follow the linked next action." />
              <div className="grid gap-4 p-4">
                <div className="grid gap-3 lg:grid-cols-[1fr_220px_260px_auto]">
                  <div>
                    <label className="mb-1 block text-sm font-bold text-muted-foreground" htmlFor="readiness-search">Search</label>
                    <Input id="readiness-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Member, function or issue" />
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-bold text-muted-foreground" htmlFor="readiness-status">Status</label>
                    <Select id="readiness-status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                      <option value="">All statuses</option>
                      {statusOptions.map((status) => <option key={status} value={status}>{status}</option>)}
                    </Select>
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-bold text-muted-foreground" htmlFor="readiness-group">Group</label>
                    <Select id="readiness-group" value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)}>
                      <option value="">All groups</option>
                      {groupOptions.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
                    </Select>
                  </div>
                  <div className="flex items-end">
                    <Button onClick={() => { setSearch(""); setStatusFilter(""); setGroupFilter(""); }}>Clear</Button>
                  </div>
                </div>
                <MemberTable members={members} onSelect={setSelected} />
              </div>
            </Card>
          ) : null}
        </div>
      )}

      {selected ? <ReadinessDrawer assessment={selected} onClose={() => setSelected(null)} /> : null}
    </>
  );
}
