import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Check, CheckCircle2, ChevronLeft, ChevronRight, Clock3, CopyX, Eye, FilePlus2, Pencil, PlayCircle, Save, Search, Send, ShieldCheck, Siren, UserCheck, XCircle } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { useApp } from "../lib/app-context";
import { isSessionWriteContextCurrent } from "../lib/session-safety";
import type { AnyRecord, DictionaryMap } from "../lib/types";
import { AlertBox, Badge, Button, Card, DecisionDialog, EmptyState, ErrorSummary, Field, Input, Loading, Select, StatusBadge, Table, Textarea } from "../components/ui";
import { DialogSurface } from "../components/DialogSurface";

type FieldDef = {
  name: string;
  label: string;
  section?: string;
  type?: "text" | "email" | "number" | "date" | "textarea" | "select" | "age-select";
  optionsKey?: keyof DictionaryMap | string;
  required?: boolean;
};

type Config = {
  resource: string;
  title: string;
  description: string;
  readPermission: string;
  createPermission: string;
  updatePermission: string;
  columns: Array<{ key: string; label: string; status?: boolean; className?: string }>;
  fields: FieldDef[];
};

const ageOptions = Array.from({ length: 121 }, (_, age) => String(age));
const enquiryPassengerFields = new Set(["passengerFirstName", "passengerLastName", "passengerFlight", "passengerRoute"]);
const pageSizeOptions = [10, 25, 50, 100];
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const dateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit"
});
const controlledOptionsByKind: Record<string, Record<string, Set<string>>> = {
  enquiries: {
    status: new Set(["Sent to family assistance", "Duplicate suspected", "Urgent welfare", "Closed"])
  },
  "family-records": {
    verificationStatus: new Set(["Verified", "Disputed"])
  },
  requests: {
    approvalStatus: new Set(["Approved", "Rejected"]),
    status: new Set(["Assigned", "In progress", "Waiting", "Done", "Closed", "Cancelled"])
  }
};
type SortDirection = "asc" | "desc";
type PendingDecision = {
  action: "family-verify" | "request-close" | "passenger-src" | "passenger-condition" | "passenger-hold";
  record: AnyRecord;
  note: string;
  value?: string;
  error: string;
  saving: boolean;
};

const configs: Record<string, Config> = {
  enquiries: {
    resource: "enquiries",
    title: "Enquiry Intake / TEC Queue",
    description: "Incoming contacts are recorded without confirming passenger, casualty or NOK status.",
    readPermission: "enquiry:read",
    createPermission: "enquiry:create",
    updatePermission: "enquiry:update",
    columns: [
      { key: "operationalId", label: "ID", className: "w-[148px]" },
      { key: "callerName", label: "Caller", className: "w-[130px]" },
      { key: "contactChannel", label: "Channel", className: "w-24" },
      { key: "passengerLastName", label: "Passenger", className: "w-[116px]" },
      { key: "urgency", label: "Urgency", status: true, className: "w-[124px]" },
      { key: "status", label: "Status", status: true, className: "w-[136px]" }
    ],
    fields: [
      { name: "contactChannel", label: "Contact channel", section: "Caller", type: "select", optionsKey: "channels", required: true },
      { name: "callerName", label: "Caller name", section: "Caller", required: true },
      { name: "callerPhone", label: "Caller phone / contact number", section: "Caller" },
      { name: "callerEmail", label: "Caller email", section: "Caller", type: "email" },
      { name: "callerLocation", label: "Caller location", section: "Caller" },
      { name: "preferredLanguage", label: "Preferred language", section: "Caller", type: "select", optionsKey: "communicationLanguages" },
      { name: "claimedRelationship", label: "Claimed relationship", section: "Passenger / context", type: "select", optionsKey: "relationships" },
      { name: "passengerFirstName", label: "Passenger first name", section: "Passenger / context" },
      { name: "passengerLastName", label: "Passenger last name", section: "Passenger / context" },
      { name: "passengerFlight", label: "Passenger flight", section: "Passenger / context" },
      { name: "passengerRoute", label: "Passenger route", section: "Passenger / context" },
      { name: "lastKnownContact", label: "Last known contact", section: "Passenger / context", type: "textarea" },
      { name: "enquiryType", label: "Enquiry type", section: "Classification", type: "select", optionsKey: "enquiryTypes", required: true },
      { name: "urgency", label: "Urgency", section: "Classification", type: "select", optionsKey: "enquiryUrgencies" },
      { name: "status", label: "Status", section: "Classification", type: "select", optionsKey: "enquiryStatuses" },
      { name: "notes", label: "Notes", section: "Notes", type: "textarea" }
    ]
  },
  "family-records": {
    resource: "family-records",
    title: "Family / NOK / FRC Records",
    description: "Verification is tracked separately from enquiries and passenger records.",
    readPermission: "family:read",
    createPermission: "family:create",
    updatePermission: "family:update",
    columns: [
      { key: "operationalId", label: "ID", className: "w-[148px]" },
      { key: "lastName", label: "Last name", className: "w-[120px]" },
      { key: "firstName", label: "First name", className: "w-[120px]" },
      { key: "claimedRelationship", label: "Relationship", className: "w-[132px]" },
      { key: "passengerLastName", label: "Passenger", className: "w-[116px]" },
      { key: "verificationStatus", label: "Verification", status: true, className: "w-[148px]" }
    ],
    fields: [
      { name: "firstName", label: "First name", required: true },
      { name: "lastName", label: "Last name", required: true },
      { name: "phone", label: "Phone" },
      { name: "email", label: "Email", type: "email" },
      { name: "preferredContactChannel", label: "Preferred contact channel", type: "select", optionsKey: "channels" },
      { name: "preferredLanguage", label: "Preferred language", type: "select", optionsKey: "communicationLanguages" },
      { name: "location", label: "Location" },
      { name: "claimedRelationship", label: "Claimed relationship", type: "select", optionsKey: "relationships" },
      { name: "passengerFirstName", label: "Passenger first name" },
      { name: "passengerLastName", label: "Passenger last name" },
      { name: "passengerFlight", label: "Passenger flight" },
      { name: "verificationStatus", label: "Verification status", type: "select", optionsKey: "verificationStatuses" },
      { name: "verificationNotes", label: "Verification notes", type: "textarea" },
      { name: "immediateNeeds", label: "Immediate needs", type: "textarea" },
      { name: "questionsAsked", label: "Questions asked", type: "textarea" },
      { name: "commitmentsMade", label: "Commitments made", type: "textarea" },
      { name: "nextContactDue", label: "Next contact due", type: "date" },
      { name: "assignedOfficer", label: "Assigned officer" },
      { name: "notes", label: "Notes", type: "textarea" }
    ]
  },
  "passenger-records": {
    resource: "passenger-records",
    title: "Passenger / Crew / SRC Records",
    description: "Manifest and SRC data remain separate from matching and release decisions.",
    readPermission: "passenger:read",
    createPermission: "passenger:create",
    updatePermission: "passenger:update",
    columns: [
      { key: "operationalId", label: "ID", className: "w-[148px]" },
      { key: "personType", label: "Type", className: "w-[112px]" },
      { key: "lastName", label: "Last name", className: "w-[124px]" },
      { key: "flightNumber", label: "Flight", className: "w-[96px]" },
      { key: "conditionStatus", label: "Condition", status: true, className: "w-[128px]" },
      { key: "holdStatus", label: "Hold", status: true, className: "w-[168px]" }
    ],
    fields: [
      { name: "personType", label: "Person type", type: "select", optionsKey: "personTypes", required: true },
      { name: "firstName", label: "First name", required: true },
      { name: "lastName", label: "Last name", required: true },
      { name: "dateOfBirth", label: "Date of birth", type: "date" },
      { name: "age", label: "Age", type: "age-select" },
      { name: "gender", label: "Gender", type: "select", optionsKey: "genders" },
      { name: "nationality", label: "Nationality", type: "select", optionsKey: "nationalities" },
      { name: "flightNumber", label: "Flight number" },
      { name: "route", label: "Route" },
      { name: "seat", label: "Seat" },
      { name: "pnr", label: "PNR" },
      { name: "ticketNumber", label: "Ticket number" },
      { name: "manifestVersion", label: "Manifest version" },
      { name: "source", label: "Source", type: "select", optionsKey: "passengerSources", required: true },
      { name: "travellingCompanions", label: "Travelling companions", type: "textarea" },
      { name: "sourceExternalId", label: "Source external ID" },
      { name: "notes", label: "Notes", type: "textarea" }
    ]
  },
  requests: {
    resource: "requests",
    title: "Welfare / Logistics Requests",
    description: "Requests should be linked to a case, passenger, family record or enquiry where possible.",
    readPermission: "request:read",
    createPermission: "request:create",
    updatePermission: "request:update",
    columns: [
      { key: "operationalId", label: "ID", className: "w-[148px]" },
      { key: "category", label: "Category", className: "w-[148px]" },
      { key: "priority", label: "Priority", status: true, className: "w-[104px]" },
      { key: "ownerAssignedTo", label: "Owner", className: "w-[132px]" },
      { key: "approvalStatus", label: "Approval", status: true, className: "w-[124px]" },
      { key: "status", label: "Status", status: true, className: "w-[112px]" }
    ],
    fields: [
      { name: "category", label: "Category", type: "select", optionsKey: "requestCategories", required: true },
      { name: "priority", label: "Priority", type: "select", optionsKey: "requestPriorities" },
      { name: "requester", label: "Requester" },
      { name: "ownerAssignedTo", label: "Owner / assigned to" },
      { name: "details", label: "Details", type: "textarea", required: true },
      { name: "approvalStatus", label: "Approval status", type: "select", optionsKey: "approvalStatuses" },
      { name: "status", label: "Status", type: "select", optionsKey: "requestStatuses" },
      { name: "closureNote", label: "Closure note", type: "textarea" },
      { name: "notes", label: "Notes", type: "textarea" }
    ]
  }
};

