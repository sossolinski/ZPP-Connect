# Foundation Stage 24 — Product Scope Cleanup & Legacy Domain Decommissioning Plan

Status: **PLAN — implementation not yet started**

Baseline: `origin/main` merge commit `29a3d2738b88f554cc4885f4f5db58f9bcccdd59`
(Foundation Stage 23). The authoritative product decision is
[`post-stage22-product-scope-realignment.md`](post-stage22-product-scope-realignment.md).

## 1. Target product state

ZPP Connect remains an Emergency / Crisis Response operational platform for real
incidents. Its active contract includes incident/session control, case work, people and
incident assignments, operational groups and rosters, briefings, documents, notifications,
imports/exports, Post-Incident Reporting, audit, administration and technical resilience.

After Stage 24:

- new Sessions are `REAL`; historical `EXERCISE` and `TRAINING` values remain readable;
- Training, Exercise and organisational Readiness have no production route, navigation,
  write workflow, assignable permission or notification producer;
- Post-Incident Reporting accepts new reports only for closed `REAL` Sessions;
- historical schema/data, approved AAR content, PDF bytes, hashes and AuditLog remain
  unchanged;
- `/api/health/readiness` remains the technical PostgreSQL reachability signal.

This is decommissioning, not replacement functionality. No LMS, exercise-management,
competency or organisational readiness product will be created.

## 2. Current legacy-domain dependencies

### Training

- durable `TrainingCourse`, `TrainingRequirement`, `MemberTrainingRecord` and
  `TrainingOperation` tables and relations from Member/Group;
- production router, repository and service with twenty active operations;
- nine permissions in the shared active catalogue and default-role grants;
- Member-directory `trainingStatus` projection;
- notification assignment/outbox dispatch and periodic overdue/expiry projection;
- `/training`, dashboard shortcuts, Member/Group copy and browser coverage;
- normal seed courses, requirements, records and `TRAINING` Session content.

### Exercise

- dormant-compatible `EXERCISE` Session mode plus `ExerciseInject`,
  `ExerciseObservation` and append-only `ExerciseObservationRevision` tables;
- production router/service, `exercise:manage`, `/exercise`, OpenAPI paths and seed data;
- AAR source-observation selector and immutable historical finding provenance/FK.

### Organisational Readiness

- no Readiness table or migration; seven GET routes calculate a live projection from
  Member, Group, Training, Document, Availability and Roster data;
- six permissions, production service/router, `/readiness`, dashboard shortcuts and
  readiness widgets/filters in Members, Groups and Rostering;
- Training-aware notification/category vocabulary and legacy static portal data.

### Cross-cutting dependencies

- production composition constructs all three services and mounts their owners;
- the active shared permission catalogue makes legacy capabilities assignable and
  EffectiveAccess treats known legacy grants as effective;
- seed and demo fixtures present Exercise/Training as the normal product;
- Stage 18/19 tests prove feature growth, while Stage 20 composition and smoke tests expect
  those active owners/pages;
- Stage 23 backup covers the complete database and verifies exact migration checksums.

## 3. Active product surfaces to remove

- production `/training/*`, `/exercise/*` and `/readiness/*` routers and owners;
- construction/injection of legacy services in production composition;
- Exercise/Training/Readiness navigation, React routes, pages and dashboard actions;
- readiness badges, filters, API calls and programme-management copy on operational pages;
- training qualification/status presentation in the Member and Group experience;
- excluded paths from the active OpenAPI document;
- new AAR observation-source endpoint and request field;
- non-REAL Session creation and mutation through the supported production contract.

Legacy source files may remain temporarily for historical regression tests. Their presence
does not make them part of the production contract.

## 4. Historical data to preserve

- all Training and Exercise tables, rows, constraints, operation replay and revision data;
- `Session.mode` values `EXERCISE` and `TRAINING` and historical event labels;
- Role/override/Audit/Timeline/Notification strings containing retired vocabulary;
- existing AAR findings including observation IDs, versions, operational IDs and copied
  content;
- every approved `aar-v1` hash, approval snapshot and retained `aar-pdf-v1` byte sequence;
- all 23 existing migrations and their exact checksums.

No cascade, purge, hash recomputation or historical relabelling is authorized.

## 5. Database strategy

The preferred Stage 24 database action is **RETAIN DORMANT**. No physical model or column
drop is required to remove a domain from the active product contract. The current schema is
also required to restore Stage 23 backups and decode historical AAR provenance.

No new migration will be created unless implementation uncovers a database-enforced active
write path that cannot be disabled safely in application composition. If one becomes
necessary it will be forward-only, additive/guarding, and separately rehearsed. Historical
migrations will never be edited.

## 6. API strategy

- remove legacy owners from `createProductionComposition` and the production dependency
  graph; requests then receive the normal sanitized 404;
- keep memory-only legacy modules only where predecessor unit tests require them;
- add contract/composition tests proving excluded paths and owners are absent;
- restrict Session writes server-side to `REAL`, with old modes readable and read-only;
- remove the AAR observation-source route and reject new observation-source input;
- keep historical source fields in AAR response/hash/render types so old reports remain
  readable and byte-stable;
- retain technical `/health/readiness` with its distinct `technical-readiness` owner.

## 7. UI and navigation strategy

- remove Training, Exercise and Readiness imports, routes and navigation keys;
- move Documents from the removed `Readiness` group into an operational group;
- remove dashboard shortcuts/copy for excluded modules;
- remove readiness/training decorations from Members, Groups and Rostering while preserving
  the underlying operational workflows;
- remove the AAR observation picker but render legacy finding provenance read-only;
- make the Session create/editor surface REAL-only and mark historical non-REAL rows
  read-only;
- legacy URLs fall through to the authenticated safe default/not-found behavior and never
  mount an unsupported page.

