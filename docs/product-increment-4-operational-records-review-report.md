# Product Increment 4 — Clear Operational Records & Post-Incident Review

## Baseline and scope

PI3 PR #26 merged normally on 2026-10-10 as
`0c963b4e2505e261f2560f789f5deac1bd0ec5c4`. Its exact final head
`ce904b03e0385620eded59221bb406384c697cd6` is an ancestor of origin/main.
Six checks passed and the review thread was resolved before merge; no protection
bypass, force operation or history rewrite. GitHub reported no separately configured
required checks. Main remains that merge commit.

PI4 branch: `agent/product-increment-4-operational-records-review`.
Separate inspection/plan commit: `54962e2`.
Plan: [operational records and review plan](product-increment-4-operational-records-review-plan.md).
The Stage 12 stash `2619b110290391049bd6741aab7d774dcee78a85` remains untouched.
PI4 is a normal product increment. No Stage 26 or PI5 work.

The pre-change PostgreSQL preview was inspected as coordinator, member, observer
and admin using repository Playwright after unavailable in-app Browser discovery.
Inspected Documents/compliance, Evidence, exports, historical incidents and the
existing approved AAR/PDF/revision. Draft/review and CSV contracts were also checked
in source and retained acceptance. Preview historical SES-2026-002 has an approved
revision and two PDFs. Downloaded/rendered an existing PDF without regenerating or
modifying it. Actual CSV downloads and complete Draft → review → Approved journeys
were verified in disposable PostgreSQL acceptance, rather than changing the persistent
preview's approved report to manufacture another lifecycle fixture.

## Documents before and after

Before: personal member list was useful, but library-wide "To acknowledge" looked
like individual work; management copy appeared for observers; draft-only/archived
material mixed with published guidance; Workspace linked to the whole page.

After:

- Required for me and operational reference explicitly label each applicable item.
  Shows title, current published version, reason, due/overdue, exact-version
  acknowledgement and available next action. No visibility expansion to unassigned
  guidance. References do not invent acknowledgements.
- Wider readers see personal obligations separately when available. An account
  without a linked member sees personal obligations unavailable, while its permitted
  organization library remains readable. Observer figures explicitly describe
  outstanding work in the permitted organizational scope; management actions remain permission-bound.
- Library labels published reference versus managed/configuration material, with
  current version and authorized version/requirement controls. Requirement target
  labels use Member rather than the internal MemberProfile term.
- Own immutable acknowledgement history is accessible; superseded versions explicitly
  say historical and do not satisfy a newer requirement. Version drawers keep
  publication/withdrawal dates, with technical actor IDs in expandable detail.
  Historical/inapplicable requirements cannot offer on-behalf acknowledgement.
  Missing version content is explicitly unavailable; fresh superseded/withdrawn or
  unavailable content cannot offer acknowledgement even if an older list did.
- Workspace obligation opens exact version. A small mine=true documentVersionId
  filter locates that user's obligation independently of pagination. The content
  endpoint still enforces scoped access. Memory preview supplies the same explicit
  required/reference flag and reference status as PostgreSQL. Its compliance projection
  excludes awareness-only items from required/outstanding/unavailable-content failures
  and reports awareness totals; genuine overdue obligations still reduce compliance.
- Read failures no longer become zero-filled requirements/acknowledgements. Technical
  publication and immutable evidence remain available through existing APIs.

Documents remain controlled organizational guidance across incidents; this increment
does not invent incident-document attachment relationships or a DMS hierarchy.

## Evidence before and after

Before: normal view led with PostgreSQL/hash/NOT_CONFIGURED and withdrawn tombstones;
upload time was absent; active and withdrawn records were mixed by default.

After: filename, category/description, uploader/time, size/type, textual state and
available actions come first. Full digest lives in native Technical integrity details.
"Malware scan not configured" is explicit. A listed file is not claimed malware-safe
or integrity-verified merely because metadata exists. Successful download reports
verification; failures block the download and direct the operator to an administrator.

Download retains the server's stored-byte verification and additionally computes the
browser SHA-256 against the header; Evidence also checks that header against the
selected record's digest. No manual digest comparison is needed.

