# Foundation Stage 17 — Exports / Reports Disclosure Integrity + Durable Generation Provenance

Status: **NOT READY — implementation and exact-SHA evidence pending**

## A. Stage 16 merge verification

PR #13 was reverified live at exact head `4693e355c08e2a798240d696f6891cb8bcd41119`: OPEN and DRAFT before the authorized transition, MERGEABLE/CLEAN, no review blocker, report verdict `READY FOR NEXT FOUNDATION SLICE`, and six successful exact-head checks. It was marked ready and merged using the repository-standard merge-commit strategy as `e99e1d53681fd92a3f8f28e39cd7e5919e816fa9`. The Stage 16 head is an ancestor of updated `origin/main`. Stage 17 branch `agent/foundation-stage-17-exports-reports` was created from that merge in isolated worktree `/tmp/zpp-connect-stage17-exports-reports`; the user's dirty Stage 12 worktree remained untouched.

## B. Current route matrix

Pre-implementation production composition trace: `createApp` → `registerRoutes` → mounted `createDemoRouter`. The large module-level `api` router in `routes/index.ts` is constructed but never mounted.

| Route | Mounted Stage 16 production behavior | Mutation | Stage 17 closure |
|---|---|---:|---|
| `GET /exports/:type` | compatibility arrays, dynamic CSV, compatibility Audit | yes | production 405; replaced by POST command |
| `POST /exports/:type` | absent | no | scoped PostgreSQL snapshot + provenance command |
| `GET /reports/session-summary` | compatibility dashboard/arrays | no | PostgreSQL permission-filtered projection |
| generation detail/list | absent | no | scoped, paged metadata only |
| `pdf-session-summary`, `aar-draft` | mounted endpoint returns 501 | no | remain unavailable |
| dormant `routes/index.ts` export/report | direct Prisma but broad permission, dynamic model serialization, PDF active | yes for export | remains non-mounted and is not production authority |

## C. Current source authority

| Dataset | PostgreSQL durable authority exists | Mounted export/report reads before Stage 17 | Risk |
|---|---:|---|---|
| Session | yes | `sessions[]` | stale or request-history dependent |
| Enquiry | yes | `enquiries[]` | incomplete compatibility hydration |
| FamilyRecord | yes | `familyRecords[]` | incomplete PII disclosure source |
| PassengerRecord | yes | `passengerRecords[]` | incomplete PII disclosure source |
| MatchingRecord | yes | `matchingRecords[]` | derived-context leakage/staleness |
| Request | yes | `requests[]` | derived-context leakage/staleness |
| AuditLog | yes | `auditLogs[]` | incomplete and recursively mutated by GET |

## D. Current permission matrix

All mounted routes first use `IncidentPermissionGate`, but optional package/report fields then use broad `can(req, ...)` compatibility checks. Export/report gates also request compatibility hydration and accidentally require a writable Incident.

| Artifact/data | Intended effective target-Incident permissions |
|---|---|
| all exports | `export:create`, `session:read` |
| enquiry-log | plus `enquiry:read` |
| family-register | plus `family:read` |
| passenger-register | plus `passenger:read` |
| matching-log | plus `matching:read`; related operational IDs redacted without their source permission |
| requests-log | plus `request:read`; related operational IDs redacted without their source permission |
| audit-log | plus `audit:read` |
| session-package | base permissions; include each optional section only with its effective source permission |
| session-summary | `reports:read`, `session:read`; domain fields individually permission-filtered |
| historical Closed/Archived | same disclosure permissions; no writability requirement |

## E. Current field/column matrix

The approved compatibility contract is snapshotted below. Stage 17 schemas keep deterministic names/order; security redaction is explicit rather than model-driven.

| Section | Explicit Stage 17 columns |
|---|---|
| Session | `operationalId, mode, status, eventType, flightNumber, route, startedAt, endedAt` |
| Enquiries | `operationalId, caseId, contactChannel, callerName, callerPhone, callerEmail, callerLocation, preferredLanguage, claimedRelationship, passengerName, enquiryType, urgency, status, notes, createdAt, updatedAt` |
| FamilyRecords | `operationalId, caseId, familyName, claimedRelationship, phone, email, preferredContactChannel, preferredLanguage, verificationStatus, verifiedRelationship, verificationDecisionBy, verificationDecisionAt, verificationNotes, immediateNeeds, createdAt, updatedAt` |
| PassengerRecords | `operationalId, caseId, personType, passengerName, dateOfBirth, age, gender, nationality, flightNumber, route, seat, pnr, ticketNumber, manifestVersion, source, conditionStatus, holdStatus, travellingCompanions, notes, createdAt, updatedAt` |
| MatchingRecords | `operationalId, caseId, familyOperationalId, passengerOperationalId, enquiryOperationalId, status, matchBasis, holdCheck, decisionNotes, createdAt, updatedAt` |
| Requests | `operationalId, caseId, category, priority, requester, ownerAssignedTo, details, approvalStatus, status, enquiryOperationalId, familyOperationalId, passengerOperationalId, createdAt, updatedAt` |
| AuditLog | `action, actorEmail, actorDisplayName, summary, createdAt` |

