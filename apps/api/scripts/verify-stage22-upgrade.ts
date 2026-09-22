import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { createPrismaExerciseService } from "../src/modules/exercise/prisma-exercise-service.js";

// Run only on an explicitly disposable, already migrated/seeded Stage 21 database.
// The caller owns creation and cleanup; this script never drops a database.
const url = process.env.STAGE22_REHEARSAL_DATABASE_URL;
if (!url || !/^(zpp_stage22_upgrade_[a-z0-9_]+|zpp_backfill_test)$/.test(new URL(url).pathname.slice(1))) {
  throw new Error("An explicitly named disposable Stage 22 upgrade database is required");
}
const db = new PrismaClient({ datasources: { db: { url } } });
try {
  const migrations = await db.$queryRaw<Array<{ migration_name: string }>>`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`;
  assert.equal(migrations.length, 22);
  assert.equal(migrations.at(-1)!.migration_name, "20260825180000_dictionary_configuration_integrity");
  const actor = await db.user.findUniqueOrThrow({ where: { email: "coordinator@lot.pl" }, select: { id: true, email: true, displayName: true } });
  const marker = "F22-UPGRADE-" + randomUUID().slice(0, 8);
  const session = await db.session.create({ data: { operationalId: marker, mode: "EXERCISE", status: "Active", eventType: "Exercise", createdById: actor.id } });
  await db.incidentAssignment.create({ data: { incidentId: session.id, userId: actor.id, function: marker, createdById: actor.id } });
  await createPrismaExerciseService(db).createObservation({ sessionId: session.id, operationId: randomUUID(), area: "Coordination", severity: "Low", observation: "Preserve observation evidence", recommendation: "Preserve historical advice", owner: null, includeInAar: true, status: "Open" }, actor);
  await db.operationalBriefing.create({ data: { id: marker + "-BRIEFING", sessionId: session.id, revision: 1, status: "Published", title: "Upgrade briefing", situationSummary: "Stage 15 evidence", createdById: actor.id, updatedById: actor.id, publishedById: actor.id, publishedAt: new Date() } });
  await db.exportGeneration.create({ data: { operationId: randomUUID(), commandFingerprint: "a".repeat(64), incidentId: session.id, exportType: "passenger-register", format: "csv", schemaVersion: "stage17-v1", fileName: marker + ".csv", contentSha256: "b".repeat(64), contentSizeBytes: 123, rowCount: 1, sectionCounts: { Session: 1 }, includedSections: ["Session"], preparedById: actor.id } });
  await db.importBatch.create({ data: { operationalId: marker + "-IMPORT", sessionId: session.id, importType: "manifest", sourceFilename: marker + ".csv", status: "Validated", totalRecords: 1, validRecords: 1, createdById: actor.id, validatedById: actor.id, validatedAt: new Date() } });
  await db.session.update({ where: { id: session.id }, data: { status: "Closed", endAt: new Date() } });
  const tables = await db.$queryRaw<Array<{ tablename: string }>>`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('_prisma_migrations','Role') ORDER BY tablename`;
  async function snapshot() {
    const result: Record<string, { count: string; digest: string }> = {};
    for (const { tablename } of tables) {
      const quoted = '"' + tablename.replaceAll('"', '""') + '"';
      const [row] = await db.$queryRawUnsafe<Array<{ count: bigint; digest: string }>>('SELECT count(*) AS count, md5(COALESCE(string_agg(to_jsonb(t)::text, chr(10) ORDER BY to_jsonb(t)::text), \'\')) AS digest FROM ' + quoted + ' t');
      result[tablename] = { count: String(row!.count), digest: row!.digest };
    }
    return result;
  }
  const before = await snapshot(), roles = await db.role.findMany({ orderBy: { id: "asc" } });
  execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["prisma", "migrate", "deploy", "--schema", "apps/api/prisma/schema.prisma"], { cwd: fileURLToPath(new URL("../../../", import.meta.url)), env: { ...process.env, DATABASE_URL: url }, stdio: "inherit" });
  assert.deepEqual(await snapshot(), before, "Every predecessor table row, ID, timestamp and digest must survive byte-for-byte");
  const afterRoles = await db.role.findMany({ orderBy: { id: "asc" } });
  const grants = ["aar:read", "aar:create", "aar:update-draft", "aar:review", "aar:approve", "aar:archive", "aar:pdf:generate"];
  for (const [index, old] of roles.entries()) {
    const expected = ["zpp-coordinator", "tec-coordinator"].includes(old.normalizedName) && !old.custom
      ? { ...old, permissions: [...old.permissions as string[], ...grants] } : old;
    assert.deepEqual(afterRoles[index], expected, "Only coordinator permission additions are permitted");
  }
  for (const table of ["AfterActionReport", "AfterActionReportVersion", "AfterActionFinding", "AfterActionLesson", "AfterActionCorrectiveAction", "AfterActionPdfArtifact", "AfterActionOperation"]) {
    const [row] = await db.$queryRawUnsafe<Array<{ n: bigint }>>('SELECT count(*) AS n FROM "' + table + '"');
    assert.equal(Number(row!.n), 0, "No fabricated AAR history");
  }
  console.log(JSON.stringify({ result: "PASS", predecessorMigrations: 22, currentMigrations: 23, unchangedTables: tables.length, rows: before, rolePolicy: "Only two built-in coordinator grants", syntheticAarRows: 0 }, null, 2));
} finally {
  await db.$disconnect();
}
