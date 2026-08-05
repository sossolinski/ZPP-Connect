import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, FilePlus2, RefreshCw, Search, ShieldCheck, UserCheck, XCircle } from "lucide-react";
import { ApiRequestError, api } from "../lib/api";
import { useApp } from "../lib/app-context";
import type { AnyRecord } from "../lib/types";
import { DialogSurface } from "../components/DialogSurface";
import { AlertBox, Badge, Button, Card, CardHeader, EmptyState, ErrorSummary, Field, Input, Loading, Select, StatusBadge, Textarea } from "../components/ui";
import { formatDate } from "../lib/format";

const pageSize = 25;
const candidatePageSize = 25;

type PrepareState = {
  candidateId: string;
  actionType: "REUNIFICATION" | "RELEASE";
  releaseDestination: string;
  receivingParty: string;
  transportMode: string;
  notes: string;
  operationId: string;
  error: string;
};

type CommandType = "identity" | "hold" | "authorize" | "complete" | "cancel";
type CommandState = {
  type: CommandType;
  basis: string;
  result: "PASS" | "FAIL";
  evidenceReference: string;
  operationId: string;
  error: string;
};

function newOperationId() {
  return crypto.randomUUID();
}

function person(record?: AnyRecord | null) {
  return record ? [record.firstName, record.lastName].filter(Boolean).join(" ") || record.operationalId : "Not recorded";
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof ApiRequestError && error.status === 409) {
    return "The action or its safety inputs changed while you were reviewing it. No automatic retry was attempted. Refresh the current context and review every precondition before deciding again.";
  }
  return error instanceof Error ? error.message : fallback;
}

function tone(state: string) {
  if (state === "PASS" || state === "CURRENT") return "success" as const;
  if (state === "STALE" || state === "REQUIRES_REVIEW") return "danger" as const;
  if (state === "BLOCKED" || state === "FAIL") return "warning" as const;
  return "neutral" as const;
}

function commandTitle(type: CommandType, actionType: string) {
  if (type === "identity") return "Record identity check";
  if (type === "hold") return "Record Passenger hold review";
  if (type === "authorize") return `AUTHORIZE ${actionType}`;
  if (type === "complete") return `COMPLETE ${actionType}`;
  return `Cancel ${actionType}`;
}

