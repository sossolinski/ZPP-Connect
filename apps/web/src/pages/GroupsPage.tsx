import { useCallback, useEffect, useMemo, useState } from "react";
import { clsx } from "clsx";
import { Archive, CalendarDays, FilePlus2, FilterX, Pencil, Save, Search, UserMinus, UserPlus, XCircle } from "lucide-react";
import { Badge, EmptyState, PageIntro, Panel, PanelBody, SectionHeader, StatusBadge } from "../components/portal";
import { AlertBox, Button, Field, Input, Loading, Select, Textarea } from "../components/ui";
import { api } from "../lib/api";
import { useApp } from "../lib/app-context";
import { isSessionWriteContextCurrent } from "../lib/session-safety";

type MemberPool = "ZPP" | "TEC";
type GroupPool = MemberPool | "Mixed";
type GroupStatus = "Active" | "Standby" | "Draft" | "Archived";
type PoolFilter = "all" | GroupPool;
type StatusFilter = "all" | GroupStatus;
type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger" | "gold" | "petrol" | "navy";

type MemberProfile = {
  id: string;
  memberId: string;
  displayName: string;
  pool: MemberPool;
  contactEmail?: string | null;
  phone?: string | null;
  role: string;
  availability: string;
  trainingStatus: string;
  assignedFunction: string;
  rosterStatus: string;
  assignedLeader?: string | null;
};

type GroupRecord = {
  id?: string;
  operationalId?: string;
  sessionId?: string | null;
  name: string;
  pool: GroupPool;
  functionName: string;
  status: GroupStatus;
  leaderId: string;
  leaderName: string;
  memberIds: string[];
  memberCount?: number;
  rosterShiftIds: string[];
  rosterLinkCount?: number;
  notes?: string | null;
  version: number;
};
type ReadinessStatus = "Ready" | "Ready with attention" | "Not ready" | "Unknown" | "Not applicable";
type GroupReadiness = {
  group?: {
    id?: string;
  };
  calculatedAt?: string;
  summary?: {
    totalMembers?: number;
    byStatus?: Partial<Record<ReadinessStatus, number>>;
    issueCounts?: Record<string, number>;
  };
  members?: Array<{
    member?: {
      id?: string;
      memberId?: string;
      displayName?: string;
    };
    overallStatus?: ReadinessStatus;
    primaryIssue?: {
      title?: string;
      category?: string;
    } | null;
  }>;
};

const groupPools: GroupPool[] = ["ZPP", "TEC", "Mixed"];
const groupStatuses: GroupStatus[] = ["Active", "Standby", "Draft"];
const defaultFunctions = ["Family Assistance Team", "Telephone Enquiry Center", "Welfare Support", "Member Rostering", "Documentation Support", "Logistics Support", "Airport Reception Support"];

function compareText(left: string, right: string) {
  return left.localeCompare(right, undefined, { sensitivity: "base", numeric: true });
}

function normalizeIds(value: unknown) {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function normalizeMember(input: Record<string, any>): MemberProfile {
  return {
    id: String(input.id ?? ""),
    memberId: String(input.memberId ?? input.volunteerId ?? ""),
    displayName: String(input.displayName ?? `${input.firstName ?? ""} ${input.lastName ?? ""}`).trim(),
    pool: input.pool === "TEC" ? "TEC" : "ZPP",
    contactEmail: input.contactEmail ?? "",
    phone: input.phone ?? "",
    role: String(input.role ?? "Member"),
    availability: String(input.availability ?? "Availability not set"),
    trainingStatus: String(input.trainingStatus ?? "Pending"),
    assignedFunction: String(input.assignedFunction ?? "Unassigned"),
    rosterStatus: String(input.rosterStatus ?? "Unassigned"),
    assignedLeader: input.assignedLeader ?? ""
  };
}

function normalizeGroup(input: Record<string, any>): GroupRecord {
  return {
    id: input.id ? String(input.id) : undefined,
    operationalId: input.operationalId ? String(input.operationalId) : undefined,
    sessionId: input.sessionId ? String(input.sessionId) : null,
    name: String(input.name ?? ""),
    pool: input.pool === "TEC" || input.pool === "Mixed" ? input.pool : "ZPP",
    functionName: String(input.functionName ?? "Family Assistance Team"),
    status: ["Active", "Standby", "Draft", "Archived"].includes(String(input.status)) ? input.status : "Draft",
    leaderId: String(input.leaderId ?? ""),
    leaderName: String(input.leaderName ?? ""),
    memberIds: normalizeIds(input.memberIds),
    memberCount: Number(input.memberCount ?? 0),
    rosterShiftIds: normalizeIds(input.rosterShiftIds),
    rosterLinkCount: Number(input.rosterLinkCount ?? 0),
    notes: String(input.notes ?? ""),
    version: Number(input.version ?? 1)
  };
}

function emptyGroup(sessionId?: string, leader?: MemberProfile, nextNumber = 1): GroupRecord {
  return {
    sessionId,
    operationalId: `GRP-2026-${String(nextNumber).padStart(6, "0")}`,
    name: "",
    pool: "ZPP",
    functionName: "Family Assistance Team",
    status: "Draft",
    leaderId: leader?.id ?? "",
    leaderName: leader?.displayName ?? "",
    memberIds: leader ? [leader.id] : [],
    rosterShiftIds: [],
    notes: "",
    version: 1
  };
}

function groupKey(group: GroupRecord) {
  return group.id ?? group.operationalId ?? group.name;
}

function groupMatches(group: GroupRecord, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [group.operationalId, group.name, group.pool, group.functionName, group.status, group.leaderName, group.notes, ...group.memberIds, ...group.rosterShiftIds]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle));
}

