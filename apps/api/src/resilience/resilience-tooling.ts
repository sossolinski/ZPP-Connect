import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";

export const manifestSchemaVersion = "zpp-backup-manifest-v1" as const;
export const backupArchiveSuffix = ".backup.dump";
export const backupManifestSuffix = ".backup.manifest.json";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const migrationSchema = z.object({
  migrationName: z.string().min(1).max(300),
  checksum: z.string().min(1).max(200),
  finishedAt: z.string().datetime(),
}).strict();

export const criticalCountKeys = [
  "users", "roles", "sessions", "documents", "documentVersions", "auditLogs",
  "dictionaries", "afterActionReports", "afterActionReportVersions", "afterActionPdfArtifacts",
] as const;

const criticalCountsSchema = z.object({
  users: z.number().int().nonnegative(),
  roles: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
  documents: z.number().int().nonnegative(),
  documentVersions: z.number().int().nonnegative(),
  auditLogs: z.number().int().nonnegative(),
  dictionaries: z.number().int().nonnegative(),
  afterActionReports: z.number().int().nonnegative(),
  afterActionReportVersions: z.number().int().nonnegative(),
  afterActionPdfArtifacts: z.number().int().nonnegative(),
}).strict();

export const backupManifestSchema = z.object({
  schemaVersion: z.literal(manifestSchemaVersion),
  backupId: z.string().uuid(),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  archive: z.object({
    fileName: z.string().regex(/^zpp-connect-[0-9TZ.-]+-[a-f0-9]{12}\.backup\.dump$/),
    format: z.literal("postgres-custom"),
    sizeBytes: z.number().int().positive(),
    sha256: sha256Schema,
  }).strict(),
  application: z.object({ name: z.literal("zpp-connect"), version: z.string().min(1).max(100) }).strict(),
  source: z.object({ databaseIdentitySha256: sha256Schema }).strict(),
  postgres: z.object({
    serverVersion: z.string().min(1).max(200),
    serverMajor: z.number().int().positive(),
    pgDumpVersion: z.string().min(1).max(200),
    pgDumpMajor: z.number().int().positive(),
  }).strict(),
  migrations: z.array(migrationSchema).min(1),
  criticalCounts: criticalCountsSchema,
}).strict();

export type BackupManifest = z.infer<typeof backupManifestSchema>;
export type CriticalCounts = BackupManifest["criticalCounts"];

type CommandResult = { stdout: string; stderr: string };

export type PostgresConnection = {
  databaseName: string;
  identitySha256: string;
  nativeEnv: NodeJS.ProcessEnv;
};

export function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

export function requiredEnv(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function positiveIntegerEnv(env: NodeJS.ProcessEnv, name: string, fallback: number) {
  const raw = env[name]?.trim();
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function parsePostgresConnection(databaseUrl: string, baseEnv: NodeJS.ProcessEnv = process.env): PostgresConnection {
  let parsed: URL;
  try { parsed = new URL(databaseUrl); }
  catch { throw new Error("PostgreSQL connection URL is invalid"); }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error("PostgreSQL connection URL must use postgres:// or postgresql://");
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName || databaseName.includes("/")) throw new Error("PostgreSQL connection URL must identify one database");
  if (!parsed.hostname || !parsed.username) throw new Error("PostgreSQL connection URL must include host and user");
  const port = parsed.port || "5432";
  const nativeEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    PGHOST: parsed.hostname.toLowerCase(),
    PGPORT: port,
    PGUSER: decodeURIComponent(parsed.username),
    PGDATABASE: databaseName,
    PGCONNECT_TIMEOUT: baseEnv.PGCONNECT_TIMEOUT ?? "10",
    PGAPPNAME: "zpp-connect-stage23",
  };
  if (parsed.password) nativeEnv.PGPASSWORD = decodeURIComponent(parsed.password);
  const sslMode = parsed.searchParams.get("sslmode");
  if (sslMode) nativeEnv.PGSSLMODE = sslMode;
  return {
    databaseName,
    identitySha256: sha256(`${parsed.hostname.toLowerCase()}:${port}/${databaseName}/${decodeURIComponent(parsed.username)}`),
    nativeEnv,
  };
}

