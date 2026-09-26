import { requiredEnv, runCli, verifyBackup } from "./resilience-tooling.js";

await runCli("backup_verify", async () => {
  const result = await verifyBackup(requiredEnv(process.env, "BACKUP_MANIFEST_PATH"));
  return { backupId: result.manifest.backupId, archivePath: result.archivePath, sizeBytes: result.manifest.archive.sizeBytes, sha256: result.manifest.archive.sha256, pgRestoreVersion: result.pgRestoreVersion };
});
