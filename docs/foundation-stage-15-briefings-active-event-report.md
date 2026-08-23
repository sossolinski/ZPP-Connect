# Foundation Stage 15 — Operational Briefings Persistence + Active Event Integrity

Status: READY FOR NEXT FOUNDATION SLICE

## A. Stage 14 merge verification

Stage 14 PR #11 was reverified at exact head `239c549f45020ba3f8849d8dc66c3d85ebdbb7c2`: the report verdict was ready, all six required checks were successful, the PR was mergeable, and no review blocker existed. It was marked ready and merged without rewriting history. Stage 15 starts from merge commit `cb747d1d9e0af03ef018e176f5ce7a0664b7dfe2` on isolated branch `agent/foundation-stage-15-briefings-active-event` and worktree `/tmp/zpp-connect-stage15-briefings`. The pre-existing dirty Stage 12 worktree was not modified.

## B. Current Briefing contract

### Current Briefing route matrix (pre-implementation)

| Operation / route | Permission | Incident scope | Memory | PostgreSQL | Audit | Timeline | Notification | Version | Restart | Stage 15 decision |
|---|---|---|---|---|---|---|---|---|---|---|
| `GET /sessions/:sessionId/active-event` | `briefing:read` | Path Incident through `IncidentPermissionGate` | Reads session, briefing and all supporting compatibility arrays | Only indirect paged hydration of Foundation domains | No | No | No | Projection only | Briefing lost/reset | Query durable projection; no compatibility hydration |
| `GET /sessions/:sessionId/briefings` | `briefing:read-history` | Path Incident through gate | Filters and sorts `briefings[]` | None | No | No | No | Returns stored versions | History lost/reset | Bounded PostgreSQL `limit`/`offset` history |
| `GET /sessions/:sessionId/briefings/current` | `briefing:read` | Path Incident through gate | Finds current Published row | None | No | No | No | Projection only | Current resets | Query partial-unique current Published row |
| `GET /briefings/:briefingId` | Published: `briefing:read`; Draft/Superseded: read + history | Briefing ID is resolved server-side to session/status before gate | Finds row in `briefings[]` | None | No | No | No | Projection only | ID may disappear | Resolve safe metadata and content in PostgreSQL |
| `POST /sessions/:sessionId/briefings/draft` | `briefing:create-draft` | Path Incident; writable gate | Finds/pushes Draft; clones Published or creates blank | None | Router `briefing_draft_created` after mutation | No | No | New row v1; max+1 is not serialized | Draft lost | Session-lock transaction, DB invariants, transactional Audit |
| `PATCH /briefings/:briefingId` | `briefing:update-draft` | Briefing-derived Incident; writable gate | Mutates parent/children in place | None | Router update + link-change rows after mutation | No | No | Required `expectedVersion`; memory increment | Update lost | Locked optimistic transaction, stable children, transactional Audit |
| `POST /briefings/:briefingId/publish` | `briefing:publish` | Briefing-derived Incident; writable gate | Supersedes/publishes in place | None | Router publication/supersession after mutation | Router append after mutation | Memory notification or direct PostgreSQL `NotificationService` call after mutation | Required `expectedVersion`; both rows increment | Publication lost; notification may outlive state | One transaction for state, Audit, Timeline and Stage 13 outbox only |

### Current Briefing lifecycle matrix (pre-implementation)

| State / transition | Current validation and behavior | Integrity gap | Stage 15 decision |
|---|---|---|---|
| No briefing → Draft | Blank Draft, revision `max + 1`, v1 | Memory race can duplicate revision/Draft | Serialize on Session and enforce DB uniqueness |
| Published → Draft | Clone complete structured content with new revision child IDs | Memory race; no durable lineage | Transactional deep clone into normalized child rows |
| Existing Draft → create Draft | Returns same row and `created=false` | Process-local only | Preserve deterministic result under 20-way concurrency |
| Draft → Draft update | Draft-only, required version, disallowed identity/lifecycle fields, child normalization | Parent/children mutate before non-transactional Audit; weak child provenance enforcement | Optimistic transaction with diff/upsert/delete and Audit |
| Draft → Published | Requires summary, priority, valid assignment links; supersedes previous Published | State, Audit, Timeline and notification are split; races not serialized | Single locked PostgreSQL transaction plus outbox |
| Published → Superseded | Occurs only when next Draft publishes | Not durable; router Audit can fail independently | Transactional immutable transition with Audit |
| Published/Superseded edit | Rejected with 409 | Memory authority | Retain 409 and enforce service/DB boundary |
| Delete/unpublish/restore | No command exists | None | Do not add commands |

