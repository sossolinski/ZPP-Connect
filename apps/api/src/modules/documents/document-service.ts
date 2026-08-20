import { HttpError } from "../../errors.js";
import { permissionScope } from "../../scope-policy.js";
import type { DirectoryActor as LegacyDirectoryActor } from "../../member-directory.js";
import type { IncidentAccessService } from "../incident-access/incident-access-service.js";
import type { FoundationDocumentRepository, MutationResult } from "./document-repository.js";
import type {
  AcknowledgementQuery,
  AcknowledgeInput,
  CreateDocumentInput,
  CreateRequirementInput,
  CreateVersionInput,
  DocumentAccess,
  DocumentActor,
  DocumentQuery,
  EndRequirementInput,
  PublishVersionInput,
  RequirementQuery,
  UpdateDocumentInput,
  UpdateRequirementInput,
  UpdateVersionInput,
  VersionQuery,
  WithdrawVersionInput,
} from "./document-types.js";

type Clock = { now(): Date };
const defaultClock: Clock = { now: () => new Date() };

function scope(actor: DocumentActor, permission: string) {
  return permissionScope(actor as LegacyDirectoryActor, permission);
}

function access(actor: DocumentActor, permission: string, ownMemberProfileId?: string | null): DocumentAccess {
  const value = scope(actor, permission);
  return { global: value.allowed && value.global, groupIds: value.allowed ? [...value.groupIds] : [], ownMemberProfileId };
}

function globalPermission(actor: DocumentActor, permission: string) {
  const value = scope(actor, permission);
  if (!value.allowed || !value.global) throw new HttpError(403, "This global document action requires global access");
}

function resolved<T>(result: MutationResult<T>, missing: string, conflicts: Record<string, string>, fallback: string) {
  if (result.conflict) throw new HttpError(409, conflicts[result.reason ?? ""] ?? fallback);
  if (!result.record) throw new HttpError(404, missing);
  return result.idempotent ? { ...(result.record as any), idempotent: true } as T : result.record;
}

const documentConflicts = {
  "duplicate-code": "A document with this code already exists",
  stale: "This document changed. Refresh and try again",
  "active-requirements": "End effective requirements or withdraw the published version before archiving this document",
  "concurrent-conflict": "Document lifecycle changed concurrently. Refresh and try again",
};
const versionConflicts = {
  "duplicate-label": "This document already has a version with that label",
  stale: "This document version changed. Refresh and try again",
  "inactive-document": "Archived documents cannot receive or publish versions",
  "invalid-transition": "This action is not valid for the current document version state",
  "invalid-content": "This version needs non-empty internal text or an HTTPS external link",
  "published-changed": "The currently published version changed. Review the publication consequences before trying again",
  "operation-misuse": "This operationId was already used for a different command, target or payload",
  "reason-required": "Withdrawing a published version requires a reason",
  "concurrent-conflict": "Document publishing changed concurrently. Refresh and try again",
};
const requirementConflicts = {
  "duplicate-requirement": "An active requirement already exists for this exact version and target",
  stale: "This requirement changed. Refresh and try again",
  "invalid-version": "Requirements can only be attached to an active document's published version",
  "inactive-target": "Archived targets cannot receive document requirements",
  "unsupported-role": "This role target is not supported",
  "invalid-date": "Effective end must be after effective start",
  "operation-misuse": "This operationId was already used for a different command, target or payload",
  "concurrent-conflict": "Document requirement changed concurrently. Refresh and try again",
};
const acknowledgementConflicts = {
  "invalid-version": "Only a published version of an active document can be acknowledged",
  "invalid-content": "This version has no content available for acknowledgement",
  "inactive-target": "Archived profiles cannot acknowledge documents",
  "not-applicable": "This document does not currently require acknowledgement for this member",
  "operation-misuse": "This operationId was already used for a different command, target or payload",
  "note-required": "On-behalf acknowledgement requires a reason",
  "concurrent-conflict": "The obligation changed while acknowledgement was being recorded. Refresh and try again",
};

