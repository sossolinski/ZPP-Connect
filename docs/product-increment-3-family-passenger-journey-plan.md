# Product Increment 3 — Continuous Family & Passenger Support Journey

10 October 2026. Branch `agent/product-increment-3-family-passenger-journey`,
from PI2 merge `0c00b97` on `origin/main`; `3c3123e` is an ancestor. Historical
Stage 12 stash `2619b110` remains untouched. PI4 and Stage 26 are excluded.

## 1. Current journey and live inspection

The marked PostgreSQL preview was inspected through the repository Playwright
harness because Browser discovery returned no available browser. Existing synthetic
records, drawers, claim queue/suggestions and empty release queue were inspected;
no destructive suite or sensitive decision was run against the preview.

| Step | Current screen and authority | Existing transition / limitation |
| --- | --- | --- |
| TEC intake | Enquiry: caller/contact, reported passenger/relationship, status/version | Dedicated send-to-family-assistance, urgent, duplicate and close commands. Save closes the drawer; no family continuation. Passenger picker can imply a selection from similar free text even without a stored link. |
| Follow-up | Enquiry status, Request relatedEnquiryId/owner, Timeline | Sending is a status/handover event; it does not assign a person or create a FamilyRecord. |
| Family contact | FamilyRecord: contact, needs, commitments, nextContactDue, assignedOfficer | Creation repeats enquiry contact/reported passenger details. assignedOfficer and caseId are free text, not assignment authority. |
| Relationship | RelationshipClaim: familyRecordId, optional passengerRecordId, reported facts/current status/version | Family creation creates a current claim. Dedicated verify/reject/reopen and correct-claim commands preserve decisions/history. A linked passenger is not verification. |
| Passenger/source | PassengerRecord: manifest identity/flight/source/version, SRC flag, condition/hold | Dedicated source correction, SRC confirmation, condition/hold commands. Source confirmation is independent of relationship verification. |
| Suggestion | MatchSuggestion: claim/passenger IDs and versions, signals/conflicts, generation | Stored immutable suggestion; numeric score and technical generation ID dominate the current candidate header. No automatic confirmation. |
| Human decision | MatchDecision and MatchingRecord: stable claim/passenger/decision IDs | Explicit confirm/reject/invalidate with reason, version checks and operation ID. MatchingRecord enquiryId is optional/legacy; modern claim decisions do not require it. |
| Preparation | ReleaseAction: claim/decision/passenger IDs, prepared versions | Requires a current human-confirmed match and verified relationship. Empty candidate/queue view lacks routes to resolve missing prerequisites. |
| Checks | ReleaseCheck: explicit identity and hold-review provenance | Independent recorded checks bound to claim/passenger/decision versions; editable checkboxes cannot replace them. |
| Authorization/completion | ReleaseAction and ReleaseOperation | Explicit distinct authorize/complete/cancel commands. Holds, stale inputs and missing checks block authorization/completion. |

## 2. Relationships and schema assessment

Stable links: Enquiry → PassengerRecord; FamilyRecord → RelationshipClaim;
RelationshipClaim → optional PassengerRecord; MatchSuggestion → claim/passenger;
MatchDecision → claim/passenger/suggestion/MatchingRecord; ReleaseAction →
claim/decision/MatchingRecord/passenger; Request → enquiry/family/passenger/release.
Timeline events reference source entity IDs and may carry a free-text caseId.

Enquiry → FamilyRecord has no direct foreign key. caseId on enquiry/family/passenger
and legacy MatchingRecord is a shared operational reference, not proof of identity.
Reported names/flight/contact copies are not relationships. PI3 will not join people
by similar names, scores, phone or email. An explicit new-contact copy action may
carry the existing case reference, or the enquiry's operational reference when
none exists, and clearly label shared-reference associations. A precise enquiry
foreign key would improve historical provenance but is not required for this
bounded, explicitly reviewed copy/navigation journey. No migration is justified.
Stop and report any genuine blocking gap before adding persistence.

## 3. Roles and permissions

TEC Member reads/creates/updates enquiries and reads family contacts; it cannot
create/verify family contacts or read passengers/matching/release. Coordinators
have the corresponding specialist commands. Group leaders/members/observers
without specialist permissions remain outside these screens. Admin operational
visibility comes from actual operational roles, not system administration alone.

Incident membership, EffectiveAccess and DENY overrides remain server authority.
Each contextual section requires its source read permission; restricted sections
are unavailable, never zero. Next links require destination read access; copy
requires enquiry read and family create. No role expansion.

## 4. Continuity and persistent context

Add a compact specialist journey panel inside selected records/claims/releases:
reported enquiry → contact/relationship state → linked passenger/source → system
suggestion/human decision → controlled release. Show incident/reference, explicit
association basis, state/blocker, next permitted source link and snapshot load time.
Avoid a generic Case table or giant form. Keep PI2 Workspace as the landing page.

## 5. Blockers and next steps

Use existing matching effective validity and ReleaseAction preconditions rather
than reimplementing authorization. Missing human match routes to the exact claim;
unverified relationship routes to the family record; passenger hold/source work
routes to the exact passenger where permitted; check/authorization steps stay in
Release Control. If a destination is unavailable, explain that an authorized
operator must continue without exposing its protected facts or controls.

## 6. Handover and next owner

Show existing open related Support Requests with their actual owner, eligibility,
state and due time; no request means Needs assignment, not a guessed person.
Retain family needs/commitments/next contact and label assignedOfficer as reported
free text. Recent significant source Timeline events provide actor/time/action;
existing immutable decision/check history remains in its specialist screen.
Expected next function may be described as family support, source reviewer,
match reviewer or release authorizer, separately from an assigned person.