function recordUxCopy(kind: keyof typeof configs) {
  if (kind === "enquiries") {
    return {
      noun: "TEC enquiry",
      newLabel: "New enquiry",
      fallback: "Unsaved enquiry",
      helper: "Capture what the caller said. Do not confirm passenger, casualty or NOK status from this panel.",
      nextSteps: [
        "Record who is calling and how to contact them.",
        "Add passenger/context exactly as reported, or choose a known passenger only when appropriate.",
        "Save the enquiry, then send to ZPP only if support action is needed."
      ],
      saveNew: "Save enquiry"
    };
  }
  if (kind === "family-records") {
    return {
      noun: "family/NOK record",
      newLabel: "New family record",
      fallback: "Unsaved family record",
      helper: "Record family contact details and verification basis separately from passenger status.",
      nextSteps: [
        "Record the contact details and claimed relationship.",
        "Add verification notes before changing verification status.",
        "Save the record, then verify only when the relationship basis is clear."
      ],
      saveNew: "Save family record"
    };
  }
  if (kind === "passenger-records") {
    return {
      noun: "passenger/SRC record",
      newLabel: "New passenger record",
      fallback: "Unsaved passenger record",
      helper: "Maintain manifest and source-confirmed details without changing matching or release decisions.",
      nextSteps: [
        "Check identity, flight and manifest/source details.",
        "Set condition and hold status before this record is used elsewhere.",
        "Save first; mark SRC confirmed only when the source has been reviewed."
      ],
      saveNew: "Save passenger record"
    };
  }
  return {
    noun: "support request",
    newLabel: "New request",
    fallback: "Unsaved request",
    helper: "Describe the welfare or logistics need, owner and status so another team member can pick it up safely.",
    nextSteps: [
      "Describe the need in plain language.",
      "Set priority, owner and status so the next person knows what to do.",
      "Save the request; close it only with a clear closure note."
    ],
    saveNew: "Save request"
  };
}

function defaultValue(field: FieldDef, dictionaries: DictionaryMap) {
  if (field.type === "age-select") return "";
  if (field.type === "select" && ["genders", "nationalities", "relationships"].includes(String(field.optionsKey))) return "";
  if (field.type === "select" && field.optionsKey) return dictionaries[field.optionsKey]?.[0]?.label ?? "";
  return "";
}

function buildDefaults(fields: FieldDef[], dictionaries: DictionaryMap, sessionId?: string) {
  const values: AnyRecord = { sessionId };
  for (const field of fields) values[field.name] = defaultValue(field, dictionaries);
  return values;
}