export function createDocumentService(repository: FoundationDocumentRepository, incidentAccess: IncidentAccessService, clock: Clock = defaultClock) {
  async function linkedMember(actor: DocumentActor) { return repository.resolveMemberForUser(actor); }

  async function readAccess(actor: DocumentActor, mine = false) {
    const member = await linkedMember(actor);
    const all = scope(actor, "document:read-all");
    const own = actor.permissions.includes("document:read-own") ? member?.id ?? null : null;
    if ((mine || !all.allowed) && !own) throw new HttpError(403, "No linked member profile is available for this user");
    return { member, access: { global: !mine && all.allowed && all.global, groupIds: !mine && all.allowed ? [...all.groupIds] : [], ownMemberProfileId: own } satisfies DocumentAccess };
  }

  async function authorizeGroup(actor: DocumentActor, groupId: string, permission: string, writable = false) {
    const group = await repository.getGroup(groupId);
    if (!group) throw new HttpError(404, "Operational group not found");
    const permissionValue = scope(actor, permission);
    if (!permissionValue.allowed || (!permissionValue.global && !permissionValue.groupIds.has(groupId))) throw new HttpError(403, "Forbidden");
    const context = await incidentAccess.authorize(actor, group.incidentId);
    if (writable && !context.writable) throw new HttpError(409, "Document requirement changes are not allowed in a closed incident");
    if (writable && group.status === "Archived") throw new HttpError(409, "Archived groups cannot receive document requirements");
    return group;
  }

  async function authorizeMember(actor: DocumentActor, memberProfileId: string, permission: string) {
    const targetAccess = access(actor, permission);
    if (!targetAccess.global && !targetAccess.groupIds.length) throw new HttpError(403, "Forbidden");
    if (!await repository.memberAccessible(memberProfileId, targetAccess)) throw new HttpError(403, "Forbidden");
  }

  async function requirementIncident(actor: DocumentActor, targetType: string, groupId: string | null | undefined, memberProfileId: string | null | undefined) {
    if (targetType === "Role") {
      globalPermission(actor, "document:requirement:manage");
      return null;
    }
    if (targetType === "Group" && groupId) return (await authorizeGroup(actor, groupId, "document:requirement:manage", true)).incidentId;
    if (targetType === "MemberProfile" && memberProfileId) {
      await authorizeMember(actor, memberProfileId, "document:requirement:manage");
      return null;
    }
    throw new HttpError(400, "Choose exactly one target matching targetType");
  }

  return {
    kind: repository.kind,
    now: () => clock.now(),

    async listDocuments(actor: DocumentActor, query: DocumentQuery) {
      const read = await readAccess(actor, Boolean(query.mine) || !actor.permissions.includes("document:read-all"));
      return repository.listDocuments(query, read.access, actor, clock.now());
    },
    async getDocument(actor: DocumentActor, id: string) {
      const read = await readAccess(actor);
      const record = await repository.getDocument(id, read.access, actor, clock.now());
      if (!record) throw new HttpError(404, "Document not found");
      return record;
    },
    async createDocument(actor: DocumentActor, input: CreateDocumentInput) {
      globalPermission(actor, "document:manage");
      return resolved(await repository.createDocument(input, actor), "Document not found", documentConflicts, "Document could not be created");
    },
    async updateDocument(actor: DocumentActor, id: string, input: UpdateDocumentInput, expectedVersion: number) {
      globalPermission(actor, "document:manage");
      return resolved(await repository.updateDocument(id, input, expectedVersion, actor), "Document not found", documentConflicts, "Document could not be updated");
    },
    async setDocumentActive(actor: DocumentActor, id: string, active: boolean, expectedVersion: number) {
      globalPermission(actor, "document:manage");
      return resolved(await repository.setDocumentActive(id, active, expectedVersion, actor), "Document not found", documentConflicts, "Document lifecycle could not be changed");
    },

    async listVersions(actor: DocumentActor, documentId: string, query: VersionQuery) {
      const read = await readAccess(actor);
      return repository.listVersions(documentId, query, read.access, actor, clock.now());
    },
    async getVersion(actor: DocumentActor, id: string, includeContent = false) {
      const read = await readAccess(actor);
      const record = await repository.getVersion(id, read.access, actor, clock.now(), includeContent);
      if (!record) throw new HttpError(404, "Document version not found");
      return record;
    },
    async createVersion(actor: DocumentActor, documentId: string, input: CreateVersionInput) {
      globalPermission(actor, "document:version:manage");
      return resolved(await repository.createVersion(documentId, input, actor), "Document not found", versionConflicts, "Document version could not be created");
    },
    async updateVersion(actor: DocumentActor, id: string, input: UpdateVersionInput, expectedVersion: number) {
      globalPermission(actor, "document:version:manage");
      return resolved(await repository.updateVersion(id, input, expectedVersion, actor), "Document version not found", versionConflicts, "Document version could not be updated");
    },
    async publishVersion(actor: DocumentActor, id: string, input: PublishVersionInput) {
      globalPermission(actor, "document:publish");
      return resolved(await repository.publishVersion(id, input, actor), "Document version not found", versionConflicts, "Document version could not be published");
    },
    async withdrawVersion(actor: DocumentActor, id: string, input: WithdrawVersionInput) {
      globalPermission(actor, "document:publish");
      return resolved(await repository.withdrawVersion(id, input, actor), "Document version not found", versionConflicts, "Document version could not be withdrawn");
    },

    async listRequirements(actor: DocumentActor, query: RequirementQuery) {
      const permission = actor.permissions.includes("document:read-all") ? "document:read-all" : "document:requirement:manage";
      if (!scope(actor, permission).allowed) throw new HttpError(403, "Forbidden");
      return repository.listRequirements(query, access(actor, permission), actor, clock.now());
    },
    async getRequirement(actor: DocumentActor, id: string) {
      const permission = actor.permissions.includes("document:read-all") ? "document:read-all" : "document:requirement:manage";
      const record = await repository.getRequirement(id, access(actor, permission), actor, clock.now());
      if (!record) throw new HttpError(404, "Document requirement not found");
      if (record.groupId) await authorizeGroup(actor, record.groupId, permission);
      return record;
    },
    async createRequirement(actor: DocumentActor, input: CreateRequirementInput) {
      if (!scope(actor, "document:requirement:manage").allowed) throw new HttpError(403, "Forbidden");
      const incidentId = await requirementIncident(actor, input.targetType, input.groupId, input.memberProfileId);
      return resolved(await repository.createRequirement(input, actor, incidentId), "Document requirement not found", requirementConflicts, "Document requirement could not be created");
    },
    async updateRequirement(actor: DocumentActor, id: string, input: UpdateRequirementInput, expectedVersion: number) {
      const current = await this.getRequirement(actor, id);
      const targetType = input.targetType ?? current.targetType;
      const groupId = targetType === "Group" ? input.groupId ?? current.groupId : null;
      const memberProfileId = targetType === "MemberProfile" ? input.memberProfileId ?? current.memberProfileId : null;
      const incidentId = await requirementIncident(actor, targetType, groupId, memberProfileId);
      return resolved(await repository.updateRequirement(id, input, expectedVersion, actor, incidentId), "Document requirement not found", requirementConflicts, "Document requirement could not be updated");
    },
    async endRequirement(actor: DocumentActor, id: string, input: EndRequirementInput) {
      const current = await this.getRequirement(actor, id);
      const incidentId = current.groupId ? (await authorizeGroup(actor, current.groupId, "document:requirement:manage", true)).incidentId : null;
      return resolved(await repository.endRequirement(id, input, actor, incidentId), "Document requirement not found", requirementConflicts, "Document requirement could not be ended");
    },

    async listAcknowledgements(actor: DocumentActor, query: AcknowledgementQuery) {
      const member = await linkedMember(actor);
      const permission = scope(actor, "document:read-all").allowed ? "document:read-all" : scope(actor, "document:acknowledge-all").allowed ? "document:acknowledge-all" : "document:acknowledge-own";
      const read = access(actor, permission, permission === "document:acknowledge-own" ? member?.id : null);
      if (!read.global && !read.groupIds.length && !read.ownMemberProfileId) throw new HttpError(403, "Forbidden");
      return repository.listAcknowledgements(query, read, actor, clock.now());
    },
    async acknowledgeVersion(actor: DocumentActor, id: string, input: AcknowledgeInput) {
      const own = await linkedMember(actor);
      const requested = input.memberProfileId ?? null;
      const onBehalf = Boolean(requested && requested !== own?.id);
      let memberProfileId = own?.id ?? "";
      if (onBehalf) {
        if (!input.onBehalf) throw new HttpError(400, "On-behalf acknowledgement must be explicit");
        if (!input.note || input.note.trim().length < 3) throw new HttpError(400, "On-behalf acknowledgement requires a reason");
        await authorizeMember(actor, requested!, "document:acknowledge-all");
        memberProfileId = requested!;
      } else {
        if (!actor.permissions.includes("document:acknowledge-own") && !scope(actor, "document:acknowledge-all").allowed) throw new HttpError(403, "Forbidden");
        if (!memberProfileId) throw new HttpError(409, "No linked member profile is available for this user");
      }
      return resolved(await repository.acknowledgeVersion(id, { ...input, memberProfileId: onBehalf ? requested : null, onBehalf }, memberProfileId, actor), "Document version not found", acknowledgementConflicts, "Acknowledgement could not be recorded");
    },
    async evaluateMemberCompliance(actor: DocumentActor, memberProfileId: string, options?: { evaluationAt?: string | Date }) {
      const member = await linkedMember(actor);
      const read = access(actor, "document:read-all", actor.permissions.includes("document:read-own") ? member?.id : null);
      if (!await repository.memberAccessible(memberProfileId, read)) throw new HttpError(403, "Forbidden");
      const evaluationAt = options?.evaluationAt instanceof Date ? options.evaluationAt : options?.evaluationAt ? new Date(options.evaluationAt) : clock.now();
      const result = await repository.evaluateMemberCompliance(memberProfileId, actor, evaluationAt);
      if (!result) throw new HttpError(404, "Member profile not found");
      return result;
    },
  };
}

export type DocumentService = ReturnType<typeof createDocumentService>;
