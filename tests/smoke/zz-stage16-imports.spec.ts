import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

const apiUrl = process.env.PLAYWRIGHT_API_URL ?? `http://127.0.0.1:${Number(process.env.PLAYWRIGHT_API_PORT ?? 4100)}/api`;
const headers = { "content-type": "application/json", "x-user-email": "coordinator@lot.pl" };
const cleanupSessionIds: string[] = [];

async function createSession(page: Page, suffix: string) {
  const response = await page.request.post(`${apiUrl}/sessions`, {
    headers,
    data: { mode: "EXERCISE", status: "Active", eventType: "Exercise", flightNumber: `F16-${suffix}-${Date.now()}` }
  });
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

async function openImports(page: Page, session: Record<string, string>) {
  await login(page, "coordinator@lot.pl");
  await useSession(page, session);
  await page.goto("/files-import");
  await expect(page.getByRole("heading", { name: "Files / Import" })).toBeVisible();
}

test.afterEach(async ({ page }) => {
  for (const sessionId of cleanupSessionIds.splice(0)) {
    await page.request.post(`${apiUrl}/sessions/${sessionId}/close`, { headers, data: { notes: "Stage 16 browser cleanup" } }).catch(() => undefined);
  }
});

test("validates, previews, reloads and confirms a durable manifest with replay-safe final state", async ({ page }) => {
  const session = await createSession(page, "MANIFEST");
  await openImports(page, session);
  const csv = [
    "firstName,lastName,personType,source,sourceExternalId,age",
    `Browser,Passenger,Passenger,Manifest,F16-BROWSER-${Date.now()},34`,
    `Second,Passenger,Passenger,Manifest,F16-BROWSER-SECOND-${Date.now()},28`
  ].join("\n");
  await page.getByLabel("File").setInputFiles({ name: "manifest-stage16.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByRole("button", { name: "Upload and validate" }).click();
  await expect(page.getByText("Validated", { exact: true }).last()).toBeVisible();
  await expect(page.getByLabel("Import preview")).toContainText("Row 2 · valid");
  const batchId = await page.evaluate((incidentId) => localStorage.getItem(`zpp-import-batch:${incidentId}`), session.id);
  expect(batchId).toBeTruthy();

  await page.reload();
  await expect(page.getByText("Validated", { exact: true }).last()).toBeVisible();
  await page.getByRole("button", { name: "Confirm import" }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm import execution?" });
  await dialog.getByRole("button", { name: "Confirm import" }).click();
  await expect(page.getByText("Imported", { exact: true }).last()).toBeVisible();

  const replay = await page.request.post(`${apiUrl}/imports/${batchId}/confirm`, { headers, data: {} });
  expect(replay.status()).toBe(200);
  expect(await replay.json()).toMatchObject({ id: batchId, status: "Imported", replayed: true });
});

test("shows manifest row errors and confirms only the valid subset", async ({ page }) => {
  const session = await createSession(page, "INVALID");
  await openImports(page, session);
  const csv = [
    "firstName,lastName,personType,source,sourceExternalId,age",
    `Valid,Passenger,Passenger,Manifest,F16-VALID-${Date.now()},40`,
    `,Missing,Passenger,Manifest,F16-INVALID-${Date.now()},40`
  ].join("\n");
  await page.getByLabel("File").setInputFiles({ name: "manifest-errors.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByRole("button", { name: "Upload and validate" }).click();
  await expect(page.getByText("Validated with errors", { exact: true }).last()).toBeVisible();
  await expect(page.getByText(/Row 3: firstName is required/)).toBeVisible();
  await page.getByRole("button", { name: "Confirm import" }).click();
  await page.getByRole("dialog", { name: "Confirm import execution?" }).getByRole("button", { name: "Confirm import" }).click();
  await expect(page.getByText("Imported with errors", { exact: true }).last()).toBeVisible();
});

test("confirms a Family import and disables validation/confirmation controls for a Closed Incident", async ({ page }) => {
  const session = await createSession(page, "FAMILY");
  await openImports(page, session);
  await page.getByLabel("Import type").selectOption("family");
  const csv = [
    "firstName,lastName,email,claimedRelationship",
    `Browser,Family,browser-family-${Date.now()}@example.test,Parent`
  ].join("\n");
  await page.getByLabel("File").setInputFiles({ name: "family-stage16.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByRole("button", { name: "Upload and validate" }).click();
  await expect(page.getByText("Validated", { exact: true }).last()).toBeVisible();
  await page.getByRole("button", { name: "Confirm import" }).click();
  await page.getByRole("dialog", { name: "Confirm import execution?" }).getByRole("button", { name: "Confirm import" }).click();
  await expect(page.getByText("Imported", { exact: true }).last()).toBeVisible();

  const closed = await page.request.post(`${apiUrl}/sessions/${session.id}/close`, { headers, data: { notes: "Closed control coverage" } });
  expect(closed.status()).toBe(200);
  cleanupSessionIds.splice(cleanupSessionIds.indexOf(session.id), 1);
  await page.route("**/api/sessions**", async (route) => {
    if (new URL(route.request().url()).pathname !== "/api/sessions") return route.continue();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ total: 1, data: [{ ...session, status: "Closed" }] })
    });
  });
  await page.reload();
  await expect(page.getByLabel("File")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Upload and validate" })).toBeDisabled();
});
