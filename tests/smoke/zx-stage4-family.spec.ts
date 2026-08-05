import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

const apiUrl = process.env.PLAYWRIGHT_API_URL ?? `http://127.0.0.1:${Number(process.env.PLAYWRIGHT_API_PORT ?? 4100)}/api`;
const headers = { "content-type": "application/json", "x-user-email": "coordinator@lot.pl" };
const cleanupSessionIds: string[] = [];

async function createSession(page: Page, token: string) {
  const response = await page.request.post(`${apiUrl}/sessions`, { headers, data: { mode: "EXERCISE", status: "Active", eventType: "Exercise", flightNumber: token, route: "WAW-TEST" } });
  expect(response.status()).toBe(201);
  const session = await response.json();
  cleanupSessionIds.push(session.id);
  return session;
}

test.afterEach(async ({ page }) => {
  for (const sessionId of cleanupSessionIds.splice(0)) {
    await page.request.post(`${apiUrl}/sessions/${sessionId}/close`, { headers, data: { notes: "Stage 4 browser test cleanup" } }).catch(() => undefined);
  }
});

async function useSession(page: Page, session: Record<string, string>) {
  await page.goto("/sessions");
  const row = page.getByRole("row").filter({ hasText: session.operationalId });
  await expect(row).toBeVisible();
  const button = row.getByRole("button", { name: "Use this session" });
  if (await button.count()) await button.click();
}

test("separates a Family/NOK claim from the human decision and surfaces stale decision conflicts", async ({ page }) => {
  const token = `F4-UX-${Date.now()}`;
  const session = await createSession(page, token);
  const createdResponse = await page.request.post(`${apiUrl}/family-records`, {
    headers,
    data: { sessionId: session.id, caseId: `CASE-${token}`, firstName: "Claimant", lastName: token, email: `${token}@example.test`, claimedRelationship: "Sibling", passengerFirstName: "Passenger", passengerLastName: token }
  });
  expect(createdResponse.status()).toBe(201);
  const family = await createdResponse.json();

  await login(page);
  await useSession(page, session);
  await page.goto("/family-nok");
  await page.getByLabel("Search records").fill(family.operationalId);
  const row = page.getByRole("row").filter({ hasText: family.operationalId });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Edit" }).click();
  const drawer = page.getByRole("dialog", { name: "Edit family/NOK record" });
  await expect(drawer.getByText("Claimed: Sibling")).toBeVisible();
  await expect(drawer.getByText(/Passenger link or Matching suggestion does not verify/)).toBeVisible();
  await expect(drawer.locator("#record-firstName")).toHaveAttribute("readonly", "");
  await drawer.getByRole("button", { name: "Reject claim" }).click();

  const verifiedResponse = await page.request.post(`${apiUrl}/family-records/${family.id}/verify`, {
    headers,
    data: { sessionId: session.id, version: family.version, claimVersion: family.currentClaim.version, basis: "Second operator reviewed identity and relationship evidence", verifiedRelationshipType: "Sibling" }
  });
  expect(verifiedResponse.status()).toBe(200);

  const decision = page.getByRole("dialog", { name: "Reject relationship claim" });
  await decision.getByLabel("Decision basis / evidence summary").fill("Conflicting evidence observed by first operator");
  await decision.getByRole("button", { name: "Reject claim" }).click();
  await expect(decision.locator("#decision-note-error")).toContainText(/changed by another user/i);
  await decision.getByRole("button", { name: "Cancel" }).click();
  const discardDecision = page.getByRole("dialog", { name: "Discard unsaved changes?" });
  if (await discardDecision.count()) await discardDecision.getByRole("button", { name: "Discard changes" }).click();
  await drawer.getByRole("button", { name: "Close" }).first().click();
  await page.reload();
  await page.getByLabel("Search records").fill(family.operationalId);
  await expect(page.getByRole("row").filter({ hasText: family.operationalId }).getByText("Verified", { exact: true })).toBeVisible();

});
