import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

const apiUrl = process.env.PLAYWRIGHT_API_URL ?? `http://127.0.0.1:${Number(process.env.PLAYWRIGHT_API_PORT ?? 4100)}/api`;
const headers = { "content-type": "application/json", "x-user-email": "coordinator@lot.pl" };
const adminHeaders = { "content-type": "application/json", "x-user-email": "admin@lot.pl" };
const cleanupSessionIds: string[] = [];

type Row = Record<string, any>;

async function createSession(page: Page, token: string) {
  const response = await page.request.post(`${apiUrl}/sessions`, {
    headers,
    data: { mode: "EXERCISE", status: "Active", eventType: "Exercise", flightNumber: token, route: "WAW-A11Y", description: "Isolated Stage 2D browser test" }
  });
  expect(response.ok()).toBeTruthy();
  const session = await response.json() as Row;
  cleanupSessionIds.push(session.id);
  return session;
}

async function useSession(page: Page, session: Row) {
  await page.goto("/sessions");
  const row = page.getByRole("row").filter({ hasText: session.operationalId });
  await expect(row).toBeVisible();
  const button = row.getByRole("button", { name: "Use this session" });
  if (await button.count()) await button.click();
}

test.afterEach(async ({ page }) => {
  for (const id of cleanupSessionIds.splice(0)) {
    await page.request.post(`${apiUrl}/sessions/${id}/close`, { headers: adminHeaders, data: { notes: "Stage 2D focused test cleanup." } }).catch(() => undefined);
  }
});

test("shared drawer traps focus and applies one dirty-close rule with focus return", async ({ page }) => {
  await login(page);
  await page.goto("/sessions");
  const opener = page.getByRole("button", { name: "New", exact: true });
  await opener.click();
  let drawer = page.getByRole("dialog", { name: "New Session" });
  await expect(drawer.getByRole("heading", { name: "New Session", exact: true })).toBeFocused();
  await expect(drawer.getByLabel("Session type")).toHaveAttribute("required", "");
  await expect(drawer.getByLabel("Session type")).toHaveAttribute("aria-required", "true");

  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBeTruthy();
  for (let index = 0; index < 16; index += 1) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBeTruthy();
  }

  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(opener).toBeFocused();

  await opener.click();
  drawer = page.getByRole("dialog", { name: "New Session" });
  await drawer.getByLabel("Flight number").fill("DIRTY-FOCUS-CHECK");
  await page.evaluate(() => window.history.back());
  let discard = page.getByRole("dialog", { name: "Discard unsaved changes?" });
  await expect(discard).toBeVisible();
  await expect(discard.getByRole("button", { name: "Continue editing" })).toBeFocused();
  await discard.getByRole("button", { name: "Continue editing" }).click();
  await expect(drawer.getByLabel("Flight number")).toHaveValue("DIRTY-FOCUS-CHECK");

  await page.keyboard.press("Escape");
  discard = page.getByRole("dialog", { name: "Discard unsaved changes?" });
  await discard.getByRole("button", { name: "Discard changes" }).click();
  await expect(page.getByRole("dialog", { name: "New Session" })).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("successful save avoids discard confirmation and duplicate submission", async ({ page }) => {
  const token = `S2D-SAVE-${Date.now()}`;
  await login(page);
  await page.goto("/sessions");
  await page.getByRole("button", { name: "New", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "New Session" });
  await drawer.getByLabel("Flight number").fill(token);

  let postCount = 0;
  await page.route("**/api/sessions", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    postCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.continue();
  });
  const save = drawer.getByRole("button", { name: "Save session" });
  await save.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(drawer).toHaveCount(0);
  expect(postCount).toBe(1);
  await expect(page.getByRole("dialog", { name: "Discard unsaved changes?" })).toHaveCount(0);

  const sessions = await page.request.get(`${apiUrl}/sessions?limit=200`, { headers: adminHeaders });
  const created = ((await sessions.json()).data as Row[]).find((item) => item.flightNumber === token);
  expect(created).toBeTruthy();
  cleanupSessionIds.push(created.id);
});

test("validation summary is announced, links to its field, preserves conflicts and blocks double submit", async ({ page }) => {
  const session = await createSession(page, `S2D-ERR-${Date.now()}`);
  await login(page);
  await useSession(page, session);
  await page.goto("/timeline");
  await page.getByRole("button", { name: "New", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "New Timeline Note" });
  const submit = drawer.getByRole("button", { name: "Add note" });
  await submit.click();
  const summary = drawer.getByRole("alert").filter({ hasText: "Timeline note could not be added" });
  await expect(summary).toBeFocused();
  const errorLink = summary.getByRole("link", { name: "Title is required." });
  await errorLink.click();
  await expect(drawer.getByLabel("Title")).toBeFocused();
  await expect(drawer.getByLabel("Title")).toHaveAttribute("aria-invalid", "true");

  await drawer.getByLabel("Title").fill("Conflict remains visible");
  let postCount = 0;
  await page.route("**/api/timeline", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    postCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 200));
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Authoritative timeline conflict from API" }) });
  });
  await submit.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(drawer.getByText("Authoritative timeline conflict from API")).toBeVisible();
  expect(postCount).toBe(1);
  await expect(drawer.getByLabel("Title")).toHaveValue("Conflict remains visible");
});

test("keyboard rows, sort state, read-only Escape, Retry and mobile layout remain accessible", async ({ page }) => {
  const token = `S2D-ROW-${Date.now()}`;
  const session = await createSession(page, token);
  const note = await page.request.post(`${apiUrl}/timeline`, { headers, data: { sessionId: session.id, eventType: "operational_update", title: token, body: "Keyboard-accessible full detail text." } });
  expect(note.ok()).toBeTruthy();
  await page.request.post(`${apiUrl}/exercise/observations`, { headers, data: { sessionId: session.id, area: "Intake", severity: "Low", observation: `${token}-INERT` } });

  await login(page);
  await useSession(page, session);
  await page.goto("/timeline");
  const timeHeader = page.getByRole("columnheader", { name: /Time/ });
  await expect(timeHeader).toHaveAttribute("aria-sort", "descending");
  await expect(timeHeader.getByRole("button")).toHaveAttribute("aria-label", /currently descending/);
  const row = page.getByRole("row", { name: new RegExp(`Open timeline event ${token}`) });
  await row.focus();
  await page.keyboard.press("Enter");
  const detail = page.getByRole("dialog", { name: "Timeline event details" });
  await expect(detail).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);
  await expect(row).toBeFocused();
  await expect(page.getByRole("dialog", { name: "Discard unsaved changes?" })).toHaveCount(0);

  await page.goto("/exercise");
  const inertRow = page.getByRole("row").filter({ hasText: `${token}-INERT` });
  await expect(inertRow).not.toHaveAttribute("tabindex");
  await expect(inertRow).not.toHaveClass(/cursor-pointer/);

  let failedOnce = false;
  await page.route("**/api/audit-logs**", async (route) => {
    if (!failedOnce) {
      failedOnce = true;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporary audit load failure" }) });
      return;
    }
    await route.continue();
  });
  await page.goto("/audit");
  await expect(page.getByText("Temporary audit load failure")).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("Temporary audit load failure")).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/timeline");
  await row.focus();
  await page.keyboard.press(" ");
  await expect(page.getByRole("dialog", { name: "Timeline event details" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
});
