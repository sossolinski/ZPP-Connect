# Foundation Stage 25 — Secure Incident Evidence & Foundation Exit

Date: 2026-09-29  
Branch: `agent/foundation-stage-25-secure-incident-evidence`

## Result

Stage 25 adds a narrow production evidence capability for authorized `REAL` incidents and
completes the planned Foundation programme. Evidence is not a generic document repository:
it belongs to one incident, is retained behind incident-scoped authorization, and cannot be
created for historical Training or Exercise Sessions.

## Storage and data model

`StoredFile` now distinguishes legacy rows from `INCIDENT_EVIDENCE` and owns authoritative
metadata: incident, original/display filename, detected and declared MIME, byte size,
SHA-256, category/description, creator, timestamps, lifecycle, withdrawal provenance,
version, operation identity and request identity. Existing legacy rows are not rewritten.

`StoredArtifact` is the first `EvidenceArtifactStore` adapter. It stores exact bytes in
PostgreSQL `BYTEA` under the opaque key `incident-evidence/<uuid>`. Display names never
participate in storage lookup. PostgreSQL was selected so one Stage 23 logical snapshot
protects metadata and bytes coherently; a future adapter can replace storage without
changing the evidence service or routes.

Migration 24 adds conditional constraints, indexes, foreign keys, deterministic operational
IDs and database triggers. Evidence core metadata, artifacts and operation history reject
update/delete. Withdrawal is the only supported lifecycle mutation and preserves bytes.

## Upload and integrity security

- Runtime default: 10 MiB; deployment may lower it but cannot exceed the database hard cap
  of 20 MiB.
- Allow-list: PDF, JPEG, PNG and valid plain UTF-8 text.
- The API detects signatures/content and requires declared MIME plus filename extension to
  agree. PE, ELF, shebang, HTML/script-like text, empty and malformed input are rejected.
- Multer 2.x uses bounded in-memory multipart handling: one file and bounded fields, with no
  temporary upload files to leak.
- Filename handling strips paths, normalizes Unicode, repairs the detectable multipart
  Latin-1/UTF-8 ambiguity, neutralizes controls/quotes and emits an ASCII fallback plus
  RFC 5987 `filename*` value.
- Every upload has SHA-256 over exact bytes. Every download rereads bytes and rechecks byte
  length, artifact metadata and authoritative digest before serving. Known-corrupt or
  missing bytes return an error and are never served.
- SHA-256 is explicitly presented as integrity evidence, not authenticity or a digital
  signature.

Malware scanning is a typed extension point. The current truthful status is
`NOT_CONFIGURED`; the product never claims that a file was scanned. Enabling a provider is
normal post-Foundation integration work and requires an operational quarantine policy.

## Authorization, concurrency and lifecycle

The active catalogue contains `evidence:read`, `evidence:upload` and
`evidence:withdraw`. Coordinators receive all three; group leaders read/upload; members
read. System Admin and Observer receive no default evidence grant. EffectiveAccess plus the
incident assignment gate is applied before multipart parsing or entity access.

List, metadata, download and guessed IDs all require access to the path incident. Cross-
incident access is rejected. Non-REAL Sessions are rejected for both evidence creation and
the evidence surface. Closed/Archived real incidents remain readable where incident access
permits it, but are not writable.

Upload and withdrawal use UUID operation IDs, canonical command fingerprints and immutable
operation results. Advisory transaction locks plus bounded serialization retry make the
same concurrent upload resolve to one record and a durable replay. Reusing an operation ID
for different content conflicts. PostgreSQL artifact insertion, metadata, operation, audit
and timeline rows commit in the same transaction, so a rejected metadata write cannot leak
artifact bytes. Withdrawal uses an expected version and retains actor,
time and reason. A download that began while evidence was active may complete; a new
download after committed withdrawal is rejected.

## Audit and timeline

Upload, successful download, withdrawal and download integrity failure create AuditLog
entries without file content. Upload and withdrawal create concise CaseTimeline events
because they change the incident's operational evidence state. Technical retries do not
duplicate audit or timeline history.

## API and UI

OpenAPI documents the following incident-scoped endpoints:

