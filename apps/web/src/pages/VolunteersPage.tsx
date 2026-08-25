import { useCallback, useEffect, useMemo, useState } from "react";
import { clsx } from "clsx";
import { AlertTriangle, Archive, CheckCircle2, ChevronLeft, ChevronRight, FilterX, Pencil, Plus, PhoneCall, Save, Search, UsersRound, XCircle } from "lucide-react";
import { Badge, EmptyState, PageIntro, Panel, PanelBody, SectionHeader } from "../components/portal";
import { AlertBox, Button, Field, Input, Select, Loading } from "../components/ui";
import { api } from "../lib/api";
import { useApp } from "../lib/app-context";

type Pool = "ZPP" | "TEC";
type MemberStatus = "Active" | "Inactive" | "Archived";
type MemberProfile = {
  id: string;
  memberId: string;
  volunteerId: string;
  firstName: string;
  lastName: string;
  displayName: string;
  pool: Pool;
  role: string;
  availability: string;
  contactEmail?: string | null;
  phone?: string | null;
  languages: string[];
  trainingStatus: string;
  assignedFunction: string;
  rosterStatus: string;
  assignedLeader?: string | null;
  status: MemberStatus;
  version: number;
};

type PoolFilter = "all" | Pool;
type ReadinessStatus = "Ready" | "Ready with attention" | "Not ready" | "Unknown" | "Not applicable";
type ReadinessFilter = "all" | ReadinessStatus;
type SortMode = "name" | "memberId" | "function" | "status";
type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger" | "gold" | "petrol" | "navy";
type ReadinessIssue = {
  title?: string;
  category?: string;
};
type MemberReadiness = {
  member?: {
    id?: string;
    memberId?: string;
    displayName?: string;
  };
  calculatedAt?: string;
  overallStatus: ReadinessStatus;
  blockers?: ReadinessIssue[];
  warnings?: ReadinessIssue[];
};

const pageSizeOptions = [25, 50, 100];
const availabilityOptions = ["Today 06:00-14:00", "Today 10:00-18:00", "Today 12:00-20:00", "Today 14:00-22:00", "Tomorrow 06:00-14:00", "Unavailable today", "Availability not set"];
const trainingOptions = ["Confirmed", "Pending", "Restricted"];
const rosterOptions = ["Confirmed", "Available", "Pending", "Unavailable", "Unassigned"];
const defaultFunctions = ["Family Assistance Team", "Telephone Enquiry Center", "Welfare Support", "Member Rostering", "Documentation Support", "Logistics Support", "Airport Support"];
const defaultLeaders = ["ZPP Coordinator", "Leader Alpha", "Leader Bravo", "Leader Charlie", "Leader Delta", "Leader Echo", "Leader Foxtrot"];

function compareText(left: string, right: string) {
  return left.localeCompare(right, undefined, { sensitivity: "base", numeric: true });
}

function normalizeMember(input: Record<string, any>): MemberProfile {
  const firstName = String(input.firstName ?? "").trim();
  const lastName = String(input.lastName ?? "").trim();
  const displayName = String(input.displayName ?? `${firstName} ${lastName}`).trim();
  return {
    id: String(input.id ?? ""),
    memberId: String(input.memberId ?? input.volunteerId ?? ""),
    volunteerId: String(input.volunteerId ?? input.memberId ?? ""),
    firstName,
    lastName,
    displayName,
    pool: input.pool === "TEC" ? "TEC" : "ZPP",
    role: String(input.role ?? "Member"),
    availability: String(input.availability ?? "Availability not set"),
    contactEmail: input.contactEmail ?? "",
    phone: input.phone ?? "",
    languages: Array.isArray(input.languages) ? input.languages.map(String) : String(input.languages ?? "PL").split(",").map((item) => item.trim()).filter(Boolean),
    trainingStatus: String(input.trainingStatus ?? "Pending"),
    assignedFunction: String(input.assignedFunction ?? "Unassigned"),
    rosterStatus: String(input.rosterStatus ?? "Unassigned"),
    assignedLeader: input.assignedLeader ?? "",
    status: input.status === "Archived" || input.status === "Inactive" ? input.status : "Active",
    version: Number(input.version ?? 1)
  };
}

