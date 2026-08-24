import { expect, test, type Page } from "@playwright/test";
import { clearAuthSession, login } from "./helpers";

const apiUrl = process.env.PLAYWRIGHT_API_URL ?? `http://127.0.0.1:${Number(process.env.PLAYWRIGHT_API_PORT ?? 4100)}/api`;
const headers = { "content-type": "application/json", "x-user-email": "coordinator@lot.pl" };
const cleanupSessionIds: string[] = [];

async function createSession(page: Page, suffix: string) {
  const response = await page.request.post(`${apiUrl}/sessions`, { headers, data: { mode: "EXERCISE", status: "Active", eventType: "Stage 18 browser", flightNumber: `F18-${suffix}-${Date.now()}` } });
  expect(response.status()).toBe(201);
  const session = await response.json();
  cleanupSessionIds.push(session.id);
  return session;
}

async function openExercise(page: Page, session: Record<string, string>) {
  await login(page, "coordinator@lot.pl");
  await page.goto("/sessions");
  const row = page.getByRole("row").filter({ hasText: session.operationalId });
  await expect(row).toBeVisible();
  const use = row.getByRole("button", { name: "Use this session" });
  if (await use.count()) await use.click();
  await page.goto("/exercise");
  await expect(page.getByRole("heading", { name: "Exercise" })).toBeVisible();
}

test.afterEach(async ({ page }) => {
  for (const sessionId of cleanupSessionIds.splice(0)) {
    await page.request.post(`${apiUrl}/sessions/${sessionId}/close`, { headers, data: { notes: "Stage 18 browser cleanup" } }).catch(() => undefined);
  }
});

test("creates, releases, reloads and completes durable Inject evidence", async ({ page }) => {
  const session = await createSession(page, "INJECT");
  await openExercise(page, session);
  const text = `Stage 18 browser inject ${Date.now()}`;
  await page.getByLabel("Inject number").fill("1818");
  await page.getByLabel("Text").fill(text);
  const createResponse = page.waitForResponse((response) => response.url().endsWith("/api/exercise/injects") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Create inject" }).click();
  expect((await createResponse).status()).toBe(201);
  const row = page.getByRole("row").filter({ hasText: text });
  await expect(row).toContainText("Planned");
  await row.getByRole("button", { name: "Release inject" }).click();
  const releaseResponse = page.waitForResponse((response) => response.url().includes("/release") && response.request().method() === "POST");
  await page.getByRole("dialog").getByRole("button", { name: "Release inject" }).click();
  expect((await releaseResponse).status()).toBe(200);
  await page.reload();
  const releasedRow = page.getByRole("row").filter({ hasText: text });
  await expect(releasedRow).toContainText("Released");
  await expect(releasedRow.getByRole("button", { name: "Release inject" })).toBeDisabled();
  await releasedRow.getByRole("button", { name: "Complete inject" }).click();
  const completeResponse = page.waitForResponse((response) => response.url().includes("/complete") && response.request().method() === "POST");
  await page.getByRole("dialog").getByRole("button", { name: "Complete inject" }).click();
  expect((await completeResponse).status()).toBe(200);
  await expect(page.getByRole("row").filter({ hasText: text })).toContainText("Completed");
});

test("creates and edits an Observation with server history, then blocks closed-session controls", async ({ page }) => {
  const session = await createSession(page, "OBSERVATION");
  await openExercise(page, session);
  const text = `Stage 18 browser observation ${Date.now()}`;
  await page.getByLabel(/^Observation/).fill(text);
  const createResponsePromise = page.waitForResponse((response) => response.url().endsWith("/api/exercise/observations") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Add observation" }).click();
  const createResponse = await createResponsePromise;
  expect(createResponse.status()).toBe(201);
  const observation = await createResponse.json();
  const update = await page.request.patch(`${apiUrl}/exercise/observations/${observation.id}`, { headers, data: { expectedVersion: observation.version, severity: "High", recommendation: "Stage 18 browser edited recommendation" } });
  expect(update.status()).toBe(200);
  const history = await page.request.get(`${apiUrl}/exercise/observations/${observation.id}/history`, { headers });
  expect(history.status()).toBe(200);
  expect((await history.json()).total).toBe(2);
  const closed = await page.request.post(`${apiUrl}/sessions/${session.id}/close`, { headers, data: { notes: "Stage 18 browser closed controls" } });
  expect(closed.status()).toBe(200);
  cleanupSessionIds.splice(cleanupSessionIds.indexOf(session.id), 1);
  await page.route("**/api/sessions**", async (route) => {
    if (new URL(route.request().url()).pathname !== "/api/sessions") return route.continue();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ total: 1, data: [{ ...session, status: "Closed" }] }) });
  });
  await page.reload();
  await expect(page.getByRole("button", { name: "Create inject" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Add observation" })).toBeDisabled();
  const rejected = await page.request.patch(`${apiUrl}/exercise/observations/${observation.id}`, { headers, data: { expectedVersion: 2, severity: "Medium" } });
  expect(rejected.status()).toBe(409);
});

test("denies the Exercise module and server reads for an unauthorized actor", async ({ page }) => {
  const session = await createSession(page, "DENIED");
  await clearAuthSession(page);
  await login(page, "viewer@lot.pl");
  await page.goto("/exercise");
  await expect(page.getByRole("heading", { name: "Limited Access" })).toBeVisible();
  const denied = await page.request.get(`${apiUrl}/exercise/injects?sessionId=${session.id}`, { headers: { "x-user-email": "viewer@lot.pl" } });
  expect(denied.status()).toBe(403);
});
