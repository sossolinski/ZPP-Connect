export const authenticationPolicies = ["SSO_ONLY", "PASSWORD_ONLY", "SSO_OR_PASSWORD"] as const;
export type AuthenticationPolicy = typeof authenticationPolicies[number];

export const accountStatuses = ["Pending", "Active", "Suspended", "Archived"] as const;
export type AccountStatus = typeof accountStatuses[number];

export const identityProviderTypes = ["MICROSOFT_ENTRA", "ENTRA_EXTERNAL_ID", "LOCAL_DEV", "DEVELOPMENT", "OTHER"] as const;
export type IdentityProviderType = typeof identityProviderTypes[number];

export const authenticationMethods = ["MICROSOFT_SSO", "EMAIL_PASSWORD", "LOCAL_DEV_SSO", "LOCAL_DEV_PASSWORD", "LOCAL_DEV_CHOICE", "DEVELOPMENT_HEADER"] as const;
export type AuthenticationMethod = typeof authenticationMethods[number];

export const userInvitationStatuses = ["Prepared", "Sent", "Accepted", "Expired", "Revoked"] as const;
export type UserInvitationStatus = typeof userInvitationStatuses[number];

export const emailOutboxStatuses = ["Pending", "Queued", "Sent", "Failed", "Cancelled"] as const;
export type EmailOutboxStatus = typeof emailOutboxStatuses[number];

export type StableId = string;
export type IsoTimestamp = string;

export type OptimisticConcurrency = {
  expectedVersion?: number;
};

export type PageRequest = {
  limit?: number;
  offset?: number;
};

export type PageResult<T> = {
  total: number;
  data: T[];
};

export type UserContract = {
  id: StableId;
  displayName: string;
  primaryEmail: string;
  status: AccountStatus;
  authenticationPolicy: AuthenticationPolicy;
  memberProfileId?: StableId | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  activatedAt?: IsoTimestamp | null;
  suspendedAt?: IsoTimestamp | null;
  archivedAt?: IsoTimestamp | null;
  restoredAt?: IsoTimestamp | null;
  lastSuccessfulSignInAt?: IsoTimestamp | null;
  version: number;
};

export type UserIdentityContract = {
  id: StableId;
  userId: StableId;
  providerType: IdentityProviderType;
  realmId: string;
  providerSubject: string;
  authenticationMethod: AuthenticationMethod;
  emailSnapshot: string;
  linkedAt: IsoTimestamp;
  lastSuccessfulAuthenticationAt?: IsoTimestamp | null;
  disabledAt?: IsoTimestamp | null;
  version: number;
};

export type UserInvitationContract = {
  id: StableId;
  userId: StableId;
  invitedEmailSnapshot: string;
  intendedAuthenticationPolicy: AuthenticationPolicy;
  status: UserInvitationStatus;
  tokenHash: string;
  tokenExpiresAt: IsoTimestamp;
  createdByUserId: StableId;
  createdAt: IsoTimestamp;
  sentAt?: IsoTimestamp | null;
  acceptedAt?: IsoTimestamp | null;
  revokedAt?: IsoTimestamp | null;
  resendGeneration: number;
  version: number;
};

export type UserInvitationView = Omit<UserInvitationContract, "tokenHash"> & {
  hasActiveToken: boolean;
};

export type EmailTemplateValue = string | number | boolean | null;

export type EmailOutboxContract = {
  id: StableId;
  messageType: string;
  recipient: string;
  templateId: string;
  templateVariables: Record<string, EmailTemplateValue>;
  sourceResourceType: string;
  sourceResourceId: StableId;
  deliveryStatus: EmailOutboxStatus;
  attemptCount: number;
  nextAttemptAt?: IsoTimestamp | null;
  sentAt?: IsoTimestamp | null;
  failureCode?: string | null;
  createdAt: IsoTimestamp;
};

export type AccountSessionContract = {
  id: StableId;
  userId: StableId;
  sessionGeneration: number;
  createdAt: IsoTimestamp;
  expiresAt?: IsoTimestamp | null;
  lastSeenAt?: IsoTimestamp | null;
  revokedAt?: IsoTimestamp | null;
  version: number;
};

