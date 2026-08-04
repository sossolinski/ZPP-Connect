# Stage 3G Functional Gap Audit

Date: 2026-07-19

## 1. Executive summary

ZPP Connect has broad local functional coverage. The strongest areas are session-aware workflow controls, explicit record actions, assignment lifecycle handling, operational briefing revisions, training/documents/readiness linkage, account lifecycle administration, audit history, and automated browser coverage. The application is suitable for continued local functional testing.

It is not yet suitable for a realistic end-to-end exercise or production use. Three confirmed critical mismatches must be contained first:

1. The Dashboard API returns detailed attention records to every role with `session:read`, including roles that cannot open the source modules. The UI then renders sensitive family, enquiry, request and matching context and links to routes that return 403.
2. Group-scoped role assignments are enforced for Groups but not consistently for case records, matching, rostering and other domain reads. Group leaders can receive session-wide data despite a GROUP-scoped role assignment.
3. CSV exports report success but return the same fixed summary for every supported CSV type. That output is not a truthful export of the selected resource or session.

The local architecture remains intentionally process-local, and authentication remains development-oriented. Those constraints do not prevent local functional testing, but they remain absolute production blockers. They must stay an internal engineering concern and must not be described in the product UI.

### Baseline evidence

| Check | Result |
| --- | --- |
| Fresh API and web processes | Started on API `4100` and web `4173` |
| Complete smoke suite | 52 passed |
| Dependency audit | `npm audit --omit=dev`: 0 vulnerabilities |
| Canonical roles exercised | 8 of 8 |
| Direct authorization probes | Dashboard, Groups, Family/NOK, Matching, Rostering and Exports |

The test suite is a strong regression baseline, but it currently proves expected implementation behavior rather than complete policy correctness. The critical findings above need dedicated negative authorization tests.

## 2. Product and module completeness matrix

Status meanings:

- Complete: coherent local workflow with no material gap found in this audit.
- Mostly Complete: usable, with bounded gaps that do not invalidate the whole workflow.
- Partial: meaningful behavior exists, but an important path or lifecycle is missing.
- Placeholder: the surface exists but the main action is not implemented.
- Broken: the surface can disclose, misrepresent or produce materially wrong behavior.

