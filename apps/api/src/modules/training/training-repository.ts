import type {
  AssignTrainingInput,
  AssignTrainingResult,
  CourseQuery,
  CreateCourseInput,
  CreateRequirementInput,
  MemberTrainingRecord,
  Page,
  RecordQuery,
  RequirementQuery,
  TrainingAccess,
  TrainingActor,
  TrainingCommandInput,
  TrainingCompliance,
  TrainingCourseRecord,
  TrainingGroupSummary,
  TrainingMemberSummary,
  TrainingRequirementRecord,
  TrainingTotals,
  UpdateCourseInput,
  UpdateRequirementInput,
  UpdateTrainingRecordInput,
} from "./training-types.js";

export type MutationResult<T> = { record: T | null; conflict: boolean; reason?: string; idempotent?: boolean };

export interface FoundationTrainingRepository {
  readonly kind: "postgres";
  resolveMemberForUser(actor: TrainingActor): Promise<TrainingMemberSummary | null>;
  memberAccessible(memberProfileId: string, access: TrainingAccess): Promise<boolean>;
  getGroup(groupId: string): Promise<TrainingGroupSummary | null>;
  listCourses(query: CourseQuery, access: TrainingAccess): Promise<Page<TrainingCourseRecord>>;
  getCourse(id: string, access: TrainingAccess): Promise<TrainingCourseRecord | null>;
  createCourse(input: CreateCourseInput, actor: TrainingActor): Promise<MutationResult<TrainingCourseRecord>>;
  updateCourse(id: string, input: UpdateCourseInput, expectedVersion: number, actor: TrainingActor): Promise<MutationResult<TrainingCourseRecord>>;
  setCourseActive(id: string, active: boolean, expectedVersion: number, actor: TrainingActor): Promise<MutationResult<TrainingCourseRecord>>;
  listRequirements(query: RequirementQuery, access: TrainingAccess, now: Date): Promise<Page<TrainingRequirementRecord>>;
  getRequirement(id: string, access: TrainingAccess, now: Date): Promise<TrainingRequirementRecord | null>;
  createRequirement(input: CreateRequirementInput, actor: TrainingActor, incidentId?: string | null): Promise<MutationResult<TrainingRequirementRecord>>;
  updateRequirement(id: string, input: UpdateRequirementInput, expectedVersion: number, actor: TrainingActor, incidentId?: string | null): Promise<MutationResult<TrainingRequirementRecord>>;
  endRequirement(id: string, expectedVersion: number, effectiveTo: Date, actor: TrainingActor, incidentId?: string | null): Promise<MutationResult<TrainingRequirementRecord>>;
  listRecords(query: RecordQuery, access: TrainingAccess, actor: TrainingActor, now: Date): Promise<Page<MemberTrainingRecord> & { totals: TrainingTotals }>;
  getRecord(id: string, access: TrainingAccess, actor: TrainingActor, now: Date): Promise<MemberTrainingRecord | null>;
  assign(input: AssignTrainingInput, actor: TrainingActor, incidentId?: string | null): Promise<MutationResult<AssignTrainingResult>>;
  updateRecord(id: string, input: UpdateTrainingRecordInput, expectedVersion: number, actor: TrainingActor): Promise<MutationResult<MemberTrainingRecord>>;
  command(id: string, command: "start" | "complete" | "verify" | "waive" | "cancel", input: TrainingCommandInput, actor: TrainingActor): Promise<MutationResult<MemberTrainingRecord>>;
  evaluateMemberCompliance(memberProfileId: string, actor: TrainingActor, evaluationAt: Date, expiringSoonDays: number): Promise<TrainingCompliance | null>;
  memberTrainingStatus(memberProfileId: string, evaluationAt: Date): Promise<string>;
}
