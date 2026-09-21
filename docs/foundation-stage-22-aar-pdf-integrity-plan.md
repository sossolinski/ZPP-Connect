# Foundation Stage 22 — AAR / Post-Incident Reporting + PDF Integrity Plan

Status: **IMPLEMENTED — LOCAL GATES PASSED; EXACT-HEAD REMOTE CI PENDING**

This document records the approved Foundation Stage 22 contract. Implementation and final local validation are documented in the [Stage 22 report](foundation-stage-22-aar-pdf-integrity-report.md). The baseline was closed in the [baseline closure](foundation-stage-22-baseline-closure.md). Sections A/B and Q below preserve the original planning-time evidence and decision, not the current blocker. Remote exact-head CI remains pending because push/merge was excluded from this task.

## A. Repository and workspace state

- Fetched `origin` on 2026-09-16. `origin/main` remains `6a5b5d5621533e384a7edc518cbacffb9778c4da`, the Stage 21 merge.
- Active branch: `agent/foundation-stage-22-aar-pdf-integrity`, tracking `origin/main`, with zero commits ahead or behind before this planning document.
- The previous workspace was on `agent/foundation-stage-12-documents` at `a4d8135` and contained an uncommitted 169-line Prisma schema addition plus a 197-line migration draft.
- The draft was confirmed obsolete: merged Stage 12 contains the complete Documents service/router/repository, production wiring, UI, migration, tests, and report. It was not deleted.
- Preserved stash: `2619b110290391049bd6741aab7d774dcee78a85`, message `preserve obsolete pre-Stage-12 document draft before Stage 22 planning`. It includes untracked files.
- Stale metadata for ten missing temporary worktrees was pruned. No reachable branch or commit was deleted.
- A fresh Stage 22 branch was selected from the exact fetched `origin/main` head. No remote history was rewritten and nothing was force-pushed.

## B. Baseline validation

| Check | Result | Classification |
|---|---|---|
| `npm ci` | pass; 445 packages installed from lockfile | clean install |
| Prisma client generation | pass, Prisma 6.19.3 | baseline healthy |
| Prisma schema validation | pass with explicit local `DATABASE_URL` | baseline healthy |
| Fresh migration deployment | pass, 22/22 migrations | baseline healthy |
| Canonical seed | pass | baseline healthy |
| Lint/typecheck | pass | baseline healthy |
| Shared/API/web production build | pass | baseline healthy; existing Vite chunk warning only |
| Unit/memory Vitest | 103/104 | existing calendar-sensitive test defect |
| General browser Playwright | 73/73 | baseline healthy |
| Ordered PostgreSQL Stage 1–21, run 1 | 262/263; Stage 18 `socket hang up` | nondeterministic transport flake |
| Dedicated Stage 18 rerun | 15/15 | pass |
| Ordered PostgreSQL Stage 1–21, fresh run 2 | 262/263; Stage 12 `socket hang up` | nondeterministic transport flake |
| Dedicated Stage 12 rerun | 18/18 | pass |
| Production PostgreSQL/Entra startup | pass | health 200, PostgreSQL reported, Microsoft SSO only, development users 404 |
| Production dependency audit | fail: 3 moderate advisories in Express → `qs` | existing dependency baseline problem |
| `git diff --check` before planning | pass | baseline healthy |

The deterministic unit failure is `uses concrete product timestamps in notifications`. On a September date, `Intl.DateTimeFormat("en-GB", { month: "short" })` returns `Sept`, while the test requires exactly three word characters. No Stage 22 code causes this.

The production audit now reports `qs` advisories through Express/body-parser. Stage 21 recorded zero vulnerabilities at its reviewed SHA, so this is a newly published advisory against the unchanged dependency graph, not a local regression. Stage 22 must not hide it by weakening the audit.

The two PostgreSQL failures were transport-level `socket hang up` errors in different suites. Each affected suite passed immediately in isolation. Existing Stage 18 and Stage 21 reports already record this class of intermittent acknowledgement/concurrency transport failure. No domain assertion failed, but the ordered gate is not considered fully green until one complete fresh run passes.

