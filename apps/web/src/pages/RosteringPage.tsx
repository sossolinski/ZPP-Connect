import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDays, CheckCircle2, Edit3, Plus, RefreshCcw, Send, Trash2, XCircle } from "lucide-react";
import type { DemoUser } from "../lib/portal-types";
import { PageIntro } from "../components/portal";
import { AlertBox, Badge, Button, Card, CardHeader, EmptyState, ErrorSummary, Field, Input, Loading, Select, StatusBadge, Table, Textarea } from "../components/ui";
import { DialogSurface } from "../components/DialogSurface";
import { api } from "../lib/api";
import { useApp } from "../lib/app-context";

type RosterStatus = "Draft" | "Published" | "Confirmed" | "Declined" | "Cancelled" | "Completed";
type AvailabilityType = "Available" | "Unavailable" | "Preferred";

type MemberSummary = {
  id: string;
  memberId: string;
  displayName: string;
  pool?: string;
  role?: string;
  assignedFunction?: string;
  status?: string;
};

type ReadinessStatus = "Ready" | "Ready with attention" | "Not ready" | "Unknown" | "Not applicable";
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

type GroupSummary = {
  id: string;
  operationalId: string;
  name: string;
  functionName?: string;
  status?: string;
};

type RosterShift = {
  id: string;
  operationalId: string;
  sessionId: string;
  groupId?: string | null;
  assignedMemberProfileId?: string | null;
  title: string;
  duty: string;
  functionName: string;
  startAt: string;
  endAt: string;
  location: string;
  status: RosterStatus;
  notes?: string | null;
  updatedAt: string;
  assignedMember?: MemberSummary | null;
  group?: GroupSummary | null;
  conflictWarnings?: string[];
  permissions?: {
    canUpdate?: boolean;
    canPublish?: boolean;
    canCancel?: boolean;
    canComplete?: boolean;
    canConfirm?: boolean;
    canDecline?: boolean;
  };
};

type AvailabilityRecord = {
  id: string;
  operationalId: string;
  memberProfileId: string;
  startAt: string;
  endAt: string;
  type: AvailabilityType;
  note?: string | null;
  updatedAt: string;
  member?: MemberSummary;
  permissions?: {
    canUpdate?: boolean;
    canRemove?: boolean;
  };
};

type ApiListResult<T> = {
  data: T[];
  total: number;
  linkedMemberProfile?: MemberSummary | null;
};

type ShiftForm = {
  title: string;
  duty: string;
  functionName: string;
  groupId: string;
  assignedMemberProfileId: string;
  startAt: string;
  endAt: string;
  location: string;
  notes: string;
};

type AvailabilityForm = {
  memberProfileId: string;
  startAt: string;
  endAt: string;
  type: AvailabilityType;
  note: string;
};

const statusOptions: Array<"All" | RosterStatus> = ["All", "Draft", "Published", "Confirmed", "Declined", "Cancelled", "Completed"];
const availabilityTypeOptions: AvailabilityType[] = ["Available", "Unavailable", "Preferred"];

function formatDateTime(value?: string | null) {
  if (!value) return "Not set";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Not set";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function toDateTimeInput(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromDateTimeInput(value: string) {
  return value ? new Date(value).toISOString() : "";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Action could not be completed.";
}

function normalizeReadinessStatus(value: unknown): ReadinessStatus {
  if (value === "Ready" || value === "Ready with attention" || value === "Not ready" || value === "Not applicable") return value;
  return "Unknown";
}

function normalizeReadiness(input: Record<string, any>): MemberReadiness {
  return {
    member: input.member,
    calculatedAt: typeof input.calculatedAt === "string" ? input.calculatedAt : undefined,
    overallStatus: normalizeReadinessStatus(input.overallStatus),
    blockers: Array.isArray(input.blockers) ? input.blockers : [],
    warnings: Array.isArray(input.warnings) ? input.warnings : []
  };
}

function readinessLabel(status: ReadinessStatus) {
  return status === "Unknown" ? "Unable to determine" : status;
}

function readinessTone(status: ReadinessStatus) {
  if (status === "Ready") return "success";
  if (status === "Ready with attention") return "warning";
  if (status === "Not ready") return "danger";
  if (status === "Not applicable") return "neutral";
  return "info";
}

function primaryReadinessIssue(readiness?: MemberReadiness) {
  return readiness?.blockers?.[0] ?? readiness?.warnings?.[0] ?? null;
}

