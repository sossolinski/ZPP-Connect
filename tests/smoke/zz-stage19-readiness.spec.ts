import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { clearAuthSession, login } from "./helpers";

const databaseUrl = process.env.DATABASE_URL;
const apiUrl = process.env.PLAYWRIGHT_API_URL ?? `http://127.0.0.1:${Number(process.env.PLAYWRIGHT_API_PORT ?? 4100)}/api`;
const prisma = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;
const marker = `F19-BROWSER-${Date.now()}`;
const memberIds = Array.from({ length: 55 }, (_, index) => `${marker.toLowerCase()}-member-${String(index + 1).padStart(3, "0")}`);
const groupId = `${marker.toLowerCase()}-group`;
const userIds: string[] = [];
const roleIds: string[] = [];
let incidentId = "";
let courseId = "";
let requirementId = "";
let summaryEmail = "";
let scopedEmail = "";
let unauthorizedEmail = "";

async function createActor(suffix: string, permissions: string[], scopeType: "GLOBAL" | "GROUP" = "GLOBAL") {
  const coordinator = await prisma!.user.findUniqueOrThrow({ where: { email: "coordinator@lot.pl" }, select: { id: true } });
  const email = `${marker.toLowerCase()}-${suffix}@example.test`;
  const role = await prisma!.role.create({ data: { name: `${marker.toLowerCase()}-${suffix}`, normalizedName: `${marker.toLowerCase()}-${suffix}`, displayName: `${marker} ${suffix}`, permissions, scopeTypes: [scopeType], custom: true } });
  const user = await prisma!.user.create({ data: { email, normalizedEmail: email, displayName: `${marker} ${suffix}`, status: "Active", authenticationPolicy: "SSO_ONLY", roles: { create: { roleId: role.id, scopeType, assignedBy: coordinator.id } } } });
  roleIds.push(role.id); userIds.push(user.id);
  return { user, role };
}

test.beforeAll(async () => {
  test.skip(!prisma, "PostgreSQL Stage 19 browser database is required");
  const coordinator = await prisma!.user.findUniqueOrThrow({ where: { email: "coordinator@lot.pl" }, select: { id: true } });
  incidentId = (await prisma!.session.create({ data: { operationalId: `${marker}-SESSION`, mode: "EXERCISE", status: "Active", eventType: marker, createdById: coordinator.id } })).id;
  await prisma!.operationalGroup.create({ data: { id: groupId, operationalId: `${marker}-GROUP`, incidentId, name: `${marker} Group`, pool: "ZPP", functionName: "Readiness", status: "Active", createdById: coordinator.id } });
  await prisma!.memberProfile.createMany({ data: memberIds.map((id, index) => ({ id, memberId: `${marker}-MEM-${String(index + 1).padStart(3, "0")}`, firstName: marker, lastName: `Member ${String(index + 1).padStart(3, "0")}`, pool: "ZPP", role: "Member", assignedFunction: "Readiness", languages: ["PL"], status: "Active", createdById: coordinator.id })) });
  await prisma!.groupMembership.createMany({ data: memberIds.map((memberProfileId, index) => ({ id: `${marker}-GMB-${index + 1}`, groupId, memberProfileId, role: "Member", addedById: coordinator.id })) });
  courseId = `${marker}-COURSE`; requirementId = `${marker}-TREQ`;
  await prisma!.trainingCourse.create({ data: { id: courseId, code: `${marker}-COURSE`, normalizedCode: `${marker.toLowerCase()}-course`, title: `${marker} Required Training`, category: "Readiness", deliveryType: "E-learning", active: true } });
  await prisma!.trainingRequirement.create({ data: { id: requirementId, courseId, targetType: "MemberProfile", memberProfileId: memberIds[54], requiredStatus: "Required", dueAt: new Date("2026-08-01T00:00:00.000Z"), active: true } });

  const summary = await createActor("summary", ["session:read", "readiness:read-summary"]); summaryEmail = summary.user.email;
  const scoped = await createActor("scoped", ["session:read", "readiness:read-own", "readiness:read-group", "readiness:read-summary"], "GROUP"); scopedEmail = scoped.user.email;
  await prisma!.memberProfile.update({ where: { id: memberIds[0] }, data: { linkedUserId: scoped.user.id } });
  await prisma!.groupRoleAssignment.create({ data: { id: `${marker}-GRA`, userId: scoped.user.id, roleId: scoped.role.id, groupId, assignedBy: coordinator.id } });
  await prisma!.incidentAssignment.create({ data: { incidentId, userId: scoped.user.id, function: marker, createdById: coordinator.id } });
  const unauthorized = await createActor("unauthorized", ["session:read"]); unauthorizedEmail = unauthorized.user.email;
});