export type RoleAssignmentContract = {
  id: StableId;
  userId: StableId;
  roleName: string;
  scopeType: "GLOBAL" | "GROUP";
  scopeId?: StableId | null;
  status: "Active" | "Revoked";
  assignedAt: IsoTimestamp;
  assignedByUserId: StableId;
  revokedAt?: IsoTimestamp | null;
  revokedByUserId?: StableId | null;
  version: number;
};

export type CapabilityOverrideContract = {
  id: StableId;
  userId: StableId;
  capability: string;
  effect: "GRANT" | "DENY";
  reason: string;
  active: boolean;
  expiresAt?: IsoTimestamp | null;
  createdAt: IsoTimestamp;
  createdByUserId: StableId;
  revokedAt?: IsoTimestamp | null;
  revokedByUserId?: StableId | null;
  version: number;
};

export const currentAccessAuditActions = [
  "user_created",
  "user_metadata_changed",
  "user_activated",
  "user_suspended",
  "user_restored",
  "user_archived",
  "member_profile_linked",
  "member_profile_link_changed",
  "member_profile_unlinked",
  "role_assigned",
  "scoped_role_assigned",
  "role_assignment_revoked",
  "role_scope_changed",
  "update_user_roles",
  "custom_role_created",
  "custom_role_changed",
  "custom_role_archived",
  "role_capability_added",
  "role_capability_removed",
  "user_grant_created",
  "user_deny_created",
  "capability_override_revoked"
] as const;

export const futureAccessAuditActions = [
  "authentication_policy_changed",
  "identity_linked",
  "identity_disabled",
  "identity_unlinked",
  "invitation_prepared",
  "invitation_sent",
  "invitation_regenerated",
  "invitation_resent",
  "invitation_revoked",
  "invitation_accepted",
  "invitation_expired",
  "local_identity_linked",
  "account_activated_through_invitation",
  "local_authentication_completed",
  "email_delivery_failed",
  "account_sessions_revoked"
] as const;

export const accessAuditActions = [...currentAccessAuditActions, ...futureAccessAuditActions] as const;
export type AccessAuditAction = typeof accessAuditActions[number];

export type AccessAuditContract = {
  id: StableId;
  action: AccessAuditAction | string;
  entityType: string;
  entityId: StableId;
  actorUserId: StableId;
  actorEmailSnapshot: string;
  actorDisplayNameSnapshot: string;
  summary: string;
  metadata?: Record<string, unknown>;
  createdAt: IsoTimestamp;
};

export type AuditEventMatrixItem = {
  action: AccessAuditAction | "user_sessions_revoked";
  lifecycle: "current" | "future" | "disabled";
  entityType: string;
  requiredMetadata: readonly string[];
  notes: string;
};