function emptyMember(): MemberProfile {
  return {
    id: "",
    memberId: "",
    volunteerId: "",
    firstName: "",
    lastName: "",
    displayName: "New member",
    pool: "ZPP",
    role: "Member",
    availability: "Availability not set",
    contactEmail: "",
    phone: "",
    languages: ["PL"],
    trainingStatus: "Pending",
    assignedFunction: "Family Assistance Team",
    rosterStatus: "Unassigned",
    assignedLeader: "ZPP Coordinator",
    status: "Active",
    version: 1
  };
}

function isAvailableToday(record: MemberProfile) {
  return record.availability.startsWith("Today") && record.rosterStatus !== "Unavailable";
}

function normalizeReadinessStatus(value: unknown): ReadinessStatus {
  if (value === "Ready" || value === "Ready with attention" || value === "Not ready" || value === "Not applicable") return value;
  return "Unknown";
}

function readinessLabel(status: ReadinessStatus) {
  return status === "Unknown" ? "Unable to determine" : status;
}

function readinessTone(status: ReadinessStatus): BadgeTone {
  if (status === "Ready") return "success";
  if (status === "Ready with attention") return "warning";
  if (status === "Not ready") return "danger";
  if (status === "Not applicable") return "neutral";
  return "info";
}

function normalizeReadiness(input: Record<string, any>): MemberReadiness {
  const primary = input.primaryIssue && typeof input.primaryIssue === "object" ? input.primaryIssue : null;
  return {
    member: input.member,
    calculatedAt: typeof input.calculatedAt === "string" ? input.calculatedAt : undefined,
    overallStatus: normalizeReadinessStatus(input.overallStatus),
    blockers: Array.isArray(input.blockers) ? input.blockers : primary?.severity === "blocker" ? [primary] : [],
    warnings: Array.isArray(input.warnings) ? input.warnings : primary?.severity === "warning" ? [primary] : []
  };
}

function primaryReadinessIssue(readiness?: MemberReadiness) {
  return readiness?.blockers?.[0] ?? readiness?.warnings?.[0] ?? null;
}

function readinessNeedsAction(readiness?: MemberReadiness) {
  return readiness?.overallStatus === "Not ready" || readiness?.overallStatus === "Ready with attention";
}

function readinessMatchesFilter(readiness: MemberReadiness | undefined, filter: ReadinessFilter) {
  if (filter === "all") return true;
  return (readiness?.overallStatus ?? "Unknown") === filter;
}

function rosterTone(status: string): BadgeTone {
  if (status === "Confirmed") return "success";
  if (status === "Pending") return "warning";
  if (status === "Unavailable") return "neutral";
  return "petrol";
}

function matchesQuery(record: MemberProfile, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [
    record.memberId,
    record.displayName,
    record.firstName,
    record.lastName,
    record.contactEmail ?? "",
    record.phone ?? "",
    record.pool,
    record.role,
    record.availability,
    record.languages.join(" "),
    record.trainingStatus,
    record.assignedFunction,
    record.rosterStatus,
    record.assignedLeader ?? ""
  ].some((value) => value.toLowerCase().includes(needle));
}

function sortMembers(rows: MemberProfile[], sortBy: SortMode) {
  return [...rows].sort((left, right) => {
    if (sortBy === "name") return compareText(left.displayName, right.displayName);
    if (sortBy === "memberId") return compareText(left.memberId, right.memberId);
    if (sortBy === "function") return compareText(left.assignedFunction, right.assignedFunction) || compareText(left.displayName, right.displayName);
    if (sortBy === "status") return compareText(left.status, right.status) || compareText(left.displayName, right.displayName);
    return compareText(left.displayName, right.displayName);
  });
}

