# Product Increment 2 — Incident Workspace & Handover

10 October 2026. Branch: `agent/product-increment-2-incident-workspace`.
Plan commit: `d9bede3`.

## Baseline and scope

PR #24 was merged with normal GitHub protections as `8e5bde2` on `origin/main`.
PI1 final commit `a75e04e` is an ancestor. The workspace began from that merged
baseline; no unrelated documentation branch is an ancestor. The preserved Stage 12
stash remains `2619b110290391049bd6741aab7d774dcee78a85`.

This implements the bounded workspace/handover findings AUD-05–10/13/14/15/25 and
focused responsive/keyboard improvements over PI1's corrected operational semantics.
It is not Stage 26. No schema/migration, new role, task engine, notification engine,
briefing model or persisted incident/handover summary was introduced.

## Workspace and handover

The existing `/dashboard` is now Incident Workspace. Reading order is incident
identity/status/location/flight and current roles → last successful load and
published briefing/age/next update → scoped attention and personal/team ownership
→ current staffing and significant activity → specialist reconciliation details.
An attention indicator is also visible in the context header. Lists remain compact
with named, keyboard-focusable scroll regions; their scope and displayed/available
counts remain explicit. No wide tables are used.

Read handover adds an explicit reading context and prioritizes team coordination
before personal work, using the same permitted records and snapshot. Stale or
failed snapshots are qualified before handover. No lifecycle commands, stored
handover, extra dashboard or automatic summary generation exist in this mode.
The operator continues work through the source record's existing workflow.

Getting-started help is collapsed below operational content. Its reading guidance,
notification/work distinction, approved-guidance link and TEC/NOK/PAX/SRC/FAM terms
remain available. Specialist family/passenger metrics are a collapsed subsection;
unavailable never becomes measured zero.

## Personas and server scope

| Persona | Behavior |
| --- | --- |
| Coordinator | Published authority, permitted attention, own work, broad incident coordination including unassigned tasks/requests, current authorized staffing and significant activity; specialist metrics available |
| TEC | Published authority, permitted urgent support/enquiry/family attention, readable own work and personal obligations; specialist data unavailable; follows urgent support to the existing request drawer |
| Group leader | Personal responsibilities, current group-member-owned open tasks, group/personal staffing and documents; forbidden Support Requests remain unavailable |
| Member | Published briefing, own tasks and document acknowledgements, personal staffing; no broad team coordination projection |
| Observer | Incident/published authority and authorized staffing observation; no work lifecycle controls, no personal/team work implied empty, no false specialist zero |
| Admin | Combined operational roles give the appropriate operational view; a separate admin-only fixture has incident identity but unavailable operational domains |

The production reader resolves incident-effective access again with scoped role
assignments and DENY overrides. Group scopes are restricted to active groups in
the selected incident. Team task owners derive from nonarchived linked member
profiles and current group membership. Actor incident access is required; assignee eligibility is checked
separately by the authoritative domain. Losing incident access therefore keeps
group-owned work visible with Reassignment required, rather than hiding the
blocker. Other groups and incidents are excluded. Tasks have no structured group ownership: unassigned tasks
are not guessed into a leader's team by free-text function labels. Global
coordination may see them; scoped leaders see their current member-owned work.
No privilege is inferred from frontend layout or system-admin alone.

## Briefing, work and freshness

Only the current Published OperationalBriefing is projected, with situation,
three priorities and up to three unresolved risks. Newer Draft content is absent.
A readable incident with no publication explicitly says no published briefing;
permission absence is unavailable. PI1 BriefingFreshness is reused for publication
age, absolute time, deadline and textual Update overdue. Full authoring/history
remain at `/active-event`.

My work and Team work read current nonterminal AssignmentTask and Request records;
show type, human item, priority, owner/unassigned, due date, state, overdue/escalated,
waiting/reassignment warning and source next action. Each source is limited to six
rows, with its own authorized total/scope. Existing task eligibility is reused;
Support Request eligibility continues to use PI1's effective ownership rule.
Readers never change status/version/history or grant permissions. Existing
Assignments/Requests remain authoritative; workspace links issue no commands.

PI1 attention is retained as the permitted list with a five-row source limit,
deduplication and personal document compliance obligations across incidents.
Notifications remain the shell indicator/inbox and delivery/read state; they are
not queried as work or duplicated into another inbox. Personal Documents links
continue to the existing acknowledgement workflow.

The same Dashboard refresh obtains operational status and workspace. Runtime
validation rejects missing/malformed workspace sections. Source failure fails the
read, keeps a previous snapshot with failed/stale text and Retry, or shows initial
unavailability. No incident is explicit. Five-minute age, successful load,
refreshing and incident-change/late-response protection remain. No auto-sync or
real-time claim was added.

## Staffing and significant activity

Current staffing uses `startAt <= snapshot time < endAt`, Published/Confirmed
states and active assigned member profiles, with EffectiveAccess roster group/own
scope. Draft, Declined, Cancelled, Completed, ended and future rows are excluded.
Confirmed coverage, Awaiting confirmation and Unfilled duty are distinct text
states. Empty current periods explicitly do not establish full coverage. Staffing
is an operational read, not an authorization editor. An own-roster reader with no
nonarchived linked profile receives unavailable staffing, consistent with the
source permission contract; it is not reported as measured empty.

