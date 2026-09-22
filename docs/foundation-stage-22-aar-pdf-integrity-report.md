# Foundation Stage 22 — AAR / Post-Incident Reporting and PDF Integrity

Status: **IMPLEMENTED — LOCAL GATES PASSED; EXACT-HEAD REMOTE CI PENDING**

Validated on 2026-09-21 on branch `agent/foundation-stage-22-aar-pdf-integrity`.
All final executable-code gates below ran on `03a5282c8c9e425c62a306b31f5f623da4ece9d8`.
The subsequent closure commit changes documentation only. Nothing was pushed or merged.
The plan's exact-SHA CI requirement remains open; this report does not claim formal READY.

## A. Objective and implemented scope

Stage 22 adds one durable After Action Report per canonical Session, supporting REAL,
EXERCISE and TRAINING events. It covers authoring, review, approval, immutable revision
history, optional Exercise Observation evidence, and retained, integrity-checked PDF
artifacts. It reuses EffectiveAccess, incident permission gates, transactional Audit,
PostgreSQL production composition, PDFKit and existing UI primitives.

The baseline was closed separately; see [baseline closure](foundation-stage-22-baseline-closure.md).
The existing Stage 12 acknowledgement/withdrawal contract and preserved old Stage 12
stash were not replaced. No unrelated production domain behavior was redesigned.

## B. Persistence and migration

Migration `20260921150000_after_action_reports_integrity` is migration **23**. Earlier
migrations are unchanged. Seven models implement the detailed decomposition in the
plan; its earlier reference to five tables was not the authoritative decomposition.

| Model | Authority |
|---|---|
| `AfterActionReport` | Unique Session association, sequence-backed `AAR-YYYY-NNNNNN`, owner, aggregate version and archive provenance |
| `AfterActionReportVersion` | Ordered revision, approved base reference, lifecycle, content digest, actor/time/context snapshots |
| `AfterActionFinding` | Ordered finding text and optional immutable source-observation revision reference |
| `AfterActionLesson` | Ordered lessons identified |
| `AfterActionCorrectiveAction` | Ordered recommendation, optional owner and target date; not a task engine |
| `AfterActionOperation` | Unique command identity/fingerprint and bounded structural replay result |
| `AfterActionPdfArtifact` | Exact PostgreSQL BYTEA, size, SHA-256, source digest, version, renderer and generation provenance |

Database constraints include unique report per Session, unique revision/order positions,
one mutable revision per report, positive version tokens, safe artifact metadata and
byte-size bounds. Foreign keys use restrictive historical relationships. Triggers
enforce Closed-Session content writes, valid lifecycle/revision ancestry, immutable
approved parents and children, no reparenting, same-Session observation sources,
Approved-only artifact creation, and immutable artifacts and operation records.
The migration creates no artificial reports, revisions or PDFs.

Only the two built-in coordinator roles receive the seven new permissions. The Stage 21
migration-count assertion now permits later migrations without weakening its own checks.

## C. Lifecycle, revisions and historical evidence

Versions follow `Draft → Under review → Approved`; review may explicitly return to
Draft. Draft edits carry `expectedVersion`. Approval requires a nonempty executive
summary and at least one finding or lesson. Approved content cannot be edited or deleted,
including direct SQL changes to its child rows. Corrections deep-copy the latest
Approved revision into a new Draft; there can be only one mutable revision.

The aggregate separately follows Active/Archived. Archive requires no mutable revision
and an explicit reason. Content commands require a Closed Session. Archived Sessions
and reports remain readable under current authorization; exact Approved-version PDF
generation and existing artifact downloads remain available. Active/Draft Sessions are
not authoring candidates. Aggregate and revision optimistic tokens are distinct.

Findings, lessons and recommendations are ordered, with at most 100 entries per section.
Text limits include title 500, summary 50,000 and section text 10,000 characters; strict
request schemas reject client-owned attempts to set provenance/status/hash fields.

