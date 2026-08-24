import type { Permission } from "@zpp/shared";

export const exportSchemaVersion = "stage17-v1";
export const exportFormat = "csv";
export const exportRowLimit = 20_000;
export const exportByteLimit = 20 * 1024 * 1024;
export const exportPageSize = 500;

export const exportDefinitions = {
  "enquiry-log": { section: "Enquiries", permission: "enquiry:read" },
  "family-register": { section: "FamilyRecords", permission: "family:read" },
  "passenger-register": { section: "PassengerRecords", permission: "passenger:read" },
  "matching-log": { section: "MatchingRecords", permission: "matching:read" },
  "requests-log": { section: "Requests", permission: "request:read" },
  "audit-log": { section: "AuditLog", permission: "audit:read" }
} as const satisfies Record<string, { section: string; permission: Permission }>;

export type DatasetExportType = keyof typeof exportDefinitions;
export type FoundationExportType = "session-package" | DatasetExportType;

export const supportedExportTypes: FoundationExportType[] = ["session-package", ...Object.keys(exportDefinitions) as DatasetExportType[]];

export function isDatasetExportType(value: string): value is DatasetExportType {
  return value in exportDefinitions;
}

export function isFoundationExportType(value: string): value is FoundationExportType {
  return value === "session-package" || isDatasetExportType(value);
}

export function generationPermissions(exportType: FoundationExportType): Permission[] {
  return ["export:create", "session:read", ...(isDatasetExportType(exportType) ? [exportDefinitions[exportType].permission] : ["audit:read"])] as Permission[];
}

export type ExportActor = {
  id: string;
  email: string;
  displayName: string;
  requestId?: string;
};

export type ExportFailureHooks = {
  beforeSourceQuery?: () => void | Promise<void>;
  duringSourcePaging?: (section: string, offset: number) => void | Promise<void>;
  beforeSerialization?: () => void | Promise<void>;
  beforeGenerationWrite?: () => void | Promise<void>;
  beforeAudit?: () => void | Promise<void>;
  afterAuditBeforeReturn?: () => void | Promise<void>;
};

export type ExportPreparationInput = {
  operationId: string;
  incidentId: string;
  exportType: FoundationExportType;
};

export type ExportAuthorizationContext = {
  id: string;
  incidentId: string;
  exportType: FoundationExportType;
};
