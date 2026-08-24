# Foundation Stage 16 — Imports Persistence + Orchestration Integrity

Status: **NOT READY — exact-final-SHA remote CI pending**

## A. Stage 15 merge verification

PR #12 was reverified live at exact head `eb0474e693ca2e0628173e3703aab4a3166a095e`: OPEN and DRAFT before the authorized transition, MERGEABLE/CLEAN, no review blocker, six successful exact-head checks, and report verdict `READY FOR NEXT FOUNDATION SLICE`. It was marked ready and merged using the repository-standard merge-commit strategy as `e7d7f95e6a2b8523b70eb227e247b5610e0f28fe`. The Stage 15 head is an ancestor of updated `origin/main`. Stage 16 branch `agent/foundation-stage-16-imports` was created from that merge in isolated worktree `/tmp/zpp-connect-stage16-imports`; the user's dirty Stage 12 worktree remained untouched.

## B. Current Import route matrix

Pre-implementation audit:

| Surface | Stage 15 production path | Authority / side effect | Gap closed in Stage 16 |
|---|---|---|---|
| `POST /imports/:type` | demo router, broad permission → disk multer → scoped gate | disk file, then memory batch/rows/file/Audit | deliberate type check, bounded memory parser, scoped gate, one PostgreSQL validation transaction |
| `POST /imports/:id/confirm` | memory batch + row Map → Passenger/Family repository | target repository creates a second/final batch authority | durable batch/rows loaded server-side; one Import-owned transaction |
| `GET /files` | generic memory resource | memory file/batch projection | truthful projection from durable Import batches, with `sourceStored: false` |
| Import detail / rows / session list | absent | none | scoped detail, paged rows, session list |
| dormant `routes/index.ts` Import router | constructed but never mounted | unsafe disk/reparse implementation | remains non-mounted; never selected by production composition |

## C. Current authority matrix

| Concern | Stage 15 memory | Stage 15 filesystem | Stage 15 PostgreSQL | Stage 16 authority |
|---|---:|---:|---:|---|
| validated batch/count/status | yes | no | no | `ImportBatch` |
| exact normalized reviewed rows | Map | raw CSV could differ later | no | `ImportValidatedRow` |
| source provenance | partial | filename/path | no digest | `ImportBatch` filename/MIME/size/SHA-256 |
| source bytes | no | durable local file | dormant `StoredFile` path only | ephemeral request buffer; not retained |
| final batch/status | memory overlay | no | repository-created row | locked existing `ImportBatch` transition |
| target records | no | no | yes | PostgreSQL in same Confirm transaction |
| validation Audit | memory | no | no | PostgreSQL validation transaction |
| confirmation Audit/Timeline | no | no | yes | PostgreSQL Confirm transaction |
| review/list/count | memory | no | partial | PostgreSQL only |

## D. Current side-effect ordering

| Stage 15 order | Step | Persistent? | Scoped authorization complete? |
|---:|---|---:|---:|
| 1 | broad `import:create` | no | no |
| 2 | `upload.single("file")` disk write | yes | no |
| 3 | Incident permission gate | no | yes |
| 4 | `readFileSync(req.file.path)` | reads durable file | yes |
| 5 | `createRow("import-batches")` | process only | yes |
| 6 | `importRowsByBatchId.set` | process only | yes |
| 7 | `createRow("files")` | process only | yes |
| 8 | compatibility Audit | process only | yes |

Stage 16 order is: deliberate type validation → bounded `memoryStorage` multipart parse → effective target-Incident permissions/writability → CSV security/parse/row validation → one PostgreSQL validation transaction. There is no durable filesystem write.

## E. Current restart gap

| Restart point | Stage 15 | Stage 16 |
|---|---|---|
| after Validate commit/response | batch and rows disappear | batch/rows/provenance/Audit survive |
| before Confirm | Confirm cannot recover Map | GET + paged review + Confirm reload PostgreSQL |
| after Confirm commit, before response | target/final DB row commit but memory state is stale | replay returns the same final batch with zero writes |
| after Confirm | target data survives; Files/workflow state does not | target, final batch, rows and projection survive |

## F. Current security gap

Stage 15 wrote a disk file before scoped authorization. An actor with broad permission from Incident A and only an unrelated assignment in Incident B could therefore leave a persistent filesystem side effect before denial. Its type permission resolver also treated every non-`manifest` value as Family before route validation. Stage 16 validates `manifest|family` deliberately, parses only into bounded request memory, then requires effective permissions and writability before any persistent write. Batch content is not serialized until the durable batch's Incident/type has been loaded minimally and authorized.