function normalizePayload(record: AnyRecord, fields: FieldDef[]) {
  const payload = { ...record };
  const fieldMap = new Map(fields.map((field) => [field.name, field]));
  for (const [key, value] of Object.entries(payload)) {
    const field = fieldMap.get(key);
    if (value === "" && (!field || !field.required)) {
      payload[key] = null;
      continue;
    }
    if (field?.type === "number" || field?.type === "age-select") {
      payload[key] = value === null || value === undefined || value === "" ? null : Number(value);
    }
  }
  return payload;
}

function sortRecordValue(value: unknown) {
  if (value === null || value === undefined) return "";
  return value;
}

function compareRecordValues(a: unknown, b: unknown) {
  const first = sortRecordValue(a);
  const second = sortRecordValue(b);
  if (typeof first === "number" && typeof second === "number") return first - second;
  return collator.compare(String(first), String(second));
}

function formatDateTime(value: unknown) {
  if (!value) return "Not captured";
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? "Not captured" : dateTimeFormatter.format(date);
}

function actorLabel(value: unknown) {
  if (!value || typeof value !== "object") return "Unknown";
  const actor = value as { displayName?: string | null; email?: string | null };
  return actor.displayName ?? actor.email ?? "Unknown";
}

function actorSearchLabel(value: unknown) {
  return value && typeof value === "object" ? actorLabel(value) : "";
}

function matchesRecordFocus(row: AnyRecord, focus: string) {
  const normalized = focus.trim().toLowerCase();
  if (!normalized) return false;
  return ["operationalId", "id", "caseId"].some((key) => String(row[key] ?? "").toLowerCase() === normalized);
}

function MetadataCell({ row }: { row: AnyRecord }) {
  return (
    <div className="min-w-0">
      <p className="truncate font-semibold text-foreground">{formatDateTime(row.updatedAt ?? row.createdAt)}</p>
      <p className="truncate text-xs font-medium text-muted-foreground">{actorLabel(row.updatedBy ?? row.createdBy)}</p>
    </div>
  );
}

