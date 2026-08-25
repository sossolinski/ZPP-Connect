# Foundation Stage 20 — Production Composition Consolidation

Status: **READY FOR NEXT FOUNDATION SLICE.**

This report records the Stage 20 route/authority audit, implementation, and evidence. The complete required workflow succeeded on exact implementation SHA `faac7e8437f6a3d5f0db5954e6d4987d6f707961`. This report-only verdict commit must receive the same complete exact-final-SHA gate before handoff. Stage 20 adds no migration; the expected migration count remains **21**. Stage 21 has not been implemented.

## A. Stage 19 merge verification and workspace isolation

- Live PR #16 was re-read at exact reviewed head `6f32beef105969d3e0db50708d4c0127293c3586` and verified OPEN/DRAFT, CLEAN/MERGEABLE, without blocking reviews or unresolved threads, with all six exact-head checks green and the Stage 19 report READY.
- PR #16 was marked ready and merged with a merge commit. Stage 19 merge commit: `1012428125abb26763533e6865bca816d4362503`.
- The reviewed Stage 19 head was proved an ancestor of updated `origin/main`.
- Stage 20 uses isolated branch `agent/foundation-stage-20-production-composition` and worktree `/tmp/zpp-connect-stage20-production-composition`, based at the Stage 19 merge commit.
- The original worktree remained on `agent/foundation-stage-12-documents` with its pre-existing modified Prisma schema and untracked Stage 12 migration; Stage 20 did not modify, stash, reset, or clean it.

## B. Proved pre-implementation composition

`app.ts` called `registerRoutes()`. PostgreSQL selection constructed durable repositories/services, mounted Identity and Readiness, and then always mounted `createDemoRouter(...)`. The historical `api = Router()` in `routes/index.ts` defined a second Prisma application but was never mounted. Production therefore depended on route order inside a large demo composition: durable routers happened to appear before shadow implementations, while Dashboard, Timeline, Audit, and Admin dictionaries remained process-memory owned.

The demo router also constructed memory Member Directory, Rostering, Training, Documents, incident assignments, and other seeded stores even when durable replacements were injected. PostgreSQL list/change callbacks copied durable rows into process arrays, and Dashboard authorization warm-up paged durable services into those arrays before reading them.

## C. Final production route ownership matrix

| Route family | Mounted | Final owner | Authority/class | Duplicate/dormant result | Stage 20 action |
|---|---:|---|---|---|---|
| `/health`, `/docs` | yes | `production-public` | E stateless | old unmounted definitions deleted | explicit public router |
| `/auth/*` | yes | Identity router | A PostgreSQL identity | demo auth not loaded or mounted | explicit durable owner |
| `/admin/users`, invitations, organizations, roles, capabilities | yes | Identity router | A PostgreSQL identity | historical and demo duplicates removed from production | explicit durable owner |
| `/admin/dictionaries` | yes | `admin-dictionaries-deferred` | F explicit 501 | memory mutation removed from production | bounded deferred domain |
| `/config/profile`, `/dictionaries` | yes | `production-shared` | E code-owned/static | dormant Prisma and accidental demo owners removed | explicit shared owner |
| `/dashboard` | yes | `production-shared` | E PostgreSQL derived read | memory array owner removed | direct scoped Prisma projection |
| `/sessions` | yes | Incidents | A PostgreSQL | historical Prisma and demo shadow authority removed | dedicated router/service/repository |
| `/sessions/:id/assignments` | yes | Incident Assignments | A PostgreSQL | no production memory assignment store | dedicated router/service/repository |
| `/enquiries` | yes | Enquiries | A PostgreSQL | bridge and shadow callbacks removed | dedicated router/service/repository |
| `/passenger-records` | yes | Passengers | A PostgreSQL | bridge and shadow callbacks removed | dedicated router/service/repository |
| `/family-records` | yes | Families | A PostgreSQL | bridge and shadow callbacks removed | dedicated router/service/repository |
| `/matching*` | yes | Matching | A PostgreSQL | bridge and shadow callbacks removed | dedicated router/service/repository |
| `/releases*` | yes | Releases | A PostgreSQL | bridge and shadow callbacks removed | dedicated router/service/repository |
| `/requests*` | yes | Requests | A PostgreSQL | bridge and shadow callbacks removed | dedicated router/service/repository |
| `/assignments*` | yes | Assignments | A PostgreSQL | bridge and shadow callbacks removed | dedicated router/service/repository |
| Member profiles and Groups | yes | Member Directory | A PostgreSQL | compatibility projection callbacks removed | dedicated router/service/repository |
| Roster and Availability | yes | Rostering | A PostgreSQL | memory shadow not constructed | dedicated router/service/repository |
| Training | yes | Training | A PostgreSQL | memory shadow not constructed | dedicated router/service/repository |
| Documents | yes | Documents | A PostgreSQL | memory shadow not constructed | dedicated router/service/repository |
| Notifications | yes | Notifications | A PostgreSQL | memory notification owner not constructed | dedicated router/service/repository |
| Active Event and Briefings | yes | Operational Briefings | A PostgreSQL | handlers extracted from demo router | dedicated production router/service |
| Imports and Files projection | yes | Imports | A PostgreSQL | generic files/import arrays unreachable | dedicated router/service |
| Exports and session report | yes | Exports/Reports | A PostgreSQL | legacy GET/export implementation unreachable | dedicated router/service |
| Exercise Injects/Observations | yes | Exercise | A PostgreSQL | generic exercise arrays unreachable | dedicated router/service |
| Readiness | yes | Readiness | A PostgreSQL derived | legacy readiness not loaded or mounted | dedicated router/service |
| `/timeline`, `/audit-logs` | yes | `production-shared` | E PostgreSQL shared | process arrays removed from production | direct scoped Prisma routes |