function shiftFormFromRecord(shift?: RosterShift): ShiftForm {
  return {
    title: shift?.title ?? "",
    duty: shift?.duty ?? "",
    functionName: shift?.functionName ?? "",
    groupId: shift?.groupId ?? "",
    assignedMemberProfileId: shift?.assignedMemberProfileId ?? "",
    startAt: toDateTimeInput(shift?.startAt),
    endAt: toDateTimeInput(shift?.endAt),
    location: shift?.location ?? "",
    notes: shift?.notes ?? ""
  };
}

function blankAvailabilityForm(memberProfileId = ""): AvailabilityForm {
  return {
    memberProfileId,
    startAt: "",
    endAt: "",
    type: "Available",
    note: ""
  };
}

function availabilityFormFromRecord(record?: AvailabilityRecord): AvailabilityForm {
  return {
    memberProfileId: record?.memberProfileId ?? "",
    startAt: toDateTimeInput(record?.startAt),
    endAt: toDateTimeInput(record?.endAt),
    type: record?.type ?? "Available",
    note: record?.note ?? ""
  };
}

function metricCard(label: string, value: string | number, detail: string) {
  return (
    <Card key={label} className="p-4">
      <p className="text-xs font-black uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-2 text-3xl font-black text-foreground">{value}</p>
      <p className="mt-1 text-sm font-semibold text-muted-foreground">{detail}</p>
    </Card>
  );
}

