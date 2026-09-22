import { useEffect, useState } from "react";
import { useBlocker } from "react-router-dom";
import { api, ApiRequestError } from "../lib/api";
import { useApp } from "../lib/app-context";
import type { ApiList, SessionRecord } from "../lib/types";
import type { AarVersion, AarPage, AarArtifact, AarSource, AarResult } from "../lib/aar-types";
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
  if (!can("aar:read")) return <AlertBox>You do not have permission to read After Action Reports.</AlertBox>;
  return <div className="grid gap-5">
    <Card><CardHeader title="Report Session" description="Choose a closed event for authoring or an archived event for historical review. This does not change the active operational Session." /><div className="grid gap-3 p-4">
      {error && <AlertBox tone="danger">{error}</AlertBox>}
      <Field label="Report Session status"><Select disabled={locked} value={status} onChange={e => { setStatus(e.target.value); setOffset(0); setSessionId(""); setSelectedSession(undefined); }}><option>Closed</option><option>Archived</option></Select></Field>
      <Field label="Search report Sessions"><Input disabled={locked} value={search} onChange={e => { setSearch(e.target.value); setOffset(0); }} /></Field>
      <Field label="Report Session"><Select disabled={locked} value={sessionId} onChange={e => { setSessionId(e.target.value); setSelectedSession(choices?.data.find(s => s.id === e.target.value)); }}><option value="">Select Session</option>{selectedSession && !choices?.data.some(s => s.id === selectedSession.id) && <option value={selectedSession.id}>{selectedSession.operationalId} · {selectedSession.eventType}</option>}{choices?.data.map(s => <option key={s.id} value={s.id}>{s.operationalId} · {s.eventType}</option>)}</Select></Field>
      <div className="flex gap-3"><Button disabled={locked || offset === 0} onClick={() => setOffset(offset - 20)}>Previous Sessions</Button><span>{choices?.total ?? 0} total</span><Button disabled={locked || offset + 20 >= (choices?.total ?? 0)} onClick={() => setOffset(offset + 20)}>Next Sessions</Button></div>
      {locked && <p>Save or reload the report before changing Session.</p>}
    </div></Card>
    {sessionId ? <AfterActionWorkspace key={sessionId} sessionId={sessionId} onDirtyChange={setLocked} /> : <AlertBox>Select a Session to view After Action Reports.</AlertBox>}
  </div>;
}
function AfterActionWorkspace({ sessionId, onDirtyChange }: { sessionId: string; onDirtyChange: (dirty: boolean) => void }) {
  const [version, setVersion] = useState<AarVersion>();
  const [form, setForm] = useState<Form>();
  const [canCreate, setCanCreate] = useState(false);
  const [canSource, setCanSource] = useState(false);
  const [title, setTitle] = useState("");
  const [reason, setReason] = useState("");
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<AarPage<AarVersion>>();
  const [artifacts, setArtifacts] = useState<AarPage<AarArtifact>>();
  const [sources, setSources] = useState<AarPage<AarSource>>();
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [decision, setDecision] = useState<{ action: string; label: string; operationId: string }>();
  const [createOperationId, setCreateOperationId] = useState(() => crypto.randomUUID());
  const navigationBlocker = useBlocker(dirty);
  useEffect(() => { onDirtyChange(dirty || busy); }, [dirty, busy, onDirtyChange]);
  function failure(e: unknown) {
    setError((e instanceof Error ? e.message : "Unable to complete request") + (e instanceof ApiRequestError && e.status === 409 ? " Your input is preserved. Reload and review the latest version before saving again." : ""));
  }
  async function loadVersion(id: string) {
    const v = await api.aarVersion(id);
    const [h, a] = await Promise.all([api.aarHistory(v.reportId), api.aarArtifacts(id)]);
    setVersion(v); setForm(formFor(v)); setHistory(h); setArtifacts(a); setDirty(false); setSelectedSources([]); setError("");
  }
  async function reload() {
    const list = await api.aarList(sessionId);
    setCanCreate(list.capabilities.create); setCanSource(list.capabilities.sourceObservations);
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
        setCanCreate(list.capabilities.create); setCanSource(list.capabilities.sourceObservations);
        if (list.data[0]) {
          const r = await api.aarReport(list.data[0].id), v = await api.aarVersion(r.latest.id);
          const [h, a] = await Promise.all([api.aarHistory(r.id), api.aarArtifacts(v.id)]);
          if (!active) return;
          setVersion(v); setForm(formFor(v)); setHistory(h); setArtifacts(a);
        }
        if (active) setLoaded(true);
      } catch (e) { if (active) failure(e); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [sessionId]);
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", protect); return () => window.removeEventListener("beforeunload", protect);
  }, [dirty]);
  const change = (update: Partial<Form>) => { setForm(old => ({ ...old!, ...update })); setDirty(true); };
  async function create() {
    if (busy) return; setBusy(true); setError("");
    try { const r = await api.aarCreate({ sessionId, title, operationId: createOperationId, sourceObservationIds: selectedSources }); await loadVersion(r.reportVersionId!); setCanCreate(false); setCreateOperationId(crypto.randomUUID()); }
    catch (e) { failure(e); } finally { setBusy(false); }
  }
  async function save() {
    if (!version || !form || busy) return; setBusy(true); setError("");
    try {
      const result = await api.aarEdit(version.id, { ...form, eventDate: form.eventDate === version.eventDate.slice(0, 10) ? version.eventDate : new Date(form.eventDate).toISOString(), expectedVersion: version.version,
        correctiveActions: form.correctiveActions.map(a => ({ ...a, targetDate: a.targetDate ? new Date(a.targetDate).toISOString() : null })), sourceObservationIds: selectedSources });
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
  if (loading) return <Loading label="Loading After Action Reports" />;
  const editable = Boolean(version?.capabilities.edit);
  return <div className="grid gap-5" data-testid="aar-workspace">
    {error && <AlertBox tone="danger">{error}</AlertBox>}
    <div className="flex flex-wrap gap-3"><Button disabled={busy} onClick={() => ask("reload", "Reload report")}>Reload report</Button>{dirty && <span>Unsaved changes</span>}</div>
    {!version && loaded && <Card><CardHeader title="After Action Reports" description="One report per Session. Authoring is available only after the Session is Closed." /><div className="grid gap-4 p-4">
      <p>No report is available for this Session.</p>
      {canCreate && <><Field label="Report title"><Input value={title} maxLength={500} onChange={e => { setTitle(e.target.value); setCreateOperationId(crypto.randomUUID()); }} /></Field><Button variant="create" disabled={busy || !title.trim()} onClick={() => void create()}>Create report</Button></>}
    </div></Card>}
    {canSource && (canCreate || editable) && <Card><CardHeader title="Exercise Observation snapshots" description="Selected evidence is copied into findings; later Observation edits do not rewrite it." /><div className="grid gap-3 p-4">
      <Button disabled={busy} onClick={() => safe(async () => setSources(await api.aarSources(sessionId)))}>Choose observations</Button>
      {sources?.data.map(s => <label key={s.id} className="flex gap-2"><input type="checkbox" checked={selectedSources.includes(s.id)} disabled={busy} onChange={e => { setSelectedSources(old => e.target.checked ? [...old, s.id] : old.filter(id => id !== s.id)); setDirty(Boolean(version)); setCreateOperationId(crypto.randomUUID()); }} /><span>{s.operationalId} v{s.version} · {s.area}: {s.observation}</span></label>)}
      {sources && pagination(sources, async offset => setSources(await api.aarSources(sessionId, offset)))}
    </div></Card>}
    {version && form && <>
      <Card><CardHeader title={version.report.operationalId + " · Revision " + version.revision} description={"Session: " + version.report.session.status + " · Report: " + version.report.status} action={<StatusBadge value={version.status} />} />
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
      <div className="flex flex-wrap gap-3">
        {editable && <Button variant="primary" disabled={busy || !dirty} onClick={() => void save()}>Save draft</Button>}
        {version.capabilities.submit && <Button disabled={busy || dirty} onClick={() => ask("submit", "Submit for review")}>Submit for review</Button>}
        {version.capabilities.returnToDraft && <Button disabled={busy} onClick={() => ask("return-to-draft", "Return to draft")}>Return to draft</Button>}
        {version.capabilities.approve && <Button disabled={busy} onClick={() => ask("approve", "Approve report")}>Approve report</Button>}
        {version.capabilities.createRevision && <Button disabled={busy} onClick={() => ask("revisions", "Create revision")}>Create revision</Button>}
      </div>
      {version.capabilities.archive && <Card><div className="grid gap-3 p-4"><Field label="Archive reason"><Input value={reason} maxLength={2000} onChange={e => setReason(e.target.value)} /></Field><Button disabled={busy || !reason.trim()} onClick={() => ask("archive", "Archive report")}>Archive report</Button></div></Card>}
      <Card><CardHeader title="Versions" /><div className="grid gap-3 p-4">
        {history?.data.map(v => <div key={v.id} className="flex flex-wrap items-center gap-3"><span>Revision {v.revision} · {v.status}</span><Button disabled={busy || dirty} onClick={() => safe(() => loadVersion(v.id))}>View revision {v.revision}</Button></div>)}
        {history && pagination(history, async offset => setHistory(await api.aarHistory(version.reportId, offset)))}
      </div></Card>
      <Card><CardHeader title="PDF Export" description="Downloads use the retained, integrity-checked artifact. SHA-256 is not a digital signature." /><div className="grid gap-3 p-4">
        {version.capabilities.generatePdf && <Button disabled={busy} onClick={() => ask("pdf-artifacts", "Generate PDF")}>Generate PDF</Button>}
        {artifacts?.data.map(a => <div key={a.id} className="grid gap-2 rounded border p-3">
          <p>{a.generatedAt} · {a.generatedBy.displayName} · {a.contentSizeBytes} bytes · {a.rendererVersion}</p>
          <p className="break-all text-xs">Artifact: {a.id}<br />PDF SHA-256: {a.contentSha256}<br />Source SHA-256: {a.sourceContentSha256}</p>
          <Button disabled={busy} onClick={() => safe(() => api.aarDownload(a.id))}>Download PDF</Button>
        </div>)}
        {artifacts?.total === 0 && <p>No retained PDF artifacts for this revision.</p>}
        {artifacts && pagination(artifacts, async offset => setArtifacts(await api.aarArtifacts(version.id, offset)))}
      </div></Card>
    </>}
    {decision && <ConfirmDialog title={decision.label} description={decision.action === "reload" ? "Reload the current revision? Unsaved input will be discarded." : decision.action === "approve" ? "Approval permanently locks this version and every section. Later changes require a new revision." : "Confirm this explicit report action."} confirmLabel={decision.label} busy={busy} error={error} onCancel={() => setDecision(undefined)} onConfirm={confirm} />}
    {navigationBlocker.state === "blocked" && <ConfirmDialog title="Leave unsaved report?" description="Unsaved report changes will be discarded if you leave this page." confirmLabel="Discard and leave" confirmVariant="danger" onCancel={() => navigationBlocker.reset()} onConfirm={() => navigationBlocker.proceed()} />}
  </div>;
}
