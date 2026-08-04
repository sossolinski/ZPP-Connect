# Identity and Invitations

This document records the planned production identity and invitation architecture
for ZPP Connect. It is a developer and security architecture note, not
user-facing product copy.

## Goals

ZPP Connect must support two primary authentication methods:

- Microsoft Entra SSO.
- Email and password.

Both methods must authenticate the same canonical ZPP Connect User. The
authentication method must never grant application roles or capabilities by
itself.

Authorization is resolved exclusively from:

- canonical User ID;
- Role assignments;
- Role scope;
- User grants;
- User denies;
- account status.

## Identity Provider Strategy

Prefer Microsoft Entra as the identity control plane for both authentication
methods:

- Microsoft Entra workforce authentication for corporate SSO users.
- Microsoft Entra External ID local accounts for approved email/password users.
- One External ID experience federated with the corporate Entra tenant where that
  architecture is appropriate.

Do not build a custom production password store inside ZPP Connect unless a later
security decision explicitly requires it.

ZPP Connect must not store:

- plaintext passwords;
- encrypted passwords;
- password hashes when password authentication is delegated to Entra External ID;
- password reset tokens from the provider.

Password creation, password reset and MFA enforcement should occur in the
configured identity provider.

## Authentication Policies

Each User account must have an explicit authentication policy.

Supported policies:

- `SSO_ONLY`;
- `PASSWORD_ONLY`;
- `SSO_OR_PASSWORD`.

Recommended defaults:

- corporate users: `SSO_ONLY`;
- approved external users: `PASSWORD_ONLY`;
- dual authentication: exceptional and explicitly approved;
- System Admin accounts: preferably `SSO_ONLY`.

A corporate-domain User configured as `SSO_ONLY` must not be able to create a
local ZPP Connect password.

## Canonical Users and Linked Identities

The application User is the canonical account used by authorization, audit and
operational ownership. Email is an attribute, not the ownership foreign key.

Add a provider-neutral User Identity model with these fields:

- stable ID;
- canonical User ID;
- provider type;
- tenant or realm identifier;
- provider subject identifier;
- authentication method;
- email snapshot;
- linked timestamp;
- last successful authentication timestamp;
- disabled timestamp.

The authoritative external identity reference is:

- provider type;
- tenant or realm identifier;
- provider subject identifier.

A User may have more than one linked identity only when explicitly permitted by
policy or by an audited administrative/account-linking flow.

## Login Experience

The production login screen should support:

- Continue with Microsoft;
- email;
- password;
- Sign in;
- Forgot password.

Domain or account discovery rules:

- known corporate domains route to Microsoft SSO;
- approved external local accounts use email and password;
- `SSO_ONLY` accounts never receive a password prompt;
- `PASSWORD_ONLY` accounts are not redirected to corporate SSO;
- generic sign-in failures do not reveal whether an account exists.

Do not expose tenant IDs, provider subjects, storage architecture or identity
provider implementation details in ordinary product UI.

## Invitation Workflow

When inviting a User, an authorized System Admin selects:

- display name;
- invited email;
- authentication policy;
- initial Roles;
- Role scopes;
- optional Member Profile;
- optional invitation expiry.

Invitation acceptance must activate the existing Pending User. It must not create
duplicate canonical Users or change Roles beyond what the authorized inviter set.

### SSO Invitation Acceptance

Acceptance requires:

1. a valid invitation;
2. successful Microsoft authentication;
3. permitted tenant;
4. matching or administratively approved identity;
5. creation of a User Identity link;
6. activation of the existing Pending User.

### Password Invitation Acceptance

Acceptance requires:

1. a valid invitation;
2. verification of the invited email;
3. password creation through the configured identity provider;
4. optional or required MFA registration;
5. creation of the User Identity link;
6. activation of the existing Pending User.

The administrator must never create, view or send the User's password.

## MFA Policy

Support an explicit MFA requirement. Recommended policy:

- System Admin: required;
- ZPP Coordinator: required;
- TEC Coordinator: required;
- ZPP Group Leader: required;
- TEC Group Leader: required;
- other Users: configurable, preferably required.

