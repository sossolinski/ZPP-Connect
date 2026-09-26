# Post-Stage-22 Product Scope Realignment

Status: **ASSESSMENT COMPLETE — DOCUMENTATION ONLY**

Assessment date: 2026-09-22. Baseline: merged Foundation Stage 22 at
`d7933524eea9b5664a5a73f4f99631e8714427d8`. This document records a product and
architecture decision; it does not delete data, change migrations, alter runtime behavior,
or implement Foundation Stage 23.

## 1. Executive decision

ZPP Connect is an **Emergency / Crisis Response operational platform for real incidents**.
It should retain the operational Incident, activation, coordination, access, notification,
briefing, timeline, documents/checklists, import/export, post-incident reporting, evidence,
audit, configuration, security and resilience capabilities that directly support that goal.

Training Management, Exercise Management and organisational Readiness are not future
product domains. Their current write surfaces should be frozen, deprecated and then
removed in a controlled stage. The underlying business processes and their authoritative
data should move to appropriate external systems. Historical rows must not be erased merely
because their authoring features leave the product.

The recommended order is:

1. **Stage 23 — Platform Resilience, Recovery & Data Integrity**.
2. **Stage 24 — Product Scope Cleanup & Legacy Domain Decommissioning**.
3. **Stage 25 — Secure Incident Evidence & Foundation Exit**, the final Foundation stage.

This is a finite roadmap. After Stage 25, product changes become normal, outcome-led
development rather than additional numbered Foundation stages.

## 2. Target product boundary

### In scope

- real Incident / Crisis Sessions and activation;
- assignments, crisis roles, effective access and operational groups;
- operational coordination, requests, matching and controlled release;
- notifications and alert delivery;
- Operational Briefings, timeline/log and audit;
- crisis documents, checklists and acknowledgements;
- controlled imports, exports and reports;
- Post-Incident Reporting, retained PDFs and incident evidence;
- administration, RBAC, dictionaries/configuration and security;
- PostgreSQL resilience, backup/restore, recovery and data-integrity monitoring.

### Outside the product boundary

- training catalogues, requirements, attendance/history, competency, qualification,
  matrices and expiry;
- exercise scheduling, permanent exercise records, injects and observation repositories;
- organisational, team or station Readiness scoring and programme dashboards.

`Session` remains the canonical operational envelope. Existing `EXERCISE` and `TRAINING`
mode values are historical compatibility data, not invitations to grow those products.
New real-incident workflows should default to `REAL`; legacy modes should remain readable
until an explicit migration and retention decision says otherwise.

## 3. Current architecture

The production application is a React client, an Express API and a PostgreSQL authority.
Production composition is explicitly registered in
[`production-composition.ts`](../apps/api/src/routes/production-composition.ts) and tested
to reject memory substitutes. The core operational model is in
[`schema.prisma`](../apps/api/prisma/schema.prisma); the 23 immutable migrations end with
Stage 22's AAR integrity migration.

Important boundary facts from the repository audit:

- There is no separate `Exercise` aggregate. `Session.mode` is `REAL`, `EXERCISE` or
  `TRAINING`; Stage 18 added `ExerciseInject`, `ExerciseObservation` and append-only
  `ExerciseObservationRevision` records below a Session.
- There is no `Readiness` or `ReadinessProjection` table and no Stage 19 migration.
  Stage 19 calculates current categorical status from Member, Group, Training, Document,
  Availability and Roster data at request time.
- Training is a durable domain with `TrainingCourse`, `TrainingRequirement`,
  `MemberTrainingRecord` and `TrainingOperation`, production routes, role grants,
  notifications and Member-directory projection.
- Stage 22 is a generic post-incident report domain. Its only material Exercise dependency
  is the optional immutable source reference from an AAR finding to an
  `ExerciseObservationRevision`; copied finding content remains part of the approved
  `aar-v1` digest.
- `StoredFile` and the disk/Multer demo path are not a secure production evidence layer.
  Documents store versioned text or external links, imports retain hashes/metadata but not
  source bytes, exports retain provenance but not general files, and AAR retains only its
  generated PDF bytes.

