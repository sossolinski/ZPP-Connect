import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertDumpCompatibility, assertRestoreCompatibility, backupManifestSchema, databaseUrlForName,
  fileSha256, parsePostgresConnection, parsePostgresToolVersion, positiveIntegerEnv,
  migrationIdentitiesMatch, redactOperationalError, requiredEnv, resolveDirectChild, selectExpiredBackups,
} from "./resilience-tooling.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function manifest() {
  return {
    schemaVersion: "zpp-backup-manifest-v1",
    backupId: "10000000-0000-4000-8000-000000000001",
    createdAt: "2026-09-23T10:00:00.000Z",
    completedAt: "2026-09-23T10:01:00.000Z",
    archive: { fileName: "zpp-connect-2026-09-23T10-00-00.000Z-abcdef123456.backup.dump", format: "postgres-custom", sizeBytes: 42, sha256: "a".repeat(64) },
    application: { name: "zpp-connect", version: "0.1.0" },
    source: { databaseIdentitySha256: "b".repeat(64) },
    postgres: { serverVersion: "16.4", serverMajor: 16, pgDumpVersion: "pg_dump (PostgreSQL) 16.4", pgDumpMajor: 16 },
    migrations: [{ migrationName: "20260701000000_baseline", checksum: "checksum", finishedAt: "2026-09-23T09:00:00.000Z" }],
    criticalCounts: { users: 1, roles: 1, sessions: 1, documents: 1, documentVersions: 1, auditLogs: 1, dictionaries: 1, afterActionReports: 1, afterActionReportVersions: 1, afterActionPdfArtifacts: 1 },
  };
}

describe("Stage 23 resilience tooling", () => {
  it("validates a strict secret-free backup manifest", () => {
    expect(backupManifestSchema.parse(manifest())).toEqual(manifest());
    expect(() => backupManifestSchema.parse({ ...manifest(), databaseUrl: "postgresql://secret" })).toThrow();
  });

  it("calculates deterministic SHA-256 for exact artifact bytes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zpp-stage23-unit-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "artifact");
    await writeFile(file, Buffer.from("stage-23"));
    expect(await fileSha256(file)).toBe("4ca0210bb455e0fa9afa4ffd1170f694bbe59e6d3913a32ba28fb99a63ef93cc");
  });

  it("requires both Prisma migration names and checksums to match", () => {
    const applied = [{ migrationName: "001_initial", checksum: "sha-001" }];
    expect(migrationIdentitiesMatch(applied, [{ migrationName: "001_initial", checksum: "sha-001" }])).toBe(true);
    expect(migrationIdentitiesMatch(applied, [{ migrationName: "001_initial", checksum: "changed" }])).toBe(false);
    expect(migrationIdentitiesMatch(applied, [{ migrationName: "002_other", checksum: "sha-001" }])).toBe(false);
  });

  it("maps a PostgreSQL URL to native-client environment without putting a URL in command arguments", () => {
    const parsed = parsePostgresConnection("postgresql://operator:s3cret@DB.EXAMPLE:5544/zpp_connect?schema=public&sslmode=require", {});
    expect(parsed.databaseName).toBe("zpp_connect");
    expect(parsed.nativeEnv).toMatchObject({ PGHOST: "db.example", PGPORT: "5544", PGUSER: "operator", PGPASSWORD: "s3cret", PGDATABASE: "zpp_connect", PGSSLMODE: "require" });
    expect(parsed.identitySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.identitySha256).not.toContain("s3cret");
  });

  it("rejects invalid connection URLs and unsafe database names", () => {
    expect(() => parsePostgresConnection("https://example.test/db")).toThrow(/postgres/);
    expect(() => parsePostgresConnection("postgresql://user@host/")).toThrow(/database/);
    expect(() => databaseUrlForName("postgresql://user@host/admin", "unsafe-name")).toThrow(/Unsafe/);
    expect(databaseUrlForName("postgresql://user@host/admin?schema=public", "zpp_stage23_restore_ok")).toContain("/zpp_stage23_restore_ok");
  });

  it("parses and enforces PostgreSQL tool compatibility", () => {
    expect(parsePostgresToolVersion("pg_dump (PostgreSQL) 16.14 (Homebrew)")).toEqual({ raw: "pg_dump (PostgreSQL) 16.14 (Homebrew)", major: 16 });
    expect(() => assertDumpCompatibility(15, 16)).toThrow(/newer/);
    expect(() => assertDumpCompatibility(16, 16)).not.toThrow();
    expect(() => assertRestoreCompatibility(17, 16)).toThrow(/does not match/);
    expect(() => assertRestoreCompatibility(16, 16)).not.toThrow();
  });

  it("requires explicit environment values and positive policy integers", () => {
    expect(requiredEnv({ BACKUP_DIR: "/safe" }, "BACKUP_DIR")).toBe("/safe");
    expect(() => requiredEnv({}, "BACKUP_DIR")).toThrow(/required/);
    expect(positiveIntegerEnv({}, "DAYS", 35)).toBe(35);
    expect(() => positiveIntegerEnv({ DAYS: "0" }, "DAYS", 35)).toThrow(/positive/);
  });

  it("refuses manifest path traversal", () => {
    expect(resolveDirectChild("/tmp/backups", "valid.backup.dump")).toBe("/tmp/backups/valid.backup.dump");
    expect(() => resolveDirectChild("/tmp/backups", "../outside")).toThrow(/unsafe|direct child/);
    expect(() => resolveDirectChild("/tmp/backups", "/tmp/outside")).toThrow(/unsafe|direct child/);
  });

  it("redacts connection credentials from operational errors", () => {
    const url = "postgresql://operator:s3cret@db.example/zpp";
    const redacted = redactOperationalError(`failed for ${url}; token=s3cret`, { DATABASE_URL: url, PGPASSWORD: "s3cret" });
    expect(redacted).not.toContain("s3cret");
    expect(redacted).not.toContain(url);
    expect(redacted).toContain("[REDACTED]");
  });

  it("selects only expired pairs while preserving the configured newest minimum", () => {
    const candidate = (name: string, date: string) => ({ manifestPath: `/safe/${name}.json`, archivePath: `/safe/${name}.dump`, createdAt: new Date(date) });
    const rows = [
      candidate("new", "2026-09-25T00:00:00Z"),
      candidate("kept-minimum", "2026-08-01T00:00:00Z"),
      candidate("expired", "2026-07-01T00:00:00Z"),
    ];
    expect(selectExpiredBackups(rows, new Date("2026-09-26T00:00:00Z"), 35, 2).map((row) => path.basename(row.manifestPath))).toEqual(["expired.json"]);
    expect(rows).toHaveLength(3);
  });
});
