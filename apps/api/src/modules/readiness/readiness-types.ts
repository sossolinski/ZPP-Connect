import type { Permission } from "@zpp/shared";

export type ReadinessSeverity = "blocker" | "warning" | "info";
export type ReadinessOverallStatus = "Ready" | "Ready with attention" | "Not ready" | "Unknown" | "Not applicable";
export type ReadinessDimensionStatus = "Compliant" | "Attention" | "Non-compliant" | "Unknown" | "Not applicable";

export type ReadinessPolicy = {
  id: string;
  version: number;
  expiringSoonDays: number;
  rosterLookaheadDays: number;
  availabilityLookaheadDays: number;
  availabilityTimezone: "UTC";
  evaluationMode: "current-topology";
};

export type ReadinessActor = {
  id: string;
  email: string;
  displayName: string;
  requestId?: string;
};

export type ReadinessMember = {
  id: string;
  memberId: string;
  displayName: string;
  pool: string;
  role: string;
  assignedFunction: string;
  status: string;
};

export type ReadinessGroup = {
  id: string;
  operationalId: string;
  name: string;
  pool: string;
  functionName: string;
  status: string;
  memberCount: number;
};

export type ReadinessFactor = {
  code: string;
  category: string;
  severity: ReadinessSeverity;
  title: string;
  detail: string;
  source: { type: string; id: string | null };
  dueAt: string | null;
  action: { label: string; href: string } | null;
};

export type ReadinessDimension = {
  key: string;
  label: string;
  status: ReadinessDimensionStatus;
  state: string;
  detail: string;
  source: { type: string; id: string | null };
  factors: ReadinessFactor[];
  items: unknown[];
};

export type TrainingSnapshotItem = {
  courseId: string;
  title: string;
  requiredStatus: "Required" | "Recommended";
  status: "Compliant" | "Attention" | "Non-compliant";
  recordStatus: string | null;
  dueAt: Date | null;
  expiryAt: Date | null;
  expiringSoon: boolean;
};

export type DocumentSnapshotItem = {
  documentVersionId: string;
  title: string;
  status: "Acknowledged" | "Awareness" | "Overdue" | "Required";
  acknowledgementRequired: boolean;
  contentAvailable: boolean;
  dueAt: Date | null;
  acknowledgedAt: Date | null;
};

export type AvailabilitySnapshotItem = {
  id: string;
  operationalId: string;
  type: string;
  startAt: Date;
  endAt: Date;
};

export type RosterSnapshotItem = {
  id: string;
  operationalId: string;
  title: string;
  duty: string;
  functionName: string;
  startAt: Date;
  endAt: Date;
  location: string;
  status: string;
};

export type ReadinessMemberSnapshot = {
  member: ReadinessMember;
  groups: ReadinessGroup[];
  training: TrainingSnapshotItem[];
  documents: DocumentSnapshotItem[];
  availability: AvailabilitySnapshotItem[];
  roster: RosterSnapshotItem[];
};

export type ReadinessAssessment = {
  member: ReadinessMember | null;
  calculatedAt: string;
  evaluationMode: ReadinessPolicy["evaluationMode"];
  overallStatus: ReadinessOverallStatus;
  dimensions: ReadinessDimension[];
  blockers: ReadinessFactor[];
  warnings: ReadinessFactor[];
  information: ReadinessFactor[];
  nextActions: Array<{ label: string; href: string; reason: string; severity: ReadinessSeverity }>;
  policy: ReadinessPolicy;
};

export type ReadinessMemberRow = {
  member: ReadinessMember;
  overallStatus: ReadinessOverallStatus;
  blockerCount: number;
  warningCount: number;
  primaryIssue: ReadinessFactor | null;
  calculatedAt: string;
  evaluationMode: ReadinessPolicy["evaluationMode"];
  policy: Pick<ReadinessPolicy, "id" | "version">;
};

export type ReadinessSummary = {
  calculatedAt: string;
  evaluationMode: ReadinessPolicy["evaluationMode"];
  totalMembers: number;
  byStatus: Record<ReadinessOverallStatus, number>;
  issueCounts: Record<string, number>;
  needsAction: number;
  blocked: number;
  attention: number;
  ready: number;
  policy: ReadinessPolicy;
};

export type ReadinessAccess = {
  permissions: Set<Permission>;
  globalPermissions: Set<Permission>;
  groupPermissions: Map<Permission, Set<string>>;
  linkedMemberProfileId: string | null;
  ownActiveGroupIds: Set<string>;
};

export type ReadinessPageQuery = {
  limit: number;
  offset: number;
  search?: string;
  status?: ReadinessOverallStatus;
  groupId?: string;
  memberProfileIds?: string[];
  evaluationAt?: Date;
};

export type ReadinessGroupQuery = {
  limit: number;
  offset: number;
  search?: string;
  groupIds?: string[];
  evaluationAt?: Date;
  optionsOnly?: boolean;
};