function MetricTile({
  label,
  value,
  detail,
  tone
}: {
  label: string;
  value: string;
  detail: string;
  tone: "navy" | "petrol" | "success" | "warning" | "danger";
}) {
  const toneClass = {
    navy: "border-border bg-card",
    petrol: "border-[#145C63]/20 bg-[#145C63]/5",
    success: "border-emerald-200 bg-emerald-50/60 dark:border-emerald-400/25 dark:bg-emerald-500/10",
    warning: "border-amber-200 bg-amber-50/60 dark:border-amber-400/25 dark:bg-amber-500/10",
    danger: "border-red-200 bg-red-50/60 dark:border-red-400/25 dark:bg-red-500/10"
  }[tone];

  return (
    <section className={clsx("rounded-md border p-3 text-foreground shadow-panel", toneClass)}>
      <p className="truncate text-xs font-bold text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-black leading-none text-foreground">{value}</p>
      <p className="mt-1 text-xs font-semibold leading-4 text-muted-foreground">{detail}</p>
    </section>
  );
}

function MemberRow({
  record,
  readiness,
  canReadReadiness,
  canEdit,
  onEdit
}: {
  record: MemberProfile;
  readiness?: MemberReadiness;
  canReadReadiness: boolean;
  canEdit: boolean;
  onEdit: (record: MemberProfile) => void;
}) {
  const readinessStatus = readiness?.overallStatus ?? "Unknown";
  const readinessIssue = primaryReadinessIssue(readiness);
  return (
    <article className="grid gap-3 border-t border-border px-3 py-3 text-sm first:border-t-0 xl:grid-cols-[1.25fr_1.25fr_1.45fr_1fr_1fr_auto] xl:items-center">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p className="min-w-0 truncate font-black text-foreground">{record.displayName}</p>
          <Badge tone={record.pool === "TEC" ? "petrol" : "navy"}>{record.pool}</Badge>
        </div>
        <p className="mt-1 text-xs font-bold text-muted-foreground">{record.memberId}</p>
        {record.contactEmail ? <p className="mt-1 truncate text-xs font-semibold text-muted-foreground">{record.contactEmail}</p> : null}
      </div>

      <div className="min-w-0">
        <p className="truncate font-bold text-foreground">{record.availability}</p>
        <p className="mt-1 text-xs font-bold text-muted-foreground">{record.phone ? `${record.phone} · ` : ""}{record.languages.join(", ")}</p>
      </div>

      <div className="min-w-0">
        <p className="truncate font-bold text-foreground">{record.assignedFunction}</p>
        <p className="mt-1 truncate text-xs font-bold text-muted-foreground">{record.role}</p>
      </div>

      <div className="min-w-0">
        <Badge tone={readinessTone(readinessStatus)}>{canReadReadiness ? readinessLabel(readinessStatus) : "Readiness not shown"}</Badge>
        <p className="mt-1 line-clamp-2 text-xs font-semibold text-muted-foreground">
          {canReadReadiness ? readinessIssue?.title ?? (readiness ? "No immediate blocker" : "Readiness unavailable") : "Open your own readiness view for personal details"}
        </p>
      </div>

      <div className="min-w-0">
        <Badge tone={rosterTone(record.rosterStatus)}>{record.rosterStatus}</Badge>
        <p className="mt-1 truncate text-xs font-bold text-muted-foreground">{record.assignedLeader || "No leader set"}</p>
      </div>

      <div className="flex justify-start xl:justify-end">
        <Button type="button" size="sm" icon={Pencil} onClick={() => onEdit(record)}>
          {canEdit ? "Edit" : "View"}
        </Button>
      </div>
    </article>
  );
}