The default register shows active records. Include withdrawn history makes preserved
metadata, actor/time and reason available. Withdrawal is an explicit accessible
dialog, removes the artifact from active records, disables download, and preserves
retained bytes/metadata/audit. Exact-item links still open a withdrawn historical
record independently of the list filter. No purge or retention-policy implementation.

Local historical Evidence context uses the existing incident and file endpoints;
Closed/Archived operational controls are absent. Exact lookup rejects another
incident's file. Failed sources show unavailable, never an empty register.

## Reports and export purpose

Reports & Exports now sits with Operations. Structured Post-Incident Reports and
CSV data exports have distinct headings and explanations. Removed the disabled
PDF session summary placeholder: neither a named recipient nor a required offline
handover/distribution workflow justified a second PDF format. Existing legacy API
501 rejection remains compatible.

| Export | Intended user/moment | Actual source scope | Format and retention |
| --- | --- | --- | --- |
| Session package | Authorized operator; handover, briefing or review | Incident context and datasets permitted for that actor | CSV; generation metadata retained, bytes delivered once |
| Enquiry log | Authorized enquiry reader; telephone desk handover/review | Incident enquiries/caller-reported information | CSV; metadata only retained |
| Family/NOK register | Authorized family reader; family support/verification review | Incident contacts and recorded verification | CSV; metadata only retained |
| Passenger/Crew register | Authorized passenger reader; source reconciliation | Incident passenger/crew source records | CSV; metadata only retained |
| Matching log | Authorized matching reader; reconciliation/decision review | Incident recorded matching state/decisions | CSV; metadata only retained |
| Requests log | Authorized request reader; handover/follow-up | Incident support requests, owners and lifecycle | CSV; metadata only retained |
| Audit log | Authorized auditor; incident review | Incident-scoped recorded actions/actors | CSV; metadata only retained |

All generation is explicit POST with existing authorization, operation ID, source
permission filtering, selected columns, formula escaping and row/byte limits. The
result reflects source data at preparation time. A later generation may differ; a
past CSV is not reproducible or downloadable from retained metadata alone.

Generation history now shows type, incident, timestamp, human actor, sections/row
scope, status and the metadata-only historical limitation. IDs, schema, filename,
size and generated-byte digest are secondary details. History is paged; exact
metadata lookup works beyond the first page and rejects incident mismatch. No fake
historical download button. Empty history and totals explicitly describe the
currently visible permission scope, without claiming there are no other exports. A fresh authorized export downloads bytes and refreshes
history; it does not replace an old generation record.

Small read projections join existing preparedBy and incident relations; generation
hash/time/scope remain unchanged. Actor display name and incident lifecycle are
current directory/incident context, not newly introduced immutable name/status
snapshots. Existing generation actor ID and audit history remain the provenance
boundary. Current source permissions still filter metadata, including the existing
session-package audit restriction; no permission expansion.

## Post-Incident Report before and after

Before: independent historical selector was correct but "Report Session" underneath
the current incident header obscured the subject. Approved content looked like a
large disabled form with full hashes and artifact IDs in the main view.

After:

- Primary UI term is Post-Incident Report; After Action Review (AAR) is help terminology.
  Internal AAR models, routes, identifiers and lifecycle remain compatible.
- Dominant historical incident identity/status/event and closed time where available;
  explains operational records are read-only and report lifecycle actions are separate.
  Return to current Incident Workspace is explicit. Selecting a report never calls
  setActiveSessionId or changes global localStorage incident state.
- Closed REAL incident register has a direct Post-Incident Report and historical
  Evidence path. Historical Records navigation connects permitted Evidence, exports
  and organizational guidance. Closure and approval remain explicit human commands.
- Draft explains editable state and submission access. Under review explains locked
  content and supported reviewer/approver transitions. Server capabilities determine
  actual actions; no fabricated workflow or privilege from admin status.
- Approved narrative prioritizes title, incident/revision, immutable approval, stored
  approval actor/time, summary, findings, lessons and recommendations with owner/target.
  There are no disabled authoring inputs in Approved read mode. Digests and archive
  controls are secondary. Recommendations remain historical report content, not tasks.
