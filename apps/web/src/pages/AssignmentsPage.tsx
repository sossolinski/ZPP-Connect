import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clsx } from "clsx";
import { CheckCircle2, Columns3, FilePlus2, FilterX, ListTodo, Pencil, PlayCircle, Save, Search, Siren, UserCheck, XCircle } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { Badge, PageIntro, Panel, PanelBody, PriorityBadge, SectionHeader, StatusBadge } from "../components/portal";
import { AlertBox, Button, ConfirmDialog, DecisionDialog, EmptyState, ErrorSummary, Field, Input, Loading, Select, Textarea } from "../components/ui";
import { api } from "../lib/api";
import { useApp } from "../lib/app-context";
import { isSessionWriteContextCurrent } from "../lib/session-safety";
import type { AnyRecord } from "../lib/types";
import { DialogSurface } from "../components/DialogSurface";

type AssignmentStatus = "Open" | "In Progress" | "Escalated" | "Completed" | "Cancelled";
type AssignmentPriority = "Normal" | "Urgent" | "Critical";
type ViewMode = "queue" | "board";
type DueFilter = "all" | "overdue" | "today" | "none";
type SortMode = "priority" | "due" | "status" | "owner" | "updated";
type AssignmentTask = AnyRecord & {
  id?: string;
  operationalId?: string;
  sessionId?: string;
  caseId?: string | null;
  title: string;
  details?: string | null;
  status: AssignmentStatus;
  priority: AssignmentPriority;
  ownerAssignedTo?: string | null;
  assignedUserId?: string | null;
  assignedUserDisplayName?: string | null;
  assignedUser?: AssignmentAssignee | null;
  legacyAssignee?: { displayName?: string | null; label?: string | null } | null;
  relatedFunction?: string | null;
  linkedRecord?: string | null;
  dueAt?: string | null;
  updatedAt?: string | null;
  version: number;
  overdue?: boolean;
  assigneeEligible?: boolean | null;
  assigneeEligibilityMessage?: string | null;
  availableActions?: string[];
  completedBy?: { id: string; displayName: string } | null;
  completedAt?: string | null;
  completionNote?: string | null;
  cancelledBy?: { id: string; displayName: string } | null;
  cancelledAt?: string | null;
  cancelReason?: string | null;
};
type AssignmentAssignee = {
  id: string;
  userId?: string;
  email?: string;
  displayName: string;
  roles?: string[];
  roleLabels?: string[];
};
type OwnerOption = { value: string; label: string };
type OwnerAction = { mode: "assign" | "reassign"; task: AssignmentTask; assigneeUserId: string; reason: string; error: string };

const boardStatuses: AssignmentStatus[] = ["Open", "In Progress", "Escalated", "Completed"];
const fallbackStatuses: AssignmentStatus[] = ["Open", "In Progress", "Escalated", "Completed", "Cancelled"];
const fallbackPriorities: AssignmentPriority[] = ["Normal", "Urgent", "Critical"];
const fallbackFunctions = [
  "Family Assistance",
  "Welfare Support",
  "Telephone Enquiry Center",
  "Passenger / SRC",
  "Matching",
  "Release Control",
  "Rostering",
  "Documentation",
  "Training"
];
const ownerMine = "__mine__";
const ownerUnassigned = "__unassigned__";
const terminalStatuses = new Set<AssignmentStatus>(["Completed", "Cancelled"]);
const boardColumnLimit = 10;
const queuePageSize = 100;

const dueFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit"
});

const priorityRank: Record<AssignmentPriority, number> = {
  Critical: 0,
  Urgent: 1,
  Normal: 2
};

const statusRank: Record<AssignmentStatus, number> = {
  Escalated: 0,
  Open: 1,
  "In Progress": 2,
  Completed: 3,
  Cancelled: 4
};

function emptyAssignment(sessionId?: string): AssignmentTask {
  return {
    sessionId,
    title: "",
    details: "",
    status: "Open",
    priority: "Normal",
    ownerAssignedTo: "",
    relatedFunction: "",
    linkedRecord: "",
    caseId: "",
    dueAt: "",
    version: 1
  };
}

function selectLabels(items: Array<{ label: string }> | undefined, fallback: string[]) {
  return items?.length ? items.map((item) => item.label) : fallback;
}

function optionalText(value: unknown) {
  const text = String(value ?? "").trim();
  return text || null;
}

function normalizeAssignmentPayload(task: AssignmentTask, sessionId: string) {
  return {
    sessionId,
    caseId: optionalText(task.caseId),
    title: String(task.title ?? "").trim(),
    details: optionalText(task.details),
    priority: task.priority,
    relatedFunction: optionalText(task.relatedFunction),
    linkedRecord: optionalText(task.linkedRecord),
    dueAt: task.dueAt ? new Date(task.dueAt).toISOString() : null
  };
}

function dateTimeInput(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function dateTime(value?: string | null) {
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

function formatDue(value?: string | null) {
  if (!value) return "No due time";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "No due time" : dueFormatter.format(date);
}

function formatUpdated(value?: string | null) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not recorded" : dueFormatter.format(date);
}

function isOverdue(task: AssignmentTask) {
  const due = dateTime(task.dueAt);
  return due !== Number.POSITIVE_INFINITY && due < Date.now() && !terminalStatuses.has(task.status);
}

function isDueToday(task: AssignmentTask) {
  if (!task.dueAt) return false;
  const due = new Date(task.dueAt);
  if (Number.isNaN(due.getTime())) return false;
  const today = new Date();
  return due.getFullYear() === today.getFullYear() && due.getMonth() === today.getMonth() && due.getDate() === today.getDate();
}

function ownerLabel(task: AssignmentTask) {
  return optionalText(task.assignedUser?.displayName) ?? optionalText(task.assignedUserDisplayName) ?? optionalText(task.ownerAssignedTo) ?? "Unassigned";
}

function ownerDisplayLabel(task: AssignmentTask) {
  return task.legacyAssignee?.label ?? ownerLabel(task);
}

function ownerUserId(task: AssignmentTask) {
  return optionalText(task.assignedUserId) ?? optionalText(task.assignedUser?.userId) ?? optionalText(task.assignedUser?.id);
}

function ownerFilterValue(task: AssignmentTask) {
  const id = ownerUserId(task);
  if (id) return `user:${id}`;
  const label = ownerLabel(task);
  return label === "Unassigned" ? ownerUnassigned : `legacy:${label}`;
}

function linkedLabel(task: AssignmentTask) {
  return optionalText(task.linkedRecord) ?? optionalText(task.caseId) ?? "None";
}

function shortTaskId(value?: string | null) {
  if (!value) return "Unsaved";
  const match = value.match(/^([A-Z]+)-\d{4}-(\d+)$/);
  return match ? `${match[1]}-${match[2]}` : value;
}

function matchesQuery(task: AssignmentTask, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [task.operationalId, task.caseId, task.title, task.details, ownerDisplayLabel(task), task.relatedFunction, task.linkedRecord, task.status, task.priority]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle));
}