| Area | Route | Purpose and primary users | Source of truth | Major actions and states | Dependencies | Status and rationale |
| --- | --- | --- | --- | --- | --- | --- |
| Login and development access | `/login` | Enter the application; all users | API authentication contract and process-local sessions | Discover method, sign in, reject inactive account, logout | Users, invitations, account status | Mostly Complete locally. Clear failure behavior and return path exist. External identity, real local password and durable sessions are deferred. |
| Account menu and Settings | `/settings` | Review current identity, roles and session context; all roles | `/auth/me`, profile and session API | Review profile, sign-in and access context | Member linkage, roles | Mostly Complete. Read-only intent is clear, but own Member Profile and personal support path are not directly discoverable. |
| Users, invitations and account lifecycle | `/users-access` | Administer accounts; System Admin | Admin API repositories | Create/pending, invite, activate, suspend, reactivate, archive, link member | Roles, organizations, invitation contract, audit | Mostly Complete locally. Dedicated lifecycle actions are strong; several secondary revocations still use browser confirms. |
| Roles and permissions | `/roles-permissions` | Review protected roles and custom capabilities; System Admin | Canonical shared role catalogue and admin API | Assign/revoke scoped roles, create/archive custom roles, grant/deny override | Users, groups, audit | Partial. Canonical permissions are server-enforced, but GROUP scope is not propagated uniformly into domain queries. |
| Organizations and dictionaries | `/users-access` tabs | Reference administration; System Admin | Admin API repositories | Create/update organization; inspect dictionaries | Users and workflow forms | Mostly Complete. Dictionary inspection is useful; some frontend assignment options still fall back to static values. |
| Sessions | `/sessions` | Establish active REAL, EXERCISE or TRAINING context; coordinators/admin/observer | Sessions API | Create, update, activate/select, close; Draft/Active/Paused/Closed/Archived | All session-scoped modules | Complete for local testing. Session write checks and closure reconciliation are covered. |
| Active Event and Operational Briefing | `/active-event` | Situation awareness and briefing lifecycle; coordinators, leaders, members, observer | Active Event service derived from session and operational entities | Draft, publish, supersede, revision history, confirmed/unconfirmed facts, priorities, risks, notes | Sessions, assignments, records | Mostly Complete. The command surface is useful and revisioned; role-specific redaction and stale-age emphasis need explicit policy tests. |
| Dashboard | `/dashboard` | Immediate orientation and next steps; all roles | `/dashboard` aggregate API | Start-here guidance, KPIs, attention queues, destinations | Sessions, records, matching, requests, readiness | Broken. Role-adaptive quick actions are good, but detailed attention data is not authorization-filtered and produces sensitive disclosure and dead-end links. |
| Notifications | topbar panel | Personal and operational attention; all roles | Entity-derived notification service and per-user read state | Group/filter, read/unread, mark all, resolve source, navigate | Assignments, briefing, roster, training, documents, records | Mostly Complete. Read state, retry and destinations are covered; policy filtering should be rechecked after Dashboard/scope containment. |
| TEC enquiries | `/tec-intake` | Capture caller enquiry without disclosure; TEC and authorized ZPP roles | Enquiry API | Create, edit, urgent/escalation actions, close | Session, passenger context, requests, timeline | Mostly Complete. Guidance and audited actions are strong; group scope and scale remain open. |
| Family/NOK | `/family-nok` | Maintain family contact and verification; authorized TEC/ZPP roles | Family API | Create, edit, verify, search/filter | Session, matching, requests, release | Mostly Complete. Verification is explicit; scope policy and sensitive dashboard leakage are unresolved. |
| Passenger/SRC | `/passenger-src` | Maintain manifest/source records and holds; authorized coordinators/leaders | Passenger API | Create, edit, source/condition/hold updates | Import, matching, release | Mostly Complete manually. Bulk manifest intake is unavailable in the local backend. |
| Matching and holds | `/matching` | Reconcile family, enquiry and passenger context; authorized roles | Matching API | Suggest, review, link, hold/escalate, verify, reunite | Enquiries, Family/NOK, Passenger/SRC, release | Mostly Complete. Integrity and hold transitions are tested; large client-side loads and scope policy remain risks. |
| Release Control | `/release-control` | Controlled reunification/release; authorized ZPP roles | Release API | Prepare, identity check, hold clear, release/reunite, terminal checks | Verified matching and hold state | Mostly Complete. Server integrity guards are strong; visual theme residue and large-list behavior remain. |
| Requests | `/requests` | Welfare/logistics support requests; TEC/ZPP operational roles | Request API | Create, assign/update, urgent handling, close | Family, passenger, enquiry, assignments | Mostly Complete. Clear queue guidance; scope filtering and dashboard exposure need correction. |
| Timeline | `/timeline` | Operational/case history and manual notes; authorized roles | Append-oriented timeline API | Search/filter, add note, inspect source | Most operational modules | Mostly Complete. Main load errors are clear; failures loading related-record selectors are silently treated as empty. |
| Assignments | `/assignments` | Operational work queue and ownership; coordinators, leaders and members | Assignment API | Create, assign, claim, reassign, start, escalate, complete, cancel | Session, briefing priorities, users/members, notifications | Mostly Complete. Dedicated My Work behavior is already present; multi-role presentation, static dictionaries and silent assignee failure need cleanup. |
| Rostering | `/rostering` | Shift planning, coverage and member duties; coordinators, leaders, members, observer | Rostering repository API | Create/update/publish, assign, confirm, decline, cancel, complete | Session, groups, members, readiness, availability | Mostly Complete. Status transitions and own/all reads are covered, but no-session code silently falls back to a seeded session and group scope is not consistently applied. |
| Availability | `/rostering` | Record when a member can work; members and roster managers | Availability API | Create/update own or all records | Member linkage, roster planning | Mostly Complete. Own/all authority is explicit; group-scoped managerial visibility needs policy enforcement. |
| Members | `/members` | Operational profile directory; authorized people roles | Member directory API | Search/filter, create/edit/archive, view readiness and links | Groups, users, training, documents, roster | Mostly Complete. API is the data source and empty/error states are clear. Internal `Volunteer` naming remains a compatibility detail only. |
| Groups | `/groups` | Operational group membership, leadership and linked planning | Group repository API | Create/edit/archive, add/remove member, link roster/training | Session, members, training, readiness, rostering | Mostly Complete. Direct group scope is enforced. Cross-domain meaning of that scope is not. |
| Training | `/training` | Course catalogue, requirements and member completion history | Training repository API | Create/edit course, assign, start, complete, verify, waive, cancel, group requirement | Members, groups, readiness | Mostly Complete. Personal and manager views are useful; related lookup failures can be flattened to empty in some supporting loads. |
| Documents | `/documents` | Versioned operational documents and acknowledgements | Document repository API | Draft/publish/supersede versions, set requirement, acknowledge | Members, groups, readiness | Mostly Complete. Version and acknowledgement history exist; several related-resource load failures are silently converted to empty lists. |
| Readiness | `/readiness` | Explain readiness from missing requirements | Derived readiness service | Review own/group/all blockers and navigate to source | Training, documents, roster/member state | Mostly Complete. No authoritative percentage was found. Explanation is actionable; group scope needs consistent server policy. |
| Exercise control | `/exercise` | Manage injects and observations; coordinators | Exercise API | Create/release/complete inject, add observation | Session, dictionaries, audit | Partial. Inject lifecycle is explicit. Observations can be created but not progressed, resolved or closed in the UI. |
| Audit | `/audit` | Governance review; System Admin and authorized coordinators | Append-oriented audit API | Search/filter and inspect structured detail/source | All mutating workflows | Mostly Complete. Useful detail and retry states exist; current client-side full-history loading will not scale. |
| Reports/export | `/reports` | Authorized handover and export | Export/report API | Download CSV; unavailable PDF/AAR disabled | Session and operational data | Broken. Supported CSV controls return fixed, type-independent content while reporting success. |
| Files/import | `/files-import` | Upload and validate manifest/support data | File and import API | Upload, validate, confirm | Session, Passenger/SRC, audit | Placeholder. The visible primary import call always returns 501 in the local backend. |
| Contextual help | Dashboard and page introductions | Orient a stressed, non-technical user | UI copy and route guidance | Start-here steps, acronym guide, next-action page descriptions | Navigation and roles | Partial. Dashboard onboarding is strong; dense matching, release and administration workflows lack contextual escalation/contact guidance. |