## 8. Permission strategy

Remove all `training:*`, `readiness:*` and `exercise:*` keys from the active shared catalogue
and from default roles. As a result:

- `/admin/capabilities` cannot offer them;
- role/override write validation cannot assign them;
- EffectiveAccess ignores legacy strings still stored in Role/PermissionOverride JSON;
- protected roles seeded under Stage 24 receive only current incident-response grants.

Stored legacy strings are preserved for audit/history decoding. Admin role projections and
updates will exclude retired capabilities from editable lists without requiring destructive
database cleanup. No retired grant is mapped to a broader permission.

## 9. Notification strategy

- stop constructing the Training repository solely for notifications;
- remove Training from periodic notification projection;
- stop producing/dispatching new `TRAINING_ASSIGNED`, overdue and expiry notifications;
- preserve generic outbox/runtime lifecycle and incident, briefing, assignment, rostering,
  document, request, operational and admin notifications;
- retain legacy Training/Readiness category/source vocabulary only where required to read
  already-stored notifications safely; retired destinations must not reopen removed pages.

## 10. AAR cleanup

- new reports require a closed `REAL` Session;
- remove `sourceObservationIds` from active create/edit validation and OpenAPI;
- remove `/sessions/{sessionId}/aar-source-observations` from runtime and OpenAPI;
- existing finding source fields and revisions remain in response models and canonical
  digest input;
- legacy approved reports and stored PDF artifacts remain downloadable without mutation;
- legacy report mutation/PDF generation will be read-only where necessary to prevent new
  excluded-domain writes.

## 11. Backup/restore compatibility

Stage 23 tooling remains strict and unchanged unless the current schema requires an explicit
count/invariant addition. Stage 24 validation will prove:

1. current fresh database backup and manifest verification;
2. restore into an empty database;
3. exact migration-name/checksum compatibility;
4. integrity PASS with dormant legacy tables present;
5. meaningful REAL incident/AAR/PDF recovery;
6. corruption rejection and cleanup of only generated resources.

## 12. Migration strategy

- preserve all existing migration files byte-for-byte;
- prefer no Stage 24 schema migration because active-surface removal is composition/catalog
  policy, not a physical-schema requirement;
- if a migration becomes unavoidable, create a new numbered directory and test zero-to-head
  plus predecessor upgrade without deleting legacy rows;
- retain database constraints and AAR foreign keys protecting historical evidence.

## 13. Seed strategy

Normal seed data will center on REAL incidents, operational users/roles, groups/rosters,
briefings, documents, notifications, reports and AAR. It will not require Training,
Exercise or Readiness records. Historical compatibility fixtures belong in isolated tests,
not the default preview state. Existing stable IDs may be retained where they avoid
unrelated regression churn, but their active content must represent real incidents.

## 14. OpenAPI changes

- remove Exercise operations and the AAR observation-source path/request field;
- ensure no Training/Readiness operation is advertised if the runtime owner is absent;
- retain technical `/health/readiness` and historical AAR response fields;
- add/adjust contract tests so declared paths match the production route manifest.

## 15. Test migration

Existing Stage 18/19 feature tests will be reclassified, not blindly discarded:

- isolated legacy tests continue proving schema/history/constraint compatibility;
- new Stage 24 PostgreSQL tests prove legacy rows survive, active routes return 404,
  retired grants are ineffective/non-assignable, new non-REAL Sessions and AARs are denied,
  approved AAR/PDF hashes remain exact, and technical readiness remains healthy;
- production composition tests prove legacy owners are absent;
- browser tests remove active legacy journeys and assert clean navigation plus REAL incident
  and Post-Incident Reporting workflows;
- the full predecessor, migration, recovery, audit, startup and dependency gates remain.

## 16. Rollout and deprecation risks

- unknown external callers may still use removed endpoints; no consumer registry exists;
- old custom roles may contain retired strings and must remain editable without regranting
  those capabilities;
- pending Training notification outbox rows require safe inert handling;
- seed/test assumptions currently use EXERCISE as the primary active Session;
- AAR immutable hashes include copied observation provenance and must not be normalized;
- backup tooling requires a matching application/schema/checksum set;
- physical purge would require a separate export, reconciliation, retention/legal-hold and
  owner-approval process and is deferred.

Deployment communication must announce terminal legacy endpoints. Rollback is application
rollback to the matching Stage 23 code because the dormant schema remains compatible.

## 17. Explicit exclusions

- no Stage 25 secure-evidence implementation;
- no LMS/HR/ERP or exercise-tool integration;
- no competency, qualification or organisational/team/station readiness replacement;
- no physical deletion/archive UI for legacy data;
- no rewrite of historical migrations, reports, AuditLog, PDFs or hashes;
- no broad visual redesign and no unrelated feature work;
- no weakening of Stage 23 migration checksum, restore or integrity gates.

## 18. Definition of Done

Stage 24 is complete only when all 28 criteria in the task are evidenced. In particular,
the three excluded domains must be absent from the active API/UI/RBAC/notification contract,
technical readiness and incident operations must remain intact, historical data and evidence
must remain exact, current and old-backup recovery procedures must be proven/documented,
and all local plus remote gates must be green. Stage 24 PR will remain unmerged pending
separate authorization.

## 19. Planned commit sequence

1. `docs: define Foundation Stage 24 product cleanup plan`
2. `feat: remove legacy domains from active API composition`
3. `feat: remove legacy domains from product navigation`
4. `refactor: retire legacy permissions and notification producers`
5. `refactor: restrict sessions and post-incident reporting to real incidents`
6. `test: cover Stage 24 decommissioning and retained history`
7. `docs: record Foundation Stage 24 cleanup`

The sequence may be split further to keep reviewable boundaries. No commit will contain
Stage 25 work.
