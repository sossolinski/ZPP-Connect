# Stage 3E3 Access Hardening

## Baseline

- `npm run test:smoke`: passed, 48 tests.
- `npm audit --omit=dev`: passed, 0 production vulnerabilities.

## Current State Audit

The current access administration module has canonical user accounts with stable IDs, display names, email, department, organization, account status, optional member profile link, timestamps and optimistic versions. Account statuses are Pending, Active, Suspended and Archived.

Roles are defined as protected default roles or custom roles. Role assignments can be global or group-scoped, and group compatibility is validated on the server. Capability overrides are explicit Grants or Denies. Active Deny overrides Role and Grant permissions. Expired or revoked overrides have no effect.

Effective access is calculated server-side from the canonical user ID, active role assignments, validated scopes, active grants and active denies. The frontend displays this result but does not calculate final permissions.

Member Profile linkage uses stable member profile IDs. Relinking clears the previous member link and records the historical ownership in Access Audit.

The current application does not have a real server-side account-session store capable of invalidating active browser sessions. The previous session-revocation endpoint only recorded a flag and did not revoke a session. Stage 3E3 disables that endpoint and removes the production-oriented UI action until real session invalidation exists.

Access Audit is append-only through the exposed API. Existing operational audit and timeline routes do not support update or delete. Access administration now uses explicit audit actions for user lifecycle, metadata changes, member linkage, role assignment, role scope changes, role revocation, custom role changes, capability deltas, grants, denies and override revocation.

Access notifications remain best-effort side effects. A notification failure must not roll back the authoritative access mutation.

The current development user simulation is only an authentication convenience for local training and tests. It must not be exposed as storage architecture in normal product UI or product copy.

The existing Prisma schema remains unchanged in this stage. No database adapter, migration, Microsoft Entra integration, password flow, invitation delivery or email sender was started.

## Frozen Contracts

`packages/shared/src/access-contracts.ts` defines persistence-ready contracts for:

- User;
- User Identity;
- Authentication Policy;
- User Invitation;
- Role Assignment;
- Capability Override;
- Account Session;
- Access Audit;
- Email Outbox.

Authentication policies are `SSO_ONLY`, `PASSWORD_ONLY` and `SSO_OR_PASSWORD`. They are separate from authorization and cannot grant Roles or capabilities.

User Identity ownership uses provider type, realm ID and provider subject. Email is only a snapshot, not an ownership key. User Identity records do not contain Roles or capabilities.

User Invitation records store a token hash only. Repository reads do not return raw tokens, and invitation acceptance cannot change Roles.

Email Outbox records store only non-sensitive template variables. Raw invitation tokens, passwords, OAuth tokens and provider secrets are excluded.

## Repository And Service Boundaries

The contract file defines repository interfaces for users, roles, role assignments, capability overrides, account sessions and access audit. It also defines future interfaces for user identities, invitations and email outbox.

Access Audit repositories are append-only: list and append are supported, update and delete are not.

Future service contracts are defined for identity resolution, invitation handling, authentication-policy changes and email outbox handling. These services own validation, policy decisions and Access Audit creation. Routers should not contain storage-specific behavior.

## Atomic Operation Matrix

Future PostgreSQL transactions must cover:

- prepare invitation: Pending User, initial Role assignments, optional Member Profile link, User Invitation, Access Audit;
- send or resend invitation: invalidate previous generation, store new token hash, update invitation status, append Email Outbox, Access Audit;
- accept invitation: consume invitation, link User Identity, activate User, Access Audit;
- change authentication policy: policy update, last-admin validation, usable-identity validation, Access Audit;
- disable identity: identity state, final-identity protection, session revocation when supported, Access Audit, notification or outbox event.

Email delivery happens after commit.

## Stage 4A Implications

Stage 4A can add a database adapter against these contracts without changing user-facing semantics. It must preserve append-only audit behavior, optimistic concurrency, stable IDs, provider-subject identity ownership, token-hash invitation lookup, non-sensitive outbox payloads and last-administrator protection based on effective access.

Before exposing invitation or password-related UI, Stage 4A must implement the corresponding identity-provider and email flows end to end.

## Final Validation

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test`: passed, 52 tests.
- `npm run build`: passed.
- `npm run test:smoke`: passed, 48 tests.
- `npm audit --omit=dev`: passed, 0 production vulnerabilities.

The temporary local backend architecture, future database adapter plan and session-revocation limitation are documented here for developers only. Normal product UI does not expose data-source labels, demo storage language, invitation delivery promises, password-management actions or fake session-revocation controls.