Unused or legacy surfaces found during source review:

- `CasesPage.tsx` and `PortalDashboardPage.tsx` are not routed by `App.tsx`; classify for dedicated cleanup after confirming no external import.
- `/volunteers` is a compatibility redirect to `/members`; retain until saved links and tests are migrated.
- `DemoUser`, `mock-auth`, `VolunteersPage` and `volunteerId` are internal compatibility names. They are not currently user-facing and should be renamed only in a dedicated cleanup stage.

## 3. Role coverage matrix

Legend: `G` global workflow, `S` group-scoped intent, `O` own/personal workflow, `R` read-only, `-` unavailable. An asterisk marks a confirmed policy or presentation gap.

| Workflow | System Admin | ZPP Coord. | ZPP Group Leader | ZPP Member | TEC Coord. | TEC Group Leader | TEC Member | Observer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Dashboard | R* | G | S* | O* | G | S* | O* | R* |
| Sessions/context | G | G | R | R | G | R | R | R |
| Active Event/briefing | - | G | R/S | R | G | R/S | R | R |
| TEC intake | - | G | S* | - | G | S* | O/G by permission | - |
| Family/NOK | - | G | S* | - | G | S* | allowed by role | - |
| Passenger/SRC | - | G | S* | - | G | - | - | - |
| Matching/holds | - | G | S* | - | G | - | - | - |
| Release | - | G | S* | - | - | - | - | - |
| Requests/timeline | - | G | S* | - | G | S* | allowed by role | - |
| Members/groups | - | G | S | O/R | G | S | - | - |
| Rostering/availability | - | G | S* | O | G | S* | O | R |
| Assignments | - | G | S* | O | G | S* | O | - |
| Training/documents | - | G | S* | O | G | S* | O | R |
| Readiness | - | G | S* | O | G | S* | O | R summary |
| Import/reports | reports | G | G | - | G | reports | - | reports |
| Exercise control | - | G | - | - | G | - | - | - |
| Users/access/audit | G | audit | audit | - | - | - | - | - |