Activity is a bounded recent curated slice of CaseTimelineEvent, gated by Timeline
and source read permissions. Task/roster source events also obey workspace scope.
Own-roster events remain visible with roster:read-own and a nonarchived linked
profile even without broad roster read. Chronological cursor pages continue until
six permitted entries or the actual end, so fifty newer private events cannot hide older permitted change.
Source visibility is checked in batches and actors resolved only for returned
entries. Only published briefing events and genuine session events use those
source links.
Human title/time/actor/short summary replace technical presentation; metadata is
not projected, and technical UUID/hash/storage references in text are removed.
AuditLog is not converted into Timeline. Full Timeline remains a separate page.

Existing request, family/enquiry and matching claim links from PI1 remain. Task
focus now resolves an authorized UUID outside the first queue page. Roster `shiftId`
opens the exact server-authorized shift in reading mode; Timeline `eventId` focuses
the existing entry drawer. No routing/model/API renames were required.

## Vocabulary, responsive and keyboard behavior

Bounded navigation now reads Incident Workspace, Operational Briefing, Incidents,
Tasks and Support Requests. Persistent context and incident selection controls use
Incident language. URLs and persistence/API model names remain unchanged; this is
not a full terminology rewrite or navigation reorganization.

Acceptance checks 1440, 1280, 1024 and 768px for document-level overflow and early
briefing visibility, with full-page screenshots. Visual review prompted bounded
scroll regions to eliminate the large blank gap beside long attention lists and
bring responsibility/staffing closer to the operational summary. Keyboard tests
activate handover/help, scroll attention, open a source record with Enter, close
its existing drawer and return. Semantic headings, visible labels/focus and textual
status remain. This is focused QA, not a full WCAG certification or timed research
with crisis-response operators.

## Validation

Final frozen-source results are recorded after the required gates. Integration and
browser databases are newly migrated/seeded disposable databases, separate from
`zpp_connect_preview`. Browser suites run sequentially; preview servers are stopped
during them to avoid shared Vite caches.

| Gate | Result |
| --- | --- |
| npm ci / Prisma generation | Passed |
| lint / typecheck / build | Passed |
| Full unit command | 134 passed; established PostgreSQL/dormant suites environment-skipped |
| Fresh full PostgreSQL command | 303 passed / 25 files, zero skipped |
| Dedicated PI2 production PostgreSQL | 19 passed |
| General Playwright | 62 passed |
| PI1/PI2 + retained PostgreSQL browser workflows | 46 passed (15 PI1 + 15 PI2 + 16 retained) |
| Production dependency audit | 0 vulnerabilities |
| Production PostgreSQL/Entra startup | Passed; health/readiness, SSO-only config, dev login route 404, anonymous Dashboard 401 |
| Four-width visual/overflow and keyboard journeys | Passed; final screenshots/preview visually inspected |
| Preview six-persona inspection | Passed; preview remains usable |
| git diff --check | Passed |

One initial existing unit case reported socket hang up; its isolated rerun and
subsequent full command passed without a production change. An attempted repeat of
the full PostgreSQL suite on its used disposable database failed its initial
notification-seed assertion; the final gate recreates/migrates/seeds a fresh database.
Both automated review findings were fixed and covered by production PostgreSQL
cases: own-roster activity for TEC, and permitted activity behind fifty newer
out-of-group events. One concurrent post-review full-suite run exceeded an
existing five-second release-integrity test limit; the sequential fresh rerun
passed all 303 tests without timeout changes.
Additional scope regressions keep blocked group-owned work visible after assignee
incident-access revocation and keep missing own-roster profiles unavailable.
During temporary host CPU contention, an intermediate local browser rerun used a
90-second CLI test budget; repository and CI time limits stayed unchanged. The
final browser gates use the standard repository limits.

Fixture setup was corrected to respect existing terminal/publication constraints
and actual group membership; those domain constraints were not weakened.

Remote CI is the exact-head PR handoff gate; final results and review handling are
recorded in the PR/final response, without claiming a real Entra browser login,
production deployment or off-host restore.

## Definition of Done and remaining work

All 30 local PI2 Definition of Done conditions are satisfied. Exact-head remote CI
and review handling remain the PR handoff gate, recorded in the final response. No migration,
new role, retired Training/Exercise/organisational Readiness surface, or separate
persistence was introduced. Technical `/api/health/readiness` remains intact.

Remaining audit refinements include the continuous family/passenger journey and
record/report presentation, volume/performance work, richer published-briefing
change history and operational-user validation of hierarchy/handover. No full
Timeline/Tasks/Documents/Reports redesign was attempted.

Separate production-pilot blockers remain Entra browser lifecycle, query-log
redaction, deployment packaging/SPA serving, secrets/ingress, backup execution,
off-host recovery/monitoring, evidence sharing/retention/scanning policy and agreed
recovery objectives. They are not PI2 work.

**PI3 and PI4 have not started. PI2 must not be merged without further authorization.**