Optional Exercise Observation inclusion copies selected same-Session evidence and
records its operational ID and immutable source revision. Clients cannot forge the
source version. Approval snapshots event context and actor names; later source edits or
actor renames cannot change the approved logical content or rendered historical PDF.
Tests cover both source mutation and actor renaming.

## D. Authorization, concurrency and Audit

All routes require authenticated identity and `session:read` for the target Session,
plus the explicit action permissions below. ZPP Coordinator and TEC Coordinator have
default grants; System Admin alone, Group Leader, Member and Observer do not.
Custom GLOBAL/GROUP grants continue through the existing EffectiveAccess model, with
incident assignment, deny overrides, expiry, revocation and user status enforced.
Seed identities with several roles must not be mistaken for System-Admin-only users.

| Permission | Purpose |
|---|---|
| `aar:read` | Authorized report/history/artifact reads and downloads |
| `aar:create` | Create; combined with draft update for later revision |
| `aar:update-draft` | Draft content changes |
| `aar:review` | Submit and return to Draft |
| `aar:approve` | Approval |
| `aar:archive` | Aggregate archive |
| `aar:pdf:generate` | Generate retained PDF, also requiring read |

Observation selection additionally requires `exercise:manage`. Collection denials return
403; inaccessible and missing ID resources share 404 behavior. Unauthenticated access is
401. Service writes re-evaluate effective access inside the transaction after locking
the Session. Lock ordering is Session, report, then version. Conflicting/stale writes
return controlled 409, without automatic retries that could conceal a lost decision.

Create/lifecycle/revision/archive/PDF commands use globally unique operation IDs and
canonical fingerprints binding actor, target, command and validated payload. A matching
retry replays the committed structural result; conflicting reuse is rejected. Draft
PATCH uses optimistic concurrency. Replay does not regenerate bytes or duplicate Audit.

Every committed domain command and its Audit/operation/artifact effects share a database
transaction. Audit contains structural identifiers, status/version/hash/size provenance,
not report free text, archive reason or PDF bytes. Failure injection proves rollback at
Audit and artifact seams. Timeline and notification events are intentionally not added:
the approved MVP plan does not require them. Audit and immutable report history are the
historical record, not a second timeline authority.

## E. API and OpenAPI

The following **16 method/path pairs** are mounted below `/api` under one PostgreSQL
production owner. There is no invented memory AAR adapter.

| Method | Path | Action permission beyond Session read |
|---|---|---|
| GET | `/after-action-reports` | read |
| POST | `/after-action-reports` | create |
| GET | `/after-action-reports/:id` | read |
| GET | `/after-action-reports/:id/versions` | read |
| GET | `/after-action-report-versions/:id` | read |
| PATCH | `/after-action-report-versions/:id` | update-draft |
| POST | `/after-action-report-versions/:id/submit` | review |
| POST | `/after-action-report-versions/:id/return-to-draft` | review |
| POST | `/after-action-report-versions/:id/approve` | approve |
| POST | `/after-action-reports/:id/revisions` | create + update-draft |
| POST | `/after-action-reports/:id/archive` | archive |
| GET | `/sessions/:sessionId/aar-source-observations` | create + exercise:manage |
| GET | `/after-action-report-versions/:id/pdf-artifacts` | read |
| POST | `/after-action-report-versions/:id/pdf-artifacts` | read + pdf:generate |
| GET | `/after-action-pdf-artifacts/:id` | read |
| GET | `/after-action-pdf-artifacts/:id/download` | read |

Collection lookup is Session-scoped. History, source and artifact pages are bounded
(default 50, maximum 200), with full totals and repeatable-read list snapshots. The
1,005-revision test proves late history remains reachable beyond the first 200 rows.

