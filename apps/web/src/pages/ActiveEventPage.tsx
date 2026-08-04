import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, Edit3, ExternalLink, FileText, Plus, RefreshCw, Send, ShieldAlert } from "lucide-react";
import { Badge, PageIntro, Panel, PanelBody, SectionHeader, StatusBadge } from "../components/portal";
import { AlertBox, Button, EmptyState, ErrorSummary, Field, Input, Loading, Select, Textarea } from "../components/ui";
import { DialogSurface } from "../components/DialogSurface";
import { api } from "../lib/api";
import { useApp } from "../lib/app-context";
import { formatDate } from "../lib/format";
import type { AnyRecord } from "../lib/types";
import type { ReactNode } from "react";

type BriefingForm = {
  title: string;
  situationSummary: string;
  overview: string;
  nextUpdateDueAt: string;
  confirmedFacts: string;
  unconfirmedInformation: string;
  priorities: string;
  priorityLinks: string[];
  risks: string;
  coordinationNotes: string;
};

const emptyForm: BriefingForm = {
  title: "",
  situationSummary: "",
  overview: "",
  nextUpdateDueAt: "",
  confirmedFacts: "",
  unconfirmedInformation: "",
  priorities: "",
  priorityLinks: [],
  risks: "",
  coordinationNotes: ""
};

function localDateTime(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60_000);
  return local.toISOString().slice(0, 16);
}

function toIsoOrNull(value: string) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function lines(value: string) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function splitStatement(line: string, fallbackSource: string) {
  const [statement, source] = line.split("|").map((part) => part.trim());
  return { statement, source: source || fallbackSource };
}

function briefingToForm(briefing: AnyRecord): BriefingForm {
  const priorities = briefing.priorities ?? [];
  return {
    title: String(briefing.title ?? ""),
    situationSummary: String(briefing.situationSummary ?? ""),
    overview: String(briefing.overview ?? ""),
    nextUpdateDueAt: localDateTime(briefing.nextUpdateDueAt),
    confirmedFacts: (briefing.confirmedFacts ?? []).map((item: AnyRecord) => `${item.statement}${item.source ? ` | ${item.source}` : ""}`).join("\n"),
    unconfirmedInformation: (briefing.unconfirmedInformation ?? []).map((item: AnyRecord) => `${item.statement}${item.source ? ` | ${item.source}` : ""}`).join("\n"),
    priorities: priorities.map((item: AnyRecord) => item.description).join("\n"),
    priorityLinks: priorities.map((item: AnyRecord) => String(item.linkedAssignmentId ?? "")),
    risks: (briefing.risks ?? []).map((item: AnyRecord) => `${item.severity ?? "Attention"}: ${item.description}`).join("\n"),
    coordinationNotes: (briefing.coordinationNotes ?? []).map((item: AnyRecord) => item.note).join("\n")
  };
}

