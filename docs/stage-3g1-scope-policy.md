# Stage 3G1 Scope Policy

This document is the server-side authorization contract for ZPP Connect. It is
developer documentation and must not be surfaced as product copy.

## Decision model

Every request is evaluated from the canonical authenticated user, active role
assignments, capability keys and access overrides. Client-provided role names,
member IDs and group IDs are never treated as proof of access.

- `GLOBAL`: the capability applies to every record in its domain.
- `GROUP`: the capability applies only to the assigned group IDs and, where the
  domain is member-owned, members of those groups.
- Personal access: a linked member can access their own record where the domain
  explicitly supports self-service.
- `DENY`: removes the capability before scope is evaluated and overrides role
  grants.
- Multiple assignments are additive only after all deny overrides are applied.
- A group-scoped assignment never becomes global because a custom role
  definition is missing or incomplete.

The API filters lists and searches to the same scope used for detail and
mutation requests. Knowing a record ID must not widen access.

## Domain ownership

| Domain | Ownership and scope |
| --- | --- |
| Groups | Group-owned. Group leaders see and manage only assigned groups. |
| Member profiles | Personal or group-owned. Members see themselves; group leaders see assigned-group members; global managers see all. |
| Enquiries | Session-wide and capability-restricted. There is no canonical group relation, so group scope does not grant access. |
| Family/NOK | Session-wide and capability-restricted. There is no canonical group relation, so group scope does not grant access. |
| Passenger/SRC | Session-wide and capability-restricted. There is no canonical group relation, so group scope does not grant access. |
| Matching, holds and release | Session-wide and capability-restricted. Group membership does not grant case access. |
| Requests | Session-wide and capability-restricted. Group membership does not grant case access. |
| Timeline | Session-wide and capability-restricted. |
| Assignments | Mixed ownership. Access can derive from an assigned group, the assignee's member profile or a global management capability. |
| Rostering | Group and member-owned. Mutations require an explicit active, writable session. |
| Availability | Member-owned. Self-service, assigned-group management or global management only. |
| Training | Course catalogue access follows capability grants. Records and targeted requirements are personal or group-owned; role-wide requirement management is global only. |
| Documents | Catalogue management is global. Requirements, acknowledgements and compliance are personal or group-owned where a canonical target exists. |
| Readiness | Derived only from source records already visible to the actor. Personal, group and global summaries retain the source scope. |
| Notifications | Recipient-scoped and derived from records the recipient can access. Notifications do not grant access to their source entity. |
| Operational briefing | Session-wide and capability-restricted. Group leaders may receive read/history access without briefing mutation authority. |
| Dashboard | A derived view. Each KPI and queue is omitted unless its authoritative source endpoint is directly permitted. |
| Reports and exports | Global capability plus explicit session and source-domain permission. Group leaders do not receive session-wide exports. |
| Imports | Global import capability plus an explicit writable session. Stage 3G1 supports manifest CSV only. |
| Audit | Restricted security domain. Operational roles do not gain audit access through group membership. |

## Dashboard role policy

Dashboard output is assembled from permitted sources, not generated first and
redacted later.

| Role | Dashboard policy |
| --- | --- |
| System Admin | Configuration and security administration only unless a separate operational role is assigned. No case detail from the admin role alone. |
| ZPP Coordinator | Global ZPP operational overview according to assigned capabilities. |
| TEC Coordinator | Global TEC operational overview according to assigned capabilities. |
| ZPP Group Leader | Personal and assigned-group work only. No session-wide case queues without a separate global operational grant. |
| TEC Group Leader | Personal and assigned-group work only. No session-wide case queues without a separate global operational grant. |
| ZPP Member | Personal work only. |
| TEC Member | Directly permitted enquiry, family and request sources only; no passenger, matching, hold or release data. |
| Observer | Only directly permitted high-level or personal sources; no implied case detail. |
| Incident Auditor | Audit access does not imply operational case or dashboard access. |

An empty Dashboard section is valid when the actor has no directly authorized
source. It must not be backfilled with global sample data.

## HTTP behavior

- `400 Bad Request`: missing or invalid input, unsupported import/export type,
  missing session ID or malformed CSV contract.
- `401 Unauthorized`: no valid authenticated identity.
- `403 Forbidden`: authenticated actor lacks the capability or canonical scope.
- `404 Not Found`: an in-scope lookup target or explicit session does not exist.
- `409 Conflict`: the target session is not writable, an import is already
  confirmed or a lifecycle transition conflicts with current state.
- `501 Not Implemented`: a deliberately visible but disabled export format has
  no implementation.

Out-of-scope list and search requests return only in-scope records. Direct
detail and mutation requests to a known out-of-scope record return `403`.

## Session, import and export contract

- Every operational mutation uses an explicit session ID.
- Rostering create, update and lifecycle actions require an active writable
  session; there is no hidden default session.
- Reports and exports are scoped to the requested session, including historical
  closed sessions.
- Every CSV export type has its own source query and authorized column set.
- Operational CSV output excludes internal IDs, actor IDs and metadata blobs.
- CSV encoding must quote commas, quotes and line breaks correctly.
- Manifest import accepts CSV only, validates rows before confirmation and
  rejects repeat confirmation.
- Import confirmation writes through the API and produces an audit event.

## Verification matrix

Stage 3G1 automated coverage must retain these negative-path checks:

1. Admin-only, group-leader, member and observer Dashboard responses contain no
   unauthorized case identifiers or names.
2. A Group A leader cannot list, search, read or mutate Group B or its members.
3. The Group A/B boundary is also enforced in Rostering, Availability,
   Training, Documents, Readiness and Assignments.
4. Group leaders cannot use session reports or exports.
5. System Admin without an operational role receives an empty operational
   report rather than case data.
6. Export types are distinct, session-contained and free of internal metadata.
7. Manifest import rejects unauthorized actors, unknown types, non-CSV files,
   invalid rows and duplicate confirmation.
8. Rostering mutations reject missing, unknown and non-writable sessions.
9. Browser smoke tests confirm that scoped UI lists contain no Group B records,
   only Manifest CSV is offered and operational session labels remain visible.

The current repository adapter is process-local during development. That
implementation detail may be discussed in source code, tests and developer
reports, but must never appear in the product interface.
