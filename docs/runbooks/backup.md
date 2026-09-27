# PostgreSQL Backup Runbook

This runbook covers the Foundation Stage 23 logical backup supported by ZPP Connect. A
backup contains sensitive crisis-response records and retained AAR PDFs. Store it only in
an access-controlled, encrypted, durable destination outside the application host.

## Prerequisites

- Run from a checkout/image matching the deployed application release.
- In a source checkout, run `npm run build -w @zpp/api` first. The production image already
  contains these compiled operational entry points.
- Install `pg_dump` and `pg_restore`. The supported rehearsed path uses one tool major for
  dump and restore; `pg_dump` must not be older than the PostgreSQL server.
- Supply `DATABASE_URL` through the process environment or an authorized secret injector.
  Never paste it into a script, manifest or ticket.
- Set `BACKUP_DIR` to a dedicated local staging directory. Do not use the repository.
- Ensure sufficient free space and a monitoring wrapper that alerts on non-zero exit or a
  missing `backup` success event.

Check versions:

```bash
pg_dump --version
pg_restore --version
psql --version
```

## Create and verify

```bash
export DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/zpp_connect?sslmode=require&schema=public'
export BACKUP_DIR='/var/lib/zpp-connect/backups'
npm run backup
```

The command prints one JSON event. On success it contains `manifestPath`, `archivePath`,
`sizeBytes` and `sha256`. The archive is a compressed PostgreSQL custom-format dump. Its
sidecar manifest records no URL or password. Both files use mode `0600`; the directory is
forced to `0700`.

Verify the emitted manifest before copying or accepting the backup:

```bash
export BACKUP_MANIFEST_PATH='/var/lib/zpp-connect/backups/zpp-connect-TIMESTAMP-ID.backup.manifest.json'
npm run backup:verify
```

Verification checks the strict manifest, regular-file/path boundary, byte size, SHA-256,
matching `pg_restore` major and readable archive catalog. A non-zero exit means the pair
must not be used as a verified recovery point.

After local verification, copy both files as one pair to the deployment's encrypted,
off-host backup store. Verify again after transfer. Stage 23 does not implement cloud
storage, scheduling, encryption or alert delivery.

## Schedule and recovery objectives

The project assumption is one successful backup per day (24-hour RPO), retained for 35
days with at least seven newest valid pairs. These are not business-approved SLAs. A
production scheduler should record the last success and alert when it exceeds 24 hours.
Run a restore verification at least weekly and after PostgreSQL/tooling changes.

Logical dumps are not WAL archives and do not provide point-in-time recovery. Writes may
continue: the command exports one repeatable-read PostgreSQL snapshot, so the dump and
manifest counts/migration state describe the same database snapshot.

## Backup retention

Preview is the mandatory first step:

```bash
export BACKUP_DIR='/var/lib/zpp-connect/backups'
export BACKUP_RETENTION_DAYS='35'
export BACKUP_RETENTION_MIN_COUNT='7'
unset BACKUP_RETENTION_APPLY
npm run backup:retention
```

Review `selectedManifests` and `ignored`. Malformed, corrupt, orphaned or symlinked files
are ignored for manual investigation, not deleted. To delete only the selected verified
pairs:

```bash
export BACKUP_RETENTION_APPLY='true'
npm run backup:retention
```

The command only considers direct-child `*.backup.manifest.json` files whose declared
archive is a valid direct-child file with the matching checksum. It cannot purge database
or application records.

## Failure response

1. Preserve stderr and the structured failure event without copying credentials.
2. Do not publish `.partial`, orphaned or failed artifacts as backups.
3. Check connectivity, permissions, disk space and version output.
4. Retry only after the cause is understood; do not delete the most recent verified pair.
5. Escalate when the last verified point approaches the assumed 24-hour RPO.
