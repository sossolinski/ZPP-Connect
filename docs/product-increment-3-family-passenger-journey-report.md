# Product Increment 3 — Continuous Family & Passenger Support Journey

10 October 2026. Branch `agent/product-increment-3-family-passenger-journey`.
Separate authoritative plan commit `aa44c78` remains unchanged.

## Recovery and baseline

PI2 PR #25 was merged through normal GitHub protections as
`0c00b97a4d7fde04d22674cd36144c9b47a186e7`; final PI2 commit `3c3123e`
was verified as an ancestor. PI3 began from that merged main baseline.

The interrupted work was recovered on the same branch at
`aa44c7842e176ec43e09fce1e2845639362d5d33`. The index was empty; the
implementation/tests were uncommitted. Status, ten-commit log, full working/index
diffs, stash list, HEAD and origin/main were inspected before further edits.
Only the expected PI3 files were modified. The recovered implementation was
committed logically as `3da01a9` (authorized context), `0cb05e8` (specialist workflow
navigation), and `7b20b1a` (journey regression tests/CI), followed by this report. No branch switch, reset, restore,
clean, rebase or discarded work occurred. The existing plan was reread and retained.
Stage 12 stash `2619b110290391049bd6741aab7d774dcee78a85` remains untouched.

## Authorized support context

A typed `SupportJourney` read composition joins the existing source workflows for
an exact selected enquiry, family contact, passenger, current relationship claim
or release. The PostgreSQL endpoint `/api/support-journey` validates incident,
entity and UUID, requires incident access/root permission, and resolves incident
EffectiveAccess again. Each section independently requires its source permission.

Sections contain named source references/links, recorded association basis,
reported facts, distinct relationship/source/matching/release states, related open
Support Requests and recent source Timeline actions. Each displayed source has a
six-item limit and a truthful scoped total. Expected next function is separate
from a recorded assignee. Actual request owner eligibility is reused; missing
ownership explicitly needs assignment. A reported officer string is not an owner.
Timeline text is sanitized, source-authorized and actor/time attributed; immutable
verification/decision/check histories remain in their existing specialist screens.

The browser validates the response at runtime, including availability, timestamp,
list shape/counts, integer limits and local source links. Denied sources are
`unavailable`, never measured zero. A failed authoritative read fails the context
and offers Retry. Loading/empty/restricted/stale/completed states remain distinct.
The memory adapter explicitly reports contextual unavailability; PostgreSQL is the
acceptance authority. No persistence, generic Case model or command was added to
this read endpoint.

## Enquiry and reviewed family-contact copy

TEC creates an enquiry through the existing command, sees the saved context, opens
that exact record and sends it to family assistance. Handover remains an explicit
status event. It does not create a contact, assign a person or verify a relationship.

An authorized coordinator opens the exact enquiry and chooses **Copy reported
enquiry to new contact**. The source is reread by the existing server-authorized
Enquiry GET. Contact/location/language/channel, reported relationship/passenger
facts and notes are editable draft values. Only a stored passenger foreign key is
carried. The original caller name is shown for review; no surname is guessed from
free text. Saving calls existing Family creation and creates an unverified current
RelationshipClaim. Existing contacts/claims are never silently overwritten.

There is no Enquiry-to-Family foreign key. The explicitly copied existing case
reference, or enquiry operational reference, supports a **Shared reference**
association, labelled as neither identity nor relationship proof. Actual source
foreign keys/legacy stored relationships are labelled **Recorded link**. Names,
phone, email, flight and similarity never create a relational identity. The former
passenger-picker inference from similar names/case references was removed.

## Relationship and passenger/source workflow

Family context shows reported relationship separately from verification and links
to the current passenger/source record when permitted. Human verification uses the
existing basis/version/claim command. Correct/reject/reopen workflows and history
remain intact. Linking a passenger does not verify the relationship.

Passenger/source context preserves manifest/source facts, separate SRC confirmation,
condition and hold controls. Source confirmation is explicitly described as distinct
from relationship verification. Source correction remains a controlled reasoned
command; source/version changes propagate effective stale status without rewriting
historical human decisions.

## Matching and release/reunification

Matching opens the exact authorized current claim independently of queue filters.
The primary suggestion label is **System suggested — human review required**;
score, algorithm and generation metadata are secondary expandable evidence.
Version-mismatched suggestions say **Stale suggestion — regenerate**, and their
confirmation control is disabled. A manual human decision remains explicit.
Recorded human confirmation and its effective validity are separately visible.

Release supports exact `claimId` prerequisites/candidates and exact `releaseId`
context. Candidate and queue reads use a validated optional relationship-claim
filter in both repository adapters. Existing authoritative matching/release
repositories determine currentness and preconditions. A suggestion, passenger link
or human match cannot bypass relationship verification. Preparation is not
identity checking, hold review, authorization or completion; all remain distinct
existing commands with basis, version and operation identity.

