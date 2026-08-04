import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, ChevronLeft, ChevronRight, Eye, FilePlus2, Pencil, Save, Search, XCircle } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { useApp } from "../lib/app-context";
import { isSessionWriteContextCurrent } from "../lib/session-safety";
import type { AnyRecord } from "../lib/types";
import { AlertBox, Badge, Button, Card, DecisionDialog, EmptyState, ErrorSummary, Field, Input, Loading, Select, StatusBadge, Textarea } from "../components/ui";
import { DialogSurface } from "../components/DialogSurface";
import { formatDate } from "../lib/format";

const emptyReleaseForm = { actionType: "Reunification", status: "Prepared", identityChecked: false, holdCleared: false };
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const pageSizeOptions = [10, 25, 50, 100];
const terminalStatuses = new Set(["Completed", "Cancelled", "Released", "Reunited"]);
type ReleaseDecision = {
  row: AnyRecord;
  actionName: "complete" | "cancel";
  notes: string;
  error: string;
  saving: boolean;
};
type ReleaseDrawerMode = "create" | "edit" | "view";

function optionalValue(value: unknown) {
  return value === "" || value === undefined ? null : value;
}

function normalizeReleasePayload(payload: AnyRecord) {
  return {
    ...payload,
    matchId: optionalValue(payload.matchId),
    passengerRecordId: optionalValue(payload.passengerRecordId),
    familyRecordId: optionalValue(payload.familyRecordId),
    releaseDestination: optionalValue(payload.releaseDestination),
    receivingParty: optionalValue(payload.receivingParty),
    transportMode: optionalValue(payload.transportMode)
  };
}

function isEligibleMatch(match: AnyRecord) {
  return ["Verified match", "Reunited", "Released"].includes(String(match.status)) && (!match.holdCheck || match.holdCheck === "No hold");
}

function matchLabel(match?: AnyRecord | null) {
  if (!match) return "No match";
  const passenger = match.passengerRecord ? [match.passengerRecord.lastName, match.passengerRecord.firstName].filter(Boolean).join(", ") : "";
  return [match.operationalId, passenger, match.status].filter(Boolean).join(" | ");
}

function personName(record?: AnyRecord | null) {
  return [record?.lastName, record?.firstName].filter(Boolean).join(", ");
}

function matchDetail(match?: AnyRecord | null) {
  if (!match) return "Match not loaded";
  const passenger = personName(match.passengerRecord);
  const family = personName(match.familyRecord);
  return [match.caseId, passenger ? `PAX ${passenger}` : "", family ? `FAM ${family}` : ""].filter(Boolean).join(" | ");
}

function releaseIssues(row: AnyRecord, match?: AnyRecord) {
  const issues: string[] = [];
  if (!match) issues.push("Matching record unavailable");
  else {
    if (!["Verified match", "Reunited", "Released"].includes(String(match.status))) issues.push(`Match status: ${match.status ?? "Unknown"}`);
    if (match.holdCheck && match.holdCheck !== "No hold") issues.push(`Active hold: ${match.holdCheck}`);
  }
  if (!row.identityChecked) issues.push("Identity pending");
  if (!row.holdCleared) issues.push("Hold pending");
  if (row.actionType === "Release" && !row.receivingParty) issues.push("Receiving party missing");
  return issues;
}

function fieldValue(value: unknown) {
  return value ? String(value) : "Not set";
}

function updatedTimestamp(row: AnyRecord) {
  return row.updatedAt ?? row.createdAt ?? row.completedAt;
}

function matchesReleaseFocus(row: AnyRecord, focus: string, match?: AnyRecord) {
  const normalized = focus.trim().toLowerCase();
  if (!normalized) return false;
  return [row.id, row.operationalId, row.matchId, match?.id, match?.operationalId, match?.caseId]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase() === normalized);
}