export const accessAuditEventMatrix: readonly AuditEventMatrixItem[] = [
  { action: "user_created", lifecycle: "current", entityType: "userAccount", requiredMetadata: ["targetUserId"], notes: "Created from server-authenticated administrator context." },
  { action: "user_metadata_changed", lifecycle: "current", entityType: "userAccount", requiredMetadata: ["targetUserId", "previous", "next"], notes: "Status changes are excluded and use lifecycle actions." },
  { action: "user_activated", lifecycle: "current", entityType: "userAccount", requiredMetadata: ["targetUserId", "previousStatus", "nextStatus"], notes: "Does not imply invitation acceptance." },
  { action: "user_suspended", lifecycle: "current", entityType: "userAccount", requiredMetadata: ["targetUserId", "previousStatus", "nextStatus", "reason"], notes: "Last administrator protection is evaluated from effective access." },
  { action: "user_restored", lifecycle: "current", entityType: "userAccount", requiredMetadata: ["targetUserId", "previousStatus", "nextStatus"], notes: "Restored accounts return to Pending." },
  { action: "user_archived", lifecycle: "current", entityType: "userAccount", requiredMetadata: ["targetUserId", "previousStatus", "nextStatus", "reason"], notes: "Last administrator protection is evaluated from effective access." },
  { action: "member_profile_linked", lifecycle: "current", entityType: "userAccount", requiredMetadata: ["targetUserId", "memberProfileId"], notes: "Member ownership is based on stable IDs." },
  { action: "member_profile_link_changed", lifecycle: "current", entityType: "userAccount", requiredMetadata: ["targetUserId", "previousMemberProfileId", "memberProfileId"], notes: "Historical ownership remains in audit." },
  { action: "member_profile_unlinked", lifecycle: "current", entityType: "userAccount", requiredMetadata: ["targetUserId", "previousMemberProfileId"], notes: "Unlink does not delete the member profile." },
  { action: "role_assigned", lifecycle: "current", entityType: "userAccount", requiredMetadata: ["targetUserId", "roleName", "scopeType"], notes: "Global role assignment." },
  { action: "scoped_role_assigned", lifecycle: "current", entityType: "userAccount", requiredMetadata: ["targetUserId", "roleName", "scopeType", "scopeId"], notes: "Group scope is validated server-side." },
  { action: "role_assignment_revoked", lifecycle: "current", entityType: "userAccount", requiredMetadata: ["targetUserId", "roleName", "scopeType"], notes: "Last administrator protection applies." },
  { action: "role_scope_changed", lifecycle: "current", entityType: "userAccount", requiredMetadata: ["targetUserId", "roleName", "previousScopeType", "nextScopeType"], notes: "Emitted when an active role is retained but its scope changes." },
  { action: "update_user_roles", lifecycle: "current", entityType: "userAccount", requiredMetadata: ["targetUserId", "assignments"], notes: "Bulk legacy update path retained for compatibility." },
  { action: "custom_role_created", lifecycle: "current", entityType: "role", requiredMetadata: ["roleId", "permissions"], notes: "Custom roles cannot include admin:manage." },
  { action: "custom_role_changed", lifecycle: "current", entityType: "role", requiredMetadata: ["roleId", "previousPermissions", "nextPermissions"], notes: "Capability deltas also emit add/remove events." },
  { action: "custom_role_archived", lifecycle: "current", entityType: "role", requiredMetadata: ["roleId"], notes: "Protected roles cannot be archived." },
  { action: "role_capability_added", lifecycle: "current", entityType: "role", requiredMetadata: ["roleId", "permission"], notes: "Emitted only for real custom-role capability deltas." },
  { action: "role_capability_removed", lifecycle: "current", entityType: "role", requiredMetadata: ["roleId", "permission"], notes: "Emitted only for real custom-role capability deltas." },
  { action: "user_grant_created", lifecycle: "current", entityType: "userAccount", requiredMetadata: ["targetUserId", "permission", "reason"], notes: "Grant is overridden by active Deny." },
  { action: "user_deny_created", lifecycle: "current", entityType: "userAccount", requiredMetadata: ["targetUserId", "permission", "reason"], notes: "Deny wins over Role and Grant." },
  { action: "capability_override_revoked", lifecycle: "current", entityType: "userAccount", requiredMetadata: ["targetUserId", "permission", "effect"], notes: "Last administrator protection applies to admin grants." },
  { action: "user_sessions_revoked", lifecycle: "disabled", entityType: "userAccount", requiredMetadata: [], notes: "Old non-enforcing flag is disabled until a real session store exists." },
  { action: "authentication_policy_changed", lifecycle: "future", entityType: "userAccount", requiredMetadata: ["targetUserId", "previousPolicy", "nextPolicy"], notes: "Must not activate an account or add identities implicitly." },
  { action: "identity_linked", lifecycle: "future", entityType: "userIdentity", requiredMetadata: ["targetUserId", "identityId", "providerType", "realmId"], notes: "Provider subject is stable ownership key." },
  { action: "identity_disabled", lifecycle: "future", entityType: "userIdentity", requiredMetadata: ["targetUserId", "identityId"], notes: "Must protect final usable identity." },
  { action: "identity_unlinked", lifecycle: "future", entityType: "userIdentity", requiredMetadata: ["targetUserId", "identityId"], notes: "Must protect final usable identity." },
  { action: "invitation_prepared", lifecycle: "future", entityType: "userInvitation", requiredMetadata: ["targetUserId", "invitationId"], notes: "Raw token is never audited." },
  { action: "invitation_sent", lifecycle: "future", entityType: "userInvitation", requiredMetadata: ["targetUserId", "invitationId"], notes: "Email send occurs after commit." },
  { action: "invitation_regenerated", lifecycle: "future", entityType: "userInvitation", requiredMetadata: ["targetUserId", "invitationId", "resendGeneration"], notes: "Regeneration invalidates the previous invitation generation." },
  { action: "invitation_resent", lifecycle: "future", entityType: "userInvitation", requiredMetadata: ["targetUserId", "invitationId", "resendGeneration"], notes: "Resend invalidates prior token generation." },
  { action: "invitation_revoked", lifecycle: "future", entityType: "userInvitation", requiredMetadata: ["targetUserId", "invitationId"], notes: "Revoked invitation cannot activate an account." },
  { action: "invitation_accepted", lifecycle: "future", entityType: "userInvitation", requiredMetadata: ["targetUserId", "invitationId", "identityId"], notes: "Acceptance cannot change roles." },
  { action: "invitation_expired", lifecycle: "future", entityType: "userInvitation", requiredMetadata: ["targetUserId", "invitationId"], notes: "Expired invitation cannot activate an account." },
  { action: "local_identity_linked", lifecycle: "future", entityType: "userIdentity", requiredMetadata: ["targetUserId", "identityId", "providerType", "authenticationMethod"], notes: "Local onboarding identity is a development adapter detail, not user-facing product copy." },
  { action: "account_activated_through_invitation", lifecycle: "future", entityType: "userAccount", requiredMetadata: ["targetUserId", "invitationId", "identityId", "previousStatus", "nextStatus"], notes: "Activation occurs only after a valid invitation acceptance." },
  { action: "local_authentication_completed", lifecycle: "future", entityType: "accountSession", requiredMetadata: ["targetUserId", "sessionId", "authenticationMethod"], notes: "Development-only authentication adapter event; effective access still comes only from canonical user assignments." },
  { action: "email_delivery_failed", lifecycle: "future", entityType: "emailOutbox", requiredMetadata: ["outboxId", "failureCode"], notes: "No sensitive payload is stored." },
  { action: "account_sessions_revoked", lifecycle: "future", entityType: "accountSession", requiredMetadata: ["targetUserId", "sessionGeneration"], notes: "Only valid after genuine session invalidation exists." }
] as const;