Blockers explain the missing prerequisite and expected authorized function. Links
resolve relationship verification to the exact family, matching/current inputs to
the current claim, passenger holds to the exact source record, and independent
checks to the exact release. An historical release whose claim was superseded
resolves new matching review to the replacement current claim while retaining its
historical release/decision. Existing-release detection uses an authoritative query,
not absence from a six-row display slice. Completed/cancelled outcomes remain
historical outcomes and do not imply a new authorization.

## Deep links, return context and async safety

| Route | Implemented and browser-verified contract |
| --- | --- |
| `/tec-intake?focus=` | Exact authorized enquiry outside the displayed queue |
| `/family-nok?focus=` | Exact contact/current claim/history outside filtered pagination |
| `/family-nok?fromEnquiry=` | Authorized reviewed new-contact draft |
| `/passenger-src?focus=` | Exact passenger/source controls |
| `/matching?claimId=` | Exact current claim, suggestions/human decisions |
| `/release-control?claimId=` | Exact claim prerequisites and candidates |
| `/release-control?releaseId=` | Exact existing release/current blockers |

Queue search, filters, sorting, pagination/offset and selection live in bounded URL
state. Related links add a validated local `returnTo`. Route/parameter allowlists,
2,000-character return targets, 200-character values and bounded numeric state
reject external/unsupported/nested return destinations. Return chains do not grow.
Related filter/page updates use one router navigation, avoiding lost URL updates.

Matching/Release selected contexts require the current entity and incident. Queue,
candidate and context reads use request sequence/scope guards. Records reject late
reads after another record, a closed drawer or incident change; displayed record
and passenger-picker data also require the current incident. SupportJourney clears
on selection/incident/revision changes, cancels obsolete reads and renders only its
current loaded scope. Delayed successful-response browser regressions cover
Records, Matching, Release and the contextual panel. No stale response can silently
replace the newly selected context.

## Permissions and retained safety boundaries

| Actor/boundary | Verified result |
| --- | --- |
| Coordinator | Authorized complete multi-role journey and existing human commands |
| TEC | Enquiry/handover and permitted family state; no family-copy/create, protected passenger/matching/release sources remain unavailable |
| Observer/member | Specialist context denied server-side |
| Admin-only | System administration does not grant specialist context |
| DENY override | Denied passenger source facts/links unavailable, not false empty |
| Other incident/missing incident | Record isolation/required context enforced before composition |
| Failed source read | Failure/Retry, unchanged domain records |

Reported facts ≠ verified relationship; source confirmed ≠ relationship verified;
system suggested ≠ human confirmed; human confirmed ≠ release authorized;
authorized ≠ completed. Holds, stale versions, independent checks and explicit
human decisions remain authoritative. No role expansion or automatic sensitive
decision was introduced. PI1 attention/truth/freshness and PI2 Incident Workspace,
briefing/handover/ownership behavior remain intact.

## Validation

Final frozen-source results are recorded below. Databases are
newly migrated/seeded disposable `zpp_connect_pi3_test_20261010` and
`zpp_connect_pi3_browser_20261010`, separate from the persistent marked preview.
Preview servers are stopped during automated browser gates. Browser runtime
discovery returned no available browser, so the repository Playwright harness
performed the before/after preview inspection. Final preview remains running at
`http://localhost:5173`; only reads/login were used for its final verification.
CI defaults remain;
the comprehensive multi-role command journey has a specific 90-second budget.

| Gate | Final result |
| --- | --- |
| npm ci / Prisma generation | Passed |
| lint/typecheck / build | Passed |
| Full unit command | 138 passed; 373 established integration/dormant cases environment-skipped |
| Fresh full PostgreSQL suite | 321 passed / 26 files, zero skipped |
| Fresh dedicated PI3 PostgreSQL + contract/navigation | 18 PostgreSQL + 4 policy cases passed (22 total) |
| Dedicated PI3 PostgreSQL browser | 19 passed |
| General Playwright | 62 passed |
| PI1/PI2/PI3 + retained PostgreSQL browser workflows | 65 passed: 15 PI1 + 15 PI2 + 19 PI3 + 16 retained |
| Production audit (`--omit=dev --omit=optional`) | 0 vulnerabilities |
| Production PostgreSQL/Entra startup | Passed: health/readiness, SSO-only config, dev route 404, anonymous Dashboard 401 |
| Four widths / keyboard / visual review | Passed: 1440/1280/1024/768px; twelve context screenshots, no document-level overflow; keyboard record/link/return and retained dialogs |
| Six-persona preview | All six passed; five specialist screens and PI2 Workspace intact; no reset/destructive acceptance against preview |
| git diff --check | Passed |

## Findings corrected during recovery/review