## C. Current Active Event contract

### Current Active Event data-source matrix (pre-implementation)

| Projection | Current authority | Permission gate | Current query behavior | Stage 15 decision |
|---|---|---|---|---|
| Session header/lifecycle | `sessions[]`, synchronized from Incident service | `briefing:read` then scoped permissions | Compatibility row | Direct PostgreSQL Session select |
| Current/Draft/history | `seededBriefings()` mutable array | Briefing scoped permissions | Array find/filter/sort; history unbounded | Normalized PostgreSQL reads; bounded history |
| Linked Assignment | `assignments[]` | Scoped `assignment:read`; manager/assignee detail rule | Hydrated in pages then array lookup | Targeted PostgreSQL `IN` query; preserve Available/Restricted/Missing/Unavailable |
| Open assignments | `assignments[]` | Scoped `assignment:read` | Array count after paged hydration | Filtered PostgreSQL `COUNT` |
| Unresolved enquiries | `enquiries[]` | Scoped `enquiry:read` | Array count after paged hydration | Filtered PostgreSQL `COUNT` |
| Active holds | `matchingRecords[]` | Scoped `matching:read` | Array count after paged hydration | Filtered PostgreSQL `COUNT` |
| Open requests | `requests[]` | Scoped `request:read` | Array count after paged hydration | Filtered PostgreSQL `COUNT` |
| Pending releases | `releases[]` | Scoped `release:read` | Array count after paged hydration | Filtered PostgreSQL `COUNT` |
| Passengers needing match review | passenger + matching arrays | Scoped passenger + matching read | Materializes IDs then array count | PostgreSQL anti-join / bounded count |
| Next actions | assignment and briefing arrays | Scoped Incident permissions | First matching own assignment plus Draft/current | Targeted durable queries |
| Actor metadata | `users[]` | Briefing read | Demo actor snapshot | Safe PostgreSQL User + active roles projection |

## D. Current split-brain

### Current publish side-effect matrix (pre-implementation)

| Side effect | Current write point | Atomic with briefing? | Failure behavior | Stage 15 decision |
|---|---|---|---|---|
| Draft-created Audit | Router `addAudit` after memory push | No | Briefing exists even if Audit fails | Write in create transaction |
| Draft-update Audit and relation Audits | Router after in-place memory mutation | No | Content/version may change without evidence | Write all rows in update transaction |
| Published/superseded Audit | Router after memory mutation | No | Publication may exist without evidence | Write in publish transaction |
| Timeline | Router after memory publication | No | Publication may exist without Timeline | Exactly one row in publish transaction |
| Briefing notification | Direct best-effort `NotificationService` or memory notifier | No | Delivery may fail silently; no durable intent | Remove publisher; enqueue `BRIEFING_PUBLISHED` |
| Outbox | Not used for Briefing | N/A | No retryable publication intent | One unique safe-payload outbox row in publish transaction |

### Current Briefing access matrix (pre-implementation)

| Surface | Broad prefilter | Target-Incident evaluation | Resource Incident source | Content-before-auth risk | Stage 15 decision |
|---|---|---|---|---|---|
| Active Event/current/history/create | Authenticated user's broad permission snapshot | `EffectiveAccessService` via `IncidentPermissionGate` | Path `sessionId` | No | Preserve gate and use `req.incidentPermissions` internally |
| Briefing detail/update/publish | Status-sensitive read or write permission | Same scoped authority | Server-side memory metadata lookup by `briefingId` | No content serialized before gate | Preserve architecture with async PostgreSQL metadata lookup |
| Assignment projection/metrics/actions | Domain helpers inspect actor permissions | Actor receives scoped permissions after gate | Target Incident | No known broad-permission leak after Stage 14 | Never fall back to broad permissions in PostgreSQL projection |
| Publication recipients | Separate direct call to `eligibleUsersForPermission` | Correct Stage 14 service, but outside outbox | Published briefing session | No cross-Incident leak; durability gap | Dispatcher uses the same EffectiveAccess service |