export const sensitiveAuthenticationFieldNames = [
  "password",
  "passwordHash",
  "encryptedPassword",
  "temporaryPassword",
  "resetToken",
  "passwordResetToken",
  "rawInvitationToken",
  "invitationToken",
  "oauthAccessToken",
  "oauthRefreshToken",
  "providerSecret",
  "clientSecret"
] as const;

export const authorizationClaimFieldNames = [
  "role",
  "roles",
  "roleAssignments",
  "permission",
  "permissions",
  "capability",
  "capabilities",
  "grants",
  "denies",
  "permissionOverrides"
] as const;

const sensitiveFieldSet = new Set<string>(sensitiveAuthenticationFieldNames.map((field) => field.toLowerCase()));
const authorizationClaimSet = new Set<string>(authorizationClaimFieldNames.map((field) => field.toLowerCase()));

function objectHasBlockedField(value: unknown, blocked: Set<string>): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => objectHasBlockedField(item, blocked));
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) => blocked.has(key.toLowerCase()) || objectHasBlockedField(nested, blocked));
}

export function hasSensitiveAuthenticationField(value: unknown) {
  return objectHasBlockedField(value, sensitiveFieldSet);
}

export function hasAuthorizationClaimField(value: unknown) {
  return objectHasBlockedField(value, authorizationClaimSet);
}

export type UserRepositoryContract = {
  getById(id: StableId): Promise<UserContract | null>;
  getByPrimaryEmail(email: string): Promise<UserContract | null>;
  list(filter: { status?: AccountStatus; search?: string } & PageRequest): Promise<PageResult<UserContract>>;
  create(input: Omit<UserContract, "id" | "createdAt" | "updatedAt" | "version">): Promise<UserContract>;
  update(id: StableId, input: Partial<UserContract> & OptimisticConcurrency): Promise<UserContract>;
};

