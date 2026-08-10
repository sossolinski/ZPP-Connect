export type TrainingDeliveryType = "Classroom" | "E-learning" | "Briefing" | "Exercise" | "Practical" | "Other";
export type TrainingRequirementTargetType = "Role" | "Group" | "MemberProfile";
export type TrainingRequirementStatus = "Required" | "Recommended";
export type TrainingBaseStatus = "Assigned" | "In Progress" | "Completed" | "Waived" | "Cancelled";
export type TrainingEffectiveStatus = TrainingBaseStatus | "Expired";

export type TrainingActor = {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
  permissions: string[];
  roleAssignments?: Array<{ roleName: string; scopeType: "GLOBAL" | "GROUP"; scopeId?: string | null; status: string; permissions?: string[] }>;
  requestId?: string;
};

export type TrainingMemberSummary = {
  id: string;
  memberId: string;
  volunteerId: string;
  linkedUserId?: string | null;
  displayName: string;
  pool: string;
  role: string;
  assignedFunction: string;
  status: string;
};

export type TrainingGroupSummary = {
  id: string;
  operationalId: string;
  incidentId: string;
  sessionId: string;
  name: string;
  pool: string;
  functionName: string;
  status: string;
  memberCount: number;
};

export type TrainingCourseRecord = {
  id: string;
  code: string;
  title: string;
  description: string;
  category: string;
  deliveryType: TrainingDeliveryType;
  validityMonths?: number | null;
  active: boolean;
  selfCompletable: boolean;
  externalRef?: string | null;
  version: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deactivatedAt?: Date | string | null;
  reactivatedAt?: Date | string | null;
};

export type TrainingRequirementRecord = {
  id: string;
  courseId: string;
  course: TrainingCourseRecord;
  targetType: TrainingRequirementTargetType;
  targetRole?: string | null;
  groupId?: string | null;
  memberProfileId?: string | null;
  target: { type: TrainingRequirementTargetType; label: string; group?: TrainingGroupSummary; member?: TrainingMemberSummary };
  requiredStatus: TrainingRequirementStatus;
  dueAt?: Date | string | null;
  effectiveFrom?: Date | string | null;
  effectiveTo?: Date | string | null;
  active: boolean;
  resolvedMemberCount: number;
  version: number;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type TrainingRecordPermissions = { canStart: boolean; canComplete: boolean; canVerify: boolean; canWaive: boolean; canCancel: boolean; canEdit: boolean };

export type MemberTrainingRecord = {
  id: string;
  operationalId: string;
  memberProfileId: string;
  member: TrainingMemberSummary;
  courseId: string;
  course: TrainingCourseRecord;
  sourceRequirementId?: string | null;
  sourceRequirement?: { id: string; targetType: TrainingRequirementTargetType; targetLabel: string; requiredStatus: TrainingRequirementStatus } | null;
  assignedAt: Date | string;
  assignedById?: string | null;
  dueAt?: Date | string | null;
  status: TrainingEffectiveStatus;
  baseStatus: TrainingBaseStatus;
  isOverdue: boolean;
  isExpiringSoon: boolean;
  startedAt?: Date | string | null;
  startedById?: string | null;
  completedAt?: Date | string | null;
  completedById?: string | null;
  expiryAt?: Date | string | null;
  score?: number | null;
  completionNote?: string | null;
  completionRef?: string | null;
  verifiedById?: string | null;
  verifiedBy?: { id: string; email: string; displayName: string } | null;
  verifiedAt?: Date | string | null;
  verificationStatus: "Pending" | "Verified" | "Not applicable";
  waivedAt?: Date | string | null;
  waivedById?: string | null;
  waiverReason?: string | null;
  cancelledAt?: Date | string | null;
  cancelledById?: string | null;
  cancelledReason?: string | null;
  version: number;
  permissions?: TrainingRecordPermissions;
  idempotent?: boolean;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type Page<T> = { total: number; limit: number; offset: number; data: T[] };
export type TrainingTotals = { assigned: number; inProgress: number; completed: number; expired: number; waived: number; cancelled: number; overdue: number; expiringSoon: number };
export type TrainingAccess = { global: boolean; groupIds: string[]; ownMemberProfileId?: string | null };

export type CourseQuery = { search?: string; category?: string; active?: boolean; limit: number; offset: number };
export type RequirementQuery = { search?: string; courseId?: string; targetType?: TrainingRequirementTargetType; target?: string; active?: boolean; requiredStatus?: TrainingRequirementStatus; limit: number; offset: number };
export type RecordQuery = { search?: string; memberProfileId?: string; groupId?: string; courseId?: string; category?: string; status?: TrainingEffectiveStatus; overdue?: boolean; expiringWithin?: number; mine?: boolean; sort: "due" | "member" | "course" | "status" | "updatedAt"; direction: "asc" | "desc"; limit: number; offset: number };

export type CreateCourseInput = { code: string; title: string; description?: string | null; category: string; deliveryType: TrainingDeliveryType; validityMonths?: number | null; selfCompletable: boolean; externalRef?: string | null };
export type UpdateCourseInput = Partial<CreateCourseInput>;
export type CreateRequirementInput = { courseId: string; targetType: TrainingRequirementTargetType; targetRole?: string | null; groupId?: string | null; memberProfileId?: string | null; requiredStatus: TrainingRequirementStatus; dueAt?: Date | null; effectiveFrom?: Date | null };
export type UpdateRequirementInput = Partial<CreateRequirementInput>;
export type AssignTrainingInput = { memberProfileId?: string | null; groupId?: string | null; courseId: string; sourceRequirementId?: string | null; assignedAt?: Date | null; dueAt?: Date | null; operationId: string };
export type AssignTrainingResult = MemberTrainingRecord | { targetType: "Group"; group: TrainingGroupSummary; course: TrainingCourseRecord; assignedCount: number; skippedCount: number; records: MemberTrainingRecord[]; idempotent?: boolean };
export type UpdateTrainingRecordInput = { dueAt?: Date | null; completionNote?: string | null };
export type TrainingCommandInput = { expectedVersion: number; operationId: string; completedAt?: Date; score?: number | null; completionNote?: string | null; completionRef?: string | null; verifiedAt?: Date; reason?: string };

export type TrainingCompliance = {
  memberProfileId: string;
  member: TrainingMemberSummary;
  evaluationAt: string;
  expiringSoonDays: number;
  status: "Compliant" | "Attention" | "Non-compliant" | "Not applicable";
  totals: { required: number; recommended: number; compliant: number; attention: number; nonCompliant: number };
  items: Array<Record<string, any>>;
};
