import { ExternalLink, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Badge, Button, StatusBadge } from "./ui";
import { formatDate, labelFromKey } from "../lib/format";
import {
  accessibleSourcePath,
  displayHistoryValue,
  historyCategoryForAudit,
  historyCategoryForTimeline,
  metadataEntries,
  workflowCategoryForRecord
} from "../lib/record-context";
import type { AnyRecord } from "../lib/types";
import { DialogSurface } from "./DialogSurface";

type Props = {
  kind: "timeline" | "audit";
  record: AnyRecord;
  can: (permission: string) => boolean;
  onClose: () => void;
};

function sameTimestamp(left: unknown, right: unknown) {
  if (!left || !right) return true;
  const leftTime = new Date(String(left)).getTime();
  const rightTime = new Date(String(right)).getTime();
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime === rightTime;
}

function actorName(record: AnyRecord) {
  return record.actorDisplayName ?? record.actor?.displayName ?? record.createdBy?.displayName ?? record.actorEmail ?? record.createdBy?.email ?? "Not recorded";
}

function actorRole(record: AnyRecord) {
  const roles = record.actorRoles ?? record.actor?.roles ?? record.createdBy?.roles;
  if (Array.isArray(roles) && roles.length) return roles.join(", ");
  return record.actorRole ?? "Not recorded";
}

function Field({ label, value, children }: { label: string; value?: unknown; children?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
      <dt className="text-[11px] font-black uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-1 break-words text-sm font-semibold leading-5 text-slate-900">{children ?? displayHistoryValue(value)}</dd>
    </div>
  );
}

export function HistoryDetailDrawer({ kind, record, can, onClose }: Props) {
  const navigate = useNavigate();
  const metadata = Object.fromEntries(metadataEntries(record.metadata));
  const category = kind === "timeline" ? historyCategoryForTimeline(record) : historyCategoryForAudit(record);
  const rawType = kind === "timeline" ? record.eventType : record.action;
  const sourcePath = accessibleSourcePath(can, record.entityType, record.entityId);
  const eventTime = kind === "timeline" ? record.occurredAt : record.eventAt ?? record.createdAt;
  const reason = record.body ?? metadata.reason ?? metadata.decisionNotes ?? metadata.closureNote ?? metadata.basis;
  const status = metadata.newState ?? metadata.status ?? record.status;
  const rawPayload = metadataEntries(record.metadata).length ? JSON.stringify(record.metadata, null, 2) : "";

  return (
    <DialogSurface
      title={`${kind === "timeline" ? "Timeline" : "Audit"} event details`}
      description="Read-only operational history"
      onClose={onClose}
      className="fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col border-l border-border bg-card text-foreground shadow-2xl"
    >
      {({ requestClose }) => (
      <>
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={category === "Workflow decision" ? "warning" : category === "Manual note" ? "info" : "neutral"}>{category}</Badge>
              {status ? <StatusBadge value={status} /> : null}
            </div>
            <h2 data-dialog-heading="true" tabIndex={-1} className="mt-2 text-lg font-black text-foreground">{kind === "timeline" ? record.title : record.summary}</h2>
            <p className="mt-1 text-sm font-semibold text-muted-foreground">Read-only operational history</p>
          </div>
          <Button icon={XCircle} variant="ghost" onClick={() => requestClose()}>Close</Button>
        </div>

        <div className="scrollbar-soft flex-1 overflow-y-auto p-5">
          <dl className="grid gap-3 sm:grid-cols-2">
            <Field label="Category" value={category} />
            <Field label={kind === "timeline" ? "Event type (original)" : "Action (original)"} value={rawType} />
            <Field label="Actor" value={actorName(record)} />
            <Field label="Actor role" value={actorRole(record)} />
            <Field label="Source entity type" value={record.entityType} />
            <Field label="Source entity ID">
              <div className="flex min-w-0 items-center justify-between gap-2">
                <span className="break-all">{displayHistoryValue(record.entityId)}</span>
                {sourcePath ? (
                  <Button icon={ExternalLink} size="sm" variant="secondary" onClick={() => navigate(sourcePath)}>Open source</Button>
                ) : null}
              </div>
            </Field>
            <Field label="Session ID" value={record.sessionId} />
            <Field label="Related case ID" value={record.caseId ?? metadata.caseId} />
            <Field label="Operational event time" value={eventTime ? formatDate(eventTime) : "Not recorded"} />
            {!sameTimestamp(eventTime, record.createdAt) ? <Field label="Record created time" value={formatDate(record.createdAt)} /> : null}
            <Field label="Originating workflow" value={workflowCategoryForRecord(kind, record)} />
            {status ? <Field label="Status" value={status} /> : null}
            {metadata.oldState !== undefined || metadata.previousStatus !== undefined ? <Field label="Old state" value={metadata.oldState ?? metadata.previousStatus} /> : null}
            {metadata.newState !== undefined || metadata.status !== undefined ? <Field label="New state" value={metadata.newState ?? metadata.status} /> : null}
          </dl>

          {kind === "timeline" && record.body ? (
            <section className="mt-4 rounded-md border border-slate-200 bg-white p-4">
              <h3 className="text-sm font-black text-slate-950">Full text</h3>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm font-medium leading-6 text-slate-700">{record.body}</p>
            </section>
          ) : null}

          {reason && (kind === "audit" || reason !== record.body) ? (
            <section className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-4">
              <h3 className="text-sm font-black text-amber-950">Decision note / reason</h3>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm font-semibold leading-6 text-amber-900">{String(reason)}</p>
            </section>
          ) : null}

          {metadataEntries(record.metadata).length ? (
            <section className="mt-4">
              <h3 className="text-sm font-black text-slate-950">Structured details</h3>
              <dl className="mt-2 grid gap-2 sm:grid-cols-2">
                {metadataEntries(record.metadata).map(([key, value]) => <Field key={key} label={labelFromKey(key)} value={value} />)}
              </dl>
            </section>
          ) : null}

          {can("audit:read") && rawPayload ? (
            <details className="mt-4 rounded-md border border-slate-200 bg-slate-950 p-3 text-slate-100">
              <summary className="cursor-pointer text-sm font-black">Raw technical payload</summary>
              <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words text-xs leading-5">{rawPayload}</pre>
            </details>
          ) : null}
        </div>
      </>
      )}
    </DialogSurface>
  );
}
