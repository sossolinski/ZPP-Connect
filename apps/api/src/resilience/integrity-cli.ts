import { assertIntegrity } from "./integrity-checker.js";
import { positiveIntegerEnv, requiredEnv, runCli } from "./resilience-tooling.js";

await runCli("integrity_check", async () => {
  const report = await assertIntegrity(requiredEnv(process.env, "DATABASE_URL"), positiveIntegerEnv(process.env, "INTEGRITY_MAX_ROWS", 10_000));
  return { checkedAt: report.checkedAt, counts: report.counts, failures: report.failures.length, limit: report.limit };
});
