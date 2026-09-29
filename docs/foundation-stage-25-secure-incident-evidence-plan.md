# Foundation Stage 25 — Secure Incident Evidence & Foundation Exit Plan

Date: 2026-09-28

Branch: `agent/foundation-stage-25-secure-incident-evidence`

Baseline: `origin/main` at `03a3b15c16593c7c0165451639ea5ec14070ac9f`

## 1. Objective

Add a narrow, production-capable evidence/file capability for authorized real incidents,
prove that its metadata and immutable bytes are recoverable and integrity checked, then
formally assess and close the Foundation programme. Stage 25 must not reopen Training,
Exercise or organisational Readiness product scope.

## 2. Current storage architecture

PostgreSQL is the only verified production data authority. Stage 23 custom-format database
backups protect durable application state and retained AAR PDF bytes. Generated CSV bytes
and import source bytes are deliberately ephemeral.

The baseline `StoredFile` table is dormant: production imports do not populate it and no
production route reads it. It has an optional Session link and basic local-storage metadata,
but no digest, lifecycle, idempotency or integrity contract. `apps/api/src/storage.ts` is a
legacy disk-multer helper used only by the memory/demo router. Its time-and-filename key,
permissive resolver and `DATA_DIR/uploads` layout are not suitable evidence authority.

`DATA_DIR` is a persistent Docker volume, but Stage 23 explicitly excludes it from verified
recovery. Making that filesystem authoritative would require a coordinated second backup
artifact and deployment-specific filesystem guarantees. That adds avoidable failure modes
to the final Foundation stage.

Decision: evolve `StoredFile` as authoritative incident-evidence metadata and add a separate
PostgreSQL byte-artifact table behind a stable storage interface. The first adapter is
PostgreSQL-backed and bounded by the upload limit. The interface keeps domain/API code
independent of a later object-storage implementation. Existing legacy `StoredFile` rows, if
any, remain identifiable and are not reclassified as verified evidence.

## 3. Exact evidence use cases

Supported evidence is directly related to one real incident: photographs, scanned documents,
authority correspondence, operational evidence, external reports, relevant PDFs and concise
incident reference files. Every new artifact belongs to exactly one `REAL` Session.

This is not a general document library, personal drive, SharePoint replacement, LMS,
Training/Exercise repository or arbitrary enterprise file manager.

## 4. Data model

Evolve `StoredFile` with a conditional incident-evidence contract:

- `purpose`: legacy compatibility or `INCIDENT_EVIDENCE`;
- required Session for incident evidence while retaining nullable legacy linkage;
- `fileName`: safe display filename, plus `originalFileName` for the normalized original;
- authoritative detected `mimeType` and separately retained `declaredMimeType`;
- `sizeBytes` and `contentSha256`;
- optional bounded `category` and `description`;
- `status`: `Active` or `Withdrawn` for evidence, legacy state otherwise;
- `version`, `uploadOperationId`, `uploadFingerprint`, `requestId`;
- `scanStatus=NOT_CONFIGURED` unless a real scanner adapter is introduced;
- withdrawal timestamp, actor and reason;
- creator/withdrawer relations and incident/status indexes.

Add `StoredArtifact` keyed by an opaque `storageKey`, containing provider, exact byte length,
SHA-256, immutable `BYTEA` content and creation time. It contains no display filename.

Add `StoredFileOperation` for idempotent upload/withdraw command provenance and replay.
PostgreSQL constraints enforce UUID/digest formats, bounded filenames/text, allowed states,
coherent withdrawal fields, positive versions and the complete evidence metadata shape.

## 5. Storage model

Introduce `EvidenceArtifactStore` with opaque-key `put`, `read`, `inspect` and recovery/test
operations. Domain logic never accepts or resolves a caller path. The production adapter
stores immutable bytes in `StoredArtifact`; the storage key is generated from the server-side
evidence UUID and must match a narrow `incident-evidence/<uuid>` grammar.

The adapter uses create-only semantics. Existing content may be reused only when size and
SHA-256 exactly match an idempotent retry. No write overwrites bytes in place. The dormant
filesystem helper is not reused. A future filesystem/object adapter can implement the same
contract without changing evidence routing or business rules.

## 6. File metadata

PostgreSQL metadata is authoritative. Responses expose evidence identity, incident identity,
safe/original filename metadata, MIME, size, digest, category/description, lifecycle,
uploader and timestamps. They never expose the storage key, provider internals, server paths,
raw content or secrets.

## 7. Hashing and integrity

SHA-256 is computed from received bytes before persistence. Metadata and byte storage retain
the same digest and size. Every read/download recomputes byte length and SHA-256 and compares
both storage and metadata values before headers or bytes are sent. Missing, mismatched or
corrupt content returns a sanitized error and writes an integrity-failure AuditLog entry.

The operational integrity checker scans every bounded incident-evidence row, detects missing
artifacts, size/hash mismatch, invalid references and unreferenced evidence artifacts, and
never repairs them automatically.

