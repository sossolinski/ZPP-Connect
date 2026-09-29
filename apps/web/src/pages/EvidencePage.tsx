import { useEffect, useState } from "react";
import { AlertBox, Button, Card, CardHeader, Field, Input, Loading, Select, StatusBadge, Textarea } from "../components/ui";
import { useApp } from "../lib/app-context";
import { api } from "../lib/api";
import type { EvidencePage as EvidencePageResult, EvidenceRecord } from "../lib/evidence-types";

const categories = ["Photograph", "Scanned document", "Authority correspondence", "Operational evidence", "External report", "Reference"];

export function EvidencePage() {
  const { activeSession, activeSessionWritable, can } = useApp();
  const [page, setPage] = useState<EvidencePageResult>();
  const [file, setFile] = useState<File>();
  const [category, setCategory] = useState(categories[0]!);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [withdraw, setWithdraw] = useState<EvidenceRecord>();
  const [reason, setReason] = useState("");

  async function load(offset = 0) {
    if (!activeSession) { setPage(undefined); return; }
    try { setPage(await api.evidenceList(activeSession.id, offset)); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "Unable to load evidence"); }
  }
  useEffect(() => { setPage(undefined); void load(); }, [activeSession?.id]);

  async function upload() {
    if (!activeSession || !file || busy) return;
    setBusy(true); setError("");
    try {
      await api.evidenceUpload(activeSession.id, file, category, description, crypto.randomUUID());
      setFile(undefined); setDescription("");
      const input = document.getElementById("evidence-file") as HTMLInputElement | null;
      if (input) input.value = "";
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to upload evidence"); }
    finally { setBusy(false); }
  }

  async function confirmWithdrawal() {
    if (!activeSession || !withdraw || !reason.trim() || busy) return;
    setBusy(true); setError("");
    try {
      await api.evidenceWithdraw(activeSession.id, withdraw.id, withdraw.version, reason, crypto.randomUUID());
      setWithdraw(undefined); setReason(""); await load(page?.offset ?? 0);
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to withdraw evidence"); }
    finally { setBusy(false); }
  }

  if (!activeSession) return <AlertBox>Select an active real incident to view retained evidence.</AlertBox>;
  if (activeSession.mode !== "REAL") return <AlertBox>Incident evidence is intentionally unavailable in training and exercise sessions.</AlertBox>;
  if (!page && !error) return <Loading label="Loading incident evidence" />;
  return <div className="grid gap-5" data-testid="evidence-workspace">
    {error && <AlertBox tone="danger">{error}</AlertBox>}
    <AlertBox>Files are retained in PostgreSQL with SHA-256 verification. The displayed digest proves integrity, not authenticity or a digital signature. Malware scanning is not configured; only PDF, JPEG, PNG and plain text are accepted.</AlertBox>
    {can("evidence:upload") && activeSessionWritable && <Card><CardHeader title="Upload evidence" description="Upload one bounded file and classify its operational purpose." /><div className="grid gap-4 p-4">
      <Field label="Evidence file"><Input id="evidence-file" type="file" accept=".pdf,.jpg,.jpeg,.png,.txt,application/pdf,image/jpeg,image/png,text/plain" disabled={busy} onChange={e => setFile(e.target.files?.[0])} /></Field>
      <Field label="Category"><Select value={category} disabled={busy} onChange={e => setCategory(e.target.value)}>{categories.map(value => <option key={value}>{value}</option>)}</Select></Field>
      <Field label="Description"><Textarea value={description} maxLength={4000} rows={3} disabled={busy} onChange={e => setDescription(e.target.value)} /></Field>
      <Button variant="create" disabled={busy || !file} onClick={() => void upload()}>Upload retained evidence</Button>
    </div></Card>}
    <Card><CardHeader title="Evidence register" description={`${page?.total ?? 0} retained record(s), including withdrawn tombstones.`} /><div className="grid gap-3 p-4">
      {page?.data.map(record => <article key={record.id} className="grid gap-2 rounded border p-3">
        <div className="flex flex-wrap items-center gap-2"><strong>{record.operationalId} · {record.fileName}</strong><StatusBadge value={record.status} /></div>
        <p>{record.category} · {record.mimeType} · {record.sizeBytes.toLocaleString()} bytes · uploaded by {record.createdBy.displayName}</p>
        {record.description && <p>{record.description}</p>}
        <p className="break-all text-xs">SHA-256: {record.contentSha256}<br />Scan status: {record.scanStatus}</p>
        {record.status === "Withdrawn" ? <p>Withdrawn: {record.withdrawalReason}</p> : <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => void api.evidenceDownload(activeSession.id, record).catch(e => setError(e.message))}>Download verified file</Button>
          {can("evidence:withdraw") && activeSessionWritable && <Button disabled={busy} onClick={() => { setWithdraw(record); setReason(""); }}>Withdraw</Button>}
        </div>}
      </article>)}
      {page?.data.length === 0 && <p>No evidence has been retained for this incident.</p>}
      {page && <div className="flex items-center gap-3"><Button disabled={busy || page.offset === 0} onClick={() => void load(Math.max(0, page.offset - page.limit))}>Previous</Button><Button disabled={busy || page.offset + page.limit >= page.total} onClick={() => void load(page.offset + page.limit)}>Next</Button></div>}
    </div></Card>
    {withdraw && <Card><CardHeader title={`Withdraw ${withdraw.operationalId}`} description="Withdrawal preserves metadata and bytes as an auditable tombstone and disables download." /><div className="grid gap-3 p-4">
      <Field label="Withdrawal reason"><Textarea value={reason} maxLength={2000} rows={3} disabled={busy} onChange={e => setReason(e.target.value)} /></Field>
      <div className="flex gap-2"><Button disabled={busy} onClick={() => setWithdraw(undefined)}>Cancel</Button><Button variant="danger" disabled={busy || !reason.trim()} onClick={() => void confirmWithdrawal()}>Confirm withdrawal</Button></div>
    </div></Card>}
  </div>;
}
