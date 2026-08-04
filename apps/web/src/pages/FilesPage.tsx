import { useEffect, useState } from "react";
import { CheckCircle2, Upload } from "lucide-react";
import { api } from "../lib/api";
import { useApp } from "../lib/app-context";
import { isSessionWriteContextCurrent } from "../lib/session-safety";
import type { AnyRecord } from "../lib/types";
import { AlertBox, Badge, Button, Card, CardHeader, ConfirmDialog, EmptyState, Field, Loading, Select, StatusBadge, Table } from "../components/ui";
import { formatDate } from "../lib/format";

const importTypes = [
  { value: "manifest", label: "Manifest CSV" }
];

export function FilesPage() {
  const { activeSession, activeSessionWritable, can, verifyActiveSessionWrite } = useApp();
  const [files, setFiles] = useState<AnyRecord[]>([]);
  const [importType, setImportType] = useState("manifest");
  const [selectedFile, setSelectedFile] = useState<File>();
  const [pendingBatch, setPendingBatch] = useState<AnyRecord>();
  const [uploading, setUploading] = useState(false);
  const [confirmingId, setConfirmingId] = useState("");
  const [fileInputKey, setFileInputKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [confirmTarget, setConfirmTarget] = useState<AnyRecord>();

  const batchErrors = ((pendingBatch?.errors ?? pendingBatch?.importErrors ?? []) as Array<{ row: number; error: string }>).slice(0, 8);

  async function load() {
    if (!activeSession) {
      setFiles([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const result = await api.listAll("files", { sessionId: activeSession.id });
      setFiles(result.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load files");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setSelectedFile(undefined);
    setPendingBatch(undefined);
    setFileInputKey((current) => current + 1);
    void load();
  }, [activeSession?.id]);

  async function uploadFile() {
    if (!activeSession || !selectedFile || !can("import:create") || !isSessionWriteContextCurrent(activeSession, activeSession.id) || !(await verifyActiveSessionWrite(activeSession.id))) {
      setError("Select an open session before uploading an import file.");
      return;
    }
    setUploading(true);
    setError("");
    try {
      const batch = await api.importFile(importType, selectedFile, activeSession.id);
      setPendingBatch(batch);
      setSelectedFile(undefined);
      setFileInputKey((current) => current + 1);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to validate import");
    } finally {
      setUploading(false);
    }
  }

  async function confirmImport(batchId: string, sessionId?: string) {
    if (!can("import:create") || !isSessionWriteContextCurrent(activeSession, sessionId) || !(await verifyActiveSessionWrite(sessionId))) {
      setError("The session changed or is closed. This import was not confirmed.");
      return;
    }
    setConfirmingId(batchId);
    setError("");
    try {
      const batch = await api.confirmImport(batchId);
      setPendingBatch(batch);
      setConfirmTarget(undefined);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to confirm import");
    } finally {
      setConfirmingId("");
    }
  }

  function isConfirmable(row?: AnyRecord) {
    return String(row?.status ?? row?.importStatus ?? "").startsWith("Validated");
  }

  return (
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_360px] min-[1800px]:grid-cols-[minmax(0,1fr)_400px]">
      <Card>
        <div className="grid gap-4 p-4">
          <AlertBox tone="warning">
            Upload the file for validation, review any row issues, then confirm only when the result is ready for operational use.
          </AlertBox>
          {loading ? (
            <Loading />
          ) : error ? (
            <EmptyState title="Unable to load files" detail={error} action={<Button onClick={() => void load()}>Retry</Button>} />
          ) : (
            <Table
              columns={[
                { key: "operationalId", label: "File ID", className: "w-[148px]" },
                { key: "fileName", label: "Name", className: "w-[220px]" },
                { key: "importType", label: "Import", className: "w-[112px]" },
                { key: "importStatus", label: "Status", className: "w-[156px]", render: (row) => <StatusBadge value={row.importStatus ?? "Stored"} /> },
                {
                  key: "records",
                  label: "Rows",
                  className: "w-[150px]",
                  render: (row) => (
                    <div className="flex flex-wrap gap-1">
                      <Badge tone="success">{row.validRecords ?? 0} valid</Badge>
                      {row.invalidRecords ? <Badge tone="warning">{row.invalidRecords} errors</Badge> : null}
                    </div>
                  )
                },
                { key: "createdAt", label: "Uploaded", className: "w-[160px]", render: (row) => formatDate(row.createdAt) }
              ]}
              rows={files}
              actionWidth="w-28"
              rowAction={(row) =>
                row.importBatchId && isConfirmable(row) ? (
                  <Button
                    icon={CheckCircle2}
                    size="sm"
                    variant="success"
                    disabled={!activeSessionWritable || !can("import:create") || confirmingId === row.importBatchId}
                    onClick={() => setConfirmTarget({ ...row, id: row.importBatchId })}
                  >
                    Confirm
                  </Button>
                ) : null
              }
            />
          )}
        </div>
      </Card>

      <Card className="xl:sticky xl:top-24">
        <CardHeader title="Import Batch" />
        <div className="grid gap-3 p-4">
          <Field label="Import type">
            <Select value={importType} disabled={!activeSessionWritable} onChange={(event) => setImportType(event.target.value)}>
              {importTypes.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="File" required>
            <input
              key={fileInputKey}
              className="focus-ring w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-slate-800 hover:file:bg-slate-200"
              type="file"
              disabled={!activeSessionWritable}
              accept=".csv,text/csv"
              onChange={(event) => setSelectedFile(event.target.files?.[0])}
            />
          </Field>
          <Button icon={Upload} variant="primary" disabled={!activeSessionWritable || !can("import:create") || !selectedFile || uploading} onClick={uploadFile}>
            {uploading ? "Validating" : "Upload and validate"}
          </Button>
          {pendingBatch ? (
            <div className="grid gap-3 rounded-md border border-slate-200 bg-slate-50 p-3">
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-black text-slate-950">{pendingBatch.operationalId ?? pendingBatch.sourceFilename ?? "Import batch"}</p>
                  <p className="mt-1 text-xs font-semibold text-slate-500">
                    {pendingBatch.validRecords ?? 0} valid / {pendingBatch.totalRecords ?? 0} total
                  </p>
                </div>
                <StatusBadge value={pendingBatch.status} className="max-w-40 shrink-0" />
              </div>
              {batchErrors.length ? (
                <div className="grid gap-1.5">
                  {batchErrors.map((item) => (
                    <div key={`${item.row}-${item.error}`} className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs font-semibold text-amber-950">
                      Row {item.row}: {item.error}
                    </div>
                  ))}
                </div>
              ) : null}
              {isConfirmable(pendingBatch) ? (
                <Button icon={CheckCircle2} variant="success" disabled={!activeSessionWritable || !can("import:create") || confirmingId === pendingBatch.id} onClick={() => setConfirmTarget(pendingBatch)}>
                  {confirmingId === pendingBatch.id ? "Confirming" : "Confirm import"}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </Card>
      {confirmTarget ? (
        <ConfirmDialog
          title="Confirm import execution?"
          recordLabel={confirmTarget.operationalId ?? confirmTarget.sourceFilename ?? confirmTarget.fileName ?? "Import batch"}
          description={Number(confirmTarget.invalidRecords ?? 0) > 0 ? `${confirmTarget.validRecords ?? 0} valid rows will be imported and ${confirmTarget.invalidRecords} invalid rows will be skipped. Confirmation cannot be repeated for this batch.` : `${confirmTarget.validRecords ?? confirmTarget.totalRecords ?? 0} validated rows will be imported. Confirmation cannot be repeated for this batch.`}
          confirmLabel="Confirm import"
          confirmVariant="success"
          confirmIcon={CheckCircle2}
          busy={confirmingId === String(confirmTarget.id)}
          error={error}
          onCancel={() => setConfirmTarget(undefined)}
          onConfirm={() => confirmImport(String(confirmTarget.id), String(confirmTarget.sessionId ?? ""))}
        />
      ) : null}
    </div>
  );
}