Production is currently split between durable Incident/Foundation data and process-local Briefing authority. `PERSISTENCE_MODE=postgres` still constructs `createActiveEventService(...)`, which immediately constructs `seededBriefings()` and calculates six metrics and next actions from hydrated arrays. The briefing router then appends side effects outside the lifecycle method. This is the confirmed Stage 15 removal target.

## E. PostgreSQL model

`OperationalBriefing` is the authoritative parent with durable Incident, revision, status, content, optimistic version, timestamps and creator/updater/publisher relations. The public ID remains text so existing `brf-…-rN` links, Audit entity IDs and Notification source IDs remain compatible; the Incident and actor keys retain UUID foreign-key integrity.

## F. Child models

Five normalized child tables persist confirmed facts, unconfirmed items, ordered priorities, risks and coordination notes. Every collection is ordered by `(briefingId, sortOrder)`. Facts, unconfirmed items and notes retain creator provenance; priorities retain an indexed FK to `AssignmentTask`; risks retain their own created/updated timestamps. No Briefing body is authoritative JSON.

## G. DB invariants

Migration `20260823190000_operational_briefings` adds positive revision/version checks, valid status/publication-state checks, unique `(sessionId, revision)`, and PostgreSQL partial unique indexes for one Draft and one Published row per Incident. All parent/child, actor and Assignment links have explicit FKs and deletion behavior. Fresh migration reported 18/18.

## H. Revision model

Revision allocation occurs while the Session row is locked in a Serializable transaction. Public parent IDs use `brf-${sessionId}-r${revision}`; copied child rows get revision-owned IDs. Repeated lifecycle tests produce unique monotonic revisions and never reuse Superseded numbers.

## I. Draft creation

Create locks the Session, rejects Closed/Archived, returns the existing Draft with `created=false`, or allocates `max(revision)+1` and deep-clones the current Published revision. A 20-call stress produced one Draft, one created response, one revision and one creation Audit.

## J. Draft update

Update requires `expectedVersion`, locks Session and Draft, rejects historical rows and protected lifecycle/identity fields, validates all children before writes, applies per-row create/update/delete diffs, increments the parent once and writes Audit in the same transaction. Existing child IDs retain `createdAt`/`createdById`; stale writers receive 409.

## K. Assignment links

Every supplied Assignment is loaded from PostgreSQL and must exist in the same Incident. Editing preserves the manager/assignee visibility rule; publication revalidates authoritative links. Cross-Incident input fails before any parent, child, version or Audit change. Active Event fetches only referenced Assignment IDs and preserves Available/Restricted/Missing/Unavailable projections.

## L. Publish transaction

Publish locks Session, Draft and the current Published row, validates lifecycle/version/summary/priorities/Assignment links, supersedes the previous current row, publishes the Draft, writes publication/supersession Audit, one Timeline event and one `BRIEFING_PUBLISHED` intent, then commits. Same-version publish races yield one success; update/publish and closure/publish serialize with no partial effects.

## M. Published immutability

The only mutation route targets Draft. Published and Superseded PATCH attempts return 409, child diff commands are unreachable for historical revisions, and no delete/unpublish/restore command was added.

## N. Audit

Creation, update, priority-link changes, publication and supersession use `entityType=operationalBriefing`, the actual Briefing Incident and the authenticated actor ID/email. Metadata contains identifiers, revision and changed section names, not Briefing bodies. Injected Audit failure rolls back the source mutation.

## O. Timeline

Each successful publication writes exactly one `CaseTimelineEvent` (`eventType=briefing`, Briefing entity ID, `Briefing revision N published`, title body and revision metadata). Failed/stale publication writes none; Draft updates do not create Timeline noise.

## P. NotificationOutbox

