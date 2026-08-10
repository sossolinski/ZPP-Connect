import { HttpError } from "../../errors.js";
import { permissionScope } from "../../scope-policy.js";
import type { DirectoryActor as LegacyDirectoryActor } from "../../member-directory.js";
import type { IncidentAccessService } from "../incident-access/incident-access-service.js";
import type { FoundationMemberDirectoryRepository, MutationResult } from "./member-directory-repository.js";
import type {
  CreateGroupInput,
  CreateMemberInput,
  DirectoryActor,
  GroupQuery,
  GroupRecord,
  MemberProfileRecord,
  MemberQuery,
  UpdateGroupInput,
  UpdateMemberInput,
} from "./member-directory-types.js";

const staleMessage = "This record changed while you were reviewing it. Refresh and try again";

function scope(actor: DirectoryActor, permission: string) {
  return permissionScope(actor as LegacyDirectoryActor, permission);
}

function global(actor: DirectoryActor, permission: string) {
  const value = scope(actor, permission);
  if (!value.allowed || !value.global) throw new HttpError(403, "Forbidden");
}

function groupScope(actor: DirectoryActor, permission: string, groupId: string) {
  const value = scope(actor, permission);
  if (!value.allowed || (!value.global && !value.groupIds.has(groupId))) throw new HttpError(403, "Forbidden");
}

function resolved<T>(result: MutationResult<T>, missing: string) {
  if (result.conflict) throw new HttpError(409, staleMessage);
  if (!result.record) throw new HttpError(404, missing);
  return result.record;
}

export function createMemberDirectoryService(repository: FoundationMemberDirectoryRepository, incidentAccess: IncidentAccessService) {
  async function incident(actor: DirectoryActor, incidentId: string, writable = false) {
    const context = await incidentAccess.authorize(actor, incidentId);
    if (writable && !context.writable) throw new HttpError(409, "Groups in a closed incident are read-only");
    return context;
  }

  async function assertMemberVisible(actor: DirectoryActor, id: string) {
    const member = await repository.getMember(id, actor);
    if (!member) throw new HttpError(404, "Member profile not found");
    return member;
  }

  async function assertGroupVisible(actor: DirectoryActor, incidentId: string, groupId: string, permission: string, writable = false) {
    await incident(actor, incidentId, writable);
    groupScope(actor, permission, groupId);
    const group = await repository.getGroup(incidentId, groupId, actor);
    if (!group) throw new HttpError(404, "Group not found");
    return group;
  }

  return {
    kind: repository.kind,
    listMembers: (actor: DirectoryActor, query: MemberQuery) => repository.listMembers(query, actor),
    getMember: (actor: DirectoryActor, id: string) => repository.getMember(id, actor).then((member) => {
      if (!member) throw new HttpError(404, "Member profile not found");
      return member;
    }),
    listEligibleUsers: (search: string | undefined, currentMemberId: string | undefined, limit: number, offset: number) => repository.listEligibleUsers(search, currentMemberId, limit, offset),
    createMember: async (actor: DirectoryActor, input: CreateMemberInput) => {
      global(actor, "member:create");
      return resolved(await repository.createMember(input, actor), "Member profile not found");
    },
    updateMember: async (actor: DirectoryActor, id: string, input: UpdateMemberInput, expectedVersion: number) => {
      await assertMemberVisible(actor, id);
      return resolved(await repository.updateMember(id, input, expectedVersion, actor), "Member profile not found");
    },
    archiveMember: async (actor: DirectoryActor, id: string, expectedVersion: number) => {
      await assertMemberVisible(actor, id);
      return resolved(await repository.archiveMember(id, expectedVersion, actor), "Member profile not found");
    },
    restoreMember: async (actor: DirectoryActor, id: string, expectedVersion: number) => {
      await assertMemberVisible(actor, id);
      return resolved(await repository.restoreMember(id, expectedVersion, actor), "Member profile not found");
    },
    listGroups: async (actor: DirectoryActor, incidentId: string | undefined, query: GroupQuery) => {
      if (incidentId) await incident(actor, incidentId);
      return repository.listGroups(incidentId, query, actor);
    },
    getGroup: async (actor: DirectoryActor, incidentId: string, id: string) => {
      await incident(actor, incidentId);
      const group = await repository.getGroup(incidentId, id, actor);
      if (!group) throw new HttpError(404, "Group not found");
      return group;
    },
    createGroup: async (actor: DirectoryActor, incidentId: string, input: CreateGroupInput) => {
      await incident(actor, incidentId, true);
      global(actor, "group:create");
      return resolved(await repository.createGroup(incidentId, input, actor), "Group not found");
    },
    updateGroup: async (actor: DirectoryActor, incidentId: string, id: string, input: UpdateGroupInput, expectedVersion: number) => {
      await assertGroupVisible(actor, incidentId, id, "group:update", true);
      return resolved(await repository.updateGroup(incidentId, id, input, expectedVersion, actor), "Group not found");
    },
    archiveGroup: async (actor: DirectoryActor, incidentId: string, id: string, expectedVersion: number) => {
      await assertGroupVisible(actor, incidentId, id, "group:archive", true);
      return resolved(await repository.archiveGroup(incidentId, id, expectedVersion, actor), "Group not found");
    },
    listGroupMembers: async (actor: DirectoryActor, incidentId: string, id: string, limit: number, offset: number) => {
      await assertGroupVisible(actor, incidentId, id, "group:read");
      return repository.listGroupMembers(incidentId, id, limit, offset, actor);
    },
    addGroupMember: async (actor: DirectoryActor, incidentId: string, id: string, memberProfileId: string, role: string, expectedVersion: number) => {
      await assertGroupVisible(actor, incidentId, id, "group:membership:manage", true);
      return resolved(await repository.addGroupMember(incidentId, id, memberProfileId, role, expectedVersion, actor), "Group not found");
    },
    changeGroupMemberRole: async (actor: DirectoryActor, incidentId: string, id: string, memberProfileId: string, role: string, expectedVersion: number) => {
      await assertGroupVisible(actor, incidentId, id, "group:membership:manage", true);
      return resolved(await repository.changeGroupMemberRole(incidentId, id, memberProfileId, role, expectedVersion, actor), "Group not found");
    },
    removeGroupMember: async (actor: DirectoryActor, incidentId: string, id: string, memberProfileId: string, expectedVersion: number) => {
      await assertGroupVisible(actor, incidentId, id, "group:membership:manage", true);
      return resolved(await repository.removeGroupMember(incidentId, id, memberProfileId, expectedVersion, actor), "Group not found");
    },
    setLeader: async (actor: DirectoryActor, incidentId: string, id: string, memberProfileId: string, expectedVersion: number) => {
      await assertGroupVisible(actor, incidentId, id, "group:update", true);
      return resolved(await repository.setLeader(incidentId, id, memberProfileId, expectedVersion, actor), "Group not found");
    },
  };
}

export type MemberDirectoryService = ReturnType<typeof createMemberDirectoryService>;