The deterministic production manifest records every concrete method/path, owner, authority, category, and `memoryBacked: false`. Composition throws on a canonicalized duplicate method/path claim.

## D. Process-memory authority inventory

All rows below lose state on restart. Their final disposition is B (test-only) unless noted F.

| Store/service | Domain and readers/mutators | Pre-Stage 20 PostgreSQL behavior | Durable replacement / bridge | Final disposition |
|---|---|---|---|---|
| `organizations` | Admin organizations GET/POST/PATCH | instantiated; shadow paths reachable after durable routes | Identity Organization | B; demo module not loaded in production |
| `users` | auth, Admin users, Member/notification inputs | instantiated and extensively mutated | Identity User | B |
| `roles` | auth/access and Admin roles | instantiated and mutable | Identity Role | B |
| `roleAssignmentGroups` | scoped demo access | instantiated and synchronized from groups | GroupRoleAssignment/OperationalGroup | B; synchronization no longer production reachable |
| `userRoleAssignments` | demo authorization/Admin commands | instantiated and mutable | UserRole/GroupRoleAssignment | B |
| `permissionOverrides` | demo EffectiveAccess/Admin commands | instantiated and mutable | PermissionOverride | B |
| `externalIdentities` | demo auth/Admin identity lifecycle | instantiated and mutable | ExternalIdentity | B |
| `approvedDevelopmentUserIds` | demo local auth allowlist | instantiated and mutable | durable dev identity policy | B |
| `localAuthSessions` Map | demo login/logout | instantiated and mutable | durable identity development session boundary | B |
| `userInvitations` | demo Admin invitations | instantiated and mutable | UserInvitation | B |
| `sessions` | Incidents, Dashboard, shared legacy logic | instantiated; copied from PostgreSQL by callbacks | Session | B; no producer/consumer bridge remains |
| router-local `memoryIncidentAssignments` | incident access/assignment routes | always constructed from demo sessions/users | IncidentAssignment | B; demo-only construction |
| `enquiries` | Enquiries, Dashboard, exports/report | cleared/hydrated/synchronized from PostgreSQL | Enquiry | B; bridge deleted |
| `passengerRecords` | Passengers, Dashboard, imports/exports | cleared/hydrated/synchronized from PostgreSQL | PassengerRecord | B; bridge deleted |
| `familyRecords` | Families, Dashboard, imports/exports | cleared/hydrated/synchronized from PostgreSQL | FamilyRecord/RelationshipClaim | B; bridge deleted |
| `matchingRecords` | Matching, Dashboard, releases/exports | cleared/hydrated/synchronized from PostgreSQL | durable matching models | B; bridge deleted |
| `releases` | Releases, Dashboard | cleared/hydrated/synchronized from PostgreSQL | ReleaseAction/ReleaseCheck | B; bridge deleted |
| `requests` | Requests, Dashboard/report | cleared/hydrated/synchronized from PostgreSQL | WelfareRequest | B; bridge deleted |
| `assignments` | Assignments, Active Event/Dashboard | cleared/hydrated/synchronized from PostgreSQL | AssignmentTask | B; bridge deleted |
| `timeline` | Timeline GET/POST plus demo workflow events | production-readable/mutable | CaseTimelineEvent | B; PostgreSQL shared owner added |
| `auditLogs` | Audit GET plus demo mutations | production-readable/mutable | AuditLog | B; PostgreSQL shared owner added |
| `files` | generic files list/create/update | generic routes disabled only by injected service | StoredFile/Imports projection | B |
| `importBatches` | legacy import validation/confirm | generic/legacy paths conditionally disabled | ImportBatch/ImportValidatedRow | B |
| `importRowsByBatchId` Map | legacy confirm payload | restart-sensitive validated rows | ImportValidatedRow | B |
| `exerciseInjects` | generic CRUD/actions | conditionally disabled | ExerciseInject | B |
| `exerciseObservations` | generic CRUD | conditionally disabled | ExerciseObservation/Revision | B |
| compatibility Member Directory service | members/groups and Admin links | always created, fed by durable callbacks | Foundation Member Directory | B; no production construction |
| compatibility Rostering service | roster/availability and Admin impact | always created | Foundation Rostering | B |
| compatibility Training service | training/readiness | always created | Foundation Training | B |
| compatibility Documents service | documents/readiness | always created | Foundation Documents | B |
| compatibility Readiness service | readiness projection | disabled by a production flag | Prisma Readiness projection | B; positive production selection replaces flag hiding |
| memory Active Event service | briefings/active event | omitted only when PG service injected | Prisma Operational Briefing | B |
| memory Notifications service and `notificationsForAdmin` | notifications and demo workflow hooks | omitted only when durable service injected | durable Notifications/outbox | B |
| `memberDirectoryForAdmin`, `rosteringForAdmin` | demo Admin impact/link helpers | global mutable compatibility references | durable Identity/Member/Rostering | B |
| Admin dictionary mutation response | Admin dictionaries POST | fabricated `dict-demo-*` production response | no approved persistence model in Stage 20 | F; explicit 501 |

