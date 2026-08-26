import { expect, test, type Page } from "@playwright/test";
import { clearAuthSession, login } from "./helpers";

const apiUrl = process.env.PLAYWRIGHT_API_URL ?? `http://127.0.0.1:${Number(process.env.PLAYWRIGHT_API_PORT ?? 4100)}/api`;
const headers = { "content-type": "application/json", "x-user-email": "coordinator@lot.pl" };
const cleanupSessionIds: string[] = [];

async function createSession(page: Page, suffix: string) {
  const response = await page.request.post(`${apiUrl}/sessions`, { headers, data: { mode: "EXERCISE", status: "Active", eventType: "Exercise", flightNumber: `F17-${suffix}-${Date.now()}` } });
  expect(response.status()).toBe(201);
  const session = await response.json();
  cleanupSessionIds.push(session.id);
  return session;
}

async function useSession(page: Page, session: Record<string, string>) {
  await page.goto("/sessions");
  const row = page.getByRole("row").filter({ hasText: session.operationalId });
  await expect(row).toBeVisible();
  const button = row.getByRole("button", { name: "Use this session" });
  if (await button.count()) await button.click();
}

async function openReports(page: Page, session: Record<string, string>) {
  await login(page, "coordinator@lot.pl");
  await useSession(page, session);
  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();
}

function exportButton(page: Page, label: string) {
  return page.getByText(label, { exact: true }).locator("..").getByRole("button", { name: "Export" });
}

test.afterEach(async ({ page }) => {
  for (const sessionId of cleanupSessionIds.splice(0)) {
    await page.request.post(`${apiUrl}/sessions/${sessionId}/close`, { headers, data: { notes: "Stage 17 browser cleanup" } }).catch(() => undefined);
  }
});

test("downloads a Passenger CSV through authenticated POST with server filename and generation header", async ({ page }) => {
  const session = await createSession(page, "PASSENGER");
  const created = await page.request.post(`${apiUrl}/passenger-records`, { headers, data: { sessionId: session.id, personType: "Passenger", firstName: "Browser", lastName: "Passenger", source: "Manual", sourceExternalId: `F17-BROWSER-${Date.now()}` } });
  expect(created.status()).toBe(201);
  await openReports(page, session);
  let operationId = "";
  let generationId = "";
  page.on("request", (request) => {
    if (request.url().endsWith("/api/exports/passenger-register")) operationId = String(request.postDataJSON()?.operationId ?? "");
  });
  page.on("response", async (response) => {
    if (response.url().endsWith("/api/exports/passenger-register")) generationId = String((await response.allHeaders())["x-export-generation-id"] ?? "");
  });
  const downloadPromise = page.waitForEvent("download");
  await exportButton(page, "Passenger/Crew register").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^zpp-.*-passenger-register\.csv$/);
  expect(operationId).toMatch(/^[0-9a-f-]{36}$/);
  await expect.poll(() => generationId).toMatch(/^[0-9a-f-]{36}$/);
});

test("downloads a session-package CSV and keeps PDF/AAR unavailable", async ({ page }) => {
  const session = await createSession(page, "PACKAGE");
  await openReports(page, session);
  const requestPromise = page.waitForRequest((request) => request.url().endsWith("/api/exports/session-package"));
  const downloadPromise = page.waitForEvent("download");
  await exportButton(page, "Session package CSV").click();
  const [requestRecord, download] = await Promise.all([requestPromise, downloadPromise]);
  expect(requestRecord.method()).toBe("POST");
  expect(requestRecord.postDataJSON()).toMatchObject({ sessionId: session.id, operationId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  expect(download.suggestedFilename()).toMatch(/^zpp-.*-session-package\.csv$/);
  await expect(page.getByText("PDF session summary", { exact: true }).locator("..").getByRole("button", { name: "Unavailable" })).toBeDisabled();
  await expect(page.getByText("Exercise/AAR draft", { exact: true }).locator("..").getByRole("button", { name: "Unavailable" })).toBeDisabled();
});

test("surfaces controlled POST errors and blocks the export module for a denied actor", async ({ page }) => {
  const session = await createSession(page, "ERROR");
  await openReports(page, session);
  await page.route("**/api/exports/passenger-register", async (route) => {
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Stage 17 controlled export failure" }) });
  });
  await exportButton(page, "Passenger/Crew register").click();
  await expect(page.getByText("Stage 17 controlled export failure")).toBeVisible();
  await clearAuthSession(page);
  await login(page, "viewer@lot.pl");
  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "Limited Access" })).toBeVisible();
  await expect(page.getByText("Passenger/Crew register", { exact: true })).toHaveCount(0);
});