- `GET /sessions/{sessionId}/evidence`
- `POST /sessions/{sessionId}/evidence`
- `GET /sessions/{sessionId}/evidence/{evidenceId}`
- `GET /sessions/{sessionId}/evidence/{evidenceId}/download`
- `POST /sessions/{sessionId}/evidence/{evidenceId}/withdraw`

The Operations navigation now includes Incident Evidence for users with `evidence:read`.
The workspace supports bounded upload, classification, description, paged active/history
list, uploader/time/size/type/hash visibility, verified download and authorized withdrawal.
It explains scan and digest limitations and exposes API failures instead of inventing local
state. Retired Training, Exercise and organisational Readiness UI remains absent.

## Retention and export boundary

The application performs no automatic evidence purge. Withdrawal is not deletion. Business
retention durations, legal holds and any approved physical purge remain policy decisions.
Stage 23 backup-pair retention is independent and cannot delete application evidence.

Stage 25 does not add whole-incident ZIP/export. Current evidence can be individually
downloaded by an authorized operator with retained metadata and hash. A deterministic,
bounded manifest package is useful normal backlog work only after a concrete disclosure
workflow is approved; it is not a Foundation blocker.

## Backup, restore and integrity

Backup manifests now count evidence metadata, artifact bytes and operation records while
remaining able to parse older Stage 23/24 v1 manifests with zero evidence defaults. A
schema-changing Stage 25 restore follows the matching-release-then-forward-migrate policy.

The integrity checker performs bounded complete scans for missing artifacts, orphaned
artifacts, unexpected size, metadata mismatch and recomputed hash mismatch. It reports and
never repairs corruption.

The exact local recovery rehearsal created a meaningful REAL incident, uploaded evidence,
closed the incident, generated an approved AAR PDF, backed up 24 migrations, restored into
an empty database and recovered both exact artifact types. It then changed one evidence
byte under a privileged test-only trigger bypass, proved integrity rejection, restored the
original byte, reran integrity successfully and detected a separately corrupted backup
archive. Result: PASS; final post-review rehearsal backup ID
`58fa3025-cb73-45d7-99e7-eeb03e2bed02`.

## Validation evidence

| Gate | Result |
| --- | --- |
| `npm ci` | PASS |
| Prisma generate and validate | PASS |
| Fresh migration chain and seed | PASS — 24/24 migrations |
| Lint/typecheck | PASS |
| Unit suite | PASS — 127/127, PostgreSQL suites intentionally skipped |
| Full Foundation PostgreSQL suite | PASS — 270/270, zero skipped |
| Dedicated Stage 25 PostgreSQL | PASS — 14/14 |
| Production build | PASS |
| Baseline browser smoke | PASS — 62/62 |
| Dedicated PostgreSQL evidence browser | PASS — 2/2 |
| Backup/restore/corruption rehearsal | PASS |
| Production Entra/PostgreSQL startup and readiness | PASS; development auth returned 404 |
| `npm audit --omit=dev --omit=optional` | PASS — 0 vulnerabilities |
| `git diff --check` | PASS |

Multer was upgraded from deprecated 1.x to current 2.4.0 after `npm ci` surfaced the upload-
security warning; lint, unit, build, audit, Stage 25 PostgreSQL and browser upload/download
were rerun successfully after the upgrade.

## Security review and limitations

The implementation covers size DoS, malformed multipart input, traversal, direct-object
access, MIME spoofing, common executable content, storage collision, hash mismatch, header
injection, transaction cleanup and secret/content logging boundaries. PostgreSQL storage
growth must be monitored, and encrypted off-host backup remains deployment responsibility.
No antivirus provider, authenticity signature, OCR, preview, advanced search, automatic
purge or evidence package export is claimed.

## Definition of Done

All 33 required criteria pass: REAL upload, PostgreSQL authority, storage abstraction,
SHA-256 and download verification, corruption/missing-byte rejection, path/header/size/MIME
safety, incident isolation, non-REAL rejection, audit, history-preserving withdrawal,
coherent backup/restore/integrity/rehearsal, valid Stage 1–24 migration history, retired
product boundaries, readiness, unit/PostgreSQL/browser/audit/startup gates, repository
hygiene and the three final reports.

Foundation exit assessment: **no unresolved FOUNDATION BLOCKER**. Foundation is complete;
there is no Stage 26 recommendation.
