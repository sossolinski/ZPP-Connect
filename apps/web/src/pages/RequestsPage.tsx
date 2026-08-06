import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FilePlus2,
  Pause,
  Pencil,
  PlayCircle,
  RotateCcw,
  Save,
  Search,
  UserCheck,
  UserMinus,
  XCircle,
} from "lucide-react";
import { ApiRequestError, api } from "../lib/api";
import { useApp } from "../lib/app-context";
import type { AnyRecord } from "../lib/types";
import {
  AlertBox,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Loading,
  Select,
  StatusBadge,
  Table,
  Textarea,
} from "../components/ui";
import { DialogSurface } from "../components/DialogSurface";

type RequestRecord = AnyRecord & {
  id: string;
  operationalId: string;
  sessionId: string;
  status: string;
  priority: string;
  version: number;
  overdue?: boolean;
};
type Assignee = { id: string; displayName: string; email: string };
const statuses = [
  "OPEN",
  "ASSIGNED",
  "IN_PROGRESS",
  "WAITING",
  "RESOLVED",
  "CANCELLED",
];
const pageSizes = [10, 25, 50, 100];
const terminal = new Set(["RESOLVED", "CANCELLED"]);
const conflictCopy =
  "Request został zmieniony przez innego operatora. Odśwież dane przed ponownym wykonaniem operacji.";
const displayStatus = (value: unknown) =>
  String(value ?? "Unknown").replaceAll("_", " ");