## G. Target architecture

`multipart bytes (ephemeral)` → `type/file bounds` → `effective Incident gate` → `parse + validate` → atomic `ImportBatch + ImportValidatedRow + validation Audit` → durable review → `lock batch + lock/recheck Incident` → atomic target adapter + final batch + confirmation Audit + Timeline.

PostgreSQL is the only production Import authority. The memory arrays and disk parser are selected only when no PostgreSQL Import service is composed, which is reserved for automated memory compatibility tests.

## H. Import lifecycle

| Input/current state | Command | Result |
|---|---|---|
| malformed/missing/non-CSV | Validate | controlled 400, no durable batch |
| all valid rows | Validate | `Validated` |
| any row error | Validate | `Validated with errors`; valid subset remains confirmable |
| either Validated state | Confirm | `Imported` or `Imported with errors` atomically |
| either Imported state | Confirm replay | 200 same final result, no writes |
| target conflict / closed Incident | Confirm | controlled 409; batch remains Validated |

No `Importing` state is persisted because Confirm is one database transaction.

## I. ImportBatch model

Migration 19 evolves the existing table with `version`, unique nullable `validationOperationId`, `validationFingerprint`, `sourceMimeType`, `sourceSizeBytes`, `sourceSha256`, `validatedAt`, `validatedById`, `confirmedAt`, `confirmedById`, and `updatedAt`. Constraints enforce positive version, nonnegative size, SHA-256 format, coherent Stage 16 validation provenance, and coherent terminal confirmation provenance. Historical fields remain nullable.

## J. Validated row model

`ImportValidatedRow` stores one row per CSV data row: UUID, batch UUID, original row number, `VALID|INVALID`, normalized JSON payload, controlled error code/message and timestamp. `UNIQUE(importBatchId,rowNumber)` and the `(batch,rowNumber)` / `(batch,status,rowNumber)` indexes support exact ordered review and filtering. Valid payloads are the exact server-normalized target inputs; invalid payloads plus controlled errors reproduce the review result. Confirm never reparses client content.

## K. Source provenance

The request buffer is hashed with SHA-256. Filename is basename/control-character sanitized; MIME, byte length and digest are persisted. Source bytes are not retained, no `StoredFile` is created, no `storageKey` or server path is exposed, and Confirm depends only on durable normalized rows. `GET /files` is explicitly a provenance projection with `sourceStored: false`, not a download promise.

## L. Validation idempotency

The client generates one UUID operation ID when a file/type attempt is selected and keeps it across transport failure. Fingerprint = SHA-256 over stable `incidentId + importType + sourceSha256`. First commit returns 201; same ID/fingerprint replay returns 200 with the same durable batch/preview; same ID with different content/type/Incident returns controlled 409. Concurrent same-operation requests serialize on the Incident lock and create one batch/Audit.

## M. Validation transaction

After authorization and parsing, the service locks the Session row and rechecks that it exists and is not Closed/Archived. It creates the batch, writes rows in bounded 500-row database chunks, and creates one safe validation Audit inside one transaction. Failure during row write or before Audit rolls back batch, rows and Audit. A post-commit response loss is recovered via the unique operation ID.

## N. Confirm transaction

Confirm locks the `ImportBatch`, reloads its authoritative type/Incident/status, returns immediately for a terminal batch, then locks/rechecks the Session. It verifies durable row counts, reparses the server-owned normalized payload through the established Passenger/Family validators, writes target records through shared transaction-local adapters, writes one confirmation Audit and one Timeline event, and finalizes the existing batch with actor/timestamp/version—all in one transaction.

## O. Confirm replay semantics

Batch ID is the idempotency identity. First actual import returns 200 with `replayed: false`. Every later or waiting caller returns 200 with `replayed: true` and the same final durable counts/status. Replays create zero target records, Audits or Timeline events.

## P. Passenger adapter

The Passenger repository's operational-ID/source-data logic was extracted into the shared `createPassengerImportRecords` transaction-local adapter and remains used by the repository compatibility method. Stage 16 owns batch lifecycle and invokes that adapter inside Confirm. DOB/age validation is re-applied, Incident/source batch/actor/imported timestamp are set, and the existing partial unique source identity remains authoritative. A specific Passenger source-identity P2002 is translated to a safe Import-scoped 409; unrelated database failures remain server failures.