function compareText(left: string, right: string) {
  return left.localeCompare(right, undefined, { sensitivity: "base" });
}

function sortAssignments(rows: AssignmentTask[], sortBy: SortMode) {
  return [...rows].sort((left, right) => {
    if (sortBy === "due") {
      return dateTime(left.dueAt) - dateTime(right.dueAt) || priorityRank[left.priority] - priorityRank[right.priority] || compareText(left.title, right.title);
    }
    if (sortBy === "status") {
      return statusRank[left.status] - statusRank[right.status] || priorityRank[left.priority] - priorityRank[right.priority] || dateTime(left.dueAt) - dateTime(right.dueAt);
    }
    if (sortBy === "owner") {
      return compareText(ownerLabel(left), ownerLabel(right)) || priorityRank[left.priority] - priorityRank[right.priority] || dateTime(left.dueAt) - dateTime(right.dueAt);
    }
    if (sortBy === "updated") {
      return dateTime(right.updatedAt) - dateTime(left.updatedAt) || priorityRank[left.priority] - priorityRank[right.priority];
    }
    return priorityRank[left.priority] - priorityRank[right.priority] || dateTime(left.dueAt) - dateTime(right.dueAt) || statusRank[left.status] - statusRank[right.status];
  });
}

function nextActions(status: AssignmentStatus) {
  if (status === "Open") return [{ label: "Start", status: "In Progress" as AssignmentStatus, icon: PlayCircle, variant: "secondary" as const }];
  if (status === "In Progress") {
    return [
      { label: "Escalate", status: "Escalated" as AssignmentStatus, icon: Siren, variant: "warning" as const },
      { label: "Complete", status: "Completed" as AssignmentStatus, icon: CheckCircle2, variant: "success" as const }
    ];
  }
  if (status === "Escalated") {
    return [{ label: "Resolve / Resume", status: "In Progress" as AssignmentStatus, icon: PlayCircle, variant: "secondary" as const }];
  }
  return [];
}