`BRIEFING_PUBLISHED` extends the Stage 13 event union and payload allowlist. The transactional row uses aggregate type `briefing`, durable Briefing ID/version, null recipient and real Incident. Its payload has exactly `revision` and `occurredAt`; no summary, structured content, names or case data is queued.

## Q. BRIEFING_PUBLISHED dispatcher

The existing dispatcher resolves recipients through `EffectiveAccessService.eligibleUsersForPermission("briefing:read", { incidentId })` and renders the required Briefing notification copy and `/active-event` action. Per-user `event:outbox:<id>` deduplication makes redelivery idempotent.

## R. Recipient access integrity

Stage 14’s shared effective-access graph remains the only authority for both requests and permission-based delivery. Tests prove a GROUP reader assigned to Incidents A and B can read/receive A only; B current/history/detail remain 403. Dispatcher failure leaves publication committed, retries the outbox and creates no duplicate recipient notification.

## S. Active Event PostgreSQL projection

`PERSISTENCE_MODE=postgres` injects `createPrismaOperationalBriefingService` and does not construct the seeded memory Active Event service. PostgreSQL routes skip compatibility hydration entirely. Session, Briefing, history, Assignment projection, metrics, next actions and actors are queried asynchronously from durable tables while preserving the frontend response shape.

## T. Metrics

The six existing metrics use filtered Prisma/PostgreSQL counts, including a relational anti-match count for passenger review. They run only when the target-Incident scoped actor has the corresponding permission, have no 200-row cap, retain unavailable warnings on query failure, and returned 1,005 open assignments in scale testing.

## U. Next actions

Next actions use one targeted own-active-Assignment query plus the durable active Draft and current Published rows. Draft actions depend on scoped update/publish permissions; no compatibility arrays are consulted.

## V. Actor metadata

Creator, updater and publisher projections come from PostgreSQL Users and active Role names and expose only ID, display name and roles. Account policy, identities, overrides and security metadata are not serialized.

## W. Incident authorization

All six routes retain `IncidentPermissionGate`. Briefing-ID routes memoize an async safe PostgreSQL `briefingId -> sessionId/status` lookup before authorization and never trust active/client Incident context. Internal metrics/actions/projections receive `req.incidentPermissions`, not the broad user snapshot.

## X. Session lifecycle

Closed/Archived reads remain available to authorized users; create/update/publish all return 409. Session locks serialize publication against closure, so either a complete publication precedes closure or the entire publication is rejected.

## Y. Seed / backfill

The migration is intentionally schema-only and succeeds against a Stage 14 database with zero Briefings. Seed intentionally recreates Published `brf-ses-demo-1-r1`, Published `brf-ses-demo-2-r1` and Draft `brf-ses-demo-2-r2`, normalized children and real Assignment links. This is a demo/training fixture, not a production history backfill. The added training Session also advances the Session operational-ID sequence after insertion.

## Z. Restart durability

The dedicated suite creates/updates a Draft, reconstructs the app/service, reads it again, publishes, reconstructs again and verifies current/history/outbox state. PostgreSQL remains the source across every instance; no seeded array participates.

## AA. Concurrency

Covered races: 20-way create, two publish calls, two-user update, update vs publish, create vs publish, publish vs closure and repeated current/supersession transitions. Database partial indexes and Session serialization keep Draft/Published counts at most one and revisions unique.

## AB. Rollback tests

Cross-Incident child input proves Fact/Priority/Risk/version/Audit rollback. Failure hooks injected immediately before Audit and Outbox prove their enclosing create/publish transactions roll back Briefing, previous current, Timeline and side effects. Dispatcher failure is separately retryable after commit.

## AC. Scale

The suite creates 1,001 eligible users and 1,005 Assignments. Effective-access recipient discovery returns candidates beyond 1,000, Active Event returns the exact count beyond the former compatibility cap, and history verifies bounded `limit`/`offset` paging.

## AD. Frontend

No redesign was required. Edit affordances, Assignment option loading and publish controls now use server-provided Incident-scoped Active Event capabilities rather than broad `can(...)`. The browser flow covers create/open/edit, stale 409 guidance, publish/current/history/supersession, clone, notification visibility and Closed-Incident disabled capabilities.

## AE. Legacy removed

