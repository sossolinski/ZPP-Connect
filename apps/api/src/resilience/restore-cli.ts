import { assertIntegrity } from "./integrity-checker.js";
import { positiveIntegerEnv, requiredEnv, restoreBackup, runCli } from "./resilience-tooling.js";

await runCli("restore_verify", async () => {
  const restoreDatabaseUrl = requiredEnv(process.env, "RESTORE_DATABASE_URL");
  const result = await restoreBackup({
    manifestPath: requiredEnv(process.env, "BACKUP_MANIFEST_PATH"),
    restoreDatabaseUrl,
    allowAnyEmptyDatabase: process.env.RESTORE_ALLOW_ANY_EMPTY_DATABASE === "true",
    runIntegrity: (databaseUrl) => assertIntegrity(databaseUrl, positiveIntegerEnv(process.env, "INTEGRITY_MAX_ROWS", 10_000)),
  });
  return { backupId: result.manifest.backupId, targetDatabase: new URL(restoreDatabaseUrl).pathname.slice(1), criticalCounts: result.manifest.criticalCounts };
});