function formToBriefingPayload(form: BriefingForm, briefing: AnyRecord) {
  const facts = lines(form.confirmedFacts).map((line, index) => {
    const existing = briefing.confirmedFacts?.[index] ?? {};
    const parsed = splitStatement(line, existing.source ?? "Operational briefing");
    return { ...existing, statement: parsed.statement, source: parsed.source };
  });
  const unconfirmed = lines(form.unconfirmedInformation).map((line, index) => {
    const existing = briefing.unconfirmedInformation?.[index] ?? {};
    const parsed = splitStatement(line, existing.source ?? "Operational briefing");
    return {
      ...existing,
      statement: parsed.statement,
      source: parsed.source,
      verificationStatus: existing.verificationStatus ?? "Needs verification"
    };
  });
  const priorities = lines(form.priorities).map((line, index) => {
    const existing = briefing.priorities?.[index] ?? {};
    return {
      id: existing.id,
      description: line,
      order: index + 1,
      status: existing.status ?? "Not started",
      responsible: existing.responsible ?? null,
      dueAt: existing.dueAt ?? null,
      linkedAssignmentId: form.priorityLinks[index] || null
    };
  });
  const risks = lines(form.risks).map((line, index) => {
    const existing = briefing.risks?.[index] ?? {};
    const match = line.match(/^(Information|Attention|Critical):\s*(.+)$/i);
    const severity = match ? `${match[1]![0]!.toUpperCase()}${match[1]!.slice(1).toLowerCase()}` : existing.severity ?? "Attention";
    return { ...existing, severity, description: match?.[2]?.trim() || line, status: existing.status ?? "Open" };
  });
  const notes = lines(form.coordinationNotes).map((line, index) => {
    const existing = briefing.coordinationNotes?.[index] ?? {};
    return { ...existing, note: line };
  });

  return {
    expectedVersion: briefing.version,
    title: form.title,
    situationSummary: form.situationSummary,
    overview: form.overview,
    nextUpdateDueAt: toIsoOrNull(form.nextUpdateDueAt),
    confirmedFacts: facts,
    unconfirmedInformation: unconfirmed,
    priorities,
    risks,
    coordinationNotes: notes
  };
}

function countLabel(items?: unknown[]) {
  return Array.isArray(items) ? String(items.length) : "0";
}

function riskTone(severity?: string): "neutral" | "warning" | "danger" {
  if (severity === "Critical") return "danger";
  if (severity === "Attention") return "warning";
  return "neutral";
}

function assignmentTone(state?: string): "neutral" | "warning" | "danger" | "success" | "petrol" {
  if (state === "Available") return "petrol";
  if (state === "Missing" || state === "Unavailable") return "warning";
  if (state === "Restricted") return "neutral";
  return "neutral";
}

function assignmentOptionLabel(assignment: AnyRecord) {
  return [
    assignment.operationalId,
    assignment.title,
    assignment.status,
    assignment.assignedUserDisplayName ?? assignment.ownerAssignedTo ?? "Unassigned"
  ].filter(Boolean).join(" · ");
}

function assignmentMeta(assignment: AnyRecord) {
  return [
    assignment.status ? `Status ${assignment.status}` : null,
    assignment.priority ? `Priority ${assignment.priority}` : null,
    assignment.assignedUserDisplayName ? `Assignee ${assignment.assignedUserDisplayName}` : assignment.ownerAssignedTo ? `Assignee ${assignment.ownerAssignedTo}` : "Unassigned",
    assignment.dueAt ? `Due ${formatDate(assignment.dueAt)}` : null,
    assignment.updatedAt ? `Updated ${formatDate(assignment.updatedAt)}` : null
  ].filter(Boolean).join(" · ");
}

function SectionList({ items, empty, render }: { items: AnyRecord[]; empty: string; render: (item: AnyRecord, index: number) => ReactNode }) {
  if (!items.length) return <EmptyState title={empty} />;
  return <div className="grid gap-2">{items.map((item, index) => render(item, index))}</div>;
}

function LinkedAssignmentBlock({ assignment }: { assignment?: AnyRecord | null }) {
  if (!assignment) return null;
  if (assignment.accessState !== "Available") {
    return (
      <div className="mt-2 rounded-md border border-border bg-card px-3 py-2">
        <Badge tone={assignmentTone(assignment.accessState)}>{assignment.contextLabel ?? "Assignment details unavailable"}</Badge>
        <p className="mt-1 text-xs font-semibold text-muted-foreground">
          {assignment.accessState === "Restricted" ? "Current task details are hidden for this role." : "Current task details cannot be shown right now."}
        </p>
      </div>
    );
  }
  return (
    <div className="mt-2 rounded-md border border-border bg-card px-3 py-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <Badge tone={assignmentTone(assignment.accessState)}>{assignment.contextLabel}</Badge>
          <p className="mt-1 truncate text-sm font-black text-foreground">{assignment.title}</p>
          <p className="mt-1 text-xs font-semibold leading-5 text-muted-foreground">{assignmentMeta(assignment)}</p>
        </div>
        {assignment.detailHref ? (
          <a
            className="focus-ring inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-black text-foreground hover:bg-muted"
            href={assignment.detailHref}
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open assignment
          </a>
        ) : null}
      </div>
    </div>
  );
}

