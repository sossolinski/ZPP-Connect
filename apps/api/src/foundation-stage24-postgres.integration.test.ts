import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { permissions } from "@zpp/shared";
import { createSharedApp } from "./test-support/listening-test-app.js";
import { EffectiveAccessService } from "./modules/identity/effective-access-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const pg = databaseUrl ? describe : describe.skip;
const db = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;

pg("Foundation Stage 24 product scope boundary", () => {
  const app = () => createSharedApp();
  const as = (email: string) => ({ "x-user-email": email });

  afterAll(async () => db?.$disconnect());

  it("does not expose retired product routers while retaining technical readiness", async () => {
    const email = "admin@lot.pl";
    for (const path of ["/api/training/courses", "/api/readiness/summary", "/api/exercise/injects"]) {
      expect((await request(app()).get(path).set(as(email))).status).toBe(404);
    }
    expect((await request(app()).get("/api/health/readiness")).status).toBe(200);
  });

  it("removes retired capabilities from the active grant catalogue", async () => {
    expect(Object.keys(permissions).some((key) => /^(training|readiness|exercise):/.test(key))).toBe(false);
    const response = await request(app()).get("/api/admin/capabilities").set(as("admin@lot.pl"));
    expect(response.status).toBe(200);
    expect(response.body.data.some((item: { id: string }) => /^(training|readiness|exercise):/.test(item.id))).toBe(false);
  });

  it("retains legacy schema while ignoring stored retired grants", async () => {
    const tables = await db!.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN (
        'TrainingCourse', 'TrainingRequirement', 'MemberTrainingRecord', 'TrainingOperation',
        'ExerciseInject', 'ExerciseObservation', 'ExerciseObservationRevision'
      )
    `;
    expect(tables.map(({ table_name }) => table_name).sort()).toEqual([
      "ExerciseInject", "ExerciseObservation", "ExerciseObservationRevision", "MemberTrainingRecord",
      "TrainingCourse", "TrainingOperation", "TrainingRequirement"
    ]);

    const suffix = randomUUID();
    const email = `f24-legacy-${suffix}@example.test`;
    const role = await db!.role.create({ data: {
      name: `f24-legacy-${suffix}`,
      normalizedName: `f24-legacy-${suffix}`,
      displayName: "Stage 24 legacy compatibility",
      permissions: ["session:read", "training:read-all", "readiness:read-all", "exercise:manage"],
      custom: true
    } });
    const user = await db!.user.create({ data: {
      email,
      normalizedEmail: email,
      displayName: "Stage 24 legacy grant holder",
      roles: { create: { roleId: role.id, scopeType: "GLOBAL", assignedBy: "stage24-compatibility-test" } }
    } });
    try {
      expect((await new EffectiveAccessService(db!).forUser(user.id))?.permissions).toEqual(["session:read"]);
      const roles = await request(app()).get("/api/admin/roles").query({ search: role.name }).set(as("admin@lot.pl"));
      expect(roles.status).toBe(200);
      expect(roles.body.data.find((item: { id: string }) => item.id === role.id)?.permissions).toEqual(["session:read"]);
    } finally {
      await db!.userRole.deleteMany({ where: { userId: user.id } });
      await db!.user.delete({ where: { id: user.id } });
      await db!.role.delete({ where: { id: role.id } });
    }
  });

  it("accepts only new REAL Sessions and keeps historical modes read-only", async () => {
    const coordinator = await db!.user.findUniqueOrThrow({ where: { email: "coordinator@lot.pl" } });
    const rejected = await request(app()).post("/api/sessions").set(as(coordinator.email)).send({
      mode: "EXERCISE", status: "Draft", eventType: "Aircraft accident",
    });
    expect(rejected.status).toBe(400);

    const historical = await db!.session.create({ data: {
      operationalId: `F24-HIST-${randomUUID()}`, mode: "TRAINING", status: "Draft",
      eventType: "Historical retained event", createdById: coordinator.id,
    } });
    await db!.incidentAssignment.create({ data: { incidentId: historical.id, userId: coordinator.id, function: "Historical review", createdById: coordinator.id } });
    try {
      expect((await request(app()).patch(`/api/sessions/${historical.id}`).set(as(coordinator.email)).send({ description: "mutation", mode: "TRAINING" })).status).toBe(409);
      expect((await request(app()).post(`/api/sessions/${historical.id}/close`).set(as(coordinator.email)).send({ notes: "attempted close" })).status).toBe(409);
      const read = await request(app()).get(`/api/sessions/${historical.id}`).set(as(coordinator.email));
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ id: historical.id, mode: "TRAINING" });
    } finally {
      await db!.incidentAssignment.deleteMany({ where: { incidentId: historical.id } });
      await db!.session.delete({ where: { id: historical.id } });
    }
  });
});
