# Foundation Stage 19 — Readiness Projection Authority + Completeness Integrity

Status: **READY FOR NEXT FOUNDATION SLICE.**

This report records the Stage 19 audit, implementation, and evidence. The complete required workflow succeeded on exact implementation SHA `ce6ac3d74c21c8b699030b667331f1928e8bc1ae`. This report-only verdict commit must receive the same complete exact-final-SHA gate before handoff. Stage 20 has not been implemented.

## A. Stage 18 merge verification

- Fetched and pruned `origin`, then re-read live PR #15 rather than relying on the prior handoff.
- Verified its exact reviewed head was `adf6fb9ad8efafe871d5ab643544acd603e4e903`, state OPEN/DRAFT, mergeable CLEAN, with the report verdict `READY FOR NEXT FOUNDATION SLICE`, no review blocker, and all six required exact-head checks green.
- Corrected the stale PR-description sentence claiming the report was still NOT READY; this was metadata-only and produced no product commit.
- Marked PR #15 ready and merged it with the repository-standard merge-commit strategy. No squash, rebase, force-push, or history rewrite was used.
- Stage 18 merge commit: `ba58764e94d9a12b21181d87495e0af3ecc29682`.
- Verified the reviewed Stage 18 head is an ancestor of updated `origin/main`, then created clean branch `agent/foundation-stage-19-readiness-integrity` in an isolated worktree. The user's pre-existing dirty worktree was not modified.

## B. Current route matrix

| Route | Final contract | Required readiness authority |
|---|---|---|
| `GET /readiness/me` | One linked-member detailed assessment, or explicit unlinked `Unknown` | `readiness:read-own` |
| `GET /readiness/members` | Complete-filtered, deterministic, server-paged compact rows | global `readiness:read-all` or effective `readiness:read-group` |
| `GET /readiness/members/:memberProfileId` | Detailed assessment; hidden and absent IDs share 404 | read-all, in-scope read-group, or own linked profile |
| `GET /readiness/groups` | Paged safe group summaries; `optionsOnly=true` skips readiness computation | read-all or effective read-group |
| `GET /readiness/groups/:groupId` | Paged compact group-member readiness plus complete group summary | read-all or exact effective group scope |
| `GET /readiness/summary` | Aggregate-only complete accessible population | summary, read-all, or read-group |
| `GET /readiness/policy` | Exact code policy used by evaluator | `readiness:policy:read` or `readiness:policy:manage` |

PostgreSQL routes are now in the explicit readiness router. The legacy routes remain reachable only in automated memory mode.

## C. Current source-authority matrix

| Source | Audited pre-Stage 19 path | Final PostgreSQL path |
|---|---|---|
| Members | compatibility `MemberDirectoryRepository`, first 200 | Prisma `MemberProfile` set query |
| User link | compatibility projection | durable `MemberProfile.linkedUserId` relationship |
| Groups/membership | compatibility arrays, first 200 | `OperationalGroup` + active `GroupMembership` |
| Access | request compatibility permission snapshot plus artificial source permissions | durable User/Role/UserRole/GroupRoleAssignment/PermissionOverride graph |
| Training | Foundation service where present, memory fallback otherwise | transaction-local Training requirements and member records |
| Documents | Foundation service where present, memory fallback otherwise | transaction-local Documents, versions, requirements, acknowledgements |
| Availability | Foundation service with bounded compatibility calls | all durable overlapping Availability records in the policy window |
| Roster | Foundation service with bounded compatibility calls | all durable assigned shifts in the policy window |

The pre-implementation search also found `evaluationActor()`, which pretended to add Training, Document, Availability, and Roster permissions to the user. The PostgreSQL projection has no such permission mutation: trusted source reads occur inside the authorized derived-projection boundary.

## D. Confirmed 200-row completeness defect

The legacy `allMembers()` and `allGroups()` call `listMembers({ limit: 200 })` and `listGroups({ limit: 200 })`. That made a page boundary the semantic universe and could omit member/group 201+, corrupt memberships, authorization visibility, filters, and aggregate totals. The generic frontend aggregator separately stops at 5,000 records. PostgreSQL readiness no longer calls those helpers, and no frontend readiness consumer uses the 5,000-record aggregator.

## E. Target architecture

`HTTP readiness router → durable readiness access projection → PrismaReadinessProjectionService → one PostgreSQL REPEATABLE READ transaction → request-local source maps → pure typed policy evaluator → allowlisted response`.