export function databaseUrlForName(databaseUrl: string, databaseName: string) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(databaseName)) throw new Error("Unsafe PostgreSQL database name");
  const parsed = new URL(databaseUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

export async function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv = process.env, maxOutputBytes = 1024 * 1024): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const append = (current: string, chunk: Buffer) => {
      const next = current + chunk.toString("utf8");
      return next.length > maxOutputBytes ? next.slice(-maxOutputBytes) : next;
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.on("error", (error) => reject(new Error(`${command} could not start: ${error.message}`)));
    child.on("close", (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} failed (${signal ?? `exit ${code ?? "unknown"}`}): ${stderr.trim() || "no diagnostic output"}`));
    });
  });
}

export function parsePostgresToolVersion(output: string) {
  const match = output.match(/(?:PostgreSQL\)?\s+)(\d+)(?:\.(\d+))?/i);
  if (!match) throw new Error(`Unable to parse PostgreSQL tool version: ${output.trim()}`);
  return { raw: output.trim(), major: Number(match[1]) };
}

export function assertDumpCompatibility(clientMajor: number, serverMajor: number) {
  if (clientMajor < serverMajor) throw new Error(`pg_dump major ${clientMajor} cannot safely dump newer PostgreSQL server major ${serverMajor}`);
}

export function assertRestoreCompatibility(restoreMajor: number, producerMajor: number) {
  if (restoreMajor !== producerMajor) throw new Error(`pg_restore major ${restoreMajor} does not match backup producer major ${producerMajor}; rehearse with matching tools`);
}

export async function fileSha256(filePath: string) {
  return sha256(await readFile(filePath));
}

export function resolveDirectChild(parentDirectory: string, fileName: string) {
  if (path.basename(fileName) !== fileName || fileName === "." || fileName === "..") throw new Error("Backup manifest contains an unsafe archive filename");
  const parent = path.resolve(parentDirectory);
  const candidate = path.resolve(parent, fileName);
  if (path.dirname(candidate) !== parent) throw new Error("Backup archive must be a direct child of its manifest directory");
  return candidate;
}

async function assertPrivateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("BACKUP_DIR must be a real directory, not a symlink");
  await chmod(directory, 0o700);
}

async function toolVersion(command: "pg_dump" | "pg_restore" | "psql") {
  return parsePostgresToolVersion((await runCommand(command, ["--version"])).stdout);
}

type MigrationRow = { migration_name: string; checksum: string; finished_at: Date | string | null; rolled_back_at: Date | string | null };

export async function migrationState(db: PrismaClient | Prisma.TransactionClient) {
  const rows = await db.$queryRawUnsafe<MigrationRow[]>(
    `SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY started_at, migration_name`,
  );
  const invalid = rows.filter((row) => !row.finished_at || row.rolled_back_at);
  if (invalid.length) throw new Error(`Database has ${invalid.length} incomplete or rolled-back Prisma migration(s)`);
  return rows.map((row) => ({
    migrationName: row.migration_name,
    checksum: row.checksum,
    finishedAt: new Date(row.finished_at!).toISOString(),
  }));
}

export async function criticalCounts(db: PrismaClient | Prisma.TransactionClient): Promise<CriticalCounts> {
  const [users, roles, sessions, documents, documentVersions, auditLogs, dictionaries, afterActionReports, afterActionReportVersions, afterActionPdfArtifacts] = await Promise.all([
    db.user.count(), db.role.count(), db.session.count(), db.document.count(), db.documentVersion.count(),
    db.auditLog.count(), db.dictionary.count(), db.afterActionReport.count(), db.afterActionReportVersion.count(), db.afterActionPdfArtifact.count(),
  ]);
  return { users, roles, sessions, documents, documentVersions, auditLogs, dictionaries, afterActionReports, afterActionReportVersions, afterActionPdfArtifacts };
}

async function serverVersion(db: PrismaClient | Prisma.TransactionClient) {
  const rows = await db.$queryRawUnsafe<Array<{ server_version: string; server_version_num: string }>>(
    `SELECT current_setting('server_version') AS server_version, current_setting('server_version_num') AS server_version_num`,
  );
  const row = rows[0];
  if (!row) throw new Error("PostgreSQL server version query returned no result");
  return { raw: row.server_version, major: Math.floor(Number(row.server_version_num) / 10000) };
}

function safeTimestamp(date: Date) {
  return date.toISOString().replace(/[:]/g, "-");
}

export async function createBackup(options: { databaseUrl: string; backupDir: string; applicationVersion?: string; now?: Date }) {
  const startedAt = options.now ?? new Date();
  const connection = parsePostgresConnection(options.databaseUrl);
  const backupDir = path.resolve(options.backupDir);
  await assertPrivateDirectory(backupDir);
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const stem = `zpp-connect-${safeTimestamp(startedAt)}-${suffix}`;
  const archiveFileName = stem + backupArchiveSuffix;
  const manifestFileName = stem + backupManifestSuffix;
  const archivePath = resolveDirectChild(backupDir, archiveFileName);
  const manifestPath = resolveDirectChild(backupDir, manifestFileName);
  const archiveTemporaryPath = resolveDirectChild(backupDir, `.${archiveFileName}.partial`);
  const manifestTemporaryPath = resolveDirectChild(backupDir, `.${manifestFileName}.partial`);
  const dumpVersion = await toolVersion("pg_dump");
  const db = new PrismaClient({ datasources: { db: { url: options.databaseUrl } } });
  let archivePublished = false;
  try {
    const snapshot = await db.$transaction(async (tx) => {
      const server = await serverVersion(tx);
      assertDumpCompatibility(dumpVersion.major, server.major);
      const rows = await tx.$queryRawUnsafe<Array<{ snapshot_id: string }>>(`SELECT pg_export_snapshot() AS snapshot_id`);
      const snapshotId = rows[0]?.snapshot_id;
      if (!snapshotId) throw new Error("PostgreSQL did not export a backup snapshot");
      const [migrations, counts] = await Promise.all([migrationState(tx), criticalCounts(tx)]);
      await runCommand("pg_dump", [
        "--format=custom", "--compress=6", "--no-owner", "--no-privileges",
        `--snapshot=${snapshotId}`, `--file=${archiveTemporaryPath}`,
      ], connection.nativeEnv);
      return { server, migrations, counts };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 30_000, timeout: 10 * 60_000 });

    await chmod(archiveTemporaryPath, 0o600);
    const archiveInfo = await stat(archiveTemporaryPath);
    if (!archiveInfo.isFile() || archiveInfo.size < 1) throw new Error("pg_dump produced an empty or invalid archive");
    await runCommand("pg_restore", ["--list", archiveTemporaryPath]);
    const manifest: BackupManifest = {
      schemaVersion: manifestSchemaVersion,
      backupId: randomUUID(),
      createdAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      archive: { fileName: archiveFileName, format: "postgres-custom", sizeBytes: archiveInfo.size, sha256: await fileSha256(archiveTemporaryPath) },
      application: { name: "zpp-connect", version: options.applicationVersion ?? "0.1.0" },
      source: { databaseIdentitySha256: connection.identitySha256 },
      postgres: { serverVersion: snapshot.server.raw, serverMajor: snapshot.server.major, pgDumpVersion: dumpVersion.raw, pgDumpMajor: dumpVersion.major },
      migrations: snapshot.migrations,
      criticalCounts: snapshot.counts,
    };
    backupManifestSchema.parse(manifest);
    await writeFile(manifestTemporaryPath, JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(archiveTemporaryPath, archivePath);
    archivePublished = true;
    await rename(manifestTemporaryPath, manifestPath);
    return { manifest, manifestPath, archivePath };
  } catch (error) {
    await Promise.allSettled([
      rm(archiveTemporaryPath, { force: true }),
      rm(manifestTemporaryPath, { force: true }),
      ...(archivePublished ? [rm(archivePath, { force: true })] : []),
    ]);
    throw error;
  } finally {
    await db.$disconnect();
  }
}

export async function readBackupManifest(manifestPath: string) {
  const absoluteManifestPath = path.resolve(manifestPath);
  const info = await lstat(absoluteManifestPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Backup manifest must be a regular file, not a symlink");
  const parsed = backupManifestSchema.parse(JSON.parse(await readFile(absoluteManifestPath, "utf8")));
  return { manifest: parsed, manifestPath: absoluteManifestPath, archivePath: resolveDirectChild(path.dirname(absoluteManifestPath), parsed.archive.fileName) };
}

export async function verifyBackup(manifestPath: string) {
  const { manifest, manifestPath: absoluteManifestPath, archivePath } = await readBackupManifest(manifestPath);
  const archiveInfo = await lstat(archivePath);
  if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink()) throw new Error("Backup archive must be a regular file, not a symlink");
  if (archiveInfo.size !== manifest.archive.sizeBytes) throw new Error("Backup archive size does not match its manifest");
  if (await fileSha256(archivePath) !== manifest.archive.sha256) throw new Error("Backup archive SHA-256 does not match its manifest");
  const restoreVersion = await toolVersion("pg_restore");
  assertRestoreCompatibility(restoreVersion.major, manifest.postgres.pgDumpMajor);
  const catalog = await runCommand("pg_restore", ["--list", archivePath]);
  if (!/TABLE DATA|SCHEMA|DATABASE/i.test(catalog.stdout)) throw new Error("Backup archive catalog contains no restorable database objects");
  return { manifest, manifestPath: absoluteManifestPath, archivePath, pgRestoreVersion: restoreVersion.raw };
}

export async function repositoryMigrationNames() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), "apps/api/prisma/migrations"),
    path.resolve(process.cwd(), "prisma/migrations"),
    path.resolve(here, "../../prisma/migrations"),
    path.resolve(here, "../../../prisma/migrations"),
  ];
  for (const candidate of candidates) {
    try {
      const entries = await readdir(candidate, { withFileTypes: true });
      const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
      if (names.length) return names;
    } catch { /* try the next runtime layout */ }
  }
  throw new Error("Unable to locate Prisma migrations directory");
}

export async function restoreBackup(options: {
  manifestPath: string;
  restoreDatabaseUrl: string;
  allowAnyEmptyDatabase?: boolean;
  runIntegrity: (databaseUrl: string) => Promise<unknown>;
}) {
  const verified = await verifyBackup(options.manifestPath);
  const target = parsePostgresConnection(options.restoreDatabaseUrl);
  if (target.identitySha256 === verified.manifest.source.databaseIdentitySha256) throw new Error("Restore target must not be the source database");
  if (!options.allowAnyEmptyDatabase && !target.databaseName.startsWith("zpp_stage23_restore_")) {
    throw new Error("Restore target database name must start with zpp_stage23_restore_");
  }
  const db = new PrismaClient({ datasources: { db: { url: options.restoreDatabaseUrl } } });
  try {
    const existing = await db.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')`,
    );
    if (Number(existing[0]?.count ?? 0) !== 0) throw new Error("Restore target must be empty; existing user tables were found");
  } finally { await db.$disconnect(); }

  await runCommand("pg_restore", ["--exit-on-error", "--no-owner", "--no-privileges", `--dbname=${target.databaseName}`, verified.archivePath], target.nativeEnv, 4 * 1024 * 1024);

  const restored = new PrismaClient({ datasources: { db: { url: options.restoreDatabaseUrl } } });
  try {
    await restored.$queryRawUnsafe(`SELECT 1`);
    const [migrations, counts, repositoryMigrations] = await Promise.all([
      migrationState(restored), criticalCounts(restored), repositoryMigrationNames(),
    ]);
    if (JSON.stringify(migrations) !== JSON.stringify(verified.manifest.migrations)) throw new Error("Restored Prisma migration state does not match backup manifest");
    if (JSON.stringify(migrations.map((item) => item.migrationName).sort()) !== JSON.stringify(repositoryMigrations)) {
      throw new Error("Restored Prisma migrations do not match this application checkout");
    }
    if (JSON.stringify(counts) !== JSON.stringify(verified.manifest.criticalCounts)) throw new Error("Restored critical table counts do not match backup manifest");
  } finally { await restored.$disconnect(); }
  const integrity = await options.runIntegrity(options.restoreDatabaseUrl);
  return { manifest: verified.manifest, integrity };
}