export function RosteringPage({ user }: { user: DemoUser }) {
  const { activeSession, user: authenticatedUser } = useApp();
  const [shifts, setShifts] = useState<RosterShift[]>([]);
  const [availability, setAvailability] = useState<AvailabilityRecord[]>([]);
  const [members, setMembers] = useState<MemberSummary[]>([]);
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [readinessRows, setReadinessRows] = useState<MemberReadiness[]>([]);
  const [linkedMember, setLinkedMember] = useState<MemberSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [readinessError, setReadinessError] = useState("");
  const [success, setSuccess] = useState("");
  const [statusFilter, setStatusFilter] = useState<(typeof statusOptions)[number]>("All");
  const [groupFilter, setGroupFilter] = useState("All");
  const [memberFilter, setMemberFilter] = useState("All");
  const [fromFilter, setFromFilter] = useState("");
  const [toFilter, setToFilter] = useState("");
  const [drawer, setDrawer] = useState<{ mode: "create" | "edit" | "view"; shift?: RosterShift } | null>(null);
  const [shiftForm, setShiftForm] = useState<ShiftForm>(() => shiftFormFromRecord());
  const [shiftBaseline, setShiftBaseline] = useState<ShiftForm>(() => shiftFormFromRecord());
  const [shiftError, setShiftError] = useState("");
  const [savingShift, setSavingShift] = useState(false);
  const [availabilityEditing, setAvailabilityEditing] = useState<AvailabilityRecord | null>(null);
  const [availabilityForm, setAvailabilityForm] = useState<AvailabilityForm>(() => blankAvailabilityForm());
  const [availabilityBaseline, setAvailabilityBaseline] = useState<AvailabilityForm>(() => blankAvailabilityForm());
  const [availabilityError, setAvailabilityError] = useState("");
  const [savingAvailability, setSavingAvailability] = useState(false);
  const [busyAction, setBusyAction] = useState("");

  const permissions = useMemo(() => new Set(authenticatedUser?.permissions ?? []), [authenticatedUser?.permissions]);
  const can = useCallback((permission: string) => permissions.has(permission), [permissions]);
  const canReadAllRoster = can("roster:read");
  const canCreateShift = can("roster:create");
  const canUpdateShift = can("roster:update");
  const canReadAvailability = can("availability:read-all") || can("availability:read-own");
  const canManageAllAvailability = can("availability:manage-all");
  const canUpdateOwnAvailability = can("availability:update-own");
  const canEditAvailability = canManageAllAvailability || canUpdateOwnAvailability;
  const canReadRosterReadiness = can("readiness:read-all") || can("readiness:read-group");
  const sessionId = activeSession?.id;

  const loadData = useCallback(async () => {
    setLoading(true);
    setError("");
    setReadinessError("");
    if (!sessionId) {
      setShifts([]);
      setAvailability([]);
      setMembers([]);
      setGroups([]);
      setReadinessRows([]);
      setLoading(false);
      return;
    }
    try {
      const rosterQuery: Record<string, string | boolean> = { sessionId };
      if (statusFilter !== "All") rosterQuery.status = statusFilter;
      if (groupFilter !== "All") rosterQuery.groupId = groupFilter;
      if (memberFilter !== "All") rosterQuery.memberProfileId = memberFilter;
      if (fromFilter) rosterQuery.startFrom = new Date(fromFilter).toISOString();
      if (toFilter) rosterQuery.startTo = new Date(`${toFilter}T23:59:59`).toISOString();
      if (!canReadAllRoster) rosterQuery.mine = true;

      const rosterPromise = api.rosterShifts(rosterQuery) as Promise<ApiListResult<RosterShift>>;
      const availabilityPromise = canReadAvailability ? (api.availability(can("availability:read-all") ? {} : { memberProfileId: linkedMember?.id }) as Promise<ApiListResult<AvailabilityRecord>>) : Promise.resolve({ total: 0, data: [], linkedMemberProfile: null });
      const membersPromise = canCreateShift || canUpdateShift || canManageAllAvailability ? api.memberProfiles({ status: "Active" }) : Promise.resolve({ total: 0, data: [] });
      const groupsPromise = canCreateShift || canUpdateShift ? api.groups({ sessionId }) : Promise.resolve({ total: 0, data: [] });
      const readinessPromise = canReadRosterReadiness
        ? api.readinessMembers(undefined, { pageLimit: 200 }).catch((nextError) => {
            setReadinessError(errorMessage(nextError));
            return null;
          })
        : Promise.resolve(null);

      const [rosterResult, availabilityResult, memberResult, groupResult, readinessResult] = await Promise.all([rosterPromise, availabilityPromise, membersPromise, groupsPromise, readinessPromise]);
      setShifts(rosterResult.data);
      setAvailability(availabilityResult.data);
      setLinkedMember((rosterResult.linkedMemberProfile ?? availabilityResult.linkedMemberProfile ?? null) as MemberSummary | null);
      setMembers((memberResult.data ?? []) as MemberSummary[]);
      setGroups((groupResult.data ?? []) as GroupSummary[]);
      setReadinessRows(readinessResult?.data.map(normalizeReadiness) ?? []);
    } catch (nextError) {
      setError(errorMessage(nextError));
      setReadinessRows([]);
    } finally {
      setLoading(false);
    }
  }, [can, canCreateShift, canReadAllRoster, canReadAvailability, canManageAllAvailability, canReadRosterReadiness, canUpdateShift, fromFilter, groupFilter, linkedMember?.id, memberFilter, sessionId, statusFilter, toFilter]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const activeShifts = shifts.filter((shift) => !["Cancelled", "Completed", "Declined"].includes(shift.status));
  const waitingForResponse = shifts.filter((shift) => shift.status === "Published").length;
  const uncovered = activeShifts.filter((shift) => !shift.assignedMemberProfileId).length;
  const warningCount = shifts.filter((shift) => (shift.conflictWarnings ?? []).length > 0).length;
  const confirmed = shifts.filter((shift) => shift.status === "Confirmed").length;
  const readOnly = !canCreateShift && !canUpdateShift;
  const readinessByMember = useMemo(() => {
    const entries: Array<[string, MemberReadiness]> = [];
    for (const row of readinessRows) {
      const id = String(row.member?.id ?? "");
      if (id) entries.push([id, row]);
    }
    return new Map(entries);
  }, [readinessRows]);
  const pageDescription = readOnly
    ? "Review your roster and confirm your own shifts when action is available."
    : "Create, publish and manage roster coverage for the selected operating period.";

  const readinessSummaryForMember = (member?: MemberSummary | null) => {
    if (!canReadRosterReadiness || !member) return null;
    const readiness = readinessByMember.get(member.id);
    const status = readinessError || !readiness ? "Unknown" : readiness.overallStatus;
    const issue = primaryReadinessIssue(readiness);
    const detail = readinessError
      ? "Readiness status could not be loaded."
      : issue?.title ?? (status === "Ready" ? "No immediate blocker" : "No readiness issue detail available");
    return (
      <div className="mt-2">
        <Badge tone={readinessTone(status)}>{readinessLabel(status)}</Badge>
        <p className="mt-1 line-clamp-2 text-xs font-semibold text-muted-foreground">{detail}</p>
      </div>
    );
  };

  const openShiftDrawer = (mode: "create" | "edit" | "view", shift?: RosterShift) => {
    const nextForm = shiftFormFromRecord(shift);
    setDrawer({ mode, shift });
    setShiftForm(nextForm);
    setShiftBaseline(nextForm);
    setShiftError("");
  };

  const closeShiftDrawer = () => {
    setDrawer(null);
    setShiftError("");
  };

  const updateShiftForm = (key: keyof ShiftForm, value: string) => {
    setShiftForm((current) => ({ ...current, [key]: value }));
  };

  const shiftDirty = drawer ? JSON.stringify(shiftForm) !== JSON.stringify(shiftBaseline) : false;
  const availabilityDirty = JSON.stringify(availabilityForm) !== JSON.stringify(availabilityBaseline);

  const saveShift = async () => {
    if (!drawer || drawer.mode === "view") return;
    if (!sessionId) {
      setShiftError("Select an active session before saving a roster shift.");
      return;
    }
    setSavingShift(true);
    setShiftError("");
    try {
      const body = {
        ...shiftForm,
        sessionId,
        groupId: shiftForm.groupId || null,
        assignedMemberProfileId: shiftForm.assignedMemberProfileId || null,
        startAt: fromDateTimeInput(shiftForm.startAt),
        endAt: fromDateTimeInput(shiftForm.endAt),
        expectedUpdatedAt: drawer.shift?.updatedAt
      };
      const saved = drawer.mode === "create"
        ? await api.createRosterShift(body)
        : await api.updateRosterShift(drawer.shift!.id, body);
      setSuccess(drawer.mode === "create" ? "Roster shift created" : "Roster shift updated");
      const nextForm = shiftFormFromRecord(saved as RosterShift);
      setShiftForm(nextForm);
      setShiftBaseline(nextForm);
      setDrawer({ mode: "edit", shift: saved as RosterShift });
      await loadData();
    } catch (nextError) {
      setShiftError(errorMessage(nextError));
    } finally {
      setSavingShift(false);
    }
  };

  const runShiftAction = async (shift: RosterShift, action: "publish" | "confirm" | "decline" | "cancel" | "complete") => {
    setBusyAction(`${shift.id}:${action}`);
    setShiftError("");
    setError("");
    try {
      const methods = {
        publish: api.publishRosterShift,
        confirm: api.confirmRosterShift,
        decline: api.declineRosterShift,
        cancel: api.cancelRosterShift,
        complete: api.completeRosterShift
      };
      const labels = {
        publish: "Roster shift published",
        confirm: "Roster shift confirmed",
        decline: "Roster shift declined",
        cancel: "Roster shift cancelled",
        complete: "Roster shift completed"
      };
      const updated = await methods[action](shift.id, {});
      setSuccess(labels[action]);
      if (drawer?.shift?.id === shift.id) {
        const nextForm = shiftFormFromRecord(updated as RosterShift);
        setDrawer({ mode: canUpdateShift ? "edit" : "view", shift: updated as RosterShift });
        setShiftForm(nextForm);
        setShiftBaseline(nextForm);
      }
      await loadData();
    } catch (nextError) {
      const message = errorMessage(nextError);
      if (drawer?.shift?.id === shift.id) setShiftError(message);
      else setError(message);
    } finally {
      setBusyAction("");
    }
  };

  const startAvailabilityCreate = () => {
    const nextForm = blankAvailabilityForm(canManageAllAvailability ? "" : linkedMember?.id ?? "");
    setAvailabilityEditing(null);
    setAvailabilityForm(nextForm);
    setAvailabilityBaseline(nextForm);
    setAvailabilityError("");
  };

  const startAvailabilityEdit = (record: AvailabilityRecord) => {
    const nextForm = availabilityFormFromRecord(record);
    setAvailabilityEditing(record);
    setAvailabilityForm(nextForm);
    setAvailabilityBaseline(nextForm);
    setAvailabilityError("");
  };

  const saveAvailability = async () => {
    setSavingAvailability(true);
    setAvailabilityError("");
    try {
      const body = {
        ...availabilityForm,
        memberProfileId: canManageAllAvailability ? availabilityForm.memberProfileId : undefined,
        startAt: fromDateTimeInput(availabilityForm.startAt),
        endAt: fromDateTimeInput(availabilityForm.endAt),
        expectedUpdatedAt: availabilityEditing?.updatedAt
      };
      const saved = availabilityEditing
        ? await api.updateAvailability(availabilityEditing.id, body)
        : await api.createAvailability(body);
      setSuccess(availabilityEditing ? "Availability updated" : "Availability added");
      const nextForm = availabilityFormFromRecord(saved as AvailabilityRecord);
      setAvailabilityEditing(saved as AvailabilityRecord);
      setAvailabilityForm(nextForm);
      setAvailabilityBaseline(nextForm);
      await loadData();
    } catch (nextError) {
      setAvailabilityError(errorMessage(nextError));
    } finally {
      setSavingAvailability(false);
    }
  };

  const removeAvailability = async (record: AvailabilityRecord) => {
    setSavingAvailability(true);
    setAvailabilityError("");
    try {
      await api.removeAvailability(record.id);
      setSuccess("Availability removed");
      startAvailabilityCreate();
      await loadData();
    } catch (nextError) {
      setAvailabilityError(errorMessage(nextError));
    } finally {
      setSavingAvailability(false);
    }
  };

  const rosterColumns = [
    {
      key: "shift",
      label: "Shift",
      render: (row: Record<string, unknown>) => {
        const shift = row as RosterShift;
        return (
          <div className="min-w-56">
            <p className="font-black text-foreground">{shift.operationalId} · {shift.title}</p>
            <p className="mt-1 text-xs font-bold text-muted-foreground">{formatDateTime(shift.startAt)} - {formatDateTime(shift.endAt)}</p>
          </div>
        );
      }
    },
    {
      key: "function",
      label: "Function / Location",
      render: (row: Record<string, unknown>) => {
        const shift = row as RosterShift;
        return (
          <div className="min-w-44">
            <p className="font-bold text-foreground">{shift.functionName}</p>
            <p className="mt-1 text-xs font-bold text-muted-foreground">{shift.location}</p>
          </div>
        );
      }
    },
    {
      key: "assignment",
      label: "Assigned",
      render: (row: Record<string, unknown>) => {
        const shift = row as RosterShift;
        return (
          <div className="min-w-44">
            <p className="font-bold text-foreground">{shift.assignedMember?.displayName ?? "Unassigned"}</p>
            <p className="mt-1 text-xs font-bold text-muted-foreground">{shift.group?.name ?? "No group"}</p>
            {readinessSummaryForMember(shift.assignedMember)}
          </div>
        );
      }
    },
    { key: "status", label: "Status", render: (row: Record<string, unknown>) => <StatusBadge value={(row as RosterShift).status} /> },
    {
      key: "warnings",
      label: "Warnings",
      render: (row: Record<string, unknown>) => {
        const warnings = (row as RosterShift).conflictWarnings ?? [];
        return warnings.length ? <Badge tone="warning">{warnings[0]}</Badge> : <Badge tone="success">Clear</Badge>;
      }
    }
  ];

  const availabilityColumns = [
    {
      key: "member",
      label: "Member / Window",
      render: (row: Record<string, unknown>) => {
        const record = row as AvailabilityRecord;
        return (
          <div className="min-w-56">
            <p className="font-black text-foreground">{record.member?.displayName ?? "Member"}</p>
            <p className="mt-1 text-xs font-bold text-muted-foreground">{formatDateTime(record.startAt)} - {formatDateTime(record.endAt)}</p>
          </div>
        );
      }
    },
    { key: "type", label: "Type", render: (row: Record<string, unknown>) => <StatusBadge value={(row as AvailabilityRecord).type} /> },
    {
      key: "note",
      label: "Note",
      render: (row: Record<string, unknown>) => <span className="line-clamp-2 text-sm font-semibold text-muted-foreground">{(row as AvailabilityRecord).note || "No note"}</span>
    }
  ];

  const drawerShift = drawer?.shift;
  const drawerReadOnly = drawer?.mode === "view" || (drawer?.mode === "edit" && !canUpdateShift);

  return (
    <>
      <PageIntro eyebrow="Roster planning" title="Rostering" description={pageDescription}>
        {readOnly ? <Badge tone="neutral">{user.roles.join(" + ")}</Badge> : <Button variant="create" icon={Plus} onClick={() => openShiftDrawer("create")}>New shift</Button>}
      </PageIntro>

      {success ? <div className="mb-3"><AlertBox tone="success" dismissible>{success}</AlertBox></div> : null}
      {error ? <div className="mb-3"><AlertBox tone="danger" dismissible>{error}</AlertBox></div> : null}
      {readinessError && canReadRosterReadiness ? <div className="mb-3"><AlertBox tone="warning" dismissible>Readiness status could not be loaded. Roster shifts remain available.</AlertBox></div> : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {metricCard(canReadAllRoster ? "Active shifts" : "My active shifts", activeShifts.length, "Not cancelled, declined or completed")}
        {metricCard("Awaiting response", waitingForResponse, "Published shifts needing confirmation")}
        {metricCard("Confirmed", confirmed, "Ready for the operating period")}
        {metricCard("Warnings", canReadAllRoster ? uncovered + warningCount : warningCount, canReadAllRoster ? "Unassigned or conflicting shifts" : "Items to review")}
      </div>

      <Card className="mt-4">
        <CardHeader
          title="Filters"
          description={canReadAllRoster ? "Narrow the roster by status, group, member or date." : "Your roster is limited to shifts linked to your member profile."}
          action={<Button variant="secondary" size="sm" icon={RefreshCcw} onClick={() => void loadData()}>Refresh</Button>}
        />
        <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-5">
          <Field label="Status">
            <Select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as (typeof statusOptions)[number])}>
              {statusOptions.map((item) => <option key={item} value={item}>{item}</option>)}
            </Select>
          </Field>
          {canReadAllRoster ? (
            <>
              <Field label="Group">
                <Select value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)}>
                  <option value="All">All groups</option>
                  {Array.from(new Map(shifts.filter((shift) => shift.group).map((shift) => [shift.group!.id, shift.group!])).values()).map((group) => (
                    <option key={group.id} value={group.id}>{group.name}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Member">
                <Select value={memberFilter} onChange={(event) => setMemberFilter(event.target.value)}>
                  <option value="All">All members</option>
                  {Array.from(new Map(shifts.filter((shift) => shift.assignedMember).map((shift) => [shift.assignedMember!.id, shift.assignedMember!])).values()).map((member) => (
                    <option key={member.id} value={member.id}>{member.displayName}</option>
                  ))}
                </Select>
              </Field>
            </>
          ) : null}
          <Field label="From date">
            <Input type="date" value={fromFilter} onChange={(event) => setFromFilter(event.target.value)} />
          </Field>
          <Field label="To date">
            <Input type="date" value={toFilter} onChange={(event) => setToFilter(event.target.value)} />
          </Field>
        </div>
      </Card>

      <div className="mt-4 grid gap-4">
        {!canReadAllRoster && !linkedMember && !loading ? (
          <EmptyState
            title="No linked member profile"
            detail="Ask a leader to link your operational account before using personal roster actions."
          />
        ) : null}

        <Card>
          <CardHeader title={canReadAllRoster ? "Roster table" : "My roster"} description={canReadAllRoster ? "Manage published coverage and review conflicts before the operating period." : "Open each published shift and confirm or decline when action is available."} />
          <div className="p-4">
            {loading ? (
              <Loading label="Loading roster" />
            ) : (
              <Table
                columns={rosterColumns}
                rows={shifts as unknown as Array<Record<string, unknown>>}
                rowId={(row) => (row as RosterShift).id}
                emptyTitle="No roster shifts found"
                emptyDetail="No shifts match the selected filters."
                rowAction={(row) => {
                  const shift = row as RosterShift;
                  return (
                    <div className="flex flex-wrap justify-end gap-2">
                      {shift.permissions?.canConfirm ? (
                        <Button size="sm" variant="success" icon={CheckCircle2} disabled={busyAction === `${shift.id}:confirm`} onClick={() => void runShiftAction(shift, "confirm")}>Confirm</Button>
                      ) : null}
                      {shift.permissions?.canDecline ? (
                        <Button size="sm" variant="secondary" icon={XCircle} disabled={busyAction === `${shift.id}:decline`} onClick={() => void runShiftAction(shift, "decline")}>Decline</Button>
                      ) : null}
                      <Button size="sm" variant="secondary" icon={Edit3} onClick={() => openShiftDrawer(canUpdateShift ? "edit" : "view", shift)}>{canUpdateShift ? "Edit" : "View"}</Button>
                    </div>
                  );
                }}
                actionWidth="w-72"
              />
            )}
          </div>
        </Card>

        {canReadAvailability ? (
          <Card>
            <CardHeader
              title={canReadAllRoster ? "Member availability" : "My availability"}
              description={canEditAvailability ? "Use availability windows so roster planners can avoid avoidable conflicts." : "Availability can be reviewed here."}
              action={canEditAvailability ? <Button size="sm" variant="secondary" icon={Plus} onClick={startAvailabilityCreate}>Add availability</Button> : null}
            />
            <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,26rem)]">
              <Table
                columns={availabilityColumns}
                rows={availability as unknown as Array<Record<string, unknown>>}
                rowId={(row) => (row as AvailabilityRecord).id}
                emptyTitle="No availability found"
                emptyDetail="Availability records for the selected scope will appear here."
                rowAction={(row) => {
                  const record = row as AvailabilityRecord;
                  if (!record.permissions?.canUpdate && !record.permissions?.canRemove) return null;
                  return (
                    <div className="flex justify-end gap-2">
                      {record.permissions.canUpdate ? <Button size="sm" variant="secondary" icon={Edit3} onClick={() => startAvailabilityEdit(record)}>Edit</Button> : null}
                      {record.permissions.canRemove ? <Button size="sm" variant="danger" icon={Trash2} disabled={savingAvailability} onClick={() => void removeAvailability(record)}>Remove</Button> : null}
                    </div>
                  );
                }}
                actionWidth="w-44"
              />

              {canEditAvailability ? (
                <form
                  className="grid content-start gap-3 rounded-lg border border-border bg-muted p-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveAvailability();
                  }}
                >
                  <div>
                    <h3 className="font-black text-foreground">{availabilityEditing ? "Edit availability" : "Add availability"}</h3>
                    <p className="mt-1 text-sm font-semibold text-muted-foreground">Set the exact time window and type.</p>
                  </div>
                  <ErrorSummary title="Availability could not be saved" errors={availabilityError ? [{ message: availabilityError }] : []} />
                  {canManageAllAvailability ? (
                    <Field label="Member" required>
                      <Select value={availabilityForm.memberProfileId} onChange={(event) => setAvailabilityForm((current) => ({ ...current, memberProfileId: event.target.value }))}>
                        <option value="">Select member</option>
                        {members.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}
                      </Select>
                    </Field>
                  ) : null}
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                    <Field label="Start" required><Input type="datetime-local" value={availabilityForm.startAt} onChange={(event) => setAvailabilityForm((current) => ({ ...current, startAt: event.target.value }))} /></Field>
                    <Field label="End" required><Input type="datetime-local" value={availabilityForm.endAt} onChange={(event) => setAvailabilityForm((current) => ({ ...current, endAt: event.target.value }))} /></Field>
                  </div>
                  <Field label="Type" required>
                    <Select value={availabilityForm.type} onChange={(event) => setAvailabilityForm((current) => ({ ...current, type: event.target.value as AvailabilityType }))}>
                      {availabilityTypeOptions.map((item) => <option key={item} value={item}>{item}</option>)}
                    </Select>
                  </Field>
                  <Field label="Note">
                    <Textarea value={availabilityForm.note} onChange={(event) => setAvailabilityForm((current) => ({ ...current, note: event.target.value }))} />
                  </Field>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Button type="submit" variant="create" disabled={savingAvailability || !availabilityDirty}>{savingAvailability ? "Saving" : "Save availability"}</Button>
                    <Button type="button" variant="secondary" onClick={startAvailabilityCreate}>Clear</Button>
                  </div>
                </form>
              ) : null}
            </div>
          </Card>
        ) : null}
      </div>

      {drawer ? (
        <DialogSurface
          title={drawer.mode === "create" ? "New roster shift" : `${drawerShift?.operationalId ?? "Roster shift"}`}
          description="Create or update roster coverage."
          onClose={closeShiftDrawer}
          dirty={shiftDirty}
          busy={savingShift}
          initialFocus="first-control"
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col border-l border-border bg-card text-foreground shadow-2xl"
        >
          {({ requestClose }) => (
            <form
              className="flex min-h-0 flex-1 flex-col"
              onSubmit={(event) => {
                event.preventDefault();
                void saveShift();
              }}
            >
              <div className="flex items-start justify-between gap-4 border-b border-border bg-card px-5 py-4">
                <div className="min-w-0">
                  <h2 data-dialog-heading="true" tabIndex={-1} className="text-xl font-black text-foreground">{drawer.mode === "create" ? "New roster shift" : drawerShift?.title}</h2>
                  <p className="mt-1 text-sm font-semibold text-muted-foreground">{drawer.mode === "create" ? "Create a draft shift, then publish it when ready." : drawerShift?.operationalId}</p>
                </div>
                <Button type="button" variant="ghost" size="sm" onClick={() => requestClose()}>Close</Button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                <div className="grid gap-4">
                  <ErrorSummary title="Roster shift could not be saved" errors={shiftError ? [{ message: shiftError }] : []} />
                  {drawerShift ? (
                    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted p-3">
                      <StatusBadge value={drawerShift.status} />
                      <span className="text-sm font-semibold text-muted-foreground">Last updated {formatDateTime(drawerShift.updatedAt)}</span>
                    </div>
                  ) : null}
                  <Field label="Title" required>
                    <Input data-dialog-initial-focus="true" value={shiftForm.title} disabled={drawerReadOnly || savingShift} onChange={(event) => updateShiftForm("title", event.target.value)} />
                  </Field>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Function" required>
                      <Input value={shiftForm.functionName} disabled={drawerReadOnly || savingShift} onChange={(event) => updateShiftForm("functionName", event.target.value)} />
                    </Field>
                    <Field label="Duty">
                      <Input value={shiftForm.duty} disabled={drawerReadOnly || savingShift} onChange={(event) => updateShiftForm("duty", event.target.value)} />
                    </Field>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Start" required>
                      <Input type="datetime-local" value={shiftForm.startAt} disabled={drawerReadOnly || savingShift} onChange={(event) => updateShiftForm("startAt", event.target.value)} />
                    </Field>
                    <Field label="End" required>
                      <Input type="datetime-local" value={shiftForm.endAt} disabled={drawerReadOnly || savingShift} onChange={(event) => updateShiftForm("endAt", event.target.value)} />
                    </Field>
                  </div>
                  <Field label="Location">
                    <Input value={shiftForm.location} disabled={drawerReadOnly || savingShift} onChange={(event) => updateShiftForm("location", event.target.value)} />
                  </Field>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Group">
                      <Select value={shiftForm.groupId} disabled={drawerReadOnly || savingShift} onChange={(event) => updateShiftForm("groupId", event.target.value)}>
                        <option value="">No group</option>
                        {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
                      </Select>
                    </Field>
                    <Field label="Assigned member">
                      <Select value={shiftForm.assignedMemberProfileId} disabled={drawerReadOnly || savingShift} onChange={(event) => updateShiftForm("assignedMemberProfileId", event.target.value)}>
                        <option value="">Unassigned</option>
                        {members.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}
                      </Select>
                    </Field>
                  </div>
                  <Field label="Notes">
                    <Textarea value={shiftForm.notes} disabled={drawerReadOnly || savingShift} onChange={(event) => updateShiftForm("notes", event.target.value)} />
                  </Field>

                  {drawerShift?.conflictWarnings?.length ? (
                    <AlertBox>{drawerShift.conflictWarnings.join(" · ")}</AlertBox>
                  ) : null}
                </div>
              </div>

              <div className="grid gap-2 border-t border-border bg-card px-5 py-4 sm:grid-cols-[1fr_auto] sm:items-center">
                <div className="flex flex-wrap gap-2">
                  {drawerShift?.permissions?.canPublish ? <Button type="button" variant="primary" icon={Send} disabled={Boolean(busyAction)} onClick={() => void runShiftAction(drawerShift, "publish")}>Publish</Button> : null}
                  {drawerShift?.permissions?.canConfirm ? <Button type="button" variant="success" icon={CheckCircle2} disabled={Boolean(busyAction)} onClick={() => void runShiftAction(drawerShift, "confirm")}>Confirm</Button> : null}
                  {drawerShift?.permissions?.canDecline ? <Button type="button" variant="secondary" icon={XCircle} disabled={Boolean(busyAction)} onClick={() => void runShiftAction(drawerShift, "decline")}>Decline</Button> : null}
                  {drawerShift?.permissions?.canComplete ? <Button type="button" variant="success" icon={CheckCircle2} disabled={Boolean(busyAction)} onClick={() => void runShiftAction(drawerShift, "complete")}>Complete</Button> : null}
                  {drawerShift?.permissions?.canCancel ? <Button type="button" variant="danger" icon={XCircle} disabled={Boolean(busyAction)} onClick={() => void runShiftAction(drawerShift, "cancel")}>Cancel shift</Button> : null}
                </div>
                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  <Button type="button" variant="secondary" disabled={savingShift} onClick={() => requestClose()}>Close</Button>
                  {!drawerReadOnly ? <Button type="submit" variant="create" icon={CalendarDays} disabled={savingShift || !shiftDirty}>{savingShift ? "Saving" : drawer.mode === "create" ? "Create shift" : "Save changes"}</Button> : null}
                </div>
              </div>
            </form>
          )}
        </DialogSurface>
      ) : null}
    </>
  );
}
