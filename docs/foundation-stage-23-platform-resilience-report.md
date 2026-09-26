# Foundation Stage 23 — Platform Resilience, Recovery & Data Integrity

Status: **IMPLEMENTED — LOCAL AND REMOTE GATES GREEN, READY FOR PR REVIEW**

Validated locally on 2026-09-26 on branch
`agent/foundation-stage-23-platform-resilience`, based on scope-decision merge
`71c9e22ddf5a589783df2b670669f69eae9983dc`. This stage implements technical
platform recovery. It does not implement organisational Readiness, Training or Exercise
product work and does not begin Stage 24 or 25.

## A. Implemented scope

Stage 23 adds a repository-owned PostgreSQL resilience workflow:

```text
consistent source snapshot
  -> pg_dump custom archive + strict manifest + SHA-256
  -> pre-restore verification
  -> explicitly empty disposable database
  -> pg_restore with exit-on-error
  -> migration/count/application integrity verification
  -> meaningful REAL incident/Audit/AAR/PDF evidence checks
```

Stable commands are available at the repository root:

- `npm run backup`
- `npm run backup:verify`
- `npm run backup:retention`
- `npm run restore:verify`
- `npm run integrity:check`
- `npm run test:recovery`

Every operational CLI emits one structured JSON success/failure event and a meaningful
exit status. Errors redact connection URLs and configured passwords. The package commands
execute compiled `dist/src/resilience/*.js` entry points, so they are present in the API
runtime image; a source checkout must build the API before invoking them.

## B. Protected assets and recovery boundary

The complete PostgreSQL application database is protected: schema/migrations, sequences,
constraints/triggers, incidents, identities/access, groups/rosters, Documents and
acknowledgements, notification state, Audit, briefings, import/export provenance,
dictionaries/configuration, AAR history and exact persisted AAR PDF bytes. Legacy tables
are included even though Exercise, Training and organisational Readiness are not primary
acceptance criteria.

Repository inspection confirmed that PostgreSQL production routes do not use the legacy
disk upload adapter. `DATA_DIR`/`app-storage` is therefore not an authoritative production
asset in the verified contract. Original import bytes and generated CSV export bytes are
also not retained by their existing product designs. AAR PDF bytes are retained as BYTEA
and are covered.

Outside the dump remain the compatible application release/image, database/Entra secrets,
environment values, TLS/DNS/network/deployment configuration, scheduler/monitor setup and
remote backup storage. The runbooks make this boundary explicit.

## C. Backup format and consistency

`pg_dump --format=custom --compress=6 --no-owner --no-privileges` was selected over plain
SQL and directory formats. It supports catalog inspection through `pg_restore --list`,
controlled restore failure, one artifact lifecycle and native schema/data preservation.

The backup command holds a Prisma repeatable-read transaction, exports its PostgreSQL
snapshot and gives that snapshot to `pg_dump`. Manifest migration state and critical row
counts are read from the same snapshot as the archive. Publication uses private temporary
files followed by rename; a failed pair publication removes its exact partial/published
artifact. Directory mode is `0700`, artifacts/manifests `0600`.

The strict `zpp-backup-manifest-v1` sidecar contains backup ID/times, safe archive filename,
format, size, SHA-256, application version, a one-way source-database identity, PostgreSQL
server and producer versions, completed migration names/checksums/times, and counts for
Users, Roles, Sessions, Documents, Audit, Dictionaries, AAR versions and PDF artifacts.
It contains no URL, password or secret configuration.

## D. Restore and verification

`restore:verify` first repeats manifest, path, regular-file, size, SHA-256, tool-major and
archive-catalog checks. It rejects the source database identity, refuses a nonempty target,
and normally requires `zpp_stage23_restore_` naming. It never creates, drops, cleans,
truncates or overwrites a database. The caller provisions the empty target.

After `pg_restore --exit-on-error --no-owner --no-privileges`, it proves connectivity,
exact manifest migration state, exact migration-name and migration-file SHA-256 compatibility
with the checkout, exact critical table counts and all application-level integrity checks.
Passwords are provided to native tools through `PGPASSWORD`, never a command-line URL.

The automated rehearsal separately creates randomized source/restore databases, deploys
all migrations, seeds, inserts a synthetic closed REAL incident plus assignment/Audit,
creates and approves an AAR and persists a real rendered PDF. It checks restored User/Role,
Session, Document, Audit, Dictionary, AAR and PDF records and exact PDF hash/size. It then
changes a copied archive and proves verification rejects it before restore. A `finally`
cleanup drops only exact generated database names and removes the generated temp directory.

