import { useEffect, useState } from "react";
import { Link, useBlocker, useSearchParams } from "react-router-dom";
import { api, ApiRequestError } from "../lib/api";
import { useApp } from "../lib/app-context";
import type { ApiList, SessionRecord } from "../lib/types";
import type { AarVersion, AarPage, AarArtifact, AarResult } from "../lib/aar-types";
import { RecordsContext } from "../components/RecordsContext";
import { AlertBox, Button, Card, CardHeader, ConfirmDialog, Field, Input, Loading, Select, StatusBadge, Textarea } from "../components/ui";

type Form = Pick<AarVersion, "title" | "eventDate" | "executiveSummary" | "findings" | "lessons" | "correctiveActions">;
function formFor(v: AarVersion): Form {
  return { title: v.title, eventDate: v.eventDate.slice(0, 10), executiveSummary: v.executiveSummary,
    findings: v.findings.map(f => ({ id: f.id, area: f.area, summary: f.summary, detail: f.detail ?? "" })),
    lessons: v.lessons.map(l => ({ statement: l.statement })),
    correctiveActions: v.correctiveActions.map(a => ({ recommendation: a.recommendation, owner: a.owner ?? "", targetDate: a.targetDate?.slice(0, 10) ?? "" })) };
}
function reordered<T>(items: T[], index: number, shift: number) {
  const next = [...items]; [next[index], next[index + shift]] = [next[index + shift]!, next[index]!]; return next;
}
export function AfterActionReportsPage() {
  const { can } = useApp();
  const [params, setParams] = useSearchParams();
  const requestedIncident = params.get("incidentId");
  const [contextError, setContextError] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [selectedSession, setSelectedSession] = useState<SessionRecord>();
  const [status, setStatus] = useState("Closed");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [choices, setChoices] = useState<ApiList<SessionRecord>>();
  const [error, setError] = useState("");
  const [locked, setLocked] = useState(false);
  useEffect(() => {
    let active = true;
    setChoices(undefined);
    void api.sessions({ status, search, offset, limit: 20 }).then(result => { if (active) { setChoices(result); setError(""); } }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [status, search, offset]);
  useEffect(() => {
    if (requestedIncident === null) return;
    let active = true;
    setSelectedSession(undefined); setSessionId(""); setContextError("");
    if (!requestedIncident || requestedIncident.length > 100) { setContextError("Invalid report incident link."); return; }
    void api.recordIncident(requestedIncident).then(s => {
      if (!active) return;
      if (s.mode !== "REAL" || !["Closed", "Archived"].includes(s.status)) { setContextError("Post-Incident Reporting requires a closed or archived REAL incident."); return; }
      setSelectedSession(s); setSessionId(s.id); setStatus(s.status);
    }).catch(e => { if (active) setContextError("Report incident unavailable: " + e.message); });
    return () => { active = false; };
  }, [requestedIncident]);
  function choose(id: string) {
    const next = new URLSearchParams(params); next.delete("revisionId"); next.delete("artifactId");
    if (id) next.set("incidentId", id); else next.delete("incidentId");
    setSelectedSession(choices?.data.find(s => s.id === id)); setSessionId(id); setParams(next);
  }
  if (!can("aar:read")) return <AlertBox>Post-Incident Reports unavailable for your role.</AlertBox>;
  return <div className="grid min-w-0 gap-5">
    <RecordsContext incident={selectedSession} />
    {contextError && <AlertBox tone="danger">{contextError}</AlertBox>}
    <Card><CardHeader title="Review a historical incident" description="Post-Incident Report · After Action Review (AAR). Choose a closed incident to prepare a report or an archived incident for historical review. The active operational incident does not change." /><div className="grid gap-3 p-4">
      {error && <AlertBox tone="danger">Historical incidents unavailable: {error}</AlertBox>}
      <Field label="Report incident status"><Select disabled={locked} value={status} onChange={e => { setStatus(e.target.value); setOffset(0); choose(""); }}><option>Closed</option><option>Archived</option></Select></Field>
      <Field label="Search report incidents"><Input disabled={locked} value={search} onChange={e => { setSearch(e.target.value); setOffset(0); }} /></Field>
      <Field label="Report incident"><Select disabled={locked} value={sessionId} onChange={e => choose(e.target.value)}><option value="">Select historical incident</option>{selectedSession && !choices?.data.some(s => s.id === selectedSession.id) && <option value={selectedSession.id}>{selectedSession.operationalId} · {selectedSession.eventType}</option>}{choices?.data.map(s => <option key={s.id} value={s.id}>{s.operationalId} · {s.eventType}</option>)}</Select></Field>
      {choices ? <div className="flex flex-wrap gap-3"><Button disabled={locked || offset === 0} onClick={() => setOffset(offset - 20)}>Previous incidents</Button><span>{choices.total} historical incidents</span><Button disabled={locked || offset + 20 >= (choices.total ?? choices.data.length)} onClick={() => setOffset(offset + 20)}>Next incidents</Button></div> : !error ? <Loading label="Loading historical incidents" /> : <p>Historical incident source unavailable.</p>}
      {locked && <p>Save or reload the report before changing incident.</p>}
    </div></Card>
    {sessionId && !contextError ? <AfterActionWorkspace key={sessionId + (params.get("revisionId") ?? "") + (params.get("artifactId") ?? "")} sessionId={sessionId} revisionId={params.get("revisionId")} artifactId={params.get("artifactId")} onDirtyChange={setLocked} /> : !contextError ? <AlertBox>Select a historical incident to view its Post-Incident Report.</AlertBox> : null}
  </div>;
}
function AfterActionWorkspace({ sessionId, revisionId, artifactId, onDirtyChange }: { sessionId: string; revisionId: string | null; artifactId: string | null; onDirtyChange: (dirty: boolean) => void }) {
  const [verifiedArtifact, setVerifiedArtifact] = useState("");
  const [version, setVersion] = useState<AarVersion>();
  const [form, setForm] = useState<Form>();
  const [canCreate, setCanCreate] = useState(false);
  const [title, setTitle] = useState("");
  const [reason, setReason] = useState("");
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<AarPage<AarVersion>>();
  const [artifacts, setArtifacts] = useState<AarPage<AarArtifact>>();
  const [decision, setDecision] = useState<{ action: string; label: string; operationId: string }>();
  const [createOperationId, setCreateOperationId] = useState(() => crypto.randomUUID());
  const navigationBlocker = useBlocker(dirty);
  useEffect(() => { onDirtyChange(dirty || busy); }, [dirty, busy, onDirtyChange]);
  function failure(e: unknown) {
    setError((e instanceof Error ? e.message : "Unable to complete request") + (e instanceof ApiRequestError && e.status === 409 ? " Your input is preserved. Reload and review the latest version before saving again." : ""));
  }
  async function loadVersion(id: string) {
    const v = await api.aarVersion(id);
    if (v.report.sessionId !== sessionId) throw new Error("The selected revision does not belong to this incident.");
    const [h, a] = await Promise.all([api.aarHistory(v.reportId), api.aarArtifacts(id)]);
    setVersion(v); setForm(formFor(v)); setHistory(h); setArtifacts(a); setDirty(false); setError("");
  }
  async function reload() {
    const list = await api.aarList(sessionId);
    setCanCreate(list.capabilities.create);
    if (list.data[0]) { const r = await api.aarReport(list.data[0].id); await loadVersion(r.latest.id); }
    setLoaded(true);
    setError("");
  }
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const list = await api.aarList(sessionId);
        if (!active) return;
        setCanCreate(list.capabilities.create);
        if (list.data[0]) {
          const r = await api.aarReport(list.data[0].id), v = await api.aarVersion(revisionId ?? r.latest.id);
          if (v.report.sessionId !== sessionId) throw new Error("The selected revision does not belong to this incident.");
          const [h, a] = await Promise.all([api.aarHistory(r.id), api.aarArtifacts(v.id)]);
          if (artifactId !== null) {
            const exact = await api.aarArtifact(artifactId);
            if (exact.reportVersionId !== v.id) throw new Error("The selected PDF does not belong to this report revision.");
            if (!a.data.some(item => item.id === exact.id)) a.data = [exact, ...a.data];
          }
          if (!active) return;
          setVersion(v); setForm(formFor(v)); setHistory(h); setArtifacts(a);
        }
        if (!list.data[0] && (revisionId !== null || artifactId !== null)) throw new Error("Selected report revision or PDF unavailable.");
        if (active) setLoaded(true);
      } catch (e) { if (active) failure(e); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [sessionId, revisionId, artifactId]);
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", protect); return () => window.removeEventListener("beforeunload", protect);
  }, [dirty]);
  const change = (update: Partial<Form>) => { setForm(old => ({ ...old!, ...update })); setDirty(true); };
  async function create() {
    if (busy) return; setBusy(true); setError("");
    try { const r = await api.aarCreate({ sessionId, title, operationId: createOperationId }); await loadVersion(r.reportVersionId!); setCanCreate(false); setCreateOperationId(crypto.randomUUID()); }
    catch (e) { failure(e); } finally { setBusy(false); }
  }
  async function save() {
    if (!version || !form || busy) return; setBusy(true); setError("");
    try {
      const result = await api.aarEdit(version.id, { ...form, eventDate: form.eventDate === version.eventDate.slice(0, 10) ? version.eventDate : new Date(form.eventDate).toISOString(), expectedVersion: version.version,
        correctiveActions: form.correctiveActions.map(a => ({ ...a, targetDate: a.targetDate ? new Date(a.targetDate).toISOString() : null })) });
      await loadVersion(result.reportVersionId!);
    } catch (e) { failure(e); } finally { setBusy(false); }
  }
  const ask = (action: string, label: string) => setDecision({ action, label, operationId: crypto.randomUUID() });
  async function confirm() {
    if (!decision || busy) return; setBusy(true); setError("");
    try {
      if (decision.action === "reload") await reload();
      else if (version) {
        const reportCommand = ["revisions", "archive"].includes(decision.action);
        const result: AarResult = await api.aarCommand(reportCommand ? version.reportId : version.id, decision.action,
          { operationId: decision.operationId, expectedVersion: reportCommand ? version.report.version : version.version, ...(decision.action === "archive" ? { reason } : {}) }, reportCommand);
        await loadVersion(result.reportVersionId ?? version.id);
      }
      setDecision(undefined);
    } catch (e) { failure(e); } finally { setBusy(false); }
  }
  const safe = (work: () => Promise<unknown>) => { setError(""); void work().catch(failure); };
  const pagination = (page: { offset: number; total: number; limit: number }, changePage: (offset: number) => Promise<unknown>) => <div className="flex items-center gap-3">
    <Button disabled={busy || page.offset === 0} onClick={() => safe(() => changePage(Math.max(0, page.offset - page.limit)))}>Previous</Button>
    <span>{page.total} total · {page.offset + 1}–{Math.min(page.offset + page.limit, page.total)}</span>
    <Button disabled={busy || page.offset + page.limit >= page.total} onClick={() => safe(() => changePage(page.offset + page.limit))}>Next</Button>
  </div>;
  const controls = (index: number, length: number, move: (shift: number) => void, remove: () => void) => <div className="flex gap-2">
    <Button disabled={busy || index === 0} onClick={() => move(-1)}>Move up</Button><Button disabled={busy || index + 1 === length} onClick={() => move(1)}>Move down</Button><Button disabled={busy} onClick={remove}>Remove</Button>
  </div>;
  if (loading) return <Loading label="Loading Post-Incident Report" />;
  const editable = Boolean(version?.capabilities.edit);
  return <div className="grid gap-5" data-testid="aar-workspace">
    {error && <AlertBox tone="danger">{error}</AlertBox>}
    <div className="flex flex-wrap gap-3"><Button disabled={busy} onClick={() => ask("reload", "Reload report")}>Reload report</Button>{dirty && <span>Unsaved changes</span>}</div>
    {!version && loaded && <Card><CardHeader title="Post-Incident Report" description="One report per incident. Authoring is available only after the incident is Closed." /><div className="grid gap-4 p-4">
      <p>No report is available for this incident.</p>
      {canCreate && <><Field label="Report title"><Input value={title} maxLength={500} onChange={e => { setTitle(e.target.value); setCreateOperationId(crypto.randomUUID()); }} /></Field><Button variant="create" disabled={busy || !title.trim()} onClick={() => void create()}>Create report</Button></>}
    </div></Card>}
    {version && form && <>
      <AlertBox><strong>Revision {version.revision} · {version.status}</strong><p>{version.status === "Draft" ? editable ? "Draft content can be edited by your role. Save changes before submitting for review." : "Draft authoring is unavailable for your role or historical incident state." : version.status === "Under review" ? "Content is locked during review. An authorized reviewer can return it to Draft; an authorized approver can approve it." : "Approved content is immutable. View the narrative below or prepare a separate new revision if permitted."}</p><p>{version.status === "Draft" ? version.capabilities.submit ? "Next available transition: Submit for review." : "Submission unavailable for your access." : version.status === "Under review" ? version.capabilities.approve ? "Next available transition: Approve report or return to Draft." : "Approval unavailable for your access." : "Retained PDFs belong to this exact approved revision."}</p></AlertBox>
      {version.status === "Approved" ? <Card><CardHeader title={version.title} description={`${version.report.session.operationalId} · ${version.report.operationalId} · Revision ${version.revision}`} action={<StatusBadge value="Approved — immutable" />} /><article data-testid="approved-report" className="grid min-w-0 gap-5 p-4">
        <p>Approved {version.approvedAt ? new Date(version.approvedAt).toLocaleString("en-GB") : "date unavailable"} by {version.contextSnapshot.approver ?? "actor unavailable"}. Later changes require a new revision.</p>
        <p>Event date: {new Date(version.eventDate).toLocaleDateString("en-GB")} · Owner: {version.contextSnapshot.owner ?? version.report.owner.displayName} · Author: {version.contextSnapshot.author ?? "actor unavailable"}</p>
        <section><h3 className="mb-2 text-lg font-bold">Executive Summary</h3><p className="whitespace-pre-wrap break-words">{version.executiveSummary}</p></section>
        <section><h3 className="mb-2 text-lg font-bold">Findings</h3>{version.findings.length ? <ol className="grid gap-3">{version.findings.map((f,i) => <li key={i} className="rounded border p-3"><h4 className="font-bold">{i+1}. {f.area} · {f.summary}</h4>{f.detail && <p className="whitespace-pre-wrap break-words">{f.detail}</p>}{f.sourceObservationOperationalId && <p>Observation snapshot: {f.sourceObservationOperationalId} v{f.sourceObservationVersion}</p>}</li>)}</ol> : <p>No findings recorded.</p>}</section>
        <section><h3 className="mb-2 text-lg font-bold">Lessons Identified</h3>{version.lessons.length ? <ol className="grid gap-2">{version.lessons.map((l,i) => <li key={i} className="whitespace-pre-wrap break-words">{i+1}. {l.statement}</li>)}</ol> : <p>No lessons recorded.</p>}</section>
        <section><h3 className="mb-2 text-lg font-bold">Corrective Actions / Recommendations</h3><p className="mb-2 text-sm">Approved recommendations are historical snapshots, not live task tracking.</p>{version.correctiveActions.length ? <ol className="grid gap-3">{version.correctiveActions.map((a,i) => <li key={i} className="rounded border p-3"><p className="whitespace-pre-wrap break-words">{i+1}. {a.recommendation}</p><p>Owner: {a.owner || "Not recorded"} · Target: {a.targetDate ? new Date(a.targetDate).toLocaleDateString("en-GB") : "Not recorded"}</p></li>)}</ol> : <p>No recommendations recorded.</p>}</section>
        <details><summary className="focus-ring cursor-pointer font-bold">Approved content integrity details</summary><p className="break-all text-xs">SHA-256: {version.contentSha256}. Approved source is verified during generation and retained bytes are verified on download; this is not a digital signature.</p></details>
      </article></Card> : <>      <Card><CardHeader title={version.report.operationalId + " · Revision " + version.revision} description={version.report.session.operationalId + " · " + version.report.session.status + " incident · " + (version.report.status === "Active" ? "Report available" : "Report archived")} action={<StatusBadge value={version.status} />} />
        <div className="grid gap-4 p-4">
          <Field label="Report title"><Input value={form.title} maxLength={500} disabled={!editable || busy} onChange={e => change({ title: e.target.value })} /></Field>
          <Field label="Event date"><Input type="date" value={form.eventDate} disabled={!editable || busy} onChange={e => change({ eventDate: e.target.value })} /></Field>
          <Field label="Executive Summary"><Textarea rows={6} maxLength={50000} value={form.executiveSummary} disabled={!editable || busy} onChange={e => change({ executiveSummary: e.target.value })} /></Field>
          {version.contentSha256 && <p className="break-all text-xs">Approved content SHA-256: {version.contentSha256}</p>}
        </div>
      </Card>
      <Card><CardHeader title="Findings" /><div className="grid gap-4 p-4">
        {form.findings.map((f, i) => <div key={i} className="grid gap-2 rounded border p-3">
          <Field label={"Finding " + (i + 1) + " area"}><Input value={f.area} disabled={!editable || busy} maxLength={200} onChange={e => change({ findings: form.findings.map((x, n) => n === i ? { ...x, area: e.target.value } : x) })} /></Field>
          <Field label={"Finding " + (i + 1) + " summary"}><Textarea value={f.summary} disabled={!editable || busy} maxLength={10000} onChange={e => change({ findings: form.findings.map((x, n) => n === i ? { ...x, summary: e.target.value } : x) })} /></Field>
          <Field label={"Finding " + (i + 1) + " detail"}><Textarea value={f.detail ?? ""} disabled={!editable || busy} maxLength={10000} onChange={e => change({ findings: form.findings.map((x, n) => n === i ? { ...x, detail: e.target.value } : x) })} /></Field>
          {version.findings.find(x => x.id === f.id)?.sourceObservationOperationalId && <p>Observation snapshot: {version.findings.find(x => x.id === f.id)?.sourceObservationOperationalId}</p>}
          {editable && controls(i, form.findings.length, shift => change({ findings: reordered(form.findings, i, shift) }), () => change({ findings: form.findings.filter((_, n) => n !== i) }))}
        </div>)}
        {editable && <Button disabled={busy || form.findings.length >= 100} onClick={() => change({ findings: [...form.findings, { area: "", summary: "", detail: "" }] })}>Add finding</Button>}
      </div></Card>
      <Card><CardHeader title="Lessons Identified" /><div className="grid gap-4 p-4">
        {form.lessons.map((l, i) => <div key={i} className="grid gap-2">
          <Field label={"Lesson " + (i + 1)}><Textarea value={l.statement} disabled={!editable || busy} maxLength={10000} onChange={e => change({ lessons: form.lessons.map((x, n) => n === i ? { statement: e.target.value } : x) })} /></Field>
          {editable && controls(i, form.lessons.length, shift => change({ lessons: reordered(form.lessons, i, shift) }), () => change({ lessons: form.lessons.filter((_, n) => n !== i) }))}
        </div>)}
        {editable && <Button disabled={busy || form.lessons.length >= 100} onClick={() => change({ lessons: [...form.lessons, { statement: "" }] })}>Add lesson</Button>}
      </div></Card>
      <Card><CardHeader title="Corrective Actions / Recommendations" description="Immutable recommendations when approved; not live task tracking." /><div className="grid gap-4 p-4">
        {form.correctiveActions.map((a, i) => <div key={i} className="grid gap-2">
          <Field label={"Recommendation " + (i + 1)}><Textarea value={a.recommendation} disabled={!editable || busy} maxLength={10000} onChange={e => change({ correctiveActions: form.correctiveActions.map((x, n) => n === i ? { ...x, recommendation: e.target.value } : x) })} /></Field>
          <Field label={"Action owner " + (i + 1)}><Input value={a.owner ?? ""} disabled={!editable || busy} maxLength={200} onChange={e => change({ correctiveActions: form.correctiveActions.map((x, n) => n === i ? { ...x, owner: e.target.value } : x) })} /></Field>
          <Field label={"Target date " + (i + 1)}><Input type="date" value={a.targetDate ?? ""} disabled={!editable || busy} onChange={e => change({ correctiveActions: form.correctiveActions.map((x, n) => n === i ? { ...x, targetDate: e.target.value } : x) })} /></Field>
          {editable && controls(i, form.correctiveActions.length, shift => change({ correctiveActions: reordered(form.correctiveActions, i, shift) }), () => change({ correctiveActions: form.correctiveActions.filter((_, n) => n !== i) }))}
        </div>)}
        {editable && <Button disabled={busy || form.correctiveActions.length >= 100} onClick={() => change({ correctiveActions: [...form.correctiveActions, { recommendation: "", owner: "", targetDate: "" }] })}>Add recommendation</Button>}
      </div></Card>
      </>}
      <div className="flex flex-wrap gap-3">
        {editable && <Button variant="primary" disabled={busy || !dirty} onClick={() => void save()}>Save draft</Button>}
        {version.capabilities.submit && <Button disabled={busy || dirty} onClick={() => ask("submit", "Submit for review")}>Submit for review</Button>}
        {version.capabilities.returnToDraft && <Button disabled={busy} onClick={() => ask("return-to-draft", "Return to draft")}>Return to draft</Button>}
        {version.capabilities.approve && <Button disabled={busy} onClick={() => ask("approve", "Approve report")}>Approve report</Button>}
        {version.capabilities.createRevision && <Button disabled={busy} onClick={() => ask("revisions", "Create revision")}>Create revision</Button>}
      </div>
      {version.capabilities.archive && <details><summary className="focus-ring cursor-pointer font-bold">Archive approved report</summary><Card><div className="grid gap-3 p-4"><Field label="Archive reason"><Input value={reason} maxLength={2000} onChange={e => setReason(e.target.value)} /></Field><Button disabled={busy || !reason.trim()} onClick={() => ask("archive", "Archive report")}>Archive report</Button></div></Card></details>}
      <Card><CardHeader title="Revision history" /><div className="grid gap-3 p-4">
        {history?.data.map(v => <div key={v.id} className="flex flex-wrap items-center gap-3"><span>Revision {v.revision} · {v.status}</span><Button disabled={busy || dirty} onClick={() => safe(() => loadVersion(v.id))}>View revision {v.revision}</Button><Link className="focus-ring underline" to={`/reports/after-action?incidentId=${sessionId}&revisionId=${v.id}`}>Link to revision {v.revision}</Link></div>)}
        {history && pagination(history, async offset => setHistory(await api.aarHistory(version.reportId, offset)))}
      </div></Card>
      <Card><CardHeader title="Approved report PDFs" description="Retained historical output for this exact revision. Approved source is verified during generation; downloads automatically verify file integrity. Built-in font fallback displays unsupported Unicode as [U+codepoint]." /><div className="grid gap-3 p-4">
        {version.capabilities.generatePdf && <Button disabled={busy} onClick={() => ask("pdf-artifacts", "Generate PDF")}>Generate PDF</Button>}
        {artifacts?.data.map(a => <div key={a.id} data-testid={a.id === artifactId ? "selected-report-pdf" : "report-pdf"} className="grid min-w-0 gap-2 rounded border p-3">
          {a.id === artifactId && <p className="font-bold">Selected retained PDF</p>}
          <p>{version.report.session.operationalId} · Revision {version.revision} · Approved · Generated {new Date(a.generatedAt).toLocaleString("en-GB")} by {a.generatedBy.displayName} · {a.contentSizeBytes} bytes</p>
          <details><summary className="focus-ring cursor-pointer font-bold">PDF technical integrity details</summary><p className="break-all text-xs">Artifact: {a.id}<br />PDF SHA-256: {a.contentSha256}<br />Source SHA-256: {a.sourceContentSha256}<br />Renderer: {a.rendererVersion}</p></details>
          {verifiedArtifact === a.id && <p role="status">PDF integrity verified for downloaded artifact.</p>}
          <Button aria-label={`Download PDF ${version.report.session.operationalId} revision ${version.revision} generated ${new Date(a.generatedAt).toISOString()}`} disabled={busy} onClick={() => safe(async () => { setVerifiedArtifact(""); await api.aarDownload(a.id); setVerifiedArtifact(a.id); })}>Download PDF</Button>
          <Link className="focus-ring underline" to={`/reports/after-action?incidentId=${sessionId}&revisionId=${version.id}&artifactId=${a.id}`}>Link to this retained PDF</Link>
        </div>)}
        {artifacts?.total === 0 && <p>No retained PDF artifacts for this revision.</p>}
        {artifacts && pagination(artifacts, async offset => setArtifacts(await api.aarArtifacts(version.id, offset)))}
      </div></Card>
    </>}
    {decision && <ConfirmDialog title={decision.label} description={decision.action === "reload" ? "Reload the current revision? Unsaved input will be discarded." : decision.action === "approve" ? "Approval permanently locks this version and every section. Later changes require a new revision." : "Confirm this explicit report action."} confirmLabel={decision.label} busy={busy} error={error} onCancel={() => setDecision(undefined)} onConfirm={confirm} />}
    {navigationBlocker.state === "blocked" && <ConfirmDialog title="Leave unsaved report?" description="Unsaved report changes will be discarded if you leave this page." confirmLabel="Discard and leave" confirmVariant="danger" onCancel={() => navigationBlocker.reset()} onConfirm={() => navigationBlocker.proceed()} />}
  </div>;
}