No empty PostgreSQL result is replaced by a seed. A dedicated test deletes the durable request sentinel, reconstructs the app, and requires `{ total: 0, data: [] }`. A failing durable Incident repository returns 500 and cannot expose demo rows.

## E. Final composition

```text
createApp
  -> registerRoutes
     -> PostgreSQL: production public + Identity
        -> authenticate
        -> production shared PostgreSQL/static routes
        -> explicitly deferred Admin dictionaries
        -> dedicated durable domain routers
     -> test memory: lazy-load createDemoRouter
```

Production configuration does not import the demo module: the import is conditional on `PERSISTENCE_MODE=memory`. PostgreSQL app locals record `legacyMemoryModuleLoaded=false` and `legacyMemoryRouterMounted=false`. The demo constructor separately rejects PostgreSQL repositories/services if called directly.

## F. Compatibility graph

Before:

```text
PostgreSQL repositories -> dedicated routers
                        -> onList/onChange -> compatibility arrays
                        -> authorization hydration -> Dashboard/report/legacy consumers
createDemoRouter -> seeded services + shadow routes + durable routers
```

After:

```text
PostgreSQL repositories -> dedicated routers
PostgreSQL tables -------> scoped Dashboard/Timeline/Audit shared router
PostgreSQL briefing -----> explicit Briefing router

memory repositories ----> createDemoRouter (automated tests only)
```

The `modules/compatibility/read-only-projection.ts` bridge and every PostgreSQL `onList`, `onChange`, page-merge, and hydration use were deleted. There is no remaining producer-to-memory consumer edge in production.

## G. Historical router disposition

The unmounted 1,200-line alternate Prisma application was deleted from `routes/index.ts`. Its health/docs behavior moved to the public production router; Dashboard, Timeline, and Audit moved to the scoped production shared router. Migrated domain implementations, obsolete imports/exports, old identity/Admin routes, and generic helpers were deleted as dormant duplicates. `routes/index.ts` now selects persistence mode, constructs dependencies, mounts one explicit composition, and installs the notification runtime.