There is no Readiness table, materialized projection, Redis/cache, process-global readiness map, compatibility hydration step, or write path.

## F. Access/scope matrix

| Durable grant | Effective result |
|---|---|
| GLOBAL `readiness:read-all` | organization-wide member and group projection |
| GLOBAL `readiness:read-group`, without read-all | active groups containing the actor's durably linked member |
| GROUP `readiness:read-group` | union of explicitly active assigned groups; multiple assignments are additive |
| `readiness:read-own` only | `/me` and only the linked member detail |
| `readiness:read-summary` only | complete organization aggregate; no member/group endpoints |
| active GRANT override | global permission while active and unrevoked |
| active DENY override | removes the permission immediately; expired/revoked DENY has no effect |
| revoked role/group assignment, archived group/member, removed membership | excluded on the next request |

IncidentAssignment is deliberately not part of this organization/member/group access decision. It neither grants Readiness nor is required for an otherwise valid readiness group scope.

## G. Persistent Member authority

Member identity, operational profile fields, status, assigned function, safe role label, and durable user link are read directly from complete PostgreSQL MemberProfile state. List rows contain only `id`, `memberId`, `displayName`, `pool`, `role`, `assignedFunction`, and `status` plus compact readiness fields. Archived members are excluded from organization/group lists; direct read-all detail can still evaluate an explicitly addressed archived profile and report its profile blocker.

## H. Persistent Group authority

Groups and memberships come directly from active PostgreSQL OperationalGroup/GroupMembership rows. Removed memberships, archived groups, and archived members do not contribute to active scoped lists or counts. Overlapping membership does not let Group A authority retrieve Group B; detail scope is checked against the requested group ID. Request-local sets prevent duplicate member contributions.

## I. Training source

Active/effective requirements, course titles, and non-cancelled member records are bulk-read inside the same transaction. Required non-compliance is a blocker; recommended/attention/expiring state is a warning. No source-service call opens a second snapshot, no source-domain permission is granted to the actor, and source failure propagates as a controlled 500.

## J. Documents source

Active/effective requirements attached to active published content and member acknowledgements are bulk-read in the same snapshot. Overdue or unavailable required content blocks; acknowledgement still needed warns; awareness-only requirements do not become false non-compliance. Document content, legacy metadata, acknowledgement notes, and actor evidence are never projected.

## K. Availability source

All active records overlapping the one-day UTC policy window are loaded without a record cap. Records active at the calculation instant take precedence; within candidates the deterministic order is Unavailable, Preferred, Available, then other types, followed by start time and stable ID. Absence warns, and Unavailable warns. Host locale/timezone does not affect calculation.

## L. Roster source

All assigned shifts overlapping the 14-day lookahead are bulk-read and ordered by start then ID. Cancelled and Completed shifts are excluded from next-shift policy. Published awaiting confirmation, Declined, and Draft warn; Confirmed/other usable current states do not invent a blocker. There is no first-20 semantic limit.

## M. Policy/evaluator

The pure `ReadinessSnapshot + ReadinessPolicy → ReadinessAssessment` evaluator is separate from Prisma acquisition. Policy `readiness-policy-2026-07`, version `1`, uses 45 expiring-soon days, 14 roster lookahead days, one availability day, UTC availability semantics, and `current-topology` evaluation mode. Every summary and assessment identifies the actual policy; no database configuration table or mutation endpoint was added.

Overall order remains Not ready, Unknown, Ready with attention, Not applicable, Ready. Blockers win, then genuine Unknown dimensions, then warnings/attention, followed by Not applicable and Ready. Unexpected query failures are errors, never Unknown or Ready.

## N. Temporal semantics

The server clock is resolved once per request unless a valid `evaluationAt` is supplied. All dimensions in that response use exactly that instant. Because organizational topology is not historically versioned, every response explicitly says `evaluationMode: "current-topology"`: an arbitrary timestamp means current topology evaluated with time-relative inputs, not a claim of historical truth.

## O. Snapshot consistency

Every readiness response, including its durable access decision, runs in one Prisma interactive transaction with PostgreSQL `REPEATABLE READ`. A controlled source change during evaluation proved the in-flight response retained the before snapshot and the next request saw the committed after state; no mixed impossible response was produced.

## P. Safe disclosure schemas