- Revision history and exact revision links remain available; later changes create a
  separate Draft and leave approved content/digest unchanged. One report per incident,
  existing legacy event report reads (with authoring still prohibited), archive behavior and immutable database triggers are intact.
- PDF metadata shows incident/revision/Approved, generation actor/time/size; technical
  artifacts/source hashes and renderer are expandable. Exact artifact links validate
  reportVersionId, include the requested item beyond pagination and label it selected.
  Browser verification checks downloaded bytes before creating a file download.

The existing Stage 22 PDF already has incident/revision, approval actor/time,
generation time, title and all report sections. Retained and new PDFs keep the
established `aar-pdf-v1` template contract, including its legacy After Action Report /
Session headings. No PDF engine or renderer constraint rewrite was needed. Approved
source is verified during generation; retained file bytes are checked on download.
The digest is neither a digital signature nor authenticity assurance. Unsupported
font characters remain visibly `[U+codepoint]`; this bounded Unicode limitation is
explicit in the PDF and download view. Poppler text extraction and visual rendering
verified provenance, section readability and footer spacing.

## Exact links and return context

| Destination | Supported exact context | Boundary |
| --- | --- | --- |
| Documents | versionId | Authorized content and filtered own obligation; no old acknowledgement satisfies new guidance |
| Evidence | incidentId + evidenceId | Existing incident/file authorization; exact item independent of page/withdrawn filter |
| Exports | incidentId + generationId | Existing source-permission gate; mismatch fails without an unrelated history fallback |
| Post-Incident Report | incidentId + revisionId | Closed/Archived local event; REAL authoring only, retained legacy reports read-only; revision ownership checked |
| Retained report PDF | incidentId + revisionId + artifactId | Authorized artifact metadata; exact version ownership and verified download |

returnTo uses the existing shared bounded local-route policy. Added only supported
record routes/parameters; external/protocol-relative targets, unsupported parameters,
nested returns, fragments and oversized values are rejected. PI3 specialist routes
and return behavior remain covered. New local context does not select a global incident. Late withdrawal/export reloads are
scoped to the selected incident/item; browser Back cannot restore an old selection.
Report version/history/PDF reads serialize with authoring controls, so a late revision
read cannot silently replace input typed while the read is pending. Three dedicated
browser regressions cover those cases.

## Permissions and truthful availability

Existing EffectiveAccess, incident assignment and document scoping remain authoritative.
Validated own document reader, document manager/read-all observer, Evidence reader,
Evidence upload/withdraw, dataset export sources, separate AAR author/reviewer/approver,
observer denial and an admin-only custom fixture with no operational permissions.
Restricted exact IDs remain non-leaking 404 where the existing service requires it;
restricted collections return 403. Account administration alone grants no operational
Evidence/export/AAR data.

Available-empty, unavailable/failed, historical, withdrawn and superseded are distinct.
No failed requirement list, report, export history or Evidence read becomes zero or
an empty success. A missing personal member link is shown independently of successful
library access. The current Workspace remains bounded and retains PI1–3 behavior.

## Schema, responsive and accessibility

No migration or persistence model change. Existing Document/Version/Requirement/
Acknowledgement, StoredFile, Session, ExportGeneration and AAR/Version/PdfArtifact
relations represent the outcomes. CSV non-retention is an existing contract. No
retired product domain, generic records service, enterprise DMS, reporting designer,
new action/task engine, Training/Exercise/readiness or Stage 26 work.

Touched pages tested at 1440, 1280, 1024 and 768px. Tables scroll within their bounded
containers; narrative and metadata wrap without document-wide horizontal overflow.
Keyboard focuses and follows return controls at all widths. Native details expose
technical metadata by keyboard. Existing dialog focus/dirty-close behavior is retained;
Evidence withdrawal uses DialogSurface. Text communicates statuses independently of
color. Download names describe file or incident/revision/generation; Approved content
uses semantic headings/sections rather than inaccessible disabled form controls.

## Validation evidence

