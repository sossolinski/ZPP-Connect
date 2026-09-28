# Foundation Stage 24 — Product Scope Cleanup & Legacy Domain Decommissioning Report

Date: 2026-09-27

Branch: `agent/foundation-stage-24-product-scope-cleanup`

Baseline: `origin/main` at `29a3d2738b88f554cc4885f4f5db58f9bcccdd59`

## Outcome

ZPP Connect now presents one active product boundary: emergency and crisis-response
operations for real incidents. Training Management, Exercise Management and organisational
Readiness are no longer production modules. Technical PostgreSQL readiness remains a
separate platform signal at `/api/health/readiness`.

This was a non-destructive decommissioning. No historical migration, table, approved AAR,
PDF byte sequence, digest or AuditLog row was rewritten or deleted.

## Active domains removed

- The production route composition no longer constructs or mounts Training, Exercise or
  organisational Readiness routers/services.
- `/api/training/*`, `/api/exercise/*` and `/api/readiness/*` now use the normal sanitized
  not-found response. `/api/health/readiness` remains public and database-backed.
- React routes, pages, navigation entries and dashboard shortcuts for all three domains
  were removed. Documents moved into the retained Operations navigation group.
- Member, Group and Rostering screens no longer fetch or display training/readiness
  projections. Normal operational workflows remain.
- Active OpenAPI paths no longer advertise Exercise operations or AAR source-observation
  selection.

Legacy implementation files remain only where they are required to compile or exercise
historical persistence tests. They are not production-composed authorities.

## Dormant compatibility schema

The following structures are retained unchanged because they contain or reference
historical evidence:

- `TrainingCourse`, `TrainingRequirement`, `MemberTrainingRecord`, `TrainingOperation`;
- `ExerciseInject`, `ExerciseObservation`, `ExerciseObservationRevision`;
- `Session.mode` values `EXERCISE` and `TRAINING`;
- legacy Member training columns and historical notification vocabulary;
- AAR finding provenance fields and foreign keys to observation history.

Stage 24 adds no migration. All 23 existing migration directories and checksums remain the
Stage 23 set. Physical removal is deferred until a separately approved retention/export,
legal-hold and referential-integrity policy exists.

## Session and AAR contract

- New Sessions must use `REAL`; supported create/update UI fixes the type to REAL.
- Historical `EXERCISE` and `TRAINING` Sessions remain readable but all incident-bound
  writes are denied through the shared access context.
- New AARs require a closed REAL Session.
- The active create contract no longer accepts `sourceObservationIds`, and the
  `/sessions/{id}/aar-source-observations` route is absent.
- Historical observation IDs, versions, copied text, context snapshots, canonical digest
  input and rendered PDF provenance remain intact. Approved evidence is never recomputed.

## Permissions and identity

All `training:*`, `readiness:*` and `exercise:*` capabilities were removed from the active
shared catalogue and protected-role defaults. They are absent from administration and
cannot be granted through role or override commands. Effective Access filters legacy
strings that can still exist in restored Role JSON. Role responses likewise expose only
current capabilities, without mutating stored history or mapping a retired grant to a
broader permission.

## Notifications

The runtime no longer constructs Training solely for notification evaluation. The periodic
projector evaluates only retained Assignment, Rostering and Document conditions. Pending
`TRAINING_ASSIGNED` outbox rows are completed inertly with no recipient or new notification,
so workers do not retry them forever. Historical Training/Readiness notifications remain
readable, but destinations to removed pages are stripped.

## Seed and preview state

The canonical seed now uses REAL operational Sessions and current event-type labels. It
does not seed Training courses/records or Exercise injects/observations, and it does not
produce Training notifications. Member seed reconciliation preserves any pre-existing
legacy training status while new profiles receive no such projection. Preview navigation,
dashboard, Sessions, Documents, Members, Groups, Rostering and AAR now form a coherent
incident-response product.

## Test reclassification

Stage 18/19 active feature suites are no longer part of the production-contract gate. Their
source remains historical development evidence; the current suite reclassifies the durable
requirements into:

- Stage 22 retained AAR provenance/hash/PDF tests;
- Stage 23 full-schema integrity, backup and restore checks;
- Stage 24 legacy-table, stored-grant, route, technical-readiness and historical-Session
compatibility tests;
- a real pre-Stage-24 backup restoration rehearsal described below.

When an older restored fixture contains only active non-REAL Sessions, the retained Stage 21
dictionary test creates and removes its own transient REAL incident for business-write
assertions. This keeps the recovery gate meaningful without making historical Training or
Exercise Sessions writable again. The Stage 22 upgrade rehearsal likewise inserts its
predecessor observation and revision as a direct historical persistence fixture instead of
calling the retired Exercise command service.

The old browser journeys that created Training/Exercise/Readiness state were removed, while
incident and AAR coverage remains. Stage 24 browser assertions verify clean navigation,
404 legacy APIs, technical readiness, REAL-only Session creation and the retired permission
catalogue.

## Backup, restore and older-backup compatibility

### Current Stage 24 data

