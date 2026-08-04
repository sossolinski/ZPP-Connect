import { useEffect, useRef, useState } from "react";
import { Archive, CheckCircle2, Pencil, Plus, Save, XCircle } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { useApp } from "../lib/app-context";
import { isSessionWritable, mostRecentWritableSession } from "../lib/session-safety";
import type { AnyRecord, SessionRecord } from "../lib/types";
import { AlertBox, Badge, Button, Card, DecisionDialog, EmptyState, ErrorSummary, Field, Input, Loading, Select, StatusBadge, Table, Textarea } from "../components/ui";
import { DialogSurface } from "../components/DialogSurface";

function emptySession(dictionaries: ReturnType<typeof useApp>["dictionaries"]): AnyRecord {
  return {
    mode: dictionaries.sessionModes?.[0]?.label ?? "REAL",
    status: "Draft",
    eventType: dictionaries.eventTypes?.[0]?.label ?? "Aircraft accident",
    flightNumber: "",
    route: "",
    aircraftRegistration: "",
    airportLocation: "",
    description: "",
    startAt: "",
    endAt: "",
    notes: ""
  };
}

function matchesSessionFocus(row: SessionRecord, focus: string) {
  const normalized = focus.trim().toLowerCase();
  if (!normalized) return false;
  return [row.id, row.operationalId, row.flightNumber, row.aircraftRegistration]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase() === normalized);
}

