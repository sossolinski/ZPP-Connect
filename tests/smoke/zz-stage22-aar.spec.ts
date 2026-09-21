import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { login } from "./helpers";

const db = new PrismaClient();
const marker = "F22-BROWSER-" + randomUUID().slice(0, 8);
const apiUrl = process.env.PLAYWRIGHT_API_URL ?? `http://127.0.0.1:${Number(process.env.PLAYWRIGHT_API_PORT ?? 4100)}/api`;
const headers = { "x-user-email": "coordinator@lot.pl" };
let coordinatorId: string;
async function incident(suffix: string, status = "Closed") {
  const s = await db.session.create({ data: { operationalId: marker + "-" + suffix, mode: "EXERCISE", status, eventType: "Exercise", createdById: coordinatorId } });
  await db.incidentAssignment.create({ data: { incidentId: s.id, userId: coordinatorId, function: "AAR browser", createdById: coordinatorId } });
  return s;
}
async function open(page: Page, session: { id: string; operationalId: string }) {
  await login(page, "coordinator@lot.pl");
  await page.goto("/reports");
  await page.getByRole("link", { name: "Open After Action Reports" }).click();
  await page.getByLabel("Search report Sessions").fill(session.operationalId);
  await expect(page.getByLabel("Report Session", { exact: true }).locator("option", { hasText: session.operationalId })).toHaveCount(1);
  await page.getByLabel("Report Session", { exact: true }).selectOption(session.id);
  await expect(page.getByTestId("aar-workspace")).toBeVisible();
}
async function confirm(page: Page, label: string) {
  await page.getByRole("button", { name: label, exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: label, exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}
test.beforeAll(async () => {
  coordinatorId = (await db.user.findUniqueOrThrow({ where: { email: "coordinator@lot.pl" } })).id;
});
// Retained immutable evidence belongs to this disposable PostgreSQL gate.
test.afterAll(async () => { await db.$disconnect(); });

test("authors, approves, downloads exact PDF and revises a Closed Session AAR", async ({ page }) => {
  test.setTimeout(60000);
  const s = await incident("WORKFLOW");
  await open(page, s);
  await page.getByLabel("Report title").fill("Browser After Action Report");
  await page.getByRole("button", { name: "Create report", exact: true }).click();
  await expect(page.getByText("Revision 1", { exact: false }).first()).toBeVisible();
  await page.getByLabel("Executive Summary").fill("Browser executive summary");
  await page.getByRole("button", { name: "Add finding" }).click();
  await page.getByLabel("Finding 1 area").fill("Coordination");
  await page.getByLabel("Finding 1 summary").fill("Browser finding");
  await page.getByRole("button", { name: "Add lesson" }).click();
  await page.getByLabel("Lesson 1", { exact: true }).fill("Browser lesson");
  await page.getByRole("button", { name: "Add recommendation" }).click();
  await page.getByLabel("Recommendation 1").fill("Browser recommendation");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("button", { name: "Submit for review" })).toBeEnabled();
  await confirm(page, "Submit for review");
  await expect(page.getByLabel("Executive Summary")).toBeDisabled();
  await confirm(page, "Approve report");
  await expect(page.getByRole("button", { name: "Save draft" })).toHaveCount(0);
  await confirm(page, "Generate PDF");
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download PDF", exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toMatch(/^AAR-.*\.pdf$/);
  const bytes = await readFile((await download.path())!);
  const report = await db.afterActionReport.findUniqueOrThrow({ where: { sessionId: s.id }, include: { versions: { include: { artifacts: true } } } });
  const artifact = report.versions[0]!.artifacts[0]!;
  expect(bytes).toEqual(Buffer.from(artifact.content));
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.contentSha256);
  await confirm(page, "Create revision");
  await expect(page.getByLabel("Executive Summary")).toBeEnabled();
  await expect(page.getByLabel("Executive Summary")).toHaveValue("Browser executive summary");
  await page.getByRole("button", { name: "View revision 1", exact: true }).click();
  await expect(page.getByLabel("Executive Summary")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Download PDF" })).toBeVisible();
  await expect(page.getByLabel("Report Session", { exact: true })).toHaveValue(s.id);
});

test("preserves unsaved input on stale, validation and server errors", async ({ page }) => {
  const s = await incident("STALE");
  await open(page, s);
  await page.getByLabel("Report title").fill("Stale report");
  await page.getByRole("button", { name: "Create report", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add lesson" })).toBeVisible();
  await page.getByLabel("Executive Summary").fill("Do not lose this text");
  for (const status of [409, 400, 500]) {
    await page.route("**/api/after-action-report-versions/*", async route => {
      if (route.request().method() === "PATCH") return route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: status === 409 ? "Report has changed" : "Controlled save failure" }) });
      return route.continue();
    });
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByText(status === 409 ? /Your input is preserved/ : "Controlled save failure", { exact: false }).first()).toBeVisible();
    await expect(page.getByLabel("Executive Summary")).toHaveValue("Do not lose this text");
    await expect(page.getByLabel("Report Session", { exact: true })).toBeDisabled();
    await page.unroute("**/api/after-action-report-versions/*");
  }
  await confirm(page, "Reload report");
  await expect(page.getByLabel("Executive Summary")).toHaveValue("");
});

test("pages historical Sessions independently, excludes Active and reads Archived history", async ({ page }) => {
  test.setTimeout(60000);
  for (let i = 0; i < 22; i++) await incident("PAGING-" + String(i).padStart(2, "0"));
  const archived = await incident("PAGING-ARCHIVED", "Closed"), active = await incident("PAGING-ACTIVE", "Active");
  const create = await page.request.post(apiUrl + "/after-action-reports", { headers, data: { sessionId: archived.id, title: "Historical Draft", operationId: randomUUID() } });
  expect(create.status()).toBe(201);
  await db.session.update({ where: { id: archived.id }, data: { status: "Archived" } });
  await login(page, "coordinator@lot.pl"); await page.goto("/reports/after-action");
  const globalBefore = await page.evaluate(() => localStorage.getItem("zpp:activeSessionId"));
  await page.getByLabel("Search report Sessions").fill(marker + "-PAGING");
  const selector = page.getByLabel("Report Session", { exact: true });
  await expect(selector.locator("option")).toHaveCount(21);
  await expect(selector.locator("option", { hasText: active.operationalId })).toHaveCount(0);
  await page.getByRole("button", { name: "Next Sessions" }).click();
  await expect(selector.locator("option")).toHaveCount(3);
  await page.getByLabel("Report Session status").selectOption("Archived");
  await expect(selector.locator("option")).toHaveCount(2);
  await selector.selectOption(archived.id);
  await expect(page.getByLabel("Report title")).toHaveValue("Historical Draft");
  await expect(page.getByLabel("Report title")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Create report", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save draft" })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("zpp:activeSessionId"))).toBe(globalBefore);
  await db.session.update({ where: { id: active.id }, data: { status: "Closed" } });
});

test("hides AAR workflow and rejects direct API access for denied role", async ({ page }) => {
  const s = await incident("DENIED");
  await login(page, "viewer@lot.pl"); await page.goto("/reports/after-action");
  await expect(page.getByRole("button", { name: "Create report", exact: true })).toHaveCount(0);
  const denied = await page.request.get(apiUrl + "/after-action-reports?sessionId=" + s.id, { headers: { "x-user-email": "viewer@lot.pl" } });
  expect(denied.status()).toBe(403);
});