export function ReleasePage() {
  const { activeSession, activeSessionWritable, dictionaries, can, reload, verifyActiveSessionWrite } = useApp();
  const [searchParams] = useSearchParams();
  const focusReleaseId = searchParams.get("focus") ?? searchParams.get("match") ?? "";
  const handledFocusRef = useRef("");
  const [rows, setRows] = useState<AnyRecord[]>([]);
  const [matches, setMatches] = useState<AnyRecord[]>([]);
  const [form, setForm] = useState<AnyRecord>(emptyReleaseForm);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerMode, setDrawerMode] = useState<ReleaseDrawerMode>("create");
  const [releaseDecision, setReleaseDecision] = useState<ReleaseDecision | null>(null);
  const [focusedReleaseId, setFocusedReleaseId] = useState("");
  const [feedback, setFeedback] = useState("");
  const [formBaseline, setFormBaseline] = useState("");

  const matchById = useMemo(() => new Map(matches.map((match) => [match.id, match])), [matches]);
  const eligibleMatches = matches.filter(isEligibleMatch);
  const preparedByMatchId = useMemo(
    () => new Map(rows.filter((row) => row.status === "Prepared" && row.matchId).map((row) => [row.matchId, row])),
    [rows]
  );
  const availableMatches = eligibleMatches.filter((match) => !preparedByMatchId.has(match.id));
  const blockedMatches = matches.filter((match) => match.holdCheck && match.holdCheck !== "No hold");
  const pendingMatches = matches.filter((match) => !["Verified match", "Reunited", "Released"].includes(String(match.status)));
  const preparedCount = rows.filter((row) => row.status === "Prepared").length;
  const completedCount = rows.filter((row) => row.status === "Completed").length;
  const selectedMatch = form.matchId ? matchById.get(form.matchId) : undefined;
  const selectedFormIssues = selectedMatch && form.status === "Prepared" ? releaseIssues(form, selectedMatch) : [];

  const statusOptions = useMemo(
    () => Array.from(new Set(rows.map((row) => row.status).filter(Boolean).map(String))).sort(collator.compare),
    [rows]
  );

  const typeOptions = useMemo(
    () => Array.from(new Set(rows.map((row) => row.actionType).filter(Boolean).map(String))).sort(collator.compare),
    [rows]
  );

  const filteredRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (statusFilter && String(row.status ?? "") !== statusFilter) return false;
      if (typeFilter && String(row.actionType ?? "") !== typeFilter) return false;
      if (!needle) return true;

      const match = matchById.get(row.matchId);
      return [
        row.operationalId,
        row.id,
        row.actionType,
        row.status,
        row.releaseDestination,
        row.receivingParty,
        row.transportMode,
        row.notes,
        match?.id,
        match?.operationalId,
        match?.caseId,
        match?.familyRecord?.lastName,
        match?.familyRecord?.firstName,
        match?.passengerRecord?.lastName,
        match?.passengerRecord?.firstName
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });
  }, [matchById, rows, search, statusFilter, typeFilter]);

  const sortedRows = useMemo(() => {
    return [...filteredRows].sort((left, right) => {
      const leftTime = updatedTimestamp(left) ? new Date(String(updatedTimestamp(left))).getTime() : 0;
      const rightTime = updatedTimestamp(right) ? new Date(String(updatedTimestamp(right))).getTime() : 0;
      return rightTime - leftTime || collator.compare(String(left.operationalId ?? ""), String(right.operationalId ?? ""));
    });
  }, [filteredRows]);

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStartIndex = sortedRows.length ? (currentPage - 1) * pageSize : 0;
  const pageEndIndex = Math.min(pageStartIndex + pageSize, sortedRows.length);
  const pageRangeStart = sortedRows.length ? pageStartIndex + 1 : 0;
  const pagedRows = sortedRows.slice(pageStartIndex, pageEndIndex);

  async function load() {
    if (!activeSession) {
      setRows([]);
      setMatches([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const [releaseList, matchList] = await Promise.all([
        api.listAll("releases", { sessionId: activeSession.id }),
        api.listAll("matching-records", { sessionId: activeSession.id })
      ]);
      setRows(releaseList.data);
      setMatches(matchList.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load release records");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setSearch("");
    setStatusFilter("");
    setTypeFilter("");
    setPageSize(10);
    setPage(1);
    setActionError("");
    void load();
    setDrawerOpen(false);
    setDrawerMode("create");
    setReleaseDecision(null);
    setFocusedReleaseId("");
    setForm(emptyReleaseForm);
  }, [activeSession?.id]);

  useEffect(() => {
    const focus = focusReleaseId.trim();
    if (!focus) {
      handledFocusRef.current = "";
      setFocusedReleaseId("");
      return;
    }
    setSearch(focus);
    setStatusFilter("");
    setTypeFilter("");
    setPage(1);
  }, [focusReleaseId]);

  useEffect(() => {
    const focus = focusReleaseId.trim();
    if (!focus || loading) return;
    const row = rows.find((item) => matchesReleaseFocus(item, focus, matchById.get(item.matchId)));
    if (!row) {
      setFocusedReleaseId("");
      return;
    }
    const key = `${row.id}:${focus}`;
    if (handledFocusRef.current === key) return;
    handledFocusRef.current = key;
    setFocusedReleaseId(String(row.id));
    setSearch(focus);
    setStatusFilter("");
    setTypeFilter("");
    setPage(1);
    openReleaseDrawer(row, "view");
  }, [focusReleaseId, loading, matchById, rows]);

  useEffect(() => {
    if (!focusedReleaseId || loading) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(`release-${focusedReleaseId}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [currentPage, focusedReleaseId, loading, pagedRows]);

  function openPrepareAction(match?: AnyRecord) {
    if (!activeSessionWritable || !activeSession) return;
    const existing = match?.id ? preparedByMatchId.get(match.id) : undefined;
    if (existing) {
      setFeedback(`${existing.operationalId} is already the open action for ${match?.operationalId ?? "this match"}.`);
      openReleaseDrawer(existing, "view");
      return;
    }
    const nextForm = {
      ...emptyReleaseForm,
      sessionId: activeSession.id,
      matchId: match?.id ?? "",
      holdCleared: match ? !match.holdCheck || match.holdCheck === "No hold" : false
    };
    setForm(nextForm);
    setFormBaseline(JSON.stringify(nextForm));
    setFormError("");
    setDrawerMode("create");
    setDrawerOpen(true);
  }

  function openReleaseDrawer(row: AnyRecord, mode: ReleaseDrawerMode) {
    const nextForm = { ...row };
    setForm(nextForm);
    setFormBaseline(JSON.stringify(nextForm));
    setFormError("");
    setDrawerMode(mode);
    setDrawerOpen(true);
  }

  async function save() {
    if (!activeSession || !can("release:create") || !isSessionWriteContextCurrent(activeSession, form.sessionId) || !(await verifyActiveSessionWrite(form.sessionId))) {
      setFormError("The session changed or is no longer writable. This release action was not prepared.");
      return;
    }
    const [currentReleases, currentMatches] = await Promise.all([
      api.listAll("releases", { sessionId: activeSession.id }),
      api.listAll("matching-records", { sessionId: activeSession.id })
    ]);
    const currentMatch = currentMatches.data.find((item) => item.id === form.matchId);
    if (!currentMatch || !isEligibleMatch(currentMatch)) {
      setFormError("The matching record is missing, no longer verified or now has an active hold.");
      return;
    }
    if (drawerMode === "edit") {
      const currentRelease = currentReleases.data.find((item) => item.id === form.id);
      if (!currentRelease || currentRelease.status !== "Prepared") {
        setFormError("This release action is no longer prepared and cannot be edited.");
        return;
      }
    } else {
      const duplicate = currentReleases.data.find((item) => item.matchId === form.matchId && item.status === "Prepared");
      if (duplicate) {
        setFormError(`${duplicate.operationalId} is already the open release action for this matching record.`);
        return;
      }
    }
    setSaving(true);
    setFormError("");
    try {
      const payload = {
        ...normalizeReleasePayload(form),
        sessionId: activeSession.id,
        matchId: currentMatch.id,
        passengerRecordId: currentMatch.passengerRecordId,
        familyRecordId: currentMatch.familyRecordId,
        status: "Prepared",
        holdCleared: !currentMatch.holdCheck || currentMatch.holdCheck === "No hold" ? Boolean(form.holdCleared) : false
      };
      const saved = drawerMode === "edit" && form.id
        ? await api.update("releases", form.id, payload)
        : await api.create("releases", payload);
      setForm(emptyReleaseForm);
      setFormBaseline("");
      setDrawerOpen(false);
      setFeedback(`${saved.operationalId} ${drawerMode === "edit" ? "updated" : "prepared"}.`);
      await Promise.all([load(), reload()]);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Unable to prepare release action");
    } finally {
      setSaving(false);
    }
  }

  function openReleaseDecision(row: AnyRecord, actionName: "complete" | "cancel") {
    if (!activeSessionWritable) return;
    setActionError("");
    setReleaseDecision({ row, actionName, notes: row.notes ?? "", error: "", saving: false });
  }

  async function confirmReleaseDecision() {
    if (!releaseDecision) return;
    const permission = releaseDecision.actionName === "complete" ? "release:complete" : "release:cancel";
    if (!activeSessionWritable || !can(permission) || !isSessionWriteContextCurrent(activeSession, releaseDecision.row.sessionId) || !(await verifyActiveSessionWrite(releaseDecision.row.sessionId))) {
      setReleaseDecision((current) => (current ? { ...current, error: "The session changed or is closed. This release decision was not submitted.", saving: false } : current));
      return;
    }
    const [releaseList, matchList] = await Promise.all([
      api.listAll("releases", { sessionId: releaseDecision.row.sessionId }),
      api.listAll("matching-records", { sessionId: releaseDecision.row.sessionId })
    ]);
    const currentRelease = releaseList.data.find((item) => item.id === releaseDecision.row.id);
    const currentMatch = currentRelease ? matchList.data.find((item) => item.id === currentRelease.matchId) : undefined;
    if (!currentRelease || currentRelease.status !== "Prepared") {
      setReleaseDecision((current) => (current ? { ...current, error: "This action is no longer prepared. Refresh and review its current state.", saving: false } : current));
      return;
    }
    if (releaseDecision.actionName === "complete") {
      const blockers = releaseIssues(currentRelease, currentMatch);
      if (blockers.length) {
        setReleaseDecision((current) => (current ? { ...current, error: `Completion blocked: ${blockers.join("; ")}.`, saving: false } : current));
        return;
      }
    }
    const notes = releaseDecision.notes.trim();
    if (notes.length < 3) {
      setReleaseDecision((current) => (current ? { ...current, error: "Enter a decision note with at least 3 characters." } : current));
      return;
    }
    setActionError("");
    setReleaseDecision((current) => (current ? { ...current, saving: true, error: "" } : current));
    try {
      await api.action("releases", releaseDecision.row.id, releaseDecision.actionName, { notes });
      setReleaseDecision(null);
      setFeedback(`${releaseDecision.row.operationalId} ${releaseDecision.actionName === "complete" ? "completed" : "cancelled"}.`);
      await Promise.all([load(), reload()]);
    } catch (err) {
      setReleaseDecision((current) =>
        current
          ? {
              ...current,
              saving: false,
              error: err instanceof Error ? err.message : "Unable to update release action"
            }
          : current
      );
    }
  }

  return (
    <div className="grid gap-5">
      <AlertBox>Release is blocked unless a verified match exists and holds are cleared.</AlertBox>
      {feedback ? <AlertBox tone="success">{feedback}</AlertBox> : null}
      {actionError ? <AlertBox>{actionError}</AlertBox> : null}

      <Card>
          <div className="border-b border-slate-200 px-4 py-3">
            <div className="grid gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <div className="relative min-w-[220px] flex-1 2xl:max-w-[360px] 2xl:flex-none">
                  <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                  <Input
                    className="h-9 pl-9"
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value);
                      setPage(1);
                      setFocusedReleaseId("");
                    }}
                    placeholder="Search release, match, person"
                  />
                </div>
                <Select
                  className="h-9 w-full sm:w-40"
                  value={statusFilter}
                  onChange={(event) => {
                    setStatusFilter(event.target.value);
                    setPage(1);
                    setFocusedReleaseId("");
                  }}
                  aria-label="Filter by release status"
                >
                  <option value="">All status</option>
                  {statusOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </Select>
                <Select
                  className="h-9 w-full sm:w-44"
                  value={typeFilter}
                  onChange={(event) => {
                    setTypeFilter(event.target.value);
                    setPage(1);
                    setFocusedReleaseId("");
                  }}
                  aria-label="Filter by action type"
                >
                  <option value="">All action types</option>
                  {typeOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </Select>
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
                <div className="ml-auto">
                  <Button icon={FilePlus2} variant="create" disabled={!activeSessionWritable || !can("release:create")} onClick={() => openPrepareAction()}>
                    New
                  </Button>
                </div>
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <div className="flex flex-wrap gap-1.5">
                  <Badge tone="success">{availableMatches.length} ready</Badge>
                  {preparedByMatchId.size ? <Badge tone="neutral">{preparedByMatchId.size} already prepared</Badge> : null}
                  {blockedMatches.length ? <Badge tone="warning">{blockedMatches.length} held</Badge> : null}
                  {pendingMatches.length ? <Badge tone="neutral">{pendingMatches.length} pending</Badge> : null}
                  {preparedCount ? <Badge tone="neutral">{preparedCount} prepared</Badge> : null}
                  {completedCount ? <Badge tone="success">{completedCount} completed</Badge> : null}
                </div>
              </div>
            </div>
          </div>
          <div className="grid gap-4 p-4">
            {loading ? (
              <Loading />
            ) : error ? (
              <EmptyState title="Unable to load records" detail={error} action={<Button onClick={() => void load()}>Retry</Button>} />
            ) : sortedRows.length ? (
              <div className="grid gap-3">
                {pagedRows.map((row) => {
                  const match = matchById.get(row.matchId);
                  const isTerminal = terminalStatuses.has(String(row.status));
                  const isPrepared = row.status === "Prepared";
                  const issues = isPrepared ? releaseIssues(row, match) : [];
                  const canCompleteRow = isPrepared && issues.length === 0;
                  return (
                    <article
                      id={`release-${row.id}`}
                      key={row.id}
                      className={[
                        "rounded-md border p-4 transition",
                        focusedReleaseId === row.id ? "border-blue-300 bg-blue-50/60 shadow-md ring-2 ring-blue-200" : "border-slate-200 bg-white shadow-sm"
                      ].join(" ")}
                    >
                      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <p className="truncate text-base font-black text-slate-950">{row.operationalId}</p>
                            <StatusBadge value={row.status} />
                            <Badge tone={issues.length ? "warning" : "success"}>
                              {issues.length ? `${issues.length} checks` : "Ready"}
                            </Badge>
                            {focusedReleaseId === row.id ? <Badge tone="info">Focused</Badge> : null}
                          </div>
                          <p className="mt-1 truncate text-sm font-semibold text-slate-500">{row.actionType ?? "Release action"}</p>
                        </div>
                        {updatedTimestamp(row) ? <p className="shrink-0 text-sm font-semibold text-slate-500">{formatDate(updatedTimestamp(row))}</p> : null}
                      </div>

                      {issues.length ? (
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {issues.map((issue) => (
                            <Badge key={issue} tone="warning">
                              {issue}
                            </Badge>
                          ))}
                        </div>
                      ) : null}

                      <div className="mt-4 grid gap-2 lg:grid-cols-4">
                        <div className="min-w-0 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 lg:col-span-2">
                          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Match</p>
                          <p className="mt-1 truncate text-sm font-bold text-slate-900">{matchLabel(match)}</p>
                          <p className="mt-0.5 truncate text-xs font-semibold text-slate-500">{matchDetail(match)}</p>
                        </div>
                        <div className="min-w-0 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Destination</p>
                          <p className="mt-1 truncate text-sm font-bold text-slate-900">{fieldValue(row.releaseDestination)}</p>
                        </div>
                        <div className="min-w-0 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Transport</p>
                          <p className="mt-1 truncate text-sm font-bold text-slate-900">{fieldValue(row.transportMode)}</p>
                        </div>
                      </div>

                      <div className="mt-4 flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-slate-800">{row.receivingParty ? `Receiving party: ${row.receivingParty}` : "Receiving party not set"}</p>
                          <p className="mt-1 line-clamp-2 text-sm text-slate-500">{row.notes ?? "No notes recorded."}</p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button icon={Eye} size="sm" variant="secondary" onClick={() => openReleaseDrawer(row, "view")}>
                            View
                          </Button>
                          {isPrepared && activeSessionWritable && can("release:create") ? (
                            <Button icon={Pencil} size="sm" variant="secondary" onClick={() => openReleaseDrawer(row, "edit")}>
                              Edit
                            </Button>
                          ) : null}
                          {isPrepared && activeSessionWritable && can("release:complete") ? (
                            <Button icon={CheckCircle2} size="sm" variant="success" disabled={!canCompleteRow} onClick={() => openReleaseDecision(row, "complete")}>
                              Complete
                            </Button>
                          ) : null}
                          {isPrepared && activeSessionWritable && can("release:cancel") ? (
                            <Button icon={XCircle} size="sm" variant="danger" disabled={isTerminal} onClick={() => openReleaseDecision(row, "cancel")}>
                              Cancel
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : rows.length ? (
              <EmptyState title="No matching actions" detail="Try changing the search or filters." action={<Button onClick={() => { setSearch(""); setStatusFilter(""); setTypeFilter(""); setPage(1); }}>Clear filters</Button>} />
            ) : (
              <EmptyState title="No prepared actions" detail="Prepared reunification and release actions will appear here." />
            )}
          </div>
      </Card>

      {drawerOpen ? (
        <DialogSurface
          title={drawerMode === "create" ? "Prepare Action" : drawerMode === "edit" ? "Edit Prepared Action" : "View Release Action"}
          description={form.operationalId ?? activeSession?.operationalId ?? "Release control"}
          dirty={drawerMode !== "view" && Boolean(formBaseline && JSON.stringify(form) !== formBaseline)}
          busy={saving}
          onClose={() => setDrawerOpen(false)}
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-border bg-card text-foreground shadow-2xl"
        >
          {({ requestClose }) => (
          <>
            <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
              <div className="min-w-0">
                <h2 data-dialog-heading="true" tabIndex={-1} className="truncate text-lg font-black text-foreground">
                  {drawerMode === "create" ? "Prepare Action" : drawerMode === "edit" ? "Edit Prepared Action" : "View Release Action"}
                </h2>
                <p className="mt-1 truncate text-sm text-muted-foreground">{activeSession?.operationalId ?? "No active session"}</p>
              </div>
              <Button icon={XCircle} variant="ghost" disabled={saving} onClick={() => requestClose()}>
                Close
              </Button>
            </div>

            <div className="scrollbar-soft grid flex-1 content-start gap-3 overflow-y-auto px-5 py-4">
              <ErrorSummary title="Release action could not be saved" errors={formError ? [{ message: formError, fieldId: "release-match" }] : []} />
              <Field id="release-match" label="Match" required={drawerMode !== "view"} error={formError && !form.matchId ? "Select an eligible matching record." : undefined}>
                <Select
                  value={form.matchId ?? ""}
                  readOnly={drawerMode === "view"}
                  disabled={drawerMode === "edit"}
                  onChange={(event) => {
                    const match = matchById.get(event.target.value);
                    setForm((current) => ({
                      ...current,
                      matchId: event.target.value,
                      holdCleared: match ? !match.holdCheck || match.holdCheck === "No hold" : current.holdCleared
                    }));
                  }}
                >
                  <option value="">Select verified match</option>
                  {(drawerMode === "create" ? availableMatches : selectedMatch ? [selectedMatch] : []).map((match) => (
                    <option key={match.id} value={match.id}>
                      {matchLabel(match)}
                    </option>
                  ))}
                </Select>
              </Field>
              {selectedMatch ? (
                <div className="rounded-md border border-border bg-muted p-3">
                  <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                    <p className="truncate text-sm font-black text-foreground">{selectedMatch.operationalId}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {typeof selectedMatch.matchScore === "number" ? <Badge tone="neutral">{Math.round(selectedMatch.matchScore * 100)}%</Badge> : null}
                      <StatusBadge value={selectedMatch.status} />
                    </div>
                  </div>
                  <p className="mt-1 truncate text-sm font-semibold text-muted-foreground">{matchDetail(selectedMatch)}</p>
                </div>
              ) : (
                <AlertBox>Select a verified match with no active hold.</AlertBox>
              )}
              {selectedMatch && selectedFormIssues.length ? (
                <AlertBox>Completion blockers: {selectedFormIssues.join("; ")}.</AlertBox>
              ) : null}
              <Field label="Action type">
                <Select readOnly={drawerMode === "view"} value={form.actionType ?? "Reunification"} onChange={(event) => setForm((current) => ({ ...current, actionType: event.target.value }))}>
                  <option value="Reunification">Reunification</option>
                  <option value="Release">Release</option>
                </Select>
              </Field>
              <Field label="Release destination">
                <Select readOnly={drawerMode === "view"} value={form.releaseDestination ?? ""} onChange={(event) => setForm((current) => ({ ...current, releaseDestination: event.target.value }))}>
                  <option value="">Select destination</option>
                  {(dictionaries.releaseDestinations ?? []).map((item) => (
                    <option key={item.key} value={item.label}>
                      {item.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Receiving party">
                <Input readOnly={drawerMode === "view"} value={form.receivingParty ?? ""} onChange={(event) => setForm((current) => ({ ...current, receivingParty: event.target.value }))} />
              </Field>
              <Field label="Transport mode">
                <Select readOnly={drawerMode === "view"} value={form.transportMode ?? ""} onChange={(event) => setForm((current) => ({ ...current, transportMode: event.target.value }))}>
                  <option value="">Select transport</option>
                  {(dictionaries.transportModes ?? []).map((item) => (
                    <option key={item.key} value={item.label}>
                      {item.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex min-h-12 items-center gap-3 rounded-md border border-border bg-card px-3 py-2 text-sm font-semibold text-foreground">
                  <input type="checkbox" disabled={drawerMode === "view"} checked={Boolean(form.identityChecked)} onChange={(event) => setForm((current) => ({ ...current, identityChecked: event.target.checked }))} />
                  <span>Identity checked</span>
                </label>
                <label className="flex min-h-12 items-center gap-3 rounded-md border border-border bg-card px-3 py-2 text-sm font-semibold text-foreground">
                  <input
                    type="checkbox"
                    disabled={drawerMode === "view" || Boolean(selectedMatch?.holdCheck && selectedMatch.holdCheck !== "No hold")}
                    checked={Boolean(form.holdCleared)}
                    onChange={(event) => setForm((current) => ({ ...current, holdCleared: event.target.checked }))}
                  />
                  <span>Hold cleared</span>
                </label>
              </div>
              <Field label="Notes">
                <Textarea readOnly={drawerMode === "view"} value={form.notes ?? ""} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} />
              </Field>
            </div>

            {drawerMode !== "view" ? (
              <div className="border-t border-border bg-card p-4">
                <Button className="w-full" icon={Save} variant="primary" disabled={!activeSessionWritable || !can("release:create") || saving || !form.matchId} onClick={save}>
                  {saving ? "Saving" : drawerMode === "edit" ? "Save changes" : "Prepare action"}
                </Button>
              </div>
            ) : null}
          </>
          )}
        </DialogSurface>
      ) : null}

      {releaseDecision ? (
        <DecisionDialog
          title={releaseDecision.actionName === "complete" ? "Complete Release Action" : "Cancel Release Action"}
          description={`${releaseDecision.row.operationalId ?? "This release action"} will be marked ${releaseDecision.actionName === "complete" ? "completed" : "cancelled"} and become read-only. The terminal decision is recorded and cannot be reversed from this dialog.`}
          label="Decision note"
          value={releaseDecision.notes}
          onChange={(value) => setReleaseDecision((current) => (current ? { ...current, notes: value, error: "" } : current))}
          onCancel={() => setReleaseDecision(null)}
          onConfirm={confirmReleaseDecision}
          confirmLabel={releaseDecision.actionName === "complete" ? "Complete action" : "Cancel action"}
          confirmIcon={releaseDecision.actionName === "complete" ? CheckCircle2 : XCircle}
          confirmVariant={releaseDecision.actionName === "complete" ? "success" : "danger"}
          error={releaseDecision.error}
          busy={releaseDecision.saving}
          required
          placeholder={releaseDecision.actionName === "complete" ? "Identity, hold, handover and transport confirmed" : "Reason this release action is being cancelled"}
        />
      ) : null}
    </div>
  );
}