export type RoleRepositoryContract<RoleRecord = unknown> = {
  getByName(name: string): Promise<RoleRecord | null>;
  list(filter: { status?: string } & PageRequest): Promise<PageResult<RoleRecord>>;
  create(input: RoleRecord): Promise<RoleRecord>;
  update(name: string, input: Partial<RoleRecord> & OptimisticConcurrency): Promise<RoleRecord>;
  archive(name: string, input: OptimisticConcurrency): Promise<RoleRecord>;
};

export type RoleAssignmentRepositoryContract = {
  listForUser(userId: StableId): Promise<RoleAssignmentContract[]>;
  create(input: Omit<RoleAssignmentContract, "id" | "assignedAt" | "version">): Promise<RoleAssignmentContract>;
  revoke(id: StableId, input: { revokedByUserId: StableId } & OptimisticConcurrency): Promise<RoleAssignmentContract>;
  replaceForUser(userId: StableId, assignments: Array<Pick<RoleAssignmentContract, "roleName" | "scopeType" | "scopeId">>, actorUserId: StableId): Promise<RoleAssignmentContract[]>;
};

export type CapabilityOverrideRepositoryContract = {
  listForUser(userId: StableId): Promise<CapabilityOverrideContract[]>;
  create(input: Omit<CapabilityOverrideContract, "id" | "createdAt" | "version">): Promise<CapabilityOverrideContract>;
  revoke(id: StableId, input: { revokedByUserId: StableId } & OptimisticConcurrency): Promise<CapabilityOverrideContract>;
};

export type AccountSessionRepositoryContract = {
  listForUser(userId: StableId, page?: PageRequest): Promise<PageResult<AccountSessionContract>>;
  revokeGeneration(userId: StableId, input: { sessionGeneration: number; revokedAt: IsoTimestamp }): Promise<void>;
  isGenerationRevoked(userId: StableId, sessionGeneration: number): Promise<boolean>;
};

export type AccessAuditRepositoryContract = {
  append(event: Omit<AccessAuditContract, "id" | "createdAt">): Promise<AccessAuditContract>;
  list(filter: { entityType?: string; entityId?: StableId; actorUserId?: StableId; action?: string } & PageRequest): Promise<PageResult<AccessAuditContract>>;
};

export type UserIdentityRepositoryContract = {
  findByProviderSubject(providerType: IdentityProviderType, realmId: string, providerSubject: string): Promise<UserIdentityContract | null>;
  listForUser(userId: StableId): Promise<UserIdentityContract[]>;
  create(input: Omit<UserIdentityContract, "id" | "linkedAt" | "version">): Promise<UserIdentityContract>;
  disable(id: StableId, input: OptimisticConcurrency): Promise<UserIdentityContract>;
};

export type UserInvitationRepositoryContract = {
  findByTokenHash(tokenHash: string): Promise<UserInvitationContract | null>;
  listForUser(userId: StableId): Promise<UserInvitationView[]>;
  create(input: Omit<UserInvitationContract, "id" | "createdAt" | "version">): Promise<UserInvitationView>;
  rotateTokenHash(id: StableId, input: { tokenHash: string; tokenExpiresAt: IsoTimestamp; resendGeneration: number } & OptimisticConcurrency): Promise<UserInvitationView>;
  consume(id: StableId, input: OptimisticConcurrency): Promise<UserInvitationView>;
  revoke(id: StableId, input: OptimisticConcurrency): Promise<UserInvitationView>;
};

export type EmailOutboxRepositoryContract = {
  append(input: Omit<EmailOutboxContract, "id" | "createdAt" | "attemptCount" | "deliveryStatus">): Promise<EmailOutboxContract>;
  listPending(page?: PageRequest): Promise<PageResult<EmailOutboxContract>>;
  markSent(id: StableId, sentAt: IsoTimestamp): Promise<EmailOutboxContract>;
  markFailed(id: StableId, failureCode: string, nextAttemptAt?: IsoTimestamp | null): Promise<EmailOutboxContract>;
};