- Member and group summaries expose only operational identity fields.
- Training items expose title, requirement/compliance status, record status, due/expiry time, and expiring-soon state.
- Document items expose title, safe acknowledgement/availability status, due and acknowledgement time.
- Availability exposes operational ID/type/window, not notes.
- Roster exposes operational ID/title/duty/function/time/location/status, not notes or internal workflow evidence.

Sentinels in availability notes, roster notes, document metadata/content, training notes, and acknowledgement notes were absent from serialized list/detail responses. Raw Prisma objects are never returned.

## Q. Own readiness

`/readiness/me` requires `readiness:read-own`, derives the member only from the durable link, accepts no client member ID, and returns the established explicit unlinked `Unknown` result when no link exists. A durable link change is visible on the next request and after service reconstruction.

## R. Group readiness

Group lists and details use the durable allowed-group union. Options are separately paged/searchable and avoid member assessment work. Group detail reports complete summary totals and a server-paged compact member list. An actor scoped to Group A receives the same 404 for Group B and an absent group.

## S. Summary-only policy

A summary-only actor receives complete organization structural totals and policy metadata. The response contains no member/group identifiers, names, factors, or source records. Member list and groups return 403; member/group ID paths do not disclose hidden object existence. Revoking summary permission takes effect immediately.

## T. Server paging

Member and group endpoints accept limit 1–200 and non-negative offset and return `total`, `limit`, `offset`, and `data`. Search/status/group filtering applies to the complete accessible population before stable status/name/ID sort and slicing. Optional bounded ID filters let neighboring pages request readiness for only their displayed records without claiming an all-population result.

## U. Frontend

ReadinessPage retains My readiness, server summary cards, search, status/group filters, member table, detail drawer, next actions, and refresh. It uses 50-row server pages with Previous/Next and displayed range/total; filter changes reset offset. Group options use lightweight `optionsOnly=true` search/paging. Detail loads only when View is opened. Request generations prevent older filter/detail responses replacing newer state. Volunteers, Rostering, and Groups request bounded readiness only for their displayed IDs rather than using the 5,000-record aggregation helper.

## V. >200 regression

The dedicated test creates 1,005 durable member profiles, places the decisive Not-ready case at member 1,005, and proves it changes the complete summary, is found by combined search/status/group filtering, and has correct detail beyond the old boundary.

## W. 1,005-member scale

A single durable group contains all 1,005 members. Group detail returns total 1,005 and correct pages including offset 800. The organization summary includes all test members plus the known seed baseline; no duplicate is introduced for multi-group members.

## X. >200-group regression

The test creates 201 groups and proves group 201 is visible by authorized search/page, has a readiness summary, participates in member filtering, and remains scope-correct. The filter UI can search/page option results rather than silently omitting later groups.

## Y. Query/N+1 strategy

One access query graph and fixed set-based source query families load members/topology, Training requirements/records, Document requirements/acknowledgements, Availability, and Roster. Request-local maps join results. Instrumented 10-member versus 1,005-member group evaluation proves the larger case stays below 30 SQL queries and grows by at most two queries; there is no member-by-member source-service loop or persistent cache.

Existing indexes were reviewed for MemberProfile/link, GroupMembership, Training, Document acknowledgement/requirements, Availability member/time, and Roster member/time query shapes. The bounded evidence did not justify speculative schema/index changes.

## Z. Source-state reflection

Durably completing required Training, acknowledging the required Document, changing Availability, and confirming/correcting Roster state each change the next readiness result without a readiness write, cache invalidation, warmup, or restart.

## AA. Restart/fresh process

A freshly reconstructed app/service reads populated PostgreSQL and directly serves summary, members, detail, and own readiness. It needs no prior Member, Group, Training, Document, Availability, or Roster hydration call. Results at the same calculation time remain stable across reconstruction.

## AB. No-side-effects proof

Before/after counts for AuditLog, TimelineEvent, NotificationOutbox, and the authoritative source tables are unchanged after exercising every Readiness GET. Stage 19 defines no Readiness persistence table. Failure tests for member/group, Training, Documents, Availability, and Roster return controlled 500 responses and no partial assessment.

## AC. Migration/index decision

No migration was added. Migration count remains 21. Readiness remains computed state, and measured set-query behavior does not justify a new source-domain index in this slice.

## AD. Upgrade rehearsal

