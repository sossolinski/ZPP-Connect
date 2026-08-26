import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { login } from "./helpers";

const databaseUrl = process.env.DATABASE_URL;
const prisma = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;
const marker = `F21-BROWSER-${Date.now()}`;
const normalizedMarker = marker.toLowerCase().replace(/[^a-z0-9]+/g, "_");
const apiUrl = process.env.PLAYWRIGHT_API_URL ?? `http://127.0.0.1:${Number(process.env.PLAYWRIGHT_API_PORT ?? 4100)}/api`;
const adminHeaders = { "content-type": "application/json", "x-user-email": "admin@lot.pl" };

async function openDictionaries(page: Parameters<typeof login>[0]) {
  await page.goto("/users-access");
  await page.getByRole("button", { name: "Dictionaries" }).click();
  await expect(page.getByTestId("admin-dictionaries")).toBeVisible();
}

async function filterDictionaries(page: Parameters<typeof login>[0], category: string, search = "") {
  await page.getByLabel("Dictionary category").selectOption(category);
  await page.getByLabel("Search dictionaries").fill(search);
  await page.getByRole("button", { name: "Apply" }).click();
}

test.beforeAll(async () => {
  test.skip(!prisma, "PostgreSQL Stage 21 browser database is required");
});

test.afterAll(async () => {
  if (!prisma) return;
  const requests = await prisma.request.findMany({ where: { details: { contains: marker } }, select: { id: true } });
  const sessions = await prisma.session.findMany({ where: { description: { contains: marker } }, select: { id: true } });
  const requestIds = requests.map((row) => row.id);
  const sessionIds = sessions.map((row) => row.id);
  if (requestIds.length) {
    await prisma.auditLog.deleteMany({ where: { entityId: { in: requestIds } } });
    await prisma.caseTimelineEvent.deleteMany({ where: { entityId: { in: requestIds } } });
    await prisma.request.deleteMany({ where: { id: { in: requestIds } } });
  }
  if (sessionIds.length) {
    await prisma.auditLog.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await prisma.caseTimelineEvent.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await prisma.session.deleteMany({ where: { id: { in: sessionIds } } });
  }
  const rows = await prisma.dictionary.findMany({ where: { normalizedKey: { startsWith: normalizedMarker } }, select: { id: true } });
  await prisma.auditLog.deleteMany({ where: { entityType: "Dictionary", entityId: { in: rows.map((row) => row.id) } } });
  await prisma.dictionary.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
  await prisma.$disconnect();
});

