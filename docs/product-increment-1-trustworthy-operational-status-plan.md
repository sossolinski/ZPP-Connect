# Product Increment 1 — Trustworthy Operational Status & Actionable Ownership

Reference: [comprehensive audit](post-foundation-comprehensive-product-audit.md).
Accepted findings: AUD-01/02/03/04; bounded Dashboard contracts from AUD-28;
preview-only lineage maintenance AUD-34. This is PI1, not Foundation Stage 26.

## Contracts and behavior

- Dashboard specialist sections use a typed `available { value } | unavailable`
  union. Only available sections contain measured numbers, including actual zero.
  Specialist cards/charts/checks are omitted for unavailable sections; a short
  availability explanation replaces them. A failed Dashboard load is an HTTP error,
  never an available zero. Existing compatibility fields remain for other readers.
- Needs attention is a **scoped list of displayed permitted unresolved issues**,
  not an incident-wide total or unread notification count. Its summary says
  “N shown” and identifies scope/limits. Source queries require read plus the
  relevant action capability; urgent Support Requests are permitted risks for
  readers who can progress or initiate follow-up (TEC create). It includes own overdue/escalated assignments and
  outstanding personal document acknowledgements from authoritative records and
  existing compliance evaluation. Restricted/no applicable sources are unavailable;
  an available empty list says no items in the checked queues, never global clear.
- Support Request owners require an active account, active incident membership,
  and incident-effective `session:read` (application incident context), `request:read`, `request:update`, `request:close` (resolve
  uses close). Assignment/admin permission is not required of the owner. Reuse
  EffectiveAccess including denies, expiry, role/group scope; no automatic grants.
  Candidate discovery and serializable assignment transactions enforce the same rule.
- Active requests with ineligible owners or legacy owner labels expose
  `reassignmentRequired` and an owner eligibility state. Reads re-evaluate access;
  IDs, labels, versions and historical audit remain unchanged. Terminal ownership
  remains historical. No silent reassignment, privilege expansion or schema change.
- Published briefing retains absolute publication/expected update dates, adds
  textual relative age and “Update overdue” when now exceeds next-update time.
  Missing expected update says none scheduled. Age updates locally on a clock.
- Dashboard refresh is manual. Show last successful load/age, refreshing, refresh
  failure and stale prior data; a five-minute age threshold is explicitly labelled
  as time since load, not domain validity. Context switches clear old data; late
  responses cannot overwrite a new incident. Retry remains available; no real-time claim.
- Preview uses deterministic fictional current claim/passenger/enquiry lineage.
  Preserve immutable prior snapshots; correct mutable pending claims (terminal
  corrections create revisions) and generate
  current suggestions through the existing production algorithm. Assert principal
  claimant/passenger/suggestion consistency. Preview-only invocation stays guarded.

## Test matrix

| Boundary | Acceptance |
| --- | --- |
| Production PostgreSQL Dashboard | Coordinator full/actual zero; TEC urgent permitted work with unavailable specialist data; leader/member own obligations; observer unavailable; admin separation; failed load; absent incident |
| Production PostgreSQL ownership | Capable accepted; incapable member omitted/rejected via direct API; permission/membership/account revocation visible; legacy label qualified; history unchanged; no grants |
| Briefing clock | Future/past/missing next update, historical publication, semantic text, UTC-fixed comparisons |
| PostgreSQL browser | Six personas; scoped attention/availability; owner controls/revocation; briefing text; refresh/failure/stale/retry/context isolation |
| Preview | Guarded synthetic coherence assertion and usable local API/browser |
| Full gates | npm ci, generation, lint, unit, build, memory smoke, full fresh disposable PostgreSQL suite, PostgreSQL smoke, production audit, production PostgreSQL/Entra startup, diff check, remote CI |

## Exclusions and Definition of Done

No workspace/navigation redesign, PI2–4, new task/notification/role engine,
Training/Exercise/organisational Readiness, persistence migration, dependency sweep
or production-delivery changes. Technical readiness remains intact. Remaining
pilot concerns (Entra browser, logging, packaging/SPA, secrets/ingress, recovery,
monitoring, evidence policies) remain separate.

Done means all requested PI1 semantics and persona/ownership/freshness acceptance
pass, existing gates pass, preview is coherent/usable, outcome report is committed,
branch is pushed, PR/CI are reviewed. Do not merge without further authorization.

## Proposed commits

1. This plan (audit retained as the authoritative reference), separately committed.
2. Explicit Dashboard availability/attention and manual refresh.
3. Capability-aware owner discovery/transaction validation and owner qualification.
4. Published briefing age/overdue presentation.
5. Preview lineage correction and coherence assertion.
6. Focused PostgreSQL/browser acceptance and CI wiring.
7. Outcome report with exact gate results and remaining separate findings.

Baseline: origin/main `2d47bc0` plus accepted preview tooling cherry-pick `6cf3c99`;
no unrelated product-baseline documentation branch included.
