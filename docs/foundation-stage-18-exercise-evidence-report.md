# Foundation Stage 18 — Exercise Inject / Observation Persistence + Evidence Integrity

Verdict: **NOT READY — exact implementation-SHA CI is pending.**

## A. Stage 17 merge verification

PR #14 was reverified live at exact head `d4df699c12d0aea9e5d336081c04bf17aa62419d`: OPEN/DRAFT, MERGEABLE/CLEAN, no review blocker, report verdict `READY FOR NEXT FOUNDATION SLICE`, and all six exact-head checks successful. It was marked ready and merged using a merge commit (no squash/rebase/history rewrite) as `7eec37450871507d677092d9638f3d5368e56330`. The reviewed Stage 17 head is an ancestor of fetched `origin/main`. This branch was created from that merge in `/tmp/zpp-connect-stage18-exercise-evidence`; the user's dirty Stage 12 worktree was not changed.

## B. Current route matrix

Before Stage 18, mounted production composition exposed generic `GET/POST/PATCH /exercise/injects`, generic `GET/POST/PATCH /exercise/observations`, and memory lifecycle `POST /exercise/injects/:id/release|complete`. A separate router in `routes/index.ts` was not mounted and was not production authority. Stage 18 mounts direct PostgreSQL routes for those operations plus `GET /exercise/observations/:id/history`; there is no Exercise DELETE route.

## C. Current writer authority

The pre-stage generic routes wrote `exerciseInjects[]` and `exerciseObservations[]` through `resources`, `createRow()`, and `updateRow()`. PostgreSQL composition now injects `PrismaExerciseService`, mounts `createExerciseRouter`, excludes both Exercise resources from `demoResourceRoutes`, and excludes the legacy release/complete handlers. The arrays remain only behind the explicit no-persistent-service memory compatibility boundary.

## D. Current evidence gap

The old writer lost new Injects, Observations, lifecycle state, and provenance on restart. It had no optimistic concurrency, durable command idempotency, immutable released stimulus, revision history, atomic Audit, database lifecycle enforcement, paging beyond the generic cap, or close/write serialization.

## E. Target architecture

`HTTP → IncidentPermissionGate → PrismaExerciseService → same-transaction Session/access recheck → typed PostgreSQL evidence + Audit`. State-changing transactions lock Session first, then the Exercise entity. Reads and writes call PostgreSQL directly; there is no PostgreSQL-to-array hydration.

## F. Inject model

`ExerciseInject` remains the typed entity and now carries a unique sequence-backed `INJ-YYYY-NNNNNN`, unique `(sessionId, injectNumber)`, target Role FK/key/display snapshot, version, creation operation/fingerprint, created/updated/released/completed actor and time provenance, and query indexes. The server owns status (`Planned`), identity, version, and provenance.

## G. Observation model

`ExerciseObservation` remains typed and now carries a unique sequence-backed `OBS-YYYY-NNNNNN`, version, creation operation/fingerprint, created/updated actors, constrained area/severity/status, Boolean `includeInAar`, paging indexes, and immutable `ExerciseObservationRevision` snapshots. `owner` remains bounded functional/team-owner text; it is not assumed to be an account identity.

## H. Role-target semantics

Every current UI audience maps to one of eight active durable Role records. Creation/update resolves a controlled canonical Role key, persists the Role FK and key, and stores the current display-name snapshot. Later Role rename/archive cannot erase the historical audience wording of a released Inject; arbitrary target-role text is rejected.

## I. Incident-mode policy

Exercise mutations are valid only when `Session.mode = EXERCISE`. Live/Real and Training modes return controlled 409. `scenarioTime` preserves the existing absolute timestamp interpretation and requires an offset-bearing ISO timestamp.

## J. Authorization

All routes require authoritative Stage 14 `exercise:manage` EffectiveAccess for the target Incident. ID routes load `id/sessionId` from PostgreSQL before authorization and use the existing 404 anti-enumeration response. GROUP A plus an unrelated IncidentAssignment in B cannot operate B; GLOBAL actors continue to work.