const date = (value: unknown) =>
  value
    ? new Intl.DateTimeFormat("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(String(value)))
    : "Not set";
const dateInput = (value: unknown) =>
  value ? new Date(String(value)).toISOString().slice(0, 16) : "";

export function RequestsPage() {
  const {
    activeSession,
    activeSessionWritable,
    can,
    dictionaries,
    verifyActiveSessionWrite,
  } = useApp();
  const [rows, setRows] = useState<RequestRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [owner, setOwner] = useState("");
  const [due, setDue] = useState("");
  const [category, setCategory] = useState("");
  const [sortBy, setSortBy] = useState("updatedAt");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [selected, setSelected] = useState<RequestRecord | null>(null);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<AnyRecord>({
    category: "Other",
    priority: "Normal",
    details: "",
    requester: "",
    dueAt: "",
    notes: "",
  });
  const createOperationId = useRef(crypto.randomUUID());
  const [action, setAction] = useState("");
  const [actionReason, setActionReason] = useState("");
  const [actionOutcome, setActionOutcome] = useState("Completed as requested");
  const [actionOwner, setActionOwner] = useState("");
  const [actionPriority, setActionPriority] = useState("Normal");
  const actionOperationId = useRef(crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState("");

  const categoryOptions = dictionaries.requestCategories ?? [];
  const priorityOptions = dictionaries.requestPriorities ?? [];
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const offset = (page - 1) * pageSize;

  async function load() {
    if (!activeSession) {
      setRows([]);
      setTotal(0);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const result = await api.list<RequestRecord>("requests/queue", {
        sessionId: activeSession.id,
        search: search || undefined,
        status: status || undefined,
        priority: priority || undefined,
        ownerUserId: owner || undefined,
        due: due || undefined,
        category: category || undefined,
        sortBy,
        sortDirection,
        limit: pageSize,
        offset,
      });
      setRows(result.data);
      setTotal(result.total ?? result.data.length);
    } catch (value) {
      setError(
        value instanceof Error ? value.message : "Unable to load Requests",
      );
    } finally {
      setLoading(false);
    }
  }
  async function loadAssignees() {
    if (!activeSession || !can("request:assign")) return;
    try {
      setAssignees(
        (
          await api.list<Assignee>("requests/assignees", {
            sessionId: activeSession.id,
            limit: 200,
          })
        ).data,
      );
    } catch {
      setAssignees([]);
    }
  }
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 200);
    return () => window.clearTimeout(timer);
  }, [
    activeSession?.id,
    search,
    status,
    priority,
    owner,
    due,
    category,
    sortBy,
    sortDirection,
    page,
    pageSize,
  ]);
  useEffect(() => {
    void loadAssignees();
  }, [activeSession?.id]);
  useEffect(() => {
    setPage(1);
  }, [activeSession?.id, search, status, priority, owner, due, category]);

  async function open(row: RequestRecord) {
    if (!activeSession) return;
    setMutationError("");
    setAction("");
    try {
      const record = await api.record<RequestRecord>("requests", row.id, {
        sessionId: activeSession.id,
      });
      setSelected(record);
      setActionOwner(String(record.ownerUserId ?? ""));
      setActionPriority(String(record.priority));
    } catch (value) {
      setError(
        value instanceof Error ? value.message : "Unable to open Request",
      );
    }
  }
  async function refreshSelected() {
    if (selected) await open(selected);
    await load();
  }
  function operationFailure(value: unknown) {
    setMutationError(
      value instanceof ApiRequestError && value.status === 409
        ? conflictCopy
        : value instanceof Error
          ? value.message
          : "Operation failed",
    );
  }
  async function ensureWrite() {
    return Boolean(
      activeSession &&
      selected &&
      activeSessionWritable &&
      (await verifyActiveSessionWrite(selected.sessionId)),
    );
  }

  async function submitCreate(event: React.FormEvent) {
    event.preventDefault();
    if (!activeSession || !(await verifyActiveSessionWrite(activeSession.id)))
      return;
    setBusy(true);
    setMutationError("");
    try {
      await api.create("requests", {
        sessionId: activeSession.id,
        category: createForm.category,
        priority: createForm.priority,
        details: createForm.details,
        requester: createForm.requester || null,
        dueAt: createForm.dueAt
          ? new Date(String(createForm.dueAt)).toISOString()
          : null,
        notes: createForm.notes || null,
        operationId: createOperationId.current,
      });
      createOperationId.current = crypto.randomUUID();
      setCreateOpen(false);
      setCreateForm({
        category: "Other",
        priority: "Normal",
        details: "",
        requester: "",
        dueAt: "",
        notes: "",
      });
      await load();
    } catch (value) {
      operationFailure(value);
    } finally {
      setBusy(false);
    }
  }

  async function runAction() {
    if (!(await ensureWrite()) || !selected) return;
    setBusy(true);
    setMutationError("");
    try {
      const common = {
        sessionId: selected.sessionId,
        expectedVersion: selected.version,
      };
      if (action === "edit")
        await api.update("requests", selected.id, {
          ...common,
          details: selected.details,
          requester: selected.requester ?? null,
          notes: selected.notes ?? null,
          dueAt: selected.dueAt ?? null,
        });
      else if (action === "assign")
        await api.action("requests", selected.id, "assign", {
          ...common,
          ownerUserId: actionOwner,
          reason: actionReason || undefined,
        });
      else if (action === "unassign")
        await api.action("requests", selected.id, "unassign", {
          ...common,
          reason: actionReason,
        });
      else if (action === "priority")
        await api.action("requests", selected.id, "priority", {
          ...common,
          priority: actionPriority,
          reason: actionReason || undefined,
        });
      else if (action === "start" || action === "wait")
        await api.action("requests", selected.id, action, common);
      else if (action === "resolve")
        await api.action("requests", selected.id, "resolve", {
          ...common,
          outcome: actionOutcome,
          resolutionNote: actionReason,
          operationId: actionOperationId.current,
        });
      else if (action === "reopen" || action === "cancel")
        await api.action("requests", selected.id, action, {
          ...common,
          reason: actionReason,
          operationId: actionOperationId.current,
        });
      actionOperationId.current = crypto.randomUUID();
      setAction("");
      setActionReason("");
      await refreshSelected();
    } catch (value) {
      operationFailure(value);
    } finally {
      setBusy(false);
    }
  }

  const columns = useMemo(
    () => [
      { key: "operationalId", label: "Request", sortable: true },
      { key: "category", label: "Type", sortable: true },
      {
        key: "priority",
        label: "Priority",
        sortable: true,
        render: (row: AnyRecord) => (
          <StatusBadge value={String(row.priority)} />
        ),
      },
      {
        key: "status",
        label: "Status",
        sortable: true,
        render: (row: AnyRecord) => (
          <StatusBadge value={displayStatus(row.status)} />
        ),
      },
      {
        key: "owner",
        label: "Owner",
        sortable: true,
        render: (row: AnyRecord) => String(row.ownerAssignedTo ?? "Unassigned"),
      },
      {
        key: "dueAt",
        label: "Due",
        sortable: true,
        render: (row: AnyRecord) => (
          <span>
            {date(row.dueAt)}{" "}
            {row.overdue ? <Badge tone="danger">Overdue</Badge> : null}
          </span>
        ),
      },
      {
        key: "updatedAt",
        label: "Updated",
        sortable: true,
        render: (row: AnyRecord) => date(row.updatedAt),
      },
    ],
    [],
  );
  function sort(key: string) {
    const apiKey = key === "owner" ? "owner" : key;
    if (sortBy === apiKey)
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
    else {
      setSortBy(apiKey);
      setSortDirection("asc");
    }
    setPage(1);
  }
  const actionNeedsReason = [
    "unassign",
    "resolve",
    "reopen",
    "cancel",
  ].includes(action);
  const selectedTerminal = selected ? terminal.has(selected.status) : false;

  return (
    <div className="grid gap-4">
      <Card>
        <div className="grid gap-3 border-b border-border p-4 lg:grid-cols-[minmax(220px,1fr)_repeat(5,minmax(130px,auto))]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
            <Input
              aria-label="Search Requests"
              className="pl-9"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search ID, case, requester or details"
            />
          </div>
          <Select
            aria-label="Filter Request status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="">All statuses</option>
            {statuses.map((item) => (
              <option key={item} value={item}>
                {displayStatus(item)}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Filter Request priority"
            value={priority}
            onChange={(event) => setPriority(event.target.value)}
          >
            <option value="">All priorities</option>
            {priorityOptions.map((item) => (
              <option key={item.key} value={item.label}>
                {item.label}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Filter Request owner"
            value={owner}
            onChange={(event) => setOwner(event.target.value)}
          >
            <option value="">All owners</option>
            <option value="unassigned">Unassigned</option>
            {assignees.map((item) => (
              <option key={item.id} value={item.id}>
                {item.displayName}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Filter Request due date"
            value={due}
            onChange={(event) => setDue(event.target.value)}
          >
            <option value="">Any due date</option>
            <option value="overdue">Overdue</option>
            <option value="due">Has due date</option>
            <option value="none">No due date</option>
          </Select>
          <Select
            aria-label="Filter Request category"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            <option value="">All types</option>
            {categoryOptions.map((item) => (
              <option key={item.key} value={item.label}>
                {item.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-sm font-semibold text-muted-foreground">
            Server queue · {total} Requests
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              aria-label="Requests per page"
              className="w-28"
              value={pageSize}
              onChange={(event) => {
                setPageSize(Number(event.target.value));
                setPage(1);
              }}
            >
              {pageSizes.map((size) => (
                <option key={size} value={size}>
                  {size} rows
                </option>
              ))}
            </Select>
            {activeSessionWritable && can("request:create") ? (
              <Button
                icon={FilePlus2}
                variant="create"
                onClick={() => {
                  setMutationError("");
                  setCreateOpen(true);
                }}
              >
                New Request
              </Button>
            ) : null}
          </div>
        </div>
        <div className="px-4 pb-4">
          {loading ? (
            <Loading />
          ) : error ? (
            <EmptyState
              title="Unable to load Requests"
              detail={error}
              action={<Button onClick={() => void load()}>Retry</Button>}
            />
          ) : (
            <Table
              columns={columns}
              rows={rows}
              sortKey={sortBy}
              sortDirection={sortDirection}
              onSort={sort}
              onRowOpen={(row) => void open(row as RequestRecord)}
              rowLabel={(row) => `Open Request ${row.operationalId}`}
              rowClassName={(row) =>
                row.overdue ? "border-l-4 border-l-red-600" : undefined
              }
              emptyTitle="No Requests match this queue"
              emptyDetail="Change the server-side filters or create a Request."
            />
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border p-3">
          <Button
            icon={ChevronLeft}
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((value) => value - 1)}
          >
            Previous
          </Button>
          <span className="text-sm font-bold">
            {page} / {pages}
          </span>
          <Button
            icon={ChevronRight}
            size="sm"
            disabled={page >= pages}
            onClick={() => setPage((value) => value + 1)}
          >
            Next
          </Button>
        </div>
      </Card>

      {createOpen ? (
        <DialogSurface
          title="Create Request"
          description="Create an incident-scoped operational commitment."
          onClose={() => setCreateOpen(false)}
          busy={busy}
          dirty={Boolean(createForm.details)}
          initialFocus="first-control"
          className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100vw-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-card shadow-2xl"
        >
          <form className="grid gap-4 p-5" onSubmit={submitCreate}>
            <h2
              data-dialog-heading="true"
              tabIndex={-1}
              className="text-xl font-black"
            >
              New Request
            </h2>
            {mutationError ? (
              <AlertBox tone="danger">
                <strong>Request not created.</strong> {mutationError}
              </AlertBox>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Type" required>
                <Select
                  data-dialog-initial-focus="true"
                  value={String(createForm.category)}
                  onChange={(event) =>
                    setCreateForm({
                      ...createForm,
                      category: event.target.value,
                    })
                  }
                >
                  {categoryOptions.map((item) => (
                    <option key={item.key} value={item.label}>
                      {item.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Priority" required>
                <Select
                  value={String(createForm.priority)}
                  onChange={(event) =>
                    setCreateForm({
                      ...createForm,
                      priority: event.target.value,
                    })
                  }
                >
                  {priorityOptions.map((item) => (
                    <option key={item.key} value={item.label}>
                      {item.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Requester">
                <Input
                  value={String(createForm.requester)}
                  onChange={(event) =>
                    setCreateForm({
                      ...createForm,
                      requester: event.target.value,
                    })
                  }
                />
              </Field>
              <Field label="Due">
                <Input
                  type="datetime-local"
                  value={String(createForm.dueAt)}
                  onChange={(event) =>
                    setCreateForm({ ...createForm, dueAt: event.target.value })
                  }
                />
              </Field>
            </div>
            <Field label="Requested action / details" required>
              <Textarea
                value={String(createForm.details)}
                onChange={(event) =>
                  setCreateForm({ ...createForm, details: event.target.value })
                }
              />
            </Field>
            <Field label="Notes">
              <Textarea
                value={String(createForm.notes)}
                onChange={(event) =>
                  setCreateForm({ ...createForm, notes: event.target.value })
                }
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                icon={Save}
                variant="create"
                disabled={busy || !String(createForm.details).trim()}
              >
                {busy ? "Creating…" : "Create Request"}
              </Button>
            </div>
          </form>
        </DialogSurface>
      ) : null}

      {selected ? (
        <DialogSurface
          title={`Request ${selected.operationalId}`}
          description="Review facts, linked context and controlled workflow actions."
          onClose={() => setSelected(null)}
          busy={busy}
          className="fixed right-0 top-0 z-50 h-full w-[min(100vw,46rem)] overflow-y-auto border-l border-border bg-card shadow-2xl"
        >
          <div className="grid gap-5 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2
                  data-dialog-heading="true"
                  tabIndex={-1}
                  className="text-xl font-black"
                >
                  {selected.operationalId}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Version {selected.version} · updated{" "}
                  {date(selected.updatedAt)}
                </p>
              </div>
              <div className="flex gap-2">
                <StatusBadge value={displayStatus(selected.status)} />
                <StatusBadge value={String(selected.priority)} />
                {selected.overdue ? <Badge tone="danger">Overdue</Badge> : null}
              </div>
            </div>
            {mutationError ? (
              <AlertBox tone="danger">
                <strong>Operation not completed.</strong> {mutationError}
                <div className="mt-3">
                  <Button onClick={() => void refreshSelected()}>
                    Refresh Request
                  </Button>
                </div>
              </AlertBox>
            ) : null}
            <Card className="p-4">
              <dl className="grid gap-3 sm:grid-cols-2">
                <div>
                  <dt className="text-xs font-black uppercase text-muted-foreground">
                    Type
                  </dt>
                  <dd>{selected.category}</dd>
                </div>
                <div>
                  <dt className="text-xs font-black uppercase text-muted-foreground">
                    Owner
                  </dt>
                  <dd>{selected.ownerAssignedTo ?? "Unassigned"}</dd>
                </div>
                <div>
                  <dt className="text-xs font-black uppercase text-muted-foreground">
                    Due
                  </dt>
                  <dd>{date(selected.dueAt)}</dd>
                </div>
                <div>
                  <dt className="text-xs font-black uppercase text-muted-foreground">
                    Requester
                  </dt>
                  <dd>{selected.requester ?? "Not recorded"}</dd>
                </div>
              </dl>
              <p className="mt-4 whitespace-pre-wrap text-sm">
                {selected.details}
              </p>
            </Card>
            <Card className="p-4">
              <h3 className="font-black">Linked context</h3>
              <div className="mt-3 grid gap-2 text-sm">
                {Object.entries(selected.linkedContext ?? {})
                  .filter(([, value]) => value)
                  .map(([key, value]: [string, any]) => (
                    <p key={key}>
                      <span className="font-bold capitalize">{key}:</span>{" "}
                      {value.operationalId} ·{" "}
                      {displayStatus(
                        value.status ??
                          value.verificationStatus ??
                          value.holdStatus,
                      )}
                    </p>
                  ))}
                {!Object.values(selected.linkedContext ?? {}).some(Boolean) ? (
                  <p className="text-muted-foreground">
                    No linked context is visible with your source-domain
                    permissions.
                  </p>
                ) : null}
              </div>
            </Card>
            {selected.resolvedAt ? (
              <AlertBox tone="success">
                <strong>Resolved {date(selected.resolvedAt)}.</strong>{" "}
                {selected.resolutionOutcome ?? "Outcome unavailable"}:{" "}
                {selected.resolutionNote ??
                  "Legacy resolution evidence unavailable"}
              </AlertBox>
            ) : null}
            {selected.reopenedAt ? (
              <AlertBox tone="warning">
                <strong>Reopened {date(selected.reopenedAt)}.</strong>{" "}
                {selected.reopenReason ?? "Reopen reason unavailable"}
              </AlertBox>
            ) : null}
            {selected.cancelledAt ? (
              <AlertBox tone="warning">
                <strong>Cancelled {date(selected.cancelledAt)}.</strong>{" "}
                {selected.cancelReason ??
                  "Legacy cancellation reason unavailable"}
              </AlertBox>
            ) : null}
            {activeSessionWritable ? (
              <Card className="p-4">
                <h3 className="font-black">Controlled actions</h3>
                <div className="mt-3 flex flex-wrap gap-2">
                  {can("request:update") && !selectedTerminal ? (
                    <>
                      <Button icon={Pencil} onClick={() => setAction("edit")}>
                        Edit facts
                      </Button>
                      {["OPEN", "ASSIGNED", "WAITING"].includes(
                        selected.status,
                      ) ? (
                        <Button
                          icon={PlayCircle}
                          onClick={() => setAction("start")}
                        >
                          Start
                        </Button>
                      ) : null}
                      {["OPEN", "ASSIGNED", "IN_PROGRESS"].includes(
                        selected.status,
                      ) ? (
                        <Button icon={Pause} onClick={() => setAction("wait")}>
                          Wait
                        </Button>
                      ) : null}
                      <Button onClick={() => setAction("priority")}>
                        Priority
                      </Button>
                    </>
                  ) : null}
                  {can("request:assign") && !selectedTerminal ? (
                    <>
                      <Button
                        icon={UserCheck}
                        onClick={() => setAction("assign")}
                      >
                        Assign
                      </Button>
                      {selected.ownerUserId ? (
                        <Button
                          icon={UserMinus}
                          onClick={() => setAction("unassign")}
                        >
                          Unassign
                        </Button>
                      ) : null}
                    </>
                  ) : null}
                  {can("request:close") ? (
                    <>
                      {selected.status === "RESOLVED" ? (
                        <Button
                          icon={RotateCcw}
                          variant="warning"
                          onClick={() => setAction("reopen")}
                        >
                          Reopen
                        </Button>
                      ) : !selectedTerminal ? (
                        <Button
                          icon={CheckCircle2}
                          variant="success"
                          onClick={() => setAction("resolve")}
                        >
                          Resolve
                        </Button>
                      ) : null}
                      {!selectedTerminal ? (
                        <Button
                          icon={XCircle}
                          variant="danger"
                          onClick={() => setAction("cancel")}
                        >
                          Cancel
                        </Button>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </Card>
            ) : null}
            {action ? (
              <Card className="grid gap-3 p-4">
                <h3 className="font-black capitalize">{action} Request</h3>
                {action === "edit" ? (
                  <>
                    <Field label="Details">
                      <Textarea
                        value={String(selected.details)}
                        onChange={(event) =>
                          setSelected({
                            ...selected,
                            details: event.target.value,
                          })
                        }
                      />
                    </Field>
                    <Field label="Requester">
                      <Input
                        value={String(selected.requester ?? "")}
                        onChange={(event) =>
                          setSelected({
                            ...selected,
                            requester: event.target.value,
                          })
                        }
                      />
                    </Field>
                    <Field label="Notes">
                      <Textarea
                        value={String(selected.notes ?? "")}
                        onChange={(event) =>
                          setSelected({
                            ...selected,
                            notes: event.target.value,
                          })
                        }
                      />
                    </Field>
                    <Field label="Due">
                      <Input
                        type="datetime-local"
                        value={dateInput(selected.dueAt)}
                        onChange={(event) =>
                          setSelected({
                            ...selected,
                            dueAt: event.target.value
                              ? new Date(event.target.value).toISOString()
                              : null,
                          })
                        }
                      />
                    </Field>
                  </>
                ) : null}
                {action === "assign" ? (
                  <Field label="New owner" required>
                    <Select
                      value={actionOwner}
                      onChange={(event) => setActionOwner(event.target.value)}
                    >
                      <option value="">Select owner</option>
                      {assignees.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.displayName} · {item.email}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ) : null}
                {action === "priority" ? (
                  <Field label="Priority" required>
                    <Select
                      value={actionPriority}
                      onChange={(event) =>
                        setActionPriority(event.target.value)
                      }
                    >
                      {priorityOptions.map((item) => (
                        <option key={item.key} value={item.label}>
                          {item.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ) : null}
                {action === "resolve" ? (
                  <Field label="Outcome" required>
                    <Input
                      value={actionOutcome}
                      onChange={(event) => setActionOutcome(event.target.value)}
                    />
                  </Field>
                ) : null}
                {actionNeedsReason ||
                ["assign", "priority"].includes(action) ? (
                  <Field
                    label={action === "resolve" ? "Resolution note" : "Reason"}
                    required={actionNeedsReason}
                  >
                    <Textarea
                      value={actionReason}
                      onChange={(event) => setActionReason(event.target.value)}
                    />
                  </Field>
                ) : null}
                <div className="flex justify-end gap-2">
                  <Button
                    onClick={() => {
                      setAction("");
                      setMutationError("");
                    }}
                  >
                    Back
                  </Button>
                  <Button
                    variant={
                      ["cancel"].includes(action)
                        ? "danger"
                        : ["resolve"].includes(action)
                          ? "success"
                          : "primary"
                    }
                    onClick={() => void runAction()}
                    disabled={
                      busy ||
                      (actionNeedsReason && actionReason.trim().length < 3) ||
                      (action === "assign" && !actionOwner)
                    }
                  >
                    {busy ? "Saving…" : "Confirm"}
                  </Button>
                </div>
              </Card>
            ) : null}
            <div className="flex justify-end">
              <Button onClick={() => setSelected(null)}>Close</Button>
            </div>
          </div>
        </DialogSurface>
      ) : null}
    </div>
  );
}
