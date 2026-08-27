# Foundation Stage 21 — Admin Dictionary and Configuration Integrity

Status: **READY FOR NEXT FOUNDATION SLICE**

This report is being written alongside the implementation. Stage 21 does not make every dropdown administrator-editable: it establishes an explicit policy for every seeded category, gives PostgreSQL authority only to categories whose write path can use the same active catalog, and keeps protocol semantics code-owned.

## A. Stage 20 merge and workspace isolation

- Live PR #17 was fetched and re-read at exact reviewed head `8ffe714482642b9fa06e3da1831504a171c36cd5`.
- It was OPEN/DRAFT, CLEAN/MERGEABLE, had no blocking review or unresolved thread, all six exact-head checks were successful, and its report said `READY FOR NEXT FOUNDATION SLICE`.
- PR #17 was marked ready and merged using the repository merge-commit strategy.
- Stage 20 merge commit: `793141df0b17a7c9a701181de932ec4aea5e64dc`.
- The reviewed Stage 20 head was proved an ancestor of updated `origin/main`.
- Stage 21 branch/worktree: `agent/foundation-stage-21-admin-configuration` at `/tmp/zpp-connect-stage21-admin-configuration`, based on that merge commit.
- The original worktree remained on `agent/foundation-stage-12-documents` with its pre-existing modified Prisma schema and untracked Stage 12 migration. It was not modified, staged, stashed, reset, or cleaned.

## B. Pre-change authority graph

```text
@zpp/shared dictionaries ──> public /dictionaries ──> frontend selects
           │
           ├───────────────> selected Zod validators / lifecycle code
           │
           └─ seed upsert ─> PostgreSQL Dictionary (not a runtime owner)

Admin /admin/dictionaries ─> explicit 501
@zpp/shared defaultProfile ─> /config/profile
seeded profile rows ────────> unused database mirror
```

The pre-change `Dictionary` table is populated, but production neither reads it for public options nor permits supported mutation. Seed reruns overwrite every label/order/active flag. The table therefore looks authoritative without being authoritative.

## C. Complete pre-implementation category consumer and policy matrix

`P` means protected system vocabulary, `E` extensible operational vocabulary, and `X` deliberately unsupported for runtime mutation in this slice. Every row already exists in PostgreSQL because the canonical seed mirrors every `@zpp/shared` array.

| Category | Read consumers | Write-validation / invariant consumers | DB/state-machine dependency | Class | Stage 21 authority |
|---|---|---|---|---|---|
| `sessionModes` | Sessions UI, reports | Session create/update enum | mode drives exercise/real behavior | P | code-owned canonical |
| `sessionStatuses` | Sessions UI, dashboard/reporting | Session validator and lifecycle | lifecycle semantics | P | code-owned canonical |
| `eventTypes` | Sessions UI | Session create/update active-label validation | plain historical string | E | PostgreSQL active catalog |
| `channels` | Enquiry forms/records | enquiry input currently accepts text | plain historical string | X | code-owned public catalog |
| `enquiryTypes` | Enquiry forms/records | enquiry input currently accepts text | plain historical string | X | code-owned public catalog |
| `enquiryUrgencies` | Enquiry forms/dashboard | Zod enum | priority/business rules | P | code-owned canonical |
| `enquiryStatuses` | Enquiry lists/workflows | Zod enum and transitions | lifecycle semantics | P | code-owned canonical |
| `verificationStatuses` | Family records | family filters/update validation | verification lifecycle | P | code-owned canonical |
| `personTypes` | Passenger forms/imports | router and importer enums | classification/report semantics | P | code-owned canonical |
| `genders` | Passenger forms | free-text persistence today | historical plain string | X | code-owned public catalog |
| `nationalities` | Passenger forms | free-text persistence today | historical plain string | X | code-owned public catalog |
| `relationships` | Family forms/imports/matching | router and importer enums | verification/matching semantics | P | code-owned canonical |
| `passengerSources` | Passenger forms/imports | router and importer enums | source-integrity logic | P | code-owned canonical |
| `conditionStatuses` | Passenger forms/dashboard | router enum | sensitive operational decision | P | code-owned canonical |
| `holdTypes` | Passenger/matching/release views | router enum and release eligibility | release safety invariant | P | code-owned canonical |
| `matchingStatuses` | matching/dashboard/reporting | matching lifecycle service | lifecycle and report semantics | P | code-owned canonical |
| `releaseDestinations` | Release form/report | optional text in release command | historical plain string | X | code-owned public catalog |
| `transportModes` | Release form/report | optional text in release command | historical plain string | X | code-owned public catalog |
| `requestCategories` | Request form/filters/exports | static request create/filter enum | plain historical string | E | PostgreSQL active catalog |
| `requestPriorities` | Request UI/queue | router enum and DB CHECK | priority ordering and workflow | P | code-owned canonical |
| `approvalStatuses` | Request UI/report | router enum | approval semantics | P | code-owned canonical |
| `requestStatuses` | Request UI/dashboard | durable service + DB CHECK uses normalized states | lifecycle projection | P | code-owned canonical |
| `assignmentStatuses` | Assignment UI | router enum and DB CHECK | lifecycle semantics | P | code-owned canonical |
| `assignmentPriorities` | Assignment UI | router enum and DB CHECK | priority semantics | P | code-owned canonical |
| `assignmentFunctions` | Assignment UI | related function is plain text | historical plain string | X | code-owned public catalog |
| `exerciseInjectStatuses` | Exercise UI | validators, service, DB CHECK | lifecycle semantics | P | code-owned canonical |
| `observationAreas` | Exercise UI/report | router enum and DB CHECK | exercise evidence semantics | P | code-owned canonical |
| `observationSeverities` | Exercise UI/report | router enum and DB CHECK | evidence/report semantics | P | code-owned canonical |
| `communicationLanguages` | Enquiry/member forms | plain strings/arrays | historical plain values | X | code-owned public catalog |
| `profile` | shell/footer presentation | no supported Admin editor | unused seeded mirror | X | `/config/profile` remains explicitly code-owned |

