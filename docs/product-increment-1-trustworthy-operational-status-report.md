# Product Increment 1 — Trustworthy Operational Status & Actionable Ownership

Date: 9–10 October 2026. Branch: `agent/product-increment-1-operational-trust`.
Plan commit: `3a20ce9`. Baseline: merged Stage 25 `2d47bc0`, accepted guarded
preview tooling cherry-pick `6cf3c99`, and the authoritative audit reference.
The unrelated product-baseline documentation branch is not an ancestor.

## Implemented findings and contracts

AUD-01/02/03/04 are implemented. AUD-28 is addressed only at the touched Dashboard
boundary; AUD-34 is developer fixture maintenance. No Foundation Stage 26 exists.

### Dashboard availability and source trace

`DashboardDto.operationalStatus` is shared and explicitly typed. `specialist` and
`attention` each use `{ status: "available", value: ... } | { status: "unavailable" }`.
Unavailable has **no value**. Authorized zero remains a measured number inside an
available section. The browser rejects missing/malformed availability and incomplete
numeric sections instead of inventing defaults. Aggregate failure fails the whole
HTTP read; it cannot become an available zero or a partial success.

The PostgreSQL shared router still obtains specialist values from incident-scoped
PassengerRecord, MatchingRecord, FamilyRecord, Enquiry, ReleaseAction/checks and
ImportBatch queries and the existing aggregate calculation. The existing seven
capability conjunction is preserved because these sections combine specialist
domains. Compatibility KPI/queue/status fields remain for existing consumers;
Dashboard reads the new contract. Effective incident permissions and existing
redaction remain authoritative.

Card decisions: unavailable Manifest/Processing/Matching cards are replaced by one
short “Specialist metrics — Not available for your role” explanation. Unavailable
coverage/matching charts and Data Quality checks are omitted. Needs attention is
qualified separately, never inferred from specialist availability. Authorized
Data Quality can still say clear after measured checks; a restricted role cannot.

### Needs attention

The contract is a scoped **list**, with “N shown”, checked source names and a
five-row limit per source; it is not an incident-wide workload total. Duplicate
matching records appearing in hold/review sources are merged by source identity.
Sources are current authoritative records:

- urgent unresolved Support Requests for request readers who can progress or
  initiate follow-up (TEC can create support follow-up but cannot fulfill ownership);
- hold/review, relationship verification and unlinked enquiry issues only when
  their relevant read and action permissions are effective;
- own overdue/escalated nonterminal assignments when readable/actionable;
- outstanding personal document acknowledgements from the existing compliance
  evaluator, including overdue text. These document obligations apply across incidents.

Unread/read notifications are never queried or counted. Available empty attention
says “No attention items in the checked queues”; unavailable says so explicitly.
Neither claims the whole incident is clear. Notifications remain delivery/read
state, Timeline remains chronology, and Requests/Assignments retain work authority.
Family and enquiry links use the record pages' supported operational-ID `focus`
parameter. Matching links select the linked relationship claim, including one
outside the initial queue page; records without a claim say “Open matching queue”.
Documents likewise use the honest “Open documents” action label. PostgreSQL browser
acceptance verifies the actual destination record/claim, not merely the URL.

### Actionable ownership

A suggested owner must have an Active account, active membership in the applicable
incident, and incident-effective `session:read`, `request:read`, `request:update`
and `request:close`. Session read is necessary to enter the application's incident
context; update permits progress/wait; close permits resolution. Assignment/admin
powers are not required. No new role or permission is introduced or granted.

Candidate discovery and the serializable assignment transaction use the same
EffectiveAccess rule, including denies, role/group scope, expiry and revocation.
Candidate and queue-owner read projections evaluate access graphs in fresh batches
instead of two additional queries per member. A PostgreSQL assertion verifies one
candidate graph batch and no per-user membership counts. Transactional write-side
validation remains independent of candidate discovery and read batching.
A stale/direct assignment to an unsuitable owner returns 409 with a clear workflow
eligibility explanation. Client controls refresh the candidate list, reset owner
selection and only submit a listed candidate. The Dashboard request link opens
the existing request drawer through its `requestId` parameter.

Every queue/detail/mutation projection re-evaluates current owner suitability.
Active ineligible or legacy-labelled ownership exposes `reassignmentRequired` with
an explicit warning. Restore eligibility and the warning clears. Owner IDs/labels,
request status/version and prior audit/timeline remain unchanged by these reads.
Terminal ownership is marked historical. Unassign/reassign remain explicit commands;
there is no silent reassignment or privilege expansion. The queue introduces
“Support requests” copy without renaming persistence models or API resources.

### Briefing and data freshness

Published briefings retain absolute publication and next-update timestamps, add
relative publication age, and show textual “Update overdue” once the deadline is
past. Missing deadlines say “No next update scheduled”. A 15-second local clock
updates age/overdue text; it does not fetch new briefing content or change validity.
Old briefings remain readable. UTC-fixed policy tests avoid timezone assumptions.

