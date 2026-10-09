import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { login } from "./helpers";

const db = new PrismaClient();
const marker = `PI1-BROWSER-${randomUUID().slice(0, 8)}`;
const apiUrl = process.env.PLAYWRIGHT_API_URL ?? `http://127.0.0.1:${Number(process.env.PLAYWRIGHT_API_PORT ?? 4100)}/api`;
let activeId: string, emptyId: string, urgentId: string, capableId: string;
const briefings: Record<string, string> = {};

async function loginReady(page: Page, email: string) {
  await login(page, email);
  // Let initial context settle before choosing the incident for this acceptance case.
  await expect(page.getByTestId("dashboard-freshness")).toBeVisible();
}

test.beforeAll(async () => {
  expect(process.env.PLAYWRIGHT_PERSISTENCE_MODE).toBe("postgres");
  activeId = (await db.session.findUniqueOrThrow({ where: { operationalId: "SES-2026-001" } })).id;
  const coordinator = await db.user.findUniqueOrThrow({ where: { email: "coordinator@lot.pl" } });
  const member = await db.user.findUniqueOrThrow({ where: { email: "volunteer@lot.pl" } });
  const role = await db.role.create({ data: { name: marker.toLowerCase(), displayName: marker, permissions: ["session:read", "request:read", "request:update", "request:close"] } });
  capableId = (await db.user.create({ data: { email: `${marker.toLowerCase()}@example.test`, displayName: "PI1 capable support owner", roles: { create: { roleId: role.id, assignedBy: "PI1 browser" } } } })).id;
  await db.incidentAssignment.create({ data: { incidentId: activeId, userId: capableId, function: marker, createdById: coordinator.id } });
  urgentId = (await db.request.create({ data: { operationalId: `${marker}-URGENT`, incidentId: activeId, category: "Transport", priority: "Urgent", details: "PI1 urgent support request", createdById: coordinator.id } })).id;
  await db.assignmentTask.create({ data: { operationalId: `${marker}-TASK`, sessionId: activeId, title: marker, assignedUserId: member.id, dueAt: new Date("2000-01-01T00:00:00Z") } });
  emptyId = (await db.session.create({ data: { operationalId: `${marker}-EMPTY`, mode: "REAL", status: "Draft", eventType: marker } })).id;
  await db.incidentAssignment.create({ data: { incidentId: emptyId, userId: coordinator.id, function: marker, createdById: coordinator.id } });
  for (const [state, nextUpdateDueAt] of [["overdue", new Date("2000-01-02T00:00:00Z")], ["scheduled", new Date("2100-01-01T00:00:00Z")], ["unscheduled", null]] as const) {
    const incident = await db.session.create({ data: { operationalId: `${marker}-${state}`, mode: "REAL", status: "Draft", eventType: marker } });
    briefings[state] = incident.id;
    await db.incidentAssignment.create({ data: { incidentId: incident.id, userId: coordinator.id, function: marker, createdById: coordinator.id } });
    await db.operationalBriefing.create({ data: { id: `${marker}-${state}`, sessionId: incident.id, revision: 1, status: "Published", title: `PI1 ${state} briefing`, situationSummary: "Retained published briefing", publishedAt: new Date("2000-01-01T00:00:00Z"), nextUpdateDueAt, publishedById: coordinator.id, createdById: coordinator.id, updatedById: coordinator.id } });
  }
});

test.afterAll(async () => { await db.$disconnect(); });