function statusTone(status: GroupStatus): BadgeTone {
  if (status === "Active") return "success";
  if (status === "Standby") return "petrol";
  if (status === "Draft") return "warning";
  return "neutral";
}

function poolTone(pool: GroupPool): BadgeTone {
  if (pool === "TEC") return "petrol";
  if (pool === "Mixed") return "gold";
  return "navy";
}

function functionMatches(recordFunction: string, groupFunction: string) {
  const record = recordFunction.toLowerCase();
  const group = groupFunction.toLowerCase();
  const compactRecord = record.replace(/ team| center| centre| support| cell/g, "").trim();
  const compactGroup = group.replace(/ team| center| centre| support| cell/g, "").trim();
  return record === group || record.includes(compactGroup) || group.includes(compactRecord);
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

function normalizeGroupReadiness(input: Record<string, any>): GroupReadiness {
  const byStatus = input.summary?.byStatus ?? {};
  return {
    group: input.group,
    calculatedAt: typeof input.calculatedAt === "string" ? input.calculatedAt : undefined,
    summary: {
      totalMembers: Number(input.summary?.totalMembers ?? 0),
      byStatus: {
        Ready: Number(byStatus.Ready ?? 0),
        "Ready with attention": Number(byStatus["Ready with attention"] ?? 0),
        "Not ready": Number(byStatus["Not ready"] ?? 0),
        Unknown: Number(byStatus.Unknown ?? 0),
        "Not applicable": Number(byStatus["Not applicable"] ?? 0)
      },
      issueCounts: input.summary?.issueCounts && typeof input.summary.issueCounts === "object" ? input.summary.issueCounts : {}
    },
    members: Array.isArray(input.members)
      ? input.members.map((member: any) => ({
          member: member.member,
          overallStatus: normalizeReadinessStatus(member.overallStatus),
          primaryIssue: member.primaryIssue ?? null
        }))
      : []
  };
}

function readinessForMember(groupReadiness: GroupReadiness | undefined, memberId: string) {
  return groupReadiness?.members?.find((item) => item.member?.id === memberId);
}

function groupStatusRank(status: GroupStatus) {
  return { Active: 0, Standby: 1, Draft: 2, Archived: 3 }[status];
}

function ReadinessDistribution({
  readiness,
  canReadReadiness,
  compact = false
}: {
  readiness?: GroupReadiness;
  canReadReadiness: boolean;
  compact?: boolean;
}) {
  if (!canReadReadiness) return <Badge tone="neutral">Readiness not shown</Badge>;
  if (!readiness?.summary?.byStatus) return <Badge tone="info">Readiness unavailable</Badge>;
  const statuses: ReadinessStatus[] = ["Ready", "Ready with attention", "Not ready", "Unknown", "Not applicable"];
  const items = statuses
    .map((status) => ({ status, count: Number(readiness.summary?.byStatus?.[status] ?? 0) }))
    .filter((item) => item.count > 0);
  if (!items.length) return <Badge tone="neutral">No members assessed</Badge>;
  return (
    <>
      {items.map(({ status, count }) => (
        <Badge key={status} tone={readinessTone(status)}>
          {compact ? `${count} ${readinessLabel(status)}` : `${readinessLabel(status)} ${count}`}
        </Badge>
      ))}
    </>
  );
}

function MemberLine({
  member,
  readiness,
  onRemove,
  readOnly = false,
  busy = false
}: {
  member: MemberProfile;
  readiness?: NonNullable<GroupReadiness["members"]>[number];
  onRemove: (id: string) => void;
  readOnly?: boolean;
  busy?: boolean;
}) {
  const status = readiness?.overallStatus ?? "Unknown";
  return (
    <div className="grid gap-2 rounded-md border border-border bg-muted p-2 text-foreground sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <p className="truncate text-sm font-black text-foreground">{member.displayName}</p>
          <Badge tone={member.pool === "TEC" ? "petrol" : "navy"}>{member.pool}</Badge>
          <Badge tone={readinessTone(status)}>{readinessLabel(status)}</Badge>
        </div>
        <p className="mt-1 truncate text-xs font-semibold text-muted-foreground">
          {member.memberId} · {member.assignedFunction} · {member.availability}
        </p>
        <p className="mt-1 line-clamp-2 text-xs font-semibold text-muted-foreground">
          {readiness?.primaryIssue?.title ?? "No immediate blocker"}
        </p>
      </div>
      {!readOnly ? (
        <Button type="button" size="sm" icon={UserMinus} variant="ghost" disabled={busy} onClick={() => onRemove(member.id)}>
          Remove
        </Button>
      ) : null}
    </div>
  );
}

function CandidateLine({ member, onAdd, busy = false }: { member: MemberProfile; onAdd: (id: string) => void; busy?: boolean }) {
  return (
    <div className="grid gap-2 rounded-md border border-border bg-card p-2 text-foreground sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <p className="truncate text-sm font-black text-foreground">{member.displayName}</p>
          <Badge tone={member.pool === "TEC" ? "petrol" : "navy"}>{member.memberId}</Badge>
        </div>
        <p className="mt-1 truncate text-xs font-semibold text-muted-foreground">
          {member.assignedFunction} · {member.trainingStatus} · {member.rosterStatus}
        </p>
      </div>
      <Button type="button" size="sm" icon={UserPlus} aria-label={`Add ${member.memberId}`} disabled={busy} onClick={() => onAdd(member.id)}>
        Add
      </Button>
    </div>
  );
}

export function GroupsPage() {
  const { activeSession, activeSessionWritable, can, verifyActiveSessionWrite } = useApp();
  const [records, setRecords] = useState<MemberProfile[]>([]);
  const [groups, setGroups] = useState<GroupRecord[]>([]);
  const [groupReadinessRows, setGroupReadinessRows] = useState<GroupReadiness[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [readinessError, setReadinessError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [poolFilter, setPoolFilter] = useState<PoolFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [functionFilter, setFunctionFilter] = useState("all");
  const [memberQuery, setMemberQuery] = useState("");
  const [memberSearchResults, setMemberSearchResults] = useState<MemberProfile[]>([]);
  const [editing, setEditing] = useState<GroupRecord | null>(null);
  const [saving, setSaving] = useState(false);
  const [membershipBusy, setMembershipBusy] = useState(false);
  const [editorError, setEditorError] = useState("");

  const canCreate = activeSessionWritable && (can("group:create") || can("admin:manage"));
  const canUpdate = activeSessionWritable && (can("group:update") || can("admin:manage"));
  const canArchive = activeSessionWritable && (can("group:archive") || can("admin:manage"));
  const canManageMembership = activeSessionWritable && (can("group:membership:manage") || can("admin:manage"));
  const canReadOrgReadiness = can("readiness:read-all") || can("readiness:read-group") || can("admin:manage");
  const canSaveCurrent = editing?.id ? canUpdate : canCreate;

  const memberById = useMemo(() => new Map(records.map((record) => [record.id, record])), [records]);
  const groupReadinessById = useMemo(() => {
    const entries: Array<[string, GroupReadiness]> = [];
    for (const row of groupReadinessRows) {
      const id = String(row.group?.id ?? "");
      if (id) entries.push([id, row]);
    }
    return new Map(entries);
  }, [groupReadinessRows]);
  const functionOptions = useMemo(
    () => Array.from(new Set([...defaultFunctions, ...records.map((record) => record.assignedFunction), ...groups.map((group) => group.functionName)].filter(Boolean))).sort(compareText),
    [groups, records]
  );
  const leaderCandidates = useMemo(() => {
    return records
      .filter((record) => record.rosterStatus !== "Unavailable")
      .sort((left, right) => compareText(left.displayName, right.displayName));
  }, [records]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError("");
    setReadinessError("");
    try {
      const [membersResult, groupsResult, readinessResult] = await Promise.all([
        api.memberProfilesPage({ limit: 100, offset: 0, sortBy: "displayName", sortDirection: "asc" }),
        api.groupsPage({
          sessionId: activeSession?.id,
          search: query || undefined,
          pool: poolFilter === "all" ? undefined : poolFilter,
          status: statusFilter === "all" ? undefined : statusFilter,
          functionName: functionFilter === "all" ? undefined : functionFilter,
          limit: 100,
          offset: 0,
          sortBy: "name",
          sortDirection: "asc"
        }),
        canReadOrgReadiness
          ? api.readinessGroups(activeSession?.id ? { sessionId: activeSession.id } : undefined, { pageLimit: 200 }).catch((err) => {
              setReadinessError(err instanceof Error ? err.message : "Unable to load readiness.");
              return null;
            })
          : Promise.resolve(null)
      ]);
      setRecords(membersResult.data.map(normalizeMember));
      setGroups(groupsResult.data.map(normalizeGroup));
      setGroupReadinessRows(readinessResult?.data.map(normalizeGroupReadiness) ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load groups.");
      setRecords([]);
      setGroups([]);
      setGroupReadinessRows([]);
    } finally {
      setLoading(false);
    }
  }, [activeSession?.id, canReadOrgReadiness, functionFilter, poolFilter, query, statusFilter]);

  useEffect(() => {
    void loadData();
    setEditing(null);
    setMemberQuery("");
    setEditorError("");
  }, [loadData]);

  const filteredGroups = useMemo(() => {
    return groups
      .filter((group) => {
        if (!groupMatches(group, query)) return false;
        if (poolFilter !== "all" && group.pool !== poolFilter) return false;
        if (statusFilter !== "all" && group.status !== statusFilter) return false;
        if (functionFilter !== "all" && group.functionName !== functionFilter) return false;
        return true;
      })
      .sort((left, right) => groupStatusRank(left.status) - groupStatusRank(right.status) || compareText(left.name, right.name));
  }, [functionFilter, groups, poolFilter, query, statusFilter]);

  const metrics = useMemo(() => {
    const assignedMemberIds = new Set(groups.flatMap((group) => group.memberIds));
    const linkedShiftIds = new Set(groups.flatMap((group) => group.rosterShiftIds));
    return {
      totalGroups: groups.length,
      activeGroups: groups.filter((group) => group.status === "Active").length,
      assignedMembers: assignedMemberIds.size,
      unassignedMembers: Math.max(0, records.length - assignedMemberIds.size),
      rosterLinks: linkedShiftIds.size
    };
  }, [groups, records.length]);

  const selectedMembers = useMemo(
    () => (editing ? editing.memberIds.map((id) => memberById.get(id)).filter((member): member is MemberProfile => Boolean(member)) : []),
    [editing, memberById]
  );
  const selectedGroupReadiness = editing?.id ? groupReadinessById.get(editing.id) : undefined;

  const candidateMembers = useMemo(() => {
    if (!editing) return [];
    const selectedIds = new Set(editing.memberIds);
    const needle = memberQuery.trim().toLowerCase();
    return (needle ? memberSearchResults : records)
      .filter((record) => {
        if (selectedIds.has(record.id)) return false;
        if (editing.pool !== "Mixed" && record.pool !== editing.pool) return false;
        if (needle) {
          const haystack = [record.memberId, record.displayName, record.contactEmail ?? "", record.phone ?? "", record.assignedFunction, record.role, record.assignedLeader ?? ""].join(" ").toLowerCase();
          if (!haystack.includes(needle)) return false;
        }
        return true;
      })
      .sort((left, right) => {
        const leftMatch = functionMatches(left.assignedFunction, editing.functionName) ? 0 : 1;
        const rightMatch = functionMatches(right.assignedFunction, editing.functionName) ? 0 : 1;
        return leftMatch - rightMatch || compareText(left.displayName, right.displayName);
      })
      .slice(0, 10);
  }, [editing, memberQuery, memberSearchResults, records]);

  useEffect(() => {
    if (!editing || !memberQuery.trim()) {
      setMemberSearchResults([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void api.memberProfilesPage({
        search: memberQuery.trim(),
        pool: editing.pool === "Mixed" ? undefined : editing.pool,
        limit: 50,
        offset: 0,
        sortBy: "displayName",
        sortDirection: "asc"
      }).then((result) => {
        if (!cancelled) setMemberSearchResults(result.data.map(normalizeMember));
      }).catch((err) => {
        if (!cancelled) setEditorError(err instanceof Error ? err.message : "Unable to search members.");
      });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [editing?.id, editing?.pool, memberQuery]);

  function replaceGroup(group: Record<string, any>) {
    const normalized = normalizeGroup(group);
    setGroups((current) => {
      const index = current.findIndex((item) => groupKey(item) === groupKey(normalized));
      if (index < 0) return [normalized, ...current];
      return current.map((item, itemIndex) => (itemIndex === index ? normalized : item));
    });
    setEditing(normalized);
  }

  async function refreshGroupReadiness(groupId?: string) {
    if (!groupId || !canReadOrgReadiness) return;
    try {
      const next = normalizeGroupReadiness(await api.readinessGroup(groupId));
      setGroupReadinessRows((current) => {
        const index = current.findIndex((item) => item.group?.id === groupId);
        if (index < 0) return [next, ...current];
        return current.map((item, itemIndex) => (itemIndex === index ? next : item));
      });
      setReadinessError("");
    } catch (err) {
      setReadinessError(err instanceof Error ? err.message : "Unable to load readiness.");
    }
  }

  function clearFilters() {
    setQuery("");
    setPoolFilter("all");
    setStatusFilter("all");
    setFunctionFilter("all");
  }

  function openNewGroup() {
    if (!canCreate) return;
    const leader = leaderCandidates.find((candidate) => candidate.pool === "ZPP") ?? leaderCandidates[0];
    setEditing(emptyGroup(activeSession?.id, leader, groups.length + 1));
    setMemberQuery("");
    setMemberSearchResults([]);
    setEditorError("");
    setNotice("");
  }

  function openGroup(group: GroupRecord) {
    setEditing({ ...normalizeGroup(group) });
    setMemberQuery("");
    setMemberSearchResults([]);
    setEditorError("");
    setNotice("");
    if (!group.id) return;
    void api.groupMembersPage(group.id, { sessionId: group.sessionId ?? activeSession?.id, limit: 200, offset: 0 }).then((result) => {
      const hydrated = result.data.map(normalizeMember);
      setRecords((current) => {
        const byId = new Map(current.map((record) => [record.id, record]));
        hydrated.forEach((record) => byId.set(record.id, record));
        return [...byId.values()];
      });
    }).catch((err) => setEditorError(err instanceof Error ? err.message : "Unable to load group members."));
  }

  function updateEditing(patch: Partial<GroupRecord>) {
    setEditing((current) => (current ? { ...current, ...patch } : current));
  }

  async function ensureWriteAllowed(group: GroupRecord) {
    if (!isSessionWriteContextCurrent(activeSession, group.sessionId) || !(await verifyActiveSessionWrite(group.sessionId))) {
      setEditorError("The session changed or is no longer writable. Changes were not applied.");
      return false;
    }
    return true;
  }

  async function addMember(id: string) {
    if (!editing || editing.memberIds.includes(id)) return;
    if (!editing.id) {
      updateEditing({ memberIds: [...editing.memberIds, id] });
      return;
    }
    if (!canManageMembership || !(await ensureWriteAllowed(editing))) return;
    setMembershipBusy(true);
    setEditorError("");
    try {
      const group = await api.addGroupMember(editing.id, {
        sessionId: editing.sessionId ?? activeSession?.id,
        memberProfileId: id,
        expectedVersion: editing.version,
        role: "Member"
      });
      replaceGroup(group);
      await refreshGroupReadiness(group.id);
      setNotice("Member added to group");
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : "Unable to add member.");
    } finally {
      setMembershipBusy(false);
    }
  }

  async function removeMember(id: string) {
    if (!editing) return;
    if (!editing.id) {
      const nextMembers = editing.memberIds.filter((memberId) => memberId !== id);
      const fallbackLeader = nextMembers.map((memberId) => memberById.get(memberId)).find(Boolean);
      updateEditing({
        memberIds: nextMembers,
        leaderId: editing.leaderId === id ? fallbackLeader?.id ?? "" : editing.leaderId,
        leaderName: editing.leaderId === id ? fallbackLeader?.displayName ?? "" : editing.leaderName
      });
      return;
    }
    if (!canManageMembership || !(await ensureWriteAllowed(editing))) return;
    setMembershipBusy(true);
    setEditorError("");
    try {
      const group = await api.removeGroupMember(editing.id, id, {
        sessionId: editing.sessionId ?? activeSession?.id,
        expectedVersion: editing.version
      });
      replaceGroup(group);
      await refreshGroupReadiness(group.id);
      setNotice("Member removed from group");
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : "Unable to remove member.");
    } finally {
      setMembershipBusy(false);
    }
  }

  async function saveGroup() {
    if (!editing || saving) return;
    if (!canSaveCurrent || !(await ensureWriteAllowed(editing))) return;
    const leader = memberById.get(editing.leaderId);
    const name = editing.name.trim();
    if (!name) {
      setEditorError("Group name is required.");
      return;
    }
    if (!leader) {
      setEditorError("Select a leader from the member directory.");
      return;
    }

    const memberIds = Array.from(new Set([leader.id, ...editing.memberIds]));
    const createPayload = {
      sessionId: editing.sessionId ?? activeSession?.id,
      name,
      pool: editing.pool,
      functionName: editing.functionName,
      status: editing.status,
      leaderId: leader.id,
      memberIds,
      notes: editing.notes?.trim() ?? ""
    };

    setSaving(true);
    setEditorError("");
    try {
      const original = editing.id ? groups.find((group) => group.id === editing.id) : undefined;
      let saved = editing.id
        ? await api.updateGroup(editing.id, {
            sessionId: editing.sessionId ?? activeSession?.id,
            expectedVersion: editing.version,
            name,
            pool: editing.pool,
            functionName: editing.functionName,
            status: editing.status,
            notes: editing.notes?.trim() ?? ""
          })
        : await api.createGroup(createPayload);
      if (editing.id && original?.leaderId !== leader.id) {
        saved = await api.setGroupLeader(editing.id, {
          sessionId: editing.sessionId ?? activeSession?.id,
          expectedVersion: Number(saved.version),
          memberProfileId: leader.id
        });
      }
      replaceGroup(saved);
      await refreshGroupReadiness(saved.id);
      setEditing(null);
      setNotice(editing.id ? "Group updated" : "Group created");
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : "Unable to save group.");
    } finally {
      setSaving(false);
    }
  }

  async function archiveGroup() {
    if (!editing?.id || !canArchive || !(await ensureWriteAllowed(editing))) return;
    setSaving(true);
    setEditorError("");
    try {
      const archived = await api.archiveGroup(editing.id, {
        sessionId: editing.sessionId ?? activeSession?.id,
        expectedVersion: editing.version
      });
      const normalized = normalizeGroup(archived);
      setGroups((current) => current.filter((group) => groupKey(group) !== groupKey(normalized)));
      setGroupReadinessRows((current) => current.filter((item) => item.group?.id !== normalized.id));
      setEditing(null);
      setNotice("Group archived");
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : "Unable to archive group.");
    } finally {
      setSaving(false);
    }
  }

  const hasFilters = query.trim() || poolFilter !== "all" || statusFilter !== "all" || functionFilter !== "all";

  return (
    <>
      <PageIntro eyebrow="People groups" title="Groups" description="Create response groups, assign members and keep leaders clear." />

      {notice ? <AlertBox tone="success" className="mt-3">{notice}</AlertBox> : null}
      {error ? <AlertBox tone="danger" className="mt-3">Unable to load groups. {error}</AlertBox> : null}
      {readinessError ? <AlertBox tone="warning" className="mt-3">Readiness status could not be loaded. Groups remain available.</AlertBox> : null}

      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <section className="rounded-md border border-border bg-card p-3 text-foreground shadow-panel">
          <p className="text-xs font-bold text-muted-foreground">Groups</p>
          <p className="mt-1 text-2xl font-black leading-none text-foreground">{metrics.totalGroups}</p>
          <p className="mt-1 text-xs font-semibold text-muted-foreground">{metrics.activeGroups} active</p>
        </section>
        <section className="rounded-md border border-[#145C63]/25 bg-[#145C63]/10 p-3 text-foreground shadow-panel">
          <p className="text-xs font-bold text-muted-foreground">Assigned people</p>
          <p className="mt-1 text-2xl font-black leading-none text-foreground">{metrics.assignedMembers}</p>
          <p className="mt-1 text-xs font-semibold text-muted-foreground">unique members in groups</p>
        </section>
        <section className="rounded-md border border-amber-200 bg-amber-50/60 p-3 text-foreground shadow-panel dark:border-amber-400/25 dark:bg-amber-500/10">
          <p className="text-xs font-bold text-muted-foreground">Unassigned pool</p>
          <p className="mt-1 text-2xl font-black leading-none text-foreground">{metrics.unassignedMembers}</p>
          <p className="mt-1 text-xs font-semibold text-muted-foreground">available for planning</p>
        </section>
        <section className="rounded-md border border-border bg-card p-3 text-foreground shadow-panel">
          <p className="text-xs font-bold text-muted-foreground">Roster links</p>
          <p className="mt-1 text-2xl font-black leading-none text-foreground">{metrics.rosterLinks}</p>
          <p className="mt-1 text-xs font-semibold text-muted-foreground">linked roster shifts</p>
        </section>
        <section className="rounded-md border border-border bg-card p-3 text-foreground shadow-panel">
          <p className="text-xs font-bold text-muted-foreground">Directory scale</p>
          <p className="mt-1 text-2xl font-black leading-none text-foreground">{records.length}</p>
          <p className="mt-1 text-xs font-semibold text-muted-foreground">ZPP and TEC records</p>
        </section>
      </div>

      <Panel className="mt-3">
        <PanelBody className="grid gap-3">
          <div className="grid gap-2 xl:grid-cols-[minmax(18rem,1fr)_auto] xl:items-end">
            <Field label="Search">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input aria-label="Search groups" className="pl-9" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search group, leader, member ID or roster shift" />
              </div>
            </Field>
            <div className="flex flex-wrap items-center justify-start gap-2 xl:justify-end">
              {canCreate ? (
                <Button type="button" icon={FilePlus2} variant="create" onClick={openNewGroup}>
                  New group
                </Button>
              ) : null}
              <Badge tone="navy">{filteredGroups.length} shown</Badge>
              <Badge tone="petrol">{activeSession?.operationalId ?? "No session"}</Badge>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[0.8fr_0.9fr_1.3fr_auto]">
            <Field label="Pool">
              <Select aria-label="Pool filter" value={poolFilter} onChange={(event) => setPoolFilter(event.target.value as PoolFilter)}>
                <option value="all">All pools</option>
                {groupPools.map((pool) => (
                  <option key={pool} value={pool}>{pool}</option>
                ))}
              </Select>
            </Field>
            <Field label="Status">
              <Select aria-label="Status filter" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
                <option value="all">All status</option>
                {groupStatuses.map((status) => (
                  <option key={status} value={status}>{status}</option>
                ))}
              </Select>
            </Field>
            <Field label="Function">
              <Select aria-label="Function filter" value={functionFilter} onChange={(event) => setFunctionFilter(event.target.value)}>
                <option value="all">All functions</option>
                {functionOptions.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </Select>
            </Field>
            <div className="flex items-end">
              <Button type="button" icon={FilterX} disabled={!hasFilters} onClick={clearFilters}>
                Clear
              </Button>
            </div>
          </div>
        </PanelBody>
      </Panel>

      <Panel className="mt-3">
        <PanelBody className="p-0">
          <div className="border-b border-border px-3.5 py-3">
            <SectionHeader
              title="Operational Groups"
              description="Compact group register with member coverage, readiness and linked roster shifts."
              action={loading ? <Badge tone="neutral">Loading</Badge> : <Badge tone="petrol">{filteredGroups.length} groups</Badge>}
            />
          </div>

          {loading ? (
            <div className="p-6">
              <Loading label="Loading groups" />
            </div>
          ) : filteredGroups.length ? (
            <div className="divide-y divide-border">
              {filteredGroups.map((group) => {
                const members = group.memberIds.map((id) => memberById.get(id)).filter((member): member is MemberProfile => Boolean(member));
                const readiness = group.id ? groupReadinessById.get(group.id) : undefined;
                return (
                  <article key={groupKey(group)} className="grid gap-3 px-3.5 py-3 transition hover:bg-muted xl:grid-cols-[minmax(18rem,1.25fr)_minmax(14rem,0.9fr)_minmax(12rem,0.75fr)_auto] xl:items-center">
                    <div className="min-w-0">
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <Badge tone={poolTone(group.pool)}>{group.pool}</Badge>
                        <Badge tone={statusTone(group.status)}>{group.status}</Badge>
                        <span className="text-xs font-bold text-muted-foreground">{group.operationalId ?? "Unsaved"}</span>
                      </div>
                      <h2 className="mt-1 truncate text-base font-black text-foreground">{group.name}</h2>
                      <p className="mt-1 truncate text-xs font-semibold text-muted-foreground">{group.functionName}</p>
                    </div>

                    <div className="min-w-0">
                      <p className="text-[10px] font-black uppercase tracking-wide text-muted-foreground">Leader</p>
                      <p className="truncate text-sm font-bold text-foreground">{group.leaderName || "No leader"}</p>
                      <p className="mt-1 truncate text-xs font-semibold text-muted-foreground">{memberById.get(group.leaderId)?.memberId ?? group.leaderId}</p>
                    </div>

                    <div className="min-w-0">
                      <div className="flex flex-wrap gap-1.5">
                        <Badge tone="neutral">{group.memberCount ?? members.length} members</Badge>
                        <ReadinessDistribution readiness={readiness} canReadReadiness={canReadOrgReadiness} compact />
                      </div>
                      <p className="mt-1 truncate text-xs font-semibold text-muted-foreground">
                        {group.rosterShiftIds.length ? `${group.rosterShiftIds.length} roster link${group.rosterShiftIds.length === 1 ? "" : "s"}` : "No roster links"}
                      </p>
                    </div>

                    <div className="flex justify-start xl:justify-end">
                      <Button type="button" size="sm" icon={canUpdate ? Pencil : Search} aria-label={`${canUpdate ? "Edit" : "View"} ${group.name}`} onClick={() => openGroup(group)}>
                        {canUpdate ? "Edit" : "View"}
                      </Button>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="p-3.5">
              <EmptyState title={groups.length ? "No results match the selected filters" : "No groups have been created"} detail={groups.length ? "Clear filters or search for another group." : "Create the first operational group when staffing is ready."} />
            </div>
          )}
        </PanelBody>
      </Panel>

      {editing ? (
        <>
          <button type="button" className="fixed inset-0 z-40 cursor-default bg-slate-950/25" aria-label="Close group editor" onClick={() => (!saving && !membershipBusy ? setEditing(null) : undefined)} />
          <aside role="dialog" aria-modal="true" aria-label={editing.id ? "Edit Group" : "New Group"} className="fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col border-l border-border bg-card text-foreground shadow-2xl">
            <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
              <div className="min-w-0">
                <h2 className="truncate text-lg font-black text-foreground">{editing.id ? (canUpdate ? "Edit Group" : "Group details") : "New Group"}</h2>
                <p className="mt-1 truncate text-sm font-semibold text-muted-foreground">{editing.operationalId ?? "Identifier assigned on save"}</p>
              </div>
              <Button type="button" icon={XCircle} variant="ghost" disabled={saving || membershipBusy} onClick={() => setEditing(null)}>
                Close
              </Button>
            </div>

            <form
              className="scrollbar-soft flex-1 overflow-y-auto px-5 py-4"
              onSubmit={(event) => {
                event.preventDefault();
                void saveGroup();
              }}
            >
              <div className="grid gap-4">
                <div className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-border bg-muted px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-black text-foreground">{editing.operationalId ?? "New group"}</p>
                    <p className="mt-0.5 truncate text-xs font-semibold text-muted-foreground">{activeSession?.operationalId ?? editing.sessionId ?? "No active session"}</p>
                  </div>
                  <StatusBadge value={editing.status} />
                </div>

                {editorError ? <AlertBox tone="danger">{editorError}</AlertBox> : null}

                <Field label="Group name" required>
                  <Input value={editing.name} disabled={!canSaveCurrent || saving} onChange={(event) => updateEditing({ name: event.target.value })} placeholder="e.g. Welfare Support Evening" />
                </Field>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Pool">
                    <Select value={editing.pool} disabled={!canSaveCurrent || saving} onChange={(event) => updateEditing({ pool: event.target.value as GroupPool })}>
                      {groupPools.map((pool) => (
                        <option key={pool} value={pool}>{pool}</option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Status">
                    <Select value={editing.status === "Archived" ? "Draft" : editing.status} disabled={!canSaveCurrent || saving} onChange={(event) => updateEditing({ status: event.target.value as GroupStatus })}>
                      {groupStatuses.map((status) => (
                        <option key={status} value={status}>{status}</option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Function">
                    <Select value={editing.functionName} disabled={!canSaveCurrent || saving} onChange={(event) => updateEditing({ functionName: event.target.value })}>
                      {functionOptions.map((option) => (
                        <option key={option} value={option}>{option}</option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Leader">
                    <Select
                      value={editing.leaderId}
                      disabled={!canSaveCurrent || saving}
                      onChange={(event) => {
                        const leader = memberById.get(event.target.value);
                        updateEditing({ leaderId: event.target.value, leaderName: leader?.displayName ?? "" });
                      }}
                    >
                      <option value="">Select leader</option>
                      {leaderCandidates.map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          {candidate.displayName} ({candidate.memberId})
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>

                <section className="rounded-md border border-border p-3">
                  <SectionHeader
                    title="Members"
                    description={editing.id ? "Add or remove members as staffing changes." : "Choose members before creating this group."}
                    action={
                      <div className="flex flex-wrap gap-1.5">
                        <Badge tone="neutral">{selectedMembers.length} selected</Badge>
                        <ReadinessDistribution readiness={selectedGroupReadiness} canReadReadiness={canReadOrgReadiness} compact />
                      </div>
                    }
                  />

                  <div className="mt-3 grid gap-2">
                    {selectedMembers.length ? (
                      selectedMembers.map((member) => (
                        <MemberLine
                          key={member.id}
                          member={member}
                          readiness={readinessForMember(selectedGroupReadiness, member.id)}
                          onRemove={removeMember}
                          readOnly={!canManageMembership && Boolean(editing.id)}
                          busy={membershipBusy}
                        />
                      ))
                    ) : (
                      <EmptyState title="No members assigned" detail="Search the member directory below to add people." />
                    )}
                  </div>

                  {(canManageMembership || !editing.id) && canSaveCurrent ? (
                    <div className="mt-4">
                      <Field label="Search members to add">
                        <div className="relative">
                          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                          <Input aria-label="Search members to add" className="pl-9" value={memberQuery} onChange={(event) => setMemberQuery(event.target.value)} placeholder="Search name, ID, email, function" />
                        </div>
                      </Field>
                      <div className="mt-2 grid max-h-72 gap-2 overflow-y-auto pr-1">
                        {candidateMembers.length ? (
                          candidateMembers.map((member) => <CandidateLine key={member.id} member={member} onAdd={addMember} busy={membershipBusy} />)
                        ) : (
                          <EmptyState title="No matching candidates" detail="Adjust pool, function or member search." />
                        )}
                      </div>
                    </div>
                  ) : null}
                </section>

                <section className="rounded-md border border-border p-3">
                  <SectionHeader title="Roster links" description="Read-only compatibility projection; manage links in Rostering." />
                  <div className="mt-3">
                    <Field label="Roster shift IDs">
                      <div className="relative">
                        <CalendarDays className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                        <Input
                          className="pl-9"
                          value={editing.rosterShiftIds.join(", ")}
                          disabled
                          placeholder="RST-001, RST-002"
                        />
                      </div>
                    </Field>
                  </div>
                </section>

                <Field label="Notes">
                  <Textarea value={editing.notes ?? ""} disabled={!canSaveCurrent || saving} onChange={(event) => updateEditing({ notes: event.target.value })} placeholder="Operational notes for this group" />
                </Field>
              </div>
            </form>

            <div className="grid gap-2 border-t border-border bg-card px-5 py-3 sm:grid-cols-[auto_1fr]">
              {editing.id && canArchive ? (
                <Button type="button" icon={Archive} variant="secondary" disabled={saving || membershipBusy} onClick={() => void archiveGroup()}>
                  Archive
                </Button>
              ) : <span />}
              {canSaveCurrent ? (
                <Button type="button" className="w-full" icon={Save} variant="primary" disabled={saving || membershipBusy} onClick={() => void saveGroup()}>
                  {saving ? "Saving" : editing.id ? "Save group" : "Create group"}
                </Button>
              ) : null}
            </div>
          </aside>
        </>
      ) : null}
    </>
  );
}
