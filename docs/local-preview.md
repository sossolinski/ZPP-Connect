# Disposable local preview

This runs the current checkout (merged Stage 25 plus PI1 on the operational-trust
branch) with its PostgreSQL production composition and development authentication.
The preview tooling itself adds no production features. All content is synthetic.
The historical Stage 12 stash and the documentation baseline branch are untouched.

## Prerequisites and connection

Node >=20, npm, and a running local PostgreSQL installation with `psql`, `createdb`
and `dropdb` on PATH. Docker is unnecessary. The verified Mac uses Homebrew
PostgreSQL on localhost:5432 and local role `sebastian`, with no URL password.

The commands default to `postgresql://<current OS username>@localhost:5432/zpp_connect_preview`.
If your local role/port differs, set `PREVIEW_DATABASE_URL` in each terminal to its
local connection URL. Use only local development credentials. An inherited
`DATABASE_URL` is deliberately ignored. Only loopback hosts and the exact database
name `zpp_connect_preview` are accepted; the only permitted query is `schema=public`.
Production mode is rejected. No Entra configuration is required.

New databases receive the marker `ZPP Connect disposable synthetic local preview`.
An existing unmarked database is refused rather than adopted or erased. Inspect
such a database before taking any manual action. All commands except the web
server verify this marker. Reset verifies the marker before dropping the exact
named database; it has no wildcard or force-disconnect option.

## Commands

Run from the repository root:

```bash
cd /Users/sebastian/Documents/ZPP-Connect/ZPP-Connect
npm run preview:setup
```

Setup installs locked dependencies, generates Prisma, builds the shared package,
deploys every migration, validates the schema, and runs the normal seed followed
by the preview supplement. Stop existing preview servers before setup (it runs
`npm ci`). Setup/reseed can be repeated without duplicating the sample report or
evidence; they reapply the baseline fixtures. Use reset for a pristine database.

Terminal 1:

```bash
npm run preview:api
```

Terminal 2:

```bash
npm run preview:web
```

Open <http://localhost:5173>. The web server uses strict port 5173, so a port
conflict fails visibly instead of silently selecting another URL.

To reapply synthetic fixtures without dropping the database:

```bash
npm run db:seed:preview
```

To completely reset **only the marked `zpp_connect_preview` database**, stop the
API first (and close other connections to this database), then run:

```bash
npm run preview:reset
npm run preview:api
```

The web terminal can remain running during reset; reload the browser afterward.
Reset drops/recreates the exact database and redeploys/reseeds it. It does not
install dependencies; run setup first on a fresh checkout.

Stop terminal-managed servers with **Ctrl+C** in both terminals. PostgreSQL and
the database remain available. Runtime logs, screenshots and other inspection
artifacts are ignored under `storage/local-preview/`; do not commit them.

## URLs and login

- Web: <http://localhost:5173>
- API: <http://localhost:4000/api>
- Liveness: <http://localhost:4000/api/health>
- Readiness: <http://localhost:4000/api/health/readiness>
- Authentication config: <http://localhost:4000/api/auth/config>
- OpenAPI / Swagger UI: <http://localhost:4000/api/docs/>

On the login page, use **Development access**, select
**ZPP Coordinator · coordinator@lot.pl**, and click **Enter ZPP Connect**.
No password is needed. The inner sign-in-method selector currently says
**Microsoft**, but this is a local development login in this configuration;
do not use the separate **Continue with Microsoft** button above it.

| Account | Seeded roles |
| --- | --- |
| `coordinator@lot.pl` | `zpp-coordinator` — recommended first account |
| `admin@lot.pl` | `system-admin`, `zpp-coordinator`, `tec-coordinator` |
| `tec@lot.pl` | `tec-member` |
| `zpp@lot.pl` | `zpp-group-leader`, scoped to Family Assistance Alpha |
| `volunteer@lot.pl` | `zpp-member` |
| `viewer@lot.pl` | `observer` |

All six are assigned to both seeded incidents. These familiar login identifiers
are code fixtures, not real employee accounts. Use the account menu to sign out
and repeat development login when comparing roles. Navigation groups expand by
clicking their headings; some Admin-labelled reports are available to coordinators,
but Users & Access and Roles & Permissions require administrative permissions.

