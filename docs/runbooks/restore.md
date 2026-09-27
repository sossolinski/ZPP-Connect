# PostgreSQL Restore and Recovery Verification Runbook

Use this runbook to restore a Stage 23 backup into a new database. The repository command
does not drop, clean, truncate or overwrite a database. It refuses a nonempty target and,
by default, requires a name beginning `zpp_stage23_restore_`.

Run from the matching production image. In a source checkout, first run
`npm run build -w @zpp/api` so the compiled operational entry points match the checkout.

## 1. Incident preparation

1. Record the incident, selected application release and recovery owner outside the failed
   database.
2. Select the newest backup pair that satisfies the required recovery point.
3. Obtain deployment configuration from the authorized secret/infrastructure systems.
4. Confirm the backup's producer/server majors and install the matching `pg_restore` major.
5. Confirm enough database/storage capacity and isolate the recovery environment from the
   active service until verification succeeds.

## 2. Verify before restore

```bash
export BACKUP_MANIFEST_PATH='/secure/recovery/zpp-connect-TIMESTAMP-ID.backup.manifest.json'
npm run backup:verify
```

Stop if this fails. Do not edit the manifest to make a damaged archive pass.

## 3. Create an empty recovery database

Provision a new database through the deployment's normal PostgreSQL administration path.
For an authorized native-client environment, an example name is:

```bash
createdb zpp_stage23_restore_20260926
```

The database must contain no user tables. Do not point the restore command at the current
production database. Use a database principal permitted to create schema objects and data
but do not use a real credential in shell history or documentation.

## 4. Restore and verify

```bash
export RESTORE_DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/zpp_stage23_restore_20260926?sslmode=require&schema=public'
export INTEGRITY_MAX_ROWS='10000'
npm run restore:verify
```

The command performs checksum/catalog verification again, rejects a target that fingerprints
as the backup source, requires an empty database, invokes `pg_restore --exit-on-error`, and
then verifies accessibility, exact Prisma migration state, repository migration names and
checksums, critical row counts and application integrity. Any failure returns non-zero.

`RESTORE_ALLOW_ANY_EMPTY_DATABASE=true` relaxes only the naming guard. Reserve it for an
approved environment whose provisioning rules cannot use the prefix; it does not relax the
empty-target, source-target, checksum or integrity checks.

## 5. Recover deployment configuration

The PostgreSQL dump includes dictionaries, roles/permissions, notification state, Audit,
Documents, incidents, AARs and persisted PDF bytes. It does **not** include:

- `DATABASE_URL`, Entra issuer/audience/JWKS or other secrets;
- application image/source, TLS keys, DNS, firewall/network or load-balancer settings;
- `APP_ORIGIN`, `APP_PROFILE`, port/log and notification-worker environment values;
- scheduler/monitor/alert configuration;
- original import bytes or generated CSV export bytes (the product stores their provenance,
  not those files);
- legacy `DATA_DIR` files. The explicit PostgreSQL production composition has no supported
  disk-backed authority. A deployment that added one must restore it separately.

Recreate these from version-controlled infrastructure and authorized secret systems. Never
derive or copy a credential from a manifest; it contains none.

## 6. Start and accept service

1. Point an isolated API instance at the recovered database.
2. Run `npm run integrity:check` with a bound large enough for a complete scan.
3. Confirm `/api/health` returns process liveness and `/api/health/readiness` returns 200,
   `ready: true`, `database: "reachable"`.
4. Confirm Entra-only production auth and perform authorized read-only checks of a real
   incident, Document, Audit entry, approved AAR and retained PDF download/hash.
5. Record measured restore duration and recovered backup timestamp against the assumed
   four-hour RTO and 24-hour RPO.
6. Cut over only through the deployment's approved process. Keep the previous database
   isolated and unchanged until rollback risk has passed.

If validation fails, do not repair records ad hoc. Preserve logs, create another empty
target, select a prior verified backup when appropriate, and escalate the invariant failure.

## Automated rehearsal

CI and an authorized local test environment can exercise the complete disposable cycle:

```bash
export NODE_ENV='test'
export STAGE23_ALLOW_RECOVERY='true'
export STAGE23_ADMIN_DATABASE_URL='postgresql://TEST_USER:TEST_PASSWORD@127.0.0.1:5432/postgres?schema=public'
npm run test:recovery
```

This command creates two randomized `zpp_stage23_*` databases, migrates/seeds the source,
adds synthetic recovery evidence, backs it up, restores it, checks meaningful data and
corruption rejection, then drops only those exact databases and removes its temporary
directory. Never supply production administrative credentials.