The audit covered schema and migrations, API modules/routes/composition, shared types and
permissions, seed, client routes/navigation/pages, notifications, imports/exports,
OpenAPI, AAR, audit/timeline, unit and PostgreSQL tests, Playwright, CI and Foundation
reports. Search terms included Exercise, Inject, Observation, Training, Readiness,
permissions, competency, qualification, matrices and station readiness. No standalone
competency, qualification-matrix or station-readiness model was found.

## 4. Stage 18 assessment

Stage 18 is technically sound but strategically out of scope.

Current behavior is implemented by
[`modules/exercise`](../apps/api/src/modules/exercise),
[`ExercisePage.tsx`](../apps/web/src/pages/ExercisePage.tsx), shared permissions and
dictionary policies. It exposes nine list/create/update/release/complete/history operations.
Writes require `EXERCISE`, an active writable Session, incident access and
`exercise:manage`; closed historical reads remain possible. Audit is structural, and the
database protects inject terminal state plus append-only, contiguous observation revisions.

Decision:

- **Do not develop this domain further.** Freeze new feature investment immediately.
- Deprecate new Inject and Observation authoring, then remove the Exercise route, UI,
  production owner, default grants and mutable dictionary surfaces in Stage 24.
- Externalise exercise planning, scheduling, injects and observations to an appropriate
  exercise-management register or service.
- Retain generic patterns—Session locking, optimistic concurrency, operation replay,
  incident scoping, append-only history and audit—but not the Exercise vocabulary or UI.
- Preserve historical Stage 18 rows while AAR references or retention obligations exist.
  Physical table deletion is not required to exit Foundation and must never cascade through
  approved AAR evidence.

The Inject domain has no live dependency from incident operations, imports, exports,
briefings or the production dashboard. Observations have the Stage 22 dependency described
in section 6, which makes blind table removal unsafe.

## 5. Stage 19 assessment

Stage 19 is a current-state projection, not a durable Readiness ledger. Its seven GET routes
in [`modules/readiness`](../apps/api/src/modules/readiness) evaluate a versioned policy over
the current Member/Profile, Group/Membership, Training, Document acknowledgement,
Availability and Roster topology in one repeatable-read transaction. Results are
categorical statuses and distributions, not a stored percentage score or historical fact.

Decision:

- Remove the Readiness API owner, policy, UI page and cross-page badges/filters in Stage 24.
- Remove the six readiness permissions and related default grants only after every endpoint
  and consumer is gone; do not translate them into broader incident authority.
- Retain the genuinely operational source domains: identity/contact directory, operational
  groups, availability, roster and incident documents.
- Externalise organisational/team/station readiness assessment and programme reporting.
- Do not export the current projection as if it were historical truth; it is evaluated at
  request time against current topology.

The Member, Group and Rostering pages already tolerate Readiness failure, so the projection
can be removed without removing those operational features. The production dashboard does
not query it. The static `apps/web/src/data/dashboard.ts` percentage data belongs to an
unrouted legacy portal component and is a direct removal candidate.

## 6. Stage 22 coupling assessment

Post-Incident Reporting remains in scope for real incidents. Its seven AAR tables,
revision lifecycle, approval digest, immutable approved content, retained PDF bytes,
integrity verification, RBAC, audit, API/OpenAPI and UI are **KEEP**.

Coupling to remove in Stage 24:

1. Stop offering new `Exercise Observation snapshots` in AAR create/edit UI and API.
2. Remove the `exercise:manage` capability dependency used only to expose that selector.
3. Retain every copied finding, source operational ID/version and approved content digest.
4. Keep legacy source rows read-only while the composite foreign key exists. If a later
   migration removes the FK after external archive/retention approval, keep source IDs and
   snapshots unchanged; never clear them or recompute an approved `aar-v1` digest.
5. Preserve already-generated `aar-pdf-v1` bytes. Do not regenerate historical PDFs under
   a new interpretation.
6. Make REAL Sessions the primary browser and acceptance path while keeping explicit tests
   for legacy EXERCISE/TRAINING report readability.