### Role walkthrough conclusions

#### System Admin

- Landing and admin navigation are understandable and appropriately separate account administration from operational roles.
- The role does not implicitly receive operational mutation permissions, which is correct.
- Critical mismatch: the Dashboard still exposes detailed operational attention records despite direct source endpoints returning 403.
- Secondary issue: some destructive/revocation actions use native browser confirms and do not provide the same reason/error experience as dedicated lifecycle dialogs.

#### ZPP Coordinator

- Best-covered operational role. It can establish session context, publish briefing, manage case workflows, assignments, people, readiness and exercise controls.
- The Dashboard and Active Event answer much of "what needs attention now," but availability, assignment ownership and recent change summaries are distributed across destination modules rather than fully synthesized.
- Import/export truthfulness prevents a complete handover/data-exchange exercise.

#### ZPP Group Leader

- Navigation communicates broad group-operational responsibility.
- Groups themselves are correctly scoped, but case, matching and roster reads are session-wide under the same GROUP-scoped role. The user cannot reliably distinguish group responsibility from global visibility.
- This is a server authorization defect, not a frontend filtering task.

#### ZPP Member

- Dashboard Start Here, Assignments, personal roster/availability, Training, Documents and Readiness provide a coherent personal workflow.
- Own work is discoverable, and mutation controls are mostly permission-driven.
- The Dashboard shows coordinator-oriented attention details and destinations the member cannot open. Own Member Profile and leader/contact context are not directly reachable from Settings.

#### TEC Coordinator

- TEC intake and related family/passenger/matching/request workflows are broadly discoverable.
- Release authority is correctly absent.
- Some language and Dashboard sections remain general ZPP operational summaries rather than a focused TEC call-intake/coverage view.

#### TEC Group Leader

- The role has a useful combination of intake, family, requests, people, roster and assignment views.
- GROUP scope is only reliably enforced in Groups. Roster and permitted case data are broader than the assigned TEC group.
- Matching is forbidden but unresolved matching details are still visible on Dashboard, producing a dead end.

#### TEC Member

- Intake, requests, timeline, own roster, assignments, training, documents and readiness are reachable.
- The role can identify work, but the difference between TEC personal work and broader intake queues should be made explicit after scope policy is fixed.
- Dashboard attention data can exceed source access.

#### Observer

- No mutation controls were found in the permitted workflows, and the role has useful session, briefing, roster, training/document/readiness summaries and reports navigation.
- The role receives sensitive Dashboard attention details despite direct endpoint denial. This violates the intended high-level read-only posture.
- Reports currently add no trustworthy value because CSV output is fixed.

## 4. First-time and personal workflow assessment

### What works

- Invitation/account status transitions are explicit and auditable.
- First login lands on a role-adaptive Dashboard.
- Start Here provides ordered steps, plain-language descriptions and an acronym guide.
- Page headers generally state the next safe action.
- Forms retain server errors rather than converting failures into success.
- Members have a practical personal workflow across Assignments, Rostering/Availability, Training, Documents, Readiness and Notifications.
- REAL, EXERCISE and TRAINING remain operational session labels and are not mixed with storage architecture.

### Where a first-time user may still ask what to do

1. Settings does not provide a clear path to the linked Member Profile, group leader or operational contact.
2. A member sees coordinator-oriented Dashboard attention content that is neither personal nor accessible.
3. Assignments uses a useful queue, but multi-role users can receive member-oriented guidance based on role names rather than effective capabilities.
4. Group leaders cannot tell whether a session-wide record belongs to their group because the domain does not consistently model/enforce group ownership.
5. Matching and Release are dense, high-consequence workflows with limited embedded explanation of evidence thresholds and escalation ownership.
6. Import looks ready to use, then fails only after upload.
7. Reports look available and report success even though the generated CSV is not the requested data.