## F. Current disclosure risks

| Boundary | Stage 16 behavior | Stage 17 requirement |
|---|---|---|
| formula strings | executable spreadsheet prefixes preserved | neutralize untrusted string cells centrally |
| schema boundary | dynamic union of object keys | explicit versioned schemas |
| snapshot | arrays hydrated through separate reads | one repeatable-read transaction client |
| provenance | compatibility Audit says downloaded | durable truthful `Prepared` generation + `export_prepared` Audit |
| response ordering | Audit then direct bytes, not one DB authority | provenance/Audit commit before bytes |
| idempotency | none | unique operation ID, generic controlled conflict |
| scale | compatibility/list hydration may cap | deterministic DB chunks, tested beyond 1,000 |
| closed incidents | accidental writable gate | authorized historical disclosure allowed |
| report denial | unauthorized domains can look empty | omit unavailable fields and expose safe availability map |

## G. Target architecture

`POST command` → deliberate CSV type/operation validation → target-Incident EffectiveAccess gate → PostgreSQL `REPEATABLE READ` transaction → effective access re-evaluation in that snapshot → bounded deterministic source paging → explicit schema mapping/redaction → formula-safe UTF-8 CSV serialization → exact SHA-256/byte/count calculation → atomic `ExportGeneration + export_prepared Audit` → commit → attachment bytes. No artifact byte is sent or retained before commit.

## H. Export type contract

Supported production artifact types remain exactly: `session-package`, `enquiry-log`, `family-register`, `passenger-register`, `matching-log`, `requests-log`, and `audit-log`, all CSV. `pdf-session-summary` and `aar-draft` remain controlled 501 unavailable formats. Production GET export returns 405 with `Allow: POST`; it cannot mutate Audit state.

## I. EffectiveAccess policy

The mounted router uses Stage 14 `IncidentPermissionGate` for target-Incident scope and the service re-evaluates `EffectiveAccessService` through the transaction client. GLOBAL, GROUP, System Admin, active DENY, and expired/revoked override semantics therefore come from one authority. Broad request permissions and frontend state are only preliminary/advisory. Tests prove GROUP authority in A plus unrelated assignment in B cannot disclose B.

## J. Session-package policy

Every package requires effective `export:create + session:read`. `Session` is always present. Each optional domain section is queried and included only when its source permission is effective in that Incident. Unauthorized sections, labels, rows, and counts are absent. A Passenger-only package persisted `includedSections = [Session, PassengerRecords]` and only those two counts. Package provenance metadata is inspectable only with `audit:read`; single-dataset provenance requires that dataset permission.

## K. PostgreSQL source queries

`PrismaExportService` queries Session, Enquiry, FamilyRecord, PassengerRecord, MatchingRecord, WelfareRequest, and AuditLog directly. Select clauses are explicit. Domain rows are read in 500-row chunks ordered by `createdAt, id`. Matching/Request joins supply only operational IDs and redact each related-domain enrichment unless its source permission is effective. Compatibility hydration is not invoked.

## L. Snapshot consistency

All Session and domain queries, schema mapping, serialization, digest/count creation, provenance, and Audit for one artifact use one transaction client at PostgreSQL `REPEATABLE READ`. The 600-row two-page race inserted a 601st row from another connection between pages; the in-flight artifact remained exactly 600 rows and the next generation included the later commit.

## M. Explicit schemas

`exportColumnSchemas` declares deterministic `stage17-v1` columns for every section. Prisma `select` clauses and schema mappers prevent future fields from appearing automatically. The pre-implementation approved names are preserved. Internal IDs, source keys, versions, security metadata, Audit metadata/IP/user agent, and arbitrary model properties are excluded.

## N. CSV structural safety

The central encoder produces UTF-8 comma-separated text with deterministic headers, doubled quotes, and quoting for comma/CR/LF. Unicode, commas, quotes, and embedded newlines round-trip through the CSV parser. No BOM, XLS/XLSX, HTML, macro, or PDF representation is introduced.