export function ActiveEventPage() {
  const { activeSession, can } = useApp();
  const [activeEvent, setActiveEvent] = useState<AnyRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [editorBriefing, setEditorBriefing] = useState<AnyRecord | null>(null);
  const [form, setForm] = useState<BriefingForm>(emptyForm);
  const [initialSignature, setInitialSignature] = useState("");
  const [saving, setSaving] = useState(false);
  const [editorError, setEditorError] = useState("");
  const [publishError, setPublishError] = useState("");
  const [assignmentOptions, setAssignmentOptions] = useState<AnyRecord[]>([]);
  const [assignmentOptionsLoading, setAssignmentOptionsLoading] = useState(false);
  const [assignmentOptionsError, setAssignmentOptionsError] = useState("");

  const currentBriefing = activeEvent?.currentBriefing ?? null;
  const draftMeta = activeEvent?.draft ?? null;
  const permissions = activeEvent?.permissions ?? {};
  const closed = activeSession?.status === "Closed";
  const formSignature = JSON.stringify(form);
  const dirty = Boolean(editorBriefing) && formSignature !== initialSignature;

  const loadActiveEvent = useCallback(async () => {
    if (!activeSession) {
      setActiveEvent(null);
      return;
    }
    setLoading(true);
    setLoadError("");
    try {
      setActiveEvent(await api.activeEvent(activeSession.id));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Unable to load Active Event");
    } finally {
      setLoading(false);
    }
  }, [activeSession]);

  const loadAssignmentOptions = useCallback(async () => {
    if (!activeSession || !can("briefing:update-draft")) {
      setAssignmentOptions([]);
      return;
    }
    setAssignmentOptionsLoading(true);
    setAssignmentOptionsError("");
    try {
      const result = await api.listAll<AnyRecord>("assignments", { sessionId: activeSession.id });
      setAssignmentOptions(result.data.filter((item) => item.sessionId === activeSession.id));
    } catch (error) {
      setAssignmentOptions([]);
      setAssignmentOptionsError(error instanceof Error ? error.message : "Unable to load assignments");
    } finally {
      setAssignmentOptionsLoading(false);
    }
  }, [activeSession?.id, can]);

  useEffect(() => {
    void loadActiveEvent();
  }, [loadActiveEvent]);

  function openEditor(briefing: AnyRecord) {
    const nextForm = briefingToForm(briefing);
    setEditorBriefing(briefing);
    setForm(nextForm);
    setInitialSignature(JSON.stringify(nextForm));
    setEditorError("");
    setPublishError("");
    void loadAssignmentOptions();
  }

  function updatePriorityText(value: string) {
    const count = lines(value).length;
    setForm((current) => ({
      ...current,
      priorities: value,
      priorityLinks: Array.from({ length: count }, (_, index) => current.priorityLinks[index] ?? "")
    }));
  }

  function updatePriorityLink(index: number, linkedAssignmentId: string) {
    setForm((current) => {
      const priorityLinks = [...current.priorityLinks];
      priorityLinks[index] = linkedAssignmentId;
      return { ...current, priorityLinks };
    });
  }

  async function createOrOpenDraft() {
    if (!activeSession) return;
    setEditorError("");
    try {
      const result = await api.createBriefingDraft(activeSession.id);
      openEditor(result.briefing ?? result);
      await loadActiveEvent();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Unable to create draft");
    }
  }

  async function editExistingDraft() {
    if (!draftMeta?.id) return;
    try {
      openEditor(await api.briefing(draftMeta.id));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Unable to open draft");
    }
  }

  async function saveDraft() {
    if (!editorBriefing) return;
    setSaving(true);
    setEditorError("");
    try {
      const updated = await api.updateBriefingDraft(editorBriefing.id, formToBriefingPayload(form, editorBriefing));
      openEditor(updated);
      await loadActiveEvent();
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : "Unable to save draft");
    } finally {
      setSaving(false);
    }
  }

  async function publishDraft() {
    if (!editorBriefing || dirty) return;
    setSaving(true);
    setPublishError("");
    try {
      await api.publishBriefingDraft(editorBriefing.id, Number(editorBriefing.version));
      setEditorBriefing(null);
      await loadActiveEvent();
    } catch (error) {
      setPublishError(error instanceof Error ? error.message : "Unable to publish draft");
    } finally {
      setSaving(false);
    }
  }

  const editorErrors = useMemo(() => [
    editorError ? { message: editorError } : null,
    publishError ? { message: publishError } : null
  ].filter(Boolean) as Array<{ message: string }>, [editorError, publishError]);
  const priorityRows = useMemo(() => lines(form.priorities).map((description, index) => ({
    description,
    linkedAssignmentId: form.priorityLinks[index] ?? ""
  })), [form.priorities, form.priorityLinks]);
  const sortedAssignmentOptions = useMemo(() => [...assignmentOptions].sort((left, right) =>
    String(left.operationalId ?? left.title ?? "").localeCompare(String(right.operationalId ?? right.title ?? ""), undefined, { sensitivity: "base" })
  ), [assignmentOptions]);

  return (
    <>
      <PageIntro
        eyebrow="Emergency response coordination"
        title="Active Event"
        description="Current briefing, confirmed information, priorities and risks for the selected session."
      >
        {activeSession ? <Badge tone={activeSession.mode === "REAL" ? "danger" : activeSession.mode === "TRAINING" ? "gold" : "petrol"}>{activeSession.mode}</Badge> : null}
        <StatusBadge value={activeSession?.status ?? "No session"} />
        {permissions.canCreateDraft ? (
          <Button size="sm" variant="create" icon={draftMeta ? Edit3 : Plus} onClick={draftMeta ? editExistingDraft : createOrOpenDraft}>
            {draftMeta ? "Edit draft" : "Create draft"}
          </Button>
        ) : null}
      </PageIntro>

      {!activeSession ? (
        <EmptyState
          title="No active session selected"
          detail="Select an open session before using Active Event information for operational work."
        />
      ) : loading ? (
        <Panel><PanelBody><Loading label="Loading current briefing" /></PanelBody></Panel>
      ) : loadError ? (
        <EmptyState title="Unable to load Active Event" detail={loadError} action={<Button icon={RefreshCw} onClick={() => void loadActiveEvent()}>Retry</Button>} />
      ) : (
        <div className="grid items-start gap-4 xl:grid-cols-[330px_minmax(0,1fr)]">
          <div className="grid gap-4">
            <Panel>
              <PanelBody>
                <SectionHeader title="Session context" description={closed ? "This session is closed and shown read-only." : "Session mode and status come from Sessions."} />
                <dl className="mt-4 grid gap-3 text-sm">
                  <div className="rounded-md border border-border bg-muted p-3">
                    <dt className="font-black uppercase tracking-wide text-muted-foreground">Session ID</dt>
                    <dd className="mt-1 text-lg font-black text-foreground">{activeSession.operationalId}</dd>
                  </div>
                  <div className="rounded-md border border-border bg-muted p-3">
                    <dt className="font-black uppercase tracking-wide text-muted-foreground">Mode / status</dt>
                    <dd className="mt-1 flex flex-wrap gap-2 font-bold text-foreground">
                      <Badge tone={activeSession.mode === "REAL" ? "danger" : activeSession.mode === "TRAINING" ? "gold" : "petrol"}>{activeSession.mode}</Badge>
                      <StatusBadge value={activeSession.status} />
                    </dd>
                  </div>
                  <div className="rounded-md border border-border bg-muted p-3">
                    <dt className="font-black uppercase tracking-wide text-muted-foreground">Event / exercise</dt>
                    <dd className="mt-1 font-bold text-foreground">{activeSession.description || activeSession.eventType}</dd>
                    {activeSession.flightNumber || activeSession.route ? <dd className="mt-1 text-xs font-semibold text-muted-foreground">{[activeSession.flightNumber, activeSession.route].filter(Boolean).join(" · ")}</dd> : null}
                  </div>
                  <div className="rounded-md border border-border bg-muted p-3">
                    <dt className="font-black uppercase tracking-wide text-muted-foreground">Start / closure</dt>
                    <dd className="mt-1 font-bold text-foreground">{activeSession.startAt ? formatDate(activeSession.startAt) : "No start time recorded"}</dd>
                    {activeSession.endAt ? <dd className="mt-1 text-xs font-semibold text-muted-foreground">Closed: {formatDate(activeSession.endAt)}</dd> : null}
                  </div>
                </dl>
              </PanelBody>
            </Panel>

            <Panel>
              <PanelBody>
                <SectionHeader title="Operational summary" description="Numbers come from permitted operational modules." />
                <div className="mt-4 grid gap-2">
                  {(activeEvent?.metrics ?? []).map((item: AnyRecord) => (
                    <div key={item.label} className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted px-3 py-2">
                      <span className="text-sm font-bold text-muted-foreground">{item.label}</span>
                      <span className="text-lg font-black text-foreground">{item.status === "unavailable" ? "Unavailable" : item.value}</span>
                    </div>
                  ))}
                  {!activeEvent?.metrics?.length ? <EmptyState title="No accessible summary metrics" detail="Your role can still read the current briefing." /> : null}
                </div>
              </PanelBody>
            </Panel>
          </div>

          <div className="grid gap-4">
            {draftMeta ? (
              <AlertBox tone="warning">
                Draft update revision {draftMeta.revision} exists and is not published yet.
                {permissions.canUpdateDraft ? <Button className="ml-3" size="sm" variant="secondary" icon={Edit3} onClick={editExistingDraft}>Open draft</Button> : null}
              </AlertBox>
            ) : null}

            {!currentBriefing ? (
              <Panel>
                <PanelBody>
                  <EmptyState
                    title="No published briefing"
                    detail={permissions.canCreateDraft ? "Create and publish a briefing before this page becomes authoritative for ordinary members." : "A current briefing has not been published for this session yet."}
                    action={permissions.canCreateDraft ? <Button variant="create" icon={Plus} onClick={createOrOpenDraft}>Create draft</Button> : undefined}
                  />
                </PanelBody>
              </Panel>
            ) : (
              <>
                <div id="current-briefing">
                  <Panel>
                    <PanelBody>
                      <SectionHeader
                        title={currentBriefing.title || "Current briefing"}
                        description="Published briefing. Use this as the current operational picture."
                        action={<Badge tone="success">Published revision {currentBriefing.revision}</Badge>}
                      />
                      <div className="mt-4 rounded-md border border-[#145C63]/25 bg-[#145C63]/10 p-4">
                        <p className="text-lg font-black leading-7 text-foreground">{currentBriefing.situationSummary}</p>
                        {currentBriefing.overview ? <p className="mt-3 text-sm font-semibold leading-6 text-muted-foreground">{currentBriefing.overview}</p> : null}
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2 text-xs font-bold text-muted-foreground">
                        {currentBriefing.publishedAt ? <span>Published {formatDate(currentBriefing.publishedAt)}</span> : null}
                        {currentBriefing.publishedBy?.displayName ? <span>by {currentBriefing.publishedBy.displayName}</span> : null}
                        {currentBriefing.nextUpdateDueAt ? <span>Next update due {formatDate(currentBriefing.nextUpdateDueAt)}</span> : null}
                      </div>
                    </PanelBody>
                  </Panel>
                </div>

                <div className="grid gap-4 lg:grid-cols-2">
                  <Panel>
                    <PanelBody>
                      <SectionHeader title="Confirmed information" action={<Badge tone="success">{countLabel(currentBriefing.confirmedFacts)}</Badge>} />
                      <div className="mt-4">
                        <SectionList items={currentBriefing.confirmedFacts ?? []} empty="No confirmed information published" render={(item) => (
                          <div key={item.id} className="rounded-md border border-border bg-card p-3">
                            <div className="flex items-start gap-2">
                              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                              <p className="text-sm font-bold leading-6 text-foreground">{item.statement}</p>
                            </div>
                            <p className="mt-2 text-xs font-semibold text-muted-foreground">Source: {item.source || "Operational briefing"}</p>
                          </div>
                        )} />
                      </div>
                    </PanelBody>
                  </Panel>

                  <Panel>
                    <PanelBody>
                      <SectionHeader title="Information to verify" action={<Badge tone="warning">{countLabel(currentBriefing.unconfirmedInformation)}</Badge>} />
                      <div className="mt-4">
                        <SectionList items={currentBriefing.unconfirmedInformation ?? []} empty="No unconfirmed information published" render={(item) => (
                          <div key={item.id} className="rounded-md border border-amber-300/60 bg-amber-50 p-3 text-amber-950 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-100">
                            <div className="flex items-start gap-2">
                              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                              <p className="text-sm font-bold leading-6">{item.statement}</p>
                            </div>
                            <p className="mt-2 text-xs font-semibold">Status: {item.verificationStatus || "Needs verification"}{item.owner ? ` · Owner: ${item.owner}` : ""}</p>
                          </div>
                        )} />
                      </div>
                    </PanelBody>
                  </Panel>
                </div>

                <Panel>
                  <PanelBody>
                    <SectionHeader title="Current priorities" description="Ordered briefing priorities. Assignment ownership still belongs to Assignments." />
                    <div className="mt-4 grid gap-2">
                      {(currentBriefing.priorities ?? []).map((item: AnyRecord, index: number) => (
                        <div key={item.id} className="grid gap-2 rounded-md border border-border bg-muted p-3 md:grid-cols-[2.5rem_minmax(0,1fr)_auto] md:items-start">
                          <div className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-card text-sm font-black text-foreground">{index + 1}</div>
                          <div className="min-w-0">
                            <p className="font-black text-foreground">{item.description}</p>
                            <p className="mt-1 text-sm font-semibold text-muted-foreground">
                              {[item.responsible, item.dueAt ? `Briefing due ${formatDate(item.dueAt)}` : null].filter(Boolean).join(" · ")}
                            </p>
                            <LinkedAssignmentBlock assignment={item.assignment} />
                          </div>
                          <StatusBadge value={item.status ?? "Not started"} />
                        </div>
                      ))}
                    </div>
                  </PanelBody>
                </Panel>

                <Panel>
                  <PanelBody>
                    <SectionHeader title="Risks and issues" />
                    <div className="mt-4 grid gap-2">
                      {(currentBriefing.risks ?? []).map((item: AnyRecord) => (
                        <div key={item.id} className="rounded-md border border-border bg-card p-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <ShieldAlert className="h-4 w-4 text-muted-foreground" />
                            <Badge tone={riskTone(item.severity)}>{item.severity}</Badge>
                            <StatusBadge value={item.status ?? "Open"} />
                          </div>
                          <p className="mt-2 text-sm font-bold leading-6 text-foreground">{item.description}</p>
                          {item.mitigation ? <p className="mt-1 text-sm font-semibold text-muted-foreground">Next action: {item.mitigation}</p> : null}
                        </div>
                      ))}
                      {!currentBriefing.risks?.length ? <EmptyState title="No risks or issues published" /> : null}
                    </div>
                  </PanelBody>
                </Panel>

                <div className="grid gap-4 lg:grid-cols-2">
                  <Panel>
                    <PanelBody>
                      <SectionHeader title="Coordination notes" />
                      <div className="mt-4 grid gap-2">
                        {(currentBriefing.coordinationNotes ?? []).map((item: AnyRecord) => (
                          <div key={item.id} className="rounded-md border border-border bg-muted px-3 py-2 text-sm font-semibold leading-6 text-foreground">{item.note}</div>
                        ))}
                        {!currentBriefing.coordinationNotes?.length ? <EmptyState title="No coordination notes published" /> : null}
                      </div>
                    </PanelBody>
                  </Panel>

                  <Panel>
                    <PanelBody>
                      <SectionHeader title="What to do next" description="Actions come from existing workflows." />
                      <div className="mt-4 grid gap-2">
                        {(activeEvent?.nextActions ?? []).map((item: AnyRecord) => (
                          <a key={item.id} href={item.href} className="focus-ring rounded-md border border-border bg-muted p-3 hover:bg-card">
                            <p className="font-black text-foreground">{item.title}</p>
                            <p className="mt-1 text-sm font-semibold text-muted-foreground">{item.detail}</p>
                            <p className="mt-2 text-xs font-black uppercase tracking-wide text-[#145C63] dark:text-[#7ed7dc]">{item.actionLabel}</p>
                          </a>
                        ))}
                      </div>
                    </PanelBody>
                  </Panel>
                </div>

                {permissions.canReadHistory ? (
                  <Panel>
                    <PanelBody>
                      <SectionHeader title="Revision history" description="Historical revisions are readable but not the current briefing unless marked Published." />
                      <div className="mt-4 grid gap-2">
                        {(activeEvent?.history ?? []).map((item: AnyRecord) => (
                          <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted px-3 py-2">
                            <div>
                              <p className="font-bold text-foreground">Revision {item.revision}: {item.title}</p>
                              <p className="text-xs font-semibold text-muted-foreground">{item.updatedAt ? formatDate(item.updatedAt) : "No update time"}</p>
                            </div>
                            <StatusBadge value={item.status} />
                          </div>
                        ))}
                      </div>
                    </PanelBody>
                  </Panel>
                ) : null}
              </>
            )}
          </div>
        </div>
      )}

      {editorBriefing ? (
        <DialogSurface
          title={`Draft briefing revision ${editorBriefing.revision}`}
          description="Edit structured briefing sections before publishing."
          onClose={() => setEditorBriefing(null)}
          dirty={dirty}
          busy={saving}
          initialFocus="first-control"
          className="fixed right-0 top-0 z-50 flex h-dvh w-full max-w-3xl flex-col border-l border-border bg-card text-foreground shadow-2xl"
        >
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              void saveDraft();
            }}
          >
            <div className="border-b border-border bg-card px-4 py-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 data-dialog-heading="true" tabIndex={-1} className="text-lg font-black text-foreground">Draft briefing</h2>
                  <p className="mt-1 text-sm font-semibold text-muted-foreground">
                    Revision {editorBriefing.revision} · Draft is not visible as current briefing until published.
                  </p>
                </div>
                <Badge tone="warning">Draft</Badge>
              </div>
            </div>
            <div className="scrollbar-soft grid min-h-0 flex-1 gap-4 overflow-y-auto px-4 py-4">
              <ErrorSummary title="Draft could not be saved" errors={editorErrors} />
              <Field label="Title" required>
                <Input data-dialog-initial-focus="true" value={form.title} disabled={saving} onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))} />
              </Field>
              <Field label="Situation summary" required helperText="Short orientation for a stressed team member.">
                <Textarea value={form.situationSummary} disabled={saving} onChange={(event) => setForm((current) => ({ ...current, situationSummary: event.target.value }))} />
              </Field>
              <Field label="Incident or exercise overview">
                <Textarea value={form.overview} disabled={saving} onChange={(event) => setForm((current) => ({ ...current, overview: event.target.value }))} />
              </Field>
              <Field label="Confirmed information" helperText="One item per line. Optional source: statement | source">
                <Textarea value={form.confirmedFacts} disabled={saving} onChange={(event) => setForm((current) => ({ ...current, confirmedFacts: event.target.value }))} />
              </Field>
              <Field label="Information to verify" helperText="One unconfirmed item per line. These remain labelled separately after publish.">
                <Textarea value={form.unconfirmedInformation} disabled={saving} onChange={(event) => setForm((current) => ({ ...current, unconfirmedInformation: event.target.value }))} />
              </Field>
              <Field label="Current priorities" required helperText="One priority per line. Order matters. Link existing assignments below when a priority has related work.">
                <Textarea value={form.priorities} disabled={saving} onChange={(event) => updatePriorityText(event.target.value)} />
              </Field>
              {priorityRows.length ? (
                <div className="grid gap-2 rounded-md border border-border bg-muted p-3">
                  <div>
                    <p className="text-sm font-black text-foreground">Linked assignments</p>
                    <p className="mt-1 text-xs font-semibold leading-5 text-muted-foreground">
                      Select existing assignments only. Task ownership and status remain managed in Assignments.
                    </p>
                  </div>
                  {assignmentOptionsError ? <AlertBox tone="warning">Assignments could not be loaded. Save is still available for priorities without link changes.</AlertBox> : null}
                  {priorityRows.map((priority, index) => (
                    <Field key={`${index}-${priority.description}`} label={`Priority ${index + 1}`} helperText={priority.description}>
                      <Select
                        value={priority.linkedAssignmentId}
                        disabled={saving || assignmentOptionsLoading}
                        onChange={(event) => updatePriorityLink(index, event.target.value)}
                      >
                        <option value="">No linked assignment</option>
                        {sortedAssignmentOptions.map((assignment) => (
                          <option key={assignment.id} value={assignment.id}>
                            {assignmentOptionLabel(assignment)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  ))}
                </div>
              ) : null}
              <Field label="Risks and issues" helperText="Use Information:, Attention: or Critical: before the issue when needed.">
                <Textarea value={form.risks} disabled={saving} onChange={(event) => setForm((current) => ({ ...current, risks: event.target.value }))} />
              </Field>
              <Field label="Coordination notes">
                <Textarea value={form.coordinationNotes} disabled={saving} onChange={(event) => setForm((current) => ({ ...current, coordinationNotes: event.target.value }))} />
              </Field>
              <Field label="Next update due">
                <Input type="datetime-local" value={form.nextUpdateDueAt} disabled={saving} onChange={(event) => setForm((current) => ({ ...current, nextUpdateDueAt: event.target.value }))} />
              </Field>
              {dirty ? (
                <AlertBox tone="warning">
                  Save the draft before publishing so the published revision uses the latest reviewed sections.
                </AlertBox>
              ) : null}
            </div>
            <div className="border-t border-border bg-card px-4 py-3">
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button type="button" variant="secondary" disabled={saving} onClick={() => setEditorBriefing(null)}>Close</Button>
                <Button type="submit" variant="primary" icon={FileText} disabled={saving}>{saving ? "Saving" : "Save draft"}</Button>
                {can("briefing:publish") ? (
                  <Button type="button" variant="create" icon={Send} disabled={saving || dirty} onClick={() => void publishDraft()}>
                    {saving ? "Publishing" : "Publish briefing"}
                  </Button>
                ) : null}
              </div>
              {editorBriefing.updatedAt ? (
                <p className="mt-2 flex items-center gap-1 text-xs font-semibold text-muted-foreground">
                  <Clock className="h-3.5 w-3.5" /> Last draft update {formatDate(editorBriefing.updatedAt)}
                </p>
              ) : null}
            </div>
          </form>
        </DialogSurface>
      ) : null}
    </>
  );
}