export function ReleasePage() {
  const { activeSession, activeSessionWritable, dictionaries, can, verifyActiveSessionWrite } = useApp();
  const sessionId = activeSession?.id ?? "";
  const [queue, setQueue] = useState<AnyRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [eligibility, setEligibility] = useState("");
  const [actionType, setActionType] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [context, setContext] = useState<AnyRecord | null>(null);
  const [candidates, setCandidates] = useState<AnyRecord[]>([]);
  const [candidateTotal, setCandidateTotal] = useState(0);
  const [candidateOffset, setCandidateOffset] = useState(0);
  const [candidateSearchDraft, setCandidateSearchDraft] = useState("");
  const [candidateSearch, setCandidateSearch] = useState("");
  const [loadingQueue, setLoadingQueue] = useState(true);
  const [loadingContext, setLoadingContext] = useState(false);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [prepare, setPrepare] = useState<PrepareState | null>(null);
  const [command, setCommand] = useState<CommandState | null>(null);

  const candidateById = useMemo(() => new Map(candidates.map((item) => [item.matchDecisionId, item])), [candidates]);
  const selectedCandidate = prepare ? candidateById.get(prepare.candidateId) : null;

  async function loadQueue(preferredId = selectedId) {
    if (!sessionId) {
      setQueue([]);
      setTotal(0);
      setSelectedId("");
      setLoadingQueue(false);
      return;
    }
    setLoadingQueue(true);
    setError("");
    try {
      const result = await api.list("releases/queue", { sessionId, search, status, eligibility, actionType, sortDirection: "desc", limit: pageSize, offset });
      setQueue(result.data);
      setTotal(result.total ?? result.data.length);
      if (!preferredId || !result.data.some((item) => item.id === preferredId)) setSelectedId(result.data[0]?.id ?? "");
    } catch (loadError) {
      setError(errorMessage(loadError, "Unable to load the release queue"));
    } finally {
      setLoadingQueue(false);
    }
  }

  async function loadContext(id = selectedId) {
    if (!sessionId || !id) {
      setContext(null);
      return;
    }
    setLoadingContext(true);
    setError("");
    try {
      setContext(await api.record("releases", id, { sessionId }));
    } catch (loadError) {
      setContext(null);
      setError(errorMessage(loadError, "Unable to load release decision context"));
    } finally {
      setLoadingContext(false);
    }
  }

  async function loadCandidates() {
    if (!sessionId) {
      setCandidates([]);
      setCandidateTotal(0);
      return;
    }
    setLoadingCandidates(true);
    try {
      const result = await api.list("releases/candidates", { sessionId, search: candidateSearch, sortDirection: "asc", limit: candidatePageSize, offset: candidateOffset });
      setCandidates(result.data);
      setCandidateTotal(result.total ?? result.data.length);
    } catch (loadError) {
      setError(errorMessage(loadError, "Unable to load current human matches"));
    } finally {
      setLoadingCandidates(false);
    }
  }

  useEffect(() => {
    setOffset(0);
    setCandidateOffset(0);
    setSelectedId("");
    setContext(null);
    setPrepare(null);
    setCommand(null);
    setNotice("");
  }, [sessionId]);

  useEffect(() => { void loadQueue(); }, [sessionId, search, status, eligibility, actionType, offset]);
  useEffect(() => { void loadContext(); }, [sessionId, selectedId]);
  useEffect(() => { void loadCandidates(); }, [sessionId, candidateSearch, candidateOffset]);

  function openPrepare(candidate?: AnyRecord) {
    setPrepare({ candidateId: candidate?.matchDecisionId ?? candidates[0]?.matchDecisionId ?? "", actionType: "REUNIFICATION", releaseDestination: "", receivingParty: "", transportMode: "", notes: "", operationId: newOperationId(), error: "" });
  }

  function openCommand(type: CommandType) {
    setCommand({ type, basis: "", result: "PASS", evidenceReference: "", operationId: newOperationId(), error: "" });
  }

  async function submitPrepare() {
    if (!prepare || !sessionId || !await verifyActiveSessionWrite(sessionId)) return;
    setSaving(true);
    setPrepare((current) => current ? { ...current, error: "" } : null);
    try {
      const record = await api.create("releases/prepare", {
        sessionId,
        matchDecisionId: prepare.candidateId,
        actionType: prepare.actionType,
        releaseDestination: prepare.releaseDestination || null,
        receivingParty: prepare.receivingParty || null,
        transportMode: prepare.transportMode || null,
        notes: prepare.notes || null,
        operationId: prepare.operationId
      });
      setPrepare(null);
      setNotice(`${record.operationalId} prepared. This is not authorization or completion.`);
      setSelectedId(record.id);
      setContext(record);
      await loadQueue(record.id);
    } catch (saveError) {
      setPrepare((current) => current ? { ...current, error: errorMessage(saveError, "Unable to prepare release action") } : null);
    } finally {
      setSaving(false);
    }
  }

  async function submitCommand() {
    if (!command || !context || !sessionId || !await verifyActiveSessionWrite(sessionId)) return;
    setSaving(true);
    setCommand((current) => current ? { ...current, error: "" } : null);
    const checkCommand = command.type === "identity" || command.type === "hold";
    const body: AnyRecord = { sessionId, expectedVersion: context.version, operationId: command.operationId, ...(checkCommand ? { basis: command.basis } : { reason: command.basis }) };
    if (command.type === "identity") Object.assign(body, { result: command.result, evidenceReference: command.evidenceReference || null });
    try {
      const suffix = command.type === "identity" ? "checks/identity" : command.type === "hold" ? "checks/hold" : command.type;
      const record = await api.action("releases", context.id, suffix, body);
      setContext(record);
      setCommand(null);
      setNotice(record.idempotent ? "The previous committed operation was recovered safely by operationId." : `${commandTitle(command.type, context.actionType)} recorded.`);
      await loadQueue(record.id);
    } catch (saveError) {
      setCommand((current) => current ? { ...current, error: errorMessage(saveError, "Unable to record the controlled release command") } : null);
    } finally {
      setSaving(false);
    }
  }

  async function refreshCurrent() {
    setCommand(null);
    await Promise.all([loadContext(), loadQueue(), loadCandidates()]);
  }

  const prepared = context?.status === "PREPARED";
  const authorized = context?.status === "AUTHORIZED";
  const real = activeSession?.mode === "REAL";
  const queueEnd = Math.min(offset + queue.length, total);

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader
          title="Release / Reunification Control"
          description="ELIGIBLE ≠ PREPARED ≠ AUTHORIZED ≠ COMPLETED. Every final outcome is an explicit human command."
          action={<Button icon={FilePlus2} variant="create" disabled={!activeSessionWritable || !can("release:prepare") || !candidates.length} onClick={() => openPrepare()}>Prepare action</Button>}
        />
        <div className="grid gap-3 border-b border-border p-4 lg:grid-cols-[minmax(220px,1fr)_180px_180px_180px_auto]">
          <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); setOffset(0); setSearch(searchDraft.trim()); }}>
            <Input aria-label="Search release queue" value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} placeholder="Release, Passenger or NOK" />
            <Button icon={Search} type="submit" size="icon" aria-label="Search" />
          </form>
          <Select aria-label="Release status" value={status} onChange={(event) => { setStatus(event.target.value); setOffset(0); }}>
            <option value="">All states</option><option value="PREPARED">Prepared</option><option value="AUTHORIZED">Authorized</option><option value="COMPLETED">Completed</option><option value="CANCELLED">Cancelled</option>
          </Select>
          <Select aria-label="Eligibility" value={eligibility} onChange={(event) => { setEligibility(event.target.value); setOffset(0); }}>
            <option value="">Eligible and blocked</option><option value="eligible">All checks pass</option><option value="blocked">Blocked / stale</option>
          </Select>
          <Select aria-label="Action type" value={actionType} onChange={(event) => { setActionType(event.target.value); setOffset(0); }}>
            <option value="">Both action types</option><option value="REUNIFICATION">Reunification</option><option value="RELEASE">Release</option>
          </Select>
          <Button icon={RefreshCw} onClick={() => void refreshCurrent()}>Refresh</Button>
        </div>
        {error ? <div className="p-4"><AlertBox>{error}</AlertBox></div> : null}
        {notice ? <div className="p-4 pb-0"><AlertBox>{notice}</AlertBox></div> : null}
        <div className="grid min-h-[560px] lg:grid-cols-[360px_minmax(0,1fr)]">
          <div className="border-r border-border p-3">
            {loadingQueue ? <Loading /> : queue.length ? <div className="grid gap-2">
              {queue.map((row) => (
                <button key={row.id} className={`focus-ring rounded-md border p-3 text-left ${selectedId === row.id ? "border-[#145C63] bg-[#145C63]/5" : "border-border bg-card hover:bg-muted"}`} onClick={() => setSelectedId(row.id)}>
                  <div className="flex flex-wrap items-center gap-2"><span className="font-black">{row.operationalId}</span><StatusBadge value={row.status} /><Badge tone={tone(row.effectiveState)}>{row.effectiveState}</Badge></div>
                  <p className="mt-2 text-sm font-bold">{person(row.passenger)}</p>
                  <p className="mt-1 text-xs text-muted-foreground">NOK: {person(row.relationship?.family)} · {row.actionType}</p>
                  {row.blockers?.length ? <p className="mt-2 line-clamp-2 text-xs font-semibold text-amber-800">{row.blockers[0]}</p> : null}
                </button>
              ))}
            </div> : <EmptyState title="No release actions" detail="Prepare an action from a current human match." />}
            <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
              <Button icon={ChevronLeft} size="icon" aria-label="Previous page" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - pageSize))} />
              <span className="text-xs font-bold text-muted-foreground">{total ? offset + 1 : 0}–{queueEnd} of {total}</span>
              <Button icon={ChevronRight} size="icon" aria-label="Next page" disabled={queueEnd >= total} onClick={() => setOffset(offset + pageSize)} />
            </div>
          </div>

          <div className="min-w-0 p-4">
            {loadingContext ? <Loading /> : context ? <div className="grid gap-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div><div className="flex flex-wrap items-center gap-2"><h2 className="text-xl font-black">{context.operationalId}</h2><StatusBadge value={context.status} /><Badge tone={tone(context.effectiveState)}>{context.effectiveState}</Badge></div><p className="mt-1 text-sm text-muted-foreground">{context.actionType} · version {context.version} · prepared {formatDate(context.preparedAt)}</p></div>
                <div className="flex flex-wrap gap-2">
                  {prepared && can("release:check") ? <Button icon={UserCheck} onClick={() => openCommand("identity")}>Identity check</Button> : null}
                  {prepared && can("release:check") ? <Button icon={ShieldCheck} onClick={() => openCommand("hold")}>Review hold</Button> : null}
                  {prepared && can("release:authorize") ? <Button icon={ShieldCheck} variant="warning" disabled={!context.canAuthorize} onClick={() => openCommand("authorize")}>Authorize</Button> : null}
                  {authorized && can("release:complete") ? <Button icon={CheckCircle2} variant="success" disabled={!context.canComplete} onClick={() => openCommand("complete")}>Complete</Button> : null}
                  {(prepared || authorized) && can("release:cancel") ? <Button icon={XCircle} variant="danger" onClick={() => openCommand("cancel")}>Cancel</Button> : null}
                </div>
              </div>

              {context.effectiveState === "REQUIRES_REVIEW" ? <AlertBox>Data used to prepare or authorize this action changed. Refresh, review the current upstream records and prepare a new action where required. Authorization is never auto-retried.</AlertBox> : null}
              {context.legacyImported ? <AlertBox>Historical legacy record. Evidence was not fabricated during migration{context.verificationEvidenceUnavailable ? "; verification evidence is unavailable" : ""}.</AlertBox> : null}

              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-md border border-border p-3"><p className="text-xs font-bold uppercase text-muted-foreground">Passenger</p><p className="mt-1 font-black">{person(context.passenger)}</p><p className="text-sm text-muted-foreground">{context.passenger?.operationalId} · hold: {context.passenger?.holdStatus}</p></div>
                <div className="rounded-md border border-border p-3"><p className="text-xs font-bold uppercase text-muted-foreground">NOK / recipient context</p><p className="mt-1 font-black">{person(context.relationship?.family)}</p><p className="text-sm text-muted-foreground">{context.relationship?.relationshipType ?? "Relationship not recorded"} · claim v{context.relationship?.version}</p></div>
              </div>

              <section aria-labelledby="release-preconditions"><h3 id="release-preconditions" className="text-sm font-black uppercase tracking-wide">Critical preconditions</h3><div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {(context.preconditions ?? []).map((item: AnyRecord) => <div key={item.key} className="rounded-md border border-border p-3"><div className="flex items-center justify-between gap-2"><p className="text-sm font-black">{item.label}</p><Badge tone={tone(item.state)}>{item.state}</Badge></div><p className="mt-1 text-xs leading-5 text-muted-foreground">{item.detail}</p></div>)}
              </div></section>

              <section aria-labelledby="release-check-history"><h3 id="release-check-history" className="text-sm font-black uppercase tracking-wide">Independent check provenance</h3><div className="mt-2 grid gap-2">
                {context.checks?.length ? context.checks.map((check: AnyRecord) => <div key={check.id} className="rounded-md border border-border p-3"><div className="flex flex-wrap items-center gap-2"><Badge tone={check.result === "PASS" ? "success" : "danger"}>{check.type} {check.result}</Badge><Badge tone={check.current ? "success" : "warning"}>{check.current ? "CURRENT" : "STALE"}</Badge><span className="text-xs text-muted-foreground">{check.actorDisplayName ?? "Unknown actor"} · {formatDate(check.checkedAt)}</span></div><p className="mt-2 text-sm">{check.basis}</p>{check.evidenceReference ? <p className="mt-1 text-xs text-muted-foreground">Evidence reference: {check.evidenceReference}</p> : null}</div>) : <EmptyState title="No independent checks" detail="Identity and hold review are explicit recorded events, not editable checkboxes." />}
              </div></section>

              {context.passenger?.holdStatus !== "No hold" ? <AlertBox>BLOCKED — active Passenger hold. Release Control cannot clear it. {can("passenger:control") ? <a className="font-black underline" href={`/records?focus=${encodeURIComponent(context.passengerRecordId)}`}>Open the Passenger workflow.</a> : null}</AlertBox> : null}
            </div> : <EmptyState title="Select a release action" detail="The backend context will show Passenger, NOK, match, checks and current blockers separately." />}
          </div>
        </div>
      </Card>

      {prepare ? <DialogSurface title="Prepare release action" description="Preparation is not authorization" onClose={() => setPrepare(null)} busy={saving} dirty={Boolean(prepare.notes || prepare.releaseDestination || prepare.receivingParty)} initialFocus="first-control" className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-border bg-card shadow-2xl">
        {({ requestClose }) => <><div className="border-b border-border p-5"><h2 data-dialog-heading="true" tabIndex={-1} className="text-lg font-black">Prepare release / reunification</h2><p className="mt-1 text-sm text-muted-foreground">Creates a versioned PREPARED action only. It does not record checks, authorize or complete an outcome.</p></div><div className="grid flex-1 content-start gap-4 overflow-y-auto p-5"><ErrorSummary title="Action could not be prepared" errors={prepare.error ? [{ message: prepare.error }] : []} />
          <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); setCandidateOffset(0); setCandidateSearch(candidateSearchDraft.trim()); }}><Input data-dialog-initial-focus="true" value={candidateSearchDraft} onChange={(event) => setCandidateSearchDraft(event.target.value)} placeholder="Search current human matches" /><Button type="submit" icon={Search}>Search</Button></form>
          <Field label="Current human match" required><Select value={prepare.candidateId} onChange={(event) => setPrepare({ ...prepare, candidateId: event.target.value })}><option value="">Select match</option>{candidates.map((item) => <option key={item.matchDecisionId} value={item.matchDecisionId}>{item.passenger.operationalId} · {person(item.passenger)} ↔ {person(item.family)}{item.eligible ? "" : " · BLOCKED"}</option>)}</Select></Field>
          {loadingCandidates ? <Loading /> : selectedCandidate ? <div className="rounded-md border border-border p-3"><div className="flex flex-wrap gap-2"><Badge tone={selectedCandidate.eligible ? "success" : "warning"}>{selectedCandidate.eligible ? "ELIGIBLE NOW" : "PREPARED WILL BE BLOCKED"}</Badge><span className="text-sm font-bold">Passenger hold: {selectedCandidate.passengerHold}</span></div>{selectedCandidate.blockers?.length ? <p className="mt-2 text-sm text-amber-800">{selectedCandidate.blockers.join("; ")}</p> : null}</div> : null}
          <div className="flex items-center justify-between"><Button icon={ChevronLeft} size="icon" disabled={candidateOffset === 0} onClick={() => setCandidateOffset(Math.max(0, candidateOffset - candidatePageSize))} /><span className="text-xs font-bold">{candidateTotal ? candidateOffset + 1 : 0}–{Math.min(candidateOffset + candidates.length, candidateTotal)} of {candidateTotal}</span><Button icon={ChevronRight} size="icon" disabled={candidateOffset + candidates.length >= candidateTotal} onClick={() => setCandidateOffset(candidateOffset + candidatePageSize)} /></div>
          <Field label="Action type"><Select value={prepare.actionType} onChange={(event) => setPrepare({ ...prepare, actionType: event.target.value as PrepareState["actionType"] })}><option value="REUNIFICATION">Reunification</option><option value="RELEASE">Release</option></Select></Field>
          <Field label="Release destination"><Select value={prepare.releaseDestination} onChange={(event) => setPrepare({ ...prepare, releaseDestination: event.target.value })}><option value="">Not recorded</option>{(dictionaries.releaseDestinations ?? []).map((item) => <option key={item.key} value={item.label}>{item.label}</option>)}</Select></Field>
          <Field label="Receiving party"><Input value={prepare.receivingParty} onChange={(event) => setPrepare({ ...prepare, receivingParty: event.target.value })} /></Field>
          <Field label="Transport mode"><Select value={prepare.transportMode} onChange={(event) => setPrepare({ ...prepare, transportMode: event.target.value })}><option value="">Not recorded</option>{(dictionaries.transportModes ?? []).map((item) => <option key={item.key} value={item.label}>{item.label}</option>)}</Select></Field>
          <Field label="Preparation notes"><Textarea value={prepare.notes} onChange={(event) => setPrepare({ ...prepare, notes: event.target.value })} /></Field>
        </div><div className="flex justify-end gap-2 border-t border-border p-4"><Button onClick={() => requestClose()}>Close</Button><Button variant="create" disabled={!prepare.candidateId || saving || !can("release:prepare")} onClick={() => void submitPrepare()}>{saving ? "Preparing" : "Prepare action"}</Button></div></>}
      </DialogSurface> : null}

      {command && context ? <DialogSurface title={commandTitle(command.type, context.actionType)} description="Controlled human release decision" onClose={() => setCommand(null)} busy={saving} dirty={Boolean(command.basis)} initialFocus="first-control" layer="nested" className="fixed left-1/2 top-1/2 z-[90] flex max-h-[90vh] w-[min(94vw,680px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-card shadow-2xl">
        {({ requestClose }) => <><div className="border-b border-border p-5"><div className="flex items-start gap-3">{["authorize", "complete"].includes(command.type) ? <AlertTriangle className="mt-0.5 h-5 w-5 text-amber-700" /> : <ShieldCheck className="mt-0.5 h-5 w-5 text-[#145C63]" />}<div><h2 data-dialog-heading="true" tabIndex={-1} className="text-lg font-black">{commandTitle(command.type, context.actionType)}</h2><p className="mt-1 text-sm text-muted-foreground">{context.operationalId} · Passenger {person(context.passenger)} · NOK {person(context.relationship?.family)}</p></div></div></div><div className="grid gap-4 overflow-y-auto p-5"><ErrorSummary title="Command was not recorded" errors={command.error ? [{ message: command.error }] : []} />
          {real && ["authorize", "complete"].includes(command.type) ? <AlertBox>REAL INCIDENT — this is an operational human decision. Review the Passenger, NOK, action type and every current critical precondition below.</AlertBox> : null}
          {["authorize", "complete"].includes(command.type) ? <div className="grid gap-2 sm:grid-cols-2">{context.preconditions.map((item: AnyRecord) => <div key={item.key} className="rounded-md border border-border p-2"><div className="flex justify-between gap-2 text-sm font-bold"><span>{item.label}</span><Badge tone={tone(item.state)}>{item.state}</Badge></div><p className="mt-1 text-xs text-muted-foreground">{item.detail}</p></div>)}</div> : null}
          {command.type === "identity" ? <><Field label="Identity result"><Select value={command.result} onChange={(event) => setCommand({ ...command, result: event.target.value as "PASS" | "FAIL" })}><option value="PASS">PASS</option><option value="FAIL">FAIL</option></Select></Field><Field label="Evidence reference or type" helperText="Do not enter document numbers or copy identity documents here."><Input value={command.evidenceReference} onChange={(event) => setCommand({ ...command, evidenceReference: event.target.value })} /></Field></> : null}
          {command.type === "hold" ? <AlertBox>The result is derived from the current Passenger hold state. This check cannot clear or alter the hold.</AlertBox> : null}
          <Field label={command.type === "identity" || command.type === "hold" ? "Check basis" : command.type === "cancel" ? "Cancellation reason" : "Human decision basis"} required><Textarea data-dialog-initial-focus="true" value={command.basis} onChange={(event) => setCommand({ ...command, basis: event.target.value })} placeholder="Record the operational basis without unnecessary PII" /></Field>
        </div><div className="flex justify-end gap-2 border-t border-border p-4"><Button onClick={() => requestClose()}>Close</Button><Button variant={command.type === "cancel" ? "danger" : command.type === "complete" ? "success" : command.type === "authorize" ? "warning" : "primary"} disabled={command.basis.trim().length < 3 || saving} onClick={() => void submitCommand()}>{saving ? "Recording" : commandTitle(command.type, context.actionType)}</Button></div></>}
      </DialogSurface> : null}
    </div>
  );
}