export type RetentionCandidate = { manifestPath: string; archivePath: string; createdAt: Date };

export function selectExpiredBackups(candidates: RetentionCandidate[], now: Date, retentionDays: number, minimumCount: number) {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) throw new Error("retentionDays must be a positive integer");
  if (!Number.isInteger(minimumCount) || minimumCount < 1) throw new Error("minimumCount must be a positive integer");
  const ordered = [...candidates].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.manifestPath.localeCompare(a.manifestPath));
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  return ordered.filter((candidate, index) => index >= minimumCount && candidate.createdAt.getTime() < cutoff);
}

export async function applyBackupRetention(options: { backupDir: string; retentionDays: number; minimumCount: number; apply: boolean; now?: Date }) {
  const backupDir = path.resolve(options.backupDir);
  await assertPrivateDirectory(backupDir);
  const entries = await readdir(backupDir, { withFileTypes: true });
  const candidates: RetentionCandidate[] = [];
  const ignored: string[] = [];
  for (const entry of entries.filter((item) => item.name.endsWith(backupManifestSuffix))) {
    const manifestPath = resolveDirectChild(backupDir, entry.name);
    try {
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("not a regular manifest");
      const verified = await verifyBackup(manifestPath);
      candidates.push({ manifestPath, archivePath: verified.archivePath, createdAt: new Date(verified.manifest.createdAt) });
    } catch {
      ignored.push(entry.name);
    }
  }
  const expired = selectExpiredBackups(candidates, options.now ?? new Date(), options.retentionDays, options.minimumCount);
  if (options.apply) {
    for (const candidate of expired) {
      await unlink(candidate.archivePath);
      await unlink(candidate.manifestPath);
    }
  }
  return {
    apply: options.apply,
    validPairCount: candidates.length,
    selectedPairCount: expired.length,
    selectedManifests: expired.map((item) => path.basename(item.manifestPath)),
    ignored,
  };
}

export function structuredEvent(event: string, status: "success" | "failure", detail: Record<string, unknown> = {}) {
  return JSON.stringify({ timestamp: new Date().toISOString(), component: "stage23-resilience", event, status, ...detail });
}

export function redactOperationalError(message: string, env: NodeJS.ProcessEnv = process.env) {
  let redacted = message.replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, "$1[REDACTED]@");
  for (const name of ["DATABASE_URL", "RESTORE_DATABASE_URL", "STAGE23_ADMIN_DATABASE_URL", "PGPASSWORD"]) {
    const secret = env[name];
    if (secret) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

export async function runCli(event: string, work: () => Promise<Record<string, unknown>>) {
  const started = Date.now();
  try {
    const detail = await work();
    process.stdout.write(structuredEvent(event, "success", { durationMs: Date.now() - started, ...detail }) + "\n");
  } catch (error) {
    const message = redactOperationalError(error instanceof Error ? error.message : "Unknown failure");
    process.stderr.write(structuredEvent(event, "failure", { durationMs: Date.now() - started, error: message }) + "\n");
    process.exitCode = 1;
  }
}