- Release claim-panel JSX accessed a context already narrowed to null; removed the
  meaningless version prop and restored clean typechecking.
- Separate router setters could lose search/filter or page changes; combined them
  atomically and added Matching/Release filtered-return browser coverage.
- Late queue/candidate/record results needed the same protection as selected
  contexts; added request/scope guards and delayed-response regressions.
- A known-passenger selection put enquiry-only `passengerRoute` into Family
  creation; kept it only on Enquiry and verified the full reviewed-copy UI save.
- A late exact-record read could reopen a drawer after handover; invalidated it on
  close and hid the saved context while an editor is open.
- Historical release traversal missed a replacement current claim after correction;
  added current-claim discovery and a PostgreSQL history/resolving-link regression.
- A bounded release slice could falsely imply no existing action; existence is now
  checked independently of display limits.
- Compact matching context now explicitly reports stale suggestion inputs; runtime
  validation also rejects noninteger/nonfinite limits.
- Browser fixtures/selectors were corrected for actual labels, source versions,
  authorized field shape and response ordering. Invariants, services and retained
  tests were not weakened. Full regression initially found two obsolete/ambiguous
  labels; final rerun results are recorded above. An existing memory release test
  reported one socket hang-up; its isolated eight-test run and subsequent full unit
  rerun passed without changing its service or tests.

## Schema decision, limits and remaining pilot work

No schema or migration was added. Existing relationships and explicit shared
reference/copy semantics are sufficient for this bounded workflow. A future exact
Enquiry-to-Family provenance relationship would require separate justification;
shared references may associate multiple contacts and never identify a person.

Displayed source slices are bounded; underlying association discovery can still
traverse multiple related rows. This is not a demonstrated pilot-volume/performance
guarantee. AUD-29 volume/query work, operational-user validation, remaining
record/report/evidence presentation and richer published-briefing change history
remain separate audit refinements. Request ownership is only real recorded support
work; free-text officer/case labels and unlinked tasks are not guessed into owners.

Production dependency audit is the requested runtime scope. npm ci reported 16
unfiltered advisories; the requested production audit reports zero. Development/
optional-tool advisories remain separate dependency maintenance debt; no dependency upgrade was
folded into PI3. Separate production-pilot blockers remain real Entra browser
lifecycle, query-log redaction, deployable packaging/SPA deep-link serving,
secrets/ingress/abuse controls, operational backups/off-host restore/monitoring,
evidence sharing/retention/scanning policies and agreed recovery objectives.
Startup checks are not a production deployment or real Entra browser login.

## Definition of Done and handoff

All 30 existing local Definition of Done conditions are satisfied. The original
conditions are retained below; no scope or acceptance requirement was redefined.

| # | Existing condition | Outcome |
| --- | --- | --- |
| 1 | enquiry → family → passenger → matching → release is understandable as one continuous journey | Passed |
| 2 | reported and verified information remain visibly distinct | Passed |
| 3 | system suggestions and human decisions remain visibly distinct | Passed |
| 4 | release remains controlled | Passed |
| 5 | blockers clearly explain missing prerequisites | Passed |
| 6 | authorized next-step links work | Passed |
| 7 | queue context is reasonably preserved | Passed |
| 8 | handover/ownership is clearer | Passed |
| 9 | duplicate entry is reduced where safe | Passed |
| 10 | historical corrections remain preserved | Passed |
| 11 | stale derived state is handled safely | Passed |
| 12 | permissions remain server-authoritative | Passed |
| 13 | TEC workflow passes | Passed |
| 14 | family-support workflow passes | Passed |
| 15 | passenger/source workflow passes | Passed |
| 16 | matching workflow passes | Passed |
| 17 | release workflow passes | Passed |
| 18 | negative/blocked journey passes | Passed |
| 19 | 768–1440px layouts remain usable | Passed |
| 20 | keyboard/accessibility behavior remains usable | Passed |
| 21 | no automatic sensitive decision was added | Passed |
| 22 | PI1/PI2 behavior remains intact | Passed |
| 23 | no schema migration unless separately justified and approved | Passed |
| 24 | full unit suite passes | Passed |
| 25 | full PostgreSQL suite passes | Passed |
| 26 | Playwright passes | Passed |
| 27 | production dependency audit remains green | Passed |
| 28 | production PostgreSQL/Entra startup passes | Passed |
| 29 | PI3 report is complete | Passed |
| 30 | PI4 has not started | Passed |

Exact-head push/PR CI and legitimate review handling are the remote handoff gate;
the resulting run links/status are recorded in the PR and final response after
this report commit. PI3 must remain unmerged without further authorization.

**PI4, Stage 26, Evidence/Reports/AAR redesign, Training, Exercise and organisational
Readiness have not started. No production-pilot deployment track was implemented.**