A separate My Work module is not justified now. The Assignments page already provides Assigned to me, claim, status transitions and personal filtering. The next improvement should be a reliable personal Dashboard destination and scope-aware counts, not a duplicate task surface.

## 5. End-to-end emergency session assessment

The current coherent path is:

1. A coordinator creates/selects a session and confirms REAL, EXERCISE or TRAINING mode.
2. Active Event establishes confirmed facts, unconfirmed information, priorities, risks and coordination notes.
3. A briefing draft is published and revision history remains readable.
4. TEC captures enquiries; authorized roles create Family/NOK and Passenger/SRC records.
5. Requests and Assignments establish actionable work and owners.
6. Matching links enquiry/family/passenger evidence; holds block release until explicit checks are complete.
7. Rostering and Availability establish coverage; Training, Documents and Readiness explain eligibility gaps.
8. Notifications surface selected entity-derived changes; Timeline and Audit record history.
9. Session closure makes operational data read-only and reconciles active context.

### Missing or weak bridges

- Dashboard aggregation bypasses source authorization instead of composing authorized summaries.
- GROUP-scoped responsibility is not carried through case, assignment, roster, training/document/readiness and notification domains consistently.
- Briefing priorities can link to Assignments, but the system does not consistently make ownership and completion visible back in every source context.
- Import cannot seed a realistic manifest workflow.
- Export cannot produce a trustworthy handover package.
- Exercise observations have no visible resolution lifecycle.
- Session closure is technically guarded, but closure communications and unresolved-work summary deserve an explicit exercise test.
- Notification source coverage is useful but should be reevaluated only after authorization and scope are corrected.

## 6. Search, failure, empty-state and accessibility assessment

### Search and scale

| Data volume | Current assessment | Recommendation |
| --- | --- | --- |
| 500 Members | Acceptable locally with existing filters/pagination, but related selectors often request only 200 | Move all management selectors to paginated/server-search before database cutover |
| 100 Groups | Acceptable locally | Preserve server filters; avoid loading all groups into every drawer |
| 1,000 Assignments | Borderline | Add server pagination and stable sort before realistic scale testing |
| 10,000 operational records | Not acceptable | `listAll` has a 5,000 record cap and Matching/Release/Cases compose multiple whole-resource loads |
| Many historical sessions | Borderline | Add server-side session paging/filtering during persistence work |
| Large audit history | Not acceptable | Audit currently loads full history and paginates in the client |

Virtualization is not required before server pagination. First correct the query contracts and stable paging, then profile rendering.

### Error and empty states

- Main list failures generally show actionable errors and Retry.
- Smoke coverage verifies failed writes do not become apparent success and important drawers remain usable.
- 400/403/404/409 workflows are represented in API tests; authentication failure is handled separately from ordinary data failure.
- Several supporting lookups silently convert failure to empty data: assignment assignees, timeline related records, and document requirements/acknowledgements/member/group lookups. This can mislabel an unavailable dependency as "nothing exists."
- Major empty states usually distinguish no records from no filter matches. Shared generic tables still default to `No records to show`, which is acceptable for secondary tables but should not replace domain-specific states.
- Import and export are availability/truthfulness defects, not empty-state problems.

### Accessibility and responsive behavior

- Existing smoke coverage exercises keyboard interaction, dialog/drawer focus behavior, validation summary, dirty-close protection, duplicate-submit protection and a 390x844 viewport.
- Status is generally communicated with text/badges rather than color alone.
- Focus states are visible and use shared controls in most current workflows.
- No formal WCAG claim is made.
- Residual hardcoded light-theme classes remain in Timeline, Audit, Files, Release, Matching, Assignments, Cases and History detail surfaces. They can reduce dark-mode contrast and should be addressed in a bounded UI cleanup.
- Wide operational tables rely on horizontal scrolling. This is acceptable for desktop operations, but mobile use is review-oriented rather than efficient for dense management work.
- Native browser confirmation dialogs in Admin do not match the accessible reason/error pattern used by dedicated application dialogs.

## 7. Terminology and dead-code assessment

### User-facing terminology