export function VolunteersPage() {
  const { can } = useApp();
  const canCreate = can("member:create");
  const canUpdate = can("member:update");
  const canArchive = can("member:archive");
  const canReadOrgReadiness = can("readiness:read-all") || can("readiness:read-group") || can("admin:manage");
  const [records, setRecords] = useState<MemberProfile[]>([]);
  const [readinessRows, setReadinessRows] = useState<MemberReadiness[]>([]);
  const [query, setQuery] = useState("");
  const [poolFilter, setPoolFilter] = useState<PoolFilter>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | MemberStatus>("all");
  const [functionFilter, setFunctionFilter] = useState("all");
  const [trainingFilter, setTrainingFilter] = useState("all");
  const [rosterFilter, setRosterFilter] = useState("all");
  const [leaderFilter, setLeaderFilter] = useState("all");
  const [readinessFilter, setReadinessFilter] = useState<ReadinessFilter>("all");
  const [sortBy, setSortBy] = useState<SortMode>("name");
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);
  const [totalMembers, setTotalMembers] = useState(0);
  const [editing, setEditing] = useState<MemberProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [readinessError, setReadinessError] = useState("");
  const [editorError, setEditorError] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");

  const loadMembers = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    setReadinessError("");
    try {
      const membersResponse = await api.memberProfilesPage({
          search: query || undefined,
          pool: poolFilter === "all" ? undefined : poolFilter,
          status: statusFilter === "all" ? undefined : statusFilter,
          functionName: functionFilter === "all" ? undefined : functionFilter,
          sortBy: sortBy === "name" ? "displayName" : sortBy === "function" ? "assignedFunction" : sortBy,
          sortDirection: "asc",
          limit: pageSize,
          offset: (page - 1) * pageSize
        });
      const memberProfileIds = membersResponse.data.map((member) => String(member.id)).filter(Boolean);
      const readinessResponse = canReadOrgReadiness && memberProfileIds.length
          ? await api.readinessMembersPage({ memberProfileIds: memberProfileIds.join(","), limit: memberProfileIds.length, offset: 0 }).catch((error) => {
              setReadinessError(error instanceof Error ? error.message : "Unable to load readiness.");
              return null;
            })
          : null;
      setRecords(membersResponse.data.map(normalizeMember));
      setTotalMembers(membersResponse.total ?? membersResponse.data.length);
      setReadinessRows(readinessResponse?.data.map(normalizeReadiness) ?? []);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Unable to load members.");
      setRecords([]);
      setTotalMembers(0);
      setReadinessRows([]);
    } finally {
      setLoading(false);
    }
  }, [canReadOrgReadiness, functionFilter, page, pageSize, poolFilter, query, sortBy, statusFilter]);

  useEffect(() => {
    void loadMembers();
  }, [loadMembers]);

  const functionOptions = useMemo(
    () => Array.from(new Set([...defaultFunctions, ...records.map((record) => record.assignedFunction).filter(Boolean)])).sort(compareText),
    [records]
  );
  const leaderOptions = useMemo(
    () => Array.from(new Set([...defaultLeaders, ...records.map((record) => record.assignedLeader ?? "").filter(Boolean)])).sort(compareText),
    [records]
  );
  const readinessByMember = useMemo(() => {
    const entries: Array<[string, MemberReadiness]> = [];
    for (const row of readinessRows) {
      const id = String(row.member?.id ?? "");
      if (id) entries.push([id, row]);
    }
    return new Map(entries);
  }, [readinessRows]);

  const metrics = useMemo(() => {
    const activeRecords = records;
    const zppCount = activeRecords.filter((record) => record.pool === "ZPP").length;
    const tecCount = activeRecords.filter((record) => record.pool === "TEC").length;
    const availableToday = activeRecords.filter(isAvailableToday).length;
    const attention = activeRecords.filter((record) => readinessNeedsAction(readinessByMember.get(record.id))).length;

    return { activeRecords, zppCount, tecCount, availableToday, attention };
  }, [readinessByMember, records]);

  const filteredMembers = useMemo(() => {
    const filtered = metrics.activeRecords.filter((record) => {
      if (!matchesQuery(record, query)) return false;
      if (poolFilter !== "all" && record.pool !== poolFilter) return false;
      if (statusFilter !== "all" && record.status !== statusFilter) return false;
      if (functionFilter !== "all" && record.assignedFunction !== functionFilter) return false;
      if (trainingFilter !== "all" && record.trainingStatus !== trainingFilter) return false;
      if (rosterFilter !== "all" && record.rosterStatus !== rosterFilter) return false;
      if (leaderFilter !== "all" && record.assignedLeader !== leaderFilter) return false;
      if (!readinessMatchesFilter(readinessByMember.get(record.id), readinessFilter)) return false;
      return true;
    });

    return sortMembers(filtered, sortBy);
  }, [functionFilter, leaderFilter, metrics.activeRecords, poolFilter, query, readinessByMember, readinessFilter, rosterFilter, sortBy, statusFilter, trainingFilter]);

  const pageCount = Math.max(1, Math.ceil(totalMembers / pageSize));
  const safePage = Math.min(page, pageCount);
  const pageStart = (safePage - 1) * pageSize;
  const pageRows = filteredMembers;
  const visibleFrom = pageRows.length ? pageStart + 1 : 0;
  const visibleTo = pageStart + pageRows.length;
  const hasFilters =
    query ||
    poolFilter !== "all" ||
    statusFilter !== "all" ||
    functionFilter !== "all" ||
    trainingFilter !== "all" ||
    rosterFilter !== "all" ||
    leaderFilter !== "all" ||
    readinessFilter !== "all" ||
    sortBy !== "name" ||
    pageSize !== 25;

  useEffect(() => {
    setPage(1);
  }, [functionFilter, leaderFilter, pageSize, poolFilter, query, readinessFilter, rosterFilter, sortBy, statusFilter, trainingFilter]);

  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  function clearFilters() {
    setQuery("");
    setPoolFilter("all");
    setStatusFilter("all");
    setFunctionFilter("all");
    setTrainingFilter("all");
    setRosterFilter("all");
    setLeaderFilter("all");
    setReadinessFilter("all");
    setSortBy("name");
    setPageSize(25);
  }

  function openEditor(record: MemberProfile) {
    setEditing({ ...record, languages: [...record.languages] });
    setEditorError("");
    setNotice("");
  }

  function openNewMember() {
    setEditing(emptyMember());
    setEditorError("");
    setNotice("");
  }

  function updateEditing(patch: Partial<MemberProfile>) {
    setEditing((current) => (current ? { ...current, ...patch } : current));
  }

  async function saveEditing() {
    if (!editing) return;
    const firstName = editing.firstName.trim();
    const lastName = editing.lastName.trim();
    const contactEmail = String(editing.contactEmail ?? "").trim();
    const phone = String(editing.phone ?? "").trim();

    if (!firstName || !lastName) {
      setEditorError("First name and last name are required.");
      return;
    }
    if (!contactEmail || !phone) {
      setEditorError("Email and phone are required for operational contact.");
      return;
    }

    setSaving(true);
    setEditorError("");
    const body = {
      memberId: editing.memberId || undefined,
      firstName,
      lastName,
      pool: editing.pool,
      role: editing.role,
      contactEmail,
      phone,
      languages: editing.languages.map((language) => language.trim()).filter(Boolean),
      assignedFunction: editing.assignedFunction,
      status: editing.status,
      ...(editing.id ? { expectedVersion: editing.version } : {})
    };

    try {
      if (editing.id) await api.updateMemberProfile(editing.id, body);
      else await api.createMemberProfile(body);
      await loadMembers();
      setEditing(null);
      setNotice(editing.id ? "Member updated" : "Member created");
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : "Unable to save member.");
    } finally {
      setSaving(false);
    }
  }

  async function archiveEditing() {
    if (!editing?.id || !canArchive) return;
    setSaving(true);
    setEditorError("");
    try {
      await api.archiveMemberProfile(editing.id, { expectedVersion: editing.version });
      await loadMembers();
      setEditing(null);
      setNotice("Profile archived");
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : "Unable to archive profile.");
    } finally {
      setSaving(false);
    }
  }

  const editorCanSave = Boolean(editing && (editing.id ? canUpdate : canCreate));

  return (
    <>
      <PageIntro
        eyebrow="People"
        title="Members"
        description="Availability, qualification and roster readiness for ZPP members and TEC agents."
      />

      {notice ? <AlertBox tone="success" className="mt-3">{notice}</AlertBox> : null}
      {loadError ? <AlertBox tone="danger" className="mt-3">Unable to load members. {loadError}</AlertBox> : null}
      {readinessError ? <AlertBox tone="warning" className="mt-3">Readiness status could not be loaded. Member profiles remain available.</AlertBox> : null}

      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <MetricTile label="Total people" value={String(totalMembers)} detail="Server-side directory total" tone="navy" />
        <MetricTile label="ZPP members" value={String(metrics.zppCount)} detail="Family, logistics and support roles" tone="petrol" />
        <MetricTile label="TEC agents" value={String(metrics.tecCount)} detail="Contact center and enquiry roles" tone="petrol" />
        <MetricTile label="Available today" value={String(metrics.availableToday)} detail="Available in active operating period" tone="success" />
        <MetricTile label="Readiness attention" value={canReadOrgReadiness && !readinessError ? String(metrics.attention) : "—"} detail="From the readiness review" tone="warning" />
      </div>

      <Panel className="mt-3">
        <PanelBody className="grid gap-3">
          <div className="grid gap-3 xl:grid-cols-[minmax(18rem,1fr)_auto] xl:items-end">
            <Field label="Search">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input
                  aria-label="Search members"
                  className="pl-9"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search name, ID, role or function"
                />
              </div>
            </Field>

            <div className="flex flex-wrap gap-2">
              {([
                ["all", "All", metrics.activeRecords.length],
                ["ZPP", "ZPP", metrics.zppCount],
                ["TEC", "TEC", metrics.tecCount]
              ] as const).map(([value, label, count]) => (
                <button
                  key={value}
                  type="button"
                  className={clsx(
                    "focus-ring inline-flex h-10 items-center gap-2 rounded-md border px-3 text-sm font-bold transition",
                    poolFilter === value ? "border-[#145C63] bg-[#145C63] text-white" : "border-border bg-card text-foreground hover:bg-muted"
                  )}
                  aria-pressed={poolFilter === value}
                  onClick={() => setPoolFilter(value)}
                >
                  {value === "TEC" ? <PhoneCall className="h-4 w-4" /> : <UsersRound className="h-4 w-4" />}
                  <span>{label}</span>
                  <span className={clsx("rounded-full px-1.5 py-0.5 text-[11px] leading-none", poolFilter === value ? "bg-white/20 text-white" : "bg-muted text-muted-foreground")}>
                    {count}
                  </span>
                </button>
              ))}
              {canCreate ? (
                <Button type="button" icon={Plus} variant="create" onClick={openNewMember}>
                  New member
                </Button>
              ) : null}
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-8">
            <Field label="Function">
              <Select aria-label="Function filter" value={functionFilter} onChange={(event) => setFunctionFilter(event.target.value)}>
                <option value="all">All functions</option>
                {functionOptions.map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </Select>
            </Field>

            <Field label="Status">
              <Select aria-label="Status filter" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as "all" | MemberStatus)}>
                <option value="all">All status</option>
                <option value="Active">Active</option>
                <option value="Inactive">Inactive</option>
                <option value="Archived">Archived</option>
              </Select>
            </Field>

            <Field label="Training">
              <Select aria-label="Training filter" value={trainingFilter} onChange={(event) => setTrainingFilter(event.target.value)}>
                <option value="all">All training</option>
                {trainingOptions.map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </Select>
            </Field>

            <Field label="Roster">
              <Select aria-label="Roster filter" value={rosterFilter} onChange={(event) => setRosterFilter(event.target.value)}>
                <option value="all">All roster</option>
                {rosterOptions.map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </Select>
            </Field>

            <Field label="Leader">
              <Select aria-label="Leader filter" value={leaderFilter} onChange={(event) => setLeaderFilter(event.target.value)}>
                <option value="all">All leaders</option>
                {leaderOptions.map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </Select>
            </Field>

            <Field label="Readiness">
              <Select aria-label="Readiness filter" value={readinessFilter} onChange={(event) => setReadinessFilter(event.target.value as ReadinessFilter)}>
                <option value="all">All readiness</option>
                <option value="Ready">Ready</option>
                <option value="Ready with attention">Ready with attention</option>
                <option value="Not ready">Not ready</option>
                <option value="Unknown">Unable to determine</option>
                <option value="Not applicable">Not applicable</option>
              </Select>
            </Field>

            <Field label="Sort">
              <Select aria-label="Sort members" value={sortBy} onChange={(event) => setSortBy(event.target.value as SortMode)}>
                <option value="name">Name</option>
                <option value="memberId">Member ID</option>
                <option value="function">Function</option>
                <option value="status">Status</option>
              </Select>
            </Field>

            <Field label="Rows">
              <Select aria-label="Page size" value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>
                {pageSizeOptions.map((value) => (
                  <option key={value} value={value}>{value} rows</option>
                ))}
              </Select>
            </Field>
          </div>

          {hasFilters ? (
            <div className="flex justify-end">
              <Button type="button" icon={FilterX} onClick={clearFilters}>Clear filters</Button>
            </div>
          ) : null}
        </PanelBody>
      </Panel>

      <Panel className="mt-3">
        <PanelBody className="p-0">
          <div className="p-3.5">
            <SectionHeader
              title="Member Pool"
              description="Paginated directory for ZPP and TEC operational members."
              action={
                <div className="flex flex-wrap gap-2">
                  <Badge tone="neutral">{visibleFrom}-{visibleTo} of {totalMembers}</Badge>
                  <Badge tone="petrol">{pageRows.length} shown</Badge>
                </div>
              }
            />
          </div>

          <div className="border-t border-border">
            <div className="hidden grid-cols-[1.25fr_1.25fr_1.45fr_1fr_1fr_auto] bg-muted px-3 py-2 text-[11px] font-black uppercase tracking-wide text-muted-foreground xl:grid">
              <span>Member</span>
              <span>Availability</span>
              <span>Function</span>
              <span>Readiness</span>
              <span>Roster</span>
              <span className="text-right">Actions</span>
            </div>

            {loading ? (
              <div className="p-6">
                <Loading label="Loading members" />
              </div>
            ) : pageRows.length ? (
              <div>
                {pageRows.map((record) => (
                  <MemberRow key={record.id} record={record} readiness={readinessByMember.get(record.id)} canReadReadiness={canReadOrgReadiness} canEdit={canUpdate} onEdit={openEditor} />
                ))}
              </div>
            ) : (
              <div className="p-3.5">
                <EmptyState
                  title={records.length ? "No results match the selected filters" : "No members found"}
                  detail={records.length ? "Adjust search, pool or status filters to widen the list." : "Create the first member profile when the roster is ready."}
                />
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2 border-t border-border px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
              {readinessError || metrics.attention ? <AlertTriangle className="h-4 w-4 text-amber-600" /> : <CheckCircle2 className="h-4 w-4 text-emerald-700" />}
              <span>{readinessError ? "Readiness unavailable for this list" : `${metrics.attention} members need readiness attention`}</span>
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button type="button" size="sm" icon={ChevronLeft} disabled={safePage <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>
                Previous
              </Button>
              <span className="min-w-20 text-center text-sm font-bold text-muted-foreground">{safePage} / {pageCount}</span>
              <Button type="button" size="sm" icon={ChevronRight} disabled={safePage >= pageCount} onClick={() => setPage((current) => Math.min(pageCount, current + 1))}>
                Next
              </Button>
            </div>
          </div>
        </PanelBody>
      </Panel>

      {editing ? (
        <div className="fixed inset-0 z-50">
          <button type="button" className="absolute inset-0 cursor-default bg-slate-950/30" aria-label="Close member editor" onClick={() => setEditing(null)} />
          <aside role="dialog" aria-modal="true" aria-label={editing.id ? "Edit Member" : "New Member"} className="absolute inset-y-0 right-0 flex w-full max-w-2xl flex-col border-l border-border bg-card text-foreground shadow-2xl">
            <div className="flex min-h-16 items-start justify-between gap-3 border-b border-border px-4 py-3">
              <div className="min-w-0">
                <h2 className="truncate text-lg font-black text-foreground">{editing.id ? (canUpdate ? "Edit Member" : "Member profile") : "New Member"}</h2>
                <p className="mt-0.5 text-sm font-semibold text-muted-foreground">{editing.memberId || "Identifier assigned on save"}</p>
              </div>
              <Button type="button" icon={XCircle} variant="ghost" onClick={() => setEditing(null)}>
                Close
              </Button>
            </div>

            <div className="scrollbar-soft flex-1 overflow-y-auto px-4 py-4">
              <div className="rounded-md border border-border bg-muted p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-black text-foreground">{editing.displayName}</p>
                    {editing.contactEmail ? <p className="mt-1 text-xs font-bold text-muted-foreground">{editing.contactEmail}</p> : null}
                  </div>
                  <Badge tone={editing.pool === "TEC" ? "petrol" : "navy"}>{editing.pool}</Badge>
                </div>
              </div>

              {editorError ? <AlertBox tone="danger" className="mt-3">{editorError}</AlertBox> : null}

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <Field label="First name" required>
                  <Input value={editing.firstName} disabled={!editorCanSave || saving} onChange={(event) => updateEditing({ firstName: event.target.value, displayName: `${event.target.value} ${editing.lastName}`.trim() || editing.displayName })} />
                </Field>
                <Field label="Last name" required>
                  <Input value={editing.lastName} disabled={!editorCanSave || saving} onChange={(event) => updateEditing({ lastName: event.target.value, displayName: `${editing.firstName} ${event.target.value}`.trim() || editing.displayName })} />
                </Field>
                <Field label="Email" required>
                  <Input type="email" value={editing.contactEmail ?? ""} disabled={!editorCanSave || saving} onChange={(event) => updateEditing({ contactEmail: event.target.value })} />
                </Field>
                <Field label="Phone" required>
                  <Input value={editing.phone ?? ""} disabled={!editorCanSave || saving} onChange={(event) => updateEditing({ phone: event.target.value })} />
                </Field>
              </div>

              <div className="mt-5 border-t border-border pt-4">
                <h3 className="text-sm font-black uppercase tracking-wide text-[#145C63] dark:text-[#7ed7dc]">Operational profile</h3>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <Field label="Pool">
                    <Select value={editing.pool} disabled={!editorCanSave || saving} onChange={(event) => updateEditing({ pool: event.target.value as Pool })}>
                      <option value="ZPP">ZPP</option>
                      <option value="TEC">TEC</option>
                    </Select>
                  </Field>
                  <Field label="Function">
                    <Select value={editing.assignedFunction} disabled={!editorCanSave || saving} onChange={(event) => updateEditing({ assignedFunction: event.target.value })}>
                      {functionOptions.map((value) => (
                        <option key={value} value={value}>{value}</option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Role">
                    <Input value={editing.role} disabled={!editorCanSave || saving} onChange={(event) => updateEditing({ role: event.target.value })} />
                  </Field>
                  <Field label="Leader (Rostering projection)">
                    <Select value={editing.assignedLeader ?? ""} disabled>
                      {leaderOptions.map((value) => (
                        <option key={value} value={value}>{value}</option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Availability (derived)">
                    <Select value={editing.availability} disabled>
                      {availabilityOptions.map((value) => (
                        <option key={value} value={value}>{value}</option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Languages">
                    <Input value={editing.languages.join(", ")} disabled={!editorCanSave || saving} onChange={(event) => updateEditing({ languages: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} />
                  </Field>
                  <Field label="Training status (derived)">
                    <Select value={editing.trainingStatus} disabled>
                      {trainingOptions.map((value) => (
                        <option key={value} value={value}>{value}</option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Roster status (derived)">
                    <Select value={editing.rosterStatus} disabled>
                      {rosterOptions.map((value) => (
                        <option key={value} value={value}>{value}</option>
                      ))}
                    </Select>
                  </Field>
                </div>
              </div>
            </div>

            <div className="grid gap-2 border-t border-border bg-card px-4 py-3 sm:grid-cols-[auto_1fr]">
              {editing.id && canArchive ? (
                <Button type="button" icon={Archive} variant="secondary" disabled={saving} onClick={archiveEditing}>
                  Archive
                </Button>
              ) : <span />}
              {editorCanSave ? (
                <Button type="button" icon={Save} variant="primary" className="w-full" disabled={saving} onClick={saveEditing}>
                  {saving ? "Saving" : editing.id ? "Save changes" : "Create member"}
                </Button>
              ) : null}
            </div>
          </aside>
        </div>
      ) : null}
    </>
  );
}