export function SessionsPage() {
  const { activeSession, dictionaries, can, reload, setActiveSessionId } = useApp();
  const [searchParams] = useSearchParams();
  const focusSessionId = searchParams.get("focus") ?? "";
  const handledFocusRef = useRef("");
  const saveInFlightRef = useRef(false);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [editing, setEditing] = useState<AnyRecord>(() => emptySession(dictionaries));
  const [editorOpen, setEditorOpen] = useState(false);
  const [closeDecision, setCloseDecision] = useState<{ row: SessionRecord; notes: string; error: string; saving: boolean } | null>(null);
  const [focusedSessionId, setFocusedSessionId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [editorBaseline, setEditorBaseline] = useState("");
  const [editorError, setEditorError] = useState("");
  const [saving, setSaving] = useState(false);
  const canCreateSession = can("session:create");
  const canUpdateSession = can("session:update");
  const canCloseSession = can("session:close");
  const canSelectSession = canUpdateSession;
  const canEditSessions = canUpdateSession || canCloseSession;

  async function load() {
    setLoading(true);
    setError("");
    try {
      const result = await api.sessionsAll();
      setSessions(result.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load sessions");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    const focus = focusSessionId.trim();
    if (!focus) {
      handledFocusRef.current = "";
      setFocusedSessionId("");
      return;
    }
    if (loading) return;
    const row = sessions.find((item) => matchesSessionFocus(item, focus));
    if (!row) {
      setFocusedSessionId("");
      return;
    }
    const key = `${row.id}:${focus}`;
    if (handledFocusRef.current === key) return;
    handledFocusRef.current = key;
    setFocusedSessionId(row.id);
  }, [focusSessionId, loading, sessions]);

  useEffect(() => {
    if (!focusedSessionId || loading) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(`session-${focusedSessionId}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusedSessionId, loading, sessions]);

  async function save() {
    if (saveInFlightRef.current || saving || (editing.id ? !canUpdateSession : !canCreateSession)) return;
    if (!editing.mode || !editing.status || !editing.eventType) {
      setEditorError("Session type, status and event type are required.");
      return;
    }
    saveInFlightRef.current = true;
    setSaving(true);
    setEditorError("");
    try {
      if (editing.id) await api.updateSession(editing.id, editing);
      else await api.createSession(editing);
      setEditorBaseline("");
      setEditing(emptySession(dictionaries));
      setEditorOpen(false);
      await Promise.all([load(), reload()]);
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : "Unable to save session");
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  }

  function selectSession(row: SessionRecord) {
    if (!canSelectSession || !isSessionWritable(row) || row.id === activeSession?.id) return;
    setActiveSessionId(row.id);
    setFeedback(`${row.operationalId} is now the active session. The topbar and operational pages have been updated.`);
  }

  function openCloseSession(row: SessionRecord) {
    setCloseDecision({ row, notes: row.notes ?? "", error: "", saving: false });
  }

  async function confirmCloseSession() {
    if (!closeDecision) return;
    const notes = closeDecision.notes.trim();
    if (notes.length < 3) {
      setCloseDecision((current) => (current ? { ...current, error: "Enter a closure note with at least 3 characters." } : current));
      return;
    }
    setCloseDecision((current) => (current ? { ...current, saving: true, error: "" } : current));
    try {
      const closingActiveSession = closeDecision.row.id === activeSession?.id;
      await api.closeSession(closeDecision.row.id, notes);
      const nextResult = await api.sessionsAll();
      setSessions(nextResult.data);
      if (closingActiveSession) {
        const nextSession = mostRecentWritableSession(nextResult.data);
        setActiveSessionId(nextSession?.id ?? "");
        setFeedback(
          nextSession
            ? `${closeDecision.row.operationalId} was closed. ${nextSession.operationalId} is now the active session.`
            : `${closeDecision.row.operationalId} was closed. No eligible session remains, so the operational active-session state was cleared.`
        );
      } else {
        setFeedback(`${closeDecision.row.operationalId} was closed. ${activeSession?.operationalId ?? "The current session"} remains active.`);
      }
      setCloseDecision(null);
      setEditorOpen(false);
      await reload();
    } catch (err) {
      setCloseDecision((current) =>
        current
          ? {
              ...current,
              saving: false,
              error: err instanceof Error ? err.message : "Unable to close session"
            }
          : current
      );
    }
  }

  const columns = [
    { key: "operationalId", label: "Session ID", className: "w-[148px]" },
    { key: "mode", label: "Mode", className: "w-[112px]", render: (row: AnyRecord) => <StatusBadge value={row.mode} /> },
    { key: "status", label: "Status", className: "w-[112px]", render: (row: AnyRecord) => <StatusBadge value={row.status} /> },
    { key: "eventType", label: "Event", className: "w-[128px]" },
    {
      key: "flightRoute",
      label: "Flight / route",
      className: "w-[216px]",
      render: (row: AnyRecord) => (
        <div>
          <p className="truncate font-semibold text-foreground">{row.flightNumber || "No flight"} · {row.route || "No route"}</p>
          <p className="truncate text-xs font-medium text-muted-foreground">{row.airportLocation || "No location"}</p>
        </div>
      )
    },
    {
      key: "selection",
      label: "Active session",
      className: "w-[168px]",
      sortable: false,
      render: (row: AnyRecord) =>
        row.id === activeSession?.id ? (
          <Badge tone="success" className="whitespace-nowrap">Current session</Badge>
        ) : canSelectSession && isSessionWritable(row as SessionRecord) ? (
          <Button icon={CheckCircle2} size="sm" variant="secondary" onClick={() => selectSession(row as SessionRecord)}>
            Use this session
          </Button>
        ) : row.status === "Closed" || row.status === "Archived" ? (
          <Badge tone="neutral">Read-only</Badge>
        ) : (
          <span className="text-xs font-semibold text-muted-foreground">Available</span>
        )
    }
  ];

  function startNewSession() {
    const next = emptySession(dictionaries);
    setEditing(next);
    setEditorBaseline(JSON.stringify(next));
    setEditorError("");
    setEditorOpen(true);
  }

  return (
    <div className="grid items-start gap-5">
      <Card>
        {feedback ? (
          <div className="border-b border-border p-4">
            <AlertBox tone="success">{feedback}</AlertBox>
          </div>
        ) : null}
        {canCreateSession ? (
          <div className="flex justify-end border-b border-border px-4 py-3">
            <Button icon={Plus} variant="create" onClick={startNewSession}>
              New
            </Button>
          </div>
        ) : null}
        <div className="p-4">
          {loading ? (
            <Loading />
          ) : error ? (
            <EmptyState title="Unable to load sessions" detail={error} action={<Button onClick={() => void load()}>Retry</Button>} />
          ) : (
            <Table
              columns={columns}
              rows={sessions}
              rowId={(row) => (row.id ? `session-${row.id}` : undefined)}
              rowClassName={(row) =>
                [
                  row.id === activeSession?.id ? "bg-emerald-50/60" : "",
                  focusedSessionId === row.id ? "outline outline-2 -outline-offset-2 outline-ring" : ""
                ].filter(Boolean).join(" ") || undefined
              }
              rowAction={
                canEditSessions
                  ? (row) => (
                      <div className="grid w-[4.5rem] grid-cols-2 gap-1.5">
                        {canUpdateSession ? (
                          <Button
                            icon={Pencil}
                            size="icon"
                            variant="ghost"
                            title="Edit session"
                            aria-label="Edit session"
                            onClick={() => {
                              setEditing(row);
                              setEditorBaseline(JSON.stringify(row));
                              setEditorError("");
                              setEditorOpen(true);
                            }}
                          />
                        ) : null}
                        {canCloseSession && row.status !== "Closed" ? <Button icon={XCircle} size="icon" variant="danger" title="Close session" aria-label="Close session" onClick={() => openCloseSession(row as SessionRecord)} /> : null}
                      </div>
                    )
                  : undefined
              }
              actionWidth="w-20"
            />
          )}
        </div>
      </Card>

      {editorOpen && (canCreateSession || (editing.id && canUpdateSession)) ? (
        <DialogSurface
          title={editing.id ? "Edit Session" : "New Session"}
          description={editing.operationalId ?? "Session setup"}
          dirty={Boolean(editorBaseline && JSON.stringify(editing) !== editorBaseline)}
          busy={saving}
          onClose={() => setEditorOpen(false)}
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-border bg-card text-foreground shadow-2xl"
        >
          {({ requestClose }) => (
          <>
            <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
              <div>
                <h2 data-dialog-heading="true" tabIndex={-1} className="text-lg font-black text-foreground">{editing.id ? "Edit Session" : "New Session"}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{editing.operationalId ?? "Session setup"}</p>
              </div>
              <Button icon={XCircle} variant="ghost" disabled={saving} onClick={() => requestClose()}>
                Close
              </Button>
            </div>
            <div className="scrollbar-soft grid flex-1 gap-3 overflow-y-auto p-5">
            <ErrorSummary title="Session could not be saved" errors={editorError ? [{ message: editorError, fieldId: "session-event-type" }] : []} />
            <Field label="Session type" required>
              <Select value={editing.mode ?? ""} onChange={(event) => setEditing((current) => ({ ...current, mode: event.target.value }))}>
                {(dictionaries.sessionModes ?? []).map((item) => <option key={item.key} value={item.label}>{item.label}</option>)}
              </Select>
            </Field>
            <Field label="Status" required>
              <Select
                value={editing.status ?? ""}
                disabled={editing.status === "Closed"}
                onChange={(event) => setEditing((current) => ({ ...current, status: event.target.value }))}
              >
                {editing.status === "Closed" ? <option value="Closed">Closed (controlled state)</option> : null}
                {(dictionaries.sessionStatuses ?? []).filter((item) => item.label !== "Closed").map((item) => <option key={item.key} value={item.label}>{item.label}</option>)}
              </Select>
              <p className="mt-1 text-xs font-semibold text-muted-foreground">Closing a session requires the dedicated Close session action and closure note.</p>
            </Field>
            <Field id="session-event-type" label="Event type" required error={editorError && !editing.eventType ? "Event type is required." : undefined}>
              <Select value={editing.eventType ?? ""} onChange={(event) => setEditing((current) => ({ ...current, eventType: event.target.value }))}>
                {(dictionaries.eventTypes ?? []).map((item) => <option key={item.key} value={item.label}>{item.label}</option>)}
              </Select>
            </Field>
            <Field label="Flight number">
              <Input value={editing.flightNumber ?? ""} onChange={(event) => setEditing((current) => ({ ...current, flightNumber: event.target.value }))} />
            </Field>
            <Field label="Route">
              <Input value={editing.route ?? ""} onChange={(event) => setEditing((current) => ({ ...current, route: event.target.value }))} />
            </Field>
            <Field label="Aircraft registration">
              <Input value={editing.aircraftRegistration ?? ""} onChange={(event) => setEditing((current) => ({ ...current, aircraftRegistration: event.target.value }))} />
            </Field>
            <Field label="Airport / location">
              <Input value={editing.airportLocation ?? ""} onChange={(event) => setEditing((current) => ({ ...current, airportLocation: event.target.value }))} />
            </Field>
            <Field label="Description">
              <Textarea value={editing.description ?? ""} onChange={(event) => setEditing((current) => ({ ...current, description: event.target.value }))} />
            </Field>
            <Field label="Start date/time">
              <Input type="datetime-local" value={String(editing.startAt ?? "").slice(0, 16)} onChange={(event) => setEditing((current) => ({ ...current, startAt: event.target.value }))} />
            </Field>
            <Field label="End date/time">
              <Input type="datetime-local" value={String(editing.endAt ?? "").slice(0, 16)} onChange={(event) => setEditing((current) => ({ ...current, endAt: event.target.value }))} />
            </Field>
            <Field label="Notes">
              <Textarea value={editing.notes ?? ""} onChange={(event) => setEditing((current) => ({ ...current, notes: event.target.value }))} />
            </Field>
            </div>
            <div className="grid gap-2 border-t border-border bg-card p-4">
              <Button icon={Save} variant="primary" disabled={saving} aria-busy={saving} onClick={save}>
                {saving ? "Saving session" : "Save session"}
              </Button>
              {editing.id && canCloseSession && editing.status !== "Closed" ? (
                <Button icon={Archive} variant="danger" onClick={() => openCloseSession(editing as SessionRecord)}>
                  Close session
                </Button>
              ) : null}
            </div>
          </>
          )}
        </DialogSurface>
      ) : null}

      {closeDecision ? (
        <DecisionDialog
          title="Close Session"
          description={`${closeDecision.row.operationalId ?? "This session"} will become closed and read-only. The closure is recorded in operational history and cannot be reversed from this dialog.`}
          label="Closure note"
          value={closeDecision.notes}
          onChange={(value) => setCloseDecision((current) => (current ? { ...current, notes: value, error: "" } : current))}
          onCancel={() => setCloseDecision(null)}
          onConfirm={confirmCloseSession}
          confirmLabel="Close session"
          confirmIcon={Archive}
          confirmVariant="danger"
          error={closeDecision.error}
          busy={closeDecision.saving}
          required
          placeholder="Summary of closure decision"
        />
      ) : null}
    </div>
  );
}