## Q. Family adapter

The Family repository's operational-ID, normalized contact, Family row, passenger-link and RelationshipClaim creation logic was extracted into the shared `createFamilyImportRecords` adapter. It validates every linked Passenger belongs to the same Incident and creates Family rows plus current IMPORT claims in the Confirm transaction. Injected failure after these writes proves every Family/claim is rolled back with batch/Audit/Timeline.

## R. Incident authorization

| Type | Validate/read/rows/Confirm permissions | Incident source |
|---|---|---|
| manifest | effective `import:create` + `passenger:create` | Validate form; durable batch thereafter |
| family | effective `import:create` + `family:create` | Validate form; durable batch thereafter |

Validate and Confirm additionally require a writable Incident. Detail/rows/history remain readable after closure when authorized. The Stage 14 effective-access graph remains authoritative, including System Admin override, active DENY, revocation/expiry and assignment eligibility. Tests cover GROUP permission in A + unrelated assignment B denial, active DENY, revoked DENY recovery and GLOBAL operation.

## S. Upload-before-auth closure

The PostgreSQL router uses a dedicated multer `memoryStorage` boundary with one file, 20 MB, eight fields and 16 KB field limits. Type is checked before upload parsing. Target-Incident authorization occurs before CSV parsing and every durable write. The production generic memory Files route and legacy disk Import routes are registered only when the PostgreSQL Import service is absent.

## T. PII/logging

Normalized Passenger/Family payloads exist only in `ImportValidatedRow` and authorized row responses. Validation and confirmation Audit metadata contain batch/type/filename/digest/counts/operation/request identifiers only. No raw CSV, row values, email/phone/PNR/ticket/relationship text, filesystem path or multipart object is logged or audited. Unexpected errors retain generic HTTP 500 responses.

## U. Audit

Validation creates exactly one `validate_import` Audit per actual durable command. Confirmation creates exactly one `import_passenger_manifest` or `import_family_records` Audit per actual import. Operation and batch replay create zero additional Audits. Both writes are transactionally required; injected failure fully rolls back.

## V. Timeline

Validation creates no Timeline noise. Actual Confirm creates exactly one existing domain event: `passenger_import` or `family_import`. Replay creates none. Injected Timeline failure rolls back target rows, confirmation Audit and final batch state.

## W. Read API

- `GET /imports/:id`: scoped batch status/counts/provenance/timestamps; no paths.
- `GET /imports/:id/rows`: scoped, stable `rowNumber ASC`, `limit` 1–200, offset and optional `VALID|INVALID` filter.
- `GET /sessions/:sessionId/imports`: scoped durable list filtered to types the actor may operate.
- `GET /files`: compatible truthful provenance projection from the same durable list.

Malformed and nonexistent batch identifiers return the same controlled 404 boundary. GET handlers perform no reconciliation or mutation.

## X. Preview/paging

Validate reloads the first ten durable rows for its bounded preview. Counts always cover the complete batch. Deeper review uses the paged row endpoint; a 1,005-row test returns 105 rows at offset 900 with a 200 limit and imports all 1,005 valid rows.

## Y. Frontend

The existing select → validate → preview/errors → confirm → final flow remains. The browser generates and retains an operation UUID, retains the durable batch ID in Incident-keyed local storage, reloads batch state from the server, confirms with batch ID only, treats terminal replay as success, renders a bounded preview, and uses server status for controls. Existing global closed-session fallback semantics remain; the Stage 16 PostgreSQL browser gate verifies disabled controls when the server exposes only the closed selected Incident.

## Z. Restart durability

Dedicated tests reconstruct `createApp()`/Import service between manifest Validate, GET/rows, Confirm and final GET; repeat the sequence for Family; and verify durable target records/claims, final batch, Audit and Timeline. No original process, Map, source file or client row payload participates.

## AA. Concurrency

| Race | Result |
|---|---|
| same validation ID + same bytes | `[201,200]`, one batch/Audit |
| same validation ID + different bytes | controlled 409 |
| concurrent Confirm | `[200,200]`, one actual import |
| lost-response Confirm replay | final 200, zero duplicate |
| Confirm vs Incident close | full import-first then close, or close-first 409/zero import |
| Validate vs Incident close | complete validation-first, or close-first 409/zero validation |
| post-validation source conflict | 409, validated batch unchanged |
| batch read during Confirm | old committed Validated view, then final Imported; GET writes nothing |