The temporary database `zpp_stage22_baseline_20260916_2155` and its empty temporary storage directory were removed after validation. No pre-existing local database was modified.

## C. Reusable architecture from Stages 12–21

Stage 22 should reuse these established patterns rather than form a parallel subsystem:

1. **Documents (Stage 12):** root/version separation, draft-only editing, immutable published content, new-version correction, SHA-256 content digest, optimistic concurrency, command fingerprints, operation replay, database constraints, and historical reads.
2. **Notifications (Stage 13):** transactional side effects, allowlisted metadata, bounded background work, durable deduplication, and no sensitive free text in outbox/audit payloads. Stage 22 does not require a notification event for MVP.
3. **Identity/Admin (Stage 14):** `EffectiveAccessService`, global/group role semantics, active deny overrides, incident-aware permission evaluation, protected built-in roles, custom role support, and actor identity from the authenticated server context.
4. **Operational Briefings (Stage 15):** normalized child sections, one mutable draft, deep-copy revision creation, strict parent/child transaction boundaries, status transition commands, immutable historical revisions, Incident ID lookup before authorization, anti-enumeration behavior, and server-provided capabilities.
5. **Imports (Stage 16):** explicit byte limits, SHA-256 provenance, idempotent operation IDs, authoritative server-owned normalized data, safe filenames, and no claim that bytes are stored when they are not.
6. **Exports/Reports (Stage 17):** explicit disclosure schemas, target-Incident authorization at router and service boundaries, `REPEATABLE READ` snapshot semantics, controlled filenames, exact byte size/hash metadata, generation provenance, and truthful artifact delivery semantics.
7. **Exercise evidence (Stage 18):** durable observations, immutable revision snapshots, `includeInAar`, optional source provenance, database triggers protecting evidence, versioned commands, and session-first lock ordering.
8. **Readiness (Stage 19):** complete server-side scope evaluation, no hidden 200-row authority, bounded response pages, explicit safe response models, and no process cache as authority.
9. **Production composition (Stage 20):** one explicit PostgreSQL owner per production route, lazy memory code only in test mode, route collision detection, no compatibility hydration, and fail-closed durable reads.
10. **Admin configuration (Stage 21):** typed policy in code, PostgreSQL state where mutable authority is required, serializable writes, immutable semantic keys, audit in the same transaction, and preservation of historical values.

Existing infrastructure relevant to Stage 22:

- `Session` is the canonical event envelope. Its `mode` distinguishes `REAL`, `EXERCISE`, and `TRAINING`; there is no separate Exercise aggregate. An AAR therefore links to `Session`, not to a new event abstraction.
- `ExerciseObservation` already supplies durable, versioned evidence and an `includeInAar` selection signal.
- `pdfkit` is already a runtime dependency. No new PDF generator is required.
- `ExportGeneration` stores generation metadata but deliberately does not retain bytes. Stage 22 must not pretend those CSV artifacts are replayable.
- `StoredFile` and disk upload helpers are legacy/general structures; the disk uploader is only used by the memory adapter. They do not provide the production authorization, immutability, hashing, or atomicity required for approved AAR artifacts.
- `AuditLog`, production route ownership, Zod validation, shared permissions, React form primitives, confirmation dialogs, and PostgreSQL browser-test conventions are directly reusable.

## D. Stage 22 scope and non-goals

Stage 22 is one vertical slice:

```text
Closed Session
  -> versioned After Action Report
  -> approved immutable report version
  -> retained PDF bytes + artifact provenance
  -> integrity-checked historical download
```

In scope:

- one AAR aggregate per Session;
- real incidents, exercises, and training Sessions;
- draft authoring, review, approval, revision, archive, history, and exact-version PDF generation;
- optional snapshot provenance from selected Exercise Observations;
- PostgreSQL artifact retention and SHA-256 verification;
- current RBAC/effective incident access;
- minimal plain-text UI and bounded lists;
- audit and database integrity controls.

Out of scope:

- rich text, HTML input, Word-like editing, DOCX, PDF/A, digital signatures, PKI, or certificates;
- generic report designer/template editor;
- email/notification delivery;
- corrective-action execution tracking as a new workflow engine;
- automatic document-library publication;
- external object storage or a generic attachment subsystem;
- attachment upload in the Stage 22 MVP;
- rewriting historical Session, Exercise Observation, Briefing, Export, or Document records;
- changing the Stage 17 CSV export contract.

Attachments are deferred because the current production architecture does not contain an integrity-safe, authorized artifact store. Stage 22 must not revive the legacy disk upload route. A future attachment slice can reuse the artifact controls proven here.

## E. Domain model

### `AfterActionReport`

Aggregate identity and lifecycle:

| Field | Type / rule |
|---|---|
| `id` | UUID primary key |
| `operationalId` | unique sequence-backed `AAR-YYYY-NNNNNN` |
| `sessionId` | UUID FK to `Session`, unique: one AAR per Session |
| `ownerId` | UUID FK to active `User`, `RESTRICT` |
| `status` | `Active` or `Archived` |
| `version` | positive optimistic-concurrency integer |
| `createdAt`, `createdById` | required server provenance |
| `updatedAt`, `updatedById` | required server provenance |
| `archivedAt`, `archivedById`, `archiveReason` | coherent nullable archive provenance |

`Session` remains the source-event relation. `Session.mode` identifies a real incident, exercise, or training event. A second nullable `exerciseId` is neither necessary nor valid because no such aggregate exists.

### `AfterActionReportVersion`

Immutable report-content snapshot after approval:

| Field | Type / rule |
|---|---|
| `id` | UUID primary key |
| `reportId` | UUID FK to `AfterActionReport`, `RESTRICT` |
| `revision` | positive integer, unique with `reportId` |
| `basedOnVersionId` | optional self FK to the approved source revision |
| `status` | `Draft`, `Under review`, or `Approved` |
| `title` | 1–500 plain-text characters |
| `eventDate` | required timestamp snapshot, initially derived from Session end/start or explicit input |
| `executiveSummary` | plain text, maximum 50,000 characters |
| `schemaVersion` | controlled value, initially `aar-v1` |
| `contentSha256` | nullable in mutable states; required 64-hex digest in `Approved` |
| `version` | positive optimistic-concurrency integer |
| author/update provenance | `createdAt/By`, `updatedAt/By` |
| review provenance | `submittedAt`, `submittedById` |
| approval provenance | `approvedAt`, `approvedById` |

The author is the version creator. The aggregate owner is separately retained. Responses project only safe actor ID/display name, consistent with Briefings and Exercise.

### Structured version sections

Use normalized child rows, matching the Operational Briefing pattern:

- `AfterActionFinding`: `id`, `reportVersionId`, `sortOrder`, `area`, `summary`, optional `detail`, optional `sourceObservationId`, optional `sourceObservationVersion`, and source observation operational-ID snapshot.
- `AfterActionLesson`: `id`, `reportVersionId`, `sortOrder`, `statement`.
- `AfterActionCorrectiveAction`: `id`, `reportVersionId`, `sortOrder`, `recommendation`, optional bounded `owner`, optional `targetDate`.

Corrective actions in an approved AAR are immutable recommendations/snapshots, not live task records. Stage 22 does not add mutable completion status or silently create Assignments. A later authorized workflow may link or promote a recommendation explicitly.

When an Exercise Observation is selected, the AAR finding copies its relevant text/area/recommendation into the draft and records the source observation ID and source version. Later Observation edits cannot rewrite the report. The service must verify the source Observation belongs to the same Session.

### `AfterActionOperation`

Durable idempotency record following Documents and Exports:

- globally unique UUID `operationId`;
- command and SHA-256 semantic fingerprint;
- optional report/version/artifact references;
- result version and bounded JSON result without PDF bytes or report body text;
- request ID and creation timestamp.

Use it for create, submit, return-to-draft, approve, create-revision, archive, and PDF generation. Reusing one operation ID for a different actor/target/payload returns a controlled 409.

### `AfterActionPdfArtifact`