New create/revision/PDF results return 201, their replays 200; other successful commands
return 200. Validation is 400, lifecycle/version conflict 409, oversized content 413,
and integrity failure 500 JSON without a PDF response body. OpenAPI documents strict
requests, parameters, report/version/artifact/capability/page/command responses, errors
and binary download headers. Tests compare all 16 routes to the production manifest,
resolve schema references and assert accurate success/integrity response types.

## F. PDF rendering, hashing and storage

The fixed `aar-pdf-v1` PDFKit template emits A4 plain-text reports, wrapped/paginated
sections, page numbers, operational and artifact IDs, revision, Approved status,
Session/event context, approval and generation provenance, findings, lessons and actions.
It does not interpret HTML or fetch URLs, fonts or images. Runtime dependencies are
unchanged. Tests extract text with test-only Poppler `pdftotext`, including multi-page
content and literal markup. CI installs `poppler-utils`; macOS requires Poppler locally.

Two hashes have different purposes:

- The logical digest hashes canonical `aar-v1` content: recursively sorted object keys,
  ISO dates, preserved section order, historical snapshots and approval provenance.
  Volatile PDF generation metadata and optimistic counters are excluded.
- The artifact digest hashes the exact rendered bytes, which are retained in PostgreSQL
  together with the logical source hash, renderer version, size and generation identity.

Generation recomputes the logical digest before rendering. Download recomputes artifact
SHA-256 and verifies byte size before sending anything. Privileged test corruption of
either source content or stored PDF bytes is rejected; no corrupted bytes are served.
Replay and restart return the same artifact, and later revisions leave old artifacts
byte-identical. A PDF does not embed its own final digest; it carries its artifact ID.

Download uses controlled attachment filename, `application/pdf`, exact Content-Length,
`no-store, no-transform`, and artifact/content/source-hash headers exposed through CORS.
Explicit metadata-only Prisma selections omit BYTEA; query-observer tests verify this.
Artifacts are limited to **10 MiB**, with size checks in renderer and database; over-limit
generation commits neither artifact nor Audit. Existing JSON request limit is 2 MiB.

Final test-fixture measurement: **9 artifacts, 19,505 stored PDF bytes in total, largest
2,211 bytes**. These are small functional fixtures, not a throughput/capacity benchmark.
At the hard limit, 1,000 artifacts alone approach 9.77 GiB before indexes, WAL and backups;
deployment capacity planning must account for immutable history and backup growth.

## G. UI and historical Session selection

Reports links to `/reports/after-action` for authorized users. The page uses existing
form, card, status, confirmation and notification primitives. It provides draft section
editing/reordering, review/return/approval, new revisions, archive, revision history,
artifact metadata/hashes and authenticated binary download. Server capabilities control
actions. Approved views are read-only. Saves preserve input on 400/409/500; explicit
reload asks before discarding edits. A read failure is not displayed as empty history.

**Architectural discovery:** the global active-session selector deliberately excludes
Closed Sessions. AAR therefore has an independent, searched and paginated Closed/Archived
selector (20 rows per page). It never makes historical Sessions globally writable and
does not change the stored global active selection. Selection stays stable while browsing
history and cannot change while unsaved edits are present. Browser tests include more
than one page, Closed/Archived visibility, Active exclusion and unchanged global state.

## H. Migration rehearsal and final validation

The Stage 21 → 22 rehearsal used disposable `zpp_stage22_upgrade_20260921`, cloned from
the successfully validated 22-migration predecessor database. Existing Documents,
Briefings, Imports, Exports, Exercise evidence, Members, Dictionaries and Audit were
present; additional representative predecessor evidence was inserted before migration.
`apps/api/scripts/verify-stage22-upgrade.ts` compared complete row counts and canonical
row-content MD5 fingerprints for **60 predecessor tables**, all unchanged after deploy.
Role rows were checked separately: only seven permission additions to two built-in
coordinator roles were allowed. Migration count became 23 and all seven AAR tables
remained empty. MD5 here is a local before/after comparison, not artifact security.
The same rehearsal is registered after the existing predecessor rehearsal in CI.

