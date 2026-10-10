# Product Increment 2 — Incident Workspace & Handover

10 October 2026. Baseline: PI1 merge `8e5bde2` on `origin/main`; `a75e04e`
is an ancestor. Branch: `agent/product-increment-2-incident-workspace`.
Historical Stage 12 stash `2619b110` remains untouched.

## Outcome and hierarchy

Evolve `/dashboard` into the operational home: incident identity → published
briefing/authority and freshness → attention and personal/team work → current
staffing and significant change → specialist reconciliation facts. A read-oriented
handover mode emphasizes the same current authority, unresolved work, coverage,
activity and next update; it creates no persisted handover or parallel dashboard.

## Role/content matrix

| Persona | Workspace content |
| --- | --- |
| Coordinator | Published briefing, permitted attention, own work, incident coordination work including unassigned, broad permitted staffing/activity, specialist subsection |
| TEC | Published briefing, permitted enquiry/family/support follow-up, own tasks/requests if readable, permitted staffing/activity; restricted metrics unavailable |
| Group leader | Briefing, personal obligations, open work owned by active members of incident-scoped groups, scoped current staffing; no forbidden support ownership |
| Member | Briefing, own work/documents and permitted staffing; no team coordination projection |
| Observer | Incident and published briefing, permitted staffing observation; no actionable work controls or implied empty restricted domains |
| Admin | Actual effective operational permissions decide content; system administration alone provides no operational domain visibility |

All projections are server-enforced using incident membership and EffectiveAccess,
including role/group scope and denies. Layout is not an authorization boundary.

## Sources and API

Extend the existing Dashboard response with a bounded typed workspace projection,
so one refresh obtains the composed operational snapshot. Preserve PI1 specialist
and attention contracts and existing compatibility fields. Reuse Session,
OperationalBriefing/priorities/risks, AssignmentTask, Request/owner suitability,
MemberProfile/GroupMembership/OperationalGroup, RosterShift and CaseTimelineEvent.
Notifications retain the existing shell indicator/inbox, separate from work;
personal document obligations continue through PI1's compliance evaluator.

Team task scope is derived from active group-member linked users; tasks have no
structured group ownership, so unassigned tasks are shown only in global
coordination scope. Do not infer group links from free text or add persistence.
Current staffing uses start <= snapshot time < end and published/confirmed state,
with explicit confirmed/awaiting confirmation/unfilled labels; draft, declined,
terminal, past and future rows do not represent current coverage. Limit each list
and show its scope/total rather than implying a complete global workload.

Timeline is a curated recent slice of existing significant operational events,
filtered by source read permission. Show human title/time/actor/summary and a
permitted source link; omit metadata, UUIDs, keys/hashes and unsupported technical
events. AuditLog remains separate. Full Timeline remains accessible.

## Navigation and handover

Keep routes/models/API names. Rename bounded navigation labels to Incident
Workspace, Operational Briefing, Incidents, Tasks and Support Requests. Strengthen
persistent incident context; keep full briefing authoring/history on `/active-event`.
Reuse PI1 record focus links; add small roster/timeline focus support if necessary.
Preserve educational help in collapsed contextual help below operational content.
Handover is a named read-oriented mode over the same authorized snapshot, with no
mutation controls and no separate saved summary or report domain.

## Availability, layout and accessibility

Available measured empty differs from unavailable by role. Required projection
failure fails the refresh: retain the prior snapshot, label failed/stale and offer
Retry; initial failure and no incident remain explicit. Preserve manual refresh,
server load time, five-minute stale indication and incident-change response guard.
No automatic real-time synchronization claims.

Compact responsive cards/lists at 1440, 1280, 1024 and 768px; no whole-page horizontal
scroll. Semantic headings, visible labels, keyboard-operable links/mode/help,
visible focus and text status. Specialist charts follow urgent work and are
role-scoped. Preserve detailed destinations and existing accessible drawers.

## Tests and Definition of Done

PostgreSQL production-composition tests cover six personas, admin-only role,
cross-group/incident isolation and denies, published versus draft briefing,
current staffing period/state boundaries, own/team/unassigned work, empty versus
unavailable, readable timeline without technical metadata, and failed refresh.
PostgreSQL Playwright proves coordinator/TEC/leader/member journeys through
workspace → briefing → underlying work → workspace; observer posture, overdue
briefing, empty work, no incident, stale/failure/retry, keyboard and all four widths.

DoD: each requested operational question has a truthful authorized projection or
explicit unavailable/empty state; handover follows a coherent reading path;
source workflows remain authoritative; no schema migration/role expansion/retired
product domains. Full existing unit, fresh PostgreSQL, general and PostgreSQL
Playwright, production dependency audit, production PostgreSQL/Entra startup,
preview and diff checks pass. Report complete, PR pushed, exact-head CI green and
legitimate reviews addressed; PI2 remains unmerged without further authorization.

## Exclusions and proposed commits

PI3/PI4, Stage 26, new tasks/notifications/briefings/persisted summaries, family or
passenger flow redesign, evidence/report/AAR redesign, production browser Entra,
deployment/Docker/logging/recovery/monitoring/policy work, migrations, Training,
Exercise, organisational Readiness, WebSockets/AI briefings/offline are excluded.

1. Separately commit this plan.
2. Add typed permission/scoped workspace read projection.
3. Evolve workspace/handover hierarchy and bounded navigation/deep links.
4. Add PostgreSQL persona and browser/responsive/keyboard acceptance.
5. Record outcome, run gates, push/open PR, address reviews and monitor CI.