Dashboard shows server snapshot load time, age and explicit manual Refresh. Five
minutes since load is labelled potentially stale; it is not a claim of domain
invalidity. Refreshing keeps the previous snapshot visible. Failed refresh warns
that prior data is being shown and offers Retry. Initial failure remains Dashboard
unavailable, with Retry; absent context remains No active session. Incident changes
clear prior data, and cancelled/late responses cannot replace a new incident's
snapshot. No WebSockets, auto-sync or real-time promise was added.

## Synthetic preview

Only the guarded preview supplement changes fixture lineage. Source and claim
corrections use existing versioned repositories; pending claims are mutable and
terminal corrections preserve prior claims as revisions. Current enquiry/family/
passenger/claim identities and LO999 flight agree. Current suggestions are generated
by the existing algorithm rather than fabricated scores/signals. Prior suggestion
signals, decisions and approved artifacts are not rewritten as current evidence.
Runtime assertions check principal identities, flight, suggestion claim/passenger
versions and absence of contradictory generated signals. Repeated preview seeding
passes. The intentionally unsuitable seeded support owner is retained and qualified
as requiring reassignment. All six personas were checked against the local preview;
TEC and briefing screenshots were visually inspected. All data remains synthetic.

## Gate prerequisites and regressions avoided

Two targeted lockfile patches were required by the current production audit:
compression 1.8.1 → 1.8.2 and proxy-addr 2.0.7 → 2.0.8, within existing ranges.
See the maintainers' [compression advisory](https://github.com/expressjs/compression/security/advisories/GHSA-vc2v-76pw-4v95)
and [proxy-addr advisory](https://github.com/jshttp/proxy-addr/security/advisories/GHSA-jqcg-44mw-7w3h).
No dependency upgrade sweep, runtime configuration or deployment changes were made.

The full gate exposed a pre-existing evidence replay defect: catching an artifact
unique violation and then reading inside that transaction could return 500 because
PostgreSQL had aborted it. Artifact insertion now uses `createMany(skipDuplicates)`;
existing immutable-byte verification and the service's serialization retries remain.
A deterministic duplicate/mismatched-content transaction regression and a local
100-round concurrent replay diagnostic cover this bounded gate repair. Evidence
workflow, retention, schema and UI are unchanged.

Existing smoke assertions were updated for the requested Support Request copy.
The AAR independence test now waits for initial operational context before capturing
its baseline. PI1 browser cases likewise await initial context before selecting
an incident, preserving the actual historical-selector acceptance rather than
racing initialization. No AAR product behavior changed.

## Validation

Final results are recorded below after the frozen-source rerun. Disposable integration,
browser and startup databases were separate from the marked running preview.
Browser suites run sequentially to avoid competing Vite caches. No destructive
test shares a database with an application/preview process.

| Gate | Result |
| --- | --- |
| npm ci / Prisma generation | Passed |
| lint / typecheck (including preview supplement) | Passed |
| Full existing unit command | 130 passed; PostgreSQL/dormant suites skipped by its established environment |
| Full current PostgreSQL command, fresh database | 284 passed / 24 files; zero skipped |
| Dedicated PI1 and evidence PostgreSQL | 28 passed (13 PI1 + 15 evidence); 100 concurrent replay rounds passed |
| Full Playwright smoke | 62 passed |
| PI1 + established PostgreSQL Playwright workflows | 31 passed (15 PI1 + 16 existing workflows) |
| Production dependency audit | 0 vulnerabilities |
| Production PostgreSQL/Entra startup | Passed: health/readiness, SSO-only config, development route 404, anonymous Dashboard 401 |
| Preview seed/coherence and six-persona browser inspection | Passed |
| git diff --check | Passed |

Remote CI is the PR's live check record for this branch. The final handoff records
its result for the exact pushed head. This report is not evidence of a real Entra
browser login, a deployed production artifact, or an off-host restore.
Both automated review findings were corrected: supported record focus parameters
and batched owner eligibility. Matching claim focus received equivalent bounded
link support. The first remote PostgreSQL jobs hit Docker Hub pull quota/timeout
before tests; rerunning the failed jobs passed without an image or deployment change.

## Definition of Done and remaining findings

PI1 behavior, persona restrictions, true-zero/unavailable separation, owner suitability,
revocation qualification, preserved history, semantic briefing freshness and truthful
load/error states are covered. The final local validation table is green. Remote CI remains the
head-specific handoff gate recorded in the final response. No Prisma migration, role expansion, Training, Exercise or
organisational Readiness was added. Technical `/api/health/readiness` remains intact.

AUD-05–26 and the remaining scoped technical/policy findings remain future work.
Separate production-pilot blockers remain: Entra browser lifecycle, query-log
redaction, deployment packaging/SPA serving, secrets/ingress, native backup execution,
off-host recovery, monitoring, evidence sharing/retention/scanning policy and approved
recovery objectives. Dev dependency maintenance and preview exposure AUD-35 remain
separate. Passing PI1 does not close those pilot gates.

**PI2 has not started. PI3/PI4 have not started. The PR must not be merged without
explicit further authorization.**