for (const email of ["coordinator@lot.pl", "tec@lot.pl", "zpp@lot.pl", "volunteer@lot.pl", "viewer@lot.pl", "admin@lot.pl"]) {
  test(`truthful PostgreSQL Dashboard for ${email}`, async ({ page }) => {
    await loginReady(page, email);
    await page.evaluate(id => localStorage.setItem("zpp:activeSessionId", id), activeId);
    await page.goto("/dashboard");
    await expect(page.getByTestId("dashboard-freshness")).toContainText("Data loaded successfully");
    const full = ["coordinator@lot.pl", "admin@lot.pl"].includes(email);
    if (full) await expect(page.getByText("Manifest coverage", { exact: true })).toBeVisible();
    else {
      await expect(page.getByTestId("dashboard-metrics")).toContainText("Not available for your role");
      await expect(page.getByText("Manifest coverage", { exact: true })).toHaveCount(0);
      await expect(page.getByText("Data Quality", { exact: true })).toHaveCount(0);
    }
    const attention = page.getByTestId("dashboard-attention");
    await expect(attention.getByText("Clear", { exact: true })).toHaveCount(0);
    if (email === "tec@lot.pl") {
      await expect(attention).toContainText(`${marker}-URGENT`);
      await expect(page.getByTestId("dashboard-metrics")).not.toContainText("0 shown");
    }
    if (email === "volunteer@lot.pl") {
      await expect(attention).toContainText("Your task is overdue");
      await expect(attention).toContainText("Your document acknowledgement");
    }
    if (email === "viewer@lot.pl") await expect(attention).toContainText("Attention information unavailable");
    const admin = await page.request.get(`${apiUrl}/admin/users`, { headers: { "x-user-email": email } });
    expect(admin.status()).toBe(email === "admin@lot.pl" ? 200 : 403);
  });
}

test("authorized measured zero remains available", async ({ page }) => {
  await loginReady(page, "coordinator@lot.pl");
  await page.evaluate(id => localStorage.setItem("zpp:activeSessionId", id), emptyId);
  await page.goto("/dashboard");
  await expect(page.getByTestId("dashboard-metrics")).toContainText("0 records loaded");
  await expect(page.getByText("Manifest coverage", { exact: true })).toBeVisible();
  await expect(page.getByTestId("dashboard-metrics")).not.toContainText("Not available for your role");
});

test("manual refresh preserves failed/stale snapshots and retries current data", async ({ page }) => {
  await page.clock.install({ time: new Date() });
  await loginReady(page, "tec@lot.pl");
  await page.evaluate(id => localStorage.setItem("zpp:activeSessionId", id), activeId);
  await page.goto("/dashboard");
  const freshness = page.getByTestId("dashboard-freshness");
  await expect(freshness).toContainText("Data loaded successfully");
  const added = await page.request.post(`${apiUrl}/requests`, { headers: { "x-user-email": "coordinator@lot.pl" }, data: { sessionId: activeId, category: "Transport", priority: "Urgent", details: "PI1 manual refresh source change", operationId: randomUUID() } });
  expect(added.status()).toBe(201);
  const addedRecord = await added.json();
  await expect(page.getByTestId("dashboard-attention")).not.toContainText(addedRecord.operationalId);
  await page.getByRole("button", { name: "Refresh dashboard" }).click();
  await expect(page.getByTestId("dashboard-attention")).toContainText(addedRecord.operationalId);
  await page.clock.fastForward(301_000);
  await expect(freshness).toContainText("Data may be stale");
  let release: (() => void) | undefined;
  await page.route("**/api/dashboard?*", async route => {
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "PI1 acceptance refresh unavailable" }) });
  });
  await page.getByRole("button", { name: "Refresh dashboard" }).click();
  await expect(freshness).toContainText("Refreshing");
  await expect(page.getByTestId("dashboard-attention")).toContainText(`${marker}-URGENT`);
  await expect.poll(() => Boolean(release)).toBe(true);
  release!();
  await expect(freshness).toContainText("Refresh failed — showing previously loaded data");
  await expect(page.getByTestId("dashboard-attention")).toContainText(`${marker}-URGENT`);
  await page.unroute("**/api/dashboard?*");
  await page.clock.setSystemTime(new Date());
  await page.clock.runFor(15_000);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(freshness).toContainText("Data loaded successfully");
});