Generic findings, lessons and corrective recommendations remain part of post-incident
reporting. They are immutable report content, not an enterprise action-tracking engine.

## 7. KEEP / DEPRECATE / REMOVE / EXTERNALISE matrix

| Component | Current role and dependencies | Class | Reason and migration risk | Historical data / destination |
|---|---|---|---|---|
| Session, lifecycle and activation | Canonical envelope used by every incident domain | KEEP | Core real-response authority; changing IDs/status semantics is high risk | Preserve all modes; default future operations to REAL |
| IncidentAssignment and effective access | Incident scope, revocation and route/service gates | KEEP | Central security boundary | Preserve assignment/access history |
| Member identity/contact | Users, MemberProfile, directory and incident staffing | KEEP | Needed to contact and assign responders | Remove training projection only; identity remains authoritative here as agreed |
| Operational Groups | Incident/group coordination and scoped RBAC | KEEP | Operational grouping is not organisational readiness scoring | Preserve membership and role history |
| Rostering and Availability | Operational coverage and shifts | KEEP | Supports real incident staffing; no qualification gate found | Keep; remove readiness badges/helpers only where unused |
| Passenger, family/NOK, enquiries, matching, release, requests, assignments | Operational case work | KEEP | Direct real-incident mission | Preserve existing integrity/audit history |
| Briefings, timeline and notifications | Coordination, decisions and alert delivery | KEEP | Direct crisis operations | Keep historical Training/Exercise notification text readable |
| Documents/checklists/acknowledgements | Versioned text/external links and compliance acknowledgements | KEEP | Useful incident instructions/checklists | Not a binary evidence vault |
| Imports and exports | Controlled operational exchange and provenance | KEEP | Needed for manifests, handover and authorized reporting | Historical mode labels remain valid |
| AAR core and retained PDF | Post-incident report, approval and exact-byte evidence | KEEP | Explicit product boundary and completed Stage 22 | Never rewrite approved hashes or stored PDFs |
| Audit, admin, RBAC, dictionaries, production composition | Cross-cutting authority and configuration | KEEP | Security and operability foundation | Preserve old action/permission labels for history decoding |
| Non-REAL Session authoring | Existing EXERCISE/TRAINING modes | DEPRECATE | Out of future scope; immediate enum/data rewrite would be unsafe | Read-only compatibility; no new feature investment |
| Stage 18 tables | Injects, observations and immutable revisions | DEPRECATE | AAR FK and history make immediate removal unsafe | Freeze writes; archive externally before any optional physical purge |
| Stage 18 API/UI/production owner | Active exercise-management product surface | REMOVE | No required real-incident dependency after AAR decoupling | Replace with legacy-history access/export if still required |
| Exercise permissions and writable dictionaries | Grants and controlled vocabularies | REMOVE | Product-specific authority should not survive endpoints | Retain audit labels; remove grants without broadening access |
| Exercise planning/records process | Scheduling, inject and observation ownership | EXTERNALISE | Not a crisis-response system responsibility | Move to approved exercise-management repository |
| Training tables | Courses, requirements, records and operation replay | DEPRECATE | Durable history and notification/member dependencies require staged cutover | Export to target LMS/HR source; retain read-only until accepted |
| Training API/UI/services | Twenty operations and active Training page | REMOVE | Out of scope once external authority is available | Remove routes/nav/composition after cutover |
| Training directory projection | `trainingStatus` in Member responses | REMOVE | Couples operational directory to qualifications | Keep directory; source qualification in external system only if display is later required |
| Training notification producer | Expiry/overdue projection and Training categories | REMOVE | Programme alerts are out of scope | Keep generic outbox/dispatcher and historical deliveries |
| Training/qualification process | Course, attendance, competency and expiry authority | EXTERNALISE | Appropriate LMS/HR/ERP concern | Export with owner-approved mapping and reconciliation |
| Stage 19 readiness service/policy | Live computed member/group/summary status | REMOVE | Not used as durable incident fact; not product responsibility | No table migration; remove consumers and owner together |
| Readiness UI badges, filters and dashboard copy | Cross-page programme status display | REMOVE | Misstates target product boundary | Member/Group/Roster pages remain without these decorations |
| Organisational/team/station readiness process | Programme assessment and dashboards | EXTERNALISE | Belongs in programme BI/ERP governance | Do not manufacture a historical snapshot during removal |
| Legacy static portal dashboard data | Dormant training percentage fixture | REMOVE | Unrouted and non-authoritative | No data migration |
| AAR Exercise-source selector | Copies selected Observation revisions into findings | DEPRECATE | New coupling is out of scope, but existing provenance is immutable | Disable new links; preserve snapshots, IDs and hashes |
| Excluded-domain production registrations | Route/composition owners mount Training, Exercise and Readiness | REMOVE | Runtime must have no hidden owner or fallback after Stage 24 | Composition inventory tests must prove absence |
| Excluded-domain OpenAPI operations and shared client types | Publish and consume the three active domain contracts | REMOVE | Contract must follow runtime decommissioning, not outlive it | Keep only legacy AAR response fields needed for history |
| Seeded grants and controlled dictionaries | Default-role permissions and Exercise/Training/Readiness vocabularies | DEPRECATE | Immediate removal can break custom roles and history decoding | Make non-assignable, reconcile, then remove active grants |
| Stage 18/19 product tests and PostgreSQL browser workflows | Assert active Exercise and Readiness behavior in CI | DEPRECATE | Deleting them first would conceal regressions | Replace with decommissioning, history and REAL-flow tests before removal |
| Historical Foundation reports and migrations | Explain why domains exist and reproduce every schema generation | KEEP | Architecture/audit evidence; rewriting would corrupt history | Mark superseded direction in new docs, never rewrite old migrations |
| Generic `StoredFile`/demo disk upload | Legacy metadata/local disk path, not a production owner | REMOVE | Must not become a second evidence authority | Replace only through Stage 25 migration, not ad hoc reuse |
| Incident binary evidence process | Photos, authority documents, correspondence, scans | KEEP | Required by the stated incident-evidence boundary | Implement secure in-app authority in Stage 25 |