`eventTypes` and `requestCategories` are the two Stage 21 runtime-configurable catalogs. Both persist historical labels as plain strings, both obtain new-use options from active PostgreSQL rows, and both validate production writes through the same durable service. Categories marked X remain visible as protected/unsupported metadata in Admin rather than pretending to be mutable; each needs a future domain-specific validation and history decision before runtime editing is safe.

## D. Policy contract

| Class | Create keys | Edit label/description | Reorder | Deactivate/reactivate | Key/category/profile | Inactive history | Public source |
|---|---:|---:|---:|---:|---|---|---|
| P | no | no | no | no | immutable | canonical values remain readable | code |
| E | yes | yes | yes | yes | immutable after creation | retained and Admin-readable; omitted for new selections | PostgreSQL |
| X | no | no | no | no | immutable | existing strings remain readable | code |

The typed registry is code-owned governance. It defines authority, protection, allowed commands, validation limits, history behavior, and public exposure for every supported category. It is not an alternate value store.

## E. Existing Dictionary schema audit and migration decision

Stage 20 fields are `id`, `profile`, `category`, `key`, `label`, `description`, `sortOrder`, `isActive`, `metadata`, and timestamps, with unique `(profile, category, key)` and an active-list index.

That shape cannot provide case-insensitive semantic identity or optimistic concurrency. Stage 21 therefore requires migration 22 to add:

- `normalizedKey`, backfilled deterministically and uniquely constrained with profile/category;
- `version`, positive and incremented by every mutation;
- `sourceType`, honestly distinguishing system mirror, bootstrap, Admin-created, and legacy profile origins.

Policy/protection stays in the typed code registry because it governs application behavior. Actor provenance stays in the transactionally coupled `AuditLog`; duplicating nullable actor fields on Dictionary would create two provenance claims. Existing rows are migrated in place and keep their IDs, labels, ordering, active state, and timestamps.

## F. Persisted field compatibility matrix