A fresh Stage 24 database was migrated through all 23 unchanged migrations, seeded and run
through the complete PostgreSQL suite. Integrity then passed over 1,021 approved AAR
versions and nine retained PDF artifacts. Backup `bc1b15a2-dc59-41c8-829e-2f961cdf562d`
(`651582` bytes, SHA-256
`64b7de9c80d87b477a4d1e1a4b6ba25f4ba2932d19a4eb712801911d2c0e7418`) passed manifest,
catalog and checksum verification, restored into an empty database, passed integrity and
then passed the Stage 1 incident plus Stage 24 boundary tests (6/6).

The automated compiled Stage 23 recovery rehearsal also passed in 2.833 seconds with 23
migrations, a closed REAL Session, approved AAR, exact persisted PDF bytes/hash, Audit,
Document, Role and Dictionary evidence. Intentional archive corruption was rejected before
restore.

### Actual backup produced before Stage 24 implementation

Backup `c619e279-0e88-4d67-99aa-d555102843e0`, created from the merged Stage 23 code before
Stage 24 implementation, was restored into a fresh empty database with current tooling.
Its manifest/archive (`429033` bytes, SHA-256
`0f279cc639158342199db14e7aa213dd1536518b46e70a54884cbaeda8de58fd`) passed strict
verification and current integrity. The restore retained six Training courses, six Member
Training records, one Exercise inject, one Exercise observation and two non-REAL Sessions;
the current Stage 24 boundary tests then passed 4/4 against that data.

This direct cross-version result is safe for Stage 23 → Stage 24 because Stage 24 adds no
migration and does not alter the historical schema/checksums. The general supported policy
remains: restore using the matching application version, verify, apply forward migrations,
then rerun current integrity and acceptance gates. No broader cross-version promise is made.

## Validation

| Gate | Result |
|---|---|
| dependency install / Prisma generation | PASS |
| lint / typecheck | PASS |
| unit suite | PASS — 121 tests; PostgreSQL suites skipped without a test DB |
| build | PASS |
| fresh migrations and seed | PASS — 23 migrations |
| full PostgreSQL suite | PASS — 256/256 across 22 files |
| browser suite | PASS — 62/62 |
| production dependency audit | PASS — 0 vulnerabilities |
| current backup verify/restore/integrity | PASS |
| actual old Stage 23 backup compatibility | PASS |
| recovery/corruption rehearsal | PASS |
| production PostgreSQL/Entra startup | PASS — liveness/readiness 200, database reachable, Microsoft SSO only, dev users 404 |
| repository whitespace/artifact check | PASS |

## Definition of Done

| # | Criterion | Result |
|---:|---|---|
| 1 | Exercise is not an active module | PASS |
| 2 | Training is not an active module | PASS |
| 3 | organisational Readiness is not an active module | PASS |
| 4 | technical readiness remains | PASS |
| 5 | excluded navigation is gone | PASS |
| 6 | excluded production write APIs are unavailable | PASS |
| 7 | excluded permissions are not assignable | PASS |
| 8 | excluded notification producers are inactive | PASS |
| 9 | normal seed does not depend on excluded domains | PASS |
| 10 | new AAR targets closed REAL incidents | PASS |
| 11 | approved historical AAR content is unchanged | PASS |
| 12 | historical PDF bytes/hashes are unchanged | PASS |
| 13 | historical AuditLog is preserved | PASS |
| 14 | required history is preserved forward-only | PASS; no migration required |
| 15 | no historical migration was rewritten | PASS |
| 16 | current Stage 24-schema backup works | PASS |
| 17 | Stage 23 restore verification still works | PASS |
| 18 | migration identity/checksum verification is strict | PASS |
| 19 | old-backup recovery strategy is documented | PASS |
| 20 | incident-response API remains functional | PASS |
| 21 | incident-response UI remains functional | PASS |
| 22 | unit tests pass | PASS |
| 23 | PostgreSQL suite passes | PASS |
| 24 | Playwright passes | PASS |
| 25 | production dependency audit is green | PASS |
| 26 | PostgreSQL/Entra startup is green | PASS |
| 27 | repository has no generated DB/backup artifact | PASS |
| 28 | Stage 24 report is complete | PASS |

## Known limitations and deferred work

- Physical deletion of dormant legacy tables/columns is intentionally deferred.
- External callers of removed endpoints require deployment communication; the repository
  has no consumer registry.
- Historical documents remain historical evidence and can describe capabilities that were
  active in their original stage. README and this report define current state.
- Logical dumps still provide no WAL/PITR guarantee; Stage 23 recovery limits remain.

## Stage 25 recommendation

Proceed with the planned final Foundation stage, **Stage 25 — Secure Incident Evidence &
Foundation Exit**. Stage 24 does not reveal a reason to extend Foundation beyond Stage 25.
Stage 25 should treat the retained legacy schema as read-only compatibility data, keep the
Stage 23 recovery gate mandatory, and focus only on secure real-incident evidence,
retention/export boundaries and explicit Foundation exit criteria. It must not reintroduce
Training, Exercise or organisational Readiness product scope.
