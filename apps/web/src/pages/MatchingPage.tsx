import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, History, RefreshCw, Search, ShieldCheck, UserCheck, XCircle } from "lucide-react";
import { ApiRequestError, api } from "../lib/api";
import { useApp } from "../lib/app-context";
import type { AnyRecord } from "../lib/types";
import { DialogSurface } from "../components/DialogSurface";
import { AlertBox, Badge, Button, Card, CardHeader, EmptyState, ErrorSummary, Field, Input, Loading, Select, StatusBadge, Textarea } from "../components/ui";

const queuePageSize = 50;
const candidatePageSize = 25;

type DecisionMode = "confirm" | "reject" | "invalidate";
type DecisionDialogState = {
  mode: DecisionMode;
  passenger?: AnyRecord;
  suggestion?: AnyRecord;
  decision?: AnyRecord;
  reason: string;
  operationId: string;
  error: string;
};

function operationId() {
  return crypto.randomUUID();
}

function personName(record?: AnyRecord | null) {
  if (!record) return "Not recorded";
  return [record.firstName, record.lastName].filter(Boolean).join(" ") || record.operationalId || "Not recorded";
}

function claimPassengerName(claim?: AnyRecord | null) {
  if (!claim) return "Not recorded";
  return [claim.claimedPassengerFirstName, claim.claimedPassengerLastName].filter(Boolean).join(" ") || "Not recorded";
}

function formatDate(value: unknown) {
  if (!value) return "Not recorded";
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function percent(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? `${Math.round(number * 100)}%` : "No score";
}

function queueStateTone(state: string) {
  if (state === "CONFIRMED") return "success" as const;
  if (state === "STALE") return "danger" as const;
  if (state === "SUGGESTED") return "info" as const;
  return "neutral" as const;
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof ApiRequestError && error.status === 409) {
    return "This matching context changed while you were reviewing it. No automatic retry was attempted. Reload the claim, review the latest versions, then decide again.";
  }
  return error instanceof Error ? error.message : fallback;
}