function RecordField({
  field,
  value,
  onChange,
  readOnly,
  controlledOptions,
  error
}: {
  field: FieldDef;
  value: any;
  onChange: (value: any) => void;
  readOnly?: boolean;
  controlledOptions?: Set<string>;
  error?: string;
}) {
  const { dictionaries } = useApp();
  const currentValue = String(value ?? "");
  const currentIsControlled = Boolean(currentValue && controlledOptions?.has(currentValue));
  const options = field.optionsKey
    ? (dictionaries[field.optionsKey] ?? []).map((item) => item.label).filter((option) => !controlledOptions?.has(option))
    : [];
  const fieldDisabled = !readOnly && currentIsControlled;
  return (
    <Field id={`record-${field.name}`} label={field.label} required={field.required} error={error}>
      {field.type === "textarea" ? (
        <Textarea value={value ?? ""} readOnly={readOnly} disabled={fieldDisabled} onChange={(event) => onChange(event.target.value)} />
      ) : field.type === "age-select" ? (
        <Select value={value ?? ""} readOnly={readOnly} disabled={fieldDisabled} onChange={(event) => onChange(event.target.value)}>
          <option value="">Select</option>
          {ageOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      ) : field.type === "select" ? (
        <Select value={value ?? ""} readOnly={readOnly} disabled={fieldDisabled} onChange={(event) => onChange(event.target.value)}>
          <option value="">Select</option>
          {currentIsControlled ? <option value={currentValue}>{currentValue} (controlled state)</option> : null}
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      ) : (
        <Input
          type={field.type ?? "text"}
          autoComplete={field.name.toLowerCase().includes("email") ? "email" : field.name.toLowerCase().includes("phone") ? "tel" : field.name === "firstName" ? "given-name" : field.name === "lastName" ? "family-name" : undefined}
          value={value ?? ""}
          readOnly={readOnly}
          disabled={fieldDisabled}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {controlledOptions?.size ? <p className="mt-1 text-xs font-semibold text-muted-foreground">Controlled states are changed only through the dedicated workflow action.</p> : null}
    </Field>
  );
}

export function RecordsPage({ kind }: { kind: keyof typeof configs }) {
  const config = configs[kind]!;
  const recordCopy = recordUxCopy(kind);
  const { activeSession, activeSessionWritable, dictionaries, can, reload, verifyActiveSessionWrite } = useApp();
  const [searchParams] = useSearchParams();
  const focusRecordId = searchParams.get("focus") ?? "";
  const handledFocusRef = useRef("");
  const [rows, setRows] = useState<AnyRecord[]>([]);
  const [serverTotal, setServerTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<AnyRecord>(() => buildDefaults(config.fields, dictionaries, activeSession?.id));
  const [editorOpen, setEditorOpen] = useState(false);
  const [passengerOptions, setPassengerOptions] = useState<AnyRecord[]>([]);
  const [selectedPassengerId, setSelectedPassengerId] = useState("");
  const [sortKey, setSortKey] = useState("updatedAt");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("");
  const [pendingDecision, setPendingDecision] = useState<PendingDecision | null>(null);
  const [writeError, setWriteError] = useState("");
  const [editorBaseline, setEditorBaseline] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [sourceCorrectionMode, setSourceCorrectionMode] = useState(false);
  const [sourceCorrectionReason, setSourceCorrectionReason] = useState("");
  const [passengerCondition, setPassengerCondition] = useState("");
  const [passengerHold, setPassengerHold] = useState("");

  const isPassengerPage = kind === "passenger-records";

  const canCreate = activeSessionWritable && can(config.createPermission);
  const canUpdate = activeSessionWritable && can(config.updatePermission);
  const canSaveCurrent = editing.id ? canUpdate : canCreate;
  const showRecordFields = Boolean(editing.id) || canCreate;
  const filterColumn = useMemo(
    () => config.columns.find((column) => column.key === "status") ?? config.columns.find((column) => column.key === "verificationStatus") ?? config.columns.find((column) => column.status),
    [config.columns]
  );
  const fieldGroups = useMemo(() => {
    const groups: Array<{ title: string; fields: FieldDef[] }> = [];
    for (const field of config.fields) {
      const title = field.section ?? "Details";
      const group = groups.find((item) => item.title === title);
      if (group) group.fields.push(field);
      else groups.push({ title, fields: [field] });
    }
    return groups;
  }, [config.fields]);

  const columns = useMemo(
    () => [
      ...config.columns.map((column) => ({
        key: column.key,
        label: column.label,
        className: column.className,
        sortable: true,
        render: column.status ? (row: AnyRecord) => <StatusBadge value={row[column.key]} /> : undefined
      })),
      {
        key: "updatedAt",
        label: "Updated",
        className: "w-[170px]",
        sortable: true,
        render: (row: AnyRecord) => <MetadataCell row={row} />
      }
    ],
    [config.columns]
  );

  const statusOptions = useMemo(() => {
    if (isPassengerPage) return (dictionaries.conditionStatuses ?? []).map((option) => option.label);
    if (!filterColumn) return [];
    return Array.from(new Set(rows.map((row) => row[filterColumn.key]).filter(Boolean).map(String))).sort(collator.compare);
  }, [dictionaries.conditionStatuses, filterColumn, isPassengerPage, rows]);

  const filteredRows = useMemo(() => {
    if (isPassengerPage) return rows;
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (statusFilter && filterColumn && String(row[filterColumn.key] ?? "") !== statusFilter) return false;
      if (!needle) return true;
      return [
        row.operationalId,
        row.caseId,
        row.callerName,
        row.firstName,
        row.lastName,
        row.passengerLastName,
        row.category,
        row.status,
        row.verificationStatus,
        actorSearchLabel(row.createdBy),
        actorSearchLabel(row.updatedBy)
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });
  }, [filterColumn, isPassengerPage, query, rows, statusFilter]);

  const sortedRows = useMemo(() => {
    if (isPassengerPage) return filteredRows;
    const direction = sortDirection === "asc" ? 1 : -1;
    return [...filteredRows].sort((left, right) => compareRecordValues(left[sortKey], right[sortKey]) * direction);
  }, [filteredRows, isPassengerPage, sortDirection, sortKey]);

  const resultTotal = isPassengerPage ? serverTotal : sortedRows.length;
  const totalPages = Math.max(1, Math.ceil(resultTotal / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStartIndex = resultTotal ? (currentPage - 1) * pageSize : 0;
  const pageEndIndex = Math.min(pageStartIndex + pageSize, resultTotal);
  const pageRangeStart = resultTotal ? pageStartIndex + 1 : 0;
  const pagedRows = isPassengerPage ? sortedRows : sortedRows.slice(pageStartIndex, pageEndIndex);

  async function load() {
    if (!activeSession) {
      setRows([]);
      setPassengerOptions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const canLoadPassengerContext = kind === "enquiries" && can("passenger:read");
      const passengerQuery = isPassengerPage ? {
        sessionId: activeSession.id,
        search: query.trim() || undefined,
        conditionStatus: statusFilter || undefined,
        sortBy: ["updatedAt", "operationalId", "lastName", "flightNumber", "conditionStatus", "holdStatus"].includes(sortKey) ? sortKey : "updatedAt",
        sortDirection,
        limit: pageSize,
        offset: (page - 1) * pageSize
      } : undefined;
      const [result, passengers] = await Promise.all([
        isPassengerPage ? api.list(config.resource, passengerQuery) : api.listAll(config.resource, { sessionId: activeSession.id }),
        canLoadPassengerContext ? api.listAll("passenger-records", { sessionId: activeSession.id }) : Promise.resolve({ data: [] })
      ]);
      setRows(result.data);
      setServerTotal(Number(result.total ?? result.data.length));
      setPassengerOptions(passengers.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load records");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    setEditing(buildDefaults(config.fields, dictionaries, activeSession?.id));
    setEditorOpen(false);
    setSelectedPassengerId("");
    setSortKey("updatedAt");
    setSortDirection("desc");
    setStatusFilter("");
    setQuery("");
    setPage(1);
    setPendingDecision(null);
    setWriteError("");
    setSourceCorrectionMode(false);
    setSourceCorrectionReason("");
  }, [activeSession?.id, kind]);

  useEffect(() => {
    if (!isPassengerPage || !activeSession) return;
    const timeout = window.setTimeout(() => void load(), 250);
    return () => window.clearTimeout(timeout);
  }, [activeSession?.id, isPassengerPage, page, pageSize, query, sortDirection, sortKey, statusFilter]);

  function handleSort(key: string) {
    setPage(1);
    if (sortKey === key) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDirection("asc");
  }

  async function save() {
    if (saving) return;
    if (!activeSession || !isSessionWriteContextCurrent(activeSession, editing.sessionId) || !(await verifyActiveSessionWrite(editing.sessionId))) {
      setWriteError("The session changed or is no longer writable. Close this drawer and select an open session before saving.");
      return;
    }
    const nextFieldErrors = Object.fromEntries(
      config.fields
        .filter((field) => field.required && (editing[field.name] === undefined || editing[field.name] === null || String(editing[field.name]).trim() === ""))
        .map((field) => [field.name, `${field.label} is required.`])
    );
    if (Object.keys(nextFieldErrors).length) {
      setFieldErrors(nextFieldErrors);
      setWriteError("Complete the required fields before saving.");
      return;
    }
    const payload = normalizePayload({ ...editing, sessionId: activeSession.id }, config.fields);
    let sourceChanges: Record<string, unknown> = {};
    if (isPassengerPage && editing.id && sourceCorrectionMode) {
      const baseline = editorBaseline ? JSON.parse(editorBaseline) as AnyRecord : {};
      sourceChanges = Object.fromEntries(
        config.fields
          .filter((field) => field.name !== "notes")
          .filter((field) => JSON.stringify(payload[field.name] ?? null) !== JSON.stringify(baseline[field.name] ?? null))
          .map((field) => [field.name, payload[field.name]])
      );
      if (Object.keys(sourceChanges).length === 0) {
        setWriteError("Change at least one source field before applying a correction.");
        return;
      }
    }
    setSaving(true);
    setWriteError("");
    try {
      if (isPassengerPage && editing.id && sourceCorrectionMode) {
        await api.action(config.resource, editing.id, "correct-source", {
          ...sourceChanges,
          sessionId: activeSession.id,
          version: editing.version,
          reason: sourceCorrectionReason
        });
      } else if (isPassengerPage && editing.id) {
        await api.update(config.resource, editing.id, { sessionId: activeSession.id, version: editing.version, caseId: editing.caseId ?? null, notes: editing.notes ?? null });
      } else if (editing.id) await api.update(config.resource, editing.id, payload);
      else await api.create(config.resource, payload);
      setEditorBaseline("");
      setEditing(buildDefaults(config.fields, dictionaries, activeSession.id));
      setEditorOpen(false);
      setSelectedPassengerId("");
      await Promise.all([load(), reload()]);
    } catch (err) {
      setWriteError(err instanceof Error ? err.message : "Unable to save record");
    } finally {
      setSaving(false);
    }
  }

  function startNewRecord() {
    if (!activeSessionWritable) return;
    const next = buildDefaults(config.fields, dictionaries, activeSession?.id);
    setEditing(next);
    setEditorBaseline(JSON.stringify(next));
    setWriteError("");
    setFieldErrors({});
    setSelectedPassengerId("");
    setEditorOpen(true);
  }

  function passengerLabel(passenger: AnyRecord) {
    const name = [passenger.firstName, passenger.lastName].filter(Boolean).join(" ");
    const flight = [passenger.flightNumber, passenger.route].filter(Boolean).join(" / ");
    return [passenger.operationalId, name, flight, passenger.caseId].filter(Boolean).join(" | ");
  }

  function findPassengerForRecord(record: AnyRecord) {
    return passengerOptions.find((passenger) => {
      if (record.passengerRecordId && passenger.id === record.passengerRecordId) return true;
      const sameCase = record.caseId && passenger.caseId === record.caseId;
      const sameName =
        record.passengerFirstName &&
        record.passengerLastName &&
        passenger.firstName === record.passengerFirstName &&
        passenger.lastName === record.passengerLastName;
      const sameFlight = !record.passengerFlight || passenger.flightNumber === record.passengerFlight;
      return Boolean(sameCase || (sameName && sameFlight));
    });
  }

  function openRecord(row: AnyRecord) {
    setEditing(row);
    setEditorBaseline(JSON.stringify(row));
    setWriteError("");
    setFieldErrors({});
    setSelectedPassengerId(kind === "enquiries" ? (findPassengerForRecord(row)?.id ?? "") : "");
    setSourceCorrectionMode(false);
    setSourceCorrectionReason("");
    setPassengerCondition(String(row.conditionStatus ?? "Unknown"));
    setPassengerHold(String(row.holdStatus ?? "No hold"));
    setEditorOpen(true);
  }

  useEffect(() => {
    const focus = focusRecordId.trim();
    if (!focus) {
      handledFocusRef.current = "";
      return;
    }
    setQuery(focus);
    setPage(1);
    if (loading) return;
    const row = rows.find((item) => matchesRecordFocus(item, focus));
    const key = `${kind}:${focus}`;
    if (row && handledFocusRef.current !== key) {
      handledFocusRef.current = key;
      openRecord(row);
    }
  }, [focusRecordId, kind, loading, rows]);

  function selectPassengerContext(passengerId: string) {
    setSelectedPassengerId(passengerId);
    if (!passengerId) {
      setEditing((current) => ({ ...current, passengerRecordId: null }));
      return;
    }
    const passenger = passengerOptions.find((item) => item.id === passengerId);
    if (!passenger) return;
    setEditing((current) => ({
      ...current,
      caseId: current.caseId || passenger.caseId || "",
      passengerRecordId: passenger.id,
      passengerFirstName: passenger.firstName ?? "",
      passengerLastName: passenger.lastName ?? "",
      passengerFlight: passenger.flightNumber ?? "",
      passengerRoute: passenger.route ?? ""
    }));
  }

  function updateEditingField(fieldName: string, value: any) {
    setFieldErrors((current) => {
      if (!current[fieldName]) return current;
      const next = { ...current };
      delete next[fieldName];
      return next;
    });
    if (kind === "enquiries" && enquiryPassengerFields.has(fieldName)) {
      setSelectedPassengerId("");
      setEditing((current) => ({ ...current, passengerRecordId: null, [fieldName]: value }));
      return;
    }
    setEditing((current) => ({ ...current, [fieldName]: value }));
  }

  async function runAction(row: AnyRecord, action: string, body?: AnyRecord) {
    if (!isSessionWriteContextCurrent(activeSession, row.sessionId) || !(await verifyActiveSessionWrite(row.sessionId))) {
      setWriteError("The session changed or is closed. This workflow action was not submitted.");
      return false;
    }
    await api.action(config.resource, row.id, action, {
      ...(body ?? {}),
      sessionId: row.sessionId,
      version: row.version
    });
    await Promise.all([load(), reload()]);
    return true;
  }

  async function runEditorAction(action: string, body?: AnyRecord) {
    if (!editing.id) return;
    if (await runAction(editing, action, body)) setEditorOpen(false);
  }

  function openFamilyVerificationDecision() {
    if (!editing.id) return;
    setPendingDecision({
      action: "family-verify",
      record: editing,
      note: String(editing.verificationNotes ?? ""),
      error: "",
      saving: false
    });
  }

  function openRequestCloseDecision() {
    if (!editing.id) return;
    setPendingDecision({
      action: "request-close",
      record: editing,
      note: String(editing.closureNote ?? ""),
      error: "",
      saving: false
    });
  }

  function openPassengerDecision(action: "passenger-src" | "passenger-condition" | "passenger-hold", value?: string) {
    if (!editing.id) return;
    setPendingDecision({ action, record: editing, value, note: "", error: "", saving: false });
  }

  async function confirmDecision() {
    if (!pendingDecision) return;
    if (!isSessionWriteContextCurrent(activeSession, pendingDecision.record.sessionId) || !(await verifyActiveSessionWrite(pendingDecision.record.sessionId))) {
      setPendingDecision((current) => (current ? { ...current, error: "The session changed or is closed. This decision was not submitted.", saving: false } : current));
      return;
    }
    const note = pendingDecision.note.trim();
    const noteLabel = pendingDecision.action === "family-verify" ? "verification basis" : pendingDecision.action === "request-close" ? "closure note" : pendingDecision.action === "passenger-hold" ? "hold reason" : "decision basis";
    if (pendingDecision.action !== "passenger-src" && note.length < 3) {
      setPendingDecision((current) => (current ? { ...current, error: `Enter a ${noteLabel} with at least 3 characters.` } : current));
      return;
    }
    setPendingDecision((current) => (current ? { ...current, saving: true, error: "" } : current));
    try {
      if (pendingDecision.action === "family-verify") {
        await api.action(config.resource, pendingDecision.record.id, "verify", { verificationNotes: note });
      } else if (pendingDecision.action === "request-close") {
        await api.action(config.resource, pendingDecision.record.id, "status", { status: "Closed", closureNote: note });
      } else if (pendingDecision.action === "passenger-src") {
        await api.action(config.resource, pendingDecision.record.id, "mark-src-confirmed", { sessionId: pendingDecision.record.sessionId, version: pendingDecision.record.version, basis: note || undefined });
      } else if (pendingDecision.action === "passenger-condition") {
        await api.action(config.resource, pendingDecision.record.id, "change-condition", { sessionId: pendingDecision.record.sessionId, version: pendingDecision.record.version, conditionStatus: pendingDecision.value, basis: note });
      } else {
        await api.action(config.resource, pendingDecision.record.id, "change-hold", { sessionId: pendingDecision.record.sessionId, version: pendingDecision.record.version, holdStatus: pendingDecision.value, reason: note });
      }
      await Promise.all([load(), reload()]);
      setPendingDecision(null);
      setEditorOpen(false);
    } catch (err) {
      const fallback = pendingDecision.action === "family-verify" ? "Unable to verify family record" : "Unable to close request";
      setPendingDecision((current) =>
        current
          ? {
              ...current,
              saving: false,
              error: err instanceof Error ? err.message : fallback
            }
          : current
      );
    }
  }

  function rowActions(row: AnyRecord) {
    return (
      <Button
        icon={canUpdate ? Pencil : Eye}
        size="sm"
        variant="secondary"
        title={canUpdate ? "Edit record" : "View record"}
        aria-label={canUpdate ? "Edit record" : "View record"}
        onClick={() => openRecord(row)}
      >
        {canUpdate ? "Edit" : "View"}
      </Button>
    );
  }

  function editorActions() {
    if (!editing.id) return null;
    if (kind === "enquiries") {
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          {canUpdate ? <Button icon={Send} variant="secondary" onClick={() => runEditorAction("send-to-family-assistance")}>Send to ZPP</Button> : null}
          {activeSessionWritable && can("enquiry:escalate") ? <Button icon={Siren} variant="warning" onClick={() => runEditorAction("mark-urgent")}>Mark urgent</Button> : null}
          {canUpdate ? <Button icon={CopyX} variant="ghost" onClick={() => runEditorAction("mark-duplicate")}>Duplicate</Button> : null}
          {activeSessionWritable && can("enquiry:close") ? <Button icon={XCircle} variant="danger" onClick={() => runEditorAction("close")}>Close</Button> : null}
        </div>
      );
    }
    if (kind === "family-records") {
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          {activeSessionWritable && can("family:verify") ? (
            <Button
              icon={UserCheck}
              variant="success"
              onClick={openFamilyVerificationDecision}
            >
              Verify
            </Button>
          ) : null}
          {canUpdate ? <Button icon={ShieldCheck} variant="warning" onClick={() => runEditorAction("mark-disputed", { verificationNotes: "Marked disputed by officer." })}>Dispute</Button> : null}
        </div>
      );
    }
    if (kind === "passenger-records") {
      return (
        <div className="grid gap-3">
          {activeSessionWritable && can("passenger:srcConfirm") && !editing.srcConfirmed ? <Button icon={Check} variant="success" onClick={() => openPassengerDecision("passenger-src")}>Mark SRC confirmed</Button> : null}
          {activeSessionWritable && can("passenger:control") ? (
            <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
              <Select value={passengerCondition} onChange={(event) => setPassengerCondition(event.target.value)} aria-label="New passenger condition">
                {(dictionaries.conditionStatuses ?? []).map((option) => <option key={option.key} value={option.label}>{option.label}</option>)}
              </Select>
              <Button variant="secondary" onClick={() => openPassengerDecision("passenger-condition", passengerCondition)}>Change condition</Button>
              <Select value={passengerHold} onChange={(event) => setPassengerHold(event.target.value)} aria-label="New passenger hold">
                {(dictionaries.holdTypes ?? []).map((option) => <option key={option.key} value={option.label}>{option.label}</option>)}
              </Select>
              <Button variant="secondary" onClick={() => openPassengerDecision("passenger-hold", passengerHold)}>Change hold</Button>
            </div>
          ) : null}
          {canUpdate ? <Button variant="ghost" onClick={() => setSourceCorrectionMode((current) => !current)}>{sourceCorrectionMode ? "Cancel source correction" : "Correct source facts"}</Button> : null}
        </div>
      );
    }
    if (kind === "requests") {
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          {activeSessionWritable && can("request:assign") ? <Button icon={UserCheck} variant="secondary" onClick={() => runEditorAction("assign-to-me")}>Assign to me</Button> : null}
          {canUpdate ? <Button icon={PlayCircle} variant="secondary" onClick={() => runEditorAction("status", { status: "In progress" })}>In progress</Button> : null}
          {canUpdate ? <Button icon={Clock3} variant="warning" onClick={() => runEditorAction("status", { status: "Waiting" })}>Waiting</Button> : null}
          {(activeSessionWritable && can("request:close")) || canUpdate ? <Button icon={CheckCircle2} variant="success" onClick={openRequestCloseDecision}>Close</Button> : null}
          {canUpdate ? <Button icon={XCircle} variant="danger" onClick={() => runEditorAction("status", { status: "Cancelled" })}>Cancel</Button> : null}
        </div>
      );
    }
    return null;
  }

  function passengerPicker() {
    if (kind !== "enquiries") return null;
    const selectedPassenger = passengerOptions.find((passenger) => passenger.id === selectedPassengerId);
    return (
      <div className="grid gap-3 rounded-md border border-border bg-muted p-3 text-foreground">
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-bold text-foreground">Passenger from manifest / SRC</p>
            <p className="mt-0.5 text-xs font-semibold text-muted-foreground">Choose a known passenger to prefill this enquiry, or keep manual entry.</p>
          </div>
          <Badge tone={selectedPassenger ? "info" : "neutral"}>{selectedPassenger ? "Prefilled" : "Manual"}</Badge>
        </div>
        <Field label="Known passenger">
          <Select value={selectedPassengerId} readOnly={!canSaveCurrent} onChange={(event) => selectPassengerContext(event.target.value)}>
            <option value="">Manual entry</option>
            {passengerOptions.map((passenger) => (
              <option key={passenger.id} value={passenger.id}>
                {passengerLabel(passenger)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    );
  }

  return (
    <div className="grid items-start gap-5">
      <Card>
        <div className="border-b border-border px-4 py-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className="relative min-w-[220px] flex-1 2xl:max-w-[300px] 2xl:flex-none">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
              <Input
                aria-label="Search records"
                className="h-9 pl-9"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                }}
                placeholder="Search ID, case, name, actor"
              />
            </div>
            {filterColumn ? (
              <Select
                className="h-9 w-full sm:w-44"
                value={statusFilter}
                onChange={(event) => {
                  setStatusFilter(event.target.value);
                  setPage(1);
                }}
                aria-label={`Filter by ${filterColumn.label}`}
              >
                <option value="">All {filterColumn.label.toLowerCase()}</option>
                {statusOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
            ) : null}
            <Select
              className="h-9 w-full sm:w-32"
              value={pageSize}
              onChange={(event) => {
                setPageSize(Number(event.target.value));
                setPage(1);
              }}
              aria-label="Rows per page"
            >
              {pageSizeOptions.map((option) => (
                <option key={option} value={option}>
                  {option} rows
                </option>
              ))}
            </Select>
            <div className="flex h-9 w-full items-center justify-between gap-1 rounded-md border border-border bg-card px-1 text-sm text-foreground sm:w-auto sm:min-w-52">
              <Button icon={ChevronLeft} size="icon" variant="ghost" aria-label="Previous page" disabled={currentPage <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))} />
              <p className="whitespace-nowrap px-2 text-sm font-semibold text-foreground">
                {pageRangeStart} - {pageEndIndex} of {resultTotal}
              </p>
              <Button icon={ChevronRight} size="icon" variant="ghost" aria-label="Next page" disabled={currentPage >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))} />
            </div>
            {canCreate ? (
              <Button icon={FilePlus2} variant="create" onClick={startNewRecord}>
                {recordCopy.newLabel}
              </Button>
            ) : null}
          </div>
        </div>
        <div className="grid gap-3 p-4">
          {loading ? (
            <Loading />
          ) : error ? (
            <EmptyState title="Unable to load records" detail={error} action={<Button onClick={() => void load()}>Retry</Button>} />
          ) : (
            <>
              <Table
                columns={columns}
                rows={pagedRows}
                rowAction={rowActions}
                sortKey={sortKey}
                sortDirection={sortDirection}
                onSort={handleSort}
                emptyTitle={rows.length ? "No records match these filters" : "No records"}
                emptyDetail={rows.length ? "Clear search and status filters to review the full queue." : "Records created in this module will appear here."}
                emptyAction={rows.length ? <Button onClick={() => { setQuery(""); setStatusFilter(""); setPage(1); }}>Clear filters</Button> : canCreate ? <Button variant="create" onClick={startNewRecord}>{recordCopy.saveNew}</Button> : undefined}
                onRowOpen={openRecord}
                rowLabel={(row) => `Open ${row.operationalId ?? recordCopy.noun}`}
              />
              {totalPages > 1 ? (
                <div className="flex flex-col gap-2 rounded-md border border-border bg-card px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm font-semibold text-muted-foreground">
                    Showing {pageRangeStart}-{pageEndIndex} of {resultTotal}
                  </p>
                  <div className="flex items-center gap-2">
                    <Button icon={ChevronLeft} size="sm" variant="secondary" disabled={currentPage <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>
                      Previous
                    </Button>
                    <span className="min-w-24 rounded-md border border-border bg-muted px-3 py-1.5 text-center text-sm font-bold text-muted-foreground">
                      {currentPage} / {totalPages}
                    </span>
                    <Button icon={ChevronRight} size="sm" variant="secondary" disabled={currentPage >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>
                      Next
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
      </Card>

      {editorOpen ? (
        <DialogSurface
          title={editing.id ? `Edit ${recordCopy.noun}` : `New ${recordCopy.noun}`}
          description={editing.operationalId ?? activeSession?.operationalId ?? recordCopy.fallback}
          dirty={canSaveCurrent && Boolean(editorBaseline && JSON.stringify(editing) !== editorBaseline)}
          busy={saving}
          onClose={() => setEditorOpen(false)}
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-border bg-card text-foreground shadow-2xl"
        >
          {({ requestClose }) => (
          <>
            <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
              <div className="min-w-0">
                <h2 data-dialog-heading="true" tabIndex={-1} className="truncate text-lg font-black text-foreground">{editing.id ? `Edit ${recordCopy.noun}` : `New ${recordCopy.noun}`}</h2>
                <p className="mt-1 truncate text-sm text-muted-foreground">{editing.operationalId ?? activeSession?.operationalId ?? recordCopy.fallback}</p>
                <p className="mt-1 text-xs font-semibold leading-5 text-muted-foreground">{recordCopy.helper}</p>
              </div>
              <Button icon={XCircle} variant="ghost" disabled={saving} onClick={() => requestClose()}>
                Close
              </Button>
            </div>

            <div className="scrollbar-soft flex-1 overflow-y-auto px-5 py-4">
              <ErrorSummary title="Record could not be saved" errors={writeError ? [{ message: writeError, fieldId: Object.keys(fieldErrors)[0] ? `record-${Object.keys(fieldErrors)[0]}` : undefined }] : []} />
              <div className="mb-4 rounded-md border border-[#145C63]/25 bg-[#145C63]/10 p-3">
                <p className="text-sm font-black text-foreground">What to do next</p>
                <ol className="mt-2 grid gap-2">
                  {recordCopy.nextSteps.map((step, index) => (
                    <li key={step} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2 text-xs font-semibold leading-5 text-muted-foreground">
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-card text-[10px] font-black text-[#145C63]">{index + 1}</span>
                      <span>{step}</span>
                    </li>
                  ))}
                </ol>
              </div>

              <div className="mb-4 flex min-w-0 items-center justify-between gap-3 rounded-md border border-border bg-muted px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-black text-foreground">{editing.operationalId ?? recordCopy.fallback}</p>
                  <p className="mt-0.5 truncate text-xs font-semibold text-muted-foreground">{activeSession?.operationalId ?? "No active session"}</p>
                </div>
                <StatusBadge value={editing.status ?? editing.verificationStatus ?? editing.conditionStatus ?? "Draft"} />
              </div>

              {editing.id ? (
                <div className="mb-4 grid gap-2 rounded-md border border-border bg-card p-3 sm:grid-cols-2">
                  <div className="min-w-0">
                    <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Created</p>
                    <p className="mt-1 truncate text-sm font-bold text-foreground">{formatDateTime(editing.createdAt)}</p>
                    <p className="mt-0.5 truncate text-xs font-semibold text-muted-foreground">{actorLabel(editing.createdBy)}</p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Updated</p>
                    <p className="mt-1 truncate text-sm font-bold text-foreground">{formatDateTime(editing.updatedAt ?? editing.createdAt)}</p>
                    <p className="mt-0.5 truncate text-xs font-semibold text-muted-foreground">{actorLabel(editing.updatedBy ?? editing.createdBy)}</p>
                  </div>
                </div>
              ) : null}

              {editing.id && editorActions() ? (
                <div className="mb-4 rounded-md border border-border bg-card p-3">
                  {editorActions()}
                </div>
              ) : null}

              {!canSaveCurrent ? (
                <EmptyState
                  title="Read-only access"
                  detail={editing.id ? "This profile can review the selected record but cannot modify it." : "This profile cannot create records in this module."}
                />
              ) : null}

              {showRecordFields ? (
                <div className="grid gap-5">
                  {isPassengerPage && editing.id && sourceCorrectionMode ? (
                    <Field label="Source correction reason" error={sourceCorrectionReason.trim().length >= 3 ? undefined : "Enter at least 3 characters."}>
                      <Textarea value={sourceCorrectionReason} onChange={(event) => setSourceCorrectionReason(event.target.value)} placeholder="Why the source facts are being corrected" />
                    </Field>
                  ) : null}
                  <div className="grid gap-3">
                    <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Case</p>
                    <Field label="Case ID">
                      <Input readOnly={!canSaveCurrent || (isPassengerPage && sourceCorrectionMode)} value={editing.caseId ?? ""} onChange={(event) => setEditing((current) => ({ ...current, caseId: event.target.value }))} placeholder="CASE-2026-0001" />
                    </Field>
                  </div>
                  {fieldGroups.map((group) => (
                    <div key={group.title} className="grid gap-3">
                      <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">{group.title}</p>
                      {group.title === "Passenger / context" ? passengerPicker() : null}
                      {group.fields.map((field) => (
                        <Fragment key={field.name}>
                          <RecordField
                            field={field}
                            value={editing[field.name]}
                            readOnly={!canSaveCurrent || (isPassengerPage && Boolean(editing.id) && field.name !== "notes" && !sourceCorrectionMode) || (isPassengerPage && Boolean(editing.id) && field.name === "notes" && sourceCorrectionMode)}
                            controlledOptions={controlledOptionsByKind[kind]?.[field.name]}
                            error={fieldErrors[field.name]}
                            onChange={(value) => updateEditingField(field.name, value)}
                          />
                        </Fragment>
                      ))}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>

            {canSaveCurrent ? (
              <div className="border-t border-border bg-card p-4">
                <Button className="w-full" icon={Save} variant="primary" disabled={saving || (isPassengerPage && sourceCorrectionMode && sourceCorrectionReason.trim().length < 3)} aria-busy={saving} onClick={save}>
                  {saving ? "Saving record" : isPassengerPage && sourceCorrectionMode ? "Apply source correction" : editing.id ? "Save changes" : recordCopy.saveNew}
                </Button>
              </div>
            ) : null}
          </>
          )}
        </DialogSurface>
      ) : null}

      {pendingDecision ? (
        <DecisionDialog
          title={pendingDecision.action === "family-verify" ? "Verify Family/NOK" : pendingDecision.action === "request-close" ? "Close Request" : pendingDecision.action === "passenger-src" ? "Confirm SRC" : pendingDecision.action === "passenger-condition" ? "Change passenger condition" : "Change passenger hold"}
          description={
            pendingDecision.action === "family-verify"
              ? `${pendingDecision.record.operationalId ?? "This family record"} will be marked verified using the recorded identity and relationship basis. The decision is added to operational history.`
              : pendingDecision.action === "request-close" ? `${pendingDecision.record.operationalId ?? "This request"} will be closed and become a terminal workflow record. The closure is recorded in operational history.` : `${pendingDecision.record.operationalId ?? "This passenger record"} will be updated to ${pendingDecision.value ?? "SRC confirmed"}. The decision is versioned and added to operational history.`
          }
          label={pendingDecision.action === "family-verify" ? "Verification basis" : pendingDecision.action === "request-close" ? "Closure note" : pendingDecision.action === "passenger-hold" ? "Hold reason" : "Decision basis"}
          value={pendingDecision.note}
          onChange={(value) => setPendingDecision((current) => (current ? { ...current, note: value, error: "" } : current))}
          onCancel={() => setPendingDecision(null)}
          onConfirm={confirmDecision}
          confirmLabel={pendingDecision.action === "family-verify" ? "Verify" : pendingDecision.action === "request-close" ? "Close request" : "Apply decision"}
          confirmIcon={pendingDecision.action === "family-verify" ? UserCheck : CheckCircle2}
          confirmVariant="success"
          error={pendingDecision.error}
          busy={pendingDecision.saving}
          required={pendingDecision.action !== "passenger-src"}
          placeholder={pendingDecision.action === "family-verify" ? "Identity and relationship evidence reviewed" : pendingDecision.action === "request-close" ? "Reason for closing this request" : "Evidence or operational reason"}
        />
      ) : null}
    </div>
  );
}