| Field | Type / rule |
|---|---|
| `id` | UUID primary key and human-visible artifact identifier |
| `operationId` | unique UUID |
| `commandFingerprint` | 64-hex SHA-256 |
| `reportVersionId` | UUID FK to one approved version, `RESTRICT` |
| `sourceContentSha256` | approved AAR content digest |
| `rendererVersion` | controlled template identifier, initially `aar-pdf-v1` |
| `fileName` | controlled safe `.pdf` filename |
| `mimeType` | exactly `application/pdf` |
| `contentSizeBytes` | nonnegative `BIGINT`, bounded by service policy |
| `contentSha256` | 64-hex SHA-256 of exact retained bytes |
| `storageProvider` | exactly `postgres` in Stage 22 |
| `storageKey` | unique controlled identifier, for example `aar-pdf/<artifact UUID>` |
| `content` | PostgreSQL `BYTEA` / Prisma `Bytes`, never returned by metadata queries |
| `generatedAt`, `generatedById`, `requestId` | required provenance |
| `status` | exactly `Ready` |

PostgreSQL byte retention is deliberate for the bounded MVP. It provides restart-safe exact downloads and keeps metadata and bytes in one authority without a filesystem/DB dual-write gap. Set an initial generated-PDF limit of 10 MiB. Capacity and object-storage migration are future operational decisions.

No classification field is added because the repository has no authoritative classification vocabulary or policy.

## F. Lifecycle, versioning, and immutability

Version FSM:

```text
Draft -> Under review
Under review -> Draft       (explicit return for changes)
Under review -> Approved    (terminal content state)
Approved -> terminal
```

Aggregate FSM:

```text
Active -> Archived
Archived -> terminal in Stage 22
```

Rules:

1. A new AAR creates aggregate plus revision 1 Draft atomically.
2. Only Draft content and child rows may be edited. Every PATCH requires `expectedVersion` and replaces/diffs all validated sections in one transaction.
3. Under review is locked against content edits. Returning it to Draft is an explicit audited command.
4. Approval requires Under review, non-empty title/executive summary, at least one finding or lesson, coherent child ordering, and `expectedVersion`.
5. Approval computes canonical `aar-v1` JSON over all report fields and ordered sections, stores `contentSha256`, approval actor/time, and commits Audit in the same transaction.
6. Approved versions and all children are immutable at service and database-trigger layers. UPDATE/DELETE must fail even through direct SQL. The artifact relation does not mutate the version.
7. A later revision is created only from the latest Approved revision, deep-copies every section, sets `basedOnVersionId`, and allocates `max(revision)+1` under a report lock.
8. A partial unique index permits at most one mutable (`Draft` or `Under review`) revision per report.
9. Historical approved revisions remain Approved; they are not relabelled or overwritten when a later revision is approved.
10. Archive is allowed only when no mutable revision exists. It archives the aggregate without mutating versions or artifacts.
11. Content commands are permitted only while the source Session is `Closed`. Archived Session data remains readable; approved PDFs may still be generated/downloaded, but no report content changes are allowed.
12. Session-first, report-second, version-third lock order serializes report commands with Session archival and concurrent writers.

## G. Authorization and default roles

Add permissions to the existing shared `Permission` registry:

- `aar:read`
- `aar:create`
- `aar:update-draft`
- `aar:review`
- `aar:approve`
- `aar:archive`
- `aar:pdf:generate`

Default grants:

| Role | Read/history/download | Create/edit | Submit/return | Approve | Generate PDF | Archive |
|---|---:|---:|---:|---:|---:|---:|
| ZPP Coordinator | yes | yes | yes | yes | yes | yes |
| TEC Coordinator | yes | yes | yes | yes | yes | yes |
| System Admin | no content grant by default; Audit remains available | no | no | no | no | no |
| Group Leaders | no incident-wide AAR grant by default | no | no | no | no | no |
| Members | no | no | no | no | no | no |
| Observer | no | no | no | no | no | no |

Custom Roles and permission overrides continue to use Stage 14 policy. No second authorization mechanism is introduced.

