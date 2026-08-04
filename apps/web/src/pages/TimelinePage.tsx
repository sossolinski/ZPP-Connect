import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Eye, FilePlus2, Plus, Search, XCircle } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { useApp } from "../lib/app-context";
import { isSessionWriteContextCurrent } from "../lib/session-safety";
import type { AnyRecord } from "../lib/types";
import { Badge, Button, Card, EmptyState, ErrorSummary, Field, Input, Loading, Select, StatusBadge, Table, Textarea } from "../components/ui";
import { formatDate } from "../lib/format";
import { historyCategoryForTimeline, isDecisionTimelineEvent, manualTimelineCategories, metadataSummary } from "../lib/record-context";
import { HistoryDetailDrawer } from "../components/HistoryDetailDrawer";
import { DialogSurface } from "../components/DialogSurface";

type SortDirection = "asc" | "desc";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const pageSizeOptions = [10, 25, 50, 100];
const caseOptionResources = ["enquiries", "family-records", "passenger-records", "matching-records", "requests", "releases"];

function compareTimelineValues(a: unknown, b: unknown, key: string) {
  if (key === "occurredAt") {
    const first = a ? new Date(String(a)).getTime() : 0;
    const second = b ? new Date(String(b)).getTime() : 0;
    return first - second;
  }
  return collator.compare(String(a ?? ""), String(b ?? ""));
}