- Navigation uses People, Members, Users & Access and Groups consistently.
- Canonical role labels are used in access administration.
- No visible `demo`, `in-memory`, reset, mock or database-connection notice was found.
- The two trivial technical labels found during the audit were corrected: `in database` became `records loaded`, and `Database created time` became `Record created time`.
- Session mode labels REAL, EXERCISE and TRAINING remain visible and correctly separate from implementation details.

### Internal compatibility and cleanup candidates

| Item | Classification | Reason |
| --- | --- | --- |
| `/volunteers` redirect | Compatibility layer required | Protects old links while canonical navigation uses `/members` |
| `VolunteersPage`, `DemoUser`, `mock-auth`, `volunteerId` | Dedicated cleanup stage | Internal only; broad rename has avoidable regression risk |
| `CasesPage.tsx`, `PortalDashboardPage.tsx` | Uncertain, verify then remove | No route in current `App.tsx` |
| Assignment static status/priority/function fallbacks | Remove in dedicated cleanup | Can diverge from API dictionaries |
| Process-local auth/storage implementation labels in API health/payload | Dedicated hardening | Internal metadata is not needed by normal clients |
| Native `window.confirm` in Admin | Replace in UX hardening | Existing shared confirmation/dialog patterns are safer and more consistent |

## 8. Complete gap register