Every route requires `session:read` plus the relevant AAR permission through `IncidentPermissionGate`. The service re-evaluates effective permissions inside state-changing transactions. ID routes resolve `artifact/version/report -> sessionId` before authorization and convert inaccessible/not-found results to the same 404 response. GROUP scope never expands to an incident-wide AAR unless the current effective-access policy explicitly grants the permission for that Incident.

PDF generation requires `aar:read + aar:pdf:generate`; metadata/download requires `aar:read`. Generic `export:create` is not a substitute for AAR authority.

## H. Proposed API and service boundary

Create one production-only module:

```text
modules/after-action-reports/
  after-action-report-types.ts
  after-action-report-router.ts
  prisma-after-action-report-service.ts
  aar-pdf-renderer.ts
```

The Prisma service is the only production authority and is mounted as owner `after-action-reports` in the Stage 20 route registry.

Proposed endpoints:

| Method/path | Purpose | Permission |
|---|---|---|
| `GET /after-action-reports` | bounded Session/status/search list | `aar:read + session:read` |
| `POST /after-action-reports` | create aggregate and revision 1 | `aar:create + session:read` |
| `GET /after-action-reports/:id` | current summary and capabilities | `aar:read + session:read` |
| `GET /after-action-reports/:id/versions` | bounded revision history | `aar:read + session:read` |
| `GET /after-action-report-versions/:id` | exact version and sections | `aar:read + session:read` |
| `PATCH /after-action-report-versions/:id` | edit Draft with `expectedVersion` | `aar:update-draft + session:read` |
| `POST /after-action-report-versions/:id/submit` | Draft → Under review | `aar:review + session:read` |
| `POST /after-action-report-versions/:id/return-to-draft` | Under review → Draft | `aar:review + session:read` |
| `POST /after-action-report-versions/:id/approve` | Under review → Approved | `aar:approve + session:read` |
| `POST /after-action-reports/:id/revisions` | clone latest Approved to new Draft | `aar:create + aar:update-draft + session:read` |
| `POST /after-action-reports/:id/archive` | archive aggregate | `aar:archive + session:read` |
| `GET /sessions/:sessionId/aar-source-observations` | bounded eligible Observation choices | `aar:create + exercise:manage + session:read` |
| `POST /after-action-report-versions/:id/pdf-artifacts` | generate and retain exact PDF | `aar:read + aar:pdf:generate + session:read` |
| `GET /after-action-report-versions/:id/pdf-artifacts` | bounded artifact metadata | `aar:read + session:read` |
| `GET /after-action-pdf-artifacts/:id` | artifact metadata/hash | `aar:read + session:read` |
| `GET /after-action-pdf-artifacts/:id/download` | verify and stream retained bytes | `aar:read + session:read` |

All command bodies are strict Zod schemas, reject client provenance/lifecycle fields, use UUID `operationId`, and use positive `expectedVersion` where state already exists. Lists use `limit <= 200`, offset, deterministic tie-break ordering, and complete server totals.

The existing `/exports/aar-draft` compatibility request should remain an honest 501 during Stage 22; it must not become an alias for an approved AAR. The UI removes the misleading disabled draft-export action and links to the new domain workflow.

## I. PDF integrity pipeline

```text
approved AAR version
  -> load canonical immutable snapshot
  -> verify stored source content SHA-256
  -> render with aar-pdf-v1 using existing PDFKit
  -> calculate exact byte length and SHA-256
  -> atomically persist bytes + artifact metadata + operation + Audit
  -> return artifact metadata
  -> later download re-hashes retained bytes before response
```

Generation rules:

- Only Approved versions can generate artifacts.
- Allocate the artifact UUID before rendering so it can appear in the PDF.
- The PDF body includes report operational ID, revision, Approved status, artifact ID, source Session operational ID/mode/event type, event date, title, owner/author/approver display snapshots, approval time, generation time, executive summary, ordered findings, lessons, and corrective actions.
- Render plain text only. Never interpret report content as HTML or PDF markup.
- Use built-in fonts and a fixed template/version. No network resources, external URLs, or dynamic fonts.
- Enforce section and 10 MiB final-byte limits before persistence.
- SHA-256 covers the exact final bytes stored and downloaded. `sourceContentSha256` separately binds the artifact to canonical AAR content.
- Store the exact bytes; downloads never regenerate.
- Metadata/list queries use explicit Prisma `select` clauses that exclude the `content` column.
- Download recomputes SHA-256 and size from retained bytes. A mismatch returns a controlled server-integrity error and never serves corrupted bytes.
- Response headers include controlled `Content-Type`, `Content-Disposition`, `Content-Length`, `Cache-Control: no-store, no-transform`, artifact ID, and SHA-256 metadata.
- A generated Audit records only structural identifiers, revision, renderer version, hashes, size, operation ID, and request ID; it does not copy report text.
- No digital signature, certificate, or claim of non-repudiation is made. Stage 22 proves byte integrity against durable metadata only.

## J. Minimal frontend

1. Keep Reports as the navigation entry and add `aar:read` as an alternative route capability.
2. Replace the disabled “Exercise/AAR draft” export card with an “After Action Reports” card linking to `/reports/after-action`.
3. Add an AAR overview page scoped to the selected Session, with truthful empty/loading/error states and server totals.
4. Use existing `Card`, `Table`, `Drawer`/dialog, `Field`, `Input`, `Textarea`, `StatusBadge`, and confirmation patterns.
5. Editor sections: Overview, Executive Summary, Findings, Lessons Identified, Corrective Actions / Recommendations, Versions, PDF Export.
6. Do not show an Attachments editor in Stage 22. Do not imply storage that does not exist.
7. Use plain textareas and simple add/remove/reorder controls. No rich-text editor.
8. Preserve unsaved input on validation, 409, and 500 errors. Show stale-version guidance and require reload/review.
9. Lifecycle buttons are explicit confirmation actions: Submit for review, Return to draft, Approve, Create revision, Archive, Generate PDF.
10. Approved/history views are read-only. Artifact rows show generated time/by, file size, renderer version, and hash with Download.
11. Do not reuse the generic `activeSessionWritable` UI flag: AAR content is intentionally writable only for a server-confirmed Closed Session. Return server capabilities and use them as the UI authority.

## K. Migration strategy

1. Add one new migration after the existing 22 migrations; do not edit predecessor migrations.
2. Add the five AAR tables, sequence, foreign keys, checks, scoped indexes, operation uniqueness, and partial unique index for one mutable revision.
3. Add triggers that reject UPDATE/DELETE of Approved versions and their child rows, and UPDATE/DELETE of PDF artifact rows/bytes.
4. Add coherent-state checks for review/approval/archive provenance, positive versions/revisions/order, safe filenames, MIME/status constants, hash formats, and nonnegative/bounded sizes.
5. Add relations to `Session` and `User`; use `RESTRICT`/`SET NULL` only where historical semantics explicitly allow it. Report/version/artifact identity must not cascade away with ordinary user lifecycle changes.
6. Create no AAR backfill. The unavailable `aar-draft` export and historical Session summaries are not evidence from which approved reports may be fabricated.
7. Do not seed fake production AAR history. Dedicated tests create their own records. If a UI demo fixture is required later, it must be explicitly marked seed provenance and must not masquerade as migrated history.
8. Rehearse exact Stage 21 → Stage 22 migration with representative Stage 12–21 data, then verify all existing counts, IDs, hashes, and lifecycle evidence survive unchanged.

## L. Test strategy

### Domain/service and PostgreSQL integration

- create one AAR for a Closed REAL Session and one for a Closed EXERCISE Session;
- reject duplicate report per Session and non-Closed content mutations;
- select same-Session Exercise Observations and reject cross-Session sources;
- edit Draft sections with optimistic concurrency and one-winner races;
- submit, return, resubmit, approve, and reject illegal transitions;
- reject every approved parent/child UPDATE and DELETE through service and direct SQL;
- create a revision, prove deep-copy fidelity, edit it without changing the approved base, and retain complete history;
- archive only with no mutable revision and preserve reads/artifacts;
- operation replay/misuse, rollback at entity/Audit/artifact seams, restart, and multi-instance consistency;
- session archive versus AAR mutation serialization;
- 1,005-report/history metadata paging where relevant, with no hidden 200-row authority.