## 8. Data and history considerations

- Never rewrite old migrations or delete Stage 18/19/22 history in place.
- Backup the full current database before scope cleanup, including deprecated domains.
- Define the external system, export schema, reconciliation totals, owner acceptance and
  retention/legal-hold policy before disabling business access.
- Treat Audit and Timeline action/source strings as historical vocabulary. Removing an
  endpoint does not authorize erasing or relabelling its events.
- PostgreSQL `ON DELETE RESTRICT`, append-only triggers and AAR composite references are
  migration inputs, not obstacles to bypass.
- Make cleanup migrations additive and reversible at first: freeze writes, remove product
  routes, export/reconcile, retain cold rows, then consider physical purge separately.
- A purge must have dry-run counts, reference checks, bounded batches, audit, explicit
  operator confirmation and a tested restore point. No automatic business-data purge is
  approved by this assessment.

## 9. RBAC impact

Training contributes nine shared permissions; Exercise contributes `exercise:manage`;
Readiness contributes six read/policy permissions. They appear in protected/default role
seed data, custom-role allowlists, tests, navigation capability checks and route gates.

Stage 24 must inventory both grants and explicit denies, remove endpoint dependencies
first, then reconcile default roles and custom roles transactionally. Deprecated grants
must not be mapped to a new broad incident permission. Historical role-assignment and
override records should remain interpretable even if a permission becomes non-assignable.
The existing incident, group, document, report, audit and admin permissions remain.

## 10. API and OpenAPI impact

- Deprecate and then remove `/training/*`, `/exercise/*` and `/readiness/*` production
  routes as coordinated domain units.
- Remove the AAR source-observation list and write fields for new reports only after a
  compatibility plan; preserve legacy response fields needed to render old versions.
- Update OpenAPI in the same commits as runtime changes and prove no orphan operations.
- Do not silently return empty data or memory fallbacks after an owner is removed.
- If external consumers exist, publish a dated deprecation window and explicit terminal
  response. The repository contains no consumer registry, so owner confirmation is a
  Stage 24 entry criterion.