## AB. Rollback/failure injection

Constructor-only test hooks cover during validated-row write, before validation Audit, before target write, after target write, before confirmation Audit and before Timeline. Tests prove zero partial batch/rows/Audit for validation and zero partial Passenger/Family/RelationshipClaim/Audit/Timeline/final transition for Confirm. Infrastructure injections remain generic 500; expected domain/source conflicts are controlled 409.

## AC. Scale

The 1,005-row manifest test proves exact counts, ten-row preview, paged review, no 200-row cap and all valid target writes. Rows are stored individually and written in chunks; no whole-batch process Map survives the request. Confirm necessarily materializes the authorized valid payloads only for the transaction, then releases them.

## AD. Seed/backfill

The normal seed does not fabricate validation history. A rehearsal-only Stage 15 final ImportBatch was inserted with known historical evidence before migration 19; after upgrade its new operation/digest/validation/confirmation fields remained null. No validated rows were invented. New demo validation data was not required.

## AE. Migration rehearsal

Local exact rehearsal: 18 Stage 15 migrations + current seed (6 Users, 2 Sessions) → insert one historical final ImportBatch → apply only migration 19 → retain all data and historical batch with null new provenance → `ImportValidatedRow` present → dedicated Stage 16 16/16 PASS. CI reproduces the historical migration chain, inserts the legacy final batch and verifies the same 19/count/null invariants.

## AF. Production legacy removal

`PERSISTENCE_MODE=postgres` always composes `PrismaImportService` and registers its router before compatibility surfaces. The generic memory Files route plus legacy `importBatches`, `importRowsByBatchId`, `createRow`, disk read/upload and repository-created batch path are wrapped behind `!options.importService`; production cannot select them. They remain only for the existing automated memory adapter. The older `api` router in `routes/index.ts` is not mounted by `registerRoutes` and is not production authority.

## AG. Test totals

- Fresh migrations/seed: 19/19 PASS.
- Foundation PostgreSQL Stage 1–16: 206/206 PASS, zero skipped.
- Dedicated Stage 16 PostgreSQL: 16/16 PASS.
- Unit/memory: 99/99 PASS (PostgreSQL suites intentionally excluded from this command).
- General Playwright: 73/73 PASS after the two independently rerun browser flakes passed; final clean rerun pending before handoff.
- Dedicated PostgreSQL Stage 16 Playwright: 3/3 PASS.
- Typecheck and production build: PASS.
- Production dependency audit: 0 vulnerabilities.
- `git diff --check`: PASS.

## AH. CI exact-SHA evidence

Pending first implementation commit and remote checks. CI has been updated to run 206 PostgreSQL tests, dedicated 16-test Stage 16 gate, dedicated PostgreSQL browser workflow, Stage 15→16 migration rehearsal, general typecheck/unit/build/browser and production dependency audit. Report verdict cannot become READY until all six checks succeed on the exact final SHA.

## AI. Remaining split-brain

Remaining production Import split-brain: **none identified**. PostgreSQL is authoritative for validation, review, counts, lifecycle, Confirm and projection; source bytes are explicitly ephemeral rather than a second authority. The memory adapter and dormant non-mounted router remain test/unreachable compatibility code, not production state.

Other application split-brain candidates remain outside Stage 16: Exports/Reports disclosure orchestration, Readiness projections, Exercise inject/observation compatibility, and small static configuration surfaces.

## AJ. Risks — max 10

1. The memory Import adapter remains for automated compatibility tests and must never be composed in production.
2. Local request memory is bounded at 20 MB, but very wide CSV rows can still increase parse/validation CPU within that bound.
3. Confirm loads all valid normalized payloads for one transaction; tested at 1,005 rows, but substantially larger operational limits should be capacity-tested before increasing the upload bound.
4. PostgreSQL sequence allocation can leave harmless operational-ID gaps after rollback.
5. Source CSV bytes are intentionally not retained; provenance proves content identity but cannot reproduce the original byte stream without an external governed source.
6. The dormant non-mounted router should eventually be deleted when the broader legacy routing consolidation slice is authorized.

## AK. Next Foundation candidate

Selected Stage 17 candidate: **Exports / Reports disclosure integrity and durable generation provenance**. It is the next coherent boundary over sensitive derived data and authorization, but no Stage 17 code is implemented here.