export function TimelinePage() {
  const { activeSession, activeSessionWritable, can, verifyActiveSessionWrite } = useApp();
  const [searchParams] = useSearchParams();
  const [rows, setRows] = useState<AnyRecord[]>([]);
  const [caseOptions, setCaseOptions] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [caseFilter, setCaseFilter] = useState("");
  const [eventTypeFilter, setEventTypeFilter] = useState("");
  const [entityTypeFilter, setEntityTypeFilter] = useState("");
  const [decisionOnly, setDecisionOnly] = useState(false);
  const [sortKey, setSortKey] = useState("occurredAt");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  const [form, setForm] = useState<AnyRecord>({ eventType: "note", title: "", body: "" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [detailRecord, setDetailRecord] = useState<AnyRecord | null>(null);
  const [writeError, setWriteError] = useState("");
  const [formBaseline, setFormBaseline] = useState("");
  const [adding, setAdding] = useState(false);
  const addInFlightRef = useRef(false);

  async function load() {
    if (!activeSession) {
      setRows([]);
      setCaseOptions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const [result, ...caseResults] = await Promise.all([
        api.listAll("timeline", { sessionId: activeSession.id }),
        ...caseOptionResources.map((resource) => api.listAll(resource, { sessionId: activeSession.id }).catch(() => ({ data: [] })))
      ]);
      const nextRows = result.data;
      const caseIds = new Set<string>();
      for (const row of nextRows) {
        if (row.caseId) caseIds.add(String(row.caseId));
      }
      for (const list of caseResults) {
        for (const row of list.data) {
          if (row.caseId) caseIds.add(String(row.caseId));
        }
      }
      setRows(nextRows);
      setCaseOptions(Array.from(caseIds).sort(collator.compare));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load timeline");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setSearch(searchParams.get("q") ?? "");
    setCaseFilter(searchParams.get("case") ?? "");
    setEventTypeFilter("");
    setEntityTypeFilter(searchParams.get("entityType") ?? "");
    setDecisionOnly(searchParams.get("decisions") === "1");
    setSortKey("occurredAt");
    setSortDirection("desc");
    setPageSize(10);
    setPage(1);
    setDrawerOpen(false);
    setDetailRecord(null);
    void load();
  }, [activeSession?.id, searchParams]);

  const eventTypeOptions = useMemo(
    () => Array.from(new Set(rows.map((row) => row.eventType).filter(Boolean).map(String))).sort(collator.compare),
    [rows]
  );
  const entityTypeOptions = useMemo(
    () => Array.from(new Set(rows.map((row) => row.entityType).filter(Boolean).map(String))).sort(collator.compare),
    [rows]
  );

  const filteredRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (caseFilter && String(row.caseId ?? "") !== caseFilter) return false;
      if (eventTypeFilter && String(row.eventType ?? "") !== eventTypeFilter) return false;
      if (entityTypeFilter && String(row.entityType ?? "") !== entityTypeFilter) return false;
      if (decisionOnly && !isDecisionTimelineEvent(row)) return false;
      if (!needle) return true;
      return [row.caseId, row.eventType, row.entityType, row.entityId, row.title, row.body, metadataSummary(row.metadata)]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });
  }, [caseFilter, decisionOnly, entityTypeFilter, eventTypeFilter, rows, search]);

  const sortedRows = useMemo(() => {
    const direction = sortDirection === "asc" ? 1 : -1;
    return [...filteredRows].sort((left, right) => compareTimelineValues(left[sortKey], right[sortKey], sortKey) * direction);
  }, [filteredRows, sortDirection, sortKey]);
  const totalPages = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStartIndex = sortedRows.length ? (currentPage - 1) * pageSize : 0;
  const pageEndIndex = Math.min(pageStartIndex + pageSize, sortedRows.length);
  const pageRangeStart = sortedRows.length ? pageStartIndex + 1 : 0;
  const pagedRows = sortedRows.slice(pageStartIndex, pageEndIndex);

  const timelineColumns = useMemo(
    () => [
      { key: "occurredAt", label: "Time", className: "w-[168px]", render: (row: AnyRecord) => formatDate(row.occurredAt) },
      {
        key: "caseId",
        label: "Case",
        className: "w-[148px]",
        render: (row: AnyRecord) =>
          row.caseId ? (
            <button
              type="button"
              className="focus-ring max-w-full truncate rounded-sm text-left font-bold text-blue-800 underline-offset-2 hover:underline"
              onClick={() => {
                setCaseFilter(String(row.caseId));
                setPage(1);
              }}
            >
              {row.caseId}
            </button>
          ) : (
            "Session"
          )
      },
      { key: "eventType", label: "Type", className: "w-[128px]", render: (row: AnyRecord) => <StatusBadge value={row.eventType} /> },
      { key: "status", label: "Status", className: "w-[128px]", sortable: false, render: (row: AnyRecord) => row.metadata?.newState ?? row.metadata?.status ?? "Not recorded" },
      {
        key: "decision",
        label: "Trail",
        className: "w-[112px]",
        sortable: false,
        render: (row: AnyRecord) => {
          const category = historyCategoryForTimeline(row);
          return <Badge tone={category === "Workflow decision" ? "warning" : category === "Manual note" ? "info" : "neutral"}>{category}</Badge>;
        }
      },
      {
        key: "title",
        label: "Event",
        className: "w-[300px]",
        render: (row: AnyRecord) => (
          <div className="min-w-0">
            <p className="truncate font-bold text-slate-950">{row.title}</p>
            <p className="mt-0.5 truncate text-xs font-semibold text-slate-500">{[row.entityType, row.entityId].filter(Boolean).join(" | ")}</p>
          </div>
        )
      },
      {
        key: "body",
        label: "Details",
        className: "w-[360px]",
        render: (row: AnyRecord) => (
          <div className="min-w-0">
            <p className="line-clamp-2 text-sm font-medium text-slate-700">{row.body ?? ""}</p>
            {metadataSummary(row.metadata) ? <p className="mt-1 line-clamp-1 text-xs font-semibold text-slate-500">{metadataSummary(row.metadata)}</p> : null}
          </div>
        )
      }
    ],
    []
  );

  function handleSort(key: string) {
    setPage(1);
    if (sortKey === key) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDirection(key === "occurredAt" ? "desc" : "asc");
  }

  async function addEvent() {
    if (adding || addInFlightRef.current) return;
    addInFlightRef.current = true;
    if (!activeSession || !can("timeline:create") || !isSessionWriteContextCurrent(activeSession, form.sessionId) || !(await verifyActiveSessionWrite(form.sessionId))) {
      setWriteError("The session changed or is no longer writable. This timeline note was not added.");
      addInFlightRef.current = false;
      return;
    }
    if (!String(form.title ?? "").trim()) {
      setWriteError("Title is required.");
      addInFlightRef.current = false;
      return;
    }
    setWriteError("");
    setAdding(true);
    try {
      await api.create("timeline", {
        sessionId: activeSession.id,
        caseId: form.caseId || undefined,
        eventType: form.eventType,
        title: String(form.title).trim(),
        body: String(form.body ?? "").trim() || undefined
      });
      setForm({ eventType: "note", title: "", body: "" });
      setDrawerOpen(false);
      setFormBaseline("");
      await load();
    } catch (err) {
      setWriteError(err instanceof Error ? err.message : "Unable to add timeline note");
    } finally {
      addInFlightRef.current = false;
      setAdding(false);
    }
  }

  function openNewNote() {
    if (!activeSessionWritable || !activeSession) return;
    const searchText = search.trim();
    const selectedCase = caseFilter || (searchText.toUpperCase().startsWith("CASE-")
      ? (caseOptions.find((caseId) => caseId.toLowerCase() === searchText.toLowerCase()) ?? caseOptions.find((caseId) => caseId.toLowerCase().includes(searchText.toLowerCase())) ?? "")
      : "");
    const nextForm = { eventType: "note", title: "", body: "", caseId: selectedCase, sessionId: activeSession.id };
    setForm(nextForm);
    setFormBaseline(JSON.stringify(nextForm));
    setWriteError("");
    setDrawerOpen(true);
  }

  return (
    <div className="grid items-start gap-5">
      <Card>
        <div className="border-b border-slate-200 px-4 py-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className="relative min-w-[220px] flex-1 2xl:max-w-[360px] 2xl:flex-none">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
              <Input
                className="h-9 pl-9"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(1);
                }}
                placeholder="Search case, type, title, details"
              />
            </div>
            <Select
              className="h-9 w-full sm:w-44"
              value={caseFilter}
              onChange={(event) => {
                setCaseFilter(event.target.value);
                setPage(1);
              }}
              aria-label="Filter by case"
            >
              <option value="">All cases</option>
              {caseOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
            <Select
              className="h-9 w-full sm:w-44"
              value={eventTypeFilter}
              onChange={(event) => {
                setEventTypeFilter(event.target.value);
                setPage(1);
              }}
              aria-label="Filter by event type"
            >
              <option value="">All event types</option>
              {eventTypeOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
            <Select
              className="h-9 w-full sm:w-44"
              value={entityTypeFilter}
              onChange={(event) => {
                setEntityTypeFilter(event.target.value);
                setPage(1);
              }}
              aria-label="Filter by entity"
            >
              <option value="">All entities</option>
              {entityTypeOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
            <label className="focus-within:focus-ring flex h-9 w-full items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 sm:w-auto">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-slate-300"
                checked={decisionOnly}
                onChange={(event) => {
                  setDecisionOnly(event.target.checked);
                  setPage(1);
                }}
              />
              Decisions
            </label>
            <Select
              className="h-9 w-full sm:w-32"
              value={pageSize}
              onChange={(event) => {
                setPageSize(Number(event.target.value));
                setPage(1);
              }}
              aria-label="Rows per page"
            >
              {pageSizeOptions.map((option) => (
                <option key={option} value={option}>
                  {option} rows
                </option>
              ))}
            </Select>
            <div className="flex h-9 w-full items-center justify-between gap-1 rounded-md border border-slate-300 bg-white px-1 text-sm text-slate-950 sm:w-auto sm:min-w-52">
              <Button icon={ChevronLeft} size="icon" variant="ghost" aria-label="Previous page" disabled={currentPage <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))} />
              <p className="whitespace-nowrap px-2 text-sm font-semibold text-slate-800">
                {pageRangeStart} - {pageEndIndex} of {sortedRows.length}
              </p>
              <Button icon={ChevronRight} size="icon" variant="ghost" aria-label="Next page" disabled={currentPage >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))} />
            </div>
            {activeSessionWritable && can("timeline:create") ? (
              <Button icon={FilePlus2} variant="create" onClick={openNewNote}>
                New
              </Button>
            ) : null}
          </div>
        </div>
        <div className="grid gap-4 p-4">
          {loading ? (
            <Loading />
          ) : error ? (
            <EmptyState title="Unable to load timeline" detail={error} action={<Button onClick={() => void load()}>Retry</Button>} />
          ) : (
            <Table
              columns={timelineColumns}
              rows={pagedRows}
              emptyTitle={rows.length ? "No timeline events match these filters" : "No timeline events"}
              emptyDetail={rows.length ? "Clear filters to review the complete timeline." : "Workflow events and authorized manual notes will appear here."}
              emptyAction={rows.length ? <Button onClick={() => { setSearch(""); setCaseFilter(""); setEventTypeFilter(""); setEntityTypeFilter(""); setDecisionOnly(false); setPage(1); }}>Clear filters</Button> : activeSessionWritable && can("timeline:create") ? <Button variant="create" onClick={openNewNote}>New note</Button> : undefined}
              onRowOpen={(row) => setDetailRecord(row)}
              rowLabel={(row) => `Open timeline event ${row.title}`}
              sortKey={sortKey}
              sortDirection={sortDirection}
              onSort={handleSort}
              rowAction={(row) => <Button icon={Eye} size="icon" variant="ghost" title="View details" aria-label="View timeline details" onClick={() => setDetailRecord(row)} />}
              actionWidth="w-14"
            />
          )}
        </div>
      </Card>

      {drawerOpen ? (
        <DialogSurface
          title="New Timeline Note"
          description={activeSession?.operationalId ?? "No active session"}
          dirty={Boolean(formBaseline && JSON.stringify(form) !== formBaseline)}
          busy={adding}
          onClose={() => setDrawerOpen(false)}
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-border bg-card text-foreground shadow-2xl"
        >
          {({ requestClose }) => (
          <>
            <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
              <div className="min-w-0">
                <h2 data-dialog-heading="true" tabIndex={-1} className="truncate text-lg font-black text-foreground">New Timeline Note</h2>
                <p className="mt-1 truncate text-sm text-muted-foreground">{activeSession?.operationalId ?? "No active session"}</p>
              </div>
              <Button icon={XCircle} variant="ghost" onClick={() => requestClose()}>
                Close
              </Button>
            </div>
            <div className="scrollbar-soft grid flex-1 content-start gap-3 overflow-y-auto p-5">
              <ErrorSummary title="Timeline note could not be added" errors={writeError ? [{ message: writeError, fieldId: !String(form.title ?? "").trim() ? "timeline-title" : undefined }] : []} />
              <Field label="Case ID">
                <Select value={form.caseId ?? ""} onChange={(event) => setForm((current) => ({ ...current, caseId: event.target.value }))}>
                  <option value="">No case selected</option>
                  {caseOptions.map((caseId) => (
                    <option key={caseId} value={caseId}>
                      {caseId}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Manual category">
                <Select value={form.eventType ?? "note"} onChange={(event) => setForm((current) => ({ ...current, eventType: event.target.value }))}>
                  {manualTimelineCategories.map((category) => <option key={category.value} value={category.value}>{category.label}</option>)}
                </Select>
                <p className="mt-1 text-xs font-semibold text-muted-foreground">Workflow decisions are recorded only by their dedicated actions.</p>
              </Field>
              <Field id="timeline-title" label="Title" required error={writeError && !String(form.title ?? "").trim() ? "Title is required." : undefined}>
                <Input value={form.title ?? ""} onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))} />
              </Field>
              <Field label="Details">
                <Textarea value={form.body ?? ""} onChange={(event) => setForm((current) => ({ ...current, body: event.target.value }))} />
              </Field>
            </div>
            <div className="border-t border-border bg-card p-4">
              <Button className="w-full" icon={Plus} variant="primary" disabled={!activeSessionWritable || !can("timeline:create") || adding} aria-busy={adding} onClick={addEvent}>
                {adding ? "Adding note" : "Add note"}
              </Button>
            </div>
          </>
          )}
        </DialogSurface>
      ) : null}
      {detailRecord ? <HistoryDetailDrawer kind="timeline" record={detailRecord} can={can} onClose={() => setDetailRecord(null)} /> : null}
    </div>
  );
}
