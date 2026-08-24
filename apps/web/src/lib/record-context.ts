import type { AnyRecord } from "./types";
import { labelFromKey } from "./format";

export type HistoryCategory =
  | "Manual note"
  | "Workflow decision"
  | "State transition"
  | "System event"
  | "Import / export"
  | "Assignment activity"
  | "Operational event";

export const manualTimelineCategories = [
  { value: "note", label: "General note" },
  { value: "contact_attempt", label: "Contact attempt" },
  { value: "information_received", label: "Information received" },
  { value: "operational_update", label: "Operational update" },
  { value: "handover_note", label: "Handover note" }
] as const;

const manualEventTypes = new Set<string>(manualTimelineCategories.map((item) => item.value));
const workflowDecisionActions = new Set([
  "close_session",
  "close_request",
  "verify_family_record",
  "mark_family_disputed",
  "mark_src_confirmed",
  "verify_match",
  "reject_match",
  "hold_escalate",
  "clear_hold",
  "reunite",
  "release",
  "cancel_release"
]);
const stateTransitionActions = new Set([
  "send_enquiry_to_family_assistance",
  "mark_urgent",
  "mark_duplicate",
  "update_request_status",
  "update_assignment_status",
  "close_assignment",
  "cancel_assignment"
]);
const assignmentActions = new Set([
  "create_assignment",
  "update_assignment",
  "assign_assignment",
  "claim_assignment",
  "reassign_assignment"
]);
const systemActions = new Set(["login", "system", "system_event"]);
const importExportActions = new Set(["import", "export", "export_prepared", "validate_import"]);

const timelineDecisionTitles = new Set([
  "family/nok verification completed",
  "match verified",
  "match rejected",
  "hold cleared",
  "reunification completed",
  "release completed"
]);
const timelineDecisionTypes = new Set(["verification", "hold", "release", "reunification"]);
const timelineStateTypes = new Set(["session", "urgent_welfare"]);

function normalized(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function shortValue(value: unknown) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function historyCategoryForTimeline(row: AnyRecord): HistoryCategory {
  const eventType = normalized(row.eventType);
  const title = normalized(row.title);
  if (manualEventTypes.has(eventType)) return "Manual note";
  if (eventType === "assignment") {
    const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata as AnyRecord : {};
    if (metadata.oldState !== undefined && metadata.newState !== undefined && normalized(metadata.oldState) !== normalized(metadata.newState)) return "State transition";
    return "Assignment activity";
  }
  if (eventType === "import" || eventType === "export") return "Import / export";
  if (eventType === "system") return "System event";
  if (timelineDecisionTypes.has(eventType) || timelineDecisionTitles.has(title)) return "Workflow decision";
  if (timelineStateTypes.has(eventType)) return "State transition";
  return "Operational event";
}

export function historyCategoryForAudit(row: AnyRecord): HistoryCategory {
  const action = normalized(row.action);
  if (action === "create_timeline_event") return "Manual note";
  if (workflowDecisionActions.has(action)) return "Workflow decision";
  if (stateTransitionActions.has(action)) return "State transition";
  if (assignmentActions.has(action)) return "Assignment activity";
  if (importExportActions.has(action)) return "Import / export";
  if (systemActions.has(action)) return "System event";
  return "Operational event";
}

export function isDecisionTimelineEvent(row: AnyRecord) {
  return historyCategoryForTimeline(row) === "Workflow decision";
}

export function isDecisionAuditLog(row: AnyRecord) {
  return historyCategoryForAudit(row) === "Workflow decision";
}

export function workflowCategoryForRecord(kind: "timeline" | "audit", row: AnyRecord) {
  const category = kind === "timeline" ? historyCategoryForTimeline(row) : historyCategoryForAudit(row);
  if (category === "Manual note") return "Timeline note endpoint";
  if (category === "Assignment activity") return "Assignment workflow";
  if (category === "Import / export") return "File transfer workflow";
  if (category === "System event") return "System";
  const entity = normalized(row.entityType);
  const labels: Record<string, string> = {
    session: "Session workflow",
    enquiry: "TEC enquiry workflow",
    familyrecord: "Family/NOK workflow",
    passengerrecord: "Passenger/SRC workflow",
    matchingrecord: "Matching workflow",
    reunificationreleaserecord: "Release workflow",
    request: "Request workflow",
    assignmenttask: "Assignment workflow"
  };
  return labels[entity] ?? "Operational workflow";
}

export function sourcePathForEntity(entityType?: string | null, entityId?: string | null) {
  if (!entityType || !entityId) return "";
  const encoded = encodeURIComponent(entityId);
  const paths: Record<string, string> = {
    enquiry: `/tec-intake?focus=${encoded}`,
    familyRecord: `/family-nok?focus=${encoded}`,
    passengerRecord: `/passenger-src?focus=${encoded}`,
    matchingRecord: `/matching?match=${encoded}`,
    request: `/requests?focus=${encoded}`,
    session: `/sessions?focus=${encoded}`,
    reunificationReleaseRecord: `/release-control?focus=${encoded}`,
    assignmentTask: `/assignments?focus=${encoded}`
  };
  return paths[entityType] ?? "";
}

export function sourcePermissionForEntity(entityType?: string | null) {
  const permissions: Record<string, string> = {
    enquiry: "enquiry:read",
    familyRecord: "family:read",
    passengerRecord: "passenger:read",
    matchingRecord: "matching:read",
    request: "request:read",
    session: "session:read",
    reunificationReleaseRecord: "release:read",
    assignmentTask: "assignment:read"
  };
  return entityType ? permissions[entityType] ?? "" : "";
}

export function accessibleSourcePath(can: (permission: string) => boolean, entityType?: string | null, entityId?: string | null) {
  const path = sourcePathForEntity(entityType, entityId);
  const permission = sourcePermissionForEntity(entityType);
  return path && permission && can(permission) ? path : "";
}

export function metadataEntries(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  return Object.entries(metadata as AnyRecord).filter(([, value]) => value !== undefined && value !== null && value !== "");
}

export function metadataSummary(metadata: unknown) {
  const entries = metadataEntries(metadata);
  const preferred = ["reason", "closureNote", "basis", "decisionNotes", "status", "oldState", "newState", "previousAssignee", "newAssignee", "holdCheck", "overrideReason", "matchBasis"];
  const preferredEntries = preferred.flatMap((key) => {
    const found = entries.find(([entryKey]) => entryKey === key);
    return found ? [found] : [];
  });
  const selected = preferredEntries.length ? preferredEntries : entries.slice(0, 4);
  return selected
    .map(([key, value]) => {
      const renderedValue = shortValue(value);
      return renderedValue ? `${labelFromKey(key)}: ${renderedValue}` : "";
    })
    .filter(Boolean)
    .join(" | ");
}

export function displayHistoryValue(value: unknown) {
  return shortValue(value) || "Not recorded";
}
