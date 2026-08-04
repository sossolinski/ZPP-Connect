# ZPP Connect

ZPP Connect is an internal emergency response portal under a controlled migration from its original in-memory prototype to a PostgreSQL-backed modular monolith.

The current implementation uses fake, anonymized demo data only. It is not connected to real passenger, family, volunteer contact or company operational data.

`Incident / Session`, `IncidentAssignment` and `Enquiry` use shared
controller/service/repository flows. In production they are persisted in
PostgreSQL. Session and Enquiry access require a global domain permission and an
active assignment to the selected incident; the named System Admin global
override is centralized in `IncidentAccessService`. Remaining modules are
migrated one vertical slice at a time and must still be treated as transitional.

See [Foundation Stage 2.5 access boundary](docs/foundation-stage-2-5-access.md)
for the lifecycle, endpoint and authorization semantics.

## Tech Stack

- Monorepo with npm workspaces
- React + TypeScript frontend in `apps/web`
- Vite, Tailwind CSS and React Router
- Express + TypeScript API in `apps/api`
- Shared TypeScript package in `packages/shared`
- Playwright smoke tests
- Vitest API tests

This repository is not a Next.js application. Because a meaningful Vite/React application already exists, the portal has been refactored using the existing stack.

## Install

```bash
npm install
```

## Run Locally

The supported development workflow uses PostgreSQL, controlled migrations and the
development-only authentication adapter:

```bash
docker compose up --build
```

On an empty volume the API runs `prisma migrate deploy`, seeds development data
and starts only after both steps succeed. `PERSISTENCE_MODE=memory` is reserved
for automated tests and is rejected in development and production.

To run the processes directly, start PostgreSQL first, copy `.env.example` to
`.env`, then run:

```bash
npm run dev
```

The web app is available at:

```bash
http://localhost:5173
```

## Checks

```bash
npm run typecheck
npm test
npm run build
npm run test:smoke
npm run check
```

`npm run check` runs typecheck, API tests, production build, audit and Playwright smoke tests.

## Demo Login

Use the local demo password:

```text
demo123!
```

Demo users:

- `admin@demo.local` — System Admin
- `coordinator@demo.local` — Crisis Coordinator
- `tec@demo.local` — TEC Operator
- `leader@demo.local` — ZPP Leader
- `volunteer@demo.local` — Volunteer
- `viewer@demo.local` — Viewer / Observer

The development login uses a process-local test session and is intended only for
local product exploration and automated tests. It is rejected when
`NODE_ENV=production`.

## Authentication Direction

The local login remains a development and test aid only. The production
identity architecture supports two sign-in methods:

- Microsoft Entra SSO for corporate workforce users.
- Email and password through Microsoft Entra External ID local accounts for
  approved non-corporate users.

Both methods authenticate the same canonical ZPP Connect User model. Sign-in
method must not determine application roles or capabilities; authorization is
resolved only from canonical User ID, role assignments, role scope, explicit
grants, explicit denies and account status.

The application should not implement a custom production password store unless a
later security decision explicitly requires it. Password reset, password
creation and MFA enforcement should be delegated to the configured identity
provider.

The API accepts `AUTH_MODE=dev` or `AUTH_MODE=entra`. Unknown values fail at
startup. Production requires `entra`, PostgreSQL, and explicit issuer, audience
and JWKS configuration. The browser-side Entra authorization flow is a later
foundation slice; current product buttons must not be treated as completed SSO.

See [Identity and Invitations](docs/identity-and-invitations.md) for the planned
architecture, invitation workflow, persistence model and required test coverage.

## Main Modules

- Dashboard
- Active Event
- Sessions
- TEC Intake
- Family / NOK
- Passenger / SRC
- Matching
- Release Control
- Requests
- Timeline
- Volunteers
- Rostering
- Assignments
- Training
- Documents
- Readiness
- Files / Import
- Reports
- Exercise
- Audit
- Settings

The UI includes frontend-level role behavior for System Admin, Crisis Coordinator, TEC Operator, ZPP Leader, Volunteer and Viewer / Observer. This prepares the product structure for future server-side access control, but it is not a security boundary.

## Demo Data and Privacy

All application data in this iteration is fake and anonymized. The Next of Kin module uses synthetic case IDs and family references only.

Do not use this demo to store:

- real names
- real contact details
- real passenger records
- real family records
- real volunteer personal data
- real operational company information

Before any real crisis, Next of Kin or volunteer data is introduced, the product needs real authentication, authorization, audit logging, data retention rules and privacy controls enforced by the backend.