export function AssignmentsPage() {
  const { activeSession, activeSessionWritable, dictionaries, can, reload, user, portalUser, verifyActiveSessionWrite } = useApp();
  const [searchParams] = useSearchParams();
  const focusAssignmentId = searchParams.get("assignmentId") ?? searchParams.get("focus") ?? "";
  const handledFocusRef = useRef("");
  const operationIdsRef = useRef(new Map<string, string>());
  const [tasks, setTasks] = useState<AssignmentTask[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [assignees, setAssignees] = useState<AssignmentAssignee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("queue");
  const [statusFilter, setStatusFilter] = useState<"all" | AssignmentStatus>("all");
  const [priorityFilter, setPriorityFilter] = useState<"all" | AssignmentPriority>("all");
  const memberSelfView = Boolean(portalUser?.roles.some((role) => role === "ZPP Member" || role === "TEC Member"));
  const assignmentUserId = user?.userId ?? user?.id ?? "";
  const assignmentIdentity = user?.displayName ?? portalUser?.displayName ?? "";
  const [ownerFilter, setOwnerFilter] = useState(() => memberSelfView ? ownerMine : "all");
  const [functionFilter, setFunctionFilter] = useState("all");
  const [dueFilter, setDueFilter] = useState<DueFilter>("all");
  const [sortBy, setSortBy] = useState<SortMode>("priority");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<AssignmentTask>(() => emptyAssignment(activeSession?.id));
  const [saving, setSaving] = useState(false);
  const [editorError, setEditorError] = useState("");
  const [actionError, setActionError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [ownerAction, setOwnerAction] = useState<OwnerAction | null>(null);
  const [editorBaseline, setEditorBaseline] = useState("");
  const [terminalTarget, setTerminalTarget] = useState<{ task: AssignmentTask; status: "Completed" | "Cancelled" } | null>(null);
  const [reasonTarget, setReasonTarget] = useState<{ task: AssignmentTask; action: "escalate" | "cancel" } | null>(null);
  const [decisionNote, setDecisionNote] = useState("");

  const canCreate = activeSessionWritable && can("assignment:create");
  const canUpdate = activeSessionWritable && can("assignment:update");
  const canAssign = activeSessionWritable && can("assignment:assign");
  const canManageOwners = activeSessionWritable && canAssign;
  const ownsTask = (task: AssignmentTask) => Boolean(assignmentUserId && ownerUserId(task) === assignmentUserId);
  const canEditTask = (task: AssignmentTask) => canUpdate && !terminalStatuses.has(task.status) && (canManageOwners || ownsTask(task));
  const canSaveCurrent = editing.id ? canEditTask(editing) : canCreate;
  const statusOptions = selectLabels(dictionaries.assignmentStatuses, fallbackStatuses) as AssignmentStatus[];
  const priorityOptions = selectLabels(dictionaries.assignmentPriorities, fallbackPriorities) as AssignmentPriority[];
  const functionOptions = selectLabels(dictionaries.assignmentFunctions, fallbackFunctions);

  function operationIdFor(key: string) {
    const current = operationIdsRef.current.get(key);
    if (current) return current;
    const created = crypto.randomUUID();
    operationIdsRef.current.set(key, created);
    return created;
  }

  function finishOperation(key: string) {
    operationIdsRef.current.delete(key);
  }

  const load = useCallback(async () => {
    if (!activeSession) {
      setTasks([]);
      setAssignees([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const ownerUser = ownerFilter.startsWith("user:") ? ownerFilter.slice(5) : undefined;
      const sortMap: Record<SortMode, string> = { priority: "priority", due: "dueAt", status: "status", owner: "assignee", updated: "updatedAt" };
      const [result, assigneeResult] = await Promise.all([
        api.assignmentQueue<AssignmentTask>({
          sessionId: activeSession.id,
          search: query.trim() || undefined,
          status: statusFilter === "all" ? undefined : statusFilter,
          priority: priorityFilter === "all" ? undefined : priorityFilter,
          assignedUserId: ownerUser,
          unassigned: ownerFilter === ownerUnassigned ? true : undefined,
          mine: ownerFilter === ownerMine ? true : undefined,
          due: dueFilter === "all" ? undefined : dueFilter,
          relatedFunction: functionFilter === "all" ? undefined : functionFilter,
          sortBy: sortMap[sortBy],
          sortDirection: sortBy === "updated" ? "desc" : "asc",
          limit: queuePageSize,
          offset: page * queuePageSize
        }),
        canManageOwners ? api.assignmentAssignees({ sessionId: activeSession.id, limit: 200, offset: 0 }).catch(() => ({ data: [] })) : Promise.resolve({ data: [] })
      ]);
      setTasks(result.data);
      setTotal(result.total ?? result.data.length);
      setAssignees((assigneeResult.data as AssignmentAssignee[]) ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load assignments");
    } finally {
      setLoading(false);
    }
  }, [activeSession?.id, canManageOwners, dueFilter, functionFilter, ownerFilter, page, priorityFilter, query, sortBy, statusFilter]);

  useEffect(() => {
    if (!editorOpen && !ownerAction) {
      setEditing(emptyAssignment(activeSession?.id));
      setQuery("");
      setEditorError("");
      setActionError("");
      setFeedback("");
      setOwnerFilter(memberSelfView ? ownerMine : "all");
    }
  }, [activeSession?.id, memberSelfView]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => { setPage(0); }, [dueFilter, functionFilter, ownerFilter, priorityFilter, query, sortBy, statusFilter]);

  useEffect(() => {
    const focus = focusAssignmentId.trim().toLowerCase();
    if (!focus || loading) {
      if (!focus) handledFocusRef.current = "";
      return;
    }
    const task = tasks.find((item) => [item.id, item.operationalId].filter(Boolean).some((value) => String(value).toLowerCase() === focus));
    if (!task || handledFocusRef.current === `${task.id}:${focus}`) return;
    if (memberSelfView && ownerUserId(task) !== assignmentUserId) return;
    handledFocusRef.current = `${task.id}:${focus}`;
    openTask(task);
  }, [assignmentUserId, focusAssignmentId, loading, tasks, memberSelfView]);

  const ownerOptions = useMemo<OwnerOption[]>(() => {
    const options = new Map<string, string>();
    for (const task of tasks) {
      const value = ownerFilterValue(task);
      if (value !== ownerUnassigned) options.set(value, ownerDisplayLabel(task));
    }
    return Array.from(options, ([value, label]) => ({ value, label })).sort((left, right) => compareText(left.label, right.label));
  }, [tasks]);
  const assigneeOptions = useMemo(
    () => assignees.filter((assignee) => assignee.id && assignee.displayName).sort((left, right) => compareText(left.displayName, right.displayName)),
    [assignees]
  );

  const filteredTasks = useMemo(() => {
    return tasks.filter((task) => {
      if (!matchesQuery(task, query)) return false;
      if (statusFilter !== "all" && task.status !== statusFilter) return false;
      if (memberSelfView && terminalStatuses.has(task.status)) return false;
      if (priorityFilter !== "all" && task.priority !== priorityFilter) return false;
      if (functionFilter !== "all" && task.relatedFunction !== functionFilter) return false;
      if (ownerFilter === ownerUnassigned && ownerLabel(task) !== "Unassigned") return false;
      if (ownerFilter === ownerMine && (!assignmentUserId || ownerUserId(task) !== assignmentUserId)) return false;
      if (![ownerUnassigned, ownerMine, "all"].includes(ownerFilter) && ownerFilterValue(task) !== ownerFilter) return false;
      if (dueFilter === "overdue" && !isOverdue(task)) return false;
      if (dueFilter === "today" && !isDueToday(task)) return false;
      if (dueFilter === "none" && task.dueAt) return false;
      return true;
    });
  }, [assignmentUserId, dueFilter, functionFilter, ownerFilter, priorityFilter, query, statusFilter, tasks, memberSelfView]);

  const sortedTasks = useMemo(() => sortAssignments(filteredTasks, sortBy), [filteredTasks, sortBy]);
  const cancelledTasks = useMemo(() => filteredTasks.filter((task) => task.status === "Cancelled"), [filteredTasks]);
  const boardStatusColumns = cancelledTasks.length ? [...boardStatuses, "Cancelled" as AssignmentStatus] : boardStatuses;
  const activeCount = filteredTasks.filter((task) => !terminalStatuses.has(task.status)).length;
  const overdueCount = filteredTasks.filter((task) => isOverdue(task)).length;
  const unassignedCount = filteredTasks.filter((task) => ownerLabel(task) === "Unassigned").length;
  const assignedToMeActive = ownerFilter === ownerMine;
  const hasFilters =
    query.trim() ||
    statusFilter !== "all" ||
    priorityFilter !== "all" ||
    ownerFilter !== "all" ||
    functionFilter !== "all" ||
    dueFilter !== "all" ||
    sortBy !== "priority";

  function clearFilters() {
    setQuery("");
    setStatusFilter("all");
    setPriorityFilter("all");
    setOwnerFilter(memberSelfView ? ownerMine : "all");
    setFunctionFilter("all");
    setDueFilter("all");
    setSortBy("priority");
  }

  function toggleAssignedToMe() {
    setOwnerFilter((current) => (current === ownerMine ? "all" : ownerMine));
  }

  function openNewTask() {
    if (!activeSessionWritable) return;
    const next = emptyAssignment(activeSession?.id);
    setEditing(next);
    setEditorBaseline(JSON.stringify(next));
    setEditorError("");
    setActionError("");
    setEditorOpen(true);
  }

  function openTask(task: AssignmentTask) {
    const next = { ...task, dueAt: dateTimeInput(task.dueAt) };
    setEditing(next);
    setEditorBaseline(JSON.stringify(next));
    setEditorError("");
    setActionError("");
    setEditorOpen(true);
  }

  async function refreshAfterChange() {
    await Promise.all([load(), reload()]);
  }

  async function saveTask() {
    if (!activeSession || !canSaveCurrent || !isSessionWriteContextCurrent(activeSession, editing.sessionId) || !(await verifyActiveSessionWrite(editing.sessionId))) {
      setEditorError("The session changed or is no longer writable. This assignment was not saved.");
      return;
    }
    const payload = normalizeAssignmentPayload(editing, activeSession.id);
    if (!payload.title) {
      setEditorError("Title is required.");
      return;
    }
    setSaving(true);
    setEditorError("");
    try {
      if (editing.id) {
        await api.update("assignments", editing.id, { ...payload, expectedVersion: editing.version });
      }
      else {
        const operationKey = `create:${activeSession.id}:${payload.title}`;
        await api.create("assignments", { ...payload, operationId: operationIdFor(operationKey) });
        finishOperation(operationKey);
      }
      setFeedback(editing.id ? "Assignment details updated." : "New assignment created in Open state.");
      setEditorOpen(false);
      setEditorBaseline("");
      setEditing(emptyAssignment(activeSession.id));
      await refreshAfterChange();
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : "Unable to save assignment");
    } finally {
      setSaving(false);
    }
  }

  async function updateStatus(task: AssignmentTask, status: AssignmentStatus) {
    const key = `status:${task.id}:${status}`;
    if (!task.id || busyKey || !canUpdate || (!canManageOwners && !ownsTask(task)) || !isSessionWriteContextCurrent(activeSession, task.sessionId) || !(await verifyActiveSessionWrite(task.sessionId))) {
      setActionError("The session, assignment state or ownership changed. The status was not updated.");
      return false;
    }
    setBusyKey(key);
    setActionError("");
    try {
      const action = status === "In Progress" ? (task.status === "Escalated" ? "resume" : "start") : status === "Completed" ? "complete" : status === "Cancelled" ? "cancel" : "escalate";
      const operationKey = `${action}:${task.id}:${task.version}`;
      await api.action("assignments", task.id!, action, {
        sessionId: task.sessionId,
        expectedVersion: task.version,
        ...(["complete", "cancel"].includes(action) ? { operationId: operationIdFor(operationKey) } : {})
      });
      if (["complete", "cancel"].includes(action)) finishOperation(operationKey);
      setFeedback(`${task.operationalId ?? "Assignment"} moved from ${task.status} to ${status}.`);
      await refreshAfterChange();
      return true;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to update assignment status");
      return false;
    } finally {
      setBusyKey("");
    }
  }

  async function assignToMe(task: AssignmentTask) {
    const key = `claim:${task.id}`;
    if (!task.id || busyKey || !canUpdate || task.status !== "Open" || ownerLabel(task) !== "Unassigned" || !isSessionWriteContextCurrent(activeSession, task.sessionId) || !(await verifyActiveSessionWrite(task.sessionId))) {
      setActionError("Only currently unassigned open work can be claimed.");
      return;
    }
    setBusyKey(key);
    setActionError("");
    try {
      const operationKey = `claim:${task.id}:${task.version}`;
      await api.action("assignments", task.id, "claim", { sessionId: task.sessionId, expectedVersion: task.version, operationId: operationIdFor(operationKey) });
      finishOperation(operationKey);
      setFeedback(`${task.operationalId ?? "Assignment"} claimed by ${assignmentIdentity}.`);
      await refreshAfterChange();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to claim assignment");
    } finally {
      setBusyKey("");
    }
  }

  async function assignEditingToMe() {
    if (!editing.id || !canUpdate || !isSessionWriteContextCurrent(activeSession, editing.sessionId) || !(await verifyActiveSessionWrite(editing.sessionId))) {
      setEditorError("The session changed or is closed. The assignment was not claimed.");
      return;
    }
    setSaving(true);
    setEditorError("");
    try {
      const operationKey = `claim:${editing.id}:${editing.version}`;
      const record = await api.action<AssignmentTask>("assignments", editing.id, "claim", { sessionId: editing.sessionId, expectedVersion: editing.version, operationId: operationIdFor(operationKey) });
      finishOperation(operationKey);
      setEditing({ ...record, dueAt: dateTimeInput(record.dueAt) });
      await refreshAfterChange();
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : "Unable to assign task");
    } finally {
      setSaving(false);
    }
  }

  async function confirmOwnerAction() {
    if (!ownerAction?.task.id || busyKey) return;
    const assigneeUserId = ownerAction.assigneeUserId.trim();
    const reason = ownerAction.reason.trim();
    const assignee = assigneeOptions.find((option) => option.id === assigneeUserId);
    if (!assignee || (ownerAction.mode === "reassign" && reason.length < 3)) {
      setOwnerAction((current) => current ? { ...current, error: current.mode === "reassign" ? "Select a new assignee and enter a handover reason." : "Select an assignee." } : current);
      return;
    }
    if (assignee.id === ownerUserId(ownerAction.task)) {
      setOwnerAction((current) => current ? { ...current, error: "Select a different assignee." } : current);
      return;
    }
    if (!isSessionWriteContextCurrent(activeSession, ownerAction.task.sessionId) || !(await verifyActiveSessionWrite(ownerAction.task.sessionId))) {
      setOwnerAction((current) => current ? { ...current, error: "The session changed or is closed. Ownership was not changed." } : current);
      return;
    }
    setBusyKey(`${ownerAction.mode}:${ownerAction.task.id}`);
    setOwnerAction((current) => current ? { ...current, error: "" } : current);
    try {
      const operationKey = `${ownerAction.mode}:${ownerAction.task.id}:${ownerAction.task.version}`;
      await api.action("assignments", ownerAction.task.id, ownerAction.mode, {
        sessionId: ownerAction.task.sessionId,
        expectedVersion: ownerAction.task.version,
        operationId: operationIdFor(operationKey),
        assignedUserId: assignee.id,
        reason: reason || undefined
      });
      finishOperation(operationKey);
      setFeedback(`${ownerAction.task.operationalId ?? "Assignment"} ${ownerAction.mode === "assign" ? "assigned" : "reassigned"} to ${assignee.displayName}.`);
      setOwnerAction(null);
      await refreshAfterChange();
    } catch (err) {
      setOwnerAction((current) => current ? { ...current, error: err instanceof Error ? err.message : "Unable to change assignment owner" } : current);
    } finally {
      setBusyKey("");
    }
  }

  async function confirmReasonAction() {
    if (!reasonTarget?.task.id || busyKey) return;
    const reason = decisionNote.trim();
    if (reason.length < 3) {
      setActionError("Enter a reason of at least 3 characters.");
      return;
    }
    const { task, action } = reasonTarget;
    if (!isSessionWriteContextCurrent(activeSession, task.sessionId) || !(await verifyActiveSessionWrite(task.sessionId))) {
      setActionError("The session changed or is closed. The workflow action was not applied.");
      return;
    }
    setBusyKey(`${action}:${task.id}`);
    setActionError("");
    try {
      const operationKey = `${action}:${task.id}:${task.version}`;
      await api.action("assignments", task.id!, action, {
        sessionId: task.sessionId,
        expectedVersion: task.version,
        reason,
        ...(action === "cancel" ? { operationId: operationIdFor(operationKey) } : {})
      });
      if (action === "cancel") finishOperation(operationKey);
      setFeedback(`${task.operationalId ?? "Assignment"} ${action === "cancel" ? "cancelled" : "escalated"}.`);
      setReasonTarget(null);
      setDecisionNote("");
      await refreshAfterChange();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to update assignment workflow");
    } finally {
      setBusyKey("");
    }
  }

  function renderActions(task: AssignmentTask, mode: "default" | "compact" | "queue" = "default") {
    const compact = mode === "compact";
    const queueMode = mode === "queue";
    return (
      <div className={clsx("flex flex-wrap gap-1.5", compact ? "items-center" : queueMode ? "items-center justify-start xl:justify-end" : "items-center justify-end")}>
        <Button icon={canEditTask(task) ? Pencil : Search} size="sm" variant="secondary" onClick={() => openTask(task)}>
          {canEditTask(task) ? "Edit" : "View"}
        </Button>
        {canUpdate && task.status === "Open" && ownerLabel(task) === "Unassigned" ? (
          <Button aria-label="Claim" icon={UserCheck} size="sm" variant="ghost" disabled={Boolean(busyKey)} onClick={() => assignToMe(task)}>
            Claim
          </Button>
        ) : null}
        {canManageOwners && task.status === "Open" && ownerLabel(task) === "Unassigned" ? <Button size="sm" variant="secondary" disabled={Boolean(busyKey)} onClick={() => setOwnerAction({ mode: "assign", task, assigneeUserId: "", reason: "", error: "" })}>Assign</Button> : null}
        {canManageOwners && !terminalStatuses.has(task.status) && ownerLabel(task) !== "Unassigned" ? <Button size="sm" variant="secondary" disabled={Boolean(busyKey)} onClick={() => setOwnerAction({ mode: "reassign", task, assigneeUserId: "", reason: "", error: "" })}>Reassign</Button> : null}
        {canUpdate && task.assigneeEligible !== false && ownerLabel(task) !== "Unassigned" && (canManageOwners || ownsTask(task))
          ? nextActions(task.status).map((action) => (
              <Button key={action.status} icon={action.icon} size="sm" variant={action.variant} disabled={Boolean(busyKey)} onClick={() => action.status === "Completed" ? setTerminalTarget({ task, status: "Completed" }) : action.status === "Escalated" ? (setDecisionNote(""), setReasonTarget({ task, action: "escalate" })) : void updateStatus(task, action.status)}>
                {busyKey === `status:${task.id}:${action.status}` ? "Working" : action.label}
              </Button>
            ))
          : null}
        {canManageOwners && !terminalStatuses.has(task.status) && ownerLabel(task) !== "Unassigned" ? <Button icon={XCircle} size="sm" variant="ghost" disabled={Boolean(busyKey)} onClick={() => { setDecisionNote(""); setReasonTarget({ task, action: "cancel" }); }}>Cancel</Button> : null}
      </div>
    );
  }

  const queue = (
    <Panel>
      <PanelBody className="p-0">
        <div className="border-b border-slate-200 px-3 py-2.5">
          <SectionHeader
            title="Queue"
            description="Start with Assigned to me. If it is empty, claim one unassigned task you can safely handle, then update its status."
            action={
              <div className="flex flex-wrap gap-1.5">
                <Badge tone="navy">{sortedTasks.length} of {total}</Badge>
                <Badge tone={activeCount ? "petrol" : "neutral"}>{activeCount} active</Badge>
                {overdueCount ? <Badge tone="danger">{overdueCount} overdue</Badge> : null}
                {unassignedCount ? <Badge tone="warning">{unassignedCount} unassigned</Badge> : null}
              </div>
            }
          />
        </div>
        {sortedTasks.length ? (
          <div role="table" aria-label="Assignment queue">
            <div role="rowgroup" className="hidden border-b border-slate-200 bg-slate-50 xl:block">
              <div
                role="row"
                className="grid grid-cols-[minmax(20rem,1.5fr)_minmax(8rem,0.55fr)_minmax(8rem,0.6fr)_minmax(7.5rem,0.5fr)_minmax(7.5rem,0.5fr)_minmax(15rem,0.9fr)] gap-3 px-3 py-2 text-xs font-black uppercase tracking-wide text-slate-500"
              >
                <span role="columnheader">Task</span>
                <span role="columnheader">State</span>
                <span role="columnheader">Owner</span>
                <span role="columnheader">Due</span>
                <span role="columnheader">Updated</span>
                <span role="columnheader" className="text-right">Next action</span>
              </div>
            </div>
            <div role="rowgroup" className="divide-y divide-slate-100">
              {sortedTasks.map((task) => {
                const linked = linkedLabel(task);
                return (
                  <div
                    key={task.id ?? task.operationalId ?? task.title}
                    role="row"
                    className="grid gap-3 px-3 py-3 transition hover:bg-blue-50/40 xl:grid-cols-[minmax(20rem,1.5fr)_minmax(8rem,0.55fr)_minmax(8rem,0.6fr)_minmax(7.5rem,0.5fr)_minmax(7.5rem,0.5fr)_minmax(15rem,0.9fr)] xl:items-center"
                  >
                    <div role="cell" className="min-w-0">
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <Badge tone="navy" className="font-mono">{shortTaskId(task.operationalId)}</Badge>
                        {task.relatedFunction ? <Badge tone="petrol">{task.relatedFunction}</Badge> : null}
                        {linked !== "None" ? <Badge tone="neutral" className="xl:hidden">{linked}</Badge> : null}
                      </div>
                      <p className="mt-1 line-clamp-1 font-black leading-5 text-[#0B1F3A]">{task.title}</p>
                      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs font-semibold text-slate-500">
                        {task.details ? <span className="min-w-0 max-w-2xl truncate">{task.details}</span> : null}
                        {linked !== "None" ? <span className="hidden truncate xl:inline">Linked: {linked}</span> : null}
                      </div>
                    </div>

                    <div role="cell" className="min-w-0">
                      <p className="mb-1 text-[10px] font-black uppercase tracking-wide text-slate-400 xl:hidden">State</p>
                      <div className="flex flex-wrap gap-1.5">
                        <PriorityBadge value={task.priority} />
                        <StatusBadge value={task.status} />
                      </div>
                    </div>

                    <div role="cell" className="min-w-0">
                      <p className="mb-1 text-[10px] font-black uppercase tracking-wide text-slate-400 xl:hidden">Owner</p>
                      {ownerLabel(task) === "Unassigned" ? (
                        <Badge tone="warning">Unassigned</Badge>
                      ) : (
                        <>
                          <span className="block truncate text-sm font-bold text-slate-700">{ownerDisplayLabel(task)}</span>
                          {task.assigneeEligible === false ? <Badge tone="danger">Access revoked</Badge> : null}
                        </>
                      )}
                    </div>

                    <div role="cell" className="min-w-0">
                      <p className="mb-1 text-[10px] font-black uppercase tracking-wide text-slate-400 xl:hidden">Due</p>
                      {isOverdue(task) ? (
                        <Badge tone="danger">{formatDue(task.dueAt)}</Badge>
                      ) : (
                        <span className="block truncate text-sm font-bold text-slate-700">{formatDue(task.dueAt)}</span>
                      )}
                    </div>

                    <div role="cell" className="min-w-0">
                      <p className="mb-1 text-[10px] font-black uppercase tracking-wide text-slate-400 xl:hidden">Updated</p>
                      <span className="block truncate text-sm font-bold text-slate-700">{formatUpdated(task.updatedAt)}</span>
                    </div>

                    <div role="cell" className="min-w-0 xl:justify-self-end">
                      {renderActions(task, "queue")}
                    </div>
                  </div>
                );
              })}
            </div>
            {total > queuePageSize ? (
              <div className="flex items-center justify-between border-t border-slate-200 px-3 py-2">
                <span className="text-xs font-bold text-slate-500">Page {page + 1} of {Math.ceil(total / queuePageSize)}</span>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" disabled={page === 0 || loading} onClick={() => setPage((current) => Math.max(0, current - 1))}>Previous</Button>
                  <Button size="sm" variant="secondary" disabled={(page + 1) * queuePageSize >= total || loading} onClick={() => setPage((current) => current + 1)}>Next</Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="p-3">
            <EmptyState title="No assignments match this view" detail="Clear filters or select another owner view." action={<Button onClick={clearFilters}>Clear filters</Button>} />
          </div>
        )}
      </PanelBody>
    </Panel>
  );

  const board = (
    <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-4">
      {boardStatusColumns.map((status) => {
        const columnTasks = sortedTasks.filter((task) => task.status === status);
        const visibleColumnTasks = columnTasks.slice(0, boardColumnLimit);
        return (
          <div key={status} data-assignment-status={status}>
            <Panel className="min-w-0">
              <PanelBody className="p-3">
                <SectionHeader
                  title={status}
                  action={<Badge tone={columnTasks.length ? "petrol" : "neutral"}>{columnTasks.length}</Badge>}
                />
                <div className="scrollbar-soft mt-3 grid max-h-[calc(100vh-22rem)] min-h-32 gap-2 overflow-y-auto pr-1">
                  {visibleColumnTasks.length ? (
                    visibleColumnTasks.map((task) => (
                      <article key={task.id ?? task.operationalId ?? task.title} className="rounded-md border border-slate-200 bg-slate-50 p-2.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <PriorityBadge value={task.priority} />
                          {task.relatedFunction ? <Badge tone="petrol">{task.relatedFunction}</Badge> : null}
                        </div>
                        <h3 className="mt-2 line-clamp-2 font-black leading-5 text-[#0B1F3A]">{task.title}</h3>
                        <div className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs font-semibold text-slate-600">
                          <span className="text-slate-500">Owner</span>
                          <span className="truncate text-right text-slate-800">{ownerDisplayLabel(task)}</span>
                          <span className="text-slate-500">Due</span>
                          <span className={clsx("truncate text-right", isOverdue(task) ? "text-red-700" : "text-slate-800")}>{formatDue(task.dueAt)}</span>
                        </div>
                        <div className="mt-2">{renderActions(task, "compact")}</div>
                      </article>
                    ))
                  ) : (
                    <EmptyState title="No assignments in this status" detail="Tasks moved into this status will appear here." />
                  )}
                  {columnTasks.length > boardColumnLimit ? (
                    <div className="rounded-md border border-dashed border-slate-300 bg-white px-3 py-2 text-center text-xs font-bold text-slate-500">
                      {columnTasks.length - boardColumnLimit} more in queue
                    </div>
                  ) : null}
                </div>
              </PanelBody>
            </Panel>
          </div>
        );
      })}
    </div>
  );

  return (
    <>
      <PageIntro eyebrow="Operational task board" title="Assignments" description="Next: open Assigned to me, claim one safe task if needed, then move it to In Progress or Complete." />

      <div className="grid gap-4">
        {feedback ? <AlertBox tone="success" dismissible={false}>{feedback}</AlertBox> : null}
        {actionError ? <AlertBox tone="warning" dismissible={false}>{actionError}</AlertBox> : null}
        {memberSelfView ? <AlertBox dismissible={false}>My active assignments - filtered to {assignmentIdentity}. Completed and cancelled records remain available to Group Leaders and Coordinators.</AlertBox> : null}
        <Panel>
          <PanelBody className="grid gap-3 p-3">
            <div className="grid gap-2 xl:grid-cols-[minmax(18rem,1fr)_auto] xl:items-center">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                <Input
                  aria-label="Search assignments"
                  className="h-9 pl-9"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search task, owner, function, case"
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {canCreate ? (
                  <Button icon={FilePlus2} variant="create" onClick={openNewTask}>
                    New assignment
                  </Button>
                ) : null}
                <Button
                  icon={UserCheck}
                  variant={assignedToMeActive ? "primary" : "secondary"}
                  aria-pressed={assignedToMeActive}
                  onClick={toggleAssignedToMe}
                >
                  {memberSelfView ? "My active assignments" : "Assigned to me"}
                </Button>
                <div className="inline-flex rounded-md border border-slate-200 bg-slate-100 p-0.5">
                  <button
                    type="button"
                    className={clsx(
                      "focus-ring inline-flex h-8 items-center gap-1.5 rounded px-2.5 text-sm font-bold",
                      viewMode === "queue" ? "bg-white text-[#0B1F3A] shadow-sm" : "text-slate-600 hover:text-slate-900"
                    )}
                    aria-pressed={viewMode === "queue"}
                    onClick={() => setViewMode("queue")}
                  >
                    <ListTodo className="h-4 w-4" />
                    Queue
                  </button>
                  <button
                    type="button"
                    className={clsx(
                      "focus-ring inline-flex h-8 items-center gap-1.5 rounded px-2.5 text-sm font-bold",
                      viewMode === "board" ? "bg-white text-[#0B1F3A] shadow-sm" : "text-slate-600 hover:text-slate-900"
                    )}
                    aria-pressed={viewMode === "board"}
                    onClick={() => setViewMode("board")}
                  >
                    <Columns3 className="h-4 w-4" />
                    Board
                  </button>
                </div>
                {hasFilters ? (
                  <Button icon={FilterX} className="h-9" variant="secondary" onClick={clearFilters}>
                    Clear
                  </Button>
                ) : null}
              </div>
            </div>

            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-[0.9fr_0.9fr_1.1fr_1.1fr_0.9fr_1.2fr]">
              <Field label="Status">
                <Select className="h-9" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as "all" | AssignmentStatus)}>
                  <option value="all">All status</option>
                  {statusOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Priority">
                <Select className="h-9" value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value as "all" | AssignmentPriority)}>
                  <option value="all">All priority</option>
                  {priorityOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Owner">
                <Select aria-label="Owner filter" className="h-9" value={ownerFilter} onChange={(event) => setOwnerFilter(event.target.value)}>
                  <option value="all">All owners</option>
                  <option value={ownerMine}>My tasks</option>
                  <option value={ownerUnassigned}>Unassigned</option>
                  {ownerOptions.map((owner) => (
                    <option key={owner.value} value={owner.value}>
                      {owner.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Function">
                <Select className="h-9" value={functionFilter} onChange={(event) => setFunctionFilter(event.target.value)}>
                  <option value="all">All functions</option>
                  {functionOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Due">
                <Select className="h-9" value={dueFilter} onChange={(event) => setDueFilter(event.target.value as DueFilter)}>
                  <option value="all">All due</option>
                  <option value="overdue">Overdue</option>
                  <option value="today">Due today</option>
                  <option value="none">No due time</option>
                </Select>
              </Field>
              <Field label="Sort">
                <Select className="h-9" value={sortBy} onChange={(event) => setSortBy(event.target.value as SortMode)}>
                  <option value="priority">Priority and due</option>
                  <option value="due">Due soon</option>
                  <option value="status">Status</option>
                  <option value="owner">Owner</option>
                  <option value="updated">Recently updated</option>
                </Select>
              </Field>
            </div>
          </PanelBody>
        </Panel>

        {loading ? <Loading label="Loading assignments" /> : error ? <EmptyState title="Unable to load assignments" detail={error} action={<Button onClick={() => void load()}>Retry</Button>} /> : viewMode === "queue" ? queue : board}
      </div>

      {editorOpen ? (
        <DialogSurface
          title={editing.id ? "Edit Assignment" : "New Assignment"}
          description={editing.operationalId ?? activeSession?.operationalId ?? "Unsaved task"}
          dirty={canSaveCurrent && Boolean(editorBaseline && JSON.stringify(editing) !== editorBaseline)}
          busy={saving}
          onClose={() => setEditorOpen(false)}
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-lg flex-col border-l border-border bg-card text-foreground shadow-2xl"
        >
          {({ requestClose }) => (
          <>
            <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
              <div className="min-w-0">
                <h2 data-dialog-heading="true" tabIndex={-1} className="truncate text-lg font-black text-foreground">{editing.id ? "Edit assignment" : "New assignment"}</h2>
                <p className="mt-1 truncate text-sm font-semibold text-muted-foreground">{editing.operationalId ?? activeSession?.operationalId ?? "Unsaved task"}</p>
                <p className="mt-1 text-xs font-semibold leading-5 text-muted-foreground">
                  Use a clear action title and keep details suitable for handover. Ownership and status use dedicated actions.
                </p>
              </div>
              <Button icon={XCircle} variant="ghost" disabled={saving} onClick={() => requestClose()}>
                Close
              </Button>
            </div>

            <form
              className="scrollbar-soft flex-1 overflow-y-auto px-5 py-4"
              onSubmit={(event) => {
                event.preventDefault();
                void saveTask();
              }}
            >
              <div className="grid gap-4">
                <div className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-border bg-muted px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-black text-foreground">{editing.operationalId ?? "Unsaved assignment"}</p>
                    <p className="mt-0.5 truncate text-xs font-semibold text-muted-foreground">{activeSession?.operationalId ?? "No active session"}</p>
                  </div>
                  <StatusBadge value={editing.status} />
                </div>

                <div className="rounded-md border border-[#145C63]/25 bg-[#145C63]/10 px-3 py-2 text-xs font-semibold leading-5 text-[#145C63]">
                  Required fields are marked. Generic editing cannot change assignment ownership or workflow status.
                </div>

                {editing.assigneeEligibilityMessage ? <AlertBox tone="warning" dismissible={false}>{editing.assigneeEligibilityMessage}</AlertBox> : null}

                {terminalStatuses.has(editing.status) ? (
                  <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
                    <p className="font-black text-slate-900">Terminal decision provenance</p>
                    <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs font-semibold text-slate-600">
                      <dt>Decision</dt><dd className="text-right text-slate-900">{editing.status}</dd>
                      <dt>Actor</dt><dd className="text-right text-slate-900">{editing.completedBy?.displayName ?? editing.cancelledBy?.displayName ?? "Historical actor unavailable"}</dd>
                      <dt>Time</dt><dd className="text-right text-slate-900">{formatUpdated(editing.completedAt ?? editing.cancelledAt)}</dd>
                      <dt>Reason / note</dt><dd className="break-words text-right text-slate-900">{editing.completionNote ?? editing.cancelReason ?? "Not recorded"}</dd>
                    </dl>
                  </div>
                ) : null}

                <ErrorSummary title="Assignment could not be saved" errors={editorError ? [{ message: editorError, fieldId: !String(editing.title ?? "").trim() ? "assignment-title" : undefined }] : []} />

                {!canSaveCurrent ? (
                  <EmptyState title="Read-only access" detail="This profile can review assignments but cannot modify them." />
                ) : null}

                <Field id="assignment-title" label="Title" required error={editorError && !String(editing.title ?? "").trim() ? "Title is required." : undefined}>
                  <Input
                    value={editing.title ?? ""}
                    readOnly={!canSaveCurrent}
                    disabled={saving}
                    onChange={(event) => setEditing((current) => ({ ...current, title: event.target.value }))}
                    placeholder="Task to complete"
                  />
                </Field>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Current status">
                    <div className="flex min-h-10 items-center rounded-md border border-border bg-muted px-3"><StatusBadge value={editing.status} /></div>
                    <p className="mt-1 text-xs font-semibold text-muted-foreground">Read-only here; use a valid workflow action from the queue.</p>
                  </Field>
                  <Field label="Priority">
                    <Select
                      value={editing.priority}
                      readOnly={!canSaveCurrent}
                      disabled={saving}
                      onChange={(event) => setEditing((current) => ({ ...current, priority: event.target.value as AssignmentPriority }))}
                    >
                      {priorityOptions.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Current assignee">
                    <div className="flex min-h-10 items-center rounded-md border border-border bg-muted px-3 text-sm font-bold text-foreground">{ownerDisplayLabel(editing)}</div>
                    <p className="mt-1 text-xs font-semibold text-muted-foreground">Claim, Assign and Reassign are separate audited actions.</p>
                  </Field>
                  <Field label="Due">
                    <Input
                      type="datetime-local"
                      value={editing.dueAt ?? ""}
                      readOnly={!canSaveCurrent}
                      disabled={saving}
                      onChange={(event) => setEditing((current) => ({ ...current, dueAt: event.target.value }))}
                    />
                  </Field>
                </div>

                <Field label="Function">
                  <Select
                    value={editing.relatedFunction ?? ""}
                    readOnly={!canSaveCurrent}
                    disabled={saving}
                    onChange={(event) => setEditing((current) => ({ ...current, relatedFunction: event.target.value }))}
                  >
                    <option value="">Select function</option>
                    {functionOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </Select>
                </Field>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Linked record">
                    <Input
                      value={editing.linkedRecord ?? ""}
                      readOnly={!canSaveCurrent}
                      disabled={saving}
                      onChange={(event) => setEditing((current) => ({ ...current, linkedRecord: event.target.value }))}
                      placeholder="REQ-2026-000001"
                    />
                  </Field>
                  <Field label="Case ID">
                    <Input
                      value={editing.caseId ?? ""}
                      readOnly={!canSaveCurrent}
                      disabled={saving}
                      onChange={(event) => setEditing((current) => ({ ...current, caseId: event.target.value }))}
                      placeholder="CASE-2026-0001"
                    />
                  </Field>
                </div>

                <Field label="Details">
                  <Textarea
                    value={editing.details ?? ""}
                    readOnly={!canSaveCurrent}
                    disabled={saving}
                    onChange={(event) => setEditing((current) => ({ ...current, details: event.target.value }))}
                    placeholder="Operational notes, handover detail or acceptance criteria"
                  />
                </Field>

                {editing.id && canUpdate && editing.status === "Open" && ownerLabel(editing) === "Unassigned" ? (
                  <Button type="button" icon={UserCheck} variant="secondary" disabled={saving} onClick={assignEditingToMe}>
                    Claim
                  </Button>
                ) : null}
              </div>
            </form>

            {canSaveCurrent ? (
              <div className="border-t border-border bg-card p-4">
                <Button className="w-full" icon={Save} variant="primary" disabled={saving} onClick={saveTask}>
                  {saving ? "Saving..." : editing.id ? "Save changes" : "Create assignment"}
                </Button>
              </div>
            ) : null}
          </>
          )}
        </DialogSurface>
      ) : null}

      {ownerAction ? (
        <DialogSurface
          title={ownerAction.mode === "assign" ? "Assign work" : "Reassign work"}
          description={`${ownerAction.task.operationalId} · Current assignee: ${ownerDisplayLabel(ownerAction.task)}`}
          dirty={Boolean(ownerAction.assigneeUserId || ownerAction.reason)}
          busy={Boolean(busyKey)}
          onClose={() => setOwnerAction(null)}
          layer="nested"
          className="fixed inset-y-0 right-0 z-[90] flex w-full max-w-md flex-col border-l border-border bg-card shadow-2xl"
        >
          {({ requestClose }) => (
          <>
            <div className="flex items-start justify-between gap-3 border-b border-border p-4">
              <div>
                <h2 data-dialog-heading="true" tabIndex={-1} className="text-lg font-black text-foreground">{ownerAction.mode === "assign" ? "Assign work" : "Reassign work"}</h2>
                <p className="mt-1 text-sm font-semibold text-muted-foreground">{ownerAction.task.operationalId} · Current assignee: {ownerDisplayLabel(ownerAction.task)}</p>
              </div>
              <Button icon={XCircle} variant="ghost" disabled={Boolean(busyKey)} onClick={() => requestClose()}>Close</Button>
            </div>
            <div className="scrollbar-soft grid flex-1 content-start gap-4 overflow-y-auto p-5">
              <ErrorSummary title="Ownership could not be changed" errors={ownerAction.error ? [{ message: ownerAction.error, fieldId: !ownerAction.assigneeUserId ? "assignment-assignee" : ownerAction.mode === "reassign" && ownerAction.reason.trim().length < 3 ? "assignment-handover" : undefined }] : []} />
              <Field id="assignment-assignee" label="New assignee" required error={ownerAction.error && !ownerAction.assigneeUserId ? "Select a new assignee." : undefined}>
                <Select value={ownerAction.assigneeUserId} disabled={Boolean(busyKey)} onChange={(event) => setOwnerAction((current) => current ? { ...current, assigneeUserId: event.target.value, error: "" } : current)}>
                  <option value="">Select assignee</option>
                  {assigneeOptions.filter((owner) => owner.id !== ownerUserId(ownerAction.task)).map((owner) => <option key={owner.id} value={owner.id}>{owner.displayName}</option>)}
                </Select>
              </Field>
              {ownerAction.mode === "reassign" ? (
                <Field id="assignment-handover" label="Handover reason" required error={ownerAction.error && ownerAction.reason.trim().length < 3 ? "Enter a handover reason." : undefined}>
                  <Textarea value={ownerAction.reason} disabled={Boolean(busyKey)} onChange={(event) => setOwnerAction((current) => current ? { ...current, reason: event.target.value, error: "" } : current)} placeholder="Why ownership is changing and what the new assignee needs to know" />
                </Field>
              ) : null}
            </div>
            <div className="border-t border-border p-4">
              <Button className="w-full" icon={UserCheck} variant="primary" disabled={Boolean(busyKey)} onClick={confirmOwnerAction}>{busyKey ? "Saving" : ownerAction.mode === "assign" ? "Assign work" : "Confirm reassignment"}</Button>
            </div>
          </>
          )}
        </DialogSurface>
      ) : null}
      {terminalTarget ? (
        <ConfirmDialog
          title={terminalTarget.status === "Completed" ? "Complete assignment?" : "Cancel assignment?"}
          recordLabel={`${terminalTarget.task.operationalId ?? "Assignment"} · ${terminalTarget.task.title}`}
          description={terminalTarget.status === "Completed" ? "The assignment will move to Completed and become read-only. This terminal transition is not reversible from the assignment board." : "The assignment will move to Cancelled and become read-only. This terminal transition is not reversible from the assignment board."}
          confirmLabel={terminalTarget.status === "Completed" ? "Complete assignment" : "Cancel assignment"}
          confirmVariant={terminalTarget.status === "Completed" ? "success" : "danger"}
          confirmIcon={terminalTarget.status === "Completed" ? CheckCircle2 : XCircle}
          busy={Boolean(busyKey)}
          error={actionError}
          onCancel={() => setTerminalTarget(null)}
          onConfirm={async () => { if (await updateStatus(terminalTarget.task, terminalTarget.status)) setTerminalTarget(null); }}
        />
      ) : null}
      {reasonTarget ? (
        <DecisionDialog
          title={reasonTarget.action === "cancel" ? "Cancel assignment?" : "Escalate assignment?"}
          description={`${reasonTarget.task.operationalId ?? "Assignment"} · ${reasonTarget.task.title}. The reason is written to the audit and incident timeline.`}
          label={reasonTarget.action === "cancel" ? "Cancellation reason" : "Escalation reason"}
          value={decisionNote}
          onChange={(value) => { setDecisionNote(value); setActionError(""); }}
          onCancel={() => { setReasonTarget(null); setDecisionNote(""); setActionError(""); }}
          onConfirm={confirmReasonAction}
          confirmLabel={reasonTarget.action === "cancel" ? "Cancel assignment" : "Escalate assignment"}
          confirmIcon={reasonTarget.action === "cancel" ? XCircle : Siren}
          confirmVariant={reasonTarget.action === "cancel" ? "danger" : "warning"}
          error={actionError}
          busy={Boolean(busyKey)}
          required
          placeholder="Give operational context for this decision"
        />
      ) : null}
    </>
  );
}