All required local gates passed on the final implementation before publication.

| Gate | Result |
| --- | --- |
| npm ci | Passed; no dependency changes. Unfiltered install reports 16 dev/optional-inclusive advisories separately from production scope |
| npm run db:generate | Passed |
| npm run lint | Passed API/web type checking |
| npm test | 152 passed; 394 skipped (PostgreSQL-only and explicitly dormant legacy coverage); 54 files |
| npm run build | Passed; existing Vite chunk-size warning remains a separate volume/performance concern |
| Full PostgreSQL | 353 passed / 27 files, zero skipped, fresh zpp_connect_pi4_ci_fixture_20261011 (rerun after CI fixture correction) |
| Dedicated PI4 | 20 PostgreSQL + 11 bounded-return policy cases passed, fresh zpp_connect_pi4_dedicated_20261011 |
| General Playwright | 62 passed |
| PostgreSQL Playwright | 83 passed: PI1 15 + PI2 15 + PI3 19 + PI4 18 + retained 16; fresh zpp_connect_pi4_browser_finalgate_20261011 |
| Responsive/keyboard | Four dedicated width/keyboard cases passed within the 18 PI4 browser cases; all four pages also passed persistent-preview overflow checks at all four widths |
| npm audit --omit=dev --omit=optional | Zero vulnerabilities |
| Production PostgreSQL/Entra startup | Passed readiness/database, SSO-only config, development route 404 and anonymous operational 401; not real Entra browser validation |
| Persistent six-persona preview | Coordinator, TEC, ZPP, volunteer, observer and admin passed; no page errors, no operational writes/reset; both original PDFs retained exact SHA-256; API/web left running |
| git diff --check | Passed |

Disposable PostgreSQL gates retain their own synthetic immutable revisions/artifacts;
no destructive suite ran against zpp_connect_preview. The full PostgreSQL count adds
20 PI4 integration cases and 11 return-policy cases to the prior 322; it includes
policy cases, not exclusively database cases. PI4 also adds three memory-projection
compatibility unit tests. Acceptance asserts content/state, exact links, lifecycle,
permission rejection and byte/hash equality; screenshots only supplement those checks.

Earlier runs had large wall-clock timeouts; a fresh stable full PostgreSQL run passed
without changing timeout limits. Browser expectations were updated for the requested
copy, placeholder removal, secondary hashes and approved read mode. The test login
helper now waits for the actual account option within existing expectation limits.
A source edit restarted the watched API during an intermediate run; that run was
invalidated and stable source was used for final gates. A subsequent combined run
passed all PI4 and retained workflows but had one pre-login PI1 discovery failure;
the final combined gate passed all 83 cases without suppressing that case.

Automated review of the initial PR head found one legitimate P2: the memory/demo
compliance calculation still counted awareness-only guidance as required/outstanding.
The correction filters compliance failures by acknowledgementRequired and adds awareness
totals. A focused regression checks reference-only compliance and mixed overdue obligations;
the full unit suite (152), lint and build passed after the correction. PostgreSQL services,
schema, browser behavior and retained artifacts are unchanged by this memory-only fix.

One subsequent CI PostgreSQL run exposed an inherited Stage 14 fixture issue: its
random identifier was F14-3864756748, whose digits-only token correctly matched the
notification safety policy. Four recipient-delivery assertions failed while all PI4
cases passed. The fixture now prefixes the random token with a letter; safety policy
and delivery assertions are unchanged. The actual policy was checked against both
the failing numeric and corrected alphanumeric values. A new fresh local database
zpp_connect_pi4_ci_fixture_20261011 passed all 353 tests with zero skipped.

## Definition of Done

All 38 Definition of Done conditions are satisfied. The PR remains subject to exact-head CI/review and must stay unmerged without explicit further authorization.