## 8. Authorization

Add active permissions `evidence:read`, `evidence:upload` and `evidence:withdraw`. Use the
existing EffectiveAccess plus incident permission gate for every route. A caller needs both
an effective incident-scoped permission and access to that Session. Inaccessible incident or
guessed evidence IDs return non-disclosing 404 responses.

Coordinators receive read/upload/withdraw; group leaders receive read/upload; operational
members receive read where appropriate. System Admin receives no default evidence permission,
avoiding implicit global content access. Lists, metadata, downloads and commands all enforce
the same incident boundary.

## 9. Upload contract

`POST /api/sessions/:sessionId/evidence` accepts one bounded multipart `file` plus UUID
`operationId`, optional category and description. Multer uses memory storage only after a
strict file/field/count limit. The command validates Session, RBAC, writable REAL state,
filename, declared and detected type, content signature, size and digest before persistence.

The server uses the operation UUID for concurrency serialization and command replay. Same
operation plus same fingerprint returns the prior result; different input returns 409.
Storage created by a failed metadata transaction is removed when this invocation created it;
unexpected orphan artifacts are reported by integrity checks.

## 10. Download contract

`GET /api/sessions/:sessionId/evidence/:evidenceId/download` authorizes the incident and
record pair, rejects withdrawn evidence from normal download, reads through the storage
interface, verifies exact size/SHA-256, audits success or integrity failure, and sends only
verified bytes. `Content-Type`, `Content-Length`, `X-Content-SHA256` and standards-safe
`Content-Disposition` are controlled by the server.

## 11. Retention

No business/legal duration is invented. Metadata, audit, operation history and immutable
bytes are retained by default. Retention is an external business/policy decision. Stage 25
adds no automatic application-evidence purge and does not confuse database-backup retention
with incident-evidence retention.

## 12. Deletion and withdrawal semantics

There is no delete endpoint. `POST /api/sessions/:sessionId/evidence/:evidenceId/withdraw`
requires `evidence:withdraw`, writable REAL incident, UUID operation ID, expected version and
a bounded non-empty reason. It atomically tombstones metadata and preserves bytes, creator,
digest, audit and operation history. Replay is idempotent; conflicting/stale commands return
409. Normal lists exclude withdrawn evidence, while authorized history views may include it.

## 13. Audit and history

AuditLog records upload, successful download, withdrawal and integrity failure with IDs,
digest/size/lifecycle metadata and request/operation IDs, never content or paths. Upload and
withdrawal also add concise incident timeline events because they change operational evidence;
downloads do not pollute the timeline. Mutation metadata and AuditLog are committed in the
same PostgreSQL transaction.

## 14. Incident/session linkage

New evidence requires an existing `REAL` Session. Read routes remain available for authorized
closed REAL history; upload and withdrawal use the shared writable-incident rule. Historical
`TRAINING` and `EXERCISE` Sessions remain readable only through their existing surfaces and
cannot receive or mutate evidence.

## 15. Backup and restore interaction

The selected PostgreSQL byte adapter makes the database backup a coherent metadata-and-bytes
backup. Extend Stage 23 critical counts with evidence metadata/artifacts/operations. Extend
the recovery fixture and rehearsal to upload evidence, restore into an empty database,
download and re-hash the restored bytes, and detect intentional corruption. No unsupported
`DATA_DIR` recovery claim is introduced.

Versioned backup-manifest compatibility remains strict. The existing database archive format
can remain unchanged because `pg_dump` already includes the new tables and `BYTEA` content;
runbooks will state the evidence capacity/backup-size implication.

## 16. Security

Controls cover bounded memory and request fields, one file per request, content signature
checks, explicit MIME allow-list, executable/signature rejection, opaque keys, no caller
paths, no overwrite, incident-scoped authorization, non-disclosing object lookup, safe
headers, content-free logs, digest verification and idempotent commands. Tests cover malformed
multipart input, traversal-like names, MIME spoofing, oversized input, guessed IDs and
cross-incident access.

## 17. MIME/type policy

Foundation allow-list: PDF, JPEG, PNG and UTF-8 plain text. Detect PDF/JPEG/PNG signatures;
plain text must be valid UTF-8 without NUL/control-binary content. Declared MIME and extension
must be compatible with detected content. PE/ELF/script-like executable content is rejected.
Unknown archives, office macros, HTML, SVG and generic binaries are not accepted in Stage 25.

## 18. Size limits

Add positive runtime `EVIDENCE_MAX_FILE_SIZE_BYTES`, default 10 MiB, with a bounded accepted
range and production validation. Multer and domain validation use the same value. Empty files
are rejected. The PostgreSQL adapter choice is explicitly conditional on this bound; capacity
monitoring remains a deployment responsibility.

## 19. Filename handling