## O. Formula-injection closure

Untrusted string cells whose leading content can be interpreted as `=`, `+`, `-`, `@`, tab, CR, or leading-space formula content receive a leading apostrophe before normal CSV quoting. Typed numbers/booleans/dates are encoded by type, so a real numeric `-12` remains `-12`. Unit and all relevant operational export tests cover the requested attack strings.

## P. ExportGeneration model

Migration 20 adds `ExportGeneration`: UUID ID, globally unique UUID operation ID, semantic fingerprint, Incident/type/format/schema version, controlled filename, exact SHA-256/byte size, domain row count, JSON structural section counts/names, preparing actor/time/request ID, immutable semantic status `Prepared`, and timestamps. Foreign keys, allowed type/format/status, SHA/fingerprint, nonnegative counts/size, filename, JSON-shape constraints, and scoped indexes are installed.

## Q. Generation provenance

Only structural metadata persists. `rowCount` excludes the one Session metadata row; `sectionCounts` explicitly includes it as `Session: 1`. SHA-256 is computed over the final artifact buffer, and byte size is `buffer.byteLength`. No CSV bytes, raw rows, PII payload, browser state, file path, `StoredFile`, local file, or object-storage reference persists.

## R. Operation ID semantics

First operation ID may return the 200 attachment. Any completed reuse returns controlled 409: “already prepared; start a new export.” Different Incident/type/fingerprint and different actors receive the same generic conflict with no generation metadata. Exact artifact replay is deliberately not promised because bytes are not stored.

## S. Concurrent generation

Two concurrent requests with one operation ID produce one 200 and one controlled 409, exactly one `ExportGeneration`, and exactly one Audit. Expected unique/transaction contention is narrowly mapped without exposing P2002/P2034/P2010/SQL; unrelated infrastructure failures remain 500.

## T. Honest delivery semantics

Durable `Prepared` means the server committed provenance for exact bytes before attempting the HTTP response. It does not claim Downloaded, Delivered, Saved, or browser receipt. There is no re-download endpoint and no fake post-response state. Transport failure after commit is an honest acknowledged limit without artifact storage.

## U. Audit

`export_prepared` is inserted in the same transaction as `ExportGeneration`. Metadata contains only generation/type/format/schema/sections/counts/digest/size/operation/request identifiers. Audit failure and the post-Audit failure seam roll both records back and return JSON 500 rather than CSV. An audit-log export selects its snapshot before its own Audit; a later audit export may include the earlier preparation event.

## V. PII-safe provenance

Provenance and Audit contain no names, phone/email, PNR/ticket, notes, source rows, or exported values. A PII-heavy Passenger artifact test verifies those values exist only in response bytes, not durable generation/Audit JSON. Application error logs receive unexpected exceptions, not serialized artifact rows.

## W. Closed/archived policy

Authorized disclosure and read-only Session Reports are allowed for both Closed and Archived Incidents. No writable check is applied. Operational mutation policies remain unchanged; tests prove historical export/report access without reopening writes.

## X. Session-summary architecture

GET `/reports/session-summary` is a PostgreSQL-only computed projection in one `REPEATABLE READ` snapshot. It requires effective `reports:read + session:read`, queries explicit Session metadata and authorized domain metrics directly, and creates no Audit, generation, cache, compatibility hydration, or version change. A fresh process produces the same durable result.

## Y. Session-summary field permissions

The response has an explicit safe `availability` map. Counts appear only for domains the actor can read; unauthorized counts are omitted rather than represented as zero. Holds and urgent requests are omitted without `matching:read` / `request:read` and use narrow non-PII schemas when included. Release and Import counts follow effective `release:read` and the established `import:create` capability respectively.

## Z. Frontend

ReportsPage retains its card layout and protection message. Supported cards call an authenticated JSON POST with a fresh `crypto.randomUUID()` per click, decode controlled JSON errors, honor `Content-Disposition`, read the exposed generation ID header, and create the browser Blob download. Tokens never enter URLs. PDF/AAR cards stay disabled; broad UI capability checks remain advisory.

## AA. Scale

Synchronous policy: maximum 20,000 disclosed domain rows and 20 MB final artifact bytes, with controlled 413 errors and no provenance. PostgreSQL queries use stable 500-row chunks. The required Passenger register exported all 1,005 rows in deterministic order, persisted count 1,005, and showed no 200-row truncation. Multi-section packages use the same aggregate bound.

## AB. Restart durability

Direct durable records were created, the app/service was reconstructed, and exports/reports disclosed them without compatibility hydration. A second reconstruction read surviving generation metadata. Artifact bytes are intentionally not restart-replayable because they are not stored.