test("manages durable values truthfully while protecting protocol vocabularies and operational options", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, "admin@lot.pl");
  await openDictionaries(page);

  await filterDictionaries(page, "sessionStatuses");
  const protectedRow = page.getByRole("row").filter({ hasText: "sessionStatuses" }).first();
  await expect(protectedRow).toContainText("Protected");
  await expect(protectedRow).toContainText("Read-only system value");
  await expect(protectedRow.getByRole("button", { name: "Edit" })).toHaveCount(0);

  await page.getByRole("button", { name: "Add configurable value" }).click();
  const editor = page.getByTestId("dictionary-editor");
  await expect(editor).toBeVisible();
  await editor.getByLabel("Category").selectOption("requestCategories");
  await editor.getByTestId("dictionary-key").fill(`${marker}-category`);
  await editor.getByTestId("dictionary-label").fill(`${marker} Category`);
  const createResponse = page.waitForResponse((response) => response.url().endsWith("/api/admin/dictionaries") && response.request().method() === "POST");
  await editor.getByRole("button", { name: "Save dictionary value" }).click();
  expect((await createResponse).status()).toBe(201);

  await filterDictionaries(page, "requestCategories", marker);
  let durableRow = page.getByRole("row").filter({ hasText: `${marker} Category` });
  await expect(durableRow).toContainText("Editable");
  await page.reload();
  await page.getByRole("button", { name: "Dictionaries" }).click();
  await filterDictionaries(page, "requestCategories", marker);
  durableRow = page.getByRole("row").filter({ hasText: `${marker} Category` });
  await expect(durableRow).toBeVisible();

  await page.getByRole("button", { name: "Add configurable value" }).click();
  const eventEditor = page.getByTestId("dictionary-editor");
  await eventEditor.getByLabel("Category").selectOption("eventTypes");
  await eventEditor.getByTestId("dictionary-key").fill(`${marker}-event`);
  await eventEditor.getByTestId("dictionary-label").fill(`${marker} Event`);
  const eventCreateResponse = page.waitForResponse((response) => response.url().endsWith("/api/admin/dictionaries") && response.request().method() === "POST");
  await eventEditor.getByRole("button", { name: "Save dictionary value" }).click();
  expect((await eventCreateResponse).status()).toBe(201);

  await filterDictionaries(page, "eventTypes", marker);
  let eventRow = page.getByRole("row").filter({ hasText: `${marker} Event` });
  await expect(eventRow).toContainText("Editable");
  await eventRow.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByTestId("dictionary-editor").getByTestId("dictionary-key")).toBeDisabled();
  await page.getByTestId("dictionary-editor").getByTestId("dictionary-label").fill(`${marker} Event Updated`);
  const eventUpdateResponse = page.waitForResponse((response) => response.url().includes("/api/admin/dictionaries/") && response.request().method() === "PATCH");
  await page.getByTestId("dictionary-editor").getByRole("button", { name: "Save dictionary value" }).click();
  expect((await eventUpdateResponse).status()).toBe(200);

  await page.reload();
  await page.goto("/sessions");
  await page.getByRole("button", { name: "New", exact: true }).click();
  const sessionEditor = page.getByRole("dialog", { name: "New Session" });
  await expect(sessionEditor.getByLabel("Event type").locator("option", { hasText: `${marker} Event Updated` })).toHaveCount(1);
  await sessionEditor.getByLabel("Session type").selectOption("TRAINING");
  await sessionEditor.getByLabel("Event type").selectOption({ label: `${marker} Event Updated` });
  await sessionEditor.getByLabel("Description").fill(`${marker} historical Session`);
  const sessionCreateResponse = page.waitForResponse((response) => response.url().endsWith("/api/sessions") && response.request().method() === "POST");
  await sessionEditor.getByRole("button", { name: "Save session" }).click();
  const sessionResponse = await sessionCreateResponse;
  expect(sessionResponse.status()).toBe(201);
  const createdSession = await sessionResponse.json();
  await expect(page.getByRole("row").filter({ hasText: createdSession.operationalId })).toContainText(`${marker} Event Updated`);

  await page.goto("/requests");
  await page.getByRole("button", { name: "New Request" }).click();
  const requestDialog = page.getByRole("dialog", { name: "Create Request" });
  await expect(requestDialog.getByLabel("Type").locator("option", { hasText: `${marker} Category` })).toHaveCount(1);
  await requestDialog.getByLabel("Type").selectOption({ label: `${marker} Category` });
  await requestDialog.getByLabel("Requested action / details").fill(`${marker} historical Request`);
  const requestCreateResponse = page.waitForResponse((response) => response.url().endsWith("/api/requests") && response.request().method() === "POST");
  await requestDialog.getByRole("button", { name: "Create Request" }).click();
  const requestResponse = await requestCreateResponse;
  expect(requestResponse.status()).toBe(201);
  const createdRequest = await requestResponse.json();
  await page.getByLabel("Search Requests").fill(`${marker} historical Request`);
  await expect(page.getByRole("row").filter({ hasText: `${marker} Category` })).toBeVisible();

  await openDictionaries(page);
  await filterDictionaries(page, "eventTypes", marker);
  eventRow = page.getByRole("row").filter({ hasText: `${marker} Event Updated` });
  await eventRow.getByRole("button", { name: "Deactivate" }).click();
  await page.reload();
  await page.goto("/sessions");
  await page.getByRole("button", { name: "New", exact: true }).click();
  const inactiveSessionEditor = page.getByRole("dialog", { name: "New Session" });
  await expect(inactiveSessionEditor.getByLabel("Event type").locator("option", { hasText: `${marker} Event Updated` })).toHaveCount(0);
  await inactiveSessionEditor.getByRole("button", { name: "Close" }).click();
  const inactiveSessionWrite = await page.request.post(`${apiUrl}/sessions`, { headers: adminHeaders, data: { mode: "TRAINING", status: "Draft", eventType: `${marker} Event Updated`, description: `${marker} inactive Session must fail` } });
  expect(inactiveSessionWrite.status()).toBe(400);
  await expect(page.getByRole("row").filter({ hasText: createdSession.operationalId })).toContainText(`${marker} Event Updated`);

  await openDictionaries(page);
  await filterDictionaries(page, "requestCategories", marker);
  durableRow = page.getByRole("row").filter({ hasText: `${marker} Category` });
  const deactivateResponse = page.waitForResponse((response) => response.url().includes("/deactivate") && response.request().method() === "POST");
  await durableRow.getByRole("button", { name: "Deactivate" }).click();
  expect((await deactivateResponse).status()).toBe(200);
  await expect(page.getByRole("row").filter({ hasText: `${marker} Category` })).toContainText("Inactive");

  await page.reload();
  await page.goto("/requests");
  await page.getByRole("button", { name: "New Request" }).click();
  await expect(page.getByRole("dialog").getByLabel("Type").locator("option", { hasText: `${marker} Category` })).toHaveCount(0);
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  const activeIncident = await prisma!.session.findFirstOrThrow({ where: { status: "Active" }, select: { id: true } });
  const inactiveRequestWrite = await page.request.post(`${apiUrl}/requests`, { headers: adminHeaders, data: { sessionId: activeIncident.id, category: `${marker} Category`, priority: "Normal", details: `${marker} inactive Request must fail`, approvalStatus: "Not required", operationId: crypto.randomUUID() } });
  expect(inactiveRequestWrite.status()).toBe(400);
  await page.getByLabel("Search Requests").fill(createdRequest.operationalId);
  await expect(page.getByRole("row").filter({ hasText: createdRequest.operationalId })).toContainText(`${marker} Category`);

  await openDictionaries(page);
  await filterDictionaries(page, "requestCategories", marker);
  durableRow = page.getByRole("row").filter({ hasText: `${marker} Category` });
  await durableRow.getByRole("button", { name: "Reactivate" }).click();
  await filterDictionaries(page, "eventTypes", marker);
  eventRow = page.getByRole("row").filter({ hasText: `${marker} Event Updated` });
  await eventRow.getByRole("button", { name: "Reactivate" }).click();
  await page.reload();
  await page.goto("/sessions");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "New Session" }).getByLabel("Event type").locator("option", { hasText: `${marker} Event Updated` })).toHaveCount(1);
  await page.getByRole("dialog", { name: "New Session" }).getByRole("button", { name: "Close" }).click();
  await openDictionaries(page);
  await filterDictionaries(page, "requestCategories", marker);
  durableRow = page.getByRole("row").filter({ hasText: `${marker} Category` });
  await durableRow.getByRole("button", { name: "Edit" }).click();
  const persisted = await prisma!.dictionary.findUniqueOrThrow({ where: { profile_category_normalizedKey: { profile: "lot-zpp", category: "requestCategories", normalizedKey: `${normalizedMarker}_category` } } });
  await prisma!.dictionary.update({ where: { id: persisted.id }, data: { label: `${marker} Server Change`, version: { increment: 1 } } });
  await page.getByTestId("dictionary-editor").getByTestId("dictionary-label").fill(`${marker} Stale Browser Change`);
  const conflictResponse = page.waitForResponse((response) => response.url().includes(`/api/admin/dictionaries/${persisted.id}`) && response.request().method() === "PATCH");
  await page.getByTestId("dictionary-editor").getByRole("button", { name: "Save dictionary value" }).click();
  expect((await conflictResponse).status()).toBe(409);
  await expect(page.getByTestId("dictionary-editor")).toContainText(/changed since it was loaded/i);
  await expect(page.getByTestId("dictionary-editor").getByTestId("dictionary-label")).toHaveValue(`${marker} Stale Browser Change`);
  await page.getByTestId("dictionary-editor").getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "Add configurable value" }).click();
  const failedKey = `${marker}-failed`;
  await page.getByTestId("dictionary-editor").getByLabel("Category").selectOption("requestCategories");
  await page.getByTestId("dictionary-editor").getByTestId("dictionary-key").fill(failedKey);
  await page.getByTestId("dictionary-editor").getByTestId("dictionary-label").fill(`${marker} Failed`);
  await page.route("**/api/admin/dictionaries", async (route) => {
    if (route.request().method() === "POST") await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Injected browser failure" }) });
    else await route.continue();
  });
  await page.getByTestId("dictionary-editor").getByRole("button", { name: "Save dictionary value" }).click();
  await expect(page.getByTestId("dictionary-editor")).toContainText("Injected browser failure");
  await expect(page.getByTestId("dictionary-editor").getByTestId("dictionary-key")).toHaveValue(failedKey);
  expect(await prisma!.dictionary.count({ where: { normalizedKey: `${normalizedMarker}_failed` } })).toBe(0);
});
