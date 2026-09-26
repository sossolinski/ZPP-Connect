import { appendFile, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { assertIntegrity } from "./integrity-checker.js";
import { createRecoveryFixture } from "./recovery-fixture.js";
import {
  backupManifestSchema, createBackup, databaseUrlForName, parsePostgresConnection,
  requiredEnv, restoreBackup, runCli, runCommand, verifyBackup,
} from "./resilience-tooling.js";

await runCli("recovery_rehearsal", async () => {
  if (process.env.NODE_ENV !== "test" || process.env.STAGE23_ALLOW_RECOVERY !== "true") {
    throw new Error("Recovery rehearsal requires NODE_ENV=test and STAGE23_ALLOW_RECOVERY=true");
  }
  const adminUrl = requiredEnv(process.env, "STAGE23_ADMIN_DATABASE_URL");
  const admin = parsePostgresConnection(adminUrl);
  const token = randomUUID().replace(/-/g, "").slice(0, 12);
  const sourceName = `zpp_stage23_source_${token}`;
  const restoreName = `zpp_stage23_restore_${token}`;
  const sourceUrl = databaseUrlForName(adminUrl, sourceName);
  const restoreUrl = databaseUrlForName(adminUrl, restoreName);
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "zpp-stage23-recovery-"));
  const createdDatabases: string[] = [];
  try {
    for (const name of [sourceName, restoreName]) {
      await runCommand("createdb", [name], admin.nativeEnv);
      createdDatabases.push(name);
    }
    await runCommand("npm", ["run", "prisma:deploy", "-w", "@zpp/api"], { ...process.env, DATABASE_URL: sourceUrl }, 4 * 1024 * 1024);
    await runCommand("npm", ["run", "prisma:seed", "-w", "@zpp/api"], { ...process.env, DATABASE_URL: sourceUrl }, 4 * 1024 * 1024);

    const sourceDb = new PrismaClient({ datasources: { db: { url: sourceUrl } } });
    let fixture;
    try { fixture = await createRecoveryFixture(sourceDb); }
    finally { await sourceDb.$disconnect(); }

    const backup = await createBackup({ databaseUrl: sourceUrl, backupDir: temporaryDirectory });
    await verifyBackup(backup.manifestPath);
    const restored = await restoreBackup({
      manifestPath: backup.manifestPath,
      restoreDatabaseUrl: restoreUrl,
      runIntegrity: (databaseUrl) => assertIntegrity(databaseUrl),
    });

    const restoredDb = new PrismaClient({ datasources: { db: { url: restoreUrl } } });
    try {
      const [session, report, artifact, audit, document, role, dictionary] = await Promise.all([
        restoredDb.session.findUnique({ where: { id: fixture.sessionId } }),
        restoredDb.afterActionReport.findUnique({ where: { id: fixture.reportId } }),
        restoredDb.afterActionPdfArtifact.findUnique({ where: { id: fixture.artifactId } }),
        restoredDb.auditLog.findFirst({ where: { sessionId: fixture.sessionId, action: "stage23_recovery_fixture_created" } }),
        restoredDb.document.findFirst(), restoredDb.role.findFirst(), restoredDb.dictionary.findFirst(),
      ]);
      if (!session || session.mode !== "REAL" || session.status !== "Closed") throw new Error("Restored REAL Session fixture is missing or invalid");
      if (!report || !audit) throw new Error("Restored AAR or Audit fixture is missing");
      if (!artifact || artifact.contentSha256 !== fixture.artifactSha256 || Number(artifact.contentSizeBytes) !== fixture.artifactSizeBytes) throw new Error("Restored retained PDF fixture is missing or invalid");
      if (!document || !role || !dictionary) throw new Error("Restored canonical Document, Role or Dictionary data is missing");
    } finally { await restoredDb.$disconnect(); }

    const corruptArchiveName = backup.manifest.archive.fileName.replace(/[a-f0-9]{12}\.backup\.dump$/, "ffffffffffff.backup.dump");
    const corruptArchivePath = path.join(temporaryDirectory, corruptArchiveName);
    const corruptManifestPath = path.join(temporaryDirectory, "corrupt.backup.manifest.json");
    await copyFile(backup.archivePath, corruptArchivePath);
    await appendFile(corruptArchivePath, Buffer.from([0x53, 0x32, 0x33]));
    const corruptManifest = backupManifestSchema.parse(JSON.parse(await readFile(backup.manifestPath, "utf8")));
    corruptManifest.archive.fileName = corruptArchiveName;
    await writeFile(corruptManifestPath, JSON.stringify(corruptManifest, null, 2) + "\n", { mode: 0o600 });
    let corruptionDetected = false;
    try { await verifyBackup(corruptManifestPath); }
    catch { corruptionDetected = true; }
    if (!corruptionDetected) throw new Error("Intentional backup corruption was not detected");

    return {
      backupId: backup.manifest.backupId,
      sourceDatabase: sourceName,
      restoreDatabase: restoreName,
      migrations: backup.manifest.migrations.length,
      criticalCounts: backup.manifest.criticalCounts,
      fixture,
      integrityStatus: (restored.integrity as { status?: string }).status,
      corruptionDetected,
    };
  } finally {
    for (const name of [...createdDatabases].reverse()) {
      try { await runCommand("dropdb", ["--if-exists", "--force", name], admin.nativeEnv); }
      catch (error) { process.stderr.write(`Stage 23 cleanup warning for ${name}: ${error instanceof Error ? error.message : "unknown error"}\n`); }
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