## AC. Rollback/failure injection

Hooks cover before source query, during paging, before serialization completion, before generation write, before Audit, and after Audit before transaction return. Every injected failure returns no CSV, commits zero generation and zero Audit, and exposes only the controlled internal-server response. Serialization never returns a partial buffer.

## AD. Legacy production removal

Production always composes `PrismaExportService` when PostgreSQL is selected and mounts its router before compatibility routes. The compatibility GET export/report code, array reads, dynamic `workbookBuffer`, broad `can(req, ...)`, and `addAudit` path are entirely wrapped behind `!options.exportService`, making them memory-test-only. The separate `routes/index.ts` router remains constructed but non-mounted and is explicitly not production authority.

## AE. Migration/backfill

Migration 20 is additive. No historical generation is created because earlier bytes/digests/counts/actors cannot be proven. The seed creates no fake export history. Existing Stage 16 `ImportBatch`, `ImportValidatedRow`, Operational Briefing, identity/access, and operational records require no rewrite.

## AF. Migration rehearsal

Exact local rehearsal: deploy the 19 Stage 16 migrations → current seed (6 Users, 2 Sessions) → add one real validated Import batch + row and one Operational Briefing → apply only migration 20 → retain all three fixtures unchanged → `ExportGeneration` exists with zero fabricated rows → dedicated Stage 17 18/18 PASS on the upgraded database. Observed invariant tuples were `19|6|2|1|1|1` before and `20|1|1|1|0` after.

## AG. PostgreSQL tests

- Fresh migrations/seed: 20/20 PASS.
- Foundation PostgreSQL Stage 1–17: 224/224 PASS, zero skipped.
- Dedicated Stage 17 PostgreSQL: 18/18 PASS.
- Unit/memory: 101/101 PASS (PostgreSQL suites intentionally excluded from that command).
- Typecheck, Prisma validate, production build, and `git diff --check`: PASS.

## AH. Browser tests

- General memory Playwright: 73/73 PASS.
- Dedicated PostgreSQL Stage 17 Playwright: 3/3 PASS.
- Dedicated PostgreSQL Stage 16 regression Playwright: 3/3 PASS.
- Coverage verifies Passenger and session-package POST downloads, controlled server error, denied actor, filename, operation ID, generation header, and unavailable PDF/AAR.

## AI. Production startup/audit

Production `NODE_ENV=production AUTH_MODE=entra PERSISTENCE_MODE=postgres` startup PASS: `/health` 200 reports PostgreSQL, auth config exposes only `MICROSOFT_SSO` with development access false, development users 404, and unauthenticated export POST 401. Production dependency audit reports 0 vulnerabilities.

## AJ. Exact-SHA CI

Pending first implementation commit and remote checks. CI now runs 224 PostgreSQL tests, the dedicated 18-test Stage 17 suite, both Stage 16 and Stage 17 PostgreSQL browser workflows, exact Stage 16→17 migration rehearsal, general typecheck/unit/build/browser, and production dependency audit. Verdict cannot become READY until the exact implementation SHA and any later report-only SHA pass all required checks.

## AK. Remaining split-brain

No production Export/Session Report split-brain remains. Remaining Foundation candidates ranked:

1. Exercise Inject / Observation compatibility writers — active production writer authority and evidence/audit integrity.
2. Readiness computed projections — read-only but vulnerable to hidden 200-row enumeration and incomplete operational decisions.
3. Generic memory-route / dormant router consolidation — broad technical debt with mixed boundedness.
4. Admin/static dictionary and configuration surfaces — lower operational-data centrality.

## AL. Risks — max 10

1. The bounded synchronous 20,000-row/20 MB policy requires future capacity review before increasing either limit.
2. A committed `Prepared` generation may outlive a failed network response; without stored bytes a new operation is required.
3. Package metadata requires `audit:read`, so an ordinary preparer may see the response ID but cannot later inspect package provenance.
4. Matching/Request related operational IDs are blank when source permissions are absent; consumers must not interpret blank as a missing durable relation.
5. Compatibility export/report code remains for memory tests and must never be composed in PostgreSQL production.
6. The dormant non-mounted router still contains unsafe duplicate PDF/export behavior and should be deleted in a later consolidation slice.

## AM. Next Foundation candidate

Selected Stage 18 candidate: **Exercise Inject / Observation persistence + evidence integrity**. It ranks first because production mutation authority and audit/evidence correctness outweigh the read-only Readiness gap. No Stage 18 code is implemented here.