### RBAC/security

- unauthenticated 401;
- wrong role 403 on collection routes;
- inaccessible ID and nonexistent ID both 404;
- GLOBAL and custom Role grants;
- active DENY, revoked/expired override, role revocation, and archived user behavior;
- GROUP Incident A cannot access Incident B;
- System Admin does not gain report content merely from `admin:manage`;
- server service recheck prevents route-only authorization races;
- Audit and errors contain no report free text or PDF bytes.

### PDF integrity

- PDF begins with a valid PDF header and renders the explicit `aar-pdf-v1` view model;
- content assertions cover report ID, revision, Approved status, Session reference, generation date, and every section;
- exact byte size and SHA-256 equal persisted metadata;
- artifact points to one Approved version and its `sourceContentSha256`;
- same operation retry returns the same committed artifact; payload reuse conflicts;
- historical artifacts remain byte-identical after a later report revision;
- download returns retained bytes, controlled headers, and recomputed integrity;
- deliberate database-byte corruption is detected and bytes are not served;
- metadata/list queries do not load or serialize content bytes;
- over-limit generation returns controlled 413 and commits no artifact/Audit.

Use the existing PDFKit runtime dependency. Prefer testing a pure renderer view model plus a reliable test-only PDF text extraction path. Add no new runtime dependency; if byte-level content extraction cannot be reliable with existing tooling, justify one narrowly scoped dev dependency in its own reviewed commit.

### Frontend and regression

- PostgreSQL browser flow for create → edit sections → submit → approve → immutable view → revision → PDF generation/download;
- stale save preserves draft;
- denied role has no controls and server rejects direct requests;
- Closed Session authoring and Archived Session historical read behavior;
- general 73-test browser regression;
- Stage 12 Documents, Stage 15 Briefings, Stage 17 Exports, Stage 18 Exercise, Stage 20 route ownership, and Stage 21 configuration focused regressions;
- typecheck, lint, unit, build, production startup, dependency audit, Prisma validate/generate, fresh deploy/seed, full ordered PostgreSQL gate, and migration rehearsal.

## M. Definition of Done

- [x] 1. Create an AAR for exactly one authorized Closed Session.
- [x] 2. Associate it with the canonical Session and optional same-Session Exercise Observation snapshots.
- [x] 3. Edit a Draft with optimistic concurrency.
- [x] 4. Add ordered findings.
- [x] 5. Add ordered lessons identified.
- [x] 6. Add ordered corrective actions/recommendations.
- [x] 7. Enforce the documented lifecycle and illegal-transition failures.
- [x] 8. Approve an Under review version with complete actor/time/content-digest provenance.
- [x] 9. Make an Approved version and all content rows immutable in service and database.
- [x] 10. Reject attempted mutation of Approved content with a controlled response.
- [x] 11. Create a later Draft revision without changing historic versions.
- [x] 12. Generate a PDF from one exact Approved version only.
- [x] 13. Persist exact PDF bytes and artifact metadata.
- [x] 14. Persist and expose the exact SHA-256 and byte size safely.
- [x] 15. Download the retained PDF with safe headers.
- [x] 16. Recompute and verify integrity before serving; reject corruption.
- [x] 17. Keep all report versions and artifacts readable under historical authorization.
- [x] 18. Enforce effective incident RBAC and anti-enumeration at router and service boundaries.
- [x] 19. Persist complete structural audit/history without copying report bodies or bytes.
- [ ] 20. Pass all existing and Stage 22 gates with zero skipped PostgreSQL tests and no Foundation regression. **Local gates PASS (112 unit, 295 PostgreSQL, 73 + 5 browser); formal exact-head remote CI remains pending.**

## N. Risks and compatibility concerns

