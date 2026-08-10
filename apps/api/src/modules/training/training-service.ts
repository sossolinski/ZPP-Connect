import { HttpError } from "../../errors.js";
import { permissionScope } from "../../scope-policy.js";
import type { DirectoryActor as LegacyDirectoryActor } from "../../member-directory.js";
import type { IncidentAccessService } from "../incident-access/incident-access-service.js";
import type { FoundationTrainingRepository, MutationResult } from "./training-repository.js";
import type {
  AssignTrainingInput,
  CourseQuery,
  CreateCourseInput,
  CreateRequirementInput,
  MemberTrainingRecord,
  RecordQuery,
  RequirementQuery,
  TrainingAccess,
  TrainingActor,
  TrainingCommandInput,
  TrainingRecordPermissions,
  UpdateCourseInput,
  UpdateRequirementInput,
  UpdateTrainingRecordInput,
} from "./training-types.js";

type Clock = { now(): Date };
const defaultClock: Clock = { now: () => new Date() };

function scope(actor: TrainingActor, permission: string) {
  return permissionScope(actor as LegacyDirectoryActor, permission);
}

function access(actor: TrainingActor, permission: string, ownMemberProfileId?: string | null): TrainingAccess {
  const value = scope(actor, permission);
  return { global: value.allowed && value.global, groupIds: value.allowed ? [...value.groupIds] : [], ownMemberProfileId };
}

function resolved<T>(result: MutationResult<T>, missing: string, conflict: Record<string, string>, fallback: string) {
  if (result.conflict) throw new HttpError(409, conflict[result.reason ?? ""] ?? fallback);
  if (!result.record) throw new HttpError(404, missing);
  return result.idempotent ? { ...(result.record as any), idempotent: true } as T : result.record;
}

