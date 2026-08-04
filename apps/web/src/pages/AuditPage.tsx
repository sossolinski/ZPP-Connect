import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Eye, Search } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { useApp } from "../lib/app-context";
import type { AnyRecord } from "../lib/types";
import { Badge, Button, Card, EmptyState, Input, Loading, Select, StatusBadge, Table } from "../components/ui";
import { formatDate } from "../lib/format";
import { historyCategoryForAudit, isDecisionAuditLog, metadataSummary } from "../lib/record-context";
import { HistoryDetailDrawer } from "../components/HistoryDetailDrawer";

type SortDirection = "asc" | "desc";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const pageSizeOptions = [10, 25, 50, 100];

function compareAuditValues(a: unknown, b: unknown, key: string) {
  if (key === "createdAt") {
    const first = a ? new Date(String(a)).getTime() : 0;
    const second = b ? new Date(String(b)).getTime() : 0;
    return first - second;
  }
  return collator.compare(String(a ?? ""), String(b ?? ""));
}

export function AuditPage() {
  const { activeSession, can } = useApp();
  const [searchParams] = useSearchParams();
  const [rows, setRows] = useState<AnyRecord[]>([]);
  const [search, setSearch] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const [entityTypeFilter, setEntityTypeFilter] = useState("");
  const [decisionOnly, setDecisionOnly] = useState(false);
  const [sortKey, setSortKey] = useState("createdAt");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [detailRecord, setDetailRecord] = useState<AnyRecord | null>(null);

  async function load() {
    if (!activeSession) {
      setRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const result = await api.listAll("audit-logs", { sessionId: activeSession.id });
      setRows(result.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load audit log");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setSearch(searchParams.get("q") ?? "");
    setActionFilter(searchParams.get("action") ?? "");
    setEntityTypeFilter(searchParams.get("entityType") ?? "");
    setDecisionOnly(searchParams.get("decisions") === "1");
    setSortKey("createdAt");
    setSortDirection("desc");
    setPageSize(25);
    setPage(1);
    setDetailRecord(null);
    void load();
  }, [activeSession?.id, searchParams]);

  const actionOptions = useMemo(
    () => Array.from(new Set(rows.map((row) => row.action).filter(Boolean).map(String))).sort(collator.compare),
    [rows]
  );
  const entityTypeOptions = useMemo(
    () => Array.from(new Set(rows.map((row) => row.entityType).filter(Boolean).map(String))).sort(collator.compare),
    [rows]
  );

  const filteredRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (actionFilter && String(row.action ?? "") !== actionFilter) return false;
      if (entityTypeFilter && String(row.entityType ?? "") !== entityTypeFilter) return false;
      if (decisionOnly && !isDecisionAuditLog(row)) return false;
      if (!needle) return true;
      return [row.createdAt, row.actorEmail, row.action, row.entityType, row.entityId, row.summary, metadataSummary(row.metadata)]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });
  }, [actionFilter, decisionOnly, entityTypeFilter, rows, search]);

  const sortedRows = useMemo(() => {
    const direction = sortDirection === "asc" ? 1 : -1;
    return [...filteredRows].sort((left, right) => compareAuditValues(left[sortKey], right[sortKey], sortKey) * direction);
  }, [filteredRows, sortDirection, sortKey]);
  const totalPages = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStartIndex = sortedRows.length ? (currentPage - 1) * pageSize : 0;
  const pageEndIndex = Math.min(pageStartIndex + pageSize, sortedRows.length);
  const pageRangeStart = sortedRows.length ? pageStartIndex + 1 : 0;
  const pagedRows = sortedRows.slice(pageStartIndex, pageEndIndex);

  const columns = useMemo(
    () => [
      { key: "createdAt", label: "Time", className: "w-[168px]", render: (row: AnyRecord) => formatDate(row.createdAt) },
      { key: "actorEmail", label: "Actor", className: "w-[200px]" },
      { key: "action", label: "Action", className: "w-[190px]", render: (row: AnyRecord) => <StatusBadge value={row.action} /> },
      { key: "entityType", label: "Entity", className: "w-[136px]", render: (row: AnyRecord) => row.entityType ?? "system" },
      { key: "status", label: "Status", className: "w-[128px]", sortable: false, render: (row: AnyRecord) => row.metadata?.newState ?? row.metadata?.status ?? "Not recorded" },
      {
        key: "decision",
        label: "Trail",
        className: "w-[112px]",
        sortable: false,
        render: (row: AnyRecord) => {
          const category = historyCategoryForAudit(row);
          return <Badge tone={category === "Workflow decision" ? "warning" : category === "Manual note" ? "info" : "neutral"}>{category}</Badge>;
        }
      },
      {
        key: "summary",
        label: "Summary",
        className: "w-[360px]",
        render: (row: AnyRecord) => (
          <div className="min-w-0">
            <p className="line-clamp-2 font-semibold text-slate-800">{row.summary}</p>
            <p className="mt-0.5 truncate text-xs font-semibold text-slate-500">{row.entityId ?? ""}</p>
          </div>
        )
      },
      {
        key: "metadata",
        label: "Metadata",
        className: "w-[320px]",
        sortable: false,
        render: (row: AnyRecord) => <span className="line-clamp-2 text-sm font-medium text-slate-700">{metadataSummary(row.metadata)}</span>
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
    setSortDirection(key === "createdAt" ? "desc" : "asc");
  }

  return (
    <>
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
              placeholder="Search action, actor, entity, metadata"
            />
          </div>
          <Select
            className="h-9 w-full sm:w-52"
            value={actionFilter}
            onChange={(event) => {
              setActionFilter(event.target.value);
              setPage(1);
            }}
            aria-label="Filter by action"
          >
            <option value="">All actions</option>
            {actionOptions.map((option) => (
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
        </div>
      </div>
      <div className="p-4">
        {loading ? (
          <Loading />
        ) : error ? (
          <EmptyState title="Unable to load audit log" detail={error} action={<Button onClick={() => void load()}>Retry</Button>} />
        ) : (
          <Table
            columns={columns}
            rows={pagedRows}
            emptyTitle={rows.length ? "No audit events match these filters" : "No audit events"}
            emptyDetail={rows.length ? "Clear filters to review the complete audit log." : "Authorized workflow and system events will appear here."}
            emptyAction={rows.length ? <Button onClick={() => { setSearch(""); setActionFilter(""); setEntityTypeFilter(""); setDecisionOnly(false); setPage(1); }}>Clear filters</Button> : undefined}
            onRowOpen={(row) => setDetailRecord(row)}
            rowLabel={(row) => `Open audit event ${row.action}`}
            sortKey={sortKey}
            sortDirection={sortDirection}
            onSort={handleSort}
            rowAction={(row) => <Button icon={Eye} size="icon" variant="ghost" title="View details" aria-label="View audit details" onClick={() => setDetailRecord(row)} />}
            actionWidth="w-14"
          />
        )}
      </div>
    </Card>
    {detailRecord ? <HistoryDetailDrawer kind="audit" record={detailRecord} can={can} onClose={() => setDetailRecord(null)} /> : null}
    </>
  );
}
