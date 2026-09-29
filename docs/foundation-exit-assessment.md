# Foundation Exit Assessment

Date: 2026-09-29  
Assessed baseline: Foundation Stages 1–25

## Verdict

There are **no unresolved FOUNDATION BLOCKER items**. The architecture has durable
PostgreSQL authority, explicit production composition, incident-scoped access, auditable
high-consequence transitions, integrity-checked retained artifacts, verified recovery and
a deliberately narrow product boundary. Foundation may end after Stage 25.

## Domain foundation

| Area | Foundation assessment |
| --- | --- |
| Incidents/Sessions | Durable REAL incident lifecycle, assignment scope, concurrency and read-only terminal states |
| Operational roles | Protected role catalogue, scoped assignments, EffectiveAccess, explicit grants/denies and account lifecycle |
| Documents | Versioned publication, targeting, acknowledgement snapshots and content digests |
| Notifications | Durable projection/outbox delivery with bounded processing and user read state |
| Briefings | PostgreSQL draft/publish/history authority tied to the selected incident |
| Imports | Validated batches, durable rows, explicit confirmation and provenance |
| Reports/exports | Bounded server generation with disclosure and generation provenance |
| Post-Incident Reporting | Versioned AAR review/approval/revision plus immutable, rehashed retained PDFs |
| Incident evidence | REAL-only upload, typed PostgreSQL metadata/bytes, SHA-256 download verification and tombstone withdrawal |

## Security and access

Production startup requires Entra configuration and PostgreSQL. Development identity routes
are unavailable in production. Canonical users, role assignments, capability overrides and
incident assignments feed EffectiveAccess. Collection permission and resource scope are
both enforced server-side; UI visibility is only a convenience. Audit attribution comes
from authenticated server context rather than client actor fields.

Remaining identity-provider tenant setup, MFA/Conditional Access rules, secret rotation,
network policy and formal privacy approval are **DEPLOYMENT/INFRASTRUCTURE** or
**BUSINESS/POLICY DECISION**, not missing application foundations.

## Data integrity

Twenty-four forward-only migrations define constraints, indexes, foreign keys and database
triggers. High-consequence histories use versions, idempotent operation records and
immutable terminal evidence. Documents, approved AAR content, retained PDFs, backups and
incident evidence use cryptographic hashes at the boundaries where exact content must be
verified. Audit and timeline records are durable and actor-attributed.

The repository preserves dormant legacy Training/Exercise schema rather than destructively
rewriting history. Current production grants, routes, UI and composition do not activate it.

## Resilience

Stage 23 backup tooling creates a secret-free sidecar manifest and consistent custom-format
PostgreSQL snapshot. Stage 25 includes evidence bytes and metadata in that same recovery
unit. Verification checks archive hash/catalog/tool compatibility; restore requires an
empty isolated target and matching migration identities; the bounded integrity scanner
checks application-level digests and evidence references. Liveness and database readiness
are distinct. Backup, restore and integrity runbooks describe execution and failure policy.

The automated rehearsal proves a fresh source, backup verification, clean restore, exact
AAR/evidence byte recovery, intentional evidence corruption rejection, final integrity and
targeted cleanup.

## Product boundary

- Training Management: absent from active permissions, routes, navigation and product API.
- Exercise Management: absent from active permissions, routes, navigation and product API.
- Organisational Readiness: absent from active permissions, routes and UI.
- Technical database readiness remains at `/api/health/readiness`.
- Historical schema/data remains preserved for audit and older recovery points.

## Operational deployability

Production builds compile API and web artifacts. Runtime configuration validates
persistence/authentication and evidence size limits. PostgreSQL is the production data and
evidence authority; `DATA_DIR` is not. Pino logging redacts known sensitive fields. Entra-
mode startup, health, readiness and disabled development-auth checks pass. Backup tooling
requires PostgreSQL native clients and an external secure destination/scheduler.

## Remaining-item classification

### FOUNDATION BLOCKER

None.

### NORMAL PRODUCT BACKLOG

- richer dashboards, advanced search, mobile and visual refinements;
- configurable evidence categories and optional preview/OCR;
- an approved bounded evidence manifest/export package;
- additional reports and workflow refinements;
- optional malware-scanning provider integration and quarantine UX;
- frontend bundle code-splitting optimization.

### DEPLOYMENT/INFRASTRUCTURE

- Entra tenant/application setup, MFA/Conditional Access and secret rotation;
- TLS, DNS, firewall/network policy and database high availability;
- encrypted off-host backup store, scheduler, monitoring and restore calendar;
- capacity planning for PostgreSQL BYTEA evidence, alerting and RPO/RTO measurement;
- centralized log transport and security operations integration.

### BUSINESS/POLICY DECISION

- authorization to process real operational/personal data and privacy impact approval;
- evidence/Audit/record retention durations, legal holds and physical purge approval;
- accepted RPO/RTO and recovery ownership;
- evidence authenticity/signature requirements and malware disposition policy;
- export/disclosure approval and recipient controls.

These are real delivery concerns, but none requires another numbered Foundation stage.