## K. Writability

Closed/Archived evidence remains readable to authorized reviewers. Every mutation has both route-level writability gating and a same-transaction Session lock/status recheck; closed mutations return 409 without entity, version, revision, or Audit changes.

## L. Inject lifecycle

The explicit matrix is `Planned → Released → Completed`. `Planned → Completed` is disallowed. Released and Completed action retries return the durable current record without timestamp/version/Audit duplication; release of Completed never regresses status. Legacy `Cancelled` rows are retained as terminal compatibility evidence, but Stage 18 exposes no cancellation command.

## M. Inject immutability

Only Planned content is editable. Service validation and the `ExerciseInject_evidence_immutable` database trigger protect inject number, scenario time, Role identity/snapshot, text, and expected action after release. Completed/legacy Cancelled rows and lifecycle provenance are terminal. There is no hard delete.

## N. Observation revisions

Each creation/update appends one full typed snapshot with version, fields, changed-field names, actor, time, and source. A deferred database constraint trigger requires exactly versions `1..N` and exactly N revisions for current version N. Update/delete of a revision is rejected by an append-only trigger; parent cascade cleanup is permitted only after the parent no longer exists.

## O. Optimistic concurrency

Planned Inject and Observation updates require positive integer `expectedVersion`. Row locking plus comparison yields one winner and one controlled 409 for same-version races. Release/update is coherent because both lock Session then Inject and re-evaluate status/version.

## P. Retry/idempotency policy

Browsers generate UUID `operationId` for Inject and Observation creation. A semantic SHA-256 fingerprint and unique operation identity make same-operation/same-command return the same entity as 200, including concurrent retries; different content returns 409. Only one entity and one creation Audit commit. Sequence rollback gaps are harmless.

## Q. Incident close races

Close-first Inject creation, Observation creation, and Observation update all return 409 and write nothing. Mutation-first commits the full entity/Audit before close. The common lock order is Session then Exercise entity, so no Exercise mutation commits after a close that won serialization.

## R. Audit

Actual changes create exactly one durable Audit in the same transaction: `exercise_inject_created|updated|released|completed` and `exercise_observation_created|updated`. No-op edits/action retries create none. Failure seams prove rollback before entity create, after entity create, around revision insertion, and before release/complete Audit.

## S. Audit payload safety

Audit metadata is structural: IDs, operational IDs, role key, number, area/severity, selection/status/version transitions, changed field names, operation ID, and request ID. Raw Inject, Observation, Recommendation, Expected Action, and Owner text are not copied. Actor response projections contain only `id` and `displayName`; emails and EffectiveAccess internals are absent.

## T. Timeline decision

No CaseTimeline event is emitted. Exercise evidence plus Audit are authoritative; adding Timeline noise was not an existing Exercise requirement.

## U. Validation

Strict Zod bodies reject unknown/provenance fields. Inject number is an actual integer `1..999999` (not numeric strings). Inject/Observation text is `1..10000`; expected action/recommendation `0..5000`; owner `0..200`; Role, area, severity, status, UUIDs, Boolean selection, scenario time, paging, and versions are constrained.

## V. Paging/scale

Pages are capped at 200 but include full durable totals and offsets. Injects order by `injectNumber ASC, id ASC`; Observations by `createdAt DESC, id DESC`; history by version ASC. A 1,005-Inject fixture verified first/middle/final pages and all six pages without duplicates, omissions, or a hidden 200-row authority.

## W. Frontend

ExercisePage keeps its recognizable two-table/two-form layout. It now uses explicit Exercise helpers, generates creation operation UUIDs, sends `expectedVersion`, omits client-controlled Inject status, and gates Release to Planned and Complete to Released. Existing active-session safety remains UX defense; the server remains authoritative.

## X. Restart durability

Tests create/release an Inject, create/update an Observation, reconstruct the app/service, read records/history, complete the Inject, reconstruct again, and read Completed evidence. No arrays, Maps, request cache, or client state participate.