export function createTrainingService(repository: FoundationTrainingRepository, incidentAccess: IncidentAccessService, clock: Clock = defaultClock) {
  async function linkedMember(actor: TrainingActor) { return repository.resolveMemberForUser(actor); }

  async function readAccess(actor: TrainingActor, mine = false) {
    const member = await linkedMember(actor);
    const all = scope(actor, "training:read-all");
    const own = actor.permissions.includes("training:read-own") ? member?.id ?? null : null;
    if ((!all.allowed || mine) && !own) throw new HttpError(403, "Forbidden");
    return { member, access: { global: !mine && all.allowed && all.global, groupIds: !mine && all.allowed ? [...all.groupIds] : [], ownMemberProfileId: own } satisfies TrainingAccess };
  }

  async function authorizeGroup(actor: TrainingActor, groupId: string, permission: string, writable = false) {
    const group = await repository.getGroup(groupId);
    if (!group) throw new HttpError(404, "Operational group not found");
    const permissionValue = scope(actor, permission);
    if (!permissionValue.allowed || (!permissionValue.global && !permissionValue.groupIds.has(groupId))) throw new HttpError(403, "Forbidden");
    const context = await incidentAccess.authorize(actor, group.incidentId);
    if (writable && !context.writable) throw new HttpError(409, "Training changes are not allowed in a closed incident");
    if (group.status === "Archived" && writable) throw new HttpError(409, "Archived groups cannot receive training changes");
    return group;
  }

  async function authorizeMember(actor: TrainingActor, memberProfileId: string, permission: string) {
    const targetAccess = access(actor, permission);
    if (!targetAccess.global && !targetAccess.groupIds.length) throw new HttpError(403, "Forbidden");
    if (!await repository.memberAccessible(memberProfileId, targetAccess)) throw new HttpError(403, "Forbidden");
  }

  function permissions(record: MemberTrainingRecord, actor: TrainingActor, ownMemberId?: string | null): TrainingRecordPermissions {
    const own = ownMemberId === record.memberProfileId;
    const active = record.baseStatus === "Assigned" || record.baseStatus === "In Progress";
    return {
      canStart: record.baseStatus === "Assigned" && (scope(actor, "training:complete-all").allowed || (own && actor.permissions.includes("training:complete-own"))),
      canComplete: active && (scope(actor, "training:complete-all").allowed || (own && actor.permissions.includes("training:complete-own") && record.course.selfCompletable)),
      canVerify: record.baseStatus === "Completed" && !record.verifiedAt && scope(actor, "training:verify").allowed,
      canWaive: active && scope(actor, "training:waive").allowed,
      canCancel: active && scope(actor, "training:assign").allowed,
      canEdit: active && (scope(actor, "training:assign").allowed || scope(actor, "training:complete-all").allowed),
    };
  }

  async function actionableRecord(actor: TrainingActor, id: string, permission: string, ownPermission?: string) {
    const own = await linkedMember(actor);
    const actionAccess = access(actor, permission, ownPermission && actor.permissions.includes(ownPermission) ? own?.id : null);
    const record = await repository.getRecord(id, actionAccess, actor, clock.now());
    if (!record) throw new HttpError(404, "Training record not found");
    return { record, own };
  }

  const courseConflicts = { "duplicate-code": "A training course with this code already exists", stale: "This course changed. Refresh and try again", "active-requirements": "End active requirements before deactivating this course" };
  const requirementConflicts = { "duplicate-requirement": "An active requirement already exists for this target and course", stale: "This requirement changed. Refresh and try again", "inactive-course": "Inactive courses cannot receive requirements", "inactive-target": "Archived targets cannot receive requirements", "unsupported-role": "This role target is not supported", "invalid-date": "Effective end must be after effective start" };
  const recordConflicts = { stale: "This training record changed. Refresh and compare before trying again", "operation-misuse": "This operationId was already used for a different command, target or payload", "inactive-course": "Inactive courses cannot receive new assignments", "inactive-target": "Archived targets cannot receive new assignments", "invalid-requirement": "The source requirement is no longer effective for this assignment", "requirement-target-mismatch": "The source requirement does not apply to every selected member", "active-duplicate": "This member already has active training for this course", "empty-target": "This group has no eligible active members", "invalid-transition": "This action is not valid for the current training state", "already-verified": "This completion was already verified and cannot be overwritten", "concurrent-conflict": "Training changed concurrently. Refresh and try again" };

  return {
    kind: repository.kind,
    now: () => clock.now(),

    async listCourses(actor: TrainingActor, query: CourseQuery) { const { access: read } = await readAccess(actor); return repository.listCourses(query, read); },
    async getCourse(actor: TrainingActor, id: string) { const { access: read } = await readAccess(actor); const record = await repository.getCourse(id, read); if (!record) throw new HttpError(404, "Training course not found"); return record; },
    async createCourse(actor: TrainingActor, input: CreateCourseInput) { if (!actor.permissions.includes("training:course:manage")) throw new HttpError(403, "Forbidden"); return resolved(await repository.createCourse(input, actor), "Training course not found", courseConflicts, "Course could not be created"); },
    async updateCourse(actor: TrainingActor, id: string, input: UpdateCourseInput, expectedVersion: number) { if (!actor.permissions.includes("training:course:manage")) throw new HttpError(403, "Forbidden"); return resolved(await repository.updateCourse(id, input, expectedVersion, actor), "Training course not found", courseConflicts, "Course could not be updated"); },
    async setCourseActive(actor: TrainingActor, id: string, active: boolean, expectedVersion: number) { if (!actor.permissions.includes("training:course:manage")) throw new HttpError(403, "Forbidden"); return resolved(await repository.setCourseActive(id, active, expectedVersion, actor), "Training course not found", courseConflicts, "Course lifecycle changed concurrently"); },

    async listRequirements(actor: TrainingActor, query: RequirementQuery) {
      const permission = actor.permissions.includes("training:read-all") ? "training:read-all" : "training:requirement:manage";
      const targetAccess = access(actor, permission);
      if (!scope(actor, permission).allowed) throw new HttpError(403, "Forbidden");
      return repository.listRequirements(query, targetAccess, clock.now());
    },
    async getRequirement(actor: TrainingActor, id: string) {
      const permission = actor.permissions.includes("training:read-all") ? "training:read-all" : "training:requirement:manage";
      const record = await repository.getRequirement(id, access(actor, permission), clock.now());
      if (!record) throw new HttpError(404, "Training requirement not found");
      if (record.groupId) await authorizeGroup(actor, record.groupId, permission);
      return record;
    },
    async createRequirement(actor: TrainingActor, input: CreateRequirementInput) {
      if (!scope(actor, "training:requirement:manage").allowed) throw new HttpError(403, "Forbidden");
      let incidentId: string | null = null;
      if (input.targetType === "Role" && !scope(actor, "training:requirement:manage").global) throw new HttpError(403, "Role-wide requirements require global access");
      if (input.groupId) incidentId = (await authorizeGroup(actor, input.groupId, "training:requirement:manage", true)).incidentId;
      if (input.memberProfileId) await authorizeMember(actor, input.memberProfileId, "training:requirement:manage");
      return resolved(await repository.createRequirement(input, actor, incidentId), "Training requirement not found", requirementConflicts, "Requirement could not be created");
    },
    async updateRequirement(actor: TrainingActor, id: string, input: UpdateRequirementInput, expectedVersion: number) {
      const current = await this.getRequirement(actor, id);
      let incidentId: string | null = null;
      const targetType = input.targetType ?? current.targetType;
      const groupId = targetType === "Group" ? input.groupId ?? current.groupId : null;
      const memberId = targetType === "MemberProfile" ? input.memberProfileId ?? current.memberProfileId : null;
      if (targetType === "Role" && !scope(actor, "training:requirement:manage").global) throw new HttpError(403, "Role-wide requirements require global access");
      if (groupId) incidentId = (await authorizeGroup(actor, groupId, "training:requirement:manage", true)).incidentId;
      if (memberId) await authorizeMember(actor, memberId, "training:requirement:manage");
      return resolved(await repository.updateRequirement(id, input, expectedVersion, actor, incidentId), "Training requirement not found", requirementConflicts, "Requirement could not be updated");
    },
    async endRequirement(actor: TrainingActor, id: string, expectedVersion: number, effectiveTo?: Date) {
      const current = await this.getRequirement(actor, id);
      const incidentId = current.groupId ? (await authorizeGroup(actor, current.groupId, "training:requirement:manage", true)).incidentId : null;
      return resolved(await repository.endRequirement(id, expectedVersion, effectiveTo ?? clock.now(), actor, incidentId), "Training requirement not found", requirementConflicts, "Requirement could not be ended");
    },

    async listRecords(actor: TrainingActor, query: RecordQuery) {
      const { member, access: read } = await readAccess(actor, Boolean(query.mine));
      if (query.groupId) await authorizeGroup(actor, query.groupId, "training:read-all");
      const result = await repository.listRecords(query, read, actor, clock.now());
      return { ...result, linkedMemberProfile: member, data: result.data.map((record) => ({ ...record, permissions: permissions(record, actor, member?.id) })) };
    },
    async getRecord(actor: TrainingActor, id: string) {
      const { member, access: read } = await readAccess(actor);
      const record = await repository.getRecord(id, read, actor, clock.now());
      if (!record) throw new HttpError(404, "Training record not found");
      return { ...record, permissions: permissions(record, actor, member?.id) };
    },
    async assign(actor: TrainingActor, input: AssignTrainingInput) {
      if (!scope(actor, "training:assign").allowed) throw new HttpError(403, "Forbidden");
      let incidentId: string | null = null;
      if (input.groupId) incidentId = (await authorizeGroup(actor, input.groupId, "training:assign", true)).incidentId;
      if (input.memberProfileId) await authorizeMember(actor, input.memberProfileId, "training:assign");
      return resolved(await repository.assign(input, actor, incidentId), "Training target not found", recordConflicts, "Training assignment conflicted");
    },
    async updateRecord(actor: TrainingActor, id: string, input: UpdateTrainingRecordInput, expectedVersion: number) {
      const permission = scope(actor, "training:assign").allowed ? "training:assign" : "training:complete-all";
      await actionableRecord(actor, id, permission);
      return resolved(await repository.updateRecord(id, input, expectedVersion, actor), "Training record not found", recordConflicts, "Training record could not be updated");
    },
    async command(actor: TrainingActor, id: string, command: "start" | "complete" | "verify" | "waive" | "cancel", input: TrainingCommandInput) {
      const permission = command === "verify" ? "training:verify" : command === "waive" ? "training:waive" : command === "cancel" ? "training:assign" : "training:complete-all";
      const ownPermission = command === "start" || command === "complete" ? "training:complete-own" : undefined;
      const { record, own } = await actionableRecord(actor, id, permission, ownPermission);
      const isOwn = own?.id === record.memberProfileId;
      if (command === "complete" && isOwn && !scope(actor, "training:complete-all").allowed && !record.course.selfCompletable) throw new HttpError(403, "This course cannot be self-completed");
      const updated = resolved(await repository.command(id, command, input, actor), "Training record not found", recordConflicts, "Training command conflicted");
      return { ...updated, permissions: permissions(updated, actor, own?.id) };
    },
    async evaluateMemberCompliance(actor: TrainingActor, memberProfileId: string, options?: { evaluationAt?: string | Date; expiringSoonDays?: number }) {
      const member = await linkedMember(actor);
      const read = access(actor, "training:read-all", actor.permissions.includes("training:read-own") ? member?.id : null);
      if (!await repository.memberAccessible(memberProfileId, read)) throw new HttpError(403, "Forbidden");
      const evaluationAt = options?.evaluationAt instanceof Date ? options.evaluationAt : options?.evaluationAt ? new Date(options.evaluationAt) : clock.now();
      const result = await repository.evaluateMemberCompliance(memberProfileId, actor, evaluationAt, Math.max(1, Math.trunc(options?.expiringSoonDays ?? 45)));
      if (!result) throw new HttpError(404, "Member profile not found");
      return result;
    },
  };
}

export type TrainingService = ReturnType<typeof createTrainingService>;