## 7. Duplicate entry

An explicit Copy reported enquiry into new family contact route loads the
server-authorized enquiry. Prefill editable reported contact/location/language,
relationship/passenger details and notes; carry only the stored passenger link.
Display the original caller name for operator review, without guessing a surname
from a single free-text name. Save uses the existing family create command and
creates an unverified claim. Never overwrite an existing contact or verification.

## 8. Deep links and queue return

Keep `/tec-intake?focus=`, `/family-nok?focus=`, `/passenger-src?focus=` and
`/matching?claimId=`. Resolve exact authorized UUID records outside a filtered page.
Add `/family-nok?fromEnquiry=` for a new reviewed draft, and
`/release-control?claimId=` / `?releaseId=` for scoped prerequisites/action focus.
Use bounded URL search/filter/page/selection state and a validated local returnTo
path. Preserve queue context when going to a related record and returning. Do not
accept external URLs, arbitrary paths, nested return chains or unsupported params.

## 9. UI and terminology

Use TEC / Enquiries, Family contacts / Relationship verification, Passengers /
Source verification, Matching and Release & reunification in bounded navigation
and headings; database/API model names remain. Expand SRC as source confirmation.
Keep reported, verified, system-suggested and human-confirmed text separate. Make
score secondary and technical generation metadata collapsible. Move repeated
starter guidance below live record context.

## 10. API/read composition

A small PostgreSQL read endpoint may compose scoped context for a selected enquiry,
family, passenger, claim or release from existing tables/repositories. It returns
explicit source availability and bounded lists/counts, no persistence or commands.
Reuse matching/release repository contexts for effective staleness and blockers.
Internal relationship traversal must not expose denied source facts. Failed reads
produce failure/retry, not successful empty. Memory compatibility may explicitly
report contextual unavailability; production PostgreSQL is acceptance authority.

## 11. Corrections and stale state

Existing family corrections update a pending claim or supersede decided claims;
immutable verification history remains. Passenger corrections/version changes,
SRC/condition/hold changes and reopened claims invalidate effective match/release
freshness through version/currentness comparisons. No silent auto-reapproval.
Context must refresh after commands, clear on entity/incident changes and reject
late responses. Historical completed/cancelled outcomes remain historical outcomes,
not recast as current permission to act.

## 12. Empty, failed and restricted states

Distinguish no incident, loading, read permission absence, no related records,
missing prerequisite, failed read, stale derived state and completed outcome.
Context load failure offers Retry; source failures do not become zero. No claim or
no human match is a concrete blocker with a permitted continuation path.

## 13. Responsive/accessibility

Validate 1440/1280/1024/768px. Compact wrapping context cards, essential queue
columns, existing drawers; no document-wide horizontal overflow. Named links,
semantic headings, labels, visible focus, keyboard record opening/dialog/return,
errors and textual verification/suggestion/blocker/authorization states.

## 14. Test matrix

PostgreSQL production composition: enquiry creation/context/handover; reported vs
verified claim, correction/history; source vs relationship confirmation; suggestion,
human confirm/reject and stale upstream corrections; release missing prerequisites,
checks/authorization/completion and links; incident isolation, DENY, TEC, coordinator,
observer/admin-only boundaries; unavailable/empty/failure and unchanged records.

PostgreSQL browser: synthetic TEC enquiry → coordinator reviewed contact copy →
claim verification → passenger source confirmation → generated suggestion → explicit
human decision → exact release preparation → checks → authorization/completion.
All journey steps use UI/service commands; DB bootstrap only unrelated prerequisites.
Negative journey: unverified claim/no human match/hold/unauthorized destination;
assert exact blocker and permitted resolution. Test every new link contract, queue
return, keyboard and four widths. Retain all PI1/PI2 coverage.

## 15. Validation and report

npm ci, Prisma generation, lint/typecheck, full unit, build, general browser,
production audit and diff check. Fresh disposable DBs for full PostgreSQL, dedicated
PI3 and PostgreSQL browser; production PostgreSQL/Entra startup. Never run destructive
automated suites against preview. Record results/limitations in
`docs/product-increment-3-family-passenger-journey-report.md`.

## 16. Definition of Done and exclusions

All 30 requested PI3 conditions: coherent authorized journey, distinct reported/
verified/suggested/confirmed states, safe release, useful blockers/next links,
queue/ownership/handover continuity, safe copy and preserved correction/history/
staleness, server permissions, positive/negative persona workflows, responsive/
keyboard usability, PI1/PI2 intact, no sensitive automation or unapproved migration,
full gates, complete report, no PI4. Push/open PR, exact-head CI green and legitimate
reviews addressed; leave PI3 unmerged without further authorization.

Exclude PI4, Stage 26, generic Case/CRM/workflow engine, automatic verification/
matching/release, telephony/external call centre/AI, Dashboard redesign, Evidence/
Reports/AAR redesign, production Entra browser/deployment/recovery infrastructure,
Training/Exercise/organisational Readiness.

## 17. Proposed commits

1. Commit this inspected workflow map and plan separately.
2. Add typed source-authorized specialist journey read composition.
3. Add explicit copy, context/next-step links and bounded queue/deep-link behavior.
4. Add PostgreSQL safety/persona and browser journey/negative/accessibility coverage.
5. Record report, run gates, push/open PR, address review and monitor exact-head CI.
