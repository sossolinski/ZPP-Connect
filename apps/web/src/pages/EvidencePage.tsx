import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AlertBox, Button, Card, CardHeader, Field, Input, Loading, Select, StatusBadge, Textarea } from "../components/ui";
import { DialogSurface } from "../components/DialogSurface";
import { RecordsContext } from "../components/RecordsContext";
import { useRecordIncident } from "../lib/use-record-incident";
import { useApp } from "../lib/app-context";
import { api } from "../lib/api";
import { isSessionWritable } from "../lib/session-safety";
import type { EvidencePage as EvidencePageResult, EvidenceRecord } from "../lib/evidence-types";

const categories = ["Photograph", "Scanned document", "Authority correspondence", "Operational evidence", "External report", "Reference"];

export function EvidencePage() {
  const { can } = useApp();
  const { incident, error: contextError, loading: contextLoading } = useRecordIncident();
  const [params] = useSearchParams();
  const exactId = params.get("evidenceId");
  const [page, setPage] = useState<EvidencePageResult>();
  const [selected, setSelected] = useState<EvidenceRecord>();
  const [showWithdrawn, setShowWithdrawn] = useState(false);
  const [file, setFile] = useState<File>();
  const [category, setCategory] = useState(categories[0]!);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [verified, setVerified] = useState<string[]>([]);
  const [withdraw, setWithdraw] = useState<EvidenceRecord>();
  const [reason, setReason] = useState("");
  const sequence = useRef(0);
  const writable = !!incident && isSessionWritable(incident);

  async function load(offset = 0) {
    const seq = ++sequence.current;
    if (!incident) { setPage(undefined); return; }
    try {
      const [list, item] = await Promise.all([api.evidenceList(incident.id, offset, showWithdrawn), exactId !== null ? api.evidenceRecord(incident.id, exactId) : Promise.resolve(undefined)]);
      if (sequence.current !== seq) return;
      setPage(list); setSelected(item); setError("");
    } catch (e) { if (sequence.current === seq) { setPage(undefined); setSelected(undefined); setError(e instanceof Error ? e.message : "Evidence unavailable"); } }
  }
  useEffect(() => {
    setPage(undefined); setSelected(undefined); setError(""); setVerified([]); setWithdraw(undefined); setFile(undefined); setDescription("");
    if (incident?.mode === "REAL") void load();
    return () => { sequence.current++; };
  }, [incident?.id, showWithdrawn, exactId]);

  async function upload() {
    if (!incident || !file || busy) return;
    setBusy(true); setError("");
    try {
      await api.evidenceUpload(incident.id, file, category, description, crypto.randomUUID());
      setFile(undefined); setDescription("");
      const input = document.getElementById("evidence-file") as HTMLInputElement | null;
      if (input) input.value = "";
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to upload evidence"); }
    finally { setBusy(false); }
  }

  async function confirmWithdrawal() {
    if (!incident || !withdraw || !reason.trim() || busy) return;
    setBusy(true); setError("");
    try {
      await api.evidenceWithdraw(incident.id, withdraw.id, withdraw.version, reason, crypto.randomUUID());
      setWithdraw(undefined); setReason(""); await load(page?.offset ?? 0);
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to withdraw evidence"); }
    finally { setBusy(false); }
  }
  async function download(record: EvidenceRecord) {
    if (!incident) return;
    setBusy(true); setError("");
    try { await api.evidenceDownload(incident.id, record); setVerified(ids => [...ids, record.id]); }
    catch (e) { setVerified(ids => ids.filter(id => id !== record.id)); setError((e instanceof Error ? e.message : "Download unavailable") + ". Contact the incident or system administrator if integrity verification fails."); }
    finally { setBusy(false); }
  }

  if (contextLoading) return <Loading label="Loading incident context" />;
  if (contextError) return <AlertBox tone="danger">{contextError}</AlertBox>;
  if (!incident) return <AlertBox>Select an incident to view retained evidence.</AlertBox>;
  if (incident.mode !== "REAL") return <AlertBox>Incident evidence is intentionally unavailable in training and exercise sessions.</AlertBox>;
  const recordView = (record: EvidenceRecord) => <article key={record.id} data-testid="evidence-record" className="grid min-w-0 gap-2 rounded border p-3">
    <div className="flex flex-wrap items-center gap-2"><h3 className="break-words font-bold">{record.fileName}</h3><StatusBadge value={record.status === "Withdrawn" ? "Withdrawn — historical" : "Active"} /></div>
    <p>{record.category} · {record.mimeType} · {record.sizeBytes.toLocaleString()} bytes</p>
    <p>Uploaded {new Date(record.createdAt).toLocaleString("en-GB")} by {record.createdBy.displayName}</p>
    {record.description && <p className="whitespace-pre-wrap break-words">{record.description}</p>}
    <p>Malware scan not configured</p>
    {verified.includes(record.id) && <p role="status">Integrity verified for downloaded file.</p>}
    <details><summary className="focus-ring cursor-pointer font-bold">Technical integrity details · {record.operationalId}</summary><div className="mt-2 break-all text-xs"><p>SHA-256: {record.contentSha256}</p><p>Retained bytes are checked automatically on download. A digest does not establish authenticity or malware safety.</p></div></details>
    {record.status === "Withdrawn" ? <p>Withdrawn {record.withdrawnAt ? new Date(record.withdrawnAt).toLocaleString("en-GB") : ""} by {record.withdrawnBy?.displayName ?? "actor unavailable"}: {record.withdrawalReason}. Removed from active records; historical metadata and audit are preserved. Download is unavailable.</p> : <div className="flex flex-wrap gap-2">
      <Button aria-label={`Download verified file ${record.fileName}`} disabled={busy} onClick={() => void download(record)}>Download verified file</Button>
      {can("evidence:withdraw") && writable && <Button aria-label={`Withdraw ${record.fileName}`} disabled={busy} onClick={() => { setWithdraw(record); setReason(""); }}>Withdraw</Button>}
    </div>}
    <Link className="focus-ring text-sm underline" to={`/evidence?incidentId=${incident.id}&evidenceId=${record.id}`}>Link to evidence {record.fileName}</Link>
  </article>;
  return <div className="grid min-w-0 gap-5" data-testid="evidence-workspace">
    <RecordsContext incident={incident} />
    {error && <AlertBox tone="danger">Evidence unavailable: {error}</AlertBox>}
    <AlertBox>Malware scan not configured. Downloads verify retained-file integrity automatically. Only PDF, JPEG, PNG and plain text are accepted.</AlertBox>
    {can("evidence:upload") && writable && <Card><CardHeader title="Upload evidence" description="Upload one bounded file and classify its operational purpose." /><div className="grid gap-4 p-4">
      <Field label="Evidence file"><Input id="evidence-file" type="file" accept=".pdf,.jpg,.jpeg,.png,.txt,application/pdf,image/jpeg,image/png,text/plain" disabled={busy} onChange={e => setFile(e.target.files?.[0])} /></Field>
      <Field label="Category"><Select value={category} disabled={busy} onChange={e => setCategory(e.target.value)}>{categories.map(value => <option key={value}>{value}</option>)}</Select></Field>
      <Field label="Description"><Textarea value={description} maxLength={4000} rows={3} disabled={busy} onChange={e => setDescription(e.target.value)} /></Field>
      <Button variant="create" disabled={busy || !file} onClick={() => void upload()}>Upload retained evidence</Button>
    </div></Card>}
    {selected && <Card><CardHeader title="Selected evidence" description="Exact retained item, independent of the register page or withdrawn filter." /><div className="p-4">{recordView(selected)}</div></Card>}
    <Card><CardHeader title="Evidence register" description={page ? `${page.total} ${showWithdrawn ? "records, including withdrawn history" : "active records"}` : "Evidence source unavailable"} /><div className="grid gap-3 p-4">
      <label className="flex items-center gap-2"><input type="checkbox" checked={showWithdrawn} disabled={busy} onChange={e => setShowWithdrawn(e.target.checked)} />Include withdrawn history</label>
      {!page && !error && <Loading label="Loading incident evidence" />}
      {page?.data.filter(r => r.id !== selected?.id).map(recordView)}
      {page?.data.length === 0 && !selected && <p>No {showWithdrawn ? "retained" : "active"} evidence for this incident.</p>}
      {page && <div className="flex flex-wrap items-center gap-3"><Button disabled={busy || page.offset === 0} onClick={() => void load(Math.max(0, page.offset - page.limit))}>Previous</Button><Button disabled={busy || page.offset + page.limit >= page.total} onClick={() => void load(page.offset + page.limit)}>Next</Button></div>}
    </div></Card>
    {withdraw && <DialogSurface title={`Withdraw ${withdraw.fileName}`} onClose={() => setWithdraw(undefined)} busy={busy} className="fixed inset-0 z-50 m-auto h-fit max-h-[90vh] w-[min(95vw,40rem)] overflow-y-auto rounded border bg-card p-5 shadow-xl">
      <h2 data-dialog-heading="true" tabIndex={-1} className="text-xl font-bold">Withdraw {withdraw.fileName}</h2>
      <p className="my-3">Withdrawal removes the file from active records and disables download. Metadata, retained bytes and audit history are preserved; this is not deletion.</p>
      <Field label="Withdrawal reason"><Textarea value={reason} maxLength={2000} rows={3} disabled={busy} onChange={e => setReason(e.target.value)} /></Field>
      {error && <AlertBox tone="danger">{error}</AlertBox>}
      <div className="mt-3 flex flex-wrap gap-2"><Button disabled={busy} onClick={() => setWithdraw(undefined)}>Cancel</Button><Button variant="danger" disabled={busy || !reason.trim()} onClick={() => void confirmWithdrawal()}>Confirm withdrawal</Button></div>
    </DialogSurface>}
  </div>;
}