MFA enforcement should occur in the identity provider. ZPP Connect should consume
provider assurance signals, enforce application entry decisions and audit
security-relevant outcomes. Do not implement custom SMS or authenticator
verification inside ZPP Connect.

## Password Reset

Password reset must be handled by the configured identity provider.

ZPP Connect may:

- provide a Forgot password entry point;
- redirect to the correct provider flow;
- record a non-sensitive security event where appropriate.

ZPP Connect must not:

- generate temporary passwords;
- email passwords;
- store password-reset tokens from the provider;
- allow an administrator to view or set another User's password.

## Persistence Model Freeze

The PostgreSQL schema-freeze must account for these models:

- `User`;
- `UserIdentity`;
- `UserInvitation`;
- `UserRoleAssignment`;
- `UserCapabilityOverride`;
- `AccountSession` or a session-revocation generation;
- `AccessAudit`;
- `EmailOutbox`;
- `AuthenticationPolicy`.

The schema must not include application-owned password hashes when password
authentication is delegated to Entra External ID.

### User

Required planning fields:

- stable ID;
- display name;
- primary email snapshot;
- account status;
- authentication policy;
- MFA requirement;
- organization;
- optional Member Profile link;
- created/updated timestamps.

Account status is checked after successful provider authentication. Suspended and
Archived Users cannot enter the application.

### UserIdentity

Required planning fields:

- stable ID;
- canonical User ID;
- provider type;
- tenant or realm identifier;
- provider subject identifier;
- authentication method;
- email snapshot;
- linked timestamp;
- last successful authentication timestamp;
- disabled timestamp.

Unique constraints must prevent one external identity from linking to more than
one canonical User. Linking a second identity requires an authenticated and
audited flow.

### UserInvitation

Required planning fields:

- stable ID;
- invited email;
- invited display name;
- authentication policy;
- target User ID;
- initial Role assignment payload;
- optional Member Profile link;
- expiry timestamp;
- accepted timestamp;
- revoked timestamp;
- inviter User ID.

Invitation acceptance cannot change Roles or create duplicate canonical Users.

### AccessAudit

All security-sensitive identity events create immutable Access Audit, including:

- invitation created, accepted, expired or revoked;
- authentication policy changed;
- identity linked, disabled or unlinked;
- Role assignment changed;
- explicit grant or deny changed;
- account status changed;
- session revoked.

Audit entries must not include passwords, provider reset tokens or secrets.

## Required Security Behavior

- Account status is checked after successful authentication.
- Suspended and Archived Users cannot enter the application.
- Invitation acceptance cannot change Roles.
- Authentication method cannot add capabilities.
- SSO and password identities cannot create duplicate canonical Users.
- Changing email does not silently transfer identity.
- Linking a second identity requires an authenticated and audited administrative
  or account-linking flow.
- All identity linking and unlinking creates immutable Access Audit.
- Removing the last usable identity from an active User requires confirmation.
- System Admin authentication-policy changes require elevated authority.
- Generic sign-in failure does not reveal account existence.

## Required Test Coverage

Future implementation must cover:

1. SSO-only User cannot authenticate with password.
2. Password-only User does not obtain SSO access automatically.
3. Dual-policy User may use either linked identity.
4. Both identities resolve to the same canonical User ID.
5. Authentication method does not change effective capabilities.
6. Suspended User is rejected after successful provider authentication.
7. Archived User is rejected.
8. Corporate-domain SSO invitation activates the intended User.
9. Password invitation activates the intended User.
10. Invitation cannot create a duplicate canonical User.
11. Password is never returned through API or Audit.
12. Administrator cannot set or view a User password.
13. Changing authentication policy creates Access Audit.
14. Linking and unlinking identity creates Access Audit.
15. Last usable identity protection works.
16. MFA-required Role cannot enter without the required provider assurance.
17. Generic sign-in failure does not reveal account existence.
18. Password reset uses the configured provider flow.

Browser tests should also verify that ordinary UI does not expose provider
subjects, tenant IDs, storage architecture or implementation details.