export type IdentityServiceContract = {
  resolveProviderIdentity(providerType: IdentityProviderType, realmId: string, providerSubject: string): Promise<UserIdentityContract | null>;
  linkIdentity(userId: StableId, identity: Omit<UserIdentityContract, "id" | "userId" | "linkedAt" | "version">, actorUserId: StableId): Promise<UserIdentityContract>;
  disableIdentity(identityId: StableId, actorUserId: StableId, input: OptimisticConcurrency): Promise<UserIdentityContract>;
  assertUsableIdentityProtection(userId: StableId): Promise<void>;
};

export type InvitationServiceContract = {
  prepareInvitation(userId: StableId, actorUserId: StableId, input: { invitedEmailSnapshot: string; intendedAuthenticationPolicy: AuthenticationPolicy; tokenExpiresAt: IsoTimestamp }): Promise<UserInvitationView>;
  resendInvitation(invitationId: StableId, actorUserId: StableId, input: OptimisticConcurrency): Promise<UserInvitationView>;
  acceptInvitation(tokenHash: string, providerIdentity: Omit<UserIdentityContract, "id" | "userId" | "linkedAt" | "version">): Promise<UserContract>;
  revokeInvitation(invitationId: StableId, actorUserId: StableId, input: OptimisticConcurrency): Promise<UserInvitationView>;
};

export type AuthenticationPolicyServiceContract = {
  changePolicy(userId: StableId, actorUserId: StableId, input: { nextPolicy: AuthenticationPolicy } & OptimisticConcurrency): Promise<UserContract>;
  assertPolicyUsableForLinkedIdentities(userId: StableId, policy: AuthenticationPolicy): Promise<void>;
  assertLastAdminPolicyProtection(userId: StableId, policy: AuthenticationPolicy): Promise<void>;
};

export type EmailOutboxServiceContract = {
  enqueue(input: Omit<EmailOutboxContract, "id" | "createdAt" | "attemptCount" | "deliveryStatus"> & { idempotencyKey: string }): Promise<EmailOutboxContract>;
  recordFailure(id: StableId, failureCode: string, nextAttemptAt?: IsoTimestamp | null): Promise<EmailOutboxContract>;
  recordSent(id: StableId, sentAt: IsoTimestamp): Promise<EmailOutboxContract>;
};

export const accessRepositoryContractSummary = {
  userIdentity: {
    ownershipKey: ["providerType", "realmId", "providerSubject"],
    emailIsOwnershipKey: false
  },
  userInvitation: {
    lookupKey: "tokenHash",
    repositoryReadsReturnRawToken: false,
    acceptanceCanChangeRoles: false
  },
  accessAudit: {
    appendOnly: true,
    supportsUpdate: false,
    supportsDelete: false
  },
  emailOutbox: {
    allowedPayload: "non-sensitive template variables",
    forbiddenTemplateFields: sensitiveAuthenticationFieldNames
  }
} as const;

export const atomicOperationMatrix = [
  {
    operation: "prepareInvitation",
    atomicWrites: ["Pending User", "initial Role assignments", "optional Member Profile link", "User Invitation", "Access Audit"],
    afterCommit: []
  },
  {
    operation: "sendOrResendInvitation",
    atomicWrites: ["invalidate previous generation", "store new token hash", "update invitation status", "append Email Outbox", "Access Audit"],
    afterCommit: ["deliver email"]
  },
  {
    operation: "acceptInvitation",
    atomicWrites: ["consume invitation", "link User Identity", "activate User", "Access Audit"],
    afterCommit: []
  },
  {
    operation: "changeAuthenticationPolicy",
    atomicWrites: ["policy update", "last-admin validation", "usable-identity validation", "Access Audit"],
    afterCommit: []
  },
  {
    operation: "disableIdentity",
    atomicWrites: ["identity state", "final-identity protection", "session revocation marker when supported", "Access Audit", "Notification or outbox event"],
    afterCommit: []
  }
] as const;