1. PostgreSQL `BYTEA` keeps the MVP atomic but increases database/backup size; the 10 MiB artifact limit and capacity measurement are mandatory.
2. Approved-content immutability must cover child tables and direct SQL, not only the HTTP route.
3. A PDF cannot contain its own final SHA-256 without circularity; it contains artifact identity, while the hash remains in durable metadata and response headers.
4. PDF layout may overflow on long plain-text sections; the renderer needs page-break, wrapping, and bounded-input tests.
5. Source Exercise Observations can change later; only copied snapshots plus source version are report evidence.
6. Incident-wide AAR content is broader than GROUP workflows; no default Group Leader grant is appropriate.
7. Existing generic `StoredFile` and disk upload code must not become a second production artifact authority.
8. `ExportGeneration` semantics remain unchanged; Stage 22 artifact retention is a separate exact-byte contract.
9. Report writes after Session archive would weaken established historical semantics; Stage 22 allows content changes only while Session is Closed.
10. Current baseline audit/date/flaky-transport problems can obscure Stage 22 regressions unless closed before the implementation commit.

## O. Recommended commit breakdown

1. `chore: close Stage 22 baseline gate` — separately fix the September-safe timestamp assertion, update the vulnerable locked dependency chain with review, and prove one clean ordered PostgreSQL run. No AAR behavior.
2. `feat: add AAR persistence and integrity constraints` — Prisma schema, migration, sequence, constraints/triggers, shared permissions/default roles, types, and focused database tests.
3. `feat: add versioned AAR workflow service` — router/service, RBAC, audit, revision/immutability commands, production composition, OpenAPI, and PostgreSQL tests.
4. `feat: retain and verify AAR PDF artifacts` — dedicated PDF renderer, artifact generation/download/integrity, byte bounds, tests, and response headers.
5. `feat: add After Action Report workflow UI` — API client, route capability, Reports entry, overview/editor/history/artifact UI, and browser tests.
6. `test: rehearse Foundation Stage 21 to 22 upgrade` — exact predecessor migration rehearsal, complete ordered gates, production startup, scale/concurrency, and dependency audit evidence.
7. `docs: close Foundation Stage 22 gate` — final measured report and READY verdict only after exact-head checks pass.

## P. Implementation checklist

- [x] Close the two deterministic baseline gate failures and obtain one clean full PostgreSQL run.
- [x] Confirm this plan as the Stage 22 scope; do not silently expand attachments/action tracking/signatures.
- [x] Add shared permissions and role seed reconciliation.
- [x] Add Prisma models, relations, migration, checks, triggers, and sequence.
- [x] Generate Prisma client and rehearse Stage 21 → 22.
- [x] Implement strict types/validation and canonical content hashing.
- [x] Implement incident-aware service/router with operation replay and audit.
- [x] Register one PostgreSQL production owner and extend route ownership tests.
- [x] Implement dedicated PDF renderer and retained artifact pipeline.
- [x] Implement integrity-checked metadata/download routes and headers.
- [x] Update OpenAPI.
- [x] Add frontend route/API/page using existing components.
- [x] Add focused PostgreSQL, RBAC, immutability, concurrency, rollback, PDF, and browser tests.
- [x] Run fresh migration/seed, full ordered PostgreSQL, unit, lint, typecheck, build, browser, production startup, audit, and `git diff --check`.
- [ ] Record exact-SHA CI evidence before declaring READY.

## Q. Original planning-time readiness decision (superseded)

The following decision is retained as historical evidence. The baseline closure and implementation are complete; the current next step is authorized exact-head remote CI, as recorded in the implementation report.

The Stage 22 architecture is sufficiently defined to implement without further product-model discovery. Implementation should **not** begin on the current baseline yet because the canonical unit and production dependency audit gates are deterministically red, and the full ordered PostgreSQL gate has not completed once without a transport flake in this validation session.

Exact next step: create the first isolated baseline-closure commit from this branch, containing only (a) a month-format assertion that accepts the actual `en-GB` short-month contract without weakening the product requirement and (b) a reviewed lockfile dependency update that clears the current production `qs` advisories; then run a fresh 22-migration seed plus the full Stage 1–21 PostgreSQL gate until one complete zero-failure run is recorded. After that commit is green, begin the AAR schema/migration commit described in section O.