| ID | Module / roles | Scenario | Current behavior | Expected behavior | Impact | Priority | Effort | Dependency | Recommended stage |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G-001 | Dashboard; all roles, especially System Admin, Members, Observer | A role opens Dashboard without source-module permissions | `/dashboard` returns detailed request, family, enquiry and matching records; UI renders sensitive content and links that later return 403 | API must produce permission-filtered/redacted aggregates and only destinations the actor may open | Confirmed privacy/authorization breach and dead-end navigation | P0 | M | Authorization policy and dashboard contract | 3G1 |
| G-002 | Cross-domain GROUP scope; ZPP/TEC Group Leaders | Group-scoped leader reads operational data | Groups are scoped, while permitted family/case/roster and other reads can be session-wide | Define ownership for each domain and enforce GROUP scope server-side for reads and writes; test negative cross-group access | Confirmed security mismatch; unclear responsibility boundary | P0 | L | Scope policy, entity ownership mapping | 3G1 |
| G-003 | Reports/export; coordinators, leaders, Observer | User downloads an available CSV | Every supported CSV type returns the same fixed four-line summary and reports success | Generate truthful type/session-filtered CSV or mark the control unavailable | False operational output can corrupt handover and exercise decisions | P0 | M | Export contract and session scoping | 3G1 |
| G-004 | Reports API; report readers | Session summary is requested | Holds and urgent requests are returned from full arrays rather than explicitly filtered session collections | Filter every detail collection by active/requested session and actor authorization | Cross-session disclosure risk when more sessions exist | P0 | S | G-001 authorization rules | 3G1 |
| G-005 | Files/Import; ZPP/TEC coordinators and ZPP Group Leader | User attempts manifest/support-file intake | Visible upload/validate action always returns 501 | Disable unavailable control with truthful product copy or implement a real process-local validation/import path | Blocks realistic manifest-based exercise preparation | P1 | M | Import schemas and validation policy | 3G1 |
| G-006 | Rostering; all roster roles | No writable active session is selected | Frontend silently substitutes `ses-demo-1` while the page also shows a no-session warning | Do not query or mutate against a hidden session; show explicit read-only/no-session state | Session-integrity ambiguity and possible writes to wrong context | P1 | XS | Session context | 3G1 |
| G-007 | Session closure; coordinators and all active workers | Session closes with unresolved work | Writes become guarded/read-only, but no consolidated closure summary confirms remaining assignments, notifications and handover state | Provide a closure review/checklist or explicit unresolved-work summary before/after close | Users may not know what remains active or transferred | P1 | M | Assignments, notifications, briefing | 3G2 |
| G-008 | Assignment/briefing linkage; coordinators and assignees | Priority becomes work and work completes | Priority-to-assignment linkage exists, but completion/ownership is not consistently visible in every source context | Surface linked owner/status bidirectionally without duplicating task state | Handover and ownership can require cross-module searching | P1 | M | Briefing and assignment query contract | 3G2 |
| G-009 | Assignments/Dashboard; multi-role users | User holds member and coordinator/admin roles | Some presentation choices use role names and first matching role rather than effective capabilities | Determine landing guidance and management UI from effective permission/scope context | Misleading personal/restricted presentation; API remains authoritative | P2 | S | Role UX policy | 3G2 |
| G-010 | Assignments; all assignment users | Dictionary API is empty or unavailable | Static status, priority and function arrays are used; assignee failure becomes empty list | Use API dictionaries only and show partial-load errors without disabling unrelated reading | Hidden divergence and false empty-state risk | P2 | S | Dictionary/error-state pattern | 3G2 |
| G-011 | Timeline/Documents and related selectors; authorized users | Supporting API request fails | Some catches return empty arrays | Distinguish unavailable dependency from a valid empty result and offer Retry where actionable | User may make decisions from incomplete context | P2 | S | Shared partial-error UI | 3G2 |
| G-012 | Settings/Member profile; Members and leaders | First-time member wants own profile, group or contact | Settings shows identity/access but no direct profile/leader/contact destination | Add a clear personal profile/group/contact route when linkage exists | Orientation and support discovery gap | P2 | S | Member linkage and scope-safe contact fields | 3G2 |
| G-013 | Exercise observations; coordinators | Observation needs ownership and closure | Observation can be added but has no visible update/resolve/close lifecycle | Add explicit, audited observation status actions | Exercise follow-up cannot be completed in product | P2 | M | Exercise workflow contract | 3G2 |
| G-014 | Notifications; all roles | Entity changes are resolved or inaccessible | Derived notifications are generally useful, but authorization relevance has not been proven after scope changes | Recompute/filter by source access, resolve stale items and retain useful destination | Noise or disclosure can remain after G-001/G-002 | P2 | M | G-001 and G-002 | 3G2 |
| G-015 | Scale; coordinators/admin/auditors | Large local or future persistent dataset | Several modules load whole resources; client cap is 5,000; some selectors cap at 200 | Server-side stable pagination/search and explicit total handling | Slow or incomplete lists at realistic data volume | P2 | L | API pagination contracts; best aligned with DB cutover | 3G3 / 4A |
| G-016 | Admin UX; System Admin | Revoke role/override/link or archive custom role | Native browser confirm is used | Shared confirmation dialog with clear target, consequence, error and optional reason | Inconsistent accessibility and weaker operational assurance | P2 | S | Shared dialog component | 3G3 |
| G-017 | Help and escalation; Members, TEC, leaders | User is unsure in a high-consequence workflow | Page instructions exist, but Matching/Release/Admin lack contextual escalation/contact guidance | Provide concise workflow-specific help and owner/escalation destination | Productivity and decision-confidence gap | P2 | S | Operational content owner | 3G3 |
| G-018 | Local persistence; all roles | API process restarts | Mutations and read state return to deterministic seed state | Durable repository adapter, migrations, backup and recovery before production | Production durability blocker; not a local functional blocker | P2 | L | Stage 4A persistence | 4A |
| G-019 | Authentication/invitations; all users/admin | Production sign-in, email invitation or revocation is required | Development access and process-local sessions are used; real delivery/identity is absent | Integrate approved identity providers, password/email policy if retained, durable sessions and revocation | Production security and onboarding blocker; not a local functional blocker | P2 | L | Identity/security architecture | 4B |
| G-020 | Dark mode/theme; several dense modules | User opens history, audit, import, matching, release or assignment detail in dark mode | Residual hardcoded light-only surfaces remain | Replace only affected surfaces with semantic tokens | Contrast inconsistency; no logic impact | P3 | S | Existing theme tokens | 3G3 |
| G-021 | UI terminology | User sees operational metric/history labels | Technical `database` wording appeared in two labels | Use product language | Minor trust/readability issue; corrected in this audit | P3 | XS | None | Resolved in 3G |
| G-022 | Internal code naming | Maintainer works with canonical Member terminology | Legacy Demo/Volunteer/mock names remain internally | Rename only after contract/test impact is mapped | Maintenance cost only; not user-facing | P3 | M | Compatibility cleanup | 3G3 or later |
| G-023 | Health/dashboard internal metadata | Unnecessary implementation metadata is inspected | Health response and dashboard payload include development storage-mode fields not required by normal UI | Restrict or remove implementation metadata from normal client contracts | Low direct product impact; avoid accidental future exposure | P3 | XS | API contract check | 3G3 |

