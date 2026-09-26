# Application Integrity Verification Runbook

`npm run integrity:check` is a read-only, bounded operational checker for critical data
invariants. It is not the cheap readiness endpoint and should not run on every HTTP request.
Run it from the matching production image; in a source checkout, first run
`npm run build -w @zpp/api`.

## Run

```bash
export DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/zpp_connect?sslmode=require&schema=public'
export INTEGRITY_MAX_ROWS='10000'
npm run integrity:check
```

Choose a bound at least as high as every checked collection. The command deliberately fails
instead of sampling when Approved AAR versions, PDF artifacts, published internal Documents
or digest-bearing acknowledgements exceed the bound. This makes a successful result an
explicit complete scan. The hard accepted range is 1–1,000,000.

## Checks

- successful Prisma migration names and SHA-256 checksums exactly match this checkout;
- PostgreSQL constraints are validated and indexes are valid;
- Approved AAR canonical logical content matches `contentSha256`;
- every persisted AAR PDF matches exact byte size/SHA-256 and its Approved source digest;
- Published internal Document text matches its stored SHA-256;
- digest-bearing Document acknowledgements match their referenced version snapshot.

The checker reports only identifiers/categories/counts, never Document/AAR/PDF content or
credentials. A pass emits one JSON `integrity_check` success event and exits 0. A violation,
incomplete scan, database error or configuration error emits a failure event and exits
non-zero.

Export-generation hashes cannot be revalidated because Stage 17 deliberately does not retain
CSV bytes. Import provenance hashes likewise describe input bytes that are not retained.

## Scheduling and monitoring

- Run after every restore and deployment migration.
- Run on an environment-appropriate schedule; daily is the initial recommendation for the
  current data scale.
- Configure the external monitor to alert on non-zero exit, missing scheduled success, or a
  new failure count. Do not hard-code vendor credentials in this repository.
- Monitor `/api/health` for liveness and `/api/health/readiness` for cheap database reachability
  separately. A 503 readiness response contains no database error detail.

## Failure handling

1. Stop any recovery cutover. For a live system, avoid writes to the affected records while
   the incident is assessed.
2. Capture the structured event and checker version/application commit without capturing
   secrets or content.
3. Use the `check` and `recordId` fields to scope read-only diagnosis.
4. Compare against a separately verified backup/restore; do not overwrite stored digests to
   silence the checker.
5. Escalate to the product/data owner for any suspected authoritative-data corruption.

The checker never mutates or purges records. AuditLog, historical Approved AARs and evidence
remain outside automatic application-data retention in Stage 23.
