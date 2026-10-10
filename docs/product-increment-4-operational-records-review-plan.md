# Product Increment 4 — Clear Operational Records & Post-Incident Review

## Baseline and authorization

PI3 PR #26 was merged through the normal GitHub merge path on 2026-10-10 as
`0c963b4e2505e261f2560f789f5deac1bd0ec5c4`. Final PI3 head
`ce904b03e0385620eded59221bb406384c697cd6` is an ancestor of origin/main.
The tree was clean, six exact-head checks succeeded, the sole review thread was
resolved, and GitHub reported no separately configured required checks.
Fresh branch: `agent/product-increment-4-operational-records-review`.
The historical Stage 12 stash `2619b110290391049bd6741aab7d774dcee78a85` is untouched.
This increment is neither Stage 26 nor PI5. PI4 will remain unmerged.

## 1. Current records/reporting journey

Before application changes, inspected the live PostgreSQL preview at localhost:5173
as coordinator, member (`volunteer@lot.pl`), observer and admin. Used the repository
Playwright harness because in-app Browser discovery previously returned no runtime.
Read all four pages, incident register, document service/router/repository,
Evidence service contract, export service/router, AAR lifecycle service and retained
acceptance. Private inspection logs/screenshots are in ignored storage/local-preview.
The active incident is SES-2026-001; closed historical SES-2026-002 has one Approved
revision and two retained PDFs. Downloaded an existing PDF without regenerating it,
rendered it with Poppler and visually reviewed its page. Draft/review behavior was
verified against the existing service and Stage 22 acceptance; the persistent
preview has no draft/review fixture and was not reset or rewritten for inspection.

Journey today: Workspace generic Documents link → member obligation/library →
read/acknowledge exact version; Evidence separately uses global incident; Reports
launches seven CSVs, omits provenance history and advertises disabled PDF summary;
AAR selects Closed/Archived incidents independently but sits beneath the live header.
Closed incidents offer read-only state without a direct post-incident review path.

## 2. Documents assessment

Member sees overdue ERP Role Cards v2.0 with reason, due date and read/acknowledge.
Coordinator/admin library mixes published, draft-only and archived material;
observer sees identical global "To acknowledge 16" and management copy despite
read-only access. Existing mine=true supports own obligations for wider readers.
Use explicit Required for me, Operational reference and authorized management
sections. Reference means available published guidance with no acknowledgement
required for that user; do not grant new visibility to unassigned documents.
Show current version, exact-version status, due date, reason, last acknowledgement
and next action. Preserve immutable acknowledgement/history access, including
own historical acknowledgements and permitted superseded version content.

## 3. Evidence assessment

Normal view currently leads with PostgreSQL, digest, raw NOT_CONFIGURED and
"withdrawn tombstones"; uploader time is absent. Show operational filename,
category/description, actor/time, size/type, status and descriptive download.
Move digest into native expandable technical details. State "Malware scan not
configured" explicitly. Downloads remain server verified and client digest checked;
never label a listed item verified before a successful download. Default active
records; explicit withdrawn-history toggle and exact retained-item link. Withdrawal
preserves bytes/metadata/audit, disables download and is never purge.

## 4. Reports/Exports assessment

Seven supported CSVs: session package (permission-scoped datasets), enquiry log,
family register, passenger register, matching log, requests log and audit log.
For authorized operators these serve handover/briefing/review/analysis at the
selected incident's current data state, in CSV format. Generation records retain
incident, timestamp, actor ID, sections/counts, filename and hash; CSV bytes are
not retained, no historical exact download exists, later regeneration can differ.
Surface permission-filtered paged generation history and exact generation detail;
add small authorized actor/incident read projections using existing relations.
A new export downloads current bytes and refreshes provenance history. History
must explain unavailable historical bytes, never imply reproducibility.
Remove disabled PDF session summary: no named recipient/offline workflow justifies
a general summary PDF. Keep the API's legacy 501 compatibility. Structured report
and retained approved PDF belong in Post-Incident Report, separately from data extracts.

## 5. Post-Incident Reporting assessment

Keep one AAR per closed REAL incident, Draft → Under review → Approved, explicit
commands, approved immutability, new revisions, findings/lessons/recommendations,
PDF hashes and archive semantics. Approved currently renders disabled input fields
and prominent digests; replace with narrative read mode and secondary history,
new-revision and technical controls. Draft/review clearly explain edit permission,
next supported transitions and actor. Existing approval context snapshot provides
actor/provenance without a new model. Retained PDF inspected: incident/revision,
Approved, actor/time, generation time and content present, no clipping. Use primary
Post-Incident Report and secondary After Action Review (AAR); preserve internal names
and old retained bytes. A small display-heading update for newly generated PDFs is
permitted; do not change renderer/typography architecture or old artifacts.
Unicode outside built-in font range remains visibly [U+codepoint], documented.

## 6. Historical incident context

Historical selectors must never alter global activeSessionId. Show selected incident
identifier, status, event and endAt when present, historical operational read-only
state and link back to current Workspace. A report draft may still be authored for
a Closed incident; operational read-only is distinct from allowed report lifecycle.
Add closed REAL incident → Post-Incident Report link and explicit historical
Evidence/export context via local incident parameter, existing incident gates.
Documents are organization guidance across incidents; say so rather than fabricate
an incident attachment. Archived operations remain restricted by existing services.

## 7. Terminology

Post-Incident Report (primary); After Action Review (AAR) (help); Exports (CSV data);
Required for me; Operational reference; Manage documents; Current published;
Superseded — historical; Acknowledgement history; Withdrawn — historical metadata;
Malware scan not configured. Keep routes/models/permissions compatible.