## 11. UI and navigation impact

Remove the Training, Exercise and Readiness routes/pages and their navigation entries in
Stage 24. Remove readiness badges/filters from Dashboard, Members, Groups and Rostering,
and qualification/training copy from Member views. The current `Readiness` navigation
group also contains Documents; move Documents to an operational grouping rather than
deleting the group wholesale. Remove the AAR Observation picker but retain readable source
provenance on historical reports.

Dashboard shortcuts must describe real activation, staffing, documents, briefings,
notifications and incident work. No percentage, course-expiry or exercise-authoring card
should remain. Historical Session labels may still display their recorded mode.

## 12. Testing impact

Stage 24 should replace product-growth tests with boundary and retention tests:

- prove deprecated writes are unavailable and no production owner/memory fallback remains;
- prove REAL incident workflows, Member/Group/Roster/Documents and notifications still work;
- prove historical Training/Exercise records remain exportable/readable under agreed access;
- prove old Audit/Timeline/Notification records render safely without live target routes;
- prove approved AAR versions/PDFs keep the same `aar-v1` and artifact hashes;
- add REAL-first AAR browser coverage and a legacy-source read-only fixture;
- adjust composition, seed, permissions, OpenAPI and navigation inventories atomically;
- keep migration-from-zero and predecessor-upgrade rehearsals.

Do not simply delete Stage 18/19 tests. Preserve tests for the generic concurrency, audit,
authorization and historical-integrity guarantees that remain applicable.

## 13. Recovered roadmap evidence

### Previously agreed or selected

- Stage 17 selected Exercise evidence as Stage 18 in
  [`foundation-stage-17-exports-reports-report.md`](foundation-stage-17-exports-reports-report.md).
- Stage 18 selected organisational Readiness as Stage 19 in
  [`foundation-stage-18-exercise-evidence-report.md`](foundation-stage-18-exercise-evidence-report.md).
- Stage 19 selected production composition as Stage 20; Stage 20 then left configuration
  and AAR as candidates. Stage 21 explicitly selected Stage 22 AAR.
- Stage 22 is now merged as Post-Incident Reporting and PDF Integrity. Its approved scope
  excluded arbitrary attachments, object storage, retention/purge and recovery.
- The current product-boundary instruction supersedes the older assumption that Exercise
  and organisational Readiness should continue growing.

### Previously deferred

- [`stage-3g-functional-gap-audit.md`](stage-3g-functional-gap-audit.md) deferred backup,
  recovery and retention until durable persistence existed.
- Stage 13 identified operational alerting needs beyond ordinary in-app delivery.
- Stage 22 deferred backup/restore rehearsal, retention, capacity benchmarking, arbitrary
  files/attachments, object storage, signatures and richer document formats.
- Stage 21 classified several identity/JWKS/observability/runbook matters as environment
  hardening rather than dictionary configuration.

### New recommendation

Repository history, reachable branches and available task attachments contain no approved
Stage 23/24/25 allocation. Stage 22's report recommended a broadly named “Production
Operational Readiness” next stage, but labelled it a recommendation, not an approved
roadmap. The current instruction authoritatively reframes Stage 23 as **Platform
Resilience, Recovery & Data Integrity**. Assigning cleanup to Stage 24 and secure incident
evidence/final exit to Stage 25 is new in this assessment.

No deleted or renamed roadmap document was found in reachable Git history. Therefore this
document does not claim recovery of a hidden previously approved Stage 24 or 25.

## 14. Cleanup ordering decision

| Option | Benefit | Cost/risk | Decision |
|---|---|---|---|
| A — cleanup before resilience | Backup/retention design sees only the target model | Destructive migrations occur before tested recovery; AAR/history coupling and external cutover are not ready | Reject |
| B — resilience before cleanup | Protects all current authoritative history and provides rollback/rehearsal before decommissioning | First backup covers data later made cold; retention inventory includes deprecated domains | **Select** |