| # | Required condition | Evidence |
| --- | --- | --- |
| 1 | Required versus reference understandable | Explicit item purpose, library reference/managed labels; PG obligation/reference cases |
| 2 | Obligations actionable | Reason/version/due/last acknowledgement/action; Workspace exact-version journey |
| 3 | Current versus superseded clear | Version drawer/content status; old-version test |
| 4 | Acknowledgement history intact | Own history and retained Stage 12 immutable evidence |
| 5 | Operational Evidence readable | Metadata first; hidden digests browser assertion |
| 6 | Integrity controls intact | Server checks retained; client byte verification; Stage 25 retained |
| 7 | Malware state truthful | Plain not configured; raw stored scanner state unchanged |
| 8 | Withdrawal non-destructive | Active exclusion/history reason/download rejection and preserved record |
| 9 | Report/export purposes clear | Structured report versus seven described CSV extracts |
| 10 | Export provenance visible | Actor/incident/time/scope/status; immutable generation digest |
| 11 | Historical context obvious | Dominant incident identity/status/closed time where present |
| 12 | Active/history cannot be confused | Local selectors, explicit return and unchanged global incident assertion |
| 13 | Reporting terminology clear | Post-Incident Report primary; AAR help; legacy PDF contract preserved |
| 14 | Draft clear | Editable state/capabilities and next supported transition |
| 15 | Under review clear | Locked content, reviewer/approver capabilities |
| 16 | Approved read-oriented | Narrative sections; no authoring inputs |
| 17 | Approved immutable | API rejection/database trigger and unchanged old digest |
| 18 | Later revision intact | New Draft copy; old approved revision/PDF readable |
| 19 | Findings/lessons/actions readable | Separate narrative sections and bounded report-only recommendations |
| 20 | Report PDF verified | Exact retained byte/hash equality and client integrity-failure rejection |
| 21 | Placeholder addressed | Disabled PDF session summary removed; legacy API unchanged |
| 22 | Exact supported links | Ownership checks; Evidence >50/export >20 acceptance; exact revision/PDF |
| 23 | Server permissions preserved | Separate roles, observer/admin-only denial and source filtering |
| 24 | Unavailable not empty/zero | Controlled 403/500 source failures and no false empty assertions |
| 25 | PI1 intact | Full API suite and all 15 PI1 browser cases passed |
| 26 | PI2 intact | Full API suite and all 15 PI2 browser cases passed |
| 27 | PI3 intact | Full API suite and all 19 PI3 browser cases passed |
| 28 | Four widths usable | Document/report/Evidence/export overflow assertions |
| 29 | Keyboard/accessibility usable | Focus/return paths, native details, descriptive downloads and retained dialogs |
| 30 | No unapproved migration | No Prisma schema/migration diff |
| 31 | No retired domain | Stage 24 product-scope tests retained; exclusions unchanged |
| 32 | Full unit passes | 152 passed |
| 33 | Full PostgreSQL passes | 353 passed, zero skipped |
| 34 | Playwright passes | General 62 and PostgreSQL 83 passed |
| 35 | Production audit green | Zero production vulnerabilities |
| 36 | Production startup passes | PostgreSQL/Entra startup passed |
| 37 | Six-persona preview usable | All six personas; historical selection preserves active incident; original two PDFs unchanged |
| 38 | Report complete | Final changes, limitations, test counters and preview evidence recorded |

## Remaining audit and pilot work

PI4 addresses AUD-16 Evidence presentation, AUD-17 export provenance, AUD-18 disabled
summary, AUD-19 historical report subject and AUD-20 approved readability, plus bounded
Documents/version/acknowledgement clarity. General AUD-21 admin configuration vocabulary
and AUD-29 realistic scale remain separate. No generic configuration redesign.

CSV bytes are not retained; generation metadata cannot recreate a historical file.
PDF built-in font fallback remains bounded. Evidence integrity does not establish
malware safety/authenticity. No scanner/provider or per-file sharing/retention model.
The Vite bundle warning and dev/optional dependency advisories remain maintenance work.

Production-pilot concerns stay separate: real Entra browser lifecycle, query-log
redaction, deployment packaging/SPA serving, ingress/secrets, off-host backup/recovery,
monitoring, evidence retention/sharing/scanning policy and realistic volume/user
validation. Six synthetic local personas and startup checks do not close those concerns.
PI4 PR will remain open and unmerged pending explicit new authorization.
