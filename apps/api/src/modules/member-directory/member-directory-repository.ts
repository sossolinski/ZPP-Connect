import type {
  CreateGroupInput,
  CreateMemberInput,
  DirectoryActor,
  GroupQuery,
  GroupRecord,
  MemberProfileRecord,
  MemberQuery,
  Page,
  UpdateGroupInput,
  UpdateMemberInput,
} from "./member-directory-types.js";

export type MutationResult<T> = { record: T | null; conflict: boolean };
export type PersistedRoleAssignment = { id: string; userId: string; roleName: string; scopeType: "GLOBAL" | "GROUP"; scopeId: string | null; status: "Active" | "Revoked"; version: number };
export type RoleScopeInput = { roleName: string; scopeType: "GLOBAL" | "GROUP"; scopeId?: string | null };

export interface FoundationMemberDirectoryRepository {
  readonly kind: "postgres";
  resolveUserId(email: string): Promise<string | null>;
  listMembers(query: MemberQuery, actor: DirectoryActor): Promise<Page<MemberProfileRecord>>;
  getMember(id: string, actor: DirectoryActor): Promise<MemberProfileRecord | null>;
  listEligibleUsers(search: string | undefined, currentMemberId: string | undefined, limit: number, offset: number): Promise<Page<Record<string, unknown>>>;
  createMember(input: CreateMemberInput, actor: DirectoryActor): Promise<MutationResult<MemberProfileRecord>>;
  updateMember(id: string, input: UpdateMemberInput, expectedVersion: number, actor: DirectoryActor): Promise<MutationResult<MemberProfileRecord>>;
  archiveMember(id: string, expectedVersion: number, actor: DirectoryActor): Promise<MutationResult<MemberProfileRecord>>;
  restoreMember(id: string, expectedVersion: number, actor: DirectoryActor): Promise<MutationResult<MemberProfileRecord>>;
  listGroups(incidentId: string | undefined, query: GroupQuery, actor: DirectoryActor): Promise<Page<GroupRecord>>;
  getGroup(incidentId: string, id: string, actor: DirectoryActor): Promise<GroupRecord | null>;
  createGroup(incidentId: string, input: CreateGroupInput, actor: DirectoryActor): Promise<MutationResult<GroupRecord>>;
  updateGroup(incidentId: string, id: string, input: UpdateGroupInput, expectedVersion: number, actor: DirectoryActor): Promise<MutationResult<GroupRecord>>;
  archiveGroup(incidentId: string, id: string, expectedVersion: number, actor: DirectoryActor): Promise<MutationResult<GroupRecord>>;
  listGroupMembers(incidentId: string, groupId: string, limit: number, offset: number, actor: DirectoryActor): Promise<Page<MemberProfileRecord & { membershipId: string; membershipRole: string; membershipCreatedAt: Date | string; membershipUpdatedAt: Date | string }>>;
  addGroupMember(incidentId: string, groupId: string, memberProfileId: string, role: string, expectedVersion: number, actor: DirectoryActor): Promise<MutationResult<GroupRecord>>;
  changeGroupMemberRole(incidentId: string, groupId: string, memberProfileId: string, role: string, expectedVersion: number, actor: DirectoryActor): Promise<MutationResult<GroupRecord>>;
  removeGroupMember(incidentId: string, groupId: string, memberProfileId: string, expectedVersion: number, actor: DirectoryActor): Promise<MutationResult<GroupRecord>>;
  setLeader(incidentId: string, groupId: string, memberProfileId: string, expectedVersion: number, actor: DirectoryActor): Promise<MutationResult<GroupRecord>>;
  assignGroupRole(userId: string, roleName: string, groupId: string, actor: DirectoryActor): Promise<PersistedRoleAssignment>;
  revokeGroupRole(assignmentId: string, userId: string, actor: DirectoryActor): Promise<PersistedRoleAssignment | null>;
  replaceRoleScopes(userId: string, assignments: RoleScopeInput[], actor: DirectoryActor): Promise<void>;
}