The final gate ran in the requested deterministic order on code SHA `03a5282`:

| Gate | Result |
|---|---|
| `npm ci` | PASS, 445 packages |
| `npm run db:generate` | PASS, Prisma 6.19.3 |
| Prisma validate with technical PostgreSQL URL | PASS |
| `npm run lint` | PASS, including workspace typechecks |
| `npm test` | **112 passed**; PostgreSQL files intentionally skipped in unit mode |
| `npm run build` | PASS |
| `npm run test:smoke` | **73/73 passed**, 1.7 minutes |
| `npm audit --omit=dev --omit=optional` | **0 vulnerabilities** |
| `git diff --check` | PASS |
| Brand-new database, entire migration chain | **23/23 deployed from zero** |
| Canonical seed | PASS |
| Full ordered PostgreSQL Stage 1–22 suite | **295/295 passed, 23 files, zero skipped**, 46.33 seconds |
| PostgreSQL Stage 22 Playwright | **5/5 passed**, 8.6 seconds |
| Production PostgreSQL/Entra startup, after all tests | PASS |

The final database was newly created as `zpp_stage22_final_20260921`, not reused from
development. The 295 tests comprise the closed 264-test predecessor plus 31 Stage 22
cases. Coverage includes modes/lifecycle, custom grants and deny/revocation races,
cross-Session isolation, concurrent edits/transitions/create/PDF, SQL immutability,
operation replay, restart, audit rollback, logical/byte corruption, snapshots, 1,005-row
history, metadata-only reads and payload limits. Seven added unit tests cover canonical
content, validation, renderer and OpenAPI. Browser coverage exercises actual downloaded
bytes against persisted metadata, revision history, historical paging, denied access,
error preservation and failed-read recovery.

Production probe ran `NODE_ENV=production AUTH_MODE=entra PERSISTENCE_MODE=postgres`
on API port 4199, strictly **after** PostgreSQL and browser tests had completed:

- `/api/health`: 200, `ok: true`, `persistence: postgres`.
- `/api/auth/config`: 200, development access false, only `MICROSOFT_SSO`.
- `/api/auth/development/users`: 404, development authentication unavailable.

The process was stopped after probing. This checks startup/composition/configuration,
not a real external Entra login; test issuer/audience/JWKS configuration was used.
The final disposable database is removed after these checks; other Stage 22 databases
and the preserved old stash are left alone.

## I. Limitations and deferred scope

### Remote closure follow-up — 2026-09-22

