# ZPP Connect Foundation Completion Report

Date: 2026-09-29

## Completion statement

**Foundation Stages 1 through 25 are complete.** No unresolved Foundation blocker remains,
and no Stage 26 is recommended. Subsequent work should be managed as product backlog,
deployment/infrastructure delivery or explicit business/policy decisions.

## What the Foundation established

The programme moved the portal from broad demo-compatible flows to an explicit production
architecture: PostgreSQL owns operational state; production routes compose typed services
and repositories; REAL incidents and assignments define the resource boundary; server-side
RBAC and Entra-mode identity protect access; high-consequence commands use versioning,
idempotency, audit and immutable history.

Completed domain slices cover Sessions, intake, passenger/family records, matching,
controlled release, welfare requests, assignments, member/group directory, rostering,
documents, notifications, administration/identity, active-event briefings, imports,
exports/reports, dictionary authority, AAR/PDF evidence, platform recovery, product-scope
cleanup and secure REAL-incident evidence.

## Current product boundary

The active product is an internal real-incident family-assistance and reunification portal.
Training, Exercise and organisational Readiness are not product modules. Their historical
database structures remain dormant to preserve audit and backup compatibility. Technical
service readiness remains an operational endpoint.

## Security and integrity posture

Production requires Entra authentication and PostgreSQL. EffectiveAccess combines current
user/role state with resource scope; protected routes independently enforce permissions and
incident assignment. Audit actor/provenance is server-owned. Database constraints, version
tokens, immutable operation/history rows and transaction boundaries defend durable state.
Content hashes protect published document acknowledgement context, approved AAR content,
retained PDFs, backup archives and incident-evidence bytes. Hashes are integrity controls,
not digital signatures.

## Resilience posture

The application provides strict backup manifests, consistent PostgreSQL snapshots,
pre-restore verification, empty-target restore, migration/count checks and a bounded
application integrity scanner. The recovery rehearsal restores meaningful incident, Audit,
AAR/PDF and incident-evidence records/bytes and proves corruption rejection. Runbooks cover
backup, restore, integrity, retention boundaries and failure handling.

## Test posture at completion

- clean dependency install, Prisma generate/validate, lint/typecheck and production build;
- 127/127 unit tests;
- fresh 24-migration deploy/seed and 270/270 Foundation PostgreSQL tests;
- 14/14 focused evidence PostgreSQL tests;
- 62/62 baseline Playwright smoke tests plus 2/2 PostgreSQL evidence workflow tests;
- backup/restore/evidence-corruption rehearsal PASS;
- production PostgreSQL/Entra startup and readiness PASS;
- production dependency audit: 0 vulnerabilities.

CI repeats fresh deploy/seed/startup, the complete PostgreSQL gate, dedicated Stage 25
tests, recovery rehearsal, browser workflow and unsuppressed production audit.

## Known limitations and next ownership

Normal product backlog includes richer UX/search/reporting, configurable evidence
categories, optional scanning integration and a policy-approved evidence export manifest.
Deployment owners must provide Entra tenant policy, secrets, TLS/networking, PostgreSQL
operations, monitoring and encrypted off-host backup automation. Business owners must
approve real-data use, retention/legal hold/purge, RPO/RTO, evidence authenticity and
disclosure rules. The application deliberately does not invent those decisions.

Foundation completion means the product has a coherent, testable and recoverable base. It
does not mean every future feature, infrastructure control or organizational policy is
already delivered.