| Domain field | Stored representation | Category | Inactive historical behavior | Stage 21 new-write source |
|---|---|---|---|---|
| Session `eventType` | label string | `eventTypes` | record retains/renders stored label | active PostgreSQL catalog |
| Enquiry `contactChannel` | label string | `channels` | retained as stored | existing code contract (X) |
| Enquiry `enquiryType` | label string | `enquiryTypes` | retained as stored | existing code contract (X) |
| Enquiry `preferredLanguage` | label string | `communicationLanguages` | retained as stored | existing code contract (X) |
| Family/claim relationship | label string | `relationships` | retained as stored | protected code enum |
| Passenger `personType` | label string | `personTypes` | retained as stored | protected code enum |
| Passenger `source` | label string | `passengerSources` | retained as stored | protected code enum |
| Passenger condition/hold | label string | `conditionStatuses` / `holdTypes` | retained as stored | protected code enum |
| Release destination/transport | nullable label string | corresponding X categories | retained as stored | existing bounded text contract |
| WelfareRequest `category` | label string | `requestCategories` | record retains/renders stored label | active PostgreSQL catalog |
| WelfareRequest priority/status/approval | strings | protected categories | retained under lifecycle rules | code enum + DB constraints |
| Assignment status/priority/function | strings | protected/X categories | retained as stored | protected lifecycle / existing text contract |
| Exercise inject/observation values | strings | protected categories | retained as evidence | code enum + DB constraints |
| Member/enquiry languages | string array/string | `communicationLanguages` | retained as stored | existing code contract (X) |

There are no Dictionary foreign keys. Deactivation never rewrites historical rows. Label editing changes the active value used by future commands; older stored labels remain truthful snapshots and remain renderable.

## G. Final production architecture

```text
authenticated public/Admin router
  -> typed DictionaryPolicy
  -> PrismaDictionaryService
       -> direct PostgreSQL reads
       -> serializable versioned mutation transaction
            -> Dictionary
            -> exactly one AuditLog

Incident / Request command routers
  -> same service assertActiveLabel()
```

The configuration router owns `GET /dictionaries`, the Admin policy/list/create/update/deactivate/reactivate routes, and direct PostgreSQL reads. Public composition is per-policy and never merges sources: E categories are complete active PostgreSQL projections; P and X categories are canonical code projections. Ordering is `category`, `sortOrder`, `label`, then `key`. A durable read failure fails the request rather than substituting shared, demo, cached, or partial data. No process cache, Timeline write, or Notification side effect exists.

The production authority chains are:

```text
Admin mutation -> Prisma Dictionary transaction -> next GET /dictionaries
  -> Sessions selector -> Session create/update -> assertActiveLabel(eventTypes)

Admin mutation -> Prisma Dictionary transaction -> next GET /dictionaries
  -> Requests selector -> Request create -> assertActiveLabel(requestCategories)
```

The Request router retains a static validator only for the memory-only automated-test adapter. PostgreSQL production composition always injects `assertActiveLabel`; there is no production static validation path for either E category.

## H. Seed and profile decisions

- Extensible canonical values become create-if-missing bootstrap rows. Seed reruns never overwrite their administrator-owned label, order, active state, or version.
- Protected code-owned mirror rows may be reconciled to canonical values because they are not runtime configuration.
- Admin-created extensible rows are never removed by seed.
- `/config/profile` remains code-owned. Legacy profile mirror rows are preserved and classified as non-authoritative/read-only so the predecessor database is not destructively rewritten.

`profileDictionaryPolicy` is X, protected, not publicly exposed, and rejects every mutation even for System Admin. `/config/profile` reads `defaultProfile` directly. The seven retained DB rows have `LEGACY_PROFILE_MIRROR` provenance and do not imply runtime mutability.

## I. Migration, normalization, and preservation

Migration `20260825180000_dictionary_configuration_integrity` is migration 22. It backfills `normalizedKey`, positive `version`, and truthful `sourceType`, adds check constraints, and adds unique `(profile, category, normalizedKey)` without replacing predecessor records. Keys normalize to lowercase ASCII words joined by `_`; key, category, and profile are immutable after creation.