Authorized PR [#19](https://github.com/sossolinski/ZPP-Connect/pull/19) exposed a stale
Stage 17 PostgreSQL browser assertion in the first remote gates on `e66680a`: it still
expected the removed disabled “Exercise/AAR draft” card. The general memory smoke gate
does not include that PostgreSQL-only file. The correction preserves the Session CSV
download and unavailable PDF-summary checks, asserts the new AAR link/navigation, and
explicitly verifies the old `/exports/aar-draft` API still returns 501. No product behavior,
test skipping, retry policy or migration changed. Local validation deployed all 23
migrations and seeded a new disposable database, then passed **8/8** combined Stage 17
and Stage 22 browser tests. Updated exact-head remote checks are still required.

### Retained product limitations

- PDFKit built-in Helvetica lacks full Unicode coverage. Unsupported code points are
  visibly escaped as `[U+XXXX]`, including some Polish characters; original Unicode
  remains in stored/canonically hashed content. Full typographic Unicode support needs
  an explicitly reviewed embedded font. This MVP is not polished multilingual output.
- BYTEA retention is deliberately atomic, not a scalable object-storage system. No
  retention purge, backup/restore drill or production-volume benchmark is claimed.
- Hash verification is not a digital signature or protection against an administrator
  who can replace both bytes and digests. PKI/signatures remain excluded.
- Arbitrary attachments, rich text, DOCX, enterprise corrective-action execution,
  notifications and unrelated Reports redesign remain out of scope.
- Local environment: macOS arm64, Node 24.13.0, npm 11.6.2, PostgreSQL 16.14. Remote CI
  uses Node 22; its exact-head result is not available without the prohibited push.
- The full development dependency graph reports 8 findings (3 moderate, 5 high), while
  the required production-only audit is clean. Existing Prisma config deprecation and
  Vite main-chunk warning (816.53 kB) remain; neither is concealed as a clean warning log.
- Memory-only development does not provide AAR persistence. Meaningful AAR browser
  validation uses PostgreSQL, as required by the production architecture.

## J. Definition of Done assessment

| Plan item | Evidence / assessment |
|---|---|
| 1. One AAR for an authorized Closed Session | PASS: uniqueness, modes and concurrent create tests |
| 2. Session and optional observation association | PASS: same-Session validation and immutable revision FK/snapshots |
| 3. Optimistic Draft editing | PASS: stale and concurrent edit tests |
| 4. Ordered findings | PASS: normalized rows, validation, API/browser/PDF coverage |
| 5. Ordered lessons | PASS: normalized rows and API/browser/PDF coverage |
| 6. Ordered corrective recommendations | PASS: normalized rows, owner/date and renderer coverage |
| 7. Lifecycle and illegal transitions | PASS: service, SQL guards and tests |
| 8. Approval provenance and digest | PASS: actor/time/context snapshot and deterministic hash tests |
| 9. Approved parent/child immutability | PASS: direct SQL UPDATE/DELETE/INSERT protection tests |
| 10. Controlled immutable-content rejection | PASS: HTTP conflict and database enforcement |
| 11. Later revision preserves history | PASS: deep-copy and unchanged approved base tests |
| 12. Exact Approved-version PDF | PASS: lifecycle guard and logical hash verification |
| 13. Persist exact PDF and metadata | PASS: PostgreSQL artifact and restart tests |
| 14. Expose exact SHA-256 and size safely | PASS: metadata-only query and digest assertions |
| 15. Retained download with safe headers | PASS: API and real browser download |
| 16. Recompute/reject corruption | PASS: deliberately corrupted bytes rejected before response |
| 17. Historical authorization/readability | PASS: archive/revision/history and paging tests |
| 18. RBAC and anti-enumeration | PASS: router/service checks, custom scopes, deny and race tests |
| 19. Structural audit/history | PASS: transactional Audit, replay and no-free-body assertions |
| 20. All existing/new gates, no skipped PostgreSQL cases | LOCAL PASS: 112 unit, 295 PostgreSQL, 73 + 5 browser; exact-head remote CI PENDING |

All 20 functional/local DoD items have supporting evidence. Full formal closure is
**not yet claimed** because section P of the plan separately requires exact-SHA CI.
The next authorized handoff is push/review/CI of the final branch; this task explicitly
does not perform that push or merge.

## K. Incremental commits and next stage

The continuation preserves the baseline and incremental history:

- `9f4a78f` — corrected serial acknowledgement/withdrawal histories and baseline closure.
- `66334db` — AAR persistence and database constraints.
- `3e1ff34` — versioned workflow, service/API and retained artifacts.
- `9451b9c` — PDF rendering tests and complete OpenAPI contract.
- `2cf539b` — historical-session UI and PostgreSQL browser gate.
- `58c794c` — complete predecessor-data migration rehearsal.
- `b24fa3e` — logical corruption and metadata-only query coverage.
- `03a5282` — truthful UI read-failure state and regression test.

The closure documentation is committed separately. Earlier lockfile, date assertion and
managed HTTP-listener fixes remain intact; no commits are amended/squashed here.

Recommendation after remote Stage 22 closure: propose **Foundation Stage 23 —
Production Operational Readiness**, scoped through a new plan: backup/restore rehearsal
including immutable artifacts, retention/capacity policy, integrity-failure monitoring
and deployment runbooks. This is a recommendation, not an already approved roadmap.