## Y. Production legacy removal

The unmounted duplicate Exercise router was removed. Search results for `exerciseInjects`, `exerciseObservations`, Exercise resources, and memory lifecycle writes are confined to the memory adapter/data and handlers guarded by `!options.exerciseService`. PostgreSQL `registerRoutes()` always composes the Prisma service.

## Z. Migration/backfill

Migration 21 adds constraints, Role mapping, provenance/version/idempotency fields, sequences, indexes, revisions, foreign keys, and triggers without rewriting earlier migrations. There is zero backfill from the old ephemeral arrays. Existing durable demo/seed Observation rows receive a truthful `MigrationBaseline` snapshot so the invariant begins at version 1; the migration does not invent process-memory production evidence. Seed owns the one demo Inject/Observation and creates its revision transactionally.

## AA. Migration rehearsal

Exact Stage 17 SHA `d4df699…` deployed and seeded 20 migrations. Representative Identity, Incident, Import, Briefing, and ExportGeneration records were present before applying migration 21. The upgrade retained all counts and the representative export digest, produced 21/21, mapped the durable seeded Exercise rows, created exactly one baseline revision for the seeded Observation, and passed the dedicated 15-test suite.

## AB. PostgreSQL tests

Local ordered Stage 1–18: **239/239 passed, zero skipped**. Dedicated Stage 18: **15/15 passed** on both fresh and rehearsed databases. Coverage includes validation, idempotency, duplicate numbering, optimistic updates, lifecycle and all requested races, database immutability, authorization/overrides, closure, rollback seams, restart, history, Audit safety, and 1,005-row paging.

## AC. Browser tests

Dedicated PostgreSQL Stage 18: **3/3 passed** for create/release/reload/complete, create/edit/history/closed controls, and unauthorized UI/server denial. The clean general memory browser rerun passed **73/73**.

## AD. Production startup/audit

Production Entra/PostgreSQL startup returned health 200 with `persistence: postgres`; auth config exposed only Microsoft SSO and development users returned 404. PostgreSQL Exercise service composition does not depend on demo arrays. Typecheck, Unit **101/101**, and production build pass. A narrow `deepmerge-ts` 8.0.2 override removes the Prisma configuration transitive advisory; `npm audit --omit=dev --omit=optional` reports **0 vulnerabilities**.

## AE. Exact-SHA CI

Pending. CI now runs fresh migration/seed/startup, ordered Stage 1–18, dedicated Stage 18, Stage 16–18 PostgreSQL browser workflows, and the Stage 17→18 rehearsal. READY requires every check on the eventual exact final SHA.

## AF. Remaining split-brain

Exercise PostgreSQL production split-brain: **none**. Remaining broader candidates, highest first: (1) Readiness projections still combine non-authoritative/static or derived paths central to staffing decisions; (2) generic memory/dormant router consolidation reduces future accidental authority; (3) Admin/static dictionary/config persistence; (4) AAR/reporting can now consume durable Exercise evidence but remains a new output surface, not writer-authority removal.

## AG. Risks — max 10

1. Role display snapshots intentionally do not follow later renames.
2. Legacy Cancelled evidence is terminal but no Stage 18 command creates it.
3. Free-text functional owner is controlled by length, not a personnel catalogue.
4. Offset paging can shift under concurrent inserts; stable ordering prevents ambiguity within a snapshot but no cursor contract was added.
5. Operational ID sequences may contain rollback gaps by design.
6. Database triggers require PostgreSQL and are intentionally absent from memory compatibility tests.
7. The dependency override should be removed when Prisma natively consumes patched `deepmerge-ts`.
8. Exact-final-SHA CI remains the READY gate.

## AH. Next Foundation candidate

Selected candidate: **Readiness projection authority and integrity**. It ranks highest on production decision centrality and operational value now that Exercise writer authority is durable. Generic memory/dormant-router consolidation is second because it reduces architectural risk but delivers less direct operational value. Admin dictionaries/config is third; AAR/reporting is fourth. Stage 19 is not implemented here.
