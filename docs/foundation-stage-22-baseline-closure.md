# Stage 22 baseline closure — 2026-09-21

Starting SHA: `64ae992`; all five preparatory commits and the preserved Stage 12 stash remain intact.

Clean install, Prisma generate/validate, lint, 105 unit tests, production build,
73 Playwright tests and production dependency audit (zero findings) passed.
The full development dependency graph still reports 8 findings; this is not the
production audit. Existing Vite chunk-size and Prisma configuration warnings remain.

The first fresh 22-migration/seed PostgreSQL gate passed 262/263 tests. The failure
was a Stage 12 assertion, not a transport error: simultaneous ACK and withdrawal
returned 201 and 200. The documented contract permits ACK followed by withdrawal
and preserves the ACK as historical evidence. ACK does not increment the version
token, and withdrawal does not prohibit existing ACKs. Requiring exactly one
successful command incorrectly rejects that valid serial history.

The focused repair checks successful withdrawal, either successful preceding ACK
or rejected subsequent ACK, exact durable ACK count/identity, coherent timestamps,
and rejection of a fresh ACK after withdrawal. A new deterministic test checks
both sequential orders. No production behavior or retry policy changed.

A subsequent run passed all 264 assertions but failed Stage 1 cleanup because
the locally launched production-startup probe shared the test database and its
notification worker created a referencing row. This was validation orchestration
interference, not a product regression. The probe was stopped and the full gate
was restarted on a new isolated database without a background API process.

Production PostgreSQL/Entra startup separately returned health 200 with PostgreSQL
authority, Microsoft SSO only, development access false, and development users 404.
No external authentication was attempted.

Final isolated PostgreSQL gate: **264/264, 22/22 files, zero skipped, 34.01s**.
Database: `zpp_stage22_baseline_20260921_isolated`, deployed from zero and seeded.
The baseline gate is closed; proceed directly with the approved Stage 22 plan.