The final exact Stage 20→21 rehearsal used independently reviewed Stage 20 head `8ffe714482642b9fa06e3da1831504a171c36cd5`, its 21-migration schema, generated client, and canonical seed before any Stage 21 client was generated. Before upgrade it contained 202 Dictionary rows, seven profile rows, six Users, two Sessions, one representative ImportBatch, three Operational Briefings, one representative ExportGeneration, one Exercise Inject, one Exercise Observation, six MemberTrainingRecords, and one DocumentAcknowledgement. Migration 22 preserved every count and the complete Dictionary ID hash `96db4109eea0345caa4b80e7215c0222`; all 202 rows gained valid integrity fields. The dedicated Stage 21 suite then passed 9/9. Administrator-owned changes to one `eventTypes` row and one `requestCategories` row survived canonical seed rerun with IDs, labels, ordering, inactive state, versions, and `ADMIN` provenance intact. A corrupted protected `sessionStatuses/Draft` mirror was restored, the Dictionary count remained 202, the ID hash remained identical, and duplicate normalized-key groups remained zero.

CI repeats the same exact Stage 20 schema/client/seed boundary, 21→22 migration, preservation assertions, focused Stage 21 suite, both E-category seed-survival checks, protected reconciliation, normalized-key uniqueness, and ID-hash preservation.

## J. Governance and API behavior

- Editable/PostgreSQL: `eventTypes`, `requestCategories`.
- Protected/code: `sessionModes`, `sessionStatuses`, `enquiryUrgencies`, `enquiryStatuses`, `verificationStatuses`, `personTypes`, `relationships`, `passengerSources`, `conditionStatuses`, `holdTypes`, `matchingStatuses`, `requestPriorities`, `approvalStatuses`, `requestStatuses`, `assignmentStatuses`, `assignmentPriorities`, `exerciseInjectStatuses`, `observationAreas`, `observationSeverities`.
- Unsupported/code, read-only: `channels`, `enquiryTypes`, `genders`, `nationalities`, `releaseDestinations`, `transportModes`, `assignmentFunctions`, `communicationLanguages`; `profile` is a non-public protected legacy mirror policy.

OpenAPI documents the public projection, policy metadata, Admin paging/filtering, create/update/version commands, deactivation/reactivation, immutable identity, and relevant 400/401/403/404/409/500 outcomes. It does not advertise generic mutation for protected or unsupported categories.

Unauthenticated Admin access returns 401; an authenticated Viewer with active IncidentAssignment still returns 403; `admin:manage` allows System Admin; assignment or GROUP operational scope never grants configuration authority. Protected mutation returns a controlled 409 even for System Admin.

Every successful mutation and exactly one `dictionary_change` AuditLog commit in one serializable transaction. Failure injection before mutation, after Dictionary write/before Audit, during Audit, and before commit leaves no partial Dictionary or orphan Audit and never reports success. There are no Timeline or Notification writes.

`expectedVersion` is required for updates and active-state commands. A stale version returns controlled 409. Two writers from version N produce one successful write, one controlled conflict, and one mutation Audit. Eight concurrent normalized-equivalent creates produce one row, one Audit, one 201, and seven controlled 409 responses; Prisma/SQL detail is not exposed. Serializable `P2034` conflicts are normalized to a controlled 409.

## K. Runtime history, restart, failure, and scale evidence

Both E categories were used in durable business records, deactivated, removed from `/dictionaries`, and rejected for new writes while the existing Session and Request continued to return their stored historical labels. Reactivation restored selection and write eligibility. Historical business rows are never rewritten.

A mutation through instance A was visible through a reconstructed app and an independently constructed instance B on their next Admin, public-dictionary, and validation requests. There is no warmup or process-local authority. Injected Admin-read, public-read, business-validation, and mutation failures return controlled server errors and persist no false state; configurable values never fall back to shared or demo data.

The bounded scale test inserted 1,005 isolated active E-category values. Admin paging reported total 1,005, returned the deterministic 200-row page at offset 800, and filtering reached values beyond row 200. Public projection returned all 1,005 active values in deterministic order, proving no hidden API page limit becomes authority. Fixtures were cleaned up.

## L. Frontend and browser truthfulness

Admin Dictionaries shows key, label, active state, governance, and supported actions. Protected rows are visibly read-only; editable rows alone show create/edit/deactivate/reactivate; the stable key is disabled on edit. Successful writes reload server state. A controlled 409 remains visible with the unsaved draft intact. An injected 500 keeps the form and draft intact and creates no row.

The PostgreSQL Stage 21 browser workflow performs real Admin creation and update for both E categories, proves reload durability and immutable keys, creates a Session using the new Event Type, creates a Request using the new Request Category, deactivates both, proves selector removal and server rejection, proves historical Session/Request rendering, reactivates both, proves restored eligibility, surfaces stale-version conflict, and preserves a failed unsaved form. Protected categories expose no mutation control.