## What to inspect

- `SES-2026-001`: active REAL-mode **[SYNTHETIC PREVIEW] LO999 — Operational
  disruption at XYZ Airport**, with fictional people and XYZ–ABC routing.
- `SES-2026-002`: closed REAL-mode synthetic incident for historical reporting.
- Dashboard, briefings (under **Active Event**), timeline, enquiries,
  passengers, family records, matching, one welfare request, four assignments,
  member directory, groups and roster fixtures come from the existing seed.
- Documents include internal published guidance, draft/version history and a
  checklist entry. The example.com external document link is a placeholder.
- The notification bell includes a seeded operational update for the coordinator.
- Evidence includes `synthetic-preview-note.txt`, retained in PostgreSQL with
  its content digest and audit/timeline provenance. It contains no real evidence.
- **Reports → Open After Action Reports → Report Session SES-2026-002** shows
  an approved synthetic report with a summary, finding, lesson and recommendation.
  The report session selector is independent of the active operational incident.
  You can generate and download a retained PDF using the existing workflow.
- Reports offers operational CSV exports. Export/PDF history begins empty after
  reset, until an artifact is generated. The general **PDF session summary** is
  explicitly unavailable in the current product; it is separate from AAR PDF export.
- No Training, Exercise or organisational Readiness sample data is created.
  Release actions/import history may be empty until you perform those workflows.

The original fixture dates are deliberately preserved, so overdue tasks/document
reviews and old roster periods are expected. REAL is the incident mode, not a
claim that these fictional events occurred. No email is sent by setup.

## Verification performed (2026-09-29)

- Local PostgreSQL: all 24 migrations applied; Prisma schema validation passed;
  liveness/readiness/auth-config returned HTTP 200 with postgres/dev configuration.
- Setup, exact-database reset and repeated reseed completed successfully. Repeated
  seeding left one evidence record and one approved report. Negative checks
  rejected a different database, remote host, connection-parameter redirection,
  and `NODE_ENV=production` before database mutation.
- API TypeScript check and a separate TypeScript check including preview-seed.ts
  passed. The preview command script passed Node syntax checking.
- Playwright Chromium exercised real development login for coordinator, admin
  and TEC against the running PostgreSQL application. No API mocks or memory
  adapter were used. The browser connector was unavailable, so the installed
  Playwright runtime was used directly.
- Verified Dashboard, Sessions, Active Event/Operational Briefings, Timeline,
  Documents, Notifications, Requests, Assignments, Members, Groups, Rostering,
  TEC intake, Family/NOK, Passenger/SRC, Matching, Release Control, Reports,
  After Action Reports and Evidence.
- Downloaded the retained evidence and checked its exact SHA-256. Downloaded a
  session-package CSV and generated/downloaded the approved AAR PDF. The current
  database retains that PDF artifact; reset starts without generated exports.
- Admin Users & Access, Roles & Permissions and Settings loaded. Coordinator and
  TEC Users & Access were restricted; API checks returned 403 for them and 200
  for admin. TEC Reports was restricted. TEC could read/download evidence but
  had no upload or withdrawal controls. These are existing product permissions.
- Dependency installation reported 8 audit findings (3 moderate, 5 high).
  Dependencies were not changed as part of this preview-only task.

Minor existing UX observations for later discovery: Development access labels its
local method Microsoft; briefings are under Active Event; historical reports have
an independent Session selector; fixed fixture dates show overdue work. No product
behaviour was changed to address these observations.

## PI1 fixture lineage

Current enquiries, claimant/family facts, relationship claims and linked passengers
use the same fictional identities and LO999 flight. Source/claim corrections use
the existing versioned repository commands; current suggestions are generated by
the existing deterministic matching algorithm. Older suggestions and decisions
remain historical evidence and are not rewritten to claim current results. The
seed asserts principal identity/flight/version coherence and no contradictory
generated signals. Fixed historical publication/due dates intentionally demonstrate
overdue states. Preview reseeding is for developer evaluation, not algorithm
acceptance evidence or a production data repair procedure.