## H. Test-only memory boundary

- Runtime validation still forbids `PERSISTENCE_MODE=memory` outside `NODE_ENV=test` and requires PostgreSQL in production.
- Memory mode lazily loads the demo module and is marked `memory-test-only`.
- PostgreSQL mode neither loads nor mounts the demo module in an actual PostgreSQL-configured process.
- Useful memory repositories/services and existing unit/browser tests remain.
- `createDemoRouter` rejects PostgreSQL authorities, preventing it from becoming a second production composition API.

## I. Automated ownership guard

`production-route-registry.ts` introspects each explicitly mounted child router at composition time. It canonicalizes parameter names and rejects duplicate method/path claims before the app starts. The manifest is exposed through app locals for deterministic tests and includes no memory-backed owner. Unit coverage verifies representative Incidents, Requests, Briefings, Imports, Exports, Exercise, Readiness, Dashboard, and Timeline ownership plus the explicitly deferred Admin dictionaries family.

## J. PostgreSQL provenance coverage

The dedicated Stage 20 suite creates unique durable sentinels for Incident, Request, published Operational Briefing, ImportBatch, ExportGeneration, and ExerciseInject. Every read uses the first request of a newly reconstructed application; Readiness is also read from a fresh composition. The suite asserts 21 migrations, explicit production manifest, no loaded/mounted demo module, honest empty results after durable deletion, and error propagation without seed fallback.

## K. Validation evidence

- API typecheck: passed.
- API unit/memory tests: **104 passed**, PostgreSQL suites skipped without a local database as designed.
- Dedicated route ownership suite: **3 passed**.
- Dedicated Stage 20 PostgreSQL provenance suite: **4 passed**.
- Fresh ordered PostgreSQL Stage 1–20 run: **254 passed across 21 files, zero skipped**.
- Fresh database deployment and canonical seed: **21 migrations applied**, seed passed.
- Focused PostgreSQL Stage 16–19 browser regression: **11 passed**.
- Full memory-mode Playwright regression: **73 passed**.
- Shared, API, and web production build: passed.
- Production PostgreSQL startup: passed; `/api/health` returned 200 with `persistence: "postgres"`, Entra-only auth configuration was exposed, and development users remained unavailable.
- Production memory-mode startup: rejected before listening with `PERSISTENCE_MODE=postgres is required when NODE_ENV=production`.
- Production dependency audit: **0 vulnerabilities**.
- `git diff --check`: passed.
- Draft PR #17 exact implementation-SHA CI: all **six checks passed**—two Foundation PostgreSQL Gates, two Typecheck/Unit/Build/Browser gates, and two Production Dependency Audits.
- The exact implementation-SHA PostgreSQL gates completed the Stage 18→20 unchanged-21-migration upgrade rehearsal and ran the Stage 20 provenance suite after Stage 19.
- This report-only closure commit changes no product code and is subject to the same complete exact-final-SHA gate before handoff.

## L. CI/rehearsal changes

The ordered PostgreSQL command now includes Stage 20. CI adds a dedicated Stage 20 run and extends the unchanged 21-migration rehearsal database through the Stage 20 provenance suite after Stage 19. No schema or migration file changed.

On exact implementation SHA `faac7e8437f6a3d5f0db5954e6d4987d6f707961`, both PostgreSQL jobs passed that rehearsal unchanged. Representative Identity, Member, Group, Training, Documents, Availability/Rostering, Incident, Import, Briefing, ExportGeneration, and Exercise state survived schema redeployment; Stage 19 and Stage 20 then passed on the same database without compatibility hydration.

## M. Deliberately deferred debt

1. Admin dictionary/config mutation authority has no approved Stage 20 persistence design; `/admin/dictionaries` is an explicit 501 rather than process-memory persistence.
2. AAR/PDF redesign remains outside Stage 20. The Stage 17 durable session-summary/export owner remains; unavailable formats retain their explicit response.
3. Memory implementations remain behavioral test adapters and can drift if treated as production specifications.

## Verdict

**READY FOR NEXT FOUNDATION SLICE**