Final local rehearsal result: **PASS**, 23 migrations, 6 Users, 8 Roles, 3 Sessions,
6 Documents/versions, 9 Audit rows, 202 Dictionaries, 1 AAR/version/PDF; application
integrity pass and `corruptionDetected: true` in **2.765 seconds**. After completion,
PostgreSQL contained zero databases matching `zpp_stage23_%`.

## E. Recovery objectives and retention

These are project assumptions, not business-approved SLAs:

| Objective | Initial assumption |
|---|---|
| RPO | 24 hours |
| RTO | 4 hours |
| Backup schedule | at least daily, external scheduler |
| Backup retention | 35 days, preserving at least seven newest valid pairs |
| Restore verification | at least weekly and after PostgreSQL/tool changes |

Retention policy is configurable with `BACKUP_RETENTION_DAYS` and
`BACKUP_RETENTION_MIN_COUNT`. It is dry-run by default; deletion requires the exact
`BACKUP_RETENTION_APPLY=true` opt-in. Only direct-child, checksum-valid manifest/archive
pairs are eligible. Symlinks, corrupt/malformed pairs and orphans are reported and retained
for investigation. The tool has no database deletion code and cannot purge product data.

No application-data retention policy was invented. AuditLog, approved AAR history,
persisted artifacts, Document acknowledgements and crisis evidence are never automatically
purged by Stage 23.

## F. Application integrity

`integrity:check` performs a complete bounded scan. It fails rather than samples when a
checked collection exceeds `INTEGRITY_MAX_ROWS` (default 10,000; explicit supported range
1–1,000,000). It verifies:

- successful Prisma state exactly matching repository migration names and file checksums;
- validated PostgreSQL constraints and valid indexes;
- canonical SHA-256 for every Approved AAR inspected;
- exact byte length/SHA-256 and Approved source digest for persisted AAR PDFs;
- SHA-256 of every Published internal-text Document;
- digest snapshots in Document acknowledgements against referenced versions.

Stage 17 export and Stage 16 input hashes are not revalidated because those subsystems
truthfully do not retain their bytes.

Integration tests intentionally corrupt and exactly restore an AAR PDF, Approved AAR body
and Published Document digest. Each corruption is detected, and a following full scan
passes. The Stage 22 scale fixture was narrowly corrected to create valid canonical hashes
for its 1,005 synthetic Approved revisions, and Stage 22 corruption tests now restore exact
bytes/content in `finally`; product behavior is unchanged.

## G. Technical health and monitoring

`GET /api/health` retains its existing cheap process-liveness response. New public
`GET /api/health/readiness` executes only `SELECT 1` and returns:

- 200 with `ready: true`, `database: "reachable"`; or
- 503 with `ready: false`, `database: "unavailable"`.

It never returns a raw database error or secret and never runs the integrity checker. The
route has its own PostgreSQL production owner in the route manifest. Tests cover reachable
and sanitized unavailable behavior.

The repository intentionally does not implement an alert vendor. Schedulers and external
monitors integrate through CLI exit codes/JSON, missing expected success timestamps and
the separate liveness/readiness HTTP signals.

## H. Security

- Connection strings remain environment-only and are not placed in manifests or native
  process arguments; structured error output redacts configured values/passwords.
- Filename generation and manifest resolution prevent path traversal; backup directories,
  regular files and symlinks are checked explicitly.
- Restore refuses source identity, unsafe default naming and nonempty targets.
- Recovery fixture/rehearsal requires `NODE_ENV=test` plus
  `STAGE23_ALLOW_RECOVERY=true` and random safe database names.
- `.gitignore` excludes `/backups/`, custom dump files and backup manifests.
- Local permissions are only a baseline. Production backup storage still requires
  deployment-owned encryption, access control and off-host durability.

No production data, credentials or backup artifact was created in the repository.

## I. Runbooks

- [Backup](runbooks/backup.md)
- [Restore](runbooks/restore.md)
- [Integrity verification](runbooks/integrity-verification.md)

They contain exact environment contracts, commands, safety conditions, configuration
recovery checklist, schedule/alert integration and failure handling.

## J. CI

The normal PostgreSQL job now:

1. checks `/api/health/readiness` during production Entra startup;
2. includes Stage 23 in the ordered PostgreSQL suite;
3. runs a dedicated Stage 23 integrity test;
4. runs the complete backup -> restore -> verification -> corruption gate using only
   randomized databases on the PostgreSQL CI service.

