import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

const apiUrl = process.env.PLAYWRIGHT_API_URL ?? `http://127.0.0.1:${Number(process.env.PLAYWRIGHT_API_PORT ?? 4100)}/api`;
const headers = { "content-type": "application/json", "x-user-email": "coordinator@lot.pl" };
type Row = Record<string, any>;
const cleanupSessionIds: string[] = [];

async function post(page: Page, path: string, data: Row) {
  const response = await page.request.post(`${apiUrl}${path}`, { headers, data });
  return { response, body: await response.json() };
}
async function get(page: Page, path: string, query: Row) {
  const url = new URL(`${apiUrl}${path}`); Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  const response = await page.request.get(url.toString(), { headers }); return { response, body: await response.json() };
}
async function useSession(page: Page, session: Row) {
  await page.goto("/sessions"); const row = page.getByRole("row").filter({ hasText: session.operationalId }); await expect(row).toBeVisible();
  const button = row.getByRole("button", { name: "Use this session" }); if (await button.count()) await button.click();
}

test.afterEach(async ({ page }) => {
  for (const sessionId of cleanupSessionIds.splice(0)) {
    await page.request.post(`${apiUrl}/sessions/${sessionId}/close`, { headers, data: { notes: "Foundation Stage 7 browser cleanup" } }).catch(() => undefined);
  }
});

test("runs the controlled Request queue, ownership and lifecycle without linked-domain side effects", async ({ page }) => {
  const token = `F7-UI-${Date.now()}`;
  const sessionResult = await post(page, "/sessions", { mode: "EXERCISE", status: "Active", eventType: "Exercise", flightNumber: token, route: "WAW-TEST" });
  expect(sessionResult.response.status()).toBe(201); const session = sessionResult.body; cleanupSessionIds.push(session.id);
  const passengerResult = await post(page, "/passenger-records", { sessionId: session.id, caseId: `CASE-${token}`, personType: "Passenger", firstName: "Linked", lastName: token, source: "Manual" });
  expect(passengerResult.response.status()).toBe(201); const passenger = passengerResult.body;
  const linkedResult = await post(page, "/requests", { sessionId: session.id, category: "Communication", priority: "Normal", details: `Linked context ${token}`, relatedPassengerRecordId: passenger.id, operationId: crypto.randomUUID() });
  expect(linkedResult.response.status(), JSON.stringify(linkedResult.body)).toBe(201); const linked = linkedResult.body;
  const passengerBefore = (await get(page, `/passenger-records/${passenger.id}`, { sessionId: session.id })).body;

  await login(page); await useSession(page, session);
  const queueCalls: string[] = [];
  page.on("request", (value) => { if (value.url().includes("/requests/queue")) queueCalls.push(value.url()); });
  await page.goto("/requests");
  await expect(page.getByText("Server queue", { exact: false })).toBeVisible();
  await expect.poll(() => queueCalls.some((url) => url.includes("limit=25") && url.includes("offset=0"))).toBe(true);
  await page.getByLabel("Filter Request priority").selectOption("Normal");
  await expect.poll(() => queueCalls.some((url) => url.includes("priority=Normal"))).toBe(true);
  await page.getByLabel("Filter Request priority").selectOption("");

  await page.getByRole("button", { name: "New Request" }).click();
  const create = page.getByRole("dialog", { name: "Create Request" });
  await expect(create.getByLabel("Type")).toBeFocused();
  await create.getByLabel("Type").selectOption("Transport");
  await create.getByLabel("Priority").selectOption("Urgent");
  await create.getByLabel("Requester").fill("Browser operator");
  await create.getByLabel("Due").fill("2026-01-01T08:00");
  await create.getByLabel("Requested action / details").fill(`Urgent transport ${token}`);
  await create.getByRole("button", { name: "Create Request" }).click();
  await expect(create).toHaveCount(0);
  await page.getByLabel("Search Requests").fill(`Urgent transport ${token}`);
  const createdRow = page.getByRole("row").filter({ hasText: "Transport" });
  await expect(createdRow).toContainText("Urgent"); await expect(createdRow).toContainText("Overdue");
  await createdRow.press("Enter");
  let drawer = page.getByRole("dialog", { name: /Request REQ-/ });
  await expect(drawer.getByRole("heading", { name: /REQ-/ })).toBeFocused();

  await drawer.getByRole("button", { name: "Assign" }).click();
  await drawer.getByLabel("New owner").selectOption({ label: "ZPP Coordinator · coordinator@lot.pl" });
  await drawer.getByRole("button", { name: "Confirm" }).click();
  await expect(drawer.getByText("ZPP Coordinator", { exact: true })).toBeVisible();
  await drawer.getByRole("button", { name: "Priority" }).click();
  await drawer.getByLabel("Priority").selectOption("High");
  await drawer.getByRole("button", { name: "Confirm" }).click();
  await expect(drawer.getByText("High", { exact: true })).toBeVisible();
  await drawer.getByRole("button", { name: "Resolve" }).click();
  await drawer.getByLabel("Outcome").fill("Transport delivered");
  await drawer.getByLabel("Resolution note").fill("Human operator confirmed delivery with the requester.");
  await drawer.getByRole("button", { name: "Confirm" }).click();
  await expect(drawer.getByText("RESOLVED", { exact: true })).toBeVisible();
  await drawer.getByRole("button", { name: "Reopen" }).click();
  await drawer.getByLabel("Reason").fill("The requester needs a revised transport time.");
  await drawer.getByRole("button", { name: "Confirm" }).click();
  await expect(drawer.getByText("IN PROGRESS", { exact: true })).toBeVisible();
  await drawer.getByRole("button", { name: "Cancel" }).click();
  await drawer.getByLabel("Reason").fill("The requester withdrew the revised need.");
  await drawer.getByRole("button", { name: "Confirm" }).click();
  await expect(drawer.getByText("CANCELLED", { exact: true })).toBeVisible();
  await drawer.getByRole("button", { name: "Close", exact: true }).click();

  await page.getByLabel("Search Requests").fill(linked.operationalId);
  const linkedRow = page.getByRole("row").filter({ hasText: linked.operationalId });
  await linkedRow.press("Enter"); drawer = page.getByRole("dialog", { name: `Request ${linked.operationalId}` });
  await expect(drawer.getByText(passenger.operationalId, { exact: false })).toBeVisible();
  const staleVersion = linked.version;
  const external = await page.request.post(`${apiUrl}/requests/${linked.id}/priority`, { headers, data: { sessionId: session.id, expectedVersion: staleVersion, priority: "High", reason: "Concurrent operator priority update" } });
  expect(external.status()).toBe(200);
  await drawer.getByRole("button", { name: "Start" }).click();
  await drawer.getByRole("button", { name: "Confirm" }).click();
  await expect(drawer.getByText("Request został zmieniony przez innego operatora.", { exact: false })).toBeVisible();
  await drawer.getByRole("button", { name: "Refresh Request" }).click();
  await expect(drawer.getByText("High", { exact: true })).toBeVisible();
  const passengerAfter = (await get(page, `/passenger-records/${passenger.id}`, { sessionId: session.id })).body;
  expect(passengerAfter).toMatchObject({ version: passengerBefore.version, holdStatus: passengerBefore.holdStatus, conditionStatus: passengerBefore.conditionStatus });
  await drawer.getByRole("button", { name: "Close", exact: true }).click();
});