test.afterAll(async () => {
  if (!prisma) return;
  await prisma!.memberTrainingRecord.deleteMany({ where: { memberProfileId: { in: memberIds } } });
  await prisma!.trainingRequirement.deleteMany({ where: { id: requirementId } });
  await prisma!.trainingCourse.deleteMany({ where: { id: courseId } });
  await prisma!.groupRoleAssignment.deleteMany({ where: { userId: { in: userIds } } });
  await prisma!.groupMembership.deleteMany({ where: { memberProfileId: { in: memberIds } } });
  await prisma!.memberProfile.deleteMany({ where: { id: { in: memberIds } } });
  await prisma!.operationalGroup.deleteMany({ where: { id: groupId } });
  await prisma!.incidentAssignment.deleteMany({ where: { OR: [{ incidentId }, { userId: { in: userIds } }] } });
  await prisma!.session.deleteMany({ where: { id: incidentId } });
  await prisma!.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await prisma!.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma!.role.deleteMany({ where: { id: { in: roleIds } } });
  await prisma!.$disconnect();
});

test("uses server paging, complete filters, detail-on-demand, safe next actions and stale-request protection", async ({ page }) => {
  await login(page, "coordinator@lot.pl");
  await page.goto("/readiness");
  await expect(page.getByRole("heading", { name: "Readiness management" })).toBeVisible();
  await expect(page.getByText(/Members 1–50 of/)).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText(/Members 51–/)).toBeVisible();

  await page.getByLabel("Find readiness group").fill(marker);
  await page.getByLabel("Group", { exact: true }).selectOption(groupId);
  await page.getByLabel("Status").selectOption("Not ready");
  await page.getByLabel("Search").fill(`${marker} Member 055`);
  const row = page.getByRole("row").filter({ hasText: `${marker} Member 055` });
  await expect(row).toContainText("Not ready");
  const detailResponse = page.waitForResponse((response) => response.url().includes(`/api/readiness/members/${memberIds[54]}`) && response.request().method() === "GET");
  await row.getByRole("button", { name: "View" }).click();
  expect((await detailResponse).status()).toBe(200);
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByText(`${marker} Required Training`)).toBeVisible();
  await drawer.getByRole("link", { name: /Open training/ }).click();
  await expect(page).toHaveURL(/\/training/);

  await page.goto("/readiness");
  await page.route("**/api/readiness/members?**", async (route) => {
    const search = new URL(route.request().url()).searchParams.get("search");
    if (search === "slow-no-match") await new Promise((resolve) => setTimeout(resolve, 700));
    await route.continue();
  });
  await page.getByLabel("Search").fill("slow-no-match");
  await page.getByLabel("Search").fill(`${marker} Member 055`);
  await expect(page.getByRole("row").filter({ hasText: `${marker} Member 055` })).toBeVisible();
  await page.waitForTimeout(900);
  await expect(page.getByRole("row").filter({ hasText: `${marker} Member 055` })).toBeVisible();

  await prisma!.trainingRequirement.update({ where: { id: requirementId }, data: { active: false, effectiveTo: new Date() } });
  await page.getByRole("button", { name: "Refresh" }).click();
  const refreshedRow = page.getByRole("row").filter({ hasText: `${marker} Member 055` });
  await expect(refreshedRow).toBeVisible();
  await refreshedRow.getByRole("button", { name: "View" }).click();
  await expect(page.getByRole("dialog").getByText(`${marker} Required Training`)).toHaveCount(0);
});

test("shows own readiness and restricts summary-only, GROUP-scoped and unauthorized actors", async ({ page }) => {
  await login(page, scopedEmail);
  await page.goto("/readiness");
  await expect(page.getByRole("heading", { name: "My readiness" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Readiness management" })).toBeVisible();
  await page.getByLabel("Find readiness group").fill(marker);
  await expect(page.getByLabel("Group", { exact: true }).locator(`option[value="${groupId}"]`)).toHaveCount(1);

  await clearAuthSession(page);
  await login(page, summaryEmail);
  await page.goto("/readiness");
  await expect(page.getByText("Not ready", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Readiness management" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "My readiness" })).toHaveCount(0);

  await clearAuthSession(page);
  await login(page, unauthorizedEmail);
  const denied = await page.request.get(`${apiUrl}/readiness/summary`, { headers: { "x-user-email": unauthorizedEmail } });
  expect(denied.status()).toBe(403);
  await page.goto("/readiness");
  await expect(page.getByRole("heading", { name: "Readiness management" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "My readiness" })).toHaveCount(0);
});
