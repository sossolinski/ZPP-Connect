import { useEffect, useState } from "react";
import { CheckCircle2, Play, Plus } from "lucide-react";
import { api } from "../lib/api";
import { useApp } from "../lib/app-context";
import { isSessionWriteContextCurrent } from "../lib/session-safety";
import type { AnyRecord } from "../lib/types";
import { AlertBox, Button, Card, CardHeader, ConfirmDialog, EmptyState, Field, Input, Loading, Select, StatusBadge, Table, Textarea } from "../components/ui";
import { formatDate } from "../lib/format";

const targetRoles = ["ZPP Coordinator", "TEC Coordinator", "ZPP Group Leader", "TEC Group Leader", "ZPP Member", "TEC Member", "System Admin", "Observer"];

export function ExercisePage() {
  const { activeSession, activeSessionWritable, dictionaries, can, verifyActiveSessionWrite } = useApp();
  const [injects, setInjects] = useState<AnyRecord[]>([]);
  const [observations, setObservations] = useState<AnyRecord[]>([]);
  const [injectForm, setInjectForm] = useState<AnyRecord>({ injectNumber: 1, targetRole: "TEC Member" });
  const [observationForm, setObservationForm] = useState<AnyRecord>({ area: "Intake", severity: "Low", includeInAar: true, status: "Open" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creatingKey, setCreatingKey] = useState("");
  const [transitionTarget, setTransitionTarget] = useState<{ row: AnyRecord; action: "release" | "complete"; error: string } | null>(null);
  const [transitionBusy, setTransitionBusy] = useState(false);

  async function load() {
    if (!activeSession) return;
    setLoading(true);
    setError("");
    try {
      const [injectList, observationList] = await Promise.all([
        api.listInjects({ sessionId: activeSession.id }),
        api.listObservations({ sessionId: activeSession.id })
      ]);
      setInjects(injectList.data);
      setObservations(observationList.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load exercise control");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setInjectForm({ injectNumber: 1, targetRole: "TEC Member", sessionId: activeSession?.id });
    setObservationForm({ area: "Intake", severity: "Low", includeInAar: true, status: "Open", sessionId: activeSession?.id });
    void load();
  }, [activeSession?.id]);

  async function createInject() {
    if (creatingKey || !activeSession || !can("exercise:manage") || !isSessionWriteContextCurrent(activeSession, injectForm.sessionId) || !(await verifyActiveSessionWrite(injectForm.sessionId))) return;
    if (!String(injectForm.text ?? "").trim()) { setError("Inject text is required."); return; }
    setCreatingKey("inject"); setError("");
    try {
      await api.createInject({ ...injectForm, sessionId: activeSession.id });
      setInjectForm({ injectNumber: Number(injectForm.injectNumber ?? 0) + 1, targetRole: "TEC Member", sessionId: activeSession.id });
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to create inject"); }
    finally { setCreatingKey(""); }
  }

  async function createObservation() {
    if (creatingKey || !activeSession || !can("exercise:manage") || !isSessionWriteContextCurrent(activeSession, observationForm.sessionId) || !(await verifyActiveSessionWrite(observationForm.sessionId))) return;
    if (!String(observationForm.observation ?? "").trim()) { setError("Observation text is required."); return; }
    setCreatingKey("observation"); setError("");
    try {
      await api.createObservation({ ...observationForm, sessionId: activeSession.id });
      setObservationForm({ area: "Intake", severity: "Low", includeInAar: true, status: "Open", sessionId: activeSession.id });
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to add observation"); }
    finally { setCreatingKey(""); }
  }

  async function transitionInject(row: AnyRecord, action: "release" | "complete") {
    if (transitionBusy || !can("exercise:manage") || !isSessionWriteContextCurrent(activeSession, row.sessionId) || !(await verifyActiveSessionWrite(row.sessionId))) {
      setTransitionTarget((current) => current ? { ...current, error: "The session changed or is closed. This inject was not updated." } : current);
      return;
    }
    setTransitionBusy(true);
    try {
      if (action === "release") await api.releaseInject(String(row.id), Number(row.version));
      else await api.completeInject(String(row.id), Number(row.version));
      setTransitionTarget(null);
      await load();
    } catch (err) {
      setTransitionTarget((current) => current ? { ...current, error: err instanceof Error ? err.message : "Unable to update inject" } : current);
    } finally { setTransitionBusy(false); }
  }

  return (
    <div className="grid gap-5">
      <Card>
        <div className="grid gap-4 p-4">
          {loading ? (
            <Loading />
          ) : error ? (
            <EmptyState title="Unable to load exercise data" detail={error} action={<Button onClick={() => void load()}>Retry</Button>} />
          ) : (
            <div className="grid gap-5 xl:grid-cols-2">
              <Table
                columns={[
                  { key: "injectNumber", label: "No.", className: "w-16" },
                  { key: "targetRole", label: "Target role", className: "w-[120px]" },
                  { key: "text", label: "Text", className: "w-[240px]" },
                  { key: "scenarioTime", label: "Scenario time", className: "w-[160px]", render: (row) => formatDate(row.scenarioTime) },
                  { key: "status", label: "Status", className: "w-[120px]", render: (row) => <StatusBadge value={row.status} /> }
                ]}
                rows={injects}
                actionWidth="w-24"
                rowAction={(row) => (
                  <div className="grid w-[4.5rem] grid-cols-2 gap-1.5">
                    <Button icon={Play} size="icon" variant="secondary" title="Release inject" aria-label="Release inject" disabled={!activeSessionWritable || !can("exercise:manage") || row.status !== "Planned"} onClick={() => setTransitionTarget({ row, action: "release", error: "" })} />
                    <Button icon={CheckCircle2} size="icon" variant="success" title="Complete inject" aria-label="Complete inject" disabled={!activeSessionWritable || !can("exercise:manage") || row.status !== "Released"} onClick={() => setTransitionTarget({ row, action: "complete", error: "" })} />
                  </div>
                )}
              />
              <Table
                columns={[
                  { key: "operationalId", label: "Observation", className: "w-[148px]" },
                  { key: "area", label: "Area", className: "w-[128px]" },
                  { key: "severity", label: "Severity", className: "w-[112px]", render: (row) => <StatusBadge value={row.severity} /> },
                  { key: "observation", label: "Observation", className: "w-[260px]" },
                  { key: "recommendation", label: "Recommendation", className: "w-[260px]" }
                ]}
                rows={observations}
              />
            </div>
          )}
        </div>
      </Card>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader title="Create Inject" />
          <div className="grid gap-4 p-4">
            <Field label="Inject number"><Input type="number" disabled={!activeSessionWritable} value={injectForm.injectNumber ?? ""} onChange={(event) => setInjectForm((current) => ({ ...current, injectNumber: Number(event.target.value) }))} /></Field>
            <Field label="Target role">
              <Select value={injectForm.targetRole ?? "TEC Member"} disabled={!activeSessionWritable} onChange={(event) => setInjectForm((current) => ({ ...current, targetRole: event.target.value }))}>
                {targetRoles.map((role) => <option key={role} value={role}>{role}</option>)}
              </Select>
            </Field>
            <Field label="Text" required error={error === "Inject text is required." ? error : undefined}><Textarea value={injectForm.text ?? ""} disabled={!activeSessionWritable} onChange={(event) => { setError(""); setInjectForm((current) => ({ ...current, text: event.target.value })); }} /></Field>
            <Field label="Expected action"><Textarea value={injectForm.expectedAction ?? ""} disabled={!activeSessionWritable} onChange={(event) => setInjectForm((current) => ({ ...current, expectedAction: event.target.value }))} /></Field>
            <div className="rounded-md border border-border bg-muted px-3 py-2">
              <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Initial status</p>
              <div className="mt-1"><StatusBadge value="Planned" /></div>
              <p className="mt-1 text-xs font-semibold text-muted-foreground">Release and completion use the dedicated inject actions.</p>
            </div>
            <Button icon={Plus} variant="primary" disabled={!activeSessionWritable || !can("exercise:manage") || Boolean(creatingKey)} aria-busy={creatingKey === "inject"} onClick={createInject}>{creatingKey === "inject" ? "Creating inject" : "Create inject"}</Button>
          </div>
        </Card>

        <Card>
          <CardHeader title="Add Evaluator Observation" />
          <div className="grid gap-4 p-4">
            <Field label="Area">
              <Select value={observationForm.area ?? "Intake"} disabled={!activeSessionWritable} onChange={(event) => setObservationForm((current) => ({ ...current, area: event.target.value }))}>
                {(dictionaries.observationAreas ?? []).map((item) => <option key={item.key} value={item.label}>{item.label}</option>)}
              </Select>
            </Field>
            <Field label="Severity">
              <Select value={observationForm.severity ?? "Low"} disabled={!activeSessionWritable} onChange={(event) => setObservationForm((current) => ({ ...current, severity: event.target.value }))}>
                {(dictionaries.observationSeverities ?? []).map((item) => <option key={item.key} value={item.label}>{item.label}</option>)}
              </Select>
            </Field>
            <Field label="Observation" required error={error === "Observation text is required." ? error : undefined}><Textarea value={observationForm.observation ?? ""} disabled={!activeSessionWritable} onChange={(event) => { setError(""); setObservationForm((current) => ({ ...current, observation: event.target.value })); }} /></Field>
            <Field label="Recommendation"><Textarea value={observationForm.recommendation ?? ""} disabled={!activeSessionWritable} onChange={(event) => setObservationForm((current) => ({ ...current, recommendation: event.target.value }))} /></Field>
            <Field label="Owner"><Input value={observationForm.owner ?? ""} disabled={!activeSessionWritable} onChange={(event) => setObservationForm((current) => ({ ...current, owner: event.target.value }))} /></Field>
            <Button icon={Plus} variant="primary" disabled={!activeSessionWritable || !can("exercise:manage") || Boolean(creatingKey)} aria-busy={creatingKey === "observation"} onClick={createObservation}>{creatingKey === "observation" ? "Adding observation" : "Add observation"}</Button>
          </div>
        </Card>
      </div>
      {transitionTarget ? (
        <ConfirmDialog
          title={transitionTarget.action === "release" ? "Release exercise inject?" : "Complete exercise inject?"}
          recordLabel={transitionTarget.row.operationalId ?? `Inject ${transitionTarget.row.injectNumber}`}
          description={transitionTarget.action === "release" ? "The inject will become visible to its target role. This workflow transition is recorded and is not reversed from this dialog." : "The inject will be marked completed. This is a terminal exercise action and is not reversible from this dialog."}
          confirmLabel={transitionTarget.action === "release" ? "Release inject" : "Complete inject"}
          confirmVariant={transitionTarget.action === "release" ? "primary" : "success"}
          confirmIcon={transitionTarget.action === "release" ? Play : CheckCircle2}
          busy={transitionBusy}
          error={transitionTarget.error}
          onCancel={() => setTransitionTarget(null)}
          onConfirm={() => transitionInject(transitionTarget.row, transitionTarget.action)}
        />
      ) : null}
    </div>
  );
}
