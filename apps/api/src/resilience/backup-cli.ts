import { createBackup, requiredEnv, runCli } from "./resilience-tooling.js";

await runCli("backup", async () => {
  const result = await createBackup({ databaseUrl: requiredEnv(process.env, "DATABASE_URL"), backupDir: requiredEnv(process.env, "BACKUP_DIR") });
  return { backupId: result.manifest.backupId, manifestPath: result.manifestPath, archivePath: result.archivePath, sizeBytes: result.manifest.archive.sizeBytes, sha256: result.manifest.archive.sha256 };
});
