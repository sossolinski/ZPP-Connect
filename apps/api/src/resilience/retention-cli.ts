import { applyBackupRetention, positiveIntegerEnv, requiredEnv, runCli } from "./resilience-tooling.js";

await runCli("backup_retention", async () => applyBackupRetention({
  backupDir: requiredEnv(process.env, "BACKUP_DIR"),
  retentionDays: positiveIntegerEnv(process.env, "BACKUP_RETENTION_DAYS", 35),
  minimumCount: positiveIntegerEnv(process.env, "BACKUP_RETENTION_MIN_COUNT", 7),
  apply: process.env.BACKUP_RETENTION_APPLY === "true",
}));