Treat the browser name as metadata only. Normalize Unicode to NFC, strip any POSIX/Windows
path components, controls and header delimiters, collapse unsafe whitespace, bound UTF-8
length and generate a non-empty display fallback. Storage keys never derive from filenames.
Downloads use an ASCII fallback plus RFC 5987 `filename*` encoding. Cover spaces, Unicode,
quotes, CR/LF and path-like input.

## 20. Malware/scanning boundary

Do not build or claim antivirus. Define an `EvidenceScanner` extension point. The default
adapter explicitly returns `NOT_CONFIGURED`; metadata and UI must not say “scanned”. The
allow-list/signature validation is content validation, not malware scanning. Vendor-specific
quarantine is normal deployment/integration work unless policy selects a provider.

## 21. UI

Add a focused Evidence route in the Operations group, visible by `evidence:read`. For the
selected incident it provides paged active/withdrawn views, filename, category/description,
MIME, size, SHA-256, uploader/time, lifecycle and explicit not-scanned boundary. Authorized
users can upload, download verified content and withdraw with reason. Reuse existing panels,
tables, dialogs and alerts; do not redesign the application.

## 22. API

Implement and register:

- `GET /sessions/:sessionId/evidence` with bounded pagination/status;
- `POST /sessions/:sessionId/evidence` multipart upload;
- `GET /sessions/:sessionId/evidence/:evidenceId` metadata;
- `GET /sessions/:sessionId/evidence/:evidenceId/download` verified bytes;
- `POST /sessions/:sessionId/evidence/:evidenceId/withdraw` tombstone command.

Add all contracts and error responses to OpenAPI and the production route manifest.

## 23. Migration

Add one forward-only migration after the unchanged Stage 1–24 chain. It evolves the dormant
`StoredFile`, creates `StoredArtifact` and `StoredFileOperation`, sequences/indexes/checks and
actor foreign keys. It does not rewrite any historical migration or mutate legacy domain
records. Backfill only safe neutral defaults required to preserve any pre-existing StoredFile
rows; verified evidence invariants apply conditionally to new `INCIDENT_EVIDENCE` rows.

## 24. Test strategy

Unit tests cover key grammar, filename/header safety, type sniffing, size policy, hashing,
scanner boundary and withdrawal rules. PostgreSQL tests cover metadata/bytes, REAL-only
restriction, cross-incident isolation, permissions, pagination, upload replay/conflict,
concurrency, withdrawal replay/stale versions, audit/timeline and dormant legacy compatibility.

Artifact tests prove verified download and rejection of tampered/missing/metadata-mismatched
bytes. Recovery creates meaningful evidence and proves database backup, clean restore,
restored download/hash and corruption rejection. A PostgreSQL-backed Playwright workflow
covers Evidence navigation, upload, list, download and withdrawal without weakening existing
Stage 1–24 tests.

## 25. Foundation exit criteria

Create `docs/foundation-exit-assessment.md` after implementation and full validation. Review
domain foundation, identity/RBAC/resource scope, migration/history/hash/audit integrity,
backup/restore/readiness, product boundary and deployability. Classify remaining work as
FOUNDATION BLOCKER, NORMAL PRODUCT BACKLOG, DEPLOYMENT/INFRASTRUCTURE or BUSINESS/POLICY.
Foundation may close only with no unresolved Foundation blockers.

## 26. Explicit exclusions

No Training, Exercise or organisational Readiness; no generic DMS/personal drive; no cloud
provider integration; no antivirus claim; no automatic purge; no invented legal retention
duration; no whole-incident ZIP; no evidence editing or byte replacement; no advanced search,
OCR, image transformation, preview generation or broad UI redesign. Controlled evidence
export is deferred to normal product backlog unless implementation reveals a Foundation
integrity blocker.

## 27. Definition of Done

All 33 criteria in the Stage 25 brief must pass: secure REAL incident upload, authoritative
PostgreSQL metadata, abstract immutable bytes, SHA-256 verification, corruption/missing-byte
rejection, filename/path/header/size/type safety, scoped access, non-REAL rejection,
audit/tombstoning/no purge, coherent backup/restore/integrity/recovery, unchanged predecessor
migrations and product boundary, green unit/PostgreSQL/browser/audit/startup gates, no leaked
artifacts/secrets, complete implementation report, blocker-free exit assessment and formal
Foundation completion report.

## 28. Recommended commit sequence

1. `docs: define Foundation Stage 25 evidence plan`
2. `feat: add secure incident evidence persistence`
3. `feat: add evidence storage and integrity enforcement`
4. `feat: expose incident evidence API`
5. `feat: add incident evidence workspace`
6. `feat: extend recovery tooling for evidence`
7. `test: cover evidence security and recovery`
8. `docs: record Stage 25 implementation`
9. `docs: complete Foundation assessment`

The sequence may be compacted only where implementation boundaries are inseparable. The plan
remains a separate first commit. Stage 25 may be pushed and opened for review, but must not be
merged without further explicit authorization.