The existing migration rehearsal, six PostgreSQL browser workflows, quality job and
production dependency audit remain enabled. On implementation head `cd45d74`, both the
push workflow [36258176580](https://github.com/sossolinski/ZPP-Connect/actions/runs/36258176580)
and PR workflow [36258195064](https://github.com/sossolinski/ZPP-Connect/actions/runs/36258195064)
passed all three jobs, including the Stage 23 recovery gate. PR #21 is not authorized for
merge in this task.

## K. Final local validation

| Gate | Result |
|---|---|
| `npm ci` | PASS, 445 packages installed from lockfile |
| Prisma generate / validate | PASS, Prisma 6.19.3, 23 migrations |
| `npm run lint` | PASS, API and web typechecks |
| `npm test` | **125 passed**, 19 unit files; 24 PostgreSQL files intentionally skipped in unit mode |
| `npm run build` | PASS; existing Vite chunk-size warning only |
| `npm run test:smoke` | **73/73 passed**, 1.8 minutes |
| `npm audit --omit=dev --omit=optional` | **0 vulnerabilities** |
| fresh migration chain + seed | PASS, 23/23 from zero |
| complete ordered PostgreSQL Stage 1–23 | **300/300 passed**, 24 files, 46.93 seconds |
| focused Stage 22 + 23 | **35/35 passed** |
| final recovery gate | PASS from compiled CLI, integrity pass, intentional corruption rejected, 2.765 seconds |
| altered repository migration checksum | PASS: integrity checker rejected it with exit 1 |
| production PostgreSQL/Entra startup | PASS; liveness 200, readiness 200/reachable, Microsoft SSO only, dev users 404 |
| `git diff --check` | PASS |
| generated backup/temp DB state | none |

One earlier clean full-suite attempt exposed the known shared-database concurrency class:
the Stage 14 last-admin race allowed both competing changes, causing 44 downstream access
failures. In a prior attempt all 296 predecessor tests passed while only the then-invalid
Stage 23 assumptions failed; the final completely fresh retry passed all 300. No retry was
added to code or CI, and no failing assertion was skipped or weakened.

## L. Known limitations and deferred infrastructure

- Logical daily dumps provide no point-in-time recovery, WAL continuity or physical
  replication. Provider snapshots/WAL may improve RPO after explicit infrastructure work.
- The API Docker runtime does not install PostgreSQL client tooling or define a scheduler;
  use an authorized operational runner/source checkout with Node dependencies and matching
  clients. A production job image/orchestrator is deployment work.
- Archive encryption, remote/object storage, cross-region copies, storage capacity and
  alert delivery are environment-specific and not implemented here.
- RPO/RTO are unapproved assumptions and fixture duration is not a production capacity
  benchmark.
- The application integrity scan loads bounded rows including PDF bytes. Operators must set
  a complete safe bound and monitor duration as real data grows.
- A manifest/checksum detects accidental alteration; it is not a cryptographic signature
  or protection from an attacker able to replace both archive and manifest.
- Deployments that independently made `DATA_DIR` authoritative are outside this verified
  recovery boundary until they add and test a separate file backup.
- Business/legal application-data retention and destructive purge remain deferred.

## M. Definition of Done

| # | Criterion | Result |
|---:|---|---|
| 1 | Reproducible PostgreSQL backup | PASS |
| 2 | Detectable backup failure | PASS: non-zero + structured failure |
| 3 | Verifiable backup integrity | PASS: strict manifest, size, SHA-256, catalog |
| 4 | Restore into a clean DB | PASS |
| 5 | Automatic restore verification | PASS |
| 6 | Meaningful application recovery checks | PASS |
| 7 | Intentional corruption detected | PASS |
| 8 | Executable critical integrity checks | PASS |
| 9 | Safely configurable backup retention | PASS |
| 10 | Cleanup cannot purge non-backup application data | PASS |
| 11 | Configuration recovery documented | PASS |
| 12 | Technical health signals | PASS |
| 13 | Executable runbooks | PASS |
| 14 | No secrets in script/manifest | PASS |
| 15 | Fresh migration compatibility | PASS, 23/23 |
| 16 | Existing Stage 1–22 tests | PASS |
| 17 | Full PostgreSQL suite | PASS, 300/300 including Stage 23 |
| 18 | Browser smoke | PASS, 73/73 |
| 19 | Production PostgreSQL/Entra startup | PASS |
| 20 | Production dependency audit | PASS, 0 vulnerabilities |
| 21 | Meaningful CI recovery verification | PASS: push and PR workflows green on implementation head |
| 22 | No generated artifacts/temp DB state | PASS |
| 23 | Complete Stage 23 report | PASS |

## N. Roadmap recommendation

The discovery does not change the approved order. Stage 24 should next remove the
out-of-scope Training, Exercise and organisational Readiness product surfaces while
preserving backup compatibility for historical tables. Stage 25 should then address secure
incident evidence/foundation exit. Neither stage is started here. Stage 24 must keep the
Stage 23 backup/restore/integrity gates green and must define migration/retention treatment
before dropping any historical table.
