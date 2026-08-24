export type FoundationImportType = "manifest" | "family";
export type ImportValidationStatus = "VALID" | "INVALID";

export type ImportActor = {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
  requestId?: string;
};

export type ImportValidationInput = {
  operationId: string;
  incidentId: string;
  importType: FoundationImportType;
  sourceFilename: string;
  sourceMimeType: string;
  sourceSizeBytes: number;
  sourceSha256: string;
  rows: Array<Record<string, unknown>>;
};

export type ImportFailureHooks = {
  duringValidatedRowWrite?: (context: { batchId: string; writtenRows: number; totalRows: number }) => void | Promise<void>;
  beforeValidationAudit?: (context: { batchId: string }) => void | Promise<void>;
  beforeConfirmationTargetWrite?: (context: { batchId: string; importType: FoundationImportType }) => void | Promise<void>;
  duringConfirmationTargetWrite?: (context: { batchId: string; importType: FoundationImportType }) => void | Promise<void>;
  beforeConfirmationAudit?: (context: { batchId: string; importType: FoundationImportType }) => void | Promise<void>;
  beforeConfirmationTimeline?: (context: { batchId: string; importType: FoundationImportType }) => void | Promise<void>;
};

export type ImportAuthorizationContext = {
  id: string;
  incidentId: string;
  importType: FoundationImportType;
  status: string;
};