## 9. Recommended roadmap

### Stage 3G1 - Security and truthfulness containment

Do this before any realistic exercise:

1. Define Dashboard summary/redaction policy per permission and return no raw source records to unauthorized roles.
2. Define GROUP scope semantics for each domain, then enforce them server-side for read and mutation paths.
3. Add negative cross-role and cross-group API/browser tests.
4. Replace fixed CSV output with truthful process-local exports or disable each unsupported type.
5. Filter report details by session and authorization.
6. Remove the Rostering fallback session.
7. Make Import availability truthful; implement only the minimum import path required by the next exercise, otherwise disable it.

### Stage 3G2 - Exercise workflow completeness

1. Add session closure review and unresolved-work summary.
2. Complete bidirectional Briefing priority/Assignment status visibility.
3. Add an audited Exercise observation resolution lifecycle.
4. Add own profile/group/contact discovery for first-time members.
5. Remove role-name-based multi-role presentation decisions.
6. Surface partial related-resource failures and retest notification relevance.

### Stage 3G3 - Scale, accessibility and bounded cleanup

1. Introduce server pagination/search contracts for large operational lists and selectors.
2. Replace Admin native confirmations with shared dialogs.
3. Complete the semantic-token dark-mode pass in the named dense modules.
4. Add contextual help for Matching, Release and access administration.
5. Verify and remove unrouted pages, then plan internal legacy naming cleanup separately.

## 10. Database deferral assessment

### Safe to continue locally

- Session, briefing, record, matching/release, assignment, roster, training, document, readiness, notification and access lifecycle behavior can continue to be tested within one API process.
- Deterministic seed state is useful for repeatable automated and exploratory tests.
- Repository interfaces and server-side permission checks can be corrected before persistence work.
- Import/export truthfulness can be implemented against process-local repositories first if needed for exercise testing.

### Genuinely requires future persistence

- Durable users, invitations, sessions and session revocation.
- Durable audit and timeline history.
- Durable notification read/resolution state.
- Durable operational records, assignments, rosters, training, documents and acknowledgements.
- Transactional multi-entity operations, uniqueness guarantees and concurrency control.
- Backups, recovery, retention, legal/audit retention and production reporting.
- Large-scale query/pagination/index behavior.

### Postpone until persistence/identity stages

- Production deployment.
- Real Microsoft Entra or approved local-password authentication.
- Real email invitation delivery.
- Multi-process/high-availability operation.
- Claims about durable synchronization, backup or permanent retention.

No database, migration, external identity or delivery infrastructure should be introduced in Stage 3G1-3G3 unless the project explicitly starts Stage 4.

## 11. Go/no-go assessment

### Continued local functional testing: GO, with restrictions

The application has enough coherent workflows and automated coverage to continue local testing. Test accounts and seeded information must be treated as non-sensitive. Do not rely on Dashboard confidentiality, group scope, import or exports until Stage 3G1 is complete.

### Realistic end-to-end exercise simulation: NO-GO

The Dashboard disclosure, incomplete GROUP scope, misleading exports, unavailable import and hidden Rostering session fallback can materially distort permissions, preparation and handover. A limited scripted exercise that avoids sensitive data, import/export and group-boundary assertions is possible, but it is not a valid end-to-end readiness exercise.

### Production deployment: NO-GO

In addition to the Stage 3G1 security/data-integrity findings, production still lacks durable persistence, production authentication/session management, external identity, real invitation delivery, backup/recovery and production-scale query guarantees. Passing tests do not change this conclusion.

## 12. Audit limitations

- This was a product and code-path audit, not a formal penetration test, privacy impact assessment or WCAG certification.
- Seed data does not exercise every possible cross-group and cross-session combination; confirmed policy mismatches should be expanded into adversarial tests before implementation.
- Performance classifications are based on current query/render patterns and documented target volumes, not load-test measurements.
- External integrations and durable infrastructure were intentionally excluded.