Select Option B, with an immediate non-code product freeze on excluded domains. PostgreSQL
backup and PITR are cluster/data-authority capabilities, so protecting currently retained
tables is not wasted design. Stage 23 must tag deprecated datasets in its restore and
retention inventory, while Stage 24 uses the resulting restore capability before any
schema or data cleanup.

## 15. Stage 23 proposal — Platform Resilience, Recovery & Data Integrity

Stage 23 is technical resilience, not organisational Readiness.

### Work packages

1. **Recovery contract and ownership** — document production topology, database/object
   owners, environments, encryption/key custody, escalation, and approved RPO/RTO. Use
   **RPO 15 minutes and RTO 4 hours as planning hypotheses only** until the service owner,
   infrastructure provider, data volume and recovery test validate them.
2. **PostgreSQL backup** — implement encrypted, independently credentialed, off-host and
   preferably immutable physical base backups plus continuous WAL archiving for PITR.
   A logical dump may be retained for portability/inspection but is not PITR. PostgreSQL
   distinguishes SQL dumps, filesystem backups and continuous archiving in its
   [backup documentation](https://www.postgresql.org/docs/16/backup.html); PITR requires a
   base backup and archived WAL as described in
   [continuous archiving](https://www.postgresql.org/docs/16/continuous-archiving.html).
3. **Automated isolated restore** — rebuild an empty recovery environment without outbound
   notifications or real Entra dependencies; restore roles, extensions, sequences,
   constraints, triggers, schema/data and separately managed configuration/secrets. Never
   run the development seed against a restored production copy.
4. **Restore rehearsal** — schedule rehearsals, record actual recovery point, start/end
   times, byte counts, failures and operator decisions, and test promotion/rollback.
5. **Backup and data integrity** — verify backup manifests, then perform a real restore;
   PostgreSQL warns that `pg_verifybackup` does not replace test restores in its
   [verification documentation](https://www.postgresql.org/docs/16/app-pgverifybackup.html).
   Add versioned, read-only invariant checks for PK/FK/unique constraints, role and Session
   topology, append-only histories, AAR canonical hashes and retained PDF byte hashes.
6. **Retention and safe purge/archive** — inventory each dataset, legal hold and external
   dependency. Propose a recoverability window only after owner approval; do not delete
   solely by age. Require dry-run, reference checks, bounded transactions, audit and a
   tested recovery point.
7. **Monitoring and alerts** — monitor last successful backup, WAL/archive lag, restore
   rehearsal age, storage growth and integrity-check failures. Alert out-of-band; an
   application notification stored in the failed database cannot be the only alarm.
8. **Runbooks** — cover loss/corruption scenarios, credential/config recovery, PITR target
   selection, validation, traffic isolation, notification suppression, promotion,
   rollback and evidence capture.

### Definition of Done

- approved owners and measured RPO/RTO, not aspirational labels;
- automated production-like backup and isolated restore from empty infrastructure;
- successful scheduled restore rehearsal with recorded recovery point and elapsed time;
- restore includes every current table, deprecated historical data, privileges,
  sequences, triggers and required configuration;
- corrupt/incomplete backup and deliberately corrupted domain/artifact fixtures fail
  visibly; successful validation has durable evidence;
- independent monitoring alerts on missed backup, excessive lag, failed verification and
  overdue rehearsal;
- retention/purge remains disabled until policy, holds and rollback are approved;
- operator-reviewed runbooks pass a tabletop and technical rehearsal;
- CI retains migration-from-zero and predecessor-upgrade gates, but CI is not presented as
  the production backup system.

## 16. Secure incident evidence/files stage

Yes—secure incident files deserve one remaining Foundation stage because incident evidence
is explicitly in the target boundary and no current component supplies a production-safe
authority for photographs, authority documents, correspondence or scans.

Stage 25 should provide:

- incident-scoped metadata and effective-access checks on every list/upload/download;
- allowlisted file types, content/signature validation, safe names and size limits;
- quarantine and malware scanning before release, consistent with the OWASP
  [File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html);
- encrypted durable object storage outside the web root, independent keys/credentials,
  immutable object identity, SHA-256 and auditable custody events;
- atomic or recoverable database/object-store write semantics, orphan reconciliation and
  honest failure states;
- retention, legal hold, authorized export and safe purge tied to Stage 23 recovery;
- backup/restore rehearsal for both metadata and bytes;
- migration or explicit retirement of the legacy `StoredFile`/local-disk path;
- evidence download security, disposition headers, scanning state and no public URL leak.

This is not a generic collaboration drive, rich-text/DOCX editor or unlimited attachment
feature. If governance later mandates that all evidence remain in an approved external
record system, Stage 25 must instead implement and validate secure external references and
custody boundaries; it remains the Foundation exit gate for incident evidence either way.

## 17. Remaining Foundation sequence

| Stage | Outcome | Explicit exclusions |
|---|---|---|
| 23 — Platform Resilience, Recovery & Data Integrity | Tested backup/PITR/restore, integrity monitoring, retention controls, alerts and runbooks | No organisational Readiness; no product-domain cleanup |
| 24 — Product Scope Cleanup & Legacy Domain Decommissioning | Remove active Training/Exercise/Readiness surfaces, decouple AAR, externalise business ownership, preserve/reconcile history | No blind table drops; no approved-hash rewrite; no new replacement ERP |
| 25 — Secure Incident Evidence & Foundation Exit | Production evidence authority or validated external custody, integrated with recovery/retention/security; final hardening acceptance | No general document-management suite |

Stage 25 is the final Foundation stage.

## 18. Foundation exit point

Foundation ends when all of the following are true:

- the deployed system can be restored and integrity-validated within approved, measured
  recovery objectives;
- Training, Exercise authoring and organisational Readiness are absent from active product
  navigation/API/composition, with historical data reconciled and protected;
- REAL incident flows, post-incident reports, audit and historical compatibility remain
  green after cleanup;
- incident evidence has an approved secure custody model and tested recovery/retention;
- production identity/configuration, monitoring, alerting and operator runbooks have named
  owners and acceptance evidence;
- no unresolved Foundation-critical integrity or security gap remains.

After that point, improvements such as richer incident workflows, usability, analytics,
new integrations, typography or domain-specific reports enter a normal product backlog.
They must not create Stage 26 merely because they are valuable.

## 19. Risks

1. External destination systems, owners and export contracts are not yet selected.
2. Retention and legal-hold decisions require accountable business/legal owners; this
   assessment is not a legal retention policy.
3. Historical AAR source FKs make premature Exercise-row deletion unsafe.
4. Training removal spans directory, notifications, seed/RBAC and UI—not only one router.
5. Removing permissions can accidentally broaden access if mapped to generic grants.
6. A backup without an isolated restore rehearsal creates false confidence.
7. App-only health (`/api/health`) currently does not prove a live database query and must
   not be the sole recovery/readiness signal.
8. The deployment provider, production scale, backup storage and key-management system are
   unknown; Stage 23 cannot claim an achieved RPO/RTO until those are fixed and measured.
9. Binary evidence increases security, privacy, malware, capacity and recovery obligations.
10. Historical mode/action labels must remain decodable after active routes disappear.

## 20. Non-goals

- No product code, schema, migration, seed, permission or CI change is made here.
- No table or historical record is deleted.
- Stage 23 is proposed, not implemented.
- No external LMS, ERP, BI, exercise or evidence vendor is selected.
- No current projection is declared an authoritative historical readiness score.
- No approved AAR content, digest or retained PDF is rewritten.
- No new Training, Exercise or organisational Readiness capability is proposed.
- No indefinite Foundation roadmap is created.

## 21. Immediate next action

Approve this boundary and sequence, then plan Stage 23 on a fresh branch. Before Stage 23
implementation, obtain named decisions for production hosting/topology, backup target and
key custody, RPO/RTO, retention/legal hold, monitoring escalation and rehearsal cadence.
Record excluded-domain feature freeze at the same time, but defer code/data cleanup to
Stage 24 after the first successful restore rehearsal.