Local fresh deployment applied all 21 migrations and the canonical seed, then passed Stage 1–19 and direct fresh-process Readiness with no migration 22. Exact implementation-SHA CI also completed the Stage 18→19 no-migration rehearsal: it retained representative Identity, Member, Group, Training, Documents, Availability/Rostering, Incident, Import, Briefing, ExportGeneration, and Exercise state; redeployed the unchanged 21-migration schema; compared durable counts; and ran Stage 19 directly without hydration.

## AE. PostgreSQL tests

- Complete ordered Foundation Stage 1–19: **20 files, 250 tests passed, zero skipped**.
- Dedicated Stage 19: **11 tests passed**.
- Coverage includes all mandatory authority, scope, scale, source reflection, failure, snapshot, restart, policy, disclosure, side-effect, and query-growth cases.

## AF. Browser tests

- General memory-mode Playwright: **73 passed**; existing Readiness tests were retained.
- PostgreSQL Stages 16–19 regression: **11 passed** total (Stage 16: 3, Stage 17: 3, Stage 18: 3, Stage 19: 2).
- Stage 19 covers My readiness, summary, status/group/search filters, paging, detail-on-demand, next action, stale-request protection, durable refresh, summary-only, group-scoped, and unauthorized actors.

## AG. Production startup/audit

Production build succeeded. With `NODE_ENV=production`, `AUTH_MODE=entra`, and `PERSISTENCE_MODE=postgres`, health returned 200 with `persistence: postgres`; auth config exposed only Microsoft SSO; development users returned 404; and Readiness was mounted and authentication-protected without compatibility warmup. `npm audit --omit=dev --omit=optional` reports **0 vulnerabilities**. No new runtime dependency was added.

## AH. Exact-SHA CI

Draft PR #16 ran six checks against exact implementation SHA `ce6ac3d74c21c8b699030b667331f1928e8bc1ae`: two Foundation PostgreSQL Gates, two Typecheck/Unit/Build/Browser gates, and two Production Dependency Audits. All six are green. One push-triggered PostgreSQL job initially hit the pre-existing Stage 18 same-operation concurrency flake; the parallel exact-SHA PostgreSQL job passed it and the complete gate, and the failed job was rerun unchanged and passed every step. No test or Stage 18 code was weakened. This report-only commit changes no product code and is subject to the complete exact-final-SHA gate before handoff.

## AI. Legacy production removal

The remaining `createReadinessService`, `allMembers()`, `allGroups()`, `evaluationActor`, and 200-limit occurrences are confined to `apps/api/src/readiness.ts`, the memory-test adapter, plus its conditional memory-only construction in `demo-router.ts`. In PostgreSQL mode that service is not constructed, its routes are disabled, and the explicit Prisma router is the single reachable Readiness authority. Production Readiness does not call compatibility MemberDirectory, memory Training/Documents/Rostering, or hydration paths.

## AJ. Remaining split-brain

There is no remaining production split-brain for Readiness. A deliberately isolated legacy Readiness implementation remains for memory/browser compatibility tests, and the broad generic demo-router still contains other compatibility surfaces outside Stage 19 scope. This is technical debt, not a second PostgreSQL Readiness authority.

## AK. Risks — maximum 10

1. The direct organization-wide evaluator loads the complete accessible population; correctness is established at 1,005 members, but substantially larger deployments may need measured query/streaming optimization without changing authority.
2. `evaluationAt` is deliberately current-topology planning semantics, so consumers must not relabel it as a historical snapshot.
3. UTC availability-day policy may later need a formally owned organization operational timezone decision.
4. Readiness policy remains versioned code configuration; future Admin policy persistence must preserve one authoritative version and is explicitly out of scope here.
5. The memory adapter can drift from PostgreSQL behavior if future tests treat it as production specification.
6. The generic demo-router continues to carry unrelated compatibility code, increasing accidental composition risk for future slices.

## AL. Next Foundation candidate

Independent ranking:

1. **Generic memory/dormant-router production consolidation** — highest remaining authority and technical-debt risk because broad compatibility composition can accidentally shadow or intercept durable modules.
2. Admin dictionaries/config authority — operational policy integrity is important but bounded and not currently a second Readiness authority.
3. AAR/reporting — operationally valuable, but less central to live authority than removing residual production compatibility surfaces.

Selected Stage 20 candidate: **generic memory/dormant-router production consolidation**. This is a recommendation only; Stage 20 is not implemented.

## Verdict

**READY FOR NEXT FOUNDATION SLICE**