## M. Measured local closure evidence

| Gate | Result |
|---|---|
| Prisma validate/generate | pass |
| Fresh migration deploy/seed | 22/22 migrations, seed pass |
| Ordered PostgreSQL Foundation Stage 1–21 | 22 files, 263/263, zero skipped |
| Dedicated Stage 21 PostgreSQL | 9/9 |
| Unit/memory Vitest | 15 files, 104/104; PostgreSQL files intentionally excluded from this mode |
| Typecheck and lint | pass |
| Shared/API/web production builds | pass; Vite reports only its existing chunk-size advisory |
| General memory Playwright | 73/73, zero skipped |
| Carried-forward PostgreSQL browser regressions | 11/11 |
| Focused Stage 21 PostgreSQL browser | 1/1 |
| Production dependency audit | 0 vulnerabilities |
| `git diff --check` and workflow YAML parse | pass |

One first ordered run exposed a Stage 1 test sentinel that had used a now-invalid free-form Event Type; moving its search sentinel to `flightNumber` while using active `Training session` corrected the fixture. An unrelated Stage 12 acknowledgement race failed once, passed immediate isolated reproduction, and the second wholly fresh authoritative run passed all 263 tests. Carried Stage 16–18 browser fixtures likewise now use active `Exercise` while retaining their original test intent.

## N. Production runtime evidence

The compiled API started with `NODE_ENV=production`, `AUTH_MODE=entra`, `PERSISTENCE_MODE=postgres`. `/api/health` returned 200 and `persistence: postgres`; `/api/auth/config` returned Microsoft SSO only and `developmentAccessEnabled: false`; `x-user-email` was rejected with 401. Using a locally signed Entra JWT and local JWKS, authenticated `/dictionaries` returned all 29 category projections with PostgreSQL UUID rows for both E categories, and `/admin/dictionaries?category=eventTypes` returned 200 with policy `E/postgres` and `BOOTSTRAP` provenance. Production composition tests and the route manifest prove owner `configuration`, authority `postgres`, no deferred 501 owner, and neither demo initialization nor demo mounting. `PERSISTENCE_MODE=memory` in production exited 1 with the required rejection.

## O. Remaining Foundation debt and next candidate

1. AAR / Post-Incident Reporting + PDF integrity: the leading independent integrity gap and selected Stage 22 candidate.
2. X-category domain migrations: each unsupported plain-label vocabulary needs consumer-specific validation, historical semantics, and a safe migration before Admin editability.
3. Operational hardening beyond Foundation: production identity/JWKS lifecycle, observability, and deployment runbooks remain environment work rather than a reason to weaken configuration authority.

Stage 22 is selected but not implemented in this branch.

## P. CI evidence

Exact implementation SHA: `3df0a946ec07c4c6e8336efada409d855ba25cb1`.

All six implementation-SHA checks completed successfully across the independent push and pull-request workflow runs:

| Event | Check | Result | Evidence |
|---|---|---|---|
| push | Foundation PostgreSQL Gate | pass | [job 98334421644](https://github.com/sossolinski/ZPP-Connect/actions/runs/33016050118/job/98334421644) |
| push | Typecheck, Unit, Build and Browser | pass | [job 98334421789](https://github.com/sossolinski/ZPP-Connect/actions/runs/33016050118/job/98334421789) |
| push | Production Dependency Audit | pass | [job 98334421513](https://github.com/sossolinski/ZPP-Connect/actions/runs/33016050118/job/98334421513) |
| pull request | Foundation PostgreSQL Gate | pass | [job 98334437545](https://github.com/sossolinski/ZPP-Connect/actions/runs/33016054850/job/98334437545) |
| pull request | Typecheck, Unit, Build and Browser | pass | [job 98334437911](https://github.com/sossolinski/ZPP-Connect/actions/runs/33016054850/job/98334437911) |
| pull request | Production Dependency Audit | pass | [job 98334438013](https://github.com/sossolinski/ZPP-Connect/actions/runs/33016054850/job/98334438013) |

## Verdict

**READY FOR NEXT FOUNDATION SLICE**