export function MatchingPage() {
  const { activeSession, activeSessionWritable, can, verifyActiveSessionWrite } = useApp();
  const [queue, setQueue] = useState<AnyRecord[]>([]);
  const [queueTotal, setQueueTotal] = useState(0);
  const [queueOffset, setQueueOffset] = useState(0);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [relationshipFilter, setRelationshipFilter] = useState("");
  const [selectedClaimId, setSelectedClaimId] = useState("");
  const [context, setContext] = useState<AnyRecord | null>(null);
  const [candidates, setCandidates] = useState<AnyRecord[]>([]);
  const [candidateTotal, setCandidateTotal] = useState(0);
  const [candidateSearchDraft, setCandidateSearchDraft] = useState("");
  const [candidateSearch, setCandidateSearch] = useState("");
  const [candidateOffset, setCandidateOffset] = useState(0);
  const [loadingQueue, setLoadingQueue] = useState(true);
  const [loadingContext, setLoadingContext] = useState(false);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [decisionDialog, setDecisionDialog] = useState<DecisionDialogState | null>(null);

  const sessionId = activeSession?.id ?? "";
  const claim = context?.relationshipClaim;
  const currentDecision = context?.currentDecision;
  const canGenerate = activeSessionWritable && can("matching:create");
  const canConfirm = activeSessionWritable && can("matching:verify");
  const canReject = activeSessionWritable && can("matching:reject");

  const activeSuggestions = useMemo(
    () => (context?.suggestions ?? []).filter((item: AnyRecord) => item.status === "ACTIVE" && item.isCurrent),
    [context]
  );

  async function loadQueue(preferredClaimId = selectedClaimId) {
    if (!sessionId) {
      setQueue([]);
      setQueueTotal(0);
      setSelectedClaimId("");
      setLoadingQueue(false);
      return;
    }
    setLoadingQueue(true);
    setError("");
    try {
      const result = await api.matchingQueue({
        sessionId,
        search,
        state: stateFilter,
        relationshipStatus: relationshipFilter,
        sortBy: "updatedAt",
        sortDirection: "desc",
        limit: queuePageSize,
        offset: queueOffset
      });
      setQueue(result.data);
      setQueueTotal(result.total ?? result.data.length);
      const stillVisible = result.data.some((item) => item.relationshipClaim?.id === preferredClaimId);
      if (!preferredClaimId || !stillVisible) setSelectedClaimId(result.data[0]?.relationshipClaim?.id ?? "");
    } catch (loadError) {
      setError(errorMessage(loadError, "Unable to load the matching queue"));
    } finally {
      setLoadingQueue(false);
    }
  }

  async function loadContext(claimId = selectedClaimId) {
    if (!sessionId || !claimId) {
      setContext(null);
      return;
    }
    setLoadingContext(true);
    setError("");
    try {
      setContext(await api.matchingContext(claimId, sessionId));
    } catch (loadError) {
      setContext(null);
      setError(errorMessage(loadError, "Unable to load matching context"));
    } finally {
      setLoadingContext(false);
    }
  }

  async function loadCandidates(claimId = selectedClaimId) {
    if (!sessionId || !claimId) {
      setCandidates([]);
      setCandidateTotal(0);
      return;
    }
    setLoadingCandidates(true);
    try {
      const result = await api.matchingCandidates(claimId, {
        sessionId,
        search: candidateSearch,
        sortDirection: "asc",
        limit: candidatePageSize,
        offset: candidateOffset
      });
      setCandidates(result.data);
      setCandidateTotal(result.total ?? result.data.length);
    } catch (loadError) {
      setError(errorMessage(loadError, "Unable to load passenger candidates"));
    } finally {
      setLoadingCandidates(false);
    }
  }

  useEffect(() => {
    setQueueOffset(0);
    setSelectedClaimId("");
    setContext(null);
    setCandidateOffset(0);
    setDecisionDialog(null);
    setNotice("");
  }, [sessionId]);

  useEffect(() => {
    void loadQueue();
  }, [sessionId, search, stateFilter, relationshipFilter, queueOffset]);

  useEffect(() => {
    void loadContext();
    setCandidateOffset(0);
  }, [sessionId, selectedClaimId]);

  useEffect(() => {
    void loadCandidates();
  }, [sessionId, selectedClaimId, candidateSearch, candidateOffset]);

  async function generateSuggestions() {
    if (!claim || !await verifyActiveSessionWrite(sessionId)) return;
    setGenerating(true);
    setError("");
    try {
      await api.generateMatchingSuggestions(claim.id, { sessionId, expectedClaimVersion: claim.version });
      setNotice("A new immutable suggestion generation was stored. Human confirmation is still required.");
      await Promise.all([loadContext(claim.id), loadQueue(claim.id)]);
    } catch (generationError) {
      setError(errorMessage(generationError, "Unable to generate suggestions"));
    } finally {
      setGenerating(false);
    }
  }

  function openConfirm(passenger: AnyRecord, suggestion?: AnyRecord) {
    setDecisionDialog({ mode: "confirm", passenger, suggestion, reason: "", operationId: operationId(), error: "" });
  }

  function openReject(suggestion: AnyRecord) {
    setDecisionDialog({ mode: "reject", passenger: suggestion.passenger, suggestion, reason: "", operationId: operationId(), error: "" });
  }

  function openInvalidate(decision: AnyRecord) {
    setDecisionDialog({ mode: "invalidate", decision, reason: "", operationId: operationId(), error: "" });
  }

  async function submitDecision() {
    if (!decisionDialog || !claim || !await verifyActiveSessionWrite(sessionId)) return;
    if (decisionDialog.reason.trim().length < 3) {
      setDecisionDialog({ ...decisionDialog, error: "Document a decision reason of at least 3 characters." });
      return;
    }
    setSaving(true);
    setDecisionDialog({ ...decisionDialog, error: "" });
    try {
      let result: AnyRecord;
      if (decisionDialog.mode === "confirm") {
        result = await api.confirmMatching(claim.id, {
          sessionId,
          passengerRecordId: decisionDialog.passenger?.id,
          suggestionId: decisionDialog.suggestion?.id ?? null,
          reason: decisionDialog.reason.trim(),
          expectedClaimVersion: claim.version,
          expectedPassengerVersion: decisionDialog.passenger?.version,
          operationId: decisionDialog.operationId
        });
      } else if (decisionDialog.mode === "reject") {
        result = await api.rejectMatchingSuggestion(claim.id, {
          sessionId,
          passengerRecordId: decisionDialog.suggestion?.passengerRecordId,
          suggestionId: decisionDialog.suggestion?.id,
          reason: decisionDialog.reason.trim(),
          expectedClaimVersion: claim.version,
          expectedPassengerVersion: decisionDialog.suggestion?.passenger?.version,
          expectedSuggestionVersion: decisionDialog.suggestion?.version,
          operationId: decisionDialog.operationId
        });
      } else {
        const passengerVersion = context?.decisionHistory?.find((item: AnyRecord) => item.id === decisionDialog.decision?.id)?.passengerVersion;
        result = await api.invalidateMatchingDecision(claim.id, {
          sessionId,
          decisionId: decisionDialog.decision?.id,
          reason: decisionDialog.reason.trim(),
          expectedClaimVersion: claim.version,
          expectedPassengerVersion: passengerVersion,
          operationId: decisionDialog.operationId
        });
      }
      setDecisionDialog(null);
      setNotice(result?.idempotent ? "The earlier successful decision was recovered safely using the same operation ID." : "The human matching decision was recorded.");
      await Promise.all([loadContext(claim.id), loadQueue(claim.id)]);
    } catch (decisionError) {
      setDecisionDialog((current) => current ? { ...current, error: errorMessage(decisionError, "Unable to save the decision") } : current);
    } finally {
      setSaving(false);
    }
  }

  if (!activeSession) return <EmptyState title="Select an incident" detail="Matching is always scoped to one incident." />;

  const queueStart = queueTotal ? queueOffset + 1 : 0;
  const queueEnd = Math.min(queueOffset + queuePageSize, queueTotal);
  const candidateStart = candidateTotal ? candidateOffset + 1 : 0;
  const candidateEnd = Math.min(candidateOffset + candidatePageSize, candidateTotal);

  return (
    <div className="grid gap-4">
      <div>
        <h1 className="text-2xl font-black text-foreground">Matching workspace</h1>
        <p className="mt-1 text-sm font-semibold text-muted-foreground">Persisted algorithm suggestions and human decisions are separate. Nothing is confirmed automatically.</p>
      </div>

      {!activeSessionWritable ? <AlertBox>Matching is read-only because this incident is closed or unavailable for writes.</AlertBox> : null}
      {error ? <AlertBox tone="danger" dismissible>{error}</AlertBox> : null}
      {notice ? <AlertBox tone="success" dismissible>{notice}</AlertBox> : null}

      <Card>
        <CardHeader title="Claim queue" description="Server-filtered and paged; the browser does not build a passenger-by-family cross-product." />
        <form
          className="grid gap-3 border-b border-border p-4 md:grid-cols-[minmax(14rem,1fr)_12rem_12rem_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            setQueueOffset(0);
            setSearch(searchDraft.trim());
          }}
        >
          <Field label="Search claims">
            <Input value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} placeholder="Claimant, passenger, flight or operational ID" />
          </Field>
          <Field label="Match state">
            <Select value={stateFilter} onChange={(event) => { setQueueOffset(0); setStateFilter(event.target.value); }}>
              <option value="">All states</option>
              <option value="UNMATCHED">Unmatched</option>
              <option value="SUGGESTED">Suggested</option>
              <option value="CONFIRMED">Confirmed</option>
              <option value="STALE">Stale / review required</option>
            </Select>
          </Field>
          <Field label="Relationship status">
            <Select value={relationshipFilter} onChange={(event) => { setQueueOffset(0); setRelationshipFilter(event.target.value); }}>
              <option value="">All statuses</option>
              <option value="VERIFIED">Verified</option>
              <option value="UNVERIFIED">Unverified</option>
              <option value="DISPUTED">Disputed</option>
              <option value="REJECTED">Rejected</option>
            </Select>
          </Field>
          <div className="self-end"><Button type="submit" variant="primary" icon={Search}>Search</Button></div>
        </form>

        <div className="grid min-h-[36rem] lg:grid-cols-[22rem_minmax(0,1fr)]">
          <aside aria-label="Matching claim queue" className="border-b border-border lg:border-b-0 lg:border-r">
            <div className="flex items-center justify-between border-b border-border px-3 py-2 text-sm font-semibold text-muted-foreground">
              <span>{queueStart}–{queueEnd} of {queueTotal}</span>
              {loadingQueue ? <Loading label="Loading" /> : null}
            </div>
            <div className="max-h-[42rem] overflow-y-auto p-2">
              {!loadingQueue && !queue.length ? <EmptyState title="No claims found" detail="Adjust the server-side filters." /> : null}
              {queue.map((item) => {
                const itemClaim = item.relationshipClaim;
                const selected = selectedClaimId === itemClaim.id;
                return (
                  <button
                    key={itemClaim.id}
                    type="button"
                    aria-pressed={selected}
                    className={`focus-ring mb-2 w-full rounded-md border p-3 text-left ${selected ? "border-[#145C63] bg-[#145C63]/10" : "border-border bg-card hover:bg-muted"}`}
                    onClick={() => setSelectedClaimId(itemClaim.id)}
                  >
                    <span className="flex items-start justify-between gap-2">
                      <span className="min-w-0 font-black text-foreground">{personName(itemClaim.family)}</span>
                      <Badge tone={queueStateTone(item.state)}>{item.state}</Badge>
                    </span>
                    <span className="mt-1 block text-sm text-muted-foreground">Looking for {claimPassengerName(itemClaim)}</span>
                    <span className="mt-2 flex flex-wrap gap-1">
                      <StatusBadge value={itemClaim.status} />
                      <Badge>{item.suggestionCount} suggestions</Badge>
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="flex items-center justify-between border-t border-border p-2">
              <Button size="sm" icon={ChevronLeft} disabled={queueOffset === 0} onClick={() => setQueueOffset(Math.max(0, queueOffset - queuePageSize))}>Previous</Button>
              <Button size="sm" icon={ChevronRight} disabled={queueOffset + queuePageSize >= queueTotal} onClick={() => setQueueOffset(queueOffset + queuePageSize)}>Next</Button>
            </div>
          </aside>

          <main className="min-w-0 p-4">
            {loadingContext ? <Loading label="Loading claim context" /> : null}
            {!loadingContext && !context ? <EmptyState title="Select a claim" detail="Review its persisted suggestions and decision history." /> : null}
            {!loadingContext && context ? (
              <div className="grid gap-4">
                <section className="rounded-md border border-border p-4" aria-labelledby="matching-claim-heading">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <h2 id="matching-claim-heading" className="text-lg font-black text-foreground">{personName(claim.family)} → {claimPassengerName(claim)}</h2>
                      <p className="mt-1 text-sm text-muted-foreground">Claim {claim.family.operationalId} · version {claim.version} · updated {formatDate(claim.updatedAt)}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Badge tone={queueStateTone(context.state)}>{context.state}</Badge>
                      <StatusBadge value={claim.status} />
                    </div>
                  </div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-3">
                    <div className="rounded-md bg-muted p-3"><p className="text-xs font-bold uppercase text-muted-foreground">Claimed relationship</p><p className="mt-1 font-black">{claim.claimedRelationshipType || "Not recorded"}</p></div>
                    <div className="rounded-md bg-muted p-3"><p className="text-xs font-bold uppercase text-muted-foreground">Relationship verification</p><p className="mt-1"><StatusBadge value={claim.status} /></p></div>
                    <div className="rounded-md bg-muted p-3"><p className="text-xs font-bold uppercase text-muted-foreground">Claimed flight</p><p className="mt-1 font-black">{claim.claimedPassengerFlight || "Not recorded"}</p></div>
                  </div>
                  <p className="mt-3 flex items-start gap-2 text-sm font-semibold text-muted-foreground"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />Confirming a passenger does not verify this relationship. Release requires both independently.</p>
                </section>

                {currentDecision ? (
                  <section className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-emerald-950">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <h3 className="font-black">Current human decision: {currentDecision.decision}</h3>
                        <p className="mt-1 text-sm font-semibold">Passenger {currentDecision.passengerRecordId} · {currentDecision.reason}</p>
                        <p className="mt-1 text-xs font-semibold">By {currentDecision.decisionByDisplayName || "Recorded actor"} at {formatDate(currentDecision.decidedAt)} · validity {currentDecision.effectiveValidity}</p>
                      </div>
                      {canConfirm ? <Button variant="danger" size="sm" icon={XCircle} onClick={() => openInvalidate(currentDecision)}>Invalidate</Button> : null}
                    </div>
                  </section>
                ) : null}

                {context.state === "STALE" ? <AlertBox tone="danger"><strong>Review required.</strong> The claim or passenger changed after the decision. The historical decision remains auditable but is not current and cannot support Release.</AlertBox> : null}

                <section aria-labelledby="suggestion-heading">
                  <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div><h3 id="suggestion-heading" className="font-black text-foreground">Persisted suggestions</h3><p className="text-sm text-muted-foreground">Algorithm evidence is immutable and never doubles as a human decision.</p></div>
                    {canGenerate ? <Button icon={RefreshCw} variant="create" disabled={generating} onClick={() => void generateSuggestions()}>{generating ? "Generating…" : "Generate suggestions"}</Button> : null}
                  </div>
                  {!activeSuggestions.length ? <EmptyState title="No current suggestions" detail="Generate a narrowed, explainable candidate set or use manual passenger search." /> : null}
                  <div className="grid gap-3">
                    {activeSuggestions.map((suggestion: AnyRecord) => (
                      <article key={suggestion.id} className="rounded-md border border-border p-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <h4 className="font-black text-foreground">{personName(suggestion.passenger)} · {suggestion.passenger?.operationalId}</h4>
                            <p className="mt-1 text-sm text-muted-foreground">{suggestion.passenger?.flightNumber || "No flight"} · {suggestion.passenger?.route || "No route"} · passenger v{suggestion.passengerVersion}</p>
                          </div>
                          <div className="flex flex-wrap gap-2"><Badge tone="info">{percent(suggestion.score)}</Badge><StatusBadge value={suggestion.status} /></div>
                        </div>
                        <div className="mt-3 grid gap-3 md:grid-cols-2">
                          <div><p className="text-xs font-black uppercase text-emerald-800">Positive signals</p><ul className="mt-1 list-disc pl-5 text-sm">{suggestion.positiveSignals?.length ? suggestion.positiveSignals.map((signal: AnyRecord, index: number) => <li key={`${signal.key}-${index}`}>{signal.label}{signal.detail ? `: ${signal.detail}` : ""}</li>) : <li>None recorded</li>}</ul></div>
                          <div><p className="text-xs font-black uppercase text-red-800">Conflicts</p><ul className="mt-1 list-disc pl-5 text-sm">{suggestion.conflicts?.length ? suggestion.conflicts.map((signal: AnyRecord, index: number) => <li key={`${signal.key}-${index}`}>{signal.label}{signal.detail ? `: ${signal.detail}` : ""}</li>) : <li>No detected conflicts</li>}</ul></div>
                        </div>
                        <p className="mt-3 text-xs font-semibold text-muted-foreground">{suggestion.algorithm} v{suggestion.algorithmVersion} · generation {suggestion.generationId} · suggestion v{suggestion.version}</p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {canConfirm ? <Button variant="success" size="sm" icon={CheckCircle2} onClick={() => openConfirm(suggestion.passenger, suggestion)}>Confirm match</Button> : null}
                          {canReject ? <Button variant="danger" size="sm" icon={XCircle} onClick={() => openReject(suggestion)}>Reject suggestion</Button> : null}
                        </div>
                      </article>
                    ))}
                  </div>
                </section>

                <section className="rounded-md border border-border" aria-labelledby="manual-heading">
                  <div className="border-b border-border bg-muted p-3"><h3 id="manual-heading" className="font-black">Manual passenger selection</h3><p className="text-sm text-muted-foreground">Server-paged search; manual confirmation has no invented algorithm score.</p></div>
                  <form className="flex gap-2 p-3" onSubmit={(event) => { event.preventDefault(); setCandidateOffset(0); setCandidateSearch(candidateSearchDraft.trim()); }}>
                    <Input aria-label="Search passenger candidates" value={candidateSearchDraft} onChange={(event) => setCandidateSearchDraft(event.target.value)} placeholder="Passenger name, operational ID, flight or route" />
                    <Button type="submit" icon={Search}>Search</Button>
                  </form>
                  <div className="divide-y divide-border">
                    {loadingCandidates ? <div className="p-3"><Loading label="Loading candidates" /></div> : null}
                    {!loadingCandidates && !candidates.length ? <div className="p-3"><EmptyState title="No passengers found" /></div> : null}
                    {candidates.map((passenger) => (
                      <div key={passenger.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                        <div><p className="font-black">{personName(passenger)} · {passenger.operationalId}</p><p className="text-sm text-muted-foreground">{passenger.flightNumber || "No flight"} · {passenger.route || "No route"} · v{passenger.version}</p></div>
                        {canConfirm ? <Button size="sm" icon={UserCheck} onClick={() => openConfirm(passenger)}>Manual confirm</Button> : null}
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center justify-between border-t border-border p-2 text-sm font-semibold text-muted-foreground">
                    <Button size="sm" icon={ChevronLeft} disabled={candidateOffset === 0} onClick={() => setCandidateOffset(Math.max(0, candidateOffset - candidatePageSize))}>Previous</Button>
                    <span>{candidateStart}–{candidateEnd} of {candidateTotal}</span>
                    <Button size="sm" icon={ChevronRight} disabled={candidateOffset + candidatePageSize >= candidateTotal} onClick={() => setCandidateOffset(candidateOffset + candidatePageSize)}>Next</Button>
                  </div>
                </section>

                <details className="rounded-md border border-border p-3">
                  <summary className="cursor-pointer font-black"><History className="mr-2 inline h-4 w-4" />Decision history ({context.decisionHistory?.length ?? 0})</summary>
                  <div className="mt-3 grid gap-2">
                    {(context.decisionHistory ?? []).map((item: AnyRecord) => <div key={item.id} className="rounded bg-muted p-2 text-sm"><strong>{item.decision}</strong> · {item.effectiveValidity} · {item.reason} · {formatDate(item.decidedAt)}</div>)}
                    {!context.decisionHistory?.length ? <p className="text-sm text-muted-foreground">No human decisions recorded.</p> : null}
                  </div>
                </details>
              </div>
            ) : null}
          </main>
        </div>
      </Card>

      {decisionDialog ? (
        <DialogSurface
          title={decisionDialog.mode === "confirm" ? "Confirm passenger match" : decisionDialog.mode === "reject" ? "Reject algorithm suggestion" : "Invalidate current match"}
          description="This appends a human decision with actor, reason, versions and operation ID."
          onClose={() => setDecisionDialog(null)}
          busy={saving}
          dirty={decisionDialog.reason.length > 0}
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-5 text-foreground shadow-2xl"
          initialFocus="first-control"
        >
          <div className="grid gap-4">
            <div>
              <h2 data-dialog-heading="true" tabIndex={-1} className="text-lg font-black">
                {decisionDialog.mode === "confirm" ? "Confirm passenger match" : decisionDialog.mode === "reject" ? "Reject algorithm suggestion" : "Invalidate current match"}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {decisionDialog.mode === "confirm" ? `${personName(claim?.family)} → ${personName(decisionDialog.passenger)}` : decisionDialog.mode === "reject" ? `Suggestion for ${personName(decisionDialog.passenger)}` : `Decision ${decisionDialog.decision?.id}`}
              </p>
            </div>
            {decisionDialog.mode === "confirm" && claim?.status !== "VERIFIED" ? <AlertBox><AlertTriangle className="mr-1 inline h-4 w-4" />The relationship is not verified. This match decision will not change that status and will not make Release eligible.</AlertBox> : null}
            {decisionDialog.mode === "confirm" && decisionDialog.suggestion ? (
              <div className="grid gap-3 rounded-md border border-border bg-muted p-3 sm:grid-cols-2">
                <div>
                  <p className="text-xs font-black uppercase text-emerald-800">Signals reviewed</p>
                  <ul className="mt-1 list-disc pl-5 text-sm">{decisionDialog.suggestion.positiveSignals?.length ? decisionDialog.suggestion.positiveSignals.map((signal: AnyRecord, index: number) => <li key={`${signal.key}-${index}`}>{signal.label}</li>) : <li>None recorded</li>}</ul>
                </div>
                <div>
                  <p className="text-xs font-black uppercase text-red-800">Conflicts reviewed</p>
                  <ul className="mt-1 list-disc pl-5 text-sm">{decisionDialog.suggestion.conflicts?.length ? decisionDialog.suggestion.conflicts.map((signal: AnyRecord, index: number) => <li key={`${signal.key}-${index}`}>{signal.label}</li>) : <li>No detected conflicts</li>}</ul>
                </div>
                <p className="text-xs font-semibold text-muted-foreground sm:col-span-2">Algorithm {decisionDialog.suggestion.algorithm} v{decisionDialog.suggestion.algorithmVersion} · score {percent(decisionDialog.suggestion.score)}</p>
              </div>
            ) : null}
            <ErrorSummary errors={decisionDialog.error ? [{ message: decisionDialog.error, fieldId: decisionDialog.error.startsWith("Document") ? "matching-decision-reason" : undefined }] : []} />
            <Field id="matching-decision-reason" label="Decision reason" required helperText="State the evidence reviewed or why the prior decision is no longer valid.">
              <Textarea data-dialog-initial-focus="true" value={decisionDialog.reason} onChange={(event) => setDecisionDialog({ ...decisionDialog, reason: event.target.value, error: "" })} />
            </Field>
            <div className="rounded-md bg-muted p-3 text-xs font-semibold text-muted-foreground">
              Operation ID: {decisionDialog.operationId}<br />The same ID is retained after a timeout, so retrying this dialog is safe. A 409 is never retried automatically.
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button disabled={saving} onClick={() => setDecisionDialog(null)}>Cancel</Button>
              <Button variant={decisionDialog.mode === "confirm" ? "success" : "danger"} disabled={saving} onClick={() => void submitDecision()}>
                {saving ? "Recording…" : decisionDialog.mode === "confirm" ? "Confirm match" : decisionDialog.mode === "reject" ? "Reject suggestion" : "Invalidate match"}
              </Button>
            </div>
          </div>
        </DialogSurface>
      ) : null}
    </div>
  );
}