Production wiring no longer contains `notificationBriefingPublisher` or direct post-commit delivery. Postgres Active Event never constructs `seededBriefings()` or reads `assignments[]`, `enquiries[]`, `passengerRecords[]`, `matchingRecords[]`, `releases[]`, `requests[]` or `sessions[]`. The legacy memory service/notifier remains only behind `kind=memory` in automated test mode.

## AF. Migration rehearsal

Exact Stage 14 code deployed 17 migrations and seed into `zpp_stage15_rehearsal` (6 Users, 1 Session). Stage 15 then applied only migration 18, regenerated the current client, ran the Stage 15 seed and retained all 6 Users while intentionally adding the second training Session and 3 Briefing revisions. Dedicated Stage 15 plus Stage 14 regression suites passed 49/49 on the upgraded database.

## AG. PostgreSQL tests

Fresh PostgreSQL migration/seed passed at 18/18. The ordered Foundation Stage 1–15 gate passed 187/187, zero skipped; the dedicated Stage 15 suite passed 11/11. Stage 14’s 40-test scoped identity/access suite is included and green.

## AH. Browser tests

The new lifecycle and scoped-capability Playwright tests pass. The full browser gate passed 73/73, including existing linked-Assignment restriction and role-containment coverage.

## AI. CI

Local evidence: Prisma validate/generate PASS; fresh migration/seed PASS; PostgreSQL 187/187; dedicated Stage 15 11/11; Stage 14→15 rehearsal and 49/49 regression PASS; Typecheck PASS; Unit 99/99 (PostgreSQL suites intentionally excluded from this separate unit command); Build PASS; Playwright 73/73; production Entra/PostgreSQL startup and health PASS with development auth unavailable; production dependency audit 0 vulnerabilities; `git diff --check` PASS. Exact implementation SHA `2f4f565148f9e401098541ec02417264b44d8b74` passed all six remote checks: both push and pull-request copies of Foundation PostgreSQL Gate, Typecheck/Unit/Build/Browser, and Production Dependency Audit. This report-only verdict commit is the final candidate and must pass those six checks again before handoff.

## AJ. Remaining split-brain

Remaining production split-brain candidates:

| Candidate | Writes / integrity | Security / centrality | Coherent next slice |
|---|---|---|---|
| Imports | Durable domain writes are initiated through remaining legacy orchestration; retry/idempotency and batch evidence are high-integrity concerns | Handles sensitive passenger/family input and feeds many domains | Yes: import batch, validation, confirm, evidence and retry boundary |
| Exports / Reports | Primarily derived/read surfaces | Sensitive disclosure controls, but lower write integrity | Yes, but best after source orchestration is durable |
| Readiness | Mostly derived projection with some legacy policy/config | Broad people/training/document dependency | Larger cross-domain projection slice |
| Admin dictionaries/profile/config | Small remaining mutable configuration authority | Global behavior but limited operational transaction depth | Coherent, lower immediate incident risk |
| Exercise injects/observations | Schema exists; some legacy route behavior remains | Exercise-only operational scope | Coherent but lower production priority |
| Remaining static router surfaces | Mixed | Mixed | Not one bounded vertical slice |

## AK. Risks — max 10

1. The legacy memory Active Event adapter remains intentionally for test mode and must never be injected in production.
2. Briefing text is operationally sensitive even though side-effect payloads are minimized; normal application/database access controls still matter.
3. The embedded Active Event history is capped at 50 for compatibility; consumers needing deeper history must use the paged endpoint.
4. PostgreSQL partial indexes are required and must not be replaced by Prisma-only validation.
5. High-recipient Briefing broadcasts create one Notification per eligible user and should continue to be monitored operationally.
6. Failure-injection hooks are constructor-only test seams; production composition does not configure them.

## AL. Next decision

Selected Stage 16 candidate: **Imports persistence/orchestration integrity**. It has the strongest combination of sensitive production writes, retry/idempotency risk and dependency centrality, and forms one coherent validation→confirmation→durable evidence slice. Exports/Reports, Readiness, configuration, Exercise and other static surfaces remain later candidates. No Stage 16 code is implemented here.