test("late refresh from the previous incident cannot replace the selected incident", async ({ page }) => {
  await loginReady(page, "coordinator@lot.pl");
  await page.evaluate(id => localStorage.setItem("zpp:activeSessionId", id), activeId);
  await page.goto("/dashboard");
  await expect(page.getByTestId("dashboard-freshness")).toContainText("Data loaded successfully");
  let release: (() => void) | undefined;
  await page.route(`**/api/dashboard?sessionId=${activeId}`, async route => {
    const response = await route.fetch();
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Refresh dashboard" }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.getByRole("link", { name: /Current session .* Open Sessions/ }).click();
  await page.getByRole("row").filter({ hasText: `${marker}-EMPTY` }).getByRole("button", { name: "Use this session" }).click();
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(page.getByTestId("dashboard-metrics")).toContainText("0 records loaded");
  release!();
  await expect(page.getByTestId("dashboard-metrics")).toContainText("0 records loaded");
  await expect(page.getByTestId("dashboard-attention")).not.toContainText(`${marker}-URGENT`);
});

test("initial load failure and absent incident never become zero or clear", async ({ page }) => {
  await loginReady(page, "tec@lot.pl");
  await page.route("**/api/dashboard?*", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "PI1 unavailable" }) }));
  await page.goto("/dashboard");
  await expect(page.getByText("Dashboard unavailable", { exact: true })).toBeVisible();
  await expect(page.getByTestId("dashboard-metrics")).toHaveCount(0);
  await page.unroute("**/api/dashboard?*");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByTestId("dashboard-freshness")).toContainText("Data loaded successfully");
  await page.route("**/api/sessions?*", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ total: 0, data: [] }) }));
  await page.goto("/dashboard");
  await expect(page.getByText("No active session", { exact: true })).toBeVisible();
  await expect(page.getByTestId("dashboard-metrics")).toHaveCount(0);
});

test("owner controls use capable candidates and qualify later revocation", async ({ page }) => {
  await loginReady(page, "coordinator@lot.pl");
  await page.evaluate(id => localStorage.setItem("zpp:activeSessionId", id), activeId);
  await page.goto(`/requests?requestId=${urgentId}`);
  let drawer = page.getByRole("dialog", { name: `Request ${marker}-URGENT` });
  await expect(drawer).toBeVisible();
  await drawer.getByRole("button", { name: "Assign", exact: true }).click();
  const ownerSelect = drawer.getByLabel("New owner");
  await expect(ownerSelect.locator("option").filter({ hasText: "ZPP Group Leader" })).toHaveCount(0);
  await ownerSelect.selectOption(capableId);
  await drawer.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(drawer.getByText("PI1 capable support owner", { exact: true })).toBeVisible();
  await db.permissionOverride.create({ data: { userId: capableId, permission: "request:close", effect: "DENY", reason: "Browser acceptance access revocation", createdById: capableId } });
  await page.goto(`/requests?requestId=${urgentId}`);
  drawer = page.getByRole("dialog", { name: `Request ${marker}-URGENT` });
  await expect(drawer).toContainText("Reassignment required");
  await expect(drawer).toContainText("can no longer fulfill this support request");
  await drawer.getByRole("button", { name: "Assign", exact: true }).click();
  await expect(drawer.getByLabel("New owner").locator(`option[value="${capableId}"]`)).toHaveCount(0);
});

for (const state of ["overdue", "scheduled", "unscheduled"]) {
  test(`published briefing ${state} freshness has semantic text`, async ({ page }) => {
    await loginReady(page, "coordinator@lot.pl");
    await page.evaluate(id => localStorage.setItem("zpp:activeSessionId", id), briefings[state]!);
    await page.goto("/active-event");
    const freshness = page.getByTestId("briefing-freshness");
    await expect(freshness).toContainText(/Published \d+ days ago/);
    await expect(freshness).toContainText("2000");
    if (state === "overdue") await expect(freshness).toContainText("Update overdue");
    else await expect(freshness).not.toContainText("Update overdue");
    await expect(freshness).toContainText(state === "unscheduled" ? "No next update scheduled" : "Next update due");
    await expect(page.getByText("Retained published briefing", { exact: true })).toBeVisible();
  });
}