## 8. Authority and generated/history states

Published guidance is authoritative organizational versioned content. Only an
acknowledgement of the applicable exact version satisfies that requirement.
Evidence is a retained source, integrity does not prove authenticity or malware safety.
CSV is a generated snapshot with metadata only retained. Approved report content
and retained PDF are immutable historical outputs; future revision is a distinct draft.
Use expandable identifiers/digests, never hide lifecycle state in technical detail.

## 9. Permission model

Existing server EffectiveAccess/document scoped access remains authoritative.
Test own Documents versus document managers/read-all observers; Evidence read vs
upload/withdraw; reports/export source permissions; AAR create/edit/review/approve;
observer rejection; and an admin-only fixture without operational role. Do not infer
incident access from account-administrator status. Source/detail failures must be
visible; forbidden/unavailable must never become empty or zero.

## 10. Deep links/context

Bounded exact destinations: /documents?versionId=... opens permitted version and
its own obligation where applicable; /evidence?incidentId=...&evidenceId=... fetches
an exact item independent of list page; /reports?incidentId=...&generationId=...
fetches permitted generation metadata; /reports/after-action?incidentId=...&revisionId=...
opens exact incident/revision with ownership validation. PDF control addresses exact
artifact; optionally artifactId pins one permitted PDF. Add allowlisted return links
to Workspace/records pages, preserve PI3's existing return policy and tests.
Never silently fallback to an unrelated incident/version for invalid links.

## 11. Read-model/API gaps

Documents already exposes mine, exact versions, history and requirement reasons.
Evidence already has exact-item GET and withdrawn option. Export generation lacks
human actor/incident context: project existing preparedBy and incident relations,
retain redaction/source permission filters. AAR exposes contextSnapshot and report
session: add endAt where useful. No generic records/reporting backend needed.

## 12. Schema assessment

No migration. Existing Document/Version/Requirement/Acknowledgement, incident
Evidence, ExportGeneration metadata, Session and AAR/Version/PdfArtifact relations
represent all bounded outcomes. CSV non-retention is an intentional limitation, not
a missing relationship. If a required relationship proves absent, stop before any
migration and report missing link, workflow, insufficiency, minimum change and
compatibility impact. No speculative persistence or Tasks/action-tracker linkage.

## 13. Responsive/accessibility goals

Check 1440/1280/1024/768 px. Use wrapping metadata, scrollable tables within bounded
containers, narrative sections and native details. No document-wide horizontal
overflow. Label selectors and row/download controls; non-color statuses, semantic
headings, keyboard focus, existing DialogSurface/ConfirmDialog behavior retained.
No brand redesign.

## 14. Test matrix

Dedicated production-composed PostgreSQL API suite covers required/reference,
current/superseded, exact ack/overdue, restricted access; Evidence metadata/scan/
withdraw/integrity/cross-incident; export provenance/metadata-only history/source
filtering/incident isolation; AAR draft/review/approval/immutable/new revision/PDF/
historical and admin-only isolation. Browser assertions cover Workspace → exact
obligation → acknowledgement → Evidence → return; independent historical incident
→ approved revision → retained PDF/hash; export → provenance → downloaded bytes;
observer negative; failed sources versus empty; exact deep links beyond list page;
four widths and keyboard. Reuse retained Stage 12/17/22/25 contracts with updated
user-facing assertions; retain all PI1–3 and Stage 16/17/21/22/24/25 PostgreSQL journeys.

Run npm ci, db:generate, lint, unit, build, general smoke, production dependency
audit and diff check. Use fresh disposable databases for full PostgreSQL, dedicated
PI4 and PostgreSQL browser suites. Never destructive tests on zpp_connect_preview.
Run production PostgreSQL/Entra startup (not real Entra browser lifecycle), restore
local preview servers and verify all six personas.

## 15. Exclusions and pilot track

No enterprise DMS/folders, generic records/report designer/BI, OCR/document AI,
automatic AAR/AI summary, programme action tracker/new task engine, Training,
Exercise/readiness, Stage 26 or PI5. No scanner provider, retention/legal-hold
implementation, infrastructure/packaging/monitoring/backup redesign. Independent
pilot concerns remain real Entra browser validation, query-log redaction, packaging/
SPA/ingress/secrets, off-host recovery, monitoring, evidence sharing/retention/
scanning policy and realistic volume/user validation. AUD-21 general admin
configuration is excluded beyond touched vocabulary; AUD-29 scale remains separate.

## 16. Definition of Done

The 38 requested conditions map to: (1–4) document purpose/obligations/version/history;
(5–8) readable Evidence/intact integrity/truthful scan/non-destructive withdrawal;
(9–12) export purpose/provenance/historical context/active independence;
(13–20) report terminology/draft/review/read mode/immutable revisions/new revision/
readable sections/integrity-verified PDF; (21–24) placeholder removal/exact links/
server permissions/truthful availability; (25–27) retained PI1/2/3;
(28–31) four widths/keyboard/no migration/no retired domain;
(32–37) unit/PostgreSQL/browser/audit/startup/six-persona preview;
(38) complete PI4 report. The final report will evidence each individually.
All must pass before claiming completion; PI4 PR remains unmerged.

## 17. Proposed commits

1. This independently committed inspection and plan.
2. Authorized record/provenance projections and bounded context links.
3. Document/Evidence/export/report presentation and lifecycle clarity.
4. PostgreSQL/browser acceptance and CI inclusion.
5. Outcome report, gate evidence, limitations and remaining pilot work.
6. Legitimate review corrections if required, with exact-head CI rechecked.
